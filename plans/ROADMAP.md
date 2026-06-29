# Limina Roadmap

> **Vision:** an agent-native, high-performance real-time 3D engine where LLM agents —
> external **Agent Builders** and in-world **Agent Players** — are first-class citizens,
> every action typed, permission-checked, and traced.
> **Source spec:** `README.md` · **Standing principle:** performance-first (see below).
>
> Plans live as hand-authored Markdown in `plans/` (the hosted Plan connector is not
> configured in this repo). Phase 2 is an **executable** plan; Phases 3–4 are
> **roadmap-level** — themes, pillars, bets, and dependencies, detailed at kickoff.

## Where we are

| Phase | Theme | Status |
|---|---|---|
| **0 — Foundation** | Native runtime + render + physics + ECS + loop | ✅ COMPLETE (`plans/limina-phase-0-foundation/plan.md`) |
| **1 — Agent-Native Core** | Skill registry, MCP, observability, agent ecosystem | ✅ COMPLETE (`plans/limina-phase-1-agent-core/plan.md`) |
| **2 — Open World** | Real external agents + interactive world + persistence | ✅ COMPLETE — built, reviewed, gaps fixed (`plans/limina-phase-2-open-world/plan.md`) |
| **3 — Single-Instance Scale & Fidelity** | Many agents + data ownership/job system + rich worlds + devtools | ✅ **COMPLETE** — review-gap fix pass (scheduler/budgets, spatial index, devtools, shadows+textures, perf 9.4→74fps) **+ native parallelism**: profile-first found the wall was an un-cached `registry.list()` (`z.toJSONSchema`/agent/tick) → memoized; then a native CSR spatial op (`limina-ecs`, rayon, bit-identical to the JS oracle, 4.5–5.4× / ≤2 ms) wired into perception (byte-identical); `MAX_ENTITIES`→16384; **density capstone: 200 agents + 256 dynamic bodies + 2000 entities @ sim-step p95 4 ms ≤ 8 ms**. 38/38 headless + spike + capstone. (Untrusted-code **isolation substrate** was delivered in Phase 4/M6 — QuickJS.) (`plans/limina-phase-3-scale-fidelity/plan.md`) |
| **4 — Shared Platform** | Persistent shared worlds + governance + ecosystem + browser/wasm target | ✅ **COMPLETE** (M1–M9 + spikes, verified) — durable shared worlds (replay determinism, snapshot recovery, authoritative multi-client sync p95 11ms, interest mgmt) + governed ecosystem (QuickJS isolation, dynamic policy engine, audit surfaces, versioned packages w/ manifest + attestation + content-hash provenance); 31/31 headless + capstone green. **4x/M10 browser-wasm optional/pull-on-demand** (`plans/limina-phase-4-platform/plan.md`) |
| **5 — Presentation & Audio** | On-screen text/UI rendering + spatial audio (multimodal output) | ✅ **COMPLETE & verified** — **P5-A (Text/UI):** expressive in-scene containers (text/speech/thought/callout/label + screen HUD), builder-styled, billboard/anchored/lifecycle, via permission-gated traced `ui.*` skills; embedded font → `DataTexture`. **P5-B (Audio):** `limina-audio` (rodio 0.22.2/cpal) — dedicated audio thread, 4-bus mixer (master/sfx/ambience/voice), spatial `SpatialPlayer` (camera-listener + 1/d²), 12 `audio.*` ops, permissioned/traced `audio.*` skills, Rust-side **fire-and-forget TTS** (espeak/Piper; never freezes the frame); backend explicit via `LIMINA_AUDIO=null` (device-free CI). **Capstone demos:** `forest_conversation.ts` — agents hold a real non-deterministic Ollama conversation in speech bubbles **and speak it aloud** over an ambient bed; `numbers_party.ts` — ambient bed + positional chatter as the flythrough camera sweeps the crowd (102 fps). 52 headless pass + capstone; clippy/fmt 0; procedural synthesis (no audio assets), voice via espeak-ng (`plans/limina-phase-5b-audio/plan.md`, `plans/limina-phase-5-presentation-audio/plan.md`) |
| **6 — Open the Door & De-risk** | Host-capability seams + web-export contract + worldgen S0 greenlight | ✅ **COMPLETE** (`plans/phase-6-open-the-door-plan.md`) — `installOps()` boundary, `RenderOps`/`PhysicsOps`/`TraceOps` seams, W0 snapshot-keyframe export contract, S0 InfiniteDiffusion greenlit (RTX 3050, exact determinism, 0.87 s/tile) |
| **7 — The Authoring Surface** | Human-in-the-loop approval gate + co-authoring editor + multi-turn | ✅ **COMPLETE** (`plans/phase-7-authoring-surface-plan.md`) — opt-in review gate in `registry.invoke()` (pending/grant/deny, causal chain intact, revocation-safe), `editor/` web app (reasoning tree + approval queue), 54/54 tests green |
| **8 — Run Anywhere** | Export-playback to browser/phone (snapshot-keyframe, one-command export) | ✅ **COMPLETE — first cut (Mode A)** (`plans/phase-8-run-anywhere-plan.md`) — export package `{manifest, log.jsonl, keyframes.jsonl}`, keyframe-driven `PhysicsOps` (bit-identical parity gate), browser host (canvas-WebGPU + IndexedDB + rAF accumulator), 57/57 tests green. **Mode B (live wasm-Rapier authoring) deferred.** |
| **9 — Worlds Worth Authoring** | `terrain.*`/`world.*` skill seam + native heightfield + model IPC | ✅ **COMPLETE — first cut** (`plans/phase-9-worlds-worth-authoring-plan.md`) — `op_physics_add_heightfield`, `ProceduralTerrainSource` (deterministic noise), 4 typed/permissioned skills, content-addressed tile cache, `ModelTerrainSource` (S1 IPC), browser playback from cached tiles, 61/61 tests green. **W2/W3 polish deferred.** |
| **10 — Agent Governance & Orchestration** | Scoped exposure + permission bundles + delegate/coordinator | ✅ **COMPLETE** (`plans/phase-10-governance-orchestration.md`, `plans/phase-10-implementation-plan.md`) — filtered `registry.list(grants?)`, `AgentRecord.bundle?`, `skills.search`, `delegate` skill + gate-driven review, 66/66 tests green |
| **11 — Content & Assets** | Render baseline + material palette + asset registry + scatter + water | ✅ **COMPLETE** (`plans/phase-11-content-assets.md`, `plans/phase-11-implementation-plan.md`) — default PBR lighting/IBL, 10 named materials, content-addressed `asset.place`/`asset.scatter` (elevation-aware), CC0 cottage-on-a-beach gate met, 74/74 tests green. **Generator-richness polish deferred.** |
| **12 — Game-Building Skill Catalog** | ~85 skills across 17 systems (player, camera, combat, quest, NPC, navmesh, VFX, save, progression…) | ✅ **COMPLETE** (`plans/phase-12-playable-game-skills.md`; **finished + made deterministic in waves A/B/C** — `plans/phase-12-finish.md`) — 15 modules (player/camera/animation/interaction/inventory/gamestate/triggers/quest/combat/behavior/navmesh/vfx/save/progression/worldstate), all WIRED + replay-deterministic + tested; progressive discovery (`skills.browse`/`skills.search`) + a bootstrap tool surface, 8 permission profiles. **Capstone — first cut done:** `playable_game_window.ts` + `p12_capstone.ts` (an agent authors *and* plays a tiny complete game — terrain → player → item pickup → trigger → win, deterministic); the full Part-F integrated demo (NPCs/combat/quest/save in one) is still open. |

**Shipped (0+1):** one native binary — Rust host → V8 (`deno_core`) → WebGPU (`deno_webgpu` + Three.js) → native Rapier physics → bitECS, on a fixed-timestep loop. A typed/permissioned/versioned skill registry with hooks, an **in-process** MCP `listTools`/`callTool` surface, EventLoom-shaped traces with a sha256 chain + JSONL export, and an agent ecosystem (perception → decision → action, LLM-agnostic: scripted / local Ollama / cloud gateway). Builder + player demos, all verified.

## Beyond MVP (post-0.1.0)

Phases 6–12 are **done** (host seams, authoring surface, browser export-playback, terrain generation, governance, assets, game-building catalog). **Also shipped since (polish + proof):** the default-render skill library (auto-surface terrain + biome scatter + post), the demo suite + materials showcase, a **rigged skinned-glTF player** (skeletal animation confirmed working on deno_webgpu), curvature-aware prop placement (no float/bury), and a public **`/examples` page whose flagship island runs LIVE in-browser** — a concrete proof of the Phase 8 export-playback path in a real browser tab. The remaining work:

| Phase / Item | Status | Plan |
|---|---|---|
| **13 — Ecosystem & Marketplace** | 🔲 Not started | Public registry + external memory adapters |
| **Phase 8 Mode B** (live wasm-Rapier browser authoring) | 🔲 Deferred | Sim-worker / SAB split (see `plans/phase-8-run-anywhere-plan.md`) |
| **Worldgen W2** (hydraulic + thermal erosion bake pass) | 🔲 Deferred | `plans/worldgen-roadmap.md` |
| **Worldgen W3** (agent-steerable coarse→fine generation) | 🔲 Deferred | `plans/worldgen-roadmap.md` |
| **Worldgen W5** (native wgpu model port) | 🔲 Deferred | `plans/worldgen-roadmap.md` |
| **Water rendering upgrade** (depth-buffer, proper surf transition) | 🔲 Deferred | `plans/worldgen-roadmap.md` |
| **Phase 12 capstone** (FULL integrated game: NPCs/combat/quest/save in one) | 🟡 First cut done (tiny game ships + passes `p12_capstone`); full Part-F open | `plans/phase-12-playable-game-skills.md` |
| **bmap pipeline** (real-world geo → limina world) | 🔲 Parked | `plans/bmap-pipeline-spike.md` |

The **immediate next sequence** — the Capstone Game → the On-Ramp → Live Authoring → *then* Phase 13 — is planned in [`plans/path-to-adoption.md`](./path-to-adoption.md). The full post-MVP sequencing, acceptance gates, and detail live in [`plans/post-mvp-roadmap.md`](./post-mvp-roadmap.md). The original MVP spec is preserved at [`docs/mvp-spec.md`](../docs/mvp-spec.md).

## The arc

```mermaid
flowchart LR
  P0["Phase 0\nFoundation\n(done)"] --> P1["Phase 1\nAgent-Native Core\n(done)"]
  P1 --> P2["Phase 2\nOpen World\nexternal agents · interactive physics · persistence\n(done)"]
  P2 --> P3["Phase 3\nSingle-instance excellence\nmany agents · rich worlds · devtools\n(done)"]
  P3 --> P4["Phase 4\nShared platform\npersistent worlds · governance · ecosystem\n(done)"]
  P1 --> P5["Phase 5\nPresentation & Audio\non-screen text/UI · spatial audio\n(independent · done)"]
  P4 --> P6["Phase 6\nOpen the Door\nhost seams · export contract · worldgen S0\n(done)"]
  P6 --> P7["Phase 7\nAuthoring Surface\napproval gate · co-authoring editor\n(done)"]
  P6 --> P8["Phase 8\nRun Anywhere\nbrowser export-playback\n(done — Mode A)"]
  P7 --> P8
  P8 --> P9["Phase 9\nWorlds Worth Authoring\nterrain skills · heightfield · model IPC\n(done — first cut)"]
  P7 --> P10["Phase 10\nGovernance & Orchestration\nscoped exposure · delegate/coordinator\n(done)"]
  P8 --> P11["Phase 11\nContent & Assets\nrender baseline · asset registry · scatter\n(done)"]
  P9 --> P11
  P10 --> P11
  P10 --> P12["Phase 12\nGame-Building Catalog\n~85 skills across 17 systems\n(done)"]
  P11 --> P12
  P10 --> P13["Phase 13\nEcosystem & Marketplace\npublic registry · external memory adapters\n(not started)"]
  P12 --> P13
```

## Why this order (dependency rationale)

- **2 before 3.** You cannot *scale* agents you cannot *connect*, nor scale a world that
  is not yet interactive. Phase 2 opens the external MCP surface and gives the world real
  physics (collisions/events), which is exactly what Phase 3 then multiplies, instruments, and
  renders at higher fidelity.
- **3 before 4.** A shared platform only pays off once one instance can host many Agent
  Builders and Agent Players in a rich world without losing frame budget, traceability, or
  capability boundaries. Phase 3 proves that per-instance ceiling; Phase 4 persists, shares,
  and governs it.
- **Each phase ends in demoable acceptance** and de-risks the next, mirroring the 0→1 cadence.
- **5 is independent.** Presentation & Audio (on-screen text/UI rendering + spatial audio) depend only on
  the Phase 0 render/runtime foundation, not on 2–4, so they can be pulled forward on demand.
- **6→12 followed the same discipline.** Phase 6 laid the host seams + de-risked export/worldgen; 7 built the authoring surface; 8 proved browser playback; 9 added terrain generation; 10 made multi-agent safe; 11 delivered the asset/content foundation; 12 stocked the game-building catalog. Each built on the prior, each closed with tests green and acceptance gates met.
- **Next is the path to adoption, not the marketplace yet.** Capability is done; the gap is an *audience* — and a marketplace presupposes one. The sequenced next path is **the Capstone Game (the proof) → the On-Ramp (the funnel) → Live Authoring (the visible experience) → *then* Phase 13 (marketplace)**, detailed in [`plans/path-to-adoption.md`](./path-to-adoption.md). Each makes agent authoring more real, reachable, or visible — the North Star's lead — before opening it to third parties.

## Maps onto the spec's deferrals

`README.md` explicitly deferred: persistent observability (→ **P2** durable traces),
multi-turn orchestration (→ **P2** / refined in **P7**), dynamic policy engine vs profiles (→ **P4** governance, refined **P10**),
and browser fallback (→ **P4** wasm/browser target, delivered **P8**). Phase 1's recorded backlog is distributed
by risk: MCP network transport, multi-turn, collision events, physics richness, and spatial
index land in **P2**; agent scale, isolation substrate, ECS ownership/job-system decisions,
textured glTF, and richer devtools land in **P3**; replay-complete durable world state,
Zaxy/EventLoom structural integration, shared worlds, third-party packaging, and governance
land in **P4**. The authoring surface, multi-turn, and browser export were **P6–P8**; terrain
generation **P9**; governance/orchestration **P10**; assets **P11**; the game-building catalog **P12**.
The remaining deferred items (worldgen erosion polish, live browser authoring, the integrated
capstone demo, and the bmap geo pipeline) are tracked in *Beyond MVP* above.

## Standing principle: performance-first (load-bearing)

Every architectural choice is aimed at making limina **blazingly fast**. When quality or
power competes with speed, surface the tradeoff, weigh it, decide deliberately, and record
the rationale. Concretely: native hot paths (ECS iteration, physics, spatial queries) over
JS; data-oriented SoA/TypedArray storage; zero-copy buffer bridging over serialization; JS
is the scripting/agent/authoring layer, not the inner loop. Agent *thinking* always runs
off the frame loop — a slow model never drops a frame.

## Standing principle: the engine is the substrate, not the brain or the memory

Limina owns the **world** (ECS, physics, render), **perception**, the **skill/MCP surface**, and a
**durable world event log** (logging). It does NOT own the agent's *brain* or its *memory*. The
decision provider is already pluggable (`LLMProvider`: Scripted/Ollama/Gateway), and **recall is part
of the brain** — fed by perception + read access to the durable log, with any memory backend (Zaxy,
a vector DB, or none) living as an **external adapter behind the provider**, never an engine runtime
dependency. External Agent Builders bring their own memory over MCP. So: **engine = world +
perception + durable log (substrate); brain = decision + recall (pluggable); memory backend =
external.** Persisting the world well (logging) serves any memory-builder without the engine owning memory.
