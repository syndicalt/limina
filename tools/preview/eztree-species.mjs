// Shoot tools/preview/eztree-species.html — a ROW of distinct ez-tree species (native materials).
// Uses SOFTWARE rendering (swiftshader) NOT the real GPU, to avoid contending with the user's
// live editor / WebGPU context. Slower but safe and sufficient for a look check.
//   node tools/preview/eztree-species.mjs [out.png]   (default: tools/preview/out/eztree-species.png)
import { existsSync, readFileSync, mkdirSync } from "node:fs";
import { createServer } from "node:http";
import { join, resolve, extname, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { resolvePwc, resolveChrome } from "../_pw-resolve.mjs";
const require = createRequire(import.meta.url);
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const outPng = resolve(process.argv[2] || join(REPO_ROOT, "tools/preview/out/eztree-species.png"));
mkdirSync(dirname(outPng), { recursive: true });
const MIME = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".glb": "model/gltf-binary", ".json": "application/json", ".png": "image/png" };
const pwc = resolvePwc(), chrome = resolveChrome();
if (!pwc || !chrome) { console.error("no chromium/playwright"); process.exit(2); }
const { chromium } = require(pwc);
const server = createServer((req, res) => {
  let p = decodeURIComponent((req.url || "/").split("?")[0]); if (p === "/") p = "/index.html";
  const f = join(REPO_ROOT, p);
  if (!f.startsWith(REPO_ROOT) || !existsSync(f)) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { "content-type": MIME[extname(f)] || "application/octet-stream" }); res.end(readFileSync(f));
});
await new Promise(r => server.listen(0, r));
const port = server.address().port;
// SOFTWARE rendering: swiftshader (NOT --use-angle=gl) so we never touch the real GPU.
const browser = await chromium.launch({ executablePath: chrome, headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage", "--use-gl=angle", "--use-angle=swiftshader"] });
try {
  const page = await browser.newPage({ viewport: { width: 1800, height: 900 } });
  page.on("pageerror", e => console.error("PAGEERROR: " + e.message));
  page.on("console", m => { if (m.type() === "error") console.error("CONSOLE.err: " + m.text()); });
  await page.goto(`http://localhost:${port}/tools/preview/eztree-species.html`, { waitUntil: "load", timeout: 60000 });
  try { await page.waitForFunction("window.__done===true", { timeout: 90000 }); } catch { console.error("timeout waiting for render"); }
  const placed = await page.evaluate("window.__placed ?? -1");
  console.error("eztree-species: placed " + placed + " trees");
  await page.screenshot({ path: outPng });
  console.error("eztree-species: wrote " + outPng);
} finally { await browser.close(); server.close(); }
