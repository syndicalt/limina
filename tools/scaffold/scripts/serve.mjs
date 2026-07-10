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

import { createServer, request as httpRequest } from "node:http";
import { createReadStream, existsSync, statSync } from "node:fs";
import { extname, join, normalize, resolve } from "node:path";
import { pathToFileURL } from "node:url";

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

const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

export function parseAtlasOrigin(input) {
  if (input === undefined || input === "") return undefined;
  let origin;
  try { origin = new URL(input); }
  catch (error) { throw new Error(`LIMINA_ATLAS_ORIGIN is invalid: ${error.message}`); }
  if (origin.protocol !== "http:" || origin.hostname !== "127.0.0.1" || origin.port === ""
      || origin.origin !== input || origin.pathname !== "/" || origin.search !== "" || origin.hash !== ""
      || origin.username !== "" || origin.password !== "") {
    throw new Error("LIMINA_ATLAS_ORIGIN must be an exact http://127.0.0.1:<port> origin");
  }
  return origin;
}

export function atlasProxyPath(requestUrl) {
  if (typeof requestUrl !== "string" || !requestUrl.startsWith("/")) return undefined;
  const queryAt = requestUrl.indexOf("?");
  const pathname = queryAt < 0 ? requestUrl : requestUrl.slice(0, queryAt);
  const query = queryAt < 0 ? "" : requestUrl.slice(queryAt);
  if (pathname === "/atlas" || pathname === "/atlas/") return `/${query}`;
  if (pathname.startsWith("/atlas/")) return `${pathname.slice("/atlas".length)}${query}`;
  if (pathname.startsWith("/api/") || pathname.startsWith("/shared/") || pathname.startsWith("/assets/qc/")) {
    return `${pathname}${query}`;
  }
  return undefined;
}

function withoutHopByHopHeaders(input) {
  const headers = { ...input };
  const connectionTokens = String(headers.connection ?? "").split(",").map((value) => value.trim().toLowerCase()).filter(Boolean);
  for (const name of [...HOP_BY_HOP_HEADERS, ...connectionTokens]) delete headers[name];
  return headers;
}

function proxyAtlasRequest(req, res, atlasOrigin, targetPath) {
  const headers = withoutHopByHopHeaders(req.headers);
  headers.host = atlasOrigin.host;
  const upstream = httpRequest({
    protocol: atlasOrigin.protocol,
    hostname: atlasOrigin.hostname,
    port: atlasOrigin.port,
    method: req.method,
    path: targetPath,
    headers,
  }, (upstreamResponse) => {
    const responseHeaders = withoutHopByHopHeaders(upstreamResponse.headers);
    responseHeaders["cross-origin-opener-policy"] = "same-origin";
    responseHeaders["cross-origin-embedder-policy"] = "require-corp";
    responseHeaders["cross-origin-resource-policy"] = "same-origin";
    res.writeHead(upstreamResponse.statusCode ?? 502, responseHeaders);
    upstreamResponse.pipe(res);
  });
  upstream.on("error", (error) => {
    if (!res.headersSent) {
      res.writeHead(502, { "content-type": "text/plain; charset=utf-8", ...COOP_COEP });
      res.end("Atlas upstream unavailable");
    } else res.destroy(error);
  });
  req.on("aborted", () => upstream.destroy());
  req.pipe(upstream);
}

export function createEditorStaticServer({ root, assetRoot, atlasOrigin } = {}) {
  const ROOT = resolve(root ?? "dist");
  const ASSETS_ROOT = resolve(assetRoot ?? resolve(ROOT, "..", "assets"));
  const ATLAS_ORIGIN = parseAtlasOrigin(atlasOrigin instanceof URL ? atlasOrigin.origin : atlasOrigin);
  return createServer((req, res) => {
    try {
      const proxyPath = ATLAS_ORIGIN === undefined ? undefined : atlasProxyPath(req.url ?? "/");
      if (proxyPath !== undefined) {
        proxyAtlasRequest(req, res, ATLAS_ORIGIN, proxyPath);
        return;
      }
      // Strip query/hash; decode; block path traversal by normalizing under ROOT.
      const rawPath = decodeURIComponent((req.url ?? "/").split(/[?#]/)[0]);
      // /assets/** → repo/assets/** (outside ROOT), same COOP/COEP headers, traversal-guarded.
      if (rawPath.startsWith("/assets/")) {
        const arel = normalize(rawPath.slice("/assets/".length)).replace(/^(\.\.[/\\])+/, "");
        const af = join(ASSETS_ROOT, arel);
        if (!af.startsWith(ASSETS_ROOT) || !existsSync(af) || !statSync(af).isFile()) {
          res.writeHead(404, { "content-type": "text/plain", ...COOP_COEP }).end("404 Not Found");
          return;
        }
        const at = MIME[extname(af).toLowerCase()] ?? "application/octet-stream";
        res.writeHead(200, { "content-type": at, "cache-control": "no-cache", ...COOP_COEP });
        createReadStream(af).pipe(res);
        return;
      }
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
}

function main() {
  const argDir = process.argv[2] ?? "dist";
  const port = Number(process.argv[3] ?? process.env.PORT ?? 5173);
  const root = resolve(process.cwd(), argDir);
  if (!existsSync(root)) {
    console.error(`\n  serve: directory not found: ${root}`);
    if (argDir === "dist") console.error("  Run `npm run export` first to build dist/.\n");
    else console.error("");
    process.exit(1);
  }
  let atlasOrigin;
  try { atlasOrigin = parseAtlasOrigin(process.env.LIMINA_ATLAS_ORIGIN); }
  catch (error) {
    console.error(`\n  serve: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
  // The repo asset root (repo/assets), served at /assets/** so the LIVE editor's op_read_asset
  // can fetch GLB/texture bytes (asset.place, vegetation.scatter) from the same origin.
  const assetRoot = resolve(process.env.LIMINA_ASSETS_ROOT || resolve(root, "..", "assets"));
  const server = createEditorStaticServer({ root, assetRoot, atlasOrigin });

  server.listen(port, "127.0.0.1", () => {
    console.log(`\n  limina: serving ${argDir}/ at http://localhost:${port}/\n  (Ctrl-C to stop)\n`);
  });
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (import.meta.url === invokedPath) main();
