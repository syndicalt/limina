// Shoot the forest preview (tools/preview/forest.html) on the real GPU so the agent can SEE whether a
// dense+fogged+eye-level scene of the fetched assets approaches a Valenfield-style forest.
//   node tools/preview/forest.mjs <out.png> <canopy csv> <ground csv> [fog]
import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { join, resolve, extname, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { resolvePwc, resolveChrome } from "../_pw-resolve.mjs";
const require = createRequire(import.meta.url);
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const [outPng, canopy, ground, fog] = process.argv.slice(2);
if (!outPng) { console.error("usage: node tools/preview/forest.mjs <out.png> <canopy csv> <ground csv> [fog]"); process.exit(2); }
const MIME={".html":"text/html",".js":"text/javascript",".mjs":"text/javascript",".glb":"model/gltf-binary",".json":"application/json"};
const pwc=resolvePwc(), chrome=resolveChrome(); if(!pwc||!chrome){console.error("forest: no chromium");process.exit(2);}
const { chromium } = require(pwc);
const server = createServer((req,res)=>{ let p=decodeURIComponent((req.url||"/").split("?")[0]); if(p==="/")p="/index.html"; const f=join(REPO_ROOT,p); if(!f.startsWith(REPO_ROOT)||!existsSync(f)){res.writeHead(404);res.end();return;} res.writeHead(200,{"content-type":MIME[extname(f)]||"application/octet-stream"}); res.end(readFileSync(f)); });
await new Promise(r=>server.listen(0,r)); const port=server.address().port;
const W=1400,H=900;
const browser = await chromium.launch({ executablePath:chrome, headless:true, args:["--no-sandbox","--disable-dev-shm-usage","--use-gl=angle","--use-angle=gl","--enable-gpu","--ignore-gpu-blocklist"] });
try {
  const page = await browser.newPage({ viewport:{width:W,height:H} });
  page.on("pageerror", e=>console.error("PAGEERROR: "+e.message));
  const url = `http://localhost:${port}/tools/preview/forest.html?canopy=${encodeURIComponent(canopy||"")}&ground=${encodeURIComponent(ground||"")}&fog=${fog||""}&w=${W}&h=${H}`;
  await page.goto(url,{waitUntil:"load",timeout:30000});
  try { await page.waitForFunction("window.__forestDone===true",{timeout:40000}); } catch { console.error("forest: render did not finish in time"); }
  const loaded = await page.evaluate("window.__loaded||null"); const errs = await page.evaluate("window.__err||[]");
  if(errs.length) console.error("load errors:\n  "+errs.join("\n  "));
  console.error("forest loaded protos: "+JSON.stringify(loaded));
  await page.screenshot({ path: outPng });
  console.error("forest: wrote "+outPng);
} finally { await browser.close(); server.close(); }
