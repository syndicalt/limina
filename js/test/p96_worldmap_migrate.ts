// p96_worldmap_migrate — forward-migration-on-read for the compiled WorldMap IR (worldmap.ts's
// migrateWorldMap), the day-one guard for the day WORLD_MAP_VERSION goes to 2 and every v1 map
// still on disk must keep loading.
//
// Run: ./target/release/limina js/test/p96_worldmap_migrate.ts
//
// Proves: (1) migrateWorldMap on a REAL current v1 map (compiled via compileDesignMap, the same
// pure compiler p_worldmap_compile.ts gates) is a HASH-IDENTICAL no-op — same contentHash before
// and after, and verifyWorldMap still reports ok:true post-migration; (2) FALSIFIABLE — a
// garbage/non-map object is still rejected by WorldMapSchema.parse(migrateWorldMap(x)), migration
// does not mask it; (3) a synthetic lower-version stub ({version:0,...}) is handed to the ladder
// without migrateWorldMap itself throwing (the shape is still rejected downstream by the schema,
// since no v0->v1 rung exists — there was never a v0 WorldMap); (4) the gate's own assertion
// harness is proven capable of catching a broken expectation (assert() flips a deliberately wrong
// claim to a thrown failure), so a silently-passing gate is ruled out.

import { ops } from "../src/engine.ts";
import { compileDesignMap } from "../src/world/design-map-compile.mjs";
import {
  WorldMapSchema,
  migrateWorldMap,
  stableStringifyWorldMap,
  verifyWorldMap,
  worldMapContentHash,
  WORLD_MAP_VERSION,
  type WorldMap,
} from "../src/world/worldmap.ts";

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error("p96_worldmap_migrate FAIL: " + message);
}

function readAssetText(assetId: string): string {
  return new TextDecoder().decode(ops.op_read_asset(assetId));
}

// ── 0. Falsifiability of the harness itself: assert() must actually throw on a false claim. ────
{
  let threw = false;
  try {
    assert(1 === 2, "1 must equal 2 (deliberately broken expectation)");
  } catch {
    threw = true;
  }
  assert(threw, "the assert() harness failed to catch a deliberately broken expectation — gate is not falsifiable");
}

// ── 1. A REAL current v1 map (compiled the same way p_worldmap_compile.ts does), migrated ──────
//    through migrateWorldMap, is a HASH-IDENTICAL NO-OP.
const mapsJsonText = readAssetText("maps/_fixtures/eastern-watch/maps.json");
const worldBibleText = readAssetText("maps/_fixtures/eastern-watch/world-bible.md");
const compiled = compileDesignMap({ mapsJsonText, worldBibleText });
const worldMap = compiled.worldMap as WorldMap;
assert(worldMap.version === WORLD_MAP_VERSION, `fixture must compile at the current version (got ${worldMap.version}, expected ${WORLD_MAP_VERSION})`);

const beforeHash = worldMapContentHash(worldMap);
const beforeStable = stableStringifyWorldMap(worldMap);

const migrated = migrateWorldMap(worldMap);
assert(migrated === (worldMap as unknown), "migrateWorldMap on an already-current WorldMap must return the SAME object by reference (no reorder/no clone)");

const reparsed = WorldMapSchema.parse(migrated);
const afterHash = worldMapContentHash(reparsed);
const afterStable = stableStringifyWorldMap(reparsed);
assert(afterHash === beforeHash, `migrateWorldMap must be hash-identical for a current-version map (before ${beforeHash}, after ${afterHash})`);
assert(afterStable === beforeStable, "migrateWorldMap must not perturb the stable-stringify bytes of a current-version map");

const verifyAfter = verifyWorldMap(migrated);
assert(verifyAfter.ok, `verifyWorldMap must still report ok:true after migration (expected ${verifyAfter.expected}, actual ${verifyAfter.actual})`);

// Also exercise verifyWorldMap's OWN internal migration call directly on the raw compiled object
// (mirrors how terrain.ts / terrain-edit.ts feed it JSON.parse output, not a pre-validated WorldMap).
const verifyDirect = verifyWorldMap(JSON.parse(JSON.stringify(worldMap)));
assert(verifyDirect.ok, `verifyWorldMap(migrate-on-read of a plain-JSON-round-tripped current map) must report ok:true (expected ${verifyDirect.expected}, actual ${verifyDirect.actual})`);

// ── 2. FALSIFIABLE: a garbage/non-map object is still rejected — migration must not mask it. ───
{
  const garbage = { not: "a worldmap", version: 1, id: 42 };
  let threw = false;
  try {
    WorldMapSchema.parse(migrateWorldMap(garbage));
  } catch {
    threw = true;
  }
  assert(threw, "a garbage object shaped like it has a version must still fail WorldMapSchema.parse after migrateWorldMap — migration must not mask a non-map file");
}
{
  let threw = false;
  try {
    WorldMapSchema.parse(migrateWorldMap(null));
  } catch {
    threw = true;
  }
  assert(threw, "null must still fail WorldMapSchema.parse after migrateWorldMap");
}
{
  let threw = false;
  try {
    WorldMapSchema.parse(migrateWorldMap("not even an object"));
  } catch {
    threw = true;
  }
  assert(threw, "a non-object primitive must still fail WorldMapSchema.parse after migrateWorldMap");
}

// ── 3. A synthetic LOWER-VERSION stub is handed to the ladder without migrateWorldMap itself ────
//    throwing. There is no real v0 WorldMap (v1 is the IR's origin version), so no ladder rung
//    exists to upgrade it — migrateWorldMap must still complete without throwing (passthrough),
//    leaving the (still-invalid) shape for WorldMapSchema.parse to reject downstream.
{
  const v0Stub = { version: 0, id: "stub", note: "pre-v1 shape that never actually shipped" };
  let migrateThrew = false;
  let migratedStub: unknown;
  try {
    migratedStub = migrateWorldMap(v0Stub);
  } catch {
    migrateThrew = true;
  }
  assert(!migrateThrew, "migrateWorldMap must not throw on a lower-version stub — the ladder degrades to a passthrough when no rung is defined");
  assert(migratedStub === v0Stub, "migrateWorldMap with no applicable ladder rung must return the input unchanged by reference");

  let parseThrew = false;
  try {
    WorldMapSchema.parse(migratedStub);
  } catch {
    parseThrew = true;
  }
  assert(parseThrew, "a v0 stub with no ladder rung must still fail WorldMapSchema.parse (version literal pins WORLD_MAP_VERSION) — it is not silently upgraded");
}

// ── 4. Non-numeric / missing version is passed through untouched (left for the schema to reject; ──
//    migrateWorldMap must never invent a default version that masks a non-map file).
{
  const noVersion = { id: "no-version-field" };
  const out = migrateWorldMap(noVersion);
  assert(out === noVersion, "an object with no `version` field must be returned unchanged by reference");
  let threw = false;
  try {
    WorldMapSchema.parse(out);
  } catch {
    threw = true;
  }
  assert(threw, "an object with no `version` field must still fail WorldMapSchema.parse after migrateWorldMap");
}

ops.op_log(
  "[js] p96_worldmap_migrate OK: migrateWorldMap on a real compiled v1 map (eastern-watch fixture) is a " +
  `hash-identical no-op (contentHash ${beforeHash.slice(0, 12)}... unchanged, same object by reference) and ` +
  "verifyWorldMap still reports ok:true post-migration; a garbage/non-map object (and null, and a bare string) " +
  "is still rejected by WorldMapSchema.parse after migration; a synthetic lower-version {version:0} stub is " +
  "handed to the ladder without migrateWorldMap throwing (passthrough — no rung defined, still rejected " +
  "downstream by the schema); a version-less object is left untouched for the schema to reject; and the " +
  "harness's own assert() is proven to catch a deliberately broken expectation.",
);
