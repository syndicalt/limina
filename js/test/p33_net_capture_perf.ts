// P33 -- net per-tick capture cost, MEASURED (not reasoned).
//
// The authoritative server's per-tick change detection re-captures world state via
// captureWorldState (O(world size): reads every entity's SoA + a native body
// transform per body). Two efficiency fixes are locked in here:
//   1. captureWorldState(world, sorted=false) skips the per-tick O(n log n) id sort
//      + sorted-array allocation on the net path (the diff keys by id, so order is
//      irrelevant). This test MEASURES that win and asserts it is correctness-neutral
//      (same entity set + data as the sorted capture).
//   2. The server skips the capture entirely when no client is subscribed (verified
//      by the subscribe/convergence tests p4_authoritative_sync + p29_net_removal,
//      which still pass with the prev-refresh-on-subscribe).
//
// It also commits a per-capture BUDGET at scale (2000 entities / 256 bodies) so a
// future O(world)-cost regression fails CI. Headless-safe: no GPU/window/sockets are
// driven; the server bootstrap runs in the constructor, so we never start the loop.

import { ops } from "../src/engine.ts";
import { spawnRenderable } from "../src/ecs/world.ts";
import { AuthoritativeServer, listenerTransport } from "../src/net/server.ts";
import { captureWorldState } from "../src/worldlog/log.ts";
import type { WorldContext } from "../src/skills/registry.ts";
import type { NetOps } from "../src/net/protocol.ts";

const net = ops as unknown as NetOps;
function assert(c: boolean, m: string): asserts c { if (!c) throw new Error("p33_net_capture_perf: " + m); }
const now = (): number => (globalThis as { performance?: { now?: () => number } }).performance?.now?.() ?? Date.now();

const STUB = { position: { set() {} }, quaternion: { set() {} }, scale: { set() {} } };
const N = 2000;      // total entities
const BODIES = 256;  // dynamic physics bodies (native body-transform reads per capture)
const ITERS = 200;   // capture iterations per variant

// Build a populated authoritative world via the server bootstrap (runs in the
// constructor, BEFORE the tick loop). We never call start(), so no async ticks
// interfere with the measurement.
let world: WorldContext | undefined;
const listenerId = await net.op_net_listen(0);
new AuthoritativeServer(listenerTransport(net, listenerId), {
  sessionId: "p33_capture_perf",
  seed: 0x33ca9700,
  tickMs: 8,
  bootstrap: ({ world: w }) => {
    world = w;
    for (let i = 0; i < N; i++) {
      const x = (i % 64) * 0.5, z = Math.floor(i / 64) * 0.5;
      if (i < BODIES) {
        const bodyId = w.ops.op_physics_add_sphere(x, 3, z, 0.5, 0.5, 0.2);
        w.entities.create({ eid: spawnRenderable(w.ecs, STUB, x, 3, z), bodyId });
      } else {
        w.entities.create({ eid: spawnRenderable(w.ecs, STUB, x, 0, z) });
      }
    }
  },
});
assert(world !== undefined, "bootstrap did not run");
const W = world;

// ---- correctness: unsorted capture is a pure reordering of the sorted one --------
const sortedCap = captureWorldState(W, true).entities;
const unsortedCap = captureWorldState(W, false).entities;
assert(sortedCap.length === N && unsortedCap.length === N, `expected ${N} entities, got ${sortedCap.length}/${unsortedCap.length}`);
const isSorted = sortedCap.every((e, i) => i === 0 || sortedCap[i - 1].id <= e.id);
assert(isSorted, "sorted=true output is not id-ordered");
// same set of ids + same per-entity transform, regardless of order:
const byId = new Map(sortedCap.map((e) => [e.id, e]));
for (const e of unsortedCap) {
  const s = byId.get(e.id);
  assert(s !== undefined, `unsorted capture has id ${e.id} absent from sorted`);
  assert(s.eid === e.eid && s.pos[0] === e.pos[0] && s.pos[1] === e.pos[1] && s.pos[2] === e.pos[2],
    `entity ${e.id} differs between sorted/unsorted capture`);
}
assert(byId.size === N, "sorted capture had duplicate ids");

// ---- measure both variants -------------------------------------------------------
function timeCapture(sorted: boolean): number {
  for (let i = 0; i < 20; i++) captureWorldState(W, sorted); // warm up
  const t0 = now();
  for (let i = 0; i < ITERS; i++) captureWorldState(W, sorted);
  return (now() - t0) / ITERS; // ms per capture
}
const sortedMs = timeCapture(true);
const unsortedMs = timeCapture(false);

// ---- budget (regression guard, generous so it never flakes on a slow CI box) -----
const BUDGET_MS = 15;
assert(sortedMs < BUDGET_MS, `sorted capture ${sortedMs.toFixed(3)}ms/call exceeds budget ${BUDGET_MS}ms at N=${N}`);
assert(unsortedMs < BUDGET_MS, `unsorted capture ${unsortedMs.toFixed(3)}ms/call exceeds budget ${BUDGET_MS}ms at N=${N}`);
// Non-regression: dropping the sort must not make the net path slower (allow noise).
assert(unsortedMs <= sortedMs * 1.5, `unsorted (${unsortedMs.toFixed(3)}ms) unexpectedly slower than sorted (${sortedMs.toFixed(3)}ms)`);

const savedPct = sortedMs > 0 ? ((sortedMs - unsortedMs) / sortedMs) * 100 : 0;
ops.op_log(
  `[js] p33_net_capture_perf OK: N=${N} entities / ${BODIES} bodies; per-capture sorted=${sortedMs.toFixed(3)}ms ` +
  `unsorted=${unsortedMs.toFixed(3)}ms (net path drops the id sort: ${savedPct >= 0 ? "-" : "+"}${Math.abs(savedPct).toFixed(1)}%); ` +
  `budget ${BUDGET_MS}ms; unsorted capture is a correctness-neutral reordering of the sorted one (${N} ids match).`,
);
