// Immutable B3 bridge: verified compiler biome-field bytes + a verified runtime content pack.
// This remains pure CPU/data. Renderers and population planners consume resolved samples; neither
// is allowed to invent a fallback for an unbound symbolic role.

import { BIOME_FIELD_WEIGHT_TOTAL } from "./biome-field.mjs";
import { createBiomeFieldSampler } from "./biome-field-sampler.mjs";
import { parseBiomePack } from "./biome-ir.mjs";
import { biomeRuntimePackContentHash, parseBiomeRuntimePack } from "./biome-runtime-pack.mjs";
import { biomeFieldArtifactContentHash, decodeBiomeFieldArtifact } from "./compiler/biome-field-artifact.mjs";

const HASH = /^sha256:[0-9a-f]{64}$/;
const MAX_SURFACE_SAMPLE_ROLES = 16;
const MAX_VEGETATION_SAMPLE_RULES = 32;

function expectedHash(value, label) {
  if (typeof value !== "string" || !HASH.test(value)) throw new TypeError(`${label} must be a canonical content hash`);
  return value;
}

function quantize(entries, limit) {
  const selected = entries.slice(0, limit);
  const total = selected.reduce((sum, entry) => sum + entry.score, 0);
  if (!(total > 0)) return Object.freeze([]);
  const parts = selected.map((entry) => {
    const exact = entry.score / total * BIOME_FIELD_WEIGHT_TOTAL;
    const weightU16 = Math.floor(exact);
    return { ...entry, weightU16, remainder: exact - weightU16 };
  });
  let remaining = BIOME_FIELD_WEIGHT_TOTAL - parts.reduce((sum, entry) => sum + entry.weightU16, 0);
  const remainderOrder = [...parts].sort((left, right) => right.remainder - left.remainder || left.key.localeCompare(right.key));
  for (let index = 0; remaining > 0; remaining--, index++) remainderOrder[index % remainderOrder.length].weightU16++;
  parts.sort((left, right) => right.weightU16 - left.weightU16 || left.key.localeCompare(right.key));
  return Object.freeze(parts.map(({ remainder: _remainder, score: _score, key: _key, ...entry }) => Object.freeze({
    ...entry, weightU16: entry.weightU16, weight01: entry.weightU16 / BIOME_FIELD_WEIGHT_TOTAL,
  })));
}

function mergeResolved(entries, limit) {
  const merged = new Map();
  for (const entry of entries) {
    const key = `${entry.binding.assetId}\u0000${entry.binding.contentHash}\u0000${entry.role}\u0000${JSON.stringify(entry.rule)}`;
    const current = merged.get(key);
    if (current === undefined) merged.set(key, { key, role: entry.role, binding: entry.binding, rule: entry.rule, score: entry.score });
    else current.score += entry.score;
  }
  return quantize([...merged.values()].sort((left, right) => right.score - left.score || left.key.localeCompare(right.key)), limit);
}

export class BiomeRuntimePublication {
  #disposed = false;
  #sampler;
  #biomes;

  constructor(input) {
    if (input === null || typeof input !== "object" || Array.isArray(input)) throw new TypeError("biome runtime publication input must be an object");
    const metadataPack = parseBiomePack(input.metadataPack);
    const fieldHash = expectedHash(input.fieldContentHash, "biome field hash");
    const runtimeHash = expectedHash(input.runtimePackContentHash, "biome runtime pack hash");
    if (biomeFieldArtifactContentHash(input.fieldArtifactBytes) !== fieldHash) throw new Error("biome field artifact content hash mismatch");
    const decoded = decodeBiomeFieldArtifact(input.fieldArtifactBytes);
    if (decoded.field.pack.id !== metadataPack.id || decoded.field.pack.version !== metadataPack.version) {
      throw new Error("biome field metadata authority does not match the runtime publication");
    }
    const runtimePack = parseBiomeRuntimePack(input.runtimePack, metadataPack);
    if (biomeRuntimePackContentHash(runtimePack, metadataPack) !== runtimeHash) throw new Error("biome runtime pack content hash mismatch");
    const fieldBiomeIds = new Set(decoded.field.biomeIds);
    const metadataIds = new Set(metadataPack.definitions.map((definition) => definition.id));
    for (const id of fieldBiomeIds) if (!metadataIds.has(id)) throw new Error(`biome field references unknown metadata biome '${id}'`);

    this.fieldContentHash = fieldHash;
    this.runtimePackContentHash = runtimeHash;
    this.metadataPackContentHash = runtimePack.metadataPackContentHash;
    this.#sampler = createBiomeFieldSampler(decoded.field);
    // Bindings and rule totals are publication invariants. Rebuilding these maps and reducing the
    // same arrays for every dense terrain sample dominated continuous-grass activation.
    this.#biomes = new Map(runtimePack.biomes.map((biome) => [biome.biomeId, Object.freeze({
      biome,
      bindings: new Map(biome.bindings.map((binding) => [`${binding.kind}:${binding.role}`, binding])),
      surfaceTotal: biome.surfaceRules.reduce((sum, rule) => sum + rule.weight, 0),
      vegetationTotal: biome.vegetationRules.reduce((sum, rule) => sum + rule.weight, 0),
    })]));
    Object.freeze(this);
  }

  get disposed() { return this.#disposed; }

  sample(x, z) {
    if (this.#disposed) throw new Error("biome runtime publication is disposed");
    const sample = this.#sampler.sample(x, z);
    if (sample === null) return null;
    const surfaces = [], vegetation = [], unbound = [];
    for (const influence of sample.influences.slice(0, 4)) {
      const resolved = this.#biomes.get(influence.biomeId);
      if (resolved === undefined) {
        unbound.push(Object.freeze({ biomeId: influence.biomeId, kind: "biome", role: influence.biomeId }));
        continue;
      }
      const { biome, bindings, surfaceTotal, vegetationTotal } = resolved;
      for (const rule of biome.surfaceRules) {
        const binding = bindings.get(`surface:${rule.role}`);
        if (binding === undefined) unbound.push(Object.freeze({ biomeId: biome.biomeId, kind: "surface", role: rule.role }));
        else surfaces.push({ role: rule.role, rule, binding, score: influence.weight01 * rule.weight / surfaceTotal });
      }
      for (const rule of biome.vegetationRules) {
        const binding = bindings.get(`vegetation:${rule.role}`);
        if (binding === undefined) unbound.push(Object.freeze({ biomeId: biome.biomeId, kind: "vegetation", role: rule.role }));
        else if (vegetationTotal > 0) vegetation.push({ role: rule.role, rule, binding,
          score: influence.weight01 * rule.weight / vegetationTotal * rule.density01 });
      }
    }
    unbound.sort((left, right) => `${left.biomeId}:${left.kind}:${left.role}`.localeCompare(`${right.biomeId}:${right.kind}:${right.role}`));
    const vegetationDensity01 = Math.max(0, Math.min(1, vegetation.reduce((sum, entry) => sum + entry.score, 0)));
    return Object.freeze({
      dominantId: sample.dominantId,
      influences: sample.influences,
      status: unbound.length === 0 ? "fulfilled" : "unfulfilled",
      surfaces: mergeResolved(surfaces, MAX_SURFACE_SAMPLE_ROLES),
      vegetation: mergeResolved(vegetation, MAX_VEGETATION_SAMPLE_RULES),
      vegetationDensity01,
      unbound: Object.freeze(unbound),
      identity: Object.freeze({ fieldContentHash: this.fieldContentHash, runtimePackContentHash: this.runtimePackContentHash }),
    });
  }

  /** Exact vegetation projection for dense consumers such as continuous grass. This deliberately
   * skips surface-role materialization and unbound diagnostics while retaining the same field
   * interpolation, contribution merge, stable ordering, u16 quantization, and density scalar as
   * sample().vegetation. */
  sampleVegetation(x, z) {
    if (this.#disposed) throw new Error("biome runtime publication is disposed");
    const sample = this.#sampler.sample(x, z);
    if (sample === null) return null;
    const vegetation = [];
    for (const influence of sample.influences.slice(0, 4)) {
      const resolved = this.#biomes.get(influence.biomeId);
      if (resolved === undefined) continue;
      const { biome, bindings, vegetationTotal } = resolved;
      for (const rule of biome.vegetationRules) {
        const binding = bindings.get(`vegetation:${rule.role}`);
        if (binding !== undefined && vegetationTotal > 0) vegetation.push({ role: rule.role, rule, binding,
          score: influence.weight01 * rule.weight / vegetationTotal * rule.density01 });
      }
    }
    const vegetationDensity01 = Math.max(0, Math.min(1, vegetation.reduce((sum, entry) => sum + entry.score, 0)));
    return Object.freeze({
      vegetation: mergeResolved(vegetation, MAX_VEGETATION_SAMPLE_RULES),
      vegetationDensity01,
    });
  }

  dispose() {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#biomes.clear();
  }
}

export function createBiomeRuntimePublication(input) { return new BiomeRuntimePublication(input); }
