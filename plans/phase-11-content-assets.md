# Plan — Phase 11: Content & Assets

> Make agent-authored content look *intentional* and *reusable*: import and instance real assets, and drive
> generation from **agent-configurable seeds** — all deterministic, content-addressed, and exported.
> **Goal:** an agent places/scatters assets by id and configures generation (look, density, biome rules);
> assets import (GLTF) once and instance everywhere; everything stays deterministic + replayable + portable.
> **Gate:** an agent calls `asset.scatter` / `scene.place` with an asset id; the asset imports + is
> content-addressed + ships in the export; placement is the deterministic scatter; a generation **config**
> (seed/density/tree-line/kind-mix) the agent sets is recorded in the log and reproduces the exact world.
> **Builds on (shipped):** `op_read_asset`, the bundled three `GLTFLoader`, the packages/assets concept, the
> Phase 8 export (`assets/`), the Phase 9 terrain + **Phase 9.1 prop scatter**, and the agent-configurable
> generation-seeds direction ([[agent-configurable-generation-seeds]] in memory).
> **Status:** not started.

## The discipline (unchanged from terrain/props)
The **engine consumes assets/generators behind the skill seam; it never becomes a modeler.** Asset *meshes*
are pluggable sources (mirroring terrain's procedural/model/cache): a **library** (Phase 13 marketplace
content), a **text→3D generator** (a spike — the "agent generates the art" source, author-side, output baked),
or a **human GLTF import** (Blender = one source). **Placement is the deterministic scatter; only the mesh
becomes a referenced, content-addressed asset.** Generation is driven by an **agent-set config** recorded in
the log, so the agent's art-direction choices *are* the authored, portable world.

## Load-bearing decisions
1. **Asset = content, referenced by id + content hash.** An asset registry holds GLTF/mesh blobs, versioned +
   content-addressed; the export carries them in `assets/`; the runtime loads/instances by id. Extends
   `op_read_asset` + packages, not a new subsystem.
2. **Placement stays deterministic + recompute-or-cache.** `asset.scatter` reuses the `scatterProps` pattern
   (pure function of seed + region); the log records the *request/config*, not instance bytes.
3. **Generation config is an agent-facing `ScatterConfig`** threaded through the skill (seed, density,
   slope/elevation rules incl. **tree line**, kind/asset mix, size ranges, asset/style source) — logged →
   deterministic. This is the template for all content generation.

## Workstreams
### A. Asset registry + GLTF import (foundational, reusable for ALL future content)
- Content-addressed asset store + versioning; GLTF/glb import → engine mesh; export packaging in `assets/`;
  an asset load skill/op + integrity (content hash).
- **Verify (headless):** import a small GLTF → a mesh with the expected geometry; round-trips through the
  export (content-hash verified); load-by-id is deterministic.

### B. `asset.*` / `prop.*` placement skills
- Place/scatter/instance by asset id (generalize `scatterProps` to emit asset-referencing instances);
  typed/permissioned/traced; the log records the request/config.
- **Verify (headless):** an agent scatters asset-by-id → instances on the surface (drop parity), deterministic,
  replays bit-identically; instanced render math matches placement (CPU matrices, as in `p9_props`).

### C. Agent-configurable generation seeds
- Promote `ScatterOptions` → the agent-facing `ScatterConfig` (decision 3), threaded through the terrain/asset
  skills, **elevation-aware** (tree line / bare peaks — also closes the Phase-9 "elevation unused" gap). Demo
  presets (lush lowland forest vs sparse rocky steppe).
- **Verify (headless):** distinct configs → distinct but reproducible worlds; the config is in the log; same
  config+seed ⇒ byte-identical placement.

### D. Pluggable asset sources
- **Library first** — a small curated low-poly pack (the immediate quality jump for the terrain demo).
- **Text→3D generator** — *spike-gated* (see the spike): de-risk a text→3D model running author-side (like the
  S0 terrain probe) before wiring it as a source.

## Verification split
- **Headless (CI):** the registry + GLTF import + export round-trip; placement determinism + on-surface +
  replay-parity; config-driven reproducibility; instance-transform math.
- **Author-side GPU / spike:** the text→3D generator (its own de-risk, like S0).
- **UAT (browser):** the in-tab look of imported/instanced assets.

## Out of scope (first cut)
Animated/skeletal assets (Phase 12 characters); per-asset LOD; a full material/PBR authoring surface; the
text→3D generator *implementation* (spike first).

## Open questions
1. Asset format scope — GLTF only first vs also glb/obj.
2. Where generated assets are cached/keyed (by prompt+config hash, like terrain tiles).
3. Library hosting — bundled dev pack vs pulled from the Phase 13 registry.

---
**Spike (gates workstream D):** *Text→3D asset generator* — run a published text/image→3D model (TripoSR /
InstantMesh-class) out-of-process on the dev GPU; measure latency, VRAM, determinism, and GLTF quality; decide
go/no-go for an `asset` generator source. Same shape as the S0 terrain-diffusion probe.
