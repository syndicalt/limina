// P44 -- net broadcast fan-out must not serialize subscribers behind one slow send.
//
// Rust bounds each socket send (1.5s), but even a BOUNDED wait turns one stalled
// client into a full-sim tick stall (head-of-line blocking every other client).
// The tick therefore FIRES the fan-out and moves on — it never awaits the sends —
// so a slow client can neither serialize the others nor gate the tick. This gate
// pins BOTH: (a) every subscriber's send starts concurrently, and (b) the tick
// resolves without waiting for the slow send, yet no delta is dropped (the slow
// send still completes in the background).

import { spawnRenderable } from "../src/ecs/world.ts";
import { ops } from "../src/engine.ts";
import { ACCEPT_CLOSED, AuthoritativeServer, type NetServerTransport } from "../src/net/server.ts";
import { SYNC_METHODS } from "../src/net/protocol.ts";
import type { WorldContext } from "../src/skills/registry.ts";

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error("p44_net_broadcast_concurrent: " + message);
}

const STUB = { position: { set() {} }, quaternion: { set() {} }, scale: { set() {} } };

function spawnMarker(world: WorldContext): string {
  const eid = spawnRenderable(world.ecs, STUB, 0, 0, 0);
  return world.entities.create({ eid });
}

class SlowFirstTransport implements NetServerTransport {
  readonly sent = new Map<number, string[]>();
  readonly started: number[] = [];
  async accept(): Promise<number> { return ACCEPT_CLOSED; }
  async recv(_connId: number): Promise<string> { return ""; }
  async close(_connId: number): Promise<void> {}
  async send(connId: number, line: string): Promise<void> {
    this.started.push(connId);
    if (connId === 1) await ops.op_sleep_ms(80);
    const lines = this.sent.get(connId) ?? [];
    lines.push(line);
    this.sent.set(connId, lines);
  }
}

let marker = "";
const transport = new SlowFirstTransport();
const server = new AuthoritativeServer(transport, {
  sessionId: "p44_net_broadcast_concurrent",
  tickMs: 1000,
  bootstrap: ({ world }) => {
    marker = spawnMarker(world);
  },
});

const internals = server as unknown as {
  conns: Map<number, { connId: number; subscribed: boolean; closing: boolean; aoi?: unknown }>;
  intentQueue: unknown[];
  doTick: () => Promise<void>;
};
internals.conns.set(1, { connId: 1, subscribed: true, closing: false });
internals.conns.set(2, { connId: 2, subscribed: true, closing: false });
internals.conns.set(3, { connId: 3, subscribed: true, closing: false });
internals.intentQueue.push({
  connId: 1,
  reqId: undefined,
  name: "ecs.updateComponent",
  input: { entity: marker, component: "position", value: [4, 0, 0] },
  session: {
    agentId: "builder",
    sessionId: "session",
    profile: "builder.readWrite",
    permissions: new Set(["ecs.modify"]),
  },
});

const tick = internals.doTick();
await ops.op_sleep_ms(20);

// (a) Fan-out starts every subscriber's send concurrently — conns 2 and 3 are
// underway while conn 1 is still inside its 80ms send.
assert(
  transport.started.includes(2) && transport.started.includes(3),
  `fast subscribers were not started while conn 1 was slow; started=${transport.started.join(",")}`,
);

// (b) The tick resolves WITHOUT blocking on the slow send: doTick fires the fan-out
// and returns, so the fast subscribers are delivered while conn 1 is still stalled,
// and conn 1's line is NOT yet present when the tick resolves.
await tick;
for (const id of [2, 3]) {
  const line = transport.sent.get(id)?.find((raw) => JSON.parse(raw).method === SYNC_METHODS.delta);
  assert(line !== undefined, `fast subscriber ${id} did not receive a delta while the slow client was stalled`);
}
assert(
  transport.sent.get(1) === undefined,
  "REGRESSION: the tick blocked until the slow client's 80ms send completed (head-of-line stall)",
);

// No delta is DROPPED — the slow send still completes in the background, just
// without gating the tick.
await ops.op_sleep_ms(100);
const slowLine = transport.sent.get(1)?.find((raw) => JSON.parse(raw).method === SYNC_METHODS.delta);
assert(slowLine !== undefined, "the slow subscriber's delta must still be delivered, only deferred (not dropped)");

ops.op_log("[js] p44_net_broadcast_concurrent OK: fan-out fires concurrently; the tick never waits on a slow send (no head-of-line stall) and no delta is dropped");
