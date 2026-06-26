# Plan — Phase 9.1: Prop Scatter (trees, rocks, grass)

> A bounded extension of **Phase 9** terrain — naturalistic detail on top of the heightfield.
> **Goal:** the terrain grows **trees, rocks, and grass**, placed **deterministically** from the tile's own
> shape (slope + elevation), streamed with the terrain, and **baked into the export** so replay and browser
> playback reproduce the exact same props.
> **Gate:** a region generates with props; each prop sits **on the terrain surface**; the **same seed +
> tile reproduces the exact props** (bit-identical); props stream in/out with their tile; and they ship in
> the export (no re-randomization on load).
> **Builds on (shipped):** Phase 9 terrain — `TerrainTile` (heights + climate), `op_physics_add_heightfield`,
> `TerrainStreamRenderer`, the tile cache + `tiles.jsonl` export, the procedural + model sources, and the
> free-fly demo.
> **Status:** in progress.

## The discipline (identical to terrain — this is the whole point)

Props are a **pure function of (seed, tile)**. A deterministic scatter reads the tile's **heights** (surface +
slope + elevation), seeds a per-tile RNG, and emits prop **instances**. Those instances are part of the tile
artifact — **serialized bit-exact, content-hashed, and exported** alongside the heights. Replay/playback
resolve them from the cache; nothing re-randomizes on load, so a prop world replays **bit-identically** (the
same gate the terrain already meets). Props are **visual** (instanced meshes); the heightfield stays the
collider (prop colliders are a later option).

Why slope+elevation, not climate, for the first cut: heights are present on **every** source (procedural
**and** model), so the scatter is source-agnostic and unambiguous. The climate channels differ between sources
(procedural 3-ch vs model 5-ch) — biome-driven prop *variety* is a clean follow-up once those are unified.

## Load-bearing decisions (get these right — they're exported)

1. **The prop instance** `PropInstance { kind, x, y, z, yaw, scale }`, where `y` is the **terrain surface**
   at (x,z) (same bilinear formula as the mesh → drop parity). **Props are DERIVED, not stored:** because
   `scatterProps(tile, seed)` is a portable-deterministic pure function (only IEEE ops — no `Math.random`/
   `sin`/`Date`), props are **recomputed from the cached tile on load** — zero export bytes, and since the
   first cut's props are **render-only** (no entities, no colliders, no world-state) they have **no replay
   impact**. (Pinning props in the export for cross-engine-version stability is a later option.)
2. **Deterministic scatter** — `scatterProps(tile, seed) -> PropInstance[]`: a seeded RNG (hashed from seed +
   the tile's world origin) walks a jittered candidate grid; per candidate it bilinear-samples height + the
   local **slope** (height gradient) and decides **kind** (steep → rock; moderate-flat below the snow line →
   tree; flat → grass) and **accept/density**, then places the prop on the surface with an RNG yaw + scale.
   Pure → cacheable → replay-exact.
3. **Instanced rendering** — one `THREE.InstancedMesh` per kind (trees / rocks / grass), low-poly **procedural**
   geometry (no external assets). Mounts/unmounts **with the tile** (extends `TerrainStreamRenderer`).
4. **One scatter, every source** — `scatterProps` is a standalone deterministic function over a `TerrainTile`,
   so procedural, model, and cached tiles all get the same props; the cache/export stores them with the tile.

## Workstreams

### A. Scatter generator (pure, headless) — MINE, the load-bearing core
- `js/src/terrain/scatter.ts`: `PropInstance`, `PropKind`, `scatterProps(tile, seed, opts?)`. Deterministic;
  props on the surface; density/kind respond to slope + elevation.
- **Verify (headless):** `js/test/p9_scatter.ts` — same (tile, seed) ⇒ **byte-identical** props; every prop's
  `y` equals the terrain surface at its (x,z) (drop parity for props); **steeper terrain yields more rocks,
  flatter yields more trees/grass** (the placement actually reads the shape); a different seed differs.

### B. Prop geometry + instanced render + streaming (geometry testable; render UAT)
- `js/src/terrain/props.ts`: pure low-poly geometry for tree/rock/grass (positions/indices/normals) +
  `js/src/terrain/props-render.ts`: an `InstancedMesh` per kind, and extend `TerrainStreamRenderer` to mount/
  unmount a tile's prop instances alongside its mesh.
- **Verify (headless):** geometry is finite + has the expected vertex/triangle counts; the per-tile instance
  matrices place each instance at its `PropInstance` transform (so the render matches the scatter). Render UAT.

### C. Determinism / portability (headless) — *replaces export serialization*
- Props are recomputed via `scatterProps(tile, seed)`, so the load-bearing property is that the scatter is
  **portable-deterministic**: byte-identical on the author's machine and the playback machine (only IEEE ops).
- **Verify (headless):** same (tile, seed) ⇒ byte-identical props (in `p9_scatter`); and since props are
  render-only, the Phase 9 terrain replay-parity is **unchanged** (props add no world state). Confirm no
  `Math.random`/`Date`/`sin` in the scatter path.

### D. Demo wiring (headless data-path test; render UAT)
- Mount props in the fly demo (`browser-entry` terrain path) so flying shows trees/rocks/grass on the hills.
- **Verify (headless):** `scatterProps` → geometry/instance path is finite + deterministic over several tiles.

### E. Adversarial review
- Determinism real; on-surface exact; export bit-exact + hash-verified; replay-parity genuine + falsifiable;
  instance transforms match the scatter; no reward-hacks.

## Verification split
- **Headless (CI):** scatter determinism + on-surface + slope response; prop serialization round-trip + hash;
  **replay-parity of a prop world**; instance-transform math. With the procedural source — **no model**.
- **UAT (browser + GPU):** the in-tab render of trees/rocks/grass while flying.

## Out of scope (first cut)
Prop physics colliders (visual only); per-prop LOD / billboard-at-distance; external/authored prop assets;
wind/animation; climate-driven biome variety (slope+elevation only for now).
