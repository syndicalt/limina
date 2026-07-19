// CPU-only native gate for the exact V3 production GLB. It places through the real
// functional-building skill and drives Rapier through the new service bay plus
// every inherited passage, door, and stair at a large coordinate/arbitrary yaw.
import { AssetRegistry } from "../src/asset-registry.ts";
import type { FunctionalBuildingContractV2, V3 } from "../src/assets/functional-building-contract.ts";
import { parseFunctionalBuildingContract } from "../src/assets/functional-building-contract.ts";
import { createTransformStorage } from "../src/ecs/facade.ts";
import { createEcsWorld } from "../src/ecs/world.ts";
import { EntityTable, ops, type EngineOps } from "../src/engine.ts";
import type { MCPResponse } from "../src/mcp/protocol.ts";
import { LiminaTracer } from "../src/observability/event.ts";
import { registerCoreSkills } from "../src/skills/index.ts";
import { resolveProfile } from "../src/skills/permissions.ts";
import { SkillRegistry, type WorldContext } from "../src/skills/registry.ts";
import { UniformGridSpatialIndex } from "../src/spatial/index.ts";

const assert = (value: unknown, message: string): asserts value => { if (!value) throw new Error(`p_fb4_v3_native_traversal FAIL: ${message}`); };
const ok = (response: MCPResponse): Record<string, unknown> => { if (!response.success) throw new Error(`p_fb4_v3_native_traversal FAIL: ${JSON.stringify(response.error)}`); return response.result as Record<string, unknown>; };
function makeWorld(worldOps: EngineOps): WorldContext {
  const ecs = createEcsWorld();
  return { ecs, transforms: createTransformStorage(ecs), spatial: new UniformGridSpatialIndex(), entities: new EntityTable(), tags: new Map(),
    scene: { add() {}, remove() {}, position: { set() {}, x: 0, y: 0, z: 0 }, background: null },
    camera: { position: { set() {} }, aspect: 1, lookAt() {}, updateProjectionMatrix() {} },
    ops: worldOps, mode: "headless", simWorker: true } as WorldContext;
}

const assetPath = "buildings/authoring/functional-hall-house-v4/fb4-multi-room-candidate-v3-1f375ec3abe1/functional-hall-house-fb4-multi-room.glb";
const bytes = ops.op_read_asset(assetPath), parsed = parseFunctionalBuildingContract(bytes);
assert(parsed.schema === "limina.functional-building/v2", "candidate lost V2 runtime functional authority");
const contract = parsed as FunctionalBuildingContractV2;
assert(contract.rooms.length === 6 && contract.portals.length === 5 && contract.verticalLinks.length === 1 && contract.doors.length === 3
  && contract.spawnAnchors.length === 6 && contract.visibilityCells.length === 6, "V3 topology inventory drifted");
assert(contract.verticalLinks[0].flights?.length === 2 && contract.verticalLinks[0].intermediateLandings?.length === 1
  && contract.verticalLinks[0].approaches?.bottom.center[2] === -2.4 && contract.verticalLinks[0].approaches?.top.center[2] === -1.5,
  "V3 return stair lost its two flights, turn landing, or controller approach sockets");

const PLACEMENT: V3 = [125_000.25, 9, -88_000.75], BUILDING_YAW = .713, CENTER_OFFSET = .9;
const c = Math.cos(BUILDING_YAW), s = Math.sin(BUILDING_YAW);
const worldPoint = (local: V3): V3 => [PLACEMENT[0] + c * local[0] + s * local[2], PLACEMENT[1] + local[1], PLACEMENT[2] - s * local[0] + c * local[2]];
const localPoint = (point: V3): V3 => { const dx = point[0] - PLACEMENT[0], dz = point[2] - PLACEMENT[2]; return [c * dx - s * dz, point[1] - PLACEMENT[1], s * dx + c * dz]; };
const heading = (dx: number, dz: number): number => Math.atan2(c * dx + s * dz, -(-s * dx + c * dz));

ops.op_physics_create_world(-9.81);
ops.op_physics_add_static_box(PLACEMENT[0], PLACEMENT[1] - .1, PLACEMENT[2], 24, .1, 24, .85, 0);
const assets = new AssetRegistry(ops); assets.seed(assetPath, bytes);
const world = makeWorld(ops), registry = new SkillRegistry(new LiminaTracer("fb4-v3-native-traversal"));
const core = registerCoreSkills(registry, { assets }), permissions = resolveProfile("builder.readWrite");
let tick = 1; const at = () => ({ agentId: "builder", sessionId: "fb4-v3-native-traversal", permissions, tick: tick++, world });
const placed = ok(await registry.invoke("building.placeFunctional", { assetId: assetPath, position: PLACEMENT, yaw: BUILDING_YAW }, at()));
const colliderByEntity = new Map((placed.parts as string[]).map((entity, index) => [entity, contract.colliders[index].id])),
  doors = placed.doors as string[]; assert(doors.length === 3, "production placement lost articulated doors");
const servicePath = ok(await registry.invoke("building.findRoomPath", { root: placed.root,
  fromRoomId: "room/space/service-pantry", toRoomId: "room/space/upper-landing" }, at()));
assert(servicePath.found === true
  && (servicePath.roomIds as string[]).join(",") === "room/space/service-pantry,room/space/ground-hall,room/space/upper-landing"
  && (servicePath.connectionIds as string[]).join(",") === "portal/connection/hall-service-pantry,stairs/primary",
  `service room graph is not connected to the upper house: ${JSON.stringify(servicePath)}`);
assert((ok(await registry.invoke("building.querySpawnAnchors", { root: placed.root }, at())).anchors as unknown[]).length === 6, "V3 spawn anchors drifted");
ops.op_physics_step();

type Walk = { final: V3; minimumY: number; maximumY: number };
async function walk(localStart: V3, localDirection: [number, number], steps: number, centerlineX?: number): Promise<Walk> {
  const start = worldPoint([localStart[0], localStart[1] + CENTER_OFFSET, localStart[2]]),
    player = ok(await registry.invoke("player.spawn", { position: start }, at())).entity as string;
  let final = start, minimumY = start[1], maximumY = start[1];
  for (let index = 0; index < steps; index++) {
    const current = localPoint(final), correction = centerlineX === undefined ? 0 : Math.max(-.5, Math.min(.5, (centerlineX - current[0]) * 2)),
      result = ok(await registry.invoke("player.move", { entity: player, forward: 1, yaw: heading(localDirection[0] + correction, localDirection[1]) }, at()));
    final = result.newPosition as V3; minimumY = Math.min(minimumY, final[1]); maximumY = Math.max(maximumY, final[1]);
  }
  assert(core.player.controllers.remove(player), `failed to remove traversal probe ${player}`);
  return { final, minimumY, maximumY };
}

async function walkWaypoints(localStart: V3, waypoints: readonly [number, number][]): Promise<Walk> {
  const start = worldPoint([localStart[0], localStart[1] + CENTER_OFFSET, localStart[2]]),
    player = ok(await registry.invoke("player.spawn", { position: start }, at())).entity as string;
  let final = start, minimumY = start[1], maximumY = start[1];
  for (const [targetX, targetZ] of waypoints) {
    let reached = false;
    for (let index = 0; index < 180; index++) {
      const current = localPoint(final), dx = targetX - current[0], dz = targetZ - current[2];
      if (Math.hypot(dx, dz) <= .05) { reached = true; break; }
      const cardinal:[number,number]=Math.abs(dx)>Math.abs(dz)?[Math.sign(dx),0]:[0,Math.sign(dz)],
        result = ok(await registry.invoke("player.move", { entity: player, forward: 1, yaw: heading(...cardinal) }, at()));
      final = result.newPosition as V3; minimumY = Math.min(minimumY, final[1]); maximumY = Math.max(maximumY, final[1]);
    }
    if(!reached){
      const current=localPoint(final),dx=targetX-current[0],dz=targetZ-current[2],length=Math.hypot(dx,dz),direction=[c*dx/length+s*dz/length,0,-s*dx/length+c*dz/length],
        rays=await Promise.all([-.7,0,.7].map((height)=>registry.invoke("physics.raycast",{origin:[final[0]+direction[0]*.4,final[1]+height,final[2]+direction[2]*.4],direction,maxDistance:1},at()).then(ok))),
        vertical=await Promise.all([{origin:worldPoint([current[0],3.2,current[2]]),direction:[0,-1,0],maxDistance:3},{origin:worldPoint([current[0],current[1]+.9,current[2]]),direction:[0,1,0],maxDistance:1}].map((input)=>registry.invoke("physics.raycast",input,at()).then(ok))),
        hits=[...rays,...vertical].map((ray)=>({...ray,semanticId:typeof ray.entity==="string"?colliderByEntity.get(ray.entity):undefined}));
      throw new Error(`p_fb4_v3_native_traversal FAIL: stair traversal could not reach local waypoint ${targetX},${targetZ} from ${current}; forward contacts=${JSON.stringify(hits)}`);
    }
  }
  assert(core.player.controllers.remove(player), `failed to remove waypoint traversal probe ${player}`);
  return { final, minimumY, maximumY };
}

const exterior = contract.portals.find((portal) => portal.exterior)!;
const blocked = localPoint((await walk([exterior.center[0], .09, exterior.center[2] - .95], [0, 1], 35)).final);
assert(blocked[2] < exterior.center[2] - .25, "closed exterior door did not block traversal");
for (const door of doors) ok(await registry.invoke("door.setOpen", { door, open: true }, at()));
const entered = localPoint((await walk([exterior.center[0], .09, exterior.center[2] - .95], [0, 1], 55)).final),
  exited = localPoint((await walk([exterior.center[0], .09, exterior.center[2] + .9], [0, -1], 55)).final);
assert(entered[2] > exterior.center[2] + .35 && exited[2] < exterior.center[2] - .7, "exterior portal failed bidirectional traversal");

const hallKitchen = contract.portals.find((portal) => portal.id === "portal/hall-kitchen")!,
  kitchenIn = localPoint((await walk([hallKitchen.center[0] - .8, .09, hallKitchen.center[2]], [1, 0], 50)).final),
  kitchenOut = localPoint((await walk([hallKitchen.center[0] + .75, .09, hallKitchen.center[2]], [-1, 0], 50)).final);
assert(kitchenIn[0] > hallKitchen.center[0] + .35 && kitchenOut[0] < hallKitchen.center[0] - .35, "hall/kitchen passage failed bidirectional traversal");

const service = contract.portals.find((portal) => portal.id === "portal/connection/hall-service-pantry")!,
  serviceRay = ok(await registry.invoke("physics.raycast", { origin: worldPoint([service.center[0], 1.1, service.center[2] + .8]), direction: [-s, 0, -c], maxDistance: 2 }, at())),
  serviceIn = localPoint((await walk([service.center[0], .09, service.center[2] + .8], [0, -1], 60)).final),
  serviceOut = localPoint((await walk([service.center[0], .09, service.center[2] - .8], [0, 1], 60)).final);
assert(serviceRay.hit === false, `service passage centerline is physically occluded: ${JSON.stringify(serviceRay)}`);
for (const offsetX of [-.3, 0, .3]) for (const height of [.31, .92, 1.81]) {
  const ray = ok(await registry.invoke("physics.raycast", {
    origin: worldPoint([service.center[0] + offsetX, height, service.center[2] + .8]),
    direction: [-s, 0, -c], maxDistance: 2,
  }, at()));
  assert(ray.hit === false, `service passage capsule envelope is occluded at x=${offsetX}, y=${height}: ${JSON.stringify(ray)}`);
}
assert(serviceIn[2] < service.center[2] - .35 && serviceOut[2] > service.center[2] + .35,
  `functional service-bay passage failed bidirectional traversal (in=${serviceIn}, out=${serviceOut}, portal=${service.center})`);

const stair = contract.verticalLinks[0], bottomApproach = stair.approaches!.bottom.center, topApproach = stair.approaches!.top.center,
  stairSurfaceSamples = await Promise.all([-2.2, -1.95, -1.8, -1.4].map((z) => registry.invoke("physics.raycast", {
    origin: worldPoint([3.14, 3, z]), direction: [0, -1, 0], maxDistance: 5,
  }, at()).then(ok)));
const upstairs = await walkWaypoints([bottomApproach[0], bottomApproach[1] + .09, bottomApproach[2]], [
    [3.14, -1.8], [3.14, .45], [3.14, 2], [4.12, 2], [4.12, 1.35], [4.12, -.95], [topApproach[0], topApproach[2]],
  ]), upstairsLocal = localPoint(upstairs.final);
assert(stairSurfaceSamples.every((sample) => sample.hit === true), `return-stair walking surface has holes: ${JSON.stringify(stairSurfaceSamples)}`);
assert(upstairsLocal[1] > stair.to[1] + .7 && upstairsLocal[2] < topApproach[2] + .2, `return-stair ascent failed (${upstairsLocal})`);
assert(upstairs.maximumY < PLACEMENT[1] + stair.to[1] + 1.25, "stair probe penetrated overhead geometry");
const downstairs = await walkWaypoints([topApproach[0], topApproach[1] + .09, topApproach[2]], [
  [4.12, -.95], [4.12, 1.35], [4.12, 2], [3.14, 2], [3.14, .45], [3.14, -1.8], [bottomApproach[0], bottomApproach[2]],
]), downstairsLocal = localPoint(downstairs.final);
assert(downstairsLocal[1] < 1.2 && downstairsLocal[2] < stair.from[2] - .25 && downstairs.minimumY > PLACEMENT[1] - .05, "return-stair descent/floor bearing failed");

for (const portal of contract.portals.filter((candidate) => !candidate.exterior && candidate.kind === "door")) {
  const fromLanding = localPoint((await walk([portal.center[0] - .65, stair.to[1] + .09, portal.center[2]], [1, 0], 50)).final),
    toLanding = localPoint((await walk([portal.center[0] + .75, stair.to[1] + .09, portal.center[2]], [-1, 0], 50)).final);
  assert(fromLanding[0] > portal.center[0] + .35 && toLanding[0] < portal.center[0] - .35, `${portal.id} failed bidirectional traversal`);
}

console.log("p_fb4_v3_native_traversal OK: exact V3 production GLB traversed exterior, hall/kitchen, service bay, both upper doors, and both return-stair flights through the turn landing and approach sockets at arbitrary yaw/large coordinates; CPU-only");
