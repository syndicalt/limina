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

export function resetWriter() {
  state.client = undefined;
  state.connecting = undefined;
}

export function closeWriter() {
  try { state.client?.close(); } catch { /* ignore */ }
  resetWriter();
}
