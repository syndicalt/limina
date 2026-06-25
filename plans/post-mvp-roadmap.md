# Limina — Post-MVP Roadmap (beyond 0.1.0)

> Companion to [`ROADMAP.md`](./ROADMAP.md). `ROADMAP.md` tracks the **MVP and its
> verified extensions** — Phases 0–5, all complete and shipped in **0.1.0**. This file
> collects the **post-MVP themes** that were explicitly *out of scope* for the MVP (they
> live in the "production / ecosystem" tier of the original `README` roadmap, now preserved
> at [`docs/mvp-spec.md`](../docs/mvp-spec.md)).
>
> These are **themes and bets**, not committed plans — each is detailed at kickoff, like the
> roadmap-level phases. Status of every item below: **not started.**

## What 0.1.0 already covers (so it's not on this list)

The MVP spec's four pillars — Skill/Hook Registry, MCP interface, Observability, Agent
ecosystem — and their Phase 2–5 extensions are **done**: external agents over MCP
(stdio/websocket), interactive physics, durable + replayable world log, single-instance
scale (200 agents @ p95 4 ms), shared-world authoritative sync, QuickJS isolation, a dynamic
policy engine, versioned/attested packages, in-scene text/UI, and spatial audio. See
`ROADMAP.md` for the evidence.

## Post-MVP themes

### 1. Editor / IDE integration
Human + agent co-authoring inside an editor: live visual traces (the `perception → decision
→ action` tree rendered, not just JSONL), inspector panels in-IDE, and a human-in-the-loop
review surface for agent edits.
- **Why deferred:** the MVP inspector is CLI/JSON + an in-scene HUD; a real editor surface is
  a separate product surface, not needed to prove the agent-native core.
- **Builds on:** `inspector.snapshot`, `trace.tail`/`explainEvent`, the durable world log.

### 2. Mobile targets & packaging
First-class mobile/handheld targets and distributable, signed builds; promoting the
browser/wasm target from *optional / pull-on-demand* (delivered in Phase 4) to a supported,
GA path.
- **Why deferred:** desktop-native was the MVP focus (per the spec's scope guards); the
  wasm/browser path exists but is not a first-class shipping target yet.

### 3. Ecosystem & community
A public package registry / marketplace and a third-party **skill contribution model**:
discovery, publishing, and a signing/provenance UX on top of the existing substrate.
- **Why deferred:** the *mechanism* shipped in Phase 4 (versioned packages + manifest +
  capability attestation + content-hash provenance, gated by the policy engine); the
  *community process and hosted registry* are a separate, post-MVP effort.

### 4. Streaming & multi-turn tool orchestration
Streaming MCP responses for long-running operations, and multi-turn tool orchestration
beyond the MVP's single-shot tool selection.
- **Why deferred:** the spec explicitly scoped LLM calls to single-shot tool selection and
  marked streaming as "future-proofing." The request/response MCP contract is stable and
  forward-compatible with a streaming channel.

### 5. Advanced external memory adapters
The engine deliberately stays the **substrate, not the brain or the memory** (see the
standing principle in `ROADMAP.md`). This theme is about richer *external* memory adapters
behind the pluggable `LLMProvider` — vector stores, EventLoom/Zaxy bridges — never an engine
runtime dependency.
- **Why deferred:** recall is part of the brain; the MVP keeps it external by design.

## Out of scope (non-goals, still)

- Engine-owned agent memory or a built-in "brain" (violates the substrate principle).
- A bespoke JS engine (V8 via `deno_core` is the runtime; see Phase 0 decisions).
