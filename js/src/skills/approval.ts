// Human-in-the-loop approval skills — a reviewer (a session holding the
// `approval.review` capability) lists, grants, or denies the agent actions the
// registry's review gate is holding. The held actions are already schema-validated
// and policy-approved; approval is the final HUMAN gate before they apply.

import { z } from "../../build/zod.bundle.mjs";
import type { ApprovalGate, SkillDefinition, SkillRegistry } from "./registry.ts";

/** Capability a reviewer/editor session must hold to resolve held actions. */
export const REVIEW_PERMISSION = "approval.review";

/** Register the reviewer skills (close over the registry to reach its pending
 *  store + resolveApproval). The editor / a human calls these over MCP. */
export function registerApprovalSkills(registry: SkillRegistry): void {
  registry.register({
    name: "approval.list",
    version: "1.0.0",
    description: "List agent actions currently held for human approval (id, skill, proposed input, agent).",
    category: "system",
    permissions: [REVIEW_PERMISSION],
    effect: "read",
    input: z.object({}),
    output: z.object({
      pending: z.array(z.object({
        approvalId: z.string(),
        skill: z.string(),
        agentId: z.string(),
        profile: z.string().nullable(),
        tick: z.number(),
        input: z.unknown(),
      })),
    }),
    handler: () => ({
      pending: registry.pendingApprovals().map((p) => ({
        approvalId: p.approvalId,
        skill: p.skill,
        agentId: p.agentId,
        profile: p.profile ?? null,
        tick: p.tick,
        input: p.input,
      })),
    }),
  });

  registry.register({
    name: "approval.grant",
    version: "1.0.0",
    description: "Approve a held agent action by id; it is applied now and its outcome returned.",
    category: "system",
    permissions: [REVIEW_PERMISSION],
    effect: "admin",
    input: z.object({ approvalId: z.string() }),
    output: z.object({ resolved: z.boolean(), applied: z.boolean(), error: z.string().nullable() }),
    handler: async (input, ctx) => {
      // Pass the reviewer's CURRENT tick as the apply tick so the granted action's
      // provenance reflects WHEN it applied, not when it was proposed.
      const res = await registry.resolveApproval(input.approvalId, true, { agentId: ctx.agentId, applyTick: ctx.tick });
      const resolved = res.error?.code !== "not_found";
      return { resolved, applied: res.success, error: res.success ? null : (res.error?.message ?? null) };
    },
  });

  registry.register({
    name: "approval.deny",
    version: "1.0.0",
    description: "Reject a held agent action by id; it is dropped and never applied.",
    category: "system",
    permissions: [REVIEW_PERMISSION],
    effect: "admin",
    input: z.object({ approvalId: z.string(), reason: z.string().optional() }),
    output: z.object({ resolved: z.boolean(), error: z.string().nullable() }),
    handler: async (input, ctx) => {
      const res = await registry.resolveApproval(input.approvalId, false, { agentId: ctx.agentId, reason: input.reason });
      const resolved = res.error?.code !== "not_found";
      return { resolved, error: resolved ? null : (res.error?.message ?? "unknown approval") };
    },
  });
}

/** Default review gate: hold a caller's MUTATING world-edit skills (scene/ecs/
 *  physics writes) when the caller runs one of `reviewProfiles`. Never gates reads
 *  or the approval.* skills themselves. Relies on the live agent loop passing the
 *  agent's `profile` in the invoke base (actionSystem / runBoundedMultiTurn do). */
export function reviewProfileGate(reviewProfiles: ReadonlySet<string>): ApprovalGate {
  // DEFAULT-HOLD: a reviewed agent's call is HELD unless EVERY capability it requires
  // is read-only by naming convention. This avoids a stale static allowlist: newly
  // added reads such as `nav.read` stay ungated, while write/action caps such as
  // scene.write, audio.play, social.act, terrain.generate, and orchestrate are held.
  const readOnly = (permission: string): boolean => permission.endsWith(".read");
  return (name, base, skill: SkillDefinition): boolean => {
    if (base.profile === undefined || !reviewProfiles.has(base.profile)) return false;
    if (name.startsWith("approval.")) return false; // never gate the resolution skills
    return skill.permissions.some((p) => !readOnly(p));
  };
}

// ---- Known limitations (Phase 7 first cut; hardening is a follow-up) ------
// 1. Re-authorization at grant (registry.resolveApproval) re-checks REVOCATION
//    without re-running the quota/budget-committing policy evaluation. Quota and
//    call-budget usage are consumed exactly once, at proposal, and are not refunded
//    on deny.
// 2. RESOLVED — a granted action's apply-time events now carry the APPLY tick. The
//    `approval.grant` handler passes its `ctx.tick` to `resolveApproval`, which stamps
//    BOTH `skill.approval.granted` and `skill.executed` via registry.stampTick. The
//    propose-time `skill.approval.pending` event STAYS at the propose tick. Net per
//    emitted event:
//      - skill.approval.pending  -> PROPOSE tick (base.tick, in invoke)    [unchanged]
//      - skill.approval.granted  -> APPLY tick, FLOORED at the propose tick [new]
//      - skill.executed (granted)-> APPLY tick, FLOORED at the propose tick [new]
//      - skill.approval.denied   -> (no tick field; deny applies nothing)  [unchanged]
//    The floor (stampTick) guards "applied before proposed": a reviewer that never
//    advanced a sim tick (apply tick 0) cannot stamp an action proposed at a LATER tick
//    as if it applied at 0 — such a tick is floored back to the propose tick. A
//    non-gated invoke() supplies no apply tick, so its `skill.executed` keeps the
//    propose==apply base.tick exactly as before (replay-safe; p4_worldlog_* unaffected).
// 3. RESOLVED — approval controls and parked proposals are not replay commands.
//    The recorder discards a proposal when invoke returns `pending_approval`, skips
//    approval.grant/deny controls, and records only the original skill when a grant
//    actually applies it. Denied actions therefore never enter authoritative replay.
//    p57_approval_recording replays this stream into a fresh world and verifies the
//    reviewed mutation applies exactly once.
// 4. The pending map is capacity-bounded and every reservation expires after the
//    registry's bounded hold timeout (15 minutes by default). Expiry drops the
//    intent and emits skill.approval.denied. Proposal-time quota/call usage is not
//    refunded: retaining that charge prevents approval spam and the policy's own
//    window resets it. Duplicate-looking proposals remain distinct because their
//    tick/provenance can differ and need explicit reviewer handling.
