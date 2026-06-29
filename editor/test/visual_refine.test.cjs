// REAL Track B visual self-correction loop — render (SwiftShader WebGL2) + pixel critique + converge.
//
// Drives the engine's actual refineVisual loop (js/src/eyes/self_correct.ts, bundled) with REAL
// providers, no mocks:
//   • RenderProvider  — renders the engine render baseline over PBR shapes in headless Chromium via
//     SwiftShader (software WebGL2, no GPU) and reads the framebuffer back (gl.readPixels) for stats.
//   • CritiqueProvider — scores the frame's measured mean luminance against a target and proposes an
//     exposure adjustment (a real pixel-based critique; a vision model is a drop-in for richer scoring).
// The loop starts from a deliberately too-dark exposure and must drive the rendered frame to the
// luminance bar on its own. This is the "improve how it looks without a human" claim, verified on real
// rendered pixels rather than mock stats.
//
// Prereq: static server on :5173 (serves editor/). Run: node editor/test/visual_refine.test.cjs
//   exit 0 = converged; exit 2 = no browser/server (skip).

const fs = require("fs");
const PWC = fs.readFileSync("/tmp/claude-1000/-home-cheapseatsecon-Projects-Personal-limina/ec66f3aa-28e5-4be6-af39-c803b3c96622/scratchpad/pwc_path.txt", "utf8").trim();
const CHROME = process.env.CHROME_BIN || `${process.env.HOME}/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome`;
function fail(m) { console.error("FAIL: " + m); process.exit(1); }

(async () => {
  let chromium, refineVisual;
  try { ({ chromium } = require(PWC)); } catch { console.log("SKIP: playwright-core not loadable"); process.exit(2); }
  try { ({ refineVisual } = await import("../vendor/self_correct.mjs")); } catch (e) { fail("could not import refineVisual (run `npm run bundle:editor` in js/): " + e.message); }
  if (!fs.existsSync(CHROME)) { console.log("SKIP: chromium not found"); process.exit(2); }

  let browser;
  try {
    browser = await chromium.launch({ executablePath: CHROME, args: [
      "--no-sandbox", "--disable-dev-shm-usage", "--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader",
    ] });
  } catch (e) { console.log("SKIP: could not launch chromium (" + e.message + ")"); process.exit(2); }

  const page = await (await browser.newContext()).newPage();
  try {
    const resp = await page.goto("http://localhost:5173/render-harness.html", { waitUntil: "domcontentloaded", timeout: 8000 }).catch(() => null);
    if (!resp) { console.log("SKIP: harness not served on :5173"); await browser.close(); process.exit(2); }
    await page.waitForFunction(() => window.__ready === true, { timeout: 10000 });

    const SUN_MIN = 0.1, SUN_MAX = 3.0; // sun-intensity is monotonic on luminance in this range
    // The real RenderProvider: render the engine baseline at this config, read back real pixels.
    // The renderer lags one frame on state changes, so render the config TWICE and use the settled
    // second reading. Sun intensity is clamped to its responsive range.
    const renderProvider = {
      render: async (config) => {
        const sun = Math.max(SUN_MIN, Math.min(SUN_MAX, config.sun ?? 1.0));
        await page.evaluate((s) => window.__renderAt({ sun: s }), sun);
        const r = await page.evaluate((s) => window.__renderAt({ sun: s }), sun);
        return { width: r.width, height: r.height, stats: { meanLum: r.meanLum } };
      },
    };

    // Calibrate the achievable luminance range so the target is reachable; gain from the measured slope.
    const lo = (await renderProvider.render({ sun: SUN_MIN })).stats.meanLum;
    const hi = (await renderProvider.render({ sun: SUN_MAX })).stats.meanLum;
    if (!(hi > lo + 0.01)) fail(`sun knob has no effect on luminance (lo=${lo.toFixed(4)}, hi=${hi.toFixed(4)}) — render not responding`);
    const target = lo + (hi - lo) * 0.55;
    const slope = (hi - lo) / (SUN_MAX - SUN_MIN);
    const gain = Math.max(2, Math.min(40, 0.6 / Math.max(slope, 0.005))); // calibrated proportional step
    const TOL = Math.max(0.004, (hi - lo) * 0.12);

    // The real CritiqueProvider: score measured luminance vs target, propose a sun-intensity delta.
    const critiqueProvider = {
      critique: (frame, config) => {
        const lum = frame.stats.meanLum;
        const err = target - lum;
        const passes = Math.abs(err) <= TOL;
        return {
          passes,
          score: Math.max(0, 1 - Math.abs(err) / Math.max(target, 0.001)),
          notes: `meanLum ${lum.toFixed(4)} vs target ${target.toFixed(4)} (sun ${(config.sun ?? 1).toFixed(3)})`,
          adjustments: passes ? {} : { sun: err * gain },
        };
      },
    };

    const result = await refineVisual({
      render: renderProvider, critique: critiqueProvider,
      initialConfig: { sun: SUN_MIN }, // deliberately too dark
      maxIterations: 16,
    });

    const finalLum = (await renderProvider.render(result.finalConfig)).stats.meanLum;
    await page.screenshot({ path: "editor/test/visual_refine.png" });
    await browser.close();

    if (!result.converged) {
      fail(`loop did NOT converge in ${result.iterations} iters. target=${target.toFixed(4)}, finalLum=${finalLum.toFixed(4)}, ` +
        `finalSun=${(result.finalConfig.sun).toFixed(3)}, TOL=${TOL.toFixed(4)}. Trajectory: ` +
        result.history.map((h) => h.notes).slice(-5).join(" || "));
    }
    if (!(result.finalConfig.sun > SUN_MIN)) fail("converged but did not raise sun intensity from the too-dark start");
    if (Math.abs(finalLum - target) > TOL + 0.01) fail(`converged flag set but final luminance ${finalLum.toFixed(4)} off target ${target.toFixed(4)}`);

    console.log(`visual_refine.test OK: the REAL self-correction loop converged on rendered pixels in ${result.iterations} iteration(s) — ` +
      `from a too-dark sun ${SUN_MIN} (lum ${lo.toFixed(4)}) up to sun ${result.finalConfig.sun.toFixed(3)} hitting target luminance ` +
      `${target.toFixed(4)} (final ${finalLum.toFixed(4)}, score ${result.finalScore.toFixed(3)}). Render: engine baseline via SwiftShader WebGL2; ` +
      `critique: real readback luminance. No human, no mocks.`);
    process.exit(0);
  } catch (e) { try { await browser.close(); } catch (_) {} fail(e && e.message ? e.message : String(e)); }
})();
