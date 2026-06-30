// HOST-SIDE (bun): validate a GDS JSON artifact against the emitted JSON Schema with Ajv — the
// SAME structural gate llmff's `validate_json` stage applies at the pipeline boundary. This proves
// the GDS artifact format is llmff-compatible end to end (Zod source -> JSON Schema -> Ajv check).
//
// Run: bun run tools/director/check-gds.ts [path/to/spec.gds.json]
//   (defaults to the emitted example)

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv from "ajv";

const here = dirname(fileURLToPath(import.meta.url));
const schemaPath = join(here, "gds.schema.json");
const schema = JSON.parse(readFileSync(schemaPath, "utf8")) as Record<string, unknown>;
const file = process.argv[2] ?? join(here, "examples", "relic-sprint.gds.json");
const data = JSON.parse(readFileSync(file, "utf8"));

// strict:false — zod v4 emits a couple of keywords (e.g. additionalProperties handling) Ajv's
// strict mode flags as warnings; we want pure structural validation like llmff does.
const ajv = new Ajv({ strict: false, allErrors: true });
const validate = ajv.compile(schema);

if (!validate(data)) {
  console.error("GDS FAILED schema validation against " + schemaPath + ":");
  console.error(JSON.stringify(validate.errors, null, 2));
  process.exit(1);
}

// Falsifiability: a deliberately broken clone (drop the required winCondition) MUST be rejected,
// proving the gate actually gates rather than rubber-stamping.
const broken = JSON.parse(JSON.stringify(data)) as Record<string, unknown>;
delete broken.winCondition;
if (validate(broken)) {
  console.error("GDS schema gate is INERT: a spec missing winCondition passed validation");
  process.exit(1);
}

console.log("GDS OK: " + file + " validates against gds.schema.json; a malformed spec is rejected (llmff validate_json compatible)");
