// Phase 11 ACCEPTANCE GATE — the cottage-on-a-beach reproduces from INTENT-LEVEL
// skills with ZERO hand-authored geometry. Drives js/src/demos/cottage_beach.ts and
// proves:
//
//   1. ASSEMBLY: buildCottageBeach sequences ONLY the foundation skills —
//      world.generateRegion (a beach region) → world.addWater (sea level) →
//      asset.place (the cottage, BY ID) → asset.scatter (palms + driftwood, BY ID,
//      elevation-gated to the dry sand). The render baseline composes onto the scene.
//   2. ASSET-BASED, NOT PRIMITIVE (the gate): the cottage is an ASSET entity carrying
//      its asset id + content hash; the props are ASSET instances; NO scene.createEntity
//      primitive geometry is authored (the recorded command stream contains none).
//   3. ON-SURFACE: scattered props sit on the generated surface (drop parity vs the
//      deterministic height field) and ABOVE the waterline (elevationMin enforced).
//   4. FALSIFIABLE + NON-VACUOUS: the waterline cut is real — lowering elevationMin
//      below the sea floods MORE props back in (a strict superset incl. below-sea).
//   5. DETERMINISTIC: same build → bit-identical sea level, cottage, and scatter.
//   6. REPLAYABLE: export (commands + tiles + asset bytes) → reload from the package →
//      replay over BAKED tiles (author source ABSENT, native asset root GUARDED) →
//      bit-identical placements + the cottage's pinned content hash.

import * as THREE from "../build/three.bundle.mjs";
import { EntityTable, ops, type EngineOps } from "../src/engine.ts";
import { createEcsWorld } from "../src/ecs/world.ts";
import { createTransformStorage } from "../src/ecs/facade.ts";
import { UniformGridSpatialIndex } from "../src/spatial/index.ts";
import { LiminaTracer } from "../src/observability/event.ts";
import { SkillRegistry, type WorldContext } from "../src/skills/registry.ts";
import { registerCoreSkills } from "../src/skills/index.ts";
import { resolveProfile } from "../src/skills/permissions.ts";
import { AssetRegistry } from "../src/asset-registry.ts";
import { assembleExport, loadExport, exportAssetBundle } from "../src/export/package.ts";
import { WorldRecorder } from "../src/worldlog/recorder.ts";
import { replayCommands } from "../src/worldlog/replay.ts";
import { ProceduralTerrainSource } from "../src/terrain/procedural.ts";
import { CachedTerrainSource } from "../src/terrain/tilecache.ts";
import { applyRenderBaseline } from "../src/render-baseline.ts";
import type { AssetInstance, ScatterConfig } from "../src/terrain/asset-scatter.ts";
import type { SkillCommand } from "../src/worldlog/log.ts";
import type { MCPResponse } from "../src/mcp/protocol.ts";
import {
  buildCottageBeach, BEACH_SEED, BEACH_BOUNDS,
  COTTAGE_ASSET, PALM_ASSET, DRIFTWOOD_ASSET,
} from "../src/demos/cottage_beach.ts";

function assert(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new Error("p11_cottage_scene FAIL: " + msg);
}
const sameInstances = (a: AssetInstance[], b: AssetInstance[]): boolean => {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].assetId !== b[i].assetId) return false;
    for (const k of ["x", "y", "z", "yaw", "scale"] as (keyof AssetInstance)[]) {
      if (!Object.is(a[i][k], b[i][k])) return false;
    }
  }
  return true;
};

function makeWorld(worldOps: EngineOps, scene?: unknown): WorldContext {
  const stub = { add() {}, remove() {}, position: { set() {}, x: 0, y: 0, z: 0 }, background: null as unknown };
  const camera = { position: { set() {} }, aspect: 1, lookAt() {}, updateProjectionMatrix() {} };
  const ecs = createEcsWorld();
  return {
    ecs, transforms: createTransformStorage(ecs), spatial: new UniformGridSpatialIndex(),
    entities: new EntityTable(), tags: new Map(), scene: (scene ?? stub) as WorldContext["scene"],
    camera: camera as WorldContext["camera"], ops: worldOps, mode: "headless",
  };
}

const TILES = (BEACH_BOUNDS.maxTx - BEACH_BOUNDS.minTx + 1) * (BEACH_BOUNDS.maxTz - BEACH_BOUNDS.minTz + 1);

// ── BUILD #1 — authoring, recorded, onto a REAL scene with the render baseline ──────
const authScene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(60, 16 / 9, 0.1, 200);
// The render baseline composes onto the scene (createEngine does this automatically
// for the live window demo; here we assert it installs lights + ground + IBL).
const applied = applyRenderBaseline({ scene: authScene as never, camera: camera as never });
assert(applied.sun !== undefined && applied.hemisphere !== undefined && applied.ground !== undefined, "render baseline did not install sun/hemisphere/ground");
assert(applied.environmentMode === "gradient", `expected headless gradient IBL, got ${applied.environmentMode}`);

const recTracer = new LiminaTracer("ses_cottage_author");
const authReg = new SkillRegistry(recTracer);
const authCore = registerCoreSkills(authReg);
const recorder = new WorldRecorder("ses_cottage_author");
recorder.attach(authReg);
const recOps = recorder.wrapOps(ops);
const recWorld = makeWorld(recOps, authScene);
recOps.op_physics_create_world(-9.81); // recorded so a replay recreates the world before re-applying tiles

const res = await buildCottageBeach({ registry: authReg, world: recWorld, source: authCore.terrain.source });

// 1. ASSEMBLY — region generated, its tiles in the shared (exportable) cache.
assert(typeof res.regionId === "string" && res.regionId.length > 0, "no region handle returned");
assert(authCore.terrain.cache.entries().length === TILES, `expected ${TILES} generated tiles in the cache, got ${authCore.terrain.cache.entries().length}`);

// 2. WATER at the computed sea level, and the sea actually intersects the beach
//    (between the surface min and max — falsifiable: a sea outside the range is no beach).
assert(authCore.water.surfaces.length === 1, `expected exactly one water surface, got ${authCore.water.surfaces.length}`);
assert(authCore.water.surfaces[0].level === res.seaLevel, "water surface level != computed sea level");
assert(res.surface.minY < res.seaLevel && res.seaLevel < res.surface.maxY, `sea level ${res.seaLevel} does not cut the beach (surface ${res.surface.minY}..${res.surface.maxY})`);

// 3. THE GATE — the cottage is an ASSET ENTITY carrying its asset id + content hash
//    (NOT a primitive), and it stands on DRY sand (above the waterline).
const cottageEntry = recWorld.entities.resolve(res.cottage.entity);
assert(cottageEntry !== undefined, "cottage entity not in the table");
const resource = cottageEntry.resource as { kind?: string; assetId?: string; hash?: string } | undefined;
assert(resource !== undefined && resource.kind === "gltf", "cottage entity does not carry a gltf asset resource");
assert(resource.assetId === COTTAGE_ASSET, `cottage asset id wrong: ${resource.assetId}`);
assert(resource.hash === res.cottage.hash && /^sha256:.+/.test(res.cottage.hash), `cottage content hash not pinned: ${res.cottage.hash}`);
assert(res.cottage.position[1] > res.seaLevel, `cottage sits below the waterline (${res.cottage.position[1]} <= ${res.seaLevel})`);

// 3b. ASSET-BASED, NOT PRIMITIVE — exactly ONE asset entity (the cottage); every other
//     entity is an inert terrain tile (no resource). NOTHING carries primitive geometry.
let assetEntities = 0, terrainEntities = 0;
for (const id of recWorld.entities.ids()) {
  const e = recWorld.entities.resolve(id);
  if (e === undefined) continue;
  if ((e.resource as { kind?: string } | undefined)?.kind === "gltf") {
    assetEntities++;
    const r = e.resource as { assetId?: string; hash?: string };
    assert(typeof r.assetId === "string" && /^sha256:.+/.test(r.hash ?? ""), "asset entity missing id/hash");
  } else {
    terrainEntities++; // terrain tile: heightfield collider + inert transform, no mesh/resource
  }
}
assert(assetEntities === 1, `expected exactly 1 asset entity (the cottage), got ${assetEntities}`);
assert(terrainEntities === TILES, `expected ${TILES} inert terrain entities, got ${terrainEntities}`);

// 3c. THE COMMAND STREAM is intent-level skills ONLY — and contains NO scene.createEntity
//     primitive geometry. This is the falsifiable "no hand-authored meshes" proof.
const skillTools = recorder.commands.filter((c): c is SkillCommand => c.kind === "skill").map((c) => c.tool);
for (const need of ["world.generateRegion", "world.addWater", "asset.place", "asset.scatter"]) {
  assert(skillTools.includes(need), `build did not invoke ${need}`);
}
assert(!skillTools.includes("scene.createEntity"), "build authored a scene.createEntity primitive (hand-authored geometry — the anti-pattern)");
assert(!skillTools.some((t) => t === "three.loadGLTF" || t.startsWith("scene.")), `build used a non-asset scene primitive skill: ${skillTools.join(", ")}`);

// 4. ON-SURFACE props + ABOVE the waterline. Both palette assets (palm + driftwood) placed.
const placements = res.scatter.placements;
assert(res.scatter.instances === placements.length && placements.length > 0, "scatter produced no instances");
assert(placements.some((p) => p.assetId === PALM_ASSET) && placements.some((p) => p.assetId === DRIFTWOOD_ASSET), "scatter did not place both palm and driftwood");
assert(placements.every((p) => p.y >= res.seaLevel), "a scattered prop sits below the waterline (elevationMin not enforced)");
// drop parity: each sampled instance sits on the deterministic surface it was scattered over.
let surfaceChecked = 0;
const stride = Math.max(1, Math.floor(placements.length / 12));
for (let i = 0; i < placements.length; i += stride) {
  const p = placements[i];
  const sh = authCore.terrain.source.sampleHeight(BEACH_SEED, p.x, p.z, 0);
  assert(Math.abs(sh - p.y) < 0.6, `prop ${i} off the surface: y=${p.y.toFixed(3)} sampleHeight=${sh.toFixed(3)}`);
  surfaceChecked++;
}
assert(surfaceChecked >= 6, `expected to surface-check several props, only ${surfaceChecked}`);

// 4b. FALSIFIABLE + NON-VACUOUS — the waterline cut is REAL. On a side registry, scatter
//     the SAME region with elevationMin dropped below the sea floor: MORE props appear,
//     and some now sit BELOW the sea level. (If elevationMin were ignored, counts match.)
{
  const sideReg = new SkillRegistry(new LiminaTracer("ses_cottage_side"));
  const sideCore = registerCoreSkills(sideReg);
  const sideWorld = makeWorld(ops);
  ops.op_physics_create_world(-9.81);
  const sideBase = { agentId: "a", sessionId: "s", permissions: resolveProfile("builder.readWrite"), tick: 0, world: sideWorld };
  const gen = await sideReg.invoke("world.generateRegion", { seed: BEACH_SEED, bounds: BEACH_BOUNDS, lod: 0 }, sideBase);
  assert(gen.success, "side region generate failed");
  const regionId = (gen.result as { regionId: string }).regionId;
  const cfgBase: ScatterConfig = { seed: 21, density: 12, assets: [{ id: PALM_ASSET, weight: 2 }, { id: DRIFTWOOD_ASSET, weight: 1 }], slopeMax: 0.6, sizeRange: [0.8, 1.8] };
  const gated = await sideReg.invoke("asset.scatter", { regionId, config: { ...cfgBase, elevationMin: res.seaLevel } }, sideBase);
  const flooded = await sideReg.invoke("asset.scatter", { regionId, config: { ...cfgBase, elevationMin: res.surface.minY - 5 } }, sideBase);
  assert(gated.success && flooded.success, "side scatter failed");
  const gatedP = (gated.result as { placements: AssetInstance[] }).placements;
  const floodedP = (flooded.result as { placements: AssetInstance[] }).placements;
  assert(gatedP.length === placements.length && sameInstances(gatedP, placements), "side gated scatter diverged from the build (config not reproduced)");
  assert(floodedP.length > gatedP.length, `waterline cut is vacuous: flooding the sea did not add props (${floodedP.length} vs ${gatedP.length})`);
  assert(floodedP.some((p) => p.y < res.seaLevel), "flooding revealed no below-sea candidates (the cut was not removing anything)");
  void sideCore;
}

// 5. DETERMINISTIC — a fresh build (own registry/world/source) reproduces it bit-for-bit.
{
  const reg2 = new SkillRegistry(new LiminaTracer("ses_cottage_det"));
  const core2 = registerCoreSkills(reg2, { terrainSource: new ProceduralTerrainSource() });
  const world2 = makeWorld(ops);
  ops.op_physics_create_world(-9.81);
  const res2 = await buildCottageBeach({ registry: reg2, world: world2, source: core2.terrain.source });
  assert(res2.seaLevel === res.seaLevel, "non-deterministic sea level");
  assert(res2.cottage.position.every((n, i) => n === res.cottage.position[i]), "non-deterministic cottage position");
  assert(res2.cottage.hash === res.cottage.hash, "non-deterministic cottage content hash");
  assert(sameInstances(res2.scatter.placements, res.scatter.placements), "non-deterministic scatter placements");
}

// 6. REPLAYABLE — export the commands + the region's TILES + the asset BYTES; reload from
//    the SERIALIZED package; replay over BAKED tiles with the author source ABSENT and the
//    native asset root GUARDED. A successful, bit-identical replay proves portability.
const files = assembleExport({
  worldId: "p11cottage", meta: recorder.meta(), commands: recorder.commands, keyframes: [],
  keyframeInterval: 10, createdAt: "2026-01-01T00:00:00Z",
  tiles: authCore.terrain.cache.entries(), assets: authCore.assets.bundle(),
});
assert(files["tiles.jsonl"].length > 0, "region tiles did not ride the export");
assert(files["assets.jsonl"].length > 0, "asset bytes did not ride the export");
const loaded = loadExport(files, ops);
assert(loaded.tiles.length === TILES, `export did not round-trip the ${TILES} region tiles (got ${loaded.tiles.length})`);

const guardOps: EngineOps = new Proxy(ops, {
  get(t, p, r) {
    if (p === "op_read_asset") return (id: string) => { throw new Error(`p11_cottage_scene: native asset root must not be read on replay (id=${id})`); };
    return Reflect.get(t, p, r);
  },
}) as EngineOps;
const makeCachedSource = (): CachedTerrainSource => new CachedTerrainSource(loaded.tiles.map((t) => ({ key: t.key, tile: t.tile })));

let replayScatter: MCPResponse | undefined;
let replayPlace: MCPResponse | undefined;
await replayCommands(recorder.commands, {
  makeWorld: () => makeWorld(guardOps),
  makeRegistry: (tr) => {
    const r = new SkillRegistry(tr as LiminaTracer);
    const pkgReg = AssetRegistry.fromBundle(exportAssetBundle(loaded), guardOps);
    registerCoreSkills(r, { assets: pkgReg, terrainSource: makeCachedSource() });
    const inner = r.invoke.bind(r);
    r.invoke = (n, i, b) => inner(n, i, b).then((rr) => {
      if (n === "asset.scatter" && rr.success) replayScatter = rr;
      if (n === "asset.place" && rr.success) replayPlace = rr;
      return rr;
    });
    return r;
  },
  tracer: new LiminaTracer("ses_cottage_replay"),
});
assert(replayScatter !== undefined && replayScatter.success, "replay did not re-run asset.scatter from the package");
assert(replayPlace !== undefined && replayPlace.success, "replay did not re-run asset.place from the package");
const replayPlacements = (replayScatter.result as { placements: AssetInstance[] }).placements;
assert(sameInstances(replayPlacements, placements), "baked-tile replay recomputed DIFFERENT scatter placements (not bit-identical)");
assert((replayPlace.result as { hash: string }).hash === res.cottage.hash, "replay loaded the cottage with a different content hash (asset identity not pinned)");

ops.op_log(
  `p11_cottage_scene OK: cottage-on-a-beach from intent-level skills, ZERO hand-authored geometry — ` +
  `world.generateRegion (${TILES} tiles) → world.addWater @ seaLevel ${res.seaLevel.toFixed(2)} (surface ${res.surface.minY.toFixed(2)}..${res.surface.maxY.toFixed(2)}) → ` +
  `asset.place(${COTTAGE_ASSET}) as 1 ASSET entity (hash ${res.cottage.hash.slice(0, 16)}…) on dry sand → ` +
  `asset.scatter(${PALM_ASSET}+${DRIFTWOOD_ASSET}) ${res.scatter.instances} props on-surface + above the waterline (${surfaceChecked} drop-checked); ` +
  `NO scene.createEntity primitive in the command stream; render baseline composed (gradient IBL); ` +
  `deterministic (same build → bit-identical); replay from the package over BAKED tiles (author source absent, native root guarded) bit-identical + cottage hash pinned.`,
);
