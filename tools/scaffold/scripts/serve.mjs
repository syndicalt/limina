#!/usr/bin/env node
// ════════════════════════════════════════════════════════════════════════════
//  scripts/serve.mjs — a tiny zero-dependency static file server.
//
//  Usage:  node scripts/serve.mjs <dir> [port]
//    npm run dev   → serves public/ (the prebuilt sample — no native toolchain)
//    npm run serve → serves dist/   (your exported world.ts)
//
//  No dependencies on purpose: just node's http + fs. Serves the limina bundle
//  files (.jsonl/.json), the player (.js), GLBs and the page with correct types.
//
//  CROSS-ORIGIN ISOLATION (Phase 8 Mode B / live runtime): every response carries
//    Cross-Origin-Opener-Policy:   same-origin
//    Cross-Origin-Embedder-Policy: require-corp
//  which is what makes `self.crossOriginIsolated === true`, the browser
//  precondition for `SharedArrayBuffer` — the zero-copy worker↔main transform
//  bridge `runLive` depends on. Without these headers the live runtime degrades
//  gracefully (runLive reports `error`, the page shows a poster); Mode-A export
//  playback is unaffected. Any other host serving the live page or the editor must
//  send the SAME two headers (see COOP-COEP note below). A side effect of
//  require-corp: cross-origin subresources must themselves opt in (CORP/CORS) —
//  the limina bundles are same-origin, so this is transparent here.
// ════════════════════════════════════════════════════════════════════════════

import { createServer } from "node:http";
import { createReadStream, existsSync, statSync } from "node:fs";
import { extname, join, normalize, resolve } from "node:path";

const argDir = process.argv[2] ?? "dist";
const port = Number(process.argv[3] ?? process.env.PORT ?? 5173);
const ROOT = resolve(process.cwd(), argDir);

if (!existsSync(ROOT)) {
  console.error(`\n  serve: directory not found: ${ROOT}`);
  if (argDir === "dist") console.error("  Run `npm run export` first to build dist/.\n");
  else console.error("");
  process.exit(1);
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".jsonl": "application/x-ndjson; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".glb": "model/gltf-binary",
  ".wasm": "application/wasm",
  ".map": "application/json; charset=utf-8",
};

// Cross-origin isolation headers — sent on EVERY response (errors included) so the
// served origin is isolated and `SharedArrayBuffer` is available to the live runtime.
const COOP_COEP = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
  // Same-origin subresources are fetched under require-corp; mark them embeddable.
  "Cross-Origin-Resource-Policy": "same-origin",
};

const server = createServer((req, res) => {
  try {
    // Strip query/hash; decode; block path traversal by normalizing under ROOT.
    const rawPath = decodeURIComponent((req.url ?? "/").split(/[?#]/)[0]);
    let rel = normalize(rawPath).replace(/^(\.\.[/\\])+/, "");
    if (rel === "/" || rel === "" || rel.endsWith("/")) rel = join(rel, "index.html");
    const filePath = join(ROOT, rel);
    if (!filePath.startsWith(ROOT)) {
      res.writeHead(403, { ...COOP_COEP }).end("Forbidden");
      return;
    }
    if (!existsSync(filePath) || !statSync(filePath).isFile()) {
      res.writeHead(404, { "content-type": "text/plain", ...COOP_COEP }).end("404 Not Found");
      return;
    }
    const type = MIME[extname(filePath).toLowerCase()] ?? "application/octet-stream";
    res.writeHead(200, { "content-type": type, "cache-control": "no-cache", ...COOP_COEP });
    createReadStream(filePath).pipe(res);
  } catch (err) {
    res.writeHead(500, { "content-type": "text/plain", ...COOP_COEP }).end("500 Internal Server Error");
    console.error("serve:", err instanceof Error ? err.message : String(err));
  }
});

server.listen(port, () => {
  console.log(`\n  limina: serving ${argDir}/ at http://localhost:${port}/\n  (Ctrl-C to stop)\n`);
});
