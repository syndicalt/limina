import { existsSync, readFileSync, mkdirSync } from "node:fs";
import { createServer } from "node:http";
import { join, resolve, extname, dirname } from "node:path";
import { fileURLToPath as _f } from "node:url";
import { createRequire } from "node:module";
import { resolvePwc, resolveChrome } from "../_pw-resolve.mjs";
const require = createRequire(import.meta.url);
const ROOT = resolve(dirname(_f(import.meta.url)), "..", "..");
const outDir = resolve(ROOT, "tools/preview/out");
mkdirSync(outDir, { recursive: true });
const MIME = { ".html":"text/html", ".js":"text/javascript", ".mjs":"text/javascript", ".css":"text/css", ".json":"application/json", ".wasm":"application/wasm", ".glb":"model/gltf-binary" };
const COOP = { "Cross-Origin-Opener-Policy":"same-origin", "Cross-Origin-Embedder-Policy":"require-corp", "Cross-Origin-Resource-Policy":"cross-origin" };
const srv = createServer((req,res)=>{ let p=decodeURIComponent((req.url||"/").split("?")[0]); if(p==="/")p="/index.html"; const f=join(ROOT,p); if(!f.startsWith(ROOT)||!existsSync(f)){res.writeHead(404,COOP);res.end();return;} res.writeHead(200,{ "content-type":MIME[extname(f)]||"application/octet-stream", ...COOP }); res.end(readFileSync(f)); });
await new Promise(r=>srv.listen(0,r));
const port = srv.address().port;
const { chromium } = require(resolvePwc());
const b = await chromium.launch({ executablePath: resolveChrome(), headless:true, args:["--no-sandbox","--disable-dev-shm-usage","--use-gl=angle","--use-angle=gl","--enable-gpu","--ignore-gpu-blocklist","--enable-features=SharedArrayBuffer"] });
const page = await b.newPage({ viewport:{ width:1280, height:800 } });
page.on("pageerror", e=>console.error("PAGEERR: "+e.message));
page.on("response", r=>{ if(r.status()===404 && /\.glb/.test(r.url())) console.error("404: "+r.url()); });
page.on("console", m=>{ const t=m.text(); if(/authoringFail|error|throw/i.test(t)) console.error("CON: "+t.slice(0,300)); });
// argv: [shots] [gapMs] [sceneUrl] [outPrefix] — sceneUrl (a /tools/preview/... path) targets an
// authored scene JSON like engine-authored.mjs does; default renders the hardcoded default scene.
const sceneUrl = process.argv[4] ? `?scene=${encodeURIComponent(process.argv[4])}` : "";
const outPrefix = process.argv[5] || "village";
await page.goto(`http://localhost:${port}/tools/preview/engine-authored.html${sceneUrl}`, { waitUntil:"load", timeout:40000 });
try { await page.waitForFunction("window.__done===true", { timeout: 50000 }); } catch { console.error("TIMEOUT (froze?)"); }
for (const l of await page.evaluate("window.__log||[]")) console.error("LOG: "+l);
for (const e of await page.evaluate("window.__err||[]")) console.error("ERR: "+e);
// The orbit camera auto-spins; screenshot at intervals to capture distinct angles.
const shots = Number(process.argv[2] || 4);
const gap = Number(process.argv[3] || 7000);
for (let i = 1; i <= shots; i++) {
  const out = join(outDir, `${outPrefix}-${i}.png`);
  await page.locator("#limina-canvas").screenshot({ path: out });
  console.error("wrote "+out);
  if (i < shots) await page.waitForTimeout(gap);
}
await b.close(); srv.close();
