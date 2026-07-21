# Native Asset-Generation Pipeline — Advisory Plan

**Status: ACTIVE — Chunk A plus B1/B2 shipped; B3 underway.** This is a research-derived program plan
whose Chunk A implementation was authorized on 2026-07-11. Later slices remain independently gated
by their listed dependencies and infrastructure decisions.

Source: the 2026-07-11 deep-research sweep (mesh/material generation, buildings, vegetation/biomes,
terrain materials, rigging, UI) cross-checked against the current code seams.

---

## Goal

Let agents author every asset class limina needs — surface materials, vegetation, biomes,
volumetric enterable buildings, rigged characters, and UI — **natively**, through the existing
pipeline, without violating the cardinal rules. No asset class should require hand-placed
coordinates, a runtime geometry generator in the engine, or a non-deterministic step on the
replay path.

## The organizing principle (decides every tool placement)

Every capability sorts into exactly one tier:

- **(a) Offline host build tool** — Blender bpy / procedural / bakers / retopo / rigging.
  Deterministic, CPU. Emits a whole GLB or a content-pack, consumed via `asset.place` /
  `material.import`. Seams: `tools/blender/`, `tools/rig/`, `tools/qc/`, `tools/asset-fetch.ts`.
- **(b) Remote AssetSource VPS** — neural mesh/material/rig generation. GPU, non-deterministic →
  **cached by content hash as a build artifact**, never on the replay path. Seam:
  `js/src/asset/types.ts` (`AssetSource`; already has `PolyPizzaAssetSource`,
  `GenerativeAssetSource`, `AssetResolver`, `AssetCache`).
- **(c) In-engine skill** — render projections and world state only (grass/scatter renderers, TSL
  materials, water, UI, door operation). **Never geometry generation.** Seam:
  `SkillRegistry.invoke` via the 5-place checklist.

**Non-negotiable funnel:** any tier-(a) or tier-(b) mesh — hand-authored, procedural, or neural —
passes the **retopo → QC → manifest-acceptance** funnel before it is a limina asset
(`tools/qc/asset-sanity.mjs` + `gates/design/asset-qc-gate.mjs` + `assets/manifest.json`). This is
what lets neural generation coexist with "the engine only consumes clean GLBs."

Most target seams already exist. This is an extend-the-systems program, not greenfield.

### Regular assets and hero assets

This program exposes two profiles over the same funnel. The **regular profile** optimizes for reusable
archetypes, throughput, fleet budgets, and standardized review. The **hero profile** specializes focal-point
assets—castles, sacred trees, monoliths, monumental ruins, temples, and comparable landmarks—with an
asset-specific visual thesis, site and approach contract, bespoke interactions, custom LOD review, expanded
production-engine captures, and exact-artifact human approval. It is not a second compiler and cannot bypass
retopo/QC, content identity, compression, lifecycle, performance, or engine-only acceptance.

The dedicated plan and class profiles are [`hero-asset-pipeline.md`](./hero-asset-pipeline.md).

---

## Chunk A — The retopo/QC funnel + material foundation

**Rationale.** This unblocks every later chunk: it is the gate that turns *any* generated geometry
into a shippable asset, and it delivers the fastest visible fidelity win (real PBR terrain/props)
with zero license or determinism risk. Ship it first.

**Delivers.**
- `tools/retopo/*.py` (Blender headless): QuadriFlow remesh → Smart UV / xatlas (MIT) → Decimate →
  Cycles bake (separated DIFFUSE/NORMAL/ROUGHNESS/AO). Then gltfpack / meshoptimizer (MIT) for
  discrete LOD chains. (No open-source Nanite exists; discrete LODs are the path.)
- A CC0 material fetch build tool (extend `tools/asset-fetch.ts`): ambientCG (keyless CC0 REST),
  Poly Haven secondary. Output a `MaterialPack` in the `assets/biome-pack.json` shape.
- **Extend `material.import`** (`js/src/skills/material.ts` + `js/src/materials/material-registry.ts`)
  to carry the **AO** channel (currently albedo+normal+roughness only) so packed ORM is fully used.
- **POM node** option in the shared imported-surface sampling path, consumed by terrain/ground
  materials. Live Three r184 verification corrected the research premise: there is no
  `parallaxOcclusion` block; `parallaxUV` is only a one-step offset. Limina therefore owns one
  bounded pure-TSL height march (`Fn`/`Loop`/`If`/`Break`, explicit-gradient samples) for both
  WebGPU and forceWebGL. The first production scope is full UV POM plus upward-ground projection
  relief for triplanar surfaces; three independent triplanar marches are prohibited until profiling
  justifies their >120-fetch blend-region cost. IQ-style stochastic anti-tiling uses registered
  translations shared by every PBR channel. Hardware tessellation does not exist on the web.

**Tier:** (a) build tools + (c) render-only material extensions. **Colorspace discipline:** albedo
`SRGBColorSpace`, normal/roughness/AO `NoColorSpace`; OpenGL (+Y) normals.

## Chunk B — Vegetation & biome scale

**Rationale.** Highest visible-fidelity payoff per unit work, and the seams (ez-tree, GrassSystem,
`vegetation.scatter`, `bake-trees` RECIPE, `biome-pack.json`) are the most mature. Depends on A only
for the impostor-atlas bake step.

**Delivers.**
- **`vegetation.grassField` skill (c)** — port false-earth's TSL compute grass (MIT): PCG-hash +
  grid-index seeding (no clock/`Math.random`), terrain-mask density in-compute, distance LOD,
  grid-tile streaming. forceWebGL fallback consumes the same canonical grass-field plans through a
  package-selected CPU mount. Extends
  `js/src/skills/grass.ts`. **Shipped 2026-07-11:** canonical signed 32×32/≤1024-slot pages,
  one concatenated native compute kernel/shared storage pair/draw per resident 48m terrain tile,
  one-build async residency with stale-generation rejection and atomic replacement, 1×/4× camera
  LOD, a 230,400 active-plus-pending slot cap, feature-local large-world coordinates, and the
  production forceWebGL streamed CPU fallback.
- **Large-world tree renderer (c) — shipped 2026-07-11.** Live Three r184 backend inspection and a
  SwiftShader falsification gate rejected the proposed Three.ez/BatchedMesh premise: without
  multi-draw, both WebGL and WebGPU submit once per visible object. Limina instead owns five real
  `InstancedMesh` batches per species (branch+foliage at full/reduced geometry, then one impostor),
  keeping the three-rung LOD population-constant at ≤60 draws for 12 species. Signed 48m pages,
  symmetric hysteresis, one pending build, stale rejection, atomic replacement, feature-local
  million-metre coordinates, 24,576 active/30,720 active-plus-pending caps, and a 192 MiB total
  resident budget are enforced. Offline Blender 5.1.2 Cycles-CPU baking emits a self-contained v2
  rotated-diamond upper-hemi-octa atlas with source/reduced hash chain, per-cell silhouette/depth QC,
  atomic evidence-last publication, and manifest validation. Pure-TSL alpha-cutout foliage
  backscatter and four-frame impostor blending compile on native WebGPU and forceWebGL.
- **Tree authoring** — keep ez-tree (`render/tree-source.ts`); add **SeedThree (MIT)** for desert
  L-system species, backlit-leaf SSS, off-thread LOD baker, and its headless seed-first Deno+wgpu
  API (template for a `vegetation.growPlant` skill). Blender Sapling for hero species.
- **Scatter (c)** — sharpen `vegetation.scatter` around MeshSurfaceSampler (weighted) +
  kchapelier/poisson-disk-sampling (MIT, variable density), seeded RNG, per-species
  slope/altitude/moisture envelopes, two-level clustering.
- **Biome pack (RECIPE)** — `biome-pack.json` using the Whittaker temp×precip classifier
  (optionally Minecraft-style multi-noise axes); ground splat rules + vegetation palette + tints +
  transition blend width (kills hard seams). `tools/bake-trees.mjs bakeSpecies` is the RECIPE
  template.

  **B3 correction and current status (2026-07-11):** compiler profile 1.3 already supersedes a
  new Whittaker pass with a deterministic blended 40-biome climate/terrain/hydrology field. The
  legacy seven-role `biome-pack.json` remains compatibility-only. The new strict
  `limina.biome-runtime-pack/v1` is pinned to the metadata-pack hash, bounds each biome to four
  surface and eight vegetation rules, requires provenance-bearing content hashes, and cannot call
  a biome fulfilled while a declared role is missing or unbound. An immutable runtime publication
  now verifies the compiler field and runtime-pack hashes, resolves top-four influences, normalizes
  bound surface/population weights exactly to 65535, and exposes unfulfilled influences without a
  fallback. The first pure population planner uses canonical signed cells plus Limina-owned
  hash-priority variable-radius thinning; negative pages, cross-page minimum spacing, traversal-
  order independence, hard caps, and million-metre feature-local equivalence pass. MeshSurfaceSampler
  and the proposed external Poisson dependency are rejected: the canonical heightfield, not a render
  mesh, remains replay authority. A renderer-independent surface plan also publishes an exact
  65535-normalized 16-slot cell layout over a globally sorted ≤32-role table, fails closed on
  unfulfilled content, and preserves transition weights at million-metre origins. That 16-role
  layout is compile-time input only: a deterministic CPU compositor now collapses each 48m tile to
  one albedo, one normalized OpenGL normal, and one packed ORM map with content/edge hashes. A
  single pure-TSL `MeshStandardNodeMaterial` samples exactly those three maps using feature-local
  UVs. Native WebGPU and forceWebGL both compile/render two texture-distinct tiles through the same
  graph in one draw per tile; the 16-role adversarial compositor and shared negative-coordinate
  borders pass. Publishing these derived composites beside terrain chunks and live B1/B2 population
  consumption remain open.

**Tier:** (c) skills + RECIPE content packs.

## Chunk C — Volumetric enterable buildings

**Rationale.** The highest-value capability gap (enterable/decoratable interiors, operable doors)
and the one most exposed to the retired-assembler failure mode. Must be authored as whole GLBs
offline. Depends on A (funnel) and benefits from D (door rigs).

**Delivers.**
- **Primary pipeline (a)** — Blender bpy parametric whole-GLB: massing → floorplan (graph/BSP,
  seeded) → exterior shell with real openings via **Building Tools (MIT)** → furnished interior via
  **Infinigen Indoors (BSD-3, exports glTF)** → door leaves as separate hinge-origin nodes with
  baked open/close clips → bake ONE GLB.
- **Author-time kit assembler (a)** — rehabilitates the retired kit by moving assembly to
  author-time. Seed from **Kenney CC0** modular buildings; snap on grid, weld boundary verts
  watertight, keep door leaves separate, bake ONE whole-building GLB. Optional bounded **WFC (MIT)**
  for variety. Reuses the `js/src/skills/building/kit.ts` part contract.
- **Two-tier interior LOD** — hero buildings: real baked volumetric interiors, interior loaded via a
  **portal-swap engine skill (c)**. Background buildings: **interior-mapping shader render skill (c)**
  (windows-as-lit-rooms, zero geometry — legal like `applyToonStyle`).
- **Operable doors** — door open/closed + occupancy is **ECS state, not mesh state**: threads the
  5-place first-class-entity-state checklist, with the Three mesh + Rapier revolute joint as the
  projection. A `door.setOpen` skill records the mutation.

**Tier:** (a) authoring + (c) portal/interior-mapping/door skills.

**Two hard constraints from the research:** key doors/rooms by **stable glTF node name / `extras`
id, never array index** (three.js node order is not deterministic — would break replay parity); and
assembly that ever happens in `runLive`/`asset.place` has regressed to the retired-assembler
failure mode — a discrete GLB must pass QC *before* placement.

## Chunk D — Rigging pipeline extension (Blender-first)

**Rationale.** NPCs are "agents with a body"; a deterministic offline rig pipeline is a prerequisite.
Extends existing `tools/rig/`. Independent of A–C except that door/prop rigs feed C.

**Delivers.**
- **Backbone (a)** — Rigify metarig fitted by uniform scale to the canonical `rig_contract.py`
  template (no per-mesh landmark detection needed given canonical proportions); Robust Weight
  Transfer (GPL-3.0 addon) / Data Transfer from a shipped canonical donor body; Blender-native
  constraint retarget + `nla.bake` onto cgspeed CMU BVH (free) + procedural Idle/Walk. Baked as
  named GLB clips (`idle`/`walk`, per `character-body.ts`).
- **Props/creatures (a)** — trivial bpy hinge-bone generator (doors/levers/chests → whole GLBs with
  an embedded `open` clip; serves Chunk C) + Rigify quadruped metarigs.
- **Neural add-on (b)** — **UniRig (MIT)** as a GPU subprocess / remote AssetSource, only for
  off-template meshes. Cache by content hash; never a live-replay step.
- **Rig round-trip gate (`pNN`)** — export hardening (apply scale, no non-uniform bone scale,
  +Y-up + Always-Sample, deform-bones-only, real material slot-0) → re-import → AnimationMixer plays
  → SkinnedMesh deforms → albedo `SRGBColorSpace`. License provenance carried in each `.card.json`.

**Tier:** (a) Blender pipeline + (b) UniRig VPS.

## Chunk E — Neural mesh/material generation as a remote AssetSource

**Rationale.** The organic-hero-asset and cloud-asset-monetization path. Deliberately last: it is the
highest infra cost (GPU VPS) and depends on A's funnel to be shippable. Procedural (Geo Nodes /
Material Maker) is the *default*; neural is opt-in on top.

**Delivers.**
- **Mesh gen (b)** behind `AssetSource`: **TRELLIS (MIT)** all-rounder + **Step1X-3D (Apache-2.0,
  full PBR)** — the only permissive model that already outputs separated PBR maps. TripoSG (MIT) +
  Paint3D (Apache-2.0) as a shape-then-texture chain; TripoSR (MIT, <0.5s) for grey-box proxies.
  Output → Chunk A retopo funnel.
- **Procedural material generation (a)** — Material Maker (MIT, CLI, JSON graphs) + Cycles bake for
  tileable PBR sets.
- **TSL node-material authoring skill (c)** — a JSON material-graph schema → TSL, seeded with
  tsl-textures (MIT) + MaterialX noise; forbid compute/storage nodes for forceWebGL portability;
  keep baking noise to `DataTexture` (proven `deno_webgpu` path).

**Tier:** (b) neural VPS + (a) procedural bakers + (c) TSL authoring.

## Chunk F — UI system

**Rationale.** Independent of A–E; needed for a playable world. Extends the **existing** `ui.*`
skills — reconciled correction: `js/src/skills/ui.ts` (`ui.update`/`ui.remove`), `js/src/ui/manager.ts`
(`UiManager`), and `hud_feed.ts` (`TraceHud`) already exist.

**Delivers.**
- **DOM/CSS overlay substrate** — renderer-agnostic, WebGPU/TSL-safe, works in export-playback and
  editor. (In-scene GLSL UI renders a white square under native WebGPU — avoid.)
- **JSON-UI-schema skill (c)** — zod schema → pure DOM renderer bound to `inspector.snapshot`/ECS.
  UI holds no authoritative state (rule #11); every UI action is an `AuthorCommand` via
  `SkillRegistry.invoke` (rule #5); record screen *definitions*, leave pure presentation unrecorded.
- **CSS2DRenderer** nameplates/health bars + raycast occlusion. **Kenney UI Pack + Fantasy borders
  (CC0)** via CSS 9-slice + design-token variables.
- **Editor tooling** — Tweakpane (MIT) inspector panels + lil-gui (MIT) debug. Editor-only, never in
  the log.

**Tier:** (c) skills + editor libs.

---

## Sequencing (landable PRs)

Each row is a vertical slice (implementation + gate + evidence). Order respects dependencies; within
a chunk, slices land independently.

1. **A1** — `tools/retopo/` Blender chain + gltfpack, wired into `check:assets` +
   `asset-qc-gate.mjs`. (Unblocks all generated geometry.)
2. **A2** — CC0 material fetch → `MaterialPack`; `material.import` +AO channel. `pNN` replay parity.
3. **A3** — shared pure-TSL POM + stochastic anti-tiling sampler, wired into imported ground
   materials and the bounded upward triplanar projection. Real-GPU proof (2 angles).
4. **B1 — shipped** — `vegetation.grassField` TSL compute skill + native camera residency +
   forceWebGL fallback. Determinism, lifecycle-fault, native WebGPU, and Chromium gates pass.
5. **B2 — shipped** — five-draw/species true-instanced tree renderer + offline v2 hemi-octa
   impostor bake. Native WebGPU and forceWebGL proofs pass.
6. **B3 — underway** — strict runtime content pack, immutable top-four publication, pure
   variable-radius population, bounded surface plan, derived three-map tile compositor, and shared
   three-sample TSL terrain material shipped; compiler/stream publication and B1/B2 runtime
   consumption/replay proof remain.
7. **D1** — Rigify + Robust Weight Transfer + retarget-bake extension of `tools/rig/`; rig
   round-trip `pNN` gate. (Can run parallel to B.)
8. **D2** — bpy hinge-bone prop/door rig generator. (Feeds C.)
9. **C1** — Blender bpy whole-building pipeline (Building Tools + Infinigen Indoors). QC-gated GLB.
10. **C2** — author-time kit assembler (Kenney seed + optional WFC). QC-gated GLB.
11. **C3** — portal-swap interior skill + `door.setOpen` (5-place state) + interior-mapping LOD skill.
12. **F1** — JSON-UI-schema `ui.*` extension + DOM overlay + CSS2D nameplates.
13. **E1** — TRELLIS + Step1X-3D behind `AssetSource` (VPS), output → A1 funnel. (Infra-gated.)
14. **E2** — Material Maker procedural bakers + TSL node-material authoring skill.
15. **D3 / E-adj** — UniRig VPS backend (opt-in, off-template meshes only).

## Verification

- **Every skill:** zod in+out; registered in `registerCoreSkills`; permission in `permissions.ts`;
  `check:determinism` + `check:portability` pass; nested invokes forward `chainId`; a `pNN` gate
  with record→replay→`compareWorldState` bit-identical where state is produced;
  `run-gates.sh --quick` green.
- **Every asset/GLB:** standalone GLB + `.card.json` + QC render before placement; `check:assets`
  clean; `asset-qc-gate.mjs` pass (palette/surface envelope + fidelity floor); GLB round-trip
  (export → GLTFLoader re-import → renders, albedo `SRGBColorSpace`); real-GPU read from ≥2 angles,
  judged shippable ≥ fidelity floor.
- **Every gate:** exit-code contract (0/1/2); proven falsifiable (a broken input fails it, proof in
  code); wired into `run-gates.sh`.
- **Neural (tier b):** output is a cached build artifact keyed by content hash; the cache entry, not
  the generator, is what the replay path sees. Determinism is guaranteed by caching, not by the model.
- **Dual-path:** TSL materials/grass verified under both native WebGPU and forceWebGL; watch the r171
  `DataTexture` WebGPU-vs-WebGL sampling divergence when checking parity.
- **UI:** screen definitions recorded and replay-identical; pure presentation not recorded; verified
  in export-playback and the editor.

## Risks / open questions (need sign-off)

1. **GPU VPS infra (Chunks D-neural, E).** Standing up a CUDA host (16–29 GB VRAM) is real cost and
   ops. Approve before E1/UniRig, or defer both and ship procedural-only (Chunks A–C, F stand alone
   without any GPU backend). **Decision needed.**
2. **License acceptance.** Excluded on license by default: Hunyuan3D-2.x (territory + MAU gate),
   Stable-Fast-3D ($1M rev cap), LLaMA-Mesh/MeshAnything/Text2Tex/AMASS (non-commercial),
   Noesis/Auto-Rig Pro/Mixamo-as-data. Confirm these stay excluded, or explicitly opt in. **Decision.**
3. **GPL-3.0 in the offline rig backend.** Robust Weight Transfer (GPL-3.0 addon) is fine as an
   offline tool emitting data GLBs (like Blender itself), but must not be statically linked/shipped in
   a binary. Confirm this boundary is acceptable. **Decision.**
4. **Verify-before-use (not license-confirmed this pass):** Spiri0 FFT ocean, content_aware_tiles,
   Bandai-Namco *dataset* (loader is MIT), Neural Blend Shapes, TriFlow (no public repo — do not plan
   around it). Each needs a LICENSE read before adoption.
5. **Scope.** This is a program, not one slice. Recommend approving Chunk A first (fastest payoff,
   zero risk, unblocks the rest), then re-deciding B vs C vs D ordering against current priorities.
6. **Web-infeasible, do not attempt:** Nanite/virtual geometry (spec-blocked on 64-bit atomics);
   hardware tessellation (absent on WebGPU/WebGL2). Called out so no slice assumes them.
7. **Interaction with in-flight work.** The working tree already has heavy biome/vegetation/fidelity
   changes (`biome-*.mjs`, `visual-fidelity-floor.ts`, water refactors). Chunks A/B must reconcile
   with that branch state before landing, not fork from a stale assumption.

## Status & outcomes

_(Filled after slices land — per §3, in a separate `docs(...)` pass.)_

- [x] Chunk A — **A1, A2, and A3 shipped.** A1 provides the pinned Blender 5.1.2
  static-opaque QuadriFlow/Smart-UV/Cycles-CPU bake, packed ORM, meshoptimizer LOD, self-contained
  GLB boundary, repository asset-sanity + mechanical-QC checks, atomic evidence-last publication,
  and aggregate host-gate coverage (`tools/retopo/`). A2 provides the ambientCG v3 CC0 fetcher,
  provenance-complete forest-ground pack, AO-aware content-addressed `material.import`, and replay
  parity. A3 adds opt-in, replay-pinned displacement; a bounded max-24 pure-TSL white-high POM
  march; explicit-gradient two-translation stochastic anti-tiling shared across every PBR channel;
  full UV relief; and bounded upward-XZ triplanar relief. CPU intersection/graph tests, native
  WebGPU shader compilation, and forceWebGL real-pack two-angle POM-vs-control readback all pass.
  This closes the material/tooling chunk, not the Project Gorgon scene-fidelity release gate.
- [ ] Chunk B — **B1 and B2 shipped; B3 mechanical production path and owner-approved browser
  candidate shipped; formal release closure remains.** B1 provides the registered/replay-pinned authored
  skill plus a shared production streaming controller. The exact radius-two 48m window is locked
  at 202,212 active slots, 25 resident tile draws, and at most 222,376 active-plus-largest-pending
  slots under 1×/4× LOD. Canonical compute pages concatenate into one signed-coordinate 2D upload,
  one kernel, one storage pair, and one `InstancedMesh` per terrain tile, avoiding the rejected
  289-program/page design. Native WebGPU camera relocation proves fine/coarse replacement and
  storage-backed rendering; Chromium forceWebGL proves the camera streamer publishes CPU grass
  without constructing compute. Cleanup faults aggregate only after all resources/callbacks are
  attempted. B2 provides the source→reduced→impostor accepted-asset chain, deterministic three-rung
  residency, five true instanced batches per species, pure-TSL foliage/impostor materials, v2
  rotated-diamond upper-hemi-octa CPU bake and QC, exact cleanup, browser prewarm, and both
  `asset.scatter` and editable `vegetation.scatter` integration. Native WebGPU renders 1,152 mixed-
  rung trees through five draws; SwiftShader forceWebGL compiles the same graphs from two angles;
  the NVIDIA Xid log remains clean. These are system/performance invariants, not scene-fidelity
  approval, and no test atlas is an accepted production scene asset. B3 now deterministically publishes
  and retrieves the complete 256-chunk 1.4 world/content closure, and the exact v13 production-scene
  artifact is explicitly owner-approved against the locked Project Gorgon floor. Its browser construction
  path was subsequently reduced from 402.1s to 46.0s without changing manifest, camera, or scene counts.
  The bundle remains a candidate because native-backend, visual-regression, lifecycle, target-hardware,
  compression, and post-buffer evidence remain open.
- [ ] Chunk C
- [ ] Chunk D
- [ ] Chunk E
- [ ] Chunk F
