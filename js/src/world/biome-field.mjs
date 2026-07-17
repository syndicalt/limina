// WB-B2 deterministic spatial biome field. Pure CPU/data: no renderer, compiler, Atlas, or water
// authority. The output is a bounded typed-array structure ready for a later portable codec.

import { BIOME_LIMITS, LEGACY_BIOME_KINDS, parseBiomePack } from "./biome-ir.mjs";

export const BIOME_FIELD_SCHEMA = "limina.biome-field/v1";
export const BIOME_FIELD_VERSION = 1;
export const BIOME_FIELD_NONE = 0xffff;
export const BIOME_FIELD_WEIGHT_TOTAL = 0xffff;
export const BIOME_FIELD_LIMITS = Object.freeze({
  rows: 1025,
  cols: 1025,
  cells: 1_050_625,
  topN: 8,
  influences: 128,
  polygonPoints: 256,
  totalPolygonPoints: 4096,
  modifiers: 256,
  workUnits: 50_000_000,
  outputBytes: 64 * 1024 * 1024,
  idChars: 64,
});

const ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

export class BiomeFieldValidationError extends Error {
  constructor(message) { super(message); this.name = "BiomeFieldValidationError"; }
}
export class BiomeFieldCancelledError extends Error {
  constructor(message = "biome field compilation was cancelled") { super(message); this.name = "BiomeFieldCancelledError"; }
}
function fail(message) { throw new BiomeFieldValidationError(message); }

function record(value, allowed, required, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail(`${label} must be a plain object`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) fail(`${label} must be a plain object`);
  if (Object.getOwnPropertySymbols(value).length !== 0) fail(`${label} must not contain symbol fields`);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (!allowed.has(key)) fail(`${label} has unknown field '${key}'`);
    if (!("value" in descriptor) || descriptor.enumerable !== true) fail(`${label}.${key} must be an enumerable data field`);
  }
  for (const key of required) if (!Object.hasOwn(value, key)) fail(`${label} is missing '${key}'`);
  return descriptors;
}
function dense(value, maximum, label) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > maximum) {
    fail(`${label} must be a standard array with at most ${maximum} entries`);
  }
  if (Object.getOwnPropertySymbols(value).length !== 0 || Object.getOwnPropertyNames(value).length !== value.length + 1) {
    fail(`${label} must be dense and field-free`);
  }
  return value;
}
function number(value, minimum, maximum, label) {
  if (typeof value !== "number" || !Number.isFinite(value) || Object.is(value, -0) || value < minimum || value > maximum) {
    fail(`${label} must be a canonical number in [${minimum}, ${maximum}]`);
  }
  return value;
}
function integer(value, minimum, maximum, label) {
  const result = number(value, minimum, maximum, label);
  if (!Number.isSafeInteger(result)) fail(`${label} must be an integer`);
  return result;
}
function id(value, label) {
  if (typeof value !== "string" || value.length < 1 || value.length > BIOME_FIELD_LIMITS.idChars || !ID.test(value)) fail(`${label} is invalid`);
  return value;
}
function typedSamples(value, cells, label, options) {
  const tag = Object.prototype.toString.call(value);
  if (tag !== "[object Float32Array]" && tag !== "[object Float64Array]") fail(`${label} must be Float32Array or Float64Array`);
  if (Object.prototype.toString.call(value.buffer) === "[object SharedArrayBuffer]") fail(`${label} must not use shared storage`);
  if (value.length !== cells) fail(`${label} length ${value.length} != ${cells}`);
  for (let index = 0; index < value.length; index++) {
    if ((index & 1023) === 0) cancelled(options);
    if (!Number.isFinite(value[index])) fail(`${label}[${index}] must be finite`);
  }
  return value;
}

function parseAuthoredTargets(value, cells, pack, options) {
  if (value === undefined) return null;
  const d = record(value, new Set(["biomeIds", "indices"]), new Set(["biomeIds", "indices"]), "biome field authoredTargets");
  const sourceIds = dense(d.biomeIds.value, pack.definitions.length, "biome field authoredTargets.biomeIds");
  if (sourceIds.length < 1) fail("biome field authoredTargets.biomeIds must not be empty");
  const packIndex = new Map(pack.definitions.map((definition, index) => [definition.id, index]));
  const biomeIds = Object.freeze(sourceIds.map((value, index) => {
    const parsed = id(value, `biome field authoredTargets.biomeIds[${index}]`);
    if (!packIndex.has(parsed)) fail(`biome field authoredTargets targets unknown biome '${parsed}'`);
    if (index > 0 && sourceIds[index - 1] >= parsed) fail("biome field authoredTargets.biomeIds must be strictly sorted and unique");
    return parsed;
  }));
  const indices = d.indices.value;
  if (!(indices instanceof Uint16Array) || Object.prototype.toString.call(indices.buffer) === "[object SharedArrayBuffer]"
      || indices.length !== cells) {
    fail(`biome field authoredTargets.indices must be a non-shared Uint16Array of length ${cells}`);
  }
  const resolved = new Uint16Array(cells);
  resolved.fill(BIOME_FIELD_NONE);
  for (let index = 0; index < cells; index++) {
    if ((index & 1023) === 0) cancelled(options);
    const target = indices[index];
    if (target === BIOME_FIELD_NONE) continue;
    if (target >= biomeIds.length) fail(`biome field authoredTargets.indices[${index}] is outside authoredTargets.biomeIds`);
    resolved[index] = packIndex.get(biomeIds[target]);
  }
  return Object.freeze({ biomeIds, indices: resolved });
}
function tuple2(value, label) {
  const tuple = dense(value, 2, label);
  if (tuple.length !== 2) fail(`${label} must contain exactly two numbers`);
  return Object.freeze([number(tuple[0], -10_000_000, 10_000_000, `${label}[0]`), number(tuple[1], -10_000_000, 10_000_000, `${label}[1]`)]);
}

function parseTarget(value, pack, label) {
  const d = record(value, new Set(["biomeId", "legacyKind"]), new Set(), label);
  const hasId = d.biomeId !== undefined;
  const hasLegacy = d.legacyKind !== undefined;
  if (hasId === hasLegacy) fail(`${label} must contain exactly one of biomeId or legacyKind`);
  if (hasId) {
    const biomeId = id(d.biomeId.value, `${label}.biomeId`);
    if (!pack.definitions.some((definition) => definition.id === biomeId)) fail(`${label}.biomeId targets unknown biome '${biomeId}'`);
    return biomeId;
  }
  const legacyKind = d.legacyKind.value;
  if (typeof legacyKind !== "string" || !LEGACY_BIOME_KINDS.includes(legacyKind)) fail(`${label}.legacyKind is unsupported`);
  const alias = pack.legacyAliases.find((entry) => entry.legacyKind === legacyKind);
  if (alias === undefined) fail(`${label}.legacyKind '${legacyKind}' has no explicit pack alias`);
  return alias.biomeId;
}

export function resolveBiomeFieldTarget(packInput, targetInput) {
  const pack = parseBiomePack(packInput);
  return parseTarget(targetInput, pack, "biome target");
}

function parseBand(value, minimum, maximum, label) {
  if (value === null) return null;
  const d = record(value, new Set(["min", "max", "feather"]), new Set(["min", "max", "feather"]), label);
  const min = number(d.min.value, minimum, maximum, `${label}.min`);
  const max = number(d.max.value, minimum, maximum, `${label}.max`);
  if (max < min) fail(`${label}.max must be at least min`);
  return Object.freeze({ min, max, feather: number(d.feather.value, 0, maximum - minimum, `${label}.feather`) });
}

function parseInfluences(value, pack) {
  const source = dense(value, BIOME_FIELD_LIMITS.influences, "biome influences");
  let totalPoints = 0;
  const result = source.map((entry, index) => {
    const label = `biome influences[${index}]`;
    const d = record(entry, new Set(["id", "target", "polygon", "featherM", "strength"]), new Set(["id", "target", "polygon", "featherM", "strength"]), label);
    const polygonInput = dense(d.polygon.value, BIOME_FIELD_LIMITS.polygonPoints, `${label}.polygon`);
    if (polygonInput.length < 3) fail(`${label}.polygon must contain at least three points`);
    totalPoints += polygonInput.length;
    if (totalPoints > BIOME_FIELD_LIMITS.totalPolygonPoints) fail(`biome influences exceed ${BIOME_FIELD_LIMITS.totalPolygonPoints} total polygon points`);
    const polygon = Object.freeze(polygonInput.map((point, pointIndex) => tuple2(point, `${label}.polygon[${pointIndex}]`)));
    let twiceArea = 0;
    for (let point = 0; point < polygon.length; point++) {
      const next = polygon[(point + 1) % polygon.length];
      if (polygon[point][0] === next[0] && polygon[point][1] === next[1]) fail(`${label}.polygon has duplicate consecutive points`);
      twiceArea += polygon[point][0] * next[1] - next[0] * polygon[point][1];
    }
    if (Math.abs(twiceArea) <= 1e-9) fail(`${label}.polygon must have nonzero area`);
    return Object.freeze({
      id: id(d.id.value, `${label}.id`),
      biomeId: parseTarget(d.target.value, pack, `${label}.target`),
      polygon,
      featherM: number(d.featherM.value, 0, 100_000, `${label}.featherM`),
      strength: number(d.strength.value, -100, 100, `${label}.strength`),
    });
  });
  result.sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
  for (let index = 1; index < result.length; index++) if (result[index - 1].id === result[index].id) fail(`biome influences duplicate id '${result[index].id}'`);
  return Object.freeze(result);
}

function parseModifiers(value, pack) {
  const source = dense(value, BIOME_FIELD_LIMITS.modifiers, "biome modifiers");
  const result = source.map((entry, index) => {
    const label = `biome modifiers[${index}]`;
    const d = record(entry, new Set(["id", "target", "strength", "elevationM", "slope01", "waterDistanceM"]), new Set(["id", "target", "strength", "elevationM", "slope01", "waterDistanceM"]), label);
    const elevationM = parseBand(d.elevationM.value, -1_000_000, 1_000_000, `${label}.elevationM`);
    const slope01 = parseBand(d.slope01.value, 0, 1, `${label}.slope01`);
    const waterDistanceM = parseBand(d.waterDistanceM.value, 0, 10_000_000, `${label}.waterDistanceM`);
    if (elevationM === null && slope01 === null && waterDistanceM === null) fail(`${label} must constrain at least one sampled dimension`);
    return Object.freeze({
      id: id(d.id.value, `${label}.id`),
      biomeId: parseTarget(d.target.value, pack, `${label}.target`),
      strength: number(d.strength.value, -100, 100, `${label}.strength`),
      elevationM, slope01, waterDistanceM,
    });
  });
  result.sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
  for (let index = 1; index < result.length; index++) if (result[index - 1].id === result[index].id) fail(`biome modifiers duplicate id '${result[index].id}'`);
  return Object.freeze(result);
}

function bandWeight(value, band, feather) {
  if (value >= band.min && value <= band.max) return 1;
  if (!(feather > 0)) return 0;
  const distance = value < band.min ? band.min - value : value - band.max;
  const t = Math.max(0, Math.min(1, 1 - distance / feather));
  return t * t * (3 - 2 * t);
}
function modifierWeight(value, band) { return band === null ? 1 : bandWeight(value, band, band.feather); }

function polygonWeight(x, z, influence) {
  let inside = false;
  let minimumSquared = Infinity;
  const points = influence.polygon;
  for (let index = 0, prior = points.length - 1; index < points.length; prior = index++) {
    const a = points[prior], b = points[index];
    if (((a[1] > z) !== (b[1] > z)) && x < (b[0] - a[0]) * (z - a[1]) / (b[1] - a[1]) + a[0]) inside = !inside;
    const dx = b[0] - a[0], dz = b[1] - a[1];
    const lengthSquared = dx * dx + dz * dz;
    const t = lengthSquared === 0 ? 0 : Math.max(0, Math.min(1, ((x - a[0]) * dx + (z - a[1]) * dz) / lengthSquared));
    const ex = x - (a[0] + dx * t), ez = z - (a[1] + dz * t);
    minimumSquared = Math.min(minimumSquared, ex * ex + ez * ez);
  }
  if (influence.featherM === 0) return inside ? 1 : 0;
  const signed = (inside ? 1 : -1) * Math.sqrt(minimumSquared) / influence.featherM;
  const t = Math.max(0, Math.min(1, 0.5 + signed * 0.5));
  return t * t * (3 - 2 * t);
}

function quantizeWeights(entries, topN, indices, weights, offset, biomeIndex) {
  const selected = entries.slice(0, topN);
  let total = 0;
  for (const entry of selected) total += entry.weight;
  if (!(total > 0)) throw new Error("biome field internal normalization received no weight");
  const parts = selected.map((entry) => {
    const exact = entry.weight / total * BIOME_FIELD_WEIGHT_TOTAL;
    const floor = Math.floor(exact);
    return { ...entry, floor, remainder: exact - floor };
  });
  let assigned = parts.reduce((sum, entry) => sum + entry.floor, 0);
  const remainderOrder = [...parts].sort((left, right) => right.remainder - left.remainder || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
  for (let remaining = BIOME_FIELD_WEIGHT_TOTAL - assigned, index = 0; remaining > 0; remaining--, index++) remainderOrder[index % remainderOrder.length].floor++;
  const quantized = parts.filter((entry) => entry.floor > 0);
  quantized.sort((left, right) => right.weight - left.weight || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
  for (let rank = 0; rank < topN; rank++) {
    const entry = quantized[rank];
    indices[offset + rank] = entry === undefined ? BIOME_FIELD_NONE : biomeIndex.get(entry.id);
    weights[offset + rank] = entry?.floor ?? 0;
  }
}

function cancelled(options) {
  if (options?.signal?.aborted === true || options?.shouldCancel?.() === true) throw new BiomeFieldCancelledError();
}

export function compileBiomeField(input, options = {}) {
  if (options === null || typeof options !== "object" || Array.isArray(options)) fail("biome field options must be an object");
  if (options.shouldCancel !== undefined && typeof options.shouldCancel !== "function") fail("biome field options.shouldCancel must be a function");
  const d = record(input, new Set(["pack", "grid", "samples", "influences", "modifiers", "topN", "climateFeather", "authoredTargets"]), new Set(["pack", "grid", "samples", "influences", "modifiers", "topN", "climateFeather"]), "biome field input");
  const pack = parseBiomePack(d.pack.value);
  const gridInput = record(d.grid.value, new Set(["origin", "rows", "cols", "cellSizeM"]), new Set(["origin", "rows", "cols", "cellSizeM"]), "biome field grid");
  const origin = tuple2(gridInput.origin.value, "biome field grid.origin");
  const rows = integer(gridInput.rows.value, 1, BIOME_FIELD_LIMITS.rows, "biome field grid.rows");
  const cols = integer(gridInput.cols.value, 1, BIOME_FIELD_LIMITS.cols, "biome field grid.cols");
  const cells = rows * cols;
  if (!Number.isSafeInteger(cells) || cells > BIOME_FIELD_LIMITS.cells) fail(`biome field exceeds ${BIOME_FIELD_LIMITS.cells} cells`);
  const cellSizeM = number(gridInput.cellSizeM.value, 0.01, 1_000_000, "biome field grid.cellSizeM");
  const topN = integer(d.topN.value, 2, Math.min(BIOME_FIELD_LIMITS.topN, pack.definitions.length), "biome field topN");
  const featherInput = record(d.climateFeather.value, new Set(["temperatureC", "moisture01"]), new Set(["temperatureC", "moisture01"]), "biome field climateFeather");
  const climateFeather = Object.freeze({
    temperatureC: number(featherInput.temperatureC.value, 0.001, 100, "biome field climateFeather.temperatureC"),
    moisture01: number(featherInput.moisture01.value, 0.001, 1, "biome field climateFeather.moisture01"),
  });
  const sampleInput = record(d.samples.value, new Set(["temperatureC", "moisture01", "elevationM", "slope01", "waterDistanceM"]), new Set(["temperatureC", "moisture01", "elevationM", "slope01", "waterDistanceM"]), "biome field samples");
  const samples = Object.freeze({
    temperatureC: typedSamples(sampleInput.temperatureC.value, cells, "biome field samples.temperatureC", options),
    moisture01: typedSamples(sampleInput.moisture01.value, cells, "biome field samples.moisture01", options),
    elevationM: typedSamples(sampleInput.elevationM.value, cells, "biome field samples.elevationM", options),
    slope01: typedSamples(sampleInput.slope01.value, cells, "biome field samples.slope01", options),
    waterDistanceM: typedSamples(sampleInput.waterDistanceM.value, cells, "biome field samples.waterDistanceM", options),
  });
  const authoredTargets = parseAuthoredTargets(d.authoredTargets?.value, cells, pack, options);
  for (let index = 0; index < cells; index++) {
    if ((index & 1023) === 0) cancelled(options);
    if (samples.moisture01[index] < 0 || samples.moisture01[index] > 1) fail(`biome field samples.moisture01[${index}] must be in [0, 1]`);
    if (samples.slope01[index] < 0 || samples.slope01[index] > 1) fail(`biome field samples.slope01[${index}] must be in [0, 1]`);
    if (samples.waterDistanceM[index] < 0) fail(`biome field samples.waterDistanceM[${index}] must be non-negative`);
  }
  const influences = parseInfluences(d.influences.value, pack);
  const modifiers = parseModifiers(d.modifiers.value, pack);
  const polygonWork = influences.reduce((sum, influence) => sum + influence.polygon.length, 0);
  const workUnits = cells * (pack.definitions.length + modifiers.length + polygonWork);
  if (!Number.isSafeInteger(workUnits) || workUnits > BIOME_FIELD_LIMITS.workUnits) fail(`biome field work ${workUnits} exceeds ${BIOME_FIELD_LIMITS.workUnits}`);
  const outputBytes = cells * topN * 4;
  if (outputBytes > BIOME_FIELD_LIMITS.outputBytes) fail(`biome field output exceeds ${BIOME_FIELD_LIMITS.outputBytes} bytes`);
  cancelled(options);

  const biomeIds = Object.freeze(pack.definitions.map((definition) => definition.id));
  const biomeIndex = new Map(biomeIds.map((biomeId, index) => [biomeId, index]));
  const indices = new Uint16Array(cells * topN);
  indices.fill(BIOME_FIELD_NONE);
  const weights = new Uint16Array(cells * topN);
  const scores = new Float64Array(pack.definitions.length);
  const definitionsById = new Map(pack.definitions.map((definition, index) => [definition.id, { definition, index }]));

  for (let row = 0; row < rows; row++) {
    cancelled(options);
    for (let col = 0; col < cols; col++) {
      const cell = row * cols + col;
      const x = origin[0] + col * cellSizeM;
      const z = origin[1] + row * cellSizeM;
      const authoredTarget = authoredTargets?.indices[cell] ?? BIOME_FIELD_NONE;
      for (let index = 0; index < pack.definitions.length; index++) {
        if (authoredTarget !== BIOME_FIELD_NONE) {
          scores[index] = index === authoredTarget ? 1 : 0;
        } else {
          const climate = pack.definitions[index].climate;
          scores[index] = bandWeight(samples.temperatureC[cell], climate.temperatureC, climateFeather.temperatureC)
            * bandWeight(samples.moisture01[cell], climate.moisture01, climateFeather.moisture01);
        }
      }
      for (const influence of influences) {
        const target = definitionsById.get(influence.biomeId);
        scores[target.index] = Math.max(0, scores[target.index] + influence.strength * polygonWeight(x, z, influence));
      }
      for (const modifier of modifiers) {
        const target = definitionsById.get(modifier.biomeId);
        const amount = modifierWeight(samples.elevationM[cell], modifier.elevationM)
          * modifierWeight(samples.slope01[cell], modifier.slope01)
          * modifierWeight(samples.waterDistanceM[cell], modifier.waterDistanceM);
        scores[target.index] = Math.max(0, scores[target.index] + modifier.strength * amount);
      }
      let entries = pack.definitions.map((definition, index) => ({ id: definition.id, weight: scores[index] })).filter((entry) => entry.weight > 0);
      if (entries.length === 0) {
        // Total fallback is continuous climate-distance ranking, never input/insertion order.
        entries = pack.definitions.map((definition) => {
          const t = definition.climate.temperatureC;
          const m = definition.climate.moisture01;
          const dt = samples.temperatureC[cell] < t.min ? t.min - samples.temperatureC[cell] : samples.temperatureC[cell] > t.max ? samples.temperatureC[cell] - t.max : 0;
          const dm = samples.moisture01[cell] < m.min ? m.min - samples.moisture01[cell] : samples.moisture01[cell] > m.max ? samples.moisture01[cell] - m.max : 0;
          return { id: definition.id, weight: 1 / (1 + dt / climateFeather.temperatureC + dm / climateFeather.moisture01) };
        });
      }
      entries.sort((left, right) => right.weight - left.weight || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
      quantizeWeights(entries, topN, indices, weights, cell * topN, biomeIndex);
    }
  }
  return Object.freeze({
    schema: BIOME_FIELD_SCHEMA,
    version: BIOME_FIELD_VERSION,
    pack: Object.freeze({ id: pack.id, version: pack.version }),
    grid: Object.freeze({ origin, rows, cols, cellSizeM }),
    topN,
    biomeIds,
    indices,
    weights,
    diagnostics: Object.freeze({ cells, workUnits, outputBytes, influences: influences.length, modifiers: modifiers.length }),
  });
}

export function inspectBiomeField(field) {
  const d = record(field, new Set(["schema", "version", "pack", "grid", "topN", "biomeIds", "indices", "weights", "diagnostics"]), new Set(["schema", "version", "pack", "grid", "topN", "biomeIds", "indices", "weights", "diagnostics"]), "biome field");
  if (d.schema.value !== BIOME_FIELD_SCHEMA || d.version.value !== BIOME_FIELD_VERSION) fail("biome field schema/version is unsupported");
  const grid = d.grid.value;
  const cells = grid.rows * grid.cols;
  const topN = d.topN.value;
  if (!(d.indices.value instanceof Uint16Array) || !(d.weights.value instanceof Uint16Array) || d.indices.value.length !== cells * topN || d.weights.value.length !== cells * topN) fail("biome field typed-array dimensions are invalid");
  for (let cell = 0; cell < cells; cell++) {
    let sum = 0;
    let priorWeight = Infinity;
    for (let rank = 0; rank < topN; rank++) {
      const offset = cell * topN + rank;
      const index = d.indices.value[offset], weight = d.weights.value[offset];
      if (index === BIOME_FIELD_NONE) { if (weight !== 0) fail("biome field empty rank has nonzero weight"); continue; }
      if (index >= d.biomeIds.value.length || weight > priorWeight) fail("biome field rank is invalid or unsorted");
      priorWeight = weight;
      sum += weight;
    }
    if (sum !== BIOME_FIELD_WEIGHT_TOTAL) fail(`biome field cell ${cell} weights do not normalize exactly`);
  }
  return field;
}
