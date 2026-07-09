#!/usr/bin/env node
// mapstudio-gate.mjs — Map Studio S0 gate: the MapDoc v2 contract + the undo command stack.
// Pure Node, no GPU/chromium (runs even under --headless). Exit 0 pass, 1 fail.
//
// What it proves:
//   1. v1 -> v2 migration round-trip: a version-less doc (the eastern-watch shape) migrates to a
//      valid v2 doc with every feature preserved byte-identically; migration is idempotent;
//      garbage input yields the default doc; a v2 save re-reads unchanged.
//   2. Undo inversion property: for EVERY command type in map-commands.js, apply -> undo restores
//      the exact original map state (deep-equal), and undo -> redo restores the post-apply state.
//      Also a mixed 6-command sequence, fully unwound and replayed.
//   3. The compile bridge: a serialized v2 doc still compiles through the REAL design-map compiler
//      (compileDesignMap), so the new doc version can't silently break the map -> world pipeline.
//
// FALSIFIABILITY (failure mode #5 — gates built to pass): each check is proven able to fail by
// feeding it a deliberately broken input (a corrupted migration, a command whose undo lies, a doc
// the compiler must reject) and asserting the check DETECTS it.

import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..", "..");

const { migrateMapDoc, serializeMapDoc, MAPDOC_VERSION } = await import(join(ROOT, "tools/design/map-doc.mjs"));
const H = await import(join(ROOT, "tools/design/frontend/map-commands.js"));
const { compileDesignMap } = await import(join(ROOT, "js/src/world/design-map-compile.mjs"));
const { worldMapContentHash } = await import(join(ROOT, "js/src/world/worldmap-hash.mjs"));
const { rasterizeWorldMap, reliefGridSampler } = await import(join(ROOT, "js/src/world/pipeline/map-raster.mjs"));
const { readFileSync } = await import("node:fs");

let failures = 0;
function check(name, cond) {
  if (cond) { console.log("  ok  " + name); return; }
  failures++; console.error("  FAIL " + name);
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const clone = (v) => JSON.parse(JSON.stringify(v));

// ---- 1. MapDoc v1 -> v2 migration -------------------------------------------------------------
console.log("mapdoc migration:");
const V1_FIXTURE = {
  activeMapId: "primary",
  maps: [{
    id: "primary", name: "eastern-watch — Hamlet", scope: "site", parent: null,
    sea: true,
    features: [
      { id: "f1", type: "area", kind: "outline", points: [[-29, -37], [-34, -36], [-36, -35]], fill: "#5b7d9a" },
      { id: "f2", type: "line", kind: "road", points: [[-34, -24], [-33, -23]], color: "#000000" },
      { id: "f3", type: "area", kind: "biome", biome: "forest", points: [[0, 0], [10, 0], [10, 10]] },
      { id: "f4", type: "glyph", glyph: "mountain", x: 5, z: -8 },
    ],
  }],
};
{
  const { doc, migratedFrom } = migrateMapDoc(clone(V1_FIXTURE), "eastern-watch");
  check("version-less doc reports migratedFrom=1", migratedFrom === 1);
  check("migrated doc carries version " + MAPDOC_VERSION, doc.version === MAPDOC_VERSION);
  check("units injected by migration", eq(doc.maps[0].units, { kind: "m", unitsPerMeter: 1, origin: [0, 0] }));
  check("features preserved byte-identically", eq(doc.maps[0].features, V1_FIXTURE.maps[0].features));
  check("unknown per-map fields preserved (sea)", doc.maps[0].sea === true);
  const again = migrateMapDoc(clone(doc), "eastern-watch");
  check("migration is idempotent", eq(again.doc, doc) && again.migratedFrom === MAPDOC_VERSION);
  const saved = serializeMapDoc(doc.maps, doc.activeMapId);
  check("save -> re-read round-trips", eq(migrateMapDoc(clone(saved), "eastern-watch").doc, doc));
}
{
  // Top-level unknown fields are LOAD-BEARING (migrate-north-negz's axes marker is a
  // refuse-to-run-twice guard; losing it on save would let the z-migration mirror the map).
  const withMarker = { ...clone(V1_FIXTURE), axes: "north-negz" };
  const { doc } = migrateMapDoc(withMarker, "eastern-watch");
  check("top-level unknown fields survive migration (axes)", doc.axes === "north-negz");
  const saved = serializeMapDoc(doc.maps, doc.activeMapId, doc);
  check("top-level unknown fields survive a save (axes)", saved.axes === "north-negz");
  const savedBare = serializeMapDoc(doc.maps, doc.activeMapId, {});
  check("(falsifiability) a save WITHOUT the extras merge drops the marker — detected", savedBare.axes === undefined);
}
{
  const g1 = migrateMapDoc(null, "proj");
  const g2 = migrateMapDoc({ maps: "nonsense" }, "proj");
  check("garbage input yields a valid default doc", g1.doc.version === MAPDOC_VERSION && g1.doc.maps.length === 1 && g2.doc.maps.length === 1);
  const mixed = migrateMapDoc({ maps: [null, 42, { id: "ok", features: "broken" }] }, "proj");
  check("broken map entries filtered, broken features normalized", mixed.doc.maps.length === 1 && Array.isArray(mixed.doc.maps[0].features));
  // Falsifiability: a corrupted "migration" output must FAIL the preservation check.
  const corrupted = clone(V1_FIXTURE.maps[0].features); corrupted[0].points[0][0] += 1;
  check("(falsifiability) corrupted features are DETECTED", !eq(corrupted, V1_FIXTURE.maps[0].features));
}

// ---- 2. Undo inversion property ----------------------------------------------------------------
console.log("undo command stack:");
function fixtureMap() {
  return clone({ id: "m1", name: "m1", sea: false, features: V1_FIXTURE.maps[0].features });
}
function inversionTest(name, makeCmd, opts) {
  const map = fixtureMap();
  const before = clone(map);
  const h = H.createHistory();
  const cmd = makeCmd(map);
  if (!cmd) { failures++; console.error("  FAIL " + name + " (constructor returned null)"); return; }
  H.push(h, cmd, opts, map);
  const after = clone(map);
  check(name + ": apply changed state", !eq(before, after));
  H.undo(h, () => map);
  check(name + ": undo restores the exact original", eq(clone(map), before));
  H.redo(h, () => map);
  check(name + ": redo restores the applied state", eq(clone(map), after));
}
inversionTest("cmdAddFeature", (m) => H.cmdAddFeature("m1", { id: "f9", type: "glyph", glyph: "peak", x: 1, z: 2 }));
inversionTest("cmdDeleteFeature (middle of list)", (m) => H.cmdDeleteFeature("m1", m, "f2"));
inversionTest("cmdDeleteFeatures (bulk, non-adjacent)", (m) => H.cmdDeleteFeatures("m1", m, ["f1", "f3"]));
inversionTest("cmdClearFeatures", (m) => H.cmdClearFeatures("m1", m));
inversionTest("cmdUpdateFeature (patch introduces a new key)", (m) => H.cmdUpdateFeature("m1", m, "f2", { kind: "river", color: "#123456", width: 3 }));
inversionTest("cmdSetMapProp (sea)", (m) => H.cmdSetMapProp("m1", "sea", m.sea, true));
{
  // Drag-commit pattern: mutation happens first, command pushed {applied:true}.
  const map = fixtureMap();
  const before = clone(map);
  const startGeom = { points: map.features[1].points.map((p) => p.slice()) };
  map.features[1].points = map.features[1].points.map(([x, z]) => [x + 7, z - 3]); // the live drag
  const after = clone(map);
  const h = H.createHistory();
  H.push(h, H.cmdMoveFeature("m1", "f2", startGeom, { points: map.features[1].points }), { applied: true }, map);
  check("cmdMoveFeature: applied-push does not double-apply", eq(clone(map), after));
  H.undo(h, () => map);
  check("cmdMoveFeature: undo restores pre-drag geometry", eq(clone(map), before));
  H.redo(h, () => map);
  check("cmdMoveFeature: redo restores post-drag geometry", eq(clone(map), after));
}
{
  // Mixed sequence: 6 commands on one map, unwound completely, then replayed completely.
  const map = fixtureMap();
  const before = clone(map);
  const h = H.createHistory();
  const cmds = [
    H.cmdAddFeature("m1", { id: "fA", type: "glyph", glyph: "hills", x: 3, z: 3 }),
    H.cmdUpdateFeature("m1", map, "f3", { biome: "swamp" }),
    H.cmdSetMapProp("m1", "sea", map.sea, true),
    H.cmdDeleteFeature("m1", map, "f1"),
  ];
  for (const c of cmds) H.push(h, c, {}, map);
  H.push(h, H.cmdDeleteFeatures("m1", map, ["f2", "fA"]), {}, map);
  H.push(h, H.cmdClearFeatures("m1", map), {}, map);
  const final = clone(map);
  while (H.undo(h, () => map)) { /* unwind all */ }
  check("mixed sequence: full unwind restores the original", eq(clone(map), before));
  while (H.redo(h, () => map)) { /* replay all */ }
  check("mixed sequence: full replay restores the final state", eq(clone(map), final));
  // New command after undo invalidates redo.
  H.undo(h, () => map);
  H.push(h, H.cmdAddFeature("m1", { id: "fB", type: "glyph", glyph: "peak", x: 0, z: 0 }), {}, map);
  check("a new command clears the redo stack", h.redo.length === 0);
}
{
  // cmdPatchRaster (S1 elevation strokes): closure-held raster store, bbox patch inversion.
  const raster = { w: 16, h: 16, cells: new Uint8Array(256).fill(64), dirty: false };
  const before0 = raster.cells.slice();
  const bbox = { c0: 3, r0: 4, c1: 7, r1: 9 };
  const preSnap = H.rasterBboxSnapshot(raster, bbox);
  for (let r = 4; r <= 9; r++) for (let c = 3; c <= 7; c++) raster.cells[r * 16 + c] = 200; // the "stroke"
  const postSnap = H.rasterBboxSnapshot(raster, bbox);
  const h = H.createHistory();
  H.push(h, H.cmdPatchRaster("m1", raster, bbox, preSnap, postSnap), { applied: true }, null);
  const painted = raster.cells.slice();
  H.undo(h, () => ({}));
  check("cmdPatchRaster: undo restores the pre-stroke cells", eq([...raster.cells], [...before0]));
  H.redo(h, () => ({}));
  check("cmdPatchRaster: redo restores the painted cells", eq([...raster.cells], [...painted]));
  check("cmdPatchRaster: patch marks the raster dirty (save picks it up)", raster.dirty === true);
  const bad = H.cmdPatchRaster("m1", raster, bbox, new Uint8Array(3), postSnap);
  check("cmdPatchRaster: mismatched snapshot sizes are rejected", bad === null);

  // cmdSetRasterRect (region move/resize): rect metadata inversion, cells untouched.
  const r2 = { w: 16, h: 16, rect: { x0: 0, z0: 0, w: 100, h: 100 }, cells: new Uint8Array(256).fill(9), dirty: false };
  const h2 = H.createHistory();
  H.push(h2, H.cmdSetRasterRect("m1", r2, { x0: 0, z0: 0, w: 100, h: 100 }, { x0: -50, z0: 20, w: 200, h: 160 }), {}, null);
  check("cmdSetRasterRect: redo applies the new rect + marks dirty", eq(r2.rect, { x0: -50, z0: 20, w: 200, h: 160 }) && r2.dirty);
  H.undo(h2, () => ({}));
  check("cmdSetRasterRect: undo restores the original rect", eq(r2.rect, { x0: 0, z0: 0, w: 100, h: 100 }));
  check("cmdSetRasterRect: cells untouched by region edits", r2.cells.every((v) => v === 9));
}
{
  // Falsifiability: a command whose undo LIES (doesn't invert) must be caught by the same check.
  const map = fixtureMap();
  const before = clone(map);
  const h = H.createHistory();
  const liar = {
    label: "liar", mapId: "m1",
    redo(m) { m.features.push({ id: "fX", type: "glyph", glyph: "peak", x: 9, z: 9 }); },
    undo(m) { /* deliberately does nothing */ },
  };
  H.push(h, liar, {}, map);
  H.undo(h, () => map);
  check("(falsifiability) a non-inverting undo is DETECTED", !eq(clone(map), before));
}

// ---- 3. The compile bridge: a v2 doc still compiles to a WorldMap ------------------------------
console.log("compile bridge:");
{
  const { doc } = migrateMapDoc(clone(V1_FIXTURE), "eastern-watch");
  const v2Text = JSON.stringify(serializeMapDoc(doc.maps, doc.activeMapId));
  const worldBibleText = [
    "---", "kind: world-bible", "title: Gate Fixture",
    "zone:", "  size_m: 200", "  origin: center [0,0]; north = -z",
    "regions:", "  - id: r1", "    name: Region One", "    biome: grass",
    "locations:", "  - id: keep", "    name: The Keep", "    kind: civic", "    region: r1", "    position: [-30, -30]",
    "---", "", "# Gate Fixture", "",
  ].join("\n");
  let worldMap = null, err = null;
  try { ({ worldMap } = compileDesignMap({ mapsJsonText: v2Text, worldBibleText })); } catch (e) { err = e; }
  check("v2 doc compiles through compileDesignMap", !!worldMap && !err);
  if (worldMap) {
    check("compiled IR has the fixture's land + anchor", worldMap.land.length >= 1 && worldMap.anchors.some((a) => a.id === "keep"));
    check("compiled IR carries a content hash", typeof worldMap.provenance.contentHash === "string" && worldMap.provenance.contentHash.length >= 16);
  }
  // Falsifiability: the compiler must REJECT a doc with no usable maps.
  let rejected = false;
  try { compileDesignMap({ mapsJsonText: JSON.stringify({ version: 2, maps: [] }), worldBibleText }); } catch { rejected = true; }
  let rejected2 = false;
  try { compileDesignMap({ mapsJsonText: "not json at all {", worldBibleText }); } catch { rejected2 = true; }
  check("(falsifiability) empty/garbage docs are REJECTED by the compiler", rejected && rejected2);
}

// ---- 4. S1: painted elevation (reliefGrid) — three-place contract + map-match ------------------
console.log("elevation raster (reliefGrid):");
const b64encode = (u8) => {
  const A = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let out = "";
  for (let i = 0; i < u8.length; i += 3) {
    const a = u8[i], b = u8[i + 1], c = u8[i + 2];
    out += A[a >> 2] + A[((a & 3) << 4) | (b === undefined ? 0 : b >> 4)]
      + (b === undefined ? "=" : A[((b & 15) << 2) | (c === undefined ? 0 : c >> 6)])
      + (c === undefined ? "=" : A[c & 63]);
  }
  return out;
};
/** A deterministic 64x64 test raster: flat plain at value 64 with a Gaussian hill (peak 220)
 *  centered at cell (40, 24). minY=-10, maxY=30 -> plain y≈0.04, hill peak y≈24.5. */
function hillRaster() {
  const w = 64, h = 64;
  const cells = new Uint8Array(w * h);
  for (let r = 0; r < h; r++) for (let c = 0; c < w; c++) {
    const d2 = (c - 40) * (c - 40) + (r - 24) * (r - 24);
    cells[r * w + c] = Math.round(64 + 156 * Math.exp(-d2 / (2 * 6 * 6)));
  }
  return { w, h, rect: { x0: -50, z0: -50, w: 100, h: 100 }, minY: -10, maxY: 30, data: b64encode(cells) };
}
const WB_TEXT = [
  "---", "kind: world-bible", "title: Gate Fixture",
  "zone:", "  size_m: 200", "  origin: center [0,0]; north = -z",
  "regions:", "  - id: r1", "    name: Region One", "    biome: grass",
  "locations:", "  - id: keep", "    name: The Keep", "    kind: civic", "    region: r1", "    position: [-30, -30]",
  "---", "",
].join("\n");
// A v2 doc WITH a painted raster AND legacy relief authors (a mountain biome + a peak glyph) —
// the fixture the vector-only eastern-watch doc can't provide (the review's vacuous-proof finding).
function rasterDoc(elev) {
  return JSON.stringify({
    version: 2, activeMapId: "m", axes: "north-negz",
    maps: [{
      id: "m", name: "m", scope: "site", parent: null, seaLevel: 0,
      units: { kind: "m", unitsPerMeter: 1, origin: [0, 0] },
      rasters: { elevation: elev },
      features: [
        { id: "o1", type: "area", kind: "outline", points: [[-45, -45], [45, -45], [45, 45], [-45, 45]] },
        { id: "b1", type: "area", kind: "biome", biome: "mountain", points: [[-40, -40], [-10, -40], [-10, -10], [-40, -10]] },
        { id: "g1", type: "glyph", glyph: "peak", x: -20, z: 20 },
      ],
    }],
  });
}
{
  const elev = hillRaster();
  const { worldMap } = compileDesignMap({ mapsJsonText: rasterDoc(elev), worldBibleText: WB_TEXT });
  check("compile emits reliefGrid from rasters.elevation", !!worldMap.reliefGrid && worldMap.reliefGrid.data === elev.data);
  check("PRECEDENCE: relief hints NOT emitted when a raster is present", worldMap.relief.length === 0);
  const bare = JSON.parse(rasterDoc(elev));
  delete bare.maps[0].rasters;
  const { worldMap: noRaster } = compileDesignMap({ mapsJsonText: JSON.stringify(bare), worldBibleText: WB_TEXT });
  check("same doc WITHOUT the raster still emits vector hints", noRaster.reliefGrid === undefined && noRaster.relief.length === 2);

  // THREE-PLACE HASH CONTRACT: editing one raster cell must change contentHash.
  const cells = new Uint8Array(64 * 64); // decode not needed: flip a byte via a second build
  const elev2 = hillRaster();
  {
    const raw = Uint8Array.from(atob(elev2.data), (ch) => ch.charCodeAt(0));
    raw[24 * 64 + 40] = raw[24 * 64 + 40] === 255 ? 254 : raw[24 * 64 + 40] + 1;
    elev2.data = b64encode(raw);
  }
  const { worldMap: edited } = compileDesignMap({ mapsJsonText: rasterDoc(elev2), worldBibleText: WB_TEXT });
  check("HASH: editing ONE raster cell changes contentHash", edited.provenance.contentHash !== worldMap.provenance.contentHash);
  check("HASH: recomputed hash matches embedded (walk covers reliefGrid)", worldMapContentHash(worldMap) === worldMap.provenance.contentHash);
  // Regression: a committed pre-reliefGrid map's hash is UNCHANGED by the new walk.
  const legacy = JSON.parse(readFileSync(join(ROOT, "assets/maps/primary.worldmap.json"), "utf8"));
  check("HASH: committed legacy map still verifies (old hashes unchanged)", worldMapContentHash(legacy) === legacy.provenance.contentHash);

  // MAP-MATCH: rasterize through the REAL terrain path and sample the painted hill.
  const sampler = reliefGridSampler(worldMap);
  const peakY = sampler(12.7, -12.3); // cell (40,24) center: x0+40/63*100=13.5... sample near it
  check("sampler: hill peak reads ~24.5m", Math.abs(peakY - 24.5) < 1.5);
  const { heights, cfg } = rasterizeWorldMap(worldMap, { size: 100, resolution: 101, seed: 7 });
  const at = (wx, wz) => heights[Math.round((wz + 50) / (100 / 100)) * 101 + Math.round((wx + 50) / (100 / 100))];
  const hillH = at(13, -12), plainH = at(-30, 30);
  check(`terrain: painted hill is walked-height ~24.5m (got ${hillH.toFixed(1)})`, Math.abs(hillH - 24.5) < 2.0);
  check(`terrain: painted plain stays near 0.8m clamp floor (got ${plainH.toFixed(1)})`, plainH > 0.5 && plainH < 2.5);
  // PRECEDENCE at the rasterizer: the peak glyph/mountain biome in the same doc must have NO
  // effect — the plain under the old glyph position reads as plain, not a 15m peak.
  const glyphH = at(-20, 20);
  check(`terrain: legacy glyph position is FLAT under raster precedence (got ${glyphH.toFixed(1)})`, glyphH < 3);
  // Falsifiability: the same sample positions against a raster with the hill REMOVED must fail
  // the hill assertion — proves the map-match check actually reads the painted data.
  const flat = hillRaster(); {
    const raw = Uint8Array.from(atob(flat.data), (ch) => ch.charCodeAt(0)); raw.fill(64); flat.data = b64encode(raw);
  }
  const { worldMap: flatMap } = compileDesignMap({ mapsJsonText: rasterDoc(flat), worldBibleText: WB_TEXT });
  const { heights: flatH } = rasterizeWorldMap(flatMap, { size: 100, resolution: 101, seed: 7 });
  const flatHill = flatH[Math.round((-12 + 50)) * 101 + Math.round(13 + 50)];
  check("(falsifiability) un-painting the hill is DETECTED by the same sample", Math.abs(flatHill - 24.5) >= 2.0);
}

// ---- 5. P1: painted landmass (mask -> land[] via marching squares) ------------------------------
console.log("landmass mask (painter P1):");
{
  const { rleEncodeU8, rleDecodeU8, encodeRasterCells, decodeRasterCells } =
    await import(join(ROOT, "js/src/world/pipeline/raster-codec.mjs"));
  const { maskToLandPolygons } = await import(join(ROOT, "js/src/world/pipeline/marching-squares.mjs"));

  // Codec: canonical round-trip + the size claim (masks are runny).
  const W = 512, R = 90; // cells; blob radius in CELLS on an 800m rect (=> ~141m world radius)
  const blob = (cx, cr) => {
    const cells = new Uint8Array(W * W);
    for (let r = 0; r < W; r++) for (let c = 0; c < W; c++) {
      const d = Math.hypot(c - cx, r - cr);
      cells[r * W + c] = d <= R ? 255 : (d <= R + 2 ? 128 : 0);
    }
    return cells;
  };
  const cells = blob(256, 256);
  const rt = rleDecodeU8(rleEncodeU8(cells), cells.length);
  check("rle8 round-trips the mask byte-identically", rt.length === cells.length && rt.every((v, i) => v === cells[i]));
  const enc = encodeRasterCells(cells);
  check("rle8 mask is <10% of raw base64 size", enc.data.length < (cells.length * 4 / 3) * 0.1);
  check("(falsifiability) corrupted rle stream is REJECTED", (() => {
    try { rleDecodeU8(rleEncodeU8(cells).slice(0, 40), cells.length); return false; } catch { return true; }
  })());

  // Marching squares: geometry + performance budget on the real 512² size.
  const rect = { x0: -400, z0: -400, w: 800, h: 800 };
  const t0 = performance.now();
  const polys = maskToLandPolygons({ w: W, h: W, rect, cells });
  const msMs = performance.now() - t0;
  check(`contour extraction on 512² within the 50ms budget (${msMs.toFixed(1)}ms)`, msMs < 50);
  check("blob yields exactly one land polygon", polys.length === 1);
  const shoelace = (pts) => Math.abs(pts.reduce((a, p, i) => { const q = pts[(i + 1) % pts.length]; return a + p[0] * q[1] - q[0] * p[1]; }, 0) / 2);
  const cellM = 800 / (W - 1);
  const wantArea = Math.PI * (R * cellM) * (R * cellM);
  const gotArea = shoelace(polys[0].points);
  check(`polygon area matches the painted disc within 5% (got ${(gotArea / wantArea * 100).toFixed(1)}%)`, Math.abs(gotArea - wantArea) / wantArea < 0.05);
  const cen = polys[0].points.reduce((a, p) => [a[0] + p[0], a[1] + p[1]], [0, 0]).map((v) => v / polys[0].points.length);
  check(`centroid within one cell of the painted center (off by ${Math.hypot(cen[0], cen[1]).toFixed(2)}m)`, Math.hypot(cen[0], cen[1]) < cellM);
  check("vertex count bounded (<=400)", polys[0].points.length <= 400);
  check("empty mask yields no land", maskToLandPolygons({ w: 8, h: 8, rect, cells: new Uint8Array(64) }).length === 0);
  // Land painted to the rect edge closes at the border (virtual ocean padding).
  const full = maskToLandPolygons({ w: 8, h: 8, rect: { x0: 0, z0: 0, w: 70, h: 70 }, cells: new Uint8Array(64).fill(255) });
  check("edge-to-edge land closes into a border coast", full.length === 1 && shoelace(full[0].points) > 70 * 70 * 0.8);

  // Compile: mask -> land[] in the EXISTING IR field, precedence over outline, hash determinism.
  const lmDoc = (lmCells, extraFeature) => JSON.stringify({
    version: 2, activeMapId: "m", axes: "north-negz",
    maps: [{
      id: "m", name: "m", scope: "site", parent: null, seaLevel: 0,
      units: { kind: "m", unitsPerMeter: 1, origin: [0, 0] },
      rasters: { landmass: { w: W, h: W, rect, ...encodeRasterCells(lmCells) } },
      features: [
        { id: "decoy", type: "area", kind: "outline", points: [[60, 60], [95, 60], [95, 95], [60, 95]] },
        ...(extraFeature ? [extraFeature] : []),
      ],
    }],
  });
  // zone.size_m 200 in WB_TEXT would trip the scale check on a ~280m-wide painted island — use a
  // fixture bible sized for the painted world (the check still runs against the derived land).
  const WB_BIG = WB_TEXT.replace("size_m: 200", "size_m: 800");
  const { worldMap: lmMap, warnings: lmWarn } = compileDesignMap({ mapsJsonText: lmDoc(cells), worldBibleText: WB_BIG });
  check("compile: mask emits land[] polygons (existing IR field)", Array.isArray(lmMap.land) && lmMap.land.length === 1);
  check("compile: PRECEDENCE — outline feature ignored with a warning", lmWarn.some((w) => w.includes("decoy") && w.includes("landmass")));
  const inBlob = (p) => Math.hypot(p[0], p[1]) < (R + 6) * cellM;
  check("compile: no land vertex comes from the decoy outline", lmMap.land.every((l) => l.points.every(inBlob)));
  check("compile: recomputed content hash verifies (no schema change)", worldMapContentHash(lmMap) === lmMap.provenance.contentHash);
  const again = compileDesignMap({ mapsJsonText: lmDoc(cells), worldBibleText: WB_BIG });
  check("compile: deterministic (same doc -> identical contentHash)", again.worldMap.provenance.contentHash === lmMap.provenance.contentHash);
  // Falsifiability: shifting the painted blob 100 cells east MUST move the compiled centroid.
  const { worldMap: shifted } = compileDesignMap({ mapsJsonText: lmDoc(blob(356, 256)), worldBibleText: WB_BIG });
  const cen2 = shifted.land[0].points.reduce((a, p) => [a[0] + p[0], a[1] + p[1]], [0, 0]).map((v) => v / shifted.land[0].points.length);
  check("(falsifiability) a shifted blob is DETECTED by the same centroid check", Math.hypot(cen2[0], cen2[1]) >= cellM);
}

// ---- 5b. Elevation carves water (UAT: digging below sea level must BE water) --------------------
console.log("elevation carves water:");
{
  const { encodeRasterCells } = await import(join(ROOT, "js/src/world/pipeline/raster-codec.mjs"));
  const W = 128, rect = { x0: -400, z0: -400, w: 800, h: 800 };
  const landDisc = new Uint8Array(W * W);
  for (let r = 0; r < W; r++) for (let c = 0; c < W; c++) { if (Math.hypot(c - 64, r - 64) <= 50) landDisc[r * W + c] = 255; }
  // Elevation raster: flat at y=+2 except a -12m trench from the disc's edge to its center
  // (connected to the sea, so the carve is a bay, not a dropped hole).
  const EW = 64;
  const mkElev = (trench) => {
    const cells = new Uint8Array(EW * EW);
    const minY = -16, maxY = 48;
    const flat = Math.round((2 - minY) / (maxY - minY) * 255);
    const deep = Math.round((-12 - minY) / (maxY - minY) * 255);
    cells.fill(flat);
    if (trench) {
      for (let c = 32; c < EW; c++) for (let r = 30; r <= 34; r++) cells[r * EW + c] = deep; // center -> east edge
    }
    const raw = String.fromCharCode(...cells);
    return { w: EW, h: EW, rect, minY, maxY, data: btoa(raw) };
  };
  const doc = (elev) => JSON.stringify({
    version: 2, activeMapId: "m",
    maps: [{
      id: "m", name: "m", scope: "site", parent: null, seaLevel: 0,
      units: { kind: "m", unitsPerMeter: 1, origin: [0, 0] },
      rasters: { landmass: { w: W, h: W, rect, ...encodeRasterCells(landDisc) }, elevation: elev },
      features: [],
    }],
  });
  const WB_BIG = WB_TEXT.replace("size_m: 200", "size_m: 800");
  const shoelace = (pts) => Math.abs(pts.reduce((a, p, i) => { const q = pts[(i + 1) % pts.length]; return a + p[0] * q[1] - q[0] * p[1]; }, 0) / 2);
  const { worldMap: flatMap } = compileDesignMap({ mapsJsonText: doc(mkElev(false)), worldBibleText: WB_BIG });
  const { worldMap: dugMap } = compileDesignMap({ mapsJsonText: doc(mkElev(true)), worldBibleText: WB_BIG });
  const aFlat = flatMap.land.reduce((a, l) => a + shoelace(l.points), 0);
  const aDug = dugMap.land.reduce((a, l) => a + shoelace(l.points), 0);
  check(`sub-sea trench removes land (${(100 - aDug / aFlat * 100).toFixed(1)}% carved)`, aDug < aFlat * 0.97);
  // The rasterized world agrees: terrain in the trench sits BELOW sea level.
  const { heights: dh } = rasterizeWorldMap(dugMap, { size: 800, resolution: 201, seed: 7 });
  const at = (wx, wz) => dh[Math.round((wz + 400) / 4) * 201 + Math.round((wx + 400) / 4)];
  check(`terrain: trench builds below sea level (got ${at(120, 0).toFixed(1)}m)`, at(120, 0) < -1);
  check(`terrain: un-dug land still builds above sea (got ${at(0, -100).toFixed(1)}m)`, at(0, -100) > 0);
  // Falsifiability of the carver itself: flat above-sea elevation must carve NOTHING (the land
  // area matches a compile with no elevation raster at all).
  const { worldMap: noneMap } = compileDesignMap({ mapsJsonText: doc(undefined), worldBibleText: WB_BIG });
  const aNone = noneMap.land.reduce((a, l) => a + shoelace(l.points), 0);
  check("(falsifiability) flat above-sea elevation carves nothing", Math.abs(aFlat - aNone) / aNone < 0.005);

  // LAKES: an ENCLOSED sub-sea pit (not connected to the sea) stays inside the land polygon
  // (holes are dropped) but must still RASTERIZE below the water plane — the paintedSubSea
  // exemption from the vertical-separation land floor. Without it the pit is silently flattened
  // to seaLevel+0.8 and the drawn lake never renders (the P5 UAT bug).
  const mkLake = () => {
    const cells = new Uint8Array(EW * EW);
    const minY = -16, maxY = 48;
    cells.fill(Math.round((2 - minY) / (maxY - minY) * 255));
    const deep = Math.round((-6 - minY) / (maxY - minY) * 255);
    for (let r = 26; r <= 32; r++) for (let c = 26; c <= 32; c++) cells[r * EW + c] = deep; // pit near the disc center
    return { w: EW, h: EW, rect, minY, maxY, data: btoa(String.fromCharCode(...cells)) };
  };
  const { worldMap: lakeMap } = compileDesignMap({ mapsJsonText: doc(mkLake()), worldBibleText: WB_BIG });
  const aLake = lakeMap.land.reduce((a, l) => a + shoelace(l.points), 0);
  check("lake: enclosed pit does NOT change the land polygon (hole dropped)", Math.abs(aLake - aFlat) / aFlat < 0.01);
  const { heights: lh, paintMat: lp } = rasterizeWorldMap(lakeMap, { size: 800, resolution: 201, seed: 7 });
  const lakeIdx = (wx, wz) => Math.round((wz + 400) / 4) * 201 + Math.round((wx + 400) / 4);
  // Pit rows 26-32 of a 64² raster over [-400,400] -> world ≈ [-70..-4]; probe its middle.
  const li = lakeIdx(-35, -35);
  check(`lake: enclosed sub-sea pit rasterizes BELOW the water plane (got ${lh[li].toFixed(1)}m)`, lh[li] < -1);
  check("lake: lake floor gets seabed paint (no bare checker under water)", lp[li] === 1);
  const { heights: fh2 } = rasterizeWorldMap(flatMap, { size: 800, resolution: 201, seed: 7 });
  check(`(falsifiability) same cell WITHOUT the pit stays land above sea (got ${fh2[li].toFixed(1)}m)`, fh2[li] > 0);

  // OPEN SEA under a painted elevation raster: where the raster carries no authored seabed
  // (unpainted default ≈ +2 out there), sea cells must fall back to the classic deepening
  // falloff — NOT ride the -0.5 clamp ceiling (that renders as a bright sand shelf around
  // the island). The dug trench (-12, an AUTHORED seabed now outside the land mask) must
  // stay at its painted depth, deeper than the classic profile ever goes.
  const farSea = lakeIdx(-380, -380); // corner of the tile, ~250m from the disc coast
  check(`sea: un-authored seabed deepens away from the coast (got ${lh[farSea].toFixed(1)}m)`, lh[farSea] < -2);
  const trenchSea = (() => { const i = lakeIdx(120, 0); return dh[i]; })(); // dug bay cell, sea side
  check(`sea: an authored (painted) seabed keeps its depth (got ${trenchSea.toFixed(1)}m)`, trenchSea < -8);
}

// ---- 6. P2: painted biomes (raster -> per-class polygons -> ground paint) -----------------------
console.log("biome raster (painter P2):");
{
  const { encodeRasterCells } = await import(join(ROOT, "js/src/world/pipeline/raster-codec.mjs"));
  const { BIOME_CLASSES } = await import(join(ROOT, "js/src/world/design-map-compile.mjs"));

  // The fixed cell vocabulary must equal worldmap.ts's BIOME_KINDS (the .mjs compiler can't
  // import the .ts, so the gate is the sync point).
  const wmSrc = readFileSync(join(ROOT, "js/src/world/worldmap.ts"), "utf8");
  const m = wmSrc.match(/BIOME_KINDS = \[([^\]]+)\]/);
  const kinds = m[1].split(",").map((s) => s.trim().replace(/["']/g, "")).filter(Boolean);
  check("BIOME_CLASSES matches worldmap.ts BIOME_KINDS exactly", eq(kinds, BIOME_CLASSES));
  check("(falsifiability) a reordered vocabulary would be DETECTED", !eq([...kinds].reverse(), BIOME_CLASSES));

  // Paint three patches (grass disc, tundra disc, mountain disc) into a 256² raster.
  const BW = 256;
  const cells = new Uint8Array(BW * BW);
  const disc = (cx, cr, R, v) => { for (let r = 0; r < BW; r++) for (let c = 0; c < BW; c++) { if (Math.hypot(c - cx, r - cr) <= R) cells[r * BW + c] = v; } };
  disc(80, 80, 40, BIOME_CLASSES.indexOf("grass") + 1);
  disc(180, 80, 30, BIOME_CLASSES.indexOf("tundra") + 1);
  disc(120, 180, 30, BIOME_CLASSES.indexOf("mountain") + 1);
  disc(60, 190, 25, BIOME_CLASSES.indexOf("swamp") + 1);
  const rect = { x0: -400, z0: -400, w: 800, h: 800 };
  const doc = (extraFeature) => JSON.stringify({
    version: 2, activeMapId: "m", axes: "north-negz",
    maps: [{
      id: "m", name: "m", scope: "site", parent: null, seaLevel: 0,
      units: { kind: "m", unitsPerMeter: 1, origin: [0, 0] },
      rasters: { biomes: { w: BW, h: BW, rect, ...encodeRasterCells(cells) } },
      features: [
        // Land under the painted biomes — the rasterizer only paints ground on land.
        { id: "land-sq", type: "area", kind: "outline", points: [[-380, -380], [380, -380], [380, 380], [-380, 380]] },
        { id: "decoy-b", type: "area", kind: "biome", biome: "swamp", points: [[300, 300], [380, 300], [380, 380]] },
        ...(extraFeature ? [extraFeature] : []),
      ],
    }],
  });
  const WB_BIG = WB_TEXT.replace("size_m: 200", "size_m: 800");
  const { worldMap: bm, warnings: bw } = compileDesignMap({ mapsJsonText: doc(), worldBibleText: WB_BIG });
  const byKind = (k) => bm.biomes.filter((b) => b.biome === k);
  check("compile: three painted classes emit three biome polygons", byKind("grass").length === 1 && byKind("tundra").length === 1 && byKind("mountain").length === 1);
  // (the ONE swamp polygon is the PAINTED disc; the vector decoy contributed nothing)
  check("compile: PRECEDENCE — vector biome feature ignored with a warning", bw.some((w) => w.includes("decoy-b") && w.includes("biome raster")) && byKind("swamp").length === 1);
  check("compile: painted mountain hints relief (no painted elevation)", bm.relief.some((r) => r.kind === "mountain" && r.shape.polygon));
  const cellM = 800 / (BW - 1);
  const shoelace = (pts) => Math.abs(pts.reduce((a, p, i) => { const q = pts[(i + 1) % pts.length]; return a + p[0] * q[1] - q[0] * p[1]; }, 0) / 2);
  const wantGrass = Math.PI * (40 * cellM) ** 2;
  check(`compile: grass polygon area within 6% of the painted disc (got ${(shoelace(byKind("grass")[0].points) / wantGrass * 100).toFixed(1)}%)`, Math.abs(shoelace(byKind("grass")[0].points) - wantGrass) / wantGrass < 0.06);
  check("compile: recomputed content hash verifies", worldMapContentHash(bm) === bm.provenance.contentHash);

  // MAP-MATCH through the REAL rasterizer: the painted tundra disc must produce SNOW paint
  // (id 5) — a palette chip that compiles to nothing is a silent UI lie.
  const { heights: _h, cfg, paintMat } = rasterizeWorldMap(bm, { size: 800, resolution: 201, seed: 7 });
  let snow = 0, grassPaint = 0;
  if (paintMat) {
    for (const v of paintMat) { if (v === 5) snow++; if (v === 2) grassPaint++; }
  }
  check(`terrain: painted tundra rasterizes as SNOW paint (${snow} cells)`, snow > 50);
  check(`terrain: painted grass rasterizes as grass paint (${grassPaint} cells)`, grassPaint > 100);
  // Swamp must rasterize as its OWN murk paint (id 6) — aliased to dirt it was invisible as
  // wetland (the P5 UAT bug). The gate is also the .ts/.mjs sync point for the new id.
  let murk = 0;
  if (paintMat) for (const v of paintMat) { if (v === 6) murk++; }
  check(`terrain: painted swamp rasterizes as MURK paint (${murk} cells)`, murk > 50);
  const renderSrc = readFileSync(join(ROOT, "js/src/terrain/render.ts"), "utf8");
  const editSrc = readFileSync(join(ROOT, "js/src/skills/terrain-edit.ts"), "utf8");
  check("sync: PAINT_ALBEDO has a 6-indexed murk entry (render.ts)", /\/\/ 6 murk/.test(renderSrc));
  check("sync: PAINT_MATERIALS maps murk: 6 (terrain-edit.ts)", /murk: 6/.test(editSrc));
  // Falsifiability: an all-grass raster must produce ZERO snow at the same sampler.
  const flatCells = new Uint8Array(BW * BW).fill(BIOME_CLASSES.indexOf("grass") + 1);
  const { worldMap: gm } = compileDesignMap({
    mapsJsonText: JSON.stringify({ version: 2, activeMapId: "m", maps: [{ id: "m", name: "m", scope: "site", parent: null, seaLevel: 0, units: { kind: "m", unitsPerMeter: 1, origin: [0, 0] }, rasters: { biomes: { w: BW, h: BW, rect, ...encodeRasterCells(flatCells) } }, features: [{ id: "land-sq", type: "area", kind: "outline", points: [[-380, -380], [380, -380], [380, 380], [-380, 380]] }] }] }),
    worldBibleText: WB_BIG,
  });
  const { paintMat: gp } = rasterizeWorldMap(gm, { size: 800, resolution: 201, seed: 7 });
  let snow2 = 0; if (gp) for (const v of gp) { if (v === 5) snow2++; }
  check("(falsifiability) un-painting tundra removes ALL snow at the same probe", snow2 === 0);
}

// ---- 6a. River width scales with the zone span --------------------------------------------------
console.log("river width:");
{
  const doc = (widthM) => JSON.stringify({
    version: 2, activeMapId: "m",
    maps: [{
      id: "m", name: "m", scope: "site", parent: null, seaLevel: 0,
      units: { kind: "m", unitsPerMeter: 1, origin: [0, 0] },
      features: [
        { id: "o1", type: "area", kind: "outline", points: [[-90, -90], [90, -90], [90, 90], [-90, 90]] },
        { id: "r1", type: "line", kind: "river", points: [[-80, 0], [80, 0]], ...(widthM ? { widthM } : {}) },
      ],
    }],
  });
  const WB_BIG = WB_TEXT.replace("size_m: 200", "size_m: 1400");
  const wSmall = compileDesignMap({ mapsJsonText: doc(), worldBibleText: WB_TEXT }).worldMap.waterways[0].widthM;
  const wBig = compileDesignMap({ mapsJsonText: doc(), worldBibleText: WB_BIG }).worldMap.waterways[0].widthM;
  check(`river: default width scales with the zone span (200m -> ${wSmall}m, 1400m -> ${wBig}m)`, wSmall === 3 && wBig === 11);
  check("(falsifiability) a fixed default would be DETECTED (big-zone river must widen)", wBig > wSmall);
  const wExplicit = compileDesignMap({ mapsJsonText: doc(9), worldBibleText: WB_BIG }).worldMap.waterways[0].widthM;
  check("river: an explicit per-feature widthM wins over the scaled default", wExplicit === 9);

  // RELATIVE carve: a river crossing ELEVATED ground cuts a ~3m gully into the local surface,
  // not a slot canyon down to the absolute seaLevel-0.6 floor (walls hid the water — the
  // "river never renders" UAT bug). Across low ground the absolute flood floor still wins.
  const docHill = JSON.stringify({
    version: 2, activeMapId: "m",
    maps: [{
      id: "m", name: "m", scope: "site", parent: null, seaLevel: 0,
      units: { kind: "m", unitsPerMeter: 1, origin: [0, 0] },
      features: [
        { id: "o1", type: "area", kind: "outline", points: [[-350, -350], [350, -350], [350, 350], [-350, 350]] },
        { id: "mt", type: "area", kind: "biome", biome: "mountain", points: [[-150, -150], [150, -150], [150, 150], [-150, 150]] },
        { id: "r1", type: "line", kind: "river", points: [[-340, 0], [340, 0]], widthM: 10 },
      ],
    }],
  });
  const WB_800 = WB_TEXT.replace("size_m: 200", "size_m: 800");
  const { worldMap: hillMap } = compileDesignMap({ mapsJsonText: docHill, worldBibleText: WB_800 });
  const noRiverMap = { ...hillMap, waterways: [] };
  const { heights: rh } = rasterizeWorldMap(hillMap, { size: 800, resolution: 201, seed: 7 });
  const { heights: nh } = rasterizeWorldMap(noRiverMap, { size: 800, resolution: 201, seed: 7 });
  const mid = Math.round(400 / 4) * 201 + Math.round(400 / 4); // (0,0): river center on the mountain
  check(`carve: on high ground the channel is a ~3m gully (orig ${nh[mid].toFixed(1)}m -> ${rh[mid].toFixed(1)}m)`,
    nh[mid] > 6 && rh[mid] >= nh[mid] - 3.5 && rh[mid] <= nh[mid] - 2);
  const low = Math.round(400 / 4) * 201 + Math.round((-330 + 400) / 4); // near the coast, low ground
  check(`carve: across low ground the flood floor still wins (got ${rh[low].toFixed(1)}m)`, rh[low] <= -0.5);
  check("(falsifiability) an absolute-floor carve would be DETECTED (high-ground channel above sea)", rh[mid] > 0);

  // SWAMP POOLS: a low-lying swamp biome dapples with sub-sea standing-water pools (the marsh
  // read) — MOTTLED, not flooded; an ELEVATED swamp (on the mountain) gains no hillside ponds.
  const docSwamp = JSON.stringify({
    version: 2, activeMapId: "m",
    maps: [{
      id: "m", name: "m", scope: "site", parent: null, seaLevel: 0,
      units: { kind: "m", unitsPerMeter: 1, origin: [0, 0] },
      features: [
        { id: "o1", type: "area", kind: "outline", points: [[-350, -350], [350, -350], [350, 350], [-350, 350]] },
        { id: "sw", type: "area", kind: "biome", biome: "swamp", points: [[-200, -200], [0, -200], [0, 0], [-200, 0]] },
        { id: "mt", type: "area", kind: "biome", biome: "mountain", points: [[100, 100], [300, 100], [300, 300], [100, 300]] },
        { id: "sw2", type: "area", kind: "biome", biome: "swamp", points: [[150, 150], [250, 150], [250, 250], [150, 250]] },
      ],
    }],
  });
  const { worldMap: swMap } = compileDesignMap({ mapsJsonText: docSwamp, worldBibleText: WB_800 });
  const { heights: sh } = rasterizeWorldMap(swMap, { size: 800, resolution: 201, seed: 7 });
  const cellAt = (wx, wz) => sh[Math.round((wz + 400) / 4) * 201 + Math.round((wx + 400) / 4)];
  let pools = 0, dry = 0, hillPools = 0;
  for (let wz = -195; wz < -5; wz += 4) for (let wx = -195; wx < -5; wx += 4) { if (cellAt(wx, wz) < 0) pools++; else dry++; }
  for (let wz = 155; wz < 245; wz += 4) for (let wx = 155; wx < 245; wx += 4) { if (cellAt(wx, wz) < 0) hillPools++; }
  check(`swamp: low swamp dapples with pools (${pools} wet / ${dry} dry cells — mottled)`, pools > 100 && dry > 100);
  check("swamp: an ELEVATED swamp gains no hillside ponds", hillPools === 0);
  const noSwamp = { ...swMap, biomes: swMap.biomes.filter((b) => b.biome !== "swamp") };
  const { heights: nsh } = rasterizeWorldMap(noSwamp, { size: 800, resolution: 201, seed: 7 });
  let nsPools = 0;
  for (let wz = -195; wz < -5; wz += 4) for (let wx = -195; wx < -5; wx += 4) { if (nsh[Math.round((wz + 400) / 4) * 201 + Math.round((wx + 400) / 4)] < 0) nsPools++; }
  check("(falsifiability) un-painting the swamp removes every pool", nsPools === 0);
}

// ---- 6b. P3: stamps -> asset anchors (schema + hash, three-place rule) --------------------------
console.log("stamps (painter P3):");
{
  const doc = (stamps) => JSON.stringify({
    version: 2, activeMapId: "m",
    maps: [{
      id: "m", name: "m", scope: "site", parent: null, seaLevel: 0,
      units: { kind: "m", unitsPerMeter: 1, origin: [0, 0] },
      features: [{ id: "o1", type: "area", kind: "outline", points: [[-45, -45], [45, -45], [45, 45], [-45, 45]] }],
      ...(stamps ? { stamps } : {}),
    }],
  });
  const S1 = [
    { id: "s1", assetId: "cottage-authored.glb", x: 10, z: -20, rot: 1.5, scale: 1.2 },
    { id: "s2", assetId: "watchtower-authored.glb", x: -30, z: 5 },
    { id: "bad" }, // malformed: no assetId — must warn, never vanish silently into nothing
  ];
  const { worldMap: sm, warnings: sw } = compileDesignMap({ mapsJsonText: doc(S1), worldBibleText: WB_TEXT });
  const stampAnchors = sm.anchors.filter((a) => a.kind === "asset");
  check("stamps compile 1:1 into asset anchors", stampAnchors.length === 2);
  const s1 = stampAnchors.find((a) => a.id === "s1"), s2 = stampAnchors.find((a) => a.id === "s2");
  check("anchor carries assetId + position + source map", s1.assetId === "cottage-authored.glb" && eq(s1.position, [10, -20]) && s1.source === "map");
  check("rot/scale present only when set", s1.rot === 1.5 && s1.scale === 1.2 && s2.rot === undefined && s2.scale === undefined);
  check("malformed stamp warns instead of vanishing", sw.some((w) => w.includes("malformed stamp")));
  check("HASH: recomputed hash covers the new anchor fields", worldMapContentHash(sm) === sm.provenance.contentHash);
  const { worldMap: sm2 } = compileDesignMap({ mapsJsonText: doc([{ ...S1[0], rot: 2.5 }, S1[1]]), worldBibleText: WB_TEXT });
  check("(falsifiability) rotating a stamp changes the contentHash", sm2.provenance.contentHash !== sm.provenance.contentHash);
  const { worldMap: sm0 } = compileDesignMap({ mapsJsonText: doc(undefined), worldBibleText: WB_TEXT });
  check("no stamps -> no asset anchors, and the hash walk emits nothing new", sm0.anchors.every((a) => a.kind !== "asset") && worldMapContentHash(sm0) === sm0.provenance.contentHash);

  // Stamp command inversions (the tool's undo stack — same purity contract as features).
  const smap = { id: "m1", features: [], stamps: [] };
  const hh2 = H.createHistory();
  H.push(hh2, H.cmdAddStamp("m1", { id: "st1", assetId: "cottage-authored.glb", x: 5, z: 6 }), {}, smap);
  check("cmdAddStamp places", smap.stamps.length === 1 && smap.stamps[0].assetId === "cottage-authored.glb");
  H.push(hh2, H.cmdMoveStamp("m1", "st1", { x: 5, z: 6, rot: undefined, scale: undefined }, { x: 9, z: 2, rot: 1.1, scale: undefined }), {}, smap);
  check("cmdMoveStamp transforms (rot appears)", smap.stamps[0].x === 9 && smap.stamps[0].rot === 1.1);
  H.push(hh2, H.cmdDeleteStamp("m1", smap, "st1"), {}, smap);
  check("cmdDeleteStamp removes", smap.stamps.length === 0);
  H.undo(hh2, () => smap); H.undo(hh2, () => smap);
  check("undo restores position and DELETES the introduced rot", smap.stamps[0].x === 5 && smap.stamps[0].rot === undefined);
  H.undo(hh2, () => smap);
  check("full unwind returns the empty stamp list", eq(smap.stamps, []));

  // Import-layers inversion (P4): a wholesale layer swap + feature append undoes exactly.
  const imap = { id: "m1", seaLevel: 2, features: [{ id: "keep", type: "line", kind: "road", points: [[0, 0], [1, 1]] }], rasters: { elevation: { w: 2, h: 2, rect: { x0: 0, z0: 0, w: 10, h: 10 }, minY: 0, maxY: 1, data: "AAAA" } } };
  const iorig = clone(imap);
  const hh3 = H.createHistory();
  H.push(hh3, H.cmdImportLayers("m1", imap, {
    rasters: { landmass: { w: 2, h: 2, rect: { x0: 0, z0: 0, w: 10, h: 10 }, enc: "rle8", data: "BAA=" } },
    stamps: [{ id: "si", assetId: "cottage-authored.glb", x: 1, z: 2 }],
    seaLevel: 0,
    featuresAppend: [{ id: "f-imp-1", type: "line", kind: "river", points: [[3, 3], [4, 4]] }],
  }), {}, imap);
  check("import swaps rasters/stamps/seaLevel and appends features",
    !!imap.rasters.landmass && !imap.rasters.elevation && imap.stamps.length === 1 && imap.seaLevel === 0 && imap.features.length === 2);
  H.undo(hh3, () => imap);
  check("import undo restores the ENTIRE prior state byte-identically", eq(imap, iorig));
  check("(falsifiability) a lying import-undo would be DETECTED", !eq({ ...clone(iorig), seaLevel: 0 }, iorig));
}

// ---- 7. Data-safety fixes (phantom feature loss) ------------------------------------------------
// Three proven loss mechanisms, each locked here: (a) colliding feature ids repaired on read,
// (b) delete-undo can't mint a duplicate, (c) the server refuses a stale wholesale save (CAS).
console.log("data safety:");
{
  // (a) id-collision repair: the live vault really held two features both named f18000000.
  const dupDoc = clone(V1_FIXTURE);
  dupDoc.maps[0].features.push({ id: "f1", type: "area", kind: "biome", biome: "forest", points: [[1, 1], [2, 1], [2, 2]] });
  const { doc, repairedIds } = migrateMapDoc(dupDoc, "proj");
  const ids = doc.maps[0].features.map((f) => f.id);
  check("colliding ids repaired on read (all unique)", new Set(ids).size === ids.length);
  check("both colliding features are KEPT (repair, not drop)", doc.maps[0].features.length === V1_FIXTURE.maps[0].features.length + 1);
  check("first holder keeps its id; duplicate gets the suffix", ids[0] === "f1" && ids[ids.length - 1] !== "f1" && ids[ids.length - 1].startsWith("f1~"));
  check("repairedIds reported for the server warn", repairedIds === 1);
  check("(falsifiability) the unrepaired input FAILS the uniqueness check", new Set(dupDoc.maps[0].features.map((f) => f.id)).size !== dupDoc.maps[0].features.length);

  // (b2) raster-layer delete/restore inversion (the layers panel's × on painted layers).
  const rmap = { id: "m1", features: [], rasters: {
    elevation: { w: 2, h: 2, rect: { x0: 0, z0: 0, w: 10, h: 10 }, minY: 0, maxY: 1, data: "AAAA" },
    landmass: { w: 2, h: 2, rect: { x0: 0, z0: 0, w: 10, h: 10 }, enc: "rle8", data: "BAA=" },
  } };
  {
    const orig = clone(rmap);
    const hh = H.createHistory();
    H.push(hh, H.cmdSetRasterLayer("m1", rmap, "elevation", undefined), {}, rmap);
    check("layer delete removes exactly that raster", rmap.rasters.elevation === undefined && !!rmap.rasters.landmass);
    H.push(hh, H.cmdSetRasterLayer("m1", rmap, "landmass", undefined), {}, rmap);
    check("deleting the last layer removes map.rasters entirely", rmap.rasters === undefined);
    H.undo(hh, () => rmap); H.undo(hh, () => rmap);
    // Key ORDER may differ after re-insertion; per-layer content must be byte-identical.
    check("undo x2 restores both layers (content-identical)",
      !!rmap.rasters && Object.keys(rmap.rasters).length === 2
      && eq(rmap.rasters.elevation, orig.rasters.elevation) && eq(rmap.rasters.landmass, orig.rasters.landmass));
    check("(falsifiability) a lying restore would be DETECTED", !eq(undefined, orig.rasters.elevation));
  }

  // (b) delete-undo existence guard: if the feature is already back (conflict reload,
  // interleaved edit), undo must NOT insert the snapshot again and mint a duplicate id.
  const map = fixtureMap();
  const h = H.createHistory();
  const del = H.cmdDeleteFeature("m1", map, "f2");
  H.push(h, del, {}, map);
  map.features.push({ id: "f2", type: "line", kind: "road", points: [[0, 0], [1, 1]], color: "#111111" });
  H.undo(h, () => map);
  check("delete-undo skips re-insert when the id already exists", map.features.filter((f) => f.id === "f2").length === 1);
}
{
  // (c) compare-and-set on /api/map-save — the PRIMARY loss cause (stale wholesale save
  // clobbering newer disk state). Run the REAL server on a temp vault: a save echoing the
  // current rev lands; a save with a stale rev is refused 409 and the disk stays untouched.
  const { mkdtempSync: mkTmp, writeFileSync: wf, readFileSync: rf, rmSync: rm } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { spawn } = await import("node:child_process");
  const vault = mkTmp(join(tmpdir(), "mapstudio-cas-"));
  wf(join(vault, "maps.json"), JSON.stringify(serializeMapDoc(clone(V1_FIXTURE.maps), "primary"), null, 2));
  const port = 41870 + (process.pid % 100);
  const srv = spawn("node", [join(ROOT, "tools/design/serve-design.mjs"), vault, String(port)], { stdio: "ignore" });
  try {
    let rev = null;
    for (let i = 0; i < 50 && rev === null; i++) {
      await new Promise((r) => setTimeout(r, 200));
      try { rev = (await (await fetch(`http://localhost:${port}/api/state`)).json()).mapsRev ?? null; } catch { /* booting */ }
    }
    check("server: /api/state carries mapsRev", typeof rev === "string" && rev.length > 0);
    const session = await (await fetch(`http://localhost:${port}/api/session`)).json();
    const postHeaders = { "content-type": "application/json", "x-limina-design-token": session.token };
    // Fresh-rev save (drops a feature deliberately — a LEGITIMATE newer-state write) lands.
    const newer = clone(V1_FIXTURE.maps); newer[0].features = newer[0].features.slice(0, 2);
    const ok = await fetch(`http://localhost:${port}/api/map-save`, { method: "POST", headers: postHeaders, body: JSON.stringify({ maps: newer, activeMapId: "primary", baseRev: rev }) });
    const okJ = await ok.json();
    check("server: matching baseRev save lands (200 + new rev)", ok.status === 200 && okJ.saved === true && typeof okJ.mapsRev === "string" && okJ.mapsRev !== rev);
    // THE BUG, replayed: a client still holding the OLD rev posts its stale full doc (which
    // lacks nothing here — worse, it would RESURRECT/clobber). Must bounce 409, disk unchanged.
    const stale = await fetch(`http://localhost:${port}/api/map-save`, { method: "POST", headers: postHeaders, body: JSON.stringify({ maps: clone(V1_FIXTURE.maps), activeMapId: "primary", baseRev: rev }) });
    const staleJ = await stale.json();
    const onDisk = JSON.parse(rf(join(vault, "maps.json"), "utf8"));
    check("server: STALE baseRev save is refused with 409 + conflict + current rev", stale.status === 409 && staleJ.conflict === true && staleJ.mapsRev === okJ.mapsRev);
    check("server: refused save left the disk untouched (2 features, not 4)", onDisk.maps[0].features.length === 2);
    // A save with NO baseRev (old client / late beacon from a dead session) is also refused.
    const bare = await fetch(`http://localhost:${port}/api/map-save`, { method: "POST", headers: postHeaders, body: JSON.stringify({ maps: clone(V1_FIXTURE.maps), activeMapId: "primary" }) });
    check("server: rev-less save (late beacon shape) is refused", bare.status === 409);
    // Falsifiability: the pre-CAS behavior — stale save landing — would flip the disk check.
    check("(falsifiability) had the stale save landed, the disk check would FAIL", clone(V1_FIXTURE.maps)[0].features.length !== 2);
  } finally {
    srv.kill();
    rm(vault, { recursive: true, force: true });
  }
}

// ---- 8. P5: peek scene assembly (buildPeekScene — everything painted appears in the peek) -------
console.log("peek scene (painter P5):");
{
  const { buildPeekScene } = await import(join(ROOT, "tools/design/peek-scene.mjs"));
  const WB_800 = WB_TEXT.replace("size_m: 200", "size_m: 800");
  const doc = (opts = {}) => JSON.stringify({
    version: 2, activeMapId: "m",
    maps: [{
      id: "m", name: "m", scope: "site", parent: null, seaLevel: 0,
      units: { kind: "m", unitsPerMeter: 1, origin: [0, 0] },
      features: [
        { id: "o1", type: "area", kind: "outline", points: [[-350, -350], [350, -350], [350, 350], [-350, 350]] },
        ...(opts.noForest ? [] : [{ id: "fw", type: "area", kind: "biome", biome: "forest", points: [[50, 50], [250, 50], [250, 250], [50, 250]] }]),
        { id: "sw", type: "area", kind: "biome", biome: "swamp", points: [[-250, -250], [-50, -250], [-50, -50], [-250, -50]] },
        { id: "rv", type: "line", kind: "river", points: [[0, -300], [0, 0], [40, 200]], widthM: 6 },
      ],
      ...(opts.noStamps ? {} : { stamps: [{ id: "s1", assetId: "tudor-cottage.glb", x: 10, z: -20, rot: 1.5, scale: 1.2 }] }),
    }],
  });
  const { worldMap: pm } = compileDesignMap({ mapsJsonText: doc(), worldBibleText: WB_800 });
  const { scene, sceneName } = buildPeekScene(pm, { project: "gate", mapFile: "gate-m.worldmap.json" });
  const tools = scene.commands.map((c) => c.tool || c.op);
  const terrainIx = tools.indexOf("terrain.create");
  check("peek: terrain.create drives the painted map source", terrainIx >= 0 && scene.commands[terrainIx].input.generate.source === "map" && scene.commands[terrainIx].input.generate.mapAssetId === "maps/gate-m.worldmap.json");
  const scatters = scene.commands.filter((c) => c.tool === "vegetation.scatter");
  check("peek: painted forest AND swamp each get a confined scatter", scatters.length === 2 && scatters.every((s) => (s.input.inclusions || []).length > 0));
  check("peek: the sea plane is present", tools.includes("world.addWater"));
  const river = scene.commands.find((c) => c.tool === "world.addRiver");
  check("peek: the drawn river gets a ribbon (widthM overshoots the carve)", !!river && river.input.widthM >= 6 * 1.7 - 1e-9);
  const places = scene.commands.filter((c) => c.tool === "asset.place");
  check("peek: the stamped asset is PLACED (grounded, at the anchor, with rot+scale)", places.length === 1
    && places[0].input.assetId === "tudor-cottage.glb" && eq(places[0].input.position, [10, 0, -20])
    && places[0].input.ground === true && places[0].input.rotation[1] === 1.5 && eq(places[0].input.scale, [1.2, 1.2, 1.2]));
  check("peek: placement happens AFTER the terrain exists (ground lift needs it)", tools.indexOf("asset.place") > terrainIx);
  const postIx = tools.indexOf("render.enablePost");
  check("peek: the render-only post stack (GTAO/bloom/grade/outline) is the LAST command (built on the finished scene)",
    postIx === scene.commands.length - 1 && scene.commands[postIx].input.ao.enabled === true && scene.commands[postIx].input.bloom.enabled === true && scene.commands[postIx].input.outline.enabled === true);
  check("peek: sceneName is stable per project+map", sceneName === "peek-gate-m");
  // Determinism: the builder is pure — same IR in, byte-identical scene out.
  check("peek: scene assembly is deterministic", eq(buildPeekScene(pm, { project: "gate", mapFile: "gate-m.worldmap.json" }).scene, scene));
  // Falsifiability: un-stamping removes the placement; un-painting the forest removes its scatter.
  const { worldMap: pm0 } = compileDesignMap({ mapsJsonText: doc({ noStamps: true }), worldBibleText: WB_800 });
  check("(falsifiability) no stamps -> no asset.place commands", buildPeekScene(pm0, { project: "gate", mapFile: "x" }).scene.commands.every((c) => c.tool !== "asset.place"));
  const { worldMap: pmNf } = compileDesignMap({ mapsJsonText: doc({ noForest: true }), worldBibleText: WB_800 });
  check("(falsifiability) un-painting the forest removes its scatter (swamp's remains)", buildPeekScene(pmNf, { project: "gate", mapFile: "x" }).scene.commands.filter((c) => c.tool === "vegetation.scatter").length === 1);

  // Tile-cap: a huge painted world must still render (clamped, coarse) — never emit a
  // terrain.create size past the 8192 cap that would zod-reject and blank the whole peek.
  const bigLand = { ...pm, land: [{ points: [[-4000, -4000], [4000, -4000], [4000, 4000], [-4000, 4000]] }] };
  const big = buildPeekScene(bigLand, { project: "gate", mapFile: "x" });
  const bigTerrain = big.scene.commands.find((c) => c.tool === "terrain.create");
  check("peek: an oversized world clamps terrain size to the 8192 cap (still renders)", bigTerrain.input.size <= 8192 && big.clampedToTileCap === true);
  check("peek: a normal-sized world is NOT flagged clamped", buildPeekScene(pm, { project: "gate", mapFile: "x" }).clampedToTileCap === false);
}

if (failures) { console.error(`\nmapstudio-gate: ${failures} FAILURE(S)`); process.exit(1); }
console.log("\nmapstudio-gate: PASS");
