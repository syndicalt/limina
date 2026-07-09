// K2 GATE -- AuthoritativeServer resumes from its durable world log without duplicating it.
//
// Run: ./target/release/limina js/test/p_boot_rehydrate.ts   (exit 0 = pass)

import { ops } from "../src/engine.ts";
import { ACCEPT_CLOSED, AuthoritativeServer, type NetServerTransport } from "../src/net/server.ts";
import { resolveProfile } from "../src/skills/permissions.ts";
import { captureWorldState, compareWorldState, parseWorldLog } from "../src/worldlog/log.ts";

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error("p_boot_rehydrate FAIL: " + message);
}

function nonEmptyLineCount(jsonl: string): number {
  return jsonl.split("\n").filter((line) => line.length > 0).length;
}

class IdleTransport implements NetServerTransport {
  async accept(): Promise<number> { return ACCEPT_CLOSED; }
  async recv(_connId: number): Promise<string> { return ""; }
  async send(_connId: number, _line: string): Promise<void> {}
  async close(_connId: number): Promise<void> {}
}

async function mustInvoke(
  server: AuthoritativeServer,
  tool: string,
  input: Record<string, unknown>,
  tick: number,
): Promise<unknown> {
  const res = await server.registry.invoke(tool, input, {
    agentId: "p_boot_rehydrate_author",
    sessionId: "p_boot_rehydrate_session",
    permissions: resolveProfile("builder.readWrite"),
    tick,
    world: server.world,
  });
  assert(res.success, `${tool} failed: ${JSON.stringify(res.error)}`);
  return res.result;
}

const LOG_NAME = "p_boot_rehydrate_worldlog.jsonl";
ops.op_write_trace(LOG_NAME, "");

const first = new AuthoritativeServer(new IdleTransport(), {
  sessionId: "p_boot_rehydrate",
  seed: 0x42,
  tickMs: 1000,
  worldLog: { name: LOG_NAME },
});
await first.ready;
assert(!first.rehydrated, "fresh empty log must not mark the server rehydrated");

const createdA = await mustInvoke(first, "scene.createEntity", {
  shape: "box",
  size: 1,
  position: [1, 2, 3],
  color: 0x4466aa,
}, 1) as { entity: string };
const createdB = await mustInvoke(first, "scene.createEntity", {
  shape: "box",
  size: 1,
  position: [-2, 1, 0],
  color: 0xaa6644,
}, 2) as { entity: string };
await mustInvoke(first, "ecs.addComponent", { entity: createdA.entity, component: "marker" }, 3);
await mustInvoke(first, "ecs.updateComponent", { entity: createdA.entity, component: "position", value: [4, 5, 6] }, 4);
await mustInvoke(first, "ecs.updateComponent", { entity: createdB.entity, component: "scale", value: [2, 3, 4] }, 5);

const firstState = captureWorldState(first.world);
const firstRecorderCount = first.recorder.commandCount;
await first.shutdown();

const firstDisk = ops.op_read_trace(LOG_NAME);
const firstParsed = parseWorldLog(firstDisk);
const firstLines = nonEmptyLineCount(firstDisk);
assert(firstParsed.commands.length === firstRecorderCount,
  `first durable log command count ${firstParsed.commands.length} != recorder count ${firstRecorderCount}`);
assert(firstParsed.commands.length >= 7, `authored session recorded too few commands: ${firstParsed.commands.length}`);

const second = new AuthoritativeServer(new IdleTransport(), {
  sessionId: "p_boot_rehydrate",
  seed: 0x42,
  tickMs: 1000,
  worldLog: { name: LOG_NAME },
});
await second.ready;
assert(second.rehydrated, "second server must mark non-empty durable log as rehydrated");
assert(second.rehydratedCommands === firstParsed.commands.length,
  `rehydratedCommands ${second.rehydratedCommands} != persisted ${firstParsed.commands.length}`);
assert(second.recorder.commandCount === firstParsed.commands.length,
  `rehydrated recorder count ${second.recorder.commandCount} != persisted ${firstParsed.commands.length}`);

const cmp = compareWorldState(firstState, captureWorldState(second.world));
assert(cmp.identical, `rehydrated world diverged after ${cmp.comparisons} comparisons: ${cmp.detail ?? "unknown"}`);

const afterBootDisk = ops.op_read_trace(LOG_NAME);
assert(parseWorldLog(afterBootDisk).commands.length === firstParsed.commands.length,
  "booting from durable log duplicated or dropped persisted commands");
assert(nonEmptyLineCount(afterBootDisk) === firstLines,
  "booting from durable log changed the on-disk line count without new edits");

await mustInvoke(second, "ecs.updateComponent", { entity: createdA.entity, component: "position", value: [7, 8, 9] }, 6);
await second.shutdown();

const afterEditParsed = parseWorldLog(ops.op_read_trace(LOG_NAME));
assert(afterEditParsed.commands.length === firstParsed.commands.length + 1,
  `post-rehydrate edit should append exactly one command (${firstParsed.commands.length + 1}), got ${afterEditParsed.commands.length}`);

const CORRUPT_LOG_NAME = "p_boot_rehydrate_corrupt_tail.jsonl";
ops.op_write_trace(CORRUPT_LOG_NAME, firstDisk + "{partial");
const recoveredFromPartial = new AuthoritativeServer(new IdleTransport(), {
  sessionId: "p_boot_rehydrate",
  seed: 0x42,
  tickMs: 1000,
  worldLog: { name: CORRUPT_LOG_NAME },
});
await recoveredFromPartial.ready;
const corruptCmp = compareWorldState(firstState, captureWorldState(recoveredFromPartial.world));
assert(corruptCmp.identical,
  `rehydrate with corrupt trailing line diverged after ${corruptCmp.comparisons} comparisons: ${corruptCmp.detail ?? "unknown"}`);
await recoveredFromPartial.shutdown();

const firstBreak = firstDisk.indexOf("\n");
assert(firstBreak >= 0, "fixture must contain more than one world-log line");
const INTERIOR_CORRUPT_LOG_NAME = "p_boot_rehydrate_corrupt_interior.jsonl";
ops.op_write_trace(
  INTERIOR_CORRUPT_LOG_NAME,
  firstDisk.slice(0, firstBreak + 1) + "{corrupt-but-terminated}\n" + firstDisk.slice(firstBreak + 1),
);
let rejectedInteriorCorruption = false;
try {
  new AuthoritativeServer(new IdleTransport(), {
    sessionId: "p_boot_rehydrate",
    seed: 0x42,
    tickMs: 1000,
    worldLog: { name: INTERIOR_CORRUPT_LOG_NAME },
  });
} catch (error) {
  rejectedInteriorCorruption = error instanceof Error && error.message.includes("invalid JSON");
}
assert(rejectedInteriorCorruption, "a malformed complete line inside the log must fail boot closed");

ops.op_log(
  "p_boot_rehydrate OK: AuthoritativeServer rebuilt the prior world from its durable world log, " +
  "repopulated recorder.commands, did not change the persisted log on a no-edit reboot, and appended " +
  "exactly one new command after reboot; a torn final fragment was recovered and interior corruption failed closed.",
);
