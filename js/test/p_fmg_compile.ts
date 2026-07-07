// p_fmg_compile — Phase 2.1 of "Map-Driven Worlds": the Azgaar Fantasy-Map-Generator front-end
// to the WorldMap IR (js/src/world/fmg-map-compile.mjs + tools/map/compile-fmg.mjs), gated the
// same way the design-space front-end is (p_worldmap_compile.ts).
//
// Run: ./target/release/limina js/test/p_fmg_compile.ts
//
// Proves: (1) compiling the committed FMG Full-JSON fixture twice yields byte-identical output +
// a stable contentHash; (2) the output zod-parses as WorldMap v1 and verifyWorldMap reports
// ok:true; (3) the version gate rejects a non-major-1 export BY NAME, and an unknown
// distanceUnit is rejected by name too; (4) the scale contract: a known px distance in the
// fixture maps to the expected meters within 1e-6; (5) land/river/road/anchor content matches
// the fixture (coastline traced, searoute skipped, burgs[0] placeholder skipped, capital ->
// civic), the unmapped-biome warning fires, and anchorMinPopulation filters; (6) the COMMITTED
// compiled IR (assets/maps/fmg-sample.worldmap.json) verifies and matches a fresh compile; and
// (7) the walkable-region check: the EXISTING terrain path consumes the compiled IR headless —
// terrain.create {generate:{source:"map", mapAssetId:"maps/fmg-sample.worldmap.json"}} succeeds,
// non-flat, land+sea present, byte-identical across fresh invocations.

import { ops, EntityTable, type WorldContext } from "../src/engine.ts";
import { compileFmgMap } from "../src/world/fmg-map-compile.mjs";
import { WorldMapSchema, stableStringifyWorldMap, verifyWorldMap, worldMapContentHash, type WorldMap } from "../src/world/worldmap.ts";
import { createEcsWorld } from "../src/ecs/world.ts";
import { createTransformStorage } from "../src/ecs/facade.ts";
import { UniformGridSpatialIndex } from "../src/spatial/index.ts";
import { SkillRegistry } from "../src/skills/registry.ts";
import { resolveProfile } from "../src/skills/permissions.ts";
import { LiminaTracer } from "../src/observability/event.ts";
import { registerTerrainEditSkills, type EditableTerrain } from "../src/skills/terrain-edit.ts";
import { AssetRegistry } from "../src/asset-registry.ts";

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error("p_fmg_compile FAIL: " + message);
}

const FIXTURE_ASSET_ID = "maps/_fixtures/fmg/sample-full.json";
const COMPILED_ASSET_ID = "maps/fmg-sample.worldmap.json";
const fmgJsonText = new TextDecoder().decode(ops.op_read_asset(FIXTURE_ASSET_ID));

// ── 1. Determinism: compiling the fixture twice -> byte-identical + stable contentHash. ────────
const runA = compileFmgMap(fmgJsonText, { mapId: "fmg-sample" });
const runB = compileFmgMap(fmgJsonText, { mapId: "fmg-sample" });
const worldMapA = runA.worldMap as WorldMap;
const worldMapB = runB.worldMap as WorldMap;
assert(
  stableStringifyWorldMap(worldMapA) === stableStringifyWorldMap(worldMapB),
  "compiling the same FMG export twice must yield byte-identical WorldMap output",
);
assert(worldMapA.provenance.contentHash === worldMapB.provenance.contentHash, "contentHash must be stable across repeated compiles");
assert(worldMapA.provenance.contentHash.length === 64, `contentHash must be 64-char sha256 hex (got ${worldMapA.provenance.contentHash.length})`);
assert(worldMapA.provenance.tool === "fmg", `provenance.tool must be "fmg" (got ${worldMapA.provenance.tool})`);
assert(typeof worldMapA.provenance.sourceHash === "string" && worldMapA.provenance.sourceHash.length === 64, "provenance.sourceHash must pin the input bytes");

// ── 2. The output zod-parses as WorldMap v1 and verifyWorldMap reports ok:true. ────────────────
const parsed = WorldMapSchema.parse(worldMapA);
assert(parsed.version === 1, "compiled map must declare version 1");
const verify = verifyWorldMap(worldMapA);
assert(verify.ok, `verifyWorldMap must report ok:true (expected ${verify.expected}, actual ${verify.actual})`);

// ── 3. The version gate rejects non-major-1 BY NAME; unknown distanceUnit rejected by name. ────
{
  const doc = JSON.parse(fmgJsonText);
  doc.info.version = "2.0.0";
  let threw: unknown;
  try { compileFmgMap(JSON.stringify(doc)); } catch (err) { threw = err; }
  assert(threw !== undefined, "a version-2.0.0 export must throw");
  assert(String(threw).includes("2.0.0"), `the version error must NAME the found version (got: ${String(threw)})`);
}
{
  const doc = JSON.parse(fmgJsonText);
  doc.settings.distanceUnit = "lg"; // leagues — a real FMG option this compiler refuses to guess at
  let threw: unknown;
  try { compileFmgMap(JSON.stringify(doc)); } catch (err) { threw = err; }
  assert(threw !== undefined, "an unknown distanceUnit must throw");
  assert(String(threw).includes("lg"), `the unit error must NAME the unknown unit (got: ${String(threw)})`);
}

// ── 4. Scale contract: Silverrun's authored points span 200px along y (140 -> 340); at
//    distanceScale 0.0005 km/px that is exactly 100m in the compiled IR. ────────────────────────
{
  const fixture = JSON.parse(fmgJsonText);
  const metersPerPx = Number(fixture.settings.distanceScale) * 1000; // km -> m
  const riverPx = fixture.pack.rivers[0].points as [number, number][];
  const pxDist = Math.abs(riverPx[riverPx.length - 1][1] - riverPx[0][1]);
  const silverrun = parsed.waterways[0];
  const mDist = Math.abs(silverrun.points[silverrun.points.length - 1][1] - silverrun.points[0][1]);
  const expected = pxDist * metersPerPx;
  assert(Math.abs(mDist - expected) < 1e-6, `a ${pxDist}px span must compile to ${expected}m (got ${mDist})`);
}

// ── 5. Content: coastline, rivers (points + cells-fallback), routes (searoute skipped),
//    anchors (placeholder skipped, capital -> civic), warnings, anchorMinPopulation. ────────────
assert(parsed.land.length === 1, `expected 1 land polygon (one island), got ${parsed.land.length}`);
assert(parsed.land[0].points.length >= 8, `the traced coastline must be a real ring (got ${parsed.land[0].points.length} points)`);
assert(parsed.relief.length === 3, `expected 3 relief hints (1 mountain + 2 hills groups), got ${parsed.relief.length}`);
assert(parsed.relief.filter((r) => r.kind === "mountain").length === 1, "expected exactly 1 mountain relief group");
assert(parsed.waterways.length === 2, `expected 2 rivers (points + cells-fallback), got ${parsed.waterways.length}`);
assert(parsed.waterways[0].widthM === 6, `Silverrun width 0.006km must compile to 6m (got ${parsed.waterways[0].widthM})`);
assert(parsed.waterways[1].points.length === 3, `Eastbrook (no points) must fall back to its 3 cell centers (got ${parsed.waterways[1].points.length})`);
assert(parsed.routes.length === 2, `expected 2 routes (road + trail; searoute skipped), got ${parsed.routes.length}`);
assert(parsed.routes[0].class === "road" && parsed.routes[1].class === "trail", "route classes must be road, trail");
assert(parsed.anchors.length === 2, `expected 2 anchors (burgs[0] placeholder skipped), got ${parsed.anchors.length}`);
{
  const highkeep = parsed.anchors.find((a) => a.id === "burg-highkeep");
  const fisherton = parsed.anchors.find((a) => a.id === "burg-fisherton");
  assert(highkeep !== undefined && fisherton !== undefined, "anchors must include burg-highkeep and burg-fisherton");
  assert(highkeep!.kind === "civic", `the capital must anchor as "civic" (got ${highkeep!.kind})`);
  assert(fisherton!.kind === "dwelling", `a non-capital burg must anchor as "dwelling" (got ${fisherton!.kind})`);
  assert(highkeep!.name === "Highkeep", `anchor must carry the burg name (got ${highkeep!.name})`);
  assert(highkeep!.source === "map", `FMG anchors must be source:"map" (got ${highkeep!.source})`);
  assert(highkeep!.position[0] === 30 && highkeep!.position[1] === -10, `Highkeep at px(260,180) must recenter+scale to [30,-10] (got ${JSON.stringify(highkeep!.position)})`);
}
assert(
  runA.warnings.some((w) => w.includes("Faerie meadow")),
  `the unmapped biome "Faerie meadow" must produce a warning (got: ${JSON.stringify(runA.warnings)})`,
);
{
  const filtered = compileFmgMap(fmgJsonText, { mapId: "fmg-sample", anchorMinPopulation: 1 }).worldMap as WorldMap;
  assert(filtered.anchors.length === 1 && filtered.anchors[0].id === "burg-highkeep",
    `anchorMinPopulation:1 must keep only Highkeep (pop 5.42), got ${JSON.stringify(filtered.anchors.map((a) => a.id))}`);
}

// ── 6. The COMMITTED compiled IR verifies and matches a fresh compile bit-for-bit. ─────────────
{
  const committed = JSON.parse(new TextDecoder().decode(ops.op_read_asset(COMPILED_ASSET_ID)));
  const committedVerify = verifyWorldMap(committed);
  assert(committedVerify.ok, `the committed ${COMPILED_ASSET_ID} must verify (expected ${committedVerify.expected}, actual ${committedVerify.actual})`);
  assert(
    worldMapContentHash(committed as WorldMap) === worldMapA.provenance.contentHash,
    "the committed compiled IR must match a fresh compile of the committed fixture (stale artifact? re-run tools/map/compile-fmg.mjs)",
  );
}

// ── 7. Walkable-region check: the EXISTING map terrain path consumes the compiled IR headless
//    (mirrors p_map_terrain's harness) — succeeds, non-flat, land+sea, deterministic. ───────────
function makeHeadlessWorld(): WorldContext {
  const ecs = createEcsWorld();
  const scene = { add() {}, remove() {}, position: { set() {}, x: 0, y: 0, z: 0 }, background: null as unknown };
  const camera = { position: { set() {} }, aspect: 1, lookAt() {}, updateProjectionMatrix() {} };
  return {
    ecs, transforms: createTransformStorage(ecs), spatial: new UniformGridSpatialIndex(),
    entities: new EntityTable(), tags: new Map(), scene, camera, ops, mode: "headless",
  };
}

const perms = resolveProfile("builder.readWrite");
const SIZE = 200;
const RESOLUTION = 129;

interface TileLike { heights: Float32Array; paintMat?: Uint8Array; paintW?: Float32Array }

async function createFmgMapTerrain(session: string, assets: AssetRegistry): Promise<TileLike> {
  const world = makeHeadlessWorld();
  const layers = new Map<string, EditableTerrain>();
  const registry = new SkillRegistry(new LiminaTracer(session));
  registerTerrainEditSkills(registry, layers, assets);
  const res = await registry.invoke("terrain.create", {
    size: SIZE, resolution: RESOLUTION, generate: { source: "map", mapAssetId: COMPILED_ASSET_ID, seed: 11 },
  }, { agentId: "agt_fmg", sessionId: session, permissions: perms, tick: 1, world });
  assert(res.success, `terrain.create (map source, fmg IR) must succeed: ${res.success ? "" : JSON.stringify(res.error)}`);
  const out = res.result as { entity: string };
  return layers.get(out.entity)!.tile as unknown as TileLike;
}

{
  const assets = new AssetRegistry();
  const t1 = await createFmgMapTerrain("ses_fmg_a", assets);
  assert(t1.heights.length === RESOLUTION * RESOLUTION, `heights grid length (${t1.heights.length})`);
  let mn = Infinity, mx = -Infinity, anyAboveSea = false, anyBelowSea = false;
  const seaLevelM = worldMapA.seaLevel;
  for (const h of t1.heights) {
    if (h < mn) mn = h;
    if (h > mx) mx = h;
    if (h > seaLevelM) anyAboveSea = true;
    if (h < seaLevelM) anyBelowSea = true;
  }
  assert(mx - mn > 1, `fmg-map terrain must be non-flat (range ${(mx - mn).toFixed(3)})`);
  assert(anyAboveSea && anyBelowSea, "fmg-map terrain must contain both land (>seaLevel) and sea (<seaLevel) cells");

  const t2 = await createFmgMapTerrain("ses_fmg_b", assets);
  let firstDiff = -1;
  for (let i = 0; i < t1.heights.length; i++) {
    if (t1.heights[i] !== t2.heights[i]) { firstDiff = i; break; }
  }
  assert(firstDiff === -1, `fmg-map terrain must be deterministic across fresh invocations (diverged at cell ${firstDiff})`);
  ops.op_log(`[js] p_fmg_compile: walkable-region terrain ok (height range ${(mx - mn).toFixed(2)}m, land+sea present, deterministic)`);
}

ops.op_log(
  "[js] p_fmg_compile OK: compileFmgMap(committed FMG v1.134.2-shaped Full JSON fixture) is PURE and " +
  "deterministic (byte-identical output + stable contentHash across repeated compiles); output zod-parses as " +
  "WorldMap v1 and verifyWorldMap reports ok:true; a version-2.0.0 export and an unknown distanceUnit are " +
  "rejected BY NAME; a 200px span compiles to exactly 100m (scale contract, <1e-6); the island coastline is " +
  "traced (1 polygon), 2 rivers (authored points + cell-center fallback, width km->m), road+trail kept with the " +
  "searoute skipped, burgs[0] placeholder skipped and the capital anchored as civic (source:map, recentered " +
  "position exact); the unmapped-biome warning fires and anchorMinPopulation filters; the committed " +
  "fmg-sample.worldmap.json verifies and matches a fresh compile; and terrain.create generate.source='map' " +
  "consumes the compiled IR headless — non-flat, land+sea, byte-identical across fresh invocations.",
);
