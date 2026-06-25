---
title: "Demos"
description: "Every Limina demo: what each one shows, the capabilities it exercises, and the exact command to run it."
---

The demos live in `js/src/demos/`. Each is a standalone TS module the `limina` binary
runs directly. Most are **windowed** (they call `createEngine`, which needs a WebGPU
adapter); a couple run **headless**. Together they exercise the full engine — physics,
agents, the native spatial pipeline, audio, UI/text, MCP, permissions, and the trace.

## The catalog

| Demo | Mode | What it shows | Capabilities exercised |
|------|------|---------------|------------------------|
| `billiards.ts` | windowed | A bordered table of static rails and a racked break of dynamic spheres; native Rapier steps and full transforms (position + quaternion) are read back to the ECS so the balls visibly **roll**. No agents — pure physics. | physics, ECS, render sync |
| `builder.ts` | headless | An in-process agent discovers tools over MCP and builds a scene (`createEntity` / `setTransform` / `setMaterial` / `setLighting` / `loadGLTF`); one call is permission-denied; the whole sequence is permission-checked and traced. | skills, MCP, permissions, observability |
| `player.ts` | windowed | An autonomous player agent runs perception → decision → action in the fixed loop, pursuing the nearest target via physics impulses; decisions resolve off-loop so frame rate is unaffected. | agents, physics, skills |
| `fidelity_scene.ts` | windowed | A visual-fidelity scene authored **through** `scene.*`/`three.*` skills: a shadow-casting directional light with real shadow maps on a receiving floor, textured glTF, ACES Filmic tone mapping + MSAA; the caster spins so the shadow sweeps. | render fidelity, skills |
| `forest_conversation.ts` | windowed | An agent humanoid walks to two NPCs and holds a real, non-deterministic Ollama (`qwen2.5:7b`) conversation rendered as speech bubbles **and** spoken aloud over an ambient bed, with a live agent-ops HUD; the LLM/decisions run off-loop, with an honest "LLM offline" fallback. | agents, LLM, UI/text, spatial audio + TTS, observability |
| `hedgehog_dance.ts` | windowed | A procedural hedgehog dances **and sings** to a JS-synthesized dance track played through the native mixer, beat-synced to BPM; the sung TTS is spatialized at its mouth and the listener follows the camera. | audio (music + spatial + TTS) |
| `numbers_party.ts` | windowed | ~200 instanced extruded-numeral "number-people" agents wander, approach, and chat in transient pairs via the real Phase-3 perception → decision → action pipeline (native batched spatial query, off-loop decisions, every move a traced `three.setTransform`); an agent-ops HUD streams the real tracer feed alongside a perf overlay, with an ambient bed and positional chatter. | scale, agents, native spatial parallelism, audio, UI, observability |
| `phase3_showcase.ts` | windowed | Textured glTF, bound MCP builder sessions, in-world Agent Players, scheduler budgets, physics sync, and trace/devtools evidence — all combined in one graphical scene. | broad Phase-3: agents, MCP, physics, fidelity, scheduler, devtools |
| `ui_showcase.ts` | windowed | In-scene UI containers authored through `ui.*` skills (speech bubble, thought bubble, titled text box, callout leader line) plus a screen-anchored agent-ops HUD; world panels billboard while the HUD stays fixed as the camera orbits. | UI/text rendering, skills, permissions |

:::note[Shared helpers, not demos]
`fidelity_scene_core.ts` and `phase3_showcase_core.ts` are shared helper modules imported
by the windowed demos above — they are not standalone demos and should not be run directly.
:::

## Run a few highlights

**Billiards** — the quickest "it works" check; pure native physics, no agents:

```bash
./target/release/limina --window --frames 600 js/src/demos/billiards.ts
```

**Numbers party** — the scale + native-spatial-parallelism showcase (~200 agents). A flythrough
runs at roughly 102 fps. This demo is windowed-only:

```bash
./target/release/limina --window --fullscreen js/src/demos/numbers_party.ts
# or a bounded run:
./target/release/limina --window --frames 600 js/src/demos/numbers_party.ts
```

**Builder** — the only headless demo; an in-process agent builds a scene over MCP, with one
call denied and the whole run traced:

```bash
./target/release/limina js/src/demos/builder.ts
```

## What to read next

- The pipeline the agent demos run on: [Perception](/concepts/perception) and the
  [fixed-timestep loop](/concepts/loop).
- How a Builder constructs a scene over MCP:
  [Agent Builders](/building-agents/builders).
- How a Player perceives, decides, and acts in-world:
  [Agent Players](/building-agents/players).
- The skills every demo calls: the [Skills reference](/skills).
