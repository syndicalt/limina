// WB-W1 P3 non-browser acceptance: one deterministic recipe-bearing source drives the real
// compiler, portable generated-water artifact, gameplay contact runtime, and swim controller.

import { NO_EROSION_RECIPE } from "../src/world/pipeline/erosion.mjs";
import { u8ToB64 } from "../src/world/pipeline/raster-codec.mjs";
import { worldMapContentHash, type WorldMap } from "../src/world/worldmap.ts";
import { compilerContentHash, createHydrologyWorldCompilerGraph } from "../src/world/compiler/index.mjs";
import {
  compileWorldTerrain,
  WORLD_HYDROLOGY_TERRAIN_COMPILER_VERSION,
  WORLD_TERRAIN_COMPILER_CONFIG_SCHEMA,
} from "../src/world/compiler/terrain-compile.ts";
import { HYDROLOGY_FIELD_ARTIFACT_TYPE } from "../src/world/hydrology-artifact.mjs";
import {
  decodeHydrologyWaterArtifact,
  HYDROLOGY_WATER_ARTIFACT_TYPE,
} from "../src/world/hydrology-water-artifact.mjs";
import { decodeTerrainChunkArtifact } from "../src/world/compiler/terrain-artifact.mjs";
import {
  DERIVED_SIM_STAGE_SCHEMA,
  SimWorkerController,
  type AuthorCommand,
  type DerivedSimStageSnapshot,
} from "../src/browser/sim-worker.ts";
import type { RapierModule } from "../src/browser/wasm-rapier-physics.ts";
import {
  CharacterController,
  PLAYER_EYE_OFFSET_M,
  SWIM_SUBMERGED_EPSILON_M,
  type MoveCommand,
} from "../src/world/character.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`p_wb_w1_acceptance FAIL: ${message}`);
}

function encodedRelief(): WorldMap["reliefGrid"] {
  const w = 17, h = 17, minY = -10, maxY = 30;
  const bytes = new Uint8Array(w * h * 2);
  for (let row = 0; row < h; row++) for (let col = 0; col < w; col++) {
    const dx = col - 8, dz = row - 8, radius = Math.hypot(dx, dz);
    // A high closed rim around a broad low bowl. Outside the authored grid, the canonical map
    // field falls to deep ocean, giving priority-flood a deterministic external outlet.
    const height = radius < 3 ? 2 : radius < 5 ? 5 : radius < 7 ? 18 : 24;
    const value = Math.round(((height - minY) / (maxY - minY)) * 65535);
    const index = (row * w + col) * 2;
    bytes[index] = value & 0xff;
    bytes[index + 1] = value >>> 8;
  }
  return {
    w,
    h,
    rect: { x0: -32, z0: -32, w: 64, h: 64 },
    minY,
    maxY,
    encoding: "u16",
    data: u8ToB64(bytes),
  };
}

function fixture(): WorldMap {
  const map = {
    version: 1 as const,
    id: "wb-w1-p3-basin",
    unitsPerMeter: 1,
    origin: [0, 0] as [number, number],
    extent: { w: 64, h: 64 },
    seaLevel: -8,
    land: [{ points: [[-32, -32], [32, -32], [32, 32], [-32, 32]] as [number, number][] }],
    relief: [],
    reliefGrid: encodedRelief(),
    biomes: [{ biome: "grass" as const, points: [[-32, -32], [32, -32], [32, 32], [-32, 32]] as [number, number][] }],
    waterways: [],
    hydrology: {
      schema: "limina.hydrology-recipe/v1" as const,
      precipitationMmPerYear: 900,
      riverMinCatchmentAreaM2: 400,
      basinMinAreaM2: 20,
      basinMinDepthM: 0.5,
      waterfallMinDropM: 0.5,
    },
    routes: [],
    anchors: [],
    provenance: { tool: "design-space" as const, sourceHash: "0".repeat(64), contentHash: "pending" },
  };
  map.provenance.contentHash = worldMapContentHash(map as WorldMap);
  return map as WorldMap;
}

const map = fixture();
const graph = createHydrologyWorldCompilerGraph();
const mapDocumentHash = compilerContentHash({ mapDocument: "wb-w1-p3" });
const compileInput = {
  request: { projectId: "wb-w1-p3", branchId: "main", revision: 1, headHash: compilerContentHash({ head: 1 }) },
  worldMap: map,
  sourceRefs: {
    mapDocument: { refId: "map-document", refType: "map-document/v1", scope: "global", assetId: "test/wb-w1-p3.map.json", contentHash: mapDocumentHash },
    designSource: { refId: "design-source", refType: "design-source/v1", scope: "global", assetId: "test/wb-w1-p3-source.json", contentHash: `sha256:${map.provenance.sourceHash}` },
    worldMap: { refId: "world-map", refType: "world-map/v1", scope: "global", assetId: "test/wb-w1-p3.worldmap.json", contentHash: `sha256:${map.provenance.contentHash}` },
  },
  terrainEditLayers: [],
  terrainEditLayerRefs: [],
  compiler: {
    version: WORLD_HYDROLOGY_TERRAIN_COMPILER_VERSION,
    config: {
      schema: WORLD_TERRAIN_COMPILER_CONFIG_SCHEMA,
      seed: 7,
      baseAmplitude: 0.01,
      erosionRecipe: NO_EROSION_RECIPE,
      gridId: "wb-w1-p3.surface",
      verticalRange: { minM: -500, maxM: 9000 },
      limits: { maxChunks: 4096, maxMasterSamples: 1_050_625, maxArtifactBytes: 256 * 1024 * 1024 },
    },
  },
  previousSnapshot: null,
  cancellation: { shouldCancel: () => false },
};
const output = compileWorldTerrain(compileInput);
const repeated = compileWorldTerrain(compileInput);
assert(repeated.manifest.manifestHash === output.manifest.manifestHash, "repeated source changed the derived manifest");
assert(repeated.artifacts.length === output.artifacts.length && output.artifacts.every((artifact: any, index: number) => {
  const other = repeated.artifacts[index];
  return artifact.contentHash === other.contentHash && artifact.bytes.length === other.bytes.length
    && artifact.bytes.every((value: number, offset: number) => value === other.bytes[offset]);
}), "repeated source changed emitted artifact bytes");

const fieldArtifact = output.artifacts.find((artifact: any) => artifact.artifactType === HYDROLOGY_FIELD_ARTIFACT_TYPE);
const waterArtifact = output.artifacts.find((artifact: any) => artifact.artifactType === HYDROLOGY_WATER_ARTIFACT_TYPE);
assert(fieldArtifact?.scope === "global" && waterArtifact?.scope === "global", "compile omitted ordered hydrology globals");
const expectedBindings = {
  hydrologyFieldContentHash: fieldArtifact.contentHash,
  recipeHash: compilerContentHash(map.hydrology),
  erosionStageKey: output.snapshot.stageKeys.erosion["@global"],
  compilerGraphHash: graph.graphHash,
};
const decoded = decodeHydrologyWaterArtifact(waterArtifact.bytes, expectedBindings);
assert(decoded.topology.basins.length > 0, "deterministic bowl emitted no generated basin");
assert(decoded.topology.reaches.length > 0, "deterministic drainage emitted no generated reach");
assert(decoded.topology.basins.some((basin: any) => basin.spillLevelM > map.seaLevel), "generated basin is not above sea level");

let rapier: RapierModule;
try {
  // @ts-ignore native Limina gate resolves the checked-in browser-compatible Rapier package.
  rapier = (await import("../node_modules/@dimforge/rapier3d-compat/rapier.mjs")) as unknown as RapierModule;
} catch (error) {
  throw new Error(`p_wb_w1_acceptance FAIL: Rapier import failed: ${String(error)}`);
}

const terrainWindow = output.artifacts.filter((artifact: any) => artifact.scope === "chunk").map((artifact: any) => {
  const chunk = output.manifest.chunks.find((candidate: any) => candidate.chunkId === artifact.chunkId);
  assert(chunk !== undefined && chunk.lod === 0, `compiled artifact '${artifact.chunkId}' lacks a LOD0 manifest chunk`);
  return { key: `${chunk.tx},${chunk.tz}`, tx: chunk.tx, tz: chunk.tz, tile: decodeTerrainChunkArtifact(artifact.bytes).tile };
});
assert(terrainWindow.length > 0 && terrainWindow.length <= 225, `compiled terrain window has ${terrainWindow.length} tiles`);
const descriptor = {
  artifactType: waterArtifact.artifactType,
  mediaType: waterArtifact.mediaType,
  contentHash: waterArtifact.contentHash,
  byteLength: waterArtifact.bytes.byteLength,
};
const stageSnapshot: DerivedSimStageSnapshot = {
  schema: DERIVED_SIM_STAGE_SCHEMA,
  projectId: output.manifest.projectId,
  branchId: output.manifest.branchId,
  source: { revision: output.manifest.source.revision, headHash: output.manifest.source.headHash },
  manifestHash: output.manifest.manifestHash,
  grid: output.manifest.grid,
  terrainWindow,
  generatedWater: { artifact: descriptor, bytes: waterArtifact.bytes.slice(), bindings: expectedBindings },
};
const mapAssetId = "maps/wb-w1-p3.worldmap.json";
const sim = await SimWorkerController.create({
  rapier,
  assets: [{ id: mapAssetId, bytes: new TextEncoder().encode(JSON.stringify(map)) }],
});
const commands: AuthorCommand[] = [
  { kind: "physics", op: "op_physics_create_world", args: [-9.81] },
  { kind: "skill", tool: "world.setTerrainSource", input: { kind: "map", mapAssetId, hash: map.provenance.contentHash } },
  { kind: "skill", tool: "terrain.create", input: { size: 32, resolution: 3, origin: [10_000, 0, 10_000], baseHeight: 0 } },
];
const loaded = await sim.loadWorldIsolated(commands);
assert(loaded.failures.length === 0, `authored WorldMap binding failed: ${JSON.stringify(loaded.failures)}`);
const staged = sim.stageDerivedRevision("wb-w1-stage", output.manifest.manifestHash, stageSnapshot);
assert(staged.tick === 0 && sim.core.water.contact.activeGeneratedArtifactContentHash === null,
  "derived stage changed active water authority");
sim.commitDerivedRevision("wb-w1-commit", "wb-w1-stage", output.manifest.manifestHash);
assert(sim.derivedRevisionStatus.activeManifestHash === output.manifest.manifestHash
  && sim.core.water.contact.activeGeneratedArtifactContentHash === waterArtifact.contentHash,
"derived commit did not activate the exact compiled terrain and water revision");

const basin = decoded.topology.basins[0];
const contact = sim.core.water.contact;
let x = 0, z = 0;
let sample = contact.query(x, z);
for (let row = 0; row < decoded.topology.rows; row++) for (let col = 0; col < decoded.topology.cols; col++) {
  const candidateX = decoded.topology.placement.originX + col * decoded.topology.cellSizeM;
  const candidateZ = decoded.topology.placement.originZ + row * decoded.topology.cellSizeM;
  const candidate = contact.query(candidateX, candidateZ);
  if (candidate.bodyId === basin.id && candidate.columnDepthM > sample.columnDepthM) {
    x = candidateX; z = candidateZ; sample = candidate;
  }
}
assert(sample.wet && sample.type === "basin" && sample.surfaceLevelM !== null, "committed generated basin has no gameplay contact");
assert(sample.columnDepthM >= 0.75, `committed basin is too shallow to swim (${sample.columnDepthM}m)`);

const player = new CharacterController(sim.world.ops, [x, sample.surfaceLevelM + 4, z], {
  halfHeight: 0.6,
  radius: 0.3,
  waterContact: contact,
});
const still: MoveCommand = { forward: 0, strafe: 0, yaw: 0, run: false, jump: false };
const step = (command: MoveCommand): void => {
  player.step(command, 1 / 60);
  sim.world.ops.op_physics_step();
};
let sawDry = false, sawWading = false, sawSwimming = false;
for (let tick = 0; tick < 600 && !sawSwimming; tick++) {
  step(still);
  sawDry ||= player.waterMode === "dry";
  sawWading ||= player.waterMode === "wading";
  sawSwimming ||= player.isSwimming;
}
assert(sawDry && sawWading && sawSwimming && player.waterState.bodyId === basin.id,
  `real Rapier fall missed dry/wading/swimming: ${JSON.stringify(player.waterState)}`);
for (let tick = 0; tick < 600; tick++) step(still);
assert(player.isSwimming && Math.abs(player.position[1] - sample.surfaceLevelM) < 2,
  `idle buoyancy escaped its surface band: y=${player.position[1]}, surface=${sample.surfaceLevelM}`);

const horizontalStart = [player.position[0], player.position[2]];
for (let tick = 0; tick < 30; tick++) step({ ...still, forward: 0.5 });
const horizontalDistance = Math.hypot(player.position[0] - horizontalStart[0], player.position[2] - horizontalStart[1]);
assert(player.isSwimming && horizontalDistance > 0.25 && horizontalDistance < 2,
  `horizontal swim was absent or unbounded (${horizontalDistance}m)`);

const submergedStartY = sample.surfaceLevelM - PLAYER_EYE_OFFSET_M - SWIM_SUBMERGED_EPSILON_M - 0.1;
const diver = new CharacterController(sim.world.ops, [x, submergedStartY, z], {
  halfHeight: 0.6,
  radius: 0.3,
  waterContact: contact,
});
const stepDiver = (command: MoveCommand): void => {
  diver.step(command, 1 / 60);
  sim.world.ops.op_physics_step();
};
stepDiver(still);
assert(diver.isSwimming && diver.isSubmerged && diver.waterState.bodyId === basin.id,
  "real Rapier submerged spawn did not derive generated-basin swim state");
for (let tick = 0; tick < 240 && diver.isSubmerged; tick++) stepDiver({ ...still, jump: true });
assert(diver.isSwimming && !diver.isSubmerged, "submerged swimmer failed to surface under swim input");

const physicsSnapshot = sim.world.ops.op_physics_snapshot();
const characterSnapshot = player.serializeState();
function continuation(): number[] {
  const values: number[] = [];
  for (let tick = 0; tick < 180; tick++) {
    step({ forward: tick % 9 < 6 ? 0.35 : -0.15, strafe: tick % 7 < 3 ? 0.2 : -0.1,
      yaw: (tick % 11) * 0.07, run: tick % 2 === 0, jump: tick % 19 < 4 });
    const state = player.serializeState();
    values.push(player.position[0], player.position[1], player.position[2], state.vy,
      state.grounded ? 1 : 0, state.heading, state.swimming ? 1 : 0, player.isSubmerged ? 1 : 0);
  }
  return values;
}
const reference = continuation();
sim.world.ops.op_physics_restore(physicsSnapshot);
player.restoreState(characterSnapshot);
const restored = continuation();
assert(reference.length === restored.length && reference.every((value, index) => Object.is(value, restored[index])),
  "real Rapier and character snapshot continuation was not bit-exact");
player.dispose();
diver.dispose();

console.log(`p_wb_w1_acceptance OK: manifest ${output.manifest.manifestHash}; ${decoded.topology.basins.length} basin(s), ${decoded.topology.reaches.length} reach(es); production stage/commit, real Rapier dry-to-swim, bounded motion, and exact continuation`);
