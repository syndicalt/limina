// tools/shoot.mjs — THE AGENT'S EYES. Serve a web root, load it in headless chromium (WebGL2 via
// swiftshader — no GPU needed), let the real limina engine render, and SAVE a PNG of the canvas so
// the agent can Read it and judge the frame. This closes the visual loop: render → PNG → look → fix.
//
// Usage: node tools/shoot.mjs <web-root> <out.png> [wait-ms=4500] [canvas-selector=#limina-canvas]
//   exit 0 = wrote a PNG · 2 = no chromium/playwright-core

import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, join, resolve, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));

const webRoot = resolve(process.argv[2] || ".");
const outPng = resolve(process.argv[3] || "shot.png");
const waitMs = Number(process.argv[4] || 4500);
const selector = process.argv[5] || "#limina-canvas";

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

const MIME = {
  ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".json": "application/json",
  ".wasm": "application/wasm", ".glb": "model/gltf-binary", ".jsonl": "application/x-ndjson", ".css": "text/css",
  ".png": "image/png", ".ndjson": "application/x-ndjson",
};

const pwc = resolvePwc();
const chrome = resolveChrome();
if (!pwc || !chrome) { console.error("shoot: no chromium/playwright-core (set CHROME_BIN / PWC_PATH)"); process.exit(2); }
const { chromium } = require(pwc);

const server = createServer((req, res) => {
  let p = decodeURIComponent(req.url.split("?")[0]);
  if (p === "/") p = "/index.html";
  const f = join(webRoot, p);
  if (!f.startsWith(webRoot) || !existsSync(f)) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, {
    "content-type": MIME[extname(f)] || "application/octet-stream",
    "cross-origin-opener-policy": "same-origin",
    "cross-origin-embedder-policy": "require-corp",
  });
  res.end(readFileSync(f));
});
await new Promise((r) => server.listen(0, r));
const port = server.address().port;

const browser = await chromium.launch({
  executablePath: chrome,
  headless: true,
  // REAL GPU (hardware ANGLE/GL — Intel Iris Xe here), headless, no display. NOT swiftshader: software
  // rendering can't do shadows, caps instance density, and disagrees with what the GPU actually draws.
  args: ["--no-sandbox", "--disable-dev-shm-usage", "--use-gl=angle", "--use-angle=gl", "--enable-gpu", "--ignore-gpu-blocklist"],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const logs = [];
page.on("console", (m) => logs.push(m.text()));
page.on("pageerror", (e) => logs.push("PAGEERROR: " + e.message));

try {
  await page.goto(`http://localhost:${port}/`, { waitUntil: "load", timeout: 30000 });
  await page.waitForTimeout(waitMs);
  let shot;
  try { shot = await page.locator(selector).screenshot({ timeout: 5000 }); }
  catch { shot = await page.screenshot(); }
  writeFileSync(outPng, shot);
  console.error("recent page logs:\n  " + logs.slice(-14).join("\n  "));
  console.log(`shoot: wrote ${outPng} (${shot.length} bytes)`);
} finally {
  await browser.close();
  server.close();
}
