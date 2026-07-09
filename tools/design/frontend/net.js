// net.js — API helpers + the debounced map saver. Map mutations call scheduleMapSave() (750ms
// trailing debounce — 10+ wholesale POSTs per drag session was fine for tiny feature lists but
// won't survive S1 rasters); paths that need write-ordering (lasso's follow-up marker unlink,
// map switch/create) await flushMapSave() instead. A beforeunload beacon flushes a pending save
// so closing the tab mid-debounce can't drop the last edit.

let sessionTokenPromise;
let cachedSessionToken;

async function sessionToken() {
  if (!sessionTokenPromise) {
    sessionTokenPromise = fetch("/api/session", { cache: "no-store" })
      .then((response) => {
        if (!response.ok) throw new Error(`design session failed: ${response.status}`);
        return response.json();
      })
      .then((body) => {
        if (typeof body.token !== "string" || body.token.length < 32) throw new Error("design session returned an invalid token");
        cachedSessionToken = body.token;
        return cachedSessionToken;
      });
  }
  return sessionTokenPromise;
}

export async function postJSON(url, body) {
  const token = await sessionToken();
  const r = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", "x-limina-design-token": token },
    body: JSON.stringify(body),
  });
  return r.json();
}

const SAVE_DEBOUNCE_MS = 750;
let saveTimer = null;
let getPayload = null; // bound once by map.js: () => ({ maps, activeMapId })
let mapsRev = null; // the on-disk revision this client's state derives from (compare-and-set)
let onConflict = null; // bound by map.js: another session saved first → reload, don't clobber

export function bindMapSaver(payloadFn) {
  getPayload = payloadFn;
  void sessionToken().catch(() => {});
}
export function bindSaveConflict(fn) { onConflict = fn; }
export function setMapsRev(rev) { mapsRev = typeof rev === "string" ? rev : null; }

async function doSave() {
  if (!getPayload) return;
  try {
    const token = await sessionToken();
    const r = await fetch("/api/map-save", {
      method: "POST",
      headers: { "content-type": "application/json", "x-limina-design-token": token },
      body: JSON.stringify({ ...getPayload(), baseRev: mapsRev }),
    });
    const j = await r.json();
    if (r.status === 409) { if (onConflict) onConflict(j); return; }
    if (j && typeof j.mapsRev === "string") mapsRev = j.mapsRev;
  } catch { /* next schedule retries */ }
}

export function scheduleMapSave() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { saveTimer = null; doSave(); }, SAVE_DEBOUNCE_MS);
}

export async function flushMapSave() {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  await doSave();
}

// The close-tab safety net. Primary: flush with a NORMAL fetch when the tab goes hidden —
// browsers cap sendBeacon payloads at 64 KiB, which a single paint raster already exceeds, so
// the beacon alone silently drops big saves. The beacon stays as a last-resort fallback for
// small payloads on an instant close (it carries baseRev, so a late/unordered delivery can't
// clobber a newer session — compare-and-set refuses it).
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden" && saveTimer) flushMapSave();
});
window.addEventListener("beforeunload", () => {
  if (!saveTimer || !getPayload || !cachedSessionToken) return;
  clearTimeout(saveTimer); saveTimer = null;
  const body = JSON.stringify({ ...getPayload(), baseRev: mapsRev, _token: cachedSessionToken });
  if (body.length < 60000) navigator.sendBeacon("/api/map-save", body);
});
