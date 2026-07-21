import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  atlasProxyPath,
  createEditorStaticServer,
  parseAtlasOrigin,
} from "./scaffold/scripts/serve.mjs";

async function listen(server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return server.address().port;
}

async function close(server) {
  if (!server.listening) return;
  server.close();
  await once(server, "close");
}

function send(port, path, { method = "GET", body = "", headers = {} } = {}) {
  return new Promise((resolveResponse, rejectResponse) => {
    const req = request({ host: "127.0.0.1", port, path, method, headers, agent: false }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolveResponse({
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      }));
    });
    req.once("error", rejectResponse);
    req.end(body);
  });
}

assert.equal(parseAtlasOrigin(undefined), undefined);
assert.equal(parseAtlasOrigin("http://127.0.0.1:4321").origin, "http://127.0.0.1:4321");
for (const origin of [
  "http://localhost:4321",
  "https://127.0.0.1:4321",
  "http://127.0.0.1:4321/",
  "http://127.0.0.1:4321/path",
  "http://user@127.0.0.1:4321",
  "http://127.0.0.1",
]) assert.throws(() => parseAtlasOrigin(origin), /exact http/);

assert.equal(atlasProxyPath("/api/state?fresh=1"), "/api/state?fresh=1");
assert.equal(atlasProxyPath("/shared/raster-codec.mjs"), "/shared/raster-codec.mjs");
assert.equal(atlasProxyPath("/assets/qc/tree.png"), "/assets/qc/tree.png");
assert.equal(atlasProxyPath("/assets/tree.glb"), undefined);
// Engine-shared validator modules (serve-design SHARED_MODULES): the native Atlas
// surface imports /js/src/world/*.mjs on this origin, so the proxy must carry the
// family — and ONLY that family (falsifiability: a non-.mjs or out-of-family path
// must never be proxied).
assert.equal(atlasProxyPath("/js/src/world/water-ir.mjs"), "/js/src/world/water-ir.mjs");
assert.equal(atlasProxyPath("/js/src/world/hydrology-ir.mjs?v=1"), "/js/src/world/hydrology-ir.mjs?v=1");
assert.equal(atlasProxyPath("/js/src/world/water-ir.js"), undefined);
assert.equal(atlasProxyPath("/js/src/skills/registry.mjs"), undefined);
assert.equal(atlasProxyPath("/js/src/world/pipeline/raster-codec.mjs"), undefined);
assert.equal(atlasProxyPath("/js/src/world/../../secrets.mjs"), undefined);

const fixture = mkdtempSync(join(tmpdir(), "limina-scaffold-serve-"));
const root = join(fixture, "editor");
const assets = join(fixture, "assets");
mkdirSync(root, { recursive: true });
mkdirSync(assets, { recursive: true });
writeFileSync(join(root, "index.html"), "editor-index");
writeFileSync(join(assets, "tree.glb"), "local-asset");

const received = [];
const atlas = createServer((req, res) => {
  const chunks = [];
  req.on("data", (chunk) => chunks.push(chunk));
  req.on("end", () => {
    received.push({ method: req.method, url: req.url, host: req.headers.host, body: Buffer.concat(chunks).toString("utf8") });
    res.writeHead(207, {
      "content-type": "text/plain",
      "x-atlas-upstream": "yes",
      "cross-origin-opener-policy": "unsafe-none",
      connection: "x-remove",
      "x-remove": "hop-by-hop",
    });
    res.end(`atlas:${req.url}`);
  });
});

let editor;
try {
  const atlasPort = await listen(atlas);
  editor = createEditorStaticServer({
    root,
    assetRoot: assets,
    atlasOrigin: `http://127.0.0.1:${atlasPort}`,
    editorServerUrl: "ws://localhost:8790/",
  });
  const editorPort = await listen(editor);

  for (const [path, upstreamPath] of [
    ["/api/state?fresh=1", "/api/state?fresh=1"],
    ["/shared/raster-codec.mjs", "/shared/raster-codec.mjs"],
    ["/assets/qc/tree.png", "/assets/qc/tree.png"],
  ]) {
    const response = await send(editorPort, path);
    assert.equal(response.status, 207);
    assert.equal(response.body, `atlas:${upstreamPath}`);
    assert.equal(response.headers["x-atlas-upstream"], "yes");
    assert.equal(response.headers["cross-origin-opener-policy"], "same-origin");
    assert.equal(response.headers["cross-origin-embedder-policy"], "require-corp");
    assert.equal(response.headers["cross-origin-resource-policy"], "same-origin");
    assert.equal(response.headers["x-remove"], undefined);
  }

  const payload = JSON.stringify({ maps: [] });
  const post = await send(editorPort, "/api/map-save", {
    method: "POST",
    body: payload,
    headers: { "content-type": "application/json", "content-length": Buffer.byteLength(payload) },
  });
  assert.equal(post.status, 207);
  assert.deepEqual(received.at(-1), {
    method: "POST",
    url: "/api/map-save",
    host: `127.0.0.1:${atlasPort}`,
    body: payload,
  });

  const localAsset = await send(editorPort, "/assets/tree.glb");
  assert.equal(localAsset.status, 200);
  assert.equal(localAsset.body, "local-asset");
  assert.equal(received.length, 4, "non-QC assets must not reach Atlas");

  await close(atlas);
  const unavailable = await send(editorPort, "/api/state");
  assert.equal(unavailable.status, 502);
  assert.equal(unavailable.headers["cross-origin-opener-policy"], "same-origin");
  assert.equal(unavailable.headers["cross-origin-embedder-policy"], "require-corp");
  assert.equal(unavailable.headers["cross-origin-resource-policy"], "same-origin");
} finally {
  await close(editor);
  await close(atlas);
  rmSync(fixture, { recursive: true, force: true });
}

console.log("scaffold-serve.test OK: Atlas proxy, isolated editor, and upstream failure");
