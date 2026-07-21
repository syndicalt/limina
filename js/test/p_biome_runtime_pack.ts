import {
  BIOME_RUNTIME_PACK_LIMITS,
  BIOME_RUNTIME_PACK_SCHEMA,
  BiomeRuntimePackValidationError,
  biomeRuntimePackContentHash,
  parseBiomeRuntimePack,
  stableStringifyBiomeRuntimePack,
} from "../src/world/biome-runtime-pack.mjs";
import { biomePackContentHash } from "../src/world/biome-ir.mjs";
import { BIOME_LIBRARY_V1 } from "../src/world/biome-library-v1.mjs";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`p_biome_runtime_pack FAIL: ${message}`);
}
function rejects(fn: () => unknown, pattern: RegExp, message: string): void {
  let error: unknown;
  try { fn(); } catch (caught) { error = caught; }
  assert(error instanceof BiomeRuntimePackValidationError || error instanceof Error, `${message}: did not throw`);
  assert(pattern.test(error.message), `${message}: ${error.message}`);
}
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const hash = (digit: string): string => `sha256:${digit.repeat(64)}`;

const metadataPackContentHash = biomePackContentHash(BIOME_LIBRARY_V1);
const metadataOnly40 = {
  schema: BIOME_RUNTIME_PACK_SCHEMA,
  id: "limina-biome-runtime-core",
  version: "1.0.0",
  metadataPackContentHash,
  status: "metadata-only",
  biomes: BIOME_LIBRARY_V1.definitions.map((definition) => ({
    biomeId: definition.id,
    status: "metadata-only",
    surfaceRules: definition.surfaceMaterials.slice(0, BIOME_RUNTIME_PACK_LIMITS.surfaceRules)
      .map(({ role }) => ({ role, weight: 1, tileScaleM: 4 })).sort((left, right) => left.role.localeCompare(right.role)),
    vegetationRules: definition.vegetationPalette.slice(0, BIOME_RUNTIME_PACK_LIMITS.vegetationRules)
      .map(({ role, weight }) => ({
        role, weight, radiusM: 1.5, density01: 0.5, scale: [0.8, 1.2],
        slope01: [0, 0.8], elevationM: [-500, 8_000], moisture01: [0, 1],
        waterDistanceM: [0, 100_000], tintSrgb: [255, 255, 255],
      })).sort((left, right) => left.role.localeCompare(right.role)),
    bindings: [],
  })),
};

const parsed40 = parseBiomeRuntimePack(metadataOnly40, BIOME_LIBRARY_V1);
assert(parsed40.biomes.length === 40 && parsed40.status === "metadata-only",
  "provided 40-biome metadata authority was not accepted as an explicit metadata-only runtime pack");
assert(Object.isFrozen(parsed40) && Object.isFrozen(parsed40.biomes)
  && Object.isFrozen(parsed40.biomes[0].surfaceRules), "parsed runtime pack exposes mutable contract containers");

const canonical = stableStringifyBiomeRuntimePack(metadataOnly40, BIOME_LIBRARY_V1);
const address = biomeRuntimePackContentHash(metadataOnly40, BIOME_LIBRARY_V1);
assert(/^sha256:[0-9a-f]{64}$/.test(address), "runtime pack hash is not a canonical content address");
const reorderedKeys = {
  biomes: clone(metadataOnly40.biomes),
  status: metadataOnly40.status,
  metadataPackContentHash,
  version: metadataOnly40.version,
  id: metadataOnly40.id,
  schema: metadataOnly40.schema,
};
assert(stableStringifyBiomeRuntimePack(reorderedKeys, BIOME_LIBRARY_V1) === canonical
  && biomeRuntimePackContentHash(reorderedKeys, BIOME_LIBRARY_V1) === address,
"object insertion order changed canonical bytes or runtime pack address");
const changed = clone(metadataOnly40) as any;
changed.biomes[0].surfaceRules[0].weight = 2;
assert(biomeRuntimePackContentHash(changed, BIOME_LIBRARY_V1) !== address,
  "runtime rule mutation did not change content identity");

const alpine = BIOME_LIBRARY_V1.definitions.find((definition) => definition.id === "alpine")!;
const partial = {
  schema: BIOME_RUNTIME_PACK_SCHEMA,
  id: "alpine-runtime",
  version: "1.0.0",
  metadataPackContentHash,
  status: "partial",
  biomes: [{
    biomeId: "alpine",
    status: "partial",
    surfaceRules: alpine.surfaceMaterials.map(({ role }) => ({ role, weight: 1, tileScaleM: 4 }))
      .sort((left, right) => left.role.localeCompare(right.role)),
    vegetationRules: alpine.vegetationPalette.map(({ role, weight }) => ({
      role, weight, radiusM: 0.75, density01: 0.6, scale: [0.7, 1.4], tintSrgb: [210, 225, 205],
    })).sort((left, right) => left.role.localeCompare(right.role)),
    bindings: [{
      kind: "surface", role: alpine.surfaceMaterials[0].role,
      assetId: "materials/alpine-turf", contentHash: hash("a"), licenseId: "CC0-1.0", sourceUri: "https://example.invalid/alpine-turf",
    }],
  }],
};
assert(parseBiomeRuntimePack(partial, BIOME_LIBRARY_V1).status === "partial",
  "partially content-addressed rules did not derive partial status");
const fulfilled = clone(partial) as any;
fulfilled.status = "fulfilled";
fulfilled.biomes[0].status = "fulfilled";
fulfilled.biomes[0].bindings = [
  ...fulfilled.biomes[0].surfaceRules.map((rule: any, index: number) => ({
    kind: "surface", role: rule.role, assetId: `materials/alpine-${index}`, contentHash: hash(index === 0 ? "a" : "b"),
    licenseId: "CC0-1.0", sourceUri: `https://example.invalid/materials/alpine-${index}`,
  })),
  ...fulfilled.biomes[0].vegetationRules.map((rule: any, index: number) => ({
    kind: "vegetation", role: rule.role, assetId: `vegetation/alpine-${index}`, contentHash: hash(index === 0 ? "c" : "d"),
    licenseId: "CC0-1.0", sourceUri: `https://example.invalid/vegetation/alpine-${index}`,
  })),
].sort((left, right) => `${left.kind}:${left.role}`.localeCompare(`${right.kind}:${right.role}`));
assert(parseBiomeRuntimePack(fulfilled, BIOME_LIBRARY_V1).status === "fulfilled",
  "fully content-addressed rules did not derive fulfilled status");

const unknownBiome = clone(metadataOnly40) as any;
unknownBiome.biomes[0].biomeId = "unknown-biome";
rejects(() => parseBiomeRuntimePack(unknownBiome, BIOME_LIBRARY_V1), /unknown biome/, "unknown biome ID was accepted");
const undeclaredSurface = clone(metadataOnly40) as any;
undeclaredSurface.biomes[0].surfaceRules[0].role = "ground/not-declared";
rejects(() => parseBiomeRuntimePack(undeclaredSurface, BIOME_LIBRARY_V1), /not declared by biome/, "undeclared surface role was accepted");
const undeclaredVegetation = clone(metadataOnly40) as any;
undeclaredVegetation.biomes[0].vegetationRules[0].role = "flora/not-declared";
rejects(() => parseBiomeRuntimePack(undeclaredVegetation, BIOME_LIBRARY_V1), /not declared by biome/, "undeclared vegetation role was accepted");
const unknownBinding = clone(partial) as any;
unknownBinding.biomes[0].bindings[0].role = "ground/not-a-runtime-rule";
rejects(() => parseBiomeRuntimePack(unknownBinding, BIOME_LIBRARY_V1), /undeclared runtime rule/, "binding to undeclared runtime rule was accepted");
const reorderedBiomes = clone(metadataOnly40) as any;
[reorderedBiomes.biomes[0], reorderedBiomes.biomes[1]] = [reorderedBiomes.biomes[1], reorderedBiomes.biomes[0]];
rejects(() => parseBiomeRuntimePack(reorderedBiomes, BIOME_LIBRARY_V1), /biomeId-sorted/, "reordered biome entries were silently canonicalized");
const duplicateRules = clone(partial) as any;
duplicateRules.biomes[0].surfaceRules[1].role = duplicateRules.biomes[0].surfaceRules[0].role;
rejects(() => parseBiomeRuntimePack(duplicateRules, BIOME_LIBRARY_V1), /role-sorted/, "duplicate surface rule was accepted");
const reorderedBindings = clone(fulfilled) as any;
reorderedBindings.biomes[0].bindings.reverse();
rejects(() => parseBiomeRuntimePack(reorderedBindings, BIOME_LIBRARY_V1), /kind\/role-sorted/, "reordered bindings were accepted");
const negativeZero = clone(partial) as any;
negativeZero.biomes[0].vegetationRules[0].density01 = -0;
rejects(() => parseBiomeRuntimePack(negativeZero, BIOME_LIBRARY_V1), /canonical number/, "negative zero was accepted");
const lyingStatus = clone(partial) as any;
lyingStatus.status = "fulfilled";
rejects(() => parseBiomeRuntimePack(lyingStatus, BIOME_LIBRARY_V1), /status must be 'partial'/, "lying pack fulfillment was accepted");
const wrongMetadataHash = clone(metadataOnly40) as any;
wrongMetadataHash.metadataPackContentHash = hash("f");
rejects(() => parseBiomeRuntimePack(wrongMetadataHash, BIOME_LIBRARY_V1), /does not match/, "wrong metadata authority hash was accepted");
const badHash = clone(partial) as any;
badHash.biomes[0].bindings[0].contentHash = "sha256:nope";
rejects(() => parseBiomeRuntimePack(badHash, BIOME_LIBRARY_V1), /contentHash.*invalid/, "noncanonical binding hash was accepted");
const tooManyBiomes = clone(metadataOnly40) as any;
tooManyBiomes.biomes = Array.from({ length: 65 }, () => tooManyBiomes.biomes[0]);
rejects(() => parseBiomeRuntimePack(tooManyBiomes, BIOME_LIBRARY_V1), /at most 64/, "biome cap was not enforced before traversal");
const tooManySurfaces = clone(partial) as any;
tooManySurfaces.biomes[0].surfaceRules = Array.from({ length: 5 }, () => tooManySurfaces.biomes[0].surfaceRules[0]);
rejects(() => parseBiomeRuntimePack(tooManySurfaces, BIOME_LIBRARY_V1), /at most 4/, "surface rule cap was not enforced before traversal");
const tooManyVegetation = clone(partial) as any;
tooManyVegetation.biomes[0].vegetationRules = Array.from({ length: 9 }, () => tooManyVegetation.biomes[0].vegetationRules[0]);
rejects(() => parseBiomeRuntimePack(tooManyVegetation, BIOME_LIBRARY_V1), /at most 8/, "vegetation rule cap was not enforced before traversal");
const unknownField = clone(partial) as any;
unknownField.biomes[0].vegetationRules[0].surprise = true;
rejects(() => parseBiomeRuntimePack(unknownField, BIOME_LIBRARY_V1), /unknown field/, "unknown rule field was accepted");
const sparse = clone(metadataOnly40) as any;
delete sparse.biomes[3];
rejects(() => parseBiomeRuntimePack(sparse, BIOME_LIBRARY_V1), /dense/, "sparse biome array was accepted");

console.log(`p_biome_runtime_pack OK: 40 metadata biomes, strict bounded rules, derived fulfillment, ${address}`);
