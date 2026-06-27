# World Generation Roadmap

> What the terrain-diffusion S0 experiment taught us, turned into a plan. Two goals:
> (1) make limina's **native** procedural generator much better using cheap techniques
> borrowed from InfiniteDiffusion, and (2) finish the **pluggable backend** so external
> terrain models can be *leveraged* for agent world generation **without ever becoming an
> engine, runtime, or export dependency**.
>
> Companion to [`worldgen-terrain-diffusion-spike.md`](./worldgen-terrain-diffusion-spike.md)
> (the S0 evidence) and [`post-mvp-roadmap.md`](./post-mvp-roadmap.md). Extends the Phase 9
> terrain work; the new generation quality lands in Phase 11 (Content & Assets) territory.
>
> **Status — QUEUED as the Phase 11 generator-richness polish round (2026-06).** The Phase 11 foundation
> shipped + its acceptance gate is met (the cottage-on-a-beach reads right), but the terrain is still a flat
> sand dome and the water is a basic plane. This roadmap is the next round. **Start with W1 — domain warping
> + ridged terrain + a real sand material** (cheapest, no deps, no erosion sim — turns the flat dome into
> dune-charactered sand); then W2 (erosion/climate) and the render-only water upgrade (foam/caustics).

## What the experiment settled

- **Generation is an authoring step, not a play-time one.** An agent calls `world.generateRegion`
  while authoring; the result bakes into the durable log + snapshots; the player (browser /
  native / mobile) replays the baked world and never runs a generator. This is the only model
  consistent with "author once, export everywhere, the deterministic log is the portable artifact."
- **No generator is ever a runtime/export dependency.** The shipped world is finite, baked, and
  replayable. Generation backends sit *behind a skill seam* and feed it; the log records the
  *request* + a content hash, snapshots cache the tiles, replay loads the cache.
- **A learned model (TerrainDiffusion) buys realism but is heavy + research-grade.** It fits a
  4 GB GPU (~3.66 GB peak) and the quality is genuinely good (coastlines, drainage, snow), but at
  seconds/tile it's a *baked* source, not a live one, and it's a single-author research repo. So it
  belongs **out-of-process, optional, behind the seam** — never vendored into the engine.
- **The realism gap between plain noise and the model is mostly recoverable cheaply.** The model's
  edge is drainage/erosion, ridged mountains, organic coastlines, and climate channels — most of
  which classic procedural techniques reproduce at ~80% for near-zero overhead.

## The seam already exists (Phase 9) — this is what we build on

- **`js/src/terrain/types.ts` — `TerrainSource`**: the interface every backend implements
  (`generateTile` / `sampleHeight` / `sampleClimate`).
- **`js/src/terrain/procedural.ts` — `ProceduralTerrainSource`**: the built-in default. Value-noise
  `fbm` elevation + a basic `(tempC, precipMm)` climate field + `biomeOf()` quantization. Zero deps,
  deterministic, O(1) random access, runs headless + in-browser. **This is the floor — always present.**
- **`js/src/terrain/tilecache.ts` — `TileCache` + `CachedTerrainSource`**: the bake/replay path. The
  log stores the request + content hash; tiles are cached + snapshotted; replay reads the cache and
  never re-runs a generator.
- **`js/src/terrain/model-source.ts`**: the scaffold for a *model-backed* `TerrainSource` — where an
  external generator plugs in. (Completed in W4.)
- **Skills (`js/src/skills/terrain.ts`)**: `world.generateRegion`, `world.streamFollow`,
  `terrain.sampleHeight`, `terrain.sampleClimate` (perms `terrain.generate` / `terrain.read`).
  `registerCoreSkills` wires `ProceduralTerrainSource` by default and accepts `opts.terrainSource` to
  swap the backend.

The architecture is right. This roadmap raises the *quality* of the procedural backend and *completes*
the external-model adapter — it does not re-plumb the seam.

## Pillar A — Leverage models, never depend on them (complete the seam)

`world.generateRegion(seed, bounds, hints)` → a registered `TerrainSource` → heightmap + climate →
native post-passes (climate / erosion / biome scatter) → baked tiles (Rapier heightfield collider via
`op_physics_add_heightfield` + render mesh) → log(request + hash) + snapshot cache.

Backends behind the one interface:
- **procedural** (built-in, zero-dep) — the default + the floor.
- **external model adapter** (out-of-process) — e.g. TerrainDiffusion via its local service; the engine
  *calls* it, never imports it; output is baked + content-addressed.
- **cache** (`CachedTerrainSource`) — the replay/playback source; what a shipped world actually uses.

Key property: the **native post-passes run on _any_ backend's heightmap**, so the cheap climate +
erosion improve procedural *and* refine a model's output — they compose. If a model backend disappears,
existing worlds still replay (baked) and procedural still generates new ones.

## Pillar B — Steal the techniques into the native generator (cheap-first)

Borrow the *methods* that make the diffusion output look good, not the weights:

1. **Domain warping + ridged multifractal** (`procedural.ts`, ~free). Warp the noise input by another
   noise field for organic coastlines/meanders; add a ridged variant for sharp mountain ridgelines
   instead of round blobs. A few extra noise evals per sample, still O(1), no deps.
2. **A real climate model** (`procedural.ts`, ~free). Replace the basic `(tempC, precipMm)` with
   temperature from elevation lapse-rate + latitude, and precipitation from windward/lee rain-shadow.
   Pays off twice: richer agent perception channels (same shape the model offered) **and** biome-aware
   scatter (`scatter.ts` / `props.ts`) — forests in wet temperate bands, bare rock up high, desert in
   dry zones, instead of uniform sprinkling.
3. **Hydraulic + thermal erosion** (new, bake-time). The #1 visual gap: coherent drainage. A droplet/
   grid erosion pass carves valleys + realistic slopes. **Authoring-time only** (paid once, baked into
   snapshots — never at play time), so cost is acceptable. The one wrinkle is tile-seam continuity
   (water crosses tile edges); handle by eroding padded/overlapping tiles or eroding a coarse layer then
   adding fine noise on top.
4. **Coarse→fine + agent control map** (`procedural.ts` + skill input). A low-frequency continent/biome
   guide the agent *steers* via `generateRegion` hints (land here, sea there, a ridge along this line),
   which noise + erosion detail in — the "agent sketches intent, the deterministic generator builds it"
   model (see the agent-configurable-generation-seeds note).

## Phased plan (cheap + dependency-light first)

| Phase | Work | Deps added | Cost |
|---|---|---|---|
| **W1 — Procedural quick wins** | Domain warping + ridged multifractal + the real climate model; biome-aware scatter; confirm the `TerrainSource` contract + content-addressed tiles hold. | none | low (free per-sample) |
| **W2 — Erosion bake pass** | Hydraulic + thermal erosion as an authoring-time pass over the heightmap, baked into snapshots; tile-seam handling. The big drainage win. | none | bake-time only |
| **W3 — Agent control + coarse→fine** | Steerable coarse continent/biome guide via `generateRegion` hints, detailed by noise + erosion; the sketch→detail conditioning loop. | none | low |
| **W4 — External model backend** | Finish `model-source.ts` as an **out-of-process** adapter; ship TerrainDiffusion as the first external backend (the spike's S1) — off-loop, baked, content-addressed; native climate/erosion composable on top. | optional, out-of-process | medium |
| **W5 — Native/quantized model port (deferred)** | Port the model to native wgpu/burn (the spike's S2) — only if self-hosted or live model generation ever becomes a hard requirement. Owns the implementation. | none (replaces the external service) | high; deferred |

W1–W3 are pure native engine work (no new dependencies) and make the *free default* dramatically
better. W4 formalizes "plug in a model" without coupling. W5 is a real-but-deferred optimization.

## Non-goals (the dependency boundary, on paper)

- **No generator in the engine, runtime, or export.** Backends are out-of-process or pure native code
  behind `TerrainSource`; the shipped artifact is baked tiles + log + snapshots.
- **No play-time generation in the default product.** Generation is an authoring step; players replay.
  (Infinite/streamed play-time worlds would be a different product thesis — out of scope here.)
- **No hard dependency on any single backend.** Procedural is the floor; external models are optional
  and swappable; the log/replay depend on none of them.

## Verification (all headless-checkable for the native work)

- **Determinism**: same `(seed, bounds, lod)` → byte-identical tiles (hash); two cold runs match. Erosion
  output is deterministic for a fixed seed + iteration count.
- **Climate channels present + sane**: temperature falls with elevation + latitude; rain-shadow on the lee.
- **Erosion improves drainage measurably** (e.g. flow-accumulation / valley connectivity up vs. raw noise),
  not just "looks better."
- **Replay parity**: a generated region bakes to snapshots; replay loads cached tiles, byte-identical, with
  no generator present (proves the runtime/export dependency-free claim).
- **Backend swap**: the same skills + tests pass with procedural and with the model adapter; the model
  backend stays out-of-process and optional (omitting it falls back to procedural).
- **Runs everywhere**: procedural generates headless + in-browser (no native/GPU model required).

## Companion thread — liquid / water rendering (render-only)

A natural pairing with terrain: render a **water surface at the world's sea level** (which the climate
fields already know) over the generated coastlines — oceans, lakes, shorelines. Technique reference:
[`jeantimex/threejs-water`](https://github.com/jeantimex/threejs-water) (MIT) — the canonical Evan
Wallace WebGL Water: GPU height-field wave sim, **caustics**, Fresnel refraction/reflection. **Borrow the
techniques, not the code** — it's WebGL/GLSL and a single-author demo; limina is WebGPU, so the math ports
to TSL/node materials, the shaders don't. Two halves land in different layers:
- **Water rendering** (ripples, caustics, refraction) → a **render-only** cosmetic layer, recomputed from
  state, never in the log, zero replay impact (exactly like prop scatter). This is the safe, high-value win.
- **Water *physics*** (buoyancy, swimming, displacement as gameplay) → deterministic Rapier/ECS sim, a
  separate + harder effort; never lifted from the demo's frame-coupled physics.

Visual polish, not critical path — sequence it after the terrain wins, not ahead of Phase 11 assets.

## Where it fits

W1–W3 deepen Phase 9 (terrain) and slot into Phase 11 (Content & Assets) as the generation-quality
thread. W4 is the spike's S1 (the `terrain.*` skill seam around a model service). W5 is the spike's S2.
The engine stays the substrate: the generator is always behind a skill, the output always baked, the
portable log always the source of truth.
