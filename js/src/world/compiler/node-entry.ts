import { compileAtlasMapDoc } from "../design-map-compile.mjs";
import { DEFAULT_MAP_EROSION_RECIPE } from "../pipeline/erosion.mjs";
import {
  WORLD_TERRAIN_COMPILER_BASE_AMPLITUDE,
  WORLD_TERRAIN_COMPILER_SEED,
  WORLD_TERRAIN_COMPILER_VERTICAL_RANGE,
} from "./config.mjs";
import { compilerContentHash } from "./canonical.mjs";
import { createBiomeWorldCompilerGraph, createHydrologyWorldCompilerGraph, createInitialWorldCompilerGraph, createPublishedBiomeWorldCompilerGraph } from "./graph.mjs";
import {
  compileWorldTerrain as compileBaseWorldTerrain,
  MAX_WORLD_TERRAIN_COMPILE_ARTIFACT_BYTES,
  MAX_WORLD_TERRAIN_COMPILE_CHUNKS,
  MAX_WORLD_TERRAIN_COMPILE_MASTER_SAMPLES,
  WORLD_TERRAIN_COMPILER_CONFIG_SCHEMA,
  WORLD_HYDROLOGY_TERRAIN_COMPILER_VERSION,
  WORLD_BIOME_TERRAIN_COMPILER_VERSION,
} from "./terrain-compile.ts";
import {
  WORLD_PUBLISHED_BIOME_COMPILER_VERSION,
  publishBiomeTerrainCompilation,
} from "./biome-publication-compile.mjs";

export { compileAtlasMapDoc };

export const WORLD_COMPILER_BUNDLE_SCHEMA = "limina.world-compiler-bundle/v1";
export const WORLD_TERRAIN_COMPILER_VERSION = "1.0.0";

function createWorldTerrainCompilerConfig(projectId: string) {
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(projectId)) throw new Error("world compiler projectId is invalid");
  return Object.freeze({
    schema: WORLD_TERRAIN_COMPILER_CONFIG_SCHEMA,
    // The field constants live in config.mjs — the runtime composed-height sampler
    // (D5.4) reads the same source, so a drift here can never fork the two.
    seed: WORLD_TERRAIN_COMPILER_SEED,
    baseAmplitude: WORLD_TERRAIN_COMPILER_BASE_AMPLITUDE,
    erosionRecipe: DEFAULT_MAP_EROSION_RECIPE,
    gridId: `${projectId}.surface`,
    verticalRange: WORLD_TERRAIN_COMPILER_VERTICAL_RANGE,
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

/** Build the pinned compiler profile for deterministic biome snapshots over hydrology maps. */
export function createBiomeWorldTerrainCompiler(projectId: string) {
  return createWorldTerrainCompilerBundle(
    projectId,
    WORLD_BIOME_TERRAIN_COMPILER_VERSION,
    createBiomeWorldCompilerGraph(),
  );
}

/** Opt-in production profile that atomically publishes reviewed B3 surfaces and population. */
export function createPublishedBiomeWorldTerrainCompiler(projectId: string) {
  return createWorldTerrainCompilerBundle(
    projectId,
    WORLD_PUBLISHED_BIOME_COMPILER_VERSION,
    createPublishedBiomeWorldCompilerGraph(),
  );
}

/** Bundle entrypoint used by the worker. Older profiles preserve their existing compiler path. */
export function compileWorldTerrain(input: any) {
  if (input?.compiler?.version !== WORLD_PUBLISHED_BIOME_COMPILER_VERSION) return compileBaseWorldTerrain(input);
  if (input.previousSnapshot !== null || Object.hasOwn(input, "previousManifest") || Object.hasOwn(input, "availableArtifactHashes")) {
    throw new Error("published biome compiler currently requires a cold base compilation");
  }
  if (!Object.hasOwn(input, "biomePublication")) throw new Error("published biome compiler requires biomePublication input");
  const { biomePublication, ...baseInput } = input;
  const baseCompilation = compileBaseWorldTerrain({
    ...baseInput,
    compiler: { version: WORLD_BIOME_TERRAIN_COMPILER_VERSION, config: input.compiler.config },
  });
  return publishBiomeTerrainCompilation({
    baseCompilation,
    publication: biomePublication,
    compiler: { version: WORLD_PUBLISHED_BIOME_COMPILER_VERSION, configHash: compilerContentHash(input.compiler.config) },
    cancellation: input.cancellation,
  });
}
