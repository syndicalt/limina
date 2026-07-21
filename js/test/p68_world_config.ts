import { ops } from "../src/engine.ts";
import {
  DEFAULT_WORLD_CONFIG,
  parseWorldConfig,
  serializeWorldConfig,
  WorldConfigSchema,
} from "../src/world/world-config.ts";
// COMPOSITION SOURCES — imported so the assertions run against the ACTUAL engine surfaces
// (the anti-reward-hack contract), never against a copy of them.
import { TERRAIN_TYPE_NAMES } from "../src/terrain/terrain-types.ts";
import { LookProfileSchema } from "../src/render/look-profile.ts";
import { DEFAULT_FOREST_CONFIG } from "../src/game/forest-config.ts";

function assert(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new Error("p68_world_config: " + msg);
}

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function assertThrows(fn: () => unknown, msg: string): void {
  let threw = false;
  try {
    fn();
  } catch {
    threw = true;
  }
  assert(threw, msg);
}

/** A fresh, structurally-valid mutable clone of the default (via the serialized form). */
function freshConfig(): Record<string, unknown> {
  return JSON.parse(serializeWorldConfig(DEFAULT_WORLD_CONFIG)) as Record<string, unknown>;
}

// ── 1. Round-trip determinism ────────────────────────────────────────────────────────────
const jsonA = serializeWorldConfig(DEFAULT_WORLD_CONFIG);
const jsonB = serializeWorldConfig(DEFAULT_WORLD_CONFIG);
assert(jsonA === jsonB, "serializeWorldConfig must be byte-identical across repeated calls");
assert(
  deepEqual(parseWorldConfig(jsonA), DEFAULT_WORLD_CONFIG),
  "DEFAULT_WORLD_CONFIG must parse/serialize round-trip (deepEqual)",
);
assert(
  serializeWorldConfig(parseWorldConfig(jsonA)) === jsonA,
  "serialize(parse(serialize(DEFAULT))) must equal serialize(DEFAULT)",
);

// ── 2. Reject invalid ────────────────────────────────────────────────────────────────────
// Unknown terrain type ("canyon" is NOT in the real catalog).
{
  const bad = freshConfig();
  (bad.terrain as Record<string, unknown>).type = "canyon";
  assertThrows(() => parseWorldConfig(JSON.stringify(bad)), "must reject unknown terrain type 'canyon'");
}
// Out-of-range latitude (200 > 90).
{
  const bad = freshConfig();
  (bad.climate as Record<string, unknown>).latitude = 200;
  assertThrows(() => parseWorldConfig(JSON.stringify(bad)), "must reject latitude 200 (out of -90..90)");
}
// Negative extentM (region size must be positive).
{
  const bad = freshConfig();
  (bad.region as Record<string, unknown>).extentM = -1;
  assertThrows(() => parseWorldConfig(JSON.stringify(bad)), "must reject negative region.extentM");
}
// Extra/unknown top-level key (.strict).
{
  const bad = freshConfig();
  bad.bogusUnknownKey = 42;
  assertThrows(() => parseWorldConfig(JSON.stringify(bad)), "must reject unknown top-level key (.strict)");
}
// Extra/unknown nested key (.strict on sub-objects).
{
  const bad = freshConfig();
  (bad.terrain as Record<string, unknown>).bogusNested = true;
  assertThrows(() => parseWorldConfig(JSON.stringify(bad)), "must reject unknown nested key (.strict sub-object)");
}
// Missing required — terrain / region / seed.
{
  const noTerrain = freshConfig();
  delete noTerrain.terrain;
  assertThrows(() => parseWorldConfig(JSON.stringify(noTerrain)), "must reject config missing terrain");

  const noRegion = freshConfig();
  delete noRegion.region;
  assertThrows(() => parseWorldConfig(JSON.stringify(noRegion)), "must reject config missing region");

  const noSeed = freshConfig();
  delete noSeed.seed;
  assertThrows(() => parseWorldConfig(JSON.stringify(noSeed)), "must reject config missing seed");
}

// ── 3. COMPOSITION IS REAL — assert against the imported sources ──────────────────────────
// (a) EVERY real terrain-type name must validate as terrain.type; a non-member must reject.
assert(TERRAIN_TYPE_NAMES.length === 7, `expected 7 terrain types, got ${TERRAIN_TYPE_NAMES.length}`);
for (const name of TERRAIN_TYPE_NAMES) {
  const cfg = freshConfig();
  (cfg.terrain as Record<string, unknown>).type = name;
  assert(
    parseWorldConfig(JSON.stringify(cfg)).terrain.type === name,
    `terrain.type must accept real catalog member '${name}'`,
  );
}
{
  const cfg = freshConfig();
  (cfg.terrain as Record<string, unknown>).type = "mesa"; // not in TERRAIN_TYPE_NAMES
  assert(
    !TERRAIN_TYPE_NAMES.includes("mesa" as (typeof TERRAIN_TYPE_NAMES)[number]),
    "sanity: 'mesa' must not be a real terrain type",
  );
  assertThrows(() => parseWorldConfig(JSON.stringify(cfg)), "terrain.type must reject non-member 'mesa'");
}

// (b) atmosphere.sky must accept EXACTLY the LookProfile sky options, and grade.tonemap must
//     match LookProfile's tonemap options — asserted against the imported LookProfileSchema.
const atmoSchema = WorldConfigSchema.shape.atmosphere.unwrap();
const lookSky = LookProfileSchema.shape.sky.options;
const worldSky = atmoSchema.shape.sky.options;
assert(deepEqual(worldSky, lookSky), `atmosphere.sky options must equal LookProfile sky options: ${JSON.stringify(worldSky)} vs ${JSON.stringify(lookSky)}`);
for (const sky of lookSky) {
  const cfg = freshConfig();
  (cfg.atmosphere as Record<string, unknown>).sky = sky;
  assert(parseWorldConfig(JSON.stringify(cfg)).atmosphere?.sky === sky, `atmosphere.sky must accept LookProfile option '${sky}'`);
}
{
  const cfg = freshConfig();
  (cfg.atmosphere as Record<string, unknown>).sky = "aurora"; // not a LookProfile sky
  assertThrows(() => parseWorldConfig(JSON.stringify(cfg)), "atmosphere.sky must reject a non-LookProfile option");
}
const lookTonemap = LookProfileSchema.shape.grade.shape.tonemap.options;
const worldTonemap = atmoSchema.shape.grade.shape.tonemap.options;
assert(deepEqual(worldTonemap, lookTonemap), `atmosphere.grade.tonemap options must equal LookProfile's: ${JSON.stringify(worldTonemap)} vs ${JSON.stringify(lookTonemap)}`);

// (c) vegetation must accept a ForestConfig-shaped species mix { id, weight01 } — taken from
//     the ACTUAL DEFAULT_FOREST_CONFIG so the shapes are provably compatible.
{
  const cfg = freshConfig();
  const veg = cfg.vegetation as Record<string, unknown>;
  const canopy = veg.canopy as Record<string, unknown>;
  canopy.species = DEFAULT_FOREST_CONFIG.canopy.species.map((s) => ({ id: s.id, weight01: s.weight01 }));
  const parsed = parseWorldConfig(JSON.stringify(cfg));
  assert(
    (parsed.vegetation?.canopy.species.length ?? 0) === DEFAULT_FOREST_CONFIG.canopy.species.length,
    "vegetation must accept a ForestConfig-shaped species mix { id, weight01 }",
  );
}

// ── 4. Region / tile addressing validation ───────────────────────────────────────────────
{
  const badTile = freshConfig();
  (badTile.region as Record<string, unknown>).tileSizeM = 0; // must be positive
  assertThrows(() => parseWorldConfig(JSON.stringify(badTile)), "region.tileSizeM must be positive (reject 0)");

  const badLodFrac = freshConfig();
  (badLodFrac.region as Record<string, unknown>).lod = 1.5; // must be integer
  assertThrows(() => parseWorldConfig(JSON.stringify(badLodFrac)), "region.lod must be an integer (reject 1.5)");

  const badLodNeg = freshConfig();
  (badLodNeg.region as Record<string, unknown>).lod = -1; // must be >= 0
  assertThrows(() => parseWorldConfig(JSON.stringify(badLodNeg)), "region.lod must be >= 0 (reject -1)");

  const okTile = freshConfig();
  (okTile.region as Record<string, unknown>).extentM = 16384;
  (okTile.region as Record<string, unknown>).tileSizeM = 512;
  (okTile.region as Record<string, unknown>).lod = 2;
  const parsed = parseWorldConfig(JSON.stringify(okTile));
  assert(parsed.region.extentM === 16384 && parsed.region.tileSizeM === 512 && parsed.region.lod === 2, "valid region/tile addressing must parse");
}

ops.op_log("[js] p68_world_config OK: WorldConfig schema validates, rejects invalid inputs, round-trips deterministically, and composes the REAL terrain-type/LookProfile/ForestConfig surfaces");
