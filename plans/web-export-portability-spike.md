# Spike: Web Export — Browser Portability of the Engine Core

> **Type:** de-risking spike · **Status:** not started (proposal) · **Tier:** north-star enabler (author-once / export-everywhere)
> **Parent:** [`ROADMAP.md`](./ROADMAP.md) · companion to [`post-mvp-roadmap.md`](./post-mvp-roadmap.md) · sibling to [`worldgen-terrain-diffusion-spike.md`](./worldgen-terrain-diffusion-spike.md)
> **De-risks:** the already-specced-but-unbuilt milestone **`4x / M10 — wasm/browser runtime`** (`plans/limina-phase-4-platform/plan.md:277`, P4-X cross-cutting track, `[ ]` not started, "optional / pull-on-demand"). M10's accept criterion ("skill/agent layer runs in a browser/wasm target ... executes a skill **at parity**") glosses the hard part — *physics* replay parity — which this spike's W0 stage measures head-on. This spike is M10's missing de-risk pass, not a new milestone.
> **Builds on (all ✅ complete):** the durable + replayable world log (JSONL command stream + seeded RNG), bitECS SoA world, the typed/permissioned/traced skill registry, the fixed-timestep determinism loop, and Phase 4 snapshot recovery (M8: `op_physics_snapshot`/`op_physics_restore`, bincode).
> **North-star fit:** the wedge is **agent-native authoring**; the goal is **author-once / export-everywhere (browser → native → mobile), Unity/Unreal-style**. This spike retires the unknowns behind the *export* half — specifically whether the deterministic **world log is a portable project format** that re-runs in a browser tab.

This is **not a phase** and **not a commitment to ship browser export now**. The wedge comes first. This is a time-boxed
investigation to (a) confirm the core can run in a browser tab and (b) protect that future with the right seams *now*, so
nothing built between here and then forecloses it.

## The thesis being tested

> A limina world is a pure function of `(seed + skill/physics command log + snapshots)`. If that holds across runtimes,
> **"export" is not a recompile — it's running the same deterministic log against the target platform's runtime.** The
> JSONL world log becomes the portable project artifact (the `.unity`/prefab equivalent), and a single deterministic core
> targets browser, native, and mobile. That is a structurally cheaper export story than a native-game engine's, and it
> falls straight out of principles we already hold.

## What the de-risk pass already found (evidence)

A repo inventory + external-fact pass classified every core piece. Summary:

| Piece | Today (file evidence) | Browser verdict |
|---|---|---|
| **ECS** | bitECS 0.4, pure-JS SoA Float32Arrays (`js/src/ecs/world.ts:9`) | **PORTABLE** as-is |
| **Skill registry** | in-memory `Map`, Zod-validated, ops via injected `ctx.ops` facade (`js/src/skills/registry.ts`) | **PORTABLE** (ops facade stubbed per host) |
| **World log format** | JSONL, ASCII, Zod-parsed; logs `seed` + physics/skill **commands** not bytes (`js/src/worldlog/log.ts:45`) | **FORMAT PORTABLE**, replay parser is pure JS |
| **Determinism loop** | fixed `1/60` timestep (`crates/limina-runtime/src/windowed.rs:28`) + mulberry32 seeded `Math.random` (`js/src/worldlog/log.ts:232`) | **PORTABLE** (modulo physics parity, below) |
| **Renderer** | Three.js `WebGPURenderer`; `device` via `navigator.gpu` ✓ but **context via `op_create_window_context`** → winit/wgpu FFI (`js/src/engine.ts:269`, `crates/limina-render/src/surface.rs`) | **DENO-LOCKED at the surface** only |
| **Physics** | **native** Rust Rapier 0.33 via deno_core ops / `Deno.dlopen`, **not wasm** (`crates/limina-physics/src/lib.rs`); bincode snapshots | **DENO-LOCKED** — FFI can't cross to browser |
| **Durable I/O** | `op_write_trace` / `op_append_trace` filesystem ops (`js/src/worldlog/durable.ts:25`) | **DENO-LOCKED I/O** (format is portable) |
| **Host / entry** | custom deno_core embedding, winit event loop; **no browser entry, no bundler config** (`crates/limina-runtime/src/windowed.rs`) | new browser entry required |

**External facts (mid-2026, sourced):** `@dimforge/rapier3d`(`-compat`) ships an in-browser **wasm** build; bitECS is
pure-JS ESM; Three.js `WebGPURenderer` is production-usable (r171+) with an automatic **WebGL2 fallback**; `deno_webgpu`
and browser `navigator.gpu` share the W3C spec / `wgpu` core, so WebGPU code ports unchanged **except surface creation**;
WebGPU is shipped by default across Chrome/Edge, Firefox (Win/macOS), Safari 26, **iOS/iPadOS 26**, and Android Chrome —
**desktop Linux is the only soft spot** (WebGL2 fallback covers it); `deno bundle --platform browser` (restored 2.4) or
esbuild + `esbuild_deno_loader` handle `npm:`/`jsr:`/import-map bundling.

## The question this spike answers

> Can the limina core **re-run a recorded world log inside a browser tab** — bitECS + wasm-Rapier + Three `WebGPURenderer`,
> driven by the same agent-issued skill/physics commands — and reach a world state that **matches the native run closely
> enough to call it the same world**, with snapshots bounding any drift?

If yes → the world log is a real portable format and "export-everywhere" is an engineering schedule, not a research bet.
If physics parity proves too costly → we still ship browser playback, but **snapshot keyframes become the authoritative
export artifact** and pure log-replay is best-effort. Either outcome is a usable answer.

## The one decisive unknown: replay parity (physics)

Everything else is plumbing; this is the load-bearing risk. Rapier is only **locally** deterministic by default — same
machine, same build, same version, same insertion order. **Cross-runtime** parity (our native-FFI build ↔ the browser
wasm build) is *not* automatic:

- Cross-platform determinism needs Rapier's **`enhanced-determinism`** feature, which **cannot coexist with
  `simd`/`parallel`** — i.e. a fast SIMD/multithreaded native build will **not** reproduce the wasm build bit-for-bit.
- Native **bincode snapshots ≠ wasm snapshots** — snapshot blobs are per-runtime; they are caches, **not** the portable
  artifact. The portable spine is the **command log**.
- The render backend is also not byte-identical (WebGPU vs the WebGL2 fallback), so any render-hash parity check is out;
  parity must be judged on **world state**, not pixels.

**Three viable parity strategies, to be chosen by evidence:**
1. **One deterministic build everywhere** — run deterministic-wasm Rapier (or a matched `enhanced-determinism` native
   build) in *both* hosts. Cleanest replay story; costs native SIMD/parallel throughput.
2. **Best-effort replay + snapshot keyframes (recommended default)** — keep the fast native build; treat log-replay as
   approximate and checkpoint **authoritative world-state snapshots** to bound drift. Reuses Phase 4 snapshot recovery and
   mirrors the terrain spike's "log the request + content hash, snapshot the result" cache. Makes export *correct by
   construction* regardless of cross-arch FP.
3. **Hybrid** — deterministic build for the authoring/canonical runtime, fast build for native play, snapshots reconcile.

The terrain spike already committed to snapshot-as-safety-net for the same float-determinism reason; adopting strategy 2
as the **general export contract** keeps one consistent story across both spikes.

## Approach — staged, de-risk-first

### W0 — Headless parity probe (cheapest, highest signal; days)
No renderer, no browser. Drive the **same recorded log** through (a) the native-FFI physics path and (b) `@dimforge/rapier3d`
wasm under Deno/Node, stepping the existing fixed-timestep loop.
- Measure **state divergence** over N steps (per-body position/orientation L2 drift) for a few representative scenes.
- Test both a fast native build and an `enhanced-determinism` native build against deterministic wasm.
- **Decision gate:** is log-replay parity good enough on its own (strategy 1), or is a snapshot cadence required (strategy 2)?
  Pick the export contract here, in writing, before touching the renderer.

### W1 — Browser core bring-up (~1–2 wks)
Stand up a minimal **browser entry** that runs the portable core in a tab:
- Abstract the **GPU surface** behind a tiny seam: `createContext()` → `canvas.getContext("webgpu")` in browser,
  `op_create_window_context` in Deno. WGSL/pipelines/bind groups/draw are shared (confirmed API-compatible).
- Swap physics behind the existing `ctx.ops` facade: a **wasm-Rapier ops adapter** implementing the same op surface the
  skills already call (`op_physics_step`, `op_physics_body_transform`, …) so no skill code changes.
- Polyfill durable I/O: `op_write_trace`/`op_append_trace` → **IndexedDB**; replay reads the same JSONL.
- Bundle via `deno bundle --platform browser` (or esbuild + `esbuild_deno_loader`); **gate every `Deno.*` behind
  `typeof Deno !== "undefined"`** and keep the FFI/host modules out of the browser entry (no top-level `Deno.*`).
- **Acceptance:** load a log exported from the native engine, replay it in a tab, agent walks/rolls on the result, and the
  final world state matches native within the W0-chosen tolerance (exact via strategy 1, or snapshot-reconciled via strategy 2).

### W2 — Export packaging (later, only if W0/W1 hold)
Define the portable bundle: `{ log.jsonl, snapshots/, assets/, manifest }` + a thin browser runtime, served as a static
site. This is where "author-once → ship to a tab" becomes a one-command export. Mobile rides the same browser runtime
(iOS/Android WebGPU shipped); a native mobile target is a separate, later question.

## Protect-the-future actions (do these NOW, even before the spike runs)

These cost little today and prevent foreclosing export later:
1. **Keep the renderer surface behind a seam** — never let new render code call `op_create_window_context` directly;
   route through one `createContext()`/render-target abstraction.
2. **Keep physics behind the `ctx.ops` facade** — no skill should import a Deno/FFI physics symbol directly; the wasm
   adapter must be a drop-in.
3. **Treat the JSONL command log as the canonical portable artifact** — keep logging *commands + content hashes*, not
   runtime bytes (already the practice; the terrain spike reinforces it). Snapshots stay caches, never the source of truth.
4. **No top-level `Deno.*`** in any module the browser entry could pull in; gate host calls behind `typeof Deno`.

## Unknowns to retire (the point of the spike)

1. **Replay parity quality** — native↔wasm world-state drift per scene; is strategy 1 viable or is strategy 2 required?
2. **Snapshot cadence vs size** — if snapshots are the safety net, what keyframe interval bounds drift within the Phase 4
   durable-state budget?
3. **Perf in a tab** — wasm-Rapier + Three `WebGPURenderer` frame budget on mid hardware; WebGL2-fallback cost on Linux.
4. **Surface-seam scope** — is the GPU context truly the *only* Deno-locked render dependency, or do other ops leak in?
5. **Bundle hygiene** — does the existing JS cleanly split into a browser-safe entry with no top-level `Deno.*`?

## Recommendation / sequencing

Do **W0 first** — it's a few days, needs no renderer, and answers the only question that can kill the thesis (physics
parity). Gate on it and **write down the export contract** (strategy 1 vs 2) before W1. Treat **W2** as packaging, not
research. Throughout, take the four protect-the-future actions immediately regardless of when the spike runs, since they
are nearly free now and expensive to retrofit. Hold the standing principles: off the frame loop, deterministic +
replayable, engine = substrate. **The wedge (agent-native authoring) ships first; this spike just guarantees the export
door stays open.**
