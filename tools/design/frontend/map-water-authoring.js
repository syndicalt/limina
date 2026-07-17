// Atlas WB-W1 authoring model. This imports the exact engine validators so UI, MapDoc compile,
// and WorldMap verification cannot drift. Pure/DOM-free: browser UI and Node gates share it.

import {
  WATER_BODY_KINDS,
  WATER_LIMITS,
  parseAuthoredWaterBodies,
} from "../../../js/src/world/water-ir.mjs";
import {
  HYDROLOGY_LIMITS,
  HYDROLOGY_RECIPE_SCHEMA,
  parseAuthoredHydrologyRecipe,
} from "../../../js/src/world/hydrology-ir.mjs";

export { WATER_BODY_KINDS, WATER_LIMITS, HYDROLOGY_LIMITS, HYDROLOGY_RECIPE_SCHEMA };

const clone = (value) => value === undefined ? undefined : JSON.parse(JSON.stringify(value));

export function parseJsonField(text, label) {
  if (typeof text !== "string" || text.length > 1_000_000) throw new Error(`${label} exceeds the bounded editor input`);
  try { return JSON.parse(text); }
  catch (error) { throw new Error(`${label} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`); }
}

export function createWaterBody(input) {
  const body = {
    id: input.id,
    kind: input.kind,
    level: input.level,
    footprint: { points: input.points, ...(Array.isArray(input.holes) && input.holes.length === 0 ? {} : { holes: input.holes }) },
    depthZones: input.depthZones,
  };
  return parseAuthoredWaterBodies([body])[0];
}

export function addWaterBody(current, body) {
  const source = current === undefined ? [] : clone(current);
  source.push(clone(body));
  return parseAuthoredWaterBodies(source);
}

export function updateWaterBody(current, id, patch) {
  const source = clone(current ?? []);
  const index = source.findIndex((body) => body.id === id);
  if (index < 0) throw new Error(`water body '${id}' no longer exists`);
  source[index] = { ...source[index], ...clone(patch) };
  return parseAuthoredWaterBodies(source);
}

export function deleteWaterBody(current, id) {
  const source = clone(current ?? []);
  const next = source.filter((body) => body.id !== id);
  if (next.length === source.length) throw new Error(`water body '${id}' no longer exists`);
  return next.length === 0 ? undefined : parseAuthoredWaterBodies(next);
}

export function parseHydrologyRecipe(input) {
  return parseAuthoredHydrologyRecipe({ schema: HYDROLOGY_RECIPE_SCHEMA, ...clone(input) });
}

export function waterBodyEditorPatch({ kind, level, pointsText, holesText, depthZonesText }) {
  const points = parseJsonField(pointsText, "basin polygon");
  const holes = parseJsonField(holesText, "basin holes");
  const depthZones = parseJsonField(depthZonesText, "basin depth zones");
  return { kind, level: Number(level), footprint: { points, ...(Array.isArray(holes) && holes.length === 0 ? {} : { holes }) }, depthZones };
}

export function importWorldMapWater(worldMap, toTarget) {
  if (typeof toTarget !== "function") throw new TypeError("water import requires a coordinate transform");
  const waterBodies = parseAuthoredWaterBodies((worldMap.waterBodies ?? []).map((body) => ({
    id: body.id,
    kind: body.kind,
    level: body.level,
    footprint: {
      points: body.footprint.points.map((point) => toTarget(point)),
      ...(body.footprint.holes?.length ? { holes: body.footprint.holes.map((ring) => ring.map((point) => toTarget(point))) } : {}),
    },
    depthZones: body.depthZones,
  })));
  const hydrology = worldMap.hydrology === undefined ? undefined : parseAuthoredHydrologyRecipe(worldMap.hydrology);
  return Object.freeze({ ...(waterBodies.length ? { waterBodies } : {}), ...(hydrology === undefined ? {} : { hydrology }) });
}
