// HOST-SIDE (node + Playwright chromium + sharp): the REAL-ENGINE browser gate. Closes the gap the
// codebase repeatedly flags as "the actual in-browser WebGPU draw is UAT": it loads the real limina
// engine bundle (THREE.WebGPURenderer, WebGL2 fallback under swiftshader) in headless chromium,
// replays an exported world through it, and ASSERTS the engine actually rendered — the export
// reached the "ready/playing" phase and the canvas is non-blank (real pixels, via sharp stats).
//
// This is the export-everywhere north star, automatically verified: author → export → the REAL
// engine renders it in a browser. Mode-A replay (keyframes) needs no SAB/COOP-COEP and no
// wasm-Rapier, so a plain static server + WebGL2 suffice.
//
// Run: node tools/director/engine-browser-gate.mjs [web-root] [world-rel-url]
//   exit 0 = pass · exit 1 = failed · exit 2 = no browser (skipped)
//
// Prereq: bundle the engine first → (cd js && npm run bundle:runtime)

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, join, resolve, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..");

function resolvePwc() {
  if (process.env.PWC_PATH) return process.env.PWC_PATH;
  try { return require.resolve("playwright-core"); } catch { /* fall through */ }
  const npx = join(process.env.HOME || "", ".npm", "_npx");
  if (existsSync(npx)) for (const d of readdirSync(npx)) {
    const p = join(npx, d, "node_modules", "playwright-core");
    if (existsSync(p)) return p;
  }
  return null;
}
function resolveChrome() {
  if (process.env.CHROME_BIN && existsSync(process.env.CHROME_BIN)) return process.env.CHROME_BIN;
  const base = join(process.env.HOME || "", ".cache", "ms-playwright");
  if (existsSync(base)) for (const d of readdirSync(base).filter((x) => x.startsWith("chromium-")).sort().reverse()) {
    const p = join(base, d, "chrome-linux64", "chrome");
    if (existsSync(p)) return p;
  }
  return null;
}
function skip(m) { console.log("SKIP: " + m); process.exit(2); }
function fail(m) { console.error("engine-browser-gate FAIL: " + m); process.exit(1); }

const webRoot = resolve(process.argv[2] || join(repoRoot, "web"));
const worldUrl = process.argv[3] || "public/worlds/demo";
const indexHtml = join(webRoot, "index.html");
const bundle = join(webRoot, "public", "limina-runtime.js");
if (!existsSync(indexHtml)) fail("no web/index.html at " + indexHtml);
if (!existsSync(bundle)) fail("engine bundle missing at " + bundle + " (run: cd js && npm run bundle:runtime)");

const pwcPath = resolvePwc();
if (!pwcPath) skip("playwright-core not resolvable (set PWC_PATH)");
const CHROME = resolveChrome();
if (!CHROME) skip("no chromium binary (set CHROME_BIN)");

let chromium, sharp;
try { ({ chromium } = require(pwcPath)); } catch (e) { skip("playwright-core not loadable: " + e.message); }
try { sharp = require("sharp"); } catch (e) { skip("sharp not loadable: " + e.message); }

const TYPES = {
  ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css",
  ".json": "application/json", ".jsonl": "text/plain", ".wasm": "application/wasm", ".map": "application/json",
};

function startServer() {
  const server = createServer((req, res) => {
    try {
      const urlPath = decodeURIComponent((req.url || "/").split("?")[0]);
      let filePath = join(webRoot, urlPath === "/" ? "index.html" : urlPath);
      if (!filePath.startsWith(webRoot)) { res.writeHead(403); res.end(); return; }
      if (!existsSync(filePath)) { res.writeHead(404); res.end("not found: " + urlPath); return; }
      res.writeHead(200, { "content-type": TYPES[extname(filePath)] || "application/octet-stream" });
      res.end(readFileSync(filePath));
    } catch (e) { res.writeHead(500); res.end(String(e)); }
  });
  return new Promise((res) => server.listen(0, "127.0.0.1", () => res({ server, port: server.address().port })));
}

(async () => {
  const { server, port } = await startServer();
  let browser;
  try {
    browser = await chromium.launch({
      executablePath: CHROME,
      args: ["--no-sandbox", "--disable-dev-shm-usage", "--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
    });
  } catch (e) { server.close(); skip("could not launch chromium: " + e.message); }

  const page = await (await browser.newContext({ viewport: { width: 900, height: 600 } })).newPage();
  const errors = [];
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  page.on("pageerror", (e) => errors.push("pageerror: " + e.message));

  try {
    const url = `http://127.0.0.1:${port}/index.html`;
    // Point the canvas at the requested world (the page defaults to public/worlds/demo).
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 15000 });
    await page.evaluate((w) => {
      const c = document.getElementById("limina-canvas");
      if (c && c.getAttribute("data-world") !== w) c.setAttribute("data-world", w);
    }, worldUrl);

    // Wait for the real engine to initialize + start replaying (status leaves "starting…",
    // is not an error). The "ready" detail is "<ticks> ticks, <keyframes> keyframes".
    const status = await page.waitForFunction(() => {
      const el = document.getElementById("limina-status");
      const t = (el && el.textContent || "").toLowerCase();
      if (t.includes("error") || t.includes("missing")) return { error: true, text: t };
      if (/ready|playing|tick|keyframe|done/.test(t)) return { error: false, text: t };
      return false;
    }, { timeout: 25000 }).then((h) => h.jsonValue()).catch(() => null);

    if (!status) fail("the engine never reached a ready/playing status within 25s (WebGL2 init likely failed)");
    if (status.error) fail("the engine reported an error status: " + status.text);

    // Let a few frames render, then screenshot the canvas and measure pixel variance.
    await page.waitForTimeout(2000);
    const shot = await page.locator("#limina-canvas").screenshot();
    const meta = await sharp(shot).stats();
    const maxStdev = Math.max(...meta.channels.map((c) => c.stdev));
    const nonblank = maxStdev > 4;

    const benign = (s) => /favicon|webgpu|navigator\.gpu|gpuadapter|require-corp|Failed to load resource/i.test(s);
    const realErrors = errors.filter((e) => !benign(e));

    await browser.close();
    server.close();

    if (!nonblank) fail(`the real-engine canvas is blank (max channel stdev ${maxStdev.toFixed(2)}) — the engine did not render`);
    if (realErrors.length > 0) fail("console/page errors during real-engine playback: " + realErrors.slice(0, 3).join(" | "));

    console.log(
      `engine-browser-gate OK: the REAL limina engine (THREE.WebGPURenderer, WebGL2 via swiftshader) ` +
      `replayed "${worldUrl}" in headless chromium — status "${status.text.trim()}", canvas NON-BLANK ` +
      `(max channel stdev ${maxStdev.toFixed(1)}), no console errors. The in-browser WebGPU/WebGL2 render ` +
      `is now AUTOMATICALLY verified (previously UAT).`,
    );
    process.exit(0);
  } catch (e) {
    try { await browser.close(); } catch { /* ignore */ }
    server.close();
    fail(e && e.message ? e.message : String(e));
  }
})();
