# Volumetrics study — how UE5 renders large volumes efficiently, mapped to limina

**Status:** study, 2026-07-20. Owner directive: optimize for volumetrics (quality + performance).
Feeds Track R (native wgpu render path) and the current Three.js/WebGL render path.

## 1. What UE5 actually does (distilled from engine docs + production reports)

UE5 has three distinct volume systems; their efficiency comes from the SAME five ideas.

### 1.1 Heterogeneous Volumes (UE 5.3+) — the large-dataset answer
- **Sparse Volume Textures (SVT)**: the volume is stored as compressed tiles
  (bricks), allocated only where density exists. GEOMAR's survey
  (oceanrep.geomar.de/62166) renders a 6-billion-voxel dataset (~2.6B
  non-empty) at 20 fps on a laptop RTX 3500 — the dense resolution is
  irrelevant; only the non-empty content costs memory and time. Reported
  ceiling: 32k×32k×16k sparse voxels while compressed tile+MIP data stays
  under 4 GV.
- **MIP pyramids with padding** for correct trilinear interpolation across
  brick borders (the chunked-dataset lighting seams they hit came from
  missing neighbor data — a correctness lesson, not just perf).
- Ray marching happens only inside occupied bricks; empty space is never sampled.

### 1.2 Volumetric Fog — the frustum-voxel (froxel) answer
- A **low-res frustum-aligned grid** (froxels), exponential depth
  distribution: dense near the camera, sparse far. Tunables are exactly
  `GridPixelSize`/`GridSizeZ` — resolution is a budget knob, not a quality
  requirement.
- Lighting/density evaluated per froxel in compute, then one integration
  pass. No per-pixel raymarch at full res.
- **Temporal reprojection with jittered integration** (~0.9 history weight)
  is what makes the low grid look like a dense volume. Known failure modes
  (documented in UE + Unity + Godot issue trackers): ghosting on fast
  object/camera motion, NaN propagation in the history buffer, and
  reprojection itself becoming 3× the base cost when implemented naively
  (Unity HDRP case: 2.7ms → 7.6ms; UE's lands ~1ms).

### 1.3 Volumetric Clouds — the raymarch answer
- Half-resolution raymarch of a 3D noise volume, **blue-noise/random offset
  at the ray start** to turn banding into noise, then **temporal
  accumulation** to average the noise away, then **depth-aware bilateral
  upsample** to full res (reject samples when depth deltas are large).
- Multi-scattering is faked analytically (Beer–Powell + octave noise), never
  with extra ray casts.

### 1.4 The five transferable ideas
1. **Sparse representation**: store only non-empty space (bricks/SVT); the
   empty world is free.
2. **Low-res evaluation + temporal accumulation**: render the volume at
   ¼–½ res and let TAA recover detail. This is the single biggest lever.
3. **Decorrelated sampling**: blue-noise offsets per pixel per frame;
   constant step offsets band, jittered ones converge.
4. **Empty-space skipping structures**: min–max MIP chains, distance maps,
   or SDF bounds so the marcher steps over emptiness at full step.
5. **Budget-driven quality**: grid resolution / sample counts / anisotropy
   are tier knobs with hard ms budgets (heavy volumetric processes target
   <3ms at 1080p-class GPUs).

### 1.5 Adjacent (worth tracking, not volume rendering per se)
Lumen-class GI uses low-res voxel SDFs + radiance caches + temporal/reuse
sampling (ReSTIR-style) — the same sparse-cache-temporally-accumulate
philosophy. Relevant when limina tackles GI, not now.

## 2. Where limina stands today

- Fog: flat exponential `scene.fog` (Three.js), plus a density knee for
  world-overview presentation. No froxels, no light scattering, no local volumes.
- Water: surface meshes with depth-fade; underwater effect exists as a screen
  pass (p_underwater_effect), not a participating medium.
- No volumetric clouds; sky is a gradient/atmospheric shell.
- Render stack: Three.js WebGL today; Track R commits to native wgpu with a
  real post pipeline (the place volumetrics belong).
- Determinism contract: every render-side structure must be derivable from
  verified content bytes (volumes are render-only, derived from
  content-hashed inputs, never authored per-frame state).

## 3. The limina volumetrics plan (quality + performance)

Sequenced to reuse each layer in the next; each phase ships behind the
existing quality-tier system (performance/balanced/cinematic).

### V1 — Froxel fog foundation (first, everything else builds on it)
- Frustum-aligned volume texture, exponential depth slices; grid dims driven
  by the quality tier (e.g. 160×90×64 performance, 160×90×128 balanced).
- Density sources at first: the existing height fog + biome humidity/blight
  fields (murk is already a paintable material — its volume is the first
  authored local fog). Light: sun + ambient only.
- Integration pass with blue-noise ray offset; temporal accumulation with
  **neighborhood clamping** (Karis) — the documented ghosting/NaN failure
  modes all come from unclamped history; clamp to current-frame froxel
  neighborhood min–max and bound history weight ≤0.9 with an explicit
  NaN guard on the history buffer.
- Budget gate: ≤1.5ms balanced at 1080p on Iris Xe-class GPUs, measured in
  the render telemetry (the telemetry pipeline already reports frame phases).
- Determinism gate: identical inputs → identical froxel buffer across realms
  (render-only, but the replay-parity rule applies to anything fed by sim state).

### V2 — Sparse local volumes (smoke/fire/dust, cave mist)
- Brick-map sparse volumes (32³ bricks, CPU-side allocation map, GPU indirection
  table — the SVT shape, not a dense texture per volume).
- Raymarch only inside occupied bricks; min–max density MIP per brick for
  border-correct interpolation (the GEOMAR seam lesson).
- Authoring: volumes are emitted by skills (vfx.*) as content-hashed
  descriptors; Niagara-style sim is a later track — the render contract
  (sparse bricks + indirection) must not change when sim arrives.

### V3 — Cloud layer
- Half-res raymarched noise volume over the sky shell, blue-noise offset,
  temporal accumulation, depth-aware upsample; single-scatter + analytic
  multi-scatter approximation (no shadow rays at first; baked volume shadow
  map later).
- Cloud coverage from the climate system (world.setClimate already exists —
  humidity/cloud cover fields feed density; authored, not random).

### V4 — Underwater as a true medium
- Replace the screen-pass underwater effect with the V1 froxel buffer:
  water bodies write density+absorption into the froxels they occupy (the
  generated-water field already knows exactly where water is — the contact
  field is the source of truth).

### Standing guardrails (from the UE/Unity/Godot failure record)
1. Never ship temporal accumulation without neighborhood clamping + NaN guard.
2. Sample-count and grid-res are tier knobs with measured ms budgets in CI's
   render telemetry; a regression past budget fails the gate.
3. Blue-noise offsets from a deterministic table (content-pinned), never a
   PRNG — replay and cross-realm parity depend on it.
4. Sparse first: no dense 3D texture is ever allocated for a mostly-empty
   volume; brick allocation maps are part of the content hash.
5. Depth-aware upsampling everywhere a low-res buffer meets the full-res frame.

## 4. Where this lands in the code

- V1 fits the CURRENT Three.js path as a post pass (render target + shader),
  designed so the froxel buffer producer/consumer is backend-agnostic — the
  Track R wgpu port then re-implements the passes, not the architecture.
- The native Track R phase (R1.2) adopts V2/V3 as compute passes; wgpu
  compute is the reason Track R exists for this work.
- Files when implemented: `js/src/render/volumetrics/` (froxel grid, jitter
  table, integrate pass), quality-tier hooks in `js/src/render/quality.ts`,
  telemetry budget asserts in the render-phase instrumentation
  (`beginDerivedMountPhase`-style phase marks already exist).

## 5. Sources

- Epic Games, UE5 Heterogeneous Volumes / Volumetric Fog / Volumetric Clouds docs (5.3+).
- GEOMAR technical report, "Rendering Large Volume Datasets in Unreal Engine 5: A Survey" (2504.07485v1) — SVT ceilings, chunked-seam failure, int-overflow fixes.
- Real-Time Rendering, 4th ed., ch. 14 — half-res scattering + random-offset raymarch + bilateral depth-aware upsample.
- Brian Karis TAA neighborhood-clamping lineage (via reproduction notes) — history rejection without motion vectors.
- Unity HDRP volumetric reprojection cost reports (3× regression) + Godot #93162 ghosting report — the temporal failure record behind guardrail 1.
