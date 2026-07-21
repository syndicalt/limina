import {
  BIOME_DEF_SCHEMA,
  BIOME_PACK_SCHEMA,
  BiomeIrValidationError,
  biomeDefContentHash,
  biomePackContentHash,
  inspectBiomeFulfillment,
  parseBiomeDef,
  parseBiomePack,
  stableStringifyBiomePack,
} from "../src/world/biome-ir.mjs";
import { BIOME_LIBRARY_V1 } from "../src/world/biome-library-v1.mjs";
import { BiomeRegistry } from "../src/world/biome-registry.mjs";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`p_biome_ir FAIL: ${message}`);
}
function rejects(fn: () => unknown, pattern: RegExp, message: string): void {
  let error: unknown;
  try { fn(); } catch (caught) { error = caught; }
  assert(error instanceof BiomeIrValidationError || error instanceof Error, `${message}: did not throw`);
  assert(pattern.test(error.message), `${message}: ${error.message}`);
}
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

assert(BIOME_LIBRARY_V1.schema === BIOME_PACK_SCHEMA && BIOME_LIBRARY_V1.definitions.length === 40,
  "core library is not the approved full approximately-40 metadata taxonomy");
assert(BIOME_LIBRARY_V1.definitions.every((definition, index, all) => definition.schema === BIOME_DEF_SCHEMA
  && (index === 0 || all[index - 1].id < definition.id)), "core definitions are not schema-valid and deterministically ordered");
const categories = new Set(BIOME_LIBRARY_V1.definitions.map((definition) => definition.taxonomy.category));
for (const category of ["terrestrial", "aquatic", "wetland", "geological", "fantasy"]) {
  assert(categories.has(category), `core taxonomy omits ${category}`);
}
for (const required of ["tundra", "mangrove", "coral-reef", "glacier", "floating-island", "fungal", "crystal", "blighted-waste", "nether"]) {
  assert(BIOME_LIBRARY_V1.definitions.some((definition) => definition.id === required), `core taxonomy omits ${required}`);
}
for (const definition of BIOME_LIBRARY_V1.definitions) {
  const fulfillment = inspectBiomeFulfillment(definition);
  assert(fulfillment.status === "metadata-only" && fulfillment.bound === 0 && fulfillment.required > 0
    && fulfillment.missing.length === fulfillment.required, `${definition.id} falsely claims fulfilled production content`);
}

const canonical = stableStringifyBiomePack(BIOME_LIBRARY_V1);
const hash = biomePackContentHash(BIOME_LIBRARY_V1);
assert(/^sha256:[0-9a-f]{64}$/.test(hash), "pack hash is not a canonical content address");
assert(hash === "sha256:866158ef46124b417f9cabd07a43fe28e48ea6e3896554beddd886ebaeffba10",
  "core biome pack canonical vector changed without an explicit schema/version decision");
const alpineHash = biomeDefContentHash(BIOME_LIBRARY_V1.definitions[0]);
assert(/^sha256:[0-9a-f]{64}$/.test(alpineHash), "definition hash is not a canonical content address");
const reorderedKeys = {
  provenance: clone(BIOME_LIBRARY_V1.provenance),
  legacyAliases: clone(BIOME_LIBRARY_V1.legacyAliases),
  definitions: clone(BIOME_LIBRARY_V1.definitions),
  version: BIOME_LIBRARY_V1.version,
  id: BIOME_LIBRARY_V1.id,
  schema: BIOME_LIBRARY_V1.schema,
};
assert(stableStringifyBiomePack(reorderedKeys) === canonical && biomePackContentHash(reorderedKeys) === hash,
  "object insertion order changed canonical bytes or content address");

const mutations: Array<[string, (pack: any) => void]> = [
  ["climate", (pack) => { pack.definitions[0].climate.temperatureC.max += 1; }],
  ["surface order", (pack) => { pack.definitions[0].surfaceMaterials.reverse(); }],
  ["vegetation weight", (pack) => { pack.definitions[0].vegetationPalette[0].weight += 1; }],
  ["resource ref", (pack) => { pack.definitions[0].resourceTableRefs[0] += "-v2"; }],
  ["spawn ref", (pack) => { pack.definitions[0].spawnTableRefs[0] += "-v2"; }],
  ["water tint", (pack) => { pack.definitions[0].waterTintSrgb[0] += 1; }],
  ["ambient audio", (pack) => { pack.definitions[0].ambientAudioRefs[0] += "-v2"; }],
  ["provenance", (pack) => { pack.definitions[0].provenance.sourceUri += "-v2"; }],
];
for (const [label, mutate] of mutations) {
  const changed = clone(BIOME_LIBRARY_V1) as any;
  mutate(changed);
  assert(biomePackContentHash(changed) !== hash, `${label} mutation did not change pack identity`);
}

const partiallyBound = clone(BIOME_LIBRARY_V1) as any;
const first = partiallyBound.definitions[0];
first.fulfillment.status = "partial";
first.fulfillment.bindings = [{
  kind: "ambient-audio",
  ref: first.ambientAudioRefs[0],
  assetId: "audio/alpine-wind.ogg",
  contentHash: `sha256:${"a".repeat(64)}`,
  licenseId: "CC0-1.0",
  sourceUri: "https://example.invalid/alpine-wind",
}];
assert(parseBiomePack(partiallyBound).definitions[0].fulfillment.status === "partial"
  && biomePackContentHash(partiallyBound) !== hash, "provenance-bearing partial fulfillment did not affect identity");

const unknown = clone(BIOME_LIBRARY_V1) as any;
unknown.definitions[0].surprise = true;
rejects(() => parseBiomePack(unknown), /unknown field/, "unknown definition field was accepted");
const accessor = clone(BIOME_LIBRARY_V1) as any;
Object.defineProperty(accessor.definitions[0], "displayName", { enumerable: true, get: () => "hostile" });
rejects(() => parseBiomePack(accessor), /data field/, "definition accessor was invoked or accepted");
const polluted = clone(BIOME_LIBRARY_V1) as any;
Object.setPrototypeOf(polluted.definitions[0], { polluted: true });
rejects(() => parseBiomePack(polluted), /plain object/, "polluted definition prototype was accepted");
const sparse = clone(BIOME_LIBRARY_V1) as any;
delete sparse.definitions[3];
rejects(() => parseBiomePack(sparse), /dense/, "sparse definitions were accepted");
const unsorted = clone(BIOME_LIBRARY_V1) as any;
[unsorted.definitions[0], unsorted.definitions[1]] = [unsorted.definitions[1], unsorted.definitions[0]];
rejects(() => parseBiomePack(unsorted), /id-sorted/, "unsorted definitions were canonicalized silently");
const duplicateSurface = clone(BIOME_LIBRARY_V1) as any;
duplicateSurface.definitions[0].surfaceMaterials[1].role = duplicateSurface.definitions[0].surfaceMaterials[0].role;
rejects(() => parseBiomePack(duplicateSurface), /duplicates role/, "duplicate ordered surface role was accepted");
const duplicateVegetation = clone(BIOME_LIBRARY_V1) as any;
duplicateVegetation.definitions[0].vegetationPalette[1].role = duplicateVegetation.definitions[0].vegetationPalette[0].role;
rejects(() => parseBiomePack(duplicateVegetation), /role-sorted/, "duplicate vegetation role was accepted");
const negativeZero = clone(BIOME_LIBRARY_V1) as any;
negativeZero.definitions[0].climate.moisture01.min = -0;
rejects(() => parseBiomePack(negativeZero), /canonical number/, "negative zero climate value was accepted");
const lyingStatus = clone(BIOME_LIBRARY_V1) as any;
lyingStatus.definitions[0].fulfillment.status = "fulfilled";
rejects(() => parseBiomePack(lyingStatus), /must be 'metadata-only'/, "unbound definition claimed fulfilled status");
const undeclaredBinding = clone(partiallyBound) as any;
undeclaredBinding.definitions[0].fulfillment.bindings[0].ref = "audio/ambient/not-declared";
rejects(() => parseBiomePack(undeclaredBinding), /not declared/, "binding to an undeclared role was accepted");
const badHash = clone(partiallyBound) as any;
badHash.definitions[0].fulfillment.bindings[0].contentHash = "sha256:nope";
rejects(() => parseBiomePack(badHash), /contentHash.*invalid/, "noncanonical binding hash was accepted");
const duplicateAlias = clone(BIOME_LIBRARY_V1) as any;
duplicateAlias.legacyAliases[1].legacyKind = duplicateAlias.legacyAliases[0].legacyKind;
rejects(() => parseBiomePack(duplicateAlias), /legacyKind-sorted/, "duplicate legacy alias was accepted");
const tooMany = clone(BIOME_LIBRARY_V1) as any;
tooMany.definitions = Array.from({ length: 65 }, () => tooMany.definitions[0]);
rejects(() => parseBiomePack(tooMany), /at most 64/, "definition cap was not enforced before traversal");

const parsedDef = parseBiomeDef(BIOME_LIBRARY_V1.definitions[0]);
assert(Object.isFrozen(parsedDef) && Object.isFrozen(parsedDef.climate) && Object.isFrozen(parsedDef.surfaceMaterials),
  "parsed definition exposes mutable contract containers");
const registry = new BiomeRegistry();
const installed = registry.install(BIOME_LIBRARY_V1);
const repeated = registry.install(clone(BIOME_LIBRARY_V1));
assert(installed.installed && !repeated.installed && installed.address === hash && repeated.address === hash,
  "registry install is not content-addressed and idempotent");
assert(registry.definitions().length === 40 && registry.definition("tundra", "1.0.1")?.displayName === "Tundra",
  "registry did not index the full deterministic definition set");
assert(registry.definitionAddress("alpine", "1.0.1") === alpineHash,
  "registry did not retain the definition-level content address");
assert(registry.resolveLegacy("limina-biomes-core", "1.0.1", "forest")?.id === "temperate-deciduous-forest"
  && registry.resolveLegacy("limina-biomes-core", "1.0.1", "unknown") === null,
  "legacy coexistence aliases do not resolve explicitly and non-destructively");
const independentDefinitionVersion = clone(BIOME_LIBRARY_V1) as any;
independentDefinitionVersion.id = "independent-version-pack";
independentDefinitionVersion.version = "2.0.0";
const independentRegistry = new BiomeRegistry();
independentRegistry.install(independentDefinitionVersion);
assert(independentRegistry.resolveLegacy("independent-version-pack", "2.0.0", "forest")?.version === "1.0.1",
  "legacy resolution incorrectly assumed definition version equals pack version");
const conflictingPack = clone(BIOME_LIBRARY_V1) as any;
conflictingPack.definitions[0].displayName = "Different Alpine";
rejects(() => registry.install(conflictingPack), /conflicts with installed content/, "same pack version accepted conflicting bytes");
const duplicateOwner = clone(BIOME_LIBRARY_V1) as any;
duplicateOwner.id = "another-pack";
rejects(() => registry.install(duplicateOwner), /already owned/, "another pack captured an installed definition version");

console.log(`p_biome_ir OK: ${BIOME_LIBRARY_V1.definitions.length} metadata-only definitions, ${hash}, strict hostile input, hash sensitivity, explicit legacy aliases, content-addressed idempotent registry`);
