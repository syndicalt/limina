// P41 -- net broadcast serialization cost.
//
// Full-interest subscribers receive the same authoritative delta. The server
// should serialize that wire line once per tick, not once per client. AoI clients
// still need per-client filtering, so this test only locks the shared case.

import { spawnRenderable } from "../src/ecs/world.ts";
import { ops } from "../src/engine.ts";
import { ACCEPT_CLOSED, AuthoritativeServer, type NetServerTransport } from "../src/net/server.ts";
import { SYNC_METHODS } from "../src/net/protocol.ts";
import type { WorldContext } from "../src/skills/registry.ts";

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error("p41_net_broadcast_serialization: " + message);
}

const STUB = { position: { set() {} }, quaternion: { set() {} }, scale: { set() {} } };

function spawnMarker(world: WorldContext, x: number, y: number, z: number): string {
  const eid = spawnRenderable(world.ecs, STUB, x, y, z);
  return world.entities.create({ eid });
}

class CaptureTransport implements NetServerTransport {
  readonly sent = new Map<number, string[]>();
  async accept(): Promise<number> { return ACCEPT_CLOSED; }
  async recv(_connId: number): Promise<string> { return ""; }
  async close(_connId: number): Promise<void> {}
  async send(connId: number, line: string): Promise<void> {
    const lines = this.sent.get(connId) ?? [];
    lines.push(line);
    this.sent.set(connId, lines);
  }
}

let marker = "";
const transport = new CaptureTransport();
const server = new AuthoritativeServer(transport, {
  sessionId: "p41_net_broadcast_serialization",
  tickMs: 1000,
  bootstrap: ({ world }) => {
    marker = spawnMarker(world, 0, 0, 0);
  },
});

const internals = server as unknown as {
  conns: Map<number, { connId: number; subscribed: boolean; closing: boolean; aoi?: unknown }>;
  intentQueue: unknown[];
  doTick: () => Promise<void>;
};
internals.conns.set(1, { connId: 1, subscribed: true, closing: false });
internals.conns.set(2, { connId: 2, subscribed: true, closing: false });
internals.intentQueue.push({
  connId: 1,
  reqId: undefined,
  name: "ecs.updateComponent",
  input: { entity: marker, component: "position", value: [7, 0, 0] },
  session: {
    agentId: "builder",
    sessionId: "session",
    profile: "builder.readWrite",
    permissions: new Set(["ecs.modify"]),
  },
});

const originalStringify = JSON.stringify;
let deltaStringifies = 0;
JSON.stringify = ((value: unknown, replacer?: unknown, space?: unknown): string => {
  if (
    typeof value === "object" &&
    value !== null &&
    (value as { method?: unknown }).method === SYNC_METHODS.delta
  ) {
    deltaStringifies += 1;
  }
  return originalStringify(value, replacer as never, space as never);
}) as typeof JSON.stringify;

try {
  await internals.doTick();
} finally {
  JSON.stringify = originalStringify;
}

const first = transport.sent.get(1)?.find((line) => JSON.parse(line).method === SYNC_METHODS.delta);
const second = transport.sent.get(2)?.find((line) => JSON.parse(line).method === SYNC_METHODS.delta);
assert(first !== undefined && second !== undefined, "both full-interest subscribers must receive the delta");
assert(first === second, "full-interest subscribers should receive the same serialized wire line");
assert(deltaStringifies === 1, `expected one delta JSON.stringify for two full-interest clients, got ${deltaStringifies}`);

ops.op_log("[js] p41_net_broadcast_serialization OK: full-interest deltas serialize once per tick and fan out unchanged");
