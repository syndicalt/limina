import { createRequire } from "node:module";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { dirname, extname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { build } from "../../js/node_modules/esbuild/lib/main.js";
import { resolveChrome, resolvePwc } from "../_pw-resolve.mjs";

const require = createRequire(import.meta.url);
const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const directory = await mkdtemp(join(tmpdir(), "limina-temperate-capture-"));
const output = resolve(repo, process.env.LIMINA_CAPTURE_OUTPUT ?? "assets/qc/internal/temperate-fidelity-engine.png");
const sceneAuthority = JSON.parse(await readFile(join(repo, "art-direction/temperate-fidelity-scene.json"), "utf8"));
const [captureWidth, captureHeight] = sceneAuthority.presentation.minimumResolution;
const shot = process.env.LIMINA_CAPTURE_SHOT ?? "forest-river";
const waterDebug = process.env.LIMINA_CAPTURE_WATER_DEBUG ?? "";
const captureBackend = process.env.LIMINA_CAPTURE_BACKEND ?? "swiftshader";
if (captureBackend !== "swiftshader" && captureBackend !== "hardware") {
  throw new RangeError("LIMINA_CAPTURE_BACKEND must be 'swiftshader' or 'hardware'");
}
const captureTimeoutMs = Number(process.env.LIMINA_CAPTURE_TIMEOUT_MS ?? 300_000);
if (!Number.isSafeInteger(captureTimeoutMs) || captureTimeoutMs < 30_000 || captureTimeoutMs > 900_000) {
  throw new RangeError("LIMINA_CAPTURE_TIMEOUT_MS must be an integer in [30000, 900000]");
}
const types = { ".html": "text/html", ".js": "text/javascript", ".json": "application/json", ".bin": "application/octet-stream", ".glb": "model/gltf-binary", ".hdr": "application/octet-stream" };
await build({ entryPoints: [join(repo, "tools/preview/temperate-fidelity-capture.ts")], bundle: true, format: "esm",
  outfile: join(directory, "entry.js"), logLevel: "silent", loader: { ".ts": "ts" } });
await writeFile(join(directory, "index.html"), "<!doctype html><body><script type='module' src='/entry.js'></script></body>\n");
const server = createServer(async (request, response) => {
  try {
    const pathname = decodeURIComponent(new URL(request.url ?? "/", "http://localhost").pathname);
    if (pathname === "/favicon.ico") { response.writeHead(204); response.end(); return; }
    const target = pathname === "/" ? join(directory, "index.html") : pathname === "/entry.js" ? join(directory, "entry.js") : join(repo, pathname);
    if (!(target.startsWith(directory + "/") || target.startsWith(repo + "/"))) throw new Error("forbidden");
    const bytes = await readFile(target); response.writeHead(200, { "content-type": types[extname(target)] ?? "application/octet-stream" }); response.end(bytes);
  } catch { response.writeHead(404); response.end("not found"); }
});
await new Promise((accept) => server.listen(0, "127.0.0.1", accept));
let browser;
try {
  const pwc = resolvePwc(), chrome = resolveChrome(); if (!pwc || !chrome) throw new Error("Playwright or Chromium is unavailable");
  const { chromium } = require(pwc);
  const browserArgs = captureBackend === "hardware"
    ? ["--no-sandbox", "--disable-dev-shm-usage", "--ignore-gpu-blocklist", "--use-gl=angle", "--use-angle=gl"]
    : ["--no-sandbox", "--disable-dev-shm-usage", "--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--disable-gpu"];
  browser = await chromium.launch({ executablePath: chrome, args: browserArgs });
  const page = await browser.newPage({ viewport: { width: captureWidth, height: captureHeight }, deviceScaleFactor: 1 });
  const errors = []; page.on("pageerror", (error) => errors.push(error.message)); page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
  await page.goto(`http://127.0.0.1:${server.address().port}/?shot=${encodeURIComponent(shot)}&waterDebug=${encodeURIComponent(waterDebug)}`, { waitUntil: "domcontentloaded", timeout: 30_000 });
  await page.waitForFunction(() => window.__captureReady || window.__captureError, undefined, { timeout: captureTimeoutMs });
  const result = await page.evaluate(() => ({ ready: window.__captureReady, error: window.__captureError }));
  if (result.error || errors.length) throw new Error(result.error ?? errors.slice(0, 6).join(" | "));
  const gpu = await page.evaluate(() => {
    const canvas = document.querySelector("canvas");
    const gl = canvas?.getContext("webgl2") ?? canvas?.getContext("webgl");
    if (!gl) return { vendor: "unavailable", renderer: "unavailable" };
    const debug = gl.getExtension("WEBGL_debug_renderer_info");
    return debug ? { vendor: String(gl.getParameter(debug.UNMASKED_VENDOR_WEBGL)),
      renderer: String(gl.getParameter(debug.UNMASKED_RENDERER_WEBGL)) }
      : { vendor: String(gl.getParameter(gl.VENDOR)), renderer: String(gl.getParameter(gl.RENDERER)) };
  });
  if (captureBackend === "hardware" && /swiftshader|llvmpipe|lavapipe|software/i.test(`${gpu.vendor} ${gpu.renderer}`)) {
    throw new Error(`hardware capture resolved a software renderer: ${gpu.vendor} / ${gpu.renderer}`);
  }
  await mkdir(dirname(output), { recursive: true });
  await page.locator("canvas").screenshot({ path: output });
  console.log(JSON.stringify({ output, captureBackend, gpu, ...result.ready }, null, 2));
} finally {
  await browser?.close(); await new Promise((accept) => server.close(accept)); await rm(directory, { recursive: true, force: true });
}
