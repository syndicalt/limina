// HOST-SIDE (bun): Stage-1 Built-Spec intake CLI. Parse a markdown GDD (or a raw .gds.json), report
// the validated GDS or the gap report, and write the GDS artifact next to the source on success.
//
// Run: bun run tools/director/parse-gdd.ts <path/to/gdd.md|spec.gds.json>
//   exit 0 = a valid GDS · exit 1 = gaps (printed)

import { readFileSync, writeFileSync } from "node:fs";
import { parseGdd } from "../../js/src/game/intake.ts";
import { validateGDS } from "../../js/src/game/gds.ts";

const path = process.argv[2];
if (!path) {
  console.error("usage: bun run tools/director/parse-gdd.ts <gdd.md|spec.gds.json>");
  process.exit(2);
}

const raw = readFileSync(path, "utf8");
// A .json file is the spec directly; a markdown GDD embeds it in a ```json block.
const result = path.endsWith(".json")
  ? (() => { const v = validateGDS(JSON.parse(raw)); return { ok: v.ok, data: v.data, gaps: v.ok ? [] : v.issues.map((i) => i.path || "(root)") }; })()
  : (() => { const p = parseGdd(raw); return { ok: p.ok, data: p.data, gaps: p.gaps }; })();

if (!result.ok) {
  console.error("GDD intake FAILED — gaps to resolve: " + JSON.stringify(result.gaps));
  process.exit(1);
}

const out = path.replace(/\.(md|json)$/i, "") + ".gds.json";
writeFileSync(out, JSON.stringify(result.data, null, 2) + "\n");
console.log(`GDD intake OK: ${path} → ${out} (id="${result.data!.id}", ${result.data!.dod.length} DoD)`);
