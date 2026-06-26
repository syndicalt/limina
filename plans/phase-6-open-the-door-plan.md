# Plan — Phase 6: Open the Door & De-risk

> Kickoff plan for **Phase 6** of [`post-mvp-roadmap.md`](./post-mvp-roadmap.md).
> **Goal:** unblock everything downstream with cheap, high-signal work — take the four
> "protect-the-future" seams that keep *author-once / export-everywhere* reachable, and run the
> cheapest stage of each de-risk spike so the two heavy external dependencies are greenlit or
> shelved with evidence before anyone commits.
> **Gate:** the four seams are merged; the export contract is written down (from W0); the worldgen
> go/no-go is recorded (from S0).
> **Status:** not started.

## The one idea under the four seams

All four seams are facets of a single move: **the engine should acquire its host capabilities by
injection, not by reaching for `Deno.core.ops` at module top level.**

Today `js/src/engine.ts:100` does `export const ops: EngineOps = Deno.core.ops` — a top-level Deno
access that (a) throws the instant `engine.ts` is imported in a browser, and (b) hard-wires every
downstream capability (render surface, physics, trace I/O) to the native host. Introduce a
**host-capabilities boundary** — the host passes a capabilities object in at startup — and each
capability becomes a typed interface a browser host can implement later. Do the boundary once and the
four seams below mostly fall out.

**Load-bearing decision (get it right now, it's expensive to reverse):** the boundary's shape. Recommend
a single `EngineHost` object with narrow typed sub-surfaces — `host.render`, `host.physics`,
`host.trace` — injected at startup. Native host wires them to `Deno.core.ops`; a future browser host
implements the same three. Mockable for tests. Decide this at kickoff before writing the seams.

## Seam 1 — Renderer behind a surface seam

- **Now:** `engine.ts:266-272` — `navigator.gpu.requestAdapter()` (portable) → `ops.op_create_window_context()`
  (native-only, `engine.ts:269`) → `new THREE.WebGPURenderer({ device, context, canvas })`. The *only*
  Deno-locked point is the context op.
- **Change:** route GPU-context/target acquisition through one `host.render.createTarget()` seam. Native
  impl calls `op_create_window_context`; a browser host (Phase 8) returns `canvas.getContext("webgpu")`.
  WGSL / pipelines / draw are untouched.
- **Accept:** a single render-target factory; no other module calls `op_create_window_context` directly;
  native windowed + headless render paths unchanged.

## Seam 2 — Physics behind a typed ops facade

- **Now:** native Rapier via **18 ops** (the exact surface a wasm adapter must implement):
  `op_physics_create_world, add_ground, add_box, add_sphere, add_capsule, add_static_box,
  add_static_sphere, add_static_capsule, add_box_material, apply_impulse, body_pos, body_transform,
  drain_collisions, raycast, remove_body, snapshot, restore, step`. Skills already call these via
  `ctx.ops` — **no skill imports FFI/physics directly** (audited; only `skills/index.ts` imports
  `registerPhysicsSkills`, which is registration).
- **Change:** lift those 18 ops into a typed `PhysicsOps` interface on `host.physics`. Native impl = the
  Deno ops; a browser host (Phase 8) implements the same interface over `@dimforge/rapier3d` wasm — a
  drop-in adapter, zero skill changes.
- **Accept:** a `PhysicsOps` interface enumerating exactly that surface; all physics access flows through
  it; native behavior unchanged (existing physics tests green).

## Seam 3 — Durable-log I/O behind a sink + commands-not-bytes contract

- **Now:** the world log is JSONL, one command per line (`worldlog/log.ts:156`), parsed by pure JS
  (`parseWorldLog`); durable I/O uses `op_write_trace` / `op_append_trace` (`worldlog/durable.ts:25,38`).
- **Change:** put durable I/O behind a `host.trace` sink interface (native = the trace ops; browser later =
  IndexedDB). **Lock the contract in writing:** the log records `seed + commands + content hashes`, never
  runtime bytes; snapshots are caches, not the source of truth. (Already the practice — Phase 6 makes it a
  stated, tested invariant.)
- **Accept:** a `TraceSink` interface; the format invariant documented beside `log.ts`; replay stays
  byte-identical on native.

## Seam 4 — No top-level `Deno.*` in browser-reachable modules

- **Now (audited):** top-level Deno access lives in `engine.ts:100` (`export const ops = Deno.core.ops` —
  the offender, since `engine.ts` is core and imported everywhere), plus `bootstrap.ts:15`,
  `mcp/ws_runtime.ts:19`, `mcp/stdio_runtime.ts:29,33`. The `bootstrap.ts` + `mcp/*_runtime.ts` files are
  native **entry points** (host-specific — fine and expected). The problem is `engine.ts`.
- **Change:** `engine.ts` stops touching `Deno.core.ops` at module top; the native host injects the
  capabilities object at startup (the boundary above). Add a CI guard: browser-reachable modules
  (everything except the host entry points) must contain no top-level `Deno.*`.
- **Accept:** importing `engine.ts` / `ecs/*` / `skills/*` / `worldlog/*` evaluates with **no `Deno`
  global present**; a lint/CI check enforces it.

## The two de-risk probes (cheapest stage of each spike — run in parallel with the seams)

- **W0 — web-export parity probe** ([`web-export-portability-spike.md`](./web-export-portability-spike.md),
  stage W0): headless, no renderer. Drive the *same recorded log* through native-FFI Rapier and
  `@dimforge/rapier3d` wasm; measure per-body state drift over N steps, on a fast build and an
  `enhanced-determinism` build. **Decision to write down:** pure log-replay parity vs snapshot-keyframe as
  the export contract.
- **S0 — worldgen value probe** ([`worldgen-terrain-diffusion-spike.md`](./worldgen-terrain-diffusion-spike.md),
  stage S0): run stock *InfiniteDiffusion* out-of-process on the RTX 3050; measure ms/tile, determinism
  (seed→identical), and quality at 30 m/px. **Decision:** greenlight Phase 9 or shelve with evidence.

These are measurement, not building, and have no code coupling to the seams — fully parallel.

## Sequencing

1. **Land the host-capabilities boundary first** — the one hard-to-reverse decision; every capability call
   site routes through it.
2. **Seams 1–4 in parallel** once the boundary shape is fixed — each is small and independent.
3. **W0 + S0 in parallel throughout** — separate workstream, no coupling.

## Acceptance gate (Phase 6 done)

- Four seams merged; importing the core modules touches no `Deno` global; native windowed / headless /
  MCP-stdio all still run unchanged.
- The export contract (W0 outcome) written down.
- The worldgen go/no-go (S0 outcome) recorded.

## Out of scope (explicitly deferred)

- Building the **browser runtime** / the **wasm-Rapier adapter** (Phase 8) — Phase 6 only defines the seams
  they will plug into; it implements **no** browser host.
- Any **worldgen integration** (Phase 9) — S0 is a measurement, not a build.
- The **editor / authoring surface** (Phase 7).

## Open questions (decide at kickoff)

1. **Boundary shape** — one `EngineHost` object with `render`/`physics`/`trace` sub-surfaces (recommended)
   vs separate interfaces threaded individually. Affects every call site; pick before writing seams.
2. **Where the host is constructed** — native host wiring lives in the runtime entry (`bootstrap.ts` /
   `mcp/*_runtime.ts`); confirm those are the only places that may name `Deno.core.ops`.
3. W0 → export contract and S0 → worldgen go/no-go are **outputs** of this phase, not inputs.

---

## Status & outcomes (implemented)

- **Host-capabilities boundary + Seam 4 — DONE, verified.** `js/src/engine.ts` replaces the top-level
  `Deno.core.ops` with a `typeof Deno`-guarded bind + `installOps()`. Native auto-binds at module eval
  (byte-identical, zero call-site churn across the 22 importers, no per-op overhead — `export let ops` is a
  plain live binding). Enforced by `js/scripts/check-host-portability.mjs` (static scan of 72 modules +
  dynamic no-`Deno`-global eval of the pure core); **51/51 runnable headless tests pass, 0 regressions**
  (the 4 non-run tests are a throw-fixture + GPU-window/Ollama env tests, failing identically pre-change);
  adversarial review came back clean (no eager-capture, no perf indirection, sound guard + live-binding).
- **Seam 1 (render) / Seam 2 (physics) — DONE.** The surfaces are now explicit `RenderOps` / `PhysicsOps`
  `Pick<EngineOps, …>` types; a browser/wasm host implements them and injects via `installOps`.
  `op_create_window_context` stays the single render-context call site (`engine.ts`).
- **Seam 3 (trace) — DONE.** `worldlog/durable.ts` narrowed to `TraceOps`; the *commands-not-bytes*
  invariant documented in `log.ts` and tested by `js/test/p6_trace_contract.ts` (asserts JSONL command
  stream, no raw-bytes blob, replay bit-identical).
- **W0 — DONE, decisive.** `spikes/w0-physics-parity/`: single-box control agrees to f32 epsilon (3e-8 m),
  but an 8-box contact pile diverges (max **0.41 m / 128°** over 300 steps), and **no wasm build on Rapier
  core 0.33 exists** (newest `@dimforge/rapier3d` ships core 0.30). **Export contract decided:
  snapshot-keyframe** — carry periodic transform keyframes (reuse `op_physics_snapshot`/`restore`,
  bit-exact within one build); pure log-replay determinism is native↔native only. Full writeup in
  `spikes/w0-physics-parity/RESULT.md`.
- **S0 — DONE, ran on the RTX 3050. GREENLIGHT.** Real *InfiniteDiffusion* (github `xandergos/terrain-diffusion`,
  ~1.1 GB public weights, 30 m/px — the pip `terrain-diffusion` is a decoy stub). Measured: fp16 **~5.5 s** for an
  isolated 256² tile, **~0.87 s/tile** for contiguous regions (~6× cheaper, VRAM ~1.16 GB), and — decisively —
  **determinism is EXACT** (bit-identical elevation + 5 climate channels across two cold processes). Viable for
  off-loop contiguous streaming around a moving agent, not per-frame/teleport without aggressive prefetch.
  Greenlight Phase 9 / S1 with fp16 + prefetch + the snapshot cache; cross-device determinism still untested.
  See `spikes/s0-terrain-diffusion/RESULT.md`.
