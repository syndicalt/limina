import { ops } from "../src/engine.ts";
import {
  HYDROLOGY_WATER_ARTIFACT_MEDIA_TYPE,
  HYDROLOGY_WATER_ARTIFACT_TYPE,
  encodeHydrologyWaterArtifact,
} from "../src/world/hydrology-water-artifact.mjs";
import { HYDROLOGY_COMBINED_WATER_TOPOLOGY_SCHEMA } from "../src/world/hydrology-water-topology.mjs";
import { sha256 } from "../src/world/sha256.mjs";
import { createWaterField, prepareGeneratedWaterFieldInput, WaterFieldCancelledError } from "../src/world/water-field.mjs";
import { worldMapContentHash } from "../src/world/worldmap-hash.mjs";
import { WATER_LIMITS } from "../src/world/water-ir.mjs";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`p_generated_water_field FAIL: ${message}`);
}

function rejects(fn: () => unknown, pattern: RegExp, message: string): Error {
  let error: unknown;
  try { fn(); } catch (caught) { error = caught; }
  assert(error instanceof Error && pattern.test(error.message), `${message}: ${error instanceof Error ? error.message : "did not throw"}`);
  return error;
}

const bindings = Object.freeze({
  hydrologyFieldContentHash: `sha256:${"11".repeat(32)}`,
  recipeHash: `sha256:${"22".repeat(32)}`,
  erosionStageKey: `sha256:${"33".repeat(32)}`,
  compilerGraphHash: `sha256:${"44".repeat(32)}`,
});

function basin(id = "gen-b-6-5", level = 10, x = 0, z = 0, seedCell = 5, spillOutsideCell = 6): any {
  return {
    id,
    kind: "lake",
    spillLevelM: level,
    maxDepthM: 4,
    areaM2: 96,
    cellCount: 96,
    seedCell,
    spillInsideCell: seedCell,
    spillOutsideCell,
    spillOutsideDrainageRank: spillOutsideCell,
    footprint: {
      points: [[x, z], [x + 10, z], [x + 10, z + 10], [x, z + 10]],
      holes: [[[x + 4, z + 4], [x + 4, z + 6], [x + 6, z + 6], [x + 6, z + 4]]],
    },
  };
}

function topology(basins = [basin()], reaches: any[] = [{
  id: "gen-r-dr-ds",
  class: "stream",
  order: 1,
  startCell: 495,
  endCell: 496,
  points: [[15, 15], [16, 15]],
  widths: [1, 1],
  terrainElevationsM: [0, 0],
  surfaceElevationsM: [0, 0],
  waterfalls: [],
}]): any {
  return {
    schema: HYDROLOGY_COMBINED_WATER_TOPOLOGY_SCHEMA,
    version: 1,
    placement: { originX: 0, originZ: 0 },
    rows: 32,
    cols: 32,
    cellSizeM: 1,
    basins,
    reaches,
    diagnostics: {},
  };
}

function prepared(source = topology(), expectedBindings: any = bindings): any {
  const bytes = encodeHydrologyWaterArtifact(source, bindings);
  return prepareGeneratedWaterFieldInput({
    bytes,
    descriptor: {
      artifactType: HYDROLOGY_WATER_ARTIFACT_TYPE,
      mediaType: HYDROLOGY_WATER_ARTIFACT_MEDIA_TYPE,
      contentHash: `sha256:${sha256(bytes)}`,
      byteLength: bytes.byteLength,
    },
    expectedBindings,
  });
}

function authored(id: string, level: number): any {
  return {
    id,
    kind: "reservoir",
    level,
    footprint: { points: [[0, 0], [10, 0], [10, 10], [0, 10]] },
    depthZones: [{ minShoreDistanceM: 0, maxShoreDistanceM: 100, depthM: 7 }],
  };
}

function sealedMap(waterBodies: any[] = []): any {
  const map: any = {
    version: 1,
    id: "generated-water-field",
    unitsPerMeter: 1,
    origin: [0, 0],
    extent: { w: 100, h: 100 },
    seaLevel: -100,
    land: [], relief: [], biomes: [], waterways: [], waterBodies, routes: [], anchors: [],
    provenance: { tool: "design-space", sourceHash: "generated-test", contentHash: "0".repeat(64) },
  };
  map.provenance.contentHash = worldMapContentHash(map);
  return map;
}

const source = topology();
const generated = prepared(source);
const map = sealedMap();
const field = createWaterField(map, { generatedWater: generated });
assert(field.identity.worldMapContentHash === map.provenance.contentHash
  && field.identity.generatedArtifactContentHash === generated.artifactContentHash, "composite field identity changed");
const wet = field.query(1, 1, 8);
assert(wet.type === "basin" && wet.id === "gen-b-6-5" && wet.isSubmerged === true && wet.actualSubmergedDepthM === 2,
  "generated basin did not produce exact live terrain depth");
assert(wet.authoredTargetDepthM === null && wet.targetFloorLevelM === null, "generated basin fabricated authored depth zones");
assert(field.query(1, 1, 0).actualSubmergedDepthM === 4, "generated basin depth did not clamp to maxDepthM");
assert(field.query(1, 1, 10).isSubmerged === false, "terrain at generated spill level was claimed submerged");
assert(field.query(5, 5, 0).type === "dry", "generated basin hole was not dry");
assert(field.query(11, 1, 0).type === "dry", "generated basin leaked beyond its footprint");
assert(field.query(15, 15, 0).type === "dry", "generated reach metadata was treated as a wet volume");
const unknownTerrain = field.query(1, 1);
assert(unknownTerrain.type === "basin" && unknownTerrain.isSubmerged === null && unknownTerrain.actualSubmergedDepthM === null,
  "terrain-free generated query fabricated submersion");

// Querying remains live against terrain deformation without rebuilding the immutable index.
let terrainHeight = 9;
assert(field.query(1, 1, terrainHeight).actualSubmergedDepthM === 1, "initial deformation depth changed");
terrainHeight = 4;
assert(field.query(1, 1, terrainHeight).actualSubmergedDepthM === 4, "live deformation did not update/clamp depth");

// Equal levels prefer authored regardless of lexical id; a strictly higher generated surface wins.
const equal = createWaterField(sealedMap([authored("z-authored", 10)]), { generatedWater: generated });
assert(equal.query(1, 1, 0).id === "z-authored", "equal-level generated basin beat authored water");
const lowerAuthored = createWaterField(sealedMap([authored("z-authored", 9)]), { generatedWater: generated });
assert(lowerAuthored.query(1, 1, 0).id === "gen-b-6-5", "higher generated surface did not win");
rejects(() => createWaterField(sealedMap([authored("gen-b-6-5", 10)]), { generatedWater: generated }),
  /id collision/, "authored/generated id collision accepted");

// Preparation owns canonical data; caller mutation after verification cannot change the field.
source.basins[0].spillLevelM = 99;
source.basins[0].footprint.points[0][0] = 99;
assert(createWaterField(map, { generatedWater: generated }).query(1, 1, 8).surfaceLevelM === 10,
  "source mutation changed prepared generated water");
rejects(() => createWaterField(map, { generatedWater: { artifactContentHash: generated.artifactContentHash } as any }),
  /prepared by prepareGeneratedWaterFieldInput/, "unbranded generated input accepted");
let buildCancellationChecks = 0;
const buildCancellation = rejects(() => createWaterField(map, { generatedWater: generated, shouldCancel: () => ++buildCancellationChecks === 1 }),
  /cancelled/, "generated field build cancellation ignored");
assert(buildCancellation instanceof WaterFieldCancelledError, "generated field build cancellation was not typed");
rejects(() => prepared(topology(), { ...bindings, recipeHash: `sha256:${"55".repeat(32)}` }), /does not match expected value/,
  "binding mismatch accepted");
{
  const candidate = topology();
  const bytes = encodeHydrologyWaterArtifact(candidate, bindings);
  rejects(() => prepareGeneratedWaterFieldInput({
    bytes,
    descriptor: { artifactType: HYDROLOGY_WATER_ARTIFACT_TYPE, mediaType: HYDROLOGY_WATER_ARTIFACT_MEDIA_TYPE,
      contentHash: `sha256:${"00".repeat(32)}`, byteLength: bytes.byteLength },
    expectedBindings: bindings,
  }), /content hash mismatch/, "descriptor hash mismatch accepted");
}
let cancellationChecks = 0;
const cancellationBytes = encodeHydrologyWaterArtifact(topology(), bindings);
const cancellation = rejects(() => prepareGeneratedWaterFieldInput({
  bytes: cancellationBytes,
  descriptor: { artifactType: HYDROLOGY_WATER_ARTIFACT_TYPE, mediaType: HYDROLOGY_WATER_ARTIFACT_MEDIA_TYPE,
    contentHash: `sha256:${sha256(cancellationBytes)}`, byteLength: cancellationBytes.byteLength },
  expectedBindings: bindings,
}, { shouldCancel: () => ++cancellationChecks === 1 }), /cancelled/, "generated preparation cancellation ignored");
assert(cancellation instanceof WaterFieldCancelledError, "generated preparation cancellation was not translated");

// Maximum generated body contract remains on the shared BVH path without body-pair validation.
const maximumBodies = [];
for (let index = 0; index < WATER_LIMITS.bodies; index++) {
  const x = (index % 64) * 20, z = Math.floor(index / 64) * 20;
  const seedCell = index * 2, spillOutsideCell = seedCell + 1;
  const body = basin(`gen-b-${spillOutsideCell.toString(36)}-${seedCell.toString(36)}`, 5 + index % 3, x, z, seedCell, spillOutsideCell);
  body.footprint = { points: [[x, z], [x + 8, z], [x + 8, z + 8], [x, z + 8]] };
  body.areaM2 = 64;
  body.cellCount = 64;
  maximumBodies.push(body);
}
maximumBodies.sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
const maximumTopology = { ...topology(maximumBodies, []), rows: 1025, cols: 1025 };
const maximumPrepared = prepared(maximumTopology);
const now = (): number => globalThis.performance?.now() ?? Date.now();
const start = now();
const maximumField = createWaterField(map, { generatedWater: maximumPrepared });
const buildMs = now() - start;
assert(maximumField.buildStats.generatedBodyCount === WATER_LIMITS.bodies && maximumField.buildStats.bodyPairValidationWork === 0,
  "maximum generated body field changed bounds or introduced pair validation");
let checksum = 0;
const queryStart = now();
for (let index = 0; index < 100_000; index++) {
  const x = ((index * 17) & 63) * 20 + index % 11;
  const z = ((index * 29) & 63) * 20 + index % 13;
  if (maximumField.query(x, z, 0).type === "basin") checksum++;
}
const queryMs = now() - queryStart;

ops.op_log(
  `[js] p_generated_water_field OK: strict bound artifact envelope, generated basin/hole/deformation/depth, authored priority, reach dryness and immutable sources proven; `
  + `${WATER_LIMITS.bodies} generated bodies build ${buildMs.toFixed(1)}ms, 100k queries ${queryMs.toFixed(1)}ms, checksum ${checksum}.`,
);
