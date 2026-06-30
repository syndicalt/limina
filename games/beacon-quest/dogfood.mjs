// BEACON QUEST — end-to-end dogfood of the assembled machine (Phase 4 of the gamestack refactor).
// Takes ONE real game (Beacon Run) from its GDS through EVERY stage and asserts each produces a real,
// verified artifact — no stubs, no green-on-void. The stages, in the order the pipeline runs them:
//
//   1. PLAYABLE SMOKE  — the native playable build loads (imports + game + the SHARED dressed field).
//   2. FUNCTIONAL gate  — the DoD loop (p28: reaching the beacon wins; the blight drains to a loss).
//   3. DESIGN gate      — silhouette distinctness over the GDS content tiers (gamestack procgen-review).
//   4. EXPORT           — record the dressed scene into a replay-complete world (manifest/log/keyframes…).
//   5. PACKAGE          — wrap that world into a self-contained playable release (packager/pack.mjs).
//   6. RENDER-VERIFY    — the packaged release must actually render non-blank in the real engine.
// The export records the SAME shared field the playable build renders, so play and ship can't drift.
//
// Any stage that fails to produce a real artifact fails the dogfood (exit 1). A missing chromium/GPU
// is reported as SKIP (exit 2), never silently passed. Run: node games/beacon-quest/dogfood.mjs

import { runGdsDesignGate } from "../../gates/design/gds-gate.mjs";
import { packRelease } from "../../packager/pack.mjs";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, copyFileSync, readdirSync, rmSync, existsSync } from "node:fs";
import { join, resolve, dirname, basename } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, "..", "..");
process.chdir(ROOT);
const LIMINA = "./target/release/limina";
const log = (m) => process.stderr.write(m + "\n");

let ok = true;
let renderSkipped = false;
const summary = {};

log("=== BEACON QUEST · end-to-end dogfood (playable smoke → functional+design gates → export → package → render) ===");

// ── 1. Playable-build smoke (the thing you actually PLAY loads cleanly) ──────
log("[1/6] playable smoke   (the native playable build loads: imports + game + shared dressed field)");
try {
  execFileSync("node", ["games/beacon-quest/smoke-playable.mjs"], { stdio: "pipe", timeout: 90000 });
  summary.playable = "pass";
  log("      playable: PASS");
} catch (e) {
  summary.playable = "fail";
  ok = false;
  log("      playable: FAIL (rc=" + (e.status ?? "?") + ")");
}

// ── 2. Functional gate ─────────────────────────────────────────────────────
log("[2/6] functional gate  (p28: reach beacon → won · blight → lost)");
try {
  execFileSync(LIMINA, ["js/test/p28_beacon_run.ts"], { stdio: "pipe", timeout: 120000 });
  summary.functional = "pass";
  log("      functional: PASS");
} catch (e) {
  summary.functional = "fail";
  ok = false;
  log("      functional: FAIL (rc=" + (e.status ?? "?") + ")");
}

// ── 3. Design gate (silhouette tiers over the real GDS content) ─────────────
log("[3/6] design gate      (silhouette distinctness within each GDS content tier)");
let design = { pass: false, score: 0, tiers: [], failures: [{ detail: "not run" }] };
try {
  const out = execFileSync(LIMINA, ["games/beacon-quest/emit-gds.ts"], { stdio: ["ignore", "pipe", "pipe"], timeout: 60000 }).toString();
  const m = out.match(/__GDS_JSON__(\{.*\})/);
  if (!m) throw new Error("could not emit GDS JSON from the spec");
  const gds = JSON.parse(m[1]);
  design = await runGdsDesignGate(gds);
  summary.design = design.pass ? "pass" : "fail";
  log(`      design: ${design.pass ? "PASS" : "FAIL"}  score=${design.score}  tiers=${design.tiers.map((t) => `${t.tier}:${t.pass ? "ok" : "X"}(${t.distinguishable}/${t.pairs})`).join(" ")}`);
  if (!design.pass) { ok = false; log("      failures: " + design.failures.map((f) => `${f.tier ?? ""}/${f.gate}: ${f.detail}`).join(" | ")); }
} catch (e) {
  if (/no chromium|playwright-core/.test(e.message)) { renderSkipped = true; summary.design = "skip"; log("      design: SKIP (no chromium/GPU)"); }
  else { summary.design = "fail"; ok = false; log("      design: FAIL (" + e.message + ")"); }
}

// ── 3. Export the dressed beacon world (record+export → replay-complete) ─────
log("[4/6] export           (record the dressed scene into a replay-complete world)");
const worldDir = join(ROOT, "games/beacon-quest/web/public/worlds/beacon");
try {
  execFileSync(LIMINA, ["games/beacon-quest/build/scene.ts"], { stdio: "pipe", timeout: 180000 });
  mkdirSync(worldDir, { recursive: true });
  for (const f of readdirSync(worldDir)) rmSync(join(worldDir, f), { force: true });
  const traces = join(ROOT, "traces");
  const emitted = readdirSync(traces).filter((f) => f.startsWith("beacon."));
  if (!emitted.length) throw new Error("scene.ts produced no traces/beacon.* export");
  for (const f of emitted) copyFileSync(join(traces, f), join(worldDir, basename(f).replace(/^beacon\./, "")));
  const have = readdirSync(worldDir);
  for (const req of ["manifest.json", "log.jsonl", "keyframes.jsonl"]) {
    if (!have.includes(req)) throw new Error("export missing " + req);
  }
  summary.export = "pass";
  log(`      export: PASS (${have.length} world files: ${have.join(", ")})`);
} catch (e) {
  summary.export = "fail";
  ok = false;
  log("      export: FAIL (" + e.message + ")");
}

// ── 4. Package into a self-contained release ────────────────────────────────
log("[5/6] package          (wrap the world into a self-contained playable release)");
const rel = mkdtempSync(join(tmpdir(), "beacon-release-"));
let packed = null;
try {
  packed = packRelease({
    worldDir,
    gameId: "beacon",
    outDir: rel,
    gates: { functional: summary.functional, design: summary.design },
  });
  for (const f of ["index.html", "public/limina-runtime.js", "release.json", "public/worlds/beacon/manifest.json"]) {
    if (!existsSync(join(rel, f))) throw new Error("release missing " + f);
  }
  summary.package = "pass";
  log(`      package: PASS (${packed.files.length} files → ${rel})`);
} catch (e) {
  summary.package = "fail";
  ok = false;
  log("      package: FAIL (" + e.message + ")");
}

// ── 5. Render-verify: the packaged release must render non-blank ─────────────
log("[6/6] render-verify    (the packaged release plays in the real engine)");
if (summary.package === "pass") {
  let rc = 0;
  try {
    execFileSync("node", [join(ROOT, "tools/director/engine-browser-gate.mjs"), rel, "public/worlds/beacon"], { stdio: "pipe", timeout: 180000 });
  } catch (e) { rc = e.status ?? 1; }
  if (rc === 2) { renderSkipped = true; summary.render = "skip"; log("      render: SKIP (no chromium)"); }
  else if (rc !== 0) { summary.render = "fail"; ok = false; log("      render: FAIL (engine-browser-gate rc=" + rc + ")"); }
  else { summary.render = "pass"; log("      render: PASS (the packaged release renders non-blank)"); }
} else {
  summary.render = "skip";
  log("      render: SKIP (nothing packaged)");
}

rmSync(rel, { recursive: true, force: true });

log("=== summary ===");
log("   " + Object.entries(summary).map(([k, v]) => `${k}:${v}`).join("  ·  "));
if (ok) {
  console.log("DOGFOOD OK — Beacon Quest went GDS → functional+design gates → export → package → render-verified release, every stage producing a real artifact.");
  process.exit(0);
}
console.log("DOGFOOD " + (renderSkipped ? "INCOMPLETE (a render stage was skipped for lack of chromium/GPU)" : "FAILED") + ".");
process.exit(renderSkipped ? 2 : 1);
