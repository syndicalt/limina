// design-api client contract (studio-unification U1). Proves: each method's
// URL/method/body, argument TypeErrors, the DesignApiError mappings (HTTP status +
// truncated body, {ok:false} domain errors, timeout via abort race with no leaked
// timer, invalid JSON), and the 404 "unavailable" flavor the panel keys on.
// Falsifiability: a client that swallowed statuses or leaked timers fails the
// mapped assertions; a fetch that resolves cannot satisfy the never-resolving
// timeout double unless the abort race exists.

import assert from "node:assert/strict";
import test from "node:test";

import { createDesignApi, DesignApiError } from "../src/design-api.js";

function fakeFetch(handler) {
  const calls = [];
  const fn = (url, init) => {
    calls.push({ url, init });
    return handler(url, init);
  };
  return { calls, fn };
}

function jsonResponse(body, { status = 200 } = {}) {
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    text: () => Promise.resolve(typeof body === "string" ? body : JSON.stringify(body)),
  });
}

test("methods map to the right endpoints with JSON bodies", async () => {
  const { calls, fn } = fakeFetch(() => jsonResponse({ ok: true }));
  const api = createDesignApi({ fetchImpl: fn });
  await api.state();
  await api.packs();
  await api.save("a.md", "text");
  await api.docCreate("T", "note");
  await api.docDelete("a.md");
  await api.editPlace("reparent", { id: "p1", parentId: "p2" });
  await api.packImport("pack-x");
  assert.deepEqual(calls.map((c) => c.url), ["/api/state", "/api/packs", "/api/save", "/api/doc-create", "/api/doc-delete", "/api/edit-place", "/api/pack-import"]);
  assert.equal(calls[0].init.method, "GET");
  assert.equal(calls[2].init.method, "POST");
  assert.equal(calls[2].init.headers["content-type"], "application/json");
  assert.deepEqual(JSON.parse(calls[2].init.body), { name: "a.md", content: "text" });
  assert.deepEqual(JSON.parse(calls[5].init.body), { op: "reparent", place: { id: "p1", parentId: "p2" } });
  assert.deepEqual(JSON.parse(calls[6].init.body), { pack: "pack-x" });
  // Relative-only: nothing here may bypass the proxy with an absolute URL.
  for (const c of calls) assert.ok(c.url.startsWith("/api/"), `same-origin relative: ${c.url}`);
});

test("argument validation throws TypeError synchronously", () => {
  const api = createDesignApi({ fetchImpl: () => jsonResponse({}) });
  assert.throws(() => api.save("", "x"), TypeError);
  assert.throws(() => api.save("a.md", 42), TypeError);
  assert.throws(() => api.docCreate("t", ""), TypeError);
  assert.throws(() => api.docDelete(null), TypeError);
  assert.throws(() => api.editPlace("", {}), TypeError);
  assert.throws(() => api.packImport(7), TypeError);
  assert.throws(() => createDesignApi({ fetchImpl: "nope" }), TypeError);
});

test("HTTP errors carry status + truncated body; 404 reads as unavailable", async () => {
  const long = "x".repeat(4096);
  let api = createDesignApi({ fetchImpl: () => jsonResponse(long, { status: 500 }) });
  await assert.rejects(api.state(), (e) => {
    assert.ok(e instanceof DesignApiError);
    assert.equal(e.status, 500);
    assert.ok(e.body.length <= 512);
    return true;
  });
  api = createDesignApi({ fetchImpl: () => jsonResponse("not found", { status: 404 }) });
  await assert.rejects(api.state(), /unavailable \(HTTP 404\)/);
});

test("{ ok: false } domain errors surface their message with the HTTP status", async () => {
  const api = createDesignApi({ fetchImpl: () => jsonResponse({ ok: false, error: "reparent rejected: cycle" }) });
  await assert.rejects(api.editPlace("reparent", {}), (e) => {
    assert.ok(e instanceof DesignApiError);
    assert.equal(e.status, 200);
    assert.match(e.message, /cycle/);
    return true;
  });
});

test("timeout rejects via the abort race and leaves no timer behind", async () => {
  let cleared = false;
  const realClear = clearTimeout;
  const realSet = setTimeout;
  // Watch the client's own timer handle through the globals it uses.
  globalThis.setTimeout = (...args) => {
    const handle = realSet(...args);
    return handle;
  };
  globalThis.clearTimeout = (handle) => { cleared = true; return realClear(handle); };
  try {
    const api = createDesignApi({
      fetchImpl: () => new Promise(() => {}), // never resolves: only the abort race can save the caller
      timeoutMs: 25,
    });
    await assert.rejects(api.state(), (e) => {
      assert.ok(e instanceof DesignApiError);
      assert.equal(e.status, 0);
      assert.match(e.message, /timed out/);
      return true;
    });
    assert.equal(cleared, true, "the timeout timer must be cleared in finally");
  } finally {
    globalThis.setTimeout = realSet;
    globalThis.clearTimeout = realClear;
  }
});

test("invalid JSON and network failures are DesignApiErrors", async () => {
  let api = createDesignApi({ fetchImpl: () => jsonResponse("{not json", { status: 200 }) });
  await assert.rejects(api.state(), /invalid JSON/);
  api = createDesignApi({ fetchImpl: () => Promise.reject(new Error("socket reset")) });
  await assert.rejects(api.state(), (e) => {
    assert.ok(e instanceof DesignApiError);
    assert.equal(e.status, 0);
    assert.match(e.message, /socket reset/);
    return true;
  });
});
