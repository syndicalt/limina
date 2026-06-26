# Spike: Learned World Generation (Terrain Diffusion)

> **Type:** de-risking spike · **Status:** not started (proposal) · **Tier:** post-MVP, **Phase 9** (S0 probe gated in **Phase 6**)
> **Parent:** [`ROADMAP.md`](./ROADMAP.md) · companion to [`post-mvp-roadmap.md`](./post-mvp-roadmap.md)
> **Builds on (all ✅ complete):** Phase 2 Open World (interactive physics, durable+replayable log, spatial index), Phase 3 Scale & Fidelity (native ECS spatial op, rich worlds, `MAX_ENTITIES` 16384), Phase 4 (durable world state + snapshot recovery, policy engine), and the standing principles (performance-first; engine = substrate, not brain/memory).
> **Candidate tech:** [`xandergos/terrain-diffusion`](https://github.com/xandergos/terrain-diffusion) — *InfiniteDiffusion* (SIGGRAPH '26, MIT). A learned, **infinite, deterministic, O(1)-random-access** terrain + climate generator (coarse sketch → 30 m/px heightmaps + temperature/precipitation), streamable in real time. HuggingFace weights; Python/PyTorch.

This is **not a phase** and **not a commitment to ship**. It is a time-boxed investigation to retire the
unknowns around making a *learned* world generator a first-class limina substrate, the same way every
other capability is: a **typed, permission-checked, traced skill** whose heavy work runs **off the frame
loop** and whose output is **deterministic enough to replay**.

## Why it's worth a spike (the fit)

- **Determinism + O(1) random access** is the contract limina already lives by (fixed timestep, seedable,
  replay-complete world log). Most learned generators can't promise reproducibility; this one is built
  around it — so it can feed the durable log without breaking replay.
- **Coarse → detail = a builder-agent skill.** An external agent (or a human via the Azgaar import) sketches
  intent; the model details it. That is exactly `world.generateRegion(seed, bounds, hints)` — permissioned
  and traced like `scene.*`/`physics.*`.
- **Climate channels = player-agent perception.** Per-coordinate temperature/precipitation/biome are real
  perception inputs, not just visuals — they extend the existing perception substrate.
- **Engine stays the substrate.** Generation is an external/optional backend behind a skill; the engine owns
  the *world* (heightfield collider + mesh) and the *log*, never the model. Mirrors the pluggable
  `LLMProvider` seam.

## The question this spike answers

> Can limina drive a learned, infinite, deterministic terrain generator as a **typed / permissioned / traced,
> off-loop** skill that streams tiles into **bitECS + native Rapier** and the renderer — **without dropping a
> frame** and **without breaking replay determinism** — on the target hardware (RTX 3050 / Wayland-Vulkan)?

If yes → it earns a place as a real world-gen pillar. If the latency/determinism/integration cost is too high
→ we keep procedural noise and shelve it with evidence.

## Non-goals

- Not training; use the published weights only.
- Not replacing the stylized scene aesthetic — this targets **large naturalistic agent worlds**, orthogonal to the cinematic's low-poly look.
- Not in the frame loop — generation is async/streamed, never inline in `render()` (the Phase 1/2 off-loop lesson).
- Not engine-owned memory/brain (standing principle).

## Approach — staged, de-risk-first

### S0 — Stock Python service (prove value, days)
Run their model **as published**, out-of-process, and measure on the real target GPU:
- Stand up `python -m terrain_diffusion api xandergos/terrain-diffusion-30m` (their built-in API) behind a thin local socket/HTTP shim.
- Tile a region; record **ms/tile**, tile size, VRAM, and visual quality at 30 m/px on the RTX 3050.
- Confirm **seed → identical tile** across two cold runs (their determinism claim) and across two coordinates' overlapping seams (InfiniteDiffusion's seam-consistency).
- **Decision gate:** is per-tile latency compatible with stream-as-you-move (like the Minecraft mod), and is determinism real? If no → stop here with a written finding.

### S1 — The `terrain.*` skill seam (engine side, ~1–2 wks)
Wire the **service** (still Python) into limina as a proper skill, validating the integration contract without yet porting the model:
- New permissioned/traced skills (below), `callTool`-able by scripted + external MCP agents.
- Heavy calls run **off the frame loop**: the request is marshalled onto the agent/action queue; the host posts it to the generator worker; results stream back and are applied between frames (reuse the off-loop marshalling Phase 2 added for windowed external-agent runs).
- Hand-off: heightmap tile → **native Rapier heightfield collider** + a render mesh via `deno_webgpu`/Three; LOD/stream by camera/agent position using the **Phase 3 native spatial op**.
- Determinism/replay: the durable log records the **request** (seed, lod, bounds, hints), not the heightmap bytes; generated tiles are **snapshotted into durable world state** (Phase 4 snapshot recovery) so replay loads cached tiles rather than re-running the model. Regeneration-from-seed is the ideal; the snapshot cache is the cross-device safety net (same caveat as Rapier float determinism).
- **Acceptance:** a scripted/external agent calls `world.generateRegion`, the agent then walks/rolls (Rapier) on the result, two runs of the same seed produce a byte-identical region (replay parity via snapshot), and generation never stalls the frame (measured).

### S2 — Native / wgpu path (weeks, optional, only if S0/S1 pass)
Remove the Python dependency. The model **forward passes** (UNet, autoencoder-x8, diffusion decoder, consistency + coarse models) are the easy part — `candle` or `burn` already do conv/attention and can load the HF weights. The **real work** is porting **InfiniteDiffusion + their `infinite-tensor`** (lazy/unbounded sampling, O(1) random access, seam-consistent tiling) and matching their **numerics**.
- **Backend decision (load-bearing):** prefer **`burn-wgpu` / CubeCL** over CUDA so inference shares the engine's existing `deno_webgpu`/wgpu GPU stack, stays **vendor-neutral** (Vulkan/Metal/DX/WebGPU, not NVIDIA-locked — aligns with the Wayland box and the "don't lock to one vendor" lean), and avoids a separate CUDA toolchain. CUDA (`cudarc`/`burn-cuda`/`tch`) only if measured wgpu throughput can't hit the streaming budget.
- Expect numeric divergence from the reference unless carefully matched; cross-device determinism is its own battle → keep the snapshot cache regardless.

## Skill contract (sketch — to be finalized at kickoff)

All under a new `terrain.*` (or `world.*`) namespace, each with a Zod-typed I/O schema, a permission entry, and EventLoom tracing — identical shape to the existing `scene.*` / `physics.*` / `audio.*` / `ui.*` skills.

| Skill | Input | Output | Notes |
|---|---|---|---|
| `terrain.sampleHeight` | `{ seed, x, z, lod }` | `{ y }` | O(1) point query; cheap; for snapping/queries |
| `world.generateRegion` | `{ seed, bounds, lod, hints? }` | `{ regionId }` (async) | streams tiles; emits `terrain.tile.ready` events; off-loop |
| `terrain.sampleClimate` | `{ seed, x, z }` | `{ tempC, precipMm, biome }` | perception input for player agents |
| `world.streamFollow` | `{ regionId, anchor }` | — | LOD/stream tiles around an agent/camera; uses spatial index |

- **Determinism contract:** outputs are a pure function of `(seed, lod, coords[, hints])`. Tiles are content-addressed and cached; the world log stores the request + a content hash, not the bytes.
- **Off-loop contract:** no skill blocks the frame; long ops return a handle and emit events when tiles land (mirrors bounded multi-turn + the action queue).
- **Permission/governance:** `world.generate*` is a high-cost capability — gated by the Phase 4 policy engine / profiles; rate-limited per session.

## Unknowns to retire (the point of the spike)

1. **ms/tile on RTX 3050** at 30 m/px — does it fit stream-as-you-move?
2. **Determinism reality** — seed→identical across runs, and (if native) cross-framework/device parity.
3. **Tile cache memory** + snapshot size vs the Phase 4 durable-state budget.
4. **`infinite-tensor` port effort** (the bespoke algorithm, not the network) for S2.
5. **Aesthetic fit** — realistic DEM terrain vs the engine's stylized look; where it's actually wanted.

## Recommendation / sequencing

Do **S0 first** (cheapest, highest-signal) and gate on it. Only proceed to **S1** (the skill seam, Python service behind it) if value + determinism hold. Treat **S2** (native wgpu) as a later optimization, not a prerequisite to using the capability. Throughout, hold the standing principles: off the frame loop, deterministic + replayable, engine = substrate (generator behind a skill, never an engine runtime dependency).
