// Force-WebGL browser compile/readback gate for the A3 shared surface sampler. Uses the real
// ambientCG pack and compares POM against an otherwise-identical anti-tiled control at two angles.
// Exit 0 pass, 1 product failure, 2 browser unavailable.

import { createRequire } from "node:module";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "../../js/node_modules/esbuild/lib/main.js";
import { resolveChrome, resolvePwc } from "../_pw-resolve.mjs";

const require = createRequire(import.meta.url);
const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const types = { ".html": "text/html", ".js": "text/javascript", ".jpg": "image/jpeg", ".png": "image/png" };

function skip(message) { console.log(`SKIP: ${message}`); process.exit(2); }
function fail(message) { console.error(`material-surface-browser-gate FAIL: ${message}`); process.exit(1); }

const pwc = resolvePwc();
const chrome = resolveChrome();
if (!pwc || !chrome) skip("Playwright or Chromium is unavailable");
let chromium;
try { ({ chromium } = require(pwc)); } catch (error) { skip(`Playwright is not loadable: ${error.message}`); }

const directory = await mkdtemp(join(tmpdir(), "limina-material-surface-"));
const entry = `
import * as THREE from ${JSON.stringify(join(repo, "js/build/three.bundle.mjs"))};
import { MaterialRegistry } from ${JSON.stringify(join(repo, "js/src/materials/material-registry.ts"))};

const W = 384, H = 256;
const canvas = document.createElement("canvas"); canvas.width = W; canvas.height = H; document.body.appendChild(canvas);
const renderer = new THREE.WebGPURenderer({ canvas, antialias: false, forceWebGL: true });
await renderer.init(); renderer.setSize(W, H, false);
const loader = new THREE.TextureLoader();
const paths = ["albedo", "normal", "roughness", "occlusion", "displacement"];
const files = { albedo: "albedo.jpg", normal: "normal.jpg", roughness: "roughness.jpg", occlusion: "occlusion.jpg", displacement: "displacement.jpg" };
const loaded = {};
for (const key of paths) {
  const texture = await loader.loadAsync("/assets/materials/forest-ground/" + files[key]);
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.minFilter = THREE.LinearMipmapLinearFilter; texture.magFilter = THREE.LinearFilter;
  if (key === "albedo") texture.colorSpace = THREE.SRGBColorSpace;
  loaded[key] = texture;
}
const registry = new MaterialRegistry();
const base = { scale: 0.65, normalStrength: 1, sharpness: 4, metalness: 0, roughness: 0.85, occlusionStrength: 0.8, antiTiling: true };
registry.define("pom", { ...base, triplanar: false, parallax: { heightScale: 0.09, minLayers: 8, maxLayers: 16, fadeStart: 20, fadeEnd: 40 } }, loaded, {});
registry.define("control", { ...base, triplanar: false }, loaded, {});
registry.define("tri", { ...base, triplanar: true, parallax: { heightScale: 0.07, minLayers: 8, maxLayers: 16, fadeStart: 20, fadeEnd: 40 } }, loaded, {});
const scene = new THREE.Scene(); scene.background = new THREE.Color(0x172027);
const camera = new THREE.PerspectiveCamera(48, W / H, 0.1, 100);
const ground = new THREE.Mesh(new THREE.PlaneGeometry(8, 8, 24, 24), registry.build("pom")); ground.rotation.x = -Math.PI / 2; scene.add(ground);
const rock = new THREE.Mesh(new THREE.IcosahedronGeometry(1.15, 3), registry.build("tri")); rock.position.set(0, 1.15, 0); rock.scale.set(1.4, 1, 1.1); scene.add(rock);
const sun = new THREE.DirectionalLight(0xfff1d2, 4); sun.position.set(4, 7, 3); scene.add(sun, new THREE.HemisphereLight(0xb8d4ff, 0x263718, 1.4));
const target = new THREE.RenderTarget(W, H);
async function pixels(material, position) {
  ground.material = material; camera.position.set(...position); camera.lookAt(0, 0.25, 0); camera.updateMatrixWorld();
  renderer.setRenderTarget(target); await renderer.renderAsync(scene, camera); await renderer.renderAsync(scene, camera);
  return renderer.readRenderTargetPixelsAsync(target, 0, 0, W, H);
}
function stats(a, b) {
  let difference = 0, sum = 0, sum2 = 0; const count = a.length / 4;
  for (let i = 0; i < a.length; i += 4) {
    const lum = a[i] * 0.299 + a[i + 1] * 0.587 + a[i + 2] * 0.114;
    const other = b[i] * 0.299 + b[i + 1] * 0.587 + b[i + 2] * 0.114;
    difference += Math.abs(lum - other); sum += lum; sum2 += lum * lum;
  }
  const mean = sum / count; return { meanDifference: difference / count, stdev: Math.sqrt(Math.max(0, sum2 / count - mean * mean)) };
}
const pom = registry.build("pom"), control = registry.build("control");
const angleA = stats(await pixels(pom, [5.2, 3.2, 6.4]), await pixels(control, [5.2, 3.2, 6.4]));
const angleB = stats(await pixels(pom, [-5.0, 2.4, 4.2]), await pixels(control, [-5.0, 2.4, 4.2]));
renderer.setRenderTarget(null); ground.material = pom; await renderer.renderAsync(scene, camera);
window.__renderSurfaceAngle = async (position) => {
  renderer.setRenderTarget(null); ground.material = pom; camera.position.set(...position); camera.lookAt(0, 0.25, 0); camera.updateMatrixWorld();
  await renderer.renderAsync(scene, camera); await renderer.renderAsync(scene, camera); return true;
};
window.__surfaceResult = { angleA, angleB, backend: "forceWebGL", pass: angleA.stdev > 3 && angleB.stdev > 3 && angleA.meanDifference > 0.15 && angleB.meanDifference > 0.15 };
`;

try {
  await build({ stdin: { contents: entry, resolveDir: repo, sourcefile: "material-surface-entry.ts", loader: "ts" }, bundle: true, format: "esm", outfile: join(directory, "entry.js"), logLevel: "silent" });
  await writeFile(join(directory, "index.html"), "<!doctype html><body style='margin:0'><script type='module' src='/entry.js'></script></body>\n");
  const server = createServer(async (request, response) => {
    try {
      const pathname = decodeURIComponent(new URL(request.url ?? "/", "http://localhost").pathname);
      if (pathname === "/favicon.ico") { response.writeHead(204); response.end(); return; }
      const path = pathname.startsWith("/assets/") ? join(repo, pathname) : join(directory, pathname === "/" ? "index.html" : pathname);
      if (!(path.startsWith(repo + "/assets/") || path.startsWith(directory + "/") || path === join(directory, "index.html"))) throw new Error("forbidden path");
      const bytes = await readFile(path);
      response.writeHead(200, { "content-type": types[extname(path)] ?? "application/octet-stream" }); response.end(bytes);
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
    const result = await page.waitForFunction(() => window.__surfaceResult ?? false, { timeout: 30_000 }).then((handle) => handle.jsonValue());
    if (errors.length > 0) fail(errors.slice(0, 4).join(" | "));
    if (!result.pass) fail(`two-angle proof did not separate POM from control: ${JSON.stringify(result)}`);
    const evidenceDirectory = process.env.LIMINA_MATERIAL_SURFACE_EVIDENCE_DIR;
    if (evidenceDirectory) {
      await mkdir(evidenceDirectory, { recursive: true });
      for (const [name, position] of [["angle-a", [5.2, 3.2, 6.4]], ["angle-b", [-5.0, 2.4, 4.2]]]) {
        await page.evaluate((value) => window.__renderSurfaceAngle(value), position);
        await page.locator("canvas").screenshot({ path: join(evidenceDirectory, `${name}.png`) });
      }
      await writeFile(join(evidenceDirectory, "evidence.json"), `${JSON.stringify(result, null, 2)}\n`);
    }
    console.log(`material-surface-browser-gate OK: forceWebGL compiled real-pack UV/triplanar POM; two-angle diffs ${result.angleA.meanDifference.toFixed(3)}, ${result.angleB.meanDifference.toFixed(3)}`);
  } finally {
    await browser?.close();
    await new Promise((accept) => server.close(accept));
  }
} finally {
  await rm(directory, { recursive: true, force: true });
}
