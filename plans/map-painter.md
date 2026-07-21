# Map Painter (Atlas)

**Status: retroactive plan; P1–P5 all CLOSED.** P1–P5 shipped 2026-07-07 across
commits `56b03f0..b8147c1` with no plan doc — this backfills the record from git history
so the phase names, sequencing, and open items are on paper. P5 was formally closed the
same day by `179131a` (stamped assets render in the peek + the acceptance list below,
GPU-verified on a full-feature fixture island). No new work is promised here beyond the
P6 candidates in §"Risks / open questions".

The Map Painter is the paint-first authoring surface inside Map Studio (`tools/design/`,
frontend module `tools/design/frontend/map*.js`, served by `tools/design/serve-design.mjs`).
It replaced the earlier click-to-trace outline/glyph tools with brush-painted raster layers
— landmass, textured terrain/biome, elevation — that a pure compiler
(`js/src/world/design-map-compile.mjs`) vectorizes into the existing WorldMap IR
(`js/src/world/worldmap.ts`, hashed by `js/src/world/worldmap-hash.mjs`). The same IR
drives both terrain build paths, so a painted map becomes a real streamed 3D world through
`village.build` / `terrain.create` exactly like a hand-authored or FMG-imported one. The
capstone, "peek," compiles the active map and renders it with the real engine on the real
GPU (`tools/preview/engine-authored.mjs` via `runLive`) so the author can see the 3D result
of a paint stroke without leaving the browser. The UI shell is called **Atlas** (renamed
from "Map" to disambiguate from the doc-vault's Map of Content and Mind-map).

---

## Chunks

### P1 — landmass brush

A 🏝 Land tool paints a 512² landmass mask (`rasters.landmass`, rle8-encoded via the new
`js/src/world/pipeline/raster-codec.mjs`). The coastline is *derived*, not drawn: marching
squares (`js/src/world/pipeline/marching-squares.mjs`, new, pure — mask → outer coast
loops, Chaikin-smoothed, ≤400 verts, virtual ocean border so edge-painted land closes) over
the mask, served to the frontend so the coast the user sees is the compiled coast. The
compiler emits the derived coast into the existing `WorldMap.land[]` field — no IR schema
or hash change, so both terrain paths inherited painted coasts unchanged from day one.

Frontend: `tools/design/frontend/map-paint.js` (new — mask cache, land/ocean brush with
cos² falloff, land-image layer, border-connected flood fill so enclosed carved pockets
render honestly as land, not a lagoon the build won't have), `map.js` (Land tool + undo
step), `map-commands.js` (`cmdPatchRaster`, later `cmdSetRasterLayer` for deletable painted
layers), `net.js` (visibilitychange flush replacing a >64KiB beacon that silently dropped
on close-tab).

UAT rounds folded into P1 (all same day):
- `1fd7a43` — round 2: stable canvas (coord-readout width was feeding back into svg
  height on every mousemove), sea-by-default, deletable painted layers via one undoable
  `cmdSetRasterLayer`, region auto-grows on an out-of-bounds stroke instead of walling it.
- `cc25773` — removed the paint-region box entirely ("the whole canvas is the editor"):
  region rect survives only as internal cell↔metre bookkeeping (`cmdSetRasterRect`); grow
  now fires mid-stroke, not just at commit.

### P2 — textured terrain palette

A 🖌 Terrain tool paints biomes with textured brushes onto a 256² paletted raster
(`rasters.biomes`, rle8; fixed enum indices from `BIOME_KINDS`, no per-map palette). The
compiler vectorizes per class through the same marching-squares module into the existing IR
biome polygons, so vegetation/climate/relief consumers inherit painted ground unchanged. The
old outline/biome click-to-trace tools left the toolbar; legacy traced features render
read-only and seed the paint layer on first stroke via a "convert to paint" undo command.
Tundra was made to actually paint snow (`PAINT_ALBEDO` id 5 in `terrain/render.ts`,
`terrain.paint` id "snow" in `terrain-edit.ts`) — an engine gap the review caught rather
than shipping a palette chip that compiled to nothing.

Commits in this chunk:
- `20611ca` — P2 landing: paletted biome raster, procedural 32² texture tiles per class
  (speckle/blobs/hatch, no external images), `BIOME_CLASSES` exported from
  `design-map-compile.mjs` with a gate-enforced match to `worldmap.ts` `BIOME_KINDS`.
- `52fa1a1` — Atlas shell UAT: Map tab renamed Atlas, header toolbar replaced by floating
  islands (tools / props / map-switcher / coord chip), Photoshop-style `[`/`]` brush sizing.
  This is UI-shell work bundled into the same UAT pass as P2, not a distinct phase.
- `8b809da` — elevation carves water: painting elevation below sea level now *is* sea
  (one rule shared by display and compile — `effectiveLand` in `map-paint.js` and the
  equivalent carve in `design-map-compile.mjs`), rather than hillshading like a mountain and
  getting clamped back above the waterline. Digging across the coast live-extends the sea.
- `5971d4c` — retired the relief-glyph stamp tool: painted elevation + painted mountain
  biomes now hint relief on their own, so the glyph authored nothing the brushes didn't
  already do better. Same retirement contract as the earlier trace-tool removal (read-only
  legacy features, still compiles).
- `0e75374` — 1:1 viewBox fix (letterboxing on wide screens) + restored z-axis gridline
  ticks that had produced zero output since the north=−z axis flip.

### P3 — catalog stamps + drag-stroke rivers/roads (+ P3a anchors, + build integration)

- `3900457` — **P3a**, landed first as the IR-only half so the hash-affecting schema change
  ships small and gate-locked: `AnchorSchema` in `worldmap.ts` gains optional `assetId` /
  `rot` / `scale`; `worldmap-hash.mjs` emits them only when present (pre-stamp maps still
  hash byte-identically); `design-map-compile.mjs` compiles `map.stamps[]` 1:1 into asset
  anchors (a malformed stamp warns, never silently vanishes); `tools/design/build-world.mjs`
  was fixed to WARN on unknown anchor kinds as unplaced rather than silently skip them —
  the review finding that the pipeline's "fail-loud siting" claim wasn't actually true of
  this consumer.
- `90a8583` — **P3** UI: a 🏠 Stamp tool places real catalog assets (new read-only
  `/api/catalog` + `/assets/qc/*` routes on `serve-design.mjs`, basename-only traversal
  guard); placed stamps render their QC thumbnail at true world footprint; a dangling
  `assetId` draws a loud ⚠ badge. Rivers/roads/borders switched from click-vertex tracing
  to drag-stroke: points collect, decimate, and commit Chaikin-smoothed as one undo step.
- `0e75374` (listed under P2 above, chronologically between P3a and P3 UI) and `620ec0f` —
  the layers panel always names the active map, so landing on an empty child map doesn't
  read as data loss.
- `b076bf6` — road tool icon: inline SVG (currentColor) replacing the 🛤 emoji, which had
  spotty font coverage on the user's system.
- `30809b2` — **P3 build integration**: every Atlas stamp folds into `village.build`
  steering — one `buildingSpec` per distinct stamped `assetId` (role `stamp:<assetId>`,
  style "authored") plus one steering anchor per stamp, bound by `village.build`'s
  first-priority exact-`assetId` match. No engine change needed; `village.ts` steering
  already resolved `assetId` anchors. Explicitly deferred: a stamp's authored rotation
  rides the IR but placement yaw still comes from the layout solver — "anchors pin WHERE,
  the solver decides HOW" is a locked rule the commit declined to revise inline.

### P4 — WorldMap IR importer + layer visibility

- `3ebb37d` — a ⤓ button lists every compiled IR (new `/api/worldmaps` + per-file route)
  and imports one into the active map as one undoable step (`cmdImportLayers`): land
  polygons → the 512² landmass mask, biomes → the 256² class raster, `reliefGrid` →
  bilinear-resampled elevation, waterways/routes → river/road features, asset anchors →
  stamps, `seaLevel` carried over. Verified against a real azgaar-real-mini FMG export:
  round-trip recompiles to land area within 0.1% of the source. The layers panel groups
  line features by kind once a map exceeds 12 rows (an FMG continent brings ~500
  rivers/roads).
- `0f8f982` — layer visibility eyes per row (Landmass / Terrain / Elevation / Stamps),
  pure session view state — doc/saves/compile untouched.
- `0c7424c` — the 👁 emoji eyes were black-on-black in dark mode; replaced with inline SVGs
  stroked in `currentColor` (same defect class as the road-icon fix in P3).
- `d3b54c9` — viewBox regression (hardcoded `0 0 1000 640` on every `renderMap` rebuild,
  clobbering the 1:1 sync from `0e75374`) + import-menu items never receiving clicks
  (the close-on-mousedown handler removed the menu before the item's own click bubbled).

### Compile-to-world groundwork (bridges P4 → P5)

Two commits that aren't a numbered phase but are load-bearing for P5 — they gave the Atlas
a UI path to turn a painted map into a world asset, which peek then reuses:
- `58602c7` — a ⤴ Compile button: flushes pending saves and POSTs `/api/compile-map`,
  which runs the *same* pure compiler the gates run over the vault's `maps.json` +
  world-bible, writing `assets/maps/<project>-<mapId>.worldmap.json` (content-hashed). The
  file immediately appears in the ⤓ import list.
- `d3a9f80` — world size becomes a visible, editable `zone.size_m` field beside ⤴ (it was
  previously buried in World Bible frontmatter with no UI); a compile refusal on a
  too-small declared world offers to grow it to fit (×1.1, rounded to 100m) and retry once
  — assisted, never silent.

### P5 — 3D peek

The 🖼 peek button compiles the active map (same path as ⤴) and renders one real-GPU frame
of the result as an async job: the server writes a scene JSON (`terrain.create source:"map"`
+ `world.addWater`, camera auto-framed on the compiled land bbox) and spawns the existing
proof harness (`tools/preview/engine-authored.mjs` — `runLive` on the editor runtime bundle,
ANGLE GL, waits for the terrain stream to drain). The client polls `/api/peek/<job>` and
shows the PNG in a lightbox, later a 12–18-frame auto-spin turntable.

Seven UAT rounds, each a real defect found by reading real renders or harness logs — this
is the part of the history worth keeping verbatim:

1. **`2eb176f`** — v1 landing. Confirm-gated (failure mode #14: don't GPU-render while the
   user's editor may be live). Explicitly shipped unverified on the actual render path
   ("NOT yet verified: the actual render output").
2. **`7a996de`** — first live peek showed pure sky. Three stacked causes: (a) the prebuilt
   editor runtime bundle still carried the pre-P3a `AnchorSchema`, so `terrain.create`
   zod-rejected any compiled map with stamps (needed `npm run bundle:editor` — failure
   modes #7/#8); (b) the auto-framed camera sat past the default far plane; (c) full-overview
   framing drowned in the ~600m distance-fog knee, fixed by framing at 0.30/0.32 of span.
3. **`ec3b3de`** (UAT round 2) — the peek dropped everything painted except the coastline:
   enclosed sub-sea pits flattened by the rasterizer's land floor, 3m rivers aliased under
   the terrain grid, painted forest produced zero trees, swamp read as dirt. Fixes: a
   `paintedSubSea` exemption in `map-raster.mjs` so decisively-below-water land cells keep
   depth and render as lakes; river width now scales with zone span (`0.008·span`, clamped
   3–16m) instead of a fixed 3m channel invisible on a km map; `vegetation.scatter` gained
   `inclusions` keep-in discs so forest can be confined to painted regions, density ceiling
   raised 64→192; swamp got its own murk paint id (6) instead of aliasing to dirt. Became a
   12-frame auto-spin turntable.
4. **`256fcfb`** (UAT round 3) — sand-shelf bug: unpainted sea cells were sampling the
   elevation raster and riding the −0.5 clamp ceiling, so the whole ocean floor read as
   bright sand. Fixed: un-authored open-sea cells under a `reliefGrid` fall back to the
   classic deepening shore falloff; a decisively sub-sea painted value (a dug bay) still
   keeps its authored depth. Also: lightbox auto-loop → drag-to-scrub + arrow keys + Escape,
   and a loading animation (SMIL camera-dot orbit + phase text) instead of a blank wait.
5. **`a6d0062`** (UAT round 4) — rivers never rendered, lakes read half their drawn size,
   forest looked dead. New `world.addRiver` skill (render-only water ribbon draped along a
   carved channel following terrain — a flat sea plane can't render a river crossing
   elevated ground; registered in `js/src/skills/water.ts` / `js/src/water.ts`, `p11_water`
   gate coverage). Two landmines inside it: triangle winding faced down (backface culling
   erased the river while `visible:true`, fixed to +Y winding + `DoubleSide`), and the
   surface needed to sit 2.2m above the carved floor or oblique-orbit banks occlude it. Also:
   waterway carve changed from an absolute floor (which cut slot canyons through painted
   mountains) to relative (~3m gully into local surface); any painted-below-plane land cell
   now renders submerged; instanced alpha-cutout foliage got `alphaTest 0.08` on a cloned
   material (mip-averaged alpha was falling below the cutoff at distance, eroding forests to
   bare trunks — never mutates the shared asset material). `elevationMin` for scatter dropped
   1.0→0.5, which alone had been silently excluding ~85% of painted forest (155 of 917
   trees).
6. **`d5b7759`** (UAT round 5) — the turntable scrub jumped at the seam: frames were
   captured on a wall clock against frame-rate-dependent autoSpin, so a heavy scene covered
   only ~270° in 12×2.2s. Fixed with driven, not timed, yaw: `runLive` exposes
   `setOrbitAzimuth(rad)`, `engine-authored.html` hooks it as `window.__setYaw`,
   `engine-shots.mjs` gained an exact-yaw mode (each shot at precisely `(i-1)/N × 360°`) —
   also ~5x faster per frame (0.4s vs 2.2s).
7. **`9329aeb`** (UAT round 6) — redrawn forests vanished again, same failure shape new
   trigger: the peek's tree floor was a hardcoded absolute `elevationMin` (0.5), but sea
   level is an Atlas-authored control (this map's is −11.5), so flat land at y≈0 sat below
   the hardcoded floor and got culled. Floor made relative to `worldMap.seaLevel` (+0.5) —
   matching how the water plane and river ribbons already derive their level. Also: brush
   cursor ring changed from a washed-out `var(--accent)` hairline to a white dashed ring
   with drop-shadow, visible on any map background.
8. **`b8147c1`** (UAT round 7) — swamp read as a flat murk tint, not a marsh. Two layers
   added: seeded standing-water pools in `map-raster.mjs` (~20m features, ~25% coverage,
   floor `seaLevel-0.7`, only within 2.5m of the waterline — an elevated painted swamp keeps
   dank tint, not impossible hillside ponds; salt 7919, deterministic) filled by the water
   plane; and a second sparse birch/spruce scatter confined to swamp polygons via the shared
   `biomeDiscs` cover. Explicit caveat in the commit body: on the Eastern Watch map itself,
   authored sea (−11.5) sits far below the swamps, so the pools are *dormant by design* on
   that map — they only activate when swamp ground is near the waterline.
9. **`179131a`** (round 8 — the close-out) — two structural gaps found reading rounds 1–7
   together: stamped catalog assets NEVER appeared in a peek (the whole point of the P3
   stamp tool), and the scene assembly lived inline in `serve-design.mjs`'s HTTP handler
   where no gate could see it. Fixed by extracting `tools/design/peek-scene.mjs` —
   `buildPeekScene(worldMap, {project, mapFile})`, a PURE function (no I/O/clock/random) —
   and adding asset-anchor placement (`asset.place`, grounded, stamp `rot` as yaw, uniform
   `scale` as Vec3, always after `terrain.create`). A new falsifiable "peek scene" family
   in `mapstudio-gate.mjs` pins the contract (10 checks: map-source terrain, confined
   biome scatters, sea, river ribbon, stamp placement w/ rot+scale, ordering, stable
   sceneName, determinism, and the two absence cases). GPU UAT ran on a purpose-built
   fixture island (sea 0, swamp basin at ~+0.8) exercising every painted class at once —
   the first time swamp pools were observed ACTIVE on a real render.

---

## Sequencing (landable PRs)

Retrospective — the actual commit order, oldest first, all on `feat/gamestack-refactor`,
all same day (2026-07-07):

1. `56b03f0` — P1 landmass brush
2. `1fd7a43` — P1 UAT round 2
3. `cc25773` — P1: remove the paint-region box
4. `20611ca` — P2 textured terrain palette
5. `52fa1a1` — Atlas full-bleed shell + brush sizing
6. `8b809da` — elevation carves water + Atlas layout fixes
7. `5971d4c` — retire the glyph tool
8. `3900457` — P3a stamp anchors (IR-only)
9. `0e75374` — 1:1 viewBox + z-axis ticks
10. `90a8583` — P3 catalog stamps + drag-stroke rivers/roads
11. `620ec0f` — layers panel always names the active map
12. `b076bf6` — road tool icon fix
13. `30809b2` — P3 build integration
14. `0f8f982` — P4 layer visibility eyes
15. `0c7424c` — visibility eyes: dark-mode SVG fix
16. `3ebb37d` — P4 WorldMap IR importer
17. `d3b54c9` — viewBox + import-menu click fix
18. `58602c7` — ⤴ Compile button
19. `d3a9f80` — world size field + grow-to-fit
20. `2eb176f` — P5 3D peek v1
21. `7a996de` — P5: stale bundle / far-plane / fog fixes
22. `ec3b3de` — P5 UAT round 2 (turntable + lakes/rivers/forest/swamp render)
23. `256fcfb` — P5 UAT round 3 (ocean depth + scrub + loader)
24. `a6d0062` — P5 UAT round 4 (world.addRiver + relief carve + living forest)
25. `d5b7759` — P5 UAT round 5 (exact-yaw turntable)
26. `9329aeb` — P5 UAT round 6 (sea-level-relative floor + cursor contrast)
27. `b8147c1` — P5 UAT round 7 (swamp wetland pools)
28. `179131a` — P5 close-out (stamps render in the peek; pure gate-proven scene module)

Every commit is single-day, single-branch, no reverts and no squashes visible in this
range — the "UAT round N" naming in commit subjects is the project's own sequencing label,
not one imposed here.

---

## Verification

- **Static/logic gates, every phase**: `gates/design/mapstudio-gate.mjs` — this is the one
  gate touched in nearly every commit; each phase added a falsifiable family to it (rle8
  round-trip + reject, contour-extraction time budget, disc-area/centroid tolerance,
  precedence-vs-decoy-outline, BIOME_CLASSES==BIOME_KINDS sync, stamp command inversions,
  sub-sea trench / relative-carve families, sea-family far-from-coast vs. painted-trench,
  swamp-family mottled-cell-count-with-falsifiability). `check:determinism` and
  `check:portability` are cited clean on nearly every commit; several also cite
  `p_map_terrain`, `p_map_source`, `p11_water`, `p11_asset_scatter`, `p64_vegetation_scatter`,
  `p78_scatter_exclusion_determinism`, `p_worldmap_compile`, `check-nested-invoke`, and one
  full `run-gates.sh --quick` sweep (`ec3b3de`: "8/8 js/test + all design gates").
- **P1–P4 (2D authoring)**: browser-verified with Playwright-driven real clicks against a
  throwaway or copied live vault — paint → save → real compiler output → undo/redo
  round-trip — plus a named check count per suite (P1 paint: 15 checks; P2 terrain: 11;
  Atlas shell: 10; P3 stamps: 10). Several UI-only fixes (icons, viewBox, dark-mode SVGs)
  cite a screenshot "read with eyes" rather than a gate.
- **P5 (3D peek)**: real-GPU renders via `tools/preview/engine-shots.mjs` /
  `engine-authored.mjs` (ANGLE GL, per this repo's cardinal rule against SwiftShader for
  pixel judgment), read by eye each round, plus headless-Chromium-driven UI flow checks for
  the lightbox/loader/scrub. `2eb176f` is the one commit in this whole range that explicitly
  shipped with the render path unverified ("the user's editor session may be live"); every
  subsequent P5 commit reports a real render read.
- No commit in this range reports a FAILED or SKIPPED gate as accepted; two commits
  (`ec3b3de`, `a6d0062`) note pre-existing, unrelated host-gate failures (event-retention,
  8787 auth-token conflict) they did not touch or "fix" to pass.

---

## P5 acceptance list (authored at close-out — what "the peek is correct" MEANS)

A peek of a compiled map is correct when, on real-GPU renders read with eyes:

1. Terrain renders from the painted map source (never sky-only), camera auto-framed on the
   compiled land at any span.
2. Painted elevation reads: hills rise, carved basins hold water (lakes at painted extent),
   open-sea depth falls off beyond the shelf instead of riding a sand clamp.
3. Painted biomes read as ground: forest = dense confined canopy, swamp = murk tint +
   sparse stands, mountain = bare relief; scatter never escapes its painted polygons.
4. Waterline features track the AUTHORED sea level (never a hardcoded constant): sea plane,
   carved river channels with ribbon surfaces tucked into banks, and — when swamp ground
   sits within ~2.5 m of the waterline — ACTIVE mottled standing-water pools.
5. Every stamped asset-anchor is placed, grounded, at its map position (rot as yaw, uniform
   scale honored) — the painted village appears in the peek.
6. The exact-yaw turntable closes a true 360° (first→last frame seamless at N frames).
7. `mapstudio-gate.mjs` (including the "peek scene" family) passes, falsifiability cases
   intact.

Known NOT rendered (explicitly out of P5's scope, top of the P6 list): painted
roads/routes — no terrain-following path capability exists in the engine yet.

Evidence for close-out (2026-07-07, `179131a`): an 18-frame turntable of a fixture island
(authored `seaLevel 0`; landmass + elevation rasters with an NE hill, SE swamp basin at
~+0.8, W lake carved to −3.5; forest/swamp/mountain paint; river + road; two stamps) read
at 4 spread angles — every list item observed, including the first ACTIVE swamp-pool
sighting (mottled water between sparse marsh stands) and both stamped buildings grounded
at the village site. Headless: 220 wet / 804 dry raster cells across the swamp basin.

## Risks / open questions

- **Candidate P6+ items** (recorded, not committed to):
  - **Painted roads render in the peek/world** — the one painted layer with no 3D
    realization. Needs a real capability (a terrain-following path ribbon akin to
    `world.addRiver`, or rasterizer-level road paint along `worldMap.routes`), not a
    one-off hack. Top candidate.
  - Stamp rotation honored at `village.build` placement (`30809b2` deliberately deferred:
    "anchors pin WHERE, the solver decides HOW" — revising that rule is a decision, not a
    patch). The peek DOES honor stamp rot as of `179131a`; the build path still doesn't.
  - Water tools for enclosed sub-sea pockets: `8b809da` and `56b03f0` both note enclosed
    carved pits stay land ("polygon holes are dropped until the water tools").
  - A live stamp → 3D-world build dogfood pass (`30809b2` shipped it gate-verified but
    live-unverified; still unconfirmed on a live editor session).
  - Steep bare slopes show a banded strata read at orbit distance (observed on the UAT
    island's mountain flank) — material/albedo behavior of the render baseline, not a
    painter defect; revisit with the Track-P look push.
- **Not determined from history**: `90a8583`/`3900457` cite `plan-8df2466225bf4213` as the
  parent plan ID, but no such `plans/*.md` file exists — likely a hosted plan-store record.
  This document is now the canonical painter record.

---

## Status & outcomes

- **P1 (landmass brush) — shipped.** `56b03f0`, `1fd7a43`, `cc25773`.
- **P2 (textured terrain palette) — shipped.** `20611ca`, `52fa1a1`, `8b809da`, `5971d4c`,
  `0e75374`.
- **P3 (catalog stamps + rivers/roads, + P3a anchors, + build integration) — shipped.**
  `3900457`, `90a8583`, `620ec0f`, `b076bf6`, `30809b2`.
- **P4 (WorldMap IR importer + layer visibility) — shipped.** `0f8f982`, `0c7424c`,
  `3ebb37d`, `d3b54c9`.
- **Compile-to-world groundwork — shipped.** `58602c7`, `d3a9f80`.
- **P5 (3D peek) — CLOSED.** `2eb176f` → `b8147c1` (7 UAT rounds) → `179131a` (close-out:
  stamps render in the peek, scene assembly extracted to the pure gate-proven
  `peek-scene.mjs`, the acceptance list above authored, and every acceptance item GPU-
  verified on a purpose-built full-feature fixture island — the first ACTIVE swamp-pool
  sighting included). The one painted layer with no 3D realization (roads) is recorded as
  the top P6 candidate, not a P5 gap.
