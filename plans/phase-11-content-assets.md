# Plan — Phase 11: Content & Assets *(the solid-foundation phase)*

> **Reframe:** Phase 11 leads with **out-of-the-box quality**, not the asset *mechanism*. The goal is a
> Unity/UE-style **solid foundation**: an agent (or a developer) works at the level of *intent* — "a beach
> with a cottage and palms" — and gets a good-looking result, because the engine hands them a usable
> baseline instead of a flat void. Importing/instancing assets and configurable generation are *in service of
> that*, and stay deterministic, content-addressed, and exported.
>
> **The lesson driving this:** the native terrain/object renders so far are rudimentary, and the hero
> cottage-on-a-beach scene only looked good after an enormous amount of hand-authoring geometry in the
> renderer + blind UAT iteration. That is exactly what a real OOB experience must not require. (See
> [[oob-content-quality]].)
>
> **Acceptance gate (the UAT baseline):** re-render the **cottage-on-a-beach effortlessly** — a curated
> cottage asset on generated terrain, palms + driftwood scattered as assets, water at sea level, under the
> default render baseline — built by a short intent-level script with **zero** hand-authored geometry and
> **none** of the original wrangling. If the foundation reproduces that scene effortlessly, it's done.
>
> **Builds on (shipped):** the Three.js WebGPU renderer, `op_read_asset` + the bundled `GLTFLoader`, the
> packages/assets concept, the Phase 8 export (`assets/`), the Phase 9 terrain + **9.1 prop scatter**, and
> [[agent-configurable-generation-seeds]]. **Status:** not started.

## The discipline (unchanged)
The **engine consumes assets/generators behind the skill seam; it never becomes a modeler.** A good default
render baseline is **not** modeling — it's the engine defaults Unity/UE ship. Curated CC0 asset packs are
**content** we bundle behind the asset seam, not a runtime code dependency. Asset *meshes* are pluggable
sources (mirroring terrain's procedural/model/cache): a curated **library**, a **text→3D generator** (a
spike), or a **human GLTF import**. Placement is the deterministic scatter; only the mesh becomes a
referenced, content-addressed asset. Generation is driven by an **agent-set config** recorded in the log.

## The foundation (ordered cheap → highest-leverage)

1. **A default render baseline** — *the new lead; cheapest, biggest, most uniform lift.* Environment/IBL
   lighting (`scene.environment` via PMREM or a bundled neutral HDRI), **ACES/AgX tonemapping + exposure**,
   a default sun + sky + ambient/hemisphere, soft shadows, sensible default PBR materials, a default ground
   + camera framing. A fresh world looks *rendered*, not a flat void — even with primitive geometry. This is
   what would have saved the hero-scene wrangling, and it lifts every demo, asset, and generated world at once.
2. **A curated asset library, placed by id** — bring in **CC0 packs** (Kenney, Quaternius, Poly Haven):
   cohesive, good-looking, public-domain → bundling is content, not a code dep. An agent says "place a
   cottage / scatter a forest" and gets a real asset, not a hand-built box. The direct answer to "no one
   would use the crude native primitives."
3. **A default material palette** — good PBR materials by name (wood / stone / metal / foliage / sand / water)
   so the agent never hand-tunes materials.
4. **High-level placement skills** — `asset.place`, `asset.scatter` (by id + config), plus environment skills
   like `world.setTimeOfDay` / `world.setWeather` — the agent works at intent, not raw geometry. (Some land
   here; the broader character/gameplay vocabulary is Phase 12.)
5. **Starter templates / sample worlds** — begin from a good beach/forest/town and modify, not from a void.
6. **Better native generators** — terrain erosion/climate + a render-only water surface at sea level — the
   floor for the *generated* parts. Tracked in [`worldgen-roadmap.md`](./worldgen-roadmap.md).

## Load-bearing decisions
1. **Render baseline = engine default, swappable preset.** Wire it where every world's renderer/scene is
   built so it's on by default; expose a preset/knobs the agent can adjust, never something each scene
   re-implements. (Where it hooks in is named in the implementation plan.)
2. **Asset = content, referenced by id + content hash.** A content-addressed asset registry holds GLTF/mesh
   blobs, versioned; the export carries them in `assets/`; the runtime loads/instances by id. Extends
   `op_read_asset` + packages, not a new subsystem.
3. **Placement stays deterministic + recompute-or-cache.** `asset.scatter`/`asset.place` reuse the
   `scatterProps` pattern (pure function of seed + region/config); the log records the *request/config*, not
   instance bytes.
4. **Generation config is an agent-facing `ScatterConfig`** (seed, density, slope/elevation incl. **tree
   line**, kind/asset mix, size ranges, asset/style source) — logged → deterministic.

## Workstreams (sequenced to deliver the cottage UAT)
- **A. Render baseline** — tonemapping + exposure, environment/IBL, default sun+sky+ambient, soft shadows,
  default PBR + a small material palette, default ground/camera; on by default for every world; a preset the
  agent can tune. *Verify:* a fresh world's renderer reports the baseline config (tonemapping/env/shadows set)
  headlessly; the in-tab look of a few primitives reads as "rendered" (UAT).
- **B. Asset registry + GLTF import** — content-addressed asset store + versioning; GLTF/glb → engine mesh;
  export packaging in `assets/`; load-by-id + integrity (content hash). *Verify:* import a GLTF → expected
  mesh; export round-trip (hash); load-by-id deterministic.
- **C. `asset.place` / `asset.scatter` (by id + `ScatterConfig`)** — place one asset by id; scatter assets by
  id deterministically (generalize `scatterProps` to emit asset-referencing instances); elevation-aware
  (tree line / bare peaks — also closes the Phase-9 "elevation unused" gap); typed/permissioned/traced; log
  records the config. *Verify:* scatter asset-by-id → instances on-surface (drop parity), deterministic,
  replays bit-identical; distinct configs → distinct-but-reproducible worlds; config in the log.
- **D. Curated CC0 library + material palette** — a small bundled beach/nature pack (cottage, palm, rock/
  driftwood) + the named material palette; the immediate quality jump. *Verify:* place/scatter the library
  assets by id; content-addressed + exported.
- **E. Starter template + the cottage UAT scene** — a short intent-level script (or a starter template):
  generate a beach → place the cottage asset → scatter palms/driftwood assets → water at sea level → under
  the render baseline. *This is the acceptance gate.* *Verify:* the scene builds from the script with zero
  hand-authored geometry; headless asserts the entities/assets/terrain/water are placed + deterministic; UAT
  confirms it looks good with no wrangling (compare to the original hero scene).
- **F. (companion) generators + water** — terrain erosion/climate (worldgen W1) and the render-only water
  surface; raises the generated floor. Parallel, not gating the UAT (a basic procedural beach + a tonemapped
  water plane suffice for the first cut).

## Verification split
- **Headless (CI):** the render-baseline config is applied; the asset registry + GLTF import + export
  round-trip; placement determinism + on-surface + replay-parity; config-driven reproducibility; the cottage
  scene assembles deterministically from the script.
- **UAT (browser):** the in-tab look — the render baseline on a fresh scene, imported/instanced assets, and
  the **effortless cottage-on-a-beach** vs. the hand-wrangled original.
- **Author-side GPU / spike:** the text→3D generator (its own de-risk, like S0).

## Out of scope (first cut)
Animated/skeletal assets (Phase 12 characters); per-asset LOD; a full PBR material *authoring* surface (a
fixed palette is enough); the text→3D generator *implementation* (spike first); gameplay water physics
(deterministic-sim work, separate).

## Open questions
1. Render baseline: bundle a neutral HDRI for IBL, or a procedural sky → PMREM (no asset)? (Recommend
   procedural sky first — zero asset weight; HDRI as an upgrade.)
2. Tonemapping: ACES vs AgX as the default.
3. Asset format scope — GLTF/glb first vs also obj.
4. Curated pack: which CC0 source(s) to bundle for the beach set (Kenney / Quaternius / Poly Haven).
5. Library hosting — bundled dev pack vs pulled from the Phase 13 registry.

---
**Spike (gates the text→3D source):** *Text→3D asset generator* — run a published text/image→3D model
(TripoSR / InstantMesh-class) out-of-process on the dev GPU; measure latency, VRAM, determinism, GLTF
quality; go/no-go for an `asset` generator source. Same shape as the S0 terrain-diffusion probe.
