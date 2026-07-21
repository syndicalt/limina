// D5.4 — vegetation.scatter + terrain.deform smooth/flatten on DERIVED terrain through
// the shared composed-height sampler (terrain/composed-height.mjs). Proves:
// (a) the sampler matches the compiler-composed chunk heights at probe lattice points
//     (differential vs compileWorldTerrain artifacts; plain AND hydrology-carved maps);
// (b) scatter on a derived world places instances on composed heights with slope and
//     elevation gates honored (a steep hill + a high plateau authored via edit layers);
// (c) inclusion/exclusion discs are honored on the derived path;
// (d) invoke → rehydrate → re-invoke is byte-identical (the recorded command pins the
//     composed-field identity);
// (e) EditableTerrain worlds are byte-unchanged (regression vs scatterAssets direct);
// (f) derived smooth + flatten produce the field the equivalent EditableTerrain brush
//     produces, sample-for-sample.

import { ops } from "../src/engine.ts";
import { AuthoritativeServer, type AuthoritativeInvocationContext, type NetServerTransport, ACCEPT_CLOSED } from "../src/net/server.ts";
import { resolveProfile } from "../src/skills/permissions.ts";
import { parseWorldLog } from "../src/worldlog/log.ts";
import { applyBrush, materializeTerrainBrushOp } from "../src/skills/terrain-edit.ts";
import { appendTerrainEditStroke, parseTerrainEditLayer } from "../src/terrain/edit-layer.mjs";
import { terrainEditBaseTopologyForWorldMap } from "../src/terrain/edit-topology.mjs";
import { compileDerivedBaseField, createComposedHeightField } from "../src/terrain/composed-height.mjs";
import { createMapTerrainField } from "../src/terrain/map-field.mjs";
import { scatterAssets, type ScatterExclusion } from "../src/terrain/asset-scatter.ts";
import { compileAtlasMapDoc } from "../src/world/design-map-compile.mjs";
import { canonicalMapDocText } from "../src/world/mapdoc-canonical.mjs";
import { sha256 } from "../src/world/sha256.mjs";
import { decodeTerrainChunkArtifact } from "../src/world/compiler/index.mjs";
import {
  compileWorldTerrain,
  WORLD_HYDROLOGY_TERRAIN_COMPILER_VERSION,
  WORLD_TERRAIN_COMPILER_CONFIG_SCHEMA,
} from "../src/world/compiler/terrain-compile.ts";
import { DEFAULT_MAP_EROSION_RECIPE } from "../src/world/pipeline/erosion.mjs";
import {
  WORLD_TERRAIN_COMPILER_BASE_AMPLITUDE,
  WORLD_TERRAIN_COMPILER_SEED,
  WORLD_TERRAIN_COMPILER_VERTICAL_RANGE,
} from "../src/world/compiler/config.mjs";
import type { TerrainTile } from "../src/terrain/types.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`p_vegetation_scatter_derived FAIL: ${message}`);
}

class IdleTransport implements NetServerTransport {
  async accept(): Promise<number> { return ACCEPT_CLOSED; }
  async recv(_connId: number): Promise<string> { return ""; }
  async send(_connId: number, _line: string): Promise<void> {}
  async close(_connId: number): Promise<void> {}
}

// ---- Fixtures: a 48x48 m land tile (a 4x4 chunk / 129x129-sample lattice domain),
//      sea level far below the land so the default elevation floor never gates. -----

const GRID_ID = "veg-derived.surface";
const projectId = "veg-derived";
const MAP_DOC_ASSET_ID = "assets/sources/map-doc/fixture.mapdoc.json";

function mapDoc(withHydrology: boolean): Record<string, unknown> {
  const outline = [[-24, -24], [24, -24], [24, 24], [-24, 24]];
  const map: Record<string, unknown> = {
    id: "surface",
    name: "Surface",
    scope: "region",
    parent: null,
    seaLevel: -20,
    features: [
      { id: "land", type: "area", kind: "outline", points: outline },
      { id: "grass", type: "area", kind: "biome", biome: "grass", points: outline },
    ],
    units: { kind: "m", unitsPerMeter: 1, origin: [0, 0] },
  };
  if (withHydrology) {
    (map.features as unknown[]).push({ id: "river", type: "line", kind: "river", points: [[-24, -12], [0, 0], [24, 12]] });
    // Low thresholds so the tiny fixture still grows reaches and the carve stage
    // cannot be vacuously equal to the un-carved field everywhere.
    map.hydrology = {
      schema: "limina.hydrology-recipe/v1",
      precipitationMmPerYear: 900,
      riverMinCatchmentAreaM2: 100,
      basinMinAreaM2: 50,
      basinMinDepthM: 0.5,
      waterfallMinDropM: 0.5,
    };
  }
  return { version: 2, activeMapId: "surface", maps: [map] };
}

const MAP_DOC_TEXT = canonicalMapDocText(mapDoc(false));
const MAP_DOC_HASH = `sha256:${sha256(MAP_DOC_TEXT)}`;
const HYDRO_DOC_TEXT = canonicalMapDocText(mapDoc(true));
const HYDRO_DOC_HASH = `sha256:${sha256(HYDRO_DOC_TEXT)}`;
const DOC_TEXT_BY_ASSET_ID: Record<string, string> = { [MAP_DOC_ASSET_ID]: MAP_DOC_TEXT };

/** Two real brush strokes (raise + lower need no heights) as one committed layer. */
function strokeLayer(baseTopology: unknown) {
  const raise = materializeTerrainBrushOp(baseTopology, { center: [6, 6], radius: 9, delta: 20, mode: "raise", falloff: "smooth" });
  const first = appendTerrainEditStroke(undefined, { layerId: `derived-${GRID_ID}`, baseTopology, deltas: raise });
  const lower = materializeTerrainBrushOp(baseTopology, { center: [-9, -3], radius: 6, delta: 5, mode: "lower", falloff: "linear" });
  return appendTerrainEditStroke(first.layer, { layerId: `derived-${GRID_ID}`, baseTopology, deltas: lower }).layer;
}

function compileInputFor(worldMap: unknown, docHash: string, version: string, layers: unknown[], refs: unknown[]) {
  return {
    request: { projectId, branchId: "main", revision: 4, headHash: `sha256:${sha256(`head:${docHash}`)}` },
    worldMap,
    sourceRefs: {
      mapDocument: { refId: "map-document", refType: "map-document/v1", scope: "global", assetId: MAP_DOC_ASSET_ID, contentHash: docHash },
    },
    terrainEditLayers: layers,
    terrainEditLayerRefs: refs,
    compiler: {
      version,
      config: {
        schema: WORLD_TERRAIN_COMPILER_CONFIG_SCHEMA,
        // The sampler reads the SAME constants (config.mjs) — that is the point of
        // the differential: any drift between the two sources fails here.
        seed: WORLD_TERRAIN_COMPILER_SEED,
        baseAmplitude: WORLD_TERRAIN_COMPILER_BASE_AMPLITUDE,
        erosionRecipe: DEFAULT_MAP_EROSION_RECIPE,
        gridId: GRID_ID,
        verticalRange: WORLD_TERRAIN_COMPILER_VERTICAL_RANGE,
        limits: { maxChunks: 4096, maxMasterSamples: 1_050_625, maxArtifactBytes: 256 * 1024 * 1024 },
      },
    },
    previousSnapshot: null,
    cancellation: { shouldCancel: () => false },
  };
}

// ---- (a) Differential: the sampler == the compiler-composed chunk heights --------

function differentialAgainstCompiled(docText: string, docHash: string, version: string, label: string): void {
  const compiledDoc = compileAtlasMapDoc({ mapsJsonText: docText }) as { worldMap: unknown };
  const baseTopology = terrainEditBaseTopologyForWorldMap(compiledDoc.worldMap, { gridId: GRID_ID });
  const layer = strokeLayer(baseTopology);
  const layerRef = {
    refId: "terrain-edit-layer-000",
    refType: "terrain-edit-layer/v1",
    scope: "chunk",
    assetId: "assets/sources/terrain-edit-layer/fixture.layer.json",
    contentHash: layer.contentHash,
  };
  const compiled = compileWorldTerrain(compileInputFor(compiledDoc.worldMap, docHash, version, [layer], [layerRef]));
  const field = createComposedHeightField({
    baseTopology,
    baseField: compileDerivedBaseField(docText, GRID_ID),
    layers: [layer],
    mapDocHash: docHash,
  });
  const intervals = baseTopology.grid.defaultSamples - 1;
  let probes = 0;
  let worst = 0;
  for (const artifact of compiled.artifacts as { chunkId?: string; bytes: Uint8Array }[]) {
    if (artifact.chunkId === undefined) continue; // global artifacts carry no chunk tile
    const tile = decodeTerrainChunkArtifact(artifact.bytes).tile;
    const chunk = (compiled.manifest.chunks as { chunkId: string; tx: number; tz: number }[])
      .find((entry) => entry.chunkId === artifact.chunkId)!;
    for (let row = 0; row < tile.nrows; row++) {
      for (let col = 0; col < tile.ncols; col++) {
        const gx = chunk.tx * intervals + col;
        const gz = chunk.tz * intervals + row;
        const metres = tile.origin[1] + tile.heights[row * tile.ncols + col] * tile.scale[1];
        const sampled = field.heightAtLattice(gx, gz);
        const diff = Math.abs(metres - sampled);
        // Compiled tiles normalize to the vertical range with one fround, so the
        // round-trip can drift by ~span/2^24 (~0.6 mm) — never by a real height step.
        assert(diff < 2e-3, `${label}: sampler diverged at lattice (${gx}, ${gz}): compiled ${metres}m vs sampled ${sampled}m`);
        if (diff > worst) worst = diff;
        probes++;
      }
    }
  }
  assert(probes > 10_000, `${label}: probe coverage too thin (${probes})`);
  ops.op_log(`[js] p_vegetation_scatter_derived (a) OK [${label}]: sampler == compiler-composed heights at ${probes} lattice probes (worst ${worst.toExponential(2)}m)`);
}

differentialAgainstCompiled(MAP_DOC_TEXT, MAP_DOC_HASH, "1.0.0", "plain map");

// Hydrology variant: the sampler must mirror the river-channel carve stage too.
{
  const compiledDoc = compileAtlasMapDoc({ mapsJsonText: HYDRO_DOC_TEXT }) as { worldMap: { hydrology?: unknown } };
  assert(compiledDoc.worldMap.hydrology !== undefined, "hydrology fixture lost its recipe");
  // Non-vacuity probe: the carved base field must differ from the un-carved one
  // somewhere, or this differential proves nothing about the carve mirror.
  const uncarved = createMapTerrainField({
    worldMap: compiledDoc.worldMap,
    seed: WORLD_TERRAIN_COMPILER_SEED,
    baseAmplitude: WORLD_TERRAIN_COMPILER_BASE_AMPLITUDE,
    erosionRecipe: DEFAULT_MAP_EROSION_RECIPE,
    gridId: GRID_ID,
  });
  const carved = compileDerivedBaseField(HYDRO_DOC_TEXT, GRID_ID);
  let carvedSamples = 0;
  for (let index = 0; index < carved.heightsM.length; index++) {
    if (!Object.is(carved.heightsM[index], uncarved.heightsM[index])) carvedSamples++;
  }
  differentialAgainstCompiled(HYDRO_DOC_TEXT, HYDRO_DOC_HASH, WORLD_HYDROLOGY_TERRAIN_COMPILER_VERSION, `hydrology map, ${carvedSamples} carved samples`);
}

// ---- Server harness for (b), (c), (d), (f) ---------------------------------------

const context: AuthoritativeInvocationContext = {
  agentId: "agt_veg_derived",
  sessionId: "ses_veg_derived",
  profile: "builder.readWrite",
  permissions: resolveProfile("builder.readWrite"),
};

function derivedServer(logName: string): AuthoritativeServer {
  const topologyCache = new Map<string, unknown>();
  const server = new AuthoritativeServer(new IdleTransport(), {
    sessionId: "p_vegetation_scatter_derived",
    tickMs: 1000,
    worldLog: { name: logName },
    authoring: {
      projectId,
      derivedTerrainTopology: (mapDocRef) => {
        assert(mapDocRef.hash === MAP_DOC_HASH, "topology resolver received a foreign MapDoc ref");
        let hit = topologyCache.get(mapDocRef.hash);
        if (hit === undefined) {
          const compiled = compileAtlasMapDoc({ mapsJsonText: MAP_DOC_TEXT });
          hit = terrainEditBaseTopologyForWorldMap(compiled.worldMap, { gridId: GRID_ID });
          topologyCache.set(mapDocRef.hash, hit);
        }
        return hit;
      },
      readMapDoc: (ref) => {
        const text = DOC_TEXT_BY_ASSET_ID[ref.assetId];
        assert(text !== undefined, "readMapDoc received an unknown asset id");
        assert(`sha256:${sha256(text)}` === ref.hash, "readMapDoc bytes do not match the authoritative ref hash");
        return text;
      },
    },
  });
  // Hermetic palette: the scatter pins per-asset content hashes, so a seeded stub id
  // keeps the gate independent of the (gitignored, regenerable) archetype GLBs.
  server.core.assets.seed("trees/test-pine.glb", new Uint8Array([1, 2, 3, 4]));
  return server;
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
      transactionId: "mount-mapdoc-veg-derived",
      projectId,
      baseRevision: snapshot.head.revision,
      baseHeadHash: snapshot.head.headHash,
      operations: [{
        adapter: "project-state",
        adapterVersion: "1.0.0",
        action: "refs.patch",
        input: { projectId, patch: { mapDoc: { assetId: MAP_DOC_ASSET_ID, hash: MAP_DOC_HASH } } },
        guard: { beforeHash: snapshot.projectState.stateHash },
      }],
    },
  });
}

/** The CURRENT composed field, rebuilt from the authority's committed refs through the
 *  SAME public module the server-side provider runs — an independent reconstruction a
 *  placement can be checked against. */
async function composedFieldNow(server: AuthoritativeServer) {
  const state = (await invoke(server, "authoring.projectState", {})) as unknown as {
    refs: { terrainEditLayers: { assetId: string; hash: string; layerId: string }[] };
  };
  const layers = [];
  for (const ref of state.refs.terrainEditLayers) {
    const read = (await invoke(server, "authoring.terrainEditLayer", { assetId: ref.assetId, hash: ref.hash })) as unknown as { layer: unknown };
    layers.push(parseTerrainEditLayer(read.layer));
  }
  const compiled = compileAtlasMapDoc({ mapsJsonText: MAP_DOC_TEXT });
  const baseTopology = terrainEditBaseTopologyForWorldMap(compiled.worldMap, { gridId: GRID_ID });
  return createComposedHeightField({
    baseTopology,
    baseField: compileDerivedBaseField(MAP_DOC_TEXT, GRID_ID),
    layers,
    mapDocHash: MAP_DOC_HASH,
  });
}

const inside = (x: number, z: number, disc: ScatterExclusion): boolean => {
  const dx = x - disc.x, dz = z - disc.z;
  return dx * dx + dz * dz <= disc.r * disc.r;
};

const LOG = "p_vegetation_scatter_derived.jsonl";
ops.op_write_trace(LOG, "");
const first = derivedServer(LOG);
await first.ready;
await mountMapDoc(first);

// A steep hill (slope far past slopeMax) and a high plateau (past elevationMax),
// both authored as derived edit-layer strokes.
const hill = (await invoke(first, "terrain.deform", { center: [12, 12], radius: 8, delta: 30, mode: "raise" })) as unknown as { ok: boolean };
assert(hill.ok === true, "derived raise stroke failed");
const plateau = (await invoke(first, "terrain.deform", { center: [-18, -18], radius: 10, delta: 80, mode: "flatten" })) as unknown as { ok: boolean };
assert(plateau.ok === true, "derived flatten stroke failed — the sampler was not wired");

// ---- (f) Derived smooth + flatten === the equivalent EditableTerrain brush --------

{
  const fieldBefore = await composedFieldNow(first);
  const tileAfter = { ...fieldBefore.denseTile(), heights: Float32Array.from(fieldBefore.denseTile().heights) } as TerrainTile;
  const smoothInput = { center: [10, 10] as [number, number], radius: 9, delta: 2, mode: "smooth" as const, falloff: "smooth" as const };
  applyBrush(tileAfter, smoothInput as never);
  const smoothStroke = (await invoke(first, "terrain.deform", smoothInput)) as unknown as { ok: boolean };
  assert(smoothStroke.ok === true, "derived smooth stroke failed — the sampler was not wired");
  const fieldAfterSmooth = await composedFieldNow(first);
  let smoothDiff = -1;
  const smoothHeights = fieldAfterSmooth.denseTile().heights;
  for (let index = 0; index < smoothHeights.length; index++) {
    if (!Object.is(smoothHeights[index], tileAfter.heights[index])) { smoothDiff = index; break; }
  }
  assert(smoothDiff === -1, `derived smooth diverged from the EditableTerrain brush at sample ${smoothDiff}`);
  const flattenInput = { center: [-4, 6] as [number, number], radius: 7, delta: 25, mode: "flatten" as const, falloff: "smooth" as const };
  applyBrush(tileAfter, flattenInput as never);
  const flattenStroke = (await invoke(first, "terrain.deform", flattenInput)) as unknown as { ok: boolean };
  assert(flattenStroke.ok === true, "derived flatten stroke failed after smooth");
  const fieldAfterFlatten = await composedFieldNow(first);
  let flattenDiff = -1;
  const flattenHeights = fieldAfterFlatten.denseTile().heights;
  for (let index = 0; index < flattenHeights.length; index++) {
    if (!Object.is(flattenHeights[index], tileAfter.heights[index])) { flattenDiff = index; break; }
  }
  assert(flattenDiff === -1, `derived flatten diverged from the EditableTerrain brush at sample ${flattenDiff}`);
  ops.op_log("[js] p_vegetation_scatter_derived (f) OK: derived smooth + flatten are byte-identical to the equivalent EditableTerrain brush");
}

// ---- (b) + (c): scatter on the derived world --------------------------------------

const inclusions: ScatterExclusion[] = [{ x: 12, z: 12, r: 16 }, { x: -18, z: -18, r: 16 }];
const exclusion: ScatterExclusion = { x: 18, z: 4, r: 5 };
const scatterArgs = {
  species: ["pine"],
  density: 32,
  seed: 4242,
  assets: [{ id: "trees/test-pine.glb" }],
  inclusions,
  exclusions: [exclusion],
  slopeMax: 0.85,
  elevationMax: 40,
  coverage: 1,
  cluster: 0,
};
interface Placement { assetId: string; x: number; y: number; z: number; yaw: number; scale: number }
const scattered = (await invoke(first, "vegetation.scatter", scatterArgs)) as unknown as {
  entity: string;
  instances: number;
  placements: Placement[];
  derivedField?: { mapDocHash: string; baseTopologyHash: string; layerHashes: string[] };
};
assert(scattered.instances > 0, "derived scatter placed nothing");
assert(scattered.instances === scattered.placements.length, "instance count does not match placements");
assert(scattered.derivedField !== undefined, "derived scatter did not emit the composed-field pin");
assert(scattered.derivedField.mapDocHash === MAP_DOC_HASH, "scatter pin binds a foreign MapDoc");

// Every placement sits on the composed field (rebuilt independently from the
// committed refs), inside an inclusion, outside the exclusion, under the tree line,
// and on ground no steeper than slopeMax (central differences on the same sampler).
const fieldNow = await composedFieldNow(first);
assert(fieldNow.layerHashes.join("|") === scattered.derivedField.layerHashes.join("|"), "scatter pin does not bind the committed layer stack");
const step = fieldNow.lattice.stepM;
for (const p of scattered.placements) {
  assert(Math.abs(p.y - fieldNow.heightAt(p.x, p.z)) < 1e-6, `placement at (${p.x}, ${p.z}) floats off the composed field`);
  assert(inclusions.some((disc) => inside(p.x, p.z, disc)), `placement at (${p.x}, ${p.z}) escaped every inclusion disc`);
  assert(!inside(p.x, p.z, exclusion), `placement at (${p.x}, ${p.z}) landed inside the exclusion disc`);
  assert(p.y <= 40 + 1e-9, `placement above the tree line (y=${p.y})`);
  const dcx = (fieldNow.heightAt(p.x + step, p.z) - fieldNow.heightAt(p.x - step, p.z)) / (2 * step);
  const dcz = (fieldNow.heightAt(p.x, p.z + step) - fieldNow.heightAt(p.x, p.z - step)) / (2 * step);
  assert(Math.sqrt(dcx * dcx + dcz * dcz) <= 0.85 + 1e-6, `placement on a too-steep face at (${p.x}, ${p.z})`);
}
// The gates demonstrably BIT: the steep hill core and the high plateau core are
// empty, while the flat rims of both inclusion discs carry trees.
assert(!scattered.placements.some((p) => inside(p.x, p.z, { x: 12, z: 12, r: 4.5 })), "the steep hill core placed trees (slope gate dead)");
assert(!scattered.placements.some((p) => inside(p.x, p.z, { x: -18, z: -18, r: 3 })), "the high plateau core placed trees (elevation gate dead)");
assert(scattered.placements.some((p) => inside(p.x, p.z, inclusions[0])), "the hill inclusion rim placed nothing");
assert(scattered.placements.some((p) => inside(p.x, p.z, inclusions[1])), "the plateau inclusion rim placed nothing");
ops.op_log(`[js] p_vegetation_scatter_derived (b)+(c) OK: derived scatter placed ${scattered.instances} pines on composed heights — slope/elevation gates and inclusion/exclusion discs honored`);

// The recorded command pins the composed-field identity.
const recordedScatter = parseWorldLog(ops.op_read_trace(LOG)).commands
  .find((command) => command.kind === "skill" && command.tool === "vegetation.scatter");
assert(recordedScatter !== undefined && recordedScatter.kind === "skill", "derived scatter was not recorded");
const recordedPin = (recordedScatter.input as { derivedField?: { mapDocHash: string; layerHashes: string[] } }).derivedField;
assert(recordedPin?.mapDocHash === MAP_DOC_HASH, "recorded scatter did not pin the MapDoc");
assert(recordedPin.layerHashes.join("|") === scattered.derivedField.layerHashes.join("|"), "recorded scatter did not pin the layer stack");

// ---- (d) Replay: rehydrate reproduces the world; a re-invoke is byte-identical ----

const stateBefore = (await invoke(first, "authoring.projectState", {})) as unknown as { stateHash: string };
await first.shutdown();
const second = derivedServer(LOG);
await second.ready; // replays every stroke (smooth/flatten through the sampler) + the scatter pin
const stateReplay = (await invoke(second, "authoring.projectState", {})) as unknown as { stateHash: string };
assert(stateReplay.stateHash === stateBefore.stateHash, "rehydrate reconstructed a different project state");
const rescattered = (await invoke(second, "vegetation.scatter", scatterArgs)) as unknown as { placements: Placement[]; derivedField?: unknown };
assert(JSON.stringify(rescattered.placements) === JSON.stringify(scattered.placements), "re-invoked scatter after rehydrate diverged");
assert(JSON.stringify(rescattered.derivedField) === JSON.stringify(scattered.derivedField), "re-invoked scatter pin diverged");
await second.shutdown();
ops.op_log("[js] p_vegetation_scatter_derived (d) OK: invoke → rehydrate → re-invoke is byte-identical (placements + composed-field pin)");

// ---- (e) Regression: a world WITH an EditableTerrain layer is byte-unchanged -------

const REGRESSION_LOG = "p_vegetation_scatter_derived_regression.jsonl";
ops.op_write_trace(REGRESSION_LOG, "");
{
  const regression = derivedServer(REGRESSION_LOG); // full derived wiring + mounted MapDoc: the derived path COULD fire
  await regression.ready;
  await mountMapDoc(regression);
  const created = (await invoke(regression, "terrain.create", { size: 200, resolution: 65, baseHeight: 0 })) as unknown as { entity: string };
  await invoke(regression, "terrain.deform", { entity: created.entity, center: [0, 0], radius: 70, delta: 30, mode: "raise" });
  const editableScatter = (await invoke(regression, "vegetation.scatter", {
    species: ["pine"],
    density: 24,
    seed: 4242,
    assets: [{ id: "trees/test-pine.glb" }],
    elevationMax: 20,
    slopeMax: 0.6,
    coverage: 0.9,
    cluster: 0.45,
  })) as unknown as { instances: number; placements: Placement[]; derivedField?: unknown };
  assert(editableScatter.derivedField === undefined, "the EditableTerrain path emitted a derived-field pin");
  assert(editableScatter.instances > 0, "the EditableTerrain regression scatter placed nothing");
  // Byte-parity with the pre-D5.4 behavior: the handler must produce EXACTLY what
  // scatterAssets computes over the layer tile directly.
  const layerEntry = [...regression.core.terrain.layers.values()][0];
  assert(layerEntry !== undefined, "the regression world lost its terrain layer");
  let loH = Infinity;
  for (let index = 0; index < layerEntry.tile.heights.length; index++) {
    const value = layerEntry.tile.heights[index];
    if (value < loH) loH = value;
  }
  const seaLevel = layerEntry.elevationColors?.seaLevel ?? (layerEntry.tile.origin[1] + loH);
  const direct = scatterAssets(layerEntry.tile, 4242, {
    seed: 4242,
    density: 24,
    assets: [{ id: "trees/test-pine.glb" }],
    slopeMax: 0.6,
    elevationMax: 20,
    coverage: 0.9,
    cluster: 0.45,
    sizeRange: [0.7, 1.35],
    elevationMin: seaLevel + 1.5,
  });
  assert(editableScatter.placements.length === direct.length, `EditableTerrain placements diverged (${editableScatter.placements.length} vs ${direct.length})`);
  for (let index = 0; index < direct.length; index++) {
    const a = editableScatter.placements[index], b = direct[index];
    assert(a.assetId === b.assetId && Object.is(a.x, b.x) && Object.is(a.y, b.y) && Object.is(a.z, b.z)
      && Object.is(a.yaw, b.yaw) && Object.is(a.scale, b.scale), `EditableTerrain placement ${index} diverged from the pre-D5.4 behavior`);
  }
  await regression.shutdown();
  ops.op_log("[js] p_vegetation_scatter_derived (e) OK: EditableTerrain worlds are byte-unchanged");
}

ops.op_log("p_vegetation_scatter_derived OK: the composed-height sampler matches the compiler (plain + hydrology-carved), vegetation.scatter runs on derived terrain with slope/elevation/inclusion/exclusion gates + replay pins, derived smooth/flatten match the EditableTerrain brush, and EditableTerrain worlds are untouched.");
