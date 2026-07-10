import { ops } from "../src/engine.ts";
import { terrainChunkId } from "../src/terrain/grid.mjs";
import {
  COMPILER_STAGE_SCHEMA,
  INITIAL_WORLD_COMPILER_STAGE_DEFINITIONS,
  MAX_ALL_STAGE_CONFIG_BYTES,
  MAX_COMPILER_STAGES,
  canonicalCompilerSnapshot,
  compilerContentHash,
  compilerStageKey,
  createCompilerGraph,
  createInitialWorldCompilerGraph,
  planCompilerInvalidation,
} from "../src/world/compiler/index.mjs";

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(`p_world_compiler_dag FAIL: ${message}`);
}

function rejects(fn: () => unknown, pattern: RegExp, message: string): void {
  let error: unknown;
  try { fn(); } catch (caught) { error = caught; }
  assert(error instanceof Error && pattern.test(error.message), `${message}: ${error instanceof Error ? error.message : "did not throw"}`);
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}

function hash(label: string): string {
  return compilerContentHash({ label });
}

function chunk(gridId: string, tx: number, tz: number) {
  return {
    chunkId: terrainChunkId(gridId, 0, tx, tz),
    gridId,
    lod: 0,
    tx,
    tz,
    chunkTopologyHash: hash(`topology:${gridId}:${tx}:${tz}`),
    sourceSliceHashes: { "edit-layers.slice": hash(`edits:${gridId}:${tx}:${tz}`) },
  };
}

const SYNTHETIC_LOCAL_HALO_GRAPH = createCompilerGraph([
  { schema: COMPILER_STAGE_SCHEMA, stageId: "worldmap", stageVersion: "1.0.0", scope: "chunk", dependencies: [], sourceInputs: [{ inputId: "worldmap.slice", scope: "chunk" }], footprint: { haloChunks: 0 } },
  { schema: COMPILER_STAGE_SCHEMA, stageId: "base-height", stageVersion: "1.0.0", scope: "chunk", dependencies: ["worldmap"], sourceInputs: [], footprint: { haloChunks: 0 } },
  { schema: COMPILER_STAGE_SCHEMA, stageId: "erosion", stageVersion: "1.0.0", scope: "chunk", dependencies: ["base-height"], sourceInputs: [], footprint: { haloChunks: 1 } },
  { schema: COMPILER_STAGE_SCHEMA, stageId: "edit-layers", stageVersion: "1.0.0", scope: "chunk", dependencies: ["erosion"], sourceInputs: [{ inputId: "edit-layers.slice", scope: "chunk" }], footprint: { haloChunks: 0 } },
  { schema: COMPILER_STAGE_SCHEMA, stageId: "collision", stageVersion: "1.0.0", scope: "chunk", dependencies: ["edit-layers"], sourceInputs: [], footprint: { haloChunks: 0 } },
  { schema: COMPILER_STAGE_SCHEMA, stageId: "render", stageVersion: "1.0.0", scope: "chunk", dependencies: ["edit-layers"], sourceInputs: [], footprint: { haloChunks: 0 } },
]);

function localHaloFixture(radius = 2, gridId = "grey-field.surface") {
  const chunks = [];
  for (let tz = -radius; tz <= radius; tz++) for (let tx = -radius; tx <= radius; tx++) {
    chunks.push({
      ...chunk(gridId, tx, tz),
      sourceSliceHashes: {
        "edit-layers.slice": hash(`edits:${gridId}:${tx}:${tz}`),
        "worldmap.slice": hash(`worldmap:${gridId}:${tx}:${tz}`),
      },
    });
  }
  const base = fixture(0);
  const { "navigation-index": _navigationConfig, ...configs } = base.configs;
  return { ...base, graph: SYNTHETIC_LOCAL_HALO_GRAPH, chunks, configs, globalSourceHashes: {} };
}

function fixture(radius = 2) {
  const chunks = [];
  for (let tz = -radius; tz <= radius; tz++) {
    for (let tx = -radius; tx <= radius; tx++) chunks.push(chunk("grey-field.surface", tx, tz));
  }
  return {
    graph: createInitialWorldCompilerGraph(),
    chunks,
    configs: {
      worldmap: { seaLevelM: 0 },
      "base-height": { encoding: "u16" },
      erosion: { iterations: 24 },
      "edit-layers": { mode: "ordered" },
      collision: { simplification: 0.25 },
      render: { quality: "editor" },
      "navigation-index": { schema: "limina.navigation-index-stage-config/v1" },
    },
    globalSourceHashes: {
      "worldmap.global": hash("worldmap-global-v1"),
      "navigation.index": hash("navigation-index-v1"),
    },
  };
}

function stageDefinition(stageId: string, dependencies: string[] = []) {
  return {
    schema: COMPILER_STAGE_SCHEMA,
    stageId,
    stageVersion: "1.0.0",
    scope: "chunk",
    dependencies,
    sourceInputs: [],
    footprint: { haloChunks: 0 },
  };
}

// Graph construction is canonical, stable, deeply immutable, and rejects structural lies.
const graph = createInitialWorldCompilerGraph();
const shuffled = createCompilerGraph([...INITIAL_WORLD_COMPILER_STAGE_DEFINITIONS].reverse());
assert(graph.graphHash === shuffled.graphHash, "definition input order changed graphHash");
assert(graph.topologicalOrder.join(",") === "navigation-index,worldmap,base-height,erosion,edit-layers,collision,render", "stable topological order is wrong");
for (const stageId of ["navigation-index", "worldmap", "base-height", "erosion"]) assert(graph.definitions.find((stage) => stage.stageId === stageId)?.scope === "global", `${stageId} must model a canonical global build`);
assert(graph.definitions.find((stage) => stage.stageId === "erosion")?.footprint.haloChunks === 0, "production erosion must not claim a chunk halo");
rejects(() => (graph.definitions[0].dependencies as string[]).push("render"), /read only|extensible|frozen|object/i, "nested graph definitions are mutable");
rejects(() => createCompilerGraph([stageDefinition("a", ["missing"])]), /missing dependency/, "missing dependency accepted");
rejects(() => createCompilerGraph([stageDefinition("a", ["b"]), stageDefinition("b", ["a"])]), /cycle/, "cycle accepted");
rejects(() => createCompilerGraph([stageDefinition("a"), stageDefinition("a")]), /duplicate stage/, "duplicate stage accepted");
rejects(() => createCompilerGraph([stageDefinition("a"), stageDefinition("b", ["a", "a"])]), /duplicate dependencies/, "duplicate dependency accepted");
rejects(
  () => createCompilerGraph(Array.from({ length: MAX_COMPILER_STAGES + 1 }, (_, index) => stageDefinition(`s${index}`))),
  /1-64 stages/,
  "oversized graph accepted",
);
const denseDefinitions = Array.from({ length: MAX_COMPILER_STAGES }, (_, index) =>
  stageDefinition(`s${String(index).padStart(2, "0")}`, Array.from({ length: Math.min(index, 16) }, (_unused, offset) => `s${String(index - offset - 1).padStart(2, "0")}`)),
);
rejects(() => createCompilerGraph(denseDefinitions), /dependency edges/, "graph exceeding the edge work cap was accepted");

const forgedGraph = clone(graph);
forgedGraph.topologicalOrder = [...forgedGraph.topologicalOrder].reverse();
rejects(() => planCompilerInvalidation({ ...fixture(0), graph: forgedGraph }), /hash or indexes are inconsistent/, "forged graph index accepted");
const staleHashGraph = clone(graph);
staleHashGraph.definitions[2].stageVersion = "9.0.0";
rejects(() => planCompilerInvalidation({ ...fixture(0), graph: staleHashGraph }), /hash or indexes are inconsistent/, "definition mutation with stale graph hash accepted");

// The public cache-key API is exact, domain-separated, and insensitive to dependency input order.
const keyInput = {
  stageId: "render",
  stageVersion: "1.0.0",
  config: { mode: "preview" },
  chunkTopologyHash: hash("topology"),
  sortedDependencyHashes: [
    { dependencyId: "stage:b:chunk", hash: hash("b") },
    { dependencyId: "stage:a:chunk", hash: hash("a") },
  ],
};
assert(
  compilerStageKey(keyInput) === compilerStageKey({ ...keyInput, sortedDependencyHashes: [...keyInput.sortedDependencyHashes].reverse() }),
  "dependency insertion order changed a stage key",
);
rejects(() => compilerStageKey({ ...keyInput, stageId: "INVALID" }), /stageId/, "invalid public stageId accepted");
rejects(() => compilerStageKey({ ...keyInput, sortedDependencyHashes: undefined }), /dependencies/, "missing public dependency array accepted");
rejects(() => compilerStageKey({ ...keyInput, surprise: true }), /unsupported field/, "extra stage-key field accepted");
rejects(() => compilerStageKey({ ...keyInput, chunkTopologyHash: "SHA256:bad" }), /lowercase sha256/, "malformed content hash accepted");

// Identical plans are byte-identical cache hits even when chunk input order changes.
const baseInput = fixture();
const initial = planCompilerInvalidation(baseInput);
const reorderedInput = { ...baseInput, chunks: [...baseInput.chunks].reverse() };
const repeated = planCompilerInvalidation({ ...reorderedInput, previous: initial.snapshot });
assert(canonicalCompilerSnapshot(initial.snapshot) === canonicalCompilerSnapshot(repeated.snapshot), "identical plan was not byte-deterministic");
assert(repeated.invalidation.changedInstances === 0, "identical plan reported changed instances");
assert(repeated.invalidation.cacheHits === 4 + baseInput.chunks.length * 3, "identical plan missed global/chunk cache hits");

// Planner halo capability remains explicit through a synthetic local algorithm graph. The
// production graph above intentionally does not claim canonical erosion is chunk-local.
const centerId = terrainChunkId("grey-field.surface", 0, 0, 0);
const localBaseInput = localHaloFixture();
const localInitial = planCompilerInvalidation(localBaseInput);
const localInput = clone(localBaseInput);
localInput.graph = SYNTHETIC_LOCAL_HALO_GRAPH;
localInput.chunks.find((candidate: { chunkId: string }) => candidate.chunkId === centerId)!.sourceSliceHashes["worldmap.slice"] = hash("worldmap:center:v2");
const noHint = planCompilerInvalidation({ ...localInput, previous: localInitial.snapshot });
const lyingHintId = terrainChunkId("grey-field.surface", 0, 2, 2);
const lyingHint = planCompilerInvalidation({ ...localInput, previous: localInitial.snapshot, clientDirtyHints: [lyingHintId] });
assert(JSON.stringify(noHint.invalidation.changedByStage) === JSON.stringify(lyingHint.invalidation.changedByStage), "client hint narrowed compiler invalidation");
assert(noHint.invalidation.changedByStage.worldmap.length === 1, "local worldmap slice did not invalidate exactly one worldmap stage");
assert(noHint.invalidation.changedByStage["base-height"].length === 1, "local worldmap slice did not invalidate exactly one base-height stage");
for (const stageId of ["erosion", "edit-layers", "collision", "render"]) {
  assert(noHint.invalidation.changedByStage[stageId].length === 9, `${stageId} did not receive the 3x3 erosion halo invalidation`);
}
assert(lyingHint.invalidation.telemetry.extraHintChunks.includes(lyingHintId), "lying hint was not reported as telemetry");
assert(lyingHint.invalidation.telemetry.missedChangedChunks.includes(centerId), "omitted dirty chunk was not reported as telemetry");

// Global configuration and stage algorithm versions invalidate all true dependents.
const seaInput = clone(baseInput);
seaInput.graph = graph;
seaInput.configs.worldmap.seaLevelM = 3;
const seaChange = planCompilerInvalidation({ ...seaInput, previous: initial.snapshot });
for (const stageId of ["worldmap", "base-height", "erosion"]) assert(seaChange.invalidation.changedByStage[stageId].length === 1, `global sea config did not invalidate global ${stageId}`);
assert(seaChange.invalidation.changedByStage["navigation-index"].length === 0, "terrain config leaked into navigation invalidation");
for (const stageId of ["edit-layers", "collision", "render"]) assert(seaChange.invalidation.changedByStage[stageId].length === baseInput.chunks.length, `global sea config did not invalidate every ${stageId} chunk`);
const versionDefinitions = clone(INITIAL_WORLD_COMPILER_STAGE_DEFINITIONS);
versionDefinitions.find((definition: { stageId: string }) => definition.stageId === "erosion")!.stageVersion = "2.0.0";
const versionGraph = createCompilerGraph(versionDefinitions);
const versionChange = planCompilerInvalidation({ ...baseInput, graph: versionGraph, previous: initial.snapshot });
assert(versionChange.invalidation.changedByStage.worldmap.length === 0, "erosion version change invalidated worldmap");
assert(versionChange.invalidation.changedByStage["base-height"].length === 0, "erosion version change invalidated base-height");
assert(versionChange.invalidation.changedByStage["navigation-index"].length === 0, "erosion version change invalidated navigation");
assert(versionChange.invalidation.changedByStage.erosion.length === 1, "erosion version change did not invalidate the global erosion stage");
for (const stageId of ["edit-layers", "collision", "render"]) assert(versionChange.invalidation.changedByStage[stageId].length === baseInput.chunks.length, `erosion version change did not invalidate ${stageId}`);

// Same coordinates in separate grids are legal and cannot contaminate one another's halo.
const multiGridInput = {
  ...localHaloFixture(0),
  chunks: [...localHaloFixture(0, "grid.alpha").chunks, ...localHaloFixture(0, "grid.beta").chunks],
};
const multiBase = planCompilerInvalidation(multiGridInput);
const multiChangedInput = clone(multiGridInput);
multiChangedInput.graph = SYNTHETIC_LOCAL_HALO_GRAPH;
multiChangedInput.chunks[0].sourceSliceHashes["worldmap.slice"] = hash("alpha:v2");
const multiChanged = planCompilerInvalidation({ ...multiChangedInput, previous: multiBase.snapshot });
const alphaId = terrainChunkId("grid.alpha", 0, 0, 0);
const betaId = terrainChunkId("grid.beta", 0, 0, 0);
for (const stageId of SYNTHETIC_LOCAL_HALO_GRAPH.topologicalOrder) {
  assert(JSON.stringify(multiChanged.invalidation.changedByStage[stageId]) === JSON.stringify([alphaId]), `${stageId} crossed grid boundaries: ${JSON.stringify(multiChanged.invalidation.changedByStage[stageId])}`);
  assert(!multiChanged.invalidation.changedByStage[stageId].includes(betaId), `${stageId} invalidated the untouched grid`);
}

// Previous snapshots are untrusted retained data, even when an attacker recomputes the outer hash.
const maliciousSnapshot = clone(initial.snapshot);
maliciousSnapshot.stageKeys.render[centerId] = "sha256:not-a-hash";
delete maliciousSnapshot.snapshotHash;
maliciousSnapshot.snapshotHash = compilerContentHash(maliciousSnapshot);
rejects(
  () => planCompilerInvalidation({ ...baseInput, previous: maliciousSnapshot }),
  /lowercase sha256 content hash/,
  "self-consistent snapshot with malformed stage hash accepted",
);
const unknownInstanceSnapshot = clone(initial.snapshot);
unknownInstanceSnapshot.stageKeys.render["surface:unknown:l0:x0:z0"] = hash("injected");
delete unknownInstanceSnapshot.snapshotHash;
unknownInstanceSnapshot.snapshotHash = compilerContentHash(unknownInstanceSnapshot);
rejects(
  () => planCompilerInvalidation({ ...baseInput, previous: unknownInstanceSnapshot }),
  /unknown instance/,
  "self-consistent snapshot with injected instance accepted",
);

// UTF-8 byte limits count encoded bytes, rather than undercounting JavaScript code units.
const unicodeDefinitions = Array.from({ length: 33 }, (_, index) => stageDefinition(`u${String(index).padStart(2, "0")}`));
const unicodeGraph = createCompilerGraph(unicodeDefinitions);
const unicodeConfigs = Object.fromEntries(unicodeDefinitions.map((definition) => [definition.stageId, { text: "é".repeat(16_000) }]));
assert(JSON.stringify(unicodeConfigs).length < MAX_ALL_STAGE_CONFIG_BYTES, "test fixture no longer distinguishes code units from UTF-8 bytes");
rejects(
  () => planCompilerInvalidation({
    graph: unicodeGraph,
    chunks: [{ ...chunk("unicode.grid", 0, 0), sourceSliceHashes: {} }],
    configs: unicodeConfigs,
    globalSourceHashes: {},
  }),
  /configs exceed/,
  "aggregate config limit undercounted non-ASCII UTF-8 bytes",
);

ops.op_log(
  "p_world_compiler_dag OK: versioned DAG keys are deterministic and tamper-resistant; compiler-owned local/global/version invalidation, halo propagation, multigrid isolation, dirty-hint telemetry, cache hits, strict retained-snapshot validation, and graph/config resource caps are proven.",
);
