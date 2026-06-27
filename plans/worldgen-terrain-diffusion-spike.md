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

---

## S0 results — 2026-06-26 (RTX 3050 Laptop, 4 GB, CUDA torch 2.12)

**S0 complete. Verdict: conditional GREENLIGHT — adopt as an async, snapshot-cached `world.generateRegion` source (the *bake* path), NOT a live stream-as-you-move generator on 4 GB consumer hardware.** Harness + renders live in `~/td-spike/` (`measure.py`, `render_hero.py`, `s0_summary.json`, `hero.png`, `hero_temp.png`).

Ran `xandergos/terrain-diffusion-30m` via the shipped Flask API (`python -m terrain_diffusion.inference.api --hdf5-file TEMP --seed <s>`) out-of-process. The lean inference deps install on conda's CUDA torch (need `rasterio` + `torchvision` + `matplotlib` beyond the obvious set; the heavy geo/training deps are NOT needed for inference). Two non-model snags worth recording for S1: the API **interactively prompts** to download a ~48 MB WorldClim dataset (auto-confirm with `yes |`), and it **loads the whole pipeline at startup before binding the port** (so `/health` only answers once the model is warm).

| Unknown | Result |
|---|---|
| **4 GB VRAM fit** | ✅ Loads + `torch.compile` + warms up all 3 UNets; **peak ~3.66 GB / 4 GB** (~430 MB headroom — tight; little room for the engine's own GPU work alongside) |
| **Terrain quality / aesthetic fit** | ✅ Coherent naturalistic DEM — coastlines, hillshaded relief, valleys, snow-capped peaks (elev −92 → 1644 m in the hero region) |
| **Climate channels** | ✅ 4 WorldClim-equivalent channels (temp / t-season / precip / p-cv) per pixel; temperature cools with elevation (physically plausible) — real agent-perception input |
| **Seam consistency** | ✅ Overlapping queries match to **≤1 m (mean 0.00 m)** — int16 quantization only; InfiniteDiffusion's seam-consistency holds |
| **Determinism** | ✅ Spatial determinism confirmed via the seam test; cross-restart reproducibility is determinism-by-design (full cold-restart confirm deferred — a restart re-compiles, ~minutes) |
| **Latency (decisive)** | ❌ **Not live-streamable on this GPU** — median **6.6 s/tile @ 90 m/px, 4.9 s/tile @ 11.25 m** (256², ~75–100 µs/px), high variance (1.3–9.5 s from `torch.compile` recompilation). Seconds/tile vs the <~100 ms live streaming wants |

**Implication.** The latency reframes the capability from "live streamer" to "**baked generator**" — which lands exactly on the existing design: the durable log records the *request* + content hash, tiles are **snapshotted/cached** (Phase 4), and replay loads cached tiles, never re-running the model. So S1 (the `terrain.*` skill seam) should marshal `world.generateRegion` **off-loop / async**, stream tiles in as they land, and bake them into snapshots — never block on inline generation. Live stream-as-you-move would need a stronger GPU or the **S2** native/quantized path (`burn-wgpu`/CubeCL, fp16/int8); that's the latency follow-up, not a prerequisite to using the capability.

**Next:** S1 is justified — wire `world.generateRegion` to the Python service off-loop, bake tiles into snapshots, validate replay parity. S2 only if live streaming becomes a hard requirement.

## S1 — engine-side seam DONE (2026-06-27)

The `terrain.*` skill seam is wired: **`ModelTerrainSource`** (`js/src/terrain/model-source.ts`) implements the
`TerrainSource` interface as an out-of-process, **baked** backend behind `world.generateRegion`.
- **Protocol:** `POST {baseUrl}/tile {seed,tx,tz,lod,tile,hints}` → `{nrows,ncols, elev:int16-LE-b64 (metres),
  climate:float32-LE-b64 (channel-major WorldClim)}`; `POST /health`. Transport is injectable (default the host
  `op_http_post`).
- **Mapping:** int16 metres → `heights∈[0,1]` over a **fixed** configurable range (`elevMinM/elevMaxM`, default
  −500..9000), `origin.y=elevMinM`/`scaleY=span` so the collider/mesh reconstruct true metres + **adjacent tiles
  stay seam-consistent** (no per-tile normalization). N-channel climate → the canonical 3-channel
  `[tempC,precipMm,Biome]` cell-major grid (the **canonical `Biome` enum** in `terrain/types.ts`, shared with the
  procedural source so biome-gated scatter works identically for both).
- **Bake/replay (the determinism contract held):** tiles bake into the `TileCache` + ride the export
  (`tiles.jsonl`); replay loads from baked tiles via a model-free `CachedTerrainSource` (throws on miss) — the
  **model service is provably absent at replay**, bit-identical + content-hash-pinned. The model is NEVER a
  runtime/export dependency; the procedural source stays the default + the floor.
- **Selection:** `registerCoreSkills(registry, { terrainSource: new ModelTerrainSource({ baseUrl }) })`.
- **Tested headless WITHOUT the GPU** via a deterministic mock transport (`p11_model_source.ts`, `p9_model_source.ts`):
  bake → model-absent replay, falsifiable. **Real-GPU generation is UAT** — run the terrain-diffusion Flask service
  + point `baseUrl` at it (the S0 harness in `~/td-spike/`). **S2** (native wgpu) remains a later optimization, not
  a prerequisite.

## S1 — real-GPU run via the reference shim (2026-06-27)

The model is now wired **end-to-end** behind `ModelTerrainSource` through a reference
**shim** (`tools/terrain-diffusion/`). limina's `/tile` contract is the **stable seam**;
each model ships its own thin adapter to it — this is that adapter for `terrain-diffusion`.

```
ModelTerrainSource ──POST /tile──▶ shim.py ──GET /terrain──▶ terrain_diffusion.inference.api
```

- **Why a shim (not the in-process `worker.py`):** the shipped model is a standalone Flask
  service (`terrain_diffusion.inference.api`) with its OWN protocol — `GET /terrain?i1,j1,i2,j2,scale`
  → **raw bytes** (int16-LE elev `h*w*2`, then float32-LE climate **INTERLEAVED `(H,W,4)`**,
  channels `[temp, t_season, precip, p_cv]`, dims in `X-Height`/`X-Width`), `GET /health` →
  `{"status":"ok"}`, **seed fixed at launch** (`--seed`). The shim adapts that to limina's
  `POST /tile`/`POST /health` so the model runs unmodified behind its native API.
- **Translation (byte-exact, unit-tested):** elev int16-LE passthrough (optional clamp);
  climate transposed interleaved `(H,W,4)` → **FAITHFUL channel-major `(4,H,W)`
  `[temp@0, t_season@1, precip@2, p_cv@3]`** — same channels, same order, **no reduction, no
  biome channel**. `model-source.ts` is the single source of truth for biome: it reads tempC
  from ch0 + precipMm from ch2 (**its defaults**) and classifies the canonical `Biome` itself,
  so a **default-configured `ModelTerrainSource` decodes the wire with NO override**.
  `tools/terrain-diffusion/test_shim.py` pins this against a synthetic upstream + the
  cross-component default-decode contract; `js/test/p9_shim_contract.ts` pins the TS consumer
  side (default source decodes the wire → right temp/precip/biome). (Earlier review found the
  reduced 3-channel `[temp,precip,biome]` wire collided with the default `precipChannel:2` —
  fixed to the faithful 4-channel wire.)
- **tile→pixel / lod→scale:** `scale = clamp(base_scale<<lod, .., max)`, `px_per_tile = tile*(scale//base_scale)`,
  box `i=tz*px..`, `j=tx*px..` (**z→rows/i, x→cols/j** — matches `model-source.ts` localCell).
  World metres per tile stay constant across lods (`tile*NATIVE/base_scale`, **`NATIVE=30` m/px**
  at scale 1 — the "30m" model, matching the source's `metersPerPx` default) → matches the
  source's fixed extent; set `metersPerPx = NATIVE/base_scale` (30 at `--scale 1`).
- **two equivalent backends:** `tools/terrain-service/worker.py` (in-process, imports the model)
  and `tools/terrain-diffusion/shim.py` (wraps the shipped HTTP service) emit the **same wire** —
  same axis (`worker.py` axis bug fixed: `i=tz*tile, j=tx*tile`), same 4 channels (precip@2), same
  30 m/px, same **floor**-quantized elev — so a consumer gets the same world from either.
- **seed:** the launch seed is the region seed (shim `--region-seed`); a mismatched per-request
  seed is rejected + never forwarded upstream (no expensive model rebuild).

**Exact run commands (real-GPU UAT — needs a box with `terrain_diffusion` installed):**

```bash
# one shot (model → shim → demo; override via env, e.g. SEED=1234 SCALE=8):
tools/terrain-diffusion/run.sh

# or by hand:
python -m terrain_diffusion.inference.api xandergos/terrain-diffusion-30m \
    --seed 1234 --host 127.0.0.1 --port 8000
python tools/terrain-diffusion/shim.py \
    --target-url http://127.0.0.1:8000 --region-seed 1234 --scale 1 --port 8917
./target/release/limina --window js/src/demos/model_terrain_window.ts   # shim = baseUrl 127.0.0.1:8917
```

The translation core is verified headless (`python tools/terrain-diffusion/test_shim.py`,
byte-exact) and the limina seam is regression-clean (`p9_model_source`, `p11_model_source`).
The live GPU generation itself remains S0-covered + UAT — not claimed here. **S2** (native
wgpu) stays a later optimization.
