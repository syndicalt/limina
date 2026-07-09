// design-map-compile.mjs — the PURE compiler: (design-space maps.json, world-bible.md frontmatter)
// -> a WorldMap IR object (see worldmap.ts for the schema this must satisfy). Pure and
// dependency-free (no fs, no process, no Date/Math.random) so it is gated directly
// (js/test/p_worldmap_compile.ts imports compileDesignMap and asserts determinism) and so
// tools/map/compile-designmap.mjs — the CLI — is a thin, untested-logic wrapper: read files,
// call this, write the file, print a summary.
//
// SCALE CONTRACT: every maps.json feature's [x, z] is already world meters (design-space's
// authoring convention), scaled by the map's own `units` metadata if present (default
// {units:"m", unitsPerMeter:1} — i.e. raw coordinate == meters). meters = raw / unitsPerMeter.
//
// AXIS CONVENTION: +x = east, NORTH = -z (right-handed y-up — see worldmap.ts's header). The
// map tool still draws north as screen-up; only the world-space sign of "north" is -z, not +z.
//
// DETERMINISM: no provenance.compiledAt timestamp is stamped by default — a real wall-clock
// value would make "compile the same vault twice" produce two different files, which is exactly
// what p_worldmap_compile.ts proves does NOT happen. provenance.sourceHash instead pins identity
// to the INPUT bytes (deterministic), and provenance.contentHash (via worldmap-hash.mjs) pins the
// compiled OUTPUT.

import { sha256 } from "./sha256.mjs";
import { worldMapContentHash } from "./worldmap-hash.mjs";
import { decodeRasterCells } from "./pipeline/raster-codec.mjs";
import { maskToLandPolygons } from "./pipeline/marching-squares.mjs";
import { reliefGridSampler } from "./pipeline/map-raster.mjs";

const DEFAULT_UNITS = { units: "m", unitsPerMeter: 1 };
// The biome raster's cell vocabulary: cell = index + 1, 0 = unpainted. MUST MATCH BIOME_KINDS
// in js/src/world/worldmap.ts (this pure .mjs can't import the .ts — the mapstudio gate asserts
// the two stay identical) and the frontend palette in tools/design/frontend/map-paint.js.
export const BIOME_CLASSES = ["grass", "forest", "mountain", "desert", "tundra", "swamp", "water", "blight"];
// River width scales with the zone span (clamped): a fixed 3m channel is narrower than one
// rasterizer cell on a km-scale map — it aliases away entirely and the drawn river never renders.
// ~0.8% of span reads as a proper river at the map's own scale (1400m zone -> ~11m channel).
const RIVER_MIN_WIDTH_M = 3;
const RIVER_MAX_WIDTH_M = 16;
const riverWidthM = (sizeM) => Math.min(RIVER_MAX_WIDTH_M, Math.max(RIVER_MIN_WIDTH_M, Math.round(sizeM * 0.008)));
const MOUNTAIN_BIOME_AMPLITUDE = 12;
const GLYPH_AMPLITUDE = { mountain: 12, peak: 15, hills: 5 };

function toPoint(p) {
  return [Number(p[0]), Number(p[1])];
}

function toPoints(pts) {
  return pts.map(toPoint);
}

function bboxOf(pointArrays) {
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const pts of pointArrays) {
    for (const [x, z] of pts) {
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (z < minZ) minZ = z;
      if (z > maxZ) maxZ = z;
    }
  }
  if (minX === Infinity) return { minX: 0, maxX: 0, minZ: 0, maxZ: 0, w: 0, h: 0 };
  return { minX, maxX, minZ, maxZ, w: maxX - minX, h: maxZ - minZ };
}

// ---- targeted world-bible frontmatter reader (the small subset this compiler needs: zone.size_m
// + the `locations:` list — id/name/kind/position/count). Mirrors the parsing strategy of
// tools/design/build-world.mjs's readLocations(), extended for name/position/count. This is
// intentionally NOT the full generic frontmatter parser (js/src/game/design-vault.ts's
// parseFrontmatter) — that lives in a .ts module a plain Node CLI cannot import; a small,
// self-contained regex reader keeps this compiler runnable from both Node and the engine. ----

function frontmatterBlock(md) {
  const m = md.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) throw new Error("world-bible: no YAML frontmatter block found");
  return m[1];
}

function readZoneSizeM(fm) {
  const zoneBlock = fm.split(/^zone:/m)[1];
  if (!zoneBlock) throw new Error("world-bible: missing 'zone:' in frontmatter");
  const top = zoneBlock.search(/\n\S/);
  const scoped = top === -1 ? zoneBlock : zoneBlock.slice(0, top);
  const m = scoped.match(/size_m:\s*(-?\d+(?:\.\d+)?)/);
  if (!m) throw new Error("world-bible: missing 'zone.size_m' in frontmatter");
  return Number(m[1]);
}

function readLocations(fm) {
  const block = fm.split(/^locations:/m)[1];
  if (!block) return [];
  const top = block.search(/\n\S/);
  const scoped = top === -1 ? block : block.slice(0, top);
  const locations = [];
  for (const chunk of scoped.split(/^  - id:/m).slice(1)) {
    const id = chunk.split("\n")[0].trim();
    const name = (chunk.match(/\n\s*name:\s*(.+)/) || [])[1]?.trim();
    const kind = (chunk.match(/\n\s*kind:\s*(\S+)/) || [])[1];
    const posMatch = chunk.match(/\n\s*position:\s*\[\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*\]/);
    const count = Number((chunk.match(/\n\s*count:\s*(\d+)/) || [])[1]) || undefined;
    if (id && kind && posMatch) {
      locations.push({ id, name, kind, position: [Number(posMatch[1]), Number(posMatch[2])], count });
    }
  }
  return locations;
}

function yamlScalar(raw) {
  if (typeof raw !== "string") return undefined;
  const value = raw.trim();
  if (value === "" || value === "null" || value === "~") return undefined;
  if (value.startsWith('"') && value.endsWith('"')) {
    try { return JSON.parse(value); } catch { throw new Error(`invalid quoted YAML scalar: ${value}`); }
  }
  if (value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1).replace(/''/g, "'");
  return value;
}

// ---- targeted `places.md` frontmatter reader (Places Stage 4). Same self-contained strategy as
// readLocations above (a plain .mjs cannot import parsePlaces from the .ts module): split the
// `places:` list on each `  - id:` item and pluck the small subset the compiler emits — id, name,
// kind, parentId, position, binding, radiusM, assetId. Missing input (no placesText / no places
// block) yields [] so pre-Places vaults compile byte-identically. ----

function readPlaces(placesText) {
  if (typeof placesText !== "string" || placesText.length === 0) return [];
  const fmMatch = placesText.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!fmMatch) return [];
  const block = fmMatch[1].split(/^places:/m)[1];
  if (!block) return [];
  const top = block.search(/\n\S/);
  const scoped = top === -1 ? block : block.slice(0, top);
  const places = [];
  for (const chunk of scoped.split(/^  - id:/m).slice(1)) {
    const id = chunk.split("\n")[0].trim();
    if (!id) continue;
    const name = yamlScalar((chunk.match(/\n\s*name:\s*(.*)/) || [])[1]) || id;
    const kind = yamlScalar((chunk.match(/\n\s*kind:\s*(.*)/) || [])[1]) || "place";
    const parentM = chunk.match(/\n\s*parentId:\s*(.*)/);
    const posMatch = chunk.match(/\n\s*position:\s*\[\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*\]/);
    const bindingM = chunk.match(/\n\s*binding:\s*(.*)/);
    const radM = chunk.match(/\n\s*radiusM:\s*(-?\d+(?:\.\d+)?)/);
    const assetM = chunk.match(/\n\s*assetId:\s*(.*)/);
    places.push({
      id,
      name,
      kind,
      parentId: yamlScalar(parentM?.[1]) ?? null,
      position: posMatch ? [Number(posMatch[1]), Number(posMatch[2])] : undefined,
      binding: yamlScalar(bindingM?.[1]),
      radiusM: radM ? Number(radM[1]) : undefined,
      assetId: yamlScalar(assetM?.[1]),
    });
  }
  const ids = new Set();
  for (const place of places) {
    if (ids.has(place.id)) throw new Error(`places: duplicate id "${place.id}"`);
    ids.add(place.id);
    if (place.binding === "area" && !(typeof place.radiusM === "number" && place.radiusM > 0)) {
      throw new Error(`places: area-bound place "${place.id}" requires a positive radiusM`);
    }
  }
  for (const place of places) {
    if (place.parentId !== null && !ids.has(place.parentId)) {
      throw new Error(`places: "${place.id}" references missing parent "${place.parentId}"`);
    }
    const seen = new Set([place.id]);
    let parent = place.parentId;
    while (parent !== null) {
      if (seen.has(parent)) throw new Error(`places: hierarchy cycle involving "${place.id}"`);
      seen.add(parent);
      parent = places.find((candidate) => candidate.id === parent)?.parentId ?? null;
    }
  }
  return places;
}

/**
 * Compile a design-space map + its world-bible into a plain WorldMap-shaped object (matching
 * worldmap.ts's WorldMapSchema — the caller is expected to zod-parse it; this pure function has
 * no zod dependency so it can run from plain Node with no engine build).
 *
 * @param {object} args
 * @param {string} args.mapsJsonText   raw contents of maps.json
 * @param {string} args.worldBibleText raw contents of world-bible.md
 * @param {string} [args.mapId]        map id to compile (default: maps.json's activeMapId)
 * @param {string} [args.placesText]   raw contents of places.md (Places Stage 4). Absent -> no
 *                                      gazetteer / no place anchors (pre-Places vaults unchanged).
 * @returns {{ worldMap: object, warnings: string[] }}
 */
export function compileDesignMap({ mapsJsonText, worldBibleText, mapId, placesText }) {
  const warnings = [];
  const mapsDoc = JSON.parse(mapsJsonText);
  const targetId = mapId || mapsDoc.activeMapId;
  const map = mapsDoc.maps.find((m) => m.id === targetId);
  if (!map) throw new Error(`compile-designmap: map id "${targetId}" not found in maps.json (have: ${mapsDoc.maps.map((m) => m.id).join(", ")})`);

  const units = map.units || DEFAULT_UNITS;
  const unitsPerMeter = units.unitsPerMeter || 1;

  // A painted elevation raster (Map Studio S1, map.rasters.elevation in the MapDoc) compiles to
  // the IR's reliefGrid. PRECEDENCE CONTRACT: when present, vector relief hints are NOT emitted
  // at all (painted is authoritative; the rasterizer would ignore them anyway — this keeps the
  // compiled IR honest about which authority produced the surface).
  const elevation = map.rasters && map.rasters.elevation ? map.rasters.elevation : undefined;
  if (elevation) {
    for (const k of ["w", "h", "minY", "maxY", "data", "rect"]) {
      if (elevation[k] === undefined) throw new Error(`compile-designmap: rasters.elevation is missing '${k}'`);
    }
  }

  // A painted landmass mask (Map Painter P1, map.rasters.landmass) compiles to the IR's EXISTING
  // land[] polygons via marching squares — no IR schema change; the rasterizer can't tell a
  // painted coast from a traced one. PRECEDENCE CONTRACT (mirrors reliefGrid): when a mask is
  // present, hand-traced outline features are ignored entirely, with a warning per feature.
  const landmass = map.rasters && map.rasters.landmass ? map.rasters.landmass : undefined;
  if (landmass) {
    for (const k of ["w", "h", "data", "rect"]) {
      if (landmass[k] === undefined) throw new Error(`compile-designmap: rasters.landmass is missing '${k}'`);
    }
  }

  // A painted biome raster (Map Painter P2, map.rasters.biomes) vectorizes per class into the
  // IR's EXISTING biome polygons. Cell values are FIXED indices into BIOME_CLASSES + 1 (0 =
  // unpainted) — no per-map palette array to reorder. Same precedence contract as the other
  // paint layers: when present, vector biome features are ignored with a warning.
  const biomesRaster = map.rasters && map.rasters.biomes ? map.rasters.biomes : undefined;
  if (biomesRaster) {
    for (const k of ["w", "h", "data", "rect"]) {
      if (biomesRaster[k] === undefined) throw new Error(`compile-designmap: rasters.biomes is missing '${k}'`);
    }
  }

  const fm = frontmatterBlock(worldBibleText);
  const sizeM = readZoneSizeM(fm);
  const locations = readLocations(fm);

  const land = [];
  const relief = [];
  const biomes = [];
  const waterways = [];
  const routes = [];

  if (landmass) {
    const lw = Number(landmass.w), lh = Number(landmass.h);
    const cells = decodeRasterCells(landmass, lw * lh);
    const rect = { x0: Number(landmass.rect.x0), z0: Number(landmass.rect.z0), w: Number(landmass.rect.w), h: Number(landmass.rect.h) };
    // ELEVATION CARVES WATER: painted elevation below sea level removes land from the mask —
    // digging at the coast extends the sea (the Atlas display applies the identical rule, so
    // the coast the user sees is the coast that builds). Enclosed sub-sea pits become polygon
    // holes and are dropped from the land VECTORS — but they still render as LAKES: the
    // rasterizer keeps decisively-sub-sea painted cells below the water plane (map-raster's
    // paintedSubSea exemption), matching the hillshade's submerged tint. Only points INSIDE
    // the elevation extent can carve (the sampler clamps to
    // its edge — without the bounds check, an edge dig would smear water outward forever).
    if (elevation) {
      const sampler = reliefGridSampler({
        reliefGrid: {
          w: Number(elevation.w), h: Number(elevation.h),
          rect: { x0: Number(elevation.rect.x0), z0: Number(elevation.rect.z0), w: Number(elevation.rect.w), h: Number(elevation.rect.h) },
          minY: Number(elevation.minY), maxY: Number(elevation.maxY),
          data: String(elevation.data),
        },
        origin: [0, 0], unitsPerMeter: 1,
      });
      const seaY = typeof map.seaLevel === "number" ? map.seaLevel : 0;
      const er = elevation.rect;
      const sx = rect.w / (lw - 1), sz = rect.h / (lh - 1);
      for (let r = 0; r < lh; r++) {
        const wz = rect.z0 + r * sz;
        if (wz < er.z0 || wz > er.z0 + er.h) continue;
        for (let c = 0; c < lw; c++) {
          const i = r * lw + c;
          if (cells[i] < 128) continue;
          const wx = rect.x0 + c * sx;
          if (wx < er.x0 || wx > er.x0 + er.w) continue;
          if (sampler(wx, wz) < seaY - 0.01) cells[i] = 0;
        }
      }
    }
    for (const poly of maskToLandPolygons({ w: lw, h: lh, rect, cells })) {
      land.push(poly);
    }
  }

  if (biomesRaster) {
    const bw = Number(biomesRaster.w), bh = Number(biomesRaster.h);
    const cells = decodeRasterCells(biomesRaster, bw * bh);
    const rect = { x0: Number(biomesRaster.rect.x0), z0: Number(biomesRaster.rect.z0), w: Number(biomesRaster.rect.w), h: Number(biomesRaster.rect.h) };
    for (let k = 0; k < BIOME_CLASSES.length; k++) {
      const bin = new Uint8Array(bw * bh);
      let any = false;
      for (let i = 0; i < cells.length; i++) if (cells[i] === k + 1) { bin[i] = 255; any = true; }
      if (!any) continue;
      for (const poly of maskToLandPolygons({ w: bw, h: bh, rect, cells: bin })) {
        biomes.push({ biome: BIOME_CLASSES[k], points: poly.points });
        // Parity with the vector path: painted mountains hint relief unless painted elevation
        // is authoritative.
        if (BIOME_CLASSES[k] === "mountain" && !elevation) {
          relief.push({ kind: "mountain", shape: { polygon: poly.points }, amplitude: MOUNTAIN_BIOME_AMPLITUDE });
        }
      }
    }
  }

  for (const f of map.features) {
    if (f.type === "area" && f.kind === "outline") {
      if (landmass) { warnings.push(`ignored outline feature "${f.id}" (a painted landmass mask is authoritative)`); continue; }
      land.push({ points: toPoints(f.points) });
    } else if (f.type === "area" && f.kind === "biome") {
      if (biomesRaster) { warnings.push(`ignored biome feature "${f.id}" (a painted biome raster is authoritative)`); continue; }
      const points = toPoints(f.points);
      biomes.push({ biome: f.biome, points });
      if (f.biome === "mountain" && !elevation) {
        relief.push({ kind: "mountain", shape: { polygon: points }, amplitude: MOUNTAIN_BIOME_AMPLITUDE });
      }
    } else if (f.type === "line" && f.kind === "river") {
      waterways.push({ points: toPoints(f.points), widthM: Number(f.widthM) > 0 ? Number(f.widthM) : riverWidthM(sizeM), class: "river" });
    } else if (f.type === "line" && f.kind === "road") {
      routes.push({ points: toPoints(f.points), class: "road" });
    } else if (f.type === "line" && f.kind === "border") {
      warnings.push(`skipped border feature "${f.id}" (political borders are out of scope for v1)`);
    } else if (f.type === "glyph" && (f.glyph === "mountain" || f.glyph === "peak" || f.glyph === "hills")) {
      if (!elevation) relief.push({ kind: f.glyph, shape: { point: [Number(f.x), Number(f.z)] }, amplitude: GLYPH_AMPLITUDE[f.glyph] });
    } else if (f.type === "glyph") {
      warnings.push(`skipped glyph "${f.glyph}" on feature "${f.id}" (no relief mapping for v1)`);
    } else {
      warnings.push(`skipped unrecognized feature "${f.id ?? "?"}" (type=${f.type}, kind=${f.kind})`);
    }
  }

  // SCALE CONTRACT CHECK — no silent fitting: an authored outline that is grossly out of scale
  // with the world-bible's declared zone size is a design-vault bug, not something to rescale.
  if (land.length > 0) {
    const bbox = bboxOf(land.map((l) => l.points));
    const wM = bbox.w / unitsPerMeter;
    const hM = bbox.h / unitsPerMeter;
    if (wM > sizeM * 2 || hM > sizeM * 2) {
      throw new Error(
        `compile-designmap: outline bbox ${wM.toFixed(1)}x${hM.toFixed(1)}m exceeds 2x world-bible zone.size_m=${sizeM}m ` +
        `(limit ${(sizeM * 2).toFixed(1)}m per axis) — no silent fitting; fix the authored map or the zone size`,
      );
    }
  }

  const allPointArrays = [
    ...land.map((l) => l.points),
    ...biomes.map((b) => b.points),
    ...waterways.map((w) => w.points),
    ...routes.map((r) => r.points),
  ];
  const bbox = bboxOf(allPointArrays.length > 0 ? allPointArrays : [[[0, 0]]]);
  const extent = { w: Math.max(bbox.w / unitsPerMeter, 1), h: Math.max(bbox.h / unitsPerMeter, 1) };

  const anchors = locations.map((l) => ({
    id: l.id,
    kind: l.kind,
    position: l.position,
    ...(l.count !== undefined ? { count: l.count } : {}),
    ...(l.name !== undefined ? { name: l.name } : {}),
    source: "world-bible",
  }));

  // Map Painter P3 stamps: each placed stamp compiles 1:1 into an "asset" anchor that names its
  // exact catalog asset — the build sites it through the same steering path as planned buildings
  // (never raw asset.place around the planner). A dangling assetId still compiles (with a
  // warning downstream at render/build time) — stamps must never vanish silently.
  for (const s of Array.isArray(map.stamps) ? map.stamps : []) {
    if (!s || typeof s !== "object" || !s.id || !s.assetId) {
      warnings.push(`skipped malformed stamp ${JSON.stringify(s && s.id ? s.id : s)}`);
      continue;
    }
    anchors.push({
      id: String(s.id),
      kind: "asset",
      position: [Number(s.x), Number(s.z)],
      assetId: String(s.assetId),
      ...(typeof s.rot === "number" && s.rot !== 0 ? { rot: Number(s.rot) } : {}),
      ...(typeof s.scale === "number" && s.scale !== 1 ? { scale: Number(s.scale) } : {}),
      source: "map",
    });
  }

  // PLACES (Stage 4): the gazetteer (the runtime named-place index NPCs navigate by) + place-marker
  // anchors. A places.md node WITH a map position compiles to one gazetteer entry. A placed place
  // that also names a marker asset (assetId — the retired world-bible location's asset/anchor role,
  // folded into a place by the convergence) ALSO compiles to an "asset" anchor, so it spawns its GLB
  // through the SAME steering path as an Atlas stamp (never a raw asset.place). Unplaced places (no
  // position — a not-yet-sited landmark, or an ancestor like a Nation) are hierarchy-only: no
  // gazetteer entry (nothing to navigate to), no anchor. Emitted in source order (deterministic).
  const gazetteer = [];
  const anchorIds = new Set(anchors.map((a) => a.id));
  for (const p of readPlaces(placesText)) {
    if (!p.position) continue;
    const entry = { placeId: p.id, name: p.name, kind: p.kind, parentId: p.parentId, position: p.position };
    if (p.binding === "area" && typeof p.radiusM === "number") entry.radiusM = p.radiusM;
    gazetteer.push(entry);
    if (p.assetId) {
      if (anchorIds.has(p.id)) {
        warnings.push(`place "${p.id}" shares an id with an existing anchor — its marker-asset anchor was skipped`);
      } else {
        anchors.push({ id: p.id, kind: "asset", position: p.position, assetId: p.assetId, source: "places" });
        anchorIds.add(p.id);
      }
    }
  }

  const sourceHash = sha256(mapsJsonText + "\u0000" + worldBibleText + (typeof placesText === "string" ? "\u0000" + placesText : ""));

  const worldMap = {
    version: 1,
    id: map.id,
    unitsPerMeter,
    origin: [0, 0],
    extent,
    seaLevel: typeof map.seaLevel === "number" ? map.seaLevel : 0.0,
    land,
    relief,
    ...(elevation ? {
      reliefGrid: {
        w: Number(elevation.w),
        h: Number(elevation.h),
        rect: { x0: Number(elevation.rect.x0), z0: Number(elevation.rect.z0), w: Number(elevation.rect.w), h: Number(elevation.rect.h) },
        minY: Number(elevation.minY),
        maxY: Number(elevation.maxY),
        data: String(elevation.data),
      },
    } : {}),
    biomes,
    waterways,
    routes,
    anchors,
    // Emitted only when the vault has placed places, so pre-Places maps keep their bytes/hash.
    ...(gazetteer.length > 0 ? { gazetteer } : {}),
    provenance: {
      tool: "design-space",
      sourceHash,
      // compiledAt intentionally omitted (see module header: determinism).
      contentHash: "", // placeholder; replaced below once the rest of the shape is final
    },
  };
  worldMap.provenance.contentHash = worldMapContentHash(worldMap);

  return { worldMap, warnings };
}
