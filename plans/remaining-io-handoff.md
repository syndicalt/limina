# Remaining I/O — handoff spec

> Companion to `plans/limina-sota-engine.md`. The verifiable logic of all six tracks is
> implemented, tested (19 gates), and committed on `feat/sota-engine-foundation`. What remains is
> exactly the set of I/O shells that require a hardware/surface capability absent from the headless
> dev environment. Each is a **wiring task behind an already-built, already-tested interface** — not
> new design. This doc specifies, per item: the interface it plugs into, the capability needed, the
> concrete steps, and how to verify it.

## Why these are separated out

The engine's perception, simulation, authoring, history, integrity, packaging, and self-correction
**logic** is all deterministic and tested headlessly. The remaining work is the runtime I/O that
turns that logic into pixels, a browser UI, or a native installer. None can be *run, seen, or
tested* in a headless box with broken GPU readback — so it is built behind interfaces and left
honestly unimplemented rather than written blind and falsely reported "done."

The one foundational unblocker is **GPU pixel readback**: it is broken here (`p3_fidelity_readback`
reads the surface mid-frame and gets black, because three composites to the surface only at
present-time — see `crates/limina-render/src/surface.rs:122`). Fixing it (via the native render path
below) unblocks A, B-visual, C-windowed, and R together.

## Items

### R — native wgpu renderer  (the keystone; unblocks A/B-visual/C-windowed)
- **Plugs into:** the Rust op seam in `crates/limina-render` (add ops to the `extension!` list in
  `src/lib.rs`; a `NativeRenderer` in `OpState` beside `SurfacePresenter`). Design: `plans/track-r-native-render.md`.
- **Capability needed:** a GPU + the ability to compile/run the native binary and inspect frames.
- **Steps:** Phase 0 = native `surface_get_current_texture` → render pass clears it → `queue_submit`
  → present (needs the device id threaded into `OpState`, which it currently is not). Then Phase 1
  MSAA, Phase 2 live post, Phase 3 native texture upload, Phase 4 depth pre-pass.
- **Verify:** frame-capped windowed run; the presented image changes every camera move with no
  stall; then **native readback returns non-black** (this is the hypothesis Phase 0 tests and, if
  true, the fix that unblocks everything visual). De-risk Risk 1 (cross-API texture sharing) first.

### B — visual self-correction providers  (loop already complete: `js/src/eyes/self_correct.ts`)
- **Plugs into:** `RenderProvider` and `CritiqueProvider` interfaces. The loop, convergence,
  determinism, and non-convergence reporting are tested (`p16_self_correct`); the structural variant
  is fully complete with real providers (`p16_structural_refine`).
- **Capability needed:** GPU readback (RenderProvider: headless render → image) + a vision model
  (CritiqueProvider).
- **Steps:** implement `RenderProvider.render(config)` = apply config (exposure/lights) → headless
  render → read back pixels (depends on R); implement `CritiqueProvider.critique(frame)` = call a
  vision model for a score + adjustments.
- **Verify:** run `refineVisual` against a deliberately ugly scene; it converges to the bar with no
  human — the same gate `p16_self_correct` proves on the stand-in provider.

### A — fidelity defaults  (logic: flip PBR/lighting/post defaults on)
- **Plugs into:** `render-baseline.ts`, `world.generateRegion` surface default, `scene.createEntity`
  `pbr` default.
- **Capability needed:** a display / readback to confirm "visibly better, not regressed."
- **Steps:** flip the conservative defaults; **Verify** via the B visual loop or human eyes on a
  windowed run (deliberately deferred here because "visibly better" is unverifiable headlessly).

### C — windowed archetype demos  (headless logic complete: siege/sequence/quest gates pass)
- **Plugs into:** the `*_window.ts` demo pattern over the existing shared sims.
- **Capability needed:** a display to validate the rendered demo.
- **Steps:** author windowed hosts for the three archetypes (render the same deterministic sims the
  `p16_archetype_*` gates already drive); **Verify** with a frame-capped windowed run + eyes.

### D — editor DOM binding  (controller complete: `js/src/editor/history_controller.ts`)
- **Plugs into:** the tested `EditorHistoryController`; bind its methods to `editor/src/app.js`
  buttons/sliders (branch list, timeline scrub, merge), and render `commandsAtPlayhead()` in
  `editor/src/viewport.js`.
- **Capability needed:** a browser (the editor dev server) to run + validate the UI.
- **Steps:** wire DOM events → controller methods → re-render; **Verify** in-browser (the controller
  logic, incl. time-travel-to-correct-world, is already proven by `p16_editor_controller`).

### E — native build toolchain  (packaging descriptor complete: `js/src/export/platform_package.ts`)
- **Plugs into:** the `PlatformPackage` descriptor `packageForPlatform` emits (gated on integrity,
  proven by `p16_platform_package`).
- **Capability needed:** desktop/mobile build toolchains (cargo cross-targets, mobile SDKs).
- **Steps:** a build script that reads the descriptor, embeds the runtime + bundle, and produces the
  installable; **Verify** by installing/running the artifact on each target.

## Bottom line

Hand me any one capability — **a box with working GPU readback (or you running the windowed build and
telling me what renders), the editor dev server, or the target build toolchains** — and the
corresponding item is a wiring task against an interface that is already built and tested, not a
design problem. Until then, these are left honestly unimplemented rather than written blind, per the
project's own no-reward-hacking standard.
