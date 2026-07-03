// Browser baker: run ez-tree in headless Chromium (where leaf/bark TEXTURES + alpha export
// correctly, unlike Node), export each archetype to a TEXTURED GLB, and write to assets/trees/.
//   node tools/bake-trees-browser.mjs
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { createServer } from "node:http";
import { join, resolve, extname, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { resolvePwc, resolveChrome } from "./_pw-resolve.mjs";
const require = createRequire(import.meta.url);
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = join(REPO_ROOT, "assets", "trees");
const MIME = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".json": "application/json", ".png": "image/png", ".jpg": "image/jpeg" };
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
const browser = await chromium.launch({ executablePath: chrome, headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage", "--use-gl=angle", "--enable-gpu", "--ignore-gpu-blocklist"] });
try {
  const page = await browser.newPage();
  page.on("pageerror", e => console.error("PAGEERROR: " + e.message));
  page.on("console", m => { if (m.type() === "error") console.error("CONSOLE.err: " + m.text()); });
  await page.goto(`http://localhost:${port}/tools/preview/bake-glb.html`, { waitUntil: "load", timeout: 60000 });
  await page.waitForFunction("window.__done===true", { timeout: 90000 });
  const glbs = await page.evaluate("window.__glbs");
  mkdirSync(OUT_DIR, { recursive: true });
  const manifest = { generator: "ez-tree (browser, textured)", species: { spruce: [], pine: [], birch: [] } };
  for (const g of glbs) {
    writeFileSync(join(OUT_DIR, g.file), Buffer.from(g.b64, "base64"));
    const species = g.file.split("-")[0];
    manifest.species[species].push(g.file);
    console.log(`${g.file}: ${(g.bytes / 1024).toFixed(1)} KB (textured)`);
  }
  writeFileSync(join(OUT_DIR, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  console.log("wrote " + glbs.length + " textured archetypes + manifest");
} finally { await browser.close(); server.close(); }
