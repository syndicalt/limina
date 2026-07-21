// P59 -- a mutating intent is acknowledged only after durable append succeeds.
// A failed append poisons the writer and all subsequent writes fail closed.

import { ops } from "../src/engine.ts";
import { ACCEPT_CLOSED, AuthoritativeServer, type NetServerTransport } from "../src/net/server.ts";
import { resolveProfile } from "../src/skills/permissions.ts";

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error("p59_authoritative_durable_failure FAIL: " + message);
}

class CaptureTransport implements NetServerTransport {
  readonly sent: string[] = [];
  readonly events: string[];
  constructor(events: string[]) { this.events = events; }
  async accept(): Promise<number> { return ACCEPT_CLOSED; }
  async recv(_connId: number): Promise<string> { return ""; }
  async close(_connId: number): Promise<void> {}
  async send(_connId: number, line: string): Promise<void> {
    this.events.push("send");
    this.sent.push(line);
  }
}

const events: string[] = [];
const transport = new CaptureTransport(events);
const server = new AuthoritativeServer(transport, {
  sessionId: "p59_durable_failure",
  worldLog: { name: "p59_authoritative_durable_failure.jsonl" },
});
await server.ready;

const permissions = resolveProfile("builder.readWrite");
const session = {
  agentId: "agt_p59",
  sessionId: "ses_p59",
  profile: "builder.readWrite",
  permissions,
};
const conn = {
  connId: 1,
  session,
  subscribed: false,
  closing: false,
  queuedIntents: 1,
  worldlogCursor: undefined as number | undefined,
};
const internals = server as unknown as {
  conns: Map<number, typeof conn>;
  intentQueue: unknown[];
  doTick(): Promise<void>;
  handleLine(conn: typeof conn, line: string): Promise<void>;
  durableLogFailure?: Error;
};
internals.conns.set(1, conn);

await internals.handleLine(conn, JSON.stringify({
  jsonrpc: "2.0",
  id: 0,
  method: "worldlog/subscribe",
  params: { since: 0 },
}));
transport.sent.length = 0;
events.length = 0;

const before = server.world.entities.ids().length;
internals.intentQueue.push({
  connId: 1,
  reqId: 1,
  name: "scene.createEntity",
  input: { shape: "box", position: [1, 2, 3] },
  session,
});

const originalAppend = ops.op_append_trace;
ops.op_append_trace = (_name: string, _content: string): void => {
  events.push("append");
  throw new Error("injected append failure");
};

try {
  await internals.doTick();
  assert(events.join(",") === "append,send", `reply occurred before append attempt: ${events}`);
  const firstReply = JSON.parse(transport.sent[0]) as { id: number; result?: unknown; error?: { code: number; message: string } };
  assert(firstReply.id === 1 && firstReply.result === undefined, "failed durable append produced a success result");
  assert(firstReply.error?.code === -32603 && firstReply.error.message.includes("could not be persisted"),
    `durability failure was not returned as an internal error: ${transport.sent[0]}`);
  assert(internals.durableLogFailure?.message === "injected append failure", "server did not retain the writer poison cause");
  assert(server.appliedIntents === 0, "non-durable intent was counted as durably applied");
  assert(server.world.entities.ids().length === before + 1,
    "test did not reach the adversarial partial-commit state needed to validate poisoning");
  assert(!transport.sent.some((line) => (JSON.parse(line) as { method?: string }).method === "worldlog/append"),
    "non-durable command escaped through worldlog/append before the failed flush");

  conn.queuedIntents = 1;
  internals.intentQueue.push({
    connId: 1,
    reqId: 2,
    name: "scene.createEntity",
    input: { shape: "sphere", position: [4, 5, 6] },
    session,
  });
  await internals.doTick();
  const secondReply = JSON.parse(transport.sent[1]) as { id: number; result?: unknown; error?: { code: number; message: string } };
  assert(secondReply.id === 2 && secondReply.result === undefined && secondReply.error?.code === -32603,
    "poisoned writer accepted or acknowledged a later mutation");
  assert(server.world.entities.ids().length === before + 1, "poisoned server executed a subsequent write");
  assert(events.filter((event) => event === "append").length === 1, "poisoned writer retried an append");

  await internals.handleLine(conn, JSON.stringify({
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: { name: "scene.createEntity", arguments: { shape: "box", position: [7, 8, 9] } },
  }));
  const thirdReply = JSON.parse(transport.sent[2]) as { id: number; result?: unknown; error?: { code: number; message: string } };
  assert(thirdReply.id === 3 && thirdReply.result === undefined && thirdReply.error?.code === -32603,
    "poisoned writer queued a newly received mutation");
  assert(internals.intentQueue.length === 0 && server.world.entities.ids().length === before + 1,
    "new mutation reached the queue or world after writer poison");

  await internals.handleLine(conn, JSON.stringify({
    jsonrpc: "2.0",
    id: 4,
    method: "tools/call",
    params: { name: "scene.inspect", arguments: {} },
  }));
  const readReply = JSON.parse(transport.sent[3]) as { id: number; result?: unknown; error?: { code: number; message: string } };
  assert(readReply.id === 4 && readReply.result === undefined && readReply.error?.code === -32603,
    "poisoned server exposed in-memory state that is ahead of the durable prefix");
  assert(readReply.error.message.includes("state is unavailable"),
    `poisoned read returned the wrong failure contract: ${transport.sent[3]}`);
} finally {
  ops.op_append_trace = originalAppend;
  await server.shutdown();
}

ops.op_log("p59_authoritative_durable_failure OK: durable append precedes ack; failure rejects writes and hides non-durable in-memory state until restart");
