// serve-design --headless (studio-unification U0a): the sidecar serves no UI and
// issues no session token; mutation auth comes solely from the launcher-issued
// LIMINA_DESIGN_TOKEN. The old Atlas SPA is retired entirely, so standalone mode
// serves no UI either — but it still issues a per-boot session token (leg 4).

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const TOKEN = "T".repeat(48);

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

function http(port, method, path, { token, body } = {}) {
  return new Promise((resolveResponse, reject) => {
    const headers = { Host: `127.0.0.1:${port}` };
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

function makeProject() {
  const project = mkdtempSync(join(tmpdir(), "limina-design-headless-"));
  const vault = join(project, "design");
  mkdirSync(vault);
  mkdirSync(join(project, "assets"));
  writeFileSync(join(project, "limina.project.json"), JSON.stringify({
    schema: "limina-project/1",
    projectId: "design-headless-test",
    assetRoot: "assets",
  }));
  writeFileSync(join(vault, "note.md"), "first revision\n");
  return { project, vault };
}

async function bootDesignServer(vault, port, extraArgs, env) {
  const child = spawn(
    process.execPath,
    [join(ROOT, "tools/design/serve-design.mjs"), vault, String(port), ...extraArgs],
    { cwd: ROOT, stdio: ["ignore", "ignore", "pipe"], env: { ...process.env, ...env } },
  );
  let diagnostics = "";
  child.stderr.on("data", (chunk) => { diagnostics = (diagnostics + chunk).slice(-8_192); });
  // Wait for readiness: the Host guard makes any loopback request answerable once up.
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`design server exited ${child.exitCode}: ${diagnostics}`);
    try {
      await http(port, "GET", "/api/packs");
      return { child, diagnostics: () => diagnostics };
    } catch {
      await new Promise((resolveWait) => setTimeout(resolveWait, 100));
    }
  }
  throw new Error(`design server did not become ready: ${diagnostics}`);
}

test("headless boot fails closed without LIMINA_DESIGN_TOKEN", { timeout: 15_000 }, async () => {
  const { project, vault } = makeProject();
  const port = await unusedPort();
  const child = spawn(
    process.execPath,
    [join(ROOT, "tools/design/serve-design.mjs"), vault, String(port), "--headless"],
    { cwd: ROOT, stdio: ["ignore", "ignore", "pipe"], env: { ...process.env, LIMINA_DESIGN_TOKEN: "" } },
  );
  let diagnostics = "";
  child.stderr.on("data", (chunk) => { diagnostics += chunk; });
  const exitCode = await new Promise((resolveExit) => child.on("exit", resolveExit));
  try {
    assert.notEqual(exitCode, 0, "headless without a token must refuse to boot");
    assert.match(diagnostics, /LIMINA_DESIGN_TOKEN/);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test("headless serves no SPA and no session, and gates mutations on the launcher token", { timeout: 20_000 }, async () => {
  const { project, vault } = makeProject();
  const port = await unusedPort();
  const { child, diagnostics } = await bootDesignServer(vault, port, ["--headless"], { LIMINA_DESIGN_TOKEN: TOKEN });
  try {
    const root = await http(port, "GET", "/");
    assert.equal(root.status, 404, `SPA must not be served headless: ${root.status}`);
    assert.match(root.body, /headless design service/);
    const session = await http(port, "GET", "/api/session");
    assert.equal(session.status, 200, "headless session answers for the studio proxy's boot");
    const parsed = JSON.parse(session.body);
    // The placeholder authenticates NOTHING: direct mutation
    // with it must 403 like any wrong token (the proxy attaches the real one).
    assert.match(parsed.token, /^limina-proxy-attached/);
    const withPlaceholder = await http(port, "POST", "/api/save", { token: parsed.token, body: {} });
    assert.equal(withPlaceholder.status, 403, "the placeholder must not authenticate direct mutations");
    const packs = await http(port, "GET", "/api/packs");
    assert.equal(packs.status, 200, "read endpoints keep working headless");

    // Mutation auth boundary: no token → 403; wrong token → 403; the launcher
    // token is ACCEPTED (a malformed payload then fails past auth, never as 403).
    const noToken = await http(port, "POST", "/api/save", { body: {} });
    assert.equal(noToken.status, 403, `no token must be 403: ${noToken.status}`);
    const wrongToken = await http(port, "POST", "/api/save", { token: "W".repeat(48), body: {} });
    assert.equal(wrongToken.status, 403, `wrong token must be 403: ${wrongToken.status}`);
    const accepted = await http(port, "POST", "/api/save", { token: TOKEN, body: {} });
    assert.notEqual(accepted.status, 403, `the launcher token must pass the auth boundary: ${accepted.status} (${accepted.body.slice(0, 200)})`);
  } catch (error) {
    throw new Error(`${error.message}\nserver diagnostics: ${diagnostics()}`);
  } finally {
    child.kill("SIGKILL");
    rmSync(project, { recursive: true, force: true });
  }
});

test("standalone mode serves no UI (SPA retired) but still issues a session token", { timeout: 20_000 }, async () => {
  const { project, vault } = makeProject();
  const port = await unusedPort();
  const { child } = await bootDesignServer(vault, port, [], {});
  try {
    // The standalone SPA is gone with tools/design/frontend/: every non-API GET
    // gets the headless answer regardless of launch mode.
    const root = await http(port, "GET", "/");
    assert.equal(root.status, 404, `standalone must not serve a UI: ${root.status}`);
    assert.match(root.body, /headless design service/);
    const session = await http(port, "GET", "/api/session");
    assert.equal(session.status, 200, "standalone must issue a session token");
    const parsed = JSON.parse(session.body);
    assert.match(parsed.token, /^[0-9a-f]{64}$/, "standalone token is the per-boot random hex");
  } finally {
    child.kill("SIGKILL");
    rmSync(project, { recursive: true, force: true });
  }
});
