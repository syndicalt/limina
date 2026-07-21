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

function get(port, path, host, timeoutMs = 1_000) {
  return new Promise((resolveResponse, reject) => {
    const req = request({ hostname: "127.0.0.1", port, path, method: "GET", headers: { Host: host } }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolveResponse({ status: res.statusCode, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error("request timeout")));
    req.once("error", reject);
    req.end();
  });
}

test("design server rejects a rebound Host before session and static routes", { timeout: 15_000 }, async () => {
  const project = mkdtempSync(join(tmpdir(), "limina-design-host-"));
  const vault = join(project, "design");
  mkdirSync(vault);
  mkdirSync(join(project, "assets"));
  writeFileSync(join(project, "limina.project.json"), JSON.stringify({
    schema: "limina-project/1",
    projectId: "design-host-test",
    assetRoot: "assets",
  }));
  writeFileSync(join(vault, "note.md"), "first revision\n");
  const port = await unusedPort();
  const child = spawn(process.execPath, [join(ROOT, "tools/design/serve-design.mjs"), vault, String(port)], {
    cwd: ROOT,
    stdio: ["ignore", "ignore", "pipe"],
  });
  let diagnostics = "";
  child.stderr.on("data", (chunk) => { diagnostics = (diagnostics + chunk).slice(-8_192); });
  try {
    let session;
    for (let attempt = 0; attempt < 50; attempt += 1) {
      if (child.exitCode !== null) throw new Error(`design server exited ${child.exitCode}: ${diagnostics}`);
      try { session = await get(port, "/api/session", `127.0.0.1:${port}`); break; }
      catch { await new Promise((resolveWait) => setTimeout(resolveWait, 100)); }
    }
    assert.equal(session?.status, 200, diagnostics);
    assert.match(session.body, /"token":"[0-9a-f]{64}"/);

    const reboundSession = await get(port, "/api/session", "attacker.example");
    assert.equal(reboundSession.status, 403);
    assert.doesNotMatch(reboundSession.body, /[0-9a-f]{64}/);
    const reboundStatic = await get(port, "/", `attacker.example:${port}`);
    assert.equal(reboundStatic.status, 403);
    assert.equal((await get(port, "/api/session", `localhost:${port}`)).status, 200);

    const firstState = await get(port, "/api/state", `127.0.0.1:${port}`, 10_000);
    assert.equal(firstState.status, 200, firstState.body);
    assert.equal(JSON.parse(firstState.body).docs[0].content, "first revision\n");
    writeFileSync(join(vault, "note.md"), "second revision with a different size\n");
    const secondState = await get(port, "/api/state", `127.0.0.1:${port}`, 10_000);
    assert.equal(secondState.status, 200, secondState.body);
    assert.equal(JSON.parse(secondState.body).docs[0].content, "second revision with a different size\n");
  } finally {
    child.kill("SIGTERM");
    await new Promise((resolveExit) => {
      if (child.exitCode !== null) resolveExit();
      else child.once("exit", resolveExit);
    });
    rmSync(project, { recursive: true, force: true });
  }
});
