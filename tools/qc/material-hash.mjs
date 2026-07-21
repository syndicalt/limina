// Material determinism probe — renders every village material's albedo + normal texture in a real
// browser (via material-hash.html), hashes the pixels, and prints them as JSON. A refactor of the
// procedural paint functions should NOT move these hashes; run before/after and diff to prove it.
//
//   node tools/qc/material-hash.mjs                 # print current hashes
//   node tools/qc/material-hash.mjs golden.json     # diff current against a saved golden (exit 1 on drift)
//
// Needs a Chromium (resolved via tools/_pw-resolve.mjs) — a browser is required because the paint
// functions draw on a canvas 2D context, which Node lacks.
import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { join, extname } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const ROOT = join(new URL(".", import.meta.url).pathname, "../..");
const golden = process.argv[2];
const MIME = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".json": "application/json", ".wasm": "application/wasm" };

const srv = createServer((req, res) => {
  let p = decodeURIComponent((req.url || "/").split("?")[0]); if (p === "/") p = "/index.html";
  const f = join(ROOT, p);
  if (!f.startsWith(ROOT) || !existsSync(f)) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { "content-type": MIME[extname(f)] || "application/octet-stream" });
  res.end(readFileSync(f));
});
await new Promise((r) => srv.listen(0, r));
const port = srv.address().port;

const { resolvePwc, resolveChrome } = await import(join(ROOT, "tools/_pw-resolve.mjs"));
const { chromium } = require(resolvePwc());
const b = await chromium.launch({ executablePath: resolveChrome(), headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
const page = await b.newPage();
page.on("pageerror", (e) => console.error("PAGEERR: " + e.message));
await page.goto(`http://localhost:${port}/tools/qc/material-hash.html`, { waitUntil: "load", timeout: 60000 });
await page.waitForFunction("window.__done===true", { timeout: 60000 });
for (const e of await page.evaluate("window.__err||[]")) console.error("ERR: " + e);
const hashes = await page.evaluate("window.__hashes");
await b.close(); srv.close();

if (!hashes) { console.error("no hashes produced"); process.exit(2); }
if (!golden) { console.log(JSON.stringify(hashes, null, 2)); process.exit(0); }

const want = JSON.parse(readFileSync(golden, "utf8"));
let drift = 0;
for (const k of Object.keys(want)) {
  if (JSON.stringify(want[k]) !== JSON.stringify(hashes[k])) { console.error(`CHANGED ${k}: ${JSON.stringify(want[k])} → ${JSON.stringify(hashes[k])}`); drift++; }
}
console.log(drift === 0 ? `✅ byte-identical — ${Object.keys(want).length} materials match golden` : `✗ ${drift} material(s) drifted from golden`);
process.exit(drift === 0 ? 0 : 1);
