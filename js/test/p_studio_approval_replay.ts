// p_studio_approval_replay — granted actions from a review-gated profile must
// rehydrate. THE BUG THIS GATE PINS: a held-then-granted action enters the log
// as an ordinary applied command (correct), but AuthoritativeServer.rehydrate
// re-invoked persisted commands WITHOUT approvalGateBypassed — so the granted
// command replayed as pending_approval and the server could not boot at all
// (hit for real on limina-world: boot died at seq 107 scene.createEntity).
//
// THE INVARIANT: the log is the record of APPLIED mutations — a held call is
// never recorded, so a recorded command was already gated live; replaying it
// must apply, never re-hold. The bypass is replay-only: the live gate must
// still hold new proposals after boot.
//
// Falsifiability: leg 2 invokes a replayed command WITH the gate and WITHOUT
// the bypass and asserts the pre-fix failure mode (pending_approval).
//
// Run: LIMINA_AUDIO=null ./target/release/limina js/test/p_studio_approval_replay.ts

import { ops } from "../src/engine.ts";
import { ACCEPT_CLOSED, AuthoritativeServer, type NetServerTransport } from "../src/net/server.ts";
import { reviewProfileGate } from "../src/skills/approval.ts";
import { resolveProfile } from "../src/skills/permissions.ts";

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error("p_studio_approval_replay FAIL: " + message);
}

class IdleTransport implements NetServerTransport {
  async accept(): Promise<number> { return ACCEPT_CLOSED; }
  async recv(_connId: number): Promise<string> { return ""; }
  async send(_connId: number, _line: string): Promise<void> {}
  async close(_connId: number): Promise<void> {}
}

const LOG = "p_studio_approval_replay.jsonl";
const serverOpts = () => ({
  sessionId: "p_studio_approval_replay",
  seed: 0xa99,
  tickMs: 1000,
  worldLog: { name: LOG },
});

function builderBase(server: AuthoritativeServer, tick: number) {
  return {
    agentId: "agt_reviewed",
    sessionId: server.sessionId ?? "ses_p_studio_approval_replay",
    permissions: resolveProfile("builder.review"),
    profile: "builder.review",
    tick,
    world: server.world,
  };
}

ops.op_write_trace(LOG, "");

// ─── Leg 1: live flow — propose (held, unrecorded), grant (applied, recorded). ──
const live = new AuthoritativeServer(new IdleTransport(), serverOpts());
live.registry.setApprovalGate(reviewProfileGate(new Set(["builder.review"])));
await live.ready;
{
  const held = await live.registry.invoke("scene.createEntity", { shape: "box", size: 1, position: [3, 0.5, 3], color: 0x44cc88 }, builderBase(live, 1));
  assert(held.success === false && held.error?.code === "pending_approval", `the proposal must be HELD (got ${JSON.stringify(held.error)})`);
  assert(live.recorder.count("skill") === 0, "a held call must NOT be recorded");
  const approvalId = held.error?.message;
  assert(typeof approvalId === "string" && approvalId.length > 0, "the held response carries the approval id");
  const granted = await live.registry.resolveApproval(approvalId, true, { agentId: "human_reviewer", applyTick: 2 });
  assert(granted.success === true, `the grant must apply (got ${JSON.stringify(granted.error)})`);
  assert(live.recorder.count("skill") === 1, "the granted action is recorded exactly once");
}
const liveEntities = live.world.entities.ids().length;
await live.shutdown();

// ─── Leg 2: falsifiability — replaying that command with the gate but WITHOUT
// the bypass reproduces the pre-fix boot failure. ─────────────────────────────
{
  const probe = new AuthoritativeServer(new IdleTransport(), { ...serverOpts(), worldLog: { name: "p_studio_approval_replay_probe.jsonl" } });
  probe.registry.setApprovalGate(reviewProfileGate(new Set(["builder.review"])));
  await probe.ready;
  const replayed = await probe.registry.invoke("scene.createEntity", { shape: "box", size: 1, position: [3, 0.5, 3], color: 0x44cc88 }, builderBase(probe, 1));
  assert(replayed.success === false && replayed.error?.code === "pending_approval",
    "without the replay bypass the gate re-holds (the pre-fix failure mode)");
  await probe.shutdown();
}

// ─── Leg 3: boot rehydrate applies the granted command; the live gate still
// holds new proposals (the bypass is replay-only). ────────────────────────────
const booted = new AuthoritativeServer(new IdleTransport(), serverOpts());
booted.registry.setApprovalGate(reviewProfileGate(new Set(["builder.review"])));
await booted.ready; // must not throw (the pre-fix code died here)
assert(booted.rehydrated, "boot must rehydrate from the persisted log");
assert(booted.world.entities.ids().length === liveEntities,
  `rehydrated world must contain the granted entity (${booted.world.entities.ids().length} != ${liveEntities})`);
{
  const heldAgain = await booted.registry.invoke("scene.createEntity", { shape: "box", size: 1, position: [9, 0.5, 9] }, builderBase(booted, 3));
  assert(heldAgain.success === false && heldAgain.error?.code === "pending_approval",
    "the live gate must still hold new proposals after boot (bypass is replay-only)");
}
await booted.shutdown();

ops.op_log(
  "p_studio_approval_replay OK: held→granted action recorded once; replay-without-bypass reproduces the pre-fix hold; " +
    "boot rehydrates the granted command and the live gate still holds new proposals.",
);
