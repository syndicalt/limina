import { compileAtlasMapDoc } from "../design-map-compile.mjs";
import { DEFAULT_MAP_EROSION_RECIPE } from "../pipeline/erosion.mjs";
import { compilerContentHash } from "./canonical.mjs";
import { createHydrologyWorldCompilerGraph, createInitialWorldCompilerGraph } from "./graph.mjs";
import {
  compileWorldTerrain,
  MAX_WORLD_TERRAIN_COMPILE_ARTIFACT_BYTES,
  MAX_WORLD_TERRAIN_COMPILE_CHUNKS,
  MAX_WORLD_TERRAIN_COMPILE_MASTER_SAMPLES,
  WORLD_TERRAIN_COMPILER_CONFIG_SCHEMA,
  WORLD_HYDROLOGY_TERRAIN_COMPILER_VERSION,
} from "./terrain-compile.ts";

export { compileAtlasMapDoc, compileWorldTerrain };

export const WORLD_COMPILER_BUNDLE_SCHEMA = "limina.world-compiler-bundle/v1";
export const WORLD_TERRAIN_COMPILER_VERSION = "1.0.0";

function createWorldTerrainCompilerConfig(projectId: string) {
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(projectId)) throw new Error("world compiler projectId is invalid");
  return Object.freeze({
    schema: WORLD_TERRAIN_COMPILER_CONFIG_SCHEMA,
    seed: 11,
    baseAmplitude: 12,
    erosionRecipe: DEFAULT_MAP_EROSION_RECIPE,
    gridId: `${projectId}.surface`,
    verticalRange: Object.freeze({ minM: -500, maxM: 9000 }),
    limits: Object.freeze({
      maxChunks: MAX_WORLD_TERRAIN_COMPILE_CHUNKS,
      maxMasterSamples: MAX_WORLD_TERRAIN_COMPILE_MASTER_SAMPLES,
      maxArtifactBytes: MAX_WORLD_TERRAIN_COMPILE_ARTIFACT_BYTES,
    }),
  });
}

function createWorldTerrainCompilerBundle(
  projectId: string,
  version: string,
  graph: ReturnType<typeof createInitialWorldCompilerGraph>,
) {
  const config = createWorldTerrainCompilerConfig(projectId);
  return Object.freeze({
    schema: WORLD_COMPILER_BUNDLE_SCHEMA,
    version,
    config,
    identity: Object.freeze({
      version,
      configHash: compilerContentHash(config),
      graphHash: graph.graphHash,
    }),
  });
}

/** Build the pinned compiler profile used by the project-local sidecar. */
export function createDefaultWorldTerrainCompiler(projectId: string) {
  return createWorldTerrainCompilerBundle(projectId, WORLD_TERRAIN_COMPILER_VERSION, createInitialWorldCompilerGraph());
}

/** Build the pinned compiler profile for recipe-bearing hydrology maps. */
export function createHydrologyWorldTerrainCompiler(projectId: string) {
  return createWorldTerrainCompilerBundle(
    projectId,
    WORLD_HYDROLOGY_TERRAIN_COMPILER_VERSION,
    createHydrologyWorldCompilerGraph(),
  );
}
