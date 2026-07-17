// SwiftShader force-WebGL compile/readback for depth-safe viewport water refraction.
// Exit 0 pass, 1 product failure, 2 browser unavailable. Never touches the NVIDIA adapter.
import { createRequire } from "node:module";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "../../js/node_modules/esbuild/lib/main.js";
import { resolveChrome, resolvePwc } from "../_pw-resolve.mjs";

const require = createRequire(import.meta.url), repo = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
function skip(message) { console.log(`SKIP: ${message}`); process.exit(2); }
function fail(message) { console.error(`water-scene-optics-browser-gate FAIL: ${message}`); process.exit(1); }
const pwc = resolvePwc(), chrome = resolveChrome(); if (!pwc || !chrome) skip("Playwright or Chromium is unavailable");
let chromium; try { ({ chromium } = require(pwc)); } catch (error) { skip(`Playwright is not loadable: ${error.message}`); }
const directory = await mkdtemp(join(tmpdir(), "limina-water-optics-"));
const entry = `
import * as THREE from ${JSON.stringify(join(repo, "js/build/three.bundle.mjs"))};
import { attachWaterMaterialAuxiliaries, createWaterMaterial } from ${JSON.stringify(join(repo, "js/src/render/water/material.ts"))};
const W=384,H=256,canvas=document.createElement('canvas');canvas.width=W;canvas.height=H;document.body.appendChild(canvas);
const renderer=new THREE.WebGPURenderer({canvas,antialias:false,forceWebGL:true});await renderer.init();renderer.setSize(W,H,false);
const scene=new THREE.Scene();scene.background=new THREE.Color(0x152331);
scene.add(new THREE.HemisphereLight(0xcde9ff,0x1b2419,2.2));const sun=new THREE.DirectionalLight(0xffe7bc,4);sun.position.set(5,9,4);scene.add(sun);
const floor=new THREE.Mesh(new THREE.PlaneGeometry(18,18).rotateX(-Math.PI/2),new THREE.MeshStandardMaterial({color:0xc5a76a,roughness:.8}));floor.position.y=-.7;scene.add(floor);
for(let x=-6;x<=6;x+=2){const box=new THREE.Mesh(new THREE.BoxGeometry(.65,.6,7),new THREE.MeshStandardMaterial({color:(x/2)%2===0?0xc34d3c:0x3f7bc2,roughness:.65}));box.position.set(x,-.35,0);scene.add(box);}
const geometry=new THREE.PlaneGeometry(12,10,32,32).rotateX(-Math.PI/2);
const plain=new THREE.Mesh(geometry,createWaterMaterial({color:0x2b5d72,kind:'basin',orientation:'xz',waveCount:4,sceneOptics:'none'}));plain.position.y=.02;plain.renderOrder=3;
const refracting=new THREE.Mesh(geometry,createWaterMaterial({color:0x2b5d72,kind:'basin',orientation:'xz',waveCount:4,sceneOptics:'refraction'}));refracting.position.y=.02;refracting.renderOrder=3;attachWaterMaterialAuxiliaries(refracting);
const reflecting=new THREE.Mesh(geometry,createWaterMaterial({color:0x2b5d72,kind:'basin',orientation:'xz',waveCount:4,sceneOptics:'refraction-reflection',reflectionScale:.25}));reflecting.position.y=.02;reflecting.renderOrder=3;attachWaterMaterialAuxiliaries(reflecting);
const foreground=new THREE.Mesh(new THREE.SphereGeometry(.8,24,16),new THREE.MeshStandardMaterial({color:0xf4d35e}));foreground.position.set(0,1.1,1.2);scene.add(foreground);
const camera=new THREE.PerspectiveCamera(48,W/H,.1,100);camera.position.set(7,7,10);camera.lookAt(0,0,0);
const target=new THREE.RenderTarget(W,H);
async function frame(mesh){scene.add(mesh);renderer.setRenderTarget(target);await renderer.renderAsync(scene,camera);await renderer.renderAsync(scene,camera);const bytes=await renderer.readRenderTargetPixelsAsync(target,0,0,W,H);scene.remove(mesh);return bytes;}
const a=await frame(plain),b=await frame(refracting),c=await frame(reflecting);let changed=0,sum=0,reflectionChanged=0,reflectionSum=0;for(let i=0;i<a.length;i+=4){const d=Math.abs(a[i]-b[i])+Math.abs(a[i+1]-b[i+1])+Math.abs(a[i+2]-b[i+2]);if(d>12)changed++;sum+=d;const r=Math.abs(b[i]-c[i])+Math.abs(b[i+1]-c[i+1])+Math.abs(b[i+2]-c[i+2]);if(r>12)reflectionChanged++;reflectionSum+=r;}
const material=refracting.material,reflectionMaterial=reflecting.material;window.__waterOptics={backend:'forceWebGL',changed,meanDelta:sum/(a.length/4),reflectionChanged,reflectionMeanDelta:reflectionSum/(a.length/4),refraction:material.userData.liminaWaterSceneDepthRefraction===true,reflection:reflectionMaterial.userData.liminaWaterPlanarReflection===true,reflectionTargets:reflecting.children.length,backdrop:material.backdropNode?.constructor?.name??null,pass:changed>500&&sum/(a.length/4)>0.5&&reflectionChanged>100&&reflectionSum/(a.length/4)>.1&&material.userData.liminaWaterSceneDepthRefraction===true&&reflectionMaterial.userData.liminaWaterPlanarReflection===true&&reflecting.children.length===1};`;
try {
  await build({ stdin: { contents: entry, resolveDir: repo, sourcefile: "water-optics-entry.ts", loader: "ts" }, bundle: true, format: "esm", outfile: join(directory, "entry.js"), logLevel: "silent" });
  await writeFile(join(directory, "index.html"), "<!doctype html><body style='margin:0'><script type='module' src='/entry.js'></script></body>\n");
  const server = createServer(async (request, response) => { try { const pathname = decodeURIComponent(new URL(request.url ?? "/", "http://localhost").pathname); if (pathname === "/favicon.ico") { response.writeHead(204); response.end(); return; } const path = join(directory, pathname === "/" ? "index.html" : pathname); const bytes = await readFile(path); response.writeHead(200, { "content-type": extname(path) === ".html" ? "text/html" : "text/javascript" }); response.end(bytes); } catch { response.writeHead(404); response.end("not found"); } });
  await new Promise((accept) => server.listen(0, "127.0.0.1", accept)); let browser;
  try {
    browser = await chromium.launch({ executablePath: chrome, args: ["--no-sandbox", "--disable-dev-shm-usage", "--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
    const page = await browser.newPage({ viewport: { width: 384, height: 256 } }), errors = [];
    page.on("pageerror", (error) => errors.push(error.message)); page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
    await page.goto(`http://127.0.0.1:${server.address().port}/`, { waitUntil: "domcontentloaded", timeout: 15_000 });
    let result; try { result = await page.waitForFunction(() => window.__waterOptics ?? false, { timeout: 30_000 }).then((handle) => handle.jsonValue()); }
    catch (error) { fail(errors.length ? errors.slice(0, 6).join(" | ") : `browser result timeout: ${error.message}`); }
    if (errors.length) fail(errors.slice(0, 6).join(" | ")); if (!result.pass) fail(`refraction proof failed: ${JSON.stringify(result)}`);
    console.log(`water-scene-optics-browser-gate OK: forceWebGL compiled depth-safe refraction + owned planar reflection; refraction changed ${result.changed} pixels (mean ${result.meanDelta.toFixed(2)}), reflection ${result.reflectionChanged} (mean ${result.reflectionMeanDelta.toFixed(2)})`);
  } finally { await browser?.close(); await new Promise((accept) => server.close(accept)); }
} finally { await rm(directory, { recursive: true, force: true }); }
