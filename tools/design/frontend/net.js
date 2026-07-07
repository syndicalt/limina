// net.js — API helpers + the debounced map saver. Map mutations call scheduleMapSave() (750ms
// trailing debounce — 10+ wholesale POSTs per drag session was fine for tiny feature lists but
// won't survive S1 rasters); paths that need write-ordering (lasso's follow-up marker unlink,
// map switch/create) await flushMapSave() instead. A beforeunload beacon flushes a pending save
// so closing the tab mid-debounce can't drop the last edit.

export async function postJSON(url, body) {
  const r = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return r.json();
}

const SAVE_DEBOUNCE_MS = 750;
let saveTimer = null;
let getPayload = null; // bound once by map.js: () => ({ maps, activeMapId })

export function bindMapSaver(payloadFn) { getPayload = payloadFn; }

async function doSave() {
  if (!getPayload) return;
  try { await postJSON("/api/map-save", getPayload()); } catch { /* next schedule retries */ }
}

export function scheduleMapSave() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { saveTimer = null; doSave(); }, SAVE_DEBOUNCE_MS);
}

export async function flushMapSave() {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  await doSave();
}

window.addEventListener("beforeunload", () => {
  if (!saveTimer || !getPayload) return;
  clearTimeout(saveTimer); saveTimer = null;
  // sendBeacon survives tab close where fetch may not; the server JSON-parses the body
  // regardless of the beacon's text/plain content-type.
  navigator.sendBeacon("/api/map-save", JSON.stringify(getPayload()));
});
