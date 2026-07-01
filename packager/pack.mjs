// limina-release PACKAGER (Phase 3). Builds a SELF-CONTAINED, playable web release around an exported
// world — the container exportGame does NOT produce: index.html + the browser runtime + the world files
// + a release manifest (with the gate verdicts). Guards the un-exportable case: a direct-path game has
// no replay-complete export (engine/game/publish.ts canExport=false), so it cannot be web-packaged.
//
// API:  packRelease({ worldDir, gameId, outDir, gates? }) -> manifest
// CLI:  node packager/pack.mjs <worldDir> <gameId> <outDir>

import { mkdirSync, copyFileSync, writeFileSync, existsSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(here, "..");
const WORLD_FILES = ["manifest.json", "log.jsonl", "keyframes.jsonl", "tiles.jsonl", "assets.jsonl"];
const REQUIRED = ["manifest.json", "log.jsonl", "keyframes.jsonl"];

const indexHtml = (gameId) => `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><title>${gameId} — a limina game</title>
<style>html,body{margin:0;height:100%;background:#0b0d12;overflow:hidden;font-family:system-ui,sans-serif}
#limina-canvas{width:100vw;height:100vh;display:block}
#hud{position:fixed;left:8px;bottom:6px;color:#9fb0c0;font:12px system-ui;opacity:.7}</style></head>
<body>
  <canvas id="limina-canvas" data-world="public/worlds/${gameId}"></canvas>
  <div id="hud"><span id="limina-status">starting…</span></div>
  <script type="module" src="public/limina-runtime.js"></script>
</body></html>
`;

const serveSh = (gameId) => `#!/usr/bin/env bash
# Play this limina release locally (Mode-A replay needs no COOP/COEP — a plain static server is enough).
cd "$(dirname "$0")" && echo "open http://localhost:8800  — ${gameId}" && exec python3 -m http.server 8800
`;

export function packRelease({ worldDir, gameId, outDir, gates = null, createdAt }) {
  worldDir = resolve(worldDir);
  outDir = resolve(outDir);
  if (!existsSync(worldDir)) throw new Error(`packRelease: worldDir not found: ${worldDir}`);
  // Un-exportable guard: a packageable world MUST carry a replay-complete export.
  const missing = REQUIRED.filter((f) => !existsSync(join(worldDir, f)));
  if (missing.length) throw new Error(`packRelease: "${worldDir}" is not a packageable export (missing ${missing.join(", ")}). A direct-path game has no replay export (publish.ts canExport=false) — opt into record+export, or ship the native build.`);

  // Mirror the web/ layout (everything under public/) so the runtime + engine-browser-gate resolve.
  mkdirSync(join(outDir, "public", "worlds", gameId), { recursive: true });
  const files = [];
  for (const f of WORLD_FILES) {
    const src = join(worldDir, f);
    if (existsSync(src)) { copyFileSync(src, join(outDir, "public", "worlds", gameId, f)); files.push(`public/worlds/${gameId}/${f}`); }
  }

  const runtimeSrc = join(REPO_ROOT, "web", "public", "limina-runtime.js");
  if (!existsSync(runtimeSrc)) throw new Error(`packRelease: browser runtime missing at ${runtimeSrc} — build it: (cd js && npm run bundle:runtime)`);
  copyFileSync(runtimeSrc, join(outDir, "public", "limina-runtime.js"));
  writeFileSync(join(outDir, "index.html"), indexHtml(gameId));
  writeFileSync(join(outDir, "serve.sh"), serveSh(gameId));
  files.push("index.html", "public/limina-runtime.js", "serve.sh");

  const manifest = { gameId, createdAt: createdAt ?? new Date().toISOString(), mode: "replay", files, gates };
  writeFileSync(join(outDir, "release.json"), JSON.stringify(manifest, null, 2));
  return manifest;
}

// CLI
if (import.meta.url === `file://${process.argv[1]}`) {
  const [worldDir, gameId, outDir] = process.argv.slice(2);
  if (!worldDir || !gameId || !outDir) { console.error("usage: node packager/pack.mjs <worldDir> <gameId> <outDir>"); process.exit(2); }
  try { const m = packRelease({ worldDir, gameId, outDir }); console.log(`packed ${gameId} -> ${resolve(outDir)} (${m.files.length} files)`); }
  catch (e) { console.error("pack failed:", e.message); process.exit(1); }
}
