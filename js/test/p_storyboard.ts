// P_STORYBOARD -- versioned storyboard design artifact schema.
//
// Run: ./target/release/limina js/test/p_storyboard.ts

import { ops } from "../src/engine.ts";
import {
  DEFAULT_STORYBOARD,
  parseStoryboard,
  serializeStoryboard,
  validateStoryboard,
  type Storyboard,
} from "../src/game/storyboard.ts";

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error("p_storyboard FAIL: " + message);
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function assertThrows(fn: () => unknown, message: string): void {
  let threw = false;
  try { fn(); } catch { threw = true; }
  assert(threw, message);
}

function fresh(): Storyboard {
  return parseStoryboard(serializeStoryboard(DEFAULT_STORYBOARD));
}

const good = fresh();
const validation = validateStoryboard(good);
assert(validation.ok, `DEFAULT_STORYBOARD must validate: ${JSON.stringify(validation.issues)}`);

const jsonA = serializeStoryboard(good);
const jsonB = serializeStoryboard(good);
assert(jsonA === jsonB, "serializeStoryboard must be byte-stable across repeated calls");
assert(serializeStoryboard(parseStoryboard(jsonA)) === jsonA, "serialize(parse(serialize(storyboard))) must be byte-stable");

{
  const bad = clone(good) as Record<string, unknown>;
  ((((bad.quests as Array<Record<string, unknown>>)[0]).steps as Array<Record<string, unknown>>)[0]).kind = "escort";
  assertThrows(() => parseStoryboard(JSON.stringify(bad)), "must reject an unknown quest step kind enum");
}

{
  const bad = clone(good);
  bad.beats.push({ ...bad.beats[0], title: "Duplicate beat" });
  const result = validateStoryboard(bad);
  assert(!result.ok, "must reject duplicate beat ids");
  assert(result.issues.some((i) => i.path === "beats.arrival"), "duplicate beat issue must identify the id");
}

{
  const bad = clone(good);
  bad.quests.push({ ...bad.quests[0], name: "Duplicate quest" });
  const result = validateStoryboard(bad);
  assert(!result.ok, "must reject duplicate quest ids");
  assert(result.issues.some((i) => i.path === "quests.first-light"), "duplicate quest issue must identify the id");
}

{
  const bad = clone(good);
  bad.quests[0].steps.push({ ...bad.quests[0].steps[0], objective: "Duplicate step" });
  const result = validateStoryboard(bad);
  assert(!result.ok, "must reject duplicate step ids within a quest");
  assert(result.issues.some((i) => i.path === "quests.first-light.steps.reach-camp"), "duplicate step issue must identify the quest and step");
}

ops.op_log("[js] p_storyboard OK: schema validates a good storyboard, rejects bad step kind/duplicate beat/quest/step ids, and round-trips byte-stable");
