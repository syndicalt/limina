# Plan — Phase 9: Worlds Worth Authoring (S1 — the `terrain.*` skill seam)

> Kickoff plan for **Phase 9** of [`post-mvp-roadmap.md`](./post-mvp-roadmap.md) — learned world generation as
> a first-class skill.
> **Goal:** an agent sketches a large naturalistic region that a learned generator details — infinite,
> deterministic, streamed **off the frame loop** — and it ships everywhere via the Phase 8 export.
> **Gate:** a scripted/external agent calls `world.generateRegion`; tiles stream in **without dropping a
> frame**; an agent walks/rolls on the result (native Rapier); **two runs of the same seed reproduce the
> region** (replay parity via snapshot); and the generated world **plays back in a browser tab** from cached
> tiles (riding Phase 8) — **no model on the playback side**.
> **Builds on (shipped):** the **S0 greenlight** (`spikes/s0-terrain-diffusion/RESULT.md` — InfiniteDiffusion
> on the RTX 3050: seed→**bit-identical** elev+climate, 1.16 GB fp16, ~0.87 s/tile amortized), the skill
> registry + policy engine (typed/permissioned/traced skills), the durable world log + **snapshot recovery**
> (`worldlog/`), the off-loop action queue, the Phase 3 native spatial op, and the **Phase 8 export/playback**
> (record the request, snapshot the output, replay from the snapshot).
> **Status:** not started.

## The spine: record the request, snapshot the output (same pattern as Phase 8)

Phase 8 records skill commands and carries physics **output** as keyframes so the browser never re-simulates.
Phase 9 is the same shape one level up: the durable log records the **`world.generateRegion` request**
(`seed, bounds, lod, hints`) — a deterministic input — and the generated **tiles** (heightmap + 5-channel
climate, the expensive model output) are **snapshotted into durable world state and carried in the Phase 8
export**. Replay and browser playback load the **cached tiles**; the diffusion model runs **only at authoring
time, on the author's machine**. This keeps replay deterministic across devices (the S0 caveat: same-machine
determinism is exact, cross-device is not guaranteed — the snapshot cache is the safety net) and means end
users get the world without a GPU model dependency. The generator is always **behind a skill, never an engine
runtime dependency**.

## Load-bearing decisions (get these right first)

1. **New native op: `op_physics_add_heightfield`** (the genuinely-new native/Rust work). Rapier3d already
   supports heightfield colliders (`ColliderBuilder::heightfield`); we expose one op:
   `op_physics_add_heightfield(x,y,z, nrows, ncols, scaleX, scaleY, scaleZ, heights: Float32Array) -> bodyId`
   (a static collider; returns an id so streaming can remove far tiles). The **height samples come from the
   tile cache/snapshot, not from the log** — a 256×256 tile is 256 KB, far too large to put in the JSONL
   command stream. So the log records the `generateRegion` request; the **tile-application path** (from cache
   or snapshot) calls `op_physics_add_heightfield`. On replay, `op_physics_restore` brings back the snapshotted
   physics world (heightfields included), or the cached tiles are re-applied — either way the model is never
   re-run.
2. **The generator runs off the frame loop, behind a skill** (S1 = Python service first). `world.generateRegion`
   marshals the request onto the action queue; the host posts it to the generator worker; tiles stream back and
   are applied **between frames** (reuse the Phase 2 off-loop marshalling). No skill blocks `render()`.
3. **fp16 + contiguous prefetch** (per S0). Stream a contiguous window **ahead of** a walking/driving agent
   (~0.87 s/tile amortized). NOT viable for per-frame generation or teleport-and-see — `world.streamFollow`
   prefetches around the agent using the spatial op; random isolated access (5.5 s/tile) is the slow path to
   avoid.
4. **Climate is perception, not just visuals.** The model emits temp/seasonality/precip per coordinate for
   free; `terrain.sampleClimate` feeds it straight into the agent perception substrate.

## Skill contract (finalize at kickoff)

All under `terrain.*` / `world.*`, each Zod-typed, permissioned, and traced — same shape as `scene.*`/`physics.*`.

| Skill | Input | Output | Notes |
|---|---|---|---|
| `world.generateRegion` | `{ seed, bounds, lod, hints? }` | `{ regionId }` (async) | streams tiles; emits `terrain.tile.ready`; off-loop; **high-cost, policy-gated + rate-limited** |
| `terrain.sampleHeight` | `{ seed, x, z, lod }` | `{ y }` | O(1) point query (snapping/queries) |
| `terrain.sampleClimate` | `{ seed, x, z }` | `{ tempC, precipMm, biome }` | perception input |
| `world.streamFollow` | `{ regionId, anchor }` | — | LOD/stream tiles around an agent/camera via the spatial op |

- **Determinism contract:** outputs are a pure function of `(seed, lod, coords[, hints])`; tiles are
  content-addressed; the log stores the **request + a content hash**, not the bytes.
- **Off-loop contract:** no skill blocks the frame; long ops return a handle and emit events when tiles land.

## Workstreams

### A. Native heightfield collider op (Rust) — verified headlessly
- Add `op_physics_add_heightfield` (Rapier `heightfield`), its `EngineOps` type, and its recorded-command /
  replay plumbing (`PHYSICS_OP_FN`, the recorder, the keyframe/snapshot path). Returns a body id; removable for
  streaming.
- **Verify (headless):** a sphere dropped onto a heightfield **settles on the surface** (not through it),
  raycasts hit it, and a recorded session **replays bit-identically** (the heightfield restores from snapshot;
  same `compareWorldState` gate as Phase 4/8). This is the one piece that's fully headless-provable.

### B. The `terrain.*` / `world.*` skill seam (engine) — verified headlessly
- The 4 skills above: typed I/O, permission entries (`world.generate` high-cost), tracing, off-loop
  marshalling onto the action queue, the durable log recording the **request** (+ content hash).
- **Verify (headless):** the skills are policy-gated + traced; `world.generateRegion` records the request in the
  log and emits `terrain.tile.ready` as (stubbed/cached) tiles land; a fake generator (returns a fixed
  heightmap) lets the whole seam + the heightfield hand-off + replay-parity be tested **without the model**.

### C. The generator service + IPC (S1) — service logic verified; GPU/model via the S0 harness
- Wire the **S0-greenlit Python service** (`xandergos/terrain-diffusion`, fp16) behind `world.generateRegion`:
  a thin local socket/HTTP worker the host posts requests to; tiles (heightmap + climate) stream back off-loop.
- **Verify:** the S0 harness already proves the model (determinism + latency + VRAM). Here, verify the **IPC +
  marshalling** (request → worker → tiles applied between frames) with the real service on the dev box; the
  diffusion output itself is S0-covered.

### D. Tile → render mesh + LOD/stream — logic headless, visual via UAT
- Heightmap tile → a Three render mesh (alongside the Rapier heightfield); `world.streamFollow` prefetches a
  contiguous window around the agent via the Phase 3 spatial op; far tiles are removed (body id + mesh).
- **Verify (headless):** the stream/LOD bookkeeping (which tiles in/out around an anchor) is unit-testable; the
  rendered terrain is **UAT** (needs the GPU).

### E. Snapshot + export integration — verified headlessly
- Generated tiles are **snapshotted into durable world state** and **carried in the Phase 8 export package**
  (a new `tiles/` alongside `keyframes.jsonl`); replay + browser playback load cached tiles.
- **Verify (headless):** record a `generateRegion` (fake or real generator) → snapshot the tile → replay loads
  the cached tile → **bit-identical** region (the gate's replay-parity); the export round-trips the tiles.

## Verification split (honest, like Phase 8)
- **Headless (CI):** the heightfield op (settle + raycast + replay-parity), the skill seam (typed/permissioned/
  traced, request logged), replay-parity via snapshot, the export round-trip, the stream/LOD bookkeeping — all
  provable with a **fake generator** so they don't need the model.
- **The S0 harness (dev GPU):** the diffusion model itself — already **greenlit** (determinism + latency + VRAM
  measured).
- **UAT (browser + author GPU):** an agent sketches a region, it streams in without a frame drop, an agent rolls
  on it, and the generated world plays back in a browser tab from the cached tiles.

## Smallest first cut (and what's deferred)
First cut: a scripted agent calls `world.generateRegion` for one region; a real heightfield collider is built;
a sphere rolls on it; the session **replays bit-identically via snapshot**; and the region **plays back in a
browser tab** from the cached tiles (riding Phase 8). Use the real S0 service on the dev box for the authoring
GPU path; a **fake generator** for all headless tests. Defer: `world.streamFollow` infinite LOD streaming,
climate-driven agent behavior, the Azgaar/human sketch import, and S2.

## Out of scope (deferred)
- **S2 — native wgpu port** (`burn-wgpu`/CubeCL, removing Python). A later optimization, not a prerequisite.
- **Live in-browser generation.** The model runs author-side (native); the browser plays back cached tiles.
  This is deliberate and consistent with Phase 8.
- **The sim-worker / SAB live-runtime architecture** — a *separate track* (see roadmap note). Phase 9 does NOT
  need it: generation is native/off-loop and playback is the Phase 8 main-thread path.
- Ecosystem/registry (**Phase 10**).

## Open questions (decide at kickoff)
1. **Heightfield op data path** — pass the full `Float32Array` per tile across the op each apply, vs a handle
   into a host-side tile store. Tile/snapshot size vs the Phase 4 durable-state budget.
2. **IPC transport** — local socket vs HTTP vs stdio to the Python worker; lifecycle (spawn/health/restart).
3. **LOD scheme** — fixed tile grid vs quadtree; how `lod` maps to InfiniteDiffusion's coarse/detail stages.
4. **Where the service lives** — bundled dev tool vs a documented external process; not shipped to end users
   (they replay cached tiles).
5. **Climate → perception depth** — expose raw channels vs a derived `biome` enum to player agents.
6. **Export tile format** — content-addressed binary tiles vs reuse the keyframe-style bit-exact JSONL.

---

## Status & outcomes (implemented — first cut)

- **Native heightfield op — DONE, verified.** `op_physics_add_heightfield` (Rapier `Array2` heightfield,
  rows→z cols→x, surface = heights×scaleY). `js/test/p9_heightfield.ts`: a sphere settles exactly a radius
  above the raycast-found surface, **bit-identical across two runs** (the replay-parity basis), and the grid
  shape is genuinely read (corner Δheight 3.2 m).
- **Terrain skill seam + replay/export — DONE, replay BIT-IDENTICAL + falsifiable.** `ProceduralTerrainSource`
  (a real deterministic value-noise generator — no `Math.random`/`sin`), the 4 typed/permissioned/traced
  skills (`world.generateRegion` applies tiles via nested `op_physics_add_heightfield` + records ONLY the
  request, never the bytes; `terrain.sampleHeight`/`sampleClimate`/`world.streamFollow`), a content-addressed
  `TileCache` + `CachedTerrainSource` (throws on miss), and the Phase-8 export extended with a bit-exact
  `tiles.jsonl` artifact (Float32 bit-pattern hashing). `js/test/p9_terrain.ts`: a recorded session (generate
  a region → drop a sphere on the terrain → step) replays into a FRESH world via an independent source →
  **bit-identical** (`compareWorldState`), seed-corruption diverges, the export's reloaded tiles + a
  model-free `CachedTerrainSource` reconstruct the world exactly.
- **Model service — IPC verified + a REAL diffusion tile ran on the dev GPU.** `ModelTerrainSource` over HTTP
  IPC + a Python worker mirroring the S0 pipeline (fp16); `js/test/p9_model_source.ts` verifies the IPC +
  wire-format + lifecycle headlessly (mock), and one real 256² diffusion tile was generated end-to-end on the
  RTX 3050 (real elev+climate, byte-identical on re-request). The model is **author-side only**.
- **Render mesh + LOD — geometry verified, render UAT.** `terrainTileGeometry` (pure) + `StreamFollower`
  (pure set math) + a THREE wrapper wired into `browser-entry`. `js/test/p9_terrain_mesh.ts`: **drop-test
  parity** (mesh surface == collider surface), no stream thrash/gaps. The in-tab WebGPU draw is UAT.
- **Adversarial review — core CLEAR, 1 bug + 2 notes fixed.** Verified: determinism real, replay genuine +
  falsifiable, cache content-addressed + bit-exact, log carries only the request, op + stream correct. Fixed:
  browser terrain LOAD (fetch `tiles.jsonl`; `installOps` before load; skip the sync hash check when the host
  has no `op_sha256`), `requestKey` hint-collision (JSON-encoded), and `CachedTerrainSource` point queries now
  bilinear-sample the cached tile (correct for reloaded model worlds).
- **Verification:** 61/61 runnable headless tests pass, 0 regressions; browser bundle builds; portability
  guard PASS.
- **Known limitations (first-cut follow-ups):** browser tile **integrity** verification is skipped (the
  browser has no sync sha256 — re-verify async via WebCrypto before load); `sampleHeight` is double-precision
  vs the f32 collider (snapping-grade, not bit-exact mid-cell); mesh vs collider triangulation can disagree
  mid-cell (visual only); the off-loop marshalling (action queue) wraps the synchronous-apply first cut later;
  S2 native-wgpu port and live in-browser generation remain out of scope.
