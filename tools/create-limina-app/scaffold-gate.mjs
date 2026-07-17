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
const PACKAGE_DIR = join(ROOT, "tools/create-limina-app");

let failed = false;
const check = (name, cond) => { if (cond) console.log("  ok  " + name); else { console.error("  FAIL " + name); failed = true; } };

const dir = mkdtempSync(join(tmpdir(), "onramp-gate-"));
const app = join(dir, "sample-app");
try {
  const packOutput = execFileSync("npm", ["pack", "--json", "--pack-destination", dir], {
    cwd: PACKAGE_DIR, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 60000,
  });
  const packed = JSON.parse(packOutput);
  const tarball = join(dir, packed[0].filename);
  const extracted = join(dir, "packed-create-limina-app");
  execFileSync("mkdir", ["-p", extracted]);
  execFileSync("tar", ["-xzf", tarball, "-C", extracted]);
  const packedCli = join(extracted, "package", "index.mjs");
  check("published tarball contains its scaffold", existsSync(join(extracted, "package", "scaffold", "world.ts")));
  execFileSync("node", [packedCli, app], { cwd: dir, stdio: ["ignore", "pipe", "pipe"], timeout: 60000 });

  // 1. File tree — a real project, not a stub.
  for (const f of ["package.json", "package-lock.json", "limina.project.json", "world.ts", "tsconfig.json", "README.md", "AGENTS.md", "COORDINATOR.md",
                   "scripts/serve.mjs", "scripts/export.mjs", "scripts/editor.mjs",
                   "design/maps.json",
                   "assets/pine.glb", "assets/rock.glb", "public/index.html", "public/limina-player.js", "public/island/manifest.json"]) {
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

  // 5. The production editor workflow owns the derived sidecar, and the seed MapDoc is substituted.
  const editorLauncher = readFileSync(join(app, "scripts", "editor.mjs"), "utf8");
  check("editor launcher owns the derived-build sidecar", /derived-build-service\.mjs/.test(editorLauncher));
  check("editor launcher requires the Node world-compiler bundle", /world-compiler\.bundle\.mjs/.test(editorLauncher));
  const seedMapDoc = JSON.parse(readFileSync(join(app, "design", "maps.json"), "utf8"));
  check("seed MapDoc is project-specific and valid-shaped", seedMapDoc.version === 2
    && seedMapDoc.activeMapId === "primary" && seedMapDoc.maps?.[0]?.name === "sample-app World");

  // 6. The committed instant-play sample must be the exact current world.ts export.
  execFileSync("npm", ["run", "export"], {
    cwd: app,
    env: { ...process.env, LIMINA_HOME: ROOT, LIMINA_BIN: join(ROOT, "target", "release", "limina") },
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 120000,
  });
  for (const file of ["log.jsonl", "keyframes.jsonl", "tiles.jsonl", "assets.jsonl", "view.json"]) {
    const samplePath = join(app, "public", "island", file);
    const freshPath = join(app, "dist", file);
    const bothAbsent = !existsSync(samplePath) && !existsSync(freshPath);
    check(`prebuilt sample matches a fresh export: ${file}`, bothAbsent || (
      existsSync(samplePath) && existsSync(freshPath)
      && readFileSync(samplePath, "utf8") === readFileSync(freshPath, "utf8")
    ));
  }
  for (const file of ["basis_transcoder.js", "basis_transcoder.wasm"]) {
    const engineRuntime = join(ROOT, "runtime", "basis", file);
    const exportedRuntime = join(app, "dist", "runtime", "basis", file);
    check(`fresh export ships exact engine Basis runtime: ${file}`, existsSync(exportedRuntime)
      && readFileSync(exportedRuntime).equals(readFileSync(engineRuntime)));
  }
  const sampleManifest = JSON.parse(readFileSync(join(app, "public", "island", "manifest.json"), "utf8"));
  const freshManifest = JSON.parse(readFileSync(join(app, "dist", "manifest.json"), "utf8"));
  sampleManifest.worldId = freshManifest.worldId;
  check("prebuilt sample matches a fresh export: manifest.json", JSON.stringify(sampleManifest) === JSON.stringify(freshManifest));
} finally {
  rmSync(dir, { recursive: true, force: true });
}

if (failed) { console.error("\nscaffold-gate: FAIL"); process.exit(1); }
console.log("\nscaffold-gate OK: create-limina-app produces a complete, bootable project — real file tree + prebuilt sample world + a classic-script-safe (import.meta-free) player exposing window.LiminaPlayer. (GPU render proof: node tools/shoot.mjs <app>/public <png>.)");
process.exit(0);
