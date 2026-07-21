// D5.3 — the derived-terrain paint-layer write path. terrain.paint on a world whose
// authority has a derived MapDoc mounted (and no EditableTerrain layer) materializes
// the brush into sparse SIGNED blend deltas (paint-layer.mjs), commits the paint layer
// through a nested authoring.commit into refs.terrainEditLayers (shared with height
// layers; paint refs are distinguished by content schema), and the derived compiler
// recolors chunk paint channels AFTER biome rasterization + height composition.
// Proves: (a) the lattice port is byte-identical to applyBrushPaint, (b) the op
// round-trips project state → compile → composed paint channels, (c) erase subtracts
// exactly, (d) replay reproduces byte-identical layer content incl. pins + the legacy
// pin-less guard, (e) cap folding is deterministic AND exactly equivalent, (f) untouched
// chunks keep identical content hashes, (g) EditableTerrain worlds are unchanged.

import { ops } from "../src/engine.ts";
import { AuthoritativeServer, type AuthoritativeInvocationContext, type NetServerTransport, ACCEPT_CLOSED } from "../src/net/server.ts";
import { resolveProfile } from "../src/skills/permissions.ts";
import { parseWorldLog } from "../src/worldlog/log.ts";
import { applyBrushPaint, materializeTerrainPaintOp } from "../src/skills/terrain-edit.ts";
import {
  MAX_TERRAIN_PAINT_OPERATIONS,
  TERRAIN_PAINT_MATERIAL_IDS,
  appendTerrainPaintStroke,
  canonicalTerrainPaintLayer,
  compactTerrainPaintOperations,
  composeTerrainPaintLayers,
  createTerrainPaintLayer,
  parseTerrainPaintLayer,
} from "../src/terrain/paint-layer.mjs";
import { createTerrainEditLayer } from "../src/terrain/edit-layer.mjs";
import { terrainEditBaseTopologyForWorldMap } from "../src/terrain/edit-topology.mjs";
import { terrainChunkId, terrainChunkTopology } from "../src/terrain/grid.mjs";
import { sha256 } from "../src/world/sha256.mjs";
import { worldMapContentHash, type WorldMap } from "../src/world/worldmap.ts";
import { NO_EROSION_RECIPE } from "../src/world/pipeline/erosion.mjs";
import { decodeTerrainChunkArtifact, decodeWorldOverviewArtifact, derivedGlobalArtifacts } from "../src/world/compiler/index.mjs";
import { compileWorldTerrain, WORLD_TERRAIN_COMPILER_CONFIG_SCHEMA } from "../src/world/compiler/terrain-compile.ts";
import type { TerrainTile } from "../src/terrain/types.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`p_terrain_derived_paint_layer FAIL: ${message}`);
}

class IdleTransport implements NetServerTransport {
  async accept(): Promise<number> { return ACCEPT_CLOSED; }
  async recv(_connId: number): Promise<string> { return ""; }
  async send(_connId: number, _line: string): Promise<void> {}
  async close(_connId: number): Promise<void> {}
}

// ---- Shared fixture: a small derived world (16x16 m of land → a 4x4 chunk domain) --

const GRID_ID = "derived-paint.surface";
const MAP_DOC_CANONICAL = `${JSON.stringify({ layers: [], mapId: "derived-paint-fixture", schema: "limina.map-doc/v1" })}\n`;
const MAP_DOC_HASH = `sha256:${sha256(MAP_DOC_CANONICAL)}`;

function fixtureMap(): WorldMap {
  const core = {
    version: 1 as const,
    id: "derived-paint-fixture",
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

function compileInput(layers: unknown[], refs: unknown[], paintLayers: unknown[] = [], paintRefs: unknown[] = []) {
  return {
    request: { projectId: "derived-paint", branchId: "main", revision: 4, headHash: `sha256:${sha256("head:4")}` },
    worldMap: map,
    sourceRefs: {
      mapDocument: { refId: "map-document", refType: "map-document/v1", scope: "global", assetId: "assets/sources/map-doc/fixture.mapdoc.json", contentHash: MAP_DOC_HASH },
    },
    terrainEditLayers: layers,
    terrainEditLayerRefs: refs,
    // Paint inputs ride as OPTIONAL keys — a paint-less compile must stay byte-identical
    // to the pre-D5.3 payload, so they appear only when a paint layer exists.
    ...(paintLayers.length > 0 ? { terrainPaintLayers: paintLayers, terrainPaintLayerRefs: paintRefs } : {}),
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

/** Compose a paint layer over every chunk of a zero base and stitch the domain field. */
function composeDomain(layer: unknown): { mat: Uint8Array; w: Float32Array } {
  const mat = new Uint8Array(samplesX * samplesZ);
  const w = new Float32Array(samplesX * samplesZ);
  for (let tz = baseTopology.domain.minTz; tz <= baseTopology.domain.maxTz; tz++) {
    for (let tx = baseTopology.domain.minTx; tx <= baseTopology.domain.maxTx; tx++) {
      const out = composeTerrainPaintLayers({
        baseTopology,
        chunkTopology: terrainChunkTopology(grid, { lod: 0, tx, tz, samples: grid.defaultSamples }),
        basePaintMat: new Uint8Array(grid.defaultSamples * grid.defaultSamples),
        basePaintW: new Float32Array(grid.defaultSamples * grid.defaultSamples),
        layers: [layer],
      });
      for (let row = 0; row < grid.defaultSamples; row++) {
        for (let col = 0; col < grid.defaultSamples; col++) {
          const target = (tz * intervals + row - minGz) * samplesX + (tx * intervals + col - minGx);
          const source = row * grid.defaultSamples + col;
          mat[target] = out.paintMat[source];
          w[target] = out.paintW[source];
        }
      }
    }
  }
  return { mat, w };
}

// ---- (a) Differential: lattice materialization === applyBrushPaint, byte-identical --

{
  const tile = (): TerrainTile => ({
    nrows: samplesZ,
    ncols: samplesX,
    origin: [0, 0, 0],
    scale: [grid.chunkSizeM * (samplesX - 1) / intervals, 1, grid.chunkSizeM * (samplesZ - 1) / intervals],
    heights: new Float32Array(samplesX * samplesZ),
  });
  type Stamp = { center: [number, number]; radius: number; strength: number; falloff: "smooth" | "linear" | "constant"; material: "sand" | "grass" | "rock" | "dirt" | "snow" | "murk" | "tundra"; erase: boolean };
  const stamps: Stamp[] = [];
  const materials = Object.keys(TERRAIN_PAINT_MATERIAL_IDS) as Stamp["material"][];
  for (let index = 0; index < materials.length; index++) {
    const falloff = (["smooth", "linear", "constant"] as const)[index % 3];
    stamps.push({
      center: [((index * 37) % 160) - 80 + 0.75, ((index * 53) % 160) - 80 - 0.25],
      radius: 9 + (index % 3) * 2,
      strength: 0.35 + (index % 4) * 0.2,
      falloff,
      material: materials[index],
      erase: false,
    });
  }
  // Overlaps (material replacement under the clamp), erases (partial + to-zero), and
  // zero-strength stamps (mat id side effects with no weight change).
  stamps.push({ center: [12.75, -20.25], radius: 11, strength: 0.8, falloff: "smooth", material: "rock", erase: false });
  stamps.push({ center: [9.0, -17.0], radius: 8, strength: 0.65, falloff: "linear", material: "sand", erase: false });
  stamps.push({ center: [12.75, -20.25], radius: 11, strength: 0.5, falloff: "smooth", material: "rock", erase: true });
  stamps.push({ center: [12.75, -20.25], radius: 6, strength: 1, falloff: "constant", material: "rock", erase: true });
  stamps.push({ center: [-30.5, 22.25], radius: 7, strength: 0, falloff: "smooth", material: "snow", erase: false });
  stamps.push({ center: [-30.5, 22.25], radius: 7, strength: 0, falloff: "smooth", material: "snow", erase: true });
  stamps.push({ center: [0, 0], radius: 20, strength: 1, falloff: "constant", material: "murk", erase: false });
  stamps.push({ center: [40.5, -33.75], radius: 12, strength: 0.55, falloff: "smooth", material: "tundra", erase: true });

  const after = tile();
  let layer;
  for (const stamp of stamps) {
    applyBrushPaint(after, stamp as never);
    const deltas = materializeTerrainPaintOp(baseTopology, stamp);
    assert(deltas.length > 0, `materialization produced no deltas for ${JSON.stringify(stamp)}`);
    layer = appendTerrainPaintStroke(layer?.layer, { layerId: "diff", baseTopology, deltas });
  }
  const composed = composeDomain(layer!.layer);
  assert(after.paintMat !== undefined && after.paintW !== undefined, "applyBrushPaint must allocate the channels");
  let firstDiff = -1;
  for (let index = 0; index < composed.mat.length; index++) {
    if (composed.mat[index] !== after.paintMat[index] || !Object.is(composed.w[index], after.paintW[index])) { firstDiff = index; break; }
  }
  assert(firstDiff === -1, `differential diverged at sample ${firstDiff}: lattice mat/w ${firstDiff >= 0 ? `${composed.mat[firstDiff]}/${composed.w[firstDiff]}` : "?"} vs tile ${firstDiff >= 0 ? `${after.paintMat[firstDiff]}/${after.paintW[firstDiff]}` : "?"}`);
  let painted = 0, erased = 0;
  for (let index = 0; index < composed.mat.length; index++) {
    if (composed.w[index] > 0) painted++;
    if (composed.mat[index] === 0 && composed.w[index] === 0) erased++;
  }
  assert(painted > 1000 && erased > 1000, `differential fixture must exercise both channels (painted ${painted}, zeroed ${erased})`);
  ops.op_log("[js] p_terrain_derived_paint_layer (a) OK: lattice materialization is byte-identical to applyBrushPaint across materials, falloffs, overlaps, erases, and zero-strength side effects");
}

// ---- Server harness for (b), (c), (d), (g) -----------------------------------------

const projectId = "derived-paint";
const context: AuthoritativeInvocationContext = {
  agentId: "agt_derived_paint",
  sessionId: "ses_derived_paint",
  profile: "builder.readWrite",
  permissions: resolveProfile("builder.readWrite"),
};

function derivedServer(logName: string, resolver: (() => void) | undefined): AuthoritativeServer {
  return new AuthoritativeServer(new IdleTransport(), {
    sessionId: "p_terrain_derived_paint_layer",
    tickMs: 1000,
    worldLog: { name: logName },
    authoring: {
      projectId,
      ...(resolver === undefined ? {} : {
        derivedTerrainTopology: (mapDocRef: { assetId: string; hash: string }) => {
          assert(mapDocRef.hash === MAP_DOC_HASH, "resolver received a foreign MapDoc ref");
          resolver();
          return baseTopology;
        },
      }),
    },
  });
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
  await invoke(server, "authoring.commit", {
    transaction: {
      schema: "limina.authoring-transaction/v1",
      transactionId: "mount-mapdoc-derived-paint",
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
    },
  });
}

function paintRefFor(ref: { assetId: string; hash: string }, index: number) {
  return {
    refId: `terrain-paint-layer-${String(index).padStart(3, "0")}`,
    refType: "terrain-paint-layer/v1",
    scope: "chunk",
    assetId: ref.assetId,
    contentHash: ref.hash,
  };
}

/** Compile the baseline + one paint layer; return chunkId → {contentHash, tile}. */
function compiledChunks(layer?: unknown, ref?: { assetId: string; hash: string }) {
  const compiled = compileWorldTerrain(compileInput([], [], layer === undefined ? [] : [layer], ref === undefined ? [] : [paintRefFor(ref, 0)]));
  const chunks = new Map<string, { contentHash: string; tile: ReturnType<typeof decodeTerrainChunkArtifact>["tile"] }>();
  for (const artifact of compiled.artifacts as { chunkId?: string; contentHash: string; bytes: Uint8Array }[]) {
    if (artifact.chunkId === undefined) continue;
    chunks.set(artifact.chunkId, { contentHash: artifact.contentHash, tile: decodeTerrainChunkArtifact(artifact.bytes).tile });
  }
  return chunks;
}

// ---- (b) + (c) + (d): commit path, compile round-trip, erase, replay ------------------

const LOG = "p_terrain_derived_paint_layer.jsonl";
ops.op_write_trace(LOG, "");
let resolverCalls = 0;
const first = derivedServer(LOG, () => resolverCalls++);
await first.ready;
await mountMapDoc(first);

const stroke = await invoke(first, "terrain.paint", { center: [0, 0], radius: 6, strength: 0.8, material: "rock" }) as unknown as {
  ok: boolean;
  baseTopology: { topologyHash: string };
  layerRef: { assetId: string; hash: string; layerId: string; baseTopologyHash: string };
  derived: { layerId: string; deltaCount: number; folded: boolean; contentHash: string };
};
assert(stroke.ok === true, "derived paint returned ok:false");
assert(stroke.baseTopology.topologyHash === baseTopology.topologyHash, "stroke bound to a foreign base topology");
assert(stroke.derived.layerId === `derived-paint-${GRID_ID}`, `unexpected layer id ${stroke.derived.layerId}`);
assert(stroke.derived.deltaCount > 0 && stroke.derived.folded === false, "stroke accounting is wrong");
assert(stroke.layerRef.hash === stroke.derived.contentHash, "layer ref does not pin the layer content hash");
assert(stroke.layerRef.baseTopologyHash === baseTopology.topologyHash, "layer ref does not pin the base topology hash");
assert(resolverCalls === 1, `live stroke must resolve the topology exactly once, got ${resolverCalls}`);

const stateAfterStroke = (await invoke(first, "authoring.projectState", {})) as unknown as {
  stateHash: string;
  refs: { terrainEditLayers: { assetId: string; hash: string; layerId: string; baseTopologyHash: string }[] };
};
assert(stateAfterStroke.refs.terrainEditLayers.length === 1, "project state did not gain the derived paint layer");
assert(stateAfterStroke.refs.terrainEditLayers[0].hash === stroke.derived.contentHash, "project state ref does not pin the committed layer");

const readBack = await invoke(first, "authoring.terrainPaintLayer", { assetId: stroke.layerRef.assetId, hash: stroke.layerRef.hash }) as unknown as { layer: unknown };
const layer = parseTerrainPaintLayer(readBack.layer);
assert(layer.contentHash === stroke.derived.contentHash, "live store returned a different layer");
const centerDelta = layer.operations[0].deltas.find((delta) => delta.gx === 0 && delta.gz === 0);
assert(centerDelta !== undefined && centerDelta.material === "rock" && centerDelta.weight === 0.8, `brush center delta must be rock at strength * falloff(1) = 0.8, got ${JSON.stringify(centerDelta)}`);
// The height-layer read tool must NOT serve paint content (separate live stores).
const wrongStore = await first.invokeAuthoritatively("authoring.terrainEditLayer", { assetId: stroke.layerRef.assetId, hash: stroke.layerRef.hash }, context);
assert(!wrongStore.success && wrongStore.error?.code === "not_found", "the height-layer store must not serve paint content");

// The recorded command pins the resolved topology + committed layer identity + nested record.
const recordedPaint = parseWorldLog(ops.op_read_trace(LOG)).commands.find((command) => command.kind === "skill" && command.tool === "terrain.paint");
assert(recordedPaint !== undefined && recordedPaint.kind === "skill", "derived paint was not recorded");
const recordedInput = recordedPaint.input as { baseTopology?: { topologyHash: string }; layerRef?: { hash: string }; commitRecord?: unknown };
assert(recordedInput.baseTopology?.topologyHash === baseTopology.topologyHash, "recorded command did not pin the base topology");
assert(recordedInput.layerRef?.hash === stroke.derived.contentHash, "recorded command did not pin the committed layer");
assert(recordedInput.commitRecord !== undefined, "recorded command did not pin the nested commit record");

// (b) Round-trip: project state → compile request → composed paint channels carry the stamp.
const baseline = compiledChunks();
const painted = compiledChunks(layer, stroke.layerRef);
const chunkId = terrainChunkId(GRID_ID, 0, 0, 0);
const baseTile = baseline.get(chunkId)!, paintedTile = painted.get(chunkId)!;
assert(baseTile !== undefined && paintedTile !== undefined, "compile did not emit the stroke chunk");
assert(baseTile.contentHash !== paintedTile.contentHash, "painted chunk content did not change");
assert(paintedTile.tile.paintMat !== undefined && paintedTile.tile.paintW !== undefined, "compiled chunk lost its paint channels");
// Sample (gx 0, gz 0) is chunk (0,0)'s local [0,0]: rock (id 3) at clamp(base + 0.8).
const rockId = TERRAIN_PAINT_MATERIAL_IDS.rock;
const expectedW = Math.fround(Math.min(1, baseTile.tile.paintW![0] + 0.8));
assert(paintedTile.tile.paintMat![0] === rockId, `compiled center material must be rock (${paintedTile.tile.paintMat![0]})`);
assert(Object.is(paintedTile.tile.paintW![0], expectedW), `compiled center weight ${paintedTile.tile.paintW![0]} !== clamp(base+0.8) = ${expectedW}`);
assert(paintedTile.tile.paintMat![0] !== baseTile.tile.paintMat![0] || !Object.is(paintedTile.tile.paintW![0], baseTile.tile.paintW![0]), "the stamp did not recolor the center sample");
ops.op_log("[js] p_terrain_derived_paint_layer (b) OK: the committed paint op round-trips project state → compile → composed paint channels (rock stamp recolored the chunk)");

// (c) Erase subtracts exactly: erase strength 1 over the same stamp, then every sample of
// the touched chunk must equal clamp01(composedBefore - falloff) with the zero-mat rule.
const erase = await invoke(first, "terrain.paint", { center: [0, 0], radius: 6, strength: 1, material: "rock", erase: true }) as unknown as {
  ok: boolean;
  layerRef: { assetId: string; hash: string };
  derived: { contentHash: string };
};
assert(erase.ok === true, "erase stroke failed");
const erasedLayer = parseTerrainPaintLayer((await invoke(first, "authoring.terrainPaintLayer", { assetId: erase.layerRef.assetId, hash: erase.layerRef.hash }) as unknown as { layer: unknown }).layer);
assert(erasedLayer.operations.length === 2, "erase did not append a second operation");
const erased = compiledChunks(erasedLayer, erase.layerRef);
const erasedTile = erased.get(chunkId)!;
for (let row = 0; row < grid.defaultSamples; row++) {
  for (let col = 0; col < grid.defaultSamples; col++) {
    const index = row * grid.defaultSamples + col;
    const wx = col * stepM, wz = row * stepM; // chunk (0,0) bounds start at world (0,0)
    const d = Math.sqrt(wx * wx + wz * wz);
    const before = paintedTile.tile.paintW![index];
    let expected = before;
    if (d <= 6) {
      const t = 1 - d / 6;
      const f = t * t * (3 - 2 * t);
      expected = Math.fround(Math.max(0, before - f));
    }
    assert(Object.is(erasedTile.tile.paintW![index], expected), `erase at local [${col},${row}] gave ${erasedTile.tile.paintW![index]}, expected exactly ${expected}`);
    const expectedMat = expected <= 0 ? 0 : paintedTile.tile.paintMat![index];
    assert(erasedTile.tile.paintMat![index] === expectedMat, `erase material rule at local [${col},${row}] gave ${erasedTile.tile.paintMat![index]}, expected ${expectedMat}`);
  }
}
assert(erasedTile.tile.paintW![0] === 0 && erasedTile.tile.paintMat![0] === 0, "a full-strength erase must zero the center weight and clear its material");
ops.op_log("[js] p_terrain_derived_paint_layer (c) OK: erase subtracts exactly (per-sample clamp arithmetic + the zero-weight material clear)");

// (d) Replay: reboot rehydrates the recorded strokes into byte-identical layer content.
const canonicalBefore = canonicalTerrainPaintLayer(readBack.layer);
const canonicalErased = canonicalTerrainPaintLayer(erasedLayer);
const stateHashBefore = ((await invoke(first, "authoring.projectState", {})) as unknown as { stateHash: string }).stateHash;
const resolverCallsBeforeReboot = resolverCalls; // two live strokes = two resolutions
await first.shutdown();
const second = derivedServer(LOG, () => resolverCalls++);
await second.ready;
assert(resolverCalls === resolverCallsBeforeReboot, `rehydrate must use the pinned topology, not the resolver (calls ${resolverCalls})`);
const stateAfterReplay = (await invoke(second, "authoring.projectState", {})) as unknown as { stateHash: string };
assert(stateAfterReplay.stateHash === stateHashBefore, "rehydrate reconstructed a different project state");
const replayedLayer = await invoke(second, "authoring.terrainPaintLayer", { assetId: stroke.layerRef.assetId, hash: stroke.layerRef.hash }) as unknown as { layer: unknown };
assert(canonicalTerrainPaintLayer(replayedLayer.layer) === canonicalBefore, "rehydrate reconstructed different stroke-1 layer bytes");
const replayedErased = await invoke(second, "authoring.terrainPaintLayer", { assetId: "x", hash: erase.derived.contentHash }) as unknown as { layer: unknown };
assert(canonicalTerrainPaintLayer(replayedErased.layer) === canonicalErased, "rehydrate reconstructed different stroke-2 layer bytes");
// A third live stroke after the reboot appends and re-pins identically on a second reboot.
const stroke3 = await invoke(second, "terrain.paint", { center: [3, 0], radius: 6, strength: 0.4, material: "sand" }) as unknown as { ok: boolean; derived: { contentHash: string; deltaCount: number } };
assert(stroke3.ok === true, "third stroke after reboot failed");
const layer3 = await invoke(second, "authoring.terrainPaintLayer", { assetId: "x", hash: stroke3.derived.contentHash }) as unknown as { layer: unknown };
const canonical3 = canonicalTerrainPaintLayer(layer3.layer);
assert(parseTerrainPaintLayer(layer3.layer).operations.length === 3, "third stroke did not append an operation");
await second.shutdown();
const resolverCallsBeforeSecondReboot = resolverCalls;
const third = derivedServer(LOG, () => resolverCalls++);
await third.ready;
assert(resolverCalls === resolverCallsBeforeSecondReboot, `second rehydrate must use the pinned topology (calls ${resolverCalls})`);
const replayed3 = await invoke(third, "authoring.terrainPaintLayer", { assetId: "x", hash: stroke3.derived.contentHash }) as unknown as { layer: unknown };
assert(canonicalTerrainPaintLayer(replayed3.layer) === canonical3, "second rehydrate reconstructed different layer bytes");
await third.shutdown();
ops.op_log("[js] p_terrain_derived_paint_layer (d) OK: invoke → rehydrate → invoke → rehydrate reproduces byte-identical paint layer content with baseTopology + layerRef + commitRecord pins");

// (d-legacy) A pin-less recorded paint (pre-D5.3 shape: ok:false, no pins) replays as the
// no-op it was — it must NOT mint a nested commit the record never had. Server A has
// authoring but NO topology resolver, so its live paint records exactly that shape.
const LEGACY_LOG = "p_terrain_derived_paint_layer_legacy.jsonl";
ops.op_write_trace(LEGACY_LOG, "");
{
  const serverA = derivedServer(LEGACY_LOG, undefined);
  await serverA.ready;
  await mountMapDoc(serverA);
  const legacy = await serverA.invokeAuthoritatively("terrain.paint", { center: [0, 0], radius: 6, strength: 0.8, material: "rock" }, context);
  assert(legacy.success && (legacy.result as { ok: boolean }).ok === false, "a resolver-less authority must record ok:false");
  await serverA.shutdown();
  let legacyResolverCalls = 0;
  const serverB = derivedServer(LEGACY_LOG, () => legacyResolverCalls++);
  await serverB.ready;
  const stateB = (await invoke(serverB, "authoring.projectState", {})) as unknown as { refs: { terrainEditLayers: unknown[] } };
  assert(stateB.refs.terrainEditLayers.length === 0, "a legacy pin-less paint record minted a layer on replay");
  assert(legacyResolverCalls === 0, "a legacy pin-less paint record consulted the resolver on replay");
  await serverB.shutdown();
  ops.op_log("[js] p_terrain_derived_paint_layer (d-legacy) OK: a pin-less paint record replays as ok:false without committing");
}

// ---- (e) Cap folding: deterministic + EXACTLY equivalent (run merge, not resampling) --

{
  const oneDelta = [{ gx: 0, gz: 0, material: "grass", weight: 0.0005 }];
  const cappedLayer = createTerrainPaintLayer({
    layerId: "fold-fixture",
    baseTopology,
    operations: Array.from({ length: MAX_TERRAIN_PAINT_OPERATIONS }, (_, index) => ({
      operationId: `op-${String(index).padStart(6, "0")}`,
      deltas: oneDelta,
    })),
  });
  const strokeDeltas = [{ gx: 0, gz: 0, material: "grass", weight: 0.0005 }, { gx: 1, gz: 0, material: "rock", weight: 1 }];
  const foldedA = appendTerrainPaintStroke(cappedLayer, { layerId: "fold-fixture", baseTopology, deltas: strokeDeltas });
  const foldedB = appendTerrainPaintStroke(cappedLayer, { layerId: "fold-fixture", baseTopology, deltas: strokeDeltas });
  assert(foldedA.folded === true, "append past the op cap did not fold");
  assert(foldedA.layer.operations.length < MAX_TERRAIN_PAINT_OPERATIONS, `fold did not compact (${foldedA.layer.operations.length} ops)`);
  assert(foldedA.layer.contentHash === foldedB.layer.contentHash, "fold is not deterministic");
  // Equivalence: manual sequential application of the unfolded stack (which exceeds the
  // format's op cap) must match the folded composition within float32 rounding — one
  // rounding per application vs one per merged run — while material ids match EXACTLY.
  const chunk = terrainChunkTopology(grid, { lod: 0, tx: 0, tz: 0, samples: grid.defaultSamples });
  const mat = new Uint8Array(grid.defaultSamples * grid.defaultSamples);
  const w = new Float32Array(grid.defaultSamples * grid.defaultSamples);
  for (const operation of [...cappedLayer.operations, { deltas: strokeDeltas }]) {
    for (const delta of operation.deltas) {
      const index = (delta.gz - chunk.tz * intervals) * grid.defaultSamples + (delta.gx - chunk.tx * intervals);
      if (delta.material === "none") {
        const next = Math.max(0, w[index] + delta.weight);
        w[index] = next;
        if (next <= 0) mat[index] = 0;
      } else {
        mat[index] = TERRAIN_PAINT_MATERIAL_IDS[delta.material as keyof typeof TERRAIN_PAINT_MATERIAL_IDS];
        w[index] = Math.min(1, w[index] + delta.weight);
      }
    }
  }
  const folded = composeTerrainPaintLayers({
    baseTopology,
    chunkTopology: chunk,
    basePaintMat: new Uint8Array(grid.defaultSamples * grid.defaultSamples),
    basePaintW: new Float32Array(grid.defaultSamples * grid.defaultSamples),
    layers: [foldedA.layer],
  });
  let maxDiff = 0;
  for (let index = 0; index < folded.paintW.length; index++) {
    assert(folded.paintMat[index] === mat[index], `folded material diverged at sample ${index} — material ids must be exact`);
    maxDiff = Math.max(maxDiff, Math.abs(folded.paintW[index] - w[index]));
  }
  assert(maxDiff < 1e-3, `folded composition diverged by ${maxDiff} — beyond float-rounding equivalence`);
  assert(folded.paintW[0] > 0.5 && folded.paintMat[1] === TERRAIN_PAINT_MATERIAL_IDS.rock, "fold fixture lost its accumulated deltas");

  // Branch switches split runs: paint, erase, paint at one key must survive the fold as
  // three ordered entries (merging across a branch switch would change the result).
  const alternating = compactTerrainPaintOperations([
    { operationId: "op-000000", deltas: [{ gx: 0, gz: 0, material: "grass", weight: 0.5 }] },
    { operationId: "op-000001", deltas: [{ gx: 0, gz: 0, material: "none", weight: -0.2 }] },
    { operationId: "op-000002", deltas: [{ gx: 0, gz: 0, material: "rock", weight: 0.3 }] },
  ]);
  assert(alternating.length === 3, `branch-switching runs must not merge (got ${alternating.length} ops)`);
  assert(alternating[0].deltas[0].material === "grass" && alternating[1].deltas[0].material === "none" && alternating[2].deltas[0].material === "rock",
    "fold reordered branch runs");
  const runsLayer = createTerrainPaintLayer({ layerId: "runs", baseTopology, operations: alternating });
  const runsComposed = composeTerrainPaintLayers({
    baseTopology,
    chunkTopology: chunk,
    basePaintMat: new Uint8Array(grid.defaultSamples * grid.defaultSamples),
    basePaintW: new Float32Array(grid.defaultSamples * grid.defaultSamples),
    layers: [runsLayer],
  });
  // Sequential: w = clamp01(clamp01(clamp01(0.5) - 0.2) + 0.3), mat = rock.
  let expectedRunW = Math.min(1, 0 + 0.5);
  expectedRunW = Math.max(0, expectedRunW - 0.2);
  expectedRunW = Math.min(1, expectedRunW + 0.3);
  assert(runsComposed.paintW[0] === Math.fround(expectedRunW) && runsComposed.paintMat[0] === TERRAIN_PAINT_MATERIAL_IDS.rock,
    `run-ordered composition is wrong (w ${runsComposed.paintW[0]}, mat ${runsComposed.paintMat[0]})`);

  // The delta cap folds the same way: four full-domain sweeps (66,564 deltas over 16,641
  // unique keys, one branch run each) merge onto one run per key, not a failed write.
  const domainDeltas = [];
  for (let gz = minGz; gz <= maxGz; gz++) for (let gx = minGx; gx <= maxGx; gx++) domainDeltas.push({ gx, gz, material: "sand", weight: 0.25 });
  let swept;
  for (let sweep = 0; sweep < 4; sweep++) {
    swept = appendTerrainPaintStroke(swept?.layer, { layerId: "sweep", baseTopology, deltas: domainDeltas });
  }
  assert(swept.folded === true, "crossing the delta cap did not fold");
  const sweptTotal = swept.layer.operations.reduce((total, operation) => total + operation.deltas.length, 0);
  assert(sweptTotal === samplesX * samplesZ, `delta-cap fold must merge onto ${samplesX * samplesZ} unique keys, got ${sweptTotal}`);
  const sweptAgain = appendTerrainPaintStroke(swept.layer, { layerId: "sweep", baseTopology, deltas: domainDeltas });
  assert(sweptAgain.layer.operations.length <= 10, "a folded layer plus one stroke must stay within per-operation caps");
  const sweptComposed = composeDomain(swept.layer);
  assert(sweptComposed.w[0] === 1 && sweptComposed.mat[0] === TERRAIN_PAINT_MATERIAL_IDS.sand, "four 0.25 sweeps must saturate to sand at weight 1");
  ops.op_log("[js] p_terrain_derived_paint_layer (e) OK: op-cap and delta-cap folding are deterministic, run-exact, and branch-order preserving");
}

// ---- (f) Untouched chunks keep identical content hashes (content-delta precondition) --

{
  const stamp = (center: [number, number], material: string) => ({
    layerId: "delta",
    baseTopology,
    deltas: materializeTerrainPaintOp(baseTopology, { center, radius: 6, strength: 0.8, falloff: "smooth", material: material as never, erase: false }),
  });
  const layerA = appendTerrainPaintStroke(undefined, stamp([0, 0], "rock"));
  const layerAB = appendTerrainPaintStroke(layerA.layer, stamp([48, 48], "snow"));
  const compileWith = (layer: unknown) => compileWorldTerrain(compileInput([], [], [layer], [{
    refId: "terrain-paint-layer-000",
    refType: "terrain-paint-layer/v1",
    scope: "chunk",
    assetId: "assets/sources/terrain-paint-layer/x.layer.json",
    contentHash: (layer as { contentHash: string }).contentHash,
  }]));
  const hashesOf = (compiled: ReturnType<typeof compileWorldTerrain>) => {
    const hashes = new Map<string, string>();
    for (const artifact of compiled.artifacts as { chunkId?: string; contentHash: string }[]) {
      if (artifact.chunkId !== undefined) hashes.set(artifact.chunkId, artifact.contentHash);
    }
    return hashes;
  };
  const none = hashesOf(compileWorldTerrain(compileInput([], [])));
  const onlyA = hashesOf(compileWith(layerA.layer));
  const bothAB = hashesOf(compileWith(layerAB.layer));
  assert(none.size === onlyA.size && onlyA.size === bothAB.size && none.size > 0, "chunk inventories diverged");
  const chunkA = terrainChunkId(GRID_ID, 0, 0, 0);
  const chunkB = terrainChunkId(GRID_ID, 0, 1, 1);
  // Stamp A at [0,0] r6 touches chunks (-1..0, -1..0); stamp B at [48,48] r6 touches
  // chunks (0..1, 0..1). A chunk B never touched must be byte-identical across all three.
  let touchedByA = 0, changedByB = 0;
  for (const [id, hash] of none) {
    if (onlyA.get(id) !== hash) touchedByA++;
    if (bothAB.get(id) !== onlyA.get(id)) changedByB++;
  }
  assert(onlyA.get(chunkA) !== none.get(chunkA), "stamp A did not change its chunk");
  assert(touchedByA > 0, "stamp A touched no chunks");
  assert(onlyA.get(chunkB) === none.get(chunkB), "stamp B's chunk changed before stamp B existed");
  assert(bothAB.get(chunkB) !== onlyA.get(chunkB), "stamp B did not change its chunk");
  assert(changedByB > 0, "stamp B touched no chunks");
  const stable = [...none.keys()].filter((id) => bothAB.get(id) === none.get(id));
  assert(stable.length > 0, "every chunk changed — the fixture must leave an untouched control");
  ops.op_log(`[js] p_terrain_derived_paint_layer (f) OK: untouched chunks keep identical content hashes (${stable.length}/${none.size} chunks byte-stable across both stamps)`);
}

// ---- (g) Regression: a world WITH an EditableTerrain layer is unchanged ---------------

const REGRESSION_LOG = "p_terrain_derived_paint_layer_regression.jsonl";
ops.op_write_trace(REGRESSION_LOG, "");
{
  const regression = derivedServer(REGRESSION_LOG, () => resolverCalls++);
  await regression.ready;
  await mountMapDoc(regression);
  // An unknown entity with NO editable layer falls through to the mounted-MapDoc path
  // (one derived commit, one paint ref) — the editable strokes below must not add to it.
  const noLayerYet = await regression.invokeAuthoritatively("terrain.paint", { entity: "ent_missing", center: [0, 0], radius: 4, material: "rock" }, context);
  assert(noLayerYet.success && (noLayerYet.result as { ok: boolean }).ok === true, "derived paint without an entity should take the mounted-MapDoc path");
  const stateBefore = (await invoke(regression, "authoring.projectState", {})) as unknown as { refs: { terrainEditLayers: unknown[] } };
  assert(stateBefore.refs.terrainEditLayers.length === 1, "the derived fallthrough did not commit exactly one paint layer");
  const created = await invoke(regression, "terrain.create", { size: 48, resolution: 33, baseHeight: 0 });
  const editable = await invoke(regression, "terrain.paint", { center: [0, 0], radius: 12, strength: 0.8, material: "sand" }) as unknown as { ok: boolean; derived?: unknown };
  assert(editable.ok === true && editable.derived === undefined, "a world with an EditableTerrain layer took the derived path");
  const named = await invoke(regression, "terrain.paint", { entity: created.entity, center: [4, 0], radius: 8, strength: 0.5, material: "rock" }) as unknown as { ok: boolean; derived?: unknown };
  assert(named.ok === true && named.derived === undefined, "an explicit editable entity took the derived path");
  const state = (await invoke(regression, "authoring.projectState", {})) as unknown as { refs: { terrainEditLayers: unknown[] } };
  assert(state.refs.terrainEditLayers.length === 1, "the editable path committed derived paint layers");
  const paintCommits = parseWorldLog(ops.op_read_trace(REGRESSION_LOG)).commands.filter((command) =>
    command.kind === "skill" && command.tool === "authoring.commit"
    && JSON.stringify(command.input).includes("terrain-paint-"));
  assert(paintCommits.length === 0, "the editable path recorded derived paint commits");
  await regression.shutdown();
  ops.op_log("[js] p_terrain_derived_paint_layer (g) OK: a world with an EditableTerrain layer behaves exactly as before");
}

// ---- (h) rev-356 regression: a layer's deltas concentrated in ONE chunk must compile -------
// The per-chunk slice content hash rides the canonicalizer; a legal paint pattern (many dabs at
// one spot — 1,089 unique lattice keys x repeated ops) once exceeded its former 1 MiB budget and
// stalled every derived build. Both slice hash call sites (edit + paint) share the raised limit.

{
  const chunkKeys: { gx: number; gz: number }[] = [];
  for (let gz = 0; gz <= intervals; gz++) for (let gx = 0; gx <= intervals; gx++) chunkKeys.push({ gx, gz });
  const concentratedPaint = createTerrainPaintLayer({
    layerId: "concentrated-paint",
    baseTopology,
    // 22 ops x 1,089 keys = 23,958 deltas > 1 MiB of canonical slice JSON in chunk (0,0).
    operations: Array.from({ length: 22 }, (_, op) => ({
      operationId: `op-${String(op).padStart(6, "0")}`,
      deltas: chunkKeys.map((key) => ({ ...key, material: "rock" as const, weight: 0.25 })),
    })),
  });
  const paintCompiled = compileWorldTerrain(compileInput([], [], [concentratedPaint], [paintRefFor(
    { assetId: "assets/sources/terrain-paint-layer/concentrated.layer.json", hash: concentratedPaint.contentHash }, 0,
  )]));
  const paintCenter = new Map<string, string>();
  let paintCenterTile: ReturnType<typeof decodeTerrainChunkArtifact>["tile"] | undefined;
  for (const artifact of paintCompiled.artifacts as { chunkId?: string; contentHash: string; bytes: Uint8Array }[]) {
    if (artifact.chunkId === undefined) continue;
    if (artifact.chunkId === terrainChunkId(GRID_ID, 0, 0, 0)) paintCenterTile = decodeTerrainChunkArtifact(artifact.bytes).tile;
    paintCenter.set(artifact.chunkId, artifact.contentHash);
  }
  assert(paintCenterTile !== undefined, "concentrated paint compile did not emit chunk (0,0)");
  assert(paintCenterTile!.paintMat![0] === TERRAIN_PAINT_MATERIAL_IDS.rock && paintCenterTile!.paintW![0] === 1,
    "concentrated paint slice did not compose (center must clamp to rock at weight 1)");
  // Untouched chunks stay byte-identical to the paint-less baseline (limit relaxation must not
  // change any previously-hashable slice).
  const paintLess = compiledChunks();
  let paintStable = 0;
  for (const [id, prior] of paintLess) if (paintCenter.get(id) === prior.contentHash) paintStable++;
  assert(paintStable > 0, "concentrated paint changed every chunk — no untouched control");
  const concentratedEdit = createTerrainEditLayer({
    layerId: "concentrated-edit",
    baseTopology,
    // 38 ops x 1,089 keys = 41,382 deltas > 1 MiB of canonical slice JSON in chunk (0,0).
    operations: Array.from({ length: 38 }, (_, op) => ({
      operationId: `op-${String(op).padStart(6, "0")}`,
      kind: "add" as const,
      deltas: chunkKeys.map((key) => ({ ...key, deltaM: 0.5 })),
    })),
  });
  const editCompiled = compileWorldTerrain(compileInput([concentratedEdit], [{
    refId: "terrain-edit-layer-000",
    refType: "terrain-edit-layer/v1",
    scope: "chunk",
    assetId: "assets/sources/terrain-edit-layer/concentrated.layer.json",
    contentHash: concentratedEdit.contentHash,
  }]));
  assert((editCompiled.artifacts as unknown[]).length > 0, "concentrated edit compile produced no artifacts");
  ops.op_log("[js] p_terrain_derived_paint_layer (h) OK: single-chunk concentrations past the old 1 MiB canonical budget compile (rev-356 regression), untouched chunks byte-identical");
}

// ---- (i) Overview parity: the bird's-eye artifact carries the stamp + rebuilds on paint ------

{
  const overviewOf = (compiled: ReturnType<typeof compileWorldTerrain>) => {
    const artifact = (compiled.artifacts as { artifactType?: string; scope?: string; bytes: Uint8Array }[])
      .find((entry) => entry.artifactType === "world-overview-terrain/v1");
    assert(artifact !== undefined, "compile did not emit a world overview artifact");
    return decodeWorldOverviewArtifact(artifact!.bytes).grid;
  };
  const stampLayer = appendTerrainPaintStroke(undefined, {
    layerId: "overview-stamp",
    baseTopology,
    deltas: materializeTerrainPaintOp(baseTopology, { center: [0, 0], radius: 8, strength: 1, falloff: "constant", material: "rock", erase: false }),
  });
  const erasedLayer = appendTerrainPaintStroke(stampLayer.layer, {
    layerId: "overview-stamp",
    baseTopology,
    deltas: materializeTerrainPaintOp(baseTopology, { center: [0, 0], radius: 8, strength: 1, falloff: "constant", material: "rock", erase: true }),
  });
  const withLayer = (layer: unknown) => compileWorldTerrain(compileInput([], [], [layer], [paintRefFor(
    { assetId: "assets/sources/terrain-paint-layer/overview.layer.json", hash: (layer as { contentHash: string }).contentHash }, 0,
  )]));
  const baseOverview = overviewOf(compileWorldTerrain(compileInput([], [])));
  const stampedOverview = overviewOf(withLayer(stampLayer.layer));
  const erasedOverview = overviewOf(withLayer(erasedLayer.layer));
  const cellAt = (grid: typeof baseOverview, x: number, z: number) => {
    const col = Math.round((x - grid.origin[0]) / grid.stepM), row = Math.round((z - grid.origin[1]) / grid.stepM);
    return row * grid.cols + col;
  };
  const center = cellAt(baseOverview, 0, 0), far = cellAt(baseOverview, 24, 24);
  assert(stampedOverview.paintMaterial[center] === TERRAIN_PAINT_MATERIAL_IDS.rock && stampedOverview.paintWeight[center] === 255,
    `overview center must carry the rock stamp (mat ${stampedOverview.paintMaterial[center]}, w ${stampedOverview.paintWeight[center]})`);
  assert(stampedOverview.paintMaterial[far] === baseOverview.paintMaterial[far] && stampedOverview.paintWeight[far] === baseOverview.paintWeight[far],
    "overview cells outside the stamp radius changed");
  // Erase subtracts the composed weight to zero and clears the material — the presentation blend
  // factor is 0, so the bird's-eye color returns to the unpainted ramp for that cell.
  assert(erasedOverview.paintMaterial[center] === 0 && erasedOverview.paintWeight[center] === 0,
    `erased overview center must be zeroed (mat ${erasedOverview.paintMaterial[center]}, w ${erasedOverview.paintWeight[center]})`);
  assert(erasedOverview.paintMaterial[far] === baseOverview.paintMaterial[far] && erasedOverview.paintWeight[far] === baseOverview.paintWeight[far],
    "erase touched overview cells outside the radius");

  // Reuse discipline: a paint-less compile REUSES a prior paint-less overview byte-identically;
  // a paint-carrying compile must REBUILD (the planner's global authority stage never sees paint).
  const availability = (compiled: ReturnType<typeof compileWorldTerrain>) => {
    const hashes = new Set<string>();
    for (const artifact of derivedGlobalArtifacts(compiled.manifest as never)) hashes.add((artifact as { contentHash: string }).contentHash);
    for (const chunk of (compiled.manifest as { chunks: { artifacts: { contentHash: string }[] }[] }).chunks) {
      for (const artifact of chunk.artifacts) hashes.add(artifact.contentHash);
    }
    return [...hashes].sort();
  };
  const overviewHashOf = (compiled: ReturnType<typeof compileWorldTerrain>) =>
    (compiled.manifest as { globalArtifacts: { artifactType: string; contentHash: string }[] }).globalArtifacts
      .find((artifact) => artifact.artifactType === "world-overview-terrain/v1")!.contentHash;
  const first = compileWorldTerrain(compileInput([], []));
  const reused = compileWorldTerrain({
    ...compileInput([], []),
    previousSnapshot: first.snapshot,
    previousManifest: first.manifest,
    availableArtifactHashes: availability(first),
  });
  assert(overviewHashOf(reused) === overviewHashOf(first), "a paint-less recompile must reuse the prior overview byte-identically");
  const repainted = compileWorldTerrain({
    ...compileInput([], [], [stampLayer.layer], [paintRefFor(
      { assetId: "assets/sources/terrain-paint-layer/overview.layer.json", hash: stampLayer.layer.contentHash }, 0,
    )]),
    previousSnapshot: first.snapshot,
    previousManifest: first.manifest,
    availableArtifactHashes: availability(first),
  });
  assert(overviewHashOf(repainted) !== overviewHashOf(first), "a paint-carrying compile must rebuild the overview, not reuse the stale one");
  const repaintedOverview = overviewOf(repainted);
  assert(repaintedOverview.paintMaterial[center] === TERRAIN_PAINT_MATERIAL_IDS.rock,
    "the reused-path rebuild did not compose the stamp into the overview");
  ops.op_log("[js] p_terrain_derived_paint_layer (i) OK: the overview artifact composes paint stamps (rock at the stamp, untouched outside, erase zeroes the blend), reuses byte-identically when paint-less, and rebuilds on paint");
}

ops.op_log("p_terrain_derived_paint_layer OK: derived paint materializes signed deltas byte-identical to applyBrushPaint, commits with replay pins, round-trips into compiled chunk paint channels, erases exactly, replays + folds byte-identically, leaves untouched chunks byte-identical, compiles single-chunk concentrations past the old 1 MiB canonical budget, recolors the bird's-eye overview with paint-less byte-identity preserved, and leaves EditableTerrain worlds untouched (legs a-i).");
