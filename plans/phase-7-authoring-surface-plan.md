# Plan — Phase 7: The Authoring Surface

> Kickoff plan for **Phase 7** of [`post-mvp-roadmap.md`](./post-mvp-roadmap.md) — the first real *build*
> sprint and the agent-native lead.
> **Goal:** a person and an agent co-author a world together, with **every step visible**
> (perception → decision → action rendered, inspector panels, human review/approve of agent edits), and
> agents take **streaming / multi-turn** turns (beyond today's single-shot tool selection).
> **Gate:** a person and an agent co-author a non-trivial world in the editor — the agent taking
> multi-step turns, every step visible live, the human approving/rejecting agent edits *before they
> apply*, and the whole session traced and replayable from the durable log.
> **Builds on (shipped):** the causal event model (`observability/event.ts`, every event carries
> `causedBy[]`), the read skills (`inspector.snapshot` / `trace.tail` / `trace.explainEvent` in
> `skills/system.ts`), the authoritative WebSocket server + `state/subscribe` per-tick deltas
> (`net/server.ts`), the bounded multi-turn seam (`agents/systems.ts:296` `runBoundedMultiTurn`), the
> policy engine, and the registry before/after hooks.
> **Status:** not started.

## What's actually new vs reused

The substrate is mostly already here — Phase 7 is sharp additions, not a from-scratch build:

- The **causal tree exists**: along one agent step the engine emits `agent.perception.updated` →
  `agent.decision.made` (causedBy the perception) → `agent.tool_result` / `agent.toolcall.rejected`
  (causedBy the decision + the emitted skill events). The editor only needs to *render* this via
  `trace.explainEvent` walking `causedBy`.
- The **read APIs exist**: `inspector.snapshot` returns world + entities + agents + skills + recent trace
  (`system.ts:194-292`); `trace.tail` is a cursor stream; `state/subscribe` pushes per-tick deltas over
  ws (`net/server.ts:446`).
- **Multi-turn already has a seam**: `runBoundedMultiTurn` (`systems.ts:296`) loops
  perception → decision → tool with `previousResults` feedback. The default `decisionSystem` is
  single-shot (`systems.ts:187`, `provider.decide({ …, previousResults: [] })`).
- What's **genuinely missing**: (1) a human-in-the-loop **approval gate** — none exists; `registry.invoke`
  executes immediately after the policy decision (`registry.ts:306-341`); and (2) the **editor surface**
  itself — today there is only an in-scene trace HUD (`ui/hud_feed.ts`), no external review UI.

## Load-bearing decisions (get these right first — they fix the wire the editor depends on)

1. **The approval protocol.** When an agent proposes a *mutating* action, the engine must HOLD it pending,
   surface it, and apply only on human grant. **Recommend** gating in `registry.invoke()` immediately after
   the policy decision (`registry.ts:306-325`): emit a `skill.approval.pending` event (causedBy the
   decision), park the intent in a pending store keyed by approval id, and return
   `{ success:false, error:{ code:"pending_approval", approvalId } }` instead of executing. New human-only
   skills `approval.grant({approvalId})` / `approval.deny({approvalId, reason?})` resolve it — grant
   re-runs the parked intent (marked approved, bypassing the gate) and emits `skill.approval.granted`;
   deny drops it and emits `skill.approval.denied`. *Reads are never gated.* This reuses the policy gate +
   the event/causedBy chain and works for both in-process and ws-driven agents (one path).
   - *Alternative:* gate at the server tick boundary (`net/server.ts:401`, ws-only). Rejected — the
     registry path covers both transports with one mechanism.
2. **The editor↔engine contract.** The editor is an external **MCP-ws client** (`net/server.ts`, port
   8787). It READS via `inspector.snapshot` + `trace.tail` + `state/subscribe` (all shipped) and ACTS via
   `approval.grant`/`approval.deny`. The only new wire is the approval flow + a trace stream — no bespoke
   protocol.
3. **Streaming the reasoning.** The editor needs perception/decision/action events live, not by polling.
   **Recommend** a `trace/subscribe` push (or fold trace events into the existing per-tick delta channel,
   `net/server.ts:446`) so the editor renders a turn unfolding.
4. **Where the editor lives.** A dedicated web client connecting to a running engine over ws. **First cut
   is a 2D dashboard** (world/entity panel + per-agent reasoning tree + approval queue) — **not** a 3D
   viewport. The live WebGPU world rides Phase 8's browser runtime; until then the editor visualizes
   *state + trace* (and can embed an in-scene HUD/screenshot). Recommend a small standalone app, kept
   separate from the marketing site.

## Workstreams

### A. Approval seam — the human-in-the-loop (engine)
- New event types `skill.approval.pending` / `granted` / `denied`; a pending-approval store
  (`approvalId → { tool, input, base, decisionEventId }`).
- Gate inside `registry.invoke()` after policy eval (`registry.ts:306-325`): if `(skill, profile, session)`
  is *under review*, park + emit pending + return `pending_approval` rather than invoking.
- New skills `approval.grant` / `approval.deny`, restricted to a reviewer permission/profile.
- "Under review" is an **opt-in** policy/profile flag (e.g. an agent running a `review` profile has its
  mutating skills gated); default off, so existing behavior is byte-unchanged unless review is enabled.
- **Accept:** an agent's mutating call is held (no world change) and surfaced as an event; a human grant
  applies it (world changes + `granted` event); a deny drops it; reads are never gated; the causal chain
  stays intact and the run still replays from the durable log.

### B. Multi-turn + streaming (engine)
- Route agents marked multi-turn through `runBoundedMultiTurn` (`systems.ts:296`) so a turn can chain tool
  calls using `previousResults` feedback; keep single-shot as the default cheap path.
- Stream per-step events (perception / decision / tool_result) over ws as they emit (extend the
  subscribe/delta push) so the editor shows the turn live.
- **Accept:** an agent completes a multi-step turn (≥2 tool calls where each feeds the next decision)
  within a bounded budget; the editor shows each step live; determinism + the durable log still hold.

### C. The co-authoring editor (web client)
- External MCP-ws client: `initialize`, `state/subscribe`.
- **World panel** — render `inspector.snapshot` (entities/transforms/tags/physics, agents, skills,
  resources), refreshed by subscribe deltas.
- **Reasoning tree** — per agent, build perception → decision → action from `trace.tail` +
  `trace.explainEvent` (walk `causedBy`); show each decision and the tool calls/rejections it produced,
  live via the trace stream.
- **Approval queue** — list pending `skill.approval.pending` items with the proposed action + a diff of
  what it would change; approve/reject buttons call `approval.grant`/`approval.deny`.
- **Accept:** a human watches an agent perceive → decide → act and approves/rejects its edits before they
  apply.

## Smallest first cut (and what's deferred)

First cut = the three workstreams at minimum fidelity: a 2D dashboard, **one** agent under review, approval
for its mutating skills, multi-turn for that agent, live trace. Defer: in-editor 3D viewport (rides Phase
8), rich visual diffs, multi-human collaboration, undo/redo of agent edits, and IDE-extension packaging.

## Acceptance gate (Phase 7 done)

A person and an agent co-author a non-trivial world in the editor: the agent takes multi-step turns; every
perception → decision → action is visible live; the human approves/rejects the agent's mutating edits
before they apply; the whole session is traced and replays bit-identically from the durable log.

## Out of scope (deferred)

- The browser 3D runtime / live viewport (**Phase 8**) — the editor visualizes state + trace, not the live
  WebGPU world yet.
- Learned worldgen (**Phase 9**) and the ecosystem registry / marketplace (**Phase 10**).
- A general IDE extension or a marketplace of editor plugins.

## Open questions (decide at kickoff)

1. **Approval gate location** — `registry.invoke()` (recommended; one path for in-process + ws agents) vs
   the server tick boundary (ws-only).
2. **Editor home + stack** — standalone web app vs an Astro route in the existing site (the read APIs are
   transport-agnostic MCP, so any web stack works).
3. **Streaming mechanism** — a dedicated `trace/subscribe` vs folding trace events into the existing
   per-tick delta push (`net/server.ts:446`).
4. **Default review scope** — opt-in `review` profile (recommended, zero behavior change otherwise) vs
   gating all mutating agent skills by default.

---

## Status & outcomes (implemented — first cut)

- **Approval gate (the new core) — DONE, verified.** `registry.invoke()` gains an opt-in review gate
  (`setApprovalGate` / `reviewProfileGate`) between policy-allow and apply: a gated mutating call is HELD —
  `skill.approval.pending` emitted, the intent parked, `pending_approval` (MCP `-32003`) returned — with
  **no world change** until a reviewer (the `reviewer` profile / `approval.review`) calls `approval.grant`
  (applies it) or `approval.deny` (drops it). The `invoke` refactor (`makeCtx`/`applyHandler`) is
  behavior-equivalent on the non-gated path (adversarially reviewed; gate off by default). Grants are
  re-authorized against live **revocation** (`PolicyEngine.isRevoked`) so a held action can't outlive its
  authorization. Tests: `js/test/p7_approval.ts` (held→grant applies / deny drops / reads ungated /
  reviewer-only / causal chain — asserting real entity counts) + `p7_approval_revocation.ts` (revoke
  between propose and grant ⇒ fail-closed).
- **The co-authoring editor — built + engine-contract verified.** `editor/` (zero-build web app: an MCP-ws
  client, a reasoning-tree builder over `causedBy`, World / Reasoning / Approval-queue panels, live by
  polling `trace.tail` + `inspector.snapshot`) + `editor/server/editor_host.ts` (gate-enabled server on
  `:8787`). `js/test/p7_editor_contract.ts` drives the **exact editor sequence over real WebSocket
  sockets** (inspector.snapshot → held action → trace.tail finds the pending → approval.list →
  approval.grant applies, entities 1→2; plus the deny path) and a cross-process check. The visual rendering
  is built-to-spec, not screenshot-verified in this headless env.
- **Multi-turn — already present** (`runBoundedMultiTurn`, tested by `agent_multiturn.ts`); Phase 7 only
  threads `profile` into the live invoke bases so the gate applies to live agents. Streaming-push is
  deferred — the editor polls the `afterSeq` cursor (functional for the first cut).
- **Verification:** 54/54 runnable headless tests pass, 0 regressions; the perf capstone `p3n4` is excluded
  as load-gated (proven environmental by revert-compare under load avg ~5).
- **Known limitations** (documented in `js/src/skills/approval.ts`): grant re-checks revocation only (not
  quota/budget); a granted `skill.executed` carries the propose tick; durable-log replay of a *gated*
  session isn't yet faithful for denied actions (the gate is off by default, so non-gated replay is
  byte-identical — verified by `p4_worldlog_*`); the pending map has no TTL/dedup. All Phase 7 follow-ups.
