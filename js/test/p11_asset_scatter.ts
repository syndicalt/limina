// Phase 11 — asset.scatter + an agent-set ScatterConfig: scatter curated,
// content-addressed assets BY ID across a region, deterministic + replayable +
// elevation/slope-aware (closing the Phase-9 "climate/elevation field unused" gap).
//
//   1. scatterAssets is a PURE function of (tile, seed, config): identical config+seed
//      -> byte-identical instances; a different config seed reshuffles.
//   2. Instances sit ON the surface — drop parity against the heightfield COLLIDER
//      (a body rests where an instance stands) AND vs terrain.sampleHeight.
//   3. THE ELEVATION RULE IS FALSIFIABLE + NON-VACUOUS: a low tree-line excludes the
//      high candidates (zero above it); loosening it makes them reappear as a strict
//      SUPERSET (the capped run == the uncapped run filtered to the cap). The slope
//      rule likewise demonstrably thins a steep tile.
//   4. The render InstancedMesh matrices REPRODUCE the scatter (translate (x,y,z),
//      uniform scale, pure +Y yaw) — mirrors p9_props.
//   5. THE SKILL: asset.scatter records the ScatterConfig REQUEST in the log (NEVER
//      instance transforms); the recorder COMMITS each palette asset's content hash
//      (pins authored identity); the export serializes the asset bytes.
//   6. REPLAY from the SERIALIZED package (guarded vs the native asset root) recomputes
//      bit-identical placements + hash-verifies each asset; a swapped hash is rejected.

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
import { scatterAssets, type AssetInstance, type ScatterConfig } from "../src/terrain/asset-scatter.ts";
import { buildAssetInstancedMeshes } from "../src/terrain/asset-scatter-render.ts";
import type { SkillCommand } from "../src/worldlog/log.ts";
import type { TerrainTile } from "../src/terrain/types.ts";
import type { MCPResponse } from "../src/mcp/protocol.ts";

function assert(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new Error("p11_asset_scatter FAIL: " + msg);
}
function ok(res: MCPResponse | undefined): Record<string, unknown> {
  if (res === undefined || !res.success) throw new Error("call failed: " + JSON.stringify(res?.error));
  return res.result as Record<string, unknown>;
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

ops.op_physics_create_world(-9.81);

const GLB = "triangle.glb";
const GLTF = "textured-triangle.gltf";
const WORLD_SEED = 11;
const src = new ProceduralTerrainSource();
const tile = src.generateTile({ seed: WORLD_SEED, tx: 0, tz: 0, lod: 0 });

// Surface-Y range of this tile (world Y = origin.y + h*scale.y).
let minH = Infinity, maxH = -Infinity;
for (let i = 0; i < tile.heights.length; i++) { const h = tile.heights[i]; if (h < minH) minH = h; if (h > maxH) maxH = h; }
const minY = tile.origin[1] + minH * tile.scale[1];
const maxY = tile.origin[1] + maxH * tile.scale[1];
const midY = (minY + maxY) / 2;
assert(maxY - minY > 1, `expected a varied tile surface to exercise the tree line (range ${minY.toFixed(2)}..${maxY.toFixed(2)})`);

const PALETTE = [{ id: GLB, weight: 3 }, { id: GLTF, weight: 1 }];
const baseConfig: ScatterConfig = { seed: 5, density: 16, assets: PALETTE, sizeRange: [0.5, 1.5] };

// 1. Determinism + seed sensitivity ----------------------------------------------
const r1 = scatterAssets(tile, WORLD_SEED, baseConfig);
const r2 = scatterAssets(tile, WORLD_SEED, baseConfig);
assert(r1.length > 0, "expected a non-empty scatter");
assert(sameInstances(r1, r2), "scatterAssets is non-deterministic (same tile+seed+config differ)");
const rSeed6 = scatterAssets(tile, WORLD_SEED, { ...baseConfig, seed: 6 });
assert(!sameInstances(r1, rSeed6), "a different config seed produced identical placements");
assert(sameInstances(rSeed6, scatterAssets(tile, WORLD_SEED, { ...baseConfig, seed: 6 })), "the distinct config is not itself reproducible");
// Both palette assets actually get used (weighted pick is real).
assert(r1.some((p) => p.assetId === GLB) && r1.some((p) => p.assetId === GLTF), "weighted palette did not place both assets");

// 2. On-surface: drop parity vs the heightfield COLLIDER + terrain.sampleHeight ----
const hId = ops.op_physics_add_heightfield(
  tile.origin[0], tile.origin[1], tile.origin[2],
  tile.nrows, tile.ncols, tile.scale[0], tile.scale[1], tile.scale[2], tile.heights,
);
ops.op_physics_step();
const ray = new Float32Array(6);
let surfaceChecked = 0;
const stride = Math.max(1, Math.floor(r1.length / 16));
for (let i = 0; i < r1.length && surfaceChecked < 16; i += stride) {
  const p = r1[i];
  ops.op_physics_raycast(p.x, p.y + 60, p.z, 0, -1, 0, 120, ray);
  if (ray[0] === 1 && ray[5] === hId) {
    assert(Math.abs(ray[3] - p.y) < 0.2, `instance ${i} off-collider: y=${p.y.toFixed(3)} collider=${ray[3].toFixed(3)}`);
    // Drop parity also against the deterministic surface query terrain.sampleHeight uses.
    const sh = src.sampleHeight(WORLD_SEED, p.x, p.z, 0);
    assert(Math.abs(sh - p.y) < 0.6, `instance ${i} off sampleHeight: y=${p.y.toFixed(3)} sampleHeight=${sh.toFixed(3)}`);
    surfaceChecked++;
  }
}
assert(surfaceChecked >= 8, `expected to surface-check several instances, only ${surfaceChecked}`);

// 3. ELEVATION RULE — falsifiable + non-vacuous (the Phase-9 gap closed) ----------
const uncapped = scatterAssets(tile, WORLD_SEED, { ...baseConfig, seed: 9 });
const capped = scatterAssets(tile, WORLD_SEED, { ...baseConfig, seed: 9, elevationMax: midY });
// The cap is REAL: uncapped has candidates above the tree line that the cap removes.
assert(uncapped.some((p) => p.y > midY), "test setup: no candidates above the tree line (cap would be vacuous)");
assert(capped.length < uncapped.length, `tree-line cap did not exclude anything (${capped.length} vs ${uncapped.length})`);
// Zero instances above the cap.
assert(capped.every((p) => p.y <= midY), "an instance sits ABOVE the tree line (elevationMax not enforced)");
// SUPERSET: the capped run is EXACTLY the uncapped run filtered to the cap (loosen ->
// the high ones reappear, reproducibly — the rule is a pure post-filter on the field).
assert(sameInstances(capped, uncapped.filter((p) => p.y <= midY)), "capped scatter is not a reproducible subset of the uncapped scatter");
// A cap below the whole tile -> zero placements.
const noneAbove = scatterAssets(tile, WORLD_SEED, { ...baseConfig, seed: 9, elevationMax: minY - 1 });
assert(noneAbove.length === 0, `a tree line below the tile floor should place nothing, got ${noneAbove.length}`);
// elevationMin (water line) symmetric: floor above the tile ceiling -> nothing.
assert(scatterAssets(tile, WORLD_SEED, { ...baseConfig, seed: 9, elevationMin: maxY + 1 }).length === 0, "elevationMin above the tile ceiling should place nothing");

// 3b. SLOPE RULE — a steep synthetic tile is thinned by slopeMax.
const N = 33;
const steepH = new Float32Array(N * N);
for (let r = 0; r < N; r++) for (let c = 0; c < N; c++) steepH[r * N + c] = c * 0.2; // steep x-ramp
const steepTile: TerrainTile = { nrows: N, ncols: N, origin: [0, 0, 0], scale: [48, 12, 48], heights: steepH };
const steepAll = scatterAssets(steepTile, 1, { ...baseConfig, seed: 2 });
const steepFlatOnly = scatterAssets(steepTile, 1, { ...baseConfig, seed: 2, slopeMax: 0.2 });
assert(steepFlatOnly.length < steepAll.length, `slopeMax did not thin the steep tile (${steepFlatOnly.length} vs ${steepAll.length})`);

// 3c. CLIMATE RULE actually reads the climate grid (biome whitelist).
const biomeSet = new Set<number>();
{
  const ch = tile.climateChannels ?? 0;
  for (let i = 0; i < tile.nrows * tile.ncols; i++) biomeSet.add(tile.climate![i * ch + 2]);
}
const oneBiome = [...biomeSet][0];
const biomeScatter = scatterAssets(tile, WORLD_SEED, { ...baseConfig, seed: 9, biomes: [oneBiome] });
assert(biomeScatter.length > 0 && biomeScatter.length <= uncapped.length, "biome whitelist did not consult the climate grid as a filter");

// 4. RENDER matrices reproduce the scatter (mirror p9_props) ----------------------
{
  const geom = new THREE.BoxGeometry(1, 1, 1);
  const mat = new THREE.MeshStandardNodeMaterial({ color: 0x808080 });
  const root = new THREE.Group();
  root.add(new THREE.Mesh(geom, mat)); // single mesh at identity -> instance matrix == transform
  const sample = r1.slice(0, 12);
  const meshes = buildAssetInstancedMeshes(root, sample);
  assert(meshes.length === 1, `expected one InstancedMesh for a single-mesh asset, got ${meshes.length}`);
  const inst = meshes[0];
  assert(inst.count === sample.length, `InstancedMesh.count ${inst.count} != ${sample.length}`);
  const m = new THREE.Matrix4(), pos = new THREE.Vector3(), quat = new THREE.Quaternion(), scl = new THREE.Vector3();
  const vx = new THREE.Vector3(), vy = new THREE.Vector3();
  const close = (a: number, b: number, eps = 1e-5): boolean => Math.abs(a - b) <= eps;
  for (let i = 0; i < sample.length; i++) {
    const p = sample[i];
    inst.getMatrixAt(i, m);
    m.decompose(pos, quat, scl);
    assert(close(pos.x, p.x) && close(pos.y, p.y) && close(pos.z, p.z), `instance ${i} translation off`);
    assert(close(scl.x, p.scale) && close(scl.y, p.scale) && close(scl.z, p.scale), `instance ${i} scale not uniform==${p.scale}`);
    vx.set(1, 0, 0).applyQuaternion(quat);
    assert(close(vx.x, Math.cos(p.yaw)) && close(vx.y, 0, 1e-5) && close(vx.z, -Math.sin(p.yaw)), `instance ${i} yaw mismatch`);
    vy.set(0, 1, 0).applyQuaternion(quat);
    assert(close(vy.x, 0, 1e-5) && close(vy.y, 1, 1e-5) && close(vy.z, 0, 1e-5), `instance ${i} rotation not pure-Y`);
  }
}

// 5. THE SKILL: generate a region, then asset.scatter BOUND to it (regionId). The log
//    records regionId + ScatterConfig (NO instance transforms); the recorder commits
//    the palette hashes; the scatter sits on the GENERATED region's tiles.
function makeWorld(worldOps: EngineOps): WorldContext {
  const scene = { add() {}, remove() {}, position: { set() {}, x: 0, y: 0, z: 0 }, background: null as unknown };
  const camera = { position: { set() {} }, aspect: 1, lookAt() {}, updateProjectionMatrix() {} };
  const ecs = createEcsWorld();
  return {
    ecs, transforms: createTransformStorage(ecs), spatial: new UniformGridSpatialIndex(),
    entities: new EntityTable(), tags: new Map(), scene, camera, ops: worldOps, mode: "headless",
  };
}
const BUILDER = resolveProfile("builder.readWrite");
const REGION = { minTx: 0, minTz: 0, maxTx: 1, maxTz: 1 }; // 2x2 = 4 tiles
const REGION_TILES = 4;
const treeLine = midY + (maxY - midY) * 0.5; // a real tree line within tile (0,0)'s range

const recTracer = new LiminaTracer("ses_p11scatter_author");
const authReg = new SkillRegistry(recTracer);
const authCore = registerCoreSkills(authReg);
const recorder = new WorldRecorder("ses_p11scatter_author");
recorder.attach(authReg);
// Record the physics world create so a replay re-creates it before re-applying tiles.
const recOps = recorder.wrapOps(ops);
const recWorld = makeWorld(recOps);
recOps.op_physics_create_world(-9.81);

const authCtx = { agentId: "agt_builder", sessionId: "ses_p11scatter_author", permissions: BUILDER, tick: 0, world: recWorld };
const genRes = ok(await authReg.invoke("world.generateRegion", { seed: WORLD_SEED, bounds: REGION, lod: 0 }, authCtx));
const regionId = genRes.regionId as string;
assert((genRes.tiles as number) === REGION_TILES, `expected ${REGION_TILES} generated tiles, got ${genRes.tiles}`);

const skillConfig: ScatterConfig = { seed: 5, density: 12, assets: PALETTE, sizeRange: [0.6, 1.4], elevationMax: treeLine };
const scattered = ok(await authReg.invoke("asset.scatter", { regionId, config: skillConfig }, authCtx));
const authPlacements = scattered.placements as AssetInstance[];
assert((scattered.instances as number) === authPlacements.length && authPlacements.length > 0, "skill returned no placements");
assert(authPlacements.every((p) => p.y <= treeLine), "skill placed an instance above the tree line over the region");
assert((scattered.mounted as number) >= 1, "skill mounted no InstancedMeshes (render path inert)");
const authHashes = scattered.assetHashes as Record<string, string>;
assert(authHashes[GLB] === authCore.assets.resolve(GLB).hash && authHashes[GLTF] === authCore.assets.resolve(GLTF).hash, "skill did not pin the palette asset hashes");
assert(scattered.regionId === regionId, "scatter is not bound to the generated region");

// SEED FOOTGUN CLOSED: scattering onto an ungenerated region fails loudly (no silent
// scatter onto a different/empty surface). Run on a SEPARATE registry so it doesn't
// pollute the recorded stream.
{
  const negReg = new SkillRegistry(new LiminaTracer("ses_neg"));
  registerCoreSkills(negReg);
  const neg = await negReg.invoke("asset.scatter", { regionId, config: skillConfig }, { agentId: "a", sessionId: "s", permissions: BUILDER, tick: 0, world: makeWorld(ops) });
  assert(!neg.success && JSON.stringify(neg.error).includes("unknown region"), "scatter onto an ungenerated region must fail loudly (seed footgun open)");
}

// The scatter REQUEST rode the trace: regionId + ScatterConfig, instance count a NUMBER,
// no transforms.
const ev = recTracer.trace("agt_builder").find((e) => e.type === "asset.scattered");
assert(ev !== undefined, "asset.scattered request not on the trace");
const evp = ev.payload as Record<string, unknown>;
assert(evp.regionId === regionId && typeof evp.instances === "number" && (evp.config as Record<string, unknown>).seed === 5, "trace event missing regionId / ScatterConfig / instance count");
assert(!("placements" in evp), "instance transforms leaked into the trace event");

// THE LOG records regionId + config (request), NOT the instance transforms; the
// recorder COMMITS the asset hashes (FALSIFIABLE — dropping commitFields drops this).
const cmd = recorder.commands.find((c): c is SkillCommand => c.kind === "skill" && c.tool === "asset.scatter");
assert(cmd !== undefined, "asset.scatter not recorded as a command");
const ci = cmd.input as Record<string, unknown>;
assert(ci.regionId === regionId && (ci.config as Record<string, unknown>).seed === 5 && Array.isArray((ci.config as Record<string, unknown>).assets), "recorded command missing regionId / ScatterConfig");
assert(!("placements" in ci) && !("instances" in ci), "recorded command carries instance data (must be the config request only)");
const committed = ci.assetHashes as Record<string, string>;
assert(committed?.[GLB] === authHashes[GLB] && committed?.[GLTF] === authHashes[GLTF], "recorder did NOT commit the palette hashes into the replay log");

// 6. Export the region TILES + asset bytes; REPLAY over BAKED tiles, author source ABSENT
const tileEntries = authCore.terrain.cache.entries();
assert(tileEntries.length === REGION_TILES, `expected the scatter region's ${REGION_TILES} tiles in the shared cache, got ${tileEntries.length}`);
const files = assembleExport({
  worldId: "p11scatter", meta: recorder.meta(), commands: recorder.commands, keyframes: [],
  keyframeInterval: 10, createdAt: "2026-01-01T00:00:00Z", tiles: tileEntries, assets: authCore.assets.bundle(),
});
assert(files["tiles.jsonl"].length > 0, "the scattered region's tiles did not ride the export (replay would float/sink or throw)");
assert(files["assets.jsonl"].length > 0, "asset bytes did not ride the export");
const loaded = loadExport(files, ops);
assert(loaded.tiles.length === REGION_TILES, `export did not round-trip the ${REGION_TILES} region tiles (got ${loaded.tiles.length})`);

// Guard host: reading the native asset root on replay is a HARD ERROR -> a successful
// replay PROVES the asset bytes came from the package.
const guardOps: EngineOps = new Proxy(ops, {
  get(t, p, r) {
    if (p === "op_read_asset") return (id: string) => { throw new Error(`p11_asset_scatter: native asset root must not be read on replay (id=${id})`); };
    return Reflect.get(t, p, r);
  },
}) as EngineOps;

// A model-free CachedTerrainSource serving ONLY the baked tiles (generateTile THROWS
// on a miss, NO regenerating fallback) — the AUTHOR SOURCE IS ABSENT. A scatter replay
// that reproduces the placements therefore proves the surface came from the EXPORT's
// baked tiles, not a re-run of the generator (the honest "replay from package" contract).
const makeCachedSource = (): CachedTerrainSource => new CachedTerrainSource(loaded.tiles.map((t) => ({ key: t.key, tile: t.tile })));

const tr_replay = new LiminaTracer("ses_p11scatter_replay");
async function replayFromPackage(): Promise<MCPResponse | undefined> {
  let last: MCPResponse | undefined;
  await replayCommands(recorder.commands, {
    makeWorld: () => makeWorld(guardOps),
    makeRegistry: (tr) => {
      const r = new SkillRegistry(tr as LiminaTracer);
      const pkgReg = AssetRegistry.fromBundle(exportAssetBundle(loaded), guardOps);
      registerCoreSkills(r, { assets: pkgReg, terrainSource: makeCachedSource() });
      const inner = r.invoke.bind(r);
      r.invoke = (n, i, b) => inner(n, i, b).then((res) => { if (n === "asset.scatter" && res.success) last = res; return res; });
      return r;
    },
    tracer: tr_replay,
  });
  return last;
}
const replayRes = ok(await replayFromPackage());
assert((replayRes.mounted as number) >= 1, "replay mounted no meshes (did not load from package bytes)");
assert(sameInstances(replayRes.placements as AssetInstance[], authPlacements), "baked-tile replay recomputed DIFFERENT placements (not bit-identical)");
assert((replayRes.assetHashes as Record<string, string>)[GLB] === authHashes[GLB], "replay resolved a different asset hash");

// A swapped/mismatched committed hash is REJECTED on replay (pins authored identity).
// Build a fresh package-backed world, regenerate the region from BAKED tiles, then
// scatter with a wrong/right hash. FALSIFIABLE — removing the handler's hash check
// makes the wrong-hash case succeed.
const pkgReg = AssetRegistry.fromBundle(exportAssetBundle(loaded), guardOps);
const pinReg = new SkillRegistry(new LiminaTracer("ses_pin"));
registerCoreSkills(pinReg, { assets: pkgReg, terrainSource: makeCachedSource() });
const pinWorld = makeWorld(guardOps);
guardOps.op_physics_create_world(-9.81);
const pinCtx = { agentId: "a", sessionId: "s", permissions: BUILDER, tick: 0, world: pinWorld };
ok(await pinReg.invoke("world.generateRegion", { seed: WORLD_SEED, bounds: REGION, lod: 0 }, pinCtx));
const goodHash = authHashes[GLB];
const badHash = authHashes[GLTF]; // a real-but-WRONG hash for GLB
const pinBad = await pinReg.invoke("asset.scatter", { regionId, config: skillConfig, assetHashes: { [GLB]: badHash } }, pinCtx);
assert(!pinBad.success && JSON.stringify(pinBad.error).includes("content hash mismatch"), "replay did NOT verify a committed palette hash (a swapped asset would scatter)");
const pinOk = ok(await pinReg.invoke("asset.scatter", { regionId, config: skillConfig, assetHashes: { [GLB]: goodHash } }, pinCtx));
assert(sameInstances(pinOk.placements as AssetInstance[], authPlacements), "pinned baked-tile scatter diverged from authoring");

ops.op_log(
  `p11_asset_scatter OK: scatterAssets deterministic + seed-sensitive (${r1.length} instances); ` +
  `${surfaceChecked} surface-checked vs collider + sampleHeight; tree line falsifiable (uncapped ${uncapped.length} -> capped ${capped.length}, 0 above, subset-reproducible; below-floor -> 0); ` +
  `slope thins steep (${steepAll.length}->${steepFlatOnly.length}); biome filter reads climate (CLIMATE_* contract); render matrices reproduce scatter; ` +
  `asset.scatter BOUND to regionId (${regionId}; ungenerated region rejected), logs regionId+ScatterConfig (no transforms) + commits ${Object.keys(committed).length} pinned hashes; ` +
  `export carries ${REGION_TILES} region tiles + asset bytes; replay over BAKED tiles (author source ABSENT, model-free CachedTerrainSource) recomputes bit-identical placements + rejects a swapped hash.`,
);
