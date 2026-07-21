// D5.1 — the derived-terrain edit-layer write path. terrain.deform on a world whose
// authority has a derived MapDoc mounted (and no EditableTerrain layer) materializes
// the brush into sparse lattice deltas, commits the edit layer through a nested
// authoring.commit, and the derived compiler composes it onto the terrain the user
// sees. Proves: (a) the lattice port is byte-identical to applyBrush, (b) the op
// round-trips project state → compile → composed field, (c) replay reproduces
// byte-identical layer content, (d) op-cap folding is deterministic + height-equivalent,
// (e) topology-change rebase surfaces structured conflicts, (f) EditableTerrain worlds
// behave exactly as before.

import { ops } from "../src/engine.ts";
import { AuthoritativeServer, type AuthoritativeInvocationContext, type NetServerTransport, ACCEPT_CLOSED } from "../src/net/server.ts";
import { resolveProfile } from "../src/skills/permissions.ts";
import { parseWorldLog } from "../src/worldlog/log.ts";
import { applyBrush, materializeTerrainBrushOp } from "../src/skills/terrain-edit.ts";
import {
  MAX_TERRAIN_EDIT_OPERATIONS,
  appendTerrainEditStroke,
  canonicalTerrainEditLayer,
  composeTerrainEditLayers,
  createTerrainEditBaseTopology,
  createTerrainEditLayer,
  parseTerrainEditLayer,
  rebaseTerrainEditLayersToBase,
} from "../src/terrain/edit-layer.mjs";
import { terrainEditBaseTopologyForWorldMap } from "../src/terrain/edit-topology.mjs";
import { createTerrainGridSpec, terrainChunkId, terrainChunkTopology } from "../src/terrain/grid.mjs";
import { sha256 } from "../src/world/sha256.mjs";
import { worldMapContentHash, type WorldMap } from "../src/world/worldmap.ts";
import { NO_EROSION_RECIPE } from "../src/world/pipeline/erosion.mjs";
import { decodeTerrainChunkArtifact } from "../src/world/compiler/index.mjs";
import { compileWorldTerrain, WORLD_TERRAIN_COMPILER_CONFIG_SCHEMA } from "../src/world/compiler/terrain-compile.ts";
import type { TerrainTile } from "../src/terrain/types.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`p_terrain_derived_edit_layer FAIL: ${message}`);
}

class IdleTransport implements NetServerTransport {
  async accept(): Promise<number> { return ACCEPT_CLOSED; }
  async recv(_connId: number): Promise<string> { return ""; }
  async send(_connId: number, _line: string): Promise<void> {}
  async close(_connId: number): Promise<void> {}
}

// ---- Shared fixture: a small derived world (16x16 m of land → a 4x4 chunk domain) --

const GRID_ID = "derived-edit.surface";
const MAP_DOC_CANONICAL = `${JSON.stringify({ layers: [], mapId: "derived-edit-fixture", schema: "limina.map-doc/v1" })}\n`;
const MAP_DOC_HASH = `sha256:${sha256(MAP_DOC_CANONICAL)}`;

function fixtureMap(): WorldMap {
  const core = {
    version: 1 as const,
    id: "derived-edit-fixture",
    unitsPerMeter: 1,
    origin: [0, 0] as [number, number],
    extent: { w: 16, h: 16 },
    seaLevel: 0,
    land: [{ points: [[-8, -8], [8, -8], [8, 8], [-8, 8]] as [number, number][] }],
    relief: [],
    biomes: [{ biome: "grass" as const, points: [[-8, -8], [8, -8], [8, 8], [-8, 8]] as [number, number][] }],
    waterways: [],
    routes: [],
    anchors: [],
    provenance: { tool: "design-space" as const, sourceHash: MAP_DOC_HASH.slice("sha256:".length), contentHash: "pending" },
  };
  const contentHash = worldMapContentHash(core as WorldMap);
  return { ...core, provenance: { ...core.provenance, contentHash } } as WorldMap;
}

const map = fixtureMap();
const baseTopology = terrainEditBaseTopologyForWorldMap(map, { gridId: GRID_ID });
const grid = baseTopology.grid;
const intervals = grid.defaultSamples - 1; // 32
const stepM = grid.chunkSizeM / intervals; // 1.5 m
const minGx = baseTopology.domain.minTx * intervals;
const minGz = baseTopology.domain.minTz * intervals;
const maxGx = (baseTopology.domain.maxTx + 1) * intervals;
const maxGz = (baseTopology.domain.maxTz + 1) * intervals;
const samplesX = maxGx - minGx + 1;
const samplesZ = maxGz - minGz + 1;
assert(samplesX === 129 && samplesZ === 129, `fixture domain must be 129x129 samples, got ${samplesX}x${samplesZ}`);

/** Deterministic non-flat base field over the domain lattice (Float32Array storage). */
function baseField(): Float32Array {
  const field = new Float32Array(samplesX * samplesZ);
  for (let row = 0; row < samplesZ; row++) {
    for (let col = 0; col < samplesX; col++) {
      field[row * samplesX + col] = Math.fround(((col * 3 + row * 7) % 11) - 5) * 0.5 + Math.fround((col * row) % 7) * 0.125;
    }
  }
  return field;
}

function compileInput(layers: unknown[], refs: unknown[]) {
  return {
    request: { projectId: "derived-edit", branchId: "main", revision: 4, headHash: `sha256:${sha256("head:4")}` },
    worldMap: map,
    sourceRefs: {
      mapDocument: { refId: "map-document", refType: "map-document/v1", scope: "global", assetId: "assets/sources/map-doc/fixture.mapdoc.json", contentHash: MAP_DOC_HASH },
    },
    terrainEditLayers: layers,
    terrainEditLayerRefs: refs,
    compiler: {
      version: "1.0.0",
      config: {
        schema: WORLD_TERRAIN_COMPILER_CONFIG_SCHEMA,
        seed: 7,
        baseAmplitude: 12,
        erosionRecipe: NO_EROSION_RECIPE,
        gridId: GRID_ID,
        verticalRange: { minM: -500, maxM: 9000 },
        limits: { maxChunks: 4096, maxMasterSamples: 1_050_625, maxArtifactBytes: 256 * 1024 * 1024 },
      },
    },
    previousSnapshot: null,
    cancellation: { shouldCancel: () => false },
  };
}

// ---- (a) Differential: lattice materialization === applyBrush, byte-identical ------

{
  const tile = (): TerrainTile => ({
    nrows: samplesZ,
    ncols: samplesX,
    origin: [0, 0, 0],
    scale: [grid.chunkSizeM * (samplesX - 1) / intervals, 1, grid.chunkSizeM * (samplesZ - 1) / intervals],
    heights: baseField(),
  });
  const strokes: { mode: "raise" | "lower" | "smooth" | "flatten" | "noise"; falloff: "smooth" | "linear" | "constant" }[] = [];
  for (const mode of ["raise", "lower", "smooth", "flatten", "noise"] as const) {
    for (const falloff of ["smooth", "linear", "constant"] as const) strokes.push({ mode, falloff });
  }
  for (const { mode, falloff } of strokes) {
    const input = { center: [12.75, -20.25] as [number, number], radius: 11, delta: mode === "flatten" ? 1.5 : 2.5, mode, falloff };
    const tileAfter = tile();
    applyBrush(tileAfter, input as never);
    const field = baseField();
    const sampler = (gx: number, gz: number) => field[(gz - minGz) * samplesX + (gx - minGx)];
    const deltas = materializeTerrainBrushOp(baseTopology, input, sampler);
    assert(deltas.length > 0, `differential ${mode}/${falloff} produced no deltas`);
    const layer = createTerrainEditLayer({
      layerId: "diff",
      baseTopology,
      operations: [{ operationId: "op-000000", kind: "add", deltas }],
    });
    const composed = baseField();
    for (let tz = baseTopology.domain.minTz; tz <= baseTopology.domain.maxTz; tz++) {
      for (let tx = baseTopology.domain.minTx; tx <= baseTopology.domain.maxTx; tx++) {
        const chunkBase = new Float32Array(grid.defaultSamples * grid.defaultSamples);
        for (let row = 0; row < grid.defaultSamples; row++) {
          for (let col = 0; col < grid.defaultSamples; col++) {
            chunkBase[row * grid.defaultSamples + col] = composed[(tz * intervals + row - minGz) * samplesX + (tx * intervals + col - minGx)];
          }
        }
        const out = composeTerrainEditLayers({
          baseTopology,
          chunkTopology: terrainChunkTopology(grid, { lod: 0, tx, tz, samples: grid.defaultSamples }),
          baseHeightsM: chunkBase,
          layers: [layer],
        });
        for (let row = 0; row < grid.defaultSamples; row++) {
          for (let col = 0; col < grid.defaultSamples; col++) {
            composed[(tz * intervals + row - minGz) * samplesX + (tx * intervals + col - minGx)] = out.heightsM[row * grid.defaultSamples + col];
          }
        }
      }
    }
    let firstDiff = -1;
    for (let index = 0; index < composed.length; index++) {
      if (!Object.is(composed[index], tileAfter.heights[index])) { firstDiff = index; break; }
    }
    assert(firstDiff === -1, `differential ${mode}/${falloff} diverged at sample ${firstDiff}: lattice ${firstDiff >= 0 ? composed[firstDiff] : "?"} vs tile ${firstDiff >= 0 ? tileAfter.heights[firstDiff] : "?"}`);
  }
  ops.op_log("[js] p_terrain_derived_edit_layer (a) OK: lattice materialization is byte-identical to applyBrush for raise/lower/smooth/flatten/noise x smooth/linear/constant");
}

// ---- Server harness for (b), (c), (f) ---------------------------------------------

const projectId = "derived-edit";
const context: AuthoritativeInvocationContext = {
  agentId: "agt_derived_edit",
  sessionId: "ses_derived_edit",
  profile: "builder.readWrite",
  permissions: resolveProfile("builder.readWrite"),
};

interface DerivedServer { server: AuthoritativeServer; resolverCalls: () => number }

function derivedServer(logName: string, resolver: () => number): DerivedServer {
  return {
    server: new AuthoritativeServer(new IdleTransport(), {
      sessionId: "p_terrain_derived_edit_layer",
      tickMs: 1000,
      worldLog: { name: logName },
      authoring: {
        projectId,
        derivedTerrainTopology: (mapDocRef) => {
          assert(mapDocRef.hash === MAP_DOC_HASH, "resolver received a foreign MapDoc ref");
          resolver();
          return baseTopology;
        },
      },
    }),
    resolverCalls: resolver,
  };
}

async function invoke(server: AuthoritativeServer, tool: string, input: Record<string, unknown>) {
  const response = await server.invokeAuthoritatively(tool, input, context);
  assert(response.success, `${tool} failed: ${JSON.stringify(response.error)}`);
  return response.result as Record<string, never>;
}

async function mountMapDoc(server: AuthoritativeServer): Promise<void> {
  const snapshot = (await invoke(server, "authoring.sourceSnapshot", {})) as unknown as {
    head: { revision: number; headHash: string };
    projectState: { stateHash: string };
  };
  const transaction = {
    schema: "limina.authoring-transaction/v1",
    transactionId: "mount-mapdoc-derived-edit",
    projectId,
    baseRevision: snapshot.head.revision,
    baseHeadHash: snapshot.head.headHash,
    operations: [{
      adapter: "project-state",
      adapterVersion: "1.0.0",
      action: "refs.patch",
      input: { projectId, patch: { mapDoc: { assetId: "assets/sources/map-doc/fixture.mapdoc.json", hash: MAP_DOC_HASH } } },
      guard: { beforeHash: snapshot.projectState.stateHash },
    }],
  };
  await invoke(server, "authoring.commit", { transaction });
}

// ---- (b) + (c): commit path, compile round-trip, replay ----------------------------

const LOG = "p_terrain_derived_edit_layer.jsonl";
ops.op_write_trace(LOG, "");
let resolverCalls = 0;
const first = derivedServer(LOG, () => resolverCalls++);
await first.server.ready;
await mountMapDoc(first.server);

// No mapDoc → no derived path: covered by the (f) server's legacy check below.
const stroke = await invoke(first.server, "terrain.deform", { center: [0, 0], radius: 6, delta: 2, mode: "raise" }) as unknown as {
  ok: boolean;
  baseTopology: { topologyHash: string };
  layerRef: { assetId: string; hash: string; layerId: string; baseTopologyHash: string };
  derived: { layerId: string; deltaCount: number; folded: boolean; contentHash: string };
};
assert(stroke.ok === true, "derived deform returned ok:false");
assert(stroke.baseTopology.topologyHash === baseTopology.topologyHash, "stroke bound to a foreign base topology");
assert(stroke.derived.layerId === `derived-${GRID_ID}`, `unexpected layer id ${stroke.derived.layerId}`);
assert(stroke.derived.deltaCount > 0 && stroke.derived.folded === false, "stroke accounting is wrong");
assert(stroke.layerRef.hash === stroke.derived.contentHash, "layer ref does not pin the layer content hash");
assert(stroke.layerRef.baseTopologyHash === baseTopology.topologyHash, "layer ref does not pin the base topology hash");
assert(resolverCalls === 1, `live stroke must resolve the topology exactly once, got ${resolverCalls}`);

const stateAfterStroke = (await invoke(first.server, "authoring.projectState", {})) as unknown as {
  stateHash: string;
  refs: { terrainEditLayers: { assetId: string; hash: string; layerId: string; baseTopologyHash: string }[] };
};
assert(stateAfterStroke.refs.terrainEditLayers.length === 1, "project state did not gain the derived edit layer");
assert(stateAfterStroke.refs.terrainEditLayers[0].hash === stroke.derived.contentHash, "project state ref does not pin the committed layer");

const readBack = await invoke(first.server, "authoring.terrainEditLayer", { assetId: stroke.layerRef.assetId, hash: stroke.layerRef.hash }) as unknown as { layer: unknown };
const layer = parseTerrainEditLayer(readBack.layer);
assert(layer.contentHash === stroke.derived.contentHash, "live store returned a different layer");
const centerDelta = layer.operations[0].deltas.find((delta) => delta.gx === 0 && delta.gz === 0);
assert(centerDelta !== undefined && centerDelta.deltaM === 2, `brush center delta must be delta * falloff(1) = 2, got ${centerDelta?.deltaM}`);

// The recorded command pins the resolved topology + committed layer identity.
const recordedDeform = parseWorldLog(ops.op_read_trace(LOG)).commands.find((command) => command.kind === "skill" && command.tool === "terrain.deform");
assert(recordedDeform !== undefined && recordedDeform.kind === "skill", "derived deform was not recorded");
const recordedInput = recordedDeform.input as { baseTopology?: { topologyHash: string }; layerRef?: { hash: string } };
assert(recordedInput.baseTopology?.topologyHash === baseTopology.topologyHash, "recorded command did not pin the base topology");
assert(recordedInput.layerRef?.hash === stroke.derived.contentHash, "recorded command did not pin the committed layer");

// (b) Round-trip: project state → compile request → composed field moved by delta.
{
  const ref = stateAfterStroke.refs.terrainEditLayers[0];
  const compiled = compileWorldTerrain(compileInput([layer], [{
    refId: "terrain-edit-layer-000",
    refType: "terrain-edit-layer/v1",
    scope: "chunk",
    assetId: ref.assetId,
    contentHash: ref.hash,
  }]));
  const compiledBase = compileWorldTerrain(compileInput([], []));
  const chunkId = terrainChunkId(GRID_ID, 0, 0, 0);
  const editedTile = compiled.artifacts.find((artifact: { chunkId?: string }) => artifact.chunkId === chunkId);
  const baseTile = compiledBase.artifacts.find((artifact: { chunkId?: string }) => artifact.chunkId === chunkId);
  assert(editedTile !== undefined && baseTile !== undefined, "compile did not emit the stroke chunk");
  const edited = decodeTerrainChunkArtifact((editedTile as { bytes: Uint8Array }).bytes).tile;
  const base = decodeTerrainChunkArtifact((baseTile as { bytes: Uint8Array }).bytes).tile;
  // Sample (gx 0, gz 0) is chunk (0,0)'s local [0,0]; metres = origin.y + h * scaleY.
  const editedM = edited.origin[1] + edited.heights[0] * edited.scale[1];
  const baseM = base.origin[1] + base.heights[0] * base.scale[1];
  assert(Math.abs(editedM - baseM - 2) < 2e-3, `composed terrain at the stroke center moved ${editedM - baseM}m instead of 2m`);
  ops.op_log("[js] p_terrain_derived_edit_layer (b) OK: the committed op round-trips project state → compile → composed field (stroke center moved by delta)");
}

// (c) Replay: reboot rehydrates the recorded stroke into byte-identical layer content.
const canonicalBefore = canonicalTerrainEditLayer(readBack.layer);
const stateHashBefore = stateAfterStroke.stateHash;
await first.server.shutdown();
const second = derivedServer(LOG, () => resolverCalls++);
await second.server.ready;
assert(resolverCalls === 1, `rehydrate must use the pinned topology, not the resolver (calls ${resolverCalls})`);
const stateAfterReplay = (await invoke(second.server, "authoring.projectState", {})) as unknown as { stateHash: string };
assert(stateAfterReplay.stateHash === stateHashBefore, "rehydrate reconstructed a different project state");
const replayedLayer = await invoke(second.server, "authoring.terrainEditLayer", { assetId: stroke.layerRef.assetId, hash: stroke.layerRef.hash }) as unknown as { layer: unknown };
assert(canonicalTerrainEditLayer(replayedLayer.layer) === canonicalBefore, "rehydrate reconstructed different layer bytes");

// A second live stroke after the reboot appends; a second reboot replays BOTH identically.
const stroke2 = await invoke(second.server, "terrain.deform", { center: [3, 0], radius: 6, delta: 1, mode: "lower" }) as unknown as { ok: boolean; derived: { contentHash: string; deltaCount: number } };
assert(stroke2.ok === true, "second stroke after reboot failed");
const layer2 = await invoke(second.server, "authoring.terrainEditLayer", { assetId: stroke.layerRef.assetId.replace(/[0-9a-f]{64}/, stroke2.derived.contentHash.slice(7)), hash: stroke2.derived.contentHash }) as unknown as { layer: unknown };
const canonical2 = canonicalTerrainEditLayer(layer2.layer);
assert(parseTerrainEditLayer(layer2.layer).operations.length === 2, "second stroke did not append an operation");
// Chain contiguity: a TOP-LEVEL commit after the nested deform commits pins its own
// durable record — rehydrate must re-commit the nested ones with their pinned records
// or this top-level record no longer chains onto the kernel tail.
const snapshot2 = (await invoke(second.server, "authoring.sourceSnapshot", {})) as unknown as {
  head: { revision: number; headHash: string };
  projectState: { stateHash: string; refs: { mapDoc: { assetId: string; hash: string } } };
};
await invoke(second.server, "authoring.commit", {
  transaction: {
    schema: "limina.authoring-transaction/v1",
    transactionId: "post-stroke-look-profile",
    projectId,
    baseRevision: snapshot2.head.revision,
    baseHeadHash: snapshot2.head.headHash,
    operations: [{
      adapter: "project-state",
      adapterVersion: "1.0.0",
      action: "refs.patch",
      input: { projectId, patch: { lookProfile: null } },
      guard: { beforeHash: snapshot2.projectState.stateHash },
    }],
  },
});
await second.server.shutdown();
const third = derivedServer(LOG, () => resolverCalls++);
await third.server.ready;
const replayedLayer2 = await invoke(third.server, "authoring.terrainEditLayer", { assetId: "x", hash: stroke2.derived.contentHash }) as unknown as { layer: unknown };
assert(canonicalTerrainEditLayer(replayedLayer2.layer) === canonical2, "second rehydrate reconstructed different layer bytes");
const headAfterChain = (await invoke(third.server, "authoring.head", {})) as unknown as { revision: number };
assert(headAfterChain.revision === snapshot2.head.revision + 1, "rehydrate lost the top-level commit after the nested ones");
await third.server.shutdown();
ops.op_log("[js] p_terrain_derived_edit_layer (c) OK: invoke → rehydrate → invoke → rehydrate reproduces byte-identical layer content, and the durable record chain stays contiguous across nested + top-level commits");

// ---- (d) Op-cap folding: deterministic + height-equivalent --------------------------

{
  const oneDelta = [{ gx: 0, gz: 0, deltaM: 0.1 }];
  const cappedLayer = createTerrainEditLayer({
    layerId: "fold-fixture",
    baseTopology,
    operations: Array.from({ length: MAX_TERRAIN_EDIT_OPERATIONS }, (_, index) => ({
      operationId: `op-${String(index).padStart(6, "0")}`,
      kind: "add",
      deltas: oneDelta,
    })),
  });
  const strokeDeltas = [{ gx: 0, gz: 0, deltaM: 0.1 }, { gx: 1, gz: 0, deltaM: 1 }];
  const foldedA = appendTerrainEditStroke(cappedLayer, { layerId: "fold-fixture", baseTopology, deltas: strokeDeltas });
  const foldedB = appendTerrainEditStroke(cappedLayer, { layerId: "fold-fixture", baseTopology, deltas: strokeDeltas });
  assert(foldedA.folded === true, "append past the op cap did not fold");
  assert(foldedA.layer.operations.length < MAX_TERRAIN_EDIT_OPERATIONS, `fold did not compact (${foldedA.layer.operations.length} ops)`);
  assert(foldedA.layer.contentHash === foldedB.layer.contentHash, "fold is not deterministic");
  const chunk = terrainChunkTopology(grid, { lod: 0, tx: 0, tz: 0, samples: grid.defaultSamples });
  const baseHeights = new Float32Array(grid.defaultSamples * grid.defaultSamples).fill(10);
  // Manual reference (the unfolded 1025-op stack exceeds the format's op cap): apply
  // every delta in order with one float32 rounding per application.
  const unfolded = new Float32Array(baseHeights);
  for (const operation of [...cappedLayer.operations, { deltas: strokeDeltas }]) {
    for (const delta of operation.deltas) {
      const index = (delta.gz - chunk.tz * intervals) * grid.defaultSamples + (delta.gx - chunk.tx * intervals);
      unfolded[index] = Math.fround(unfolded[index] + delta.deltaM);
    }
  }
  const folded = composeTerrainEditLayers({ baseTopology, chunkTopology: chunk, baseHeightsM: baseHeights, layers: [foldedA.layer] });
  // One float32 rounding per applied delta vs one per merged key: the difference is
  // bounded by the op count times half a ulp of the accumulated magnitude.
  let maxDiff = 0;
  for (let index = 0; index < folded.heightsM.length; index++) {
    maxDiff = Math.max(maxDiff, Math.abs(folded.heightsM[index] - unfolded[index]));
  }
  assert(maxDiff < 0.01, `folded composition diverged by ${maxDiff}m — beyond float-rounding equivalence`);
  assert(folded.heightsM[0] > 110 && unfolded[0] > 110, "fold fixture lost its accumulated deltas");
  // The delta cap folds the same way: four full-domain sweeps (66,564 deltas over 16,641
  // unique keys) plus one more stroke must merge by lattice key, not fail the write.
  const domainDeltas = [];
  for (let gz = minGz; gz <= maxGz; gz++) for (let gx = minGx; gx <= maxGx; gx++) domainDeltas.push({ gx, gz, deltaM: 0.25 });
  let swept;
  for (let sweep = 0; sweep < 4; sweep++) {
    swept = appendTerrainEditStroke(swept?.layer, { layerId: "sweep", baseTopology, deltas: domainDeltas });
  }
  assert(swept.folded === true, "crossing the delta cap did not fold");
  const sweptTotal = swept.layer.operations.reduce((total, operation) => total + operation.deltas.length, 0);
  assert(sweptTotal === samplesX * samplesZ, `delta-cap fold must merge onto ${samplesX * samplesZ} unique keys, got ${sweptTotal}`);
  const sweptAgain = appendTerrainEditStroke(swept.layer, { layerId: "sweep", baseTopology, deltas: domainDeltas });
  assert(sweptAgain.layer.operations.length <= 16, "folded layer must stay within per-operation caps");
  ops.op_log("[js] p_terrain_derived_edit_layer (d) OK: op-cap and delta-cap folding are deterministic and height-equivalent within float rounding");
}

// ---- (e) Topology-change rebase: structured conflicts, never a silent drop ----------

{
  const grownDomain = createTerrainEditBaseTopology({
    grid,
    domain: { minTx: baseTopology.domain.minTx - 1, minTz: baseTopology.domain.minTz, maxTx: baseTopology.domain.maxTx, maxTz: baseTopology.domain.maxTz },
  });
  const strokeLayer = createTerrainEditLayer({
    layerId: "rebase-me",
    baseTopology,
    operations: [{ operationId: "op-000000", kind: "add", deltas: [{ gx: 0, gz: 0, deltaM: 2 }, { gx: 1, gz: 1, deltaM: -1 }] }],
  });
  const grown = rebaseTerrainEditLayersToBase([strokeLayer], grownDomain);
  assert(grown.ok === true && grown.layers.length === 1, "domain growth did not rebase exactly");
  if (grown.ok) {
    assert(grown.layers[0].baseTopology.topologyHash === grownDomain.topologyHash, "rebased layer kept the stale topology");
    assert(grown.layers[0].operations[0].deltas.length === 2, "exact rebase dropped deltas");
    assert(grown.reports.length === 1 && grown.reports[0].report.mappedDeltaCount === 2, "rebase report is incomplete");
  }
  const same = rebaseTerrainEditLayersToBase([strokeLayer], baseTopology);
  assert(same.ok && same.layers[0].contentHash === strokeLayer.contentHash, "an on-base layer was needlessly rewritten");
  const foreignGrid = createTerrainEditBaseTopology({
    grid: createTerrainGridSpec({ gridId: "other-grid", origin: [0, 0], chunkSizeM: 48, defaultSamples: 33 }),
    domain: baseTopology.domain,
  });
  const mismatched = rebaseTerrainEditLayersToBase([strokeLayer], foreignGrid);
  assert(!mismatched.ok, "a foreign grid did not conflict");
  if (!mismatched.ok) {
    assert(mismatched.failures.length === 1 && mismatched.failures[0].conflicts.some((conflict) => conflict.code === "grid_mismatch"), "grid mismatch conflict is not structured");
  }
  const shrunken = createTerrainEditBaseTopology({
    grid,
    domain: { minTx: 0, minTz: 0, maxTx: 0, maxTz: 0 },
  });
  const outLayer = createTerrainEditLayer({
    layerId: "outside-me",
    baseTopology: shrunken,
    operations: [{ operationId: "op-000000", kind: "add", deltas: [{ gx: 32, gz: 32, deltaM: 2 }] }],
  });
  const outside = rebaseTerrainEditLayersToBase([outLayer], createTerrainEditBaseTopology({ grid, domain: { minTx: 0, minTz: 0, maxTx: 0, maxTz: 0 } }));
  assert(outside.ok, "identity rebase failed");
  const outsideFail = rebaseTerrainEditLayersToBase([
    createTerrainEditLayer({
      layerId: "outside-me",
      baseTopology,
      operations: [{ operationId: "op-000000", kind: "add", deltas: [{ gx: -1, gz: -1, deltaM: 2 }] }],
    }),
  ], shrunken);
  assert(!outsideFail.ok && outsideFail.failures[0].conflicts.some((conflict) => conflict.code === "outside_target_domain"), "domain shrink did not surface outside_target_domain");
  ops.op_log("[js] p_terrain_derived_edit_layer (e) OK: topology-change rebase is exact when representable and surfaces structured conflicts otherwise");
}

// ---- (f) Regression: a world WITH an EditableTerrain layer is unchanged -------------

const REGRESSION_LOG = "p_terrain_derived_edit_layer_regression.jsonl";
ops.op_write_trace(REGRESSION_LOG, "");
{
  const regression = derivedServer(REGRESSION_LOG, () => resolverCalls++);
  await regression.server.ready;
  await mountMapDoc(regression.server);
  // No EditableTerrain + NO mapDoc-style derived intent here → a stray entity still
  // misses derived only when a mapDoc is mounted; with the map mounted but an editable
  // layer present, the editable path must win.
  const noLayerYet = await regression.server.invokeAuthoritatively("terrain.deform", { entity: "ent_missing", center: [0, 0], radius: 4, delta: 1, mode: "smooth" }, context);
  assert(!noLayerYet.success && noLayerYet.error?.code === "invalid_input", "smooth on derived terrain without a height sampler must fail loudly");
  const created = await invoke(regression.server, "terrain.create", { size: 48, resolution: 33, baseHeight: 0 });
  const editable = await invoke(regression.server, "terrain.deform", { center: [0, 0], radius: 12, delta: 3, mode: "raise" }) as unknown as { ok: boolean; derived?: unknown };
  assert(editable.ok === true && editable.derived === undefined, "a world with an EditableTerrain layer took the derived path");
  const named = await invoke(regression.server, "terrain.deform", { entity: created.entity, center: [4, 0], radius: 8, delta: 1, mode: "raise" }) as unknown as { ok: boolean; derived?: unknown };
  assert(named.ok === true && named.derived === undefined, "an explicit editable entity took the derived path");
  const state = (await invoke(regression.server, "authoring.projectState", {})) as unknown as { refs: { terrainEditLayers: unknown[] } };
  assert(state.refs.terrainEditLayers.length === 0, "the editable path committed derived edit layers");
  const editCommits = parseWorldLog(ops.op_read_trace(REGRESSION_LOG)).commands.filter((command) =>
    command.kind === "skill" && command.tool === "authoring.commit"
    && JSON.stringify(command.input).includes("terrain-edit-"));
  assert(editCommits.length === 0, "the editable path recorded derived edit commits");
  await regression.server.shutdown();
  ops.op_log("[js] p_terrain_derived_edit_layer (f) OK: a world with an EditableTerrain layer behaves exactly as before");
}

ops.op_log("p_terrain_derived_edit_layer OK: derived-terrain deform materializes sparse lattice deltas (byte-identical to applyBrush), commits them through nested authoring.commit with replay pins, round-trips into the compiled field, replays byte-identically, folds deterministically at the op cap, rebases with structured conflicts, and leaves EditableTerrain worlds untouched.");
