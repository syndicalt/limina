#!/usr/bin/env node
// hub.mjs — the limina management surface (Editor 2.0). Boot the app with no
// project and you land HERE: create a new project (create-limina-app) or open an
// existing one. Opening boots the project's full stack (editor.mjs child — the
// canonical supervisor), which loads its world log and artifacts; the hub then
// hands the browser the stack's URL (the studio's capability bootstrap prefills
// the token, so Open is one click end-to-end).
//
// Security shape: loopback bind + exact Host validation (DNS rebinding would
// otherwise make "create/open project" remotely triggerable). Projects are only
// ever opened from within the projects root (no arbitrary-path spawns), and
// create names are validated before any directory is made.

import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { copyFileSync, createReadStream, existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { createServer as createTcpServer } from "node:net";
import { homedir } from "node:os";
import { basename, join, resolve, sep } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { dirname } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const HOME = resolve(__dirname, "..", "..", ".."); // the limina repo
const HUB_UI_DIR = resolve(__dirname, "..", "hub-ui");
const LAUNCHER_SCRIPTS = ["editor.mjs", "serve.mjs", "export.mjs"];
const PROJECT_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const MAX_BODY_BYTES = 16 * 1024;
const STACK_READY_TIMEOUT_MS = 120_000;
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

function isAllowedLoopbackRequestHost(rawHost, localPort) {
  if (typeof rawHost !== "string" || !Number.isInteger(localPort)) return false;
  let parsed;
  try { parsed = new URL(`http://${rawHost}`); }
  catch { return false; }
  return parsed.username === "" && parsed.password === "" && parsed.pathname === "/"
    && parsed.search === "" && parsed.hash === "" && parsed.port === String(localPort)
    && LOOPBACK_HOSTS.has(parsed.hostname);
}

function defaultProjectsRoot() {
  return process.env.LIMINA_PROJECTS_ROOT !== undefined
    ? resolve(process.env.LIMINA_PROJECTS_ROOT)
    : resolve(HOME, "..");
}

function projectConfigFor(dir) {
  const configPath = join(dir, "limina.project.json");
  if (!existsSync(configPath)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(configPath, "utf8"));
    if (parsed?.schema !== "limina-project/1" || typeof parsed.projectId !== "string") return undefined;
    return { projectId: parsed.projectId, assetRoot: parsed.assetRoot ?? "assets" };
  } catch {
    return undefined;
  }
}

function lastTouched(dir) {
  const candidates = [join(dir, "limina.project.json"), join(dir, "design", "maps.json"), join(dir, ".limina")];
  let latest = 0;
  for (const candidate of candidates) {
    try {
      const stat = statSync(candidate);
      if (stat.mtimeMs > latest) latest = stat.mtimeMs;
    } catch { /* absent */ }
  }
  return latest || null;
}

/** Depth-1 scan of the projects root for limina.project.json-bearing dirs. */
export function scanProjects(projectsRoot) {
  const out = [];
  let entries;
  try {
    entries = readdirSync(projectsRoot, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const dir = join(projectsRoot, entry.name);
    const config = projectConfigFor(dir);
    if (config === undefined) continue;
    out.push({ projectId: config.projectId, root: dir, name: entry.name, lastTouched: lastTouched(dir) });
  }
  out.sort((a, b) => (b.lastTouched ?? 0) - (a.lastTouched ?? 0));
  return out;
}

function isInsideRoot(root, candidate) {
  const relative = resolve(candidate).slice(resolve(root).length);
  return relative === "" || relative.startsWith(sep) && !relative.startsWith(sep + ".." + sep) && relative !== sep + "..";
}

async function freePort() {
  const server = createTcpServer();
  await new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const { port } = server.address();
  await new Promise((resolveClose) => server.close(resolveClose));
  return port;
}

function readBody(req) {
  return new Promise((resolveBody, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try { resolveBody(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}")); }
      catch { reject(new Error("request body is not valid JSON")); }
    });
    req.on("error", reject);
  });
}

/** A supervised project stack: one editor.mjs child (the project's own copy,
 *  which carries the correct PROJECT_DIR), ports allocated by the hub, readiness
 *  parsed from its banner, teardown kills the whole process group. */
function startProjectStack({ projectRoot, env, onLog }) {
  return new Promise((resolveStack, reject) => {
    const child = spawn("npm", ["run", "editor"], {
      cwd: projectRoot,
      detached: true,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    let settled = false;
    const timer = setTimeout(() => finish(new Error(`project stack timed out before readiness:\n${output.slice(-8_000)}`)), STACK_READY_TIMEOUT_MS);
    function finish(error, value) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) {
        try { process.kill(-child.pid, "SIGTERM"); } catch { /* already down */ }
        reject(error);
      } else {
        resolveStack(value);
      }
    }
    const check = () => {
      const browser = output.match(/Browser:\s+(http:\/\/localhost:[1-9][0-9]{0,4}\/\?server=\S+)/)?.[1];
      const host = output.match(/Editor host:\s+(ws:\/\/localhost:[1-9][0-9]{0,4}\/)/)?.[1];
      const capability = output.match(/Capability:\s+(\S+\/editor-capability\.json) \(private, mode 0600\)/)?.[1];
      if (browser && host && capability) {
        finish(undefined, Object.freeze({
          child,
          editorUrl: new URL(browser).origin + "/",
          host,
          capabilityPath: capability,
          output: () => output,
        }));
      }
    };
    const append = (chunk) => {
      output = (output + String(chunk)).slice(-512 * 1024);
      if (onLog !== undefined) onLog(String(chunk));
      check();
    };
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    child.once("exit", (code, signal) => finish(new Error(`project stack exited before readiness (${signal ?? `exit ${code}`}):\n${output.slice(-8_000)}`)));
    child.once("error", finish);
  });
}

export function createHubServer({ projectsRoot = defaultProjectsRoot() } = {}) {
  const stacks = new Map(); // projectRoot -> stack record

  // Scaffold copies of the launcher go stale (there is no upgrade path); the
  // hub boots a project only with the repo's current scripts. These files are
  // verbatim template files — no project-specific content.
  function syncLauncherScripts(root) {
    const scriptsDir = join(root, "scripts");
    for (const name of LAUNCHER_SCRIPTS) {
      copyFileSync(join(HOME, "tools", "scaffold", "scripts", name), join(scriptsDir, name));
    }
  }

  function json(res, status, body) {
    res.writeHead(status, {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    });
    res.end(JSON.stringify(body));
  }

  async function openProject(root) {
    const existing = stacks.get(root);
    if (existing !== undefined) return { url: existing.editorUrl, attached: true };
    const [editorPort, uiPort, derivedPort, atlasPort] = await Promise.all([freePort(), freePort(), freePort(), freePort()]);
    syncLauncherScripts(root);
    const stack = await startProjectStack({
      projectRoot: root,
      env: {
        ...process.env,
        LIMINA_HOME: HOME,
        LIMINA_BIN: join(HOME, "target", "release", "limina"),
        LIMINA_AUDIO: "null",
        LIMINA_EDITOR_PORT: String(editorPort),
        LIMINA_EDITOR_UI_PORT: String(uiPort),
        LIMINA_DERIVED_RUNTIME_PORT: String(derivedPort),
        LIMINA_ATLAS_PORT: String(atlasPort),
      },
    });
    stacks.set(root, { ...stack, startedAt: Date.now() });
    stack.child.once("exit", () => stacks.delete(root));
    return { url: stack.editorUrl, attached: false };
  }

  return createServer(async (req, res) => {
    try {
      if (!isAllowedLoopbackRequestHost(req.headers.host, req.socket.localPort)) {
        json(res, 403, { ok: false, error: "request host is not allowed" });
        return;
      }
      const url = (req.url ?? "/").split("?")[0];

      if (req.method === "GET" && url === "/api/projects") {
        const running = new Set(stacks.keys());
        json(res, 200, {
          projectsRoot,
          projects: scanProjects(projectsRoot).map((p) => ({ ...p, running: running.has(p.root) })),
        });
        return;
      }

      if (req.method === "POST" && url === "/api/projects/create") {
        const body = await readBody(req);
        const name = typeof body.name === "string" ? body.name.trim() : "";
        if (!PROJECT_NAME_PATTERN.test(name)) {
          json(res, 400, { ok: false, error: "project names use lowercase letters, digits, '-', '_' or '.', starting with a letter or digit" });
          return;
        }
        const target = join(projectsRoot, name);
        if (existsSync(target)) {
          json(res, 409, { ok: false, error: `a project named '${name}' already exists here` });
          return;
        }
        const result = await new Promise((resolveCreate) => {
          const child = spawn(process.execPath, [join(HOME, "tools", "create-limina-app", "index.mjs"), target], {
            cwd: HOME,
            stdio: ["ignore", "pipe", "pipe"],
          });
          let output = "";
          child.stdout.on("data", (c) => { output = (output + c).slice(-16_000); });
          child.stderr.on("data", (c) => { output = (output + c).slice(-16_000); });
          child.on("exit", (code) => resolveCreate({ code, output }));
        });
        if (result.code !== 0) {
          json(res, 500, { ok: false, error: `create-limina-app failed: ${result.output.slice(-400)}` });
          return;
        }
        json(res, 200, { ok: true, project: { projectId: name, root: target, name, lastTouched: lastTouched(target), running: false } });
        return;
      }

      if (req.method === "POST" && url === "/api/projects/open") {
        const body = await readBody(req);
        const root = typeof body.root === "string" ? resolve(body.root) : "";
        if (root === "" || !isInsideRoot(projectsRoot, root) || projectConfigFor(root) === undefined) {
          json(res, 400, { ok: false, error: "not a limina project inside the projects root" });
          return;
        }
        const opened = await openProject(root);
        json(res, 200, { ok: true, ...opened });
        return;
      }

      if (req.method === "POST" && url === "/api/projects/stop") {
        const body = await readBody(req);
        const root = typeof body.root === "string" ? resolve(body.root) : "";
        const stack = stacks.get(root);
        if (stack === undefined) {
          json(res, 404, { ok: false, error: "no running stack for that project" });
          return;
        }
        stacks.delete(root);
        try { process.kill(-stack.child.pid, "SIGTERM"); } catch { /* already down */ }
        json(res, 200, { ok: true });
        return;
      }

      // Hub UI static serving (own directory only, no traversal).
      if (req.method === "GET") {
        const clean = url === "/" ? "/index.html" : url;
        const rel = clean.replace(/^\/+/, "");
        const file = resolve(HUB_UI_DIR, rel);
        if ((file.startsWith(HUB_UI_DIR + sep) || file === join(HUB_UI_DIR, "index.html")) && existsSync(file) && statSync(file).isFile()) {
          const ext = file.slice(file.lastIndexOf("."));
          const mime = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml" }[ext] ?? "application/octet-stream";
          res.writeHead(200, { "content-type": mime, "cache-control": "no-cache", "x-content-type-options": "nosniff" });
          createReadStream(file).pipe(res);
          return;
        }
      }
      json(res, 404, { ok: false, error: "not found" });
    } catch (error) {
      json(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  });
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (import.meta.url === invokedPath) {
  const port = Number(process.argv[2] ?? process.env.LIMINA_HUB_PORT ?? 5173);
  const server = createHubServer();
  server.listen(port, "127.0.0.1", () => {
    console.log(`\n  limina hub — projects in ${defaultProjectsRoot()}`);
    console.log(`  open  http://localhost:${port}/\n`);
  });
}
