import {
  ATLAS_EDITOR_BRIDGE_SCHEMA,
  EDITOR_HANDOFF_READY,
  parseAtlasFocusRequest,
} from "./atlas-editor-protocol.js";
import { createAtlasEditorHandoff, parseAtlasHandoffRelayConfig, storeAtlasEditorHandoff } from "./atlas-handoff.js";

function fail(message) {
  const status = document.getElementById("handoff-status");
  if (status) status.textContent = message;
}

export function installAtlasHandoffRelayGate({
  eventTarget,
  opener,
  atlasOrigin,
  timeoutMs = 30_000,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  onFocus,
  onTimeout,
}) {
  let terminal = false;
  let timer;
  const cleanup = () => {
    eventTarget.removeEventListener("message", onMessage);
    if (timer !== undefined) clearTimer(timer);
  };
  const onMessage = (event) => {
    if (terminal || event.source !== opener || event.origin !== atlasOrigin) return;
    let focus;
    try { focus = parseAtlasFocusRequest(event.data); }
    catch { return; }
    terminal = true;
    cleanup();
    onFocus(focus);
  };
  eventTarget.addEventListener("message", onMessage);
  timer = setTimer(() => {
    if (terminal) return;
    terminal = true;
    cleanup();
    onTimeout();
  }, timeoutMs);
  return () => {
    if (terminal) return;
    terminal = true;
    cleanup();
  };
}

async function start() {
  const opener = window.opener;
  if (!opener) { fail("Atlas handoff is unavailable"); return; }
  const response = await fetch("/atlas-handoff-config", { cache: "no-store" });
  if (!response.ok) throw new Error("editor handoff configuration is unavailable");
  const config = parseAtlasHandoffRelayConfig(await response.json());
  installAtlasHandoffRelayGate({
    eventTarget: window,
    opener,
    atlasOrigin: config.atlasOrigin,
    onFocus: (focus) => {
      try {
        const handoff = createAtlasEditorHandoff({ serverUrl: config.editorServerUrl, focus });
        storeAtlasEditorHandoff(sessionStorage, handoff);
        window.opener = null;
        window.location.replace(config.editorUrl);
      } catch {
        fail("Atlas handoff could not be stored");
      }
    },
    onTimeout: () => {
      window.opener = null;
      fail("Atlas handoff timed out");
    },
  });
  const ready = Object.freeze({ schema: ATLAS_EDITOR_BRIDGE_SCHEMA, type: EDITOR_HANDOFF_READY });
  opener.postMessage(ready, config.atlasOrigin);
}

if (typeof window !== "undefined" && typeof document !== "undefined") {
  start().catch(() => fail("Atlas handoff could not start"));
}
