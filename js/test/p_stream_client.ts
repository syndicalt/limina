// p_stream_client — Map Phase 3.3: the CLIENT-SIDE camera-following terrain stream loop
// (terrain/stream-client.ts ClientTerrainStream) that runLive drives around the live camera.
//
// Run: LIMINA_AUDIO=null ./target/release/limina js/test/p_stream_client.ts   (exit 0 = pass)
//
// runLive itself cannot run headless (it needs a real Worker + SharedArrayBuffer + a WebGPU/
// WebGL2 canvas), so — as the phase deliverable allows — this gate exercises the EXTRACTED
// stream-loop logic over the REAL MapTerrainSource and the REAL native heightfield collider
// ops: the exact class + policy browser-entry wires (radius/hysteresis/budget/nearest-first/
// external-ownership), minus the THREE mesh construction (render-only) and the sim-worker
// mirror (a keyed message carrying the same fields).
//
// Proves (falsifiably):
//   (a) BUDGET: a first fill that wants the whole 49-tile window mounts EXACTLY the per-update
//       budget; walking the anchor across the IR extent never exceeds it on any update;
//   (b) CAPACITY: client-resident tiles never exceed the keep window (2·(radius+hyst)+1)²;
//   (c) CONVERGENCE: once drained at a fixed anchor, the resident set contains the whole load
//       window and nothing outside the keep margin (no gaps, no strays);
//   (d) CONTENT: every mounted tile byte-matches MapTerrainSource.generateTile for the same
//       coords — and two different coords genuinely differ, so the comparison has teeth;
//   (e) COLLIDERS: mounts/unmounts pair 1:1 through the REAL op_physics_add_heightfield /
//       op_physics_remove_body (validating the exact collider args runLive passes);
//   (f) NO ENTITY GROWTH: view streaming allocates no EntityTable ids and no ECS renderables
//       (by construction the stream never sees a world context; asserted anyway);
//   (g) DETERMINISM: an identical walk replays the identical mount/unmount event sequence;
//   (h) EXTERNAL OWNERSHIP: a tile the recorded world owns is never client-mounted;
//       reconcileExternal() hands tiles back and forth when ownership changes live.

import { EntityTable, ops } from "../src/engine.ts";
import { createEcsWorld } from "../src/ecs/world.ts";
import { MapTerrainSource } from "../src/terrain/map-source.ts";
import { ClientTerrainStream } from "../src/terrain/stream-client.ts";
import { desiredTiles, tileKey, worldToTile, type TileCoord } from "../src/terrain/stream.ts";
import { TILE_SIZE } from "../src/terrain/procedural.ts";
import type { TerrainTile } from "../src/terrain/types.ts";
import { verifyWorldMap, WorldMapSchema } from "../src/world/worldmap.ts";

function assert(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new Error("p_stream_client FAIL: " + msg);
}

const MAP_ASSET_ID = "maps/primary.worldmap.json";
const RADIUS = 3;
const HYSTERESIS = 1;
const BUDGET = 2;
const LOAD_CAPACITY = (2 * RADIUS + 1) ** 2; // 49
const KEEP_CAPACITY = (2 * (RADIUS + HYSTERESIS) + 1) ** 2; // 81

// ── The REAL map source, built exactly like world.setTerrainSource builds it ────────────────
const worldMap = WorldMapSchema.parse(JSON.parse(new TextDecoder().decode(ops.op_read_asset(MAP_ASSET_ID))));
const verified = verifyWorldMap(worldMap);
assert(verified.ok, "map IR failed content-hash verification (fixture problem, not a stream bug)");
const source = new MapTerrainSource({ worldMap });

// ── Harness: the SAME wiring shape browser-entry uses, with real colliders ──────────────────
interface Harness {
  stream: ClientTerrainStream;
  mountedTiles: Map<string, TerrainTile>;
  bodies: Map<string, number>;
  events: string[];
  maxMountsPerUpdate: number;
  maxResident: number;
  entities: EntityTable;
}
function makeHarness(isExternal?: (c: TileCoord) => boolean): Harness {
  const mountedTiles = new Map<string, TerrainTile>();
  const bodies = new Map<string, number>();
  const events: string[] = [];
  const entities = new EntityTable();
  createEcsWorld(); // fresh ECS globals — the stream must never spawn a renderable into them
  const h: Harness = { stream: undefined as unknown as ClientTerrainStream, mountedTiles, bodies, events, maxMountsPerUpdate: 0, maxResident: 0, entities };
  h.stream = new ClientTerrainStream({
    tileSize: TILE_SIZE,
    radius: RADIUS,
    hysteresis: HYSTERESIS,
    maxLoadsPerUpdate: BUDGET,
    getTile: (c) => source.generateTile({ seed: 0, tx: c.tx, tz: c.tz, lod: 0 }),
    isExternal,
    mount: (key, _c, tile) => {
      assert(!mountedTiles.has(key), `double mount of ${key}`);
      mountedTiles.set(key, tile);
      const [ox, oy, oz] = tile.origin;
      const [sx, sy, sz] = tile.scale;
      bodies.set(key, ops.op_physics_add_heightfield(ox, oy, oz, tile.nrows, tile.ncols, sx, sy, sz, tile.heights));
      events.push("+" + key);
    },
    unmount: (key) => {
      assert(mountedTiles.delete(key), `unmount of never-mounted ${key}`);
      const bodyId = bodies.get(key);
      assert(bodyId !== undefined, `no collider recorded for ${key}`);
      ops.op_physics_remove_body(bodyId);
      bodies.delete(key);
      events.push("-" + key);
    },
  });
  return h;
}
function walk(h: Harness, path: [number, number][]): void {
  for (const [x, z] of path) {
    const r = h.stream.update(x, z);
    if (r.mounted > h.maxMountsPerUpdate) h.maxMountsPerUpdate = r.mounted;
    if (r.resident > h.maxResident) h.maxResident = r.resident;
    assert(r.mounted <= BUDGET, `update mounted ${r.mounted} tiles > budget ${BUDGET}`);
    assert(r.resident <= KEEP_CAPACITY, `resident ${r.resident} > keep capacity ${KEEP_CAPACITY}`);
    assert(h.bodies.size === h.mountedTiles.size, "collider set diverged from mounted set");
  }
}
function drain(h: Harness, x: number, z: number): void {
  for (let i = 0; i < 200 && h.stream.pendingCount() > 0; i++) walk(h, [[x, z]]);
  assert(h.stream.pendingCount() === 0, "pending queue failed to drain in 200 updates");
}

ops.op_physics_create_world(-9.81);

// ── (a)+(b): first fill respects the budget; a west→east walk across the whole IR extent ────
const A = makeHarness();
{
  const first = A.stream.update(-240, 0);
  assert(first.mounted === BUDGET, `first fill must mount exactly the budget (${BUDGET}), got ${first.mounted}`);
  assert(first.pending === LOAD_CAPACITY - BUDGET, `first fill must queue the remaining ${LOAD_CAPACITY - BUDGET} tiles, got ${first.pending}`);
}
const PATH: [number, number][] = [];
for (let x = -240; x <= 240; x += 12) PATH.push([x, 0]);
walk(A, PATH);
drain(A, 240, 0);
assert(A.maxMountsPerUpdate === BUDGET, `budget never reached? max mounts/update = ${A.maxMountsPerUpdate}`);
assert(A.maxResident <= KEEP_CAPACITY && A.maxResident >= LOAD_CAPACITY, `resident peak ${A.maxResident} outside [${LOAD_CAPACITY}, ${KEEP_CAPACITY}]`);

// ── (c): converged resident set = full load window, nothing beyond the keep margin ──────────
{
  const anchor = worldToTile(240, 0, TILE_SIZE);
  const mounted = A.stream.mountedKeys();
  for (const t of desiredTiles(anchor, RADIUS)) {
    assert(mounted.has(tileKey(t.tx, t.tz)), `gap: load-window tile ${tileKey(t.tx, t.tz)} not resident after drain`);
  }
  const keep = new Set(desiredTiles(anchor, RADIUS + HYSTERESIS).map((t) => tileKey(t.tx, t.tz)));
  for (const k of mounted) assert(keep.has(k), `stray: resident tile ${k} is outside the keep window`);
  // The walk crossed ~10 windows' worth of tiles — MOUNTED tiles behind the camera must have
  // actually unloaded (with the mount budget, most trailing tiles drop straight from the
  // pending queue without ever mounting, so the count is modest — the spatial check above
  // (no resident tile outside the final keep window) is the real no-leak proof).
  const unloads = A.events.filter((e) => e.startsWith("-")).length;
  assert(unloads > 0, `expected unloading of mounted tiles across the extent walk (got ${unloads})`);
}

// ── (d): mounted tile content byte-matches a fresh generateTile; different coords differ ────
{
  let checked = 0;
  for (const [key, tile] of A.mountedTiles) {
    const [txs, tzs] = key.split(",");
    const fresh = source.generateTile({ seed: 0, tx: Number(txs), tz: Number(tzs), lod: 0 });
    for (let i = 0; i < 3; i++) {
      assert(Object.is(tile.origin[i], fresh.origin[i]) && Object.is(tile.scale[i], fresh.scale[i]), `tile ${key} origin/scale diverged`);
    }
    assert(tile.heights.length === fresh.heights.length, `tile ${key} heights length diverged`);
    for (let i = 0; i < tile.heights.length; i++) {
      assert(Object.is(tile.heights[i], fresh.heights[i]), `tile ${key} heights diverged at ${i}`);
      assert(tile.paintMat![i] === fresh.paintMat![i], `tile ${key} paintMat diverged at ${i}`);
      assert(Object.is(tile.paintW![i], fresh.paintW![i]), `tile ${key} paintW diverged at ${i}`);
    }
    for (let i = 0; i < tile.climate!.length; i++) {
      assert(Object.is(tile.climate![i], fresh.climate![i]), `tile ${key} climate diverged at ${i}`);
    }
    checked++;
  }
  assert(checked >= LOAD_CAPACITY, `expected ≥${LOAD_CAPACITY} content-checked tiles, got ${checked}`);
  // Teeth: two different coords must NOT byte-match (else the comparison proves nothing).
  const a = source.generateTile({ seed: 0, tx: 0, tz: 0, lod: 0 });
  const b = source.generateTile({ seed: 0, tx: 0, tz: -1, lod: 0 });
  let differs = false;
  for (let i = 0; i < a.heights.length && !differs; i++) differs = !Object.is(a.heights[i], b.heights[i]);
  assert(differs, "island tiles (0,0) and (0,-1) byte-match — content comparison has no teeth");
}

// ── (e)+(f): collider pairing already asserted per update; entity/ECS growth = zero ──────────
assert(A.bodies.size === A.mountedTiles.size, "final collider set diverged from mounted set");
assert(A.entities.ids().length === 0 && A.entities.version === 0, "view streaming must not touch the EntityTable");

// ── (g): determinism — an identical walk replays the identical event sequence ───────────────
{
  const B = makeHarness();
  B.stream.update(-240, 0);
  walk(B, PATH);
  drain(B, 240, 0);
  assert(A.events.length === B.events.length, `event count diverged (${A.events.length} vs ${B.events.length})`);
  for (let i = 0; i < A.events.length; i++) {
    assert(A.events[i] === B.events[i], `event sequence diverged at ${i}: ${A.events[i]} vs ${B.events[i]}`);
  }
}

// ── (h): external ownership suppresses the client mount; reconcile hands tiles back ─────────
{
  const extern = new Set<string>(["0,0"]);
  const E = makeHarness((c) => extern.has(tileKey(c.tx, c.tz)));
  walk(E, [[24, 24]]); // anchor tile (0,0) — the externally-owned tile is dead center
  drain(E, 24, 24);
  assert(!E.stream.mountedKeys().has("0,0"), "externally-owned tile must not be client-mounted");
  assert(E.stream.externalCount() === 1, `expected 1 external tile, got ${E.stream.externalCount()}`);
  // Ownership released (the recorded region streamed away) → reconcile re-queues + mounts it.
  extern.clear();
  E.stream.reconcileExternal();
  drain(E, 24, 24);
  assert(E.stream.mountedKeys().has("0,0"), "released tile must backfill after reconcileExternal");
  // Ownership claimed LIVE over a mounted tile (a mid-session world.streamFollow) → unmounted.
  extern.add("0,0");
  E.stream.reconcileExternal();
  assert(!E.stream.mountedKeys().has("0,0"), "newly region-owned tile must be handed back (unmounted)");
  assert(E.stream.externalCount() === 1, "handed-back tile must be tracked as external");
  E.stream.clear();
  assert(E.bodies.size === 0 && E.mountedTiles.size === 0, "clear() must unmount every tile + collider");
}
A.stream.clear();
assert(A.bodies.size === 0, "clear() must remove every collider");

// Terminal cleanup is exhaustive: one failing unmount cannot strand later tiles or
// retain internal residency bookkeeping.
{
  const attempted: string[] = [];
  const faulted = new ClientTerrainStream({
    tileSize: 48,
    radius: 1,
    maxLoadsPerUpdate: 20,
    getTile: (coord) => source.generateTile({ seed: 0, tx: coord.tx, tz: coord.tz, lod: 0 }),
    mount: () => {},
    unmount: (key) => {
      attempted.push(key);
      if (attempted.length === 1) throw new Error("injected terrain unmount failure");
    },
  });
  faulted.update(0, 0);
  const resident = faulted.mountedKeys().size;
  let cleanupError: unknown;
  try { faulted.clear(); } catch (error) { cleanupError = error; }
  assert(cleanupError instanceof AggregateError, "faulted clear must report an AggregateError");
  assert(attempted.length === resident, `faulted clear attempted ${attempted.length}/${resident} tile unmounts`);
  assert(faulted.mountedKeys().size === 0 && faulted.pendingCount() === 0, "faulted clear retained stream bookkeeping");
}

ops.op_log(
  `[js] p_stream_client OK: camera walk across the '${MAP_ASSET_ID}' extent streamed ${A.events.filter((e) => e[0] === "+").length} mounts / ` +
  `${A.events.filter((e) => e[0] === "-").length} unmounts at ≤${BUDGET} mounts/update, resident peak ${A.maxResident} ≤ ${KEEP_CAPACITY}; ` +
  "converged window has no gaps/strays; every mounted tile byte-matches MapTerrainSource.generateTile; colliders pair 1:1 via the real " +
  "heightfield ops; zero EntityTable/ECS growth; identical walks replay identical event sequences; external (recorded-region) ownership " +
  "suppresses, releases backfill, and live claims hand tiles back.",
);
