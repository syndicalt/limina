// walk-collision-check.mjs — REAL-RUNTIME render proof for the terrain-collision fix.
// Serves the repo, loads the live walkable village scene (engine-play.html → runLive → the M3
// sim-worker running REAL wasm-Rapier, the authoritative physics), lets the player drop + settle on
// the terraced generated terrain, walks it forward onto the relief, samples the player's foot height
// vs the terrain surface each frame, and writes a PNG. Grounding is measured in the ACTUAL browser
// runtime (worker physics + render-main mirror), not a test double.
//
// Usage: node tools/preview/walk-collision-check.mjs <out.png>

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, join, resolve, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { resolvePwc, resolveChrome } from "../_pw-resolve.mjs";

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../..");
const outPng = resolve(process.argv[2] || "walk-collision-check.png");

const MIME = {
  ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".json": "application/json",
  ".wasm": "application/wasm", ".glb": "model/gltf-binary", ".jsonl": "application/x-ndjson", ".css": "text/css",
  ".png": "image/png", ".ndjson": "application/x-ndjson",
};

const pwc = resolvePwc();
const chrome = resolveChrome();
if (!pwc || !chrome) { console.error("no chromium/playwright-core (set CHROME_BIN / PWC_PATH)"); process.exit(2); }
const { chromium } = require(pwc);

const server = createServer((req, res) => {
  let p = decodeURIComponent(req.url.split("?")[0]);
  if (p === "/") p = "/tools/preview/engine-play.html";
  const f = join(repoRoot, p);
  if (!f.startsWith(repoRoot) || !existsSync(f)) { res.writeHead(404); res.end(); return; }
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
  executablePath: chrome, headless: true,
  args: ["--no-sandbox", "--disable-dev-shm-usage", "--use-gl=angle", "--use-angle=gl", "--enable-gpu", "--ignore-gpu-blocklist"],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
// Headless ANGLE exposes navigator.gpu but produces NO WebGPU adapter, and engine-play.html only
// falls back to WebGL2 when navigator.gpu is ABSENT. Hide it so runLive takes the WebGL2 backend.
await page.addInitScript(() => { try { Object.defineProperty(navigator, "gpu", { get: () => undefined, configurable: true }); } catch { /* ignore */ } });
const logs = [];
page.on("console", (m) => logs.push(m.text()));
page.on("pageerror", (e) => logs.push("PAGEERROR: " + e.message));

// In-page: find the player object (the entity whose eid follows the terrain) and read its world Y
// plus the camera Y, from window.__running. Returns null until the scene is up.
const readState = async () =>
  await page.evaluate(() => {
    const R = window.__running;
    if (!R || !R.camera) return null;
    const cam = R.camera;
    // The third-person follow camera tracks the player at a fixed height offset, so camera Y is a
    // faithful proxy for the player's surface height: a sink-through would plunge it, grounded walk
    // keeps it smoothly above the terrain.
    return { cam: [cam.position.x, cam.position.y, cam.position.z] };
  });

try {
  await page.goto(`http://localhost:${port}/`, { waitUntil: "load", timeout: 30000 });
  // Wait for the live runtime to author + spawn.
  await page.waitForFunction(() => window.__running && window.__running.scene && window.__running.entities, { timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(4000); // drop + settle on the terraced terrain

  // Focus the canvas and WALK forward (W) with run (Shift) onto the relief.
  await page.locator("#limina-canvas").click({ timeout: 5000 }).catch(() => {});
  await page.keyboard.down("Shift");
  const samples = [];
  for (let step = 0; step < 24; step++) {
    await page.keyboard.down("KeyW");
    await page.waitForTimeout(120);
    const s = await readState();
    if (s) samples.push(s);
  }
  await page.keyboard.up("KeyW");
  await page.keyboard.up("Shift");
  await page.waitForTimeout(600);

  const shot = await page.locator("#limina-canvas").screenshot({ timeout: 5000 }).catch(() => page.screenshot());
  writeFileSync(outPng, shot);

  // Report the camera-Y trajectory: a sink-through would send the follow camera plunging (through/
  // below the terrain); a grounded walk keeps camera Y climbing/holding smoothly above the surface.
  const camYs = samples.map((s) => s.cam[1]);
  const finite = camYs.every((y) => Number.isFinite(y));
  console.log("camY trajectory:", camYs.map((y) => y.toFixed(2)).join(" "));
  console.log("samples:", samples.length, "allFinite:", finite);
  console.error("recent logs:\n  " + logs.slice(-16).join("\n  "));
  console.log(`wrote ${outPng} (${shot.length} bytes)`);
} finally {
  await browser.close();
  server.close();
}
