# Limina — Phase 3 Plan: Single-Instance Scale & Fidelity

> **Status:** ◻ Roadmap-level — themes/pillars/bets only; to be detailed (M-by-M, research +
> review) at kickoff, after Phase 2 ships.
> **Parent roadmap:** `plans/ROADMAP.md` · **Builds on:** Phase 2 (Open World)
> **Principle:** performance-first — prove one rich, high-density agent world before platformizing it.

Phase 2 opens Limina to real external Agent Builders, interactive Agent Players, and durable
trace/replay. Phase 3 makes a single instance excellent: many agents can build and inhabit one
world, the world looks like something worth inhabiting, and the authoring/inspection loop is good
enough to debug agent-built scenes without guessing. This is where Limina earns its claim as a
high-performance native runtime that underpins Three.js/WebGPU for agentic spatial systems.

## Pillars

### P3-A — Agent runtime scale & isolation

Scale the three agent surfaces separately instead of treating "sandboxing" as one problem:

- **External MCP agent sessions** — many Agent Builders connected over Phase 2 transports, each
  bound to a session/profile, budgeted for tool-call rate, wall time, and queued world mutations.
- **In-world Agent Players** — many data-only player records running perception -> decision ->
  action loops off the frame path, with fair scheduling and backpressure when action queues fill.
- **Untrusted code/skill isolation** — arbitrary third-party JS/skill code must not run in the
  privileged engine isolate. QuickJS, additional V8 isolates, workers, or another sandbox are a
  kickoff decision driven by profiling and trust-boundary requirements, not a preselected answer.

### P3-B — Data ownership & job system

Move hot paths off the main thread only after the ECS ownership contract is explicit:

- Decide whether Phase 3 keeps **JS-owned TypedArray components**, moves to **native-owned
  component slabs exposed to JS**, or uses **message-passed worker jobs** for parallel work.
- Add a job system for the chosen ownership model covering ECS queries, spatial lookups, and
  physics-adjacent batch work while keeping render/WebGPU presentation on the main thread.
- Add determinism guards for fixed-step simulation: parallelism is an optimization, not permission
  to change replayable behavior.

### P3-C — Visual fidelity for agent-built worlds

Make Agent Builder output inspectable and compelling, not just technically present:

- **Textured glTF** end-to-end, including the deferred ImageBitmap/DOM shims required for
  `GLTFLoader` materials/textures in headless and windowed runtime paths.
- **Lighting and materials**: shadows, environment/IBL lighting, fuller PBR material support,
  tone mapping, antialiasing, and restrained post-processing.
- **Fidelity acceptance scenes** that are constructed through skills/MCP, not only handwritten demo
  code, so the builder surface proves it can create rich worlds.

### P3-D — Authoring & devtools

Turn observability into a usable world-building surface:

- A rich inspector for entities, agents, skills, permissions, world state, and trace causality.
- Hot-reload for skills/scenes with clear invalidation rules and trace visibility for reload events.
- CLI plus devtool client surfaces that can tail traces, inspect live world state, and explain why
  an agent action was allowed, denied, delayed, or dropped.

## Key bets (resolve at kickoff)

- **Agent isolation model** — separate data-only Agent Players from arbitrary untrusted code; choose
  QuickJS, V8 isolates, workers, or another sandbox only after profiling and threat-model review.
- **ECS ownership model** — JS-owned arrays vs native-owned slabs vs message-passed jobs; this
  decision gates every native parallelism milestone.
- **Scheduler model** — fair queues and budgets for MCP sessions, player decisions, and world
  mutations without blocking fixed-step simulation.
- **Render-vs-sim threading** — render/WebGPU presentation remains main-thread; sim, perception,
  spatial queries, and non-render authoring work are the parallelism candidates.

## De-risking spikes (lead with these at kickoff)

- Run many external MCP sessions and many in-world Agent Players at once, measuring frame time,
  decision latency, queue pressure, and permission denials separately.
- Compare parallel ECS/spatial-query strategies against the single-threaded baseline before adopting
  a job-system model.
- Load textured glTF through the actual skill/MCP path and render it in both headless validation and
  the native windowed path.

## Dependencies & sequencing

Phase 3 needs Phase 2's transport, multi-turn loop, collision-rich world, spatial index, and durable
trace sink. Start with measurement and ownership decisions, then agent scheduling/isolation, then
job-system work. Visual fidelity can run in parallel, but its acceptance must use the same builder
skill surface agents use. Devtools should land early enough to observe the scale work rather than
arrive after the hard bugs.

## Acceptance (sketch — firmed at kickoff)

At kickoff, set numeric targets and hardware/profile assumptions for:

- **Agent density:** target counts for concurrent MCP builder sessions and in-world Agent Players,
  with p95 frame time, p95 decision latency, and queue saturation thresholds.
- **Runtime fidelity:** a skill-built scene with textured glTF, lighting, shadows, PBR materials,
  and post-processing at the target frame budget.
- **Determinism:** fixed-step replay remains stable within an explicit divergence tolerance after
  parallel systems are enabled.
- **Devtools:** a reviewer can inspect a live scene, trace an agent action from perception to world
  mutation, and hot-reload a skill or scene without restarting the instance.

## Scope guards

Still a **single instance / single machine**. Networked shared worlds, multi-tenant governance,
third-party package distribution, and browser/wasm deployment are Phase 4. Phase 3 may build the
isolation substrate for untrusted code, but it does not launch an ecosystem or marketplace.

## Executable fix pass — numeric acceptance (T1, 2026-06-23)

> **Status: ✅ COMPLETE & verified (2026-06-23)** — T1 (this spec, Main) · T2 dead abstractions DELETED (`facade.ts` exports only `TransformStorage`+`createTransformStorage`, both referenced; `p3_ecs_facade_jobs.ts` removed; JS-owned-SoA ownership recorded) · T3 showcase **9.4→74.6 fps / 59.8 steps-s** (root cause: a per-decision `op_sleep_ms(100)` watchdog parked the host loop — replaced with a synchronous deadline sweep, same semantics; sim work p95 **4 ms**; `p3_perf_budget` bench; no density/work reduction; windowed p95 is 74.91 Hz-vsync-bound, documented) · T4 **real shadow maps + ACES tone mapping + working textured glTF** (fixed a deno_webgpu `copyExternalImageToTexture` gap by re-homing textures to `writeTexture`; `p3_fidelity_readback`: shadow 68% darker, glTF texel red) · T5 **real hot-reload** (`dev.reload` → `registry.reloadSkill`/`reloadScene` live swap; `hot_reload.ts` A→B, falsifiability-proven). Gate: `cargo build` + `clippy --workspace --all-targets` clean; 26 headless + 5 windowed tests + WS e2e green; determinism intact. *(Broader Phase 3 pillars beyond these review-gap fixes — untrusted-code isolation substrate, native/threaded parallelism, full post-processing/IBL — remain future scope.)*

> Converts the review gaps into a falsifiable, anti-reward-hack fix pass. **Hardware baseline:**
> i7-12700H + RTX 3050, Wayland/Vulkan. **Locked density:** the existing `js/src/demos/phase3_showcase.ts`
> at its current scale — **12 in-world players + 3 bound MCP builder sessions + ≥28 entities**. Density,
> per-agent work, and tracing MUST NOT be reduced to meet any target.

### T2 — ECS ownership decided; no dead abstractions
- **Decision (record in code/comment):** Phase 3 keeps **JS-owned TypedArray components**; native slabs / message-passed workers stay deferred unless T3 profiling proves them necessary.
- `runChunkedEcsJob` and `EcsMutationQueue` are each either **wired into the real engine loop** (a non-test caller demonstrably uses them) **or deleted** with their tests. No tested-but-unreferenced abstractions survive.
- **Accept:** every surviving `facade.ts` export is referenced by non-test engine code (grep-provable); removed ones build + test clean.

### T3 — Showcase hits frame budget (profile first)
- Produce a **per-frame cost breakdown** (render / physics step / perception / decision / action / tracing / showcase bookkeeping) at the locked density.
- **Target:** `phase3_showcase` sustains **≥ 60 fps (p95 frame ≤ 16.7 ms, mean ≤ 14 ms)** over ≥ 300 frames at the locked density, with the **fixed-step sim running at 60 steps/s (no step starvation)**.
- **Determinism preserved:** `p0_5_physics` + `billiards_physics` + any replay test stay bit-identical.
- **ANTI-HACK (hard):** the speedup MUST come from making the *same* work faster (algorithmic or parallel). FORBIDDEN: fewer agents/entities/builders, skipped ticks/frames, disabled or sampled tracing/perception/decisions, raised decision intervals, or any density reduction. Every due agent still perceives→decides→acts; every action still traced.
- **Accept:** a committed perf bench prints fps + p95 + the breakdown at the locked density and asserts ≥ 60 fps.

### T4 — Real visual fidelity (built through skills/MCP)
- A scene **constructed via skills** (`scene.createEntity`, `three.setLighting`, `three.loadGLTF`) renders with: a directional light casting **real shadow maps** (a floor visibly receives a cast shadow), **tone mapping** (e.g. ACESFilmic) + **antialiasing**, and a **textured glTF whose texture is visibly sampled**.
- **Accept (falsifiable, headless pixel readback):** (a) a pixel inside the cast-shadow region is materially darker (e.g. ≥ 25%) than a lit pixel of the same surface; (b) a pixel on the textured glTF surface matches the texture's color, not flat black/dark. Plus a windowed screenshot showing shadows + textures. Renderer `shadowMap`/`toneMapping`/`antialias` configured in `engine.ts`.
- **ANTI-HACK:** shadows from real shadow mapping (not a painted gradient/decal); texture color from real UV sampling (not vertex colors or a flat material faking it).

### T5 — Real hot-reload
- `dev.reload` performs an **actual live reload**: a skill definition can be replaced at runtime (registry unregister + re-register) so a later `callTool` runs the **new** behavior; scene reload re-runs its builder. Reload stays traced with clear invalidation. A target that genuinely cannot reload returns an **honest failure**, never a silent no-op.
- **Accept (falsifiable):** a test registers skill X (behavior A), invokes it (gets A), `dev.reload`s X to behavior B, invokes it again (gets **B**) — no process restart, reload event traced. The test FAILS if the second call still returns A.
- **ANTI-HACK:** a real registry swap that changes observable behavior — not re-emitting a "reload requested" event while behavior is unchanged.

### Sequencing
T2+T3 (one perf/ownership workstream — profiling gates the ownership decision), T4 (fidelity), and T5 (hot-reload) run in parallel against the criteria above. Main authored these criteria, reviews each deliverable for accuracy + code quality, and runs the union gate (build + `clippy --workspace` + full headless suite + WS e2e + the perf bench + the fidelity readback + the hot-reload test) before sign-off.

---

## Native Parallelism — executable spec (P3-B cash-in)

> **Status:** ✅ **COMPLETE & verified (2026-06-24)** — all milestones done. Decision-path cache + native CSR spatial op (`limina-ecs`, bit-identical to the JS oracle, 4.5–5.4× / ≤2 ms) integrated into perception (byte-identical), `MAX_ENTITIES`→16384, and the **density capstone PASSES: sim-step p95 4 ms ≤ 8 ms at 200 agents / 256 dynamic bodies / 2000 entities**. `cargo build`/`clippy`/`fmt` clean; **38/38 headless** (incl. `p3n3_capacity`) + `p3n_s_spike` + `p3n4_capstone` (release). JS spatial index kept as the determinism oracle; agent-state SoA + a general job system stayed (correctly) out of scope — profiling showed they weren't the wall.
> **Parent:** this Phase 3 plan (pillar **P3-B — Data ownership & job system**); builds on the T1–T5 fix pass above.
> **Hardware baseline (locked):** i7-12700H (14C / 20T) + RTX 3050, Wayland/Vulkan.
> **Principle:** performance-first — parallelism is an optimization, **never** a license to change replayable behavior.

### Outcome

Raise the per-instance **simulation** density ceiling **far past** the current locked density (12 in-world players + 3 MCP sessions + ~28 entities) by moving the single-threaded JS **sim** hot paths — the spatial index (build + radius queries) and the per-tick physics→ECS transform sync — into **native, rayon-parallel Rust ops that borrow the existing zero-copy SoA `Float32Array`s in place**, while **JS keeps ECS ownership, the agent scheduler, and the authoring layer**, and **fixed-step replay stays bit-identical**. Success is measured as **sim-step cost** (`frameStepMs` p95), NOT wall-clock fps: the render path (`renderSyncSystem` O(N) main-thread Object3D setters + non-instanced draw) is a **separate, acknowledged ceiling** that native sim ops never touch (instancing/dirty-tracking out of scope here).

### Where the time goes (grounded — from the architecture scout pass)

- **Spatial index is the likely sim wall — confirm by profiling (P3N-0), don't assume.** `UniformGridSpatialIndex` (`js/src/spatial/index.ts`) is pure JS: a `Map<string,IndexedEntity[]>` with **string** cell keys, forced into a **full O(N) rebuild every tick** (demos call `engine.spatial.invalidate()` each tick), then a per-due-agent radius query + per-result materialize + distance sort — degrading toward **O(A×N)** brute force for large radii. _Caveat:_ at the **current** density T3 measured sim `frameStepMs` p95 ≈ **4 ms** (spatial within budget today); "spatial dominates at high density" is big-O extrapolation until **P3N-0** measures it.
- **Per-tick JS churn:** `AgentRegistry.all()` allocates a fresh array on every call (3×/tick across perception/decision/action) and two **O(A log A)** sorts run every tick (`agents.all().sort`, `admitDecisions ordered()`).
- **Physics readback is N op-calls/tick:** `syncPhysicsBodyTransform` calls `op_physics_body_transform(id, scratch)` **once per body** (`js/src/ecs/world.ts`).
- **Already native:** physics (Rapier `PhysicsWorld` in `OpState`, `op_physics_step`). **Already zero-copy-ready:** `Position/Rotation/Scale` are per-axis `Float32Array(4096)` SoA indexed by `eid` — exactly what an `#[op2(fast)] #[buffer] &mut [f32]` op borrows in place (proven by `op_buffer_scale` / `op_physics_body_transform`).
- **NOT parallelizable as-is:** agent state is AoS `Map<string,AgentRecord>` (strings + nested objects). bitECS membership/iteration arrays are plain JS `number[]` (not TypedArrays) — only the **numeric component data** is zero-copy.
- **Nothing parallel exists yet:** no `rayon`, no `std::thread`, no workers; `tokio` is `new_current_thread`; the V8 isolate + winit pump + present are one thread (`crates/limina-runtime/src/windowed.rs`). `MAX_ENTITIES = 4096`.

### The central decision — LOCK at kickoff

**Native rayon-parallel hot-path ops over zero-copy, JS-owned SoA buffers; JS keeps ECS ownership + the scheduler.**

- **Why:** cashes the "zero-copy path to native later" bet directly; targets the bottleneck **P3N-0 confirms** (expected: spatial/perception + physics readback); **least hard-to-reverse** (no ECS-ownership reversal, no isolate sharding); determinism is straightforward (pure native functions over buffers with stable ordering); the AoS string-keyed scheduler is **not** the numeric hot path and decisions already run off-loop.
- **Alternatives — DEFERRED unless the spike/profiling proves this insufficient:**
  - **(B) native-owned ECS component slabs + native job system** — reverses the T2 JS-ownership decision; re-plumbs bitECS membership + the authoring surface; large, hard to reverse.
  - **(C) multi-isolate / `deno_core` worker sharding + `SharedArrayBuffer`** — V8 is single-threaded per isolate, so shard agents across isolates; message-passing + cross-isolate determinism cost.
- **Threading model:** introduce `rayon` (absent today) for data-parallel native ops. **Render/WebGPU + the V8 isolate stay main-thread** (thread-affinity); native ops are **synchronous** calls from the fixed-step callback, parallel **internally**. JS owns the `Float32Array`s; native ops only borrow them for the call.

### De-risking spike (run after P3N-0 confirms the target) — go / no-go

**P3N-S.** A native rayon-parallel spatial op: build a uniform grid + answer K radius queries, **borrowing `Position.{x,y,z}` zero-copy**, returning hits into a JS-supplied buffer — measured **end-to-end through the perception system it feeds** (native grid + the JS materialize/decide it hands off to), **not** the grid op in isolation. Prove all three or STOP:
1. **Bit-identical** to the JS `UniformGridSpatialIndex` — same hit set, same order: distance, then **record insertion `order`** matching the oracle's stable sort (`compareDistanceThenEntity` is distance-only; ties fall to insertion order, **NOT** eid — see `js/src/spatial/index.ts`). Building to "eid tiebreak" would diverge on the many equidistant ties in the symmetric demos and break replay.
2. **End-to-end perception cost drops below the sim-step budget at target scale** — native grid + the JS perception it feeds is materially faster than the all-JS path at ≥ 2000 entities / ≥ 200 querying agents (the bench prints both, broken down).
3. **Deterministic** across runs and **independent of thread count** (see Determinism guards — f64 math, parallelize across queries).

If it cannot beat the JS path, cannot be made deterministic, **OR the wall turns out to be JS per-agent perception/decision over the AoS map rather than the grid**, **stop and revisit (B)/(C) or expand scope** before building further. (This is the real load-bearing unknown: a fast grid that doesn't move end-to-end density is a no-go.)

### Milestones (numeric · falsifiable · anti-hack)

- [ ] **P3N-0 — Profile first (evidence, not big-O).** Scale the **existing** JS `phase3_showcase` up (its bench already prints the per-system breakdown: render / physics / perception / decision / action / tracing) until it **breaks the sim-step budget**, and confirm the **spatial build/query + physics readback actually dominate** the sim step at that scale. *Gate:* if something else dominates first (JS perception materialize, scheduler sorts, GC), **re-target this pass** before building any native op. (Mirrors the T3 "profile first" precedent.)
- [ ] **P3N-S — Spike** (above): go/no-go on the ownership-preserving native-parallel approach.
- [ ] **P3N-1 — Native parallel spatial index.** Grid build + radius/nearest queries become a rayon-parallel native op over the zero-copy SoA; the JS `UniformGridSpatialIndex` is **retained as the bit-identical oracle** for tests. *Accept:* native query hits + order **bit-identical** to the JS oracle on fixed scenes; at the locked density (200 agents / ~2000 entities) the committed micro-bench prints native vs the **real current** JS grid (no deliberately-slowed baseline) and asserts native build+query p95 **≥ 4× faster AND ≤ 2 ms absolute**.
- [ ] **P3N-2 — Batched physics→ECS sync.** One native op writes **all** active bodies' pos+quat straight into the `Position/Rotation` SoA in a single call (rayon-parallel), replacing the N per-body `op_physics_body_transform` calls. *Accept:* identical transforms vs the per-body path (bit-identical); fewer op crossings; `p0_5_physics` + `billiards_physics` stay bit-identical.
- [ ] **P3N-3 — Scheduler hygiene + capacity.** Remove the per-tick `agents.all()` allocations + redundant sorts (cache a stable agent list, invalidate on add/remove); raise `MAX_ENTITIES` (e.g. 4096→16384) across **every coupled structure** — the `Position/Rotation/Scale` SoA arrays, the bitECS world capacity, the sparse `renderables` array, and any native op assuming a 4096-length borrowed buffer. *Accept:* zero per-tick agent-array allocations on the steady-state path (verified); a correctness test that **spawns past 4096** (transforms/queries/render-sync correct at `eid > 4096`), not merely an array-length assert; same decisions/actions/ordering as before (deterministic); no scheduler behavior change beyond perf. **(Agent-state SoA is explicitly NOT in scope — deferred.)**
- [ ] **P3N-4 — Density acceptance capstone.** A scene **built through skills/MCP** (not hand-wired) at the locked density — **200 agents** each fully perceiving→deciding→acting (every action traced), **256 dynamic physics bodies**, **~2000 total entities** in the grid, **5 bound MCP builder sessions** (counted separately so the target can't be padded with inert scenery). *Accept (SIM cost, NOT wall-clock):* **sim-step p95 (`frameStepMs`) ≤ 8 ms over ≥ 300 ticks** with the **fixed-step at 60 steps/s and no step starvation**, plus the committed per-system breakdown (render / physics / perception / decision / action / tracing). Wall-clock fps is reported as **documented-vsync context only** (per T3: sim p95 ≈ 4 ms vs the ~75 Hz vsync wall) — **not** the pass/fail bar, because `renderSyncSystem` (O(N) main-thread setters) + ~2000 non-instanced draw calls dominate wall-clock and are the **known next ceiling** (mesh instancing / dirty-tracking out of scope here, but named).

### Determinism guards (hard)

- Native parallel ops MUST be deterministic: **stable result ordering** — distance, then **record insertion `order`** matching the JS oracle's stable sort (**not** eid); **distance math in f64** (cast the borrowed `f32`→f64, accumulate in f64, **correctly-rounded `sqrt`**, matching JS operation order — the radius cutoff `distance > maxDistance` changes the **hit set**, not just order, so f32 math would diverge); **parallelize ACROSS independent queries** (each agent writes a disjoint output slice), **never reduce within a query across threads**; grid build is sequential or its buckets are **post-sorted by `order`** (no parallel-insertion arrival order). No thread-count-dependent behavior on the replayable path.
- These tests stay **BIT-IDENTICAL**: `p0_5_physics`, `billiards_physics`, `p5_conversation`, `p4_worldlog_replay`, `p4_snapshot_recovery`, `p4_worldlog_durable`. A determinism diff is a **bug**, not a tolerance.

### Anti-hack (hard)

The density win MUST come from making the **same** work faster (native + parallel). **FORBIDDEN:** fewer agents / dynamic-bodies / entities / builders; **padding the entity count with inert scenery** (A agents / D dynamic bodies / E entities are pinned separately — see P3N-4); skipped or sampled perception/decisions/ticks; raised decision intervals; disabled/sampled tracing; lowered fidelity; or a **deliberately-slowed JS baseline** to flatter the speedup. Every due agent still perceives→decides→acts; every action still flows through the one skill/permission/replay path and is traced.

### Scope guards / non-goals

- **Single instance / single machine.** Shared worlds, governance, packaging = Phase 4 (done).
- **NO ECS-ownership reversal** (JS owns the SoA; native ops only **borrow**). **NO** native-owned slabs, **NO** worker/isolate sharding (both deferred to a follow-on only if this approach's ceiling proves insufficient).
- **NO agent-state SoA redesign** in this pass (the AoS scheduler stays JS; hygiene only).
- **Render/WebGPU presentation stays main-thread.** LLM decisions stay off the fixed-step path. Not building a general job-system API beyond what these hot paths need.

### Locked decisions (signed off 2026-06-24)

1. **Density target — LOCKED:** **200 in-world agents + 5 MCP sessions + 256 dynamic physics bodies + ~2000 total entities**, sim-step p95 **≤ 8 ms** (≈ half the 16.7 ms tick, render headroom), `MAX_ENTITIES` 4096→**16384**. Pins A/D/E + the P3N-1 (≥ 4× / ≤ 2 ms) and P3N-4 (≤ 8 ms) bars.
2. **Native code location — LOCKED:** a new **`limina-ecs`** native crate (grid + parallel transform ops + `rayon`), beside `limina-physics`.
3. **JS spatial index — LOCKED:** **kept** as the bit-identical determinism **oracle** (off the hot path).
4. **Scheduler scope — LOCKED:** **hygiene only** (cache list + drop redundant sorts); agent-state SoA deferred to a follow-on unless P3N-4 shows it's the new wall.

### Sequencing

**P3N-0 profile-first (re-target gate)** → **P3N-S spike (go/no-go, end-to-end)** → **P3N-1 native spatial** (the big win) → **P3N-2 batched physics sync** + **P3N-3 scheduler hygiene** (parallel) → **P3N-4 density capstone + union gate**. Main authors the criteria, reviews each deliverable for accuracy + code quality, and runs the union gate (build + `clippy --workspace` + full headless suite + the determinism oracle + the density bench) before sign-off.

---

## P3N-0 results & RE-TARGET (2026-06-24) — profile-first overturned the premise

> **Profiler:** `js/test/p3n0_profile.ts` — headless sim-step profiler at the locked density (200 agents / 256 dynamic bodies / 2000 entities), per-phase timed (`performance.now()`), decisions modeled OFF-loop (deferred provider + `void actionSystem` + untimed post-tick drain). Verified: `clippy` 0 / `fmt` 0 / **37/37 headless** after each change.

**The plan's central premise was wrong; profile-first caught it before any native code.** At the locked density the sim-step measured **p95 46 ms** (6× over the 8 ms budget), but the dominant cost was **NOT** spatial — it was `decisionSystem` calling `registry.list()` **once per admitted agent per tick** (`js/src/agents/systems.ts:87`), and `registry.list()` ran `z.toJSONSchema()` for all 38 skills on every call (**3.29 ms/call**, identical output). Physics **readback** was negligible (0.10 ms / 0.3%), so **P3N-2 was pointless**.

**Done (signed off + verified):** `SkillRegistry.list()` is now **memoized** (`js/src/skills/registry.ts`), invalidated on `register`/`unregister`/`replace`. Pure JS, deterministic, also speeds MCP `listTools`. Result: decision **20.0 → 0.48 ms** (56% → 3.5%), **sim-step p95 46 → 20 ms** (a ~26 ms cut from one cache). `clippy`/`fmt` clean, **37/37 headless** (incl. `hot_reload`/`m3_skills`/`mcp_stdio` — cache invalidation correct).

**New profile (post-cache), the true wall:**

| phase | mean | p95 | share |
|---|---|---|---|
| **`op_physics_step`** (native Rapier) | 8.19 ms | 11 ms | **59%** |
| perception (JS spatial: rebuild + radius queries) | 5.08 ms | 9 ms | 37% |
| decision (cached) | 0.48 ms | 1 ms | 3.5% |
| physics readback (sync) · action · spatial.invalidate | <0.12 ms each | — | <1% |

**Revised milestones (supersedes P3N-1..4 above):**
- [x] **Decision-path cache** — `registry.list()` memoized. **Sim-step p95 46 → 20 ms.** DONE & verified.
- [x] **P3N-S — spike GO** (`crates/limina-ecs` + `js/test/p3n_s_spike.ts`). `op_ecs_spatial_query_batch` is **bit-identical** to the JS oracle (200 queries / 6583 hits incl. a 4-way distance-0 tie → insertion-order tiebreak matched), **deterministic** (byte-identical across runs), and **RELEASE 2.60× faster** (native 2.41 ms vs JS 6.28 ms build+query; debug ~1.3× — debug Rust vs V8 JIT). clippy 0 / 37/37 headless. Naive op still rebuilds + allocates each call → P3N-1′ optimizes (flat grid / parallel build / reused scratch) toward ≥ 4× / ≤ 2 ms.
- [x] **P3N-1′ — Native parallel spatial index DONE & verified.** Op optimized to a **CSR (counting-sort) grid** (densify cells → one contiguous order-ascending array; no per-bucket allocation): native **~0.9 ms vs JS ~4.4 ms = 4.5–5.4× faster** (≥4× ✓) at **≤2 ms** ✓ (release, `js/test/p3n_s_spike.ts`), still **bit-identical** + deterministic. **Integrated into the live perception path**: `perceptionSystem` (js/src/agents/systems.ts) now serves all due agents' spatial queries via ONE `op_ecs_spatial_query_batch` per tick, reconstructing **byte-identical `Perception.nearby`** (eid→entityId reverse map, f64 distance recompute, `world.spatial.cellSize`; JS fallback for position-less agents / no-index worlds). **JS `UniformGridSpatialIndex` kept as the determinism oracle + the path for non-perception queries.** Verified: **37/37 headless byte-identical** (m7_agents / p3_spatial_index / agent_multiturn / p5_conversation assert perception order), clippy 0 / fmt 0. **p3n0 re-profile: perception 5 → 2.49 ms** (the remaining cost is the shared JS `nearby` reconstruction + `recentEvents` scan the native op doesn't touch); sim-step p95 **20 → 6 ms**.
- [ ] **P3N-Δ — `op_physics_step` is NOT a parallelize-our-JS target (note, not a milestone).** Diagnosis (impulse zeroed → no clustering): physics-step is **~3 ms baseline** for 256 sparse bodies; the ~8 ms in the table above was the profiler's impulse-toward-nearest **piling all 256 together** (harness artifact). Scene-design note for P3N-4: a realistic capstone must not cluster every dynamic body. If a genuinely contact-heavy scene is wanted later, the only lever is the `rapier3d` **`parallel` rayon Cargo feature** (not our code) — considered only if P3N-4 misses budget.
- [x] **P3N-3 — `MAX_ENTITIES` 4096 → 16384** DONE. All coupled structures move via the constant (SoA arrays + the `eid>=MAX_ENTITIES` guards in scene/humanoid); `js/test/p3n3_capacity.ts` spawns 5000 entities and verifies transform/query/render-sync correct at eid > 4096 (bitECS world + `renderables` grow; native op reads the passed array length). 38/38 headless.
- [x] **P3N-4 — Density capstone DONE & PASSES** (`js/test/p3n4_capstone.ts`, release). Skill-built scene at the locked density (**200 agents** each perceiving→deciding→acting through the registry/native batch, **256 dynamic bodies**, **2000 entities**); agents move kinematically via `three.setTransform` toward dispersed waypoints (realistic, non-clustering). **Accept met: sim-step p95 5 ms ≤ 8 ms over 340 ticks** (perception 2.54 ms native / decision 0.29 / action 0.026 / physics 0.10). **Integrity:** agents use `builder.readWrite` (grants `scene.write`) so `three.setTransform` actually EXECUTES — the test asserts **200/200 agents physically moved** from spawn (an earlier `player.limited` profile silently DENIED the moves; caught + fixed). Wall-clock/render is a separate ceiling per P3N-Δ.
- **~~P3N-2 batched physics readback~~ — DROPPED** (0.10 ms / 0.3%; the original assumption was wrong).
