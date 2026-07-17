const { spawn } = require("node:child_process");
const { mkdtempSync, rmSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");
const { chromeExecutable, loadChromium, requireChromeBinary, skip } = require("./browser-env.cjs");

const ROOT = resolve(__dirname, "../..");
const sleep = (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
function fail(message) { throw new Error(message); }

(async () => {
  const loaded = loadChromium();
  if (!loaded.chromium) skip(loaded.error);
  const executablePath = chromeExecutable();
  requireChromeBinary(executablePath);

  const vault = mkdtempSync(join(tmpdir(), "atlas-water-authoring-"));
  writeFileSync(join(vault, "limina.project.json"), JSON.stringify({ schema: "limina-project/1", projectId: "atlas-water-browser" }, null, 2));
  writeFileSync(join(vault, "home.md"), "---\nkind: home\ntitle: Atlas Water Browser\n---\n# Atlas Water Browser\n");
  writeFileSync(join(vault, "maps.json"), JSON.stringify({
    version: 2,
    activeMapId: "primary",
    maps: [{
      id: "primary", name: "Water Browser", scope: "site", parent: null,
      units: { kind: "m", unitsPerMeter: 1, origin: [0, 0] },
      features: [{ id: "legacy-river", type: "line", kind: "river", points: [[-50, 0], [50, 0]], widthM: 4 }],
      sea: true, seaLevel: 0,
    }],
  }, null, 2));

  const port = 43100 + (process.pid % 1000);
  const server = spawn("node", [join(ROOT, "tools/design/serve-design.mjs"), vault, String(port)], { stdio: "ignore" });
  let ready = false;
  for (let attempt = 0; attempt < 60 && !ready; attempt += 1) {
    await sleep(100);
    try { ready = (await fetch(`http://127.0.0.1:${port}/api/state`)).ok; } catch { /* server is booting */ }
  }
  if (!ready) fail("Atlas design server did not become ready");

  const browser = await loaded.chromium.launch({ executablePath, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  const pageErrors = [];
  const saves = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.route("**/api/map-save", async (route) => {
    saves.push(route.request().postDataJSON());
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ok: true, mapsRev: `browser-rev-${saves.length}` }),
    });
  });

  try {
    const response = await page.goto(`http://127.0.0.1:${port}/?embed=editor`, { waitUntil: "networkidle", timeout: 15_000 });
    if (!response?.ok()) fail(`Atlas HTTP load failed: ${response?.status()}`);
    await page.locator("#map-svg").waitFor({ state: "visible", timeout: 10_000 });

    // Exercise the actual Atlas toolbar and pointer workflow, not a test-only form.
    await page.locator('[data-tool="basin"]').click();
    const map = page.locator("#map-svg");
    const box = await map.boundingBox();
    if (!box) fail("Atlas map canvas has no layout box");
    const polygon = [
      [box.x + box.width * 0.35, box.y + box.height * 0.35],
      [box.x + box.width * 0.60, box.y + box.height * 0.35],
      [box.x + box.width * 0.60, box.y + box.height * 0.62],
      [box.x + box.width * 0.35, box.y + box.height * 0.62],
    ];
    await page.mouse.move(...polygon[0]);
    await page.mouse.down();
    for (const point of polygon.slice(1)) await page.mouse.move(...point, { steps: 8 });
    await page.mouse.up();
    await page.locator("#insp").waitFor({ state: "visible" });
    if (await page.locator(".waterbody").count() !== 1) fail("pointer authoring did not create the basin path");

    await page.locator("#wb-kind").selectOption("reservoir");
    await page.locator("#wb-level").fill("18.5");
    await page.locator("#wb-zones").fill('[{"minShoreDistanceM":0,"maxShoreDistanceM":5,"depthM":1},{"minShoreDistanceM":5,"maxShoreDistanceM":14,"depthM":6}]');
    await page.locator("#wb-save").click();
    if (!/Saved/.test(await page.locator("#wb-feedback").textContent())) fail("valid basin edit did not surface success feedback");

    // A rejected edit must remain in the inspector and explain the canonical depth-zone error.
    await page.locator("#wb-zones").fill('[{"minShoreDistanceM":1,"maxShoreDistanceM":5,"depthM":2}]');
    await page.locator("#wb-save").click();
    const zoneError = await page.locator("#wb-feedback").textContent();
    if (!/shoreline|start/.test(zoneError)) fail(`invalid depth-zone feedback was not surfaced: ${zoneError}`);
    await page.locator("#insp-x").click();

    await page.locator('[data-tool="hydrology"]').click();
    await page.locator("#hydro-precip").fill("900");
    await page.locator("#hydro-river").fill("120000");
    await page.locator("#hydro-basin-area").fill("500");
    await page.locator("#hydro-basin-depth").fill("1.5");
    await page.locator("#hydro-fall").fill("4");
    await page.locator("#hydro-apply").click();
    if (await page.locator("#hydro-feedback").textContent() !== "saved") fail("hydrology recipe did not surface success feedback");

    await page.waitForTimeout(1000);
    if (!saves.length) fail("Atlas did not persist the authored water state");
    const persisted = saves.at(-1).maps[0];
    if (persisted.features[0]?.id !== "legacy-river" || persisted.sea !== true) fail("water authoring changed legacy sea/river state");
    if (persisted.waterBodies?.[0]?.kind !== "reservoir" || persisted.waterBodies[0].level !== 18.5
        || persisted.waterBodies[0].depthZones?.[1]?.depthM !== 6) fail(`persisted basin mismatch: ${JSON.stringify(persisted.waterBodies)}`);
    if (persisted.hydrology?.schema !== "limina.hydrology-recipe/v1" || persisted.hydrology.precipitationMmPerYear !== 900) {
      fail(`persisted hydrology mismatch: ${JSON.stringify(persisted.hydrology)}`);
    }

    // Undo/redo are real Atlas history operations and each state remains persistable.
    await page.keyboard.press("Control+z");
    await page.waitForTimeout(900);
    if (saves.at(-1).maps[0].hydrology !== undefined || saves.at(-1).maps[0].waterBodies?.length !== 1) {
      fail("undo did not remove only the hydrology recipe");
    }
    await page.keyboard.press("Control+Shift+z");
    await page.waitForTimeout(900);
    if (saves.at(-1).maps[0].hydrology?.precipitationMmPerYear !== 900) fail("redo did not restore the exact hydrology recipe");
    if (pageErrors.length) fail(`browser page errors: ${pageErrors.join(" | ")}`);
  } finally {
    await browser.close();
    server.kill();
    rmSync(vault, { recursive: true, force: true });
  }
  console.log("atlas_water_authoring_browser OK: real Atlas basin/depth/hydrology UI, validation, legacy coexistence, persistence, and undo/redo");
})().catch((error) => { console.error(`FAIL: ${error.stack || error.message}`); process.exit(1); });
