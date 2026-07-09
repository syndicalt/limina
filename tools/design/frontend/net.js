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
const SAVE_RETRY_DELAYS_MS = [500, 1000, 2000, 4000, 8000, 15000];
let saveTimer = null;
let retryAttempt = 0;
let getPayload = null; // bound once by map.js: () => ({ maps, activeMapId })
let mapsRev = null; // the on-disk revision this client's state derives from (compare-and-set)
let onConflict = null; // bound by map.js: another session saved first → reload, don't clobber
let onSaveError = null;

export function bindMapSaver(payloadFn) {
  getPayload = payloadFn;
  void sessionToken().catch(() => {});
}
export function bindSaveConflict(fn) { onConflict = fn; }
export function bindSaveError(fn) { onSaveError = fn; }
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
    if (r.status === 409) {
      retryAttempt = 0;
      if (onConflict) onConflict(j);
      return { conflict: true };
    }
    if (!r.ok || !j || j.ok !== true || typeof j.mapsRev !== "string") {
      const error = new Error(j?.error || `map save failed with HTTP ${r.status}`);
      error.status = r.status;
      throw error;
    }
    mapsRev = j.mapsRev;
    retryAttempt = 0;
    return j;
  } catch (error) {
    const transient = error?.status === 423 || error?.status === 502 || error?.status === 503 || error?.status === 504 || error instanceof TypeError;
    if (transient && retryAttempt < SAVE_RETRY_DELAYS_MS.length) {
      const delay = SAVE_RETRY_DELAYS_MS[retryAttempt++];
      if (!saveTimer) saveTimer = setTimeout(() => { saveTimer = null; void doSave().catch(() => {}); }, delay);
      if (retryAttempt === 1 && onSaveError) onSaveError(new Error(`${error.message}; retrying`));
    } else if (onSaveError) onSaveError(error);
    throw error;
  }
}

export function scheduleMapSave() {
  if (saveTimer) clearTimeout(saveTimer);
  retryAttempt = 0;
  saveTimer = setTimeout(() => { saveTimer = null; void doSave().catch(() => {}); }, SAVE_DEBOUNCE_MS);
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
  if (document.visibilityState === "hidden" && saveTimer) void flushMapSave().catch(() => {});
});
window.addEventListener("beforeunload", () => {
  if (!saveTimer || !getPayload || !cachedSessionToken) return;
  clearTimeout(saveTimer); saveTimer = null;
  const body = JSON.stringify({ ...getPayload(), baseRev: mapsRev, _token: cachedSessionToken });
  if (body.length < 60000) navigator.sendBeacon("/api/map-save", body);
});
