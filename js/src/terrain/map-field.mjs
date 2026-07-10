import { MapRasterCancelledError, rasterizeWorldMap } from "../world/pipeline/map-raster.mjs";
import { NO_EROSION_RECIPE, validateErosionRecipe } from "../world/pipeline/erosion.mjs";
import {
  createTerrainGridSpec,
  terrainChunkBounds,
  terrainChunkTopology,
  terrainFieldTopologyHash,
  terrainGridIdForLogicalMap,
  validateTerrainSeed,
} from "./grid.mjs";

export const MAP_FIELD_CHUNK_SIZE_M = 48;
export const MAP_FIELD_CHUNK_SAMPLES = 33;
export const MAP_FIELD_MASTER_STEP_M = MAP_FIELD_CHUNK_SIZE_M / (MAP_FIELD_CHUNK_SAMPLES - 1);
export const MAP_FIELD_MARGIN_M = MAP_FIELD_CHUNK_SIZE_M;
export const MAX_MAP_FIELD_MASTER_RES = 1025;
export const MAX_MAP_FIELD_GEOMETRY_POINTS = 262_144;
export const MAX_MAP_FIELD_ESTIMATED_WORK_UNITS = 500_000_000;
export const MAP_FIELD_DEEP_SEA_DROP_M = 6;
export const MAP_FIELD_OUTSIDE_PAINT_MATERIAL = 1;
export const MAP_FIELD_OUTSIDE_PAINT_WEIGHT = 0.55;
export const MAP_FIELD_CLIMATE_CHANNELS = 3;

const BIOME_KIND_CLIMATE = Object.freeze({
  grass: Object.freeze([14, 500, 2]),
  forest: Object.freeze([12, 900, 4]),
  mountain: Object.freeze([4, 450, 2]),
  desert: Object.freeze([28, 120, 1]),
  tundra: Object.freeze([-6, 250, 0]),
  swamp: Object.freeze([16, 1800, 6]),
});
const OPEN_CLIMATE = Object.freeze([14, 800, 4]);

export class MapFieldCancelledError extends Error {
  constructor() {
    super("map field build cancelled");
    this.name = "MapFieldCancelledError";
    this.code = "map_field_cancelled";
  }
}

function checkpoint(shouldCancel, work) {
  if ((work & 1023) === 0 && shouldCancel?.()) throw new MapFieldCancelledError();
}

function preparePointInRing(ring) {
  let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
  for (const point of ring) {
    if (point[0] < minX) minX = point[0];
    if (point[0] > maxX) maxX = point[0];
    if (point[1] < minZ) minZ = point[1];
    if (point[1] > maxZ) maxZ = point[1];
  }
  const binCount = 256, span = maxZ - minZ;
  const binOf = (z) => span > 0 ? Math.max(0, Math.min(binCount - 1, Math.floor(((z - minZ) / span) * binCount))) : 0;
  const bins = Array.from({ length: binCount }, () => []);
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const first = binOf(Math.min(ring[i][1], ring[j][1])), last = binOf(Math.max(ring[i][1], ring[j][1]));
    for (let bin = first; bin <= last; bin++) bins[bin].push([j, i]);
  }
  return { ring, minX, minZ, maxX, maxZ, bins, binOf };
}

function pointInPreparedRing(x, z, prepared) {
  if (x < prepared.minX || x > prepared.maxX || z < prepared.minZ || z > prepared.maxZ) return false;
  let inside = false;
  for (const [j, i] of prepared.bins[prepared.binOf(z)]) {
    const xi = prepared.ring[i][0], zi = prepared.ring[i][1], xj = prepared.ring[j][0], zj = prepared.ring[j][1];
    const denom = (zj - zi) || 1e-12;
    if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / denom + xi) inside = !inside;
  }
  return inside;
}

function clamp01(value) { return value < 0 ? 0 : value > 1 ? 1 : value; }

export function worldMapFeatureBounds(map) {
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  const take = (point) => {
    const x = map.origin[0] + point[0] * map.unitsPerMeter;
    const z = map.origin[1] + point[1] * map.unitsPerMeter;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (z < minZ) minZ = z;
    if (z > maxZ) maxZ = z;
  };
  for (const polygon of map.land) {
    for (const point of polygon.points) take(point);
    for (const hole of polygon.holes ?? []) for (const point of hole) take(point);
  }
  for (const relief of map.relief) {
    for (const point of relief.shape.polygon ?? []) take(point);
    if (relief.shape.point !== undefined) take(relief.shape.point);
  }
  for (const biome of map.biomes) for (const point of biome.points) take(point);
  for (const waterway of map.waterways) for (const point of waterway.points) take(point);
  for (const route of map.routes) for (const point of route.points) take(point);
  for (const anchor of map.anchors) take(anchor.position);
  for (const body of map.waterBodies ?? []) {
    for (const point of body.footprint.points) take(point);
    for (const hole of body.footprint.holes ?? []) for (const point of hole) take(point);
  }
  if (map.reliefGrid !== undefined) {
    const rect = map.reliefGrid.rect;
    take([rect.x0, rect.z0]);
    take([rect.x0 + rect.w, rect.z0 + rect.h]);
  }
  if (!Number.isFinite(minX)) {
    return Object.freeze({
      minX: map.origin[0] - map.extent.w / 2,
      maxX: map.origin[0] + map.extent.w / 2,
      minZ: map.origin[1] - map.extent.h / 2,
      maxZ: map.origin[1] + map.extent.h / 2,
    });
  }
  return Object.freeze({ minX, maxX, minZ, maxZ });
}

export function inspectMapFieldGeometry(map, masterRes) {
  let points = 0;
  let landSegments = 0, reliefSegments = 0, biomeSegments = 0, waterwaySegments = 0;
  let ringBinBindings = 0, landRingCount = 0, reliefCount = 0, biomeRingCount = 0;
  const addRing = (ring, category) => {
    points += ring.length;
    if (points > MAX_MAP_FIELD_GEOMETRY_POINTS) throw new Error(`map field geometry exceeds ${MAX_MAP_FIELD_GEOMETRY_POINTS} points`);
    let minZ = Infinity, maxZ = -Infinity;
    for (const point of ring) { if (point[1] < minZ) minZ = point[1]; if (point[1] > maxZ) maxZ = point[1]; }
    const span = maxZ - minZ;
    const binOf = (z) => span > 0 ? Math.max(0, Math.min(255, Math.floor(((z - minZ) / span) * 256))) : 0;
    for (let index = 0, prior = ring.length - 1; index < ring.length; prior = index++) ringBinBindings += binOf(Math.max(ring[index][1], ring[prior][1])) - binOf(Math.min(ring[index][1], ring[prior][1])) + 1;
    if (category === "land") { landSegments += ring.length; landRingCount++; }
    else if (category === "relief") { reliefSegments += ring.length; reliefCount++; }
    else if (category === "biome") { biomeSegments += ring.length; biomeRingCount++; }
  };
  for (const polygon of map.land) {
    addRing(polygon.points, "land");
    for (const hole of polygon.holes ?? []) addRing(hole, "land");
  }
  for (const relief of map.relief) {
    if (relief.shape.polygon !== undefined) addRing(relief.shape.polygon, "relief");
    else {
      reliefCount++;
      points++;
      if (points > MAX_MAP_FIELD_GEOMETRY_POINTS) throw new Error(`map field geometry exceeds ${MAX_MAP_FIELD_GEOMETRY_POINTS} points`);
    }
  }
  for (const biome of map.biomes) addRing(biome.points, "biome");
  for (const waterway of map.waterways) {
    points += waterway.points.length;
    waterwaySegments += Math.max(0, waterway.points.length - 1);
    if (points > MAX_MAP_FIELD_GEOMETRY_POINTS) throw new Error(`map field geometry exceeds ${MAX_MAP_FIELD_GEOMETRY_POINTS} points`);
  }
  for (const route of map.routes) {
    points += route.points.length;
    if (points > MAX_MAP_FIELD_GEOMETRY_POINTS) throw new Error(`map field geometry exceeds ${MAX_MAP_FIELD_GEOMETRY_POINTS} points`);
  }
  points += map.anchors.length;
  for (const body of map.waterBodies ?? []) {
    points += body.footprint.points.length;
    for (const hole of body.footprint.holes ?? []) points += hole.length;
    if (points > MAX_MAP_FIELD_GEOMETRY_POINTS) throw new Error(`map field geometry exceeds ${MAX_MAP_FIELD_GEOMETRY_POINTS} points`);
  }
  const masterCells = masterRes * masterRes;
  // Indexed cost model: feature AABB probes, average scanline-bin candidates for exact PIP,
  // and logarithmic segment-BVH descent for nearest-boundary queries.
  const averageRingCandidates = Math.ceil(ringBinBindings / 256);
  const bvhDepthCost = Math.ceil(Math.log2(Math.max(2, landSegments + reliefSegments + biomeSegments + waterwaySegments))) * 8;
  const vectorWorkPerCell = 32 + landRingCount + reliefCount * 2 + biomeRingCount * 3 + map.waterways.length * 2 + averageRingCandidates + bvhDepthCost;
  const estimatedWorkUnits = masterCells * vectorWorkPerCell + points * Math.ceil(Math.log2(Math.max(2, points)));
  if (!Number.isSafeInteger(estimatedWorkUnits) || estimatedWorkUnits > MAX_MAP_FIELD_ESTIMATED_WORK_UNITS) {
    throw new Error(`map field estimated work ${estimatedWorkUnits} exceeds ${MAX_MAP_FIELD_ESTIMATED_WORK_UNITS}`);
  }
  return Object.freeze({ points, landSegments, reliefSegments, biomeSegments, waterwaySegments, landRingCount, reliefCount, biomeRingCount, ringBinBindings, masterCells, estimatedWorkUnits });
}

function gridCoordinates(field, x, z) {
  const fx = (x + field.half) / field.masterStep;
  const fz = (z + field.half) / field.masterStep;
  const max = field.masterRes - 1;
  return fx < 0 || fz < 0 || fx > max || fz > max ? undefined : { fx, fz };
}

export function sampleMapFieldHeight(field, x, z) {
  const point = gridCoordinates(field, x, z);
  if (point === undefined) return field.outsideHeightM;
  const n = field.masterRes;
  const c0 = Math.min(Math.floor(point.fx), n - 1), c1 = Math.min(c0 + 1, n - 1);
  const r0 = Math.min(Math.floor(point.fz), n - 1), r1 = Math.min(r0 + 1, n - 1);
  const dc = point.fx - c0, dr = point.fz - r0;
  const top = field.heightsM[r0 * n + c0] + (field.heightsM[r0 * n + c1] - field.heightsM[r0 * n + c0]) * dc;
  const bottom = field.heightsM[r1 * n + c0] + (field.heightsM[r1 * n + c1] - field.heightsM[r1 * n + c0]) * dc;
  return top + (bottom - top) * dr;
}

export function nearestMapFieldCell(field, x, z) {
  const point = gridCoordinates(field, x, z);
  if (point === undefined) return undefined;
  const col = Math.max(0, Math.min(field.masterRes - 1, Math.round(point.fx)));
  const row = Math.max(0, Math.min(field.masterRes - 1, Math.round(point.fz)));
  return row * field.masterRes + col;
}

export function mapFieldClimateAt(field, x, z) {
  const cell = nearestMapFieldCell(field, x, z);
  if (cell === undefined || field.biomeCell[cell] === 0) return OPEN_CLIMATE;
  return BIOME_KIND_CLIMATE[field.biomeKinds[field.biomeCell[cell] - 1]] ?? OPEN_CLIMATE;
}

export function sliceMapFieldChunk(field, tx, tz, options = {}) {
  const shouldCancel = options.shouldCancel;
  const topology = terrainChunkTopology(field.grid, { lod: 0, tx, tz, samples: MAP_FIELD_CHUNK_SAMPLES });
  const cells = MAP_FIELD_CHUNK_SAMPLES * MAP_FIELD_CHUNK_SAMPLES;
  const heightsM = new Float32Array(cells);
  const paintMat = new Uint8Array(cells);
  const paintW = new Float32Array(cells);
  const climate = new Float32Array(cells * MAP_FIELD_CLIMATE_CHANNELS);
  const blight = new Float32Array(cells);
  let work = 0;
  for (let row = 0; row < MAP_FIELD_CHUNK_SAMPLES; row++) {
    const z = topology.bounds.minZ + (row / (MAP_FIELD_CHUNK_SAMPLES - 1)) * MAP_FIELD_CHUNK_SIZE_M;
    for (let col = 0; col < MAP_FIELD_CHUNK_SAMPLES; col++) {
      checkpoint(shouldCancel, work++);
      const x = topology.bounds.minX + (col / (MAP_FIELD_CHUNK_SAMPLES - 1)) * MAP_FIELD_CHUNK_SIZE_M;
      const index = row * MAP_FIELD_CHUNK_SAMPLES + col;
      heightsM[index] = sampleMapFieldHeight(field, x, z);
      const masterCell = nearestMapFieldCell(field, x, z);
      if (masterCell === undefined) {
        paintMat[index] = MAP_FIELD_OUTSIDE_PAINT_MATERIAL;
        paintW[index] = MAP_FIELD_OUTSIDE_PAINT_WEIGHT;
      } else {
        paintMat[index] = field.paintMat[masterCell];
        paintW[index] = field.paintW[masterCell];
      }
      const climateSample = masterCell === undefined || field.biomeCell[masterCell] === 0
        ? OPEN_CLIMATE
        : BIOME_KIND_CLIMATE[field.biomeKinds[field.biomeCell[masterCell] - 1]] ?? OPEN_CLIMATE;
      climate[index * 3] = climateSample[0];
      climate[index * 3 + 1] = climateSample[1];
      climate[index * 3 + 2] = climateSample[2];
      if (masterCell !== undefined) {
        const biomeIndex = field.biomeCell[masterCell];
        if (biomeIndex > 0 && field.biomeKinds[biomeIndex - 1] === "blight") blight[index] = 1;
      }
    }
  }
  if (shouldCancel?.()) throw new MapFieldCancelledError();
  return Object.freeze({ topology, heightsM, paintMat, paintW, climate, blight });
}

export function normalizedMapFieldTile(field, tx, tz, verticalRange, options = {}) {
  const chunk = sliceMapFieldChunk(field, tx, tz, options);
  const minM = verticalRange?.minM;
  const maxM = verticalRange?.maxM;
  if (!Number.isFinite(minM) || !Number.isFinite(maxM) || !(maxM > minM)) throw new Error("map field vertical range must have finite minM < maxM");
  const heights = new Float32Array(chunk.heightsM.length);
  const span = maxM - minM;
  for (let index = 0; index < heights.length; index++) {
    checkpoint(options.shouldCancel, index);
    const value = chunk.heightsM[index];
    if (value < minM || value > maxM) throw new Error(`map field height ${value}m is outside configured vertical range [${minM}, ${maxM}]`);
    heights[index] = clamp01((value - minM) / span);
  }
  return Object.freeze({
    topology: chunk.topology,
    tile: Object.freeze({
      nrows: MAP_FIELD_CHUNK_SAMPLES,
      ncols: MAP_FIELD_CHUNK_SAMPLES,
      origin: [chunk.topology.bounds.minX + MAP_FIELD_CHUNK_SIZE_M / 2, minM, chunk.topology.bounds.minZ + MAP_FIELD_CHUNK_SIZE_M / 2],
      scale: [MAP_FIELD_CHUNK_SIZE_M, span, MAP_FIELD_CHUNK_SIZE_M],
      heights,
      paintMat: chunk.paintMat,
      paintW: chunk.paintW,
      climate: chunk.climate,
      climateChannels: MAP_FIELD_CLIMATE_CHANNELS,
      blight: chunk.blight,
    }),
    heightsM: chunk.heightsM,
  });
}

export function createMapTerrainField(options) {
  const map = options?.worldMap;
  if (map === null || typeof map !== "object") throw new Error("map field requires a WorldMap");
  const seed = validateTerrainSeed(options.seed ?? 1);
  const baseAmplitude = options.baseAmplitude ?? 12;
  if (!Number.isFinite(baseAmplitude) || !(baseAmplitude > 0)) throw new Error("map terrain baseAmplitude must be a positive finite number");
  const erosionRecipe = validateErosionRecipe(options.erosionRecipe ?? NO_EROSION_RECIPE);
  if (options.shouldCancel !== undefined && typeof options.shouldCancel !== "function") throw new Error("map field shouldCancel must be a function");
  if (options.shouldCancel?.()) throw new MapFieldCancelledError();
  const grid = createTerrainGridSpec({
    gridId: options.gridId ?? terrainGridIdForLogicalMap(map.id),
    origin: [0, 0],
    chunkSizeM: MAP_FIELD_CHUNK_SIZE_M,
    defaultSamples: MAP_FIELD_CHUNK_SAMPLES,
  });
  const featureBounds = worldMapFeatureBounds(map);
  const coverRadius = Math.max(Math.abs(featureBounds.minX), Math.abs(featureBounds.maxX), Math.abs(featureBounds.minZ), Math.abs(featureBounds.maxZ)) + MAP_FIELD_MARGIN_M;
  let half = Math.ceil(coverRadius / MAP_FIELD_MASTER_STEP_M) * MAP_FIELD_MASTER_STEP_M;
  if (!(half > 0)) half = MAP_FIELD_MASTER_STEP_M;
  const size = half * 2;
  let masterRes = Math.round(size / MAP_FIELD_MASTER_STEP_M) + 1;
  if (masterRes > MAX_MAP_FIELD_MASTER_RES) masterRes = MAX_MAP_FIELD_MASTER_RES;
  const geometry = inspectMapFieldGeometry(map, masterRes);
  const masterStep = size / (masterRes - 1);
  const bounds = Object.freeze({ minX: -half, minZ: -half, maxX: half, maxZ: half });
  const masterTopologyHash = terrainFieldTopologyHash({ gridId: grid.gridId, bounds, rows: masterRes, cols: masterRes });
  let raster;
  try {
    raster = rasterizeWorldMap(map, {
      size,
      resolution: masterRes,
      seed,
      baseAmplitude,
      erosion: erosionRecipe,
      shouldCancel: options.shouldCancel,
    });
  } catch (error) {
    if (error instanceof MapRasterCancelledError || (error instanceof Error && error.name === "ErosionCancelledError")) throw new MapFieldCancelledError();
    throw error;
  }
  const biomeKinds = Object.freeze(map.biomes.map((biome) => biome.biome));
  const biomeCell = new Uint8Array(masterRes * masterRes);
  const rings = map.biomes.map((biome) => preparePointInRing(biome.points.map((point) => [
    map.origin[0] + point[0] * map.unitsPerMeter,
    map.origin[1] + point[1] * map.unitsPerMeter,
  ])));
  let work = 0;
  for (let row = 0; row < masterRes; row++) {
    const z = -half + row * masterStep;
    for (let col = 0; col < masterRes; col++) {
      checkpoint(options.shouldCancel, work++);
      const x = -half + col * masterStep;
      let biomeIndex = 0;
      for (let index = 0; index < rings.length; index++) if (pointInPreparedRing(x, z, rings[index])) biomeIndex = index + 1;
      biomeCell[row * masterRes + col] = biomeIndex;
    }
  }
  const outsideHeightM = map.seaLevel - MAP_FIELD_DEEP_SEA_DROP_M;
  let minimum = outsideHeightM, maximum = map.seaLevel + 1;
  for (let index = 0; index < raster.heights.length; index++) {
    checkpoint(options.shouldCancel, work++);
    if (raster.heights[index] < minimum) minimum = raster.heights[index];
    if (raster.heights[index] > maximum) maximum = raster.heights[index];
  }
  if (options.shouldCancel?.()) throw new MapFieldCancelledError();
  return Object.freeze({
    grid,
    featureBounds,
    geometry,
    bounds,
    half,
    masterRes,
    masterStep,
    masterTopologyHash,
    seed,
    baseAmplitude,
    erosionRecipe,
    seaLevelM: map.seaLevel,
    outsideHeightM,
    minimumHeightM: minimum,
    maximumHeightM: maximum,
    heightsM: raster.heights,
    paintMat: raster.paintMat,
    paintW: raster.paintW,
    biomeCell,
    biomeKinds,
  });
}
