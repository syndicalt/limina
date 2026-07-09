// BEACON QUEST — W5 export gate. Regression-protects the painted-world Mode-A export
// (games/beacon-quest/build/world-export.ts → the /examples deliverable). Headless + display-
// independent (the export itself needs no GPU): runs the exporter through the limina binary and
// asserts it produced a REAL, replay-complete package — the peek scene replayed clean, the
// stamped buildings placed, keyframes + a bundled asset set written, and the manifest/log/
// keyframes/assets files present + parseable. A stub, an empty world, or a broken export FAILS.
//
// FALSIFIABILITY: the checks are counts + structure the exporter can't fake — 0 stamped buildings,
// 0 commands, a missing asset bundle, or an unparseable manifest each fail the gate.
//
// Run: node games/beacon-quest/export-gate.mjs   (exit 0 = real export · 1 = broken · 2 = env skip)

import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const LIMINA = join(ROOT, "target/release/limina");
const EXPORTER = "games/beacon-quest/build/world-export.ts";
const GAME_ASSETS = join(ROOT, "games", "beacon-quest", "assets");

if (!existsSync(LIMINA)) {
  console.log("export-gate SKIP: no ./target/release/limina (build the engine first: cargo build --release).");
  process.exit(2);
}
if (!existsSync(join(ROOT, "assets/maps/beacon-quest-primary.worldmap.json"))) {
  console.error("export-gate FAILED: the committed Beacon Quest WorldMap is missing (regenerate via games/beacon-quest/world.mjs + compile).");
  process.exit(1);
}

let out = "";
try {
  out = execFileSync(LIMINA, [EXPORTER], {
    cwd: ROOT,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 180000,
    env: { ...process.env, LIMINA_AUDIO: "null", LIMINA_ASSET_ROOT: GAME_ASSETS },
  }).toString();
} catch (e) {
  console.error("export-gate FAILED: the exporter did not run to completion.\n" + ((e.stdout?.toString() ?? "") + (e.stderr?.toString() ?? "")).split("\n").slice(-16).join("\n"));
  process.exit(1);
}

// The exporter's success line: "... replayed the peek scene (N skills incl. M stamped buildings) →
// C commands, K keyframes, A assets bundled. Wrote: ...".
const m = out.match(/replayed the peek scene \((\d+) skills incl\. (\d+) stamped buildings\)\s*→\s*(\d+) commands,\s*(\d+) keyframes,\s*(\d+) assets bundled/);
if (!m) {
  console.error("export-gate FAILED: no valid export summary line.\nOutput tail:\n" + out.split("\n").slice(-16).join("\n"));
  process.exit(1);
}
const [, skills, buildings, commands, keyframes, assets] = m.map(Number);

const checks = [
  ["stamped buildings placed (the painted village is in the export)", buildings >= 6],
  ["a substantial command stream (not an empty world)", commands >= 10],
  ["keyframes captured (placed transforms are replay-visible)", keyframes >= 1],
  ["an asset bundle shipped (glbs ride the export, not 404s)", assets >= 8],
  ["skills replayed (peek scene ran clean)", skills >= 8],
];
let failed = false;
for (const [name, cond] of checks) {
  if (cond) { console.log("  ok  " + name); }
  else { console.error("  FAIL " + name); failed = true; }
}

// The written package files must exist + parse (the exporter writes them to traces/).
for (const f of ["manifest.json", "keyframes.jsonl"]) {
  const p = join(ROOT, "traces", "beacon." + f);
  if (!existsSync(p)) { console.error("  FAIL package file missing: traces/beacon." + f); failed = true; continue; }
  if (f.endsWith(".json")) {
    try { JSON.parse(readFileSync(p, "utf8")); console.log("  ok  traces/beacon." + f + " parses"); }
    catch { console.error("  FAIL traces/beacon." + f + " is not valid JSON"); failed = true; }
  }
}

if (failed) { console.error("\nexport-gate: FAIL"); process.exit(1); }
console.log(`\nexport-gate OK: painted-world Mode-A export is real — ${skills} skills / ${buildings} buildings / ${commands} commands / ${keyframes} keyframes / ${assets} assets, package files parse. The /examples deliverable round-trips.`);
process.exit(0);
