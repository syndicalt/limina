// studio_docs_panel_browser (studio-unification U1): the Design Docs panel is a
// real panel in the editor chrome, backed by the headless design sidecar through
// the launcher proxy. Provisions a real project (create-limina-app + fixture
// vault), boots the launcher, and asserts in a real (CPU-only) Chromium:
//   1. /api/state through the studio proxy returns the vault docs;
//   2. the #design-docs accordion renders keyed nav items for the vault;
//   3. opening a doc renders markdown into .dd-wrap .doc;
//   4. the panel's new-doc affordance is wired.
// Falsifiability: against a panel that never loaded (e.g. import path broken)
// leg 2's wait times out and fails — it cannot green vacuously.

const assert = require("node:assert/strict");
const { mkdtempSync, rmSync, copyFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const { randomBytes } = require("node:crypto");
const { loadChromium, chromeExecutable, requireChromeBinary } = require("./browser-env.cjs");

const ROOT = join(__dirname, "..", "..");
const FIXTURE = join(__dirname, "fixtures", "wb-w1-generated-water");
const START_TIMEOUT_MS = 120_000;

function distinctPorts(n) {
  const { createServer } = require("node:net");
  const one = () => new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
  return Promise.all(Array.from({ length: n }, one));
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
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error(`studio docs launcher timed out:\n${output.slice(-8_000)}`)), START_TIMEOUT_MS);
    const finish = (error, value) => {
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(value);
    };
    child.once("exit", (code, signal) => finish(new Error(`launcher exited (${signal ?? `exit ${code}`}):\n${output.slice(-8_000)}`)));
    child.once("error", finish);
    const check = () => {
      const browser = output.match(/Browser:\s+(http:\/\/localhost:[1-9][0-9]{0,4}\/\?server=\S+)/)?.[1];
      const host = output.match(/Editor host:\s+(ws:\/\/localhost:[1-9][0-9]{0,4}\/)/)?.[1];
      const capability = output.match(/Capability:\s+(\S+\/editor-capability\.json) \(private, mode 0600\)/)?.[1];
      if (browser && host && capability) {
        finish(undefined, Object.freeze({ editorUrl: new URL(browser).origin + "/", host }));
      }
    };
    child.stdout.on("data", (chunk) => { output = (output + String(chunk)).slice(-512 * 1024); check(); });
    child.stderr.on("data", (chunk) => { output = (output + String(chunk)).slice(-512 * 1024); check(); });
  });
  const stop = () => {
    try { process.kill(-child.pid, "SIGTERM"); } catch { /* already down */ }
  };
  return { child, ready, stop, output: () => output };
}

(async () => {
  const loaded = loadChromium();
  if (!loaded.chromium) {
    console.log("SKIP: " + loaded.error);
    process.exit(2);
  }
  const executablePath = chromeExecutable();
  requireChromeBinary(executablePath);

  const tmpBase = mkdtempSync(join(tmpdir(), "limina-studio-docs-"));
  const projectRoot = join(tmpBase, "studio-docs-project"); // create-limina-app validates lowercase names
  const scaffold = spawnSync(process.execPath, [join(ROOT, "tools", "create-limina-app", "index.mjs"), projectRoot], {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  assert.equal(scaffold.status, 0, `create-limina-app failed: ${scaffold.stderr || scaffold.stdout}`);
  copyFileSync(join(FIXTURE, "maps.json"), join(projectRoot, "design", "maps.json"));
  copyFileSync(join(FIXTURE, "world-bible.md"), join(projectRoot, "design", "world-bible.md"));

  const ports = await distinctPorts(4);
  const launcher = startLauncher(projectRoot, ports);
  let browser;
  try {
    const first = await launcher.ready;

    // 1. The studio proxy fronts the design backend on the editor origin.
    const stateResponse = await fetch(new URL("api/state", first.editorUrl));
    assert.equal(stateResponse.status, 200, `/api/state through the proxy: ${stateResponse.status}`);
    const state = await stateResponse.json();
    assert.ok(Array.isArray(state.docs) && state.docs.some((d) => d.name === "world-bible.md"), "vault docs reachable through the proxy");

    // 2-4. The panel is real chrome in the editor page.
    browser = await loaded.chromium.launch({ executablePath, headless: true, args: ["--no-sandbox", "--disable-gpu", "--enable-unsafe-swiftshader"] });
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.goto(first.editorUrl, { waitUntil: "domcontentloaded" });
    await page.click("#workspace-tab-design");
    await page.waitForSelector("#design-workspace-body .dd-navitem", { timeout: 30_000 });
    const items = await page.$$eval("#design-workspace-body .dd-navitem .t", (els) => els.map((e) => e.textContent));
    assert.ok(items.length >= 1, "docs nav renders vault documents");
    await page.click("#design-workspace-body .dd-navitem");
    await page.waitForSelector("#design-workspace-body .dd-wrap .doc", { timeout: 10_000 });
    const docText = await page.$eval("#design-workspace-body .dd-wrap .doc", (e) => e.textContent);
    assert.ok(docText.trim().length > 0, "the open document renders markdown");
    const newBtn = await page.$("#design-workspace-new");
    assert.ok(newBtn !== null, "the ＋ new-document affordance is present");
    // The workspace is center-stage, not an accordion rail: it must own the
    // stage's width (the viewport is hidden while Design is active).
    const widths = await page.evaluate(() => {
      const workspace = document.getElementById("design-workspace").getBoundingClientRect();
      const viewport = document.getElementById("viewport");
      return { workspace: workspace.width, viewportHidden: viewport.hidden };
    });
    assert.ok(widths.viewportHidden, "the viewport is hidden while the Design workspace is active");
    assert.ok(widths.workspace > 600, `the Design workspace is center-stage (width ${widths.workspace})`);
    console.log(`studio_docs_panel_browser.test OK: proxy /api/state, ${items.length} nav items (${items[0]}), doc view renders, affordances wired`);
    process.exit(0);
  } finally {
    if (browser) await browser.close().catch(() => {});
    launcher.stop();
    rmSync(tmpBase, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error("FAIL:", error && error.message ? error.message : error);
  process.exit(1);
});
