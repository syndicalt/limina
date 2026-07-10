// design-map-compile.mjs — the PURE compiler: (design-space maps.json, world-bible.md frontmatter)
// -> a WorldMap IR object (see worldmap.ts for the schema this must satisfy). Pure and
// dependency-free (no fs, no process, no Date/Math.random) so it is gated directly
// (js/test/p_worldmap_compile.ts imports compileDesignMap and asserts determinism) and so
// tools/map/compile-designmap.mjs — the CLI — is a thin, untested-logic wrapper: read files,
// call this, write the file, print a summary.
//
// COORDINATE CONTRACT: MapDoc geometry is local to its declared `units` frame. The compiler
// normalizes every horizontal point/rect exactly once to canonical world metres using
// world = units.origin + local / units.unitsPerMeter, then emits WorldMap unitsPerMeter=1 and
// origin=[0,0]. Meter-suffixed physical quantities (widthM, radiusM, depthM, etc.) are already
// physical and are never scaled. Legacy maps without `units` use the canonical identity frame.
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
import { canonicalMapDocText } from "./mapdoc-canonical.mjs";
import { decodeRasterCells } from "./pipeline/raster-codec.mjs";
import { maskToLandPolygons } from "./pipeline/marching-squares.mjs";
import { reliefGridSampler } from "./pipeline/map-raster.mjs";
import { parseAuthoredWaterBodies, parseAuthoredWaterway, WATER_LIMITS, WaterIrValidationError } from "./water-ir.mjs";
import { HydrologyIrValidationError, parseAuthoredHydrologyRecipe } from "./hydrology-ir.mjs";
import { mapLocalRectToWorld, mapLocalToWorld, parseMapCoordinateFrame } from "./map-coordinate-frame.mjs";
import {
  ATLAS_DESIGN_REF_SCHEMA,
  MAX_DESIGN_INDEX_ENTRIES,
  atlasDesignRefKey,
  parseAtlasDesignRef,
} from "./design-ref.mjs";

const DEFAULT_UNITS = { kind: "m", unitsPerMeter: 1, origin: [0, 0] };
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
const MAX_ATLAS_MAPS = 256;
const MAX_ATLAS_FEATURES = 100_000;
const MAX_ATLAS_STAMPS = 100_000;
const MAX_ATLAS_PLACES = 100_000;
const MAX_ATLAS_MARKERS = 100_000;
const ATLAS_CONTROL_CHAR = /[\u0000-\u001f\u007f]/;
const ATLAS_PLACE_FIELDS = new Set([
  "id", "name", "kind", "parentId", "position", "binding", "radiusM", "regionId", "map",
  "tags", "note", "assetId", "mapLink",
]);
const ATLAS_MARKER_FIELDS = new Set([
  "id", "name", "kind", "position", "count", "radiusM", "assetId", "map", "mapLink",
  "region", "regionId", "tags", "note",
]);

function atlasError(message) {
  throw new Error(`compile-atlas-mapdoc: ${message}`);
}

function finiteAtlasNumber(value, path) {
  if (typeof value !== "number" || !Number.isFinite(value) || Object.is(value, -0)) atlasError(`${path} must be a finite canonical number`);
  return value;
}

function atlasPoint(value, path) {
  if (!Array.isArray(value) || value.length !== 2) atlasError(`${path} must be a two-number point`);
  finiteAtlasNumber(value[0], `${path}[0]`);
  finiteAtlasNumber(value[1], `${path}[1]`);
}

function atlasPoints(value, minimum, path) {
  if (!Array.isArray(value) || value.length < minimum || value.length > 1_000_000) atlasError(`${path} must contain ${minimum}-1000000 points`);
  for (let index = 0; index < value.length; index++) atlasPoint(value[index], `${path}[${index}]`);
}

function atlasBoundedString(value, path, maximum = 256) {
  if (typeof value !== "string" || value.length < 1 || value.length > maximum
      || value.trim().length < 1 || ATLAS_CONTROL_CHAR.test(value)) {
    atlasError(`${path} must be a non-empty string of at most ${maximum} characters`);
  }
  return value;
}

function validateAtlasPlaces(places, path, coordinateFrame) {
  if (!Array.isArray(places) || places.length > MAX_ATLAS_PLACES) atlasError(`${path} must contain at most ${MAX_ATLAS_PLACES} entries`);
  const ids = new Set();
  for (let index = 0; index < places.length; index++) {
    const place = places[index], placePath = `${path}[${index}]`;
    if (place === null || typeof place !== "object" || Array.isArray(place)
        || Object.getPrototypeOf(place) !== Object.prototype || Object.getOwnPropertySymbols(place).length !== 0
        || Object.getOwnPropertyNames(place).some((field) => !ATLAS_PLACE_FIELDS.has(field))) {
      atlasError(`${placePath} fields are invalid`);
    }
    atlasBoundedString(place.id, `${placePath}.id`, 128);
    atlasBoundedString(place.name, `${placePath}.name`);
    atlasBoundedString(place.kind, `${placePath}.kind`, 128);
    if (ids.has(place.id)) atlasError(`${placePath}.id is duplicated`);
    ids.add(place.id);
    if (place.parentId !== undefined && place.parentId !== null) atlasBoundedString(place.parentId, `${placePath}.parentId`, 128);
    if (place.position !== undefined) { atlasPoint(place.position, `${placePath}.position`); toPoint(coordinateFrame, place.position); }
    if (place.binding !== undefined && place.binding !== "point" && place.binding !== "area") atlasError(`${placePath}.binding is invalid`);
    if (place.radiusM !== undefined && !(finiteAtlasNumber(place.radiusM, `${placePath}.radiusM`) > 0)) atlasError(`${placePath}.radiusM must be positive`);
    if (place.binding === "area" && !(typeof place.radiusM === "number" && place.radiusM > 0)) atlasError(`${placePath} area binding requires radiusM`);
    if (place.radiusM !== undefined && place.binding !== "area") atlasError(`${placePath}.radiusM requires area binding`);
    for (const field of ["regionId", "map", "note", "assetId", "mapLink"]) {
      if (place[field] !== undefined) atlasBoundedString(place[field], `${placePath}.${field}`, field === "note" ? 4096 : 256);
    }
    if (place.tags !== undefined) {
      if (!Array.isArray(place.tags) || place.tags.length > 256) atlasError(`${placePath}.tags is invalid`);
      for (let tagIndex = 0; tagIndex < place.tags.length; tagIndex++) atlasBoundedString(place.tags[tagIndex], `${placePath}.tags[${tagIndex}]`, 128);
    }
  }
  for (let index = 0; index < places.length; index++) {
    const place = places[index], placePath = `${path}[${index}]`;
    if (place.parentId !== undefined && place.parentId !== null && !ids.has(place.parentId)) atlasError(`${placePath}.parentId references a missing place`);
    const seen = new Set([place.id]);
    let parent = place.parentId ?? null;
    while (parent !== null) {
      if (seen.has(parent)) atlasError(`${placePath} participates in a hierarchy cycle`);
      seen.add(parent);
      parent = places.find((candidate) => candidate.id === parent)?.parentId ?? null;
    }
  }
}

function validateAtlasMarkers(markers, path, coordinateFrame) {
  if (!Array.isArray(markers) || markers.length > MAX_ATLAS_MARKERS) atlasError(`${path} must contain at most ${MAX_ATLAS_MARKERS} entries`);
  const ids = new Set();
  for (let index = 0; index < markers.length; index++) {
    const marker = markers[index], markerPath = `${path}[${index}]`;
    if (marker === null || typeof marker !== "object" || Array.isArray(marker)
        || Object.getPrototypeOf(marker) !== Object.prototype || Object.getOwnPropertySymbols(marker).length !== 0
        || Object.getOwnPropertyNames(marker).some((field) => !ATLAS_MARKER_FIELDS.has(field))) {
      atlasError(`${markerPath} fields are invalid`);
    }
    atlasBoundedString(marker.id, `${markerPath}.id`, 128);
    atlasBoundedString(marker.name, `${markerPath}.name`);
    atlasBoundedString(marker.kind, `${markerPath}.kind`, 128);
    if (ids.has(marker.id)) atlasError(`${markerPath}.id is duplicated`);
    ids.add(marker.id);
    atlasPoint(marker.position, `${markerPath}.position`);
    toPoint(coordinateFrame, marker.position);
    if (marker.count !== undefined && (!Number.isSafeInteger(marker.count) || marker.count < 1)) atlasError(`${markerPath}.count must be a positive safe integer`);
    if (marker.radiusM !== undefined && !(finiteAtlasNumber(marker.radiusM, `${markerPath}.radiusM`) > 0)) atlasError(`${markerPath}.radiusM must be positive`);
    for (const field of ["assetId", "map", "mapLink", "region", "regionId", "note"]) {
      if (marker[field] !== undefined) atlasBoundedString(marker[field], `${markerPath}.${field}`, field === "note" ? 4096 : 256);
    }
    if (marker.tags !== undefined) {
      if (!Array.isArray(marker.tags) || marker.tags.length > 256) atlasError(`${markerPath}.tags is invalid`);
      for (let tagIndex = 0; tagIndex < marker.tags.length; tagIndex++) atlasBoundedString(marker.tags[tagIndex], `${markerPath}.tags[${tagIndex}]`, 128);
    }
  }
}

function validateAtlasRaster(raster, path, elevation) {
  if (raster === null || typeof raster !== "object" || Array.isArray(raster)) atlasError(`${path} must be an object`);
  if (!Number.isInteger(raster.w) || raster.w < 2 || raster.w > 1024 || !Number.isInteger(raster.h) || raster.h < 2 || raster.h > 1024) {
    atlasError(`${path} dimensions must be integers in [2, 1024]`);
  }
  const rect = raster.rect;
  if (rect === null || typeof rect !== "object" || Array.isArray(rect)) atlasError(`${path}.rect must be an object`);
  finiteAtlasNumber(rect.x0, `${path}.rect.x0`);
  finiteAtlasNumber(rect.z0, `${path}.rect.z0`);
  if (!(finiteAtlasNumber(rect.w, `${path}.rect.w`) > 0) || !(finiteAtlasNumber(rect.h, `${path}.rect.h`) > 0)) atlasError(`${path}.rect dimensions must be positive`);
  if (typeof raster.data !== "string" || raster.data.length < 1 || raster.data.length > 2_796_204) atlasError(`${path}.data is invalid`);
  if (elevation) {
    const minY = finiteAtlasNumber(raster.minY, `${path}.minY`);
    const maxY = finiteAtlasNumber(raster.maxY, `${path}.maxY`);
    if (!(maxY > minY)) atlasError(`${path} requires maxY > minY`);
    if (raster.encoding !== undefined && raster.encoding !== "u8" && raster.encoding !== "u16") atlasError(`${path}.encoding is invalid`);
    try {
      reliefGridSampler({
        reliefGrid: {
          w: raster.w,
          h: raster.h,
          rect: { x0: rect.x0, z0: rect.z0, w: rect.w, h: rect.h },
          minY,
          maxY,
          ...(raster.encoding === undefined ? {} : { encoding: raster.encoding }),
          data: raster.data,
        },
        origin: [0, 0],
        unitsPerMeter: 1,
      });
    } catch (error) { atlasError(`${path} payload is invalid: ${error instanceof Error ? error.message : String(error)}`); }
  } else {
    if (raster.enc !== undefined && raster.enc !== "rle8") atlasError(`${path}.enc is invalid`);
    try { decodeRasterCells(raster, raster.w * raster.h); }
    catch (error) { atlasError(`${path} payload is invalid: ${error instanceof Error ? error.message : String(error)}`); }
  }
}

function validateAtlasMapDoc(doc) {
  if (doc === null || typeof doc !== "object" || Array.isArray(doc)) atlasError("root must be an object");
  if (doc.version !== 2) atlasError("version must be 2");
  if (!Array.isArray(doc.maps) || doc.maps.length < 1 || doc.maps.length > MAX_ATLAS_MAPS) atlasError(`maps must contain 1-${MAX_ATLAS_MAPS} entries`);
  if (typeof doc.activeMapId !== "string" || doc.activeMapId.length < 1 || doc.activeMapId.length > 128) atlasError("activeMapId is invalid");
  const ids = new Set();
  for (let mapIndex = 0; mapIndex < doc.maps.length; mapIndex++) {
    const map = doc.maps[mapIndex];
    const path = `maps[${mapIndex}]`;
    if (map === null || typeof map !== "object" || Array.isArray(map)) atlasError(`${path} must be an object`);
    if (typeof map.id !== "string" || map.id.length < 1 || map.id.length > 128) atlasError(`${path}.id is invalid`);
    if (ids.has(map.id)) atlasError(`map id '${map.id}' is duplicated`);
    ids.add(map.id);
    if (typeof map.name !== "string" || map.name.length < 1 || typeof map.scope !== "string" || map.scope.length < 1) atlasError(`${path} name/scope are invalid`);
    if (map.parent !== null && map.parent !== undefined && typeof map.parent !== "string") atlasError(`${path}.parent is invalid`);
    let coordinateFrame;
    try { coordinateFrame = parseMapCoordinateFrame(map.units); }
    catch (error) { atlasError(`${path}.units is invalid: ${error instanceof Error ? error.message : String(error)}`); }
    if (!Array.isArray(map.features) || map.features.length > MAX_ATLAS_FEATURES) atlasError(`${path}.features must contain at most ${MAX_ATLAS_FEATURES} entries`);
    if (map.seaLevel !== undefined) finiteAtlasNumber(map.seaLevel, `${path}.seaLevel`);
    if (map.waterBodies !== undefined) normalizeWaterBodies(coordinateFrame, compileWater(map.waterBodies, parseAuthoredWaterBodies));
    if (map.hydrology !== undefined) compileHydrology(map.hydrology);
    if (map.rasters !== undefined) {
      if (map.rasters === null || typeof map.rasters !== "object" || Array.isArray(map.rasters)) atlasError(`${path}.rasters must be an object`);
      if (map.rasters.elevation !== undefined) validateAtlasRaster(map.rasters.elevation, `${path}.rasters.elevation`, true);
      if (map.rasters.landmass !== undefined) validateAtlasRaster(map.rasters.landmass, `${path}.rasters.landmass`, false);
      if (map.rasters.biomes !== undefined) validateAtlasRaster(map.rasters.biomes, `${path}.rasters.biomes`, false);
      if (map.rasters.elevation !== undefined) toRect(coordinateFrame, map.rasters.elevation.rect);
      if (map.rasters.landmass !== undefined) toRect(coordinateFrame, map.rasters.landmass.rect);
      if (map.rasters.biomes !== undefined) toRect(coordinateFrame, map.rasters.biomes.rect);
    }
    if (map.stamps !== undefined) {
      if (!Array.isArray(map.stamps) || map.stamps.length > MAX_ATLAS_STAMPS) atlasError(`${path}.stamps must contain at most ${MAX_ATLAS_STAMPS} entries`);
      const stampIds = new Set();
      for (let index = 0; index < map.stamps.length; index++) {
        const stamp = map.stamps[index], stampPath = `${path}.stamps[${index}]`;
        if (stamp === null || typeof stamp !== "object" || Array.isArray(stamp)
          || typeof stamp.id !== "string" || stamp.id.length < 1 || stamp.id.length > 128
          || typeof stamp.assetId !== "string" || stamp.assetId.length < 1) atlasError(`${stampPath} is invalid`);
        if (stampIds.has(stamp.id)) atlasError(`${stampPath}.id is duplicated`);
        stampIds.add(stamp.id);
        finiteAtlasNumber(stamp.x, `${stampPath}.x`);
        finiteAtlasNumber(stamp.z, `${stampPath}.z`);
        toPoint(coordinateFrame, [stamp.x, stamp.z]);
        if (stamp.rot !== undefined) finiteAtlasNumber(stamp.rot, `${stampPath}.rot`);
        if (stamp.scale !== undefined && !(finiteAtlasNumber(stamp.scale, `${stampPath}.scale`) > 0)) atlasError(`${stampPath}.scale must be positive`);
      }
    }
    if (map.places !== undefined) validateAtlasPlaces(map.places, `${path}.places`, coordinateFrame);
    if (map.markers !== undefined) validateAtlasMarkers(map.markers, `${path}.markers`, coordinateFrame);
    const featureIds = new Set();
    for (let featureIndex = 0; featureIndex < map.features.length; featureIndex++) {
      const feature = map.features[featureIndex], featurePath = `${path}.features[${featureIndex}]`;
      if (feature === null || typeof feature !== "object" || Array.isArray(feature)) atlasError(`${featurePath} must be an object`);
      if (typeof feature.id !== "string" || feature.id.length < 1 || feature.id.length > 128) atlasError(`${featurePath}.id is invalid`);
      if (featureIds.has(feature.id)) atlasError(`${featurePath}.id is duplicated`);
      featureIds.add(feature.id);
      if (feature.type === "area" && (feature.kind === "outline" || feature.kind === "biome")) {
        atlasPoints(feature.points, 3, `${featurePath}.points`);
        toPoints(coordinateFrame, feature.points);
        if (feature.kind === "biome" && !BIOME_CLASSES.includes(feature.biome)) atlasError(`${featurePath}.biome is invalid`);
      } else if (feature.type === "line" && feature.kind === "river") {
        const waterway = compileWater(feature, (value) => parseAuthoredWaterway(value, RIVER_MIN_WIDTH_M, featurePath));
        toPoints(coordinateFrame, waterway.points);
      } else if (feature.type === "line" && (feature.kind === "road" || feature.kind === "border")) {
        atlasPoints(feature.points, 2, `${featurePath}.points`);
        toPoints(coordinateFrame, feature.points);
      } else if (feature.type === "glyph") {
        if (typeof feature.glyph !== "string" || feature.glyph.length < 1) atlasError(`${featurePath}.glyph is invalid`);
        finiteAtlasNumber(feature.x, `${featurePath}.x`);
        finiteAtlasNumber(feature.z, `${featurePath}.z`);
        toPoint(coordinateFrame, [feature.x, feature.z]);
      }
    }
  }
  if (!ids.has(doc.activeMapId)) atlasError("activeMapId does not identify a map");
  for (let mapIndex = 0; mapIndex < doc.maps.length; mapIndex++) {
    for (let placeIndex = 0; placeIndex < (doc.maps[mapIndex].places ?? []).length; placeIndex++) {
      const place = doc.maps[mapIndex].places[placeIndex];
      for (const field of ["map", "mapLink"]) {
        if (place[field] !== undefined && !ids.has(place[field])) atlasError(`maps[${mapIndex}].places[${placeIndex}].${field} does not identify a map`);
      }
    }
    for (let markerIndex = 0; markerIndex < (doc.maps[mapIndex].markers ?? []).length; markerIndex++) {
      const marker = doc.maps[mapIndex].markers[markerIndex];
      for (const field of ["map", "mapLink"]) {
        if (marker[field] !== undefined && !ids.has(marker[field])) atlasError(`maps[${mapIndex}].markers[${markerIndex}].${field} does not identify a map`);
      }
    }
  }
  return doc.maps.find((map) => map.id === doc.activeMapId);
}

function atlasMapSizeM(map, coordinateFrame) {
  let span = 1;
  const includeRect = (rect) => {
    if (rect === undefined) return;
    const world = mapLocalRectToWorld(coordinateFrame, rect);
    span = Math.max(span, world.w, world.h);
  };
  includeRect(map.rasters?.elevation?.rect);
  includeRect(map.rasters?.landmass?.rect);
  includeRect(map.rasters?.biomes?.rect);
  const pointSets = [];
  for (const feature of map.features) if (Array.isArray(feature.points)) pointSets.push(toPoints(coordinateFrame, feature.points));
  for (const body of map.waterBodies ?? []) {
    pointSets.push(toPoints(coordinateFrame, body.footprint.points));
    for (const hole of body.footprint.holes ?? []) pointSets.push(toPoints(coordinateFrame, hole));
  }
  if (pointSets.length > 0) {
    const bounds = bboxOf(pointSets);
    span = Math.max(span, bounds.w, bounds.h);
  }
  return span;
}

function toPoint(coordinateFrame, p) {
  return [...mapLocalToWorld(coordinateFrame, [p[0], p[1]])];
}

function toPoints(coordinateFrame, pts) {
  return pts.map((point) => toPoint(coordinateFrame, point));
}

function toRect(coordinateFrame, rect) {
  return { ...mapLocalRectToWorld(coordinateFrame, {
    x0: rect.x0,
    z0: rect.z0,
    w: rect.w,
    h: rect.h,
  }) };
}

function normalizeWaterBodies(coordinateFrame, bodies) {
  if (bodies === undefined) return undefined;
  return bodies.map((body) => ({
    ...body,
    footprint: {
      points: toPoints(coordinateFrame, body.footprint.points),
      ...(body.footprint.holes === undefined ? {} : {
        holes: body.footprint.holes.map((hole) => toPoints(coordinateFrame, hole)),
      }),
    },
  }));
}

function waterError(message) {
  throw new Error(`compile-designmap: ${message}`);
}

function compileWater(value, parse) {
  try {
    return parse(value);
  } catch (error) {
    if (error instanceof WaterIrValidationError) waterError(error.message);
    throw error;
  }
}

function compileHydrology(value) {
  try {
    return parseAuthoredHydrologyRecipe(value);
  } catch (error) {
    if (error instanceof HydrologyIrValidationError) waterError(error.message);
    throw error;
  }
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
    const map = (chunk.match(/\n\s*map:\s*(\S+)/) || [])[1];
    const radiusM = Number((chunk.match(/\n\s*radiusM:\s*(-?\d+(?:\.\d+)?)/) || [])[1]) || undefined;
    const assetId = yamlScalar((chunk.match(/\n\s*assetId:\s*(.*)/) || [])[1]);
    if (id && kind && posMatch) {
      locations.push({ id, name, kind, position: [Number(posMatch[1]), Number(posMatch[2])], count, map, radiusM, assetId });
    }
  }
  const ids = new Set();
  for (const location of locations) {
    if (ids.has(location.id)) throw new Error(`world-bible: duplicate location id "${location.id}"`);
    ids.add(location.id);
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
    const mapM = chunk.match(/\n\s*map:\s*(.*)/);
    places.push({
      id,
      name,
      kind,
      parentId: yamlScalar(parentM?.[1]) ?? null,
      position: posMatch ? [Number(posMatch[1]), Number(posMatch[2])] : undefined,
      binding: yamlScalar(bindingM?.[1]),
      radiusM: radM ? Number(radM[1]) : undefined,
      assetId: yamlScalar(assetM?.[1]),
      map: yamlScalar(mapM?.[1]),
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

function designRef(mapId, kind, id) {
  return parseAtlasDesignRef({ schema: ATLAS_DESIGN_REF_SCHEMA, mapId, kind, id: String(id) });
}

function featureIndexPosition(coordinateFrame, feature) {
  if (feature.type === "glyph") return toPoint(coordinateFrame, [feature.x, feature.z]);
  if (!Array.isArray(feature.points) || feature.points.length === 0) return undefined;
  const bounds = bboxOf([toPoints(coordinateFrame, feature.points)]);
  return [(bounds.minX + bounds.maxX) / 2, (bounds.minZ + bounds.maxZ) / 2];
}

function sortedDesignIndex(entries) {
  return entries.sort((left, right) => {
    const a = atlasDesignRefKey(left.designRef), b = atlasDesignRefKey(right.designRef);
    return a < b ? -1 : a > b ? 1 : 0;
  });
}

function addDesignIndexEntry(entries, entry) {
  if (entries.length >= MAX_DESIGN_INDEX_ENTRIES) {
    throw new Error(`compile-designmap: navigable designIndex exceeds ${MAX_DESIGN_INDEX_ENTRIES} entries`);
  }
  entries.push(entry);
}

function assignedToMap(subject, mapId, primaryMapId) {
  return subject.map ? subject.map === mapId : mapId === primaryMapId;
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
function compileMap({ mapsJsonText, worldBibleText, mapId, placesText, atlasSourceHash, atlasMode = false }) {
  const warnings = [];
  const mapsDoc = JSON.parse(mapsJsonText);
  const targetId = mapId || mapsDoc.activeMapId;
  const map = mapsDoc.maps.find((m) => m.id === targetId);
  if (!map) throw new Error(`compile-designmap: map id "${targetId}" not found in maps.json (have: ${mapsDoc.maps.map((m) => m.id).join(", ")})`);

  const coordinateFrame = parseMapCoordinateFrame(map.units || DEFAULT_UNITS);

  // A painted elevation raster (Map Studio S1, map.rasters.elevation in the MapDoc) compiles to
  // the IR's reliefGrid. PRECEDENCE CONTRACT: when present, vector relief hints are NOT emitted
  // at all (painted is authoritative; the rasterizer would ignore them anyway — this keeps the
  // compiled IR honest about which authority produced the surface).
  const elevation = map.rasters && map.rasters.elevation ? map.rasters.elevation : undefined;
  let elevationGrid, elevationSampler;
  if (elevation) {
    for (const k of ["w", "h", "minY", "maxY", "data", "rect"]) {
      if (elevation[k] === undefined) throw new Error(`compile-designmap: rasters.elevation is missing '${k}'`);
    }
    // Construct without numeric/string coercion: accepting "256", Infinity, a reversed range,
    // or a malformed/oversized base64 payload here would defer corruption until runtime.
    elevationGrid = {
      w: elevation.w,
      h: elevation.h,
      rect: toRect(coordinateFrame, elevation.rect),
      minY: elevation.minY,
      maxY: elevation.maxY,
      ...(elevation.encoding !== undefined ? { encoding: elevation.encoding } : {}),
      data: elevation.data,
    };
    // The runtime sampler is the single payload validator and endian decoder. Validate eagerly
    // even when there is no landmass raster (previously malformed elevation could compile).
    elevationSampler = reliefGridSampler({ reliefGrid: elevationGrid, origin: [0, 0], unitsPerMeter: 1 });
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

  const fm = atlasMode ? undefined : frontmatterBlock(worldBibleText);
  const sizeM = atlasMode ? atlasMapSizeM(map, coordinateFrame) : readZoneSizeM(fm);
  const primaryMapId = mapsDoc.maps[0]?.id;
  const locations = (atlasMode ? (map.markers ?? []) : readLocations(fm)).filter((location) => (
    assignedToMap(location, map.id, primaryMapId)
  ));
  const places = atlasMode
    ? (map.places ?? []).filter((place) => assignedToMap(place, map.id, primaryMapId))
    : readPlaces(placesText).filter((place) => assignedToMap(place, map.id, primaryMapId));

  const land = [];
  const relief = [];
  const biomes = [];
  const waterways = [];
  const routes = [];
  const designIndex = [];
  for (const feature of map.features) {
    if (feature.type !== "glyph") continue;
    const position = featureIndexPosition(coordinateFrame, feature);
    if (position !== undefined) addDesignIndexEntry(designIndex, { designRef: designRef(map.id, "feature", feature.id), position });
  }
  // MapDoc stores per-basin water directly on the map, not as overloaded generic area features.
  // Presence is preserved exactly: absent stays absent; an authored empty array stays present.
  const waterBodies = map.waterBodies === undefined ? undefined : normalizeWaterBodies(
    coordinateFrame,
    compileWater(map.waterBodies, parseAuthoredWaterBodies),
  );
  const hydrology = map.hydrology === undefined ? undefined : compileHydrology(map.hydrology);
  let waterwayPointCount = 0;

  if (landmass) {
    const lw = Number(landmass.w), lh = Number(landmass.h);
    const cells = decodeRasterCells(landmass, lw * lh);
    const rect = toRect(coordinateFrame, landmass.rect);
    // ELEVATION CARVES WATER: painted elevation below sea level removes land from the mask —
    // digging at the coast extends the sea (the Atlas display applies the identical rule, so
    // the coast the user sees is the coast that builds). Enclosed sub-sea pits become polygon
    // holes and are dropped from the land VECTORS — but they still render as LAKES: the
    // rasterizer keeps decisively-sub-sea painted cells below the water plane (map-raster's
    // paintedSubSea exemption), matching the hillshade's submerged tint. Only points INSIDE
    // the elevation extent can carve (the sampler clamps to
    // its edge — without the bounds check, an edge dig would smear water outward forever).
    if (elevation) {
      const sampler = elevationSampler;
      const seaY = typeof map.seaLevel === "number" ? map.seaLevel : 0;
      const er = elevationGrid.rect;
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
    const rect = toRect(coordinateFrame, biomesRaster.rect);
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

  for (let featureIndex = 0; featureIndex < map.features.length; featureIndex++) {
    const f = map.features[featureIndex];
    if (f.type === "area" && f.kind === "outline") {
      if (landmass) { warnings.push(`ignored outline feature "${f.id}" (a painted landmass mask is authoritative)`); continue; }
      land.push({ points: toPoints(coordinateFrame, f.points) });
    } else if (f.type === "area" && f.kind === "biome") {
      if (biomesRaster) { warnings.push(`ignored biome feature "${f.id}" (a painted biome raster is authoritative)`); continue; }
      const points = toPoints(coordinateFrame, f.points);
      biomes.push({ biome: f.biome, points });
      if (f.biome === "mountain" && !elevation) {
        relief.push({ kind: "mountain", shape: { polygon: points }, amplitude: MOUNTAIN_BIOME_AMPLITUDE });
      }
    } else if (f.type === "line" && f.kind === "river") {
      if (waterways.length >= WATER_LIMITS.waterways) waterError(`waterways exceeds ${WATER_LIMITS.waterways} entries`);
      const parsedWaterway = compileWater(f, (feature) => parseAuthoredWaterway(feature, riverWidthM(sizeM), `features[${featureIndex}]`));
      const waterway = { ...parsedWaterway, points: toPoints(coordinateFrame, parsedWaterway.points) };
      waterwayPointCount += waterway.points.length;
      if (waterwayPointCount > WATER_LIMITS.totalWaterwayPoints) waterError(`waterway geometry exceeds ${WATER_LIMITS.totalWaterwayPoints} points`);
      waterways.push(waterway);
    } else if (f.type === "line" && f.kind === "road") {
      routes.push({ points: toPoints(coordinateFrame, f.points), class: "road" });
    } else if (f.type === "line" && f.kind === "border") {
      warnings.push(`skipped border feature "${f.id}" (political borders are out of scope for v1)`);
    } else if (f.type === "glyph" && (f.glyph === "mountain" || f.glyph === "peak" || f.glyph === "hills")) {
      if (!elevation) relief.push({ kind: f.glyph, shape: { point: toPoint(coordinateFrame, [f.x, f.z]) }, amplitude: GLYPH_AMPLITUDE[f.glyph] });
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
    const wM = bbox.w;
    const hM = bbox.h;
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
    ...(waterBodies ?? []).flatMap((body) => [body.footprint.points, ...(body.footprint.holes ?? [])]),
    ...routes.map((r) => r.points),
  ];
  const bbox = bboxOf(allPointArrays.length > 0 ? allPointArrays : [[[0, 0]]]);
  const extent = { w: Math.max(bbox.w, 1), h: Math.max(bbox.h, 1) };

  const anchors = locations.map((l) => ({
    id: l.id,
    kind: l.kind,
    position: toPoint(coordinateFrame, l.position),
    ...(l.count !== undefined ? { count: l.count } : {}),
    ...(l.name !== undefined ? { name: l.name } : {}),
    ...(l.assetId !== undefined ? { assetId: l.assetId } : {}),
    designRef: designRef(map.id, "marker", l.id),
    source: atlasMode ? "map" : "world-bible",
  }));
  for (const location of locations) {
    addDesignIndexEntry(designIndex, {
      designRef: designRef(map.id, "marker", location.id),
      position: toPoint(coordinateFrame, location.position),
      ...(location.radiusM === undefined ? {} : { radiusM: location.radiusM }),
    });
  }

  // Map Painter P3 stamps: each placed stamp compiles 1:1 into an "asset" anchor that names its
  // exact catalog asset — the build sites it through the same steering path as planned buildings
  // (never raw asset.place around the planner). A dangling assetId still compiles (with a
  // warning downstream at render/build time) — stamps must never vanish silently.
  for (const s of Array.isArray(map.stamps) ? map.stamps : []) {
    if (!s || typeof s !== "object" || !s.id || !s.assetId) {
      warnings.push(`skipped malformed stamp ${JSON.stringify(s && s.id ? s.id : s)}`);
      continue;
    }
    const ref = designRef(map.id, "stamp", s.id);
    const position = toPoint(coordinateFrame, [s.x, s.z]);
    anchors.push({
      id: String(s.id),
      kind: "asset",
      position,
      assetId: String(s.assetId),
      ...(typeof s.rot === "number" && s.rot !== 0 ? { rot: Number(s.rot) } : {}),
      ...(typeof s.scale === "number" && s.scale !== 1 ? { scale: Number(s.scale) } : {}),
      designRef: ref,
      source: "map",
    });
    addDesignIndexEntry(designIndex, { designRef: ref, position });
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
  for (const p of places) {
    if (!p.position) continue;
    const position = toPoint(coordinateFrame, p.position);
    const ref = designRef(map.id, "place", p.id);
    const entry = { placeId: p.id, name: p.name, kind: p.kind, parentId: p.parentId ?? null, position, designRef: ref };
    if (p.binding === "area" && typeof p.radiusM === "number") entry.radiusM = p.radiusM;
    gazetteer.push(entry);
    addDesignIndexEntry(designIndex, { designRef: ref, position, ...(entry.radiusM === undefined ? {} : { radiusM: entry.radiusM }) });
    if (p.assetId) {
      if (anchorIds.has(p.id)) {
        warnings.push(`place "${p.id}" shares an id with an existing anchor — its marker-asset anchor was skipped`);
      } else {
        anchors.push({ id: p.id, kind: "asset", position, assetId: p.assetId, designRef: ref, source: "places" });
        anchorIds.add(p.id);
      }
    }
  }

  const sourceHash = atlasMode
    ? atlasSourceHash
    : sha256(mapsJsonText + "\u0000" + worldBibleText + (typeof placesText === "string" ? "\u0000" + placesText : ""));

  const worldMap = {
    version: 1,
    id: map.id,
    unitsPerMeter: 1,
    origin: [0, 0],
    extent,
    seaLevel: typeof map.seaLevel === "number" ? map.seaLevel : 0.0,
    land,
    relief,
    ...(elevation ? {
      reliefGrid: elevationGrid,
    } : {}),
    biomes,
    waterways,
    ...(waterBodies !== undefined ? { waterBodies } : {}),
    ...(hydrology !== undefined ? { hydrology } : {}),
    routes,
    anchors,
    // Emitted only when the vault has placed places, so pre-Places maps keep their bytes/hash.
    ...(gazetteer.length > 0 ? { gazetteer } : {}),
    ...(designIndex.length > 0 ? { designIndex: sortedDesignIndex(designIndex) } : {}),
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

export function compileDesignMap({ mapsJsonText, worldBibleText, mapId, placesText }) {
  return compileMap({ mapsJsonText, worldBibleText, mapId, placesText });
}

/** Compile the exact canonical MapDoc committed by Atlas. No mutable vault mirror or unrelated
 * design document participates in this source identity. Legacy compileDesignMap remains the
 * compatibility path for world-bible/places aggregation. */
export function compileAtlasMapDoc(input) {
  if (input === null || typeof input !== "object" || Array.isArray(input) || Object.getPrototypeOf(input) !== Object.prototype
    || Object.getOwnPropertySymbols(input).length !== 0 || Object.getOwnPropertyNames(input).length !== 1
    || !Object.hasOwn(input, "mapsJsonText")) atlasError("input must contain exactly mapsJsonText");
  const descriptor = Object.getOwnPropertyDescriptor(input, "mapsJsonText");
  if (!descriptor?.enumerable || descriptor.get !== undefined || descriptor.set !== undefined || typeof descriptor.value !== "string") {
    atlasError("mapsJsonText must be an enumerable string data field");
  }
  let mapsDoc;
  try { mapsDoc = JSON.parse(descriptor.value); }
  catch (error) { atlasError(`source is invalid JSON: ${error instanceof Error ? error.message : String(error)}`); }
  let canonical;
  try { canonical = canonicalMapDocText(mapsDoc); }
  catch (error) { atlasError(error instanceof Error ? error.message : "source cannot be canonicalized"); }
  if (descriptor.value !== canonical) atlasError("source bytes are not canonical Atlas MapDoc bytes");
  const activeMap = validateAtlasMapDoc(mapsDoc);
  return compileMap({
    mapsJsonText: descriptor.value,
    mapId: activeMap.id,
    atlasSourceHash: sha256(descriptor.value),
    atlasMode: true,
  });
}
