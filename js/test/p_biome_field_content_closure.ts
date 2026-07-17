import { compileBiomeField } from "../src/world/biome-field.mjs";
import { deriveBiomeFieldContentClosure } from "../src/world/biome-field-content-closure.mjs";
import { BIOME_LIBRARY_V1 } from "../src/world/biome-library-v1.mjs";
import { biomePackContentHash } from "../src/world/biome-ir.mjs";
import { BIOME_RUNTIME_PACK_SCHEMA, biomeRuntimePackContentHash } from "../src/world/biome-runtime-pack.mjs";
import { biomeFieldArtifactContentHash, encodeBiomeFieldArtifact } from "../src/world/compiler/biome-field-artifact.mjs";

function assert(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(`p_biome_field_content_closure FAIL: ${message}`); }
const hash = (digit: string) => `sha256:${digit.repeat(64)}`;
const forest = BIOME_LIBRARY_V1.definitions.find((entry) => entry.id === "temperate-deciduous-forest")!;
function runtimePack(bound = true) {
  const bindings = bound ? [
    ...forest.surfaceMaterials.map(({ role }, index) => ({ kind: "surface", role, assetId: `materials/forest-${index}`,
      contentHash: hash(String(index + 1)), licenseId: "CC0-1.0", sourceUri: `https://example.invalid/surface-${index}` })),
    ...forest.vegetationPalette.map(({ role }, index) => ({ kind: "vegetation", role, assetId: `vegetation/forest-${index}`,
      contentHash: hash(String(index + 4)), licenseId: "CC0-1.0", sourceUri: `https://example.invalid/tree-${index}` })),
  ].sort((a, b) => `${a.kind}:${a.role}`.localeCompare(`${b.kind}:${b.role}`)) : [];
  return {
    schema: BIOME_RUNTIME_PACK_SCHEMA, id: "temperate-closure", version: "1.0.0",
    metadataPackContentHash: biomePackContentHash(BIOME_LIBRARY_V1), status: bound ? "fulfilled" : "metadata-only",
    biomes: [{ biomeId: forest.id, status: bound ? "fulfilled" : "metadata-only",
      surfaceRules: forest.surfaceMaterials.map(({ role }) => ({ role, weight: 1, tileScaleM: 4 })).sort((a, b) => a.role.localeCompare(b.role)),
      vegetationRules: forest.vegetationPalette.map(({ role, weight }) => ({ role, weight, radiusM: 2, density01: 0.7,
        scale: [0.9, 1.2], tintSrgb: [220, 235, 215] })).sort((a, b) => a.role.localeCompare(b.role)), bindings }],
  };
}
const cells = 4;
const targetIds = [forest.id];
const field = compileBiomeField({ pack: BIOME_LIBRARY_V1, grid: { origin: [0, 0], rows: 2, cols: 2, cellSizeM: 8 },
  samples: { temperatureC: new Float32Array(cells).fill(12), moisture01: new Float32Array(cells).fill(0.5),
    elevationM: new Float32Array(cells), slope01: new Float32Array(cells), waterDistanceM: new Float32Array(cells).fill(100) },
  authoredTargets: { biomeIds: targetIds, indices: new Uint16Array(cells) }, influences: [], modifiers: [], topN: 4,
  climateFeather: { temperatureC: 6, moisture01: 0.2 } });
const bytes = encodeBiomeFieldArtifact(field), fieldContentHash = biomeFieldArtifactContentHash(bytes);
const pack = runtimePack(true), runtimePackContentHash = biomeRuntimePackContentHash(pack, BIOME_LIBRARY_V1);
const closure = deriveBiomeFieldContentClosure({ fieldArtifactBytes: bytes, fieldContentHash, metadataPack: BIOME_LIBRARY_V1,
  runtimePack: pack, runtimePackContentHash });
assert(closure.reachableBiomes.length === 1 && closure.reachableBiomes[0].biomeId === forest.id,
  "unreachable metadata biomes leaked into the field-domain closure");
assert(closure.reachableBiomes[0].surfaceRoles.join(",") === "ground/forest-loam,ground/leaf-litter"
  && closure.reachableBiomes[0].vegetationRoles.join(",") === "flora/ash,flora/fern,flora/forest-grass,flora/oak,flora/shrub",
"reachable declared roles drifted");
assert(Object.isFrozen(closure) && /^sha256:[0-9a-f]{64}$/.test(closure.closureHash), "closure is not immutable and content-addressed");
let rejected = false;
const missing = runtimePack(false);
try { deriveBiomeFieldContentClosure({ fieldArtifactBytes: bytes, fieldContentHash, metadataPack: BIOME_LIBRARY_V1,
  runtimePack: missing, runtimePackContentHash: biomeRuntimePackContentHash(missing, BIOME_LIBRARY_V1) }); }
catch (error) { rejected = /reachable biome content is incomplete/.test(String(error)); }
assert(rejected, "missing reachable bindings did not fail closed");
console.log("p_biome_field_content_closure OK: exact reachable forest roles close while 39 unreachable metadata biomes remain out of scope");
