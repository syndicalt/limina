// Production SwiftShader/force-WebGL pixel gate for the real generated-river render path.
// Exit 0 pass, 1 product failure, 2 browser unavailable. Never touches the NVIDIA adapter.
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
const viewport = Object.freeze({ width: 480, height: 320 });
function skip(message) { console.log(`SKIP: ${message}`); process.exit(2); }
function fail(message) { console.error(`generated-river-browser-gate FAIL: ${message}`); process.exit(1); }

const pwc = resolvePwc(), chrome = resolveChrome();
if (!pwc || !chrome) skip("Playwright or Chromium is unavailable");
let chromium;
try { ({ chromium } = require(pwc)); }
catch (error) { skip(`Playwright is not loadable: ${error.message}`); }

const directory = await mkdtemp(join(tmpdir(), "limina-generated-river-"));
const entry = `
import * as THREE from ${JSON.stringify(join(repo, "js/build/three.bundle.mjs"))};
import { mountGeneratedWaterResource } from ${JSON.stringify(join(repo, "js/src/render/water/generated-water-renderer.ts"))};
import { VisibleWaterManager } from ${JSON.stringify(join(repo, "js/src/render/water/visible-water-manager.ts"))};
import { DEFAULT_RENDER_QUALITY_PROFILES } from ${JSON.stringify(join(repo, "js/src/render/quality.ts"))};

const W = 480, H = 320;
const canvas = document.createElement("canvas");
canvas.width = W; canvas.height = H; document.body.appendChild(canvas);
const renderer = new THREE.WebGPURenderer({ canvas, antialias: false, forceWebGL: true });
await renderer.init(); renderer.setSize(W, H, false);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;

// Curved, downhill generated reach. Its channel depth has two deliberately separated regimes,
// while its banks and bed come from the exact sampler supplied to mountGeneratedWaterResource.
const samples = [];
for (let x = 6; x <= 126; x += 2) {
  const z = 40 + 10 * Math.sin(x * 0.055) + 2.2 * Math.sin(x * 0.137);
  const width = 9 + 1.4 * Math.sin(x * 0.047 + 0.8);
  const surface = 4.6 - x * 0.015;
  samples.push({ x, z, width, surface });
}
function smoothstep(a, b, value) {
  const t = Math.max(0, Math.min(1, (value - a) / (b - a)));
  return t * t * (3 - 2 * t);
}
function channelDepth(x) {
  // ~0.35 m upstream, transitioning to ~2.45 m downstream. The high-pass periodicity sample
  // is taken only after this transition, so the depth ramp cannot masquerade as stripe noise.
  return 0.35 + 2.1 * smoothstep(40, 68, x);
}
function nearestSample(x, z) {
  let best = samples[0], distance = Infinity;
  for (const sample of samples) {
    const candidate = Math.hypot(x - sample.x, z - sample.z);
    if (candidate < distance) { best = sample; distance = candidate; }
  }
  return { sample: best, distance };
}
function terrainHeight(x, z) {
  const { sample, distance } = nearestSample(x, z);
  const depth = channelDepth(sample.x);
  const bed = sample.surface - depth;
  const bank = sample.surface + 0.75 + 0.12 * Math.sin(x * 0.09) * Math.cos(z * 0.11);
  const rise = smoothstep(sample.width * 0.28, sample.width * 0.72, distance);
  return bed + (bank - bed) * rise;
}

const scene = new THREE.Scene(); scene.background = new THREE.Color(0x9ab6c3);
scene.add(new THREE.HemisphereLight(0xcce2ee, 0x26351f, 2.0));
const sun = new THREE.DirectionalLight(0xffd2a0, 3.2); sun.position.set(95, 72, 18); scene.add(sun);
const terrainGeometry = new THREE.PlaneGeometry(136, 88, 136, 88).rotateX(-Math.PI / 2);
const terrainPosition = terrainGeometry.getAttribute("position");
const terrainColors = new Float32Array(terrainPosition.count * 3);
const grass = new THREE.Color(0x526d35), bank = new THREE.Color(0x877957), bed = new THREE.Color(0x554738);
for (let index = 0; index < terrainPosition.count; index++) {
  const x = terrainPosition.getX(index) + 68, z = terrainPosition.getZ(index) + 44;
  const y = terrainHeight(x, z); terrainPosition.setY(index, y);
  const { sample, distance } = nearestSample(x, z);
  const color = distance < sample.width * 0.32 ? bed : distance < sample.width * 0.72 ? bank : grass;
  terrainColors[index * 3] = color.r; terrainColors[index * 3 + 1] = color.g; terrainColors[index * 3 + 2] = color.b;
}
terrainGeometry.setAttribute("color", new THREE.BufferAttribute(terrainColors, 3));
terrainGeometry.computeVertexNormals();
const terrain = new THREE.Mesh(terrainGeometry, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.92 }));
terrain.position.set(68, 0, 44); scene.add(terrain);

// A small amount of irregular opaque bank detail makes the real refraction path observable.
for (let index = 0; index < 18; index++) {
  const x = 10 + index * 6.4, sample = nearestSample(x, 40).sample;
  const side = index % 2 === 0 ? -1 : 1, z = sample.z + side * sample.width * 0.72;
  const rock = new THREE.Mesh(new THREE.DodecahedronGeometry(0.45 + (index % 3) * 0.13, 0),
    new THREE.MeshStandardMaterial({ color: index % 2 === 0 ? 0x735b3f : 0x6b7550, roughness: 0.88 }));
  rock.position.set(x, terrainHeight(x, z) + 0.38, z); scene.add(rock);
}

const resource = {
  artifactHash: "sha256:" + "c".repeat(64),
  field: { placement: { originX: 0, originZ: 0 }, rows: 137, cols: 137, cellSizeM: 1,
    seaLevelM: -10, oceanMask: new Uint8Array(137 * 137) },
  sampleTerrainHeight: (x, z) => x >= 0 && x <= 136 && z >= 0 && z <= 88 ? terrainHeight(x, z) : null,
  topology: { schema: "limina.hydrology-generated-water/v1", version: 1, basins: [], reaches: [{
    id: "gen-r-2-9", class: "river", order: 4,
    points: samples.map(({ x, z }) => [x, z]), widths: samples.map(({ width }) => width),
    terrainElevationsM: samples.map((sample) => sample.surface - channelDepth(sample.x)),
    surfaceElevationsM: samples.map(({ surface }) => surface), waterfalls: [],
  }] },
};
const manager = new VisibleWaterManager(scene, DEFAULT_RENDER_QUALITY_PROFILES.balanced.water);
const mounted = mountGeneratedWaterResource(resource, manager);
if (mounted.reachCount !== 1 || manager.entries().length !== 1) throw new Error("real generated reach did not mount");
const river = manager.entries()[0].mesh;

const camera = new THREE.PerspectiveCamera(48, W / H, 0.1, 400);
camera.position.set(65, 92, 105); camera.lookAt(68, 1.8, 42); camera.updateMatrixWorld();
const target = new THREE.RenderTarget(W, H, { depthBuffer: true });
async function frame(visible) {
  river.visible = visible; renderer.setRenderTarget(target);
  await renderer.renderAsync(scene, camera);
  await renderer.renderAsync(scene, camera);
  return await renderer.readRenderTargetPixelsAsync(target, 0, 0, W, H);
}
const baseline = await frame(false);
await new Promise((resolve) => setTimeout(resolve, 850));
const baselineRepeat = await frame(false);
const first = await frame(true);
await new Promise((resolve) => setTimeout(resolve, 850));
const second = await frame(true);

function rgbDelta(a, b, pixel) {
  const offset = pixel * 4;
  return Math.abs(a[offset] - b[offset]) + Math.abs(a[offset + 1] - b[offset + 1]) + Math.abs(a[offset + 2] - b[offset + 2]);
}
const mask = new Uint8Array(W * H);
let riverPixels = 0, temporalPixels = 0, temporalSum = 0;
let staticTemporalSum = 0;
for (let pixel = 0; pixel < W * H; pixel++) {
  staticTemporalSum += rgbDelta(baseline, baselineRepeat, pixel);
  if (rgbDelta(baseline, first, pixel) > 12) { mask[pixel] = 1; riverPixels++; }
  if (mask[pixel]) {
    const delta = rgbDelta(first, second, pixel); temporalSum += delta;
    if (delta > 5) temporalPixels++;
  }
}

function project(sample) {
  const point = new THREE.Vector3(sample.x, sample.surface + 0.02, sample.z).project(camera);
  return { x: Math.round((point.x * 0.5 + 0.5) * (W - 1)), y: Math.round((point.y * 0.5 + 0.5) * (H - 1)) };
}
function sampleDisk(bytes, sample, radius = 2) {
  const center = project(sample); let r = 0, g = 0, b = 0, baseDelta = 0, count = 0;
  for (let dy = -radius; dy <= radius; dy++) for (let dx = -radius; dx <= radius; dx++) {
    const x = center.x + dx, y = center.y + dy;
    if (x < 0 || x >= W || y < 0 || y >= H) continue;
    // These samples are projected from the verified generated reach centreline itself. Do not
    // reuse the stronger whole-frame segmentation threshold here: genuinely shallow/transmissive
    // water is expected to differ less from its visible bed than deep water does.
    const pixel = y * W + x;
    const offset = pixel * 4; r += bytes[offset]; g += bytes[offset + 1]; b += bytes[offset + 2];
    baseDelta += rgbDelta(baseline, bytes, pixel); count++;
  }
  return count ? { r: r / count, g: g / count, b: b / count, baseDelta: baseDelta / count, count } : null;
}
function groupMean(group) {
  const valid = group.filter(Boolean); if (!valid.length) return null;
  return { r: valid.reduce((sum, v) => sum + v.r, 0) / valid.length,
    g: valid.reduce((sum, v) => sum + v.g, 0) / valid.length,
    b: valid.reduce((sum, v) => sum + v.b, 0) / valid.length,
    baseDelta: valid.reduce((sum, v) => sum + v.baseDelta, 0) / valid.length,
    samples: valid.length };
}
const shallow = groupMean(samples.filter((sample) => sample.x >= 18 && sample.x <= 34).map((sample) => sampleDisk(first, sample)));
const deep = groupMean(samples.filter((sample) => sample.x >= 82 && sample.x <= 108).map((sample) => sampleDisk(first, sample)));
const depthColorDelta = shallow && deep ? Math.hypot(deep.r - shallow.r, deep.g - shallow.g, deep.b - shallow.b) : 0;
const depthEffectDelta = shallow && deep ? Math.abs(deep.baseDelta - shallow.baseDelta) : 0;

function luminance(value) { return value.r * 0.2126 + value.g * 0.7152 + value.b * 0.0722; }
function periodicity(values) {
  const residual = values.map((value, index) => {
    let sum = 0, count = 0;
    for (let offset = -4; offset <= 4; offset++) if (index + offset >= 0 && index + offset < values.length) {
      sum += values[index + offset]; count++;
    }
    return value - sum / count;
  });
  let energy = 0; for (const value of residual) energy += value * value;
  let peak = 0, peakLag = 0;
  for (let lag = 5; lag <= Math.min(20, residual.length - 4); lag++) {
    let numerator = 0, left = 0, right = 0;
    for (let index = 0; index + lag < residual.length; index++) {
      numerator += residual[index] * residual[index + lag];
      left += residual[index] ** 2; right += residual[index + lag] ** 2;
    }
    const correlation = Math.abs(numerator) / Math.sqrt(Math.max(1e-9, left * right));
    if (correlation > peak) { peak = correlation; peakLag = lag; }
  }
  return { peak, peakLag, energy };
}
const flowSamples = samples.filter((sample) => sample.x >= 72 && sample.x <= 122)
  .map((sample) => sampleDisk(first, sample, 1)).filter(Boolean).map(luminance);
const stripe = periodicity(flowSamples);
const syntheticRibs = periodicity(flowSamples.map((_, index) => 128 + 72 * Math.sin(index * Math.PI * 2 / 8)));

const temporalMean = riverPixels ? temporalSum / riverPixels : 0;
const staticTemporalMean = staticTemporalSum / (W * H);
const pass = riverPixels > 1200
  // Natural deep-water flow is a low-amplitude whole-surface signal. The earlier high-delta
  // count was dominated by animated white bank foam; require a clean static control plus measured
  // river-wide motion instead of rewarding that artifact.
  && staticTemporalMean < 0.02 && temporalPixels > 30 && temporalMean > 0.6
  && shallow?.samples >= 5 && deep?.samples >= 8
  && shallow.baseDelta > 0.5 && deep.baseDelta > 4
  && depthColorDelta > 4 && depthEffectDelta > 2
  && flowSamples.length >= 20 && stripe.energy > 1
  && stripe.peak < 0.82 && syntheticRibs.peak > 0.92;
window.__generatedRiverGate = { backend: "forceWebGL", mountedKeys: mounted.mountedKeys.length,
  riverPixels, temporalPixels, temporalMean, staticTemporalMean, shallow, deep, depthColorDelta, depthEffectDelta,
  flowSampleCount: flowSamples.length, stripePeak: stripe.peak, stripePeakLag: stripe.peakLag,
  stripeEnergy: stripe.energy, syntheticRibPeak: syntheticRibs.peak, pass };
`;

try {
  await build({ stdin: { contents: entry, resolveDir: repo, sourcefile: "generated-river-browser-entry.ts", loader: "ts" },
    bundle: true, format: "esm", outfile: join(directory, "entry.js"), logLevel: "silent" });
  await writeFile(join(directory, "index.html"), "<!doctype html><body style='margin:0'><script type='module' src='/entry.js'></script></body>\n");
  const server = createServer(async (request, response) => {
    try {
      const pathname = decodeURIComponent(new URL(request.url ?? "/", "http://localhost").pathname);
      if (pathname === "/favicon.ico") { response.writeHead(204); response.end(); return; }
      const path = join(directory, pathname === "/" ? "index.html" : pathname);
      const bytes = await readFile(path);
      response.writeHead(200, { "content-type": extname(path) === ".html" ? "text/html" : "text/javascript" }); response.end(bytes);
    } catch { response.writeHead(404); response.end("not found"); }
  });
  await new Promise((accept) => server.listen(0, "127.0.0.1", accept));
  let browser;
  try {
    browser = await chromium.launch({ executablePath: chrome, args: ["--no-sandbox", "--disable-dev-shm-usage",
      "--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
    const page = await browser.newPage({ viewport }), errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
    await page.goto(`http://127.0.0.1:${server.address().port}/`, { waitUntil: "domcontentloaded", timeout: 15_000 });
    let result;
    try { result = await page.waitForFunction(() => window.__generatedRiverGate ?? false, { timeout: 45_000 }).then((handle) => handle.jsonValue()); }
    catch (error) { fail(errors.length ? errors.slice(0, 6).join(" | ") : `browser result timeout: ${error.message}`); }
    if (errors.length) fail(errors.slice(0, 6).join(" | "));
    if (!result.pass) fail(`pixel proof failed: ${JSON.stringify(result)}`);
    console.log(`generated-river-browser-gate OK: real generated reach changed ${result.riverPixels} river pixels; `
      + `${result.temporalPixels} animated (mean delta ${result.temporalMean.toFixed(2)}, static control ${result.staticTemporalMean.toFixed(3)}); depth colour/effect deltas `
      + `${result.depthColorDelta.toFixed(2)}/${result.depthEffectDelta.toFixed(2)}; stripe autocorrelation `
      + `${result.stripePeak.toFixed(3)} at lag ${result.stripePeakLag} (synthetic sine ribs ${result.syntheticRibPeak.toFixed(3)})`);
  } finally {
    await browser?.close(); await new Promise((accept) => server.close(accept));
  }
} finally {
  await rm(directory, { recursive: true, force: true });
}
