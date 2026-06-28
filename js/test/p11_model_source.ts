// Phase 9/11 GATE — the MODEL-backed terrain source BAKES + REPLAYS (headless, NO GPU).
//
// This is the production proof that ModelTerrainSource is an OPTIONAL, out-of-process,
// BAKED authoring source — never a runtime/export dependency. It mirrors p9_terrain's
// baked-replay pattern (and p11_asset_scatter's "author source ABSENT" guard), but with
// the LEARNED-model adapter instead of the procedural source, driven by a deterministic
// MOCK service so the contract is verified without the diffusion model or a network call.
//
//   (a) AUTHORING: registerCoreSkills({ terrainSource: ModelTerrainSource(mock) }) — a
//       scripted builder calls world.generateRegion; the source marshals each tile over
//       the (mock) HTTP transport, normalizes int16 metres → [0,1] heights, remaps the
//       worker's WorldClim block → canonical [tempC,precipMm,biome], and the tiles BAKE
//       into the shared TileCache. A sphere dropped onto the result rests on the MODEL
//       surface (finite, fell, on-surface) and the world log records the REQUEST only.
//   (b) EXPORT: the baked tiles ride tiles.jsonl (content-hash verified on reload).
//   (c) REPLAY with the MODEL ABSENT: a model-free CachedTerrainSource (generateTile
//       THROWS on a miss) serves ONLY the baked tiles; its point-source is a GUARD model
//       whose transport throws if hit. Replay reconstructs the world BIT-IDENTICALLY.
//   (d) FALSIFIABLE: corrupt the recorded generateRegion seed → the baked tile key no
//       longer resolves → the region can't rebuild → replay DIVERGES. Dropping a baked
//       tile from the package likewise diverges. The guard model throws if its service
//       is touched — proving the model is genuinely absent at replay, not silently re-run.

import * as THREE from "../build/three.bundle.mjs";
import { EntityTable, ops } from "../src/engine.ts";
import { createEcsWorld } from "../src/ecs/world.ts";
import { createTransformStorage } from "../src/ecs/facade.ts";
import { UniformGridSpatialIndex } from "../src/spatial/index.ts";
import { SkillRegistry, type WorldContext } from "../src/skills/registry.ts";
import { registerCoreSkills } from "../src/skills/index.ts";
import { resolveProfile } from "../src/skills/permissions.ts";
import { LiminaTracer } from "../src/observability/event.ts";
import { WorldRecorder } from "../src/worldlog/recorder.ts";
import { replayCommands } from "../src/worldlog/replay.ts";
import { captureWorldState, compareWorldState, syncAllBodies, type WorldCommand } from "../src/worldlog/log.ts";
import { KeyframeRecorder } from "../src/worldlog/keyframes.ts";
import { assembleExport, loadExport } from "../src/export/package.ts";
import { ModelTerrainSource, encodeBase64, type TileTransport } from "../src/terrain/model-source.ts";
import { ProceduralTerrainSource } from "../src/terrain/procedural.ts";
import { CachedTerrainSource } from "../src/terrain/tilecache.ts";
import { Biome, CLIMATE_BIOME, type TileRequest } from "../src/terrain/types.ts";
import { BIOME_CONTENT, BIOME_DESERT, CACTUS_ASSET, resolveLayer } from "../src/terrain/biome-content.ts";
import { scatterAssets } from "../src/terrain/asset-scatter.ts";

function assert(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new Error("p11_model_source FAIL: " + msg);
}

// ---- config ----------------------------------------------------------------
const SEED = 0xbeef;            // session PRNG seed (sphere geometry rng)
const TERRAIN_SEED = 0x5eed;    // model request seed
const LOD = 1;
const BOUNDS = { minTx: 0, minTz: 0, maxTx: 1, maxTz: 1 }; // 2x2 = 4 tiles
const TILES = (BOUNDS.maxTx - BOUNDS.minTx + 1) * (BOUNDS.maxTz - BOUNDS.minTz + 1);
const TILE_PX = 16;
const M_PER_PX = 30;
const CHANNELS = 5;             // the (mock) worker emits 5 WorldClim channels
const ELEV_MIN = -500, ELEV_MAX = 9000; // fixed normalization range
const EXTENT = TILE_PX * M_PER_PX; // 480 m per tile edge
// Step long enough that the sphere actually SETTLES on the surface and comes to REST — not
// merely a free-fall snapshot that happens to land in a wide window. Empirically the sphere
// reaches the surface by ~tick 270 and is at rest (sub-mm/tick) from ~tick 590 onward, so 720
// sits deep inside the rest plateau with margin. (Critically, if origin.y is reverted from
// elevMinM to 0 the surface jumps to ~540 m — unreachable from the y=120 drop — and the sphere
// free-falls forever, never at rest in a late window: the strengthened assertion below FAILS.)
const TICKS = 720;
const SETTLE_TICK = TICKS - 60; // a late tick to compare the final against (the at-rest probe)
const INTERVAL = 30;
const DROP: [number, number, number] = [120, 120, 120]; // over tile (0,0), above the surface

// ---- the deterministic MOCK service (stands in for the Flask diffusion worker) ----
// Synthetic, PURE per request: a gentle elevation field (metres) that varies per tile
// (so seam/seed sensitivity is real) + a constant-per-channel WorldClim climate block,
// encoded with the EXACT wire format the Python worker uses (base64 int16 LE elev +
// float32 LE channel-major climate). NO randomness, NO timestamps → byte-identical.
function elevMetres(seed: number, tx: number, tz: number, r: number, c: number): number {
  return 30 + (seed & 7) + tx * 4 + tz * 7 + r * 0.5 + c * 0.5;
}
function buildEnvelope(req: TileRequest): string {
  const nrows = TILE_PX, ncols = TILE_PX;
  const elev = new Int16Array(nrows * ncols);
  for (let r = 0; r < nrows; r++) {
    for (let c = 0; c < ncols; c++) elev[r * ncols + c] = elevMetres(req.seed, req.tx, req.tz, r, c);
  }
  const climate = new Float32Array(CHANNELS * nrows * ncols);
  const chValues = [12.5, 4.0, 800.0, 15.0, 1.0]; // temp(ch0), tSeason, precip(ch2), pCV, +1
  for (let ch = 0; ch < CHANNELS; ch++) {
    for (let i = 0; i < nrows * ncols; i++) climate[ch * nrows * ncols + i] = chValues[ch];
  }
  return JSON.stringify({
    name: "mock:terrain-diffusion-30m",
    seed: req.seed, tx: req.tx, tz: req.tz, lod: req.lod, nrows, ncols,
    elev: { dtype: "int16", b64: encodeBase64(new Uint8Array(elev.buffer.slice(0))) },
    climate: { channels: CHANNELS, dtype: "float32", b64: encodeBase64(new Uint8Array(climate.buffer.slice(0))) },
  });
}
const mockTransport: TileTransport = {
  post(url, body) {
    if (url.endsWith("/health")) return Promise.resolve(JSON.stringify({ ok: true, model: "mock" }));
    if (url.endsWith("/tile")) return Promise.resolve(buildEnvelope(JSON.parse(body) as TileRequest));
    return Promise.reject(new Error("mock: unknown route " + url));
  },
};
// A GUARD transport that THROWS — used as the replay point-source's transport so any
// attempt to touch the model service during replay fails loudly (proves it is absent).
const guardTransport: TileTransport = {
  post: (url) => Promise.reject(new Error(`p11_model_source: model service must NOT be hit at replay (${url})`)),
};
const makeModelSource = (transport: TileTransport) =>
  new ModelTerrainSource({ transport, tilePx: TILE_PX, metersPerPx: M_PER_PX, climateChannels: CHANNELS, elevMinM: ELEV_MIN, elevMaxM: ELEV_MAX, timeoutMs: 2000 });

function makeHeadlessWorld(worldOps: typeof ops): WorldContext {
  const ecs = createEcsWorld();
  const scene = { add() {}, remove() {}, position: { set() {}, x: 0, y: 0, z: 0 }, background: null as unknown };
  const camera = { position: { set() {} }, aspect: 1, lookAt() {}, updateProjectionMatrix() {} };
  return { ecs, transforms: createTransformStorage(ecs), spatial: new UniformGridSpatialIndex(), entities: new EntityTable(), tags: new Map(), scene, camera, ops: worldOps, mode: "headless" };
}

// Warm THREE's lazy init on the DEFAULT rng before the seeded rng is installed (mirrors
// p9_terrain/p8) so record + replay draw the same seeded stream for scene.createEntity.
void new THREE.Mesh(new THREE.SphereGeometry(0.5, 24, 16), new THREE.MeshStandardNodeMaterial({ color: 0x808080 }));
void new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardNodeMaterial({ color: 0x808080 }));

// ============================================================================
// (a) AUTHORING — generate a region via the MODEL source; tiles bake into the cache
// ============================================================================
const recTracer = new LiminaTracer("ses_p11model_record");
const registry = new SkillRegistry(recTracer);
const authModel = makeModelSource(mockTransport);
const core = registerCoreSkills(registry, { terrainSource: authModel });
assert(core.terrain.source === authModel, "the model source was not wired as the terrain source");

const recorder = new WorldRecorder("ses_p11model_record");
recorder.attach(registry);
recorder.seed(SEED);
const recOps = recorder.wrapOps(ops);
const world = makeHeadlessWorld(recOps);
const keyframeRec = new KeyframeRecorder(INTERVAL);
const author = { agentId: "limina:builder", sessionId: "ses_p11model_record", permissions: resolveProfile("builder.readWrite"), tick: 0, world };

recOps.op_physics_create_world(-9.81);

// world.generateRegion drives the (mock) model service off-loop and applies the tiles.
const genRes = await registry.invoke("world.generateRegion", { seed: TERRAIN_SEED, bounds: BOUNDS, lod: LOD }, author);
assert(genRes.success, `world.generateRegion failed: ${JSON.stringify(genRes.error)}`);
const region = genRes.result as { regionId: string; tiles: number; bodies: number[] };
assert(region.tiles === TILES, `expected ${TILES} model tiles, got ${region.tiles}`);
assert(region.bodies.length === TILES && new Set(region.bodies).size === TILES, "tile body ids missing/duplicated");

// terrain.tile.ready carries the model source name (provenance) per tile.
const readyEvents = recTracer.trace("limina:builder").filter((e) => e.type === "terrain.tile.ready");
assert(readyEvents.length === TILES, `expected ${TILES} terrain.tile.ready events, got ${readyEvents.length}`);
assert(readyEvents.every((e) => (e.payload as { source?: string }).source === authModel.name), "tile.ready did not record the model source name");

// The world log records the REQUEST (seed/bounds/lod), never the tile bytes.
const genCmd = recorder.commands.find((c): c is Extract<WorldCommand, { kind: "skill" }> => c.kind === "skill" && c.tool === "world.generateRegion");
assert(genCmd !== undefined, "generateRegion request not recorded in the world log");
// Assert on the recorded REQUEST (input), not the whole command — the command also
// carries the actor's `perms` set, which is legitimately large and unrelated to tile bytes.
const genLine = JSON.stringify(genCmd.input);
assert(!genLine.includes("heights") && !genLine.includes("elev") && genLine.length < 400, `tile bytes leaked into the recorded request (${genLine.length} chars)`);

// climate flows through to perception: sampleClimate reads the canonical 3-channel grid.
const cs = await registry.invoke("terrain.sampleClimate", { seed: TERRAIN_SEED, x: DROP[0], z: DROP[2] }, author);
assert(cs.success, `terrain.sampleClimate failed: ${JSON.stringify(cs.error)}`);
const climate = cs.result as { tempC: number; precipMm: number; biome: number };
assert(climate.tempC === 12.5 && climate.precipMm === 800, `model climate wrong: ${JSON.stringify(climate)}`);

// Drop a sphere onto the generated MODEL terrain and step.
const sphereRes = await registry.invoke("scene.createEntity", {
  shape: "sphere", collider: "sphere", size: 1.0, color: 0xffaa33,
  position: DROP, dynamic: true, friction: 0.5, restitution: 0.1,
}, author);
assert(sphereRes.success, "sphere createEntity failed");
const sphereId = (sphereRes.result as { entity: string }).entity;

keyframeRec.maybeCapture(world, 0);
let settleY: number | undefined; // sphere y at SETTLE_TICK — the at-rest reference
for (let tick = 1; tick <= TICKS; tick++) {
  recorder.tick = tick;
  recOps.op_physics_step();
  syncAllBodies(world);
  keyframeRec.maybeCapture(world, tick);
  if (tick === SETTLE_TICK) {
    settleY = captureWorldState(world).entities.find((e) => e.id === sphereId)?.body?.[1];
  }
}
keyframeRec.capture(world, TICKS);

const nativeFinal = captureWorldState(world);
assert(nativeFinal.entities.length === TILES + 1, `expected ${TILES + 1} entities (terrain+sphere), got ${nativeFinal.entities.length}`);
const restY = nativeFinal.entities.find((e) => e.id === sphereId)?.body?.[1];
assert(restY !== undefined && Number.isFinite(restY), "sphere transform not finite (fell through / NaN)");
assert(restY < DROP[1] - 5, `sphere did not fall (y=${restY} from drop ${DROP[1]})`);
// AT REST: the sphere is SETTLED, not still moving — its y is stable across the last 60 ticks
// (near-zero velocity). A free-falling sphere (e.g. if origin.y were reverted to 0, leaving the
// surface unreachable at ~540 m) moves tens of metres over this span → this FAILS.
assert(settleY !== undefined && Number.isFinite(settleY), "settle probe not finite");
const drift = Math.abs(restY - (settleY as number));
assert(drift < 0.05, `sphere not at rest: moved ${drift.toFixed(4)} m between tick ${SETTLE_TICK} and ${TICKS} (still falling/rolling, not settled)`);
// RESTS ON THE TRUE SURFACE: the model surface over the sphere's rest cell is ≈38 m (elevMetres,
// reconstructed as origin.y(−500) + h·scaleY); a size-1 sphere rests centred ≈0.5 m above it, so
// restY ≈ 38.5 m — a TIGHT 1 m window. If origin.y is reverted to 0 the reconstructed surface is
// ≈538 m (h·9500), unreachable from the y=120 drop, and the sphere free-falls past this window
// (deeply negative by tick 720) → this FAILS. (p9_model_source pins origin.y === elevMinM directly.)
assert(restY > 38.0 && restY < 39.0, `sphere not resting on the true model surface (y=${restY}, expected ≈38.5 m); a reverted origin.y/free-fall lands outside this window`);

// ============================================================================
// (b) EXPORT — the baked tiles ride tiles.jsonl, content-hash verified on reload
// ============================================================================
const tileEntries = core.terrain.cache.entries();
assert(tileEntries.length === TILES, `cache holds ${tileEntries.length} baked tiles, expected ${TILES}`);
const files = assembleExport({
  worldId: "p11-model", meta: recorder.meta(), commands: recorder.commands,
  keyframes: keyframeRec.keyframes, keyframeInterval: INTERVAL, createdAt: "2026-01-01T00:00:00Z",
  tiles: tileEntries,
});
assert(files["tiles.jsonl"].length > 0, "tiles.jsonl artifact is empty (model tiles did not bake into the export)");
const pkg = loadExport(files); // re-parses + content-hash-verifies exactly what a browser reads back
assert(pkg.tiles.length === TILES, `reloaded ${pkg.tiles.length} tiles, expected ${TILES}`);
for (const entry of tileEntries) {
  const back = pkg.tiles.find((t) => t.key === entry.key);
  assert(back !== undefined, `tile ${entry.key} missing after round-trip`);
  assert(back.hash === entry.hash, `tile ${entry.key} content hash changed across export`);
  assert(back.tile.heights.every((h) => h >= 0 && h <= 1), `tile ${entry.key} heights not in [0,1] after round-trip`);
  for (let i = 0; i < entry.tile.heights.length; i++) {
    assert(Object.is(back.tile.heights[i], entry.tile.heights[i]), `tile ${entry.key} height ${i} not byte-identical after export`);
  }
}

// ============================================================================
// (c) REPLAY with the MODEL ABSENT — only the baked tiles, guarded
// ============================================================================
// The guard model throws if its service is touched — proves "absent", non-vacuously.
let guardThrew = false;
try { await makeModelSource(guardTransport).generateTile({ seed: TERRAIN_SEED, tx: 0, tz: 0, lod: LOD }); }
catch (e) { guardThrew = /must NOT be hit at replay/.test((e as Error).message); }
assert(guardThrew, "guard model did not throw — the replay 'model absent' guard is vacuous");

// A model-free CachedTerrainSource serving ONLY the baked tiles (generateTile THROWS on a
// miss — no regenerating fallback); its point-source is the GUARD model. A bit-identical
// replay therefore proves the world came from the EXPORT's baked tiles, not a model re-run.
function makeReplayRegistry(tracer: LiminaTracer, source: CachedTerrainSource): SkillRegistry {
  const r = new SkillRegistry(tracer);
  registerCoreSkills(r, { terrainSource: source });
  return r;
}
const makeCached = (tiles = pkg.tiles): CachedTerrainSource =>
  new CachedTerrainSource(tiles.map((t) => ({ key: t.key, tile: t.tile })), makeModelSource(guardTransport));

const replay = await replayCommands(recorder.commands, {
  makeWorld: () => makeHeadlessWorld(ops),
  makeRegistry: (tracer) => makeReplayRegistry(tracer as LiminaTracer, makeCached()),
  tracer: new LiminaTracer("ses_p11model_replay"),
});
const cmp = compareWorldState(nativeFinal, replay.state);
assert(cmp.identical, `baked-tile replay diverged from native (${cmp.comparisons} fields): ${cmp.detail ?? "?"}`);
assert(replay.state.entities.length === nativeFinal.entities.length, "replay entity count differs");

// ============================================================================
// (d) FALSIFIABLE — corrupting the request, or dropping a baked tile, diverges
// ============================================================================
// Corrupt the recorded generateRegion seed: the baked tile keys no longer resolve, so the
// region can't be rebuilt from the cache → divergence (the world is pinned to the baked
// tiles for the EXACT recorded request, not re-derivable from a changed one).
const corrupted: WorldCommand[] = recorder.commands.map((c) =>
  (c.kind === "skill" && c.tool === "world.generateRegion")
    ? { ...c, input: { ...(c.input as object), seed: TERRAIN_SEED ^ 0x1 } }
    : c);
const badReplay = await replayCommands(corrupted, {
  makeWorld: () => makeHeadlessWorld(ops),
  makeRegistry: (tracer) => makeReplayRegistry(tracer as LiminaTracer, makeCached()),
  tracer: new LiminaTracer("ses_p11model_badseed"),
});
assert(!compareWorldState(nativeFinal, badReplay.state).identical, "corrupting the generateRegion seed did NOT diverge — replay isn't bound to the baked tiles");

// Drop one baked tile from the package: the region can't fully rebuild → divergence.
const droppedReplay = await replayCommands(recorder.commands, {
  makeWorld: () => makeHeadlessWorld(ops),
  makeRegistry: (tracer) => makeReplayRegistry(tracer as LiminaTracer, makeCached(pkg.tiles.slice(1))),
  tracer: new LiminaTracer("ses_p11model_droptile"),
});
assert(!compareWorldState(nativeFinal, droppedReplay.state).identical, "dropping a baked tile did NOT diverge — replay silently regenerated a missing tile");

// ============================================================================
// (e) BIOME INTEGRATION GUARD — the model source's biome CLASSIFIER and the
// biome-content DESERT gate agree on the SAME canonical integer, so cacti actually land
// on a model-generated desert. Closes the "the two enums were never integrated" gap: the
// model source now classifies onto the canonical Biome (terrain/types.ts), the same enum
// procedural.ts:biomeOf emits and the cacti gate whitelists.
// ============================================================================
// A mock worker emitting an unambiguously HOT + ARID climate block (32 °C, 40 mm/yr) — the
// canonical DESERT cell. ModelTerrainSource.classifyBiome must fold this onto Biome.DESERT.
const HOT_C = 32.0, ARID_MM = 40.0;
function buildDesertEnvelope(req: TileRequest): string {
  const nrows = TILE_PX, ncols = TILE_PX;
  const elev = new Int16Array(nrows * ncols);
  for (let i = 0; i < elev.length; i++) elev[i] = 50; // flat lowland (metres) → no slope/elev gating
  const climate = new Float32Array(CHANNELS * nrows * ncols);
  const chValues = [HOT_C, 4.0, ARID_MM, 15.0, 1.0]; // temp(ch0)=hot, precip(ch2)=arid
  for (let ch = 0; ch < CHANNELS; ch++) {
    for (let i = 0; i < nrows * ncols; i++) climate[ch * nrows * ncols + i] = chValues[ch];
  }
  return JSON.stringify({
    name: "mock:desert", seed: req.seed, tx: req.tx, tz: req.tz, lod: req.lod, nrows, ncols,
    elev: { dtype: "int16", b64: encodeBase64(new Uint8Array(elev.buffer.slice(0))) },
    climate: { channels: CHANNELS, dtype: "float32", b64: encodeBase64(new Uint8Array(climate.buffer.slice(0))) },
  });
}
const desertTransport: TileTransport = {
  post(url, body) {
    if (url.endsWith("/health")) return Promise.resolve(JSON.stringify({ ok: true, model: "mock" }));
    if (url.endsWith("/tile")) return Promise.resolve(buildDesertEnvelope(JSON.parse(body) as TileRequest));
    return Promise.reject(new Error("mock: unknown route " + url));
  },
};
const desertTile = await makeModelSource(desertTransport).generateTile({ seed: TERRAIN_SEED, tx: 0, tz: 0, lod: LOD });

// THE LINCHPIN: the model's hot+arid cell classifies to the CANONICAL desert the gate checks.
// (If classifyBiome emitted a non-canonical desert — e.g. the old 10-value 6 — this integer
// would not equal BIOME_DESERT(1) and the cacti gate below would place NOTHING.)
const desertCellBiome = desertTile.climate![CLIMATE_BIOME];
assert(BIOME_DESERT === Biome.DESERT, `gate constant BIOME_DESERT(${BIOME_DESERT}) diverged from canonical Biome.DESERT(${Biome.DESERT})`);
assert(desertCellBiome === Biome.DESERT, `model hot+arid cell classified ${desertCellBiome}, expected canonical DESERT ${Biome.DESERT} — model classifier ↔ gate enum mismatch`);
// every cell of the uniform hot+arid tile is canonical DESERT (not just cell 0).
for (let i = CLIMATE_BIOME; i < desertTile.climate!.length; i += desertTile.climateChannels!) {
  assert(desertTile.climate![i] === Biome.DESERT, `a hot+arid cell classified ${desertTile.climate![i]} (≠ canonical DESERT)`);
}

// NON-VACUOUS: resolve the catalog's DESERT cacti layer (biome-gated to BIOME_DESERT) and scatter
// it over the MODEL tile. Cacti must LAND (the gate's whitelist matches the model's biome integer).
const cactusLayer = BIOME_CONTENT.desert.find((l) => l.biomes?.includes(BIOME_DESERT) && l.assets.some((a) => a.id === CACTUS_ASSET));
assert(cactusLayer !== undefined, "no biome-gated cacti layer in BIOME_CONTENT.desert");
const cactusConfig = resolveLayer(cactusLayer, { minY: 0, maxY: 1 }); // cacti layer has no elev gates → survey irrelevant
const cacti = scatterAssets(desertTile, TERRAIN_SEED, cactusConfig);
assert(cacti.length > 0, "cacti VANISHED on the model's desert tile — the model biome integer doesn't match the gate's BIOME_DESERT whitelist (enum integration broken)");
assert(cacti.every((c) => c.assetId === CACTUS_ASSET), "desert scatter placed a non-cactus asset");
// FALSIFIABLE the other way: the SAME scatter whitelisted to a NON-desert biome places nothing,
// proving the gate genuinely reads the tile's biome channel (not coverage alone).
const nonDesert = scatterAssets(desertTile, TERRAIN_SEED, { ...cactusConfig, biomes: [Biome.ICE] });
assert(nonDesert.length === 0, "biome gate is vacuous — an ICE whitelist still placed cacti on a DESERT tile");
ops.op_log(
  `p11_model_source biome-integration OK: model hot(${HOT_C}°C)+arid(${ARID_MM}mm) cell → canonical DESERT(${desertCellBiome}); ` +
  `biome-content cacti gate [biomes=${JSON.stringify(cactusConfig.biomes)}] placed ${cacti.length} cacti on the model desert tile, 0 under an ICE whitelist.`,
);

ops.op_log(
  `p11_model_source OK: ModelTerrainSource (mock service) generated ${TILES} tiles via world.generateRegion ` +
  `(request logged, ${genLine.length}-char cmd, no bytes); heights normalized [0,1] over [${ELEV_MIN},${ELEV_MAX}]m, ` +
  `climate → canonical [tempC=${climate.tempC},precipMm=${climate.precipMm},biome=${climate.biome}]; ` +
  `sphere settled at y=${restY.toFixed(3)} on the model surface; tiles BAKE into the cache + export (tiles.jsonl, hash-verified); ` +
  `replay reconstructs BIT-IDENTICAL (${cmp.comparisons} fields, ${replay.state.entities.length} entities) from baked tiles with the model service ABSENT (guard throws if hit); ` +
  `seed-corruption + dropped-tile both falsify. [model output itself is S0-covered, not run here]`,
);
