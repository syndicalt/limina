// Track C flagship-demo render — renders the SIEGE archetype's REAL geometry via SwiftShader.
//
// editor/test/siege_scene.json is dumped from the actual world.generateRegion + architecture.building
// + attacker spawns (js/test/_dump_siege_scene.ts — the same authoring p16_archetype_siege drives).
// This loads that real keep (floor + 4 walls + lintel + roof) + attackers, renders it through the
// engine baseline in headless Chromium (software WebGL2, no GPU), and asserts it draws a rich,
// non-trivial multi-object scene. Saves a screenshot — the visible flagship demo for the archetype
// whose integration test already passes headlessly.
//
// Prereq: static server on :5173; siege_scene.json present. Run: node editor/test/archetype_render.test.cjs

const fs = require("fs");
const { chromeExecutable, loadChromium, requireChromeBinary, skip } = require("./browser-env.cjs");
const { artifactPath } = require("./artifacts.cjs");
const CHROME = chromeExecutable();
const EDITOR_BASE_URL = process.env.EDITOR_BASE_URL || "http://localhost:5173";
function fail(m) { console.error("FAIL: " + m); process.exit(1); }

(async () => {
  const loaded = loadChromium();
  if (!loaded.chromium) skip(loaded.error);
  const chromium = loaded.chromium;
  requireChromeBinary(CHROME);
  // Render every archetype scene dump present (siege keep, quest village, …).
  const scenes = [
    { name: "siege", path: "editor/test/siege_scene.json", shot: artifactPath("archetype_siege.png") },
    { name: "quest", path: "editor/test/quest_scene.json", shot: artifactPath("archetype_quest.png") },
  ].filter((s) => fs.existsSync(s.path));
  if (scenes.length === 0) { console.log("SKIP: no archetype scene dumps present (run js/test/_dump_*_scene.ts)"); process.exit(2); }

  let browser;
  try {
    browser = await chromium.launch({ executablePath: CHROME, args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu", "--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
  } catch (e) { console.log("SKIP: could not launch chromium (" + e.message + ")"); process.exit(2); }

  const page = await (await browser.newContext()).newPage();
  try {
    const resp = await page.goto(`${EDITOR_BASE_URL}/render-harness.html`, { waitUntil: "domcontentloaded", timeout: 8000 }).catch(() => null);
    if (!resp) { console.log("SKIP: harness not served on :5173"); await browser.close(); process.exit(2); }
    await page.waitForFunction(() => window.__ready === true, { timeout: 10000 });

    const results = [];
    for (const sc of scenes) {
      const spec = JSON.parse(fs.readFileSync(sc.path, "utf8"));
      if (!Array.isArray(spec.boxes) || spec.boxes.length < 8) fail(`${sc.name} spec has too few boxes (${spec.boxes && spec.boxes.length})`);
      await page.evaluate((s) => window.__renderScene(s), spec); // settle
      const r = await page.evaluate((s) => window.__renderScene(s), spec);
      await page.screenshot({ path: sc.shot });
      // A real multi-object scene + sky + ground draws a rich, non-black, structured frame.
      if (!(r.meanLum > 0.05)) fail(`${sc.name} render is near-black (meanLum ${r.meanLum.toFixed(4)})`);
      if (!(r.detail > 0.0012)) fail(`${sc.name} render lacks structure (detail ${r.detail.toFixed(5)} ≤ 0.0012) — geometry may not have rendered`);
      results.push(`${sc.name}: ${spec.boxes.length} boxes, meanLum ${r.meanLum.toFixed(4)}, detail ${r.detail.toFixed(5)} → ${sc.shot}`);
    }
    await browser.close();
    console.log(`archetype_render.test OK: archetype flagship demos render the REAL skill-authored geometry via SwiftShader ` +
      `(integration tests p16_archetype_* already pass headlessly):\n  ` + results.join("\n  "));
    process.exit(0);
  } catch (e) { try { await browser.close(); } catch (_) {} fail(e && e.message ? e.message : String(e)); }
})();
