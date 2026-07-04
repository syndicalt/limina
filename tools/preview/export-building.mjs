import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { createServer } from "node:http";
import { join, resolve, extname, dirname } from "node:path";
import { fileURLToPath as _f } from "node:url";
import { createRequire } from "node:module";
import { resolvePwc, resolveChrome } from "../_pw-resolve.mjs";
const require = createRequire(import.meta.url);
const ROOT = resolve(dirname(_f(import.meta.url)), "..", "..");
// argv: [style] [outGlb]
const style = process.argv[2] || "nordic castle";
const outGlb = resolve(ROOT, process.argv[3] || "tools/preview/out/keep.glb");
mkdirSync(dirname(outGlb), { recursive: true });
const MIME = { ".html":"text/html", ".js":"text/javascript", ".mjs":"text/javascript", ".json":"application/json", ".wasm":"application/wasm", ".glb":"model/gltf-binary" };
const srv = createServer((req,res)=>{ let p=decodeURIComponent((req.url||"/").split("?")[0]); if(p==="/")p="/index.html"; const f=join(ROOT,p); if(!f.startsWith(ROOT)||!existsSync(f)){res.writeHead(404);res.end();return;} res.writeHead(200,{ "content-type":MIME[extname(f)]||"application/octet-stream" }); res.end(readFileSync(f)); });
await new Promise(r=>srv.listen(0,r));
const port = srv.address().port;
const { chromium } = require(resolvePwc());
// Export doesn't render — swiftshader is fine and avoids GPU contention.
const b = await chromium.launch({ executablePath: resolveChrome(), headless:true, args:["--no-sandbox","--disable-dev-shm-usage","--use-gl=angle","--use-angle=swiftshader"] });
const page = await b.newPage();
page.on("pageerror", e=>console.error("PAGEERR: "+e.message));
await page.goto(`http://localhost:${port}/tools/preview/export-building.html?style=`+encodeURIComponent(style), { waitUntil:"load", timeout:40000 });
await page.waitForFunction("window.__done===true", { timeout: 40000 });
const err = await page.evaluate("window.__err||''");
if (err) { console.error(err); await b.close(); srv.close(); process.exit(1); }
for (const l of await page.evaluate("window.__log||[]")) console.error("LOG: "+l);
const b64 = await page.evaluate("window.__glb");
const bounds = await page.evaluate("window.__bounds");
const bytes = Buffer.from(b64, "base64");
writeFileSync(outGlb, bytes);
const id = outGlb.slice(ROOT.length+1).replace(/^.*\//,"").replace(/\.glb$/,"");
const card = { id, name: style + " (agent-authored)", kind: "glb", source: "village.mjs buildStandalone baked via GLTFExporter", file: outGlb.slice(ROOT.length+1), boundsM: bounds, tags: ["building", style.split(/\s+/)].flat() };
writeFileSync(outGlb.replace(/\.glb$/, ".card.json"), JSON.stringify(card, null, 2));
console.error("wrote " + outGlb + " (" + bytes.length + " bytes) bounds=" + JSON.stringify(bounds) + " + card");
await b.close(); srv.close();
