// Force-WebGL browser runtime gate for the vegetation.grassField CPU fallback.
// Exit 0 pass, 1 product failure, 2 browser unavailable.

import { createRequire } from "node:module";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "../../js/node_modules/esbuild/lib/main.js";
import { resolveChrome, resolvePwc } from "../_pw-resolve.mjs";

const require = createRequire(import.meta.url);
const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
function skip(message) { console.log(`SKIP: ${message}`); process.exit(2); }
function fail(message) { console.error(`grass-field-browser-gate FAIL: ${message}`); process.exit(1); }
const pwc = resolvePwc(), chrome = resolveChrome();
if (!pwc || !chrome) skip("Playwright or Chromium is unavailable");
let chromium;
try { ({ chromium } = require(pwc)); } catch (error) { skip(`Playwright is not loadable: ${error.message}`); }

const directory = await mkdtemp(join(tmpdir(), "limina-grass-field-"));
const entry = `
import * as THREE from ${JSON.stringify(join(repo, "js/build/three.bundle.mjs"))};
import { GrassFieldStreamManager } from ${JSON.stringify(join(repo, "js/src/render/grass-field-render.ts"))};
import { INTERACTIVE_TEMPERATE_MEADOW_PACKAGE } from ${JSON.stringify(join(repo, "js/src/content/grass/interactive-temperate-meadow.ts"))};
const W=384,H=256,canvas=document.createElement("canvas"); canvas.width=W; canvas.height=H; document.body.appendChild(canvas);
const renderer=new THREE.WebGPURenderer({canvas,antialias:false,forceWebGL:true}); await renderer.init(); renderer.setSize(W,H,false);
const scene=new THREE.Scene(); scene.background=new THREE.Color(0x17242b);
const camera=new THREE.PerspectiveCamera(50,W/H,0.1,100);
const n=17,heights=new Float32Array(n*n),paintMat=new Uint8Array(n*n).fill(2),paintW=new Float32Array(n*n).fill(1);
for(let row=0;row<n;row++) for(let col=0;col<n;col++) heights[row*n+col]=Math.sin(col*.3)*.04+Math.cos(row*.24)*.03;
const tile={nrows:n,ncols:n,origin:[0,0,0],scale:[12,1,12],heights,paintMat,paintW};
let forbiddenCompute=0;
const manager=new GrassFieldStreamManager(scene,{tileSize:12,radius:0,renderer,visualPackage:INTERACTIVE_TEMPERATE_MEADOW_PACKAGE,source:()=>({seed:19,spacing:.6,elevationMin:-1}),
  buildComputeBatch:()=>{forbiddenCompute++;throw new Error("forceWebGL constructed native compute");}});
manager.noteTile("0:0",{tx:0,tz:0},tile); const launch=manager.update(1,1); await manager.settle();
if(launch.grown!==1||forbiddenCompute!==0||manager.takeErrors().length!==0) throw new Error("forceWebGL did not select the streamed CPU fallback");
const meshes=[]; scene.traverse((object)=>{if(object.isInstancedMesh)meshes.push(object);});
const instances=meshes.reduce((sum,mesh)=>sum+mesh.count,0);
if(meshes.length<1||instances<100||manager.grassKeys().size!==1) throw new Error("stream manager did not publish the bounded CPU fallback field: meshes="+meshes.length+", instances="+instances);
scene.add(new THREE.HemisphereLight(0xc8e8ff,0x263718,2.5));
const sun=new THREE.DirectionalLight(0xffefc8,5); sun.position.set(5,9,4); scene.add(sun);
const target=new THREE.RenderTarget(W,H);
async function pixels(position){camera.position.set(...position);camera.lookAt(0,0.35,0);renderer.setRenderTarget(target);await renderer.renderAsync(scene,camera);await renderer.renderAsync(scene,camera);return renderer.readRenderTargetPixelsAsync(target,0,0,W,H);}
function stats(bytes){let sum=0,sum2=0;const n=bytes.length/4;for(let i=0;i<bytes.length;i+=4){const l=bytes[i]*.299+bytes[i+1]*.587+bytes[i+2]*.114;sum+=l;sum2+=l*l;}const mean=sum/n;return{mean,stdev:Math.sqrt(Math.max(0,sum2/n-mean*mean))};}
const a=stats(await pixels([5,3.2,6])),b=stats(await pixels([-4,1.8,3]));renderer.setRenderTarget(null);await renderer.renderAsync(scene,camera);
window.__grassFieldResult={backend:"forceWebGL",a,b,meshes:meshes.length,instances,pass:a.stdev>3&&b.stdev>3&&a.mean>2&&b.mean>2};
`;

try {
  await build({ stdin: { contents: entry, resolveDir: repo, sourcefile: "grass-field-entry.ts", loader: "ts" }, bundle: true, format: "esm", outfile: join(directory, "entry.js"), logLevel: "silent" });
  await writeFile(join(directory, "index.html"), "<!doctype html><body style='margin:0'><script type='module' src='/entry.js'></script></body>\n");
  const server = createServer(async (request, response) => {
    try {
      const pathname = decodeURIComponent(new URL(request.url ?? "/", "http://localhost").pathname);
      if (pathname === "/favicon.ico") { response.writeHead(204); response.end(); return; }
      const path = join(directory, pathname === "/" ? "index.html" : pathname);
      if (!(path === join(directory, "index.html") || path.startsWith(directory + "/"))) throw new Error("forbidden");
      const bytes = await readFile(path);
      response.writeHead(200, { "content-type": extname(path) === ".html" ? "text/html" : "text/javascript" }); response.end(bytes);
    } catch { response.writeHead(404); response.end("not found"); }
  });
  await new Promise((accept) => server.listen(0, "127.0.0.1", accept));
  const port = server.address().port;
  let browser;
  try {
    browser = await chromium.launch({ executablePath: chrome, args: ["--no-sandbox", "--disable-dev-shm-usage", "--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
    const page = await browser.newPage({ viewport: { width: 384, height: 256 } });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
    await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: "domcontentloaded", timeout: 15_000 });
    let result;
    try {
      result = await page.waitForFunction(() => window.__grassFieldResult ?? false, { timeout: 30_000 }).then((handle) => handle.jsonValue());
    } catch (error) {
      fail(errors.length > 0 ? errors.slice(0, 6).join(" | ") : `browser result timeout: ${error.message}`);
    }
    if (errors.length > 0) fail(errors.slice(0, 4).join(" | "));
    if (!result.pass) fail(`two-angle fallback proof is blank/flat: ${JSON.stringify(result)}`);
    console.log(`grass-field-browser-gate OK: forceWebGL streamed and rendered ${result.instances} CPU-fallback tuft instances without constructing compute; two-angle stdev ${result.a.stdev.toFixed(2)}, ${result.b.stdev.toFixed(2)}`);
  } finally {
    await browser?.close();
    await new Promise((accept) => server.close(accept));
  }
} finally {
  await rm(directory, { recursive: true, force: true });
}
