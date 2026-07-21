import { BIOME_FIELD_NONE, compileBiomeField } from "../src/world/biome-field.mjs";
import { cropBiomeFieldSnapshot } from "../src/world/biome-field-snapshot.mjs";
import { BIOME_LIBRARY_V1 } from "../src/world/biome-library-v1.mjs";
import { decodeBiomeFieldArtifact, encodeBiomeFieldArtifact } from "../src/world/compiler/biome-field-artifact.mjs";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`p_biome_field_snapshot FAIL: ${message}`);
}
const cells = 25;
const targets = new Uint16Array(cells);
const forestIndex = BIOME_LIBRARY_V1.definitions.findIndex((entry) => entry.id === "temperate-deciduous-forest");
const riverIndex = BIOME_LIBRARY_V1.definitions.findIndex((entry) => entry.id === "river");
targets.fill(forestIndex);
targets[12] = riverIndex;
const field = compileBiomeField({
  pack: BIOME_LIBRARY_V1,
  grid: { origin: [-20, -20], rows: 5, cols: 5, cellSizeM: 10 },
  samples: {
    temperatureC: new Float32Array(cells).fill(12),
    moisture01: new Float32Array(cells).fill(0.6),
    elevationM: new Float32Array(cells),
    slope01: new Float32Array(cells),
    waterDistanceM: new Float32Array(cells).fill(100),
  },
  authoredTargets: { biomeIds: BIOME_LIBRARY_V1.definitions.map((entry) => entry.id), indices: targets },
  influences: [], modifiers: [], topN: 4,
  climateFeather: { temperatureC: 6, moisture01: 0.2 },
});
const snapshot = cropBiomeFieldSnapshot(field, { minX: -7, minZ: -7, maxX: 17, maxZ: 17 });
assert(snapshot.grid.origin[0] === 0 && snapshot.grid.origin[1] === 0 && snapshot.grid.rows === 2 && snapshot.grid.cols === 2,
  "closed-domain sample selection drifted");
assert(snapshot.diagnostics.cells === 4 && snapshot.diagnostics.outputBytes === 64, "snapshot diagnostics are not self-contained");
const decoded = decodeBiomeFieldArtifact(encodeBiomeFieldArtifact(snapshot)).field;
const reachable = new Set<string>();
for (let offset = 0; offset < decoded.indices.length; offset++) {
  if (decoded.indices[offset] !== BIOME_FIELD_NONE && decoded.weights[offset] > 0) reachable.add(decoded.biomeIds[decoded.indices[offset]]);
}
assert([...reachable].join(",") === "river,temperate-deciduous-forest" || [...reachable].join(",") === "temperate-deciduous-forest,river",
  `snapshot closure changed: ${[...reachable].join(",")}`);
let rejected = false;
try { cropBiomeFieldSnapshot(field, { minX: -30, minZ: -7, maxX: 17, maxZ: 17 }); }
catch (error) { rejected = /exceed the source/.test(String(error)); }
assert(rejected, "out-of-source bounds did not fail closed");
console.log("p_biome_field_snapshot OK: exact closed-domain source samples produce a portable snapshot");
