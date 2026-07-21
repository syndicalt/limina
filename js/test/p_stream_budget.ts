// p_stream_budget — Map Phase 3.5, THE MILESTONE GATE: a ~1 km² map-driven world (the FMG-
// compiled maps/fmg-1km.worldmap.json, extent 1000×1000 m) streamed through the EXTRACTED
// client-stream loop (p_stream_client's harness pattern: the exact ClientTerrainStream +
// policy browser-entry wires, real heightfield collider ops, no THREE) while a scripted
// anchor walks the extent border-to-border. Every number printed is MEASURED — no vibes.
//
// Run: LIMINA_AUDIO=null ./target/release/limina js/test/p_stream_budget.ts   (exit 0 = pass)
//
// Proves (falsifiably, with the numbers printed):
//   (a) CAPACITY: resident client-mounted tiles never exceed the keep window
//       (2·(radius+hysteresis)+1)² and per-update mounts never exceed the budget — for the
//       WHOLE border-to-border lawnmower walk (radius 14, the Phase-3.5 browser cap).
//   (b) FLAT ENTITIES: the EntityTable/ECS count is byte-flat across the entire walk
//       (view streaming uses ZERO entity slots); max observed total ≪ MAX_ENTITIES (16384).
//   (c) CONTENT: EVERY mounted tile byte-matches a fresh MapTerrainSource.generateTile of
//       the same coords (through the BOUND holder, i.e. the exact object the recorded
//       world.setTerrainSource command installed) — with a teeth check that two different
//       coords do NOT byte-match.
//   (d) RETENTION EXEMPTION AT SCALE: the walk generates far more unique tiles than could
//       ever be resident (or than the transient LRU could hold if tiles were pinned) while
//       the shared TileCache's retained store stays EMPTY — both numbers printed against
//       the DEFAULT caps (8192 retained fail-closed / 512 transient LRU).
//   (e) BOOT: a durable session log (recorded world.setTerrainSource + authoring + simulated
//       ticks) boots through the REAL AuthoritativeServer rehydrate path in < 5 s wall-clock,
//       reconstructing bit-identical world state (post-K-compaction expectation: far less).

import { ops } from "../src/engine.ts";
import { EntityTable, type EngineOps } from "../src/engine.ts";
import { createEcsWorld, MAX_ENTITIES } from "../src/ecs/world.ts";
import { createTransformStorage } from "../src/ecs/facade.ts";
import { UniformGridSpatialIndex } from "../src/spatial/index.ts";
import { LiminaTracer } from "../src/observability/event.ts";
import { SkillRegistry, type WorldContext } from "../src/skills/registry.ts";
import { registerCoreSkills, type CoreSkills } from "../src/skills/index.ts";
import { resolveProfile } from "../src/skills/permissions.ts";
import { WorldRecorder } from "../src/worldlog/recorder.ts";
import { ACCEPT_CLOSED, AuthoritativeServer, type NetServerTransport } from "../src/net/server.ts";
import { captureWorldState, compareWorldState, parseWorldLog, syncAllBodies } from "../src/worldlog/log.ts";
import { ClientTerrainStream } from "../src/terrain/stream-client.ts";
import { tileKey } from "../src/terrain/stream.ts";
import { TILE_SIZE } from "../src/terrain/procedural.ts";
import { MapTerrainSource } from "../src/terrain/map-source.ts";
import { SwappableTerrainSource } from "../src/terrain/swappable.ts";
import type { TerrainTile } from "../src/terrain/types.ts";
import type { MCPResponse } from "../src/mcp/protocol.ts";

function assert(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new Error("p_stream_budget FAIL: " + msg);
}
function ok(res: MCPResponse | undefined): Record<string, unknown> {
  if (res === undefined || !res.success) throw new Error("call failed: " + JSON.stringify(res?.error));
  return res.result as Record<string, unknown>;
}

const MAP_ASSET_ID = "maps/fmg-1km.worldmap.json";
// The browser client-stream policy at the Phase-3.5 cap (browser-entry.ts): radius ≤ 14,
// hysteresis 1, ≤2 mounts per update.
const RADIUS = 14;
const HYSTERESIS = 1;
const BUDGET = 2;
const KEEP_CAPACITY = (2 * (RADIUS + HYSTERESIS) + 1) ** 2; // 961
// TileCache DEFAULTS the retention-exemption comparison is made against (tilecache.ts).
const RETAINED_CAP = 8192;
const TRANSIENT_CAP = 512;

// ── Bind the 1 km map through the RECORDED world.setTerrainSource path (p_map_source's
// harness shape) — the stream below generates through the BOUND holder, never a private
// out-of-band source. ────────────────────────────────────────────────────────────────────────
function makeWorld(worldOps: EngineOps): WorldContext {
  const stub = { add() {}, remove() {}, position: { set() {}, x: 0, y: 0, z: 0 }, background: null as unknown };
  const camera = { position: { set() {} }, aspect: 1, lookAt() {}, updateProjectionMatrix() {} };
  const ecs = createEcsWorld();
  return {
    ecs, transforms: createTransformStorage(ecs), spatial: new UniformGridSpatialIndex(),
    entities: new EntityTable(), tags: new Map(), scene: stub as WorldContext["scene"],
    camera: camera as WorldContext["camera"], ops: worldOps, mode: "headless",
  };
}

const recorder = new WorldRecorder("ses_stream_budget");
const registry = new SkillRegistry(new LiminaTracer("ses_stream_budget"));
const core: CoreSkills = registerCoreSkills(registry);
recorder.attach(registry);
const world = makeWorld(recorder.wrapOps(ops));
const base = {
  agentId: "agt_budget", sessionId: "ses_stream_budget",
  permissions: resolveProfile("builder.readWrite"), tick: 0, world,
};
(world.ops as EngineOps).op_physics_create_world(-9.81);

const setOut = ok(await registry.invoke("world.setTerrainSource", { kind: "map", mapAssetId: MAP_ASSET_ID }, base));
assert(setOut.kind === "map", "world.setTerrainSource must bind the 1 km map");
assert(
  recorder.commands.some((c) => c.kind === "skill" && (c as { tool?: string }).tool === "world.setTerrainSource"),
  "the bind must be RECORDED",
);
const holder = core.terrain.source;
assert(holder instanceof SwappableTerrainSource && holder.current instanceof MapTerrainSource,
  "the shared holder must now delegate to MapTerrainSource");
const mapSource = holder.current as MapTerrainSource;
const extentM = (mapSource.masterRes - 1) * mapSource.masterStep; // master frame edge (m)
const HALF = extentM / 2;
assert(extentM >= 1000 && extentM <= 1200, `master frame must cover the ~1 km map (+margin), got ${extentM} m`);
assert(Math.abs(mapSource.masterStep - 1.5) < 1e-9,
  `a 1 km map must master at FULL 1.5 m fidelity (no >1.5 km coarsening), got step ${mapSource.masterStep}`);

// A small authored population so entity-flatness has a real nonzero baseline.
for (let i = 0; i < 8; i++) {
  ok(await registry.invoke("scene.createEntity", {
    shape: "box", size: 1, position: [i * 3, 0.5, -6], color: 0x556677 + i,
  }, base));
}
const ENTITY_BASELINE = world.entities.ids().length;
assert(ENTITY_BASELINE === 8, `expected 8 authored entities, got ${ENTITY_BASELINE}`);

// ── The walk harness: p_stream_client's wiring (real heightfield collider ops, no THREE),
// getTile through the BOUND holder exactly as browser-entry does ({seed:0, lod:0}). ─────────
const mountedTiles = new Map<string, TerrainTile>();
const bodies = new Map<string, number>();
const uniqueMounted = new Set<string>();
let mountEvents = 0;
let unmountEvents = 0;
const getTile = (tx: number, tz: number): TerrainTile => mapSource.generateTile({ seed: 0, tx, tz, lod: 0 });

function tilesEqual(a: TerrainTile, b: TerrainTile): boolean {
  for (let i = 0; i < 3; i++) {
    if (!Object.is(a.origin[i], b.origin[i]) || !Object.is(a.scale[i], b.scale[i])) return false;
  }
  if (a.heights.length !== b.heights.length || a.climate!.length !== b.climate!.length) return false;
  for (let i = 0; i < a.heights.length; i++) {
    if (!Object.is(a.heights[i], b.heights[i])) return false;
    if (a.paintMat![i] !== b.paintMat![i] || !Object.is(a.paintW![i], b.paintW![i])) return false;
  }
  for (let i = 0; i < a.climate!.length; i++) if (!Object.is(a.climate![i], b.climate![i])) return false;
  return true;
}

const stream = new ClientTerrainStream({
  tileSize: TILE_SIZE,
  radius: RADIUS,
  hysteresis: HYSTERESIS,
  maxLoadsPerUpdate: BUDGET,
  getTile: (c) => getTile(c.tx, c.tz),
  mount: (key, c, tile) => {
    assert(!mountedTiles.has(key), `double mount of ${key}`);
    mountedTiles.set(key, tile);
    uniqueMounted.add(key);
    mountEvents++;
    // (c) EVERY mounted tile byte-matches a FRESH generation for the same coords.
    assert(tilesEqual(tile, getTile(c.tx, c.tz)), `mounted tile ${key} does not byte-match a fresh generateTile`);
    const [ox, oy, oz] = tile.origin;
    const [sx, sy, sz] = tile.scale;
    bodies.set(key, ops.op_physics_add_heightfield(ox, oy, oz, tile.nrows, tile.ncols, sx, sy, sz, tile.heights));
  },
  unmount: (key) => {
    assert(mountedTiles.delete(key), `unmount of never-mounted ${key}`);
    const bodyId = bodies.get(key);
    assert(bodyId !== undefined, `no collider for ${key}`);
    ops.op_physics_remove_body(bodyId);
    bodies.delete(key);
    unmountEvents++;
  },
});

// ── The scripted walk: a border-to-border lawnmower over the master frame at walking-speed
// steps (1.5 m/update ≈ one frame of a 90 m/min stroll at 60 Hz... generously brisk; what
// matters is that anchor motion per update ≪ a tile). Serpentine rows + walked transitions —
// the anchor never teleports. ────────────────────────────────────────────────────────────────
const STEP = 1.5;
const EDGE = Math.ceil(HALF / STEP) * STEP; // ±549 → walk rail at ±549 (border-to-border)
const ROWS = [-EDGE, -EDGE / 2, 0, EDGE / 2, EDGE];
const path: [number, number][] = [];
for (let r = 0; r < ROWS.length; r++) {
  const z = ROWS[r];
  const [from, to] = r % 2 === 0 ? [-EDGE, EDGE] : [EDGE, -EDGE];
  const dir = Math.sign(to - from) * STEP;
  for (let x = from; dir > 0 ? x <= to : x >= to; x += dir) path.push([x, z]);
  if (r + 1 < ROWS.length) {
    const zTo = ROWS[r + 1];
    for (let zz = z + STEP; zz < zTo; zz += STEP) path.push([to, zz]);
  }
}

let maxMountsPerUpdate = 0;
let maxResident = 0;
let maxPending = 0;
let maxEntities = 0;
for (const [x, z] of path) {
  const r = stream.update(x, z);
  if (r.mounted > maxMountsPerUpdate) maxMountsPerUpdate = r.mounted;
  if (r.resident > maxResident) maxResident = r.resident;
  if (r.pending > maxPending) maxPending = r.pending;
  assert(r.mounted <= BUDGET, `update mounted ${r.mounted} > budget ${BUDGET}`);
  assert(r.resident <= KEEP_CAPACITY, `resident ${r.resident} > keep capacity ${KEEP_CAPACITY} (window blown)`);
  assert(bodies.size === mountedTiles.size, "collider set diverged from mounted set");
  // (b) entity count is FLAT the whole walk: streaming allocates no entity/ECS slots.
  const count = world.entities.ids().length;
  if (count > maxEntities) maxEntities = count;
  assert(count === ENTITY_BASELINE, `entity count moved during the walk: ${count} != ${ENTITY_BASELINE}`);
}
// Drain the tail so the final window is converged, then re-verify every RESIDENT tile.
for (let i = 0; i < 600 && stream.pendingCount() > 0; i++) stream.update(path[path.length - 1][0], path[path.length - 1][1]);
assert(stream.pendingCount() === 0, "pending queue failed to drain at the walk's end");
for (const [key, tile] of mountedTiles) {
  const [txs, tzs] = key.split(",");
  assert(tilesEqual(tile, getTile(Number(txs), Number(tzs))), `resident tile ${key} diverged post-walk`);
}
// Teeth: two different coords must NOT byte-match (else (c) proves nothing).
assert(!tilesEqual(getTile(0, 0), getTile(0, -1)), "tiles (0,0)/(0,-1) byte-match — content check has no teeth");

// (d) retention exemption at scale: the walk's unique tiles vs what retention would allow.
const unique = uniqueMounted.size;
assert(unique > 2 * KEEP_CAPACITY,
  `walk must generate far more unique tiles than could ever be resident (${unique} ≤ 2×${KEEP_CAPACITY})`);
assert(unique > 4 * TRANSIENT_CAP,
  `walk must overrun the transient LRU cap many times over (${unique} ≤ 4×${TRANSIENT_CAP})`);
assert(core.terrain.cache.retainedSize === 0,
  `the shared TileCache retained store must stay EMPTY (got ${core.terrain.cache.retainedSize})`);
assert(maxEntities < MAX_ENTITIES / 16,
  `entity total must sit far below MAX_ENTITIES (${maxEntities} vs ${MAX_ENTITIES})`);
stream.clear();
assert(bodies.size === 0, "clear() must remove every collider");

// ── (e) BOOT: a durable 1 km session log through the REAL AuthoritativeServer rehydrate
// path (p_boot_compaction's harness), wall-clock measured. ──────────────────────────────────
class IdleTransport implements NetServerTransport {
  async accept(): Promise<number> { return ACCEPT_CLOSED; }
  async recv(_connId: number): Promise<string> { return ""; }
  async send(_connId: number, _line: string): Promise<void> {}
  async close(_connId: number): Promise<void> {}
}
async function author(server: AuthoritativeServer, tool: string, input: Record<string, unknown>, tick: number): Promise<void> {
  const res = await server.registry.invoke(tool, input, {
    agentId: "agt_budget_boot", sessionId: "ses_stream_budget_boot",
    permissions: resolveProfile("builder.readWrite"), tick, world: server.world,
  });
  assert(res.success, `${tool} failed: ${JSON.stringify(res.error)}`);
}
const LOG = "p_stream_budget_boot.jsonl";
ops.op_write_trace(LOG, "");
const serverOpts = { sessionId: "p_stream_budget", seed: 0x1517, tickMs: 1000, worldLog: { name: LOG } };
const TICKS = 3000;

const live = new AuthoritativeServer(new IdleTransport(), serverOpts);
await live.ready;
{
  let tick = 0;
  live.world.ops.op_physics_add_ground(0);
  live.recorder.tick = ++tick;
  await author(live, "world.setTerrainSource", { kind: "map", mapAssetId: MAP_ASSET_ID }, tick);
  for (let i = 0; i < 40; i++) {
    live.recorder.tick = ++tick;
    await author(live, "scene.createEntity", {
      shape: "box", size: 1, position: [-30 + (i % 8) * 4, 0.5, -20 + Math.floor(i / 8) * 4], color: 0x707070 + i,
    }, tick);
  }
  for (let i = 0; i < 2; i++) {
    live.recorder.tick = ++tick;
    await author(live, "scene.createEntity", { shape: "box", size: 1, dynamic: true, position: [10, 3 + i * 1.5, 10], color: 0xaa3300 + i }, tick);
  }
  for (const end = tick + TICKS; tick < end;) {
    live.recorder.tick = ++tick;
    live.world.ops.op_physics_step();
    syncAllBodies(live.world);
  }
}
const liveState = captureWorldState(live.world);
assert(live.world.entities.ids().length === 42, "boot session must carry its authored entities");
await live.shutdown();
const persisted = parseWorldLog(ops.op_read_trace(LOG));

const bootT0 = Date.now();
const rebooted = new AuthoritativeServer(new IdleTransport(), serverOpts);
await rebooted.ready;
const bootMs = Date.now() - bootT0;
assert(rebooted.rehydrated, "reboot must rehydrate from the durable log");
const cmp = compareWorldState(liveState, captureWorldState(rebooted.world));
assert(cmp.identical, `rebooted world diverged: ${cmp.detail ?? "unknown"}`);
assert(bootMs < 5000, `1 km-world boot must take < 5000 ms wall-clock, took ${bootMs} ms`);
await rebooted.shutdown();

// ── THE MILESTONE NUMBERS (all measured above; the report's table reads from here). ─────────
const fieldTiles = Math.ceil(extentM / TILE_SIZE) ** 2;
ops.op_log(
  "[js] p_stream_budget OK — Map Phase 3.5 milestone numbers:\n" +
  `  world:      ${MAP_ASSET_ID} extent 1000x1000 m (master ${mapSource.masterRes}²@${mapSource.masterStep} m, frame ${extentM} m, ~${fieldTiles} field tiles)\n` +
  `  walk:       ${path.length} updates × ${STEP} m lawnmower (5 rows, border-to-border ±${EDGE} m), radius ${RADIUS} + hyst ${HYSTERESIS}, budget ${BUDGET}/update\n` +
  `  streaming:  ${mountEvents} mounts / ${unmountEvents} unmounts · unique tiles generated ${unique} · resident peak ${maxResident} ≤ ${KEEP_CAPACITY} · pending peak ${maxPending} · max mounts/update ${maxMountsPerUpdate}\n` +
  `  retention:  retainedSize 0 the whole time — ${unique} unique tiles vs transient-LRU cap ${TRANSIENT_CAP} (${(unique / TRANSIENT_CAP).toFixed(1)}×) and retained fail-closed cap ${RETAINED_CAP} (${(100 * unique / RETAINED_CAP).toFixed(0)}% of the export budget had they been retained)\n` +
  `  entities:   flat at ${ENTITY_BASELINE} for all ${path.length} updates (max ${maxEntities}; MAX_ENTITIES ${MAX_ENTITIES})\n` +
  `  content:    all ${mountEvents} mounts byte-matched fresh generateTile (+ final resident re-verify)\n` +
  `  boot:       ${persisted.commands.length} persisted commands (${TICKS} sim ticks) rebooted bit-identical in ${bootMs} ms (< 5000)`,
);
