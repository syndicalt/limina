// HOST-SIDE (bun): the Stage-5 web-build step. Produce a static, self-contained web build of a GDS
// game under dist/<gdsId>/ — drop-anywhere HTML + JS that renders the game and publishes the
// diagnostics global the tier-2 gate reads. GDS-driven: the spec's id/loop/win text is injected, so
// the artifact tracks the pipeline rather than being a hand-faked duplicate.
//
// Run: bun run tools/director/build-web.ts   (builds the RELIC_SPRINT example)

import { readFileSync, writeFileSync, mkdirSync, copyFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { validateGDS } from "../../js/src/game/gds.ts";
import { RELIC_SPRINT } from "../../js/src/game/examples/relic_sprint.gds.ts";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..");

const v = validateGDS(RELIC_SPRINT);
if (!v.ok || v.data === undefined) {
  console.error("build-web: GDS is invalid:", JSON.stringify(v.issues, null, 2));
  process.exit(1);
}
const gds = v.data;

const outDir = join(repoRoot, "dist", gds.id);
mkdirSync(outDir, { recursive: true });

// Inject the GDS subset the browser build needs into the template.
const gdsSubset = { id: gds.id, loopSentence: gds.loopSentence, winCondition: gds.winCondition };
const template = readFileSync(join(here, "web-template", "index.html"), "utf8");
const html = template
  .replace("__TITLE__", gds.id)
  .replace("__CAPTION__", gds.loopSentence)
  .replace("__GDS__", JSON.stringify(gdsSubset));

writeFileSync(join(outDir, "index.html"), html);
copyFileSync(join(here, "web-template", "game.js"), join(outDir, "game.js"));

console.log("build-web: wrote " + join("dist", gds.id, "index.html") + " + game.js (static, self-contained)");
