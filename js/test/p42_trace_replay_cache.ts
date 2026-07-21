// P42 -- trace replay index caching.
//
// Audit/explain surfaces repeatedly need by-id and causal parent/child indexes.
// Rebuilding those maps for every query is O(events) avoidable work when the
// trace has not changed. The cache must be reused while stable and invalidated
// immediately after an emit.

import { ops } from "../src/engine.ts";
import { LiminaTracer } from "../src/observability/event.ts";

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error("p42_trace_replay_cache: " + message);
}

const tracer = new LiminaTracer("p42_trace_replay_cache");
const root = tracer.emit({
  type: "policy.decision",
  actorId: "agent",
  threadId: "session",
  parentEventId: null,
  causedBy: [],
  payload: { allow: true, cap: "ecs.updateComponent" },
});
const child = tracer.emit({
  type: "skill.executed",
  actorId: "agent",
  threadId: "session",
  parentEventId: root,
  causedBy: [],
  payload: { skill: "ecs.updateComponent" },
});

const replayA = tracer.replay();
const replayB = tracer.replay();
assert(replayA === replayB, "unchanged traces should reuse the replay index object");
assert(replayA.byId.get(child)?.id === child, "cached replay must resolve event ids");
assert(replayA.parentsById.get(child)?.[0]?.id === root, "cached replay must preserve parent links");

const next = tracer.emit({
  type: "skill.executed",
  actorId: "agent",
  threadId: "session",
  parentEventId: child,
  causedBy: [],
  payload: { skill: "ecs.updateComponent" },
});
const replayC = tracer.replay();
assert(replayC !== replayA, "emit must invalidate the cached replay index");
assert(replayC.byId.get(next)?.id === next, "rebuilt replay must include the newly emitted event");
assert(replayC.parentsById.get(next)?.[0]?.id === child, "rebuilt replay must link new parents");

ops.op_log("[js] p42_trace_replay_cache OK: replay indexes are cached between emits and invalidated on new events");
