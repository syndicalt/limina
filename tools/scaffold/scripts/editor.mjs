#!/usr/bin/env node
// ---------------------------------------------------------------------------
//  scripts/editor.mjs - boot the limina coordinator surface.
//
//  Starts the gate-enabled editor_host, serves the editor UI with the COOP/COEP
//  headers required by the live runtime, and prints the bridge config your
//  coding agent uses to coordinate builders into the running world.
// ---------------------------------------------------------------------------

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { connect } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = resolve(__dirname, "..");
const DEFAULT_EDITOR_PORT = 8787;
const DEFAULT_UI_PORT = 5173;
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

function printBanner({ home, uiPort, editorPort, token }) {
  const editorUrl = `ws://localhost:${editorPort}/`;
  console.log("");
  console.log("limina editor is running");
  console.log("");
  console.log(`  Browser:     http://localhost:${uiPort}/?server=${encodeURIComponent(editorUrl)}`);
  console.log(`  Editor host: ${editorUrl}`);
  console.log(`  Token:       ${token}`);
  console.log("");
  console.log("Register this MCP server with your coding agent:");
  console.log(JSON.stringify(bridgeConfig(home, editorUrl, token), null, 2));
  console.log("");
  console.log("Then follow COORDINATOR.md.");
  console.log("");
  console.log("Press Ctrl-C to stop.");
}

export function editorHostEnvironment({ projectId, editorPort, uiPort, token, projectRoot = PROJECT_DIR, environment = process.env }) {
  return {
    ...environment,
    LIMINA_EDITOR_PORT: String(editorPort),
    LIMINA_EDITOR_STATIC_PORT: String(uiPort),
    LIMINA_EDITOR_TOKEN: token,
    LIMINA_PROJECT_ID: projectId,
    LIMINA_ASSET_ROOT: join(projectRoot, "assets"),
    LIMINA_EDITOR_WORLDLOG: `${projectId}.editor.worldlog.jsonl`,
    LIMINA_EDITOR_TRACE: `${projectId}.editor.trace.jsonl`,
    LIMINA_EDITOR_CHAT: `${projectId}.editor.chat.jsonl`,
    LIMINA_EDITOR_KERNEL_LOCK: `${projectId}.editor.kernel.lock.json`,
  };
}

async function main() {
  const { bin, home } = resolveLimina();
  const { projectId: id } = await loadEditorProjectConfig(home);
  const stateDir = join(PROJECT_DIR, ".limina");
  mkdirSync(stateDir, { recursive: true });
  const bundle = join(home, "editor", "vendor", "limina-runtime.js");
  if (!existsSync(bundle)) {
    fail(
      `missing editor runtime bundle: ${bundle}\n` +
      "  Build it first:\n" +
      `      cd ${join(home, "js")} && npm run bundle:editor`,
    );
  }

  const editorPort = parsePort(process.env.LIMINA_EDITOR_PORT, DEFAULT_EDITOR_PORT, "LIMINA_EDITOR_PORT");
  const uiPort = parsePort(process.env.LIMINA_EDITOR_UI_PORT ?? process.env.PORT, DEFAULT_UI_PORT, "LIMINA_EDITOR_UI_PORT");
  if (await canConnect(editorPort)) fail(`LIMINA_EDITOR_PORT is already in use: ${editorPort}`);
  if (await canConnect(uiPort)) fail(`editor UI port is already in use: ${uiPort}`);

  const requestedToken = process.env.LIMINA_EDITOR_TOKEN;
  if (requestedToken !== undefined && !/^[A-Za-z0-9_-]{32,128}$/.test(requestedToken)) {
    fail("LIMINA_EDITOR_TOKEN must be 32-128 URL-safe characters");
  }
  const token = requestedToken ?? randomBytes(24).toString("base64url");
  const editorHost = spawn(bin, [join(home, "editor", "server", "editor_host.ts")], {
    cwd: stateDir,
    env: editorHostEnvironment({ projectId: id, editorPort, uiPort, token }),
    stdio: ["ignore", "ignore", "pipe"],
  });
  prefixStream(editorHost.stderr, "[editor_host]");

  let staticServer;
  let shuttingDown = false;
  cleanupChildren = () => {
    if (staticServer && staticServer.exitCode === null) staticServer.kill("SIGTERM");
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

  await waitForPort(editorPort, "editor_host", editorHost);

  staticServer = spawn(process.execPath, [join(PROJECT_DIR, "scripts", "serve.mjs"), join(home, "editor"), String(uiPort)], {
    cwd: PROJECT_DIR,
    env: { ...process.env, LIMINA_ASSETS_ROOT: join(PROJECT_DIR, "assets") },
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
  printBanner({ home, uiPort, editorPort, token });
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (import.meta.url === invokedPath) {
  main().catch((err) => {
    cleanupChildren();
    fail(err instanceof Error ? err.message : String(err));
  });
}
