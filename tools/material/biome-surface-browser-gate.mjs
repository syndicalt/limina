// SwiftShader force-WebGL compile/readback for the B3 three-map, one-graph terrain consumer.
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
  console.error(`biome-surface-browser-gate FAIL: ${message}`);
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
const directory = await mkdtemp(join(tmpdir(), "limina-biome-surface-"));
const entry = `
import * as THREE from ${JSON.stringify(join(repo, "js/build/three.bundle.mjs"))};
import { buildBiomeSurfaceMaterial } from ${JSON.stringify(join(repo, "js/src/terrain/biome-surface-material.ts"))};
import { SURFACE_COMPOSITE_POLICY_VERSION, SURFACE_COMPOSITE_TILE_SCHEMA } from ${JSON.stringify(join(repo, "js/src/world/surface-composite-tile.mjs"))};
const W=384,H=256,canvas=document.createElement('canvas');canvas.width=W;canvas.height=H;document.body.appendChild(canvas);
const renderer=new THREE.WebGPURenderer({canvas,antialias:false,forceWebGL:true});await renderer.init();renderer.setSize(W,H,false);
function map(base,kind){const size=8,data=new Uint8Array(size*size*4);for(let y=0;y<size;y++)for(let x=0;x<size;x++){const o=(y*size+x)*4,n=((x^y)&1)*35;if(kind==='a'){data[o]=base[0]+n;data[o+1]=base[1]+n;data[o+2]=base[2]+n;}else if(kind==='n'){data[o]=128;data[o+1]=128;data[o+2]=255;}else{data[o]=230;data[o+1]=170+n;data[o+2]=0;}data[o+3]=255;}return data;}
function artifact(tx,base){return{schema:SURFACE_COMPOSITE_TILE_SCHEMA,source:{biomeFieldHash:'field',biomePackHash:'pack',terrainChunkHash:'terrain',policyVersion:SURFACE_COMPOSITE_POLICY_VERSION},coord:{tx,tz:0,lod:0},placement:{sizeM:8},resolution:{interior:6,gutter:1,total:8},maps:{albedo:{data:map(base,'a')},normal:{data:map(base,'n')},orm:{data:map(base,'o'),channels:'ao-roughness-metalness-grass-density'}},diagnostics:{runtimeTextureSamples:3}};}
const left=buildBiomeSurfaceMaterial(artifact(-1,[40,80,30])),right=buildBiomeSurfaceMaterial(artifact(0,[90,55,25]));
const geometry=new THREE.PlaneGeometry(8,8,16,16).rotateX(-Math.PI/2);const a=new THREE.Mesh(geometry,left.material),b=new THREE.Mesh(geometry,right.material);a.position.x=-4;b.position.x=4;
const scene=new THREE.Scene();scene.background=new THREE.Color(0x172027);scene.add(a,b,new THREE.HemisphereLight(0xc9e4ff,0x26391d,1.7));const sun=new THREE.DirectionalLight(0xffe2b8,4);sun.position.set(4,8,5);scene.add(sun);
const camera=new THREE.PerspectiveCamera(48,W/H,.1,100);camera.position.set(11,10,14);camera.lookAt(0,0,0);const target=new THREE.RenderTarget(W,H);renderer.setRenderTarget(target);await renderer.renderAsync(scene,camera);renderer.info.reset();await renderer.renderAsync(scene,camera);const calls=renderer.info.render.calls;const bytes=await renderer.readRenderTargetPixelsAsync(target,0,0,W,H);
let sum=0,sum2=0;for(let i=0;i<bytes.length;i+=4){const l=bytes[i]*.299+bytes[i+1]*.587+bytes[i+2]*.114;sum+=l;sum2+=l*l;}const count=bytes.length/4,mean=sum/count,stdev=Math.sqrt(Math.max(0,sum2/count-mean*mean));
// Global stdev is dominated by the fixed background and changes across SwiftShader revisions.
// Render each texture identity over the exact same proof geometry, plus an empty control, so a
// blank graph and a cloned identity each fail independently.
a.visible=false;b.visible=false;const proof=new THREE.Mesh(geometry,left.material);scene.add(proof);
async function proofPixels(material){proof.visible=material!==null;if(material!==null)proof.material=material;await renderer.renderAsync(scene,camera);await renderer.renderAsync(scene,camera);return renderer.readRenderTargetPixelsAsync(target,0,0,W,H);}
function difference(first,second){let changed=0,total=0;for(let i=0;i<first.length;i+=4){const delta=Math.abs(first[i]-second[i])+Math.abs(first[i+1]-second[i+1])+Math.abs(first[i+2]-second[i+2]);if(delta>3)changed++;total+=delta;}return{changed,meanRgbDelta:total/(first.length/4*3)};}
const emptyPixels=await proofPixels(null),leftPixels=await proofPixels(left.material),rightPixels=await proofPixels(right.material);
const leftVisible=difference(leftPixels,emptyPixels),rightVisible=difference(rightPixels,emptyPixels),identities=difference(leftPixels,rightPixels);
window.__biomeSurface={backend:'forceWebGL',calls,mean,stdev,programs:renderer.info.programs?.length??null,leftVisible,rightVisible,identities,pass:calls===2&&leftVisible.changed>1000&&rightVisible.changed>1000&&identities.changed>1000&&identities.meanRgbDelta>.25};`;
try {
  await build({
    stdin: { contents: entry, resolveDir: repo, sourcefile: "biome-surface-entry.ts", loader: "ts" },
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
    const result = await page
      .waitForFunction(() => window.__biomeSurface ?? false, { timeout: 30_000 })
      .then((handle) => handle.jsonValue());
    if (errors.length) fail(errors.slice(0, 6).join(" | "));
    if (!result.pass) fail(`render proof failed: ${JSON.stringify(result)}`);
    console.log(
      `biome-surface-browser-gate OK: forceWebGL rendered two texture identities through the shared three-sample TSL graph in ${result.calls} draws; ${result.identities.changed} identity pixels changed (mean RGB delta ${result.identities.meanRgbDelta.toFixed(2)}), legacy global stdev ${result.stdev.toFixed(2)}`,
    );
  } finally {
    await browser?.close();
    await new Promise((accept) => server.close(accept));
  }
} finally {
  await rm(directory, { recursive: true, force: true });
}
