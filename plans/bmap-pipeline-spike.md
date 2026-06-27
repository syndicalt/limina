# Spike (parked): Real-World Geo → limina World (a "bmap" pipeline)

> **Type:** de-risking spike · **Status:** PARKED (idea captured 2026-06-27; not started, not scheduled) · **Tier:** post-MVP
> **Parent:** [`post-mvp-roadmap.md`](./post-mvp-roadmap.md) · sibling to [`worldgen-terrain-diffusion-spike.md`](./worldgen-terrain-diffusion-spike.md)
> **Inspiration:** [bmap.io](https://bmap.io/) — a web tool that turns any spot on Earth into "a clean, low-poly 3D world." Bounding box in → a layered GLB out (three.js today; UE5/Roblox planned). "No GIS software. No manual modelling. No wrangling elevation files in Blender at 2am."

## The idea
A limina **generation backend** that turns a real-world location (a bounding box) into a limina region — heightfield terrain + buildings at true footprint/height + roads + shoreline + canopy, at 1:1 scale. The agent says "build me this place" (a bbox or a named location) and the deterministic pipeline assembles the world.

## Why it fits limina (the same shape as the terrain-diffusion backend)
- **It's a generation source behind `world.generateRegion`**, exactly like the procedural source and the [terrain-diffusion model backend](./worldgen-terrain-diffusion-spike.md): an external/optional data pipeline whose output is **baked into the content-addressed tile/asset cache** and the durable log records the *request* (the bbox + data-source versions + a content hash), **never a runtime/export dependency**. Replay loads the baked region; the engine never calls out to OSM at play time.
- **Agent-configurable generation** ([[agent-configurable-generation-seeds]]): the agent sets the config (bbox / place name / LOD / layers), a deterministic pipeline builds the world. No GIS wrangling — the exact OOB-quality lever ([[oob-content-quality]]).
- **Author-once, export-everywhere** ([[north-star-vision]]): the real-world world becomes a limina world (deterministic, replayable, the portable log) — then re-exports to web/GLB/etc. limina's export is the same artifact bmap produces, plus interactivity + the agent layer.
- **Engine stays the substrate** — the geo pipeline lives behind the skill seam; the engine owns the heightfield collider + mesh + log, never the GIS.

## Open data sources (all open / permissive — content, not a code dep)
- **OpenStreetMap** — building footprints, roads, land use, water (ODbL — attribution/share-alike; check export licensing).
- **Overture Maps** — buildings (with heights), transportation, places (open).
- **Copernicus DEM** (GLO-30 etc.) — elevation → the heightfield (free, global, ~30 m).

## Sketch of the pipeline (mirrors S0/S1 of the model spike)
1. **bbox → tiles**: map the bbox to limina's tile grid (a `TerrainSource` like `ModelTerrainSource`); DEM → heights (the existing int16→[0,1]+origin/scale convention); seam-consistent across tiles.
2. **vector layers → placed content**: OSM/Overture building footprints + heights → extruded building meshes (or asset instances) placed by id; roads → ribbons/decals; water → the render-only water surface at the right level; canopy/land use → `asset.scatter` with biome-appropriate assets ([[render-backend-gotchas]] for the render seam).
3. **bake + log**: the assembled region bakes into the tile/asset cache + export; the log records the bbox + source snapshot versions + content hash → deterministic replay, source absent.
4. **out-of-process / off-loop**: fetching + meshing is authoring-time (seconds–minutes), never in the frame loop — same discipline as the model bake.

## Unknowns to retire (if/when un-parked — do an S0 first)
1. **Building reconstruction quality** — extruded footprints from OSM/Overture heights: good enough for the stylized low-poly look? Where heights are missing (estimate from levels/area)?
2. **Licensing** — OSM ODbL share-alike on exported worlds; Overture/Copernicus terms. What attribution/obligations ride a shipped limina export? (Load-bearing — decide before building.)
3. **Tiling + seam consistency** of the DEM + vector data at limina's tile resolution; CRS/projection handling (lat/lon → local metric).
4. **Determinism** — pin data-source snapshots (OSM changes daily) so a bbox reproduces; content-hash the inputs.
5. **Scale** — large bbox = many tiles + thousands of buildings vs `MAX_ENTITIES` / instancing budget.

## Recommendation / sequencing
PARKED until the active roadmap threads land (same posture as the [factory-sim](./factory-sim-post-roadmap.md)). When un-parked: an **S0** (one bbox, stock open-data tools, out-of-process, measure quality + licensing) gates an **S1** (`world.generateFromLocation` skill seam over the baked source — identical shape to the terrain-diffusion S1, reusing `ModelTerrainSource`/`CachedTerrainSource` + `asset.place`/`asset.scatter`). Hold the standing principles throughout: off the frame loop, deterministic + replayable, engine = substrate (the geo pipeline behind a skill, never an engine dependency).
