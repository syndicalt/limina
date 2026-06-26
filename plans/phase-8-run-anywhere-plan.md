# Plan — Phase 8: Run Anywhere

> Kickoff plan for **Phase 8** of [`post-mvp-roadmap.md`](./post-mvp-roadmap.md) — the headline
> *author-once / export-everywhere* phase.
> **Goal:** the same world authored on native **runs in a browser tab** (and on a phone), via a thin
> browser/WebGPU runtime, with **one-command export**.
> **Gate:** a world authored on native exports and runs in a browser tab — and a phone — playing back at
> parity within the W0-chosen tolerance, **confirmed by browser UAT** (see below).
> **Builds on (shipped):** the Phase 6 **host-capabilities boundary** (`engine.ts` `installOps()` +
> `RenderOps`/`PhysicsOps`/`TraceOps` sub-surfaces), the **host-agnostic replay** (`worldlog/replay.ts`
> `replayCommands`), the **portable JSONL log + transform capture** (`worldlog/log.ts:316` `captureWorldState`
> reads `op_physics_body_transform` → `[pos,quat]`), the durable trace seam (`worldlog/durable.ts`), and the
> W0 **export contract = snapshot-keyframe** ([`web-export-portability-spike.md`](./web-export-portability-spike.md)).
> **Status:** not started.

## The one hard reality up front: verification

I **cannot fully verify Phase 8 in the headless dev environment** (no browser → no real WebGPU render, no
in-tab run) — unlike Phases 6–7, which the native test suite verified end-to-end. So this plan splits
verification explicitly:

- **What gets verified headlessly (by me, in CI/tests):** the keyframe capture + format, the export
  packager, the browser bundle *builds* (esbuild), the replay logic, the keyframe-driven `PhysicsOps`
  adapter (unit), the IndexedDB `TraceOps` logic, and the Phase-6 no-`Deno`-global portability guard
  extended to the browser entry.
- **What requires browser UAT (by a human):** the actual in-tab **WebGPU render**, the world **playing
  back** in the tab, and the **phone** run. A concrete UAT checklist is in this plan.

This is honest, not a gap to paper over: the engine-facing logic is testable; the GPU/visual layer is
human-confirmed.

## Two modes — scope the first cut to playback

There are two distinct browser targets; **the first cut is (A)**:

- **(A) Export-playback** — *"the same world runs in a tab."* Ship a native-authored world as a portable
  package; a thin browser runtime **replays the skill-command log** (`replayCommands`, already host-agnostic)
  and **applies transform keyframes** for physics state (NO live simulation), rendering via Three
  `WebGPURenderer` on the browser's `navigator.gpu`. Deterministic, simpler, and exactly the W0 contract.
- **(B) Live browser authoring** *(deferred to a later stage)* — the full engine running in the tab with a
  **wasm-Rapier** `PhysicsOps` adapter so an agent can author live in the browser. Heavier; physics won't
  match native (W0), which is fine for a fresh browser-authored run, but it is not needed for the headline
  and is out of scope for the first cut.

The key consequence: **(A) needs no wasm Rapier.** Physics state comes from keyframes, so the browser's
`PhysicsOps` is a *keyframe-driven* implementation (body handles + transforms served from the keyframe
stream), not a simulator.

## Load-bearing decisions (get these right first)

1. **Browser physics = keyframe-driven (playback), not wasm-Rapier (first cut).** During replay, skills
   re-invoke and call `op_physics_add_*` / `op_physics_body_transform` through `ctx.ops`. The browser
   `PhysicsOps` registers body handles on `add_*`, treats `op_physics_step` as a no-op, and returns the
   **keyframe-interpolated** transform for the current tick from `op_physics_body_transform`. This replays
   the native-authored motion *exactly* (the keyframes ARE the native transforms) with zero sim divergence.
   wasm-Rapier is mode (B) only.
2. **The export package format** (hard-to-reverse — the runtime depends on it): `{ manifest.json, log.jsonl,
   keyframes.jsonl, assets/ }`. `manifest` = world id, engine/log version, keyframe interval, asset
   refs, tick count, camera/scene seed. `log.jsonl` = the existing recorder output (seed + skill + physics
   commands). `keyframes.jsonl` = periodic `{ tick, bodies:[{bodyId,pos,quat}], ecs:[{eid,pos,rot,scale}] }`
   records. Content-addressed assets. The JSONL log stays the canonical artifact (commands + hashes, never
   runtime bytes — the standing invariant).
3. **The browser host (`EngineHost`)** implements three sub-surfaces and injects via `installOps()`:
   - **`RenderOps`** — `op_create_window_context()` → `canvas.getContext("webgpu")`; the loop ops
     (`op_set_fixed_step_callback`/`op_set_frame_callback`/`op_set_resize_callback`) store callbacks driven
     by a **requestAnimationFrame accumulator** mirroring `windowed.rs:146-177` (FIXED_DT 1/60,
     MAX_STEPS_PER_FRAME 5); `op_surface_present` is a no-op (the canvas auto-presents); `op_surface_resize`
     reconfigures the canvas; `op_input_axes` reads keyboard/touch.
   - **`TraceOps`** — `op_write_trace`/`op_append_trace`/`op_read_trace` over **IndexedDB** (or OPFS).
   - **`PhysicsOps`** — keyframe-driven (decision 1).
4. **Bundling.** A new `js/src/browser-entry.ts` (imports the engine + the existing `build/*.bundle.mjs`),
   bundled for the browser via `esbuild --platform=browser` (the repo already uses esbuild;
   `js/package.json:bundle:three`). Every `Deno.*` is already gated (`typeof Deno !== "undefined"`, Phase 6)
   — the portability guard (`js/scripts/check-host-portability.mjs`) extends to the browser entry.

## Workstreams

### A. Keyframe export (engine, native side) — verified headlessly
- Add a **keyframe capture** that, every N ticks during a recorded session, emits a transform keyframe
  (reuse the exact `op_physics_body_transform` read in `worldlog/log.ts:316-338` `captureWorldState` + the
  ECS SoA) into a `keyframes.jsonl` sink alongside the durable log.
- Add the **one-command exporter**: `{ manifest, log.jsonl, keyframes.jsonl, assets/ }`.
- **Verify (headless):** a test records a small physics world, exports it, and asserts the keyframe stream's
  transforms match `op_physics_body_transform` at those ticks (no drift), and the package round-trips.

### B. Browser host (`EngineHost`) — logic verified headlessly, GPU via UAT
- Implement `RenderOps` (canvas WebGPU context + the rAF accumulator loop + input), `TraceOps` (IndexedDB),
  `PhysicsOps` (keyframe-driven). `installOps(browserHost)` before any engine code runs.
- **Verify (headless):** unit-test the keyframe-driven `PhysicsOps` (handles + interpolated transforms) and
  the IndexedDB `TraceOps` logic (against a fake-IndexedDB). The rAF loop + WebGPU context are **UAT**.

### C. Browser runtime + bundling — builds verified headlessly, run via UAT
- `js/src/browser-entry.ts`: construct the browser host, `installOps`, load an exported package, build a
  `WorldContext` + `SkillRegistry`, `replayCommands(log, {makeWorld, makeRegistry})` to rebuild the world,
  drive the rAF loop applying keyframes, render via `WebGPURenderer`.
- A minimal static page (`web/` or a route) that loads the bundle + a sample exported world.
- **Verify (headless):** the bundle builds clean via esbuild for `--platform=browser`; the portability guard
  passes on the browser entry. **The actual in-tab render + playback is UAT.**

### D. Live wasm-Rapier authoring — DEFERRED (later stage)
A wasm-Rapier `PhysicsOps` adapter (the W0 `spikes/w0-physics-parity/wasm_dump.mjs` is the starting point)
for live in-browser authoring. Out of scope for the first cut.

## UAT verification (human, in a real browser) — the acceptance proof

After the headless pieces are green, the human runs this in **Chrome/Edge (desktop, WebGPU on)** and a
**phone** (iOS 18+/Android Chrome). I'll provide the served build + a sample exported world.

1. **Loads & renders.** Open the served page → a canvas appears and the **3D scene renders** (no WebGPU
   errors in console; the WebGL2 fallback note appears only where WebGPU is unavailable).
2. **Plays back.** The exported world's recorded session **plays** — entities appear/move as in the native
   authoring; the agent's run reproduces. Pause/seek if exposed.
3. **Parity.** The browser playback **matches the native run** within the W0 tolerance (visually identical
   motion for the keyframed bodies; no drift, since keyframes are authoritative).
4. **No install / offline.** It runs in a plain tab with no install; reloading replays from the IndexedDB-
   cached package.
5. **Phone.** The same page renders + plays on a phone (WebGPU is shipped on iOS/Android per the spike).
6. **Console clean.** No uncaught errors; no `Deno is not defined`; no `op_*` undefined.

A short written UAT report (pass/fail per item + screenshots) closes the Phase 8 gate.

## Acceptance gate (Phase 8 done)
A native-authored world **exports with one command** and **runs in a browser tab and on a phone**, playing
back at parity within tolerance — the headless suite is green (keyframe export, bundle build, host logic,
portability guard) **and** the human UAT report passes (render + playback + phone).

## Out of scope (deferred)
- **Live wasm-Rapier in-browser authoring** (mode B) — a later stage.
- **Native mobile** apps (this is browser/WebGPU on mobile, not a native build).
- Worldgen (**Phase 9**), ecosystem (**Phase 10**).
- The Phase-7 editor's in-tab 3D viewport — it can later embed this runtime, but that's not Phase 8.

## Open questions (decide at kickoff)
1. **Keyframe interval N** — every how many ticks? Trade-off: smaller N = larger package, exact playback;
   larger N = smaller package, needs interpolation. Decide from the W0 drift data + a target package size.
2. **Interpolation** — between keyframes, interpolate transforms (smooth) or step (exact-at-keyframe)? For
   parity, step-to-keyframe is safest; interpolation is smoother but introduces in-between frames not in the
   native run.
3. **Browser storage** — IndexedDB vs OPFS for the package + trace. IndexedDB is universally supported;
   OPFS is faster but newer.
4. **Bundler** — `esbuild --platform=browser` (repo already uses esbuild) vs `deno bundle --platform
   browser`. Recommend esbuild for consistency.
5. **Where the web runtime lives** — a new top-level `web/` app vs a route in the existing site. Keep it a
   standalone `web/` to separate from the marketing site.

---

## Status & outcomes (implemented — first cut; mode A export-playback)

- **Playback core — DONE, verified bit-identical.** Export format (`js/src/worldlog/keyframes.ts` +
  `js/src/export/package.ts`: `{ manifest.json, log.jsonl, keyframes.jsonl }`), the keyframe-driven
  `PhysicsOps` (`js/src/browser/keyframe-physics.ts` — `add_*` re-allocates the SAME native body ids,
  `step` advances the tick, `body_transform` does step-to-keyframe lookup), and the time-driven
  `ReplayPlayer` (`js/src/browser/player.ts`, the form the browser rAF loop drives). The gate
  `js/test/p8_playback_parity.ts` records a native physics run with keyframes, exports, round-trips through
  the serialized files, and replays through the keyframe-driven physics — asserting **BIT-IDENTICAL** final
  state (`compareWorldState`, 24 fields) for BOTH batch replay and the tick-by-tick player, and is
  **falsifiable** (corrupting one keyframe diverges). `p8_export.ts` covers the format + native-matching id
  allocation + the step-to-keyframe lookup.
- **Browser host + runtime — built; logic verified, GPU is UAT.** `js/src/browser/host.ts` (canvas-WebGPU
  `RenderOps`, IndexedDB `TraceOps` with a sync mirror + write-behind, and the rAF accumulator loop
  mirroring `windowed.rs` FIXED_DT 1/60 / MAX_STEPS 5) + `js/src/browser-entry.ts` (WebGPU detect → load
  package → real THREE scene/camera/`WebGPURenderer` → `ReplayPlayer` → rAF loop). `js/test/p8_browser_runtime.ts`
  verifies (no browser) the loop schedule + clamps, the trace store, and the **actual on-disk sample export
  loading + the `ReplayPlayer` running to `done` with all bodies**. `web/` is a zero-build page +
  `js/scripts/export-demo.ts` (the one-command export) producing `web/public/worlds/demo/`.
- **Bundling + portability — verified.** `npm run bundle:runtime` builds the browser bundle clean for
  `--platform=browser`; `check-host-portability.mjs` confirms `browser-entry.ts` + `browser/*` carry no
  ungated `Deno.*` at module init (Seam 4 PASS).
- **Adversarial review — 4 fixes landed.** A keyframe transform now serializes as exact **Float32 bit
  patterns** so `-0`/NaN/Inf survive the JSONL round-trip (the bit-identical `Object.is` gate would
  otherwise silently diverge on a `-0`); `loadExport` cross-checks manifest counts (no silent truncation),
  validates `logVersion`, and `parseKeyframes` validates body shape. All covered by `p8_export.ts`.
- **Verification:** 57/57 runnable headless tests pass, 0 regressions (`p3n4` perf capstone excluded as
  load-gated). The in-tab **WebGPU render + playback + phone** remain **UAT** (no browser here) — the
  acceptance checklist above stands; serve `web/` and open the sample world.
- **Playback smoothness — interpolated.** `KeyframePhysics` is EXACT on keyframe ticks (so the parity gate
  stays bit-identical) and **interpolates between them** (position lerp + shortest-path quaternion nlerp),
  so a body moves every tick at 60Hz instead of stepping at the keyframe interval (the UAT-flagged
  jerkiness). Verified by `p8_export` (exact at keyframes, smooth between) with `p8_playback_parity` still
  bit-identical.
- **Known limitations (first-cut follow-ups):** WebGPU is preferred with a WebGL2 fallback (renders on
  browsers/GPUs without WebGPU); sub-tick render interpolation (frame `alpha`) could smooth >60Hz displays
  further; live in-browser authoring (wasm-Rapier, mode B) is deferred; assets beyond the log/keyframes are
  not yet packaged.
