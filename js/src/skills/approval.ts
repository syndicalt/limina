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
    input: z.object({ approvalId: z.string() }),
    output: z.object({ resolved: z.boolean(), applied: z.boolean(), error: z.string().nullable() }),
    handler: async (input, ctx) => {
      const res = await registry.resolveApproval(input.approvalId, true, { agentId: ctx.agentId });
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
  const MUTATING = new Set(["scene.write", "ecs.modify", "physics.write"]);
  return (name, base, skill: SkillDefinition): boolean => {
    if (base.profile === undefined || !reviewProfiles.has(base.profile)) return false;
    if (name.startsWith("approval.")) return false;
    return skill.permissions.some((p) => MUTATING.has(p));
  };
}

// ---- Known limitations (Phase 7 first cut; hardening is a follow-up) ------
// 1. Re-authorization at grant (registry.resolveApproval) re-checks REVOCATION
//    only — not quotas/budgets, since re-running the full policy would double-count
//    the propose-time commit. Quota consumed at propose is not refunded on deny.
// 2. A granted action's `skill.executed` is stamped with the PROPOSE tick (the
//    parked base), not the apply tick — a provenance gap for the durable log.
// 3. Durable-log REPLAY of an APPROVAL-GATED session is not yet faithful: the
//    recorder logs the propose-invoke (worldlog/recorder.ts `attach`), so on a
//    gate-off replay a DENIED action would re-apply. The gate is OFF by default,
//    so non-gated sessions replay byte-identically (verified by p4_worldlog_*).
// 4. The pending map has no TTL/eviction; an agent that re-proposes every tick
//    creates near-duplicate pending entries (no dedup). Fine per session; cap it
//    for a long-lived host.
