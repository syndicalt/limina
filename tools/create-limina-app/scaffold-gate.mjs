// ON-RAMP scaffold gate — regression-protects create-limina-app (Track 2, Bet 2). Scaffolds a
// fresh project into a temp dir and asserts it is COMPLETE + BOOTABLE: the expected file tree,
// the prebuilt sample world, the coordinator docs, and — the exact bug that shipped a dead
// sample — the player bundle must be a classic-script-safe IIFE (NO import.meta, which is an
// early syntax error under <script src>) exposing window.LiminaPlayer, and index.html must load
// it as a classic script so its inline loader can read that global. Headless + fast (no GPU); a
// GPU render check is the separate playable path (tools/shoot.mjs) noted below.
//
// FALSIFIABILITY: an import.meta in the player, a missing sample manifest, or a stripped file
// tree each fail the gate — the import.meta check specifically would have caught the DOA sample.
//
// Run: node tools/create-limina-app/scaffold-gate.mjs   (exit 0 = real scaffold · 1 = broken)

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CLI = join(ROOT, "tools/create-limina-app/index.mjs");

let failed = false;
const check = (name, cond) => { if (cond) console.log("  ok  " + name); else { console.error("  FAIL " + name); failed = true; } };

const dir = mkdtempSync(join(tmpdir(), "onramp-gate-"));
const app = join(dir, "sample-app");
try {
  execFileSync("node", [CLI, app], { cwd: dir, stdio: ["ignore", "pipe", "pipe"], timeout: 60000 });

  // 1. File tree — a real project, not a stub.
  for (const f of ["package.json", "world.ts", "tsconfig.json", "README.md", "AGENTS.md", "COORDINATOR.md",
                   "scripts/serve.mjs", "scripts/export.mjs", "scripts/editor.mjs",
                   "public/index.html", "public/limina-player.js", "public/island/manifest.json"]) {
    check("scaffolds " + f, existsSync(join(app, f)));
  }

  // 2. The prebuilt sample world is a real Mode-A export (plays instantly, no toolchain).
  if (existsSync(join(app, "public/island/manifest.json"))) {
    try {
      const mf = JSON.parse(readFileSync(join(app, "public/island/manifest.json"), "utf8"));
      check("sample world manifest is a real export (worldId + commands)", typeof mf.worldId === "string" && mf.commands >= 1);
    } catch { check("sample world manifest parses", false); }
  }

  // 3. THE REGRESSION INVARIANT: the player bundle is classic-script-safe.
  const player = readFileSync(join(app, "public/limina-player.js"), "utf8");
  check("player is import.meta-free (parses as a classic <script src>, not a DOA ESM bundle)", !/\bimport\.meta\b/.test(player));
  check("player exposes the window.LiminaPlayer global (IIFE global-name)", /\bvar LiminaPlayer\b/.test(player) || /window\.LiminaPlayer/.test(player));

  // 4. index.html loads the player as a CLASSIC script (so the inline loader sees the global).
  const html = readFileSync(join(app, "public/index.html"), "utf8");
  const scriptTag = html.match(/<script[^>]*src=["']\.\/limina-player\.js["'][^>]*>/);
  check("index.html loads limina-player.js as a classic <script src>", !!scriptTag && !/type=["']module["']/.test(scriptTag[0]));
  check("index.html's loader gates on window.LiminaPlayer", /window\.LiminaPlayer/.test(html));
} finally {
  rmSync(dir, { recursive: true, force: true });
}

if (failed) { console.error("\nscaffold-gate: FAIL"); process.exit(1); }
console.log("\nscaffold-gate OK: create-limina-app produces a complete, bootable project — real file tree + prebuilt sample world + a classic-script-safe (import.meta-free) player exposing window.LiminaPlayer. (GPU render proof: node tools/shoot.mjs <app>/public <png>.)");
process.exit(0);
