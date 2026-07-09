# World Builder → AAA Terrain, Biomes & World

Turn the Design Space map painter into a full agent-native world editor — the World Machine / Gaea /
Unreal Landscape bar — whose every stroke compiles into a walkable, swimmable 3D world across surface,
underground, and sky.

- **Interactive plan:** `plan-1afde76922e149e5` (agent-native Plans). This file is the authoritative,
  source-controlled copy.
- **Status:** APPROVED 2026-07-09 (all decisions locked, below). Phase 0 underway — Slice 0.1 shipped
  (`7819bdc`). See §Status & outcomes.

---

## Orientation

**Two authoring surfaces, one IR.** The **Atlas** (2D top-down painter) owns what reads top-down:
terrain shape at map scale, water bodies, rivers, coastlines, biome + climate painting, road/POI layout.
The **3D editor** (in-engine viewport) owns what can't be top-down: cave/tunnel carving, overhangs,
arches, cliff undercuts, fine sculpt, floating-island shaping, precise scatter. Both write the same
`WorldMap` IR (+ a new underground layer). Rule of thumb: height/mask/polygon field → Atlas; true-volume
or sub-metre → 3D editor.

**Systems vs. content.** The engine gains a small set of SYSTEMS (heightfield, multi-layer terrain,
water/hydrology, a biome-definition registry, splat, scatter, POI stamps, streaming). The vast taxonomy
ships as a CONTENT LIBRARY on those systems — a biome is a DATA def (climate band, material, veg
palette, resource/spawn tables, water tint, ambient audio) in a content-addressed registry, the same
pack pattern already shipping. So "do we cover Tundra → Nether" is a content question, not an engine
rewrite. Cardinal-rule aligned (extend the system).

**Grounded diagnosis** (five source audits + one adversarial review, all confirmed file:line):

| Symptom | Root cause | Reality |
|---|---|---|
| Mountains cap at +48m | `tools/design/frontend/map-elevation.js:12` u8 raster `ELEV_MAX_Y=48` | 64m span; nothing downstream caps height. |
| Lakes won't fill | `js/src/world/worldmap.ts:148` scalar `seaLevel`; `map-raster.mjs:402` clamps depressions up | No water-body concept anywhere. |
| Rivers don't flow | `js/src/water.ts:345` `buildRiverRibbon` static material | Sea water is animated TSL; rivers are a draped static ribbon. |
| Crude river carving | `map-raster.mjs:506` relative 3m gully; `projectWaterways:234` drops `class` | Depth/width don't vary by stream order; no meander/valley/floodplain. |
| Not swimmable | 0 gameplay hits for swim/buoyant/submerged; `player.ts` capsule ignores water | No water volume, submerged test, or swim state. |
| Biomes are flat | `map-paint.js:295` 8 winner-take-all classes; `climate.mjs` exists but is a DEAD global scalar | No taxonomy, blending, or per-biome material/veg. |
| No erosion | `js/src/world/pipeline/erosion.mjs` used by the procedural gen only; never called in `map-raster.mjs` | Biggest gap vs Gaea — and the module already exists (the free win). |

---

## Chunks (the eight pillars)

Each pillar is a system the engine gains; content it enables is authored on top. "Authored in" = Atlas /
3D editor / engine.

### P1 — Terrain shape  (Atlas + 3D)
u16 heightfield (−500…+9,000m), sculpt/erode brushes, a landform-stamp system, an erosion pass. Enables
mountains, hills, plateaus, mesas, canyons, dunes, badlands, volcanoes, hoodoos, arches, pillars.

### P2 — Multi-layer world  (3D, mostly)
An **SDF + sparse-voxel** underground layer (true volume) + overhang/undercut + an aerial layer. Enables
caves, tunnels, dripstone, magma chambers, natural arches, sea stacks, floating islands.

### P3 — Water & hydrology  (Atlas)
Per-basin water bodies + depth zones, rivers (stream order / flow / waterfalls), coastal features,
swimmable volume. Enables ocean, reef, kelp, estuary, lake, marsh/swamp/bog, glacier, beach, fjord,
atoll; and swim.

### P4 — Biome system + full library  (Atlas)
A data-driven biome registry, spatial climate (extend the dead `climate.mjs`), blended borders,
auto-rules (snow-by-height, rock-by-slope), influence overlays. Ships the **full ~40** up front: WWF
core (tundra → mangrove) + aquatic + fantasy (volcanic/crystal/fungal/enchanted/blighted/nether).

### P5 — Surface detail  (Atlas + 3D)
Slope/height/biome splat materials + flora scatter packs. Enables grass/moss/rock/snow/ash;
trees/cacti/reeds/kelp/coral/giant-fungi/bioluminescent flora.

### P6 — World content  (Atlas layout + 3D precise)
POI/settlement/road/resource stamps + procedural layers. Enables villages, ruins, roads, bridges,
dungeons, shrines, ore/herb nodes, spawn zones. (Roads-to-3D is the project's own tracked #1 P6 gap.)

### P7 — Gameplay overlays  (Atlas)
Climate/wind + biodiversity/danger + wildlife spawn tables + seasonal/weather. Enables corruption
spread, pollution/radiation, protected/hostile zones, seasons.

### P8 — Scale & streaming  (engine)
Paged fixed-size tiles + LOD rings around the camera (beyond the current ~1.5km master-field ceiling at
`js/src/terrain/map-source.ts:53`).

**Taxonomy coverage** (the direct check that nothing on the requested list is dropped):

| Category | Pillar(s) | Authored in |
|---|---|---|
| Core terrestrial biomes (tundra, taiga, temperate/tropical forests, savanna, prairie, desert, mangrove…) | P4 + P5 | Atlas |
| Aquatic & wetland (ocean/reef/kelp/estuary/river/lake/marsh/swamp/bog/glacier/coastal) | P3 + P4 | Atlas |
| Geological (ranges/volcano/mesa/canyon/cliff/badlands + caves/underground/arches) | P1 surface + P2 underground | Atlas + 3D |
| Fantasy/sci-fi/special (lava/crystal/fungal/enchanted/blighted/floating/wasteland/alien/nether) | P4 defs + P7 overlays + P2 floating | Atlas + 3D |
| Vegetation/flora/ground cover | P5 | Atlas + 3D |
| Man-made / POI / infrastructure / resources | P6 | Atlas + 3D |
| Overlays/modifiers/gameplay (climate, wildlife, seasonal, multi-layer) | P7 + P2 | Atlas |

---

## Data-model bets (lock in the foundation phase)

Expensive-to-undo IR shapes. Additive-optional + `migrateWorldMap` keep old maps loading.

- **ReliefGrid** — `encoding: 'u8'|'u16'` (absent = u8 discriminator) + real range; resolution scales with map size.
- **WaterBody[]** (new) — per-basin `level` / `depthZones` / `footprint` / `kind`.
- **BiomeDef** (new, registry) — `climate {tempC,moisture}`, material, vegPalette, resource/spawn tables, waterTint, audio.
- **UndergroundLayer** (new) — `repr: voxel|SDF`, region, biome ref. Authored in the 3D editor.
- **Waterway** (modified) — `class`/`order` (was dropped) drives depth/width; per-vertex `widths`.

**HASH DISCIPLINE (load-bearing).** `js/src/world/worldmap-hash.mjs` hand-builds the canonical form
field-by-field. Every new field above needs a matching serializer entry, emitted only-when-present, in
the SAME commit — or it parses fine but ships UNHASHED (silently excluded from `contentHash`, breaking
provenance/content-addressing). Established in Slice 0.1.

---

## Sequencing (landable PRs)

A multi-month program in phases; each slice is its own commit + gate + (where visual) real-GPU proof.

- **Phase 0 · Foundation** — u16 heightfield + range + encoding-version migration + hash discipline; wire
  `erosion.mjs` in. (Slices 0.1 IR, 0.2 painter, 0.3 resolution, 0.4 erosion.)
- **Phase 1 · Water & swim** — water bodies + the `WaterField` query seam (spike early for replay-safety);
  rivers (order/flow/waterfalls); swimmable volume.
- **Phase 2 · Biomes & surface** — biome registry + spatial climate + blends + auto-rules; splat materials;
  flora scatter; the full ~40-biome starter library.
- **Phase 3 · Multi-layer & scale** — SDF/voxel underground (caves/overhangs/arches); floating islands;
  paged streaming. The two big architectural detours — after the surface world is solid.
- **Phase 4 · Content & overlays** — POI/settlement/road/resource stamps + procedural; gameplay overlays.
- **Ongoing** — content-library expansion (more biome defs, flora packs, landform stamps).

Ordering rationale worth stating: erosion (Phase 0) runs BEFORE flood-fill (Phase 1) because it mutates
the heightfield the basin detection reads; biomes (Phase 2) finalize BEFORE the river carve so the carve
reads the final shaped surface.

---

## Verification

- Each slice ships a `pNN`/`p_*` gate (compile determinism / replay-equivalence where state is produced).
- P1: real-GPU Everest-scale render + a physics/nav check that it's genuinely impassable (impassable ≠ tall).
- P3: a carved mountain basin renders a lake at its own level, above sea, on the real GPU; a river visibly flows.
- P3 swim: playtest — enter, float, swim, surface; replay-deterministic (no clock/RNG in buoyancy).
- P4: a climate gradient renders distinct blended biomes; auto-rules place snow/rock correctly.
- Every IR change migrates — existing maps still load + hash byte-identically (only-when-present serializers).

---

## Risks / open questions

**Locked decisions (2026-07-09):**
- Heightfield encoding = **u16** (~0.14m steps at 9km).
- Underground representation = **SDF + sparse-voxel hybrid** (true caves/arches/overhangs; heaviest, most capable).
- Streaming = **paged fixed-size tiles + LOD rings**.
- Biome library v1 = **the full ~40** up front (slower to first playable, complete).
- Atlas ↔ 3D split confirmed (height/mask/polygon → Atlas; true-volume/sub-metre → 3D).
- Swim scope = **functional** (buoyancy + swim-speed + submerged + underwater tint).
- Streaming past ~1.5km and caves/underground are IN scope (upgraded from the initial recommended defer).

**Deferred even so** (later, if ever): dynamic ecological simulation (wildlife AI / food webs beyond
spawn tables); true CFD fluid simulation (vs. flow-painted rivers); full dynamic weather sim.

**Recurring tradeoff:** a fixed-resolution raster over a km-scale map ramps steep walls into slopes —
tall terrain needs higher resolution or locally-scoped feature rects, and (once P2 lands) true 3D volume
for genuine verticality. Interim stopgap: a slope clamp so the u16 range doesn't produce unsupported
near-vertical cliffs before the SDF layer exists.

---

## Status & outcomes

- **2026-07-09 — Plan approved.** All decisions locked. `plan-1afde76922e149e5`.
- **2026-07-09 — Slice 0.1 shipped (`7819bdc`).** u16 heightfield encoding: `ReliefGrid.encoding`
  (`u8`|`u16`, absent = u8 discriminator); hash emits `encoding` only-when-present (u8 maps hash
  identically); `reliefGridSampler` decodes u8 vs u16 (explicit little-endian, host-independent). Gate
  `p_reliefgrid_u16` (Everest-scale peak reachable, u8 back-compat, mis-tag throws, hash discipline).
  Gates green: p_reliefgrid_u16, p_worldmap_compile, check:determinism, check:portability. Painter still
  writes u8 — Slice 0.2 flips it.
