// P51 -- browser/worker ephemeral tracers do not retain unbounded durable history.

import { ops } from "../src/engine.ts";
import { LiminaTracer } from "../src/observability/event.ts";

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error("p51_ephemeral_tracer_retention: " + message);
}

function emitTick(tracer: LiminaTracer, tick: number): void {
  tracer.emit({
    type: "p51.trace.event",
    actorId: "agent_p51",
    threadId: "ses_p51_ephemeral",
    parentEventId: null,
    causedBy: [],
    payload: { tick },
  });
}

const tracer = LiminaTracer.ephemeral("ses_p51_ephemeral", 3);
for (let i = 0; i < 8; i++) emitTick(tracer, i);

assert(tracer.inspect().eventCount === 3, "ephemeral tracer should keep only the bounded hot window");
assert(tracer.durableEventCount() === 3, "ephemeral tracer must not accumulate a hidden durableEvents array");

const replayTicks = tracer.replay().events.map((ev) => (ev.payload as { tick: number }).tick);
assert(replayTicks.join(",") === "5,6,7", `ephemeral replay should be explicitly hot-window only, got ${replayTicks.join(",")}`);

ops.op_log("[js] p51_ephemeral_tracer_retention OK: ephemeral tracer bounds hot and durable retention");
