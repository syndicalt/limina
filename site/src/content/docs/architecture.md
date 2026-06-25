---
title: "Architecture & stack"
description: "The full Limina stack, layer by layer: Rust host, V8, WebGPU, bitECS, native Rapier/rayon/audio, and the crates that implement them."
---

Limina is one native binary built from a Rust workspace. A Rust host embeds V8, runs your
TypeScript, and exposes native subsystems — rendering, physics, ECS hot paths, spatial
queries, audio — as ops that JS calls directly. The design is performance-first: native
where it counts, zero-copy between layers, and agent thinking off the frame loop.

This page walks the stack top to bottom and names the crate behind each layer.

## The layered stack

```text
┌──────────────────────────────────────────────────────────────┐
│  Agents & skills (TypeScript)                                 │
│  Builders over MCP · in-world Players · 45 typed skills       │
├──────────────────────────────────────────────────────────────┤
│  Rendering                                                    │
│  Three.js WebGPURenderer → deno_webgpu → native surface       │  limina-render
├──────────────────────────────────────────────────────────────┤
│  Simulation                                                   │
│  bitECS world · SoA TypedArrays · fixed-timestep loop          │  (JS) + limina-ecs
├──────────────────────────────────────────────────────────────┤
│  Native hot paths                                            │
│  Rapier3D physics · rayon CSR spatial/ECS ops · rodio audio   │  limina-physics
│                                                              │  limina-ecs · limina-audio
├──────────────────────────────────────────────────────────────┤
│  Bridge & isolation                                         │
│  #[op2] op bridge · QuickJS sandbox for untrusted code        │  limina-ops · limina-sandbox
├──────────────────────────────────────────────────────────────┤
│  Host                                                       │
│  Rust embedder + V8 (deno_core) — the single `limina` binary  │  limina-runtime
└──────────────────────────────────────────────────────────────┘
```

## Layer by layer

### Host — `limina-runtime`

The embedder, and the only binary (`limina`). It boots a V8 isolate via `deno_core`,
transpiles and loads your TypeScript main module, and then either runs it to completion
headless or drives the native `winit` window with the [fixed-timestep loop](/concepts/loop).
It also hosts the `--mcp-stdio` and `--mcp-ws` JSON-RPC servers that external
[Agent Builders](/building-agents/builders) connect to. Everything else is a library this
crate links.

### Rendering — `limina-render`

Owns the WebGPU device and the native window surface. It registers the `deno_webgpu`
extension stack plus a JS bootstrap so `navigator.gpu` and the `GPU*` types exist inside
V8, injects a native surface (so the engine presents directly from Rust rather than through
a browser canvas), and presents frames. On top of this, JS builds a standard **Three.js
`WebGPURenderer`** — so authors and agents work in familiar Three.js terms while the device
underneath is native WebGPU.

### Simulation — bitECS + `limina-ecs`

The world's state is a [bitECS](/concepts/ecs-and-world) world whose components are
**Structure-of-Arrays (SoA) TypedArrays** backing transforms (position, rotation, scale)
for up to `MAX_ENTITIES = 16384` entities. Iteration-heavy work that JS is slow at is pushed
into `limina-ecs`: native, **rayon-parallel** ECS ops over those same JS-owned buffers,
including a batched uniform-grid (CSR) radius query that is **bit-identical** to the JS
spatial oracle — 4.5–5.4× faster and ≤2 ms. The JS index remains the determinism oracle;
the native op only accelerates it.

### Native hot paths — `limina-physics`, `limina-ecs`, `limina-audio`

- **`limina-physics`** integrates native **Rapier3D** via `#[op2]`: a `PhysicsWorld` lives
  in the host's `OpState`, bodies are addressed by stable `u32` handles (with tombstoning),
  and collision events and on-demand raycasts are exposed to JS. Physics steps in native
  code; transforms are read back into the ECS SoA each tick.
- **`limina-ecs`** provides the rayon-parallel spatial/ECS ops described above — the engine's
  answer to "perceive 200 agents against 2000 entities every few ticks without burning the
  frame budget." See [Perception](/concepts/perception).
- **`limina-audio`** runs native audio (rodio/cpal) on a dedicated thread: a 4-bus mixer
  (master/sfx/ambience/voice), a spatial player with 1/d² attenuation relative to the camera
  listener, and fire-and-forget Rust-side TTS (espeak-ng / Piper). It never blocks the frame.

### Bridge & isolation — `limina-ops`, `limina-sandbox`

- **`limina-ops`** is the shared `#[op2]` bridge every native subsystem reuses: fast numeric
  ops, **zero-copy buffer round-trips** (e.g. scaling a `Float32Array` in place), structured
  catchable errors, and the `OpState` resource conventions for host-owned state.
- **`limina-sandbox`** is the isolation substrate for untrusted skill/agent code: a QuickJS
  (`rquickjs`) runtime per agent with a standard-ECMAScript-only global and a single injected
  `host.invoke` surface. Reads are served from an injected perception snapshot; mutations are
  recorded as intents and driven through the real skill registry under host attribution, with
  per-agent memory/CPU/stack budgets.

## Three design properties

These three properties are why the stack holds together at speed.

**Zero-copy SoA bridging.** Component data lives in JS-owned TypedArrays over `ArrayBuffer`s.
Native ops read and write those buffers in place — no serialization, no marshalling copies
crossing the JS↔Rust boundary on the hot path. The same bytes the physics step writes are
the bytes the spatial query reads and the renderer presents.

**Native hot paths, JS as the authoring layer.** Iteration, physics, spatial queries, and
audio mixing run in native code (often rayon-parallel). JS is the scripting, agent, and
authoring layer — expressive where expressiveness matters, and out of the inner loop where
it does not.

**Off-loop agent thinking.** Perception and action are on-frame and deterministic, but an
agent's (slow, async) model decision fires **off** the frame path; its validated tool calls
are enqueued and applied at a tick boundary. A slow model adds latency to a decision, never
a dropped frame. See the [loop](/concepts/loop) and [perception](/concepts/perception).

## Crate map

| Crate | Responsibility |
|-------|----------------|
| `limina-runtime` | The embedder and the only binary: boots V8 via `deno_core`, loads TS, runs headless or drives the native `winit` window loop, hosts the `--mcp-stdio` / `--mcp-ws` servers. |
| `limina-render` | WebGPU device + native `winit` surface; registers the `deno_webgpu` extension stack + JS bootstrap; presents frames from Rust. |
| `limina-ecs` | Native rayon-parallel ECS hot-path ops over zero-copy JS-owned SoA TypedArrays; batched CSR radius query, bit-identical to the JS oracle. |
| `limina-physics` | Native Rapier3D via `#[op2]`: `PhysicsWorld` in `OpState`, `u32` body handles, collision events, on-demand raycast. |
| `limina-audio` | Native audio (rodio/cpal): dedicated thread, 4-bus mixer, spatial 1/d² player, fire-and-forget TTS. |
| `limina-ops` | Shared `#[op2]` bridge + `OpState` resource conventions: fast ops, zero-copy buffers, structured errors. |
| `limina-sandbox` | QuickJS isolation substrate for untrusted skill/agent code; single injected `host.invoke`, per-agent budgets. |

## Where to go deeper

- **Concepts:** [ECS & the world](/concepts/ecs-and-world) ·
  [The fixed-timestep loop](/concepts/loop) · [Perception](/concepts/perception) ·
  [Observability & the world log](/concepts/observability)
- **Pillars:** [Skill / Hook registry](/pillars/skill-registry) ·
  [MCP interface](/pillars/mcp-interface) · [Observability](/pillars/observability) ·
  [Agent ecosystem](/pillars/agent-ecosystem)
