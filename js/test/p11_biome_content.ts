// Phase 11 GATE — the BIOME-CONTENT catalog: every terrain TYPE scatters its own
// biome-appropriate curated CC0 assets, gated so the right content lands in the right
// place. Falsifiable end to end:
//
//   1. ASSETS LOAD: each new curated CC0 asset (pine/broadleaf/cactus/bush/grass) resolves
//      through the content-addressed registry and asset.place spawns a gltf entity + hash
//      (no parse error) — the same pipeline the beach pack uses.
//   2. PER-TYPE CONTENT: scattering a type's catalog content places its expected assets
//      (mountains→pine+rock, desert→cactus+rock, forest→broadleaf+pine+bush, plains→grass).
//   3. MOUNTAIN TREE LINE (elevation gate, falsifiable + non-vacuous): pines sit only BELOW
//      the tree line; the icy peaks above stay BARE; loosening the gate makes the high pines
//      reappear as a strict SUPERSET (the rule is a pure post-filter on the height field).
//   4. DESERT CACTI (biome gate, falsifiable): cacti are biome-gated to the hot/dry desert
//      biome — scattering the desert content over a FOREST region places ZERO cacti, over a
//      desert region places many. Remove the gate and the cross-biome run stops being empty.
//   5. ON-SURFACE: instances sit on the terrain (drop parity vs the heightfield collider +
//      terrain sampleHeight). DETERMINISTIC: same region+config → byte-identical placements.
//   6. THE HELPER + SKILL: scatterBiomeContent surveys the region, resolves the layers, and
//      drives asset.scatter per layer (deterministic, replay-pinned). Beach parity: the
//      catalog reproduces beachScatterConfig bit-for-bit.

import { ProceduralTerrainSource, HEIGHT_SCALE, TILE_SIZE } from "../src/terrain/procedural.ts";
import { terrainTypeHints, type RegionBounds } from "../src/terrain/terrain-types.ts";
import {
  BIOME_CONTENT, BIOME_DESERT, biomeScatterConfigs, resolveLayer, resolveBeachConfig,
  surveyRegionRelief, scatterBiomeContent, defaultWaterLevel,
  PINE_ASSET, BROADLEAF_ASSET, CACTUS_ASSET, BUSH_ASSET, GRASS_ASSET, ROCK_ASSET, PALM_ASSET,
} from "../src/terrain/biome-content.ts";
import { scatterAssets, type AssetInstance, type ScatterConfig } from "../src/terrain/asset-scatter.ts";
import { CLIMATE_BIOME, CLIMATE_CHANNELS, type TerrainTile } from "../src/terrain/types.ts";
import { EntityTable, ops } from "../src/engine.ts";
import { createEcsWorld } from "../src/ecs/world.ts";
import { createTransformStorage } from "../src/ecs/facade.ts";
import { UniformGridSpatialIndex } from "../src/spatial/index.ts";
import { SkillRegistry, type WorldContext } from "../src/skills/registry.ts";
import { registerCoreSkills } from "../src/skills/index.ts";
import { resolveProfile } from "../src/skills/permissions.ts";
import { LiminaTracer } from "../src/observability/event.ts";
import type { MCPResponse } from "../src/mcp/protocol.ts";

function assert(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new Error("p11_biome_content FAIL: " + msg);
}
function ok(res: MCPResponse | undefined): Record<string, unknown> {
  if (res === undefined || !res.success) throw new Error("call failed: " + JSON.stringify(res?.error));
  return res.result as Record<string, unknown>;
}
const sameInstances = (a: AssetInstance[], b: AssetInstance[]): boolean => {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].assetId !== b[i].assetId) return false;
    for (const k of ["x", "y", "z", "yaw", "scale"] as (keyof AssetInstance)[]) if (!Object.is(a[i][k], b[i][k])) return false;
  }
  return true;
};

const SEED = 1234;
const BOUNDS: RegionBounds = { minTx: 0, minTz: 0, maxTx: 1, maxTz: 1 }; // 2×2 = 4 tiles
const src = new ProceduralTerrainSource();

// Generate every tile of a typed region + survey its relief (the way the helper does).
function regionTiles(type: Parameters<typeof terrainTypeHints>[0], bounds: RegionBounds): { tiles: TerrainTile[]; hints: Record<string, number>; survey: { minY: number; maxY: number } } {
  const hints = terrainTypeHints(type, bounds);
  const tiles: TerrainTile[] = [];
  for (let tz = bounds.minTz; tz <= bounds.maxTz; tz++) {
    for (let tx = bounds.minTx; tx <= bounds.maxTx; tx++) tiles.push(src.generateTile({ seed: SEED, tx, tz, lod: 0, hints }));
  }
  return { tiles, hints, survey: surveyRegionRelief(src, SEED, bounds, hints) };
}
// Aggregate a scatter config across a region's tiles (the SAME tile loop asset.scatter runs).
function scatterRegion(tiles: TerrainTile[], config: ScatterConfig): AssetInstance[] {
  const out: AssetInstance[] = [];
  for (const t of tiles) for (const inst of scatterAssets(t, SEED, config)) out.push(inst);
  return out;
}
const countBy = (insts: AssetInstance[], id: string): number => insts.filter((p) => p.assetId === id).length;

// ── 1. ASSETS LOAD: every curated CC0 asset places as a gltf entity + hash ────────────
function makeHeadlessWorld(): WorldContext {
  const ecs = createEcsWorld();
  const scene = { add() {}, remove() {}, position: { set() {}, x: 0, y: 0, z: 0 }, background: null as unknown };
  const camera = { position: { set() {} }, aspect: 1, lookAt() {}, updateProjectionMatrix() {} };
  return { ecs, transforms: createTransformStorage(ecs), spatial: new UniformGridSpatialIndex(), entities: new EntityTable(), tags: new Map(), scene, camera, ops, mode: "headless" };
}
ops.op_physics_create_world(-9.81);
const registry = new SkillRegistry(new LiminaTracer("ses_p11_biome"));
const core = registerCoreSkills(registry);
const world = makeHeadlessWorld();
const base = { agentId: "agt_biome", sessionId: "ses_p11_biome", permissions: resolveProfile("builder.readWrite"), tick: 0, world };

const NEW_ASSETS = [PINE_ASSET, BROADLEAF_ASSET, CACTUS_ASSET, BUSH_ASSET, GRASS_ASSET];
const placedHashes = new Map<string, string>();
for (const id of NEW_ASSETS) {
  const r = ok(await registry.invoke("asset.place", { assetId: id, position: [0, 0, 0] }, base));
  assert(typeof r.entity === "string" && typeof r.hash === "string" && (r.hash as string).startsWith("sha256:"), `${id} did not place as a hashed gltf entity`);
  placedHashes.set(id, r.hash as string);
}
// Distinct bytes → distinct content hashes (the palette is really five different assets).
assert(new Set(placedHashes.values()).size === NEW_ASSETS.length, "two curated assets share a content hash (not distinct meshes)");

// ── 2 + 3. MOUNTAINS: pine on lower slopes + rock higher; the tree line is falsifiable ─
const mtn = regionTiles("mountains", BOUNDS);
const mtnConfigs = biomeScatterConfigs("mountains", mtn.survey);
assert(mtnConfigs.length === BIOME_CONTENT.mountains.length, "mountains layer count mismatch");
const pineCfg = mtnConfigs[0]; // layer 0 = pines, the elevation-gated one
assert(pineCfg.assets.length === 1 && pineCfg.assets[0].id === PINE_ASSET, "mountains layer 0 is not the pine layer");
assert(pineCfg.elevationMax !== undefined, "mountains pine layer has no tree line (elevationMax unset)");
const treeLine = pineCfg.elevationMax!;
// Non-vacuous: the region genuinely rises ABOVE the tree line (bare peaks exist).
assert(mtn.survey.maxY > treeLine + 0.5, `tree line ${treeLine.toFixed(1)} is not below the peaks (maxY ${mtn.survey.maxY.toFixed(1)}) — gate would be vacuous`);

const pines = scatterRegion(mtn.tiles, pineCfg);
const rocks = scatterRegion(mtn.tiles, mtnConfigs[1]);
assert(pines.length > 0 && pines.every((p) => p.assetId === PINE_ASSET), "mountains placed no pines");
assert(rocks.length > 0 && rocks.every((p) => p.assetId === ROCK_ASSET), "mountains placed no boulders");
// The pine layer carries an embedRadius, which SINKS the recorded y into the slope — so a
// pine's recorded y is NOT the surface y the tree-line gate compares against (a candidate
// whose surface sits just above the line can sink to below it, and vice-versa near the line).
// The tree-line CONTRACT is about the SURFACE seating, so verify it on the un-embedded config
// (recorded y == surface y): same gate, same RNG stream, no sink. Acceptance is identical to
// the embedded run (the sink is applied AFTER the gate), which we cross-check below.
const pineCfgNoEmbed: ScatterConfig = { ...pineCfg, embedRadius: 0, assets: pineCfg.assets.map((a) => ({ id: a.id, ...(a.weight !== undefined ? { weight: a.weight } : {}) })) };
const pinesSeated = scatterRegion(mtn.tiles, pineCfgNoEmbed);                 // recorded y == surface y
assert(pinesSeated.length === pines.length, `embed changed the placed pine count (${pines.length} vs seated ${pinesSeated.length}) — the sink leaked into the gate`);
// Every pine is BELOW the tree line on the true SEATING surface (the icy peaks stay bare).
assert(pinesSeated.every((p) => p.y <= treeLine + 1e-6), "a pine sits ABOVE the mountain tree line on the seating surface (ice line not enforced)");
// FALSIFIABLE SUPERSET (bidirectional, on surface y): drop the tree line → the high pines
// reappear, and the capped run is EXACTLY the loosened run filtered to the cap — nothing extra
// (subset) AND nothing missing (a sub-sink leak just under the line would break equality).
const pinesSeatedLoose = scatterRegion(mtn.tiles, { ...pineCfgNoEmbed, elevationMax: undefined });
assert(pinesSeatedLoose.length > pinesSeated.length, `tree line excluded nothing (${pinesSeated.length} vs loosened ${pinesSeatedLoose.length})`);
assert(pinesSeatedLoose.some((p) => p.y > treeLine), "test setup: no pine candidates above the tree line (cap vacuous)");
assert(sameInstances(pinesSeated, pinesSeatedLoose.filter((p) => p.y <= treeLine + 1e-6)),
  "capped pines are not EXACTLY the uncapped run filtered to the tree line (surface-y gate is not a pure post-filter)");

// ── 4. DESERT CACTI: biome-gated, falsifiably absent outside the desert biome ─────────
const des = regionTiles("desert", BOUNDS);
const desConfigs = biomeScatterConfigs("desert", des.survey);
const cactusCfg = desConfigs[0];
assert(cactusCfg.assets[0].id === CACTUS_ASSET && cactusCfg.biomes?.includes(BIOME_DESERT), "desert layer 0 is not the biome-gated cactus layer");
const desertCacti = scatterRegion(des.tiles, cactusCfg);
assert(desertCacti.length > 0 && desertCacti.every((p) => p.assetId === CACTUS_ASSET), "desert placed no cacti");
// The SAME cactus config over a FOREST region (boreal/wet biome) → ZERO cacti.
const forest = regionTiles("forest", BOUNDS);
const cactiInForest = scatterRegion(forest.tiles, cactusCfg);
assert(cactiInForest.length === 0, `cacti leaked into the forest (${cactiInForest.length}) — biome gate not enforced`);
// Falsifiable control: WITHOUT the biome gate the same forest region DOES place cacti
// (so the empty result above is the gate doing work, not an empty candidate set).
const cactiNoGate = scatterRegion(forest.tiles, { ...cactusCfg, biomes: undefined });
assert(cactiNoGate.length > 0, "removing the biome gate still placed nothing in the forest — the desert-only result was vacuous");

// ── 2b. FOREST + PLAINS content is biome-appropriate ──────────────────────────────────
const forestTrees = scatterRegion(forest.tiles, biomeScatterConfigs("forest", forest.survey)[0]);
assert(countBy(forestTrees, BROADLEAF_ASSET) > 0 && countBy(forestTrees, PINE_ASSET) > 0, "forest did not place a broadleaf+pine mix");
const forestBush = scatterRegion(forest.tiles, biomeScatterConfigs("forest", forest.survey)[1]);
assert(forestBush.length > 0 && forestBush.every((p) => p.assetId === BUSH_ASSET), "forest placed no understorey bushes");
const plains = regionTiles("plains", BOUNDS);
const grass = scatterRegion(plains.tiles, biomeScatterConfigs("plains", plains.survey)[0]);
assert(grass.length > 0 && grass.every((p) => p.assetId === GRASS_ASSET), "plains placed no grass");

// ── 5. ON-SURFACE (drop parity vs the heightfield collider) + DETERMINISTIC ────────────
// The pine layer carries an embedRadius, which deliberately SINKS instances into a slope so
// their downhill base lip stays grounded (the floating-trees fix — verified in p11_prop_tether).
// Pure surface-SEATING is a property of the base placement, so we drop-parity against the
// un-embedded config (embedRadius stripped per-asset + layer): recorded y == the surface.
const t0 = mtn.tiles[0];
const hId = ops.op_physics_add_heightfield(t0.origin[0], t0.origin[1], t0.origin[2], t0.nrows, t0.ncols, t0.scale[0], t0.scale[1], t0.scale[2], t0.heights);
ops.op_physics_step();
const onTile0 = scatterAssets(t0, SEED, pineCfgNoEmbed);
assert(sameInstances(onTile0, scatterAssets(t0, SEED, pineCfgNoEmbed)), "biome scatter is non-deterministic (same tile+config differ)");
const ray = new Float32Array(6);
let checked = 0;
const stride = Math.max(1, Math.floor(onTile0.length / 12));
for (let i = 0; i < onTile0.length && checked < 10; i += stride) {
  const p = onTile0[i];
  ops.op_physics_raycast(p.x, p.y + 60, p.z, 0, -1, 0, 120, ray);
  if (ray[0] === 1 && ray[5] === hId) {
    assert(Math.abs(ray[3] - p.y) < 0.2, `pine ${i} off-collider: y=${p.y.toFixed(3)} collider=${ray[3].toFixed(3)}`);
    assert(Math.abs(src.sampleHeight(SEED, p.x, p.z, 0, mtn.hints) - p.y) < 0.6, `pine ${i} off sampleHeight`);
    checked++;
  }
}
assert(checked >= 5, `expected to surface-check several pines, only ${checked}`);

// ── 6. THE HELPER + SKILL: scatterBiomeContent over a generated region ────────────────
ops.op_physics_create_world(-9.81);
const skreg = new SkillRegistry(new LiminaTracer("ses_p11_biome_skill"));
const skcore = registerCoreSkills(skreg);
const skworld = makeHeadlessWorld();
const skbase = { agentId: "agt_biome2", sessionId: "ses_p11_biome_skill", permissions: resolveProfile("builder.readWrite"), tick: 0, world: skworld };
const gen = ok(await skreg.invoke("world.generateRegion", { seed: SEED, bounds: BOUNDS, lod: 0, type: "mountains" }, skbase));
const regionId = gen.regionId as string;
const content = await scatterBiomeContent({ registry: skreg, source: skcore.terrain.source, regionId, type: "mountains", bounds: BOUNDS, seed: SEED, base: skbase });
assert(content.instances > 0 && content.layers.length === BIOME_CONTENT.mountains.length, "scatterBiomeContent placed nothing / wrong layer count");
assert(content.layers.every((l) => l.mounted >= 1), "a biome-content layer mounted no InstancedMesh (render path inert)");
assert(content.layers[0].assetHashes[PINE_ASSET] === skcore.assets.resolve(PINE_ASSET).hash, "scatterBiomeContent did not pin the pine hash");
// The helper's resolved configs match the pure path (same survey → same gates).
assert(content.configs[0].elevationMax !== undefined && Math.abs(content.configs[0].elevationMax! - treeLine) < 1e-9, "helper resolved a different tree line than the pure path");

// ── 7. BEACH PARITY: the catalog reproduces beachScatterConfig bit-for-bit ─────────────
const seaLevel = 3.19;
const beach = resolveBeachConfig(seaLevel);
const beachExpected: ScatterConfig = {
  seed: 21, density: 14, coverage: 0.05, cluster: 0.85, clusterFreq: 1 / 30,
  assets: [{ id: PALM_ASSET, weight: 3 }, { id: ROCK_ASSET, weight: 2 }],
  slopeMax: 0.7, sizeRange: [1.1, 2.4], elevationMin: seaLevel,
};
// Deep canonicalization (sorted keys, recursive) so the comparison is byte-exact on every
// value but independent of key insertion ORDER (which doesn't affect placements).
const canon = (v: unknown): string => {
  if (Array.isArray(v)) return `[${v.map(canon).join(",")}]`;
  if (v !== null && typeof v === "object") {
    return `{${Object.keys(v as Record<string, unknown>).sort().map((k) => `${JSON.stringify(k)}:${canon((v as Record<string, unknown>)[k])}`).join(",")}}`;
  }
  return JSON.stringify(v);
};
assert(canon(beach) === canon(beachExpected),
  `beach config drifted from the original recipe:\n got ${canon(beach)}\n want ${canon(beachExpected)}`);

// Water types default a sensible sea level (low 40% floods); land types don't water-gate.
const isl = regionTiles("islands", BOUNDS);
assert(biomeScatterConfigs("islands", isl.survey)[0].elevationMin === defaultWaterLevel(isl.survey), "islands palm layer not water-gated to the default sea level");
assert(biomeScatterConfigs("plains", plains.survey)[0].elevationMin === undefined, "plains layer should not be water-gated");
// resolveLayer omits unset fields (so a no-gate layer stays a plain density scatter).
assert(!("elevationMax" in resolveLayer({ seed: 1, assets: [{ id: GRASS_ASSET }] }, isl.survey)), "resolveLayer emitted an unset elevation gate");

ops.op_log(
  `p11_biome_content OK: 5 curated CC0 assets place as hashed gltf entities (pine/broadleaf/cactus/bush/grass, distinct hashes); ` +
  `mountains pine tree-line falsifiable on the seating surface (capped ${pinesSeated.length} == uncapped ${pinesSeatedLoose.length} filtered to the line, 0 above, peaks bare to Y${mtn.survey.maxY.toFixed(0)} > line ${treeLine.toFixed(0)}); ` +
  `desert cacti biome-gated (${desertCacti.length} in desert, 0 in forest, ${cactiNoGate.length} ungated — gate non-vacuous); ` +
  `forest broadleaf+pine+bush, plains grass; ${checked} pines drop-checked vs collider+sampleHeight, deterministic; ` +
  `scatterBiomeContent surveyed+scattered ${content.instances} mountain instances over ${content.layers.length} layers (hashes pinned, meshes mounted); beach config byte-identical to the original recipe.`,
);
