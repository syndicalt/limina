// HOST-SIDE (node + Playwright chromium): the Stage-4 BROWSER TIER-2 GATE. Loads a static web build
// in a REAL headless browser and asserts the game actually ran: the canvas is non-blank (pixel
// variance), the diagnostics global reports the expected game state, and there are no console/page
// errors. Then it proves itself FALSIFIABLE by rejecting a blank page. This is the limina analogue
// of the reference repo's inspect-threejs-canvas.mjs, reading __LIMINA_DIAGNOSTICS__.
//
// Run: node tools/director/browser-gate.mjs [dist/<gdsId>]
//   exit 0 = pass · exit 1 = gate failed · exit 2 = no browser (skipped)

import { existsSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..");

function resolvePwc() {
  if (process.env.PWC_PATH) return process.env.PWC_PATH;
  try { return require.resolve("playwright-core"); } catch { /* fall through */ }
  const npx = join(process.env.HOME || "", ".npm", "_npx");
  if (existsSync(npx)) {
    for (const d of readdirSync(npx)) {
      const p = join(npx, d, "node_modules", "playwright-core");
      if (existsSync(p)) return p;
    }
  }
  return null;
}

function resolveChrome() {
  if (process.env.CHROME_BIN && existsSync(process.env.CHROME_BIN)) return process.env.CHROME_BIN;
  const base = join(process.env.HOME || "", ".cache", "ms-playwright");
  if (existsSync(base)) {
    const dirs = readdirSync(base).filter((x) => x.startsWith("chromium-")).sort().reverse();
    for (const d of dirs) {
      const p = join(base, d, "chrome-linux64", "chrome");
      if (existsSync(p)) return p;
    }
  }
  return null;
}

function skip(msg) { console.log("SKIP: " + msg); process.exit(2); }
function fail(msg) { console.error("browser-gate FAIL: " + msg); process.exit(1); }

const pwcPath = resolvePwc();
if (!pwcPath) skip("playwright-core not resolvable (set PWC_PATH)");
const CHROME = resolveChrome();
if (!CHROME) skip("no chromium binary found under ~/.cache/ms-playwright (set CHROME_BIN)");

let chromium;
try { ({ chromium } = require(pwcPath)); } catch (e) { skip("playwright-core not loadable: " + e.message); }

/** Load a page and return { nonblank, variance, buckets, diag, errors }. */
async function inspect(browser, fileUrl, settleMs) {
  const page = await (await browser.newContext({ viewport: { width: 700, height: 460 } })).newPage();
  const errors = [];
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
  await page.goto(fileUrl, { waitUntil: "domcontentloaded", timeout: 8000 });
  await page.waitForTimeout(settleMs);

  const stats = await page.evaluate(() => {
    const c = document.querySelector("canvas");
    if (!c) return { hasCanvas: false };
    const g = c.getContext("2d");
    const data = g.getImageData(0, 0, c.width, c.height).data;
    let min = 255, max = 0;
    const buckets = new Set();
    const stride = Math.max(4, Math.floor((data.length / 4 / 4096)) * 4);
    for (let i = 0; i < data.length; i += stride) {
      const r = data[i], gg = data[i + 1], b = data[i + 2];
      min = Math.min(min, r, gg, b);
      max = Math.max(max, r, gg, b);
      buckets.add((r >> 4) + "," + (gg >> 4) + "," + (b >> 4));
    }
    return { hasCanvas: true, variance: max - min, buckets: buckets.size, diag: window.__LIMINA_DIAGNOSTICS__ || null };
  });
  await page.close();

  const benign = (s) => /favicon|Failed to load resource/i.test(s);
  return {
    hasCanvas: !!stats.hasCanvas,
    nonblank: !!stats.hasCanvas && (stats.variance > 8 || stats.buckets > 3),
    variance: stats.variance,
    buckets: stats.buckets,
    diag: stats.diag,
    errors: errors.filter((e) => !benign(e)),
  };
}

(async () => {
  const distDir = process.argv[2] ? resolve(process.argv[2]) : join(repoRoot, "dist", "relic-sprint");
  const indexHtml = join(distDir, "index.html");
  if (!existsSync(indexHtml)) fail("no web build at " + indexHtml + " (run: bun run tools/director/build-web.ts)");

  // A deliberately blank page for the falsifiability check.
  const blankDir = join(repoRoot, "dist", "_gate_blank");
  mkdirSync(blankDir, { recursive: true });
  const blankHtml = join(blankDir, "index.html");
  writeFileSync(blankHtml, "<!doctype html><html><body><canvas id=g width=640 height=400></canvas>" +
    "<script>var c=document.getElementById('g');var x=c.getContext('2d');x.fillStyle='#fff';x.fillRect(0,0,c.width,c.height);</script></body></html>");

  let browser;
  try {
    browser = await chromium.launch({ executablePath: CHROME, args: ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage"] });
  } catch (e) { skip("could not launch chromium: " + e.message); }

  try {
    // 1. The real build MUST pass: non-blank canvas, diagnostics reach "won", no console errors.
    const real = await inspect(browser, pathToFileURL(indexHtml).href, 2600);
    if (!real.hasCanvas) fail("the web build has no <canvas>");
    if (!real.nonblank) fail(`the web build canvas is blank (variance=${real.variance}, buckets=${real.buckets})`);
    if (!real.diag) fail("the web build did not publish __LIMINA_DIAGNOSTICS__");
    if (real.diag.gameState !== "won") fail(`diagnostics gameState expected "won", got "${real.diag.gameState}" (frame ${real.diag.frame})`);
    if (!real.diag.complete || real.diag.counters.relics < 1) fail("diagnostics did not reflect the relic collection / completion");
    if (real.errors.length > 0) fail("console/page errors in the web build: " + real.errors.slice(0, 3).join(" | "));

    // 2. Falsifiability: a blank page (no game, no diagnostics) MUST be rejected by the gate.
    const blank = await inspect(browser, pathToFileURL(blankHtml).href, 300);
    const blankRejected = !blank.nonblank || !blank.diag || blank.diag.gameState === undefined;
    if (!blankRejected) fail("the gate is INERT: a blank page passed (variance=" + blank.variance + ", diag=" + JSON.stringify(blank.diag) + ")");

    await browser.close();
    console.log(
      `browser-gate OK: headless chromium loaded the static web build — non-blank canvas ` +
      `(variance=${real.variance}, ${real.buckets} color buckets), __LIMINA_DIAGNOSTICS__ reached ` +
      `gameState="won" (relics=${real.diag.counters.relics}, frame ${real.diag.frame}), zero console errors; ` +
      `and a blank page is correctly REJECTED. The browser tier-2 gate is real and falsifiable.`,
    );
    process.exit(0);
  } catch (e) {
    try { await browser.close(); } catch { /* ignore */ }
    fail(e && e.message ? e.message : String(e));
  }
})();
