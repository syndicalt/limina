// B3 derived surface compositor. All combinatorial biome/role blending happens once on CPU; the
// renderer receives exactly three ordinary PBR textures and keeps one shared material graph.

import { BIOME_SURFACE_PLAN_NONE } from "./biome-surface-plan.mjs";
import { sha256 } from "./sha256.mjs";

export const SURFACE_COMPOSITE_TILE_SCHEMA = "limina.surface-composite-tile/v1";
export const SURFACE_COMPOSITE_POLICY_VERSION = 8;
export const SURFACE_COMPOSITE_LIMITS = Object.freeze({ interior: 256, gutter: 4, roles: 32, sourceDimension: 4096, outputBytes: 4 * 1024 * 1024 });
const HASH = /^sha256:[0-9a-f]{64}$/;

function finite(value, label) { if (typeof value !== "number" || !Number.isFinite(value) || Object.is(value, -0)) throw new TypeError(`${label} must be a canonical finite number`); return value; }
function integer(value, minimum, maximum, label) { if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new RangeError(`${label} must be an integer in [${minimum}, ${maximum}]`); return value; }
function hash(value, label) { if (typeof value !== "string" || !HASH.test(value)) throw new TypeError(`${label} must be a canonical content hash`); return value; }
function rgba(value, width, height, label) { if (!(value instanceof Uint8Array) || value.length !== width * height * 4) throw new TypeError(`${label} must be exact RGBA8 data`); return value; }
function scalar(value, width, height, label) { if (!(value instanceof Uint8Array) || value.length !== width * height) throw new TypeError(`${label} must be exact R8 data`); return value; }
function srgbToLinear(value) { const c = value / 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; }
function linearToSrgb(value) { const c = Math.max(0, Math.min(1, value)); return Math.round(255 * (c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055)); }
function wrap(value) { return value - Math.floor(value); }
function smoothstep(edge0, edge1, value) {
  if (edge1 === edge0) return value < edge0 ? 0 : 1;
  const t = Math.max(0, Math.min(1, (value - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

export function grassPresentationCoverage(density01) {
  const density = finite(density01, "grass presentation density");
  if (density < 0 || density > 1) throw new RangeError("grass presentation density must be in [0,1]");
  // The compiled field already expresses normalized whole-scene coverage (the acceptance-camera
  // tiles measure roughly 0.75-0.90 away from exact water). Preserve that authority directly;
  // nonlinear saturation turns the exact water boundary into a visible dark turf cliff.
  return density;
}

function bandResponse(value, band) {
  const [minimum, maximum, feather] = band;
  const enter = feather === 0 ? (value >= minimum ? 1 : 0) : smoothstep(minimum - feather, minimum, value);
  const leave = feather === 0 ? (value <= maximum ? 1 : 0) : 1 - smoothstep(maximum, maximum + feather, value);
  return enter * leave;
}

function environmentalWeights(plan, baseWeights, sample) {
  if (sample === undefined) return baseWeights;
  if (sample === null || typeof sample !== "object" || Array.isArray(sample)) throw new TypeError("surface environment sample must be an object");
  const values = { slope01: finite(sample.slope01, "surface environment slope01"),
    elevationM: finite(sample.elevationM, "surface environment elevationM"),
    waterDistanceM: finite(sample.waterDistanceM, "surface environment waterDistanceM") };
  if (values.slope01 < 0 || values.slope01 > 1 || values.waterDistanceM < 0) throw new RangeError("surface environment sample is out of bounds");
  const scores = new Float64Array(plan.roles.length);
  for (const entry of baseWeights) scores[entry.index] = entry.weight;
  for (const role of plan.roles) {
    const environment = role.rule.environment;
    if (environment === undefined) continue;
    let response = 1;
    for (const key of ["slope01", "elevationM", "waterDistanceM"]) if (environment[key] !== undefined) {
      response *= bandResponse(values[key], environment[key]);
    }
    scores[role.index] += environment.overlayWeight * response;
  }
  const total = scores.reduce((sum, value) => sum + value, 0);
  if (!(total > 0)) return baseWeights;
  return [...scores].map((score, index) => ({ index, weight: score / total })).filter((entry) => entry.weight > 0);
}

function sampleMap(layer, map, x, z, scale) {
  const u = wrap(x / scale) * layer.width, v = wrap(z / scale) * layer.height;
  const x0 = Math.floor(u) % layer.width, y0 = Math.floor(v) % layer.height;
  const x1 = (x0 + 1) % layer.width, y1 = (y0 + 1) % layer.height, tx = u - Math.floor(u), ty = v - Math.floor(v);
  const at = (px, py, channel) => map[(py * layer.width + px) * 4 + channel];
  const out = new Array(4);
  for (let channel = 0; channel < 4; channel++) {
    const top = at(x0, y0, channel) * (1 - tx) + at(x1, y0, channel) * tx;
    const bottom = at(x0, y1, channel) * (1 - tx) + at(x1, y1, channel) * tx;
    out[channel] = top * (1 - ty) + bottom * ty;
  }
  return out;
}

function sampleScalar(layer, map, x, z, scale) {
  const u = wrap(x / scale) * layer.width, v = wrap(z / scale) * layer.height;
  const x0 = Math.floor(u) % layer.width, y0 = Math.floor(v) % layer.height;
  const x1 = (x0 + 1) % layer.width, y1 = (y0 + 1) % layer.height, tx = u - Math.floor(u), ty = v - Math.floor(v);
  const top = map[y0 * layer.width + x0] * (1 - tx) + map[y0 * layer.width + x1] * tx;
  const bottom = map[y1 * layer.width + x0] * (1 - tx) + map[y1 * layer.width + x1] * tx;
  return top * (1 - ty) + bottom * ty;
}

function planWeights(plan, x, z, edgePolicy) {
  let gx = (x - plan.grid.origin[0]) / plan.grid.cellSizeM, gz = (z - plan.grid.origin[1]) / plan.grid.cellSizeM;
  if (gx < 0 || gz < 0 || gx > plan.grid.cols - 1 || gz > plan.grid.rows - 1) {
    if (edgePolicy !== "clamp") throw new RangeError("surface composite sample lies outside its surface plan");
    gx = Math.max(0, Math.min(plan.grid.cols - 1, gx));
    gz = Math.max(0, Math.min(plan.grid.rows - 1, gz));
  }
  const col0 = Math.floor(gx), row0 = Math.floor(gz), col1 = Math.min(plan.grid.cols - 1, col0 + 1), row1 = Math.min(plan.grid.rows - 1, row0 + 1);
  const tx = col1 === col0 ? 0 : gx - col0, tz = row1 === row0 ? 0 : gz - row0;
  const scores = new Float64Array(plan.roles.length);
  for (const [row, col, factor] of [[row0, col0, (1 - tx) * (1 - tz)], [row0, col1, tx * (1 - tz)],
    [row1, col0, (1 - tx) * tz], [row1, col1, tx * tz]]) {
    const base = (row * plan.grid.cols + col) * plan.slots;
    for (let slot = 0; slot < plan.slots; slot++) {
      const role = plan.indices[base + slot];
      if (role !== BIOME_SURFACE_PLAN_NONE) scores[role] += factor * plan.weights[base + slot] / 65_535;
    }
  }
  const total = scores.reduce((sum, value) => sum + value, 0);
  if (!(total > 0)) throw new Error("surface composite sample resolved no role weight");
  return [...scores].map((score, index) => ({ index, weight: score / total })).filter((entry) => entry.weight > 0);
}

function edgeHash(maps, total, interior, gutter, edge) {
  const bytes = new Uint8Array(interior * 4 * maps.length); let offset = 0;
  for (const map of maps) {
    for (let sample = 0; sample < interior; sample++) {
      const row = edge === "north" ? gutter : edge === "south" ? gutter + interior - 1 : gutter + sample;
      const col = edge === "west" ? gutter : edge === "east" ? gutter + interior - 1 : gutter + sample;
      const source = (row * total + col) * 4;
      bytes.set(map.subarray(source, source + 4), offset); offset += 4;
    }
  }
  return `sha256:${sha256(bytes)}`;
}

export function buildSurfaceCompositeTile(input) {
  if (input === null || typeof input !== "object" || Array.isArray(input)) throw new TypeError("surface composite input must be an object");
  const plan = input.plan;
  if (plan?.schema !== "limina.biome-surface-plan/v1") throw new TypeError("surface composite requires a biome surface plan");
  if (!Array.isArray(input.layers) || input.layers.length !== plan.roles.length || input.layers.length > SURFACE_COMPOSITE_LIMITS.roles) throw new RangeError("surface composite layers must exactly cover the bounded role table");
  const interior = integer(input.interior ?? SURFACE_COMPOSITE_LIMITS.interior, 2, SURFACE_COMPOSITE_LIMITS.interior, "surface composite interior");
  const gutter = integer(input.gutter ?? 1, 0, SURFACE_COMPOSITE_LIMITS.gutter, "surface composite gutter");
  const edgePolicy = input.edgePolicy ?? "reject";
  if (edgePolicy !== "reject" && edgePolicy !== "clamp") throw new TypeError("surface composite edgePolicy must be 'reject' or 'clamp'");
  const total = interior + gutter * 2, outputBytes = total * total * 4 * 3;
  if (outputBytes > SURFACE_COMPOSITE_LIMITS.outputBytes) throw new RangeError("surface composite output exceeds byte budget");
  const tile = input.tile;
  if (tile === null || typeof tile !== "object" || Array.isArray(tile)) throw new TypeError("surface composite tile must be an object");
  const tx = integer(tile.tx, -1_000_000, 1_000_000, "surface composite tile.tx"), tz = integer(tile.tz, -1_000_000, 1_000_000, "surface composite tile.tz");
  const lod = integer(tile.lod, 0, 16, "surface composite tile.lod"), sizeM = finite(tile.sizeM, "surface composite tile.sizeM");
  if (!(sizeM > 0)) throw new RangeError("surface composite tile.sizeM must be positive");
  if (!Array.isArray(tile.origin) || tile.origin.length !== 2) throw new TypeError("surface composite tile.origin must be [x,z]");
  const originX = finite(tile.origin[0], "surface composite tile.origin[0]"), originZ = finite(tile.origin[1], "surface composite tile.origin[1]");
  const featureOrigin = input.featureOrigin ?? [0, 0];
  if (!Array.isArray(featureOrigin) || featureOrigin.length !== 2) throw new TypeError("surface composite featureOrigin must be [x,z]");
  const featureX = finite(featureOrigin[0], "surface composite featureOrigin[0]"), featureZ = finite(featureOrigin[1], "surface composite featureOrigin[1]");
  const layers = input.layers.map((layer, index) => {
    if (layer === null || typeof layer !== "object" || Array.isArray(layer) || layer.index !== index) throw new TypeError(`surface composite layer ${index} is invalid`);
    const role = plan.roles[index];
    if (layer.assetId !== role.assetId || layer.contentHash !== role.contentHash) throw new Error(`surface composite layer ${index} identity mismatch`);
    const width = integer(layer.width, 1, SURFACE_COMPOSITE_LIMITS.sourceDimension, `surface composite layer ${index}.width`);
    const height = integer(layer.height, 1, SURFACE_COMPOSITE_LIMITS.sourceDimension, `surface composite layer ${index}.height`);
    return Object.freeze({ index, width, height, albedo: rgba(layer.albedo, width, height, `surface composite layer ${index}.albedo`),
      normal: rgba(layer.normal, width, height, `surface composite layer ${index}.normal`), orm: rgba(layer.orm, width, height, `surface composite layer ${index}.orm`),
      displacement: layer.displacement === undefined ? new Uint8Array(width * height)
        : scalar(layer.displacement, width, height, `surface composite layer ${index}.displacement`) });
  });
  const grassOverlayRole = input.grassOverlayRole;
  if (grassOverlayRole !== undefined && (typeof grassOverlayRole !== "string" || grassOverlayRole.length === 0)) {
    throw new TypeError("surface composite grassOverlayRole must be a non-empty role");
  }
  const grassOverlayIndices = grassOverlayRole === undefined ? []
    : plan.roles.filter((role) => role.role === grassOverlayRole).map((role) => role.index);
  if (grassOverlayRole !== undefined && grassOverlayIndices.length !== 1) {
    throw new Error(`surface composite grass overlay role '${grassOverlayRole}' must resolve exactly once`);
  }
  const grassOverlayIndex = grassOverlayIndices[0];
  const albedo = new Uint8Array(total * total * 4), normal = new Uint8Array(total * total * 4), orm = new Uint8Array(total * total * 4);
  const step = sizeM / (interior - 1);
  for (let row = 0; row < total; row++) for (let col = 0; col < total; col++) {
    const worldX = originX + (col - gutter) * step, worldZ = originZ + (row - gutter) * step;
    const baseWeights = planWeights(plan, worldX, worldZ, edgePolicy);
    const environment = input.sampleEnvironment?.(worldX, worldZ);
    const grassDensity01 = input.sampleGrassDensity === undefined ? 0
      : finite(input.sampleGrassDensity(worldX, worldZ), "surface grass density");
    if (grassDensity01 < 0 || grassDensity01 > 1) throw new RangeError("surface grass density must be in [0,1]");
    const weights = environmentalWeights(plan, baseWeights, environment);
    const shorelineWet01 = environment === undefined ? 0
      : 1 - smoothstep(0.2, 3, environment.waterDistanceM);
    let lr = 0, lg = 0, lb = 0, nx = 0, ny = 0, nz = 0, logAo = 0, roughSquared = 0, metal = 0;
    for (const weighted of weights) {
      const layer = layers[weighted.index], role = plan.roles[weighted.index];
      const a = sampleMap(layer, layer.albedo, worldX - featureX, worldZ - featureZ, role.rule.tileScaleM);
      const n = sampleMap(layer, layer.normal, worldX - featureX, worldZ - featureZ, role.rule.tileScaleM);
      const o = sampleMap(layer, layer.orm, worldX - featureX, worldZ - featureZ, role.rule.tileScaleM), w = weighted.weight;
      const calibration = role.rule.calibration ?? { albedoLinearGain: [1, 1, 1], normalStrength: 1, displacementScaleM: 0 };
      lr += srgbToLinear(a[0]) * calibration.albedoLinearGain[0] * w;
      lg += srgbToLinear(a[1]) * calibration.albedoLinearGain[1] * w;
      lb += srgbToLinear(a[2]) * calibration.albedoLinearGain[2] * w;
      const displacementStepM = role.rule.tileScaleM / layer.width;
      const displacementX = calibration.displacementScaleM === 0 ? 0 : (
        sampleScalar(layer, layer.displacement, worldX - featureX + displacementStepM, worldZ - featureZ, role.rule.tileScaleM)
        - sampleScalar(layer, layer.displacement, worldX - featureX - displacementStepM, worldZ - featureZ, role.rule.tileScaleM)
      ) / 255 * calibration.displacementScaleM / (2 * displacementStepM);
      const displacementZ = calibration.displacementScaleM === 0 ? 0 : (
        sampleScalar(layer, layer.displacement, worldX - featureX, worldZ - featureZ + displacementStepM, role.rule.tileScaleM)
        - sampleScalar(layer, layer.displacement, worldX - featureX, worldZ - featureZ - displacementStepM, role.rule.tileScaleM)
      ) / 255 * calibration.displacementScaleM / (2 * displacementStepM);
      nx += ((n[0] / 127.5 - 1) * calibration.normalStrength - displacementX) * w;
      ny += ((n[1] / 127.5 - 1) * calibration.normalStrength - displacementZ) * w;
      nz += (n[2] / 127.5 - 1) * w;
      logAo += Math.log(Math.max(1 / 255, o[0] / 255)) * w; roughSquared += (o[1] / 255) ** 2 * w; metal += o[2] / 255 * w;
    }
    // Policy v7 makes the authenticated ecological grass field visible in the surface itself.
    // Explicit blades can now hand off to real turf color, normal, and roughness instead of a
    // flat green tint over scrub. Density zero deliberately takes no arithmetic path so the base
    // composite remains byte-identical, and the same world coordinates preserve tile gutters.
    const grassCoverage = grassOverlayIndex === undefined ? 0
      : grassPresentationCoverage(grassDensity01) * (1 - shorelineWet01);
    if (grassCoverage > 0) {
      const layer = layers[grassOverlayIndex], role = plan.roles[grassOverlayIndex];
      const a = sampleMap(layer, layer.albedo, worldX - featureX, worldZ - featureZ, role.rule.tileScaleM);
      const n = sampleMap(layer, layer.normal, worldX - featureX, worldZ - featureZ, role.rule.tileScaleM);
      const o = sampleMap(layer, layer.orm, worldX - featureX, worldZ - featureZ, role.rule.tileScaleM);
      const calibration = role.rule.calibration ?? { albedoLinearGain: [1, 1, 1], normalStrength: 1, displacementScaleM: 0 };
      const displacementStepM = role.rule.tileScaleM / layer.width;
      const displacementX = calibration.displacementScaleM === 0 ? 0 : (
        sampleScalar(layer, layer.displacement, worldX - featureX + displacementStepM, worldZ - featureZ, role.rule.tileScaleM)
        - sampleScalar(layer, layer.displacement, worldX - featureX - displacementStepM, worldZ - featureZ, role.rule.tileScaleM)
      ) / 255 * calibration.displacementScaleM / (2 * displacementStepM);
      const displacementZ = calibration.displacementScaleM === 0 ? 0 : (
        sampleScalar(layer, layer.displacement, worldX - featureX, worldZ - featureZ + displacementStepM, role.rule.tileScaleM)
        - sampleScalar(layer, layer.displacement, worldX - featureX, worldZ - featureZ - displacementStepM, role.rule.tileScaleM)
      ) / 255 * calibration.displacementScaleM / (2 * displacementStepM);
      const inverse = 1 - grassCoverage;
      lr = lr * inverse + srgbToLinear(a[0]) * calibration.albedoLinearGain[0] * grassCoverage;
      lg = lg * inverse + srgbToLinear(a[1]) * calibration.albedoLinearGain[1] * grassCoverage;
      lb = lb * inverse + srgbToLinear(a[2]) * calibration.albedoLinearGain[2] * grassCoverage;
      const baseLength = Math.hypot(nx, ny, nz) || 1;
      let turfX = (n[0] / 127.5 - 1) * calibration.normalStrength - displacementX;
      let turfY = (n[1] / 127.5 - 1) * calibration.normalStrength - displacementZ;
      const turfXyLength = Math.hypot(turfX, turfY);
      if (turfXyLength > 0.28) { turfX *= 0.28 / turfXyLength; turfY *= 0.28 / turfXyLength; }
      const turfZ = Math.sqrt(Math.max(0, 1 - turfX * turfX - turfY * turfY));
      nx = nx / baseLength * inverse + turfX * grassCoverage;
      ny = ny / baseLength * inverse + turfY * grassCoverage;
      nz = nz / baseLength * inverse + turfZ * grassCoverage;
      logAo = logAo * inverse + Math.log(Math.max(1 / 255, o[0] / 255)) * grassCoverage;
      const turfRoughness = 0.88 + 0.08 * (o[1] / 255);
      roughSquared = roughSquared * inverse + turfRoughness ** 2 * grassCoverage;
      metal = metal * inverse + o[2] / 255 * grassCoverage;
    }
    const length = Math.hypot(nx, ny, nz) || 1, out = (row * total + col) * 4;
    albedo[out] = linearToSrgb(lr); albedo[out + 1] = linearToSrgb(lg); albedo[out + 2] = linearToSrgb(lb);
    // Albedo alpha is otherwise unused by the opaque terrain material. Policy v4+ binds it to the
    // exact generated-water distance field so water and terrain share one shoreline identity
    // without adding a fourth runtime texture sample.
    albedo[out + 3] = Math.round(shorelineWet01 * 255);
    normal[out] = Math.round((nx / length * 0.5 + 0.5) * 255); normal[out + 1] = Math.round((ny / length * 0.5 + 0.5) * 255);
    normal[out + 2] = Math.round((nz / length * 0.5 + 0.5) * 255); normal[out + 3] = 255;
    orm[out] = Math.round(Math.exp(logAo) * 255); orm[out + 1] = Math.round(Math.sqrt(roughSquared) * 255); orm[out + 2] = Math.round(metal * 255);
    // Policy v5+ authenticates the continuous biome grass field into the previously unused ORM
    // alpha channel. Geometry and the horizon proxy therefore consume one frozen ecological
    // authority without adding a fourth runtime texture.
    orm[out + 3] = Math.round(grassDensity01 * 255);
  }
  const maps = Object.freeze({
    albedo: Object.freeze({ data: albedo, contentHash: `sha256:${sha256(albedo)}`, colorSpace: "srgb" }),
    normal: Object.freeze({ data: normal, contentHash: `sha256:${sha256(normal)}`, colorSpace: "none", convention: "opengl-y-plus" }),
    orm: Object.freeze({ data: orm, contentHash: `sha256:${sha256(orm)}`, colorSpace: "none", channels: "ao-roughness-metalness-grass-density" }),
  });
  const edgeHashes = Object.freeze(Object.fromEntries(["north", "east", "south", "west"].map((edge) => [edge, edgeHash([albedo, normal, orm], total, interior, gutter, edge)])));
  return Object.freeze({ schema: SURFACE_COMPOSITE_TILE_SCHEMA, source: Object.freeze({
    biomeFieldHash: hash(plan.identity.fieldContentHash, "surface composite biome field hash"),
    biomePackHash: hash(plan.identity.runtimePackContentHash, "surface composite biome pack hash"),
    terrainChunkHash: hash(input.terrainChunkHash, "surface composite terrain chunk hash"),
    environmentHash: hash(input.environmentHash ?? input.terrainChunkHash, "surface composite environment hash"),
    policyVersion: SURFACE_COMPOSITE_POLICY_VERSION }),
    coord: Object.freeze({ tx, tz, lod }), placement: Object.freeze({ origin: Object.freeze([originX, originZ]), sizeM, featureOrigin: Object.freeze([featureX, featureZ]) }),
    resolution: Object.freeze({ interior, gutter, total }), maps, edgeHashes,
    diagnostics: Object.freeze({ roles: layers.length, runtimeTextureSamples: 3, outputBytes }) });
}
