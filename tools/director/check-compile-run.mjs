// HOST-SIDE: the browser RUN tier for the World Designer's "Compile & Run". Takes a GDS `world`
// slice all the way to a render-verified release, reusing the packager + engine-browser-gate the
// beacon dogfood uses — but sourcing the export from compileWorldToExport (a designed world slice)
// instead of a hand-authored scene. Stages:
//   1. COMPILE   — ./target/release/limina js/scripts/compile-world-export.ts → traces/compile.*
//   2. PACKAGE   — packRelease wraps the world into a self-contained playable release.
//   3. RENDER    — engine-browser-gate loads the release in the real engine and asserts non-blank.
//
// exit 0 = pass · exit 1 = fail · exit 2 = no chromium (compiled + packaged OK, render unverified).
// Run: node tools/director/check-compile-run.mjs

import { packRelease } from "../../packager/pack.mjs";
import { execFileSync } from "node:child_process";
import { mkdtempSync, copyFileSync, readdirSync, rmSync, existsSync } from "node:fs";
import { join, resolve, dirname, basename } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, "..", "..");
process.chdir(ROOT);
const LIMINA = "./target/release/limina";
const log = (m) => process.stderr.write(m + "\n");
const fail = (m) => { console.error("check-compile-run FAIL: " + m); process.exit(1); };

// ── 1. compile the GDS world slice → export files in traces/ ────────────────
log("[1/3] compile   (GDS world slice → export bundle)");
try {
  execFileSync(LIMINA, ["js/scripts/compile-world-export.ts"], { stdio: "pipe", timeout: 120000 });
} catch (e) {
  fail("compile step rc=" + (e.status ?? "?"));
}

// Relocate traces/compile.* → a fresh worldDir (strip the `compile.` prefix packRelease expects).
const worldDir = mkdtempSync(join(tmpdir(), "compiled-world-"));
const traces = join(ROOT, "traces");
const emitted = readdirSync(traces).filter((f) => f.startsWith("compile."));
if (emitted.length === 0) fail("no traces/compile.* export produced");
for (const f of emitted) copyFileSync(join(traces, f), join(worldDir, basename(f).replace(/^compile\./, "")));
for (const req of ["manifest.json", "log.jsonl", "keyframes.jsonl"]) {
  if (!existsSync(join(worldDir, req))) fail("export missing " + req);
}
log(`      compile: ${emitted.length} world files`);

// ── 2. package into a self-contained release ────────────────────────────────
log("[2/3] package   (self-contained playable release)");
const rel = mkdtempSync(join(tmpdir(), "compiled-release-"));
try {
  packRelease({ worldDir, gameId: "compiled", outDir: rel });
} catch (e) {
  rmSync(worldDir, { recursive: true, force: true });
  fail("package " + e.message);
}
for (const f of ["index.html", "public/limina-runtime.js", "release.json", "public/worlds/compiled/manifest.json"]) {
  if (!existsSync(join(rel, f))) { rmSync(worldDir, { recursive: true, force: true }); rmSync(rel, { recursive: true, force: true }); fail("release missing " + f); }
}
log("      package: release assembled");

// ── 3. render-verify: the packaged release must render non-blank ─────────────
log("[3/3] render    (the packaged release plays in the real engine)");
let rc = 0;
try {
  execFileSync("node", [join(ROOT, "tools/director/engine-browser-gate.mjs"), rel, "public/worlds/compiled"], { stdio: "pipe", timeout: 180000 });
} catch (e) {
  rc = e.status ?? 1;
}
rmSync(worldDir, { recursive: true, force: true });
rmSync(rel, { recursive: true, force: true });

if (rc === 2) {
  console.log("check-compile-run SKIP (no chromium) — GDS world slice compiled + packaged OK; render unverified.");
  process.exit(2);
}
if (rc !== 0) fail("render rc=" + rc);
console.log("check-compile-run OK — GDS world slice compiled → packaged → rendered non-blank in the real engine.");
process.exit(0);
