// HOST-SIDE (bun): emit the GDS pipeline artifacts under tools/director/.
//
//   gds.schema.json                  — the JSON Schema llmff's `validate_json` stage gates GDS
//                                       artifacts with (emitted from the ONE Zod source of truth).
//   examples/relic-sprint.gds.json   — the hand-authored example, parsed + defaulted, as the
//                                       canonical Stage-1 output artifact.
//
// Run: bun run tools/director/emit-gds-schema.ts
//
// Imports the engine-side schema directly (the same module the in-engine gate uses), so the
// emitted JSON Schema can never drift from the runtime validation.

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gdsJsonSchema, GameDesignSpecSchema } from "../../js/src/game/gds.ts";
import { RELIC_SPRINT } from "../../js/src/game/examples/relic_sprint.gds.ts";

const here = dirname(fileURLToPath(import.meta.url));
const schema = gdsJsonSchema();
const example = GameDesignSpecSchema.parse(RELIC_SPRINT);

mkdirSync(join(here, "examples"), { recursive: true });
writeFileSync(join(here, "gds.schema.json"), JSON.stringify(schema, null, 2) + "\n");
writeFileSync(join(here, "examples", "relic-sprint.gds.json"), JSON.stringify(example, null, 2) + "\n");

console.log("wrote tools/director/gds.schema.json (" + JSON.stringify(schema).length + " bytes) + examples/relic-sprint.gds.json");
