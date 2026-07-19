// SwiftShader force-WebGL compile/readback gate for B2 BatchedMesh foliage + pure-TSL impostors.
// Exit 0 pass, 1 product failure, 2 browser unavailable.
import { createRequire } from "node:module";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "../../js/node_modules/esbuild/lib/main.js";
import { resolveChrome, resolvePwc } from "../_pw-resolve.mjs";

const require = createRequire(import.meta.url),
  repo = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
function skip(message) {
  console.log(`SKIP: ${message}`);
  process.exit(2);
}
function fail(message) {
  console.error(`tree-population-browser-gate FAIL: ${message}`);
  process.exit(1);
}
const pwc = resolvePwc(),
  chrome = resolveChrome();
if (!pwc || !chrome) skip("Playwright or Chromium is unavailable");
let chromium;
try {
  ({ chromium } = require(pwc));
} catch (error) {
  skip(`Playwright is not loadable: ${error.message}`);
}
const directory = await mkdtemp(join(tmpdir(), "limina-tree-population-"));
const entry = `
import * as THREE from ${JSON.stringify(join(repo, "js/build/three.bundle.mjs"))};
import { buildTreeFoliageMaterial } from ${JSON.stringify(join(repo, "js/src/render/tree-foliage-material.ts"))};
import { buildTreeImpostorMaterial } from ${JSON.stringify(join(repo, "js/src/render/tree-impostor-material.ts"))};
import { TreeSpeciesBatchAdapter } from ${JSON.stringify(join(repo, "js/src/render/tree-population-batch.ts"))};
const W=384,H=256,canvas=document.createElement('canvas');canvas.width=W;canvas.height=H;document.body.appendChild(canvas);
const renderer=new THREE.WebGPURenderer({canvas,antialias:false,forceWebGL:true});await renderer.init();renderer.setSize(W,H,false);
function atlas(kind){const size=64,data=new Uint8Array(size*size*4);for(let y=0;y<size;y++)for(let x=0;x<size;x++){const lx=x%32-15.5,ly=y%32-15.5,o=(y*size+x)*4,inside=(lx*lx/120+ly*ly/190)<1;if(inside){data[o]=kind==='a'?55:128;data[o+1]=kind==='a'?145:128;data[o+2]=kind==='a'?45:110;data[o+3]=255;}}const t=new THREE.DataTexture(data,size,size);t.needsUpdate=true;return t;}
const albedo=atlas('a'),normalDepth=atlas('n');
const branch=new THREE.MeshStandardNodeMaterial({color:0x68401f,roughness:.85});
const leaves=buildTreeFoliageMaterial(new THREE.MeshStandardMaterial({color:0x4c8a38,roughness:.8}),{sssStrength:.28});
const impostor=buildTreeImpostorMaterial({albedo,normalDepth,grid:2,cellSize:32,alphaCutoff:.4});
const adapter=new TreeSpeciesBatchAdapter('oak',3,{speciesId:'oak',capacity:3,
 branch:{full:new THREE.CylinderGeometry(.45,.65,7,10),reduced:new THREE.CylinderGeometry(.4,.6,7,6),material:branch},
 foliage:{full:new THREE.IcosahedronGeometry(2.6,2),reduced:new THREE.IcosahedronGeometry(2.5,1),material:leaves},
 impostorGeometry:new THREE.PlaneGeometry(5.5,9).translate(0,4.5,0),impostorMaterial:impostor,atlasTextures:2,atlasBytes:32768});
const tree=(ordinal,rung,x,z)=>({speciesId:'oak',ordinal,rung,x,y:0,z,yaw:ordinal*.7,scale:1,localX:0,localZ:0});
adapter.publish([tree(0,0,-3,0),tree(1,1,3,0),tree(2,2,0,-4)],0,0);
const scene=new THREE.Scene();scene.background=new THREE.Color(0x17252d);scene.add(adapter.root,new THREE.HemisphereLight(0xc9e4ff,0x26391d,1.8));const sun=new THREE.DirectionalLight(0xffe2b8,4);sun.position.set(5,9,4);scene.add(sun);
const camera=new THREE.PerspectiveCamera(48,W/H,.1,100),target=new THREE.RenderTarget(W,H);
async function pixels(p){camera.position.set(...p);camera.lookAt(0,3,0);camera.updateMatrixWorld();renderer.setRenderTarget(target);await renderer.renderAsync(scene,camera);renderer.info.reset();await renderer.renderAsync(scene,camera);const calls=renderer.info.render.calls;const data=await renderer.readRenderTargetPixelsAsync(target,0,0,W,H);return{data,calls};}
function stats(bytes){let sum=0,sum2=0,n=bytes.length/4;for(let i=0;i<bytes.length;i+=4){const l=bytes[i]*.299+bytes[i+1]*.587+bytes[i+2]*.114;sum+=l;sum2+=l*l;}const mean=sum/n;return{mean,stdev:Math.sqrt(Math.max(0,sum2/n-mean*mean))};}
const pa=await pixels([9,6,12]),pb=await pixels([-10,5,8]),a=stats(pa.data),b=stats(pb.data);renderer.setRenderTarget(null);await renderer.renderAsync(scene,camera);
window.__treeResult={backend:'forceWebGL',a,b,calls:Math.max(pa.calls,pb.calls),objects:adapter.root.children.length,pass:a.stdev>3&&b.stdev>3&&a.mean>2&&b.mean>2&&adapter.root.children.length===5&&Math.max(pa.calls,pb.calls)<=5};
`;
try {
  await build({
    stdin: { contents: entry, resolveDir: repo, sourcefile: "tree-population-entry.ts", loader: "ts" },
    bundle: true,
    format: "esm",
    outfile: join(directory, "entry.js"),
    logLevel: "silent",
  });
  await writeFile(
    join(directory, "index.html"),
    "<!doctype html><body style='margin:0'><script type='module' src='/entry.js'></script></body>\n",
  );
  const server = createServer(async (request, response) => {
    try {
      const pathname = decodeURIComponent(new URL(request.url ?? "/", "http://localhost").pathname);
      if (pathname === "/favicon.ico") {
        response.writeHead(204);
        response.end();
        return;
      }
      const path = join(directory, pathname === "/" ? "index.html" : pathname);
      if (!(path === join(directory, "index.html") || path.startsWith(directory + "/"))) throw new Error("forbidden");
      const bytes = await readFile(path);
      response.writeHead(200, { "content-type": extname(path) === ".html" ? "text/html" : "text/javascript" });
      response.end(bytes);
    } catch {
      response.writeHead(404);
      response.end("not found");
    }
  });
  await new Promise((accept) => server.listen(0, "127.0.0.1", accept));
  let browser;
  try {
    browser = await chromium.launch({
      executablePath: chrome,
      args: [
        "--no-sandbox",
        "--disable-dev-shm-usage",
        "--use-gl=angle",
        "--use-angle=swiftshader",
        "--enable-unsafe-swiftshader",
      ],
    });
    const page = await browser.newPage({ viewport: { width: 384, height: 256 } }),
      errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error") errors.push(message.text());
    });
    await page.goto(`http://127.0.0.1:${server.address().port}/`, { waitUntil: "domcontentloaded", timeout: 15_000 });
    let result;
    try {
      result = await page
        .waitForFunction(() => window.__treeResult ?? false, { timeout: 30_000 })
        .then((handle) => handle.jsonValue());
    } catch (error) {
      fail(errors.length ? errors.slice(0, 6).join(" | ") : `browser timeout: ${error.message}`);
    }
    if (errors.length) fail(errors.slice(0, 6).join(" | "));
    if (!result.pass) fail(`render proof failed: ${JSON.stringify(result)}`);
    console.log(
      `tree-population-browser-gate OK: forceWebGL compiled five true 3-rung instanced draws with TSL foliage+impostor in ${result.calls} calls; two-angle stdev ${result.a.stdev.toFixed(2)}/${result.b.stdev.toFixed(2)}`,
    );
  } finally {
    await browser?.close();
    await new Promise((accept) => server.close(accept));
  }
} finally {
  await rm(directory, { recursive: true, force: true });
}
