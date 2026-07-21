import { BIOME_LIBRARY_V1 } from "../biome-library-v1.mjs";
import { BiomeFieldCancelledError, compileBiomeField } from "../biome-field.mjs";

export const WORLD_BIOME_FIELD_COMPILER_VERSION = 2;
export const WORLD_BIOME_FIELD_TOP_N = 4;
export const WORLD_BIOME_PRECIPITATION_CEILING_MM_PER_YEAR = 3000;
export const WORLD_BIOME_CLIMATE_FEATHER = Object.freeze({ temperatureC: 6, moisture01: 0.2 });
export const WORLD_BIOME_FIELD_MAX_WATER_RASTER_TESTS = 50_000_000;
export const WORLD_BIOME_LEGACY_CLIMATE = Object.freeze({
  open: Object.freeze({ temperatureC: 14, precipitationMmPerYear: 800 }),
  grass: Object.freeze({ temperatureC: 14, precipitationMmPerYear: 500 }),
  forest: Object.freeze({ temperatureC: 12, precipitationMmPerYear: 900 }),
  mountain: Object.freeze({ temperatureC: 4, precipitationMmPerYear: 450 }),
  desert: Object.freeze({ temperatureC: 28, precipitationMmPerYear: 120 }),
  tundra: Object.freeze({ temperatureC: -6, precipitationMmPerYear: 250 }),
  swamp: Object.freeze({ temperatureC: 16, precipitationMmPerYear: 1800 }),
});
export const WORLD_BIOME_AUTHORED_TARGETS = Object.freeze({
  open: "grassland",
  grass: "grassland",
  forest: "temperate-deciduous-forest",
  mountain: "alpine",
  desert: "desert",
  tundra: "tundra",
  swamp: "swamp",
  blight: "blighted-waste",
  water: "ocean",
});
export const WORLD_BIOME_FIELD_POLICY = Object.freeze({
  authority: "pre-edit-globally-eroded-terrain/v1",
  grid: "exact-map-terrain-master-grid/v1",
  moisture: "clamp-precipitation-mm-per-year-div-3000/v1",
  slope: "atan-rise-run-central-interior-one-sided-edge/v1",
  waterCoverage: "hydrology-ocean-generated-basin-and-reach-ribbon/v1",
  waterDistance: "exact-squared-euclidean-covered-cell-centres/v1",
  authoredInfluences: "authored-legacy-region-is-exclusive-semantic-baseline-before-environmental-modifiers/v2",
  authoredTargets: WORLD_BIOME_AUTHORED_TARGETS,
  waterSemantic: "hydrology-covered-cells-are-exclusive-deep-ocean-baseline-with-land-slope-suppressed/v2",
  legacyClimate: WORLD_BIOME_LEGACY_CLIMATE,
  modifiers: Object.freeze([
    Object.freeze({ id: "compiled-alpine-elevation", targetBiomeId: "alpine", strength: 1.5,
      rule: "elevation-min-sea-plus-300m-feather-100m/v2" }),
    Object.freeze({ id: "compiled-canyon-slope", targetBiomeId: "canyon", strength: 1.25,
      rule: "slope01-min-0.85-feather-0.1/v3" }),
    Object.freeze({ id: "compiled-deep-ocean-water", targetBiomeId: "deep-ocean", strength: 100,
      rule: "water-distance-equals-zero/v1" }),
    Object.freeze({ id: "compiled-riparian-water", targetBiomeId: "river", strength: 2,
      rule: "water-distance-one-to-two-cells-feather-four-cells/v1" }),
  ]),
});

export class WorldBiomeFieldCancelledError extends Error {
  constructor() {
    super("world biome field compilation was cancelled");
    this.name = "WorldBiomeFieldCancelledError";
    this.code = "world_biome_field_cancelled";
  }
}

function exactRecord(value, keys, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new TypeError(`${label} must be a plain object`);
  }
  if (Object.getOwnPropertySymbols(value).length !== 0) throw new TypeError(`${label} must not contain symbol fields`);
  const names = Object.getOwnPropertyNames(value).sort(), expected = [...keys].sort();
  if (names.length !== expected.length || names.some((name, index) => name !== expected[index])) {
    throw new TypeError(`${label} must contain exactly: ${expected.join(", ")}`);
  }
  for (const name of names) {
    const descriptor = Object.getOwnPropertyDescriptor(value, name);
    if (!descriptor || descriptor.get !== undefined || descriptor.set !== undefined || descriptor.enumerable !== true) {
      throw new TypeError(`${label}.${name} must be an enumerable data field`);
    }
  }
  return value;
}

function checkpoint(shouldCancel, work = 0) {
  if ((work & 1023) === 0 && shouldCancel()) throw new WorldBiomeFieldCancelledError();
}
function clamp01(value) { return value < 0 ? 0 : value > 1 ? 1 : value; }

// -1 outside, 0 on the boundary, 1 inside.
function classifyRing(x, z, ring) {
  let inside = false;
  for (let index = 0, prior = ring.length - 1; index < ring.length; prior = index++) {
    const a = ring[prior], b = ring[index];
    const cross = (b[0] - a[0]) * (z - a[1]) - (b[1] - a[1]) * (x - a[0]);
    if (cross === 0 && x >= Math.min(a[0], b[0]) && x <= Math.max(a[0], b[0])
        && z >= Math.min(a[1], b[1]) && z <= Math.max(a[1], b[1])) return 0;
    if ((a[1] > z) !== (b[1] > z) && x < (b[0] - a[0]) * (z - a[1]) / (b[1] - a[1]) + a[0]) inside = !inside;
  }
  return inside ? 1 : -1;
}

function rasterizeWater(mask, grid, hydrology, generatedWater, shouldCancel) {
  mask.set(hydrology.oceanMask);
  const { rows, cols, origin, cellSizeM } = grid;
  const boundsToGrid = (minX, minZ, maxX, maxZ) => ({
    minCol: Math.max(0, Math.ceil((minX - origin[0]) / cellSizeM)),
    maxCol: Math.min(cols - 1, Math.floor((maxX - origin[0]) / cellSizeM)),
    minRow: Math.max(0, Math.ceil((minZ - origin[1]) / cellSizeM)),
    maxRow: Math.min(rows - 1, Math.floor((maxZ - origin[1]) / cellSizeM)),
  });
  let tests = 0;
  const meter = () => {
    if (++tests > WORLD_BIOME_FIELD_MAX_WATER_RASTER_TESTS) throw new Error(`world biome water raster exceeds ${WORLD_BIOME_FIELD_MAX_WATER_RASTER_TESTS} bounded tests`);
    checkpoint(shouldCancel, tests);
  };

  for (const basin of generatedWater.basins) {
    let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
    for (const point of basin.footprint.points) {
      minX = Math.min(minX, point[0]); minZ = Math.min(minZ, point[1]);
      maxX = Math.max(maxX, point[0]); maxZ = Math.max(maxZ, point[1]);
    }
    const bounds = boundsToGrid(minX, minZ, maxX, maxZ);
    for (let row = bounds.minRow; row <= bounds.maxRow; row++) {
      const z = origin[1] + row * cellSizeM;
      for (let col = bounds.minCol; col <= bounds.maxCol; col++) {
        meter();
        const x = origin[0] + col * cellSizeM;
        if (classifyRing(x, z, basin.footprint.points) < 0) continue;
        if ((basin.footprint.holes ?? []).some((ring) => classifyRing(x, z, ring) >= 0)) continue;
        mask[row * cols + col] = 1;
      }
    }
  }

  for (const reach of generatedWater.reaches) {
    for (let segment = 0; segment + 1 < reach.points.length; segment++) {
      const a = reach.points[segment], b = reach.points[segment + 1];
      const radiusA = reach.widths[segment] / 2, radiusB = reach.widths[segment + 1] / 2;
      const maximumRadius = Math.max(radiusA, radiusB);
      const bounds = boundsToGrid(Math.min(a[0], b[0]) - maximumRadius, Math.min(a[1], b[1]) - maximumRadius,
        Math.max(a[0], b[0]) + maximumRadius, Math.max(a[1], b[1]) + maximumRadius);
      const dx = b[0] - a[0], dz = b[1] - a[1], lengthSquared = dx * dx + dz * dz;
      for (let row = bounds.minRow; row <= bounds.maxRow; row++) {
        const z = origin[1] + row * cellSizeM;
        for (let col = bounds.minCol; col <= bounds.maxCol; col++) {
          meter();
          const x = origin[0] + col * cellSizeM;
          const t = lengthSquared === 0 ? 0 : Math.max(0, Math.min(1, ((x - a[0]) * dx + (z - a[1]) * dz) / lengthSquared));
          const radius = radiusA + (radiusB - radiusA) * t;
          const ex = x - (a[0] + dx * t), ez = z - (a[1] + dz * t);
          if (ex * ex + ez * ez <= radius * radius) mask[row * cols + col] = 1;
        }
      }
    }
  }
  checkpoint(shouldCancel);
}

function transform1d(source, length, output, sites, boundaries) {
  let last = 0;
  sites[0] = 0; boundaries[0] = -Infinity; boundaries[1] = Infinity;
  for (let q = 1; q < length; q++) {
    let intersection;
    do {
      const site = sites[last];
      intersection = ((source[q] + q * q) - (source[site] + site * site)) / (2 * q - 2 * site);
      if (intersection <= boundaries[last]) last--;
    } while (intersection <= boundaries[last]);
    sites[++last] = q; boundaries[last] = intersection; boundaries[last + 1] = Infinity;
  }
  last = 0;
  for (let q = 0; q < length; q++) {
    while (boundaries[last + 1] < q) last++;
    const delta = q - sites[last];
    output[q] = delta * delta + source[sites[last]];
  }
}

function waterDistances(mask, rows, cols, cellSizeM, shouldCancel) {
  let sources = 0;
  for (let index = 0; index < mask.length; index++) sources += mask[index] === 0 ? 0 : 1;
  if (sources === 0) throw new Error("world biome water raster has no hydrology water source cells");
  const cells = rows * cols, maximumSquared = rows * rows + cols * cols + 1;
  const horizontal = new Float64Array(cells);
  const length = Math.max(rows, cols), source = new Float64Array(length), output = new Float64Array(length);
  const sites = new Int32Array(length), boundaries = new Float64Array(length + 1);
  let work = 0;
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) source[col] = mask[row * cols + col] === 0 ? maximumSquared : 0;
    transform1d(source, cols, output, sites, boundaries);
    for (let col = 0; col < cols; col++) { checkpoint(shouldCancel, work++); horizontal[row * cols + col] = output[col]; }
  }
  const result = new Float32Array(cells);
  for (let col = 0; col < cols; col++) {
    for (let row = 0; row < rows; row++) source[row] = horizontal[row * cols + col];
    transform1d(source, rows, output, sites, boundaries);
    for (let row = 0; row < rows; row++) {
      checkpoint(shouldCancel, work++);
      result[row * cols + col] = Math.sqrt(output[row]) * cellSizeM;
    }
  }
  return result;
}

function modifiers(seaLevelM, cellSizeM) {
  return [
    { id: "compiled-alpine-elevation", target: { biomeId: "alpine" }, strength: 1.5,
      elevationM: { min: seaLevelM + 300, max: 1_000_000, feather: 100 }, slope01: null, waterDistanceM: null },
    { id: "compiled-canyon-slope", target: { biomeId: "canyon" }, strength: 1.25,
      elevationM: null, slope01: { min: 0.85, max: 1, feather: 0.1 }, waterDistanceM: null },
    { id: "compiled-deep-ocean-water", target: { biomeId: "deep-ocean" }, strength: 100,
      elevationM: null, slope01: null, waterDistanceM: { min: 0, max: 0, feather: 0 } },
    { id: "compiled-riparian-water", target: { biomeId: "river" }, strength: 2,
      elevationM: null, slope01: null, waterDistanceM: { min: cellSizeM, max: cellSizeM * 2, feather: cellSizeM * 4 } },
  ];
}

export function compileWorldBiomeField(input) {
  const root = exactRecord(input,
    ["worldMap", "terrainField", "hydrologyTopology", "generatedWaterTopology", "shouldCancel"],
    "world biome field input");
  if (typeof root.shouldCancel !== "function") throw new TypeError("world biome field shouldCancel must be a function");
  const map = root.worldMap, field = root.terrainField, hydrology = root.hydrologyTopology, generatedWater = root.generatedWaterTopology;
  if (map === null || typeof map !== "object" || field === null || typeof field !== "object"
      || hydrology === null || typeof hydrology !== "object" || generatedWater === null || typeof generatedWater !== "object") {
    throw new TypeError("world biome field requires authored map, compiled terrain, and compiled hydrology objects");
  }
  const origin = [field.bounds.minX, field.bounds.minZ];
  if (field.masterRes !== hydrology.rows || field.masterRes !== hydrology.cols || field.masterStep !== hydrology.cellSizeM
      || generatedWater.rows !== hydrology.rows || generatedWater.cols !== hydrology.cols
      || generatedWater.cellSizeM !== hydrology.cellSizeM
      || generatedWater.placement.originX !== origin[0] || generatedWater.placement.originZ !== origin[1]) {
    throw new Error("world biome field terrain and generated hydrology must share the exact master grid");
  }
  if (map.seaLevel !== field.seaLevelM || map.biomes.length !== field.biomeKinds.length
      || map.biomes.some((biome, index) => biome.biome !== field.biomeKinds[index])) {
    throw new Error("world biome field terrain climate is not source-fenced to the authored WorldMap");
  }
  const rows = field.masterRes, cols = field.masterRes, cells = rows * cols, cellSizeM = field.masterStep;
  if (!Number.isSafeInteger(rows) || rows < 2) throw new Error("world biome field master grid must have at least 2 rows and columns");
  if (!Number.isFinite(cellSizeM) || !(cellSizeM > 0)
      || field.bounds.maxX - field.bounds.minX !== (cols - 1) * cellSizeM
      || field.bounds.maxZ - field.bounds.minZ !== (rows - 1) * cellSizeM) {
    throw new Error("world biome field master grid bounds and cell size are inconsistent");
  }
  if (!(field.heightsM instanceof Float32Array || field.heightsM instanceof Float64Array) || field.heightsM.length !== cells
      || !(field.biomeCell instanceof Uint8Array) || field.biomeCell.length !== cells
      || !(hydrology.oceanMask instanceof Uint8Array) || hydrology.oceanMask.length !== cells
      || !Array.isArray(generatedWater.basins) || !Array.isArray(generatedWater.reaches)) {
    throw new Error("world biome field master channels are missing or dimensionally inconsistent");
  }
  if (field.biomeKinds.length > 255) throw new Error("world biome field exceeds Uint8 authored biome-region capacity");
  for (let index = 0; index < cells; index++) {
    checkpoint(root.shouldCancel, index);
    if (field.biomeCell[index] > field.biomeKinds.length) throw new Error(`world biome field biomeCell[${index}] is outside authored biome kinds`);
    if (hydrology.oceanMask[index] > 1) throw new Error(`world biome field oceanMask[${index}] is not binary`);
  }
  if (field.seaLevelM + 300 > 1_000_000) throw new Error("world biome field sea level exceeds the pinned alpine modifier range");
  const grid = Object.freeze({ origin, rows, cols, cellSizeM });
  const temperatureC = new Float32Array(cells), moisture01 = new Float32Array(cells);
  const authoredTargetIds = [...new Set(["deep-ocean", ...["open", ...field.biomeKinds].map((kind) => WORLD_BIOME_AUTHORED_TARGETS[kind])])].sort();
  if (authoredTargetIds.some((biomeId) => typeof biomeId !== "string")) throw new Error("world biome field has an authored kind without an explicit semantic target");
  const authoredTargetIndex = new Map(authoredTargetIds.map((biomeId, index) => [biomeId, index]));
  const authoredTargetIndices = new Uint16Array(cells);
  const elevationM = new Float32Array(field.heightsM), slope01 = new Float32Array(cells);
  let work = 0;
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      checkpoint(root.shouldCancel, work++);
      const index = row * cols + col, biomeIndex = field.biomeCell[index];
      const kind = biomeIndex === 0 ? "open" : field.biomeKinds[biomeIndex - 1];
      const climate = WORLD_BIOME_LEGACY_CLIMATE[kind] ?? WORLD_BIOME_LEGACY_CLIMATE.open;
      temperatureC[index] = climate.temperatureC;
      moisture01[index] = clamp01(climate.precipitationMmPerYear / WORLD_BIOME_PRECIPITATION_CEILING_MM_PER_YEAR);
      authoredTargetIndices[index] = authoredTargetIndex.get(WORLD_BIOME_AUTHORED_TARGETS[kind]);
    }
  }
  for (let row = 0; row < rows; row++) {
    const priorRow = Math.max(0, row - 1), nextRow = Math.min(rows - 1, row + 1);
    for (let col = 0; col < cols; col++) {
      checkpoint(root.shouldCancel, work++);
      const priorCol = Math.max(0, col - 1), nextCol = Math.min(cols - 1, col + 1);
      const dx = (elevationM[row * cols + nextCol] - elevationM[row * cols + priorCol]) / ((nextCol - priorCol) * cellSizeM);
      const dz = (elevationM[nextRow * cols + col] - elevationM[priorRow * cols + col]) / ((nextRow - priorRow) * cellSizeM);
      slope01[row * cols + col] = 2 * Math.atan(Math.hypot(dx, dz)) / Math.PI;
    }
  }
  const waterMask = new Uint8Array(cells);
  rasterizeWater(waterMask, grid, hydrology, generatedWater, root.shouldCancel);
  const deepOceanTarget = authoredTargetIndex.get("deep-ocean");
  for (let index = 0; index < cells; index++) {
    checkpoint(root.shouldCancel, work++);
    if (waterMask[index] === 0) continue;
    authoredTargetIndices[index] = deepOceanTarget;
    elevationM[index] = field.seaLevelM;
    slope01[index] = 0;
  }
  const waterDistanceM = waterDistances(waterMask, rows, cols, cellSizeM, root.shouldCancel);
  try {
    return compileBiomeField({
      pack: BIOME_LIBRARY_V1,
      grid,
      samples: { temperatureC, moisture01, elevationM, slope01, waterDistanceM },
      authoredTargets: { biomeIds: authoredTargetIds, indices: authoredTargetIndices },
      influences: [],
      modifiers: modifiers(field.seaLevelM, cellSizeM),
      topN: WORLD_BIOME_FIELD_TOP_N,
      climateFeather: WORLD_BIOME_CLIMATE_FEATHER,
    }, { shouldCancel: root.shouldCancel });
  } catch (error) {
    if (error instanceof BiomeFieldCancelledError) throw new WorldBiomeFieldCancelledError();
    throw error;
  }
}
