// Export ONE kit-composed cottage (js/src/eyes/kit_export_entry.ts) to a portable GLB. Mirrors
// export-building.mjs: esbuild-bundles the entry, serves the repo root, drives the export in headless
// chromium (swiftshader — the export doesn't RENDER, so no GPU contention), then writes the GLB + a
// bounds sidecar so the native round-trip gate (js/test/p90_glb_export_roundtrip.ts) can verify it.
//
//   node tools/preview/export-kit-building.mjs <outGlb>
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { createServer } from "node:http";
import { execFileSync } from "node:child_process";
import { join, resolve, extname, dirname } from "node:path";
import { fileURLToPath as _f } from "node:url";
import { createRequire } from "node:module";
import { resolvePwc, resolveChrome } from "../_pw-resolve.mjs";
const require = createRequire(import.meta.url);
const ROOT = resolve(dirname(_f(import.meta.url)), "..", "..");
const outGlb = resolve(process.argv[2] || join(ROOT, "tools/preview/out/kit-building.glb"));
mkdirSync(dirname(outGlb), { recursive: true });

// 1. Bundle the export entry (three.bundle engine + node_modules three/GLTFExporter) into one module.
const bundleOut = join(ROOT, "tools/preview/out/kit-export.js");
mkdirSync(dirname(bundleOut), { recursive: true });
const esbuild = join(ROOT, "js/node_modules/.bin/esbuild");
execFileSync(esbuild, [
  join(ROOT, "js/src/eyes/kit_export_entry.ts"),
  "--bundle", "--format=esm", "--platform=browser", "--outfile=" + bundleOut,
], { stdio: "inherit" });

const MIME = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".json": "application/json", ".wasm": "application/wasm", ".glb": "model/gltf-binary" };
const srv = createServer((req, res) => {
  let p = decodeURIComponent((req.url || "/").split("?")[0]); if (p === "/") p = "/index.html";
  const f = join(ROOT, p);
  if (!f.startsWith(ROOT) || !existsSync(f)) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { "content-type": MIME[extname(f)] || "application/octet-stream" }); res.end(readFileSync(f));
});
await new Promise((r) => srv.listen(0, r));
const port = srv.address().port;

const { chromium } = require(resolvePwc());
const b = await chromium.launch({ executablePath: resolveChrome(), headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage", "--use-gl=angle", "--use-angle=swiftshader"] });
const page = await b.newPage();
page.on("pageerror", (e) => console.error("PAGEERR: " + e.message));
page.on("console", (m) => { if (m.type() === "error") console.error("CONSOLE.err: " + m.text()); });
await page.goto(`http://localhost:${port}/tools/preview/kit-export.html`, { waitUntil: "load", timeout: 60000 });
await page.waitForFunction("window.__done===true", { timeout: 60000 });
const err = await page.evaluate("window.__err||''");
if (err) { console.error(err); await b.close(); srv.close(); process.exit(1); }
for (const l of await page.evaluate("window.__log||[]")) console.error("LOG: " + l);
const b64 = await page.evaluate("window.__glb");
const bounds = await page.evaluate("window.__bounds");
const bytes = Buffer.from(b64, "base64");
const boundsJson = JSON.stringify(bounds, null, 2);
// 1. Primary deliverable: the scratchpad GLB + bounds sidecar.
writeFileSync(outGlb, bytes);
writeFileSync(outGlb.replace(/\.glb$/, ".bounds.json"), boundsJson);
// 2. Native-readable mirror: the native round-trip gate reads through the engine's real asset path
//    (op_read_asset), which is sandboxed to <cwd>/assets and can't reach /tmp — so mirror the same
//    bytes into the asset root for p90_glb_export_roundtrip.ts. Same bytes → same content address.
const assetGlb = join(ROOT, "assets", "kit-building.glb");
writeFileSync(assetGlb, bytes);
writeFileSync(join(ROOT, "assets", "kit-building.bounds.json"), boundsJson);
console.error(`wrote ${outGlb} (${bytes.length} bytes) + bounds sidecar; mirrored to ${assetGlb}; bounds=${JSON.stringify(bounds)}`);
await b.close(); srv.close();
