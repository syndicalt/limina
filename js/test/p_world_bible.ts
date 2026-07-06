// P_WORLD_BIBLE -- versioned world-bible design artifact schema.
//
// Run: ./target/release/limina js/test/p_world_bible.ts

import { ops } from "../src/engine.ts";
import {
  DEFAULT_WORLD_BIBLE,
  parseWorldBible,
  serializeWorldBible,
  validateWorldBible,
  type WorldBible,
} from "../src/game/world-bible.ts";

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error("p_world_bible FAIL: " + message);
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function assertThrows(fn: () => unknown, message: string): void {
  let threw = false;
  try { fn(); } catch { threw = true; }
  assert(threw, message);
}

function fresh(): WorldBible {
  return parseWorldBible(serializeWorldBible(DEFAULT_WORLD_BIBLE));
}

const good = fresh();
const validation = validateWorldBible(good);
assert(validation.ok, `DEFAULT_WORLD_BIBLE must validate: ${JSON.stringify(validation.issues)}`);

const jsonA = serializeWorldBible(good);
const jsonB = serializeWorldBible(good);
assert(jsonA === jsonB, "serializeWorldBible must be byte-stable across repeated calls");
assert(serializeWorldBible(parseWorldBible(jsonA)) === jsonA, "serialize(parse(serialize(worldBible))) must be byte-stable");

{
  const bad = clone(good) as Record<string, unknown>;
  ((bad.regions as Array<Record<string, unknown>>)[0]).biome = "jungle";
  assertThrows(() => parseWorldBible(JSON.stringify(bad)), "must reject an unknown biome enum");
}

{
  const bad = clone(good);
  bad.locations[0].regionId = "missing-region";
  const result = validateWorldBible(bad);
  assert(!result.ok, "must reject a location whose regionId does not reference a region");
  assert(result.issues.some((i) => i.path === "locations.home.regionId"), "dangling reference issue must identify the location");
}

{
  const bad = clone(good);
  bad.regions.push({ ...bad.regions[0], name: "Duplicate region" });
  const result = validateWorldBible(bad);
  assert(!result.ok, "must reject duplicate region ids");
  assert(result.issues.some((i) => i.path === "regions.home-region"), "duplicate region issue must identify the id");
}

{
  const bad = clone(good);
  bad.locations.push({ ...bad.locations[0], name: "Duplicate location" });
  const result = validateWorldBible(bad);
  assert(!result.ok, "must reject duplicate location ids");
  assert(result.issues.some((i) => i.path === "locations.home"), "duplicate location issue must identify the id");
}

ops.op_log("[js] p_world_bible OK: schema validates a good world bible, rejects bad biome/dangling region/duplicate ids, and round-trips byte-stable");
