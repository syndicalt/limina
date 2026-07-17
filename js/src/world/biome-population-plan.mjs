// B3 pure population authority. Canonical heightfield candidates are selected by the immutable
// biome publication, then a hash-priority variable-radius filter enforces cross-page blue-noise
// spacing without consulting renderer geometry or streamed mesh order.

import { hashSeed } from "../terrain/scatter.ts";

export const BIOME_POPULATION_PLAN_SCHEMA = "limina.biome-population-plan/v1";
export const BIOME_POPULATION_LIMITS = Object.freeze({ candidates: 65_536, placements: 24_576, maxRadiusM: 24, pageSizeM: 48 });
export const BIOME_POPULATION_STRATA = Object.freeze(["shared", "canopy", "understory", "ground-cover"]);

function finite(value, label) { if (typeof value !== "number" || !Number.isFinite(value) || Object.is(value, -0)) throw new TypeError(`${label} must be a canonical finite number`); return value; }
function positive(value, maximum, label) { finite(value, label); if (!(value > 0) || value > maximum) throw new RangeError(`${label} must be in (0, ${maximum}]`); return value; }
function unit(value, label) { finite(value, label); if (value < 0 || value > 1) throw new RangeError(`${label} must be in [0, 1]`); return value; }
function hash01(seed, x, z, salt) { return hashSeed((seed ^ salt) | 0, x, z) / 4_294_967_296; }
function inBand(value, band) { return band === undefined || (value >= band[0] && value <= band[1]); }
function candidateKey(candidate) { return `${candidate.stratum ?? "shared"}:${candidate.cellZ}:${candidate.cellX}`; }

function stratumSalt(stratum) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < stratum.length; index++) {
    hash ^= stratum.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash | 0;
}

/** Order-independent Matérn-II thinning. The greatest hash priority wins within max(rA,rB). */
export function thinBiomePopulationCandidates(input) {
  const candidates = [...input];
  const byCell = new Map(candidates.map((candidate) => [candidateKey(candidate), candidate]));
  const kept = [];
  for (const candidate of candidates) {
    const search = Math.ceil(candidate.maxRadiusM / candidate.cellSizeM);
    let blocked = false;
    for (let dz = -search; dz <= search && !blocked; dz++) {
      for (let dx = -search; dx <= search; dx++) {
        const other = byCell.get(`${candidate.stratum ?? "shared"}:${candidate.cellZ + dz}:${candidate.cellX + dx}`);
        if (other === undefined || other === candidate) continue;
        const radius = Math.max(candidate.radiusM, other.radiusM);
        const ox = candidate.x - other.x, oz = candidate.z - other.z;
        if (ox * ox + oz * oz >= radius * radius) continue;
        if (other.priority > candidate.priority || (other.priority === candidate.priority && candidateKey(other) < candidateKey(candidate))) {
          blocked = true; break;
        }
      }
    }
    if (!blocked) kept.push(candidate);
  }
  return Object.freeze(kept.sort((left, right) => left.cellZ - right.cellZ || left.cellX - right.cellX));
}

export function buildBiomePopulationPlan(input) {
  if (input === null || typeof input !== "object" || Array.isArray(input)) throw new TypeError("biome population input must be an object");
  const publication = input.publication;
  if (publication === null || typeof publication !== "object" || typeof publication.sample !== "function" || publication.disposed === true) {
    throw new TypeError("biome population requires a live runtime publication");
  }
  if (typeof input.sampleSurface !== "function") throw new TypeError("biome population sampleSurface must be a function");
  const stratumForRole = input.stratumForRole ?? (() => "shared");
  if (typeof stratumForRole !== "function") throw new TypeError("biome population stratumForRole must be a function");
  if (!Number.isSafeInteger(input.seed)) throw new TypeError("biome population seed must be a safe integer");
  const bounds = input.bounds;
  if (!Array.isArray(bounds) || bounds.length !== 4) throw new TypeError("biome population bounds must be [minX,minZ,maxX,maxZ]");
  const [minX, minZ, maxX, maxZ] = bounds.map((value, index) => finite(value, `biome population bounds[${index}]`));
  if (!(maxX > minX) || !(maxZ > minZ)) throw new RangeError("biome population bounds must have positive area");
  const featureOrigin = input.featureOrigin ?? [0, 0];
  if (!Array.isArray(featureOrigin) || featureOrigin.length !== 2) throw new TypeError("biome population featureOrigin must be [x,z]");
  const originX = finite(featureOrigin[0], "biome population featureOrigin[0]"), originZ = finite(featureOrigin[1], "biome population featureOrigin[1]");
  const cellSizeM = positive(input.cellSizeM ?? 2, 24, "biome population cellSizeM");
  const pageSizeM = positive(input.pageSizeM ?? BIOME_POPULATION_LIMITS.pageSizeM, 512, "biome population pageSizeM");
  const maxRadiusM = positive(input.maxRadiusM ?? BIOME_POPULATION_LIMITS.maxRadiusM, BIOME_POPULATION_LIMITS.maxRadiusM, "biome population maxRadiusM");
  const maxCandidates = input.maxCandidates ?? BIOME_POPULATION_LIMITS.candidates;
  const maxPlacements = input.maxPlacements ?? BIOME_POPULATION_LIMITS.placements;
  if (!Number.isSafeInteger(maxCandidates) || maxCandidates < 1 || maxCandidates > BIOME_POPULATION_LIMITS.candidates) throw new RangeError("biome population maxCandidates is invalid");
  if (!Number.isSafeInteger(maxPlacements) || maxPlacements < 1 || maxPlacements > BIOME_POPULATION_LIMITS.placements) throw new RangeError("biome population maxPlacements is invalid");

  const localMinX = minX - originX, localMaxX = maxX - originX, localMinZ = minZ - originZ, localMaxZ = maxZ - originZ;
  const pad = Math.ceil(maxRadiusM / cellSizeM);
  const cellMinX = Math.floor(localMinX / cellSizeM) - pad, cellMaxX = Math.ceil(localMaxX / cellSizeM) + pad;
  const cellMinZ = Math.floor(localMinZ / cellSizeM) - pad, cellMaxZ = Math.ceil(localMaxZ / cellSizeM) + pad;
  const cellCount = (cellMaxX - cellMinX + 1) * (cellMaxZ - cellMinZ + 1);
  if (!Number.isSafeInteger(cellCount) || cellCount > maxCandidates) throw new RangeError(`biome population candidate grid ${cellCount} exceeds cap ${maxCandidates}`);

  const candidates = [];
  for (let cellZ = cellMinZ; cellZ <= cellMaxZ; cellZ++) {
    for (let cellX = cellMinX; cellX <= cellMaxX; cellX++) {
      const x = originX + (cellX + hash01(input.seed, cellX, cellZ, 0x13579bdf)) * cellSizeM;
      const z = originZ + (cellZ + hash01(input.seed, cellX, cellZ, 0x2468ace0)) * cellSizeM;
      const biome = publication.sample(x, z);
      if (biome === null || biome.vegetation.length === 0 || !(biome.vegetationDensity01 > 0)) continue;
      const surface = input.sampleSurface(x, z);
      if (surface === null || typeof surface !== "object") continue;
      const y = finite(surface.y, "biome population surface.y"), slope01 = unit(surface.slope01, "biome population surface.slope01");
      const moisture01 = unit(surface.moisture01, "biome population surface.moisture01");
      const waterDistanceM = finite(surface.waterDistanceM, "biome population surface.waterDistanceM");
      if (waterDistanceM < 0) throw new RangeError("biome population surface.waterDistanceM must be non-negative");
      const strata = new Map();
      for (const entry of biome.vegetation) {
        const stratum = stratumForRole(entry.role, entry.binding);
        if (typeof stratum !== "string" || !BIOME_POPULATION_STRATA.includes(stratum)) {
          throw new TypeError(`biome population role '${entry.role}' resolved unsupported stratum '${String(stratum)}'`);
        }
        const entries = strata.get(stratum);
        if (entries === undefined) strata.set(stratum, [entry]); else entries.push(entry);
      }
      for (const [stratum, entries] of [...strata].sort((left, right) => left[0].localeCompare(right[0]))) {
        const salt = stratumSalt(stratum);
        if (hash01(input.seed ^ salt, cellX, cellZ, 0x5f356495) >= biome.vegetationDensity01) continue;
        const totalWeight = entries.reduce((sum, entry) => sum + entry.weight01, 0);
        const pick = hash01(input.seed ^ salt, cellX, cellZ, 0x6c8e9cf5) * totalWeight;
        let accumulated = 0, selected = entries[entries.length - 1];
        for (const entry of entries) { accumulated += entry.weight01; if (pick < accumulated) { selected = entry; break; } }
        const rule = selected.rule;
        if (hash01(input.seed ^ salt, cellX, cellZ, 0x3c6ef372) >= rule.density01) continue;
        if (!inBand(slope01, rule.slope01) || !inBand(y, rule.elevationM) || !inBand(moisture01, rule.moisture01)
            || !inBand(waterDistanceM, rule.waterDistanceM)) continue;
        if (rule.radiusM > maxRadiusM) throw new RangeError(`biome population rule '${rule.role}' radius exceeds planner maximum ${maxRadiusM}`);
        const scale = rule.scale[0] + hash01(input.seed ^ salt, cellX, cellZ, 0x7f4a7c15) * (rule.scale[1] - rule.scale[0]);
        candidates.push(Object.freeze({ stratum, cellX, cellZ, cellSizeM, maxRadiusM, x, y, z, radiusM: rule.radiusM,
          priority: hashSeed((input.seed ^ salt ^ 0x9e3779b9) | 0, cellX, cellZ), role: selected.role,
          assetId: selected.binding.assetId, contentHash: selected.binding.contentHash, scale,
          yaw: hash01(input.seed ^ salt, cellX, cellZ, 0x85ebca6b) * Math.PI * 2, tintSrgb: rule.tintSrgb }));
        if (candidates.length > maxCandidates) throw new RangeError(`biome population candidates exceed cap ${maxCandidates}`);
      }
    }
  }
  const thinned = thinBiomePopulationCandidates(candidates);
  const placements = thinned.filter((candidate) => candidate.x >= minX && candidate.x < maxX && candidate.z >= minZ && candidate.z < maxZ)
    .map((candidate) => Object.freeze({ role: candidate.role, assetId: candidate.assetId, contentHash: candidate.contentHash,
      x: candidate.x, y: candidate.y, z: candidate.z, localX: candidate.x - originX, localZ: candidate.z - originZ,
      yaw: candidate.yaw, scale: candidate.scale, tintSrgb: candidate.tintSrgb,
      pageX: Math.floor((candidate.x - originX) / pageSizeM), pageZ: Math.floor((candidate.z - originZ) / pageSizeM) }));
  if (placements.length > maxPlacements) throw new RangeError(`biome population placements ${placements.length} exceed cap ${maxPlacements}`);
  return Object.freeze({ schema: BIOME_POPULATION_PLAN_SCHEMA, seed: input.seed,
    identity: Object.freeze({ fieldContentHash: publication.fieldContentHash, runtimePackContentHash: publication.runtimePackContentHash }),
    featureOrigin: Object.freeze([originX, originZ]), bounds: Object.freeze([minX, minZ, maxX, maxZ]), cellSizeM, pageSizeM,
    candidates: candidates.length, placements: Object.freeze(placements) });
}
