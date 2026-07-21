import { McpClient } from "./mcp-client.js";
import { ProjectAuthoringGateway } from "./authoring-gateway.js";
import { assertEditorAuthoringAllowed } from "./play-lifecycle.js";

const state = {
  client: undefined,
  connecting: undefined,
  generation: 0,
};

const authoring = new ProjectAuthoringGateway({ getClient: ensureWriter });

const val = (id) => {
  const el = document.getElementById(id);
  return el && el.value ? el.value.trim() : "";
};

function writerIsOpen(client) {
  const openState = globalThis.WebSocket?.OPEN ?? 1;
  return client?.ws?.readyState === openState;
}

export async function ensureWriter() {
  if (writerIsOpen(state.client)) return state.client;
  state.client = undefined;
  if (state.connecting) return state.connecting;
  const generation = state.generation;
  const connecting = (async () => {
    const url = val("url");
    const authToken = val("auth-token") || undefined;
    if (!url) throw new Error("server URL is required");
    const client = new McpClient(url);
    try {
      await client.connect();
      await client.initialize(
        "editor_writer",
        "ses_writer_" + Math.random().toString(36).slice(2, 8),
        "builder.readWrite",
        authToken,
      );
      if (generation !== state.generation) {
        client.close();
        throw new Error("writer connection was superseded");
      }
      client.onConnectionChange = (connected) => {
        if (connected || state.client !== client) return;
        state.client = undefined;
        authoring.invalidateHead();
      };
      state.client = client;
      return client;
    } catch (e) {
      try { client.close(); } catch { /* ignore */ }
      throw e;
    } finally {
      if (state.connecting === connecting) state.connecting = undefined;
    }
  })();
  state.connecting = connecting;
  return connecting;
}

export function commitSceneOperations(operations) {
  assertEditorAuthoringAllowed();
  return authoring.commit(operations);
}

export function undoSceneAuthoring() {
  assertEditorAuthoringAllowed();
  return authoring.undo();
}

export function redoSceneAuthoring() {
  assertEditorAuthoringAllowed();
  return authoring.redo();
}

export function refreshAuthoringHead() {
  return authoring.refreshHead();
}

export function sceneAuthoringHistory() {
  return authoring.historySnapshot();
}

export async function writeUpdate(entity, component, value) {
  assertEditorAuthoringAllowed();
  const client = await ensureWriter();
  const result = await client.callTool("ecs.updateComponent", { entity, component, value });
  if (!result || result.ok !== true) throw new Error(`ecs.updateComponent ${component} returned ok=false`);
  return result;
}

// In-game terrain brush (Slice 1): stamp a terrain.deform through the SAME recorded command path an
// AI builder uses. The server records + broadcasts it; the viewport's poll() pulls it back and applies
// it in place. `center` is world [x,z]; mode is raise|lower|smooth|flatten. terrain.deform defaults to
// the most-recently-created terrain layer when `entity` is omitted.
export async function deformTerrain(center, radius, delta, mode, falloff) {
  assertEditorAuthoringAllowed();
  const client = await ensureWriter();
  const result = await client.callTool("terrain.deform", { center, radius, delta, mode, falloff });
  // The skill returns ok:false (not a throw) when no EditableTerrain layer
  // exists — e.g. brushing streamed generateRegion terrain. Until D5 edit
  // layers land, that stroke is a no-op and MUST be loud, not silent.
  if (!result || result.ok !== true) {
    throw new Error("terrain.deform found no editable terrain layer (sculpting streamed terrain needs edit layers — D5)");
  }
  return result;
}

// Terrain material paint (Slice 3): blend a surface material (sand/grass/rock/dirt) onto the terrain.
// strength is a 0..1 blend rate; erase pulls paint back out. Recorded like deform.
export async function paintTerrain(center, radius, strength, falloff, material, erase) {
  assertEditorAuthoringAllowed();
  const client = await ensureWriter();
  const result = await client.callTool("terrain.paint", { center, radius, strength, falloff, material, erase: !!erase });
  if (!result || result.ok !== true) {
    throw new Error("terrain.paint found no editable terrain layer (painting streamed terrain needs edit layers — D5)");
  }
  return result;
}

// Asset catalog (Slice 4): read the QC-approved catalog for the palette. Read-only — never held by
// the review gate — but routed through the same writer client so one profile covers the whole tool.
export async function fetchCatalog() {
  const client = await ensureWriter();
  return client.callTool("asset.catalog", {});
}

// ＋New (Slice 5): record a build request for the architect — a description of an asset that doesn't
// exist yet. Non-blocking; the architect authors it out-of-engine and proposes catalog.publish.
export async function requestAsset(description, category, refImage) {
  assertEditorAuthoringAllowed();
  const client = await ensureWriter();
  return client.callTool("asset.request", { description, category, ...(refImage ? { refImage } : {}) });
}

// Catalog place tool (Slice 4): place a whole approved GLB through the same recorded command path.
// ground:true snaps the asset base to the terrain surface at (x,z); rotation is Euler radians.
export async function placeAsset(assetId, position, opts = {}) {
  assertEditorAuthoringAllowed();
  const client = await ensureWriter();
  return client.callTool("asset.place", { assetId, position, ground: true, ...opts });
}

// Water tools (2.0-C): the world water plane is a single world-scale surface
// (no position — level/size only); a river is a terrain-following ribbon over
// a clicked centerline. Both recorded like every other write.
export async function addWaterPlane(level, size) {
  assertEditorAuthoringAllowed();
  const client = await ensureWriter();
  // Returns {level,size,color} (no ok field) — invalid input throws over the wire.
  return client.callTool("world.addWater", { level, size });
}

export async function addRiver(points, widthM, waterClass) {
  assertEditorAuthoringAllowed();
  const client = await ensureWriter();
  return client.callTool("world.addRiver", { points, widthM, class: waterClass });
}

// Scatter brush (2.0-C): one dab = one recorded vegetation.scatter confined to
// the brush disc. The caller derives the seed deterministically (stroke counter
// + dab index) — never Math.random, replay must rebuild the same forest.
export async function scatterVegetation({ species, density, seed, x, z, r }) {
  assertEditorAuthoringAllowed();
  const client = await ensureWriter();
  const input = { density, seed, inclusions: [{ x, z, r }] };
  if (species !== "mixed") input.species = [species];
  return client.callTool("vegetation.scatter", input);
}

export async function writeMaterial(entity, material) {
  assertEditorAuthoringAllowed();
  const client = await ensureWriter();
  const result = await client.callTool("three.setMaterial", { entity, ...material });
  if (!result || result.ok !== true) throw new Error(`three.setMaterial returned ok=false for ${entity}`);
  return result;
}

export async function addTag(entity, tag) {
  assertEditorAuthoringAllowed();
  const client = await ensureWriter();
  const result = await client.callTool("ecs.addComponent", { entity, component: tag });
  if (!result || result.ok !== true) throw new Error(`ecs.addComponent returned ok=false for ${entity}`);
  return result;
}

export async function removeTag(entity, tag) {
  assertEditorAuthoringAllowed();
  const client = await ensureWriter();
  const result = await client.callTool("ecs.removeComponent", { entity, component: tag });
  if (!result || result.ok !== true) throw new Error(`ecs.removeComponent returned ok=false for ${entity}`);
  return result;
}

export async function destroyEntity(entity) {
  assertEditorAuthoringAllowed();
  const client = await ensureWriter();
  const result = await client.callTool("scene.destroyEntity", { entity });
  if (!result || result.removed !== true) throw new Error(`scene.destroyEntity returned removed=false for ${entity}`);
  return result;
}

export function resetWriter() {
  const client = state.client;
  state.generation++;
  state.client = undefined;
  state.connecting = undefined;
  authoring.invalidateHead();
  try { client?.close(); } catch { /* ignore */ }
}

export function closeWriter() {
  resetWriter();
}
