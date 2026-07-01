// SILHOUETTE DESIGN GATE (Phase 2b) — the real gate, built on the proven 2a spike. Renders a set of
// assets to deterministic flat-silhouette masks (headless real GPU) and runs gamestack's procgen-review
// "oatmeal" gate over the pairwise mask IoU: a set of perceptually-distinct assets PASSES; a clone-heavy
// or samey set HARD-FAILS. Emits a verdict in the gamestack JSON shape {pass, score, failures[]} that an
// adapter maps onto limina's GateReport. No model, no network — pure render + geometry.
//
//   import { runSilhouetteGate } from "./silhouette-gate.mjs"
//   const verdict = await runSilhouetteGate([{ label, asset }], opts)   // -> {pass, score, failures}

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { join, resolve, extname, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(here, "..", "..");

// Thresholds (procgen-review). IoU above CLONE = effectively the same silhouette; a pair is
// "distinguishable" when its IoU is below DISTINCT. Oatmeal = too few distinguishable pairs.
export const THRESHOLDS = { clone: 0.95, distinct: 0.9, oatmealRatio: 0.5, softRatio: 0.8 };

function resolvePwc() { if (process.env.PWC_PATH) return process.env.PWC_PATH; try { return require.resolve("playwright-core"); } catch { /**/ } const npx = join(process.env.HOME || "", ".npm", "_npx"); if (existsSync(npx)) for (const d of readdirSync(npx)) { const p = join(npx, d, "node_modules", "playwright-core"); if (existsSync(p)) return p; } return null; }
function resolveChrome() { if (process.env.CHROME_BIN && existsSync(process.env.CHROME_BIN)) return process.env.CHROME_BIN; const base = join(process.env.HOME || "", ".cache", "ms-playwright"); if (existsSync(base)) for (const d of readdirSync(base).filter((x) => x.startsWith("chromium-")).sort().reverse()) { const p = join(base, d, "chrome-linux64", "chrome"); if (existsSync(p)) return p; } return null; }

const MIME = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".glb": "model/gltf-binary", ".json": "application/json", ".css": "text/css", ".wasm": "application/wasm" };

/** Render each entry's asset to a 512² binary silhouette mask via the spike harness. Returns
 *  [{label, asset, mask:Uint8Array, fg, err}]. Deterministic: unlit, fixed ortho, no AA. */
export async function renderMasks(entries, opts = {}) {
  const pwc = resolvePwc(), chrome = resolveChrome();
  if (!pwc || !chrome) throw new Error("silhouette-gate: no chromium/playwright-core");
  const { chromium } = require(pwc);
  const sharp = require("sharp");
  const W = 512, H = 512;

  const server = createServer((req, res) => {
    let p = decodeURIComponent((req.url || "/").split("?")[0]);
    if (p === "/") p = "/index.html";
    const f = join(REPO_ROOT, p);
    if (!f.startsWith(REPO_ROOT) || !existsSync(f)) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { "content-type": MIME[extname(f)] || "application/octet-stream" });
    res.end(readFileSync(f));
  });
  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;
  const browser = await chromium.launch({ executablePath: chrome, headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage", "--use-gl=angle", "--use-angle=gl", "--enable-gpu", "--ignore-gpu-blocklist"] });

  const masks = [];
  try {
    for (const e of entries) {
      const page = await browser.newPage({ viewport: { width: W, height: H } });
      await page.goto(`http://localhost:${port}/gates/design/spike/index.html?asset=${encodeURIComponent(e.asset)}`, { waitUntil: "load", timeout: 30000 });
      try { await page.waitForFunction("window.__silDone===true", { timeout: 20000 }); } catch { /**/ }
      const err = String(await page.evaluate("window.__silErr || ''"));
      const shot = await page.locator("#sil-canvas").screenshot();
      const { data } = await sharp(shot).resize(W, H, { fit: "fill" }).greyscale().raw().toBuffer({ resolveWithObject: true });
      const mask = new Uint8Array(W * H); let fg = 0;
      for (let k = 0; k < W * H; k++) { if (data[k] > 50) { mask[k] = 1; fg++; } }
      masks.push({ label: e.label ?? e.asset, asset: e.asset, mask, fg, err });
      await page.close();
    }
  } finally { await browser.close(); server.close(); }
  return masks;
}

export function iou(a, b) { let inter = 0, uni = 0; for (let k = 0; k < a.length; k++) { const u = a[k] | b[k], n = a[k] & b[k]; if (u) uni++; if (n) inter++; } return uni ? inter / uni : 1; }

/** The verdict over already-rendered masks. {pass, score, failures:[{gate, detail}], stats}. */
export function silhouetteVerdict(masks, t = THRESHOLDS) {
  const failures = [];
  const broken = masks.filter((m) => m.err || m.fg < 100);
  if (broken.length) failures.push({ gate: "render", detail: `${broken.length} asset(s) failed to render a silhouette: ${broken.map((m) => m.label).join(", ")}` });
  const ok = masks.filter((m) => !m.err && m.fg >= 100);

  let pairs = 0, distinguishable = 0, clonePairs = [];
  for (let i = 0; i < ok.length; i++) for (let j = i + 1; j < ok.length; j++) {
    const v = iou(ok[i].mask, ok[j].mask);
    pairs++;
    if (v < t.distinct) distinguishable++;
    if (v >= t.clone) clonePairs.push(`${ok[i].label}~${ok[j].label} (IoU ${v.toFixed(2)})`);
  }
  const ratio = pairs ? distinguishable / pairs : 1;
  if (clonePairs.length) failures.push({ gate: "clone", detail: `${clonePairs.length} clone/near-clone pair(s): ${clonePairs.slice(0, 6).join("; ")}` });
  if (ratio < t.oatmealRatio) failures.push({ gate: "oatmeal", detail: `only ${distinguishable}/${pairs} pairs distinguishable (ratio ${ratio.toFixed(2)} < ${t.oatmealRatio}) — perceptual sameness` });
  else if (ratio < t.softRatio) failures.push({ gate: "oatmeal", detail: `thin variety: ${distinguishable}/${pairs} distinguishable (ratio ${ratio.toFixed(2)})` });

  // HARD failures: a render failure, any clone, or oatmeal (ratio<oatmealRatio). Thin variety is soft.
  const hard = failures.some((f) => f.gate === "render" || f.gate === "clone" || (f.gate === "oatmeal" && ratio < t.oatmealRatio));
  return { pass: !hard, score: Number(ratio.toFixed(3)), failures, stats: { pairs, distinguishable, clones: clonePairs.length } };
}

export async function runSilhouetteGate(entries, opts = {}) {
  return silhouetteVerdict(await renderMasks(entries, opts), opts.thresholds ?? THRESHOLDS);
}
