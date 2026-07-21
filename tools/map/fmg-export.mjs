// fmg-export.mjs — drive the locally-served Azgaar Fantasy Map Generator with playwright-core,
// let it auto-generate a map, then call window.Services.ExportJson().exportToJson("Full") and
// capture the triggered download via Playwright's download event (no real browser needed).
import { createRequire } from "node:module";
import { resolve } from "node:path";

const require = createRequire(import.meta.url);
const pwc = "/home/cheapseatsecon/.npm/_npx/218f5d799962bf90/node_modules/playwright-core";
const chrome = "/home/cheapseatsecon/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome";
const { chromium } = require(pwc);

const URL = process.argv[2] || "http://localhost:5273/Fantasy-Map-Generator/";
const OUT = resolve(process.argv[3] || "azgaar-real.json");

const browser = await chromium.launch({
  executablePath: chrome,
  headless: true,
  args: ["--no-sandbox", "--disable-dev-shm-usage", "--use-gl=angle", "--use-angle=gl", "--enable-gpu", "--ignore-gpu-blocklist"],
});
const context = await browser.newContext({ acceptDownloads: true, viewport: { width: 1600, height: 1000 } });
const page = await context.newPage();
const logs = [];
page.on("console", (m) => logs.push(m.text()));
page.on("pageerror", (e) => logs.push("PAGEERROR: " + e.message));

try {
  console.error("goto...");
  await page.goto(URL, { waitUntil: "load", timeout: 60000 });

  // FMG auto-generates a random map on load. Wait for the loading screen to disappear and for
  // window.pack (the generated Voronoi cell graph) to be populated with cells.
  console.error("waiting for map generation...");
  await page.waitForFunction(
    () => {
      // @ts-ignore
      const p = window.pack;
      return p && p.cells && p.cells.i && p.cells.i.length > 1000;
    },
    { timeout: 90000, polling: 500 }
  );
  // small settle buffer for any async post-generation steps (routes, burgs, etc.)
  await page.waitForTimeout(3000);

  const cellCount = await page.evaluate(() => window.pack.cells.i.length);
  console.error(`generated pack with ${cellCount} cells`);

  if (process.env.FMG_DISTANCE_SCALE) {
    const newScale = Number(process.env.FMG_DISTANCE_SCALE);
    // `distanceScale` is a top-level `let` in public/main.js (a classic, non-module script) — it is
    // NOT attached to `window`, so it must be changed the way the real UI changes it: set the
    // #distanceScaleInput value and dispatch a "change" event, which runs the app's own
    // changeDistanceScale() handler (public/modules/ui/units-editor.js:52) that reassigns the
    // module-scoped variable. distanceScale is read only at export/display time (getSettings()) —
    // it is NOT consulted by the heightmap/cell generators — so this does not touch the
    // already-generated Voronoi geometry, only how those real coordinates are labelled in meters on
    // export. This mirrors the FMG UI's own distance-scale input (a legitimate, user-editable
    // setting) and matches the precedent already established in this repo's own hand-built fixture
    // (assets/maps/_fixtures/fmg/README.md: "miniature on purpose... Any positive distanceScale is
    // legal in FMG"). It is NOT a crop/region-select — the whole generated world is rescaled.
    // The change listener on #distanceScaleInput is only registered the first time the "Units
    // Editor" dialog opens (public/modules/ui/units-editor.js: `if (modules.editUnits) return;`
    // guards re-registration, but registration itself happens inside editUnits()). Call it once so
    // the listener exists, then set the slider's value and dispatch change for real.
    await page.evaluate(() => { window.editUnits(); });
    await page.evaluate((s) => {
      const el = document.getElementById("distanceScaleInput");
      el.value = String(s);
      el.dispatchEvent(new Event("change", { bubbles: true }));
    }, newScale);
  }

  console.error("calling Services.ExportJson.exportToJson('Full') and awaiting download...");
  const [download] = await Promise.all([
    page.waitForEvent("download", { timeout: 30000 }),
    page.evaluate(async () => {
      // window.Services.ExportJson is a lazy-loading Proxy (see src/utils/registry.ts) whose
      // methods return promises; matches the call site in public/modules/ui/options.js.
      await window.Services.ExportJson.exportToJson("Full");
    }),
  ]);
  await download.saveAs(OUT);
  console.error(`saved -> ${OUT}`);
} finally {
  console.error("recent logs:\n  " + logs.slice(-25).join("\n  "));
  await browser.close();
}
