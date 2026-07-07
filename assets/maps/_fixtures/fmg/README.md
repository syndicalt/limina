# FMG Full-JSON fixture (`sample-full.json`)

**Provenance: hand-built**, not a real Azgaar export. It is a deterministic, structurally
faithful miniature written to match the shapes of **FMG v1.134.2's** "Full JSON" export
(`src/services/io/export-json.ts` `getFullDataJson()` in
github.com/Azgaar/Fantasy-Map-Generator, verified from source on 2026-07-06 — the repo bundles
no sample Full JSON export, and full map generation only runs in a browser). Generator script:
a one-shot node script (square-grid cells laid out explicitly, no randomness); the committed
JSON is the artifact of record.

Verified-shape fidelity:

- Top level: `{info, settings, mapCoordinates, pack, grid, biomesData, notes, nameBases}`.
- `pack.cells` / `pack.vertices` are **arrays of per-cell/per-vertex objects** (the v1.134
  exporter's layout; the limina compiler also accepts the older/internal structure-of-arrays).
- `features[0]` and `burgs[0]` are the literal number `0` (FMG's placeholder convention).
- `cells[].h` is 0–100 with 20 = sea level; `cells[].v` are vertex ids into `pack.vertices`,
  `cells[].c` neighbor cell ids, `cells[].p` px centers.
- `rivers[].width` is mouth width in **km**; `rivers[1]` (Eastbrook) deliberately has **no
  `points`** — the common freshly-generated case (compiler falls back to cell centers);
  `rivers[0]` (Silverrun) has authored `points` (the hand-edited case).
- `routes[].points` are `[x, y, cellId]` triplets; groups `roads` / `trails` / `searoutes`.
- `burgs[].capital` is the number `1`/`0`; `population` is in FMG "population points".
- `biomesData.name` is FMG's default 13-name table plus one custom name ("Faerie meadow")
  to exercise the compiler's unmapped-biome warning path.

Known deviations from a real export (all inert to the compiler):

- Cells are a **square grid** (10×10 cells of 40px, 11×11 shared vertices), not a Voronoi
  mesh — so vertices touch up to 4 cells where FMG's touch exactly 3, and `grid`/`states`/
  `cultures`/`religions` are minimal stubs. The compiler reads none of that.
- `settings.distanceScale` is `0.0005` (km/px → 0.5 m/px), far below FMG's default of 3 —
  **miniature on purpose**, so the compiled island (~120 m across) fits a walkable 200 m
  terrain tile and the p_fmg_compile gate can drive the real `terrain.create
  {generate:{source:"map"}}` path directly against it. Any positive `distanceScale` is legal
  in FMG (the UI slider goes down to 0.01, and the value is user-editable).

Content: one island (32 land cells), a 2×2 mountain block (h 68–74) with a hills fringe,
grassland/forest/wetland biomes, 2 rivers, road + trail + (skipped) searoute, and 2 burgs —
capital **Highkeep** (pop 5.42) and village **Fisherton** (pop 0.87) — behind the `burgs[0]`
placeholder.

Compiled by `node tools/map/compile-fmg.mjs assets/maps/_fixtures/fmg/sample-full.json --out
assets/maps/fmg-sample.worldmap.json --map-id fmg-sample`; gated by `js/test/p_fmg_compile.ts`.
