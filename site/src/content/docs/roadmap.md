---
title: "Roadmap & status"
description: "Where Limina is: six phases shipped, the standing principles, and the numbers."
---

Limina is an agent-native, high-performance real-time 3D engine where LLM agents — external [Agent Builders](/building-agents/builders) and in-world [Agent Players](/building-agents/players) — are first-class citizens, every action typed, permission-checked, and traced. Phases 0 through 5 are **complete and verified**.

## Where we are

| Phase | Theme | Status — what shipped |
|---|---|---|
| **0 — Foundation** | Native runtime + render + physics + ECS + loop | ✅ The native floor: one binary, Rust host → V8 (`deno_core`) → WebGPU (`deno_webgpu` + Three.js) → native Rapier physics → bitECS, on a fixed-timestep loop. |
| **1 — Agent-Native Core** | Skill registry, MCP, observability, agent ecosystem | ✅ The four pillars: a typed/permissioned/versioned [skill registry](/pillars/skill-registry) with hooks, an in-process [MCP](/pillars/mcp-interface) `listTools`/`callTool` surface, EventLoom-shaped traces with a sha256 chain + JSONL export, and the [agent ecosystem](/pillars/agent-ecosystem) (perception → decision → action, LLM-agnostic). |
| **2 — Open World** | Real external agents + interactive world + persistence | ✅ Real external agents over network MCP, interactive physics (collisions/events), and durable persistence. |
| **3 — Scale & Fidelity** | Many agents + data ownership/job system + rich worlds + devtools | ✅ Scheduler/budgets, a spatial index, devtools, shadows + textures, and a perf pass (9.4 → 74 fps), capped by **native parallelism**: a native CSR spatial op wired into perception. |
| **4 — Shared Platform** | Persistent shared worlds + governance + ecosystem + browser/wasm | ✅ Durable shared worlds (replay determinism, snapshot recovery, authoritative multi-client sync, interest management) + a governed ecosystem (QuickJS isolation, the dynamic policy engine, audit surfaces, versioned packages with manifest + attestation + content-hash provenance). |
| **5 — Presentation & Audio** | On-screen text/UI + spatial audio (multimodal output) | ✅ Expressive in-scene UI containers (speech/thought bubbles, callouts, labels, screen HUD) via permission-gated `ui.*` skills; and `limina-audio` (rodio/cpal) — a dedicated audio thread, 4-bus mixer, spatial player, `audio.*` skills, and fire-and-forget Rust-side TTS that never freezes the frame. |

Phase 2 is an executable plan; Phases 3–4 were detailed at kickoff. Phase 5 is independent — Presentation & Audio depend only on the Phase 0 render/runtime floor, so they were pulled forward on demand.

## The arc

```text
Phase 0           Phase 1            Phase 2        Phase 3          Phase 4
Foundation  ──▶  Agent-Native  ──▶  Open World ──▶ Scale &     ──▶  Shared
                 Core                              Fidelity          Platform
                   │
                   └──▶  Phase 5 · Presentation & Audio   (independent · pull-forward)
```

The ordering follows the dependencies: you cannot *scale* agents you cannot *connect* (2 before 3), and a shared platform only pays off once one instance can host many builders and players in a rich world without losing frame budget, traceability, or capability boundaries (3 before 4). Each phase ends in demoable acceptance and de-risks the next.

## Standing principle: performance-first

Every architectural choice is aimed at making Limina blazingly fast. When quality or power competes with speed, the tradeoff is surfaced, weighed, decided deliberately, and the rationale recorded. Concretely: native hot paths (ECS iteration, physics, spatial queries) over JS; data-oriented SoA/TypedArray storage; zero-copy buffer bridging over serialization; JS is the scripting/agent/authoring layer, **not** the inner loop. Agent *thinking* always runs off the frame loop — a slow model never drops a frame.

## Standing principle: the engine is the substrate, not the brain

Limina owns the **world** (ECS, physics, render), **perception**, the **skill/MCP surface**, and a **durable world event log**. It does **not** own the agent's brain or its memory. The decision provider is pluggable ([`LLMProvider`](/building-agents/llm-providers): Scripted / Ollama / Gateway), and recall is part of the brain — fed by perception plus read access to the durable log, with any memory backend living as an external adapter behind the provider, never an engine runtime dependency. So: **engine = world + perception + durable log; brain = decision + recall (pluggable); memory backend = external.**

## The numbers

| Metric | Result | Source |
|---|---|---|
| Density capstone | 200 agents + 256 dynamic bodies + 2000 entities @ sim-step **p95 4 ms** (≤ 8 ms budget), 60 steps/s over ≥300 ticks | Phase 3 |
| Render perf fix pass | **9.4 → 74 fps** | Phase 3 |
| Native spatial parallelism | **4.5–5.4×** over the JS oracle, **≤ 2 ms**, byte-identical; `MAX_ENTITIES` raised to 16384 | Phase 3 |
| Authoritative multi-client sync | **p95 11 ms** | Phase 4 |
| Numbers-party flythrough | **~102 fps** (~200 instanced agents) | Phase 5 |

Every density agent fully perceives → decides → acts, and every action is traced. The shipped headline: one native binary — **Rust host → V8 (`deno_core`) → WebGPU (`deno_webgpu` + Three.js) → native Rapier → bitECS**, on a fixed-timestep loop, with a typed/permissioned/versioned skill registry, an in-process + stdio/WebSocket MCP surface, and sha256-chained EventLoom-shaped JSONL traces.
