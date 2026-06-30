// M2 GATE — THE GAME DESIGN SPEC (GDS). Proves the pipeline's spine artifact: a TypeScript + Zod
// schema that (a) accepts a complete hand-authored spec, (b) rejects malformed specs structurally,
// (c) enforces cross-field semantic invariants (one player, state-transition DoDs carry a drive
// script, at least one automated DoD), (d) round-trips through JSON unchanged, and (e) emits a
// clean JSON Schema (zod v4 native) so llmff's validate_json can gate it at the pipeline boundary.
//
// Run: ./target/release/limina js/test/p21_gds.ts   (exit 0 = pass)

import {
  validateGDS, gdsJsonSchema, GameDesignSpecSchema, type GameDesignSpec,
} from "../src/game/gds.ts";
import { RELIC_SPRINT } from "../src/game/examples/relic_sprint.gds.ts";

function assert(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new Error("p21_gds FAIL: " + msg);
}

/** Structured clone via JSON so a test mutation never touches the shared fixture. */
function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

// ════════════════════════ 1. THE HAND-AUTHORED SPEC VALIDATES ═════════════════════════════════
{
  const r = validateGDS(RELIC_SPRINT);
  assert(r.ok, "the hand-authored RELIC_SPRINT spec must validate, issues: " + JSON.stringify(r.issues));
  assert(r.data !== undefined, "valid spec must return parsed data");
  assert(r.data!.entities.length === 2, "expected 2 entities");
  // Defaults are applied (repeat defaults to 1 where omitted, states default to []).
  assert(r.data!.dod[0].drives!.steps[0].repeat === 600, "explicit repeat preserved");
}

// ════════════════════════ 2. STRUCTURAL REJECTION (Zod) ═══════════════════════════════════════
{
  const bad = clone(RELIC_SPRINT) as Record<string, unknown>;
  delete bad.winCondition;
  const r = validateGDS(bad);
  assert(!r.ok, "a spec missing winCondition must be rejected");
  assert(r.issues.some((i) => i.path === "winCondition"), "issue must point at winCondition: " + JSON.stringify(r.issues));
}
{
  const bad = clone(RELIC_SPRINT);
  // @ts-expect-error — deliberately invalid enum for the test
  bad.entities[0].role = "wizard";
  const r = validateGDS(bad);
  assert(!r.ok, "an invalid entity role must be rejected");
}
{
  const bad = clone(RELIC_SPRINT);
  bad.dod = []; // min(1) violated
  const r = validateGDS(bad);
  assert(!r.ok, "a spec with no DoD must be rejected (min 1)");
}

// ════════════════════════ 3. SEMANTIC INVARIANTS ══════════════════════════════════════════════
{
  // A state-transition DoD without a drive script is structurally valid but semantically illegal.
  const bad = clone(RELIC_SPRINT);
  delete bad.dod[0].drives;
  const r = validateGDS(bad);
  assert(!r.ok, "a state-transition DoD without drives must be rejected semantically");
  assert(r.issues.some((i) => i.message.includes("drives")), "issue must mention the missing drive script");
}
{
  // No player entity.
  const bad = clone(RELIC_SPRINT);
  bad.entities[0].role = "npc";
  const r = validateGDS(bad);
  assert(!r.ok, "a spec with zero player entities must be rejected");
  assert(r.issues.some((i) => i.message.includes("player")), "issue must mention the player requirement");
}
{
  // Two players.
  const bad = clone(RELIC_SPRINT);
  bad.entities[1].role = "player";
  const r = validateGDS(bad);
  assert(!r.ok, "a spec with two player entities must be rejected");
}
{
  // Duplicate entity ids.
  const bad = clone(RELIC_SPRINT);
  bad.entities[1].id = "player";
  const r = validateGDS(bad);
  assert(!r.ok, "duplicate entity ids must be rejected");
  assert(r.issues.some((i) => i.message.includes("duplicate")), "issue must mention duplicate id");
}
{
  // Only "feel" DoDs → no automated gate.
  const bad = clone(RELIC_SPRINT);
  bad.dod = [{ id: "feel-only", statement: "feels good", kind: "feel" }];
  const r = validateGDS(bad);
  assert(!r.ok, "a spec with only feel DoDs (no automated gate) must be rejected");
}

// ════════════════════════ 4. JSON ROUND-TRIP STABILITY ════════════════════════════════════════
{
  const parsedOnce = GameDesignSpecSchema.parse(RELIC_SPRINT);
  const roundTripped = GameDesignSpecSchema.parse(JSON.parse(JSON.stringify(parsedOnce)));
  assert(JSON.stringify(parsedOnce) === JSON.stringify(roundTripped),
    "GDS must be stable across a JSON round-trip (defaults applied identically)");
}

// ════════════════════════ 5. JSON SCHEMA EMISSION (for llmff validate_json) ════════════════════
{
  const schema = gdsJsonSchema();
  assert(typeof schema === "object" && schema !== null, "gdsJsonSchema must return an object");
  assert(schema.type === "object", `emitted schema root type must be object (got ${String(schema.type)})`);
  const props = schema.properties as Record<string, unknown> | undefined;
  assert(props !== undefined, "emitted schema must have properties");
  for (const must of ["id", "pitch", "loopSentence", "winCondition", "entities", "dod"]) {
    assert(must in props, `emitted JSON Schema must describe property "${must}"`);
  }
  const required = schema.required as string[] | undefined;
  assert(Array.isArray(required) && required.includes("id") && required.includes("dod"),
    "emitted JSON Schema must mark id + dod as required");
  // The emitted schema must itself be JSON-serializable (it rides the pipeline as an artifact).
  const serialized = JSON.stringify(schema);
  assert(serialized.length > 100, "emitted schema serialized suspiciously small");
}

// A nested type (DoDAssertion) survives emission with its enum intact.
{
  const schema = gdsJsonSchema();
  const serialized = JSON.stringify(schema);
  assert(serialized.includes("state-transition") && serialized.includes("feel"),
    "emitted schema must carry the DoD kind enum (state-transition | feel)");
  assert(serialized.includes("counterAtLeast") || serialized.includes("gameState"),
    "emitted schema must carry the Assertion.check enum");
}

const schemaBytes = JSON.stringify(gdsJsonSchema()).length;
const dodCount = RELIC_SPRINT.dod.length;
const autoDod = RELIC_SPRINT.dod.filter((d: GameDesignSpec["dod"][number]) => d.kind === "state-transition").length;
console.log(
  `p21_gds OK: GDS schema validated the hand-authored RELIC_SPRINT (${RELIC_SPRINT.entities.length} entities, ` +
  `${dodCount} DoD / ${autoDod} automated); structural + semantic rejections fire (missing fields, bad enums, ` +
  `zero/two players, duplicate ids, drive-less state-transition DoD, feel-only specs); JSON round-trip stable; ` +
  `and a ${schemaBytes}-byte JSON Schema emits for llmff validate_json (root object, id+dod required, enums intact).`,
);
