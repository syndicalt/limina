// Minimal static server with CROSS-ORIGIN ISOLATION headers (COOP: same-origin + COEP: require-corp),
// which SharedArrayBuffer — and therefore the limina live worker bridge — requires. Serves the repo
// root so /editor/vendor/limina-runtime.js, /tools/preview/*.html, /assets/**, and the scene JSON all
// load from one isolated origin. Open the printed URL in a real browser (Chrome/Edge) to WALK the
// settlement interactively.
//
//   node tools/preview/serve.mjs           # then open http://localhost:8099/tools/preview/engine-play.html
//
import { existsSync, readFileSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { join, resolve, extname, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PORT = Number(process.env.PORT || 8099);
const MIME = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".json": "application/json", ".wasm": "application/wasm", ".glb": "model/gltf-binary", ".png": "image/png" };
const COOP = { "Cross-Origin-Opener-Policy": "same-origin", "Cross-Origin-Embedder-Policy": "require-corp", "Cross-Origin-Resource-Policy": "cross-origin" };

createServer((req, res) => {
  let p = decodeURIComponent((req.url || "/").split("?")[0]);
  if (p === "/") p = "/tools/preview/engine-play.html";
  const f = join(ROOT, p);
  if (!f.startsWith(ROOT) || !existsSync(f) || statSync(f).isDirectory()) { res.writeHead(404, COOP); res.end("not found"); return; }
  res.writeHead(200, { "content-type": MIME[extname(f)] || "application/octet-stream", ...COOP });
  res.end(readFileSync(f));
}).listen(PORT, () => {
  console.log(`limina preview server (COOP/COEP) → http://localhost:${PORT}/tools/preview/engine-play.html`);
});
