// Append-backed traces are the durable authoring audit: read-effect skill
// executions stay observable in the hot ring without growing the trace file.

import { z } from "../build/zod.bundle.mjs";
import { ops } from "../src/engine.ts";
import { createHeadlessContext } from "../src/game/index.ts";
import {
  LiminaTracer,
  type EmitInput,
  type EmitOptions,
  type Tracer,
} from "../src/observability/event.ts";
import { SkillRegistry } from "../src/skills/registry.ts";

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(`p_trace_reads_not_durable: ${message}`);
}

const INVOCATIONS = 8;
const ACTOR = "agt_trace_poll_gate";
const READ_SKILL = "test.pollObservation";
const WRITE_SKILL = "test.authorMutation";

function durableBytes(name: string): number {
  return new TextEncoder().encode(ops.op_read_trace(name)).byteLength;
}

function readsStayedOffDisk(beforeBytes: number, afterBytes: number): boolean {
  return afterBytes === beforeBytes;
}

function registerProbeSkills(registry: SkillRegistry): void {
  let writes = 0;
  registry.register({
    name: READ_SKILL,
    version: "1.0.0",
    description: "Read-effect polling probe for append-backed trace retention.",
    category: "system",
    permissions: [],
    effect: "read",
    input: z.object({ poll: z.number().int().nonnegative() }),
    output: z.object({ observed: z.number().int().nonnegative() }),
    handler: (input) => ({ observed: input.poll }),
  });
  registry.register({
    name: WRITE_SKILL,
    version: "1.0.0",
    description: "Write-effect authoring probe for append-backed trace retention.",
    category: "system",
    permissions: [],
    effect: "write",
    input: z.object({ edit: z.number().int().nonnegative() }),
    output: z.object({ writes: z.number().int().positive() }),
    handler: () => ({ writes: ++writes }),
  });
}

async function invokeMany(registry: SkillRegistry, base: ReturnType<typeof createHeadlessContext>["base"], skill: string): Promise<void> {
  for (let i = 0; i < INVOCATIONS; i++) {
    const input = skill === READ_SKILL ? { poll: i } : { edit: i };
    const response = await registry.invoke(skill, input, { ...base, tick: i });
    assert(response.success, `${skill} invocation ${i} failed: ${JSON.stringify(response.error)}`);
  }
}

// (a)-(c): exercise the real append-backed tracer through SkillRegistry.invoke.
const TRACE_NAME = "p_trace_reads_not_durable.jsonl";
ops.op_write_trace(TRACE_NAME, "");
const tracer = LiminaTracer.appendOnEmit("ses_trace_poll_gate", TRACE_NAME, 64);
const ctx = createHeadlessContext({
  tracer,
  session: "ses_trace_poll_gate",
  agentId: ACTOR,
});
registerProbeSkills(ctx.registry);

const beforeReads = durableBytes(TRACE_NAME);
await invokeMany(ctx.registry, ctx.base, READ_SKILL);
const afterReads = durableBytes(TRACE_NAME);
assert(readsStayedOffDisk(beforeReads, afterReads),
  `read-effect invokes grew the append trace from ${beforeReads} to ${afterReads} bytes`);

const hotReadEvents = tracer.trace(ACTOR).filter((event) =>
  event.type === "skill.executed" &&
  (event.payload as { skill?: string }).skill === READ_SKILL
);
assert(hotReadEvents.length === INVOCATIONS,
  `hot trace retained ${hotReadEvents.length}/${INVOCATIONS} read executions`);

await invokeMany(ctx.registry, ctx.base, WRITE_SKILL);
const afterWrites = durableBytes(TRACE_NAME);
assert(afterWrites > afterReads,
  `write-effect invokes did not grow the append trace (${afterReads} -> ${afterWrites} bytes)`);
const durableEvents = LiminaTracer.replayTrace(TRACE_NAME).events;
const durableReadCount = durableEvents.filter((event) =>
  event.type === "skill.executed" && (event.payload as { skill?: string }).skill === READ_SKILL
).length;
const durableWriteCount = durableEvents.filter((event) =>
  event.type === "skill.executed" && (event.payload as { skill?: string }).skill === WRITE_SKILL
).length;
assert(durableReadCount === 0, `durable trace retained ${durableReadCount} read executions`);
assert(durableWriteCount === INVOCATIONS,
  `durable trace retained ${durableWriteCount}/${INVOCATIONS} write executions`);

// (d) Falsifiability: this adapter recreates the old behavior by discarding the
// registry's emission options. The exact byte-stability predicate above must
// reject that always-durable implementation.
class AlwaysDurableTracer implements Tracer {
  constructor(readonly inner: LiminaTracer) {}
  emit(event: EmitInput, _options?: EmitOptions): string { return this.inner.emit(event); }
  trace(actorId: string, sinceTick?: number) { return this.inner.trace(actorId, sinceTick); }
  exportJsonl(): string { return this.inner.exportJsonl(); }
  inspect() { return this.inner.inspect(); }
}

const OLD_TRACE_NAME = "p_trace_reads_not_durable_old_behavior.jsonl";
ops.op_write_trace(OLD_TRACE_NAME, "");
const oldInner = LiminaTracer.appendOnEmit("ses_trace_poll_gate_old", OLD_TRACE_NAME, 64);
const oldRegistry = new SkillRegistry(new AlwaysDurableTracer(oldInner));
registerProbeSkills(oldRegistry);
const oldBefore = durableBytes(OLD_TRACE_NAME);
await invokeMany(oldRegistry, { ...ctx.base, sessionId: "ses_trace_poll_gate_old" }, READ_SKILL);
const oldAfter = durableBytes(OLD_TRACE_NAME);
assert(oldAfter > oldBefore, "old always-durable simulation did not append read executions");
assert(!readsStayedOffDisk(oldBefore, oldAfter),
  "gate byte-stability predicate did not reject the old always-durable behavior");

// Batch/export remains a full-history model: the marker only controls the live
// append stream. Both exportJsonl and the trace.export skill retain read + write.
const BATCH_EXPORT_NAME = "p_trace_reads_not_durable_batch_export.jsonl";
const batchTracer = new LiminaTracer("ses_trace_poll_gate_batch", 64);
const batchCtx = createHeadlessContext({
  tracer: batchTracer,
  session: "ses_trace_poll_gate_batch",
  agentId: ACTOR,
});
registerProbeSkills(batchCtx.registry);
await invokeMany(batchCtx.registry, batchCtx.base, READ_SKILL);
await invokeMany(batchCtx.registry, batchCtx.base, WRITE_SKILL);

function assertedBatchSkills(events: readonly { type: string; payload: unknown }[], source: string): void {
  const skills = events.flatMap((event) =>
    event.type === "skill.executed" ? [(event.payload as { skill?: string }).skill] : []
  );
  assert(skills.filter((skill) => skill === READ_SKILL).length === INVOCATIONS,
    `${source} omitted read-effect executions`);
  assert(skills.filter((skill) => skill === WRITE_SKILL).length === INVOCATIONS,
    `${source} omitted write-effect executions`);
}

assertedBatchSkills(LiminaTracer.replayJsonl(batchTracer.exportJsonl()).events, "exportJsonl");
const exportResponse = await batchCtx.registry.invoke("trace.export", { name: BATCH_EXPORT_NAME }, {
  ...batchCtx.base,
  permissions: new Set([...batchCtx.base.permissions, "trace.read"]),
});
assert(exportResponse.success, `trace.export failed: ${JSON.stringify(exportResponse.error)}`);
assertedBatchSkills(LiminaTracer.replayTrace(BATCH_EXPORT_NAME).events, "trace.export");

ops.op_log(
  `p_trace_reads_not_durable OK: (a) ${INVOCATIONS} reads added 0 durable bytes; ` +
  `(b) ${INVOCATIONS} writes grew ${afterReads} -> ${afterWrites} bytes; ` +
  `(c) ${hotReadEvents.length} reads remained hot; (d) old behavior grew ${oldBefore} -> ${oldAfter} bytes and was rejected; ` +
  "batch exportJsonl/trace.export retained reads and writes",
);
