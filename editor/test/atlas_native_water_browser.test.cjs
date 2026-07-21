// atlas_native_water_browser.test.cjs — browser gate for water-basin authoring on the
// NATIVE Atlas surface (editor/src/atlas/atlas-surface.js), replacing the retired
// old-SPA gate (atlas_water_authoring_browser.test.cjs, deleted with the SPA).
//
// What it proves, against a throwaway FIXTURE vault (never a live project vault):
//   1. The studio editor boots the native Atlas surface against a real headless
//      design sidecar (tools/design/serve-design.mjs --headless) reached through
//      the real launcher proxy (tools/scaffold/scripts/serve.mjs /api/**, with the
//      design token attached server-side).
//   2. The water.basin tool activates from the real ribbon button and real pointer
//      events (page.mouse click ×4 + dblclick) commit exactly one water body with
//      the registry defaults (kind "lake", level 0, depth 8) through makeWaterBody
//      and the shared water-ir contract into model.doc.waterBodies.
//   3. flushSave() round-trips through the REAL design server: /api/state serves
//      the persisted body back (CAS save, not a stubbed route).
//   4. The #atlas-undo rail button removes the body and that removal also persists.
//   5. Redo restores it, and a select.lasso drag rect over the basin (real mouse
//      drag) deletes it — and that deletion persists server-side too.
//
// Falsifiability: a basin that fails shared-contract validation never lands in the
// doc (leg 2 fails); a save that does not round-trip leaves /api/state without the
// body (legs 3-5 fail); a lasso that misses leaves the body in the doc (leg 5
// fails); any page error fails the gate. No test-only seams drive the workflow —
// __atlas is used only to read state and to convert world→screen coordinates for
// real mouse events.

const { spawn } = require("node:child_process");
const { randomBytes } = require("node:crypto");
const { mkdtempSync, rmSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");
const { chromeExecutable, loadChromium, requireChromeBinary, skip } = require("./browser-env.cjs");

const ROOT = resolve(__dirname, "../..");
const SCREENSHOT = join(ROOT, "traces/atlas_native_water_browser.png");
const sleep = (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
function fail(message) { throw new Error(message); }

(async () => {
  const loaded = loadChromium();
  if (!loaded.chromium) skip(loaded.error);
  const executablePath = chromeExecutable();
  requireChromeBinary(executablePath);

  // Fixture vault: the old gate's maps.json shape (version 2, activeMapId
  // "primary", one empty map — the native surface needs only model != null).
  const vault = mkdtempSync(join(tmpdir(), "atlas-native-water-"));
  writeFileSync(join(vault, "limina.project.json"), JSON.stringify({ schema: "limina-project/1", projectId: "atlas-native-water-browser" }, null, 2));
  writeFileSync(join(vault, "home.md"), "---\nkind: home\ntitle: Atlas Native Water Browser\n---\n# Atlas Native Water Browser\n");
  writeFileSync(join(vault, "maps.json"), JSON.stringify({
    version: 2,
    activeMapId: "primary",
    maps: [{
      id: "primary", name: "Native Water Browser", scope: "site", parent: null,
      units: { kind: "m", unitsPerMeter: 1, origin: [0, 0] },
      features: [],
      // A small land raster (ocean border, land interior — the same shape
      // run-gates.sh uses) so the surface composites terrain and the authored
      // basin is VISIBLE in the screenshot; on an empty map render() shows the
      // land-brush hint and never reaches drawFeatures().
      rasters: { landmass: { w: 7, h: 7, rect: { x0: -384, z0: -384, w: 768, h: 768 }, data: "AAAAAAAAAAD//////wAA//////8AAP//////AAD//////wAA//////8AAAAAAAAAAA==" } },
      sea: true, seaLevel: 0,
    }],
  }, null, 2));

  // Ports: pid-offset, three distinct families, clear of the dev stack (5173/5190/4321).
  const designPort = 43100 + (process.pid % 1000);
  const hostPort = 44100 + (process.pid % 1000);
  const staticPort = 45100 + (process.pid % 1000);
  const designToken = randomBytes(24).toString("base64url");
  const editorToken = randomBytes(24).toString("base64url");
  // The Atlas save path is authoritative: map-save commits through the editor
  // host's authoring.commit skill, so the fixture stack needs the real host too
  // (same triple run-gates.sh spawns). Pid-tagged trace names keep the host's
  // worldlog/trace/kernel-lock out of the dev stack's way; removed in cleanup.
  const tag = `atlas_native_water_${process.pid}`;
  const hostArtifacts = [`${tag}_worldlog.jsonl`, `${tag}_trace.jsonl`, `${tag}_chat.jsonl`, `${tag}_kernel.lock.json`]
    .map((name) => join(ROOT, "traces", name));

  const logs = { design: "", static: "", host: "" };
  const editorHost = spawn(join(ROOT, "target/release/limina"), [join(ROOT, "editor/server/editor_host.ts")], {
    cwd: ROOT,
    env: {
      ...process.env,
      LIMINA_EDITOR_PORT: String(hostPort),
      LIMINA_EDITOR_STATIC_PORT: String(staticPort),
      LIMINA_EDITOR_TOKEN: editorToken,
      LIMINA_PROJECT_ID: "atlas-native-water-browser",
      LIMINA_ASSET_ROOT: join(vault, "assets"),
      // Discovery config is validated eagerly at host boot; no derived runtime
      // ever listens here (this gate never enters Play) — the port is inert.
      LIMINA_DERIVED_RUNTIME_BASE_URL: `http://127.0.0.1:${46100 + (process.pid % 1000)}`,
      LIMINA_DERIVED_RUNTIME_TOKEN: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      LIMINA_DERIVED_RUNTIME_BRANCH_ID: "main",
      LIMINA_EDITOR_WORLDLOG: `${tag}_worldlog.jsonl`,
      LIMINA_EDITOR_TRACE: `${tag}_trace.jsonl`,
      LIMINA_EDITOR_CHAT: `${tag}_chat.jsonl`,
      LIMINA_EDITOR_KERNEL_LOCK: `${tag}_kernel.lock.json`,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  editorHost.stdout.on("data", (d) => { logs.host += d; });
  editorHost.stderr.on("data", (d) => { logs.host += d; });
  const designServer = spawn("node", [join(ROOT, "tools/design/serve-design.mjs"), vault, String(designPort), "--headless"], {
    env: {
      ...process.env,
      LIMINA_DESIGN_TOKEN: designToken,
      LIMINA_EDITOR_URL: `ws://127.0.0.1:${hostPort}/`,
      LIMINA_EDITOR_TOKEN: editorToken,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  designServer.stdout.on("data", (d) => { logs.design += d; });
  designServer.stderr.on("data", (d) => { logs.design += d; });
  const staticServer = spawn("node", [join(ROOT, "tools/scaffold/scripts/serve.mjs"), "editor", String(staticPort)], {
    cwd: ROOT,
    env: { ...process.env, LIMINA_ATLAS_ORIGIN: `http://127.0.0.1:${designPort}`, LIMINA_DESIGN_TOKEN: designToken },
    stdio: ["ignore", "pipe", "pipe"],
  });
  staticServer.stdout.on("data", (d) => { logs.static += d; });
  staticServer.stderr.on("data", (d) => { logs.static += d; });

  const stopProc = async (proc) => {
    if (proc.exitCode !== null || proc.signalCode !== null) return;
    proc.kill("SIGTERM");
    const deadline = Date.now() + 3000;
    while (proc.exitCode === null && proc.signalCode === null && Date.now() < deadline) await sleep(50);
    if (proc.exitCode === null && proc.signalCode === null) proc.kill("SIGKILL");
  };
  const cleanupAll = async () => {
    await stopProc(designServer);
    await stopProc(staticServer);
    await stopProc(editorHost);
    rmSync(vault, { recursive: true, force: true });
    for (const artifact of hostArtifacts) rmSync(artifact, { force: true });
  };

  // The editor host must be listening before any save can commit.
  let hostReady = false;
  for (let attempt = 0; attempt < 100 && !hostReady; attempt += 1) {
    if (logs.host.includes("gate-enabled authoritative MCP-ws server listening")) { hostReady = true; break; }
    if (editorHost.exitCode !== null) break;
    await sleep(100);
  }
  if (!hostReady) {
    await cleanupAll();
    console.error(`editor host log tail:\n${logs.host.slice(-2000)}`);
    fail("editor host did not become ready");
  }

  // Readiness through the serve.mjs proxy: proves the design sidecar is up AND the
  // proxy family + server-side token injection work before any browser boots.
  let ready = false;
  for (let attempt = 0; attempt < 100 && !ready; attempt += 1) {
    await sleep(100);
    try { ready = (await fetch(`http://127.0.0.1:${staticPort}/api/state`)).ok; } catch { /* servers are booting */ }
  }
  if (!ready) {
    await cleanupAll();
    console.error(`design server log tail:\n${logs.design.slice(-2000)}\nstatic server log tail:\n${logs.static.slice(-2000)}`);
    fail("design sidecar or studio proxy did not become ready");
  }

  const fetchState = async () => {
    const res = await fetch(`http://127.0.0.1:${staticPort}/api/state`);
    if (!res.ok) fail(`server /api/state returned ${res.status}`);
    return res.json();
  };

  const browser = await loaded.chromium.launch({ executablePath, args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"] });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));

  const worldToScreen = (wx, wz) => page.evaluate(([x, z]) => window.__atlas.worldToScreen(x, z), [wx, wz]);
  const waterBodies = () => page.evaluate(() => window.__atlas.model?.doc?.waterBodies ?? []);

  try {
    const response = await page.goto(`http://127.0.0.1:${staticPort}/`, { waitUntil: "domcontentloaded", timeout: 15_000 });
    if (!response?.ok()) fail(`studio HTTP load failed: ${response?.status()}`);

    // Leg 1: boot the studio, switch to the Atlas workspace, wait for the surface's model.
    await page.locator("#workspace-tab-atlas").click();
    await page.waitForFunction(() => window.__atlas?.model != null, null, { timeout: 10_000 });
    await page.waitForFunction(() => (document.querySelector("#atlas-workspace-body .atlas-canvas")?.width ?? 0) > 100, null, { timeout: 10_000 });

    // Leg 2: activate water.basin from the real ribbon; registry defaults must hold.
    await page.locator('#atlas-workspace-body .tool-btn[data-tool="water.basin"]').click();
    const defaults = await page.evaluate(() => ({
      active: window.__atlas.controller.activeId(),
      kind: window.__atlas.controller.option("water.basin", "kind"),
      level: window.__atlas.controller.option("water.basin", "level"),
      depth: window.__atlas.controller.option("water.basin", "depth"),
    }));
    if (defaults.active !== "water.basin") fail(`ribbon click did not activate water.basin (active: ${defaults.active})`);
    if (defaults.kind !== "lake" || defaults.level !== 0 || defaults.depth !== 8) {
      fail(`water.basin defaults drifted: ${JSON.stringify(defaults)}`);
    }

    // Real pointer authoring: 4 corner clicks + dblclick to close.
    const square = [[-60, -60], [60, -60], [60, 60], [-60, 60]];
    for (const [wx, wz] of square) {
      const [sx, sy] = await worldToScreen(wx, wz);
      await page.mouse.click(sx, sy);
    }
    const [lastX, lastY] = await worldToScreen(...square[3]);
    await page.mouse.dblclick(lastX, lastY);

    const authored = await waterBodies();
    if (authored.length !== 1) fail(`expected exactly 1 water body after basin authoring, got ${authored.length}`);
    const body = authored[0];
    if (body.kind !== "lake" || body.level !== 0) fail(`basin defaults not applied: ${JSON.stringify(body)}`);
    if (body.depthZones?.[0]?.depthM !== 8) fail(`basin depth default not applied: ${JSON.stringify(body.depthZones)}`);
    if (!Array.isArray(body.footprint?.points) || body.footprint.points.length < 4) {
      fail(`basin footprint too small: ${JSON.stringify(body.footprint)}`);
    }

    // Screenshot with the basin visible (proof artifact for the report).
    await page.screenshot({ path: SCREENSHOT });

    // Leg 3: the save round-trips through the REAL fixture design server.
    await page.evaluate(() => window.__atlas.flushSave());
    const afterSave = await fetchState();
    const persisted = afterSave.maps?.[0]?.waterBodies ?? [];
    if (persisted.length !== 1 || persisted[0].kind !== "lake" || persisted[0].footprint?.points?.length < 4) {
      fail(`server state did not persist the basin: ${JSON.stringify(persisted)}`);
    }

    // Leg 4: undo via the rail button removes the body, and the removal persists.
    await page.locator("#atlas-undo").click();
    if ((await waterBodies()).length !== 0) fail("undo did not remove the water body from the doc");
    await page.evaluate(() => window.__atlas.flushSave());
    const afterUndo = await fetchState();
    if ((afterUndo.maps?.[0]?.waterBodies ?? []).length !== 0) {
      fail(`server state still holds the basin after undo: ${JSON.stringify(afterUndo.maps?.[0]?.waterBodies)}`);
    }

    // Leg 5: redo restores it; a select.lasso drag rect over the basin deletes it.
    await page.locator("#atlas-redo").click();
    if ((await waterBodies()).length !== 1) fail("redo did not restore the water body");
    await page.locator('#atlas-workspace-body .tool-btn[data-tool="select.lasso"]').click();
    const [x0, y0] = await worldToScreen(-80, -80);
    const [x1, y1] = await worldToScreen(80, 80);
    await page.mouse.move(x0, y0);
    await page.mouse.down();
    await page.mouse.move(x1, y1, { steps: 10 });
    await page.mouse.up();
    if ((await waterBodies()).length !== 0) fail("lasso drag over the basin did not delete the water body");
    await page.evaluate(() => window.__atlas.flushSave());
    const afterLasso = await fetchState();
    if ((afterLasso.maps?.[0]?.waterBodies ?? []).length !== 0) {
      fail(`server state still holds the basin after lasso delete: ${JSON.stringify(afterLasso.maps?.[0]?.waterBodies)}`);
    }

    if (pageErrors.length) fail(`browser page errors: ${pageErrors.join(" | ")}`);
  } finally {
    await browser.close();
    await cleanupAll();
  }
  console.log("atlas_native_water_browser OK: native surface basin authoring via real pointer events, shared-contract validation, real server save round-trip, undo/redo, lasso delete — all persisted");
})().catch((error) => { console.error(`FAIL: ${error.stack || error.message}`); process.exit(1); });
