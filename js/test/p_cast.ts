// P_CAST -- versioned cast design artifact schema.
//
// Run: ./target/release/limina js/test/p_cast.ts

import { ops } from "../src/engine.ts";
import {
  DEFAULT_CAST,
  parseCast,
  serializeCast,
  validateCast,
  type Cast,
} from "../src/game/cast.ts";

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error("p_cast FAIL: " + message);
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function assertThrows(fn: () => unknown, message: string): void {
  let threw = false;
  try { fn(); } catch { threw = true; }
  assert(threw, message);
}

function fresh(): Cast {
  return parseCast(serializeCast(DEFAULT_CAST));
}

const good = fresh();
const validation = validateCast(good);
assert(validation.ok, `DEFAULT_CAST must validate: ${JSON.stringify(validation.issues)}`);

const jsonA = serializeCast(good);
const jsonB = serializeCast(good);
assert(jsonA === jsonB, "serializeCast must be byte-stable across repeated calls");
assert(serializeCast(parseCast(jsonA)) === jsonA, "serialize(parse(serialize(cast))) must be byte-stable");

{
  const bad = clone(good) as Record<string, unknown>;
  bad.player = [{ id: "p1", name: "Wrong", archetype: "guard" }];
  assertThrows(() => parseCast(JSON.stringify(bad)), "must reject a non-object player (wrong player count shape)");
}

{
  const bad = clone(good);
  bad.npcs[0].id = bad.player.id;
  const result = validateCast(bad);
  assert(!result.ok, "must reject duplicate ids across player and NPCs");
  assert(result.issues.some((i) => i.path === `npcs.${bad.player.id}`), "duplicate NPC issue must identify the id");
}

{
  const fallback = clone(good);
  fallback.player.archetype = "custom-warden";
  const result = validateCast(fallback);
  assert(result.ok, `string fallback archetype must validate: ${JSON.stringify(result.issues)}`);
  assert(parseCast(serializeCast(fallback)).player.archetype === "custom-warden", "custom archetype must round-trip");
}

{
  const bad = clone(good) as Record<string, unknown>;
  (bad.player as Record<string, unknown>).extra = true;
  assertThrows(() => parseCast(JSON.stringify(bad)), "must reject unknown nested keys on player");
}

ops.op_log("[js] p_cast OK: schema validates a good cast, rejects wrong player shape/duplicate ids/strict extras, allows string fallback archetypes, and round-trips byte-stable");
