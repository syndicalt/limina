// P48 -- DurableWorldLog compacts flushed recorder commands.
//
// The recorder's default in-memory command array remains the full export/replay
// history for short authoring/test runs. When a durable sink is active, though,
// the persisted JSONL segment can be the full-history authority and the recorder
// should not retain every finalized command forever. This test proves opt-in
// durable compaction drops hot memory without losing a replayable command stream.

import { ops } from "../src/engine.ts";
import { z } from "../build/zod.bundle.mjs";
import { LiminaTracer } from "../src/observability/event.ts";
import { SkillRegistry, type WorldContext } from "../src/skills/registry.ts";
import { DurableWorldLog } from "../src/worldlog/durable.ts";
import { parseWorldLog } from "../src/worldlog/log.ts";
import { WorldRecorder } from "../src/worldlog/recorder.ts";
import { verifyWorldLog } from "../src/worldlog/verify.ts";

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error("p48_recorder_durable_compaction: " + message);
}

const LOG_NAME = "p48_recorder_durable_compaction.jsonl";

const dummyWorld = {
  entities: { create() { return "ent_dummy"; } },
  tags: new Map(),
  scene: {},
  camera: {},
  ops,
} as unknown as WorldContext;

const gapRegistry = new SkillRegistry(new LiminaTracer("ses_p48_gap"));
gapRegistry.register({
  name: "p48.ok",
  version: "1.0.0",
  description: "test skill that succeeds",
  category: "system",
  permissions: [],
  input: z.object({ value: z.number() }),
  output: z.object({ ok: z.boolean() }),
  handler: () => ({ ok: true }),
});
gapRegistry.register({
  name: "p48.fail",
  version: "1.0.0",
  description: "test skill that fails after being tentatively recorded",
  category: "system",
  permissions: [],
  input: z.object({ value: z.number() }),
  output: z.object({ ok: z.boolean() }),
  handler: () => {
    throw new Error("intentional p48 failure");
  },
});

const gapRecorder = new WorldRecorder("ses_p48_gap");
gapRecorder.attach(gapRegistry);
const gapBase = {
  agentId: "agt_p48_gap",
  sessionId: "ses_p48_gap",
  permissions: new Set<string>(),
  tick: 1,
  world: dummyWorld,
};
assert((await gapRegistry.invoke("p48.ok", { value: 1 }, gapBase)).success, "setup ok skill should succeed");
assert(!(await gapRegistry.invoke("p48.fail", { value: 2 }, gapBase)).success, "setup fail skill should fail");
assert((await gapRegistry.invoke("p48.ok", { value: 3 }, gapBase)).success, "post-failure ok skill should succeed");
const gapParsed = parseWorldLog(gapRecorder.toJsonl());
assert(gapParsed.commands.map((c) => c.seq).join(",") === "0,1", "discarded failed commands must not leave seq gaps");
assert(verifyWorldLog(gapRecorder.toJsonl()).ok, "world log with a discarded failed command should still verify");

const recorder = new WorldRecorder("ses_p48_compact");
const durable = new DurableWorldLog(recorder, LOG_NAME, { compactFlushed: true });

recorder.seed(0x48);
durable.open();

assert(durable.flush() === 1, "initial seed command should flush");
assert(recorder.commandCount === 1, "total command count should include compacted seed");
assert(recorder.compactedCommandCount === 1, "seed should be compacted after durable flush");
assert(recorder.commands.length === 0, "hot recorder buffer should be empty after compacting flushed seed");

const recOps = recorder.wrapOps(ops);
recOps.op_physics_create_world(-9.81);
recorder.tick = 1;
recOps.op_physics_step();
assert(recorder.commands.length === 2, "new unflushed commands should stay in the hot buffer");
assert(durable.flush() === 2, "physics commands should flush after the compacted seed");
assert(recorder.commandCount === 3, "total command count should include all flushed commands");
assert(recorder.compactedCommandCount === 3, "all flushed commands should be compacted");
assert(recorder.commands.length === 0, "hot buffer should be empty after second compaction");

let toJsonlRejected = false;
try {
  recorder.toJsonl();
} catch (err) {
  toJsonlRejected = err instanceof Error && err.message.includes("compacted");
}
assert(toJsonlRejected, "toJsonl must not pretend compacted in-memory history is complete");

const closed = durable.close();
assert(closed.commands === 3, "durable close should report total command count, not retained-buffer length");
assert(durable.pending === 0, "durable log should have no pending commands after close");

const disk = ops.op_read_trace(LOG_NAME);
const parsed = parseWorldLog(disk);
assert(parsed.commands.length === 3, "disk log should preserve every compacted command");
assert(parsed.commands.map((c) => c.seq).join(",") === "0,1,2", "disk command seqs should remain contiguous");
assert(parsed.meta?.commands === 3, "meta command count should report the full durable history");
const verified = verifyWorldLog(disk);
assert(verified.ok, `compacted durable log should verify (${verified.reason ?? "no reason"})`);

ops.op_log("[js] p48_recorder_durable_compaction OK: durable sink compacts flushed recorder commands while preserving a verified full-history log");
