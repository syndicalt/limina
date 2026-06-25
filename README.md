# Limina

<p align="center">
  <img src="assets/limina-hero.png" alt="Limina - A liminal dreamscape where agents build and inhabit worlds" width="100%">
</p>

> A native runtime and agent-native engine for Three.js/WebGPU.  
> Where AI agents build worlds — and then live inside them.

**Limina** is an early-stage, high-performance engine and runtime designed to underpin [Three.js](https://threejs.org/) with first-class WebGPU support. It combines a lightweight native execution environment with a data-oriented ECS architecture, making both **AI agent builders** and **in-world agent players** first-class citizens.

## Vision

Limina sits at the intersection of modern 3D graphics and agentic systems. It provides the foundational infrastructure for spatial experiences where:

- **Agent Builders** can programmatically construct and modify rich 3D worlds using structured skills, hooks, and tool interfaces.
- **Agent Players** can perceive, reason, and act within those worlds with deep observability and memory.
- Humans and agents collaborate in a shared, traceable, and governable environment.

## Current Status

**0.1.0 — agent-native core shipped.** Limina is early-stage and evolving fast (the public API is not yet stable), but the foundational milestone is **complete and verified**: a single native binary — Rust → V8 (`deno_core`) → WebGPU (`deno_webgpu` + Three.js) → native Rapier physics → bitECS, on a fixed-timestep loop — with all four agent-native pillars:

- **Skill / Hook registry** — typed, versioned, permissioned capabilities with hooks
- **MCP interface** — `listTools` / `callTool` over in-process, stdio, and websocket
- **Observability** — every action emitted as a typed, sha256-chained, replayable event
- **Agent ecosystem** — builder + player agents (perceive → decide → act), LLM-agnostic

…plus interactive physics, a durable world log, single-instance scale (200 agents @ p95 4 ms), shared-world sync, in-scene text/UI, and spatial audio. See the [roadmap](plans/ROADMAP.md).

## Key Concepts

| Concept              | Description |
|----------------------|-----------|
| **Agent Builders**   | AI agents that use Limina’s skill system to create and modify scenes, entities, and behaviors |
| **Agent Players**    | Autonomous entities inside the simulation with perception, decision-making, and action systems |
| **Skill/Hook System**| Discoverable, typed registry of engine capabilities agents can safely invoke |
| **MCP-style Interface** | Structured tool-calling protocol designed for LLM agents |
| **Observability**    | Every significant action is traceable, logged, and replayable |

## Getting Started

> **Note:** Limina is early-stage; the public API is not yet stable.

**Docs & live demo → [liminaengine.com](https://www.liminaengine.com)** — overview, architecture, the full skills / SDK reference, and an agent-tailored section.

```bash
git clone https://github.com/syndicalt/limina.git
cd limina
cargo build --release
# run a demo in a window (see the docs for prerequisites):
./target/release/limina --window --frames 600 js/src/demos/billiards.ts
```

## Architecture

- **Runtime Layer** — Native execution (WebGPU via Dawn/wgpu, windowing/input, minimal web API surface)
- **Engine Layer** — Data-oriented ECS + fixed-timestep loop + Three.js WebGPU rendering + physics
- **Agent Layer** — Skill registry, perception/decision/action systems, and rich observability

## Licensing

Limina is **dual-licensed**:

- **Open Source**: [GNU Affero General Public License v3.0 (AGPL-3.0)](LICENSE)
- **Commercial**: A separate commercial license is available for organizations that cannot comply with AGPL-3.0.

For commercial licensing inquiries, please open an issue or contact the maintainers.

## Contributing

Contributions are welcome once the project reaches a more stable state. Feel free to open issues for discussion in the meantime.

## Roadmap

- **Shipped (0.1.0):** [`plans/ROADMAP.md`](plans/ROADMAP.md) — Phases 0–5, with evidence.
- **Next (post-MVP):** [`plans/post-mvp-roadmap.md`](plans/post-mvp-roadmap.md).
- **Original MVP spec:** [`docs/mvp-spec.md`](docs/mvp-spec.md).

---

*Limina is an exploration into what becomes possible when agentic systems and spatial computing are designed together from the ground up.*
