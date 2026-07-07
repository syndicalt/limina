// p_map_source — Map Phase 3.2: MapTerrainSource on the STREAMED terrain path, bound by the
// RECORDED world.setTerrainSource command (self-describing replay; the source is constructed
// FROM the log, never out-of-band).
//
// Run: ./target/release/limina js/test/p_map_source.ts   (exit 0 = pass)
//
// Proves:
//   (a) world.setTerrainSource {kind:"map", mapAssetId:"maps/primary.worldmap.json"} succeeds
//       and is RECORDED; world.generateRegion over the island bounds then succeeds with
//       non-flat tiles containing both land (>seaLevel) and sea (<seaLevel).
//   (b) DETERMINISM: the same request sequence in a FRESH harness → byte-identical tiles
//       (heights + paintMat + paintW + climate + origin/scale).
//   (c) sampleHeight is a point query of the SAME field generateTile samples: at every tile
//       vertex, origin.y + h·scale.y agrees with source.sampleHeight within 1e-4.
//   (d) A TAMPERED IR (flipped byte) makes world.setTerrainSource FAIL (hash verify THROWS —
//       maps are load-bearing), as does a committed-identity mismatch (wrong input.hash).
//   (e) CACHE RETENTION EXEMPTION: map tiles are derived (re-derive from the IR), so
//       generating more tiles than maxRetainedEntries does NOT trip the fail-closed retained
//       limit (retainedSize stays 0; tiles ride the transient LRU). Falsifiable contrast:
//       the PROCEDURAL source under the same tiny cache DOES fail closed.
//   (f) REPLAY: rebuilding a fresh world from the recorded commands re-binds the map source
//       (name "map") and reproduces byte-identical tiles; the recorded command carries the
//       COMMITTED IR content hash (commitFields).
//   (g) ORDERING RULE: once regions exist, world.setTerrainSource REJECTS (set the source
//       before generating; rebinding mid-session would mix sources under shared cache keys).

import { EntityTable, ops, type EngineOps } from "../src/engine.ts";
import { createEcsWorld } from "../src/ecs/world.ts";
import { createTransformStorage } from "../src/ecs/facade.ts";
import { UniformGridSpatialIndex } from "../src/spatial/index.ts";
import { LiminaTracer } from "../src/observability/event.ts";
import { SkillRegistry, type WorldContext } from "../src/skills/registry.ts";
import { registerCoreSkills, type CoreSkills } from "../src/skills/index.ts";
import { resolveProfile } from "../src/skills/permissions.ts";
import { WorldRecorder } from "../src/worldlog/recorder.ts";
import { replayCommands } from "../src/worldlog/replay.ts";
import { AssetRegistry, assetContentHash } from "../src/asset-registry.ts";
import { TileCache } from "../src/terrain/tilecache.ts";
import type { TerrainTile, TileRequest } from "../src/terrain/types.ts";
import type { MCPResponse } from "../src/mcp/protocol.ts";
import type { WorldMap } from "../src/world/worldmap.ts";

function assert(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new Error("p_map_source FAIL: " + msg);
}
function ok(res: MCPResponse | undefined): Record<string, unknown> {
  if (res === undefined || !res.success) throw new Error("call failed: " + JSON.stringify(res?.error));
  return res.result as Record<string, unknown>;
}

function makeWorld(worldOps: EngineOps): WorldContext {
  const stub = { add() {}, remove() {}, position: { set() {}, x: 0, y: 0, z: 0 }, background: null as unknown };
  const camera = { position: { set() {} }, aspect: 1, lookAt() {}, updateProjectionMatrix() {} };
  const ecs = createEcsWorld();
  return {
    ecs, transforms: createTransformStorage(ecs), spatial: new UniformGridSpatialIndex(),
    entities: new EntityTable(), tags: new Map(), scene: stub as WorldContext["scene"],
    camera: camera as WorldContext["camera"], ops: worldOps, mode: "headless",
  };
}

const MAP_ASSET_ID = "maps/primary.worldmap.json";
const SEED = 7;
// The primary island's projected features span x −42..94, z −51..10 → tiles tx −1..1, tz −2..0.
const BOUNDS = { minTx: -1, minTz: -2, maxTx: 1, maxTz: 0 } as const;
const TILE_COUNT = 9;
const perms = resolveProfile("builder.readWrite");

const mapText = new TextDecoder().decode(ops.op_read_asset(MAP_ASSET_ID));
const worldMap = JSON.parse(mapText) as WorldMap;
const seaLevelM = worldMap.seaLevel;
const irHash = worldMap.provenance.contentHash;

interface Harness { registry: SkillRegistry; core: CoreSkills; world: WorldContext; base: Record<string, unknown> }
function makeHarness(session: string, opts?: { cache?: TileCache; assets?: AssetRegistry; recorder?: WorldRecorder }): Harness {
  const registry = new SkillRegistry(new LiminaTracer(session));
  const core = registerCoreSkills(registry, { terrainCache: opts?.cache, assets: opts?.assets });
  if (opts?.recorder !== undefined) opts.recorder.attach(registry);
  const worldOps = opts?.recorder !== undefined ? opts.recorder.wrapOps(ops) : ops;
  const world = makeWorld(worldOps);
  const base = { agentId: "agt_map", sessionId: session, permissions: perms, tick: 0, world };
  return { registry, core, world, base };
}

function regionTiles(core: CoreSkills): { key: string; tile: TerrainTile }[] {
  const out: { key: string; tile: TerrainTile }[] = [];
  for (let tz = BOUNDS.minTz; tz <= BOUNDS.maxTz; tz++) {
    for (let tx = BOUNDS.minTx; tx <= BOUNDS.maxTx; tx++) {
      const req: TileRequest = { seed: SEED, tx, tz, lod: 0 };
      const tile = core.terrain.cache.get(req);
      assert(tile !== undefined, `tile (${tx},${tz}) missing from the cache after generateRegion`);
      out.push({ key: `${tx},${tz}`, tile });
    }
  }
  return out;
}

// ── (a) set source (RECORDED) + generateRegion over the island: non-flat, land+sea ─────────
const recorder = new WorldRecorder("ses_map_src_rec");
const A = makeHarness("ses_map_src_rec", { recorder });
(A.world.ops as EngineOps).op_physics_create_world(-9.81);
const setOut = ok(await A.registry.invoke("world.setTerrainSource", { kind: "map", mapAssetId: MAP_ASSET_ID }, A.base));
assert(setOut.kind === "map" && setOut.source === "map", `setTerrainSource must bind the map source (got ${JSON.stringify(setOut)})`);
assert(setOut.hash === irHash, `setTerrainSource must return the IR's contentHash (got ${setOut.hash})`);
assert(A.core.terrain.source.name === "map", "the shared terrain source holder must now delegate to the map source");

const gen = ok(await A.registry.invoke("world.generateRegion", { seed: SEED, bounds: BOUNDS, lod: 0, render: false }, A.base));
assert((gen.tiles as number) === TILE_COUNT, `generateRegion applied ${gen.tiles} tiles, expected ${TILE_COUNT}`);
const tilesA = regionTiles(A.core);
{
  let minY = Infinity, maxY = -Infinity, anyTileNonFlat = false;
  for (const { tile } of tilesA) {
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < tile.heights.length; i++) {
      const y = tile.origin[1] + tile.heights[i] * tile.scale[1];
      if (y < lo) lo = y;
      if (y > hi) hi = y;
    }
    if (hi - lo > 2) anyTileNonFlat = true;
    if (lo < minY) minY = lo;
    if (hi > maxY) maxY = hi;
    assert(tile.paintMat !== undefined && tile.paintW !== undefined, "map tiles must carry paintMat/paintW");
    assert(tile.climate !== undefined && tile.climateChannels === 3, "map tiles must carry the canonical 3-channel climate grid");
  }
  assert(anyTileNonFlat && maxY - minY > 3, `map region must be non-flat (world-Y range ${(maxY - minY).toFixed(2)} m)`);
  assert(minY < seaLevelM && maxY > seaLevelM, `region must contain both sea (<${seaLevelM}) and land (>${seaLevelM}) — got [${minY.toFixed(2)}, ${maxY.toFixed(2)}]`);
}
{
  const tools = recorder.commands.filter((c): c is { kind: "skill"; tool: string } => c.kind === "skill").map((c) => c.tool);
  assert(tools.includes("world.setTerrainSource"), "world.setTerrainSource must be RECORDED (replay is self-describing)");
}

// ── (g) ordering rule: with regions live, a re-bind REJECTS (documented + gated) ───────────
{
  const res = await A.registry.invoke("world.setTerrainSource", { kind: "procedural" }, A.base);
  assert(!res.success, "setTerrainSource must REJECT once regions exist (set the source before generating)");
  const msg = res.error?.message ?? "";
  assert(msg.includes("regions already exist"), `rejection must explain the ordering rule (got: ${msg})`);
}

// ── (b) determinism: fresh harness, same sequence → byte-identical tiles ───────────────────
const B = makeHarness("ses_map_src_b");
(B.world.ops as EngineOps).op_physics_create_world(-9.81);
ok(await B.registry.invoke("world.setTerrainSource", { kind: "map", mapAssetId: MAP_ASSET_ID }, B.base));
ok(await B.registry.invoke("world.generateRegion", { seed: SEED, bounds: BOUNDS, lod: 0, render: false }, B.base));
const tilesB = regionTiles(B.core);
function sameTiles(a: { key: string; tile: TerrainTile }[], b: { key: string; tile: TerrainTile }[], label: string): void {
  assert(a.length === b.length, `${label}: tile count ${a.length} != ${b.length}`);
  for (let t = 0; t < a.length; t++) {
    const ta = a[t].tile, tb = b[t].tile;
    assert(a[t].key === b[t].key, `${label}: tile order diverged at ${t}`);
    for (let i = 0; i < 3; i++) {
      assert(Object.is(ta.origin[i], tb.origin[i]) && Object.is(ta.scale[i], tb.scale[i]), `${label}: tile ${a[t].key} origin/scale diverged`);
    }
    assert(ta.heights.length === tb.heights.length, `${label}: tile ${a[t].key} heights length`);
    for (let i = 0; i < ta.heights.length; i++) {
      assert(Object.is(ta.heights[i], tb.heights[i]), `${label}: tile ${a[t].key} heights diverged at cell ${i}`);
      assert(ta.paintMat![i] === tb.paintMat![i], `${label}: tile ${a[t].key} paintMat diverged at cell ${i}`);
      assert(Object.is(ta.paintW![i], tb.paintW![i]), `${label}: tile ${a[t].key} paintW diverged at cell ${i}`);
    }
    for (let i = 0; i < ta.climate!.length; i++) {
      assert(Object.is(ta.climate![i], tb.climate![i]), `${label}: tile ${a[t].key} climate diverged at ${i}`);
    }
  }
}
sameTiles(tilesA, tilesB, "fresh-harness determinism");

// ── (c) sampleHeight agrees with generateTile at every shared vertex (≤1e-4) ───────────────
{
  const source = A.core.terrain.source;
  let worst = 0;
  for (const { tile } of tilesA) {
    const [ox, oy, oz] = tile.origin;
    const [sx, sy, sz] = tile.scale;
    for (let r = 0; r < tile.nrows; r++) {
      const z = oz - sz / 2 + (r / (tile.nrows - 1)) * sz;
      for (let c = 0; c < tile.ncols; c++) {
        const x = ox - sx / 2 + (c / (tile.ncols - 1)) * sx;
        const fromTile = oy + tile.heights[r * tile.ncols + c] * sy;
        const fromQuery = source.sampleHeight(SEED, x, z, 0);
        const d = Math.abs(fromTile - fromQuery);
        if (d > worst) worst = d;
      }
    }
  }
  assert(worst <= 1e-4, `sampleHeight must agree with generateTile vertices (worst |Δ| = ${worst})`);
  ops.op_log(`[js] p_map_source: sampleHeight↔generateTile worst |Δ| = ${worst.toExponential(3)}`);
}

// ── (d) tampered IR → setTerrainSource FAILS; wrong committed hash → FAILS ─────────────────
{
  const rawBytes = ops.op_read_asset(MAP_ASSET_ID);
  const tampered = new Uint8Array(rawBytes);
  const flipAt = Math.floor(tampered.length / 2);
  tampered[flipAt] = tampered[flipAt] ^ 0xff;
  const tamperedAssets = AssetRegistry.fromBundle([
    { id: MAP_ASSET_ID, path: `assets/${MAP_ASSET_ID}`, hash: assetContentHash(tampered, ops), bytes: tampered },
  ], ops);
  const T = makeHarness("ses_map_src_tamper", { assets: tamperedAssets });
  const res = await T.registry.invoke("world.setTerrainSource", { kind: "map", mapAssetId: MAP_ASSET_ID }, T.base);
  assert(!res.success, "setTerrainSource must FAIL on a tampered map asset (verifyWorldMap THROWS)");

  const I = makeHarness("ses_map_src_identity");
  const res2 = await I.registry.invoke("world.setTerrainSource", { kind: "map", mapAssetId: MAP_ASSET_ID, hash: "not-the-authored-hash" }, I.base);
  assert(!res2.success, "setTerrainSource must FAIL when the committed hash mismatches the resolved IR (identity pin)");
}

// ── (e) retention exemption: derived map tiles never trip the fail-closed retained limit ───
{
  const SMALL = 2; // far fewer than the 9 tiles generated
  const E = makeHarness("ses_map_src_lru", { cache: new TileCache({ maxRetainedEntries: SMALL }) });
  (E.world.ops as EngineOps).op_physics_create_world(-9.81);
  ok(await E.registry.invoke("world.setTerrainSource", { kind: "map", mapAssetId: MAP_ASSET_ID }, E.base));
  ok(await E.registry.invoke("world.generateRegion", { seed: SEED, bounds: BOUNDS, lod: 0, render: false }, E.base));
  assert(E.core.terrain.cache.retainedSize === 0, `map tiles must NOT be export-retained (retainedSize ${E.core.terrain.cache.retainedSize})`);
  assert(E.core.terrain.cache.evictableSize === TILE_COUNT, `map tiles must ride the transient LRU (evictableSize ${E.core.terrain.cache.evictableSize})`);

  // Falsifiable contrast: the NON-derived procedural source under the same tiny cache
  // MUST still fail closed (the retention guard is intact for retained sources).
  const P = makeHarness("ses_map_src_lru_proc", { cache: new TileCache({ maxRetainedEntries: SMALL }) });
  (P.world.ops as EngineOps).op_physics_create_world(-9.81);
  const res = await P.registry.invoke("world.generateRegion", { seed: SEED, bounds: BOUNDS, lod: 0, render: false }, P.base);
  assert(!res.success, "procedural tiles must STILL fail closed past the retained limit (exemption is map/derived-only)");
  assert((res.error?.message ?? "").includes("retained tile limit"), `expected the retained-limit error (got: ${res.error?.message})`);
}

// ── (f) replay: the recorded commands rebuild the source + byte-identical tiles ────────────
{
  let replayCore: CoreSkills | undefined;
  await replayCommands(recorder.commands, {
    makeWorld: () => makeWorld(ops),
    makeRegistry: (tr) => {
      const r = new SkillRegistry(tr as LiminaTracer);
      replayCore = registerCoreSkills(r);
      return r;
    },
    tracer: new LiminaTracer("ses_map_src_replay"),
  });
  assert(replayCore !== undefined, "replay registry not constructed");
  assert(replayCore.terrain.source.name === "map", "replay must re-bind the map source from the recorded world.setTerrainSource");
  const tilesR = regionTiles(replayCore);
  sameTiles(tilesA, tilesR, "replay determinism");
  const setCmd = recorder.commands.find((c) => c.kind === "skill" && (c as { tool?: string }).tool === "world.setTerrainSource") as { input?: { hash?: string } } | undefined;
  assert(setCmd !== undefined, "recorded stream must carry world.setTerrainSource");
  assert(setCmd.input?.hash === irHash, `the recorder must COMMIT the resolved IR hash into the command (got ${setCmd.input?.hash})`);
}

ops.op_log(
  "[js] p_map_source OK: world.setTerrainSource {kind:'map'} is RECORDED and binds MapTerrainSource for the " +
  `streamed path — generateRegion over the island (${TILE_COUNT} tiles) is non-flat with land+sea from the IR's ` +
  "seaLevel; fresh-harness AND replay runs reproduce byte-identical heights/paint/climate; sampleHeight agrees " +
  "with generateTile vertices ≤1e-4; a tampered IR and a committed-identity mismatch both THROW; derived map " +
  "tiles are exempt from export retention (transient LRU, fail-closed limit unreachable) while procedural tiles " +
  "still fail closed; and re-binding REJECTS once regions exist (source-before-generate ordering rule).",
);
