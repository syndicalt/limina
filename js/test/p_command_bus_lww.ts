// p_command_bus_lww -- KERNEL K1: the command bus is a single-writer total order
// with last-writer-wins (design decision #3: bus-serialize + LWW).
//
// The bus core (submit intent -> queue -> serial apply at the tick boundary ->
// record -> broadcast delta -> no set-state verb) is already proven end-to-end
// over real sockets by p4_authoritative_sync, and its fan-out by p41/p44. The one
// guarantee those do NOT lock is CONFLICT RESOLUTION: when two intents target the
// SAME entity field within ONE tick, the LAST one submitted must win, because the
// queue is applied SERIALLY in arrival order.
//
// This gate locks that, falsifiably: in a single tick, entity M1 receives
// position [7]->[9] and entity M2 receives [9]->[7]. Serial arrival-order apply
// yields M1=9, M2=7 (the second write per entity wins). If the bus ever applied
// intents as an unordered set / parallel merge, the two entities could not end on
// OPPOSITE values from the SAME two writes -- so the divergence is the proof that
// arrival order (not the value) decides the winner. We also assert both intents
// landed in ONE tick (causedBy has two applied seqs) and were both recorded.

import { spawnRenderable } from "../src/ecs/world.ts";
import { ops } from "../src/engine.ts";
import { ACCEPT_CLOSED, AuthoritativeServer, type NetServerTransport } from "../src/net/server.ts";
import { SYNC_METHODS } from "../src/net/protocol.ts";
import type { WorldContext } from "../src/skills/registry.ts";

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error("p_command_bus_lww: " + message);
}

const STUB = { position: { set() {} }, quaternion: { set() {} }, scale: { set() {} } };

function spawnMarker(world: WorldContext, x: number, y: number, z: number): string {
  const eid = spawnRenderable(world.ecs, STUB, x, y, z);
  return world.entities.create({ eid });
}

let m1 = "";
let m2 = "";
const transport = new class implements NetServerTransport {
  readonly sent = new Map<number, string[]>();
  async accept(): Promise<number> { return ACCEPT_CLOSED; }
  async recv(_connId: number): Promise<string> { return ""; }
  async close(_connId: number): Promise<void> {}
  async send(connId: number, line: string): Promise<void> {
    const lines = this.sent.get(connId) ?? [];
    lines.push(line);
    this.sent.set(connId, lines);
  }
}();

const server = new AuthoritativeServer(transport, {
  sessionId: "p_command_bus_lww",
  tickMs: 1000,
  bootstrap: ({ world }) => {
    m1 = spawnMarker(world, 0, 0, 0);
    m2 = spawnMarker(world, 0, 0, 0);
  },
});
await server.ready;

const internals = server as unknown as {
  conns: Map<number, { connId: number; subscribed: boolean; closing: boolean; aoi?: unknown }>;
  intentQueue: unknown[];
  doTick: () => Promise<void>;
  recorder: { commandCount: number };
};
internals.conns.set(1, { connId: 1, subscribed: true, closing: false });

const builderSession = {
  agentId: "builder",
  sessionId: "session",
  profile: "builder.readWrite",
  permissions: new Set(["ecs.modify"]),
};
function setPos(entity: string, x: number): void {
  internals.intentQueue.push({
    connId: 1,
    reqId: undefined,
    name: "ecs.updateComponent",
    input: { entity, component: "position", value: [x, 0, 0] },
    session: builderSession,
  });
}

// One tick, four intents, interleaved: M1 (7 then 9), M2 (9 then 7).
setPos(m1, 7);
setPos(m2, 9);
setPos(m1, 9);
setPos(m2, 7);

const beforeCount = internals.recorder.commandCount;
await internals.doTick();
const afterCount = internals.recorder.commandCount;

const deltaLine = transport.sent.get(1)?.find((l) => JSON.parse(l).method === SYNC_METHODS.delta);
assert(deltaLine !== undefined, "subscriber must receive a delta for the tick");
const delta = JSON.parse(deltaLine) as {
  params: { causedBy: number[]; changes: Array<{ id: string; pos: [number, number, number] }> };
};

const changeOf = (id: string) => delta.params.changes.find((c) => c.id === id);
const c1 = changeOf(m1);
const c2 = changeOf(m2);
assert(c1 !== undefined, "M1 must appear in the delta");
assert(c2 !== undefined, "M2 must appear in the delta");

// LAST-WRITER-WINS, per entity, decided by ARRIVAL ORDER not value.
assert(c1!.pos[0] === 9, `M1 last-writer-wins expected x=9, got ${c1!.pos[0]}`);
assert(c2!.pos[0] === 7, `M2 last-writer-wins expected x=7, got ${c2!.pos[0]}`);
// The two entities end on OPPOSITE values from the identical write pair -> the
// order of arrival, not the set of values, is load-bearing (falsifiability).
assert(c1!.pos[0] !== c2!.pos[0],
  "FALSIFIABILITY: identical write values must not converge -- arrival order must decide");

// One total order in ONE tick: all four writes applied this tick (causedBy tracks
// each APPLIED intent), and each was recorded (single mutation choke point).
assert(delta.params.causedBy.length === 4,
  `expected 4 applied intents in one tick (one total order), got ${delta.params.causedBy.length}`);
assert(afterCount - beforeCount >= 4,
  `recorder must record all 4 bus intents at the mutation choke point, recorded ${afterCount - beforeCount}`);

ops.op_log(
  "[js] p_command_bus_lww OK: bus is a single-writer total order; four same-tick intents apply " +
    "serially in arrival order; per-entity last-writer-wins (M1=9, M2=7) with divergence proving " +
    "order is load-bearing; all four recorded at the choke point (decision #3).",
);
