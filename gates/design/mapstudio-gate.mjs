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

if (failures) { console.error(`\nmapstudio-gate: ${failures} FAILURE(S)`); process.exit(1); }
console.log("\nmapstudio-gate: PASS");
