// SMOKE GATE for the PLAYABLE build — the pipeline now gates the thing you actually PLAY, not just the
// headless sim. Runs the native window entry (js/src/demos/beacon_run_window.ts) WITHOUT --window, so it
// loads the full import graph + buildBeaconRunGame + the SHARED dressed field, then stops exactly at
// window-creation ("no WindowTarget"). That clean stop proves the playable build isn't broken; an
// import/type/logic break surfaces as a DIFFERENT error and FAILS this gate.
//
// Honest limit: a window can't open headless, so this verifies the build LOADS, not that it feels good.
// Run: node games/beacon-quest/smoke-playable.mjs   (exit 0 = loads clean · 1 = broken)

import { execFileSync } from "node:child_process";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const ENTRY = "js/src/demos/beacon_run_window.ts";

let out = "";
try {
  out = execFileSync(join(ROOT, "target/release/limina"), [ENTRY], { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"], timeout: 60000 }).toString();
} catch (e) {
  out = (e.stdout?.toString() ?? "") + (e.stderr?.toString() ?? "");
}

if (/no WindowTarget/.test(out)) {
  console.log("smoke-playable OK: beacon_run_window.ts loads cleanly (imports + game + shared dressed field); stops only at window-creation.");
  process.exit(0);
}
console.error("smoke-playable FAILED: the playable build did not load cleanly (expected a 'no WindowTarget' stop). Output:\n" + out.split("\n").slice(0, 14).join("\n"));
process.exit(1);
