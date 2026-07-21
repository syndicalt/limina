// P49 -- authoritative server can run with append-backed bounded trace retention.

import { ops } from "../src/engine.ts";
import { LiminaTracer } from "../src/observability/event.ts";
import { ACCEPT_CLOSED, AuthoritativeServer, type NetServerTransport } from "../src/net/server.ts";

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error("p49_authoritative_trace_retention: " + message);
}

class IdleTransport implements NetServerTransport {
  async accept(): Promise<number> { return ACCEPT_CLOSED; }
  async recv(_connId: number): Promise<string> { return ""; }
  async send(_connId: number, _line: string): Promise<void> {}
  async close(_connId: number): Promise<void> {}
}

const TRACE_NAME = "p49_authoritative_trace_retention.jsonl";
ops.op_write_trace(TRACE_NAME, "");

const server = new AuthoritativeServer(new IdleTransport(), {
  sessionId: "p49_authoritative_trace_retention",
  trace: { name: TRACE_NAME, maxInMemory: 2 },
});

for (let i = 0; i < 5; i++) {
  server.registry.tracer.emit({
    type: "p49.trace.event",
    actorId: "agent_p49",
    threadId: "p49_authoritative_trace_retention",
    parentEventId: null,
    causedBy: [],
    payload: { tick: i },
  });
}

assert(server.registry.tracer.inspect().eventCount === 2, "server tracer should retain only the configured hot window");
assert(server.registry.tracer.durableEventCount() === 5, "server tracer should keep full durable history outside the hot window");
assert(LiminaTracer.replayTrace(TRACE_NAME).events.length === 5, "append-backed server trace should replay the full persisted history");

const CORRUPT_TRACE_NAME = "p49_authoritative_trace_corrupt_recovery.jsonl";
ops.op_write_trace(CORRUPT_TRACE_NAME, "");
const corruptSeed = LiminaTracer.appendOnEmit("p49_corrupt", CORRUPT_TRACE_NAME, 2);
for (let i = 0; i < 3; i++) {
  corruptSeed.emit({
    type: "p49.trace.corrupt",
    actorId: "agent_p49",
    threadId: "p49_corrupt",
    parentEventId: null,
    causedBy: [],
    payload: { tick: i },
  });
}
const corruptLines = ops.op_read_trace(CORRUPT_TRACE_NAME).trimEnd().split("\n");
const bad = JSON.parse(corruptLines[2]);
bad.payload.tick = 999;
corruptLines[2] = JSON.stringify(bad);
ops.op_write_trace(CORRUPT_TRACE_NAME, corruptLines.join("\n") + "\n");

const recovered = LiminaTracer.appendOnEmit("p49_corrupt", CORRUPT_TRACE_NAME, 2);
assert(recovered.durableEventCount() === 2, "corrupt append trace should recover the verified prefix before the bad line");
recovered.emit({
  type: "p49.trace.corrupt",
  actorId: "agent_p49",
  threadId: "p49_corrupt",
  parentEventId: null,
  causedBy: [],
  payload: { tick: 3 },
});
const recoveredTicks = LiminaTracer.replayTrace(CORRUPT_TRACE_NAME).events.map((ev) => (ev.payload as { tick: number }).tick);
assert(recoveredTicks.join(",") === "0,1,3", `corrupt append trace recovered wrong ticks: ${recoveredTicks.join(",")}`);

const UNDEFINED_TRACE_NAME = "p49_authoritative_trace_undefined_payload.jsonl";
ops.op_write_trace(UNDEFINED_TRACE_NAME, "");
const undefinedPayload = LiminaTracer.appendOnEmit("p49_undefined", UNDEFINED_TRACE_NAME, 2);
undefinedPayload.emit({
  type: "p49.trace.undefined",
  actorId: "agent_p49",
  threadId: "p49_undefined",
  parentEventId: null,
  causedBy: [],
  payload: { kept: 1, dropped: undefined },
});
const undefinedReplay = LiminaTracer.replayTrace(UNDEFINED_TRACE_NAME);
assert(undefinedReplay.events.length === 1, "trace payload with undefined object field should replay with a valid integrity hash");
assert(!("dropped" in (undefinedReplay.events[0].payload as Record<string, unknown>)), "undefined object fields should not persist in trace payload");

ops.op_log("[js] p49_authoritative_trace_retention OK: authoritative server trace hot window is bounded while durable history persists; corrupt append traces recover to the verified prefix; undefined object fields hash like persisted JSON");
