// Verify the packager: (1) the un-exportable/direct-path guard rejects a world with no export;
// (2) the demo world packs into a self-contained release dir whose contents are present AND that
// RENDERS non-blank in the real engine (reusing the engine-browser-gate on the release dir, so the
// "playable" claim is proven, not assumed).
//
// Run: node packager/check.mjs  (exit 0 = real release · 1 = broken · 2 = no chromium)

import { packRelease } from "./pack.mjs";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(here, "..");
let ok = true;

// 1. Guard: packing a world without a replay-complete export MUST throw (direct-path case).
const empty = mkdtempSync(join(tmpdir(), "limina-empty-"));
try {
  packRelease({ worldDir: empty, gameId: "x", outDir: mkdtempSync(join(tmpdir(), "o-")) });
  console.error("FAIL: guard accepted an un-exportable world"); ok = false;
} catch (e) {
  if (!/not a packageable export|record\+export/.test(e.message)) { console.error("FAIL: wrong guard error: " + e.message); ok = false; }
  else console.error("guard OK: un-exportable (direct-path) world rejected");
}

// 2. Pack the demo world.
const demoWorld = join(REPO_ROOT, "web", "public", "worlds", "demo");
if (!existsSync(demoWorld)) { console.error("SKIP: no demo world at " + demoWorld + " (run js export:demo)"); process.exit(2); }
const rel = mkdtempSync(join(tmpdir(), "limina-release-"));
const m = packRelease({ worldDir: demoWorld, gameId: "demo", outDir: rel, gates: { functional: "pass", design: "pass" } });
for (const f of ["index.html", "public/limina-runtime.js", "release.json", "public/worlds/demo/manifest.json"]) {
  if (!existsSync(join(rel, f))) { console.error("FAIL: release missing " + f); ok = false; }
}
console.error(`packed demo -> ${rel} (${m.files.length} files)`);

// 3. The packaged release must RENDER non-blank in the real engine.
let rc = 0;
try { execFileSync("node", [join(REPO_ROOT, "tools", "director", "engine-browser-gate.mjs"), rel, "public/worlds/demo"], { stdio: "pipe", timeout: 120000 }); }
catch (e) { rc = e.status ?? 1; }
if (rc === 2) console.error("render SKIP (no chromium)");
else if (rc !== 0) { console.error("FAIL: packaged release did not render non-blank (engine-browser-gate rc=" + rc + ")"); ok = false; }
else console.error("render OK: the packaged release renders non-blank in the real engine");

rmSync(empty, { recursive: true, force: true });
rmSync(rel, { recursive: true, force: true });
console.log(ok ? "check-packager OK: direct-path rejected; demo packs into a self-contained release that RENDERS." : "check-packager FAILED.");
process.exit(ok ? 0 : (rc === 2 ? 2 : 1));
