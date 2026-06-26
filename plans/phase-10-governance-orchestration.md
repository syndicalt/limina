# Plan — Phase 10: Agent Governance & Orchestration

> The safe-scaling foundation for the agent-native mission: an agent only *sees* the skills its role grants,
> and a **coordinator** (human or agent) decomposes a goal, hands workers **scoped permission bundles**, and
> **reviews** their mutating work before it applies.
> **Goal:** make it safe and tractable to point *many* agents at *one* game as the skill catalog grows — least
> privilege in both exposure and invocation, with a first-class delegate/review loop.
> **Gate:** a `player.limited` agent's tool list excludes `system.*`/`terrain.generate`; a coordinator spawns a
> worker with a scoped bundle, the worker's mutating edits are held for review, the coordinator grants/denies
> them, and the whole tree is traced + replayable.
> **Builds on (shipped):** permission profiles (`skills/permissions.ts`), the policy engine
> (`policy/engine.ts` — deny by profile/quota/revocation/budget), the **Phase 7 approval gate**
> (`skills/approval.ts`), multi-turn agents (`runBoundedMultiTurn`), the causal trace + durable log.
> **Status:** not started. **~70% of the primitives already exist** — this is mostly assembly + the exposure layer.

## Why this comes first
Today **invocation is gated but exposure is not**: `registry.list()` returns the *entire* catalog to every
agent (`mcp.ts` `listTools`, `agents/systems.ts` decision + multi-turn). So a growing catalog makes agents
(a) worse at tool selection, (b) wasteful (calling skills that just get denied), and (c) over-exposed (the
full attack surface advertised). Every skill we add in Phases 11–12 makes this worse until it's fixed. It's
the cheapest, highest-leverage work and unblocks everything after it.

## Load-bearing decisions
1. **Exposure = least privilege (matches the security boundary).** `registry.list(caller)` returns only the
   skills the caller could actually invoke (its profile/bundle grants ⊇ `skill.permissions`, or the policy
   would allow). Defense in depth: don't advertise what can't be used.
2. **Coordinator is role-agnostic.** The approval gate + policy engine don't care whether the reviewer/assigner
   is a human or an agent — so **human-coordinator works today** (editor + approval), and **agent-coordinator**
   is the same primitives with a planner doing the decomposition.
3. **Bundles are first-class.** A *bundle* is a (possibly dynamic) capability set assigned per task — the fixed
   profiles are the common presets; arbitrary least-privilege bundles are a small policy extension.

## Workstreams
### A. Exposure scoping (the prerequisite)
- **Profile/bundle-filtered `list()`** at both call sites (MCP `listTools`, the agent decision loop) — pass the
  caller's permissions; return only invocable skills.
- **Progressive disclosure** for scale: expose **categories** + a `skills.search` / `skills.describe`
  meta-skill so the agent browses (~10 namespaces) and pulls specific verbs on demand, instead of a flat dump
  (the deferred-tools pattern). 
- **Task-scoped working sets**: the coordinator hands a worker a curated subset even of its profile.
- **Accept:** a `player.limited` agent's advertised tools exclude `system.*`/`terrain.generate`; `skills.search`
  returns only authorized matches; existing single-agent behavior unchanged when a full bundle is granted.

### B. Dynamic permission bundles
- Compose a least-privilege capability set per task (beyond the fixed profiles); the policy engine enforces it
  unchanged (it already evaluates `permissions` + `requiredPermissions`). Bundles are recorded (audit/replay).
- **Accept:** a worker granted a 3-capability bundle is denied everything outside it (policy-audited), and the
  bundle is in the trace.

### C. The coordinator / delegate model
- A **`delegate(task, bundle)` skill**: a coordinator agent spawns a sub-agent with a task + a scoped bundle;
  the worker runs bounded multi-turn; results return as events. Depth/budget/revocation governed by the policy
  engine (already has budgets + revocation).
- The **coordinator loop**: `runBoundedMultiTurn` with "spawn → await → review" moves; review uses the Phase 7
  approval gate (hold worker mutations, coordinator grants/denies).
- **Accept:** a coordinator decomposes a goal into ≥2 delegated workers with distinct bundles, reviews and
  approves/rejects their held edits, and the session replays bit-identically from the durable log.

## Verification
- **Headless:** filtered `list()` per profile; `skills.search` authorization; bundle enforcement (denials
  audited); a delegate→worker→review→apply flow with replay-parity (mirrors `p7_approval` + `agent_multiturn`).
- This phase is **fully headless-verifiable** (no GPU/UAT) — it's policy + registry + agent-loop wiring.

## Out of scope (first cut)
Visual org-chart UI for the coordinator (editor can show it later); learned/automatic decomposition quality
(the planner uses the LLM); cross-process worker isolation beyond the existing sandbox/policy.

## Open questions
1. Bundle representation — named presets only vs arbitrary capability sets (recommend: presets + arbitrary).
2. `delegate` result channel — events vs a synchronous handle the coordinator polls.
3. Default exposure when no policy engine is attached (static-permission fallback should still filter).
