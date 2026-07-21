// TileCache memory-bound regression.
//
// Proves the cache separates export/replay retention from transient hot-cache
// pressure: scratch entries can be LRU-evicted, but recorded terrain tiles remain
// export-visible even after streamFollow unloads them from the live region.

import { EntityTable, ops } from "../src/engine.ts";
import { createTransformStorage } from "../src/ecs/facade.ts";
import { createEcsWorld } from "../src/ecs/world.ts";
import { SkillRegistry, type WorldContext } from "../src/skills/registry.ts";
import { registerCoreSkills } from "../src/skills/index.ts";
import { resolveProfile } from "../src/skills/permissions.ts";
import { TILE_SIZE } from "../src/terrain/procedural.ts";
import { requestKey, TileCache } from "../src/terrain/tilecache.ts";
import type { ClimateSample, TerrainSource, TerrainTile, TileRequest } from "../src/terrain/types.ts";
import { UniformGridSpatialIndex } from "../src/spatial/index.ts";
import { LiminaTracer } from "../src/observability/event.ts";

function assert(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new Error("p47_tilecache_bounds FAIL: " + msg);
}

function tileFor(req: TileRequest): TerrainTile {
  return {
    nrows: 2,
    ncols: 2,
    origin: [req.tx * 10, 0, req.tz * 10],
    scale: [10, 1, 10],
    heights: new Float32Array([req.tx, req.tz, req.lod, req.seed]),
  };
}

class CountingSource implements TerrainSource {
  readonly name = "counting";
  calls = 0;
  async generateTile(req: TileRequest): Promise<TerrainTile> {
    this.calls++;
    return tileFor(req);
  }
  sampleHeight(): number { return 0; }
  sampleClimate(): ClimateSample { return { tempC: 0, precipMm: 0, biome: 0 }; }
}

function req(tx: number, tz = 0): TileRequest {
  return { seed: 1, tx, tz, lod: 0 };
}

function makeHeadlessWorld(worldOps: typeof ops): WorldContext {
  const ecs = createEcsWorld();
  const scene = { add() {}, remove() {}, position: { set() {}, x: 0, y: 0, z: 0 }, background: null as unknown };
  const camera = { position: { set() {} }, aspect: 1, lookAt() {}, updateProjectionMatrix() {} };
  return { ecs, transforms: createTransformStorage(ecs), spatial: new UniformGridSpatialIndex(), entities: new EntityTable(), tags: new Map(), scene, camera, ops: worldOps, mode: "headless" };
}

// Transient cache pressure evicts only non-export scratch entries.
{
  const cache = new TileCache({ maxRetainedEntries: 4, maxEvictableEntries: 2 });
  const source = new CountingSource();
  await cache.resolve(req(0), source, { retainForExport: false });
  await cache.resolve(req(1), source, { retainForExport: false });
  await cache.resolve(req(2), source, { retainForExport: false });
  assert(cache.size === 2 && cache.evictableSize === 2 && cache.retainedSize === 0, `expected two evictable entries, got size=${cache.size}`);
  assert(!cache.has(req(0)), "oldest scratch tile should be evicted");
  assert(cache.entries().length === 0, "scratch tiles must not leak into export entries");

  await cache.resolve(req(1), source);
  assert(cache.retainedSize === 1 && cache.evictableSize === 1, "promoting a scratch hit should retain it and remove it from LRU");
  assert(cache.entries()[0]?.key === requestKey(req(1)), "promoted tile should be export-visible");
}

// Retained entries fail closed on cap instead of silently evicting replay-required bytes.
{
  const cache = new TileCache({ maxRetainedEntries: 1, maxEvictableEntries: 1 });
  const source = new CountingSource();
  await cache.resolve(req(0), source);
  assert(source.calls === 1, "first retained miss should call source once");
  let threw = false;
  try {
    await cache.resolve(req(1), source);
  } catch (err) {
    threw = err instanceof Error && err.message.includes("retained tile limit exceeded");
  }
  assert(threw, "retained cap breach must throw a clear error");
  assert(source.calls === 1, "retained cap breach must fail before calling the source");
  assert(cache.entries().length === 1 && cache.has(req(0)), "cap breach must preserve already-retained export entries");
}

// Terrain streaming unloads live physics/ECS state, but export retention keeps both
// the original and streamed-in tiles for command-log replay.
{
  const tracer = new LiminaTracer("ses_p47_tilecache_bounds");
  const registry = new SkillRegistry(tracer);
  const cache = new TileCache({ maxRetainedEntries: 8, maxEvictableEntries: 1 });
  const core = registerCoreSkills(registry, { terrainCache: cache });
  const world = makeHeadlessWorld(ops);
  ops.op_physics_create_world(-9.81);
  const actor = { agentId: "limina:builder", sessionId: "ses_p47_tilecache_bounds", permissions: resolveProfile("builder.readWrite"), tick: 0, world };

  const gen = await registry.invoke("world.generateRegion", { seed: 99, bounds: { minTx: 0, minTz: 0, maxTx: 0, maxTz: 0 }, lod: 0, render: false }, actor);
  assert(gen.success, `generateRegion failed: ${JSON.stringify(gen.error)}`);
  const regionId = (gen.result as { regionId: string }).regionId;

  const stream = await registry.invoke("world.streamFollow", { regionId, anchor: [TILE_SIZE * 4, 0, 0], radius: 0 }, actor);
  assert(stream.success, `streamFollow failed: ${JSON.stringify(stream.error)}`);
  const streamed = stream.result as { loaded: string[]; removed: string[]; active: number };
  assert(streamed.loaded.length === 1 && streamed.removed.length === 1 && streamed.active === 1, "streamFollow should replace the active tile");
  assert(core.terrain.cache.entries().length === 2, "unloaded but recorded tile must remain in export retention");
}

ops.op_log("p47_tilecache_bounds OK: TileCache bounds transient memory, fails closed on retained cap, and preserves streamed-out export tiles.");
