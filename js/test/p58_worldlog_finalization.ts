// P58 -- worldlog readers may observe only the contiguous finalized prefix.
// Concurrent skills can settle out of order; cursors must never cross the gap.

import { z } from "../build/zod.bundle.mjs";
import { ops } from "../src/engine.ts";
import { LiminaTracer } from "../src/observability/event.ts";
import { SkillRegistry, type WorldContext } from "../src/skills/registry.ts";
import { worldlogTail } from "../src/skills/worldlog.ts";
import { WorldRecorder } from "../src/worldlog/recorder.ts";

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error("p58_worldlog_finalization FAIL: " + message);
}

interface Deferred {
  promise: Promise<{ value: string }>;
  resolve(value: { value: string }): void;
  reject(reason: Error): void;
}

function deferred(): Deferred {
  let resolve!: Deferred["resolve"];
  let reject!: Deferred["reject"];
  const promise = new Promise<{ value: string }>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const world = {
  entities: { ids: () => [] }, tags: new Map(), scene: {}, camera: {}, ops,
} as unknown as WorldContext;

function setup(session: string, first: Deferred, second: Deferred) {
  const registry = new SkillRegistry(new LiminaTracer(session));
  const register = (name: string, gate: Deferred) => registry.register({
    name,
    version: "1.0.0",
    description: "deferred write used to force completion order",
    category: "system",
    permissions: ["scene.write"],
    effect: "write",
    input: z.object({ value: z.string() }),
    output: z.object({ value: z.string() }),
    handler: () => gate.promise,
  });
  register("p58.first", first);
  register("p58.second", second);
  const recorder = new WorldRecorder(session);
  recorder.attach(registry);
  const base = {
    agentId: "agt_p58",
    sessionId: session,
    permissions: new Set(["scene.write"]),
    tick: 1,
    world,
  };
  return { registry, recorder, base };
}

// Later completion is finalized internally but remains invisible until the gap closes.
{
  const first = deferred();
  const second = deferred();
  const { registry, recorder, base } = setup("ses_p58_order", first, second);
  const notifications: number[] = [];
  const batches: string[][] = [];
  let cursor = 0;
  recorder.onFinalized((count) => {
    notifications.push(count);
    const tail = worldlogTail(recorder, registry, cursor);
    batches.push(tail.commands.flatMap((cmd) => cmd.kind === "skill" ? [cmd.tool] : []));
    cursor = tail.next;
  });

  const pendingFirst = registry.invoke("p58.first", { value: "first" }, base);
  const pendingSecond = registry.invoke("p58.second", { value: "second" }, base);
  second.resolve({ value: "second" });
  assert((await pendingSecond).success, "second command did not settle successfully");

  const whileFirstPending = worldlogTail(recorder, registry, 0);
  assert(whileFirstPending.next === 0, `tail crossed a provisional gap to ${whileFirstPending.next}`);
  assert(whileFirstPending.commands.length === 0, "tail exposed the later command while the first was pending");
  assert(notifications.length === 0, "out-of-order completion emitted a visible-prefix notification");

  first.resolve({ value: "first" });
  assert((await pendingFirst).success, "first command did not settle successfully");
  assert(notifications.join(",") === "1,2", `expected one boundary per newly contiguous command, got ${notifications}`);
  assert(JSON.stringify(batches) === JSON.stringify([["p58.first"], ["p58.second"]]),
    `subscriber batches had a gap or duplicate: ${JSON.stringify(batches)}`);

  const complete = worldlogTail(recorder, registry, 0);
  assert(complete.next === 2 && complete.commands.length === 2, "complete tail did not expose both commands");
  const ahead = worldlogTail(recorder, registry, 99);
  assert(ahead.reset && ahead.next === 2 && ahead.commands.length === 2,
    "cursor ahead of the finalized prefix did not force a full retained-range reset");
  recorder.compactFinalizedPrefix(1);
  const stale = worldlogTail(recorder, registry, 0);
  assert(stale.reset && stale.next === 2, "stale compacted cursor did not request reset at the finalized cursor");
  assert(stale.commands.length === 1 && stale.commands[0].seq === 1, "compacted tail returned the wrong retained suffix");
}

// Removing a failed gap must immediately expose already-finalized successors.
{
  const first = deferred();
  const second = deferred();
  const { registry, recorder, base } = setup("ses_p58_failure", first, second);
  const notifications: number[] = [];
  recorder.onFinalized((count) => notifications.push(count));

  const pendingFirst = registry.invoke("p58.first", { value: "discard" }, base);
  const pendingSecond = registry.invoke("p58.second", { value: "keep" }, base);
  second.resolve({ value: "keep" });
  assert((await pendingSecond).success, "successor did not settle");
  first.reject(new Error("intentional failure"));
  const failed = await pendingFirst;
  assert(!failed.success, "failed predecessor unexpectedly succeeded");

  const tail = worldlogTail(recorder, registry, 0);
  assert(notifications.join(",") === "1", `discard did not expose its settled successor exactly once: ${notifications}`);
  assert(tail.next === 1 && tail.commands.length === 1, "tail did not close the failed-command gap");
  assert(tail.commands[0].kind === "skill" && tail.commands[0].tool === "p58.second" && tail.commands[0].seq === 0,
    "settled successor was not renumbered into a contiguous replay stream");
}

ops.op_log("p58_worldlog_finalization OK: provisional gaps stay hidden; completion and discard expose each contiguous command once");
