# Implementation Plan — Phase 11: Content & Assets (the solid foundation)

> The *how* for [`phase-11-content-assets.md`](./phase-11-content-assets.md) (the what/why), grounded in the
> current code. **Goal:** deliver the OOB foundation that re-renders the **cottage-on-a-beach effortlessly**
> — the acceptance gate. Six landable chunks (A → F), cheapest + most foundational first, each
> headless-verifiable except the in-tab look. **Status:** ready to build.

## Current state (the exact seams we change)
- **Render** — `engine.ts:createEngine()` (~321–330) builds the `THREE.WebGPURenderer` and **already** sets
  ACES `toneMapping` (exposure 1.0) + `PCFSoftShadowMap`, but gives a **dark background (0x0b0e14)**, a **bare
  camera**, and **no lighting**. Default lights + ground exist only in `browser-entry.ts:buildRenderTarget()`
  (~104–136: ambient + a directional + a ground plane) and `demo.ts` (~16–26) — **not in the engine**, so a
  fresh world is an unlit void. No `scene.environment`/PMREM/IBL, no sky, no material palette.
- **Assets** — `op_read_asset(id)` (`engine.ts:71`) + the `loadGLTF` skill (`skills/three.ts:289–318`,
  `GLTFLoader.parse` → texture rehome for WebGPU → entity spawn → `LoadedResourceMetadata` at `engine.ts:193`)
  are the asset→entity path. No content-addressed registry, no bundled pack, no place-by-id wrapper. The
  content-addressing model to mirror is `terrain/tilecache.ts` (`requestKey` / `tileContentHash` / `TileCache`).
- **Scatter** — `terrain/scatter.ts:scatterProps(tile, seed, ScatterOptions)` (~59–129) → `PropInstance[]`
  (fixed `PropKind`); `props-render.ts:buildPropInstancedMesh(kind, instances)` (~51–80). The tile's **climate
  field is computed but unused** (the Phase-9 "elevation unused" gap). No asset scatter, no logged config.
- **Entities / materials** — `skills/scene.ts:createEntity` (~22–71) → `MeshStandardNodeMaterial` with
  hardcoded color/roughness/metalness; `skills/three.ts:setMaterial` (~54–93). No material palette/abstraction.
- **Terrain** — `world.generateRegion` (`skills/terrain.ts:123–152`) → `ProceduralTerrainSource.generateTile`
  (`procedural.ts:123–150`) → `op_physics_add_heightfield` (`engine.ts:48`) + `terrain/mesh.ts` mesh. Works
  for a beach. No sea-level water surface; `terrain.sampleClimate` exists but is unused.

## Chunk A — Render baseline *(land first; cheapest, biggest, most uniform lift)*
New **`js/src/render-baseline.ts`** — `applyRenderBaseline(engine, preset?)`, called in `createEngine()` after
renderer init (~324–345) so **every** world inherits it:
- **Lighting** — move the default sun (directional) + a hemisphere/ambient fill out of `browser-entry`/`demo`
  into the baseline; soft shadows already on.
- **Environment / IBL** — a **procedural sky → PMREM → `scene.environment`** (Open Q: procedural sky first vs a
  bundled HDRI) so PBR materials get ambient + reflections. This is the single biggest "looks rendered" jump.
- **Sky + ground + camera** — replace the dark `0x0b0e14` background with a sky/gradient; a default ground;
  sensible default camera framing.
- **Preset** — a `RenderBaselinePreset { tonemapping, exposure, sun, sky/env, shadows, ground, camera }` the
  host/agent can override; **on by default**. Refactor `browser-entry.ts` + `demo.ts` to consume it (drop their
  bespoke lights) so there is one source of truth.
- **Verify (headless):** `createEngine()` returns a renderer with tonemapping set and a scene carrying the
  baseline lights + `scene.environment`; a golden config assertion. **UAT:** a fresh scene with a couple
  primitives reads as *rendered*, not a flat void. (The render baseline is a GPU/look concern — headless checks
  the *config*, the browser checks the *look*.)

## Chunk B — Material palette
New **`js/src/materials/palette.ts`** — `MATERIALS` (sand / stone / wood / foliage / metal / water / …) →
`getMaterial(name)` returning `MeshStandardNodeMaterial` presets. Extend `scene.createEntity` + `three.setMaterial`
to accept `material: "<name>"` **alongside** the existing numeric params (back-compat). Terrain + props may pull
from the palette (optional; removes hardcoded materials).
- **Verify (headless):** `getMaterial` returns expected params; `createEntity { material:"wood" }` applies it;
  numeric params still work (back-compat).

## Chunk C — Asset registry + `asset.place` (by id)
New **`js/src/asset-registry.ts`** (mirrors `TileCache`): content-addressed store (assetId/SHA256(bytes) → blob),
versioning, integrity; the export (`export/package.ts`) carries `assets/` + the content hash; add a `hash` field
to `LoadedResourceMetadata`. New skill **`asset.place(id, position, rotation?, scale?, material?)`** (new
`js/src/skills/asset.ts` or extend `three.ts`) wrapping the existing `loadGLTF` pipeline + logging the place
request.
- **Verify (headless):** import a GLTF → expected mesh metadata; content hash stable; export round-trip carries
  the asset + hash; `asset.place` spawns an entity referencing the asset; deterministic.

## Chunk D — `asset.scatter` (by id + `ScatterConfig`, elevation-aware)
New **`scatterAssets(tile, seed, ScatterConfig)`** (in `scatter.ts` or new `terrain/asset-scatter.ts`) mirroring
`scatterProps` but returning `{ assetId, x, y, z, yaw, scale }`. **`ScatterConfig`** = `{ seed, density,
assetIds[], elevationMin/Max (tree line), slopeMax, sizeRange, kindMix, … }` — **uses the existing climate/
elevation fields**, closing the Phase-9 "elevation unused" gap. New skill **`asset.scatter(region|bounds, seed,
ScatterConfig)`** → per-asset `InstancedMesh` (generalize `buildPropInstancedMesh`); the log records the
`ScatterConfig`.
- **Verify (headless):** scatter asset-by-id → instances on-surface (drop parity via `terrain.sampleHeight`),
  deterministic + replays bit-identical (mirror `p9_props`); distinct configs → distinct-but-reproducible worlds;
  elevation rules respected (no trees above the tree line); config in the log.

## Chunk E — Curated CC0 library + the cottage UAT *(the acceptance gate)*
- Bundle a small curated **CC0 beach/nature pack** (cottage, palm, rock/driftwood), content-addressed via the
  registry. (Open Q: Kenney / Quaternius / Poly Haven.) The palette covers sand/wood/foliage/water.
- A **starter scene script** (intent-level, agent-style): `world.generateRegion` (beach) → water at sea level
  → `asset.place(cottage)` → `asset.scatter(palms + driftwood)` → under the render baseline.
- **Verify:** the scene builds **from the script with zero hand-authored geometry**; headless asserts the
  terrain + water + cottage + scattered assets are placed + deterministic. **UAT (the gate):** it looks good with
  **none** of the wrangling the original hero scene needed — A/B against that hand-built scene.

## Chunk F — Companion: water + generator upgrades *(parallel, non-gating)*
- A **render-only sea-level water surface** (a tonemapped plane for the first cut; caustics/refraction later per
  the water note in `worldgen-roadmap.md`). No physics (gameplay water physics is separate, deterministic-sim work).
- Terrain **erosion / climate** (worldgen W1) — parallel; a basic procedural beach suffices for the UAT first cut.

## Sequencing (landable PRs)
**A → B → C → D → E**, with **F** parallel. A+B are cheap and lift *everything*; C+D are the asset core; **E is the
gate**. Each chunk is a PR with its headless tests; the look is UAT per chunk and decisively at E.

## Verification — headless except the look
Per-chunk headless contracts above. The through-line: **determinism + replay parity + export round-trip** hold
for every new content path (same discipline as terrain tiles + props), and the **render baseline is a config the
engine applies by default**. The single human gate is **E's UAT**: the effortless cottage-on-a-beach.

## Risks / open questions
1. **IBL source** — procedural sky → PMREM (recommend; zero asset weight) vs a bundled HDRI (upgrade).
2. **Tonemapping** — keep ACES vs switch default to AgX.
3. **Refactor risk** — moving lighting from `browser-entry`/`demo` into the shared baseline must not regress the
   existing demos (`p8_*`, terrain, coordinator-demo). Keep their look or improve uniformly; the coordinator-demo
   has its own renderer and is unaffected.
4. **CC0 pack** — which source to bundle + license hygiene (CC0 = no attribution burden; verify per-asset).
5. **Headless render path** — the baseline's *visual* effect is UAT-only; headless asserts the applied config,
   not pixels (no GPU in CI).

---

## Status & outcomes (implemented 2026-06)

All six chunks landed on main — expert-built, adversarially reviewed, headless-verified (**74/74, 0 regressions**).
The cottage-on-a-beach gate (E) is met for the build logic; the in-tab LOOK with curated assets is the remaining UAT.

- **A — render baseline (PR #21):** `render-baseline.ts` applied in `createEngine()` — sun + hemisphere fill +
  gradient-sky IBL (PMREM / graceful headless fallback) + ACES + ground/camera; browser-entry/demo consume it.
  Every world is lit by default.
- **B — material palette (merged):** `materials/palette.ts` — 10 named PBR materials; `createEntity`/`setMaterial`
  accept a name (back-compat).
- **C — asset registry + `asset.place` (PR #22):** content-addressed registry; bytes ride the export
  (`assets.jsonl`); replay loads from the package + verifies the committed hash (`commitFields`). *Adversarial
  review caught + fixed an unwired portability contract before merge.*
- **D — `asset.scatter` + `ScatterConfig` (PR #23):** elevation/slope/biome-aware scatter bound to a `regionId`;
  replay over BAKED tiles (model-free `CachedTerrainSource`). *Adversarial review caught + fixed the
  baked-replay / seed-binding / climate-channel gaps.*
- **F — water surface (merged):** render-only sea-level water (`world.addWater`), no physics/replay impact.
- **E — cottage gate (PR #24):** `demos/cottage_beach.ts` assembles the scene from intent-level skills with
  **zero hand-authored geometry** (falsifiable: no `scene.createEntity` in the command stream); deterministic +
  replayable. Asset ids are swappable constants — the curated CC0 pack swaps in by changing 3 lines.

**Remaining for the full gate (UAT + content):** bundle the curated CC0 beach pack (cottage / palm / driftwood)
in place of the stand-in GLTFs (swap the three `*_ASSET` constants in `cottage_beach.ts`), then UAT the look
(`./target/release/limina --window js/src/demos/cottage_beach_window.ts`). The render baseline + palette +
place/scatter are all in; only the curated assets + the human "looks good, no wrangling" check remain.
