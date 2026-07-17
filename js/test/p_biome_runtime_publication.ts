import { compileBiomeField } from "../src/world/biome-field.mjs";
import { BIOME_LIBRARY_V1 } from "../src/world/biome-library-v1.mjs";
import { biomePackContentHash } from "../src/world/biome-ir.mjs";
import { BIOME_RUNTIME_PACK_SCHEMA, biomeRuntimePackContentHash } from "../src/world/biome-runtime-pack.mjs";
import { createBiomeRuntimePublication } from "../src/world/biome-runtime-publication.mjs";
import { biomeFieldArtifactContentHash, encodeBiomeFieldArtifact } from "../src/world/compiler/biome-field-artifact.mjs";

function assert(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(`p_biome_runtime_publication FAIL: ${message}`); }
const hash = (digit: string): string => `sha256:${digit.repeat(64)}`;
const alpine = BIOME_LIBRARY_V1.definitions.find((entry) => entry.id === "alpine")!;
const runtimePack = {
  schema: BIOME_RUNTIME_PACK_SCHEMA, id: "alpine-runtime", version: "1.0.0",
  metadataPackContentHash: biomePackContentHash(BIOME_LIBRARY_V1), status: "fulfilled",
  biomes: [{ biomeId: "alpine", status: "fulfilled",
    surfaceRules: alpine.surfaceMaterials.map(({ role }, index) => ({ role, weight: index + 1, tileScaleM: 3 + index })).sort((a, b) => a.role.localeCompare(b.role)),
    vegetationRules: alpine.vegetationPalette.map(({ role, weight }) => ({ role, weight, radiusM: 0.8, density01: 0.7,
      scale: [0.8, 1.2], slope01: [0, 0.8], tintSrgb: [220, 235, 215] })).sort((a, b) => a.role.localeCompare(b.role)),
    bindings: [
      ...alpine.surfaceMaterials.map(({ role }, index) => ({ kind: "surface", role, assetId: `materials/alpine-${index}`,
        contentHash: hash(String(index + 1)), licenseId: "CC0-1.0", sourceUri: `https://example.invalid/material-${index}` })),
      ...alpine.vegetationPalette.map(({ role }, index) => ({ kind: "vegetation", role, assetId: `vegetation/alpine-${index}`,
        contentHash: hash(String(index + 5)), licenseId: "CC0-1.0", sourceUri: `https://example.invalid/vegetation-${index}` })),
    ].sort((a, b) => `${a.kind}:${a.role}`.localeCompare(`${b.kind}:${b.role}`)),
  }],
};

const cells = 4;
const field = compileBiomeField({ pack: BIOME_LIBRARY_V1, grid: { origin: [-8, -8], rows: 2, cols: 2, cellSizeM: 16 },
  samples: { temperatureC: new Float32Array(cells).fill(-5), moisture01: new Float32Array(cells).fill(0.5),
    elevationM: new Float32Array(cells).fill(1200), slope01: new Float32Array(cells).fill(0.2), waterDistanceM: new Float32Array(cells).fill(100) },
  influences: [{ id: "force-alpine", target: { biomeId: "alpine" }, polygon: [[-20, -20], [20, -20], [20, 20], [-20, 20]], featherM: 0, strength: 100 }],
  modifiers: [], topN: 4, climateFeather: { temperatureC: 8, moisture01: 0.15 } });
const bytes = encodeBiomeFieldArtifact(field), fieldContentHash = biomeFieldArtifactContentHash(bytes);
const runtimePackContentHash = biomeRuntimePackContentHash(runtimePack, BIOME_LIBRARY_V1);
const publication = createBiomeRuntimePublication({ fieldArtifactBytes: bytes, fieldContentHash, runtimePack,
  runtimePackContentHash, metadataPack: BIOME_LIBRARY_V1 });
assert(Object.isFrozen(publication), "publication identity remained externally mutable");
const first = publication.sample(0, 0), second = publication.sample(0, 0);
assert(first !== null && JSON.stringify(first) === JSON.stringify(second), "same coordinate did not resolve byte-identically");
assert(first.status === "unfulfilled" && first.surfaces.length > 0 && first.vegetation.length > 0,
  "fulfilled dominant biome content was not resolved or missing secondary influences were hidden");
assert(first.surfaces.reduce((sum, entry) => sum + entry.weightU16, 0) === 65_535, "surface weights were not exactly normalized");
assert(first.vegetation.reduce((sum, entry) => sum + entry.weightU16, 0) === 65_535, "vegetation weights were not exactly normalized");
const vegetationOnly = publication.sampleVegetation(0, 0);
assert(vegetationOnly !== null && JSON.stringify(vegetationOnly) === JSON.stringify({
  vegetation: first.vegetation, vegetationDensity01: first.vegetationDensity01,
}), "vegetation-only dense sampling drifted from the full publication's exact weights or density");
assert(first.unbound.length > 0 && first.unbound.every((entry) => entry.biomeId !== "alpine"), "bound alpine roles leaked into unbound output");
assert(publication.sample(100, 100) === null, "out-of-bounds sample did not return null");

let mismatch = false;
try { createBiomeRuntimePublication({ fieldArtifactBytes: bytes, fieldContentHash: hash("f"), runtimePack,
  runtimePackContentHash, metadataPack: BIOME_LIBRARY_V1 }); } catch (error) { mismatch = /field artifact content hash mismatch/.test(String(error)); }
assert(mismatch, "field hash mismatch did not fail before publication");
mismatch = false;
try { createBiomeRuntimePublication({ fieldArtifactBytes: bytes, fieldContentHash, runtimePack,
  runtimePackContentHash: hash("e"), metadataPack: BIOME_LIBRARY_V1 }); } catch (error) { mismatch = /runtime pack content hash mismatch/.test(String(error)); }
assert(mismatch, "runtime pack hash mismatch did not fail before publication");

publication.dispose(); publication.dispose();
assert(publication.disposed, "publication did not expose disposed state");
let disposed = false; try { publication.sample(0, 0); } catch (error) { disposed = /disposed/.test(String(error)); }
assert(disposed, "disposed publication remained sampleable");
disposed = false; try { publication.sampleVegetation(0, 0); } catch (error) { disposed = /disposed/.test(String(error)); }
assert(disposed, "disposed publication remained vegetation-sampleable");
console.log("p_biome_runtime_publication OK: field+pack hashes pin one immutable top-four resolver; bound content normalizes exactly and unbound influences never fallback");
