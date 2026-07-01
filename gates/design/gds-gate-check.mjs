// Falsifiability check for the GDS design gate, on REALISTIC game content (real assets, grouped into
// tiers as a real GDS would). A well-art-directed game PASSES; a samey game (a tier of clones)
// HARD-FAILS. Proves the GDS->gate bridge is real, not a rubber-stamp.
//
// Run: node gates/design/gds-gate-check.mjs  (exit 0 = real + falsifiable · 1 = broken · 2 = no browser)

import { runGdsDesignGate } from "./gds-gate.mjs";

// A well-made game: each tier holds perceptually distinct assets.
const GOOD = { content: [
  { id: "pine", kind: "environment", tier: "vegetation", asset: "pine.glb" },
  { id: "snag", kind: "environment", tier: "vegetation", asset: "vegetation-dead-tree-1.glb" },
  { id: "broadleaf", kind: "environment", tier: "vegetation", asset: "broadleaf.glb" },
  { id: "bush", kind: "environment", tier: "vegetation", asset: "bush.glb" },
  { id: "tower", kind: "prop", tier: "structure", asset: "building-wooden-watchtower-1.glb" },
  { id: "cottage", kind: "prop", tier: "structure", asset: "cottage.glb" },
  { id: "well", kind: "prop", tier: "structure", asset: "prop-water-well-1.glb" },
] };

// A samey game: the "vegetation" tier is three clones of the same tree.
const OATMEAL = { content: [
  { id: "tree1", kind: "environment", tier: "vegetation", asset: "pine.glb" },
  { id: "tree2", kind: "environment", tier: "vegetation", asset: "pine.glb" },
  { id: "tree3", kind: "environment", tier: "vegetation", asset: "pine.glb" },
  { id: "tower", kind: "prop", tier: "structure", asset: "building-wooden-watchtower-1.glb" },
  { id: "cottage", kind: "prop", tier: "structure", asset: "cottage.glb" },
] };

console.error("GDS gate on a well-art-directed game (expect PASS)...");
const good = await runGdsDesignGate(GOOD);
console.error(`  GOOD:    pass=${good.pass} score=${good.score} tiers=${JSON.stringify(good.tiers)} failures=${good.failures.length ? JSON.stringify(good.failures) : "none"}`);

console.error("GDS gate on a samey game (vegetation tier = 3 clones — expect HARD-FAIL)...");
const oat = await runGdsDesignGate(OATMEAL);
console.error(`  OATMEAL: pass=${oat.pass} score=${oat.score} tiers=${JSON.stringify(oat.tiers)} failures=${JSON.stringify(oat.failures)}`);

let ok = true;
if (!good.pass) { console.error("FAIL: the well-art-directed GDS should PASS."); ok = false; }
if (oat.pass) { console.error("FAIL: the samey GDS should HARD-FAIL — the gate is a no-op."); ok = false; }

console.log(ok
  ? `check-gds-design-gate OK: well-art-directed game PASSES (score ${good.score}), samey game HARD-FAILS (score ${oat.score}). The GDS design gate is real + falsifiable.`
  : "check-gds-design-gate FAILED.");
process.exit(ok ? 0 : 1);
