import assert from "node:assert/strict";
import test from "node:test";

function response(status, body) {
  return { status, ok: status >= 200 && status < 300, json: async () => body };
}

test("map saver handles conflicts once and retries transient authority failures", async () => {
  const names = ["document", "window", "navigator", "fetch", "setTimeout", "clearTimeout"];
  const originals = new Map(names.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  const install = (name, value) => Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  const timers = new Map();
  let nextTimer = 1;
  install("document", { visibilityState: "visible", addEventListener() {} });
  install("window", { addEventListener() {} });
  install("navigator", { sendBeacon() { return true; } });
  install("setTimeout", (callback, delay) => {
    const id = nextTimer++;
    timers.set(id, { callback, delay });
    return id;
  });
  install("clearTimeout", (id) => timers.delete(id));
  try {
    let phase = "conflict";
    let mapCalls = 0;
    install("fetch", async (url) => {
      if (url === "/api/session") return response(200, { token: "x".repeat(64) });
      assert.equal(url, "/api/map-save");
      mapCalls++;
      if (phase === "conflict") return response(409, { conflict: true, mapsRev: "new", error: "stale" });
      if (mapCalls === 2) return response(503, { ok: false, code: "authoring_unavailable", error: "editor restarting" });
      return response(200, { ok: true, mapsRev: "saved" });
    });

    const saver = await import(`./net.js?test=${Date.now()}`);
    saver.bindMapSaver(() => ({ maps: [{ id: "primary" }], activeMapId: "primary" }));
    saver.setMapsRev("base");
    let conflicts = 0;
    const errors = [];
    saver.bindSaveConflict(() => { conflicts++; });
    saver.bindSaveError((error) => errors.push(error.message));

    const conflictResult = await saver.flushMapSave();
    assert.deepEqual(conflictResult, { conflict: true });
    assert.equal(conflicts, 1);
    assert.deepEqual(errors, []);

    phase = "transient";
    await assert.rejects(saver.flushMapSave(), /editor restarting/);
    assert.deepEqual(errors, ["editor restarting; retrying"]);
    assert.equal(timers.size, 1);
    const [timerId, retry] = [...timers.entries()][0];
    assert.equal(retry.delay, 500);
    timers.delete(timerId);
    retry.callback();
    await new Promise((resolve) => originals.get("setTimeout").value(resolve, 0));
    assert.equal(mapCalls, 3);
    assert.equal(timers.size, 0);
    assert.deepEqual(errors, ["editor restarting; retrying"]);
  } finally {
    for (const [name, descriptor] of originals) {
      if (descriptor === undefined) delete globalThis[name];
      else Object.defineProperty(globalThis, name, descriptor);
    }
  }
});
