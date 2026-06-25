---
title: "Introduction"
description: "Limina is an agent-native real-time 3D engine: one native binary where LLM agents build and inhabit a high-performance world."
---

Limina is an **agent-native, high-performance real-time 3D engine**. It ships as a
single native binary, and LLM agents are first-class citizens: they build scenes and
live inside them through a typed, permission-checked, fully traced skill surface.

The whole engine is one process — a Rust host embedding V8, driving WebGPU through
Three.js, with native physics, spatial queries, and audio on the hot paths — running on
a fixed-timestep loop. There is no separate renderer service, no game-server sidecar, no
scripting daemon. One binary boots the world, opens a window (or runs headless), and
exposes an [MCP](/pillars/mcp-interface) surface that external agents connect to.

## One binary, one stack

Every layer lives in the same process. Agents call **skills**; skills mutate the
**ECS**; native **physics/spatial** ops advance the simulation in place over zero-copy
data; the **renderer** reads that same data and presents a frame.

```text
┌──────────────────────────────────────────────────────────────┐
│  Agents & skills                                             │
│  Agent Builders (over MCP) · Agent Players (in-world)        │
│  45 typed, permission-checked, traced skills                 │
├──────────────────────────────────────────────────────────────┤
│  Rendering                                                   │
│  Three.js (WebGPURenderer) → WebGPU (deno_webgpu)            │
├──────────────────────────────────────────────────────────────┤
│  Simulation                                                  │
│  bitECS — SoA TypedArrays · fixed-timestep loop (60 steps/s) │
├──────────────────────────────────────────────────────────────┤
│  Native hot paths                                            │
│  Rapier3D physics · rayon spatial/ECS ops · rodio audio      │
├──────────────────────────────────────────────────────────────┤
│  Host                                                        │
│  Rust embedder + V8 (deno_core) — the single `limina` binary │
└──────────────────────────────────────────────────────────────┘
```

Data flows down and back up every tick: agents and authoring code call skills at the
top, the simulation and native subsystems advance the world's Structure-of-Arrays (SoA)
state in the middle, and the renderer reads that state to present a frame — with **no
serialization** between the layers. See [Architecture & stack](/architecture) for the
crate-by-crate breakdown.

## Two kinds of agents

Limina treats agents as participants, not plugins. There are two kinds, and both speak
the same skill vocabulary.

| Kind | Where it runs | How it acts | Typical profile |
|------|---------------|-------------|-----------------|
| **Agent Builder** | External process, connected over MCP | Constructs and edits the world: create entities, set transforms/materials/lighting, load glTF | `builder.readWrite` |
| **Agent Player** | In-world, on the engine's loop | Runs perceive → decide → act, inhabiting an entity and moving it via physics/locomotion | `player.limited`, `social.actor` |

A Builder discovers tools over the [MCP interface](/pillars/mcp-interface) and calls them
remotely; a Player runs its [perception → decision → action](/building-agents/players)
cycle inside the engine, with its (slow, async) model decisions resolved **off** the
frame loop so a slow model never drops a frame. Either way, every call is the same typed,
permissioned, traced skill invocation. See [Building agents](/building-agents/builders)
and the [agent ecosystem pillar](/pillars/agent-ecosystem).

## Standing principles

Two principles are load-bearing — they decide architectural tradeoffs across the engine.

:::tip[Performance-first]
Every architectural choice aims at making Limina **blazingly fast**. Hot paths (ECS
iteration, physics, spatial queries, audio) are native; data is stored as data-oriented
SoA TypedArrays; buffers are bridged **zero-copy** rather than serialized; and JS is the
scripting/agent/authoring layer, never the inner loop. Agent *thinking* always runs off
the frame loop — a slow model never drops a frame.
:::

:::note[The engine is the substrate, not the brain]
Limina owns the **world** (ECS, physics, render), **perception**, the **skill/MCP
surface**, and a **durable world event log**. It does *not* own an agent's brain or its
memory. The decision provider is pluggable
([Scripted / Ollama / Gateway](/building-agents/llm-providers)), and recall is part of
the brain — fed by perception plus read access to the durable log, with any memory
backend living as an external adapter behind the provider. Persisting the world well
serves any memory-builder without the engine owning memory.
:::

## Where to go next

- **[Getting started](/getting-started)** — prerequisites, build, and your first demo.
- **[Architecture & stack](/architecture)** — the full layered stack, crate by crate.
- **[Skills reference](/skills)** — the 45 typed skills agents and authors call.
- **[For agents ↗](/agents)** — the agent-oriented entry point into Limina.

:::note[Project status]
Phases 0–5 are complete and verified: the native runtime, agent-native core, open world,
single-instance scale & fidelity, the shared platform, and presentation & audio all ship
today. See the [Roadmap & status](/roadmap) for the full breakdown.
:::
