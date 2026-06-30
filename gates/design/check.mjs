// FALSIFIABILITY CHECK for the silhouette design gate. The discipline test that a gate is REAL, not a
// rubber-stamp: a set of distinct assets must PASS, and a clone-heavy "oatmeal" set must HARD-FAIL. If
// the oatmeal set passes, the gate is a no-op and this exits non-zero.
//
// Run: node gates/design/check.mjs   (exit 0 = real + falsifiable · 1 = broken/rubber-stamp · 2 = no browser)

import { runSilhouetteGate } from "./silhouette-gate.mjs";

const DISTINCT = ["pine.glb", "vegetation-dead-tree-1.glb", "building-wooden-watchtower-1.glb", "rock.glb", "prop-barrel-1.glb", "prop-water-well-1.glb", "broadleaf.glb", "bush.glb", "cottage.glb"].map((a) => ({ label: a, asset: a }));
const OATMEAL = ["pine.glb", "pine.glb", "pine.glb", "pine.glb", "pine.glb", "rock.glb", "rock.glb", "bush.glb"].map((a, i) => ({ label: `${a}#${i}`, asset: a }));

console.error("rendering DISTINCT set (expect PASS)...");
const d = await runSilhouetteGate(DISTINCT);
console.error(`  distinct: pass=${d.pass} score=${d.score} ${JSON.stringify(d.stats)} failures=${d.failures.length ? JSON.stringify(d.failures) : "none"}`);

console.error("rendering OATMEAL set (5×pine + 2×rock + bush — expect HARD-FAIL)...");
const o = await runSilhouetteGate(OATMEAL);
console.error(`  oatmeal:  pass=${o.pass} score=${o.score} ${JSON.stringify(o.stats)} failures=${JSON.stringify(o.failures)}`);

let ok = true;
if (!d.pass) { console.error("FAIL: the distinct set should PASS but didn't — gate too strict."); ok = false; }
if (o.pass) { console.error("FAIL: the oatmeal set should HARD-FAIL but PASSED — the gate is a no-op stub."); ok = false; }

console.log(ok
  ? `check-silhouette-gate OK: distinct PASSES (score ${d.score}), oatmeal HARD-FAILS (score ${o.score}, ${o.failures.map((f) => f.gate).join("+")}). The design gate is real + falsifiable.`
  : "check-silhouette-gate FAILED.");
process.exit(ok ? 0 : 1);
