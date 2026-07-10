#!/usr/bin/env node
// ---------------------------------------------------------------------------
//  scripts/editor.mjs - boot the limina coordinator surface.
//
//  Starts the gate-enabled editor_host, serves the editor UI with the COOP/COEP
//  headers required by the live runtime, and prints the bridge config your
//  coding agent uses to coordinate builders into the running world.
// ---------------------------------------------------------------------------

import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { connect } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = resolve(__dirname, "..");
const DEFAULT_EDITOR_PORT = 8787;
const DEFAULT_UI_PORT = 5173;
const DEFAULT_ATLAS_PORT = 4321;
const DERIVED_RUNTIME_DISCOVERY_SCHEMA = "limina.derived-runtime-discovery/v1";
const DERIVED_RUNTIME_DISCOVERY_PREFIX = "[derived-runtime] ready ";
const MAX_DERIVED_RUNTIME_DISCOVERY_BYTES = 1_024;
const DEFAULT_DERIVED_RUNTIME_BRANCH = "main";
const MAX_EDITOR_HOST_READINESS_BYTES = 64 * 1024;
const EDITOR_HOST_READINESS_TIMEOUT_MS = 90_000;
let cleanupChildren = () => {};

/** Print an actionable error and exit non-zero. */
function fail(msg) {
  console.error(`\n  limina editor: ${msg}\n`);
  process.exit(1);
}

/** Resolve the limina binary + source home, matching scripts/export.mjs. */
function resolveLimina() {
  const env = process.env;
  let bin = env.LIMINA_BIN ? resolve(env.LIMINA_BIN) : "";
  let home = env.LIMINA_HOME ? resolve(env.LIMINA_HOME) : "";

  const looksLikeHome = (dir) => dir && existsSync(join(dir, "js", "src", "engine.ts"));
  if (bin && !home) {
    const guess = resolve(dirname(bin), "..", "..");
    if (looksLikeHome(guess)) home = guess;
  }
  if (home && !bin) {
    const guess = join(home, "target", "release", "limina");
    if (existsSync(guess)) bin = guess;
  }
  if (!bin || !home) {
    const candidates = [
      env.LIMINA_HOME && resolve(env.LIMINA_HOME),
      resolve(PROJECT_DIR, "..", "limina"),
      resolve(PROJECT_DIR, "limina"),
      process.cwd() && resolve(process.cwd(), "limina"),
    ].filter(Boolean);
    for (const dir of candidates) {
      if (!looksLikeHome(dir)) continue;
      home = home || dir;
      const guessBin = join(dir, "target", "release", "limina");
      if (!bin && existsSync(guessBin)) bin = guessBin;
      if (bin && home) break;
    }
  }

  if (!bin) {
    fail(
      "could not find the native `limina` binary.\n" +
      "  Set LIMINA_BIN to its path, e.g.:\n" +
      "      LIMINA_BIN=/path/to/limina/target/release/limina npm run editor\n" +
      "  Or clone + build limina (cargo build --release) and set LIMINA_HOME to the checkout.",
    );
  }
  if (!existsSync(bin)) fail(`LIMINA_BIN does not exist: ${bin}`);
  if (!home || !looksLikeHome(home)) {
    fail(
      "found the binary but not the limina source tree (js/src/engine.ts).\n" +
      `  Set LIMINA_HOME to the limina checkout. Tried: ${home || "(none)"}`,
    );
  }
  return { bin, home };
}

export async function loadEditorProjectConfig(home, projectRoot = PROJECT_DIR) {
  const modulePath = join(home, "tools", "project-config.mjs");
  if (!existsSync(modulePath)) {
    throw new Error(`selected LIMINA_HOME has no canonical project loader: ${modulePath}`);
  }
  const { loadProjectConfig } = await import(pathToFileURL(modulePath).href);
  return loadProjectConfig(projectRoot);
}

function parsePort(value, fallback, name) {
  const port = Number(value ?? fallback);
  if (!Number.isInteger(port) || port < 1 || port > 65535) fail(`${name} must be a TCP port, got: ${value}`);
  return port;
}

export function derivedRuntimeLaunchConfig({ uiPort, environment = process.env, randomBytesFn = randomBytes }) {
  if (!Number.isInteger(uiPort) || uiPort < 1 || uiPort > 65_535) throw new Error("editor UI port must be a TCP port");
  const configuredPort = environment.LIMINA_DERIVED_RUNTIME_PORT;
  let port;
  if (configuredPort === undefined) {
    if (uiPort === 65_535) throw new Error("LIMINA_DERIVED_RUNTIME_PORT is required when the editor UI uses port 65535");
    port = uiPort + 1;
  } else {
    if (!/^[1-9][0-9]{0,4}$/.test(configuredPort)) {
      throw new Error(`LIMINA_DERIVED_RUNTIME_PORT must be a canonical TCP port, got: ${configuredPort}`);
    }
    port = Number(configuredPort);
    if (port > 65_535 || String(port) !== configuredPort) {
      throw new Error(`LIMINA_DERIVED_RUNTIME_PORT must be a canonical TCP port, got: ${configuredPort}`);
    }
  }
  const bytes = randomBytesFn(32);
  if (!(bytes instanceof Uint8Array) || bytes.byteLength !== 32) {
    throw new Error("derived runtime token generator must return exactly 32 bytes");
  }
  return Object.freeze({
    port,
    token: Buffer.from(bytes).toString("base64url"),
    origin: `http://localhost:${uiPort}`,
  });
}

export function atlasLaunchConfig({ environment = process.env } = {}) {
  const configuredPort = environment.LIMINA_ATLAS_PORT;
  if (configuredPort !== undefined && (!/^[1-9][0-9]{0,4}$/.test(configuredPort)
      || Number(configuredPort) > 65_535 || String(Number(configuredPort)) !== configuredPort)) {
    throw new Error(`LIMINA_ATLAS_PORT must be a canonical TCP port, got: ${configuredPort}`);
  }
  const port = configuredPort === undefined ? DEFAULT_ATLAS_PORT : Number(configuredPort);
  return Object.freeze({ port, origin: `http://127.0.0.1:${port}` });
}

export function parseDerivedRuntimeDiscoveryLine(line, expectedPort) {
  if (typeof line !== "string" || Buffer.byteLength(line, "utf8") > MAX_DERIVED_RUNTIME_DISCOVERY_BYTES
      || !line.startsWith(DERIVED_RUNTIME_DISCOVERY_PREFIX)) {
    throw new Error("derived runtime discovery line is invalid or too large");
  }
  let value;
  try { value = JSON.parse(line.slice(DERIVED_RUNTIME_DISCOVERY_PREFIX.length)); }
  catch (error) { throw new Error(`derived runtime discovery is not valid JSON: ${error.message}`); }
  if (value === null || Array.isArray(value) || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype
      || Object.keys(value).sort().join() !== "baseUrl,schema"
      || value.schema !== DERIVED_RUNTIME_DISCOVERY_SCHEMA || typeof value.baseUrl !== "string") {
    throw new Error("derived runtime discovery has unsupported or missing fields");
  }
  let baseUrl;
  try { baseUrl = new URL(value.baseUrl); }
  catch (error) { throw new Error(`derived runtime discovery base URL is invalid: ${error.message}`); }
  if (!Number.isInteger(expectedPort) || expectedPort < 1 || expectedPort > 65_535
      || baseUrl.protocol !== "http:" || baseUrl.hostname !== "127.0.0.1"
      || Number(baseUrl.port) !== expectedPort || baseUrl.origin !== value.baseUrl
      || baseUrl.pathname !== "/" || baseUrl.search !== "" || baseUrl.hash !== ""
      || baseUrl.username !== "" || baseUrl.password !== "") {
    throw new Error("derived runtime discovery does not match the requested loopback endpoint");
  }
  return Object.freeze({ schema: value.schema, baseUrl: value.baseUrl });
}

function prefixStream(stream, prefix) {
  let pending = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk) => {
    pending += chunk;
    const lines = pending.split(/\r?\n/);
    pending = lines.pop() ?? "";
    for (const line of lines) {
      if (line) console.error(`${prefix} ${line}`);
    }
  });
  stream.on("end", () => {
    if (pending) console.error(`${prefix} ${pending}`);
  });
}

function canConnect(port) {
  return new Promise((resolveConnect) => {
    const socket = connect({ host: "127.0.0.1", port });
    socket.setTimeout(250);
    socket.once("connect", () => {
      socket.destroy();
      resolveConnect(true);
    });
    socket.once("timeout", () => {
      socket.destroy();
      resolveConnect(false);
    });
    socket.once("error", () => resolveConnect(false));
  });
}

async function waitForPort(port, label, child) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`${label} exited before it started.`);
    if (await canConnect(port)) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error(`${label} did not start listening on port ${port}.`);
}

export function waitForEditorHostReady(child, stream, expectedPort) {
  const marker = `editor_host: gate-enabled authoritative MCP-ws server listening on ws://localhost:${expectedPort}/`;
  return new Promise((resolveReady, rejectReady) => {
    let pending = "";
    let settled = false;
    const timer = setTimeout(() => finish(new Error("editor_host did not report readiness within 90 seconds.")), EDITOR_HOST_READINESS_TIMEOUT_MS);
    const onData = (chunk) => {
      pending += String(chunk);
      if (Buffer.byteLength(pending, "utf8") > MAX_EDITOR_HOST_READINESS_BYTES) {
        finish(new Error("editor_host emitted an overlong readiness stream."));
        return;
      }
      const lines = pending.split(/\r?\n/);
      pending = lines.pop() ?? "";
      if (lines.some((line) => line.includes(marker))) finish();
    };
    const onExit = (code, signal) => finish(new Error(`editor_host exited before readiness (${signal ?? `exit ${code}`}).`));
    const onError = (error) => finish(new Error(`editor_host failed before readiness: ${error.message}`));
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      stream.off("data", onData);
      child.off("exit", onExit);
      child.off("error", onError);
      if (error) rejectReady(error);
      else resolveReady();
    };
    stream.on("data", onData);
    child.once("exit", onExit);
    child.once("error", onError);
  });
}

function bridgeConfig(home, editorUrl, token) {
  return {
    mcpServers: {
      limina: {
        command: "node",
        args: [join(home, "tools", "bridge", "limina-bridge.mjs")],
        env: {
          LIMINA_EDITOR_URL: editorUrl,
          LIMINA_EDITOR_TOKEN: token,
        },
      },
    },
  };
}

function printBanner({ home, uiPort, editorPort, atlasPort, token, runtimeDiscovery }) {
  const editorUrl = `ws://localhost:${editorPort}/`;
  console.log("");
  console.log("limina editor is running");
  console.log("");
  console.log(`  Browser:     http://localhost:${uiPort}/?server=${encodeURIComponent(editorUrl)}`);
  console.log(`  Editor host: ${editorUrl}`);
  console.log(`  Atlas dock:  http://localhost:${uiPort}/atlas/`);
  console.log(`  Atlas solo:  http://127.0.0.1:${atlasPort}/`);
  console.log(`  Derived API: ${runtimeDiscovery.baseUrl}`);
  console.log("  Builds:      authoritative MapDoc -> derived terrain sidecar");
  console.log(`  Editor key:  ${token}`);
  console.log("");
  console.log("Register this MCP server with your coding agent:");
  console.log(JSON.stringify(bridgeConfig(home, editorUrl, token), null, 2));
  console.log("");
  console.log("Then follow COORDINATOR.md.");
  console.log("");
  console.log("Press Ctrl-C to stop.");
}

export function editorHostEnvironment({
  projectId,
  editorPort,
  uiPort,
  token,
  derivedRuntime,
  projectRoot = PROJECT_DIR,
  assetRoot = join(projectRoot, "assets"),
  environment = process.env,
}) {
  if (derivedRuntime === null || typeof derivedRuntime !== "object" || Array.isArray(derivedRuntime)
      || Object.getPrototypeOf(derivedRuntime) !== Object.prototype
      || Object.keys(derivedRuntime).sort().join() !== "baseUrl,branchId,token") {
    throw new Error("editor host derived runtime config must contain exactly baseUrl, token, and branchId");
  }
  return {
    ...environment,
    LIMINA_EDITOR_PORT: String(editorPort),
    LIMINA_EDITOR_STATIC_PORT: String(uiPort),
    LIMINA_EDITOR_TOKEN: token,
    LIMINA_PROJECT_ID: projectId,
    LIMINA_ASSET_ROOT: assetRoot,
    LIMINA_EDITOR_WORLDLOG: `${projectId}.editor.worldlog.jsonl`,
    LIMINA_EDITOR_TRACE: `${projectId}.editor.trace.jsonl`,
    LIMINA_EDITOR_CHAT: `${projectId}.editor.chat.jsonl`,
    LIMINA_EDITOR_KERNEL_LOCK: `${projectId}.editor.kernel.lock.json`,
    LIMINA_DERIVED_RUNTIME_BASE_URL: derivedRuntime.baseUrl,
    LIMINA_DERIVED_RUNTIME_TOKEN: derivedRuntime.token,
    LIMINA_DERIVED_RUNTIME_BRANCH_ID: derivedRuntime.branchId,
  };
}

function newestSourceMtime(root, fsApi) {
  let newest = 0;
  const visit = (dir) => {
    for (const entry of fsApi.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (/\.(?:ts|mjs|js)$/.test(entry.name)) newest = Math.max(newest, fsApi.statSync(path).mtimeMs);
    }
  };
  visit(root);
  return newest;
}

/** Ensure ignored editor bundles exist and are newer than browser-reachable source. */
export function ensureFreshEditorBundles(home, dependencies = {}) {
  const fsApi = {
    existsSync: dependencies.existsSync ?? existsSync,
    readdirSync: dependencies.readdirSync ?? readdirSync,
    statSync: dependencies.statSync ?? statSync,
  };
  const run = dependencies.spawnSync ?? spawnSync;
  const sourceRoot = join(home, "js", "src");
  const packageJson = join(home, "js", "package.json");
  const bundles = [
    join(home, "editor", "vendor", "limina-runtime.js"),
    join(home, "editor", "vendor", "sim-worker-entry.js"),
    join(home, "editor", "vendor", "derived-runtime-worker-entry.js"),
  ];
  if (!fsApi.existsSync(sourceRoot) || !fsApi.existsSync(packageJson)) {
    throw new Error(
      `cannot build editor runtime: Limina source/build metadata is missing under ${join(home, "js")}. ` +
      "Install a complete Limina release or set LIMINA_HOME to a source checkout.",
    );
  }
  const sourceMtime = newestSourceMtime(sourceRoot, fsApi);
  const stale = bundles.some((bundle) => !fsApi.existsSync(bundle) || fsApi.statSync(bundle).mtimeMs < sourceMtime);
  if (!stale) return { rebuilt: false, bundles };

  const result = run("npm", ["--prefix", join(home, "js"), "run", "bundle:editor"], { encoding: "utf8" });
  if (result.error || result.status !== 0) {
    const detail = String(result.error?.message ?? result.stderr ?? result.stdout ?? "unknown build failure").trim();
    throw new Error(
      `failed to build editor runtime with 'npm --prefix ${join(home, "js")} run bundle:editor': ${detail}. ` +
      "Install the Limina JavaScript dependencies and retry.",
    );
  }
  const missing = bundles.filter((bundle) => !fsApi.existsSync(bundle));
  if (missing.length > 0) {
    throw new Error(`editor bundle build reported success but did not create: ${missing.join(", ")}`);
  }
  return { rebuilt: true, bundles };
}

/** Ensure the Node-target compiler bundle consumed by the derived-build sidecar is current. */
export function ensureFreshWorldCompilerBundle(home, dependencies = {}) {
  const fsApi = {
    existsSync: dependencies.existsSync ?? existsSync,
    readdirSync: dependencies.readdirSync ?? readdirSync,
    statSync: dependencies.statSync ?? statSync,
  };
  const run = dependencies.spawnSync ?? spawnSync;
  const sourceRoot = join(home, "js", "src");
  const packageJson = join(home, "js", "package.json");
  const bundle = join(home, "js", "build", "world-compiler.bundle.mjs");
  if (!fsApi.existsSync(sourceRoot) || !fsApi.existsSync(packageJson)) {
    throw new Error(
      `cannot build world compiler: Limina source/build metadata is missing under ${join(home, "js")}. ` +
      "Install a complete Limina release or set LIMINA_HOME to a source checkout.",
    );
  }
  const sourceMtime = newestSourceMtime(sourceRoot, fsApi);
  if (fsApi.existsSync(bundle) && fsApi.statSync(bundle).mtimeMs >= sourceMtime) return { rebuilt: false, bundle };
  const result = run("npm", ["--prefix", join(home, "js"), "run", "bundle:world-compiler"], { encoding: "utf8" });
  if (result.error || result.status !== 0) {
    const detail = String(result.error?.message ?? result.stderr ?? result.stdout ?? "unknown build failure").trim();
    throw new Error(
      `failed to build world compiler with 'npm --prefix ${join(home, "js")} run bundle:world-compiler': ${detail}. ` +
      "Install the Limina JavaScript dependencies and retry.",
    );
  }
  if (!fsApi.existsSync(bundle)) throw new Error(`world compiler build reported success but did not create: ${bundle}`);
  return { rebuilt: true, bundle };
}

function waitForDerivedRuntimeDiscovery(child, stream, expectedPort) {
  return new Promise((resolveReady, rejectReady) => {
    let pending = "";
    let settled = false;
    const timer = setTimeout(() => finish(new Error("derived build service did not report runtime discovery within 15 seconds.")), 15_000);
    const onData = (chunk) => {
      pending += String(chunk);
      if (Buffer.byteLength(pending, "utf8") > 64 * 1024) {
        finish(new Error("derived build service emitted an overlong readiness stream."));
        return;
      }
      const lines = pending.split(/\r?\n/);
      pending = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.startsWith(DERIVED_RUNTIME_DISCOVERY_PREFIX)) continue;
        try { finish(undefined, parseDerivedRuntimeDiscoveryLine(line, expectedPort)); }
        catch (error) { finish(error); }
        return;
      }
    };
    const onExit = (code, signal) => finish(new Error(`derived build service exited before runtime discovery (${signal ?? `exit ${code}`}).`));
    const onError = (error) => finish(new Error(`derived build service failed before runtime discovery: ${error.message}`));
    const finish = (error, discovery) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      stream.off("data", onData);
      child.off("exit", onExit);
      child.off("error", onError);
      if (error) rejectReady(error);
      else resolveReady(discovery);
    };
    stream.on("data", onData);
    child.once("exit", onExit);
    child.once("error", onError);
  });
}

async function main() {
  const { bin, home } = resolveLimina();
  const projectConfig = await loadEditorProjectConfig(home);
  const id = projectConfig.projectId;
  const assetRoot = join(projectConfig.projectRoot, projectConfig.assetRoot ?? "assets");
  const stateDir = join(projectConfig.projectRoot, projectConfig.stateDir ?? ".limina");
  mkdirSync(stateDir, { recursive: true });
  try { ensureFreshEditorBundles(home); } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
  let worldCompiler;
  try { worldCompiler = ensureFreshWorldCompilerBundle(home); } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }

  const editorPort = parsePort(process.env.LIMINA_EDITOR_PORT, DEFAULT_EDITOR_PORT, "LIMINA_EDITOR_PORT");
  const uiPort = parsePort(process.env.LIMINA_EDITOR_UI_PORT ?? process.env.PORT, DEFAULT_UI_PORT, "LIMINA_EDITOR_UI_PORT");
  let runtimeLaunch;
  try { runtimeLaunch = derivedRuntimeLaunchConfig({ uiPort }); }
  catch (error) { fail(error instanceof Error ? error.message : String(error)); }
  let atlasLaunch;
  try { atlasLaunch = atlasLaunchConfig(); }
  catch (error) { fail(error instanceof Error ? error.message : String(error)); }
  if (runtimeLaunch.port === editorPort || runtimeLaunch.port === uiPort) {
    fail("LIMINA_DERIVED_RUNTIME_PORT must differ from the editor host and UI ports");
  }
  if (atlasLaunch.port === editorPort || atlasLaunch.port === uiPort || atlasLaunch.port === runtimeLaunch.port) {
    fail("LIMINA_ATLAS_PORT must differ from the editor host, UI, and derived runtime ports");
  }
  if (await canConnect(editorPort)) fail(`LIMINA_EDITOR_PORT is already in use: ${editorPort}`);
  if (await canConnect(uiPort)) fail(`editor UI port is already in use: ${uiPort}`);
  if (await canConnect(runtimeLaunch.port)) fail(`derived runtime port is already in use: ${runtimeLaunch.port}`);
  if (await canConnect(atlasLaunch.port)) fail(`LIMINA_ATLAS_PORT is already in use: ${atlasLaunch.port}`);

  const requestedToken = process.env.LIMINA_EDITOR_TOKEN;
  if (requestedToken !== undefined && !/^[A-Za-z0-9_-]{32,128}$/.test(requestedToken)) {
    fail("LIMINA_EDITOR_TOKEN must be 32-128 URL-safe characters");
  }
  const token = requestedToken ?? randomBytes(24).toString("base64url");
  const hostEnvironment = editorHostEnvironment({
    projectId: id,
    editorPort,
    uiPort,
    token,
    assetRoot,
    derivedRuntime: {
      baseUrl: `http://127.0.0.1:${runtimeLaunch.port}`,
      token: runtimeLaunch.token,
      branchId: DEFAULT_DERIVED_RUNTIME_BRANCH,
    },
  });
  const editorHost = spawn(bin, [join(home, "editor", "server", "editor_host.ts")], {
    cwd: stateDir,
    env: hostEnvironment,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const editorHostReady = waitForEditorHostReady(editorHost, editorHost.stdout, editorPort);
  prefixStream(editorHost.stderr, "[editor_host]");

  let staticServer;
  let derivedBuildService;
  let atlasServer;
  let shuttingDown = false;
  cleanupChildren = () => {
    if (staticServer && staticServer.exitCode === null) staticServer.kill("SIGTERM");
    if (derivedBuildService && derivedBuildService.exitCode === null) derivedBuildService.kill("SIGTERM");
    if (atlasServer && atlasServer.exitCode === null) atlasServer.kill("SIGTERM");
    if (editorHost.exitCode === null) editorHost.kill("SIGTERM");
  };
  const shutdown = (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    if (signal) console.error(`\nlimina editor: received ${signal}, shutting down.`);
    cleanupChildren();
  };

  process.once("SIGINT", () => shutdown("SIGINT"));
  process.once("SIGTERM", () => shutdown("SIGTERM"));

  editorHost.once("error", (err) => {
    if (!shuttingDown) {
      shutdown();
      fail(`failed to launch editor_host: ${err.message}`);
    }
  });
  editorHost.once("exit", (code, signal) => {
    if (!shuttingDown) {
      shutdown();
      fail(`editor_host stopped unexpectedly (${signal ?? `exit ${code}`}).`);
    }
  });

  await editorHostReady;
  // Readiness is the only stdout record the launcher consumes. Drain subsequent output privately so
  // a verbose host can never fill the child pipe and deadlock while token-bearing banners stay hidden.
  editorHost.stdout.resume();

  derivedBuildService = spawn(process.execPath, [join(home, "tools", "design", "derived-build-service.mjs"), PROJECT_DIR], {
    cwd: PROJECT_DIR,
    env: {
      ...hostEnvironment,
      LIMINA_EDITOR_URL: `ws://127.0.0.1:${editorPort}/`,
      LIMINA_WORLD_COMPILER_BUNDLE: worldCompiler.bundle,
      LIMINA_DERIVED_RUNTIME_PORT: String(runtimeLaunch.port),
      LIMINA_DERIVED_RUNTIME_TOKEN: runtimeLaunch.token,
      LIMINA_DERIVED_RUNTIME_ORIGIN: runtimeLaunch.origin,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const runtimeDiscoveryPromise = waitForDerivedRuntimeDiscovery(
    derivedBuildService,
    derivedBuildService.stdout,
    runtimeLaunch.port,
  );
  prefixStream(derivedBuildService.stdout, "[derived_build]");
  prefixStream(derivedBuildService.stderr, "[derived_build]");
  derivedBuildService.once("error", (err) => {
    if (!shuttingDown) {
      shutdown();
      fail(`failed to launch derived build service: ${err.message}`);
    }
  });
  derivedBuildService.once("exit", (code, signal) => {
    if (!shuttingDown) {
      shutdown();
      fail(`derived build service stopped unexpectedly (${signal ?? `exit ${code}`}).`);
    }
  });
  const runtimeDiscovery = await runtimeDiscoveryPromise;

  atlasServer = spawn(process.execPath, [
    join(home, "tools", "design", "serve-design.mjs"),
    join(projectConfig.projectRoot, "design"),
    String(atlasLaunch.port),
  ], {
    cwd: projectConfig.projectRoot,
    env: {
      ...process.env,
      LIMINA_EDITOR_URL: `ws://127.0.0.1:${editorPort}/`,
      LIMINA_EDITOR_TOKEN: token,
      LIMINA_EDITOR_HANDOFF_URL: `http://localhost:${uiPort}/atlas-handoff.html`,
      LIMINA_ATLAS_PUBLIC_ORIGIN: atlasLaunch.origin,
      LIMINA_ASSETS_ROOT: assetRoot,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  prefixStream(atlasServer.stdout, "[atlas]");
  prefixStream(atlasServer.stderr, "[atlas]");
  atlasServer.once("error", (err) => {
    if (!shuttingDown) {
      shutdown();
      fail(`failed to launch Atlas: ${err.message}`);
    }
  });
  atlasServer.once("exit", (code, signal) => {
    if (!shuttingDown) {
      shutdown();
      fail(`Atlas stopped unexpectedly (${signal ?? `exit ${code}`}).`);
    }
  });
  await waitForPort(atlasLaunch.port, "Atlas", atlasServer);

  staticServer = spawn(process.execPath, [join(PROJECT_DIR, "scripts", "serve.mjs"), join(home, "editor"), String(uiPort)], {
    cwd: PROJECT_DIR,
    env: {
      ...process.env,
      LIMINA_ASSETS_ROOT: assetRoot,
      LIMINA_ATLAS_ORIGIN: atlasLaunch.origin,
      LIMINA_EDITOR_PUBLIC_URL: `http://localhost:${uiPort}/`,
      LIMINA_EDITOR_SERVER_URL: `ws://localhost:${editorPort}/`,
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  prefixStream(staticServer.stderr, "[editor_ui]");
  staticServer.once("error", (err) => {
    if (!shuttingDown) {
      shutdown();
      fail(`failed to launch editor UI server: ${err.message}`);
    }
  });
  staticServer.once("exit", (code, signal) => {
    if (!shuttingDown) {
      shutdown();
      fail(`editor UI server stopped unexpectedly (${signal ?? `exit ${code}`}).`);
    }
  });

  await waitForPort(uiPort, "editor UI server", staticServer);
  printBanner({
    home,
    uiPort,
    editorPort,
    atlasPort: atlasLaunch.port,
    token,
    runtimeDiscovery,
  });
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (import.meta.url === invokedPath) {
  main().catch((err) => {
    cleanupChildren();
    fail(err instanceof Error ? err.message : String(err));
  });
}
