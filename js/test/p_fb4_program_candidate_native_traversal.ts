// CPU-only FB-4 gate for the exact program-derived production GLB. This places the asset through
// the real functional-building skill and drives Rapier across every portal and the stair at a large
// coordinate and arbitrary yaw. It does not initialize a renderer or GPU adapter.

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

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(`p_fb4_program_candidate_native_traversal FAIL: ${message}`);
}
function ok(response: MCPResponse): Record<string, unknown> {
  if (!response.success) throw new Error(`p_fb4_program_candidate_native_traversal FAIL: ${JSON.stringify(response.error)}`);
  return response.result as Record<string, unknown>;
}
function makeWorld(worldOps: EngineOps): WorldContext {
  const ecs = createEcsWorld();
  return { ecs, transforms: createTransformStorage(ecs), spatial: new UniformGridSpatialIndex(), entities: new EntityTable(), tags: new Map(),
    scene: { add() {}, remove() {}, position: { set() {}, x: 0, y: 0, z: 0 }, background: null },
    camera: { position: { set() {} }, aspect: 1, lookAt() {}, updateProjectionMatrix() {} },
    ops: worldOps, mode: "headless", simWorker: true } as WorldContext;
}

const assetPath = "buildings/authoring/functional-hall-house-v4/fb4-multi-room-candidate-1b4470041e01/functional-hall-house-fb4-multi-room.glb";
const bytes = ops.op_read_asset(assetPath), parsed = parseFunctionalBuildingContract(bytes);
assert(parsed.schema === "limina.functional-building/v2", "candidate lost v2 functional authority");
const contract = parsed as FunctionalBuildingContractV2;
assert(contract.rooms.length === 5 && contract.portals.length === 4 && contract.verticalLinks.length === 1 && contract.doors.length === 3,
  "candidate topology inventory drifted");

const PLACEMENT: V3 = [125_000.25, 7, -88_000.75], BUILDING_YAW = .713, CENTER_OFFSET = .9;
const c = Math.cos(BUILDING_YAW), s = Math.sin(BUILDING_YAW);
const worldPoint = (local: V3): V3 => [PLACEMENT[0] + c * local[0] + s * local[2], PLACEMENT[1] + local[1], PLACEMENT[2] - s * local[0] + c * local[2]];
const localPoint = (point: V3): V3 => { const dx = point[0] - PLACEMENT[0], dz = point[2] - PLACEMENT[2]; return [c * dx - s * dz, point[1] - PLACEMENT[1], s * dx + c * dz]; };
const heading = (dx: number, dz: number): number => Math.atan2(c * dx + s * dz, -(-s * dx + c * dz));

ops.op_physics_create_world(-9.81);
// The native infinite-ground helper is origin-scoped; author the local terrain bearing at the same
// large-coordinate placement used by the building so the test cannot tunnel below the door leaf.
ops.op_physics_add_static_box(PLACEMENT[0], PLACEMENT[1] - .1, PLACEMENT[2], 20, .1, 20, .85, 0);
const assets = new AssetRegistry(ops); assets.seed(assetPath, bytes);
const world = makeWorld(ops), registry = new SkillRegistry(new LiminaTracer("fb4-program-native-traversal"));
const core = registerCoreSkills(registry, { assets }), permissions = resolveProfile("builder.readWrite");
let tick = 1;
const at = () => ({ agentId: "builder", sessionId: "fb4-program-native-traversal", permissions, tick: tick++, world });
const placed = ok(await registry.invoke("building.placeFunctional", { assetId: assetPath, position: PLACEMENT, yaw: BUILDING_YAW }, at()));
const doors = placed.doors as string[];
assert(doors.length === 3, "production placement did not realize all three articulated doors");
const roomPath = ok(await registry.invoke("building.findRoomPath", { root: placed.root,
  fromRoomId: "room/space/kitchen", toRoomId: "room/space/upper-landing" }, at()));
assert(roomPath.found === true
  && (roomPath.roomIds as string[]).join(",") === "room/space/kitchen,room/space/ground-hall,room/space/upper-landing"
  && (roomPath.connectionIds as string[]).join(",") === "portal/hall-kitchen,stairs/primary",
  `production room graph does not match the review-authority topology proof: ${JSON.stringify(roomPath)}`);
const anchors = ok(await registry.invoke("building.querySpawnAnchors", { root: placed.root }, at())).anchors as unknown[];
assert(anchors.length === 5, "production placement lost the five review-authority spawn anchors");
ops.op_physics_step();

type Walk = { final: V3; minimumY: number; maximumY: number };
async function walk(localStart: V3, localDirection: [number, number], steps: number): Promise<Walk> {
  const start = worldPoint([localStart[0], localStart[1] + CENTER_OFFSET, localStart[2]]);
  const player = ok(await registry.invoke("player.spawn", { position: start }, at())).entity as string;
  let final = start, minimumY = start[1], maximumY = start[1];
  for (let index = 0; index < steps; index++) {
    const result = ok(await registry.invoke("player.move", { entity: player, forward: 1, yaw: heading(...localDirection) }, at()));
    final = result.newPosition as V3; minimumY = Math.min(minimumY, final[1]); maximumY = Math.max(maximumY, final[1]);
  }
  assert(core.player.controllers.remove(player), `failed to remove traversal probe ${player}`);
  return { final, minimumY, maximumY };
}

const exterior = contract.portals.find((portal) => portal.exterior)!;
const exteriorX = exterior.center[0], exteriorZ = exterior.center[2];
const closed = localPoint((await walk([exteriorX, .09, exteriorZ - .95], [0, 1], 35)).final);
assert(closed[2] < exteriorZ - .25, `closed exterior door did not block the capsule (${closed})`);
for (const door of doors) ok(await registry.invoke("door.setOpen", { door, open: true }, at()));
const entered = localPoint((await walk([exteriorX, .09, exteriorZ - .95], [0, 1], 55)).final),
  exited = localPoint((await walk([exteriorX, .09, exteriorZ + .9], [0, -1], 55)).final);
assert(entered[2] > exteriorZ + .35 && exited[2] < exteriorZ - .7, "open exterior portal failed bidirectional traversal");

const passage = contract.portals.find((portal) => portal.kind === "passage")!;
const passageIn = localPoint((await walk([passage.center[0] - .8, .09, passage.center[2]], [1, 0], 50)).final),
  passageOut = localPoint((await walk([passage.center[0] + .75, .09, passage.center[2]], [-1, 0], 50)).final);
assert(passageIn[0] > passage.center[0] + .35 && passageOut[0] < passage.center[0] - .35,
  "hall/kitchen passage failed bidirectional traversal");

const stair = contract.verticalLinks[0], upstairs = await walk([stair.from[0], stair.from[1] + .09, stair.from[2] - .8], [0, 1], 320),
  upstairsLocal = localPoint(upstairs.final);
assert(upstairsLocal[1] > stair.to[1] + .7 && upstairsLocal[2] > stair.to[2] + .25,
  `capsule did not reach the upper landing through the stair void (${upstairsLocal})`);
assert(upstairs.maximumY < PLACEMENT[1] + stair.to[1] + 1.25, `capsule penetrated overhead geometry (${upstairs.maximumY})`);
const downstairs = await walk([stair.to[0], stair.to[1] + .09, stair.to[2] + .8], [0, -1], 320),
  downstairsLocal = localPoint(downstairs.final);
assert(downstairsLocal[1] < 1.2 && downstairsLocal[2] < stair.from[2] - .25,
  `capsule did not descend to the ground floor (${downstairsLocal})`);
assert(downstairs.minimumY > PLACEMENT[1] - .05, `capsule fell through the stair/floor system (${downstairs.minimumY})`);

for (const portal of contract.portals.filter((candidate) => !candidate.exterior && candidate.kind === "door")) {
  const fromLanding = localPoint((await walk([portal.center[0] - .65, stair.to[1] + .09, portal.center[2]], [1, 0], 50)).final),
    toLanding = localPoint((await walk([portal.center[0] + .75, stair.to[1] + .09, portal.center[2]], [-1, 0], 50)).final);
  assert(fromLanding[0] > portal.center[0] + .35 && toLanding[0] < portal.center[0] - .35,
    `${portal.id} failed bidirectional traversal`);
}

console.log("p_fb4_program_candidate_native_traversal OK: exact production GLB traversed every portal and stair in both directions at arbitrary yaw/large coordinates; CPU-only");
