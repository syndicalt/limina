# Track R — Native wgpu Render Path (design)

> Companion to `plans/limina-sota-engine.md` (Track R). Grounded design spike output —
> the implementation plan for lifting the deno_webgpu fidelity ceiling. Status: **designed,
> not yet implemented.** Phase 0 is the next slice.

## Current stack (three.js ↔ deno_webgpu ↔ present)

The host owns the winit window; three.js renders into a **host-owned native surface** via a
**shared** `deno_webgpu::Instance`. Present path (windowed):

1. `run_windowed` creates the winit window and puts `WindowTarget` into `OpState` before JS runs — `crates/limina-runtime/src/windowed.rs:158-192`.
2. JS `createEngine` → `requestAdapter`/`requestDevice` → `op_create_window_context()` → `new THREE.WebGPURenderer({ device, context, antialias:true })` → `renderer.init()` — `js/src/engine.ts:349-356`.
3. `op_create_window_context` builds a wgpu surface from the host window on the **same** Instance `navigator.gpu` uses, wrapped as a `GPUCanvasContext` — `crates/limina-render/src/surface.rs:70-123`.
4. Host loop: fixed-step accumulator fires `Callback::Step(1/60)` N times, then one `Callback::Frame(alpha)` — `windowed.rs:214-261`. Sim is in Step; render is in Frame.
5. JS `render(alpha)` syncs ECS transforms, `renderer.render(scene,camera)`, then `op_surface_present(context)`.
6. `op_surface_present` → `instance.surface_present(surface_id)` then clears `current_texture` so the next `getCurrentTexture()` is fresh — `surface.rs:128-144`.

**The real Track-R plug point is the Rust op layer** (`crates/limina-render/src/lib.rs:18-34` `extension!` op list; ops in `surface.rs`), not the JS `RenderOps` `Pick<>` type (`engine.ts:146-151`).

## The four backend ceilings (with evidence)

- **(a) No `GPUQueue.copyExternalImageToTexture`** → ImageBitmap textures upload black; re-homed onto `DataTexture`/`queue.writeTexture`. `crates/limina-render/js/00_bootstrap.js:77-83`; workaround `js/src/skills/three.ts:240-282`.
- **(b) No reliable fresh-frame present per camera move → live post DISABLED.** `js/src/skills/render.ts:12-16`. **Key nuance: the bare `renderer.render` path DOES present fresh live** — the staleness is **post-composite-specific**, implicating three's multi-pass→surface mapping, not the present op.
- **(c) No MSAA / sampleCount>1** — documented in plan prose only; source actually passes `antialias:true` (`engine.ts:355`). **Treat as documented-but-unverified** — confirm empirically.
- **(d) Depth-attachment sampling limited** — depth-as-MRT works (`js/src/render/post.ts:18-22`); sampling the depth a live/transparent pass is writing does not (`js/src/water.ts:28-36`), so water uses a heightfield/proxy.

Versions: deno_core `=0.404.0`, **deno_webgpu `=0.218.0`** (hard-pinned), winit `0.30`. Transitive: **wgpu-core 29.0.1 / wgpu-hal 29.0.3 / naga 29.0.3**. The `wgpu` facade is absent — deno_webgpu binds wgpu-core directly. wgpu-core 29 is locked by the `=`-pinned deno_webgpu.

## Recommendation: Option A, staged as a hybrid migration

**A native wgpu renderer behind the Rust op seam in `limina-render`, on the shared `deno_webgpu::Instance` already in `OpState`** (not a second device, not the `wgpu` facade), bypassing three's WebGPU backend for the **present + post** path.

- **B (fork/fix deno_webgpu) is wrong leverage** — the staleness is post-composite-specific (bare present already works), so it's a three-side mapping defect, not an `op_surface_present` bug; forking a `=`-pinned ABI set wouldn't touch three's post path and can't add MSAA/depth semantics.
- **A owns exactly the three broken things** — present timing, MRT/MSAA resolve, texture upload — additively (present is already Rust-side on the shared Instance).
- **C "hybrid" is the migration shape of A**: three keeps authoring scene geometry into an offscreen MRT (already works); the native path takes over post + resolve + present. Full native scene render (retiring three) is out of Track-R scope.

## Architecture

- **Plug-in:** new native render module + ops (`op_native_*`) in `crates/limina-render`, a `NativeRenderer` in `OpState` beside `SurfacePresenter`. No new crate.
- **Driven by the existing Frame seam** (`windowed.rs:248-249`) on the same single-threaded `!Send` JsRuntime thread — no threading change.
- **Coexistence:** three renders the lit scene into an offscreen color+depth+normal MRT (the path `post.ts` already builds); the native stage samples it, runs post/MSAA-resolve, writes + presents the surface — replacing three's `post.render()`+`op_surface_present` tail. Old paths stay behind a flag until parity. Browser/Mode-B keeps its present stubs (native is windowed-only).
- **Determinism (core promise intact):** replay determinism = seed + command stream + fixed-step `Callback::Step` order; **render never participates.** The native renderer runs only in `Callback::Frame`, reads interpolated transforms over the SAB bridge, and must be **write-free over sim state**. Headless creates no surface → native path inert → headless determinism untouched.

## Phases (each independently verifiable)

- **Phase 0 — Native clear+present (minimal slice + de-risk).** A native wgpu-core pass owns the surface for one frame: clear to a camera-derived color, present via the existing `surface_present`; three not involved. **Acceptance:** frame-capped windowed run (~300 frames) moving the camera each frame proves the image changes **every** frame with **no present-stall** — directly refutes limit (b) for the native path. Needs no device-sharing, so it isolates the present-freshness hypothesis cheaply. Headless determinism stays green.
- **Phase 1 — Native scene blit + MSAA.** Native pass samples three's offscreen scene color, resolves a `sampleCount=4` target to the surface. *Gated on the sharing spike (Risk 1).* Settles limit (c) empirically.
- **Phase 2 — Live post (the Track-R gate).** Port `post.ts`'s GTAO→bloom→HDR-grade chain to native WGSL over three's MRT. **Acceptance:** post runs during free-fly with fresh frames; the `USE_POST` static gates are removed.
- **Phase 3 — Direct texture upload.** Native `write_texture` replacing the DataTexture re-home (limit a); `js/test/p3_textured_gltf.ts` passes through the native path.
- **Phase 4 — Real depth pre-pass.** Sampleable scene-depth for water/refraction, retiring the proxies (limit d).
- **Phase 5 (out of scope, noted):** native scene geometry render to retire three.

## Risks

1. **[HIGHEST — spike first] Cross-"API" resource sharing in one wgpu-core global:** can a native wgpu-core pass sample the offscreen texture three's deno_webgpu backend rendered, via the same `Instance`/`Device`? *Spike:* three renders a known pattern to an offscreen `GPUTexture`; pass its wgpu-core `TextureId` to a native pass that samples it; verify pixels. Fallback: readback-blit, or accelerate Phase 5. **Phase 0 does not depend on this**, so the present-freshness win is bankable regardless.
2. **wgpu-core 29 raw-API churn + version lock** (pinned transitively by deno_webgpu `=0.218`). Mitigate with a thin adapter + pinning. Rebuild gotcha: bootstrap JS is embedded — `touch crates/limina-render/src/lib.rs` to force a rebuild.
3. **Present-freshness root cause mislocated** — if native present *also* goes stale, the fix is deeper in surface acquisition. Phase 0 is the cheap test; low-probability given the bare-path evidence.

**First spike:** Risk 1 (shared-texture sampling), in parallel with Phase 0.
