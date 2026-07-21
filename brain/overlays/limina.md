# Engine overlay: limina (Three.js / web, agent-native)

**limina IS the curated Three.js engine hand** that `overlays/threejs.md` flags as a roadmap gap
("no curated engine pack exists yet"). When the target engine is limina, load this overlay instead of
the first-principles `threejs.md` mapping — the capabilities it describes already exist as engine code.

## Spec → implementation (limina engine, `engine/` — currently `js/src/`)

| Bible / design spec | limina engine |
|---------------------|---------------|
| World structure, navigation (`world.md`) | `world.generateRegion` (procedural terrain) + the SoA ECS; instanced meshes |
| Procgen scatter (`constraints.md`) | `asset.scatter` (one InstancedMesh per asset, replay-pinned) + `world.populateBiome` |
| Systems / rules (`systems.md`) | TS modules + the skill registry; gamestate/quest/inventory/combat managers |
| Combat / game feel | fixed-timestep sim decoupled from render; `render.enablePost` (GTAO/bloom/grade) |
| UI / readability | DOM/canvas HUD over the WebGL canvas (out of the WebGPU context) |
| Asset placement | `asset.place` (content-addressed, grounded) — the AssetSource seam |
| Ship | `engine/game/publish.ts` export → the `packager/` container (index.html + runtime + COOP/COEP) |

## The gate is EXECUTED here (the limina difference)

procgen-review is not just described — it runs:

- **Silhouette / readability** → `gates/design/silhouette-gate.mjs`: renders each entity to a flat,
  unlit, fixed-orthographic, no-AA mask on the real GPU (deterministic by construction) and scores
  pairwise mask IoU. Distinct assets PASS; clones/oatmeal HARD-FAIL. Verified falsifiable
  (`gates/design/check.mjs`, run in CI by `tools/director/run-gates.sh`).
- **Functional DoD gate** → `engine/game/gate.ts` (a separate axis — does the loop work?).

## Conventions & gotchas

- Web has a hard draw-call/memory budget — lean into instancing (`asset.scatter`), frustum culling,
  LOD. Do not spawn thousands of individual meshes.
- The agent has **eyes**: `tools/shoot.mjs` renders any web build headless on the real GPU → PNG the
  agent reads. Use it to *see* generated scenes, never swiftshader (it disagrees with the GPU).
- Keep the sim deterministic + data-driven so `constraints.md` stays authoritative and content replays.

## Handoff

`engine-router` passes the Bible as the engine-independent contract; the Bible→GDS router derives the
typed spec the engine builds from. Unlike a no-pack engine, limina then **gates** the output (functional
+ design) before the packager ships it.
