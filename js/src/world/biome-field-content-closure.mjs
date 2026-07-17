// Exact field-domain fulfillment for a compiled biome snapshot. Metadata biomes that never appear
// in the field are intentionally outside this closure; every nonzero field influence is mandatory.

import { BIOME_FIELD_NONE } from "./biome-field.mjs";
import { biomePackContentHash, parseBiomePack } from "./biome-ir.mjs";
import { biomeRuntimePackContentHash, parseBiomeRuntimePack } from "./biome-runtime-pack.mjs";
import { biomeFieldArtifactContentHash, decodeBiomeFieldArtifact } from "./compiler/biome-field-artifact.mjs";
import { sha256 } from "./sha256.mjs";

export const BIOME_FIELD_CONTENT_CLOSURE_SCHEMA = "limina.biome-field-content-closure/v1";
const HASH = /^sha256:[0-9a-f]{64}$/;

export class BiomeFieldContentClosureError extends Error {
  constructor(message) { super(message); this.name = "BiomeFieldContentClosureError"; }
}
function fail(message) { throw new BiomeFieldContentClosureError(message); }
function hash(value, label) {
  if (typeof value !== "string" || !HASH.test(value)) fail(`${label} must be a canonical content hash`);
  return value;
}
function inputRecord(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    fail("biome field content closure input must be a plain object");
  }
  const keys = Object.keys(value).sort();
  const expected = ["fieldArtifactBytes", "fieldContentHash", "metadataPack", "runtimePack", "runtimePackContentHash"].sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    fail(`biome field content closure input must contain exactly: ${expected.join(", ")}`);
  }
  return value;
}
function freezeArray(values) { return Object.freeze(values.map((value) => Object.freeze(value))); }

export function deriveBiomeFieldContentClosure(value) {
  const input = inputRecord(value);
  const fieldContentHash = hash(input.fieldContentHash, "biome field content hash");
  const runtimePackContentHash = hash(input.runtimePackContentHash, "biome runtime pack content hash");
  if (biomeFieldArtifactContentHash(input.fieldArtifactBytes) !== fieldContentHash) fail("biome field artifact content hash mismatch");
  const decoded = decodeBiomeFieldArtifact(input.fieldArtifactBytes);
  const metadataPack = parseBiomePack(input.metadataPack);
  const metadataPackContentHash = biomePackContentHash(metadataPack);
  if (decoded.field.pack.id !== metadataPack.id || decoded.field.pack.version !== metadataPack.version) {
    fail("biome field metadata authority does not match the supplied metadata pack");
  }
  const runtimePack = parseBiomeRuntimePack(input.runtimePack, metadataPack);
  if (biomeRuntimePackContentHash(runtimePack, metadataPack) !== runtimePackContentHash) fail("biome runtime pack content hash mismatch");

  const reachable = new Set();
  for (let offset = 0; offset < decoded.field.indices.length; offset++) {
    const index = decoded.field.indices[offset];
    if (index === BIOME_FIELD_NONE || decoded.field.weights[offset] === 0) continue;
    const biomeId = decoded.field.biomeIds[index];
    if (biomeId === undefined) fail(`biome field influence ${offset} references an unknown biome index`);
    reachable.add(biomeId);
  }
  const definitions = new Map(metadataPack.definitions.map((definition) => [definition.id, definition]));
  const runtimeBiomes = new Map(runtimePack.biomes.map((biome) => [biome.biomeId, biome]));
  const missing = [];
  const biomes = [];
  for (const biomeId of [...reachable].sort()) {
    const definition = definitions.get(biomeId);
    if (definition === undefined) fail(`biome field references unknown metadata biome '${biomeId}'`);
    const runtimeBiome = runtimeBiomes.get(biomeId);
    const surfaceRoles = definition.surfaceMaterials.map((entry) => entry.role).sort();
    const vegetationRoles = definition.vegetationPalette.map((entry) => entry.role).sort();
    if (runtimeBiome === undefined) {
      missing.push({ biomeId, kind: "biome", role: biomeId });
    } else {
      const bound = new Set(runtimeBiome.bindings.map((binding) => `${binding.kind}:${binding.role}`));
      for (const role of surfaceRoles) if (!bound.has(`surface:${role}`)) missing.push({ biomeId, kind: "surface", role });
      for (const role of vegetationRoles) if (!bound.has(`vegetation:${role}`)) missing.push({ biomeId, kind: "vegetation", role });
    }
    biomes.push({ biomeId, surfaceRoles: Object.freeze(surfaceRoles), vegetationRoles: Object.freeze(vegetationRoles) });
  }
  missing.sort((left, right) => `${left.biomeId}:${left.kind}:${left.role}`.localeCompare(`${right.biomeId}:${right.kind}:${right.role}`));
  if (missing.length !== 0) {
    fail(`reachable biome content is incomplete: ${missing.map((entry) => `${entry.biomeId}:${entry.kind}:${entry.role}`).join(", ")}`);
  }
  const core = Object.freeze({
    schema: BIOME_FIELD_CONTENT_CLOSURE_SCHEMA,
    fieldContentHash,
    runtimePackContentHash,
    metadataPackContentHash,
    reachableBiomes: freezeArray(biomes),
  });
  return Object.freeze({ ...core, closureHash: `sha256:${sha256(JSON.stringify(core))}` });
}

