// Headless render test for the editor's live 3D viewport (WebGL2 via SwiftShader).
//
// With forceWebGL2 set, the viewport no longer needs a real GPU — headless Chromium's SwiftShader
// renders the same three scene in software. This loads the editor, lets runLive boot the sim-worker +
// SAB bridge + WebGL2 renderer, then samples the viewport canvas to prove it draws a NON-BLACK scene
// (the bug the user hit was an all-black canvas from WebGPU device loss). Saves a screenshot.
//
// Run: node editor/test/viewport_render.test.cjs   (exit 0 = pass; exit 2 = no browser/servers → skip)

const fs = require("fs");
const PWC = fs.readFileSync("/tmp/claude-1000/-home-cheapseatsecon-Projects-Personal-limina/ec66f3aa-28e5-4be6-af39-c803b3c96622/scratchpad/pwc_path.txt", "utf8").trim();
const CHROME = process.env.CHROME_BIN || `${process.env.HOME}/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome`;
function fail(m) { console.error("FAIL: " + m); process.exit(1); }

(async () => {
  let chromium;
  try { ({ chromium } = require(PWC)); } catch (e) { console.log("SKIP: playwright-core not loadable"); process.exit(2); }
  if (!fs.existsSync(CHROME)) { console.log("SKIP: chromium not found"); process.exit(2); }

  let browser;
  try {
    // SwiftShader gives a software WebGL2 backend with no GPU — enough to render the scene headlessly.
    browser = await chromium.launch({ executablePath: CHROME, args: [
      "--no-sandbox", "--disable-dev-shm-usage",
      "--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader",
    ] });
  } catch (e) { console.log("SKIP: could not launch chromium (" + e.message + ")"); process.exit(2); }

  const page = await (await browser.newContext()).newPage();
  const status = [];
  page.on("console", (m) => { const t = m.text(); if (/viewport|runLive|WebGL|render/i.test(t)) status.push(m.type() + ": " + t.slice(0, 120)); });

  try {
    const resp = await page.goto("http://localhost:5173/", { waitUntil: "domcontentloaded", timeout: 8000 }).catch(() => null);
    if (!resp) { console.log("SKIP: editor not served on :5173"); await browser.close(); process.exit(2); }

    // runLive boots on load (viewport.js calls boot()); give the worker + SAB + first frames time.
    await page.waitForTimeout(8000);

    const vstatus = await page.textContent("#viewport-status").catch(() => "?");
    // Reliable readback: an ELEMENT screenshot of the canvas captures the browser-composited frame
    // (drawImage/toDataURL on a WebGL canvas return black without preserveDrawingBuffer). A rendered
    // scene (sky gradient + ground + lit shapes) yields a much larger PNG than a flat-black frame.
    const canvasShot = "editor/test/viewport_render.png";
    const buf = await page.locator("#editor-viewport").screenshot({ path: canvasShot });
    await page.screenshot({ path: "editor/test/viewport_render_full.png", fullPage: true });
    await browser.close();

    const BLACK_PNG_CEILING = 6000; // a flat ~400x510 black PNG compresses to ~1-3KB; a scene is far larger
    if (/error/i.test(vstatus)) fail(`viewport reported error status: "${vstatus}"`);
    if (buf.length <= BLACK_PNG_CEILING) {
      fail(`viewport canvas looks flat/black (PNG ${buf.length}B ≤ ${BLACK_PNG_CEILING}B), status="${vstatus}". ` +
        `Render logs: ${status.slice(-4).join(" || ")}`);
    }
    console.log(`viewport_render.test OK: the editor's live 3D viewport renders a non-flat scene via WebGL2/SwiftShader ` +
      `(canvas PNG ${buf.length}B ≫ ${BLACK_PNG_CEILING}B black-frame ceiling), status "${vstatus}". ` +
      `forceWebGL2 fixes the WebGPU-device-loss black screen. Screenshots: ${canvasShot}, viewport_render_full.png.`);
    process.exit(0);
  } catch (e) { try { await browser.close(); } catch (_) {} fail(e && e.message ? e.message : String(e)); }
})();
