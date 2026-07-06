import { McpClient } from "./mcp-client.js";

const state = {
  client: undefined,
  connecting: undefined,
};

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
  state.connecting = (async () => {
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
      state.client = client;
      return client;
    } catch (e) {
      try { client.close(); } catch { /* ignore */ }
      throw e;
    } finally {
      state.connecting = undefined;
    }
  })();
  return state.connecting;
}

export async function writeUpdate(entity, component, value) {
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
  const client = await ensureWriter();
  return client.callTool("terrain.deform", { center, radius, delta, mode, falloff });
}

// Terrain material paint (Slice 3): blend a surface material (sand/grass/rock/dirt) onto the terrain.
// strength is a 0..1 blend rate; erase pulls paint back out. Recorded like deform.
export async function paintTerrain(center, radius, strength, falloff, material, erase) {
  const client = await ensureWriter();
  return client.callTool("terrain.paint", { center, radius, strength, falloff, material, erase: !!erase });
}

export async function writeMaterial(entity, material) {
  const client = await ensureWriter();
  const result = await client.callTool("three.setMaterial", { entity, ...material });
  if (!result || result.ok !== true) throw new Error(`three.setMaterial returned ok=false for ${entity}`);
  return result;
}

export async function addTag(entity, tag) {
  const client = await ensureWriter();
  const result = await client.callTool("ecs.addComponent", { entity, component: tag });
  if (!result || result.ok !== true) throw new Error(`ecs.addComponent returned ok=false for ${entity}`);
  return result;
}

export async function removeTag(entity, tag) {
  const client = await ensureWriter();
  const result = await client.callTool("ecs.removeComponent", { entity, component: tag });
  if (!result || result.ok !== true) throw new Error(`ecs.removeComponent returned ok=false for ${entity}`);
  return result;
}

export async function destroyEntity(entity) {
  const client = await ensureWriter();
  const result = await client.callTool("scene.destroyEntity", { entity });
  if (!result || result.removed !== true) throw new Error(`scene.destroyEntity returned removed=false for ${entity}`);
  return result;
}

export function resetWriter() {
  state.client = undefined;
  state.connecting = undefined;
}

export function closeWriter() {
  try { state.client?.close(); } catch { /* ignore */ }
  resetWriter();
}
