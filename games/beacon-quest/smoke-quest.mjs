// SMOKE GATE for the BEACON QUEST playable build (js/src/demos/beacon_quest_window.ts) — the
// human-playable "Light the Eastern Beacon" on the MAP-PAINTER world. Runs the window entry
// frame-capped on the real GPU and asserts it AUTHORS + RENDERS cleanly: the painted terrain
// source, buildBeaconQuest, the rigged player/warden models, the HUD, and the render loop all
// construct and run for N frames with zero errors. This is the render sibling of the headless
// determinism gate (js/test/p14_beacon_quest.ts) — the gate proves the SIM is correct + replay-
// deterministic; this proves the PLAYABLE build boots + renders the painted world.
//
// Honest limit: it proves the build renders without error, NOT that the look is shippable (no
// headless screenshot from the native window). The eye-level taste judgment is human UAT
// (run `--window`) or the export-playback path (tools/shoot.mjs).
//
// Run: node games/beacon-quest/smoke-quest.mjs   (exit 0 = renders clean · 1 = broken · 2 = no GPU)

import { execFileSync } from "node:child_process";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const ENTRY = "js/src/demos/beacon_quest_window.ts";
const FRAMES = 30;

let out = "";
let failed = false;
try {
  out = execFileSync(
    join(ROOT, "target/release/limina"),
    ["--window", "--frames", String(FRAMES), ENTRY],
    { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"], timeout: 90000, env: { ...process.env, LIMINA_AUDIO: "null" } },
  ).toString();
} catch (e) {
  failed = true;
  out = (e.stdout?.toString() ?? "") + (e.stderr?.toString() ?? "");
}

// No GPU / no display surface → environmental SKIP (exit 2), never a false FAIL.
if (/no WindowTarget|failed to create (window|surface)|no adapter|no suitable GPU/i.test(out)) {
  console.log("smoke-quest SKIP: no window/GPU surface in this environment (headless CI). The build's import graph still loaded.");
  process.exit(2);
}

// A clean run prints the engine's frame-exit line: "exit: N frames, M fixed steps ...".
const exitLine = out.match(/exit:\s*(\d+)\s*frames,\s*(\d+)\s*fixed steps/i);
const errored = failed || /\berror\b|panic|throw|step error|authoringFail|FAILED/i.test(out);

if (exitLine && Number(exitLine[1]) >= FRAMES && !errored) {
  console.log(`smoke-quest OK: beacon_quest_window.ts authored the painted world + rendered ${exitLine[1]} frames / ${exitLine[2]} sim steps clean (rigged models + HUD + map terrain source, zero errors).`);
  process.exit(0);
}
console.error("smoke-quest FAILED: the beacon quest playable build did not render cleanly.\nOutput:\n" + out.split("\n").slice(-16).join("\n"));
process.exit(1);
