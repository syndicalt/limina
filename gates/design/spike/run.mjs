// SILHOUETTE SPIKE DRIVER (Phase 2a). Renders each asset's flat silhouette in headless chromium (real
// GPU), reads the mask with sharp, and measures: (1) DETERMINISM/clone — two renders of the same asset
// must give IoU ~1.0; (2) DISTINCTNESS — distinct assets must have pairwise mask IoU well below 1. If
// both hold, the silhouette design gate is viable. Saves the masks so the agent can eyeball them.
//
// Run: node gates/design/spike/run.mjs   (exit 0 = ran; reports PASS/FAIL inline)

import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join, resolve, extname, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..", "..");
const OUT = process.env.SIL_OUT || here;

function resolvePwc() { if (process.env.PWC_PATH) return process.env.PWC_PATH; try { return require.resolve("playwright-core"); } catch { /**/ } const npx = join(process.env.HOME || "", ".npm", "_npx"); if (existsSync(npx)) for (const d of readdirSync(npx)) { const p = join(npx, d, "node_modules", "playwright-core"); if (existsSync(p)) return p; } return null; }
function resolveChrome() { if (process.env.CHROME_BIN && existsSync(process.env.CHROME_BIN)) return process.env.CHROME_BIN; const base = join(process.env.HOME || "", ".cache", "ms-playwright"); if (existsSync(base)) for (const d of readdirSync(base).filter((x) => x.startsWith("chromium-")).sort().reverse()) { const p = join(base, d, "chrome-linux64", "chrome"); if (existsSync(p)) return p; } return null; }

const pwc = resolvePwc(), chrome = resolveChrome();
if (!pwc || !chrome) { console.error("no chromium/playwright-core"); process.exit(2); }
const { chromium } = require(pwc);
const sharp = require("sharp");

const MIME = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".glb": "model/gltf-binary", ".json": "application/json", ".css": "text/css", ".wasm": "application/wasm" };
const server = createServer((req, res) => {
  let p = decodeURIComponent((req.url || "/").split("?")[0]);
  if (p === "/") p = "/index.html";
  const f = join(repoRoot, p);
  if (!f.startsWith(repoRoot) || !existsSync(f)) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { "content-type": MIME[extname(f)] || "application/octet-stream" });
  res.end(readFileSync(f));
});
await new Promise((r) => server.listen(0, r));
const port = server.address().port;

const browser = await chromium.launch({ executablePath: chrome, headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage", "--use-gl=angle", "--use-angle=gl", "--enable-gpu", "--ignore-gpu-blocklist"] });

const ASSETS = ["pine.glb", "vegetation-dead-tree-1.glb", "building-wooden-watchtower-1.glb", "rock.glb", "prop-barrel-1.glb", "prop-water-well-1.glb", "broadleaf.glb", "bush.glb", "cottage.glb", "pine.glb"];
const labels = ASSETS.map((a, i) => (i === ASSETS.length - 1 && a === "pine.glb") ? "pine.glb#dup" : a);

const W = 512, H = 512;
const masks = [];
for (let i = 0; i < ASSETS.length; i++) {
  const page = await browser.newPage({ viewport: { width: 512, height: 512 } });
  await page.goto(`http://localhost:${port}/gates/design/spike/index.html?asset=${encodeURIComponent(ASSETS[i])}`, { waitUntil: "load", timeout: 30000 });
  try { await page.waitForFunction("window.__silDone===true", { timeout: 20000 }); } catch { /**/ }
  const err = await page.evaluate("window.__silErr || ''");
  const shot = await page.locator("#sil-canvas").screenshot();
  writeFileSync(join(OUT, `sil_${i}_${labels[i].replace(/[^a-z0-9]/gi, "_")}.png`), shot);
  const { data } = await sharp(shot).resize(W, H, { fit: "fill" }).greyscale().raw().toBuffer({ resolveWithObject: true });
  const mask = new Uint8Array(W * H); let fg = 0;
  for (let k = 0; k < W * H; k++) { if (data[k] > 50) { mask[k] = 1; fg++; } }
  masks.push({ label: labels[i], mask, fg, err: String(err) });
  console.error(`${labels[i].padEnd(34)} fg=${(100 * fg / (W * H)).toFixed(1)}%${err ? "  ERR " + err : ""}`);
  await page.close();
}

const iou = (a, b) => { let inter = 0, uni = 0; for (let k = 0; k < a.length; k++) { const u = a[k] | b[k], n = a[k] & b[k]; if (u) uni++; if (n) inter++; } return uni ? inter / uni : 1; };

const pine = masks.find((m) => m.label === "pine.glb");
const dup = masks.find((m) => m.label === "pine.glb#dup");
const detIoU = (pine && dup) ? iou(pine.mask, dup.mask) : NaN;

const distinct = masks.filter((m) => m.label !== "pine.glb#dup" && !m.err && m.fg > 100);
let pairs = 0, distinguishable = 0, maxIoU = 0, sumIoU = 0, maxPair = "";
const rows = [];
for (let i = 0; i < distinct.length; i++) {
  const r = [];
  for (let j = 0; j < distinct.length; j++) {
    const v = iou(distinct[i].mask, distinct[j].mask);
    r.push(v.toFixed(2));
    if (j > i) { pairs++; sumIoU += v; if (v < 0.9) distinguishable++; if (v > maxIoU) { maxIoU = v; maxPair = `${distinct[i].label}~${distinct[j].label}`; } }
  }
  rows.push(distinct[i].label.padEnd(30) + " " + r.join(" "));
}

console.log("\n=== SILHOUETTE SPIKE RESULT ===");
console.log(`determinism/clone IoU (pine vs pine#dup): ${Number(detIoU).toFixed(4)}  ${detIoU > 0.98 ? "PASS (deterministic + clone-detectable)" : "FAIL (non-deterministic!)"}`);
console.log(`distinctness: ${distinguishable}/${pairs} distinct pairs IoU<0.90 (ratio ${(distinguishable / Math.max(1, pairs)).toFixed(2)}); mean ${(sumIoU / Math.max(1, pairs)).toFixed(2)}, max ${maxIoU.toFixed(2)} (${maxPair})`);
console.log("labels: " + distinct.map((m) => m.label).join(", "));
console.log(rows.join("\n"));
console.log(`\nmasks written to ${OUT}/sil_*.png`);
await browser.close(); server.close();
