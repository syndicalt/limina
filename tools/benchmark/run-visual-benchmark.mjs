#!/usr/bin/env node
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, extname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveChrome, resolvePwc } from "../_pw-resolve.mjs";
import {
  BenchmarkValidationError, loadAndValidateBenchmark, resolveProjectFile, resolveProjectOutputDirectory,
} from "./visual-benchmark.mjs";

const MIME = {
  ".css": "text/css; charset=utf-8", ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8", ".jsonl": "application/x-ndjson; charset=utf-8", ".wasm": "application/wasm",
};

export class BenchmarkEnvironmentError extends Error {
  constructor(message) { super(message); this.name = "BenchmarkEnvironmentError"; }
}

function parseArgs(argv) {
  const args = { project: ".", manifest: "benchmarks/grey-field.visual.json" };
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index];
    if (flag === "--project" || flag === "--manifest") {
      if (index + 1 >= argv.length) throw new BenchmarkValidationError([`${flag} requires a value`]);
      args[flag.slice(2)] = argv[++index];
    } else throw new BenchmarkValidationError([`unknown argument: ${flag}`]);
  }
  return args;
}

function percentile(sorted, q) {
  if (sorted.length === 0) return null;
  const position = (sorted.length - 1) * q;
  const lower = Math.floor(position), upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

function summarizeIntervals(intervals) {
  const sorted = [...intervals].sort((a, b) => a - b);
  const mean = sorted.length ? sorted.reduce((sum, value) => sum + value, 0) / sorted.length : null;
  return { samples: sorted.length, mean, median: percentile(sorted, 0.5), p95: percentile(sorted, 0.95), max: sorted.at(-1) ?? null };
}

function staticServer(projectRoot) {
  const server = createServer((request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      const projectPath = decodeURIComponent(url.pathname).replace(/^\/+/, "");
      const file = resolveProjectFile(projectRoot, projectPath || "dist/index.html");
      response.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream" });
      response.end(readFileSync(file));
    } catch {
      response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      response.end("not found\n");
    }
  });
  return server;
}

export async function runVisualBenchmark(projectRoot, manifestPath) {
  const root = resolve(projectRoot);
  const { manifest } = loadAndValidateBenchmark(root, manifestPath);
  const pwcPath = resolvePwc();
  const chromePath = resolveChrome();
  if (!pwcPath || !chromePath) {
    throw new BenchmarkEnvironmentError(
      `visual benchmark validated but cannot run: ${!pwcPath ? "playwright-core is unavailable" : "Chromium is unavailable"}. ` +
      "Set PWC_PATH and CHROME_BIN to explicit installations.",
    );
  }
  const require = createRequire(import.meta.url);
  let chromium;
  try { ({ chromium } = require(pwcPath)); }
  catch (error) { throw new BenchmarkEnvironmentError(`cannot load playwright-core from ${pwcPath}: ${error.message}`); }

  const server = staticServer(root);
  await new Promise((accept, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", accept); });
  const port = server.address().port;
  let browser;
  try {
    browser = await chromium.launch({ executablePath: chromePath, headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage", "--use-gl=angle", "--use-angle=gl", "--enable-gpu", "--ignore-gpu-blocklist"] });
    const context = await browser.newContext({ viewport: { width: manifest.viewport.width, height: manifest.viewport.height }, deviceScaleFactor: manifest.viewport.deviceScaleFactor });
    const page = await context.newPage();
    // The scaffold page has a header and the player auto-spins by default. A benchmark needs the
    // declared viewport to be the capture surface and the exported orbit to remain fixed.
    await page.addInitScript(() => {
      let player;
      Object.defineProperty(window, "LiminaPlayer", {
        configurable: true,
        get: () => player,
        set: (value) => {
          if (value && typeof value.run === "function") {
            const run = value.run.bind(value);
            value.run = (options) => run({
              ...options,
              width: window.innerWidth,
              height: window.innerHeight,
              orbit: { ...(options.orbit ?? {}), autoSpin: 0 },
            });
          }
          player = value;
        },
      });
      document.addEventListener("DOMContentLoaded", () => {
        const style = document.createElement("style");
        style.textContent = "header,.status,.poster{display:none!important}body{overflow:hidden!important}.stage{height:100vh!important;flex:1 1 100vh!important}";
        document.head.appendChild(style);
      }, { once: true });
    });
    const pageErrors = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    const entryPath = manifest.export.files.includes("dist/index.html") ? "dist/index.html" : manifest.export.files.find((path) => path.endsWith("/index.html"));
    if (!entryPath) throw new BenchmarkValidationError(["$.export.files must include the browser entry index.html"]);
    await page.goto(`http://127.0.0.1:${port}/${entryPath}`, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.waitForFunction(() => document.querySelector("#limina-canvas.ready") !== null, { timeout: 180_000 });
    const intervals = await page.evaluate(async ({ warmupFrames, measureFrames }) => {
      const frame = () => new Promise((accept) => requestAnimationFrame(accept));
      for (let index = 0; index < warmupFrames; index++) await frame();
      const timestamps = [];
      for (let index = 0; index <= measureFrames; index++) timestamps.push(await frame());
      return timestamps.slice(1).map((timestamp, index) => timestamp - timestamps[index]);
    }, { warmupFrames: manifest.simulation.warmupFrames, measureFrames: manifest.simulation.measureFrames });

    const outputDir = resolveProjectOutputDirectory(root, manifest.output.directory);
    mkdirSync(outputDir, { recursive: true });
    const camera = manifest.cameras[0];
    const screenshotPath = resolve(outputDir, `${manifest.id}-${camera.id}.png`);
    await page.locator("#limina-canvas").screenshot({ path: screenshotPath });
    const result = {
      schema: "limina.visual-benchmark-result/1",
      benchmarkId: manifest.id,
      recordOnly: true,
      cameraId: camera.id,
      sourceSha256: manifest.source.sha256,
      exportSha256: manifest.export.sha256,
      viewport: manifest.viewport,
      simulation: manifest.simulation,
      qualityProfile: manifest.qualityProfile,
      recordedAt: new Date().toISOString(),
      metrics: {
        rafIntervalMs: summarizeIntervals(intervals),
        gpuFrameMs: null,
        gpuMemoryBytes: null,
        drawCalls: null,
        triangles: null,
      },
      pageErrors,
      screenshot: relative(root, screenshotPath).split("\\").join("/"),
    };
    writeFileSync(resolve(outputDir, `${manifest.id}-${camera.id}.json`), `${JSON.stringify(result, null, 2)}\n`);
    return result;
  } finally {
    if (browser) await browser.close();
    await new Promise((accept) => server.close(accept));
  }
}

const invoked = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const result = await runVisualBenchmark(args.project, args.manifest);
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = error instanceof BenchmarkEnvironmentError ? 2 : 1;
  }
}
