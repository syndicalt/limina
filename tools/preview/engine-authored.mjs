import { existsSync, readFileSync, mkdirSync } from "node:fs";
import { createServer } from "node:http";
import { join, resolve, extname, dirname } from "node:path";
import { fileURLToPath as _f } from "node:url";
import { createRequire } from "node:module";
import { resolvePwc, resolveChrome } from "../_pw-resolve.mjs";
const require = createRequire(import.meta.url);
const ROOT = resolve(dirname(_f(import.meta.url)), "..", "..");
const out = process.argv[2] || resolve(ROOT, "tools/preview/out/mvp-scene.png");
const sceneArg = process.argv[3]; // optional scene JSON path (served from ROOT), e.g. /tools/preview/authored-library.json
mkdirSync(dirname(out), { recursive: true });
const MIME = { ".html":"text/html", ".js":"text/javascript", ".mjs":"text/javascript", ".css":"text/css", ".json":"application/json", ".wasm":"application/wasm", ".glb":"model/gltf-binary" };
const COOP = { "Cross-Origin-Opener-Policy":"same-origin", "Cross-Origin-Embedder-Policy":"require-corp", "Cross-Origin-Resource-Policy":"cross-origin" };
const srv = createServer((req,res)=>{ let p=decodeURIComponent((req.url||"/").split("?")[0]); if(p==="/")p="/index.html"; const f=join(ROOT,p); if(!f.startsWith(ROOT)||!existsSync(f)){res.writeHead(404,COOP);res.end();return;} res.writeHead(200,{ "content-type":MIME[extname(f)]||"application/octet-stream", ...COOP }); res.end(readFileSync(f)); });
await new Promise(r=>srv.listen(0,r));
const port = srv.address().port;
const { chromium } = require(resolvePwc());
// Editor is closed → REAL GPU (angle-gl) for fidelity; forceWebGL uses the WebGL2 backend.
const b = await chromium.launch({ executablePath: resolveChrome(), headless:true, args:["--no-sandbox","--disable-dev-shm-usage","--use-gl=angle","--use-angle=gl","--enable-gpu","--ignore-gpu-blocklist","--enable-features=SharedArrayBuffer"] });
const page = await b.newPage({ viewport:{ width:1280, height:800 } });
page.on("pageerror", e=>console.error("PAGEERR: "+e.message));
page.on("response", r=>{ if(r.status()===404) console.error("404: "+r.url()); });
page.on("worker", w=>{ console.error("WORKER: "+w.url().slice(-40)); w.on("console", m=>console.error("WK."+m.type()+": "+m.text().slice(0,200))); });
page.on("console", m=>{ const t=m.text(); if(m.type()==="error"||/worker|error|throw|fail/i.test(t)) console.error("CON."+m.type()+": "+t.slice(0,200)); });
await page.goto(`http://localhost:${port}/tools/preview/engine-authored.html`+(sceneArg?("?scene="+encodeURIComponent(sceneArg)):""), { waitUntil:"load", timeout:40000 });
try { await page.waitForFunction("window.__done===true", { timeout: 50000 }); } catch { console.error("TIMEOUT (froze?)"); }
for (const l of await page.evaluate("window.__log||[]")) console.error("LOG: "+l);
for (const s of await page.evaluate("window.__status||[]")) console.error("STATUS: "+s);
for (const e of await page.evaluate("window.__err||[]")) console.error("ERR: "+e);
await page.locator("#limina-canvas").screenshot({ path: out });
console.error("wrote "+out);
await b.close(); srv.close();
