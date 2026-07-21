// Render a LIT contact sheet of assets (real materials) so the agent can SEE what was fetched — quality,
// not just silhouette. Serves the repo root, renders tools/preview/contact.html?assets=…, screenshots it.
//   node tools/preview/contact.mjs <out.png> <a.glb,b.glb,…> [cols]
import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { join, resolve, extname, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { resolvePwc, resolveChrome } from "../_pw-resolve.mjs";

const require = createRequire(import.meta.url);
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const [outPng, list, cols] = process.argv.slice(2);
if (!outPng || !list) { console.error("usage: node tools/preview/contact.mjs <out.png> <a.glb,b.glb,…> [cols]"); process.exit(2); }

const MIME = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".glb": "model/gltf-binary", ".json": "application/json", ".css": "text/css" };

const pwc = resolvePwc(), chrome = resolveChrome();
if (!pwc || !chrome) { console.error("contact: no chromium/playwright-core"); process.exit(2); }
const { chromium } = require(pwc);

const server = createServer((req, res) => {
  let p = decodeURIComponent((req.url || "/").split("?")[0]); if (p === "/") p = "/index.html";
  const f = join(REPO_ROOT, p);
  if (!f.startsWith(REPO_ROOT) || !existsSync(f)) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { "content-type": MIME[extname(f)] || "application/octet-stream" }); res.end(readFileSync(f));
});
await new Promise((r) => server.listen(0, r));
const port = server.address().port;
const W = 1400, H = 1000;
const browser = await chromium.launch({ executablePath: chrome, headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage", "--use-gl=angle", "--use-angle=gl", "--enable-gpu", "--ignore-gpu-blocklist"] });
try {
  const page = await browser.newPage({ viewport: { width: W, height: H } });
  page.on("pageerror", (e) => console.error("PAGEERROR: " + e.message));
  page.on("console", (m) => { if (m.type() === "error") console.error("CONSOLE.err: " + m.text()); });
  const url = `http://localhost:${port}/tools/preview/contact.html?assets=${encodeURIComponent(list)}&cols=${cols || ""}&w=${W}&h=${H}`;
  await page.goto(url, { waitUntil: "load", timeout: 30000 });
  try { await page.waitForFunction("window.__contactDone===true", { timeout: 25000 }); } catch { }
  const errs = await page.evaluate("window.__contactErr || []");
  const loaded = await page.evaluate("window.__contactLoaded ?? -1");
  if (errs.length) console.error("contact load errors:\n  " + errs.join("\n  "));
  console.error(`contact: ${loaded} models loaded of ${list.split(",").length}`);
  await page.screenshot({ path: outPng });
  console.error("contact: wrote " + outPng);
} finally { await browser.close(); server.close(); }
