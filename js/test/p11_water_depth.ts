// Phase 11 — TRUE water-column-depth UAT (headless, falsifiable).
//
// world.addWater's depth shading must be REAL water-column depth read from the terrain
// heightfield — clear/shallow where the floor is near the waterline, deepening to opaque
// where the floor drops away — NOT a camera-distance proxy and NOT a constant. This test
// pins that down with FALSIFIABLE assertions on the baked depth field:
//
//   (1) bakeWaterDepth over a beach RAMP (floor drops away from shore) → the normalised
//       depth byte rises MONOTONICALLY with the real column depth (0 at the shore → 255 at
//       the deepest floor). A constant/proxy field would fail the spread + monotonicity.
//   (2) bakeWaterDepth over an ISLAND floor (shallow in the middle, deep at the rim) → the
//       field tracks the TERRAIN SHAPE (low depth at the centre, high depth at the edges),
//       i.e. it is U-shaped — which a monotone-with-coordinate proxy could NOT produce.
//   (3) deriveDepthFromRegions (the DEFAULT path when addWater gets no explicit region)
//       reproduces the region's world bounds + samples the SAME source/seed/lod/hints the
//       terrain was generated with, and an empty region table returns undefined (so the
//       proxy stands in only when there is genuinely no terrain). Its descriptor bakes to
//       the same TRUE depth as the explicit path.
//
// Run: limina js/test/p11_water_depth.ts   (exit 0 = pass)

import * as THREE from "../build/three.bundle.mjs";
import { EntityTable, ops } from "../src/engine.ts";
import { createEcsWorld } from "../src/ecs/world.ts";
import { createTransformStorage } from "../src/ecs/facade.ts";
import { UniformGridSpatialIndex } from "../src/spatial/index.ts";
import { SkillRegistry, type WorldContext } from "../src/skills/registry.ts";
import { resolveProfile } from "../src/skills/permissions.ts";
import { LiminaTracer } from "../src/observability/event.ts";
import { bakeWaterDepth, type WaterDepthOptions } from "../src/water.ts";
import { deriveDepthFromRegions, registerWaterSkills } from "../src/skills/water.ts";
import { TILE_SIZE } from "../src/terrain/procedural.ts";
import type { RegionState } from "../src/skills/terrain.ts";
import type { TerrainSource, TerrainTile, TileRequest, ClimateSample } from "../src/terrain/types.ts";

function assert(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new Error("p11_water_depth FAIL: " + msg);
}

/** Read the baked R8 depth field as a row-major Uint8Array + its resolution. The bake stores
 *  it on a THREE.DataTexture whose `.image` is `{ data, width, height }`. */
function readField(baked: { texture: unknown }): { data: Uint8Array; res: number } {
  const img = (baked.texture as { image: { data: Uint8Array; width: number; height: number } }).image;
  return { data: img.data, res: img.width };
}
/** Sample the field at fractional (u,v) in [0,1] (u→col→x, v→row→z), nearest texel. */
function at(field: { data: Uint8Array; res: number }, u: number, v: number): number {
  const c = Math.min(field.res - 1, Math.max(0, Math.round(u * (field.res - 1))));
  const r = Math.min(field.res - 1, Math.max(0, Math.round(v * (field.res - 1))));
  return field.data[r * field.res + c];
}

const SEA = 0; // sea level for every scenario

// ===========================================================================
// (1) BEACH RAMP — floor drops away from the shore as x grows. Depth must rise
//     monotonically from ~0 at the shore to 255 at the deepest floor (true column depth).
// ===========================================================================
const RAMP: WaterDepthOptions = {
  // h(x) = 2 − 0.12·x : above sea at x=0 (h=+2, depth 0), −10 at x=100 (depth 10). z-flat.
  sampleHeight: (x, _z) => 2 - 0.12 * x,
  bounds: { minX: 0, minZ: 0, maxX: 100, maxZ: 100 },
  resolution: 64,
};
const rampBaked = bakeWaterDepth(RAMP, SEA);
const ramp = readField(rampBaked);

// Walk a single z-row across increasing x: the byte must be non-decreasing (monotone with
// the real column depth) and strictly increase overall. A constant or a noisy proxy fails.
let prev = -1;
let monotone = true;
for (let c = 0; c < ramp.res; c++) {
  const b = ramp.data[0 * ramp.res + c];
  if (b < prev - 1) monotone = false; // allow ±1 quantisation jitter
  prev = b;
}
assert(monotone, "ramp depth byte is not monotone non-decreasing along the floor's drop-away");
const shoreByte = at(ramp, 0.0, 0.0);   // shallowest (floor at/above sea)
const deepByte = at(ramp, 1.0, 0.0);    // deepest floor
assert(shoreByte <= 4, `ramp shore must read ~0 depth (clear shallows), got ${shoreByte}`);
assert(deepByte >= 251, `ramp deepest floor must read ~255, got ${deepByte}`);
assert(deepByte - shoreByte >= 200, `FALSIFIABILITY: depth field has no spread (got ${deepByte - shoreByte}) — a constant/proxy would collapse here`);

// FALSIFIABLE vs a constant: a shallow-terrain column reads STRICTLY less depth than a
// deep-terrain column (the whole point of "true water-column depth").
const shallowCol = at(ramp, 0.2, 0.5); // high floor → shallow
const deepCol = at(ramp, 0.9, 0.5);    // low floor → deep
assert(deepCol > shallowCol + 100, `depth must grow over deeper terrain (shallow=${shallowCol}, deep=${deepCol})`);

// ===========================================================================
// (2) ISLAND FLOOR — shallow in the middle (high floor), deep at the rim (low floor). The
//     field must be U-shaped (low depth centre, high depth edges): it tracks TERRAIN SHAPE,
//     not a monotone coordinate proxy. center<edge at BOTH ends is impossible for a ramp.
// ===========================================================================
const ISLAND: WaterDepthOptions = {
  sampleHeight: (x, _z) => {
    const dx = (x - 50) / 50; // [-1,1] across the span
    return 3 - 12 * dx * dx;  // +3 at centre (above sea), −9 at the rim (deep)
  },
  bounds: { minX: 0, minZ: 0, maxX: 100, maxZ: 100 },
  resolution: 64,
};
const island = readField(bakeWaterDepth(ISLAND, SEA));
const centre = at(island, 0.5, 0.5);
const leftRim = at(island, 0.0, 0.5);
const rightRim = at(island, 1.0, 0.5);
assert(centre <= 4, `island centre (high floor) must read ~0 depth, got ${centre}`);
assert(leftRim >= 251 && rightRim >= 251, `island rim (deep floor) must read ~255, got L=${leftRim} R=${rightRim}`);
assert(leftRim > centre + 100 && rightRim > centre + 100, `island depth must be U-shaped (tracks terrain, not a coordinate ramp): L=${leftRim} C=${centre} R=${rightRim}`);

// ===========================================================================
// (3) DEFAULT PATH — deriveDepthFromRegions (used when addWater gets no explicit region).
//     It must reproduce the region's world bounds, query the SAME source/seed/lod/hints, and
//     bake to the same TRUE depth; an empty table returns undefined (→ proxy fallback only
//     when there is no terrain).
// ===========================================================================
const HINTS = { amp: 1, erode: 1 };
const SEED = 7, LOD = 0;
// A stub source whose sampleHeight is the beach RAMP, asserting it is queried with EXACTLY
// the region's (seed, lod, hints) — proving the default path reads the field the colliders
// were built with, not a guess.
let queriedSeed = -1, queriedLod = -1, queriedHints = "";
const stub: TerrainSource = {
  name: "stub:depth-test",
  generateTile: (_r: TileRequest): TerrainTile => { throw new Error("generateTile not used"); },
  sampleHeight: (seed, x, _z, lod, hints) => {
    queriedSeed = seed; queriedLod = lod; queriedHints = JSON.stringify(hints ?? {});
    return 2 - 0.12 * x; // SAME ramp as scenario (1)
  },
  sampleClimate: (): ClimateSample => ({ tempC: 20, precipMm: 1000, biome: 5 }),
};

// Empty region table → undefined (the proxy fallback is reserved for "no terrain").
assert(deriveDepthFromRegions(stub, new Map()) === undefined, "empty region table must yield no depth descriptor (proxy fallback)");

// One generated region spanning tiles (0,0)..(1,1) at seed 7 with HINTS.
const tiles = new Map<string, { bodyId: number; entity: string; eid: number; tx: number; tz: number }>();
for (let tz = 0; tz <= 1; tz++) {
  for (let tx = 0; tx <= 1; tx++) {
    tiles.set(`${tx},${tz}`, { bodyId: 0, entity: "e", eid: 0, tx, tz });
  }
}
const regions = new Map<string, RegionState>([
  ["rgn", { seed: SEED, lod: LOD, hints: HINTS, tiles } as RegionState],
]);
const derived = deriveDepthFromRegions(stub, regions);
assert(derived !== undefined, "a generated region must yield a depth descriptor (the DEFAULT true-depth path)");

// Bounds = the tiles' world rectangle (0,0)..(2·TILE_SIZE, 2·TILE_SIZE).
const b = derived!.bounds;
assert(b.minX === 0 && b.minZ === 0 && b.maxX === 2 * TILE_SIZE && b.maxZ === 2 * TILE_SIZE,
  `derived bounds wrong: ${JSON.stringify(b)} (expected 0..${2 * TILE_SIZE})`);

// The query passes through with the region's EXACT seed/lod/hints (matches the colliders).
const hInside = derived!.sampleHeight(TILE_SIZE, TILE_SIZE);
assert(queriedSeed === SEED && queriedLod === LOD && queriedHints === JSON.stringify(HINTS),
  `default path queried the wrong (seed,lod,hints): seed=${queriedSeed} lod=${queriedLod} hints=${queriedHints}`);
assert(Math.abs(hInside - (2 - 0.12 * TILE_SIZE)) < 1e-6, "default path did not pass the source height through");

// And it bakes to TRUE depth too (shallow → deep across the region), like the explicit path.
const derivedField = readField(bakeWaterDepth(derived!, SEA));
const dShore = at(derivedField, 0.0, 0.5);
const dDeep = at(derivedField, 1.0, 0.5);
assert(dDeep - dShore >= 200, `default-path depth field has no spread (shore=${dShore}, deep=${dDeep})`);

// ===========================================================================
// (4) WIRING — the `world.addWater` skill takes the DEFAULT true-depth path end-to-end:
//     with a generated region present and NO explicit region descriptor, it BAKES the depth
//     field from the bound source (the source's sampleHeight is queried res² times); with an
//     EMPTY region table it does NOT bake (zero queries → the camera-distance proxy stands
//     in). The query count is the falsifiable signal that true-depth is the default.
// ===========================================================================
function makeWorld(): WorldContext {
  const ecs = createEcsWorld();
  const scene = new THREE.Scene();
  return {
    ecs, transforms: createTransformStorage(ecs), spatial: new UniformGridSpatialIndex(),
    entities: new EntityTable(), tags: new Map(), scene: scene as unknown as WorldContext["scene"],
    camera: { position: { set() {} }, aspect: 1, lookAt() {}, updateProjectionMatrix() {} },
    ops, mode: "headless",
  } as WorldContext;
}
function countingSource(counter: { calls: number }): TerrainSource {
  return {
    name: "stub:counting",
    generateTile: (_r: TileRequest): TerrainTile => { throw new Error("generateTile not used"); },
    sampleHeight: (_seed, x, _z, _lod, _hints) => { counter.calls++; return 2 - 0.12 * x; },
    sampleClimate: (): ClimateSample => ({ tempC: 20, precipMm: 1000, biome: 5 }),
  };
}
const author = { agentId: "limina:builder", sessionId: "ses_p11_water_depth", permissions: resolveProfile("builder.readWrite"), tick: 0, world: makeWorld() };

// 4a. A region is generated → addWater(no region) BAKES from the source (default true depth).
{
  const counter = { calls: 0 };
  const reg = new SkillRegistry(new LiminaTracer("ses_p11_water_depth"));
  const regions = new Map<string, RegionState>([["rgn", { seed: SEED, lod: LOD, hints: HINTS, tiles } as RegionState]]);
  registerWaterSkills(reg, countingSource(counter), regions);
  const res = await reg.invoke("world.addWater", { level: 0, resolution: 32 } as unknown as Record<string, unknown>, author);
  assert(res.success, `default-path addWater failed: ${JSON.stringify(res.error)}`);
  assert(counter.calls >= 32 * 32, `DEFAULT path did not bake true depth from terrain (sampleHeight calls=${counter.calls}, expected ≥${32 * 32}) — it fell back to the proxy`);
}
// 4b. No region generated → addWater(no region) does NOT bake (proxy fallback, zero queries).
{
  const counter = { calls: 0 };
  const reg = new SkillRegistry(new LiminaTracer("ses_p11_water_depth"));
  registerWaterSkills(reg, countingSource(counter), new Map());
  const res = await reg.invoke("world.addWater", { level: 0 }, author);
  assert(res.success, `proxy-path addWater failed: ${JSON.stringify(res.error)}`);
  assert(counter.calls === 0, `FALSIFIABILITY: with no terrain the proxy must stand in (sampleHeight calls=${counter.calls}, expected 0)`);
}

ops.op_log(
  `p11_water_depth OK: bakeWaterDepth is TRUE water-column depth — ramp rises monotonically ` +
  `0→255 (shore ${shoreByte} → deep ${deepByte}, spread ${deepByte - shoreByte}); island floor is ` +
  `U-shaped (centre ${centre} < rim ${leftRim}/${rightRim}, tracks terrain not a coordinate proxy); ` +
  `DEFAULT path deriveDepthFromRegions reproduces region bounds + (seed ${queriedSeed}/lod ${queriedLod}/` +
  `hints) and bakes the same true depth (spread ${dDeep - dShore}); empty table → proxy fallback. ` +
  `WIRING: world.addWater with a generated region + no explicit descriptor BAKES from the source ` +
  `(true depth is the DEFAULT); with no terrain it queries the source 0× (proxy fallback).`,
);
