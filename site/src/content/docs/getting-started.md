---
title: "Getting started"
description: "Prerequisites, building the single Limina binary, and running your first demo windowed and headless."
---

Limina builds into one native binary, `limina`. This page takes you from a clean checkout
to a window with rolling billiard balls, then to the headless test suite — the same
binary drives all three modes (windowed, headless, MCP server).

## Prerequisites

### Toolchain

- **Rust + Cargo** (recent stable). The workspace pins a prebuilt V8 and `deno_core`, so a
  current stable toolchain is expected. This is all you need to build and run the engine.
- **Node.js + npm** — only for the JS tooling layer: the Three.js / bitECS / zod bundles
  in `js/build/` are produced with esbuild, and the external example MCP client runs under
  Node. The engine itself embeds V8 via `deno_core` and never shells out to Node at runtime.

The prebuilt JS bundles (`js/build/three.bundle.mjs`, `zod.bundle.mjs`, `bitecs.bundle.mjs`)
are already committed and are what the demos and tests import, so you only need Node if you
change those dependencies.

### System libraries (Linux)

- **A Vulkan-capable GPU + driver.** Rendering is WebGPU via `deno_webgpu`/wgpu. Windowed
  demos request a WebGPU adapter at startup; without one, `createEngine` fails with
  `engine: no WebGPU adapter` — which is exactly why windowed demos cannot run in the
  headless suite.
- **A native window stack (X11/Wayland).** Limina opens its own window via `winit`.
- **An audio output backend** (ALSA on Linux, via `cpal`) for the audio subsystem. This can
  be disabled for headless/CI runs (see env vars below).
- **`espeak-ng`** (or **Piper**) on `PATH` for agent voice/TTS. Optional — voice is
  auto-disabled with an honest log if no provider is found.

### Environment variables

| Variable | Purpose |
|----------|---------|
| `LIMINA_AUDIO=null` | Force the no-op `Null` audio backend (device-free CI/headless). A missing device also auto-falls-back. |
| `LIMINA_TTS` | Select the voice provider: `none` \| `espeak` \| `piper` \| `piper:<model.onnx>`. Unset = auto (espeak-ng if on `PATH`, else no voice). |

The conversation demo additionally talks to a local **Ollama** server at
`http://localhost:11434` (model `qwen2.5:7b`). That is optional: the demo runs and shows an
honest "LLM offline" status if Ollama is unreachable.

## Build

```bash
git clone https://github.com/syndicalt/limina.git
cd limina

# Optional: rebuild the JS bundles only if you changed three/bitecs/zod
# cd js && npm install && npm run bundle:three && cd ..

# Build the engine (optimized; recommended for demos and perf)
cargo build --release
```

This produces the single binary at **`./target/release/limina`**. A plain `cargo build`
produces a faster-to-compile debug binary at `./target/debug/limina`.

:::note[First build is slow]
The first release build downloads a prebuilt V8 and compiles a large native dependency
graph (V8, wgpu, Rapier), so expect a multi-minute initial build. Incremental rebuilds
afterward are fast.
:::

## Run your first demo (windowed)

```bash
./target/release/limina --window --frames 600 js/src/demos/billiards.ts
```

A window opens onto a billiards table: a racked break where dynamic spheres are stepped by
native Rapier, with each ball's full transform (position **and** orientation) read back
into the ECS so the balls visibly *roll* across the cloth. `--frames 600` auto-exits after
600 frames, which is handy for non-interactive runs and screenshots; drop it to run until
you close the window or press Escape.

The CLI flags are:

| Flag | Meaning |
|------|---------|
| `<module.ts>` | The TS module to run (bare positional argument). |
| `--window` | Open a native window and drive the frame loop. |
| `--frames N` | Auto-exit after `N` frames. |
| `--fullscreen` | Run the window borderless-fullscreen. |
| `--mcp-stdio` | Run as a newline-delimited JSON-RPC MCP server on stdin/stdout. |
| `--mcp-ws [--port N]` | Run the authoritative multi-client MCP server over a localhost WebSocket. |

Browse the full catalog on the [Demos](/demos) page.

## Run the headless tests

Headless tests are standalone TS modules under `js/test/`, run by the same binary with no
window and no GPU:

```bash
# A representative agent-native test: registry + Zod validation + traced
# permission denial, all headless (no GPU).
./target/release/limina js/test/m1_registry.ts

# The Phase-3 density capstone (release build recommended).
./target/release/limina js/test/p3n4_capstone.ts
```

Audio tests are designed to run with `LIMINA_AUDIO=null`. The external MCP transport is
exercised separately with `node examples/mcp_stdio_client.mjs`, which spawns the binary in
`--mcp-stdio` mode and walks an `initialize → tools/list → tools/call → shutdown`
handshake.

## What just happened

A windowed run wired up the whole stack in one process:

1. The Rust host created a native window and a WebGPU device, then booted a V8 isolate and
   loaded your TS module.
2. The module called `createEngine`, which built the Three.js `WebGPURenderer`, the scene
   and camera, and a bitECS world over SoA TypedArrays.
3. The host's [fixed-timestep loop](/concepts/loop) called the module's fixed-step callback
   ~60 times per second: native Rapier advanced the physics, transforms were synced into
   the ECS, and the render callback presented a frame with interpolation.

That is the same loop every demo and every Agent Player runs on. To understand the moving
parts, read [Architecture & stack](/architecture).

:::caution[Headless and audio gotchas]
Windowed demos require a real WebGPU adapter; running one headless throws
`engine: no WebGPU adapter` by design — use the `js/test/*.ts` modules for headless work.
For CI or machines without an audio device, set `LIMINA_AUDIO=null` to use the no-op audio
backend, and set `LIMINA_TTS=none` (or install `espeak-ng`) so voice synthesis does not
warn. None of these affect determinism: audio and TTS never block the frame.
:::
