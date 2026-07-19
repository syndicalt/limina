import { z } from "../build/zod.bundle.mjs";
import { ops } from "../src/engine.ts";
import { createHeadlessContext } from "../src/game/context.ts";
import type { TerrainSource, TerrainTile, TileRequest } from "../src/terrain/types.ts";
import { TILE_SIZE } from "../src/terrain/procedural.ts";
import { installSeededRandom } from "../src/worldlog/log.ts";

const RELEASE_PATH = "assets/settlements/functional-hall-r1/release.json";
const assert = (value: unknown, message: string): asserts value => {
  if (!value) throw new Error(`p_functional_settlement_live_host_native FAIL: ${message}`);
};
const read = (path: string): Uint8Array => ops.op_read_asset(path);
const json = (path: string): any => JSON.parse(new TextDecoder().decode(read(path)));
const releaseRecord = json(RELEASE_PATH);
const recipe = json(releaseRecord.recipe.path);
const plan = json(releaseRecord.plan.path);
const terrain = recipe.terrain;
const c = Math.cos(terrain.yaw), s = Math.sin(terrain.yaw);
const surface = (x: number, z: number): number => terrain.baseHeight
  + terrain.localZSlope * ((x - terrain.origin[0]) * s + (z - terrain.origin[1]) * c);

const terrainSource: TerrainSource = {
  name: "fb5-release-live-grade-r1",
  sampleHeight: (_seed, x, z) => surface(x, z),
  sampleClimate: () => ({ tempC: 12, precipMm: 900, biome: 4 }),
  generateTile(req: TileRequest): TerrainTile {
    const n = 33;
    const ox = (req.tx + .5) * TILE_SIZE;
    const oz = (req.tz + .5) * TILE_SIZE;
    const heights = new Float32Array(n * n);
    for (let row = 0; row < n; row++) for (let col = 0; col < n; col++) {
      heights[row * n + col] = surface(req.tx * TILE_SIZE + col / (n - 1) * TILE_SIZE,
        req.tz * TILE_SIZE + row / (n - 1) * TILE_SIZE);
    }
    return { nrows: n, ncols: n, origin: [ox, 0, oz], scale: [TILE_SIZE, 1, TILE_SIZE], heights };
  },
};

ops.op_physics_create_world(0);
installSeededRandom(0xFB52, true);
const ctx = createHeadlessContext({ session: "fb5-live-host", agentId: "fb5-live-host", coreOpts: { terrainSource } });
let genericCalls = 0;
ctx.registry.replace("asset.place", {
  name: "asset.place", version: "trap", description: "released live-host pipeline trap", category: "scene",
  permissions: ["scene.write"], input: z.unknown(), output: z.unknown(),
  handler() { genericCalls++; throw new Error("generic asset.place forbidden"); },
} as any);

const host = ctx.core.functionalSettlements.releaseHost;
const participantKeysBefore = ctx.core.snapshotParticipants.keys();
const session = host.load({ releasePath: RELEASE_PATH, read, namespace: "live/functional-hall-r1", invokeBase: () => ctx.base });
assert(host.size === 1 && session.releaseId === releaseRecord.releaseId && session.settlementId === releaseRecord.settlementId,
  "normal core host did not load the exact release identity");
const participantKeysLive = ctx.core.snapshotParticipants.keys();
assert(participantKeysLive.length === participantKeysBefore.length + 1
  && participantKeysLive.some((key) => key.startsWith("functionalSettlements.residency.")),
"live release residency was not dynamically enrolled in core snapshot ownership");

const nearest = plan.placements.find((placement: any) => placement.residency.unitId === "residency/functional-hall/b");
assert(nearest !== undefined, "released plan omitted center building");
let uncoveredRejected = false;
try { await session.update(nearest.position); } catch (error) {
  uncoveredRejected = /terrain|site|reproduce|sampler/i.test(error instanceof Error ? error.message : String(error));
}
assert(uncoveredRejected && ctx.core.functionalSettlements.placementManager.size() === 0
  && ctx.core.functionalBuildings.topologyManager.size() === 0, "uncovered terrain reached runtime mutation");

const xs = plan.placements.map((placement: any) => placement.position[0]);
const zs = plan.placements.map((placement: any) => placement.position[2]);
const terrainResult = await ctx.registry.invoke("world.generateRegion", {
  seed: 1, lod: 0, render: false,
  bounds: {
    minTx: Math.floor((Math.min(...xs) - 16) / TILE_SIZE),
    maxTx: Math.floor((Math.max(...xs) + 16) / TILE_SIZE),
    minTz: Math.floor((Math.min(...zs) - 16) / TILE_SIZE),
    maxTz: Math.floor((Math.max(...zs) + 16) / TILE_SIZE),
  },
}, ctx.base);
assert(terrainResult.success, `resident terrain generation failed: ${terrainResult.error?.message ?? "unknown"}`);

let snapshot = await session.update(nearest.position);
assert(snapshot.residentUnitIds.join(",") === "residency/functional-hall/b"
  && ctx.core.functionalSettlements.placementManager.size() === 1
  && ctx.core.functionalBuildings.topologyManager.size() === 1,
"camera interest did not load exactly one whole released building through normal core registration");
const allUnits = plan.placements.map((placement: any) => placement.residency.unitId).sort();
session.setExplicitInterest(allUnits);
snapshot = await session.update(nearest.position);
assert(snapshot.residentUnitIds.length === releaseRecord.runtime.maxActiveUnits
  && ctx.core.functionalSettlements.placementManager.size() === releaseRecord.runtime.maxActiveUnits,
"release residency bounds did not cap explicit interest");

await host.close();
assert(host.size === 0 && session.closed && ctx.core.functionalSettlements.placementManager.size() === 0
  && ctx.core.functionalBuildings.topologyManager.size() === 0 && genericCalls === 0,
"host teardown did not unload whole buildings atomically through the engine pipeline");
assert(JSON.stringify(ctx.core.snapshotParticipants.keys()) === JSON.stringify(participantKeysBefore),
  "host teardown did not unregister its exact dynamic snapshot participant");
let closedRejected = false;
try { await session.update(nearest.position); } catch (error) { closedRejected = /closed/.test(error instanceof Error ? error.message : String(error)); }
assert(closedRejected, "closed live session accepted a later update");

console.log("p_functional_settlement_live_host_native OK: normal CoreSkills loads exact release bytes, rejects non-resident terrain, streams bounded whole buildings through building.placeFunctional, and unloads atomically");
