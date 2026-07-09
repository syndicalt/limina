// p_map_terrain — Phase 1.1 "Map-Driven Worlds": terrain.create's generate.source==="map"
// branch rasterizes a COMMITTED WorldMap IR (js/src/world/worldmap.ts) into an editable
// terrain tile via world/pipeline/map-raster.mjs (a PURE, deterministic function of the map +
// params — no THREE/DOM, no Date/Math.random).
//
// Run: ./target/release/limina js/test/p_map_terrain.ts
//
// Proves: (1) terrain.create {generate:{source:"map"}} succeeds headless and the resulting
// tile is non-flat, with both land (>seaLevel) and sea (<seaLevel) cells present, sourced from
// the IR's own seaLevel; (2) two FRESH invocations reproduce byte-identical heights/paintMat/
// paintW (the record-ops-not-bytes replay contract — replay re-rasterizes, never snapshots the
// bytes); (3) the built land mask (heights > seaLevelM) matches the IR's own land polygons
// (IoU >= 0.85, rasterized via the module's OWN point-in-polygon — landClassifier); (4) a
// tampered map asset (one flipped byte) makes terrain.create THROW — the content-hash pin is
// load-bearing here, deliberately stricter than asset.place's warn-not-throw; (5) at least one
// grid sample along a river polyline sits >=0.8m below an off-channel point 10m perpendicular
// to the river's local direction (the waterway carve).

import { ops, EntityTable, type WorldContext } from "../src/engine.ts";
import { createEcsWorld } from "../src/ecs/world.ts";
import { createTransformStorage } from "../src/ecs/facade.ts";
import { UniformGridSpatialIndex } from "../src/spatial/index.ts";
import { SkillRegistry } from "../src/skills/registry.ts";
import { resolveProfile } from "../src/skills/permissions.ts";
import { LiminaTracer } from "../src/observability/event.ts";
import { registerTerrainEditSkills, type EditableTerrain } from "../src/skills/terrain-edit.ts";
import { AssetRegistry, assetContentHash } from "../src/asset-registry.ts";
import { landClassifier, rasterizeWorldMap } from "../src/world/pipeline/map-raster.mjs";
import type { WorldMap } from "../src/world/worldmap.ts";

function assert(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new Error("p_map_terrain: " + msg);
}

function makeHeadlessWorld(): WorldContext {
  const ecs = createEcsWorld();
  const scene = { add() {}, remove() {}, position: { set() {}, x: 0, y: 0, z: 0 }, background: null as unknown };
  const camera = { position: { set() {} }, aspect: 1, lookAt() {}, updateProjectionMatrix() {} };
  return {
    ecs, transforms: createTransformStorage(ecs), spatial: new UniformGridSpatialIndex(),
    entities: new EntityTable(), tags: new Map(), scene, camera, ops, mode: "headless",
  };
}

const perms = resolveProfile("builder.readWrite");
const MAP_ASSET_ID = "maps/primary.worldmap.json";
const SIZE = 200;
const RESOLUTION = 129;
const HALF = SIZE / 2;
const STEP = SIZE / (RESOLUTION - 1);

interface TileLike { heights: Float32Array; paintMat?: Uint8Array; paintW?: Float32Array }
interface CreateOut { tile: TileLike; entity: string; mapHash?: string }

async function createMapTerrain(session: string, assets: AssetRegistry): Promise<CreateOut> {
  const world = makeHeadlessWorld();
  const layers = new Map<string, EditableTerrain>();
  const registry = new SkillRegistry(new LiminaTracer(session));
  registerTerrainEditSkills(registry, layers, assets);
  const at = (tick: number) => ({ agentId: "agt_map", sessionId: session, permissions: perms, tick, world });

  const res = await registry.invoke("terrain.create", {
    size: SIZE, resolution: RESOLUTION, generate: { source: "map", mapAssetId: MAP_ASSET_ID, seed: 11 },
  }, at(1));
  assert(res.success, `terrain.create (map source) must succeed: ${res.success ? "" : JSON.stringify(res.error)}`);
  const out = res.result as { entity: string; mapHash?: string };
  const tile = layers.get(out.entity)!.tile as unknown as TileLike;
  return { tile, entity: out.entity, mapHash: out.mapHash };
}

function nearestCellIndex(wx: number, wz: number): number {
  const col = Math.max(0, Math.min(RESOLUTION - 1, Math.round((wx + HALF) / STEP)));
  const row = Math.max(0, Math.min(RESOLUTION - 1, Math.round((wz + HALF) / STEP)));
  return row * RESOLUTION + col;
}

// ── real asset registry over the host asset root (assets/maps/primary.worldmap.json). ──────
const assets = new AssetRegistry();

// 1. terrain.create {source:"map"} succeeds headless; tile heights non-flat.
const a = await createMapTerrain("ses_map_a", assets);
assert(a.tile.heights.length === RESOLUTION * RESOLUTION, `heights grid length (${a.tile.heights.length})`);
{
  let mn = Infinity, mx = -Infinity;
  for (const h of a.tile.heights) { if (h < mn) mn = h; if (h > mx) mx = h; }
  assert(mx - mn > 1, `map-rasterized terrain must be non-flat (range ${(mx - mn).toFixed(3)})`);
}
assert(a.mapHash !== undefined && a.mapHash.length === 64, `terrain.create must return the map's contentHash (got ${a.mapHash})`);

// ── the source-of-truth WorldMap (read directly, for the seaLevel/IoU/waterway checks). ────
const mapText = new TextDecoder().decode(ops.op_read_asset(MAP_ASSET_ID));
const worldMap = JSON.parse(mapText) as WorldMap;
const seaLevelM = worldMap.seaLevel;

// seaLevel comes from the IR: both land (>seaLevel) and sea (<seaLevel) cells must be present.
{
  let anyAboveSea = false, anyBelowSea = false;
  for (const h of a.tile.heights) { if (h > seaLevelM) anyAboveSea = true; if (h < seaLevelM) anyBelowSea = true; }
  assert(anyAboveSea && anyBelowSea, "map-sourced terrain must contain both land (>seaLevel) and sea (<seaLevel) cells");
}

// 2. Determinism: two FRESH invocations -> byte-identical heights + paintMat + paintW.
const b = await createMapTerrain("ses_map_b", assets);
{
  assert(a.tile.paintMat !== undefined && a.tile.paintW !== undefined, "a map-sourced tile must install paintMat/paintW");
  assert(b.tile.paintMat !== undefined && b.tile.paintW !== undefined, "a map-sourced tile must install paintMat/paintW");
  let firstDiffH = -1, firstDiffM = -1, firstDiffW = -1;
  for (let i = 0; i < a.tile.heights.length; i++) {
    if (firstDiffH === -1 && a.tile.heights[i] !== b.tile.heights[i]) firstDiffH = i;
    if (firstDiffM === -1 && a.tile.paintMat![i] !== b.tile.paintMat![i]) firstDiffM = i;
    if (firstDiffW === -1 && a.tile.paintW![i] !== b.tile.paintW![i]) firstDiffW = i;
  }
  assert(firstDiffH === -1, `heights must be deterministic (diverged at cell ${firstDiffH})`);
  assert(firstDiffM === -1, `paintMat must be deterministic (diverged at cell ${firstDiffM})`);
  assert(firstDiffW === -1, `paintW must be deterministic (diverged at cell ${firstDiffW})`);
  assert(a.mapHash === b.mapHash, "mapHash must be identical across fresh invocations");
}

// 3. Land-mask IoU >= 0.85: rasterize the IR's land polygons at gate resolution (the module's
//    OWN point-in-polygon, via landClassifier) as the truth mask; built mask = heights > seaLevelM.
{
  const classify = landClassifier(worldMap);
  let intersection = 0, union = 0;
  for (let row = 0; row < RESOLUTION; row++) {
    const wz = -HALF + row * STEP;
    for (let col = 0; col < RESOLUTION; col++) {
      const wx = -HALF + col * STEP;
      const i = row * RESOLUTION + col;
      const truth = classify.isLand(wx, wz);
      const built = a.tile.heights[i] > seaLevelM;
      if (truth || built) union++;
      if (truth && built) intersection++;
    }
  }
  const iou = union > 0 ? intersection / union : 1;
  ops.op_log(`[js] p_map_terrain: land-mask IoU = ${iou.toFixed(4)} (${intersection}/${union})`);
  assert(iou >= 0.85, `land-mask IoU must be >= 0.85 (got ${iou.toFixed(4)})`);
}

// 4. Tamper: flip a byte in a copied IR fixture -> terrain.create THROWS (hash mismatch, or a
//    JSON/schema parse failure — either is a load-bearing failure "THROWS" satisfies).
{
  const rawBytes = ops.op_read_asset(MAP_ASSET_ID);
  const tampered = new Uint8Array(rawBytes);
  const flipAt = Math.floor(tampered.length / 2);
  tampered[flipAt] = tampered[flipAt] ^ 0xff;
  const tamperedAssets = AssetRegistry.fromBundle([
    { id: MAP_ASSET_ID, path: `assets/${MAP_ASSET_ID}`, hash: assetContentHash(tampered, ops), bytes: tampered },
  ], ops);

  const world = makeHeadlessWorld();
  const layers = new Map<string, EditableTerrain>();
  const registry = new SkillRegistry(new LiminaTracer("ses_map_tamper"));
  registerTerrainEditSkills(registry, layers, tamperedAssets);
  const res = await registry.invoke("terrain.create", {
    size: SIZE, resolution: RESOLUTION, generate: { source: "map", mapAssetId: MAP_ASSET_ID, seed: 11 },
  }, { agentId: "agt_map", sessionId: "ses_map_tamper", permissions: perms, tick: 1, world });
  assert(!res.success, "terrain.create must FAIL on a tampered map asset");
}

// 5. Waterway effect: at least one grid sample along a river polyline sits >=0.8m below an
//    off-channel point 10m perpendicular to the river's local direction (well outside the
//    channel's ~3.5m carve radius, so it reads the un-carved base surface).
{
  let found = false;
  let bestDrop = -Infinity;
  for (const w of worldMap.waterways) {
    const pts = w.points;
    for (let idx = 1; idx < pts.length - 1; idx++) {
      const [x0, z0] = pts[idx - 1];
      const [x1, z1] = pts[idx + 1];
      const dx = x1 - x0, dz = z1 - z0;
      const len = Math.hypot(dx, dz) || 1;
      const px = -dz / len, pz = dx / len; // unit perpendicular to the local river direction
      const [cx, cz] = pts[idx];
      const centerIdx = nearestCellIndex(cx, cz);
      const offIdx = nearestCellIndex(cx + px * 10, cz + pz * 10);
      const drop = a.tile.heights[offIdx] - a.tile.heights[centerIdx];
      if (drop > bestDrop) bestDrop = drop;
      if (drop >= 0.8) found = true;
    }
  }
  assert(found, `at least one river-polyline sample must sit >=0.8m below an off-channel point (best drop found: ${bestDrop.toFixed(3)}m)`);
}

// 6. Blight overlay (caesura): a painted `blight` biome region marks the per-cell corruption mask
//    (rasterizeWorldMap.blight); a map WITHOUT one marks zero — falsifiable in both directions — and
//    the mask is deterministic. This is the design-space Grey Field's caesura, sourced like any biome
//    but treated as an OVERLAY (it drains the ground colour rather than being its own paint material).
{
  const rasterOpts = { size: SIZE, resolution: RESOLUTION, seed: 11, baseAmplitude: 30 };
  const noBlight = worldMap.biomes.filter((b) => b.biome !== "blight");
  const cleanRaster = rasterizeWorldMap({ ...worldMap, biomes: noBlight }, rasterOpts);
  let cleanCells = 0;
  for (const v of cleanRaster.blight) if (v > 0) cleanCells++;
  assert(cleanCells === 0, `a map with no blight biome must mark zero blight cells (got ${cleanCells})`);

  // Relabel an existing biome's ring as `blight` → those cells are marked (overlay, not a paint id).
  const withBlight = { ...worldMap, biomes: [...noBlight, { biome: "blight" as const, points: worldMap.biomes[0].points }] };
  const r1 = rasterizeWorldMap(withBlight, rasterOpts);
  let blightCells = 0;
  for (const v of r1.blight) if (v > 0) blightCells++;
  assert(blightCells > 0, `a painted blight biome region must mark blight cells (got ${blightCells})`);

  const r2 = rasterizeWorldMap(withBlight, rasterOpts);
  let diff = -1;
  for (let i = 0; i < r1.blight.length; i++) if (r1.blight[i] !== r2.blight[i]) { diff = i; break; }
  assert(diff === -1, `blight mask must be deterministic (diverged at cell ${diff})`);
  ops.op_log(`[js] p_map_terrain: blight overlay marks ${blightCells} cells (clean map marks 0), deterministic`);
}

ops.op_log(
  "[js] p_map_terrain OK: terrain.create generate.source='map' rasterizes the committed WorldMap IR " +
  "(assets/maps/primary.worldmap.json) into an editable tile via world/pipeline/map-raster.mjs — " +
  "non-flat with both land+sea cells sourced from the IR's seaLevel, deterministic (byte-identical " +
  "heights/paintMat/paintW/mapHash across fresh invocations), the built land mask (heights > seaLevel) " +
  "matches the IR's own land polygons at IoU >= 0.85, a tampered map asset (flipped byte) makes " +
  "terrain.create THROW (content-hash pinned — load-bearing, unlike asset.place's warn), and at least " +
  "one river-polyline sample carves >=0.8m below an off-channel point.",
);
