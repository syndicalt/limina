# Limina

<p align="center">
  <img src="assets/limina-hero.png" alt="Limina - A liminal dreamscape where agents build and inhabit worlds" width="100%">
</p>

> The agent-native 3D engine.  
> Real agents build worlds — and then live inside them.

Limina is a high-performance 3D engine where LLM agents are first-class citizens. External **Agent Builders** construct and modify worlds through typed, permissioned, traced skills. In-world **Agent Players** perceive, decide, and act inside those worlds with full observability. Every action is governed, replayable, and sha256-chained.

A world in Limina is a pure function of `(seed + skill/physics command log + snapshots)`. The durable JSONL world log **is** the portable project format — "export" means re-running the log against a target runtime, not recompiling.

## What's shipped

Twelve phases are complete with acceptance gates and tests green. The engine runs as a single native binary — Rust → V8 (`deno_core`) → WebGPU (`deno_webgpu` + Three.js) → native Rapier physics → bitECS, on a fixed-timestep loop.

| Pillar | Capability |
|---|---|
| **Agent builders** | Typed, versioned, permissioned skill/hook registry. External agents drive the engine over MCP `listTools`/`callTool` (in-process, stdio, websocket). LLM-agnostic: scripted / local Ollama / cloud gateway. |
| **Agent players** | Perception → decision → action loop as first-class entities. 200 concurrent agents @ p95 4 ms with 256 dynamic bodies and 2000 entities in a single instance. |
| **Observability** | Every action emitted as a typed, sha256-chained, replayable event (EventLoom-shaped traces, JSONL export). Bit-identical determinism between native and JS oracle, verified. |
| **Governance** | QuickJS isolation for untrusted code. Dynamic policy engine. Scoped skill exposure via permission bundles. Audit surfaces. Versioned packages with manifest + attestation + content-hash provenance. Delegate/coordinator orchestration. |
| **Worlds** | Native Rapier physics. Persistent shared worlds with authoritative multi-client sync (p95 11 ms). Interest management. Durable replay. |
| **Authoring** | Human-in-the-loop approval gate in `registry.invoke()` (pending/grant/deny, causal chain intact). Web editor with reasoning tree + approval queue. |
| **Terrain** | `terrain.*` / `world.*` skill seam. Native heightfield op. `ProceduralTerrainSource` (deterministic noise) and `ModelTerrainSource` (IPC). Content-addressed tile cache. |
| **Content** | Default PBR lighting/IBL. 10 named materials. Content-addressed `asset.place` / `asset.scatter` (elevation-aware). CC0 cottage-on-a-beach gate met. |
| **Audio** | `limina-audio` (rodio 0.22 / cpal). Dedicated audio thread. 4-bus mixer (master/sfx/ambience/voice). Spatial `SpatialPlayer` (camera-listener + 1/d²). Fire-and-forget TTS (espeak/Piper). |
| **Game-building** | ~85 skills across 17 systems: player, camera, animation, interaction, inventory, gamestate, triggers, quest, combat, behavior, navmesh, VFX, save, progression, worldstate. Progressive discovery (`skills.browse` / `skills.search`). 8 permission profiles. |
| **Export** | Browser/phone playback (Mode A: snapshot-keyframe). Export package `{manifest, log.jsonl, keyframes.jsonl}`. Keyframe-driven `PhysicsOps` with bit-identical parity gate. Browser host (canvas-WebGPU + IndexedDB + rAF accumulator). |
| **Native parallelism** | Rayon-based CSR spatial op in `limina-ecs`, bit-identical to the JS oracle, 4.5–5.4× / ≤ 2 ms. Profile-first found and memoized an un-cached `registry.list()` (`z.toJSONSchema` / agent / tick). `MAX_ENTITIES` → 16384. |

### Demos

22+ demos in `js/src/demos/`, including:

- **`forest_conversation.ts`** — agents hold a real non-deterministic Ollama conversation in speech bubbles and speak it aloud over an ambient bed.
- **`numbers_party.ts`** — ambient bed + positional chatter as the camera sweeps the crowd (102 fps).
- **`cottage_beach.ts`** — CC0 cottage on a beach, content-addressed asset pipeline.
- **`playable_game_window.ts`** — game-building skill catalog end-to-end.
- **`billiards.ts`** — interactive Rapier physics.
- **`coordinator_cottage.ts`** — delegate/coordinator orchestration pattern.

Run any of them with:

```bash
./target/release/limina --window --frames 600 js/src/demos/<name>.ts
```

## Quick start

**Docs & live demo → [liminaengine.com](https://www.liminaengine.com)** — overview, architecture, the full skills / SDK reference, and an agent-tailored section.

### Native (full engine — agents, physics, audio, the whole surface)

```bash
git clone https://github.com/syndicalt/limina.git
cd limina
cargo build --release
./target/release/limina --window --frames 600 js/src/demos/billiards.ts
```

See [`INSTALL.md`](INSTALL.md) for platform prerequisites (WebGPU via Dawn/wgpu, audio backend, etc.).

### Browser (export playback — Mode A)

The export package (`{manifest, log.jsonl, keyframes.jsonl}`) plays back in any WebGPU-capable browser with no Rust toolchain. Mode B (live wasm-Rapier browser authoring) is on the roadmap but not yet shipped — see [`plans/phase-8-run-anywhere-plan.md`](plans/phase-8-run-anywhere-plan.md).

### Drive it from an LLM agent

Limina exposes MCP `listTools` / `callTool` over stdio and websocket. Point any MCP-compatible agent (Claude, Cursor, Ollama, a custom orchestrator) at the running binary and it can build worlds through the same typed skill surface a human uses in the editor. See the docs site for the agent-tailored walkthrough.

## Architecture

- **Runtime layer** — Native execution (WebGPU via Dawn/wgpu, windowing/input, minimal web API surface, dedicated audio thread).
- **Engine layer** — Data-oriented bitECS + fixed-timestep loop + Three.js WebGPU rendering + native Rapier physics + content-addressed asset registry.
- **Agent layer** — Skill/hook registry, perception/decision/action systems, governance (QuickJS isolation, policy engine, audit), and sha256-chained observability.

Seven Rust crates: `limina-runtime`, `limina-ecs`, `limina-render`, `limina-physics`, `limina-audio`, `limina-ops`, `limina-sandbox`.

## Roadmap

- **Shipped (Phases 0–12):** [`plans/ROADMAP.md`](plans/ROADMAP.md) — Foundation, Agent-Native Core, Open World, Single-Instance Scale & Fidelity, Shared Platform, Presentation & Audio, Open the Door, Authoring Surface, Run Anywhere (Mode A), Worlds Worth Authoring, Governance & Orchestration, Content & Assets, Game-Building Skill Catalog. All with evidence.
- **Next:** [`plans/post-mvp-roadmap.md`](plans/post-mvp-roadmap.md) — Phase 13 (Ecosystem & Marketplace), plus deferred polish: Mode B live browser authoring, worldgen W2/W3/W5, Phase 12 capstone demo, bmap pipeline.
- **Original MVP spec:** [`docs/mvp-spec.md`](docs/mvp-spec.md).

## Licensing

Limina is **dual-licensed**:

- **Open Source**: [GNU Affero General Public License v3.0 (AGPL-3.0)](LICENSE)
- **Commercial**: A separate commercial license is available for organizations that cannot comply with AGPL-3.0.

For commercial licensing inquiries, please open an issue or contact the maintainers.

## Contributing

Contributions are welcome once the project reaches a more stable API state. Feel free to open issues for discussion in the meantime.

---

*Limina is an exploration into what becomes possible when agentic systems and spatial computing are designed together from the ground up.*
