// K-COMPACTION GATE (kernel / Map Phase 3.1) -- durable boots stop replaying per-tick step
// history, and idle physics steps stop bloating the log.
//
// The measured problem this gates: a real editor session's durable world log was 99.98% idle
// {"op":"step"} records (32,767 of 32,772 lines; an earlier session hit 1.29M lines / 89MB), and
// boot rehydrate re-applies the ENTIRE history, so boot cost grew with session TIME, not world
// size. The fix under test (see worldlog/step-filter.ts):
//   1. FRESH sessions: a depth-0 step is applied every tick but RECORDED only when it moved a
//      dynamic body bit-wise (plus a short post-activity grace window).
//   2. LEGACY logs (recorded before the cut): one full-replay boot re-records only the steps
//      that mattered and REWRITES the segment once -- permanent self-compaction.
// Both must reconstruct BIT-IDENTICAL world state (compareWorldState strictness).
//
// Falsifiability: phase 1 simulates thousands of idle ticks around real dynamic motion
// (entity-bound crates AND a raw non-entity body that lands on them, plus an impulse fired
// mid-idle) and asserts the log stays small while a reboot rebuilds identical state; phase 2
// builds a genuine legacy log via the recordIdleSteps escape hatch and asserts the compacting
// boot preserves state exactly, rewrites the segment to a contiguous-seq replayable stream, and
// that the NEXT boot replays a bounded command set. Real before/after boot costs are printed.
//
// Run: ./target/release/limina js/test/p_boot_compaction.ts   (exit 0 = pass)

import { ops } from "../src/engine.ts";
import { ACCEPT_CLOSED, AuthoritativeServer, type NetServerTransport } from "../src/net/server.ts";
import { resolveProfile } from "../src/skills/permissions.ts";
import { captureWorldState, compareWorldState, parseWorldLog, syncAllBodies, type WorldStateSnapshot } from "../src/worldlog/log.ts";
import { assertReplayable, seqsAreContiguous } from "../src/worldlog/verify.ts";

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error("p_boot_compaction FAIL: " + message);
}

class IdleTransport implements NetServerTransport {
  async accept(): Promise<number> { return ACCEPT_CLOSED; }
  async recv(_connId: number): Promise<string> { return ""; }
  async send(_connId: number, _line: string): Promise<void> {}
  async close(_connId: number): Promise<void> {}
}

async function author(server: AuthoritativeServer, tool: string, input: Record<string, unknown>, tick: number): Promise<unknown> {
  const res = await server.registry.invoke(tool, input, {
    agentId: "p_boot_compaction_author",
    sessionId: "p_boot_compaction_session",
    permissions: resolveProfile("builder.readWrite"),
    tick,
    world: server.world,
  });
  assert(res.success, `${tool} failed: ${JSON.stringify(res.error)}`);
  return res.result;
}

const TICKS = 6000; // ~100s of sim at 60Hz -- overwhelmingly idle
const AUTHORED = 200; // the authoring stream a boot must always replay

/** Drive a synthetic long session through the server's REAL recording seam (world.ops IS the
 *  recorder-wrapped ops doTick steps through; recorder.tick is the same field doTick stamps).
 *  Motion: 3 entity-bound dynamic crates + 1 RAW dynamic body (never enters the entity table --
 *  it free-falls onto the crate column, so its faithful replay is OBSERVABLE through the entity
 *  transforms it collides with). Mid-idle (after ~4000 quiet ticks) an impulse re-wakes the raw
 *  body: the filter must resume recording steps after a long dropped stretch. */
async function buildSession(server: AuthoritativeServer): Promise<{ firstEntity: string }> {
  let tick = 0;
  server.world.ops.op_physics_add_ground(0);
  let firstEntity = "";
  for (let i = 0; i < AUTHORED; i++) {
    tick += 1;
    server.recorder.tick = tick;
    const created = await author(server, "scene.createEntity", {
      shape: "box",
      size: 1,
      position: [-30 + (i % 20) * 3, 0.5, -30 + Math.floor(i / 20) * 3],
      color: 0x808080 + i,
    }, tick) as { entity: string };
    if (i === 0) firstEntity = created.entity;
  }
  for (let i = 0; i < 3; i++) {
    tick += 1;
    server.recorder.tick = tick;
    await author(server, "scene.createEntity", {
      shape: "box",
      size: 1,
      dynamic: true,
      position: [40, 4 + i * 1.5, 40],
      color: 0xaa2200 + i,
    }, tick);
  }
  const rawBody = server.world.ops.op_physics_add_box(40, 12, 40, 0.5);
  const impulseTick = tick + 4000;
  const end = tick + TICKS;
  for (tick += 1; tick <= end; tick++) {
    server.recorder.tick = tick;
    if (tick === impulseTick) server.world.ops.op_physics_apply_impulse(rawBody, 1.5, 3, 0.5);
    // Mirror doTick's per-tick engine rule exactly: recorded step, then body->ECS sync.
    server.world.ops.op_physics_step();
    syncAllBodies(server.world);
  }
  return { firstEntity };
}

function stepCount(commands: readonly { kind: string }[]): number {
  let n = 0;
  for (const c of commands) if (c.kind === "physics" && (c as { op?: string }).op === "step") n++;
  return n;
}

function identical(a: WorldStateSnapshot, b: WorldStateSnapshot, label: string): void {
  const cmp = compareWorldState(a, b);
  assert(cmp.identical, `${label}: world state diverged after ${cmp.comparisons} comparisons: ${cmp.detail ?? "unknown"}`);
}

const serverOpts = (name: string) => ({
  sessionId: "p_boot_compaction",
  seed: 0xc0dec,
  tickMs: 1000,
  worldLog: { name },
});

// ─── Phase 0: the measured real-world shape -- pure authoring, no dynamic bodies ────────────────
// The observed editor log was 32,767 step records against 5 authoring commands: an authoring
// session with nothing dynamic must now record ZERO steps, no matter how long it idles.
const LOG_0 = "p_boot_compaction_authoring.jsonl";
ops.op_write_trace(LOG_0, "");
{
  const authoring = new AuthoritativeServer(new IdleTransport(), serverOpts(LOG_0));
  await authoring.ready;
  for (let i = 0; i < 5; i++) {
    authoring.recorder.tick = i + 1;
    await author(authoring, "scene.createEntity", { shape: "box", size: 1, position: [i * 2, 0.5, 0], color: 0x334455 }, i + 1);
  }
  for (let t = 6; t <= 2000; t++) {
    authoring.recorder.tick = t;
    authoring.world.ops.op_physics_step();
    syncAllBodies(authoring.world);
  }
  const authoringState = captureWorldState(authoring.world);
  await authoring.shutdown();
  const parsed = parseWorldLog(ops.op_read_trace(LOG_0));
  assert(stepCount(parsed.commands) === 0,
    `an all-static authoring session must persist ZERO step records, got ${stepCount(parsed.commands)}`);
  const reboot = new AuthoritativeServer(new IdleTransport(), serverOpts(LOG_0));
  await reboot.ready;
  identical(authoringState, captureWorldState(reboot.world), "authoring-only reboot");
  await reboot.shutdown();
}

// ─── Phase 1: fresh session with the idle-step cut (the default) ────────────────────────────────
const LOG_A = "p_boot_compaction_fresh.jsonl";
ops.op_write_trace(LOG_A, "");

const fresh = new AuthoritativeServer(new IdleTransport(), serverOpts(LOG_A));
await fresh.ready;
await buildSession(fresh);
const freshState = captureWorldState(fresh.world);
const freshDropped = fresh.recorder.droppedIdleSteps;
await fresh.shutdown();

const freshDisk = ops.op_read_trace(LOG_A);
const freshParsed = parseWorldLog(freshDisk);
const freshSteps = stepCount(freshParsed.commands);
// (a) the durable log carries only changed-tick (+grace) step records, not one per tick.
assert(freshSteps + freshDropped === TICKS,
  `applied-step accounting broken: ${freshSteps} recorded + ${freshDropped} dropped != ${TICKS} applied`);
assert(freshDropped > TICKS * 0.6, `idle cut ineffective: only ${freshDropped}/${TICKS} steps dropped`);
assert(freshSteps >= 1, "a session with real motion must still record SOME steps (motion is load-bearing for replay)");
assert(freshParsed.commands.length < TICKS / 2,
  `fresh log still step-dominated: ${freshParsed.commands.length} commands for ${TICKS} ticks`);

// (b) boot rehydrate replays a bounded command set and reconstructs bit-identical state.
const bootT0 = Date.now();
const rebooted = new AuthoritativeServer(new IdleTransport(), serverOpts(LOG_A));
await rebooted.ready;
const freshBootMs = Date.now() - bootT0;
assert(rebooted.rehydrated, "reboot must rehydrate from the fresh log");
assert(rebooted.rehydratedCommands === freshParsed.commands.length,
  `rehydratedCommands ${rebooted.rehydratedCommands} != persisted ${freshParsed.commands.length}`);
identical(freshState, captureWorldState(rebooted.world), "fresh-log reboot");
// A post-cut log replays with ZERO drops, so the boot must leave the segment byte-untouched
// (no spurious self-compaction rewrite).
assert(ops.op_read_trace(LOG_A) === freshDisk, "reboot of a post-cut log must not rewrite the segment");
await rebooted.shutdown();
assert(ops.op_read_trace(LOG_A) === freshDisk, "no-edit reboot shutdown must not change the segment");

// ─── Phase 2: legacy log (record-every-step) self-compacts on its next boot ─────────────────────
const LOG_B = "p_boot_compaction_legacy.jsonl";
ops.op_write_trace(LOG_B, "");

const legacy = new AuthoritativeServer(new IdleTransport(), { ...serverOpts(LOG_B), recordIdleSteps: true });
await legacy.ready;
const { firstEntity } = await buildSession(legacy);
assert(legacy.recorder.droppedIdleSteps === 0, "recordIdleSteps:true must disable the filter entirely");
const legacyState = captureWorldState(legacy.world);
await legacy.shutdown();

const legacyParsed = parseWorldLog(ops.op_read_trace(LOG_B));
const legacySteps = stepCount(legacyParsed.commands);
assert(legacySteps === TICKS, `legacy log must carry every applied step: ${legacySteps} != ${TICKS}`);

// The compacting boot: full replay ONCE (faithful physics), then the segment is rewritten.
const compactT0 = Date.now();
const compacting = new AuthoritativeServer(new IdleTransport(), serverOpts(LOG_B));
await compacting.ready;
const legacyBootMs = Date.now() - compactT0;
assert(compacting.rehydrated, "legacy boot must rehydrate");
assert(compacting.rehydratedCommands === legacyParsed.commands.length,
  `legacy rehydratedCommands ${compacting.rehydratedCommands} != persisted ${legacyParsed.commands.length}`);
identical(legacyState, captureWorldState(compacting.world), "legacy compacting boot");

const compactedParsed = parseWorldLog(ops.op_read_trace(LOG_B));
const compactedSteps = stepCount(compactedParsed.commands);
assert(compactedParsed.commands.length === compacting.recorder.commandCount,
  `rewritten segment (${compactedParsed.commands.length} commands) != recorder history (${compacting.recorder.commandCount})`);
assert(compactedParsed.commands.length < legacyParsed.commands.length, "compacting boot must shrink a legacy log");
assert(compactedSteps < TICKS / 2, `compacted log still step-dominated: ${compactedSteps} steps`);
assert(seqsAreContiguous(compactedParsed.commands), "rewritten segment must carry contiguous 0..n-1 seqs");
assertReplayable(compactedParsed.commands);

// Post-compaction appends still work: exactly one new command lands on the rewritten segment.
await author(compacting, "ecs.updateComponent", { entity: firstEntity, component: "position", value: [9, 0.5, 9] }, 1);
const editedState = captureWorldState(compacting.world);
await compacting.shutdown();
const afterEditParsed = parseWorldLog(ops.op_read_trace(LOG_B));
assert(afterEditParsed.commands.length === compactedParsed.commands.length + 1,
  `post-compaction edit should append exactly one command, got ${afterEditParsed.commands.length} vs ${compactedParsed.commands.length}`);

// The boot AFTER compaction replays the bounded set and reconstructs the edited state exactly.
const boundedT0 = Date.now();
const bounded = new AuthoritativeServer(new IdleTransport(), serverOpts(LOG_B));
await bounded.ready;
const boundedBootMs = Date.now() - boundedT0;
assert(bounded.rehydratedCommands === afterEditParsed.commands.length,
  `post-compaction boot replayed ${bounded.rehydratedCommands}, expected ${afterEditParsed.commands.length}`);
assert(bounded.rehydratedCommands < TICKS / 2,
  `post-compaction boot still replays a step-history-scale command set: ${bounded.rehydratedCommands}`);
identical(editedState, captureWorldState(bounded.world), "post-compaction reboot");
// The compacted segment replayed with zero drops -> byte-untouched by this boot.
assert(parseWorldLog(ops.op_read_trace(LOG_B)).commands.length === afterEditParsed.commands.length,
  "post-compaction reboot must not change the persisted command count");
await bounded.shutdown();

ops.op_log(
  `p_boot_compaction OK: ${TICKS}-tick session -- fresh log ${freshParsed.commands.length} commands ` +
    `(${freshSteps} steps kept, ${freshDropped} idle steps dropped; boot replayed ${freshParsed.commands.length} in ${freshBootMs}ms); ` +
    `legacy log ${legacyParsed.commands.length} commands booted once in ${legacyBootMs}ms and self-compacted to ` +
    `${compactedParsed.commands.length}; next boot replayed ${bounded.rehydratedCommands} in ${boundedBootMs}ms. ` +
    `World state bit-identical across all three reboots.`,
);
