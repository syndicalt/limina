// worldmap-hash.mjs — deterministic serialization + content hashing for the WorldMap IR, shared
// verbatim by both sides of the compile/verify seam:
//   - js/src/world/worldmap.ts (the engine's zod schema + verifyWorldMap), a .ts importing this
//     .mjs the same way terrain-edit.ts imports pipeline/terrain-heightfield.mjs;
//   - tools/map/compile-designmap.mjs (the CLI) and js/src/world/design-map-compile.mjs (the pure
//     compiler it wraps), plain Node scripts that cannot import a .ts file directly.
// Keeping ONE implementation here (rather than a TS copy + an .mjs copy) is the whole point: the
// compiler computes provenance.contentHash with the exact function the engine later re-verifies
// with, so there is no seam where the two could silently diverge.
//
// stableStringifyWorldMap is NOT JSON.stringify(map) — object key order in a hand-authored or
// zod-parsed object is whatever insertion order happened to produce, and JS engines are not
// obligated to preserve it identically across every producer. This walks the WorldMap shape
// EXPLICITLY in the schema's declared field order (mirrors world-bible.ts's canonicalizeWorldBible
// pattern) so the same logical map always serializes to the same bytes, from any caller.

import { sha256 } from "./sha256.mjs";

function point(p) {
  return [p[0], p[1]];
}

function points(ps) {
  return ps.map(point);
}

function polygon(p) {
  const out = { points: points(p.points) };
  if (p.holes !== undefined) out.holes = p.holes.map((h) => points(h));
  return out;
}

function reliefHint(r) {
  const shape = {};
  if (r.shape.polygon !== undefined) shape.polygon = points(r.shape.polygon);
  if (r.shape.point !== undefined) shape.point = point(r.shape.point);
  return { kind: r.kind, shape, amplitude: r.amplitude };
}

function reliefGrid(g) {
  return {
    w: g.w,
    h: g.h,
    rect: { x0: g.rect.x0, z0: g.rect.z0, w: g.rect.w, h: g.rect.h },
    minY: g.minY,
    maxY: g.maxY,
    data: g.data,
  };
}

function biomeRegion(b) {
  return { biome: b.biome, points: points(b.points) };
}

function waterway(w) {
  const out = { points: points(w.points) };
  if (w.widthM !== undefined) out.widthM = w.widthM;
  out.class = w.class;
  return out;
}

function route(r) {
  return { points: points(r.points), class: r.class };
}

function anchor(a) {
  const out = { id: a.id, kind: a.kind, position: point(a.position) };
  if (a.count !== undefined) out.count = a.count;
  if (a.name !== undefined) out.name = a.name;
  // P3 stamp fields: emitted ONLY when present, so every pre-stamp map hashes byte-identically.
  if (a.assetId !== undefined) out.assetId = a.assetId;
  if (a.rot !== undefined) out.rot = a.rot;
  if (a.scale !== undefined) out.scale = a.scale;
  out.source = a.source;
  return out;
}

function gazetteerEntry(g) {
  const out = { placeId: g.placeId, name: g.name, kind: g.kind, parentId: g.parentId === undefined ? null : g.parentId, position: point(g.position) };
  if (g.radiusM !== undefined) out.radiusM = g.radiusM;
  return out;
}

function provenance(p, omitContentHash) {
  const out = { tool: p.tool };
  if (p.sourceHash !== undefined) out.sourceHash = p.sourceHash;
  if (p.compiledAt !== undefined) out.compiledAt = p.compiledAt;
  if (!omitContentHash) out.contentHash = p.contentHash;
  if (p.cropOf !== undefined) out.cropOf = { anchor: p.cropOf.anchor, anchorPx: point(p.cropOf.anchorPx), radiusM: p.cropOf.radiusM };
  return out;
}

/**
 * Deterministic serialization of a WorldMap: fixed key order (schema declaration order), no
 * whitespace variance, every field rebuilt from scratch (never trusts input object key order).
 * `omitContentHash: true` drops provenance.contentHash entirely (not just blanks it) — the form
 * worldMapContentHash hashes, since the hash cannot include itself.
 */
export function stableStringifyWorldMap(map, opts = {}) {
  const omitContentHash = opts.omitContentHash === true;
  const canonical = {
    version: map.version,
    id: map.id,
    unitsPerMeter: map.unitsPerMeter,
    origin: point(map.origin),
    extent: { w: map.extent.w, h: map.extent.h },
    seaLevel: map.seaLevel,
    land: map.land.map(polygon),
    relief: map.relief.map(reliefHint),
    // Optional additive fields are emitted ONLY when present, so every pre-reliefGrid map keeps
    // its original bytes (and hash) unchanged.
    ...(map.reliefGrid !== undefined ? { reliefGrid: reliefGrid(map.reliefGrid) } : {}),
    biomes: map.biomes.map(biomeRegion),
    waterways: map.waterways.map(waterway),
    routes: map.routes.map(route),
    anchors: map.anchors.map(anchor),
    // Optional additive field: emitted ONLY when present, so every pre-Places map hashes
    // byte-identically (mirrors reliefGrid above).
    ...(map.gazetteer !== undefined ? { gazetteer: map.gazetteer.map(gazetteerEntry) } : {}),
    provenance: provenance(map.provenance, omitContentHash),
  };
  return JSON.stringify(canonical);
}

/** sha256 hex of the stable form with provenance.contentHash omitted — the content address a
 *  WorldMap's own provenance.contentHash field is expected to hold. */
export function worldMapContentHash(map) {
  return sha256(stableStringifyWorldMap(map, { omitContentHash: true }));
}
