# How limina governs agents

*Least-privilege capability bundles, scoped tool exposure, and opt-in review — and why "the human approves everything" is a demo setting, not the engine's default.*

limina is an agent-native engine: agents author and run worlds by calling typed, permissioned, traced skills. Once you point more than one agent at a world, two problems show up. Can an agent do something it shouldn't? And can it even find the right tool among a catalog that keeps growing? limina answers both with the same idea — **least privilege** — applied in layers. Review by a human or a coordinator is one optional layer on top, not the foundation.

Here is how the layers fit together, from the capability an agent holds to the edit that finally lands in the world.

## Layer 1 — Capabilities, profiles, and dynamic bundles

Every skill declares the capabilities it requires — `scene.write`, `ecs.modify`, `terrain.generate`, `approval.review`, and so on. An agent holds a **set** of capabilities, and it can invoke a skill only if it holds *every* capability that skill declares.

Where that set comes from is the interesting part. There are two sources:

- A **profile** — a named static allow-list (`PERMISSION_PROFILES` in `skills/permissions.ts`). `player.limited` can read the scene and move; `terrain.author` can run the expensive generators; `reviewer` can resolve held actions. `resolveProfile(name)` turns a profile name into a capability set.
- A **dynamic bundle** — a per-task capability set attached directly to an agent (`AgentRecord.bundle`). This is how a coordinator hands a worker exactly the capabilities its one task needs, nothing more.

A single helper resolves the effective set:

```ts
agentGrants(agent) = agent.bundle ?? resolveProfile(agent.profile)
```

The bundle, when present, wins. That one function is the whole authority model — and, crucially, it feeds *both* of the next two layers.

## Layer 2 — Exposure: you only see what you could invoke

A naive engine hands every agent the full tool catalog and relies on the invocation check to reject anything out of scope. limina doesn't. `registry.list(grants)` filters the catalog down to the skills whose required capabilities are a subset of the agent's grants:

```ts
list(grants) = fullCatalog.filter(skill => skill.permissions.every(p => grants.has(p)))
```

So a scoped worker's tool list literally does not contain the skills it isn't allowed to call. This matters for safety (no probing of tools it can't use) and for tractability: an agent reasons over a small, relevant working set instead of a sprawling catalog. The meta-skills follow the same rule — `skills.list`, `skills.describe`, and `skills.search` only ever surface authorized skills, so even discovery can't leak the catalog.

Because exposure and invocation both read from `agentGrants(agent)`, what an agent can *see* and what it can *do* are guaranteed to match. There is no gap between the two to exploit.

## Layer 3 — The policy engine: the invocation gate

When an agent actually calls a skill, the policy engine evaluates the request against the agent's grants: allow or deny, plus quotas and live revocation. This is the hard enforcement boundary. Exposure scoping (Layer 2) is what an agent *sees*; the policy engine is what the engine *permits*. An agent that somehow names a skill outside its grants is denied with no effect, and the denial is recorded.

## Layer 4 — The approval gate: opt-in review

This is the layer the coordinator demo puts on stage, so it's the one most worth being precise about.

**The approval gate is off by default.** A session with no gate installed runs every authorized action straight through, and because the world is a pure function of its command log, that session replays byte-for-byte. Nothing forces a human into the loop.

When you *do* want review, you install a gate — a predicate that decides which actions to hold:

```ts
reviewProfileGate(reviewProfiles)  // holds an action when:
  //  - the acting agent's profile is in reviewProfiles, AND
  //  - the skill needs any non-read capability
```

Two things make this narrow on purpose:

- It keys on **profile**, so only agents you've explicitly flagged for review are gated. Everyone else is untouched.
- It is a **denylist of reads**: `scene.read`, `ecs.read`, `physics.read`, `agent.read`, `terrain.read` always pass through, and the `approval.*` skills are never gated. "Review everything" really means "hold the *world-writes* of agents I flagged."

A held action becomes a `skill.approval.pending` event and waits. A holder of `approval.review` lists it (`approval.list`), then `approval.grant`s it (it applies now) or `approval.deny`s it (it's dropped and never touches the world). Gates compose: `addApprovalGate` OR-combines a new predicate with any existing one, so a human-review gate and a coordinator-review gate can coexist.

## Putting it together — the coordinator / delegate model

The coordinator demo is these four layers in motion. A coordinator agent holds `orchestrate` (to delegate) and `approval.review` (to sign off). It calls one skill:

```ts
delegate(task, bundle)   // requires `orchestrate`
```

For each delegated task the engine spawns a fresh worker with:

- `bundle = new Set(task.bundle)` — its real, least-privilege capabilities (Layers 1–3), and
- `profile = "delegate.review"` — a marker that flags it for the review gate (Layer 4).

The worker runs a bounded multi-turn loop. Its reads pass through; its mutating edits are held for the coordinator to grant or deny. The capability that a worker is *running under review* is just a flag — its actual power comes from the bundle.

Two guardrails are wired in, not left to the host:

- **Escalation caps are refused.** A worker bundle may not contain `approval.review` (it would let a worker approve its own held edits) or `orchestrate` (it would let a worker spawn more workers unbounded). The `delegate` skill rejects such a bundle before spawning anything — fail-closed.
- **The review gate ships with the surface.** Registering the delegation skill co-installs the review gate via `addApprovalGate`, so a delegated worker is never accidentally run unreviewed. (An early version installed the gate only in the test; that's exactly the kind of gap that makes the green test lie, and it was caught and fixed.)

## It's all traced and replayable

Every step emits a typed event with causal links: `agent.delegated`, `agent.decision.made`, `skill.approval.pending`, `skill.approval.granted` / `denied`, `skill.executed`. The `causedBy` edges form a tree you can replay and audit — who delegated what, under which bundle, what was held, who approved it. Because the world is a pure function of `(seed + command log + snapshots)`, the durable JSONL log *is* the portable record of the session, and a non-gated run reproduces bit-for-bit.

## What actually ships by default

To be unambiguous, since the demo cranks review to its maximum:

- **No mandatory human review.** The gate is opt-in and off unless installed.
- **The default isolation is the bundle**, enforced by exposure scoping + the policy engine — *before* any review enters the picture.
- **Review is a scalpel, not a blanket.** Even when on, it gates only the write-class actions of agents you flagged, never reads, never `approval.*`.

A shipped title would typically lean on least-privilege bundles and let agents run without a human in the loop — gating only the narrow set of actions that particular game wants a human, or a coordinator, to sign off on. The "approve every edit" experience in the demo is a deliberately heightened illustration of the mechanism, turned up so you can watch it work.
