# Limina — Phase 4 Plan: Shared Platform

> **Status:** ✅ **Phase 4 COMPLETE & verified (2026-06-23)** — 4a (M1–M5) + 4b (M6–M9) + spikes
> P4.0a/P4.0b/P4.0c all delivered & verified; `cargo build`/`clippy`/`fmt` clean, **31/31 headless + 2 Rust
> integration tests** pass, 4b capstone green. Only **4x/M10 (browser/wasm) remains — optional, pull-on-demand**. Logging-bridge slice delivered (Zaxy 2.6.2).
> **Parent roadmap:** `plans/ROADMAP.md` · **Builds on:** Phase 3 (Single-Instance Scale & Fidelity)
> **Principle:** performance-first — share, persist, and govern worlds without giving up the
> per-instance ceiling Phase 3 proved.

Phase 4 turns one excellent Limina instance into a platform for shared, persistent, governable
worlds. Humans, Agent Builders, and Agent Players should coexist in the same authoritative worlds;
world state should survive restarts and support replay; third-party skills and agents should be
distributable without bypassing the engine's capability boundaries.

## Pillars

### P4-A — Replay-complete durable worlds

- Promote Phase 2/3 observability from "trace what happened" to a **world command/event model**
  that is complete enough to rebuild state: scene creation, ECS mutations, physics-relevant inputs,
  agent actions, policy decisions, and versioned asset/package references.
- Use **snapshots + delta log** as the default performance-first architecture unless kickoff
  research proves pure event replay is fast enough at target scale.
- **Zaxy/EventLoom integration is LOGGING** — a durable, replayable world event log, *not* agent
  memory (memory is an agent-layer/provider concern; see ROADMAP standing principle). Limina already
  emits EventLoom-shaped, sha256-chained events; the bridge mirrors them OFF the hot path into a
  **dedicated limina-owned session** via **Zaxy 2.6.2's batch-ingest + caller-id/chain-preserving
  append**. (2.6.1 had neither: every append re-id'd + re-chained, single-event, with per-event
  embed/Kuzu cost — unsuitable for world-log volume. 2.6.2 lets limina's own ids + continuous chain
  survive through a supported API, no direct-`.jsonl` workaround.) **Gated on Zaxy 2.6.2 shipping
  batch + caller-id/chain-preserving append; build the limina-side exporter once that lands.** Interop:
  align limina's hash canonicalization with EventLoom v1 (or confirm 2.6.2's preserve-verify semantics)
  so the chain is mutually verifiable. Raw observability events alone are not authoritative-replay
  sufficient — the world command/event model (above) is.
- **Producer identity rides the `actor` field — no `producer` field in the ingest manifest** (Zaxy
  2.6.2 decision). Limina reuses Zaxy's existing actor-attribution dimension: engine events carry a
  producer-namespaced `actorId` (e.g. `limina:<in-world-actor>` — `limina:engine`, `limina:agt_player`,
  `limina:<builder-session>`) so both the producer (limina) and the specific in-world actor are
  distinguishable in one field, with no Zaxy schema change. The namespaced actor also becomes the
  token in limina's preserved id (`evt_<actor>_<seq>_<hash>`); pick an id-safe separator at impl time.
- **✅ Logging bridge DELIVERED & verified (2026-06-23, Zaxy 2.6.2).** `js/tools/eventloom_bridge.mjs`
  — an optional, out-of-engine-core node adapter — mirrors limina's EventLoom-shaped durable trace
  into a dedicated Zaxy session via `zaxy memory ingest`, preserving limina's `id`/`parentEventId`/
  `causedBy`, attributing the producer via `actor="limina:<actorId>"`, idempotent via `producer_ref`
  (= the limina event id). Zaxy recomputes its own seq/hash chain (so no hasher alignment needed);
  original timestamp/thread ride in `payload.__limina_origin`. Real round-trip test
  `js/test/eventloom_bridge_roundtrip.mjs` (produces a genuine 3-event causal trace via the limina
  binary → ingests into a temp eventloom-path → verifies preserved ids/links + chain integrity +
  idempotence; falsifiability-proven). **Remaining P4-A (world command/event model that is
  replay-complete, snapshots+delta) is still future** — this slice is logging mirror, not yet the
  authoritative world log.

### P4-B — Networked / shared worlds

- An **authoritative server** owns simulation and policy; clients receive state sync and submit
  intent/tool calls rather than mutating world state directly.
- Support humans and agents in the same world, including interest management / area-of-interest so
  sync scales with visible/relevant state.
- External agents still connect through the MCP-derived surface, now scoped to a shared
  authoritative world instead of a private local instance.

### P4-C — Governance & safety at scale

- Replace static profile allow-lists with a **dynamic policy engine** for contextual permissions,
  quotas, revocation, and resource budgets.
- Enforce policy at non-bypassable boundaries: untrusted skills/agents run outside the privileged
  engine isolate, and every mutating capability crosses a host/registry boundary with an auditable
  decision.
- Add queryable audit surfaces for actions, denials, resource usage, package provenance, and
  capability attestations.

### P4-D — Skill / agent ecosystem

- Package and distribute skills, scenes, and agent templates with versioned manifests, declared
  capabilities, asset references, and compatibility bounds.
- Extend per-skill semver discovery into registry/package-level versioning.
- Third-party packages are allowed only after P4-C governance can prove what they may touch, what
  they did touch, and how to revoke them.

### P4-X (cross-cutting) — Browser / wasm runtime target

- Build a wasm/browser runtime target where Three.js WebGPU runs against the browser's native
  WebGPU instead of `deno_webgpu`, while sharing as much of the JS skill/agent layer as practical.
- Treat browser/wasm as a second runtime target, not a replacement for the native high-performance
  path. Pull it earlier only if a concrete user/deployment need justifies the extra compatibility
  surface.

## Key bets (resolve at kickoff)

- **World log contract** — which commands/events are replay-complete, how snapshots are versioned,
  and what divergence tolerance is acceptable after replay.
- **Netcode model** — authoritative server with client prediction/reconciliation vs lockstep; how
  fixed-step determinism and agent decisions map onto state sync.
- **Policy language and enforcement** — declarative policy vs programmable hooks; enforcement at
  host op boundaries, registry invocation, package loading, and transport/session admission.
- **Package trust boundary** — how third-party skills declare capabilities, how those declarations
  are attested, and how runtime behavior is audited.

## Dependencies & sequencing

Phase 4 hard-depends on Phase 3's single-instance density, devtools, and isolation substrate, and
on Phase 2's transport/durable trace foundation. Within Phase 4, durable world state (P4-A) should
land before shared worlds depend on restart/replay. Governance (P4-C) gates the third-party
ecosystem (P4-D). Browser/wasm can run independently only if it does not weaken the native runtime
or agent capability model.

## Acceptance (sketch — firmed at kickoff)

At kickoff, set numeric targets and deployment assumptions for:

- **Persistent shared world:** at least one human client and one external agent act in one
  authoritative world; state syncs; restart recovery rebuilds the world from snapshot + delta log
  within the target recovery time.
- **Replay correctness:** replayed world state matches expected state within an explicit divergence
  tolerance across engine/package versions allowed by the manifest.
- **Governed package:** a third-party skill package loads with declared capabilities, runs outside
  the privileged isolate, is governed by policy, and leaves a queryable audit trail for every
  allowed or denied action.
- **Platform resource control:** per-session or per-tenant CPU/GPU/memory/tool-rate budgets are
  enforced and visible in audit/devtool surfaces.

## Scope guards

Phase 4 will likely split into 4a/4b at kickoff: durable worlds + networking first, then ecosystem
distribution once governance is real. Do not launch marketplace/shareable bundles before the trust
boundary and audit model are enforceable.

**Non-goal — the engine does not provide an agent-player memory solution.** Memory/recall is an
agent-layer concern that lives behind the pluggable decision provider (`LLMProvider`), fed by the
engine's perception + durable world log, with any backend (Zaxy, vector DB, none) as an external
adapter — never an engine runtime dependency. The P4-A EventLoom work is **logging** (persisting the
world), not memory. External Agent Builders bring their own memory over MCP.

## Executable plan — milestones & numeric acceptance (2026-06-23)

> Operationalizes the pillars into ordered, falsifiable milestones. **Hardware baseline:** i7-12700H +
> RTX 3050, Wayland/Vulkan; localhost/LAN for networking targets. Splits into **4a (durable + shared
> worlds — not blocked on isolation)**, **4b (governed ecosystem — gated on the isolation substrate
> deferred from Phase 3)**, and an independent **4x (browser/wasm)**. Every milestone's ANTI-HACK
> clause is binding.

### Global anti-hack rules
Replay/recovery must rebuild from the **persisted log/snapshot alone** (never reuse held in-memory
state). Networking must use **real remote processes** with server **authority enforced** (a client's
direct state write is rejected), not in-process fakes. Isolation must be proven by a **real escape
attempt being contained**, not a code convention. Policy must be enforced at a **non-bypassable
boundary** and proven by **real denials**. Tests assert real behavior and FAIL when the feature is
broken/stubbed; never weaken existing tests to pass.

### De-risking spikes (lead with these)
- [x] **P4.0a — world-log replay determinism — ✅ DONE (folded into M1).** Bit-identical replay over
  12,839 commands / 3,050 ticks (51 entities, 180 fields); impulse + seed perturbations diverge
  (falsifiable). `js/test/p4_worldlog_replay.ts`.
- [x] **P4.0b — isolation — ✅ RESOLVED: QuickJS.** Two sandboxes prototyped (`spikes/isolation/`); both
  contain all 6 escapes; per-call overhead a wash (~340–390 ns); QuickJS chosen on density (~24× lighter,
  ~32× faster startup, catchable OOM, in-thread CPU/mem budgets). Main/render isolate stays V8. M6 integration
  sketch in `spikes/isolation/REPORT.md`.
- [x] **P4.0c — netcode — ✅ RESOLVED.** Two real processes over a real socket (`spikes/netcode/`):
  authoritative server + client intent round-trip + state sync; **p95 17.6 ms** over 2000 round-trips
  (transport p95 0.05 ms — the rest is one 60 Hz tick), authority enforced (direct write rejected,
  ungranted intent rejected, granted applied), grounded in the real engine (unmodified `--mcp-ws`,
  read-only session rejected −32001). Model: authoritative server + clients-as-views + state deltas.

## Phase 4a — Durable + Shared Worlds  (no isolation dependency)

- [x] **M1 — World command/event model (the keystone).** Define the **replay-complete** command/event
  set (scene creation, ECS mutations, physics inputs: spawns/impulses/seeds, agent actions, RNG seed,
  tick boundaries). *Accept:* a recorded session replayed into a fresh engine reproduces final world
  state **bit-identical** over ≥10k events / ≥3k ticks; any divergence fails. (Builds on the proven
  fixed-step determinism: `p0_5_physics`, `billiards_physics`.)
  - **✅ DELIVERED & verified (2026-06-23):** `js/src/worldlog/{log,recorder,replay,index}.ts` —
    authoritative world log (seed/physics/skill commands, JSONL, versioned), recorder (registry-invoke +
    physics-op proxy + seed hooks, re-entrancy-aware so skill-internal ops aren't double-logged), disk-only
    replay into a fresh world (no provider re-runs). Bit-identical over 12,839 cmds / 3,050 ticks;
    perturbation-falsified; baselines green; no engine-core files touched.
- [x] **M2 — Snapshots + delta log.** Periodic world snapshot + delta event log; restart recovery =
  load latest snapshot + replay deltas. *Accept:* kill + restart recovers the world (entity count,
  transforms, physics state) bit-identical to pre-kill within **≤2 s for a 10k-event world**; snapshot
  cadence configurable. Recovery is from disk, not a held process.
  - **✅ DELIVERED & verified (2026-06-23):** native physics snapshot via rapier `serde-serialize`
    (new `op_physics_snapshot`/`op_physics_restore`, bincode; existing op arity intact) + JS world state
    (ECS SoA, `EntityTable.snapshot/restore`, bitECS index, RNG state) in `js/src/worldlog/snapshot.ts`.
    `recoverWorld` = restore snapshot@T + replay ONLY the delta (no genesis). `p4_snapshot_recovery.ts`:
    recover from disk bit-identical (252 fields, 75 entities) in **30 ms** from latest snapshot / 1050 ms
    from mid (genesis = 1605 ms), real mid-stream resume (50 steps not 3050), 3 perturbations diverge.
- [x] **M3 — Authoritative world log → durable sink (extends the delivered logging bridge).** The M1
  log persists durably and round-trips: persist → reload → replay → bit-identical. *Accept:* a session
  reconstructs from the persisted authoritative log (the EventLoom bridge already mirrors trace events;
  M3 makes the *authoritative* world log the persisted source of truth).
  - **✅ DELIVERED & verified (2026-06-23):** `js/src/worldlog/durable.ts` streams each tick's commands
    to disk incrementally (one fsync'd segment/tick). `p4_worldlog_durable.ts`: on-disk log grows
    monotonically, mid-run reads are clean JSONL crash-prefixes, persist→reload→replay bit-identical
    (508 fields, 133 entities), streamed == one-shot stream.
- [x] **M4 — Authoritative server + state sync.** Server owns sim + log; clients submit intent/tool
  calls; server broadcasts authoritative deltas. *Accept:* ≥2 real remote clients (1 human-driven + 1
  external MCP agent) act in ONE authoritative world; a mutation by one appears on the other at **p95
  ≤ 50 ms localhost / ≤ 150 ms LAN**; a client's attempt to mutate state directly (not via accepted
  intent) is **rejected**.
  - **✅ DELIVERED & verified (2026-06-23):** multi-client WS transport `crates/limina-runtime/src/net.rs`
    (clean cutover: replaced single-client `mcp_ws.rs`) + `js/src/net/{protocol,server,client}.ts`. Server
    owns the fixed-step sim + M1 log; per-client fan-out; clients `state/subscribe` → snapshot (reuses M2)
    then per-tick `state/delta` (change-set). Authority structural: only intent-submit + reads on the wire,
    permission at SkillRegistry.invoke, session-bound attribution. **Verified:** 2 real WS clients in ONE
    world, A→B cross-mutation **p95 11 ms** over 200 round-trips (≤50 ms); authority enforced 3 ways
    (direct write `-32601` + state unchanged; `player.limited` `ecs.modify` `-32001`; spoofed actorId absent
    from the log); falsified by broadcast-off. `js/test/p4_authoritative_sync.ts` + Rust e2e
    `tests/p4_multi_client_sync.rs` (real binary + 2 external clients). Existing WS e2e `tests/mcp_ws.rs` survives.
- [x] **M5 — Interest management / area-of-interest.** Sync scales with relevant state. *Accept:* with
  K world entities and a client AoI, the client's sync stream is **O(relevant), not O(K)** — churn of a
  far-away entity does not appear in the client's stream; bandwidth scales with AoI, not world size.
  - **✅ DELIVERED & verified (2026-06-23):** per-client AoI filter on the per-tick delta (`inAoi`/`parseAoi`
    in `js/src/net/protocol.ts`; snapshot + deltas filtered per subscriber). `js/test/p4_interest_mgmt.ts`:
    300 entities, AoI-r50 client synced **51 distinct (O(relevant))** vs full-interest client **300**; the far
    entity (`ent_200`, x=200) is provably **absent** from the AoI client's real delta stream (scanned, not
    counted) yet present in the full client's — a real filter, not a missing broadcast.

## Phase 4b — Governed Ecosystem  (gated on the isolation substrate)

- [x] **M6 — Isolation substrate (deferred P3 prerequisite, pulled here).** Untrusted skill/agent code
  runs OUTSIDE the privileged engine isolate (QuickJS / worker / separate V8 isolate — resolved by
  P4.0b on profiling + threat model). *Accept:* a malicious test skill that tries to reach engine
  internals/ops beyond its grant is **contained** (cannot touch the privileged isolate's globals/ops);
  every mutating call crosses the host/registry boundary; containment is audited. Real isolation, proven
  by a blocked escape — not a convention.
  - **✅ DELIVERED & verified (2026-06-23):** new crate `crates/limina-sandbox` (QuickJS via `rquickjs` 0.12);
    one Runtime+Context per untrusted agent, exposing ONLY `host.invoke(cap, argsJson)` (no `Deno`/ops/ECS
    arrays/`WorldContext`). Ops `op_sandbox_create/eval/destroy/count`. Re-entry = collect-then-drive: the
    untrusted `decide()` records mutating intents; the JS `SandboxedSkillHost` then drives each through the
    real `SkillRegistry.invoke` with **host-bound** `{agentId,sessionId,permissions}` (spoofed payload id
    ignored). Per-agent CPU (interrupt deadline) + memory (`set_memory_limit`) + stack budgets. Crossings
    emit `sandbox.capability.invoked/denied` + `sandbox.decision.contained` on the sha256 trace chain (M8
    trail). `SandboxedProvider` slots untrusted agents into the live perception→decision→action loop.
    `js/test/p4_isolation.ts`: 6 escapes contained (globals undefined, loop interrupted, OOM catchable,
    crash isolated — host alive each), ungranted cap denied+audited (zero side effect), cross-agent secret
    not leaked, legit granted path mutates world via the registry (x 0→2.40, host-attributed). Build/clippy/fmt clean, 27/27 headless.
- [x] **M7 — Dynamic policy engine.** Replace profile allow-lists with contextual permissions, quotas,
  revocation, and resource budgets, enforced at non-bypassable boundaries (host op + registry invoke +
  package load + session admission). *Accept:* a context-dependent decision is enforced at the boundary
  (quota exhausted → denied; capability revoked → denied) and **audited**; the only path to a mutating
  capability is the policy-checked boundary (a bypass attempt fails).
  - **✅ DELIVERED & verified (2026-06-23):** `js/src/policy/engine.ts` — `PolicyEngine` (deny-overrides,
    fail-closed: session.revoked → revoked cap → profile → quota → budget → allow); profiles subsumed as one
    policy input. Enforced at all 4 non-bypassable boundaries: `SkillRegistry.invoke` (mutating choke point),
    sandbox `host.invoke`, `AuthoritativeServer.initialize` (session admission), `admitPackageLoad` hook.
    Quota (sliding window; denied calls don't consume), revocation (checked first), budgets (per-session
    calls/cpuMs/memBytes; CPU/mem tied to the M6 sandbox knobs). `policy.decision`/`policy.denied` on the
    sha256 chain, allow linked into `skill.executed.causedBy`. `p4_policy.ts`: context-dependent allow/deny,
    quota N+1 denied, revocation denied, budget.calls/cpu denied, session-admission `-32001`, package
    over-claim/revoked denied — all audited; **bypass impossible** (only the policy-checked boundary mutates);
    falsifiable vs an always-allow stub. Pure TS (engine-core Rust unchanged).
- [x] **M8 — Audit surfaces.** Queryable audit for actions, denials, resource usage, package
  provenance, attestations. *Accept:* a reviewer queries "why was action X allowed/denied" and gets the
  policy decision + provenance + causal trace (leveraging the observability layer).
  - **✅ DELIVERED & verified (2026-06-23):** `js/src/policy/audit.ts` skills — `audit.explain{eventId}`
    returns the governing policy decision (rule + context) + provenance (agent/session/profile/package) +
    causal trace (causedBy/parentEventId ancestry); `audit.query` (denials by rule, package provenance,
    summary); `audit.usage` (per-session allowed/denied + quota/budget snapshots). `p4_audit.ts`: "why
    allowed/denied" answered purely from **real recorded events** (matching rule + context + real causal
    parents), unknown id rejected (no fabrication). Built on the existing sha256 trace chain + `replay()`.
- [x] **M9 — Packaging + versioned registries.** Distributable skill/scene/agent packages with manifests
  (declared capabilities, asset refs, compat bounds); package-level semver. *Accept:* a third-party
  package loads with a manifest, runs under M6 isolation + M7 policy, leaves an M8 audit trail; a package
  claiming a capability it isn't granted is contained; an out-of-compat-bounds version is rejected.
  - **✅ DELIVERED & verified (2026-06-23):** `js/src/packages/` — Zod `manifest` {name, semver `version`,
    kind, `declaredCapabilities`, `assetRefs`, `engineCompat` range, `entry`, optional `attestation`} +
    real `semver` (no new dep) + `PackageRegistry` (install + content-hash + resolve by `name@range`).
    Governed `load()` composes M6+M7+M8: (b) semver compat vs `ENGINE_VERSION=1.0.0` → out-of-bounds
    rejected; (c) M7 `admitPackageLoad` declared-vs-granted → over-claim denied at load; (d) untrusted
    entry loaded into the M6 sandbox; (e) M8 audit trail (`package.loaded` causedBy the admit decision).
    `package.load`/`package.list` skills. **4b capstone** `js/test/p4_packaging.ts`: `orbit-mover@1.2.0`
    loads isolated → moves x 0→1.60 via the governed registry (spoof ignored) → quota 4th-denied + revocation
    denied → audited; over-claim contained at load (`evil-spawner`) AND runtime (`sneaky-mover`, zero side
    effect); `future-skill@3.0.0` rejected (engine.incompat); both gates falsifiable. Pure TS.

## Phase 4x — Browser / wasm target  (independent track, pull on demand)

- [ ] **M10 — wasm/browser runtime.** Three.js WebGPU against the browser's native WebGPU (not
  `deno_webgpu`), sharing the JS skill/agent layer. *Accept:* the skill/agent layer runs in a
  browser/wasm target, renders a scene via native browser WebGPU, and executes a skill at parity with a
  defined subset of the native path.

## Hard-to-reverse decisions (lock at kickoff)

| Decision | Why hard to reverse |
|---|---|
| **World-log contract** — the exact replay-complete command/event set, RNG-seed handling, tick-boundary framing | Persisted logs + every replay/recovery depend on it; changing it invalidates stored worlds |
| **Snapshot format + cadence** | Recovery reads it; format migration is costly |
| **Netcode model** — authoritative server + client prediction/reconciliation vs lockstep; how fixed-step determinism maps to sync | The on-wire protocol; clients integrate against it |
| **Policy enforcement points + language** — host op / registry invoke / package load / session admission; declarative vs programmable hooks | Every capability crosses these; bypass = security hole |
| **Isolation mechanism** — QuickJS vs workers vs isolates (resolved at P4.0b) | The trust boundary all untrusted code runs in |
| **Package manifest + attestation model** | The ecosystem integrates against it |

## Sequencing & dependencies

**4a first** (M1→M2→M3→M4→M5): the world log is the keystone — snapshots, durable persistence,
networking, and replay all build on it, and none of 4a is blocked on isolation. **Then 4b**
(M6→M7→M8→M9): M6 is the Phase-3 isolation substrate pulled forward as the hard prerequisite for
governance (M7) and untrusted packaging (M9). **4x (M10)** is independent — pull only if a concrete
deployment need justifies the extra compatibility surface. Likely ship **4a as its own release**
(persistent shared worlds) before committing to 4b.

## Capstone acceptance demos

- **4a:** a **persistent shared world** — 1 human client + 1 external MCP agent in one authoritative
  world; a mutation syncs within target latency; **kill + restart recovers** from snapshot+delta within
  target; the session **replays bit-identical** from the persisted log.
- **4b:** a **governed third-party skill package** — loads with a manifest, runs **isolated** (M6),
  **policy-governed** (a real quota/revocation denial, M7), fully **audited** (M8); an escape / capability
  over-claim attempt is contained.
