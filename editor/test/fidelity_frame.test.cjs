// Track A "visibly better frame" — measured evidence the fidelity baseline beats a flat render.
//
// Renders the SAME shapes two ways via SwiftShader (software WebGL2, no GPU):
//   • flat   — naive unlit constant-color materials (the "before": flat-shaded primitives)
//   • lit    — the engine's render baseline (sun + hemisphere + procedural-sky IBL + ACES tonemap,
//              PBR surfaces) — the fidelity default ("after")
// and asserts the lit frame carries materially more shading STRUCTURE (per-pixel luminance stdev:
// highlights, shadows, gradients) than the flat frame. Saves both frames as side-by-side evidence.
// This is the objective half of Track A's "a side-by-side frame is visibly better than today" gate;
// the subjective half is a human glance (the user already confirmed the lit render in the editor).
//
// Prereq: static server on :5173. Run: node editor/test/fidelity_frame.test.cjs (exit 0/2 = pass/skip).

const fs = require("fs");
const PWC = fs.readFileSync("/tmp/claude-1000/-home-cheapseatsecon-Projects-Personal-limina/ec66f3aa-28e5-4be6-af39-c803b3c96622/scratchpad/pwc_path.txt", "utf8").trim();
const CHROME = process.env.CHROME_BIN || `${process.env.HOME}/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome`;
function fail(m) { console.error("FAIL: " + m); process.exit(1); }

(async () => {
  let chromium;
  try { ({ chromium } = require(PWC)); } catch { console.log("SKIP: playwright-core not loadable"); process.exit(2); }
  if (!fs.existsSync(CHROME)) { console.log("SKIP: chromium not found"); process.exit(2); }
  let browser;
  try {
    browser = await chromium.launch({ executablePath: CHROME, args: ["--no-sandbox", "--disable-dev-shm-usage", "--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
  } catch (e) { console.log("SKIP: could not launch chromium (" + e.message + ")"); process.exit(2); }

  const page = await (await browser.newContext()).newPage();
  try {
    const resp = await page.goto("http://localhost:5173/render-harness.html", { waitUntil: "domcontentloaded", timeout: 8000 }).catch(() => null);
    if (!resp) { console.log("SKIP: harness not served on :5173"); await browser.close(); process.exit(2); }
    await page.waitForFunction(() => window.__ready === true, { timeout: 10000 });

    // Render-twice per config to settle the renderer's one-frame state lag, then read the settled stats.
    const measure = async (cfg) => { await page.evaluate((c) => window.__renderAt(c), cfg); return page.evaluate((c) => window.__renderAt(c), cfg); };

    const flat = await measure({ flat: 1, sun: 3 });
    await page.screenshot({ path: "editor/test/fidelity_flat.png" });
    const lit = await measure({ fullSky: 1, sun: 3 });
    await page.screenshot({ path: "editor/test/fidelity_lit.png" });
    await browser.close();

    // The lit baseline must carry materially more shading structure than the flat render.
    const ratio = lit.detail / Math.max(flat.detail, 1e-5);
    if (!(lit.detail > flat.detail * 1.3)) {
      fail(`fidelity baseline is not measurably richer than flat: lit detail ${lit.detail.toFixed(5)} vs flat ${flat.detail.toFixed(5)} (ratio ${ratio.toFixed(2)}x < 1.3x)`);
    }
    console.log(`fidelity_frame.test OK: the render baseline produces a measurably richer frame than flat shading — ` +
      `shading detail (mean local gradient) ${lit.detail.toFixed(5)} lit vs ${flat.detail.toFixed(5)} flat (${ratio.toFixed(2)}x more), ` +
      `lit mean ${lit.meanLum.toFixed(4)}. Side-by-side: editor/test/fidelity_lit.png vs fidelity_flat.png. Track A "visibly better frame", measured.`);
    process.exit(0);
  } catch (e) { try { await browser.close(); } catch (_) {} fail(e && e.message ? e.message : String(e)); }
})();
