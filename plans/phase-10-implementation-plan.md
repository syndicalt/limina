# Implementation Plan — Phase 10: Agent Governance & Orchestration

> The *how* for [`phase-10-governance-orchestration.md`](./phase-10-governance-orchestration.md) (the *what/why*),
> grounded in the current code. Three landable chunks (A → B → C), all **fully headless-verifiable**.
> **Status:** ready to build.

## Current state (the exact seams we change)
- **`registry.list()`** (`skills/registry.ts:192`) returns a **memoized full** `MCPTool[]` (the expensive
  `z.toJSONSchema` per skill is cached at `:196`). `MCPTool` is `{name, description, input_schema}` — it carries
  **no permissions**; each skill's `permissions` lives on the `SkillDefinition` in `this.skills`.
- **Leak sites (hand every agent the whole catalog):** `mcp.ts` `listTools()` → `registry.list()` (no session
  perms threaded); `agents/systems.ts` decision (`:184`) + `runBoundedMultiTurn` (`:348`) → `registry.list()`.
- **Invocation grant today:** `InvokeBase.permissions = resolveProfile(agent.profile)` (`systems.ts:234, 381`).
  So exposure and invocation should draw from the **same** source — they don't today (invocation is gated,
  exposure isn't).
- **Meta-skills exist:** `skills.list` / `skills.describe` (`skills/system.ts:86, 100`, `permissions: []`) call
  `registry.list()` unfiltered. The skill `ctx` (`ExecutionContext`) already has `permissions` (the caller's grants).
- **`AgentRecord`** (`agents/agent.ts:22`) has `profile: string` (a profile *name*); `resolveProfile` →
  `ReadonlySet<string>`.
- **Reusable primitives (shipped):** `PolicyEngine.evaluate` (commits quota on allow — so NOT usable for a
  read-only exposure check) + `PolicyEngine.isRevoked` (read-only, added in Phase 7); the **approval gate**
  (`setApprovalGate` / `resolveApproval` / `approval.grant|deny|list`, `skills/approval.ts`); `AgentRegistry.add`
  + `runBoundedMultiTurn` + `AgentScheduler`.

## Workstream A — Exposure scoping (land first; smallest, highest leverage)

**A1. Filtered `registry.list(grants?)`** — keep the memoized full build, filter cheaply per call:
```ts
list(grants?: ReadonlySet<string>): MCPTool[] {
  const full = this.fullList();           // the existing memoized build
  if (grants === undefined) return full;  // back-compat (legacy callers unchanged)
  return full.filter((t) => {
    const s = this.skills.get(t.name);
    return s !== undefined && s.permissions.every((p) => grants.has(p))
      && (this.policy === undefined || !revokedAny(this.policy, ... )); // optional: hide revoked caps
  });
}
```
Exposure = **static subset** (`skill.permissions ⊆ grants`), the right first cut. (Policy-aware exposure — also
hiding revoked caps — is a small refinement using `isRevoked`; `evaluate` can't be used because it commits quota.)

**A2. Thread grants into the leak sites:**
- `mcp.ts` `listTools()` → `listTools(session)` → `registry.list(session.permissions)` (the session already
  carries `permissions` from the handshake; thread it the few lines to the `tools/list` handler).
- `systems.ts` decision (`:184`) + multi-turn (`:348`) → `registry.list(agentGrants(agent))` (see B for
  `agentGrants`).

**A3. Filtered meta-skills + progressive disclosure** (`skills/system.ts`):
- `skills.list` / `skills.describe` → filter by `ctx.permissions` (a caller only lists/describes what it could
  invoke).
- **New `skills.search({ query, category? })`** → returns the *authorized* matches by name/description/category,
  so a large catalog is browsed, not dumped. (Category is already on `SkillDefinition`.)

**Verify (headless, `js/test/p10_exposure.ts`):** register the core set; a `player.limited` grant's `list()`
**excludes** `system.*` / `terrain.generate` and includes its read/act skills; a full `builder.readWrite` grant
is **unchanged** vs today (no regression); `skills.search` returns only authorized matches; `list()` with no
grants is identical to before (back-compat). Assert the filter is O(n) over the memoized list (no schema rebuild).

## Workstream B — Dynamic permission bundles

**B1. `AgentRecord` carries an optional bundle** (`agents/agent.ts`): add `bundle?: ReadonlySet<string>` (a
custom capability set). Helper `agentGrants(agent): ReadonlySet<string>` = `agent.bundle ?? resolveProfile(agent.profile)`.

**B2. One source for exposure AND invocation** (`systems.ts`): use `agentGrants(agent)` for **both** the
`registry.list(...)` filter (A2) **and** the `InvokeBase.permissions` (`:234, :381`). So what an agent sees ==
what it can invoke — least privilege, end to end. The policy engine already evaluates `permissions`; no change there.

**B3. Audit:** emit `agent.bundle.assigned` (actor=agent, payload=sorted caps) when a worker is spawned with a
bundle, so the trace records who-could-do-what (and replay reconstructs it).

**Verify (headless, fold into p10):** an agent given a 3-cap bundle sees exactly those skills, is **denied**
(policy-audited `security.permission.denied` / `policy.denied`) on anything outside it, and the bundle appears
in the trace; profile-only agents behave exactly as before.

## Workstream C — Coordinator / delegate model (lands last; the meatier piece)

**C1. `delegate` skill** (`skills/orchestration.ts`, `registerOrchestrationSkills(registry, deps)` closing over
the provider map + scheduler, like other stateful skills): input
`{ task: string, bundle: string[], agentType?, entityId?, maxSteps?, maxToolCalls? }`; permission `orchestrate`.
Handler: `AgentRegistry.add` a worker with `bundle = new Set(input.bundle)` + `llm.systemPrompt = task`, run
`runBoundedMultiTurn(worker, registry, providers, world, tracer, bounds)`, emit `agent.delegated` (causedBy the
coordinator's decision) and return `{ workerId, steps, toolCalls, reason }`. Worker results already surface as
`agent.tool_result` events on the worker's thread (the coordinator perceives them).

**C2. Review = the Phase 7 approval gate.** Install `setApprovalGate(predicate)` where the predicate holds a
**delegated worker's** mutating skills (e.g. the worker's bundle is flagged under-review, or its profile is a
`*.review` profile). The coordinator (an `orchestrate`+`approval.review` holder) calls `approval.grant|deny` on
the worker's held edits — exactly the existing seam, now driven by a coordinator agent instead of a human.

**C3. The coordinator loop** is `runBoundedMultiTurn` with `delegate` + `approval.grant|deny` as its tools (no
new loop primitive). Depth/budget/revocation are the policy engine's existing budgets + `isRevoked`.

**Verify (headless, `js/test/p10_delegate.ts`, mirrors `p7_approval` + `agent_multiturn`):** a coordinator
(scripted provider) delegates **two** workers with **distinct** bundles; each worker's mutating action is
**held**; the coordinator grants one + denies the other; assert the granted edit applied + the denied dropped +
both bundles enforced (cross-bundle calls denied) + the whole tree (`delegated → tool_result → approval.*`)
**replays bit-identically** from the durable log.

## Sequencing (3 PRs)
1. **A — exposure scoping** (filtered `list` + threaded grants + `skills.search` + p10_exposure). Ship alone;
   immediate safety + selection win, zero new concepts.
2. **B — dynamic bundles** (AgentRecord bundle + `agentGrants` + one-source exposure/invocation + audit).
3. **C — delegate/coordinator** (the `delegate` skill + gate-driven review + p10_delegate).

## Verification — all headless
No GPU/UAT. Mirror `p7_approval` (gate), `agent_multiturn` (multi-turn), `m1_registry` (registry). Full suite must
stay green: filtering with no grants and full grants must be byte-identical to today (the regression guard).

## Open questions / risks
1. **Policy-aware vs static-subset exposure** — recommend static-subset + `isRevoked` (no quota commit on a list).
2. **`delegate` result channel** — events (recommended; matches the agent loop) vs a synchronous worker handle.
3. **Nesting depth** — cap coordinator→worker→worker depth (a budget) to bound fan-out.
4. **Back-compat is the main risk** — `list()`/`listTools()` keep their no-arg behavior; only the new grant-passing
   call sites filter. The p10 test asserts the unfiltered path is unchanged.
