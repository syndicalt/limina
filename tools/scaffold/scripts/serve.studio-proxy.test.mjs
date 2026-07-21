// p_studio_proxy (studio-unification U0b): the launcher-supervised static server is
// the single HTTP entry to the design backend. It proxies /api/* upstream with the
// launcher-issued design token attached server-side — the browser never holds it.
// (The old Atlas SPA it once served locally is retired; the native Atlas surface
// is part of the editor bundle.)
//
// Falsifiability: a proxy started WITHOUT the token must get 403 from the same
// mutation (leg 5) — proving injection, not an open sidecar, passes leg 3.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createEditorStaticServer } from "./serve.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const DESIGN_TOKEN = "D".repeat(48);
const EDITOR_TOKEN = "E".repeat(43);

async function unusedPort() {
  const server = createServer();
  await new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  await new Promise((resolveClose) => server.close(resolveClose));
  return address.port;
}

function http(port, method, path, { token, body, host } = {}) {
  return new Promise((resolveResponse, reject) => {
    const headers = { Host: host ?? `127.0.0.1:${port}` };
    if (token !== undefined) headers["x-limina-design-token"] = token;
    if (body !== undefined) headers["content-type"] = "application/json";
    const req = request({ hostname: "127.0.0.1", port, path, method, headers }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolveResponse({ status: res.statusCode, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.setTimeout(2_000, () => req.destroy(new Error("request timeout")));
    req.once("error", reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

function listen(server, port) {
  return new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolveListen);
  });
}

function close(server) {
  return new Promise((resolveClose) => server.close(resolveClose));
}

test("studio proxy: token-injected API over a headless sidecar", { timeout: 30_000 }, async () => {
  const tmp = mkdtempSync(join(tmpdir(), "limina-studio-proxy-"));
  const editorDir = join(tmp, "editor");
  const vault = join(tmp, "design");
  mkdirSync(editorDir);
  mkdirSync(vault);
  mkdirSync(join(tmp, "assets"));
  writeFileSync(join(tmp, "limina.project.json"), JSON.stringify({
    schema: "limina-project/1",
    projectId: "studio-proxy-test",
    assetRoot: "assets",
  }));
  writeFileSync(join(vault, "note.md"), "first revision\n");
  writeFileSync(join(editorDir, "index.html"), "<html>editor</html>\n");

  const atlasPort = await unusedPort();
  const proxyPort = await unusedPort();
  const sidecar = spawn(
    process.execPath,
    [join(ROOT, "tools/design/serve-design.mjs"), vault, String(atlasPort), "--headless"],
    { cwd: ROOT, stdio: ["ignore", "ignore", "pipe"], env: { ...process.env, LIMINA_DESIGN_TOKEN: DESIGN_TOKEN } },
  );
  let diagnostics = "";
  sidecar.stderr.on("data", (chunk) => { diagnostics = (diagnostics + chunk).slice(-8_192); });

  const proxy = createEditorStaticServer({
    root: editorDir,
    assetRoot: join(tmp, "assets"),
    atlasOrigin: `http://127.0.0.1:${atlasPort}`,
    editorServerUrl: "ws://localhost:8787/",
    editorToken: EDITOR_TOKEN,
    designToken: DESIGN_TOKEN,
  });
  const tokenlessProxy = createEditorStaticServer({
    root: editorDir,
    assetRoot: join(tmp, "assets"),
    atlasOrigin: `http://127.0.0.1:${atlasPort}`,
  });
  const tokenlessPort = await unusedPort();

  try {
    // Sidecar readiness.
    for (let attempt = 0; attempt < 50; attempt += 1) {
      if (sidecar.exitCode !== null) throw new Error(`sidecar exited ${sidecar.exitCode}: ${diagnostics}`);
      try { await http(atlasPort, "GET", "/api/packs"); break; }
      catch { await new Promise((r) => setTimeout(r, 100)); }
    }
    await listen(proxy, proxyPort);
    await listen(tokenlessProxy, tokenlessPort);

    // 1. A browser WITHOUT any token mutates through the proxy — the proxy attached
    // the launcher token server-side (a malformed payload fails PAST auth: not 403).
    const viaProxy = await http(proxyPort, "POST", "/api/save", { body: {} });
    assert.notEqual(viaProxy.status, 403, `proxy must inject the launcher token: ${viaProxy.status} (${viaProxy.body.slice(0, 160)})`);

    // 2. The sidecar cannot be bypassed directly, and its session issuance is gone.
    const direct = await http(atlasPort, "POST", "/api/save", { body: {} });
    assert.equal(direct.status, 403, `direct sidecar mutation must stay 403: ${direct.status}`);
    const session = await http(proxyPort, "GET", "/api/session");
    assert.equal(session.status, 200, "proxied session reaches the headless sidecar");
    assert.match(JSON.parse(session.body).token, /^limina-proxy-attached/, "headless session carries the placeholder, never the real token");

    // 3. FALSIFIABILITY: a proxy without the token gets 403 from the same mutation.
    const noInject = await http(tokenlessPort, "POST", "/api/save", { body: {} });
    assert.equal(noInject.status, 403, `a tokenless proxy must NOT pass auth: ${noInject.status}`);

    // 4. Runtime capability handoff: /editor-bootstrap vends the session capability
    // to the page — with a loopback Host…
    const bootstrap = await http(proxyPort, "GET", "/editor-bootstrap");
    assert.equal(bootstrap.status, 200, `bootstrap endpoint: ${bootstrap.status}`);
    const config = JSON.parse(bootstrap.body);
    assert.equal(config.schema, "limina.editor-bootstrap/v1");
    assert.equal(config.token, EDITOR_TOKEN, "bootstrap carries the session capability");
    assert.equal(config.serverUrl, "ws://localhost:8787/");
    // …but DNS rebinding (hostile Host header) gets 403 on EVERY route — the
    // bootstrap above all, since it carries a credential.
    const reboundBootstrap = await http(proxyPort, "GET", "/editor-bootstrap", { host: "evil.example" });
    assert.equal(reboundBootstrap.status, 403, `rebinding on bootstrap must be 403: ${reboundBootstrap.status}`);
    assert.ok(!reboundBootstrap.body.includes(EDITOR_TOKEN), "the capability must never leave on a rebound request");
    const reboundStatic = await http(proxyPort, "GET", "/", { host: "evil.example" });
    assert.equal(reboundStatic.status, 403, `rebinding on static routes must be 403: ${reboundStatic.status}`);
    // A tokenless server vends no endpoint at all.
    const noBootstrap = await http(tokenlessPort, "GET", "/editor-bootstrap");
    assert.equal(noBootstrap.status, 404, `no capability configured → no endpoint: ${noBootstrap.status}`);
  } finally {
    sidecar.kill("SIGKILL");
    await close(proxy);
    await close(tokenlessProxy);
    rmSync(tmp, { recursive: true, force: true });
  }
});
