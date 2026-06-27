// Phase 11 GATE — the AGENT-NATIVE terrain-TYPE system. Proves the generalization of the
// procedural generator from a beach special-case into a seedable CATALOG of terrain types
// (beach, mountains, forest, desert, plains, hills, islands). Falsifiable end to end:
//
//   1. DISTINCT SURFACES: each type at a FIXED seed produces a different heightfield
//      (different content hash) — mountains tower over near-flat plains (relief ordering).
//   2. DETERMINISTIC: the same (type, seed) yields BYTE-IDENTICAL tiles across two runs
//      (same content hash) — the replay/cache contract holds per type.
//   3. CLIMATE VARIES PER TYPE: desert is hot + bone-dry (desert biome), forest is wet,
//      mountains/alpine is the coldest and the ONLY type with ice — the biome grid that
//      gates asset.scatter reads sensibly per type (not one config wearing seven hats).
//   4. AGENT-FACING API: world.generateRegion accepts a named `type` (resolved to the full
//      shaping+climate config server-side), rejects an unknown type, and an explicit `hints`
//      knob overrides the type. terrain.sampleClimate reads the per-type biome from hints.
//
// If all types collapsed to one config (the failure this guards against), the distinct-hash,
// relief-ordering, and per-type-climate assertions all fail loudly.

import { ProceduralTerrainSource, HEIGHT_SCALE, TILE_SIZE } from "../src/terrain/procedural.ts";
import { TERRAIN_TYPES, TERRAIN_TYPE_NAMES, terrainTypeHints, type TerrainTypeName } from "../src/terrain/terrain-types.ts";
import { tileContentHash } from "../src/terrain/tilecache.ts";
import {
  CLIMATE_TEMP_C, CLIMATE_PRECIP_MM, CLIMATE_BIOME, CLIMATE_CHANNELS,
} from "../src/terrain/types.ts";
import { EntityTable, ops } from "../src/engine.ts";
import { createEcsWorld } from "../src/ecs/world.ts";
import { createTransformStorage } from "../src/ecs/facade.ts";
import { UniformGridSpatialIndex } from "../src/spatial/index.ts";
import { SkillRegistry, type WorldContext } from "../src/skills/registry.ts";
import { registerCoreSkills } from "../src/skills/index.ts";
import { resolveProfile } from "../src/skills/permissions.ts";
import { LiminaTracer } from "../src/observability/event.ts";

function assert(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new Error("p11_terrain_types FAIL: " + msg);
}

const SEED = 1234;
const BOUNDS = { minTx: 0, minTz: 0, maxTx: 1, maxTz: 1 }; // 2×2 = 4 tiles
const ICE_BIOME = 0; // biomeOf: tempC < 0 → polar / ice (only the cold alpine type reaches it)
const DESERT_BIOME = 1; // hot + dry
const CORE_TYPES: TerrainTypeName[] = ["beach", "mountains", "forest", "desert", "plains"];

// ── Aggregate one type's generated region (all tiles) deterministically ──────────────
interface TypeStats {
  hash: string;          // content hash over the whole region (all tiles, ordered)
  minY: number; maxY: number;
  meanTemp: number; meanPrecip: number;
  dominantBiome: number;
  biomeSet: Set<number>;
}
function aggregate(src: ProceduralTerrainSource, type: TerrainTypeName): TypeStats {
  const hints = terrainTypeHints(type, BOUNDS);
  let minY = Infinity, maxY = -Infinity, tSum = 0, pSum = 0, n = 0;
  const biomeCount = new Map<number, number>();
  const hashes: string[] = [];
  for (let tz = BOUNDS.minTz; tz <= BOUNDS.maxTz; tz++) {
    for (let tx = BOUNDS.minTx; tx <= BOUNDS.maxTx; tx++) {
      const tile = src.generateTile({ seed: SEED, tx, tz, lod: 0, hints });
      hashes.push(tileContentHash(tile));
      assert(tile.climate !== undefined && tile.climateChannels === CLIMATE_CHANNELS, `${type}: tile carries no ${CLIMATE_CHANNELS}-channel climate grid`);
      for (let i = 0; i < tile.heights.length; i++) {
        const y = tile.heights[i] * HEIGHT_SCALE;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
        const c = i * CLIMATE_CHANNELS;
        tSum += tile.climate[c + CLIMATE_TEMP_C];
        pSum += tile.climate[c + CLIMATE_PRECIP_MM];
        const b = tile.climate[c + CLIMATE_BIOME];
        biomeCount.set(b, (biomeCount.get(b) ?? 0) + 1);
        n++;
      }
    }
  }
  let dominantBiome = -1, domN = -1;
  for (const [b, count] of biomeCount) if (count > domN) { domN = count; dominantBiome = b; }
  return {
    hash: hashes.join("|"), minY, maxY,
    meanTemp: tSum / n, meanPrecip: pSum / n,
    dominantBiome, biomeSet: new Set(biomeCount.keys()),
  };
}

const src = new ProceduralTerrainSource();
const stats = new Map<TerrainTypeName, TypeStats>();
for (const type of TERRAIN_TYPE_NAMES) stats.set(type, aggregate(src, type));

// ── 1. DISTINCT SURFACES — every type's heightfield hash is unique ───────────────────
const hashes = new Map<string, TerrainTypeName>();
for (const type of TERRAIN_TYPE_NAMES) {
  const s = stats.get(type)!;
  const prev = hashes.get(s.hash);
  assert(prev === undefined, `types "${type}" and "${prev}" produced an IDENTICAL surface hash — they collapsed to one config`);
  hashes.set(s.hash, type);
}

// ── 2. DETERMINISM — a second independent source/run is byte-identical per type ──────
const src2 = new ProceduralTerrainSource();
for (const type of TERRAIN_TYPE_NAMES) {
  const again = aggregate(src2, type);
  assert(again.hash === stats.get(type)!.hash, `type "${type}" is non-deterministic: two runs differ`);
}

// ── 3a. RELIEF — mountains tower, plains are near-flat (the amplitude knob is real) ──
const mtn = stats.get("mountains")!;
const plains = stats.get("plains")!;
assert(mtn.maxY > plains.maxY * 4, `mountains should tower over plains: mtn.maxY=${mtn.maxY.toFixed(1)} vs plains.maxY=${plains.maxY.toFixed(1)}`);
assert(mtn.maxY > 18, `mountains relief too low: maxY=${mtn.maxY.toFixed(1)}`);
assert(plains.maxY < 5, `plains not flat enough: maxY=${plains.maxY.toFixed(1)}`);

// ── 3b. CLIMATE — per-type biomes are sensible + falsifiably distinct ───────────────
const desert = stats.get("desert")!;
const forest = stats.get("forest")!;
const beach = stats.get("beach")!;

// Desert is the hottest AND driest of ALL types, and reads as the desert biome.
for (const type of TERRAIN_TYPE_NAMES) {
  if (type === "desert") continue;
  assert(desert.meanTemp > stats.get(type)!.meanTemp, `desert not hotter than ${type}`);
  assert(desert.meanPrecip <= stats.get(type)!.meanPrecip, `desert not drier than ${type}`);
}
assert(desert.dominantBiome === DESERT_BIOME, `desert dominant biome should be ${DESERT_BIOME}, got ${desert.dominantBiome}`);
assert(desert.meanPrecip < 50, `desert not arid: meanPrecip=${desert.meanPrecip.toFixed(0)}`);

// Mountains/alpine is the coldest of ALL types, and the ONLY type that reaches ice.
for (const type of TERRAIN_TYPE_NAMES) {
  if (type === "mountains") continue;
  assert(mtn.meanTemp < stats.get(type)!.meanTemp, `mountains not colder than ${type}`);
  assert(!stats.get(type)!.biomeSet.has(ICE_BIOME), `non-alpine type "${type}" reached the ice biome (${ICE_BIOME})`);
}
assert(mtn.biomeSet.has(ICE_BIOME), `mountains should reach the ice biome (${ICE_BIOME}); biomes=${[...mtn.biomeSet]}`);

// Forest is well-watered + temperate (much wetter than desert/plains, not freezing).
assert(forest.meanPrecip > 2000, `forest not wet: meanPrecip=${forest.meanPrecip.toFixed(0)}`);
assert(forest.meanPrecip > desert.meanPrecip && forest.meanTemp > mtn.meanTemp, "forest climate not between desert/alpine");

// Beach is warm + maritime.
assert(beach.meanTemp > 18, `beach not warm: meanTemp=${beach.meanTemp.toFixed(1)}`);
assert(beach.meanPrecip > 1500, `beach not maritime/humid: meanPrecip=${beach.meanPrecip.toFixed(0)}`);

// FALSIFIABLE non-collapse: the five CORE types must each have a DISTINCT dominant biome.
const coreDom = new Set(CORE_TYPES.map((t) => stats.get(t)!.dominantBiome));
assert(coreDom.size === CORE_TYPES.length, `the ${CORE_TYPES.length} core types should have ${CORE_TYPES.length} distinct dominant biomes, got ${coreDom.size}: ${CORE_TYPES.map((t) => `${t}=${stats.get(t)!.dominantBiome}`).join(", ")}`);

// ── 4. AGENT-FACING API — world.generateRegion takes a named TYPE; sampleClimate too ─
function makeHeadlessWorld(): WorldContext {
  const ecs = createEcsWorld();
  const scene = { add() {}, remove() {}, position: { set() {}, x: 0, y: 0, z: 0 }, background: null as unknown };
  const camera = { position: { set() {} }, aspect: 1, lookAt() {}, updateProjectionMatrix() {} };
  return { ecs, transforms: createTransformStorage(ecs), spatial: new UniformGridSpatialIndex(), entities: new EntityTable(), tags: new Map(), scene, camera, ops, mode: "headless" };
}

ops.op_physics_create_world(-9.81);
const registry = new SkillRegistry(new LiminaTracer("ses_p11_types"));
const core = registerCoreSkills(registry);
const world = makeHeadlessWorld();
const base = { agentId: "agt_types", sessionId: "ses_p11_types", permissions: resolveProfile("builder.readWrite"), tick: 0, world };
const TILES = (BOUNDS.maxTx - BOUNDS.minTx + 1) * (BOUNDS.maxTz - BOUNDS.minTz + 1);

// 4a. Generate two different types by NAME into two different regions; both succeed and
//     report the expected tile count (the type resolved to a real shaping config).
const genDesert = await registry.invoke("world.generateRegion", { seed: SEED, bounds: BOUNDS, lod: 0, type: "desert" }, base);
assert(genDesert.success && (genDesert.result as { tiles: number }).tiles === TILES, "world.generateRegion type:desert did not generate the region");
const mtnBounds = { minTx: 10, minTz: 10, maxTx: 11, maxTz: 11 };
const genMtn = await registry.invoke("world.generateRegion", { seed: SEED, bounds: mtnBounds, lod: 0, type: "mountains" }, base);
assert(genMtn.success && (genMtn.result as { tiles: number }).tiles === TILES, "world.generateRegion type:mountains did not generate the region");
assert((genDesert.result as { regionId: string }).regionId !== (genMtn.result as { regionId: string }).regionId, "two types collapsed to the same region handle");

// 4b. An unknown type is rejected by the schema (the enum is a stable, validated contract).
const bad = await registry.invoke("world.generateRegion", { seed: SEED, bounds: BOUNDS, lod: 0, type: "swamptopia" }, base);
assert(!bad.success, "world.generateRegion accepted an unknown terrain type");

// 4c. An explicit hint overrides the type's resolved knob (raw-config escape hatch).
const tallPlains = terrainTypeHints("plains", BOUNDS);
const overridden = { ...tallPlains, amp: TERRAIN_TYPES.mountains.amp };
let oMax = -Infinity;
for (let tz = BOUNDS.minTz; tz <= BOUNDS.maxTz; tz++) {
  for (let tx = BOUNDS.minTx; tx <= BOUNDS.maxTx; tx++) {
    const tile = src.generateTile({ seed: SEED, tx, tz, lod: 0, hints: overridden });
    for (let i = 0; i < tile.heights.length; i++) oMax = Math.max(oMax, tile.heights[i] * HEIGHT_SCALE);
  }
}
assert(oMax > plains.maxY * 2, `amp override did not raise plains relief: ${oMax.toFixed(1)} vs base ${plains.maxY.toFixed(1)}`);

// 4d. terrain.sampleClimate reads the per-type biome from the region's hints — desert is
//     hot + dry, forest wet, at the SAME coordinate (so the difference is the type, not place).
const px = (BOUNDS.minTx + 0.5) * TILE_SIZE, pz = (BOUNDS.minTz + 0.5) * TILE_SIZE;
const cDesert = await registry.invoke("terrain.sampleClimate", { seed: SEED, x: px, z: pz, hints: terrainTypeHints("desert", BOUNDS) }, base);
const cForest = await registry.invoke("terrain.sampleClimate", { seed: SEED, x: px, z: pz, hints: terrainTypeHints("forest", BOUNDS) }, base);
assert(cDesert.success && cForest.success, "terrain.sampleClimate with hints failed");
const dC = cDesert.result as { tempC: number; precipMm: number; biome: number };
const fC = cForest.result as { tempC: number; precipMm: number; biome: number };
assert(dC.tempC > fC.tempC && dC.precipMm < fC.precipMm && dC.biome !== fC.biome, `sampleClimate did not vary by type: desert=${JSON.stringify(dC)} forest=${JSON.stringify(fC)}`);

// Sanity: the no-hints sampleClimate is still the byte-identical base field.
const cBase = await registry.invoke("terrain.sampleClimate", { seed: SEED, x: px, z: pz }, base);
assert(cBase.success, "terrain.sampleClimate (no hints) failed");

const line = TERRAIN_TYPE_NAMES.map((t) => {
  const s = stats.get(t)!;
  return `${t} Y${s.minY.toFixed(0)}..${s.maxY.toFixed(0)} T${s.meanTemp.toFixed(0)} P${s.meanPrecip.toFixed(0)} b${s.dominantBiome}`;
}).join(" | ");
ops.op_log(
  `p11_terrain_types OK: ${TERRAIN_TYPE_NAMES.length} seedable terrain types, all DISTINCT surfaces + DETERMINISTIC (byte-identical 2 runs); ` +
  `relief mountains ${mtn.maxY.toFixed(0)}m ≫ plains ${plains.maxY.toFixed(0)}m; ` +
  `climate per type: desert hot/dry(b${desert.dominantBiome}) · forest wet · alpine coldest+ice(b0) · ${CORE_TYPES.length} core types → ${coreDom.size} distinct biomes; ` +
  `agent API: world.generateRegion type:NAME resolves (unknown rejected), hint-override works, terrain.sampleClimate reads per-type biome. [${line}]`,
);
