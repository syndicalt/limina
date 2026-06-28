// Phase 9 GATE (headless, PROCEDURAL source — NO model). Proves the terrain.* /
// world.* skill seam end to end:
//   (a) the 4 skills are registered, Zod-typed, permissioned, and traced; a
//       terrain.generate-less profile is DENIED; world.generateRegion records its
//       REQUEST (not the tile bytes) in the world log and emits terrain.tile.ready.
//   (b) terrain.sampleHeight / terrain.sampleClimate are deterministic, and the
//       procedural source generates byte-identical tiles for an identical request.
//   (c) REPLAY-PARITY: a recorded session (generateRegion -> drop a sphere onto
//       the generated terrain -> step) replays into a FRESH world (procedural
//       source) BIT-IDENTICALLY (compareWorldState). Falsifiable: changing the
//       recorded generateRegion seed MUST diverge (proves the sphere rests on the
//       GENERATED shape, not a flat plane).
//   (d) the export round-trips the tiles (a tiles.jsonl artifact, content-hash
//       verified) and a model-free CachedTerrainSource (generateTile throws on a
//       miss) reconstructs the EXACT same world from the reloaded tiles.

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
import { ProceduralTerrainSource } from "../src/terrain/procedural.ts";
import { CachedTerrainSource } from "../src/terrain/tilecache.ts";

function assert(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new Error("p9_terrain FAIL: " + msg);
}

const SEED = 0xbeef;
const TERRAIN_SEED = 0x5eed;
const LOD = 1;
const BOUNDS = { minTx: 0, minTz: 0, maxTx: 1, maxTz: 1 }; // 2x2 = 4 tiles
const TILES = (BOUNDS.maxTx - BOUNDS.minTx + 1) * (BOUNDS.maxTz - BOUNDS.minTz + 1);
const TICKS = 240;
const INTERVAL = 30;
const DROP: [number, number, number] = [40, 30, 40]; // over tile (0,0), above terrain

function makeHeadlessWorld(worldOps: typeof ops): WorldContext {
  const ecs = createEcsWorld();
  const scene = { add() {}, remove() {}, position: { set() {}, x: 0, y: 0, z: 0 }, background: null as unknown };
  const camera = { position: { set() {} }, aspect: 1, lookAt() {}, updateProjectionMatrix() {} };
  return { ecs, transforms: createTransformStorage(ecs), spatial: new UniformGridSpatialIndex(), entities: new EntityTable(), tags: new Map(), scene, camera, ops: worldOps, mode: "headless" };
}

// Warm THREE's lazy init on the DEFAULT rng before the seeded rng is installed
// (mirrors p8) so record + replay draw the same seeded stream for scene.createEntity.
void new THREE.Mesh(new THREE.SphereGeometry(0.5, 24, 16), new THREE.MeshStandardNodeMaterial({ color: 0x808080 }));
void new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardNodeMaterial({ color: 0x808080 }));

// ============================================================================
// (a) typed / permissioned / traced
// ============================================================================
const recTracer = new LiminaTracer("ses_p9_record");
const registry = new SkillRegistry(recTracer);
const core = registerCoreSkills(registry);

for (const name of ["world.generateRegion", "terrain.sampleHeight", "terrain.sampleClimate", "world.streamFollow"]) {
  assert(registry.has(name), `skill not registered: ${name}`);
}
const listed = registry.list();
for (const name of ["world.generateRegion", "terrain.sampleHeight", "terrain.sampleClimate", "world.streamFollow"]) {
  const tool = listed.find((t) => t.name === name);
  assert(tool !== undefined && typeof tool.input_schema === "object", `skill not Zod-typed in list(): ${name}`);
}
assert(registry.describe("world.generateRegion")?.permissions.includes("terrain.generate") === true, "world.generateRegion not gated by terrain.generate");
assert(registry.describe("terrain.sampleHeight")?.permissions.includes("terrain.read") === true, "terrain.sampleHeight not gated by terrain.read");

// Record + run a real native session.
const recorder = new WorldRecorder("ses_p9_record");
recorder.attach(registry);
recorder.seed(SEED);
const recOps = recorder.wrapOps(ops);
const world = makeHeadlessWorld(recOps);
const keyframeRec = new KeyframeRecorder(INTERVAL);

const author = { agentId: "limina:builder", sessionId: "ses_p9_record", permissions: resolveProfile("builder.readWrite"), tick: 0, world };
const denied = { agentId: "limina:player", sessionId: "ses_p9_record", permissions: resolveProfile("player.limited"), tick: 0, world };

recOps.op_physics_create_world(-9.81);

// Permission gate: a profile WITHOUT terrain.generate is denied (no world change).
const denyRes = await registry.invoke("world.generateRegion", { seed: TERRAIN_SEED, bounds: BOUNDS, lod: LOD }, denied);
assert(!denyRes.success && denyRes.error?.code === "forbidden", "player.limited was NOT denied world.generateRegion");

// Generate the region (4 heightfield tiles).
const genRes = await registry.invoke("world.generateRegion", { seed: TERRAIN_SEED, bounds: BOUNDS, lod: LOD }, author);
assert(genRes.success, `world.generateRegion failed: ${JSON.stringify(genRes.error)}`);
const region = genRes.result as { regionId: string; tiles: number; bodies: number[]; keys: string[] };
assert(region.tiles === TILES, `expected ${TILES} tiles, got ${region.tiles}`);
assert(region.bodies.length === TILES && new Set(region.bodies).size === TILES, "tile body ids missing/duplicated");

// terrain.tile.ready emitted per tile (traced on the author thread).
const readyEvents = recTracer.trace("limina:builder").filter((e) => e.type === "terrain.tile.ready");
assert(readyEvents.length === TILES, `expected ${TILES} terrain.tile.ready events, got ${readyEvents.length}`);

// The world log records the REQUEST, not the tile bytes.
const genCmd = recorder.commands.find((c): c is Extract<WorldCommand, { kind: "skill" }> => c.kind === "skill" && c.tool === "world.generateRegion" && (c.input as { seed?: number }).seed === TERRAIN_SEED && c.actorId === "limina:builder");
assert(genCmd !== undefined, "generateRegion request not recorded in the world log");
const genInput = genCmd.input as Record<string, unknown>;
assert(genInput.seed === TERRAIN_SEED && genInput.lod === LOD && typeof genInput.bounds === "object", "recorded request missing seed/bounds/lod");
// Assert on the recorded REQUEST (input), not the whole command — the command also
// carries the actor's `perms` set, which is legitimately large and unrelated to tile bytes.
const genLine = JSON.stringify(genCmd.input);
assert(!genLine.includes("heights") && genLine.length < 400, `tile bytes leaked into the recorded request (${genLine.length} chars)`);

// ============================================================================
// (b) determinism of point queries + tile generation
// ============================================================================
const h1 = await registry.invoke("terrain.sampleHeight", { seed: TERRAIN_SEED, x: 40, z: 40, lod: LOD }, author);
const h2 = await registry.invoke("terrain.sampleHeight", { seed: TERRAIN_SEED, x: 40, z: 40, lod: LOD }, author);
assert(h1.success && h2.success, "terrain.sampleHeight invoke failed");
assert(Object.is((h1.result as { y: number }).y, (h2.result as { y: number }).y), "terrain.sampleHeight not deterministic");
const c1 = await registry.invoke("terrain.sampleClimate", { seed: TERRAIN_SEED, x: 40, z: 40 }, author);
const c2 = await registry.invoke("terrain.sampleClimate", { seed: TERRAIN_SEED, x: 40, z: 40 }, author);
assert(c1.success && c2.success, "terrain.sampleClimate invoke failed");
assert(JSON.stringify(c1.result) === JSON.stringify(c2.result), "terrain.sampleClimate not deterministic");

// Tile generation is byte-identical for an identical request.
const probe = new ProceduralTerrainSource();
const t1 = probe.generateTile({ seed: TERRAIN_SEED, tx: 0, tz: 0, lod: LOD });
const t2 = probe.generateTile({ seed: TERRAIN_SEED, tx: 0, tz: 0, lod: LOD });
assert(t1.heights.length === t2.heights.length, "tile size differs");
for (let i = 0; i < t1.heights.length; i++) assert(Object.is(t1.heights[i], t2.heights[i]), `tile height ${i} not byte-identical`);
// A neighbouring tile must differ (the field is non-constant).
const tN = probe.generateTile({ seed: TERRAIN_SEED, tx: 5, tz: 5, lod: LOD });
let neighbourDiffers = false;
for (let i = 0; i < t1.heights.length; i++) if (!Object.is(t1.heights[i], tN.heights[i])) { neighbourDiffers = true; break; }
assert(neighbourDiffers, "neighbouring tile identical — generator is constant (not a real heightmap)");

// ============================================================================
// Drop a sphere onto the generated terrain and step.
// ============================================================================
const sphereRes = await registry.invoke("scene.createEntity", {
  shape: "sphere", collider: "sphere", size: 1.0, color: 0xffaa33,
  position: DROP, dynamic: true, friction: 0.5, restitution: 0.1,
}, author);
assert(sphereRes.success, "sphere createEntity failed");
const sphereId = (sphereRes.result as { entity: string }).entity;

keyframeRec.maybeCapture(world, 0);
for (let tick = 1; tick <= TICKS; tick++) {
  recorder.tick = tick;
  recOps.op_physics_step();
  syncAllBodies(world);
  keyframeRec.maybeCapture(world, tick);
}
keyframeRec.capture(world, TICKS);

const nativeFinal = captureWorldState(world);
assert(nativeFinal.entities.length === TILES + 1, `expected ${TILES + 1} entities (terrain+sphere), got ${nativeFinal.entities.length}`);
const sphereState = nativeFinal.entities.find((e) => e.id === sphereId);
assert(sphereState?.body !== undefined, "sphere has no body in final snapshot");
const restY = sphereState.body[1];
assert(Number.isFinite(restY), "sphere transform not finite (fell through / NaN)");
assert(restY < DROP[1] - 5, `sphere did not fall (y=${restY} from drop ${DROP[1]})`);
assert(restY > 0 && restY < 14, `sphere not resting on terrain surface (y=${restY}, expected 0..14)`);

// ============================================================================
// (c) replay-parity into a fresh world (procedural source)
// ============================================================================
function makeReplayRegistry(tracer: LiminaTracer, source?: ProceduralTerrainSource | CachedTerrainSource): SkillRegistry {
  const r = new SkillRegistry(tracer);
  registerCoreSkills(r, source !== undefined ? { terrainSource: source } : undefined);
  return r;
}
const replay = await replayCommands(recorder.commands, {
  makeWorld: () => makeHeadlessWorld(ops),
  makeRegistry: (tracer) => makeReplayRegistry(tracer as LiminaTracer),
  tracer: new LiminaTracer("ses_p9_replay"),
});
const cmp = compareWorldState(nativeFinal, replay.state);
assert(cmp.identical, `replay diverged from native (${cmp.comparisons} fields): ${cmp.detail ?? "?"}`);
assert(replay.state.entities.length === nativeFinal.entities.length, "replay entity count differs");

// Falsifiability: changing the recorded generateRegion seed MUST diverge (the
// sphere rests on the GENERATED shape, not a flat plane).
const corrupted: WorldCommand[] = recorder.commands.map((c) => {
  if (c.kind === "skill" && c.tool === "world.generateRegion") {
    return { ...c, input: { ...(c.input as object), seed: TERRAIN_SEED ^ 0x1 } };
  }
  return c;
});
const badReplay = await replayCommands(corrupted, {
  makeWorld: () => makeHeadlessWorld(ops),
  makeRegistry: (tracer) => makeReplayRegistry(tracer as LiminaTracer),
  tracer: new LiminaTracer("ses_p9_bad"),
});
const badCmp = compareWorldState(nativeFinal, badReplay.state);
assert(!badCmp.identical, "changing the terrain seed did NOT diverge — sphere isn't resting on the generated terrain");

// ============================================================================
// (d) export round-trips the tiles; cached (model-free) source reconstructs it
// ============================================================================
const tileEntries = core.terrain.cache.entries();
assert(tileEntries.length === TILES, `cache holds ${tileEntries.length} tiles, expected ${TILES}`);
const files = assembleExport({
  worldId: "p9-terrain", meta: recorder.meta(), commands: recorder.commands,
  keyframes: keyframeRec.keyframes, keyframeInterval: INTERVAL, createdAt: "2026-01-01T00:00:00Z",
  tiles: tileEntries,
});
assert(files["tiles.jsonl"].length > 0, "tiles.jsonl artifact is empty");
const pkg = loadExport(files); // re-parses + content-hash-verifies exactly what a browser reads back
assert(pkg.manifest.tiles === TILES, `manifest.tiles ${pkg.manifest.tiles} != ${TILES}`);
assert(pkg.tiles.length === TILES, `reloaded ${pkg.tiles.length} tiles, expected ${TILES}`);
// Byte-exact round-trip of the heightmaps.
for (const entry of tileEntries) {
  const back = pkg.tiles.find((t) => t.key === entry.key);
  assert(back !== undefined, `tile ${entry.key} missing after round-trip`);
  assert(back.hash === entry.hash, `tile ${entry.key} content hash changed`);
  for (let i = 0; i < entry.tile.heights.length; i++) {
    assert(Object.is(back.tile.heights[i], entry.tile.heights[i]), `tile ${entry.key} height ${i} not byte-identical after export`);
  }
}

// Replay from the RELOADED tiles via a model-free CachedTerrainSource whose
// generateTile THROWS on a miss — so this only passes if the export carried every
// tile the world needs and they reconstruct it exactly.
const cachedSource = new CachedTerrainSource(pkg.tiles.map((t) => ({ key: t.key, tile: t.tile })), new ProceduralTerrainSource());
const cachedReplay = await replayCommands(pkg.commands, {
  makeWorld: () => makeHeadlessWorld(ops),
  makeRegistry: (tracer) => makeReplayRegistry(tracer as LiminaTracer, cachedSource),
  tracer: new LiminaTracer("ses_p9_cached"),
});
const cachedCmp = compareWorldState(nativeFinal, cachedReplay.state);
assert(cachedCmp.identical, `cached-tile replay diverged from native (${cachedCmp.comparisons} fields): ${cachedCmp.detail ?? "?"}`);

// ============================================================================
// world.streamFollow — load/unload bookkeeping around a moving anchor (a fresh,
// non-recorded world so it does not perturb the parity/export evidence above).
// ============================================================================
const sfTracer = new LiminaTracer("ses_p9_stream");
const sfRegistry = new SkillRegistry(sfTracer);
registerCoreSkills(sfRegistry);
const sfWorld = makeHeadlessWorld(ops);
const sfBase = { agentId: "limina:builder", sessionId: "ses_p9_stream", permissions: resolveProfile("terrain.author"), tick: 0, world: sfWorld };
sfWorld.ops.op_physics_create_world(-9.81);
const sfGen = await sfRegistry.invoke("world.generateRegion", { seed: TERRAIN_SEED, bounds: { minTx: 0, minTz: 0, maxTx: 0, maxTz: 0 }, lod: 0 }, sfBase);
assert(sfGen.success, "streamFollow setup generateRegion failed");
const sfRegionId = (sfGen.result as { regionId: string }).regionId;
// Anchor over tile (0,0); radius 1 -> a 3x3 window. Tile (0,0) already loaded -> 8 new.
const follow1 = await sfRegistry.invoke("world.streamFollow", { regionId: sfRegionId, anchor: [24, 0, 24], radius: 1 }, sfBase);
assert(follow1.success, `streamFollow failed: ${JSON.stringify(follow1.error)}`);
const f1 = follow1.result as { loaded: string[]; removed: string[]; active: number };
assert(f1.loaded.length === 8 && f1.active === 9, `streamFollow window wrong: loaded ${f1.loaded.length}, active ${f1.active}`);
// Move far away (10 tiles over): everything from the old window leaves the keep-margin.
const follow2 = await sfRegistry.invoke("world.streamFollow", { regionId: sfRegionId, anchor: [10 * 48 + 24, 0, 10 * 48 + 24], radius: 1 }, sfBase);
const f2 = follow2.result as { loaded: string[]; removed: string[]; active: number };
assert(f2.loaded.length === 9 && f2.removed.length === 9 && f2.active === 9, `streamFollow move wrong: loaded ${f2.loaded.length}, removed ${f2.removed.length}, active ${f2.active}`);
// Denied without terrain.generate.
const sfDeny = await sfRegistry.invoke("world.streamFollow", { regionId: sfRegionId, anchor: [0, 0, 0] }, { ...sfBase, permissions: resolveProfile("player.limited") });
assert(!sfDeny.success && sfDeny.error?.code === "forbidden", "streamFollow not gated by terrain.generate");

ops.op_log(
  `p9_terrain OK: ${TILES} heightfield tiles generated via world.generateRegion (request logged, ${genLine.length}-char cmd, no bytes); ` +
  `sphere settled at y=${restY.toFixed(3)} on generated terrain; replay BIT-IDENTICAL (${cmp.comparisons} fields, ${replay.state.entities.length} entities), ` +
  `seed-corruption falsifies [${badCmp.detail ?? "?"}]; export tiles.jsonl round-trips ${TILES} tiles (hash-verified) and a model-free CachedTerrainSource reconstructs the world bit-identically; ` +
  `world.streamFollow loaded 8 + removed 9 tiles around a moving anchor (9 active), gated by terrain.generate.`,
);
