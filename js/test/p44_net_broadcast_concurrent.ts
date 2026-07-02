// P44 -- net broadcast fan-out must not serialize subscribers behind one slow send.
//
// Rust bounds each socket send, but sequential JS fan-out still turns N slow
// clients into N * timeout tick debt. The broadcast loop should start every
// relevant client's send before awaiting completion.

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

assert(
  transport.started.includes(2) && transport.started.includes(3),
  `fast subscribers were not started while conn 1 was slow; started=${transport.started.join(",")}`,
);

await tick;
for (const id of [1, 2, 3]) {
  const line = transport.sent.get(id)?.find((raw) => JSON.parse(raw).method === SYNC_METHODS.delta);
  assert(line !== undefined, `subscriber ${id} did not receive a delta`);
}

ops.op_log("[js] p44_net_broadcast_concurrent OK: broadcast sends start for all subscribers before awaiting slow clients");
