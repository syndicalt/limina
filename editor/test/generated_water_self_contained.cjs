const { randomBytes } = require("node:crypto");
const { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync } = require("node:fs");
const { createServer } = require("node:net");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");
const { spawn, spawnSync } = require("node:child_process");

const ROOT = resolve(__dirname, "../..");
const FIXTURE = join(__dirname, "fixtures", "wb-w1-generated-water");
const START_TIMEOUT_MS = 180_000;

function freePort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close((error) => error ? reject(error) : resolvePort(port));
    });
  });
}

async function distinctPorts(count) {
  const ports = new Set();
  while (ports.size < count) ports.add(await freePort());
  return [...ports];
}

function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return Promise.race([
    new Promise((resolveExit) => child.once("exit", () => resolveExit(true))),
    new Promise((resolveTimeout) => setTimeout(() => resolveTimeout(false), timeoutMs)),
  ]);
}

function processGroupAlive(pid) {
  try { process.kill(-pid, 0); return true; }
  catch { return false; }
}

async function waitForProcessGroup(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!processGroupAlive(pid)) return true;
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  return !processGroupAlive(pid);
}

async function stopLauncher(launcher) {
  if (!launcher?.child) return;
  const child = launcher.child;
  const pid = child.pid;
  try { process.kill(-pid, "SIGINT"); } catch { if (child.exitCode === null) child.kill("SIGINT"); }
  await Promise.all([waitForExit(child, 10_000), waitForProcessGroup(pid, 10_000)]);
  if (processGroupAlive(pid)) {
    try { process.kill(-pid, "SIGTERM"); } catch { /* group exited between checks */ }
    await waitForProcessGroup(pid, 2_000);
  }
  if (processGroupAlive(pid)) {
    try { process.kill(-pid, "SIGKILL"); } catch { /* group exited between checks */ }
    await waitForProcessGroup(pid, 5_000);
  }
  if (processGroupAlive(pid)) throw new Error(`generated-water launcher process group ${pid} did not terminate`);
}

function startLauncher(projectRoot, ports) {
  const [editorPort, uiPort, derivedPort, atlasPort] = ports;
  const child = spawn("npm", ["run", "editor"], {
    cwd: projectRoot,
    detached: true,
    env: {
      ...process.env,
      LIMINA_HOME: ROOT,
      LIMINA_BIN: join(ROOT, "target", "release", "limina"),
      LIMINA_AUDIO: "null",
      LIMINA_EDITOR_PORT: String(editorPort),
      LIMINA_EDITOR_UI_PORT: String(uiPort),
      LIMINA_DERIVED_RUNTIME_PORT: String(derivedPort),
      LIMINA_ATLAS_PORT: String(atlasPort),
      LIMINA_EDITOR_TOKEN: randomBytes(24).toString("base64url"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  let settled = false;
  const append = (chunk) => { output = (output + String(chunk)).slice(-512 * 1024); check(); };
  child.stdout.on("data", append);
  child.stderr.on("data", append);

  let resolveReady;
  let rejectReady;
  const ready = new Promise((resolvePromise, rejectPromise) => {
    resolveReady = resolvePromise;
    rejectReady = rejectPromise;
  });
  const timer = setTimeout(() => finish(new Error(`generated-water launcher timed out:\n${output.slice(-12_000)}`)), START_TIMEOUT_MS);
  const finish = (error, value) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    child.off("exit", exited);
    child.off("error", failed);
    if (error) rejectReady(error);
    else resolveReady(value);
  };
  const exited = (code, signal) => finish(new Error(`generated-water launcher exited before readiness (${signal ?? `exit ${code}`}):\n${output.slice(-12_000)}`));
  const failed = (error) => finish(new Error(`generated-water launcher failed: ${error.message}`));
  child.once("exit", exited);
  child.once("error", failed);

  function check() {
    const browser = output.match(/Browser:\s+(http:\/\/localhost:[1-9][0-9]{0,4}\/\?server=\S+)/)?.[1];
    const host = output.match(/Editor host:\s+(ws:\/\/localhost:[1-9][0-9]{0,4}\/)/)?.[1];
    const atlas = output.match(/Atlas solo:\s+(http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}\/)/)?.[1];
    const derived = output.match(/Derived API:\s+(http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4})/)?.[1];
    const token = output.match(/Editor key:\s+([A-Za-z0-9_-]{32,128})/)?.[1];
    if (browser && host && atlas && derived && token) {
      finish(undefined, Object.freeze({
        child,
        host,
        token,
        editorUrl: new URL(browser).origin + "/",
        derivedUrl: derived + "/",
        atlasUrl: atlas,
      }));
    }
  }
  return { child, ready, output: () => output };
}

async function waitForPublication(projectRoot, minimumExclusiveRevision = -1) {
  const pointerPath = join(projectRoot, ".limina", "derived", "main", "published.json");
  const deadline = Date.now() + START_TIMEOUT_MS;
  let diagnostic = "publication pointer is absent";
  while (Date.now() < deadline) {
    try {
      if (!existsSync(pointerPath)) throw new Error("publication pointer is absent");
      const pointer = JSON.parse(readFileSync(pointerPath, "utf8"));
      const hash = pointer?.current?.manifestHash;
      if (typeof hash !== "string" || !/^sha256:[0-9a-f]{64}$/.test(hash)) throw new Error("publication pointer has no canonical current manifest");
      const manifestPath = join(projectRoot, ".limina", "derived", "main", "manifests", `${hash.slice(7)}.json`);
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      const revision = manifest?.source?.revision;
      if (!Number.isSafeInteger(revision) || revision < 0) throw new Error("published manifest has no source revision");
      if (revision > minimumExclusiveRevision) return Object.freeze({ revision, manifestHash: hash });
      diagnostic = `published revision ${revision} has not advanced beyond ${minimumExclusiveRevision}`;
    } catch (error) {
      diagnostic = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error(`generated-water derived publication timed out: ${diagnostic}`);
}

async function compileFixture(atlasUrl) {
  const sessionResponse = await fetch(new URL("api/session", atlasUrl));
  if (!sessionResponse.ok) throw new Error(`Atlas session failed with HTTP ${sessionResponse.status}`);
  const session = await sessionResponse.json();
  if (typeof session.token !== "string") throw new Error("Atlas session omitted its design token");
  const response = await fetch(new URL("api/compile-map", atlasUrl), {
    method: "POST",
    headers: { "content-type": "application/json", "x-limina-design-token": session.token },
    body: JSON.stringify({ mapId: "primary" }),
  });
  const result = await response.json();
  if (!response.ok || typeof result.file !== "string" || !result.file.startsWith("maps/")) {
    throw new Error(`Atlas compile failed with HTTP ${response.status}: ${JSON.stringify(result)}`);
  }
  return result.file;
}

async function bindTerrainSource(chromium, executablePath, launch, mapAssetId) {
  const browser = await chromium.launch({ executablePath, headless: true, args: ["--no-sandbox", "--enable-unsafe-swiftshader"] });
  const page = await browser.newPage();
  try {
    await page.goto(launch.editorUrl, { waitUntil: "domcontentloaded" });
    const result = await page.evaluate(async ({ host, token, mapAssetId: assetId }) => {
      const { McpClient } = await import("./src/mcp-client.js");
      const client = new McpClient(host, token);
      await client.connect();
      await client.initialize("generated_water_uat", "ses_generated_water_uat", "builder.readWrite");
      try { return await client.callTool("world.setTerrainSource", { kind: "map", mapAssetId: assetId }); }
      finally { client.close(); }
    }, { host: launch.host, token: launch.token, mapAssetId });
    if (result?.kind !== "map") throw new Error(`world.setTerrainSource returned an unexpected result: ${JSON.stringify(result)}`);
  } finally {
    await page.close();
    await browser.close();
  }
}

async function provisionGeneratedWaterUat(chromium, executablePath) {
  const temporaryRoot = mkdtempSync(join(tmpdir(), "limina-generated-water-"));
  const projectRoot = join(temporaryRoot, "wb-w1-generated-water");
  let launcher;
  let cleaned = false;
  const cleanup = async () => {
    if (cleaned) return;
    cleaned = true;
    process.off("SIGINT", interrupted);
    process.off("SIGTERM", terminated);
    await stopLauncher(launcher);
    rmSync(temporaryRoot, { recursive: true, force: true });
  };
  const leave = (code) => { void cleanup().finally(() => process.exit(code)); };
  const interrupted = () => leave(130);
  const terminated = () => leave(143);
  process.once("SIGINT", interrupted);
  process.once("SIGTERM", terminated);
  try {
    const scaffold = spawnSync(process.execPath, [join(ROOT, "tools", "create-limina-app", "index.mjs"), projectRoot], {
      cwd: ROOT,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    });
    if (scaffold.status !== 0) throw new Error(`create-limina-app failed: ${scaffold.stderr || scaffold.stdout}`);
    copyFileSync(join(FIXTURE, "maps.json"), join(projectRoot, "design", "maps.json"));
    copyFileSync(join(FIXTURE, "world-bible.md"), join(projectRoot, "design", "world-bible.md"));
    const ports = await distinctPorts(4);

    launcher = startLauncher(projectRoot, ports);
    const first = await launcher.ready;
    await waitForPublication(projectRoot);
    const mapAssetId = await compileFixture(first.atlasUrl);
    await bindTerrainSource(chromium, executablePath, first, mapAssetId);
    await stopLauncher(launcher);
    launcher = startLauncher(projectRoot, ports);
    const second = await launcher.ready;
    // world.setTerrainSource is a durable command, not a MapDoc transaction: restart is required
    // so replay binds the terrain source before this unchanged derived revision activates.
    await waitForPublication(projectRoot);
    return {
      environment: Object.freeze({
        PLAY_UAT_HOST: second.host,
        PLAY_UAT_TOKEN: second.token,
        PLAY_UAT_EDITOR: second.editorUrl,
        PLAY_UAT_DERIVED: second.derivedUrl,
      }),
      cleanup,
    };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

module.exports = { provisionGeneratedWaterUat };
