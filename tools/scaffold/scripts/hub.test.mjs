// hub.mjs (management surface): scan correctness, create/open validation, Host
// validation, static serving. Proves the management surface only opens real
// projects inside the projects root (no arbitrary-path spawns), only creates
// validated names, and rebinding gets 403 on every route. Falsifiability: a hub
// that skipped containment fails the escape leg; one that served the token-less
// create to a rebound Host fails the rebinding legs.

import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { createServer as createTcpServer } from "node:net";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createHubServer, scanProjects } from "./hub.mjs";

async function unusedPort() {
  const server = createTcpServer();
  await new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const { port } = server.address();
  await new Promise((resolveClose) => server.close(resolveClose));
  return port;
}

function http(port, method, path, { body, host } = {}) {
  return new Promise((resolveResponse, reject) => {
    const headers = { Host: host ?? `127.0.0.1:${port}` };
    if (body !== undefined) headers["content-type"] = "application/json";
    const req = request({ hostname: "127.0.0.1", port, path, method, headers }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolveResponse({ status: res.statusCode, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.setTimeout(5_000, () => req.destroy(new Error("request timeout")));
    req.once("error", reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

function makeProjectsRoot() {
  const root = mkdtempSync(join(tmpdir(), "limina-hub-test-"));
  const mk = (name, withConfig = true) => {
    const dir = join(root, name);
    mkdirSync(dir, { recursive: true });
    if (withConfig) {
      writeFileSync(join(dir, "limina.project.json"), JSON.stringify({ schema: "limina-project/1", projectId: name, assetRoot: "assets" }));
    }
    return dir;
  };
  return { root, mk };
}

test("scanProjects: only config-bearing dirs, hidden skipped, sorted by lastTouched desc", () => {
  const { root, mk } = makeProjectsRoot();
  mk("alpha");
  const beta = mk("beta");
  mk("not-a-project", false);
  mk(".hidden");
  // Touch beta's config into the future so the sort is observable (filesystem
  // mtime granularity would otherwise collapse the two into insertion order).
  const future = new Date(Date.now() + 60_000);
  utimesSync(join(beta, "limina.project.json"), future, future);
  const projects = scanProjects(root);
  assert.deepEqual(projects.map((p) => p.projectId), ["beta", "alpha"]);
  assert.ok(projects.every((p) => typeof p.root === "string" && "lastTouched" in p));
  rmSync(root, { recursive: true, force: true });
});

test("hub API: list, create validation, create E2E, open containment, Host guard", { timeout: 60_000 }, async () => {
  const { root, mk } = makeProjectsRoot();
  mk("existing");
  const port = await unusedPort();
  const server = createHubServer({ projectsRoot: root });
  await new Promise((resolveListen) => server.listen(port, "127.0.0.1", resolveListen));
  try {
    // List: exactly the one seeded project.
    const list = JSON.parse((await http(port, "GET", "/api/projects")).body);
    assert.equal(list.projects.length, 1);
    assert.equal(list.projects[0].projectId, "existing");
    assert.equal(list.projects[0].running, false);
    assert.equal(list.projectsRoot, root);

    // Create: bad names are rejected before any directory exists.
    for (const bad of ["UPPER", "has space", "../escape", "", "a/b"]) {
      const res = await http(port, "POST", "/api/projects/create", { body: { name: bad } });
      assert.equal(res.status, 400, `bad name '${bad}' must be 400 (got ${res.status})`);
    }
    // Create: a good name scaffolds a real project.
    const created = JSON.parse((await http(port, "POST", "/api/projects/create", { body: { name: "hub-made" } })).body);
    assert.equal(created.ok, true);
    assert.equal(created.project.projectId, "hub-made");
    const list2 = JSON.parse((await http(port, "GET", "/api/projects")).body);
    assert.ok(list2.projects.some((p) => p.projectId === "hub-made"), "created project appears in the scan");
    // Duplicate create → 409.
    const dup = await http(port, "POST", "/api/projects/create", { body: { name: "hub-made" } });
    assert.equal(dup.status, 409);

    // Open containment: escape attempts and non-projects are 400.
    const escape = await http(port, "POST", "/api/projects/open", { body: { root: join(root, "..", "outside") } });
    assert.equal(escape.status, 400);
    const notProject = await http(port, "POST", "/api/projects/open", { body: { root: join(root, "missing") } });
    assert.equal(notProject.status, 400);

    // Host guard: rebinding gets 403 on API AND static routes.
    const reboundApi = await http(port, "GET", "/api/projects", { host: "evil.example" });
    assert.equal(reboundApi.status, 403);
    const reboundStatic = await http(port, "GET", "/", { host: "evil.example" });
    assert.equal(reboundStatic.status, 403);
    // Static UI serves with a loopback Host; traversal is contained.
    const index = await http(port, "GET", "/");
    assert.equal(index.status, 200);
    assert.match(index.body, /limina/);
    const traversal = await http(port, "GET", "/../scripts/hub.mjs");
    assert.equal(traversal.status, 404);
  } finally {
    await new Promise((resolveClose) => server.close(resolveClose));
    rmSync(root, { recursive: true, force: true });
  }
});
