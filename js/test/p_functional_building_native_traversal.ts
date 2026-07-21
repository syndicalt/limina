// FB-4 native traversal gate. This deliberately compiles architectural authority, packages the
// compiler's exact functional contract as a headless glTF, places it through the production skill,
// and drives the real Rapier character capsule. Declarative connectivity alone is not evidence that
// authored wall apertures, floor voids, stair treads, and door sweeps are physically usable.

import { AssetRegistry } from "../src/asset-registry.ts";
import type { FunctionalBuildingContractV2, V3 } from "../src/assets/functional-building-contract.ts";
import { createTransformStorage } from "../src/ecs/facade.ts";
import { createEcsWorld } from "../src/ecs/world.ts";
import { EntityTable, ops, type EngineOps } from "../src/engine.ts";
import type { MCPResponse } from "../src/mcp/protocol.ts";
import { LiminaTracer } from "../src/observability/event.ts";
import { compileArchitecture, type ArchitectureSpec } from "../src/architecture/index.ts";
import { registerCoreSkills } from "../src/skills/index.ts";
import { resolveProfile } from "../src/skills/permissions.ts";
import { SkillRegistry, type WorldContext } from "../src/skills/registry.ts";
import { UniformGridSpatialIndex } from "../src/spatial/index.ts";
import { makeMultiRoomArchitectureSpec } from "./fixtures/architecture-multi-room.ts";

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(`p_functional_building_native_traversal FAIL: ${message}`);
}
function ok(response: MCPResponse): Record<string, unknown> {
  if (!response.success) throw new Error(`p_functional_building_native_traversal FAIL: ${JSON.stringify(response.error)}`);
  return response.result as Record<string, unknown>;
}
function makeWorld(worldOps: EngineOps): WorldContext {
  const ecs = createEcsWorld();
  return { ecs, transforms: createTransformStorage(ecs), spatial: new UniformGridSpatialIndex(), entities: new EntityTable(), tags: new Map(),
    scene: { add() {}, remove() {}, position: { set() {}, x: 0, y: 0, z: 0 }, background: null },
    camera: { position: { set() {} }, aspect: 1, lookAt() {}, updateProjectionMatrix() {} },
    ops: worldOps, mode: "headless", simWorker: true } as WorldContext;
}

function compileFixture(): FunctionalBuildingContractV2 {
  const base = JSON.parse(new TextDecoder().decode(ops.op_read_asset(
    "buildings/functional-hall-house-architecture-v5.json",
  ))) as ArchitectureSpec;
  const spec = makeMultiRoomArchitectureSpec(base);
  const contract = compileArchitecture(spec).functionalContract;
  assert(contract?.schema === "limina.functional-building/v2", "compiler did not emit v2 traversal authority");
  return contract;
}

function packageContract(contract: FunctionalBuildingContractV2): Uint8Array {
  const semantic = new Map<string, Record<string, unknown>>();
  semantic.set(contract.rootNodeId, { id: contract.rootNodeId, role: "root" });
  for (const id of contract.roomIds) semantic.set(id, { id, role: "room" });
  for (const id of contract.portalIds) semantic.set(id, { id, role: "portal" });
  for (const collider of contract.colliders) {
    const nodeId = collider.nodeId ?? collider.id;
    semantic.set(nodeId, { id: nodeId, role: "collider", shape: "box", center: collider.center, halfExtents: collider.halfExtents });
  }
  for (const door of contract.doors) {
    const nodeId = door.nodeId ?? door.id;
    semantic.set(nodeId, { id: nodeId, role: "door", roomId: door.roomId, portalId: door.portalId, hinge: door.hinge,
      closedYaw: door.closedYaw, openYaw: door.openYaw, halfExtents: door.halfExtents, center: door.center });
  }
  const support = contract.site?.entranceSupport;
  if (support !== undefined) semantic.set(support.sourcePrimitiveId, { id: support.sourcePrimitiveId, role: "architecture-primitive",
    box: { center: [support.center[0], support.exteriorGradeY - support.bearingDepth + .05, support.center[1]],
      halfExtents: [support.halfExtents[0], .05, support.halfExtents[1]], yawRadians: support.yawRadians } });
  const ids = [...semantic.keys()];
  const nodes = ids.map((id, index) => ({ ...(index === 0 ? { children: ids.slice(1).map((_, child) => child + 1) } : {}), extras: { limina: semantic.get(id) } }));
  const nodeIndex = new Map(ids.map((id, index) => [id, index]));
  const animations = contract.doors.map((door) => { const nodeId = door.nodeId ?? door.id; return { name: `${nodeId}/open`, channels: [{ target: { node: nodeIndex.get(nodeId), path: "rotation" } }], samplers: [] }; });
  const { colliders: _colliders, doors: _doors, ...authority } = contract;
  return new TextEncoder().encode(JSON.stringify({ asset: { version: "2.0", extras: { liminaFunctionalBuilding: { units: "meter", up: "Y", ...authority } } }, scene: 0, scenes: [{ nodes: [0] }], nodes, animations }));
}

const PLACEMENT: V3 = [125_000.25, 7, -88_000.75];
const BUILDING_YAW = .713;
const CENTER_OFFSET = .9; // player.spawn below uses a 1.8 m capsule (0.6 half-height + 0.3 caps)
const c = Math.cos(BUILDING_YAW), s = Math.sin(BUILDING_YAW);
const worldPoint = (local: V3): V3 => [PLACEMENT[0] + c * local[0] + s * local[2], PLACEMENT[1] + local[1], PLACEMENT[2] - s * local[0] + c * local[2]];
const heading = (localDx: number, localDz: number): number => {
  const dx = c * localDx + s * localDz, dz = -s * localDx + c * localDz;
  return Math.atan2(dx, -dz);
};

const contract = compileFixture(), bytes = packageContract(contract), assetId = "buildings/fb4-native-traversal.gltf";
ops.op_physics_create_world(-9.81);
// Site/terrain integration owns exterior grade. Keep the traversal fixture level with the finished
// floor so this gate isolates the compiled building apertures; entrance earthwork has its own gate.
ops.op_physics_add_ground(PLACEMENT[1] + contract.site!.finishedFloorY);
const assets = new AssetRegistry(ops); assets.seed(assetId, bytes);
const world = makeWorld(ops), registry = new SkillRegistry(new LiminaTracer("fb4-native-traversal"));
const core = registerCoreSkills(registry, { assets });
const permissions = resolveProfile("builder.readWrite");
let tick = 1;
const at = () => ({ agentId: "builder", sessionId: "fb4-native-traversal", permissions, tick: tick++, world });
const placed = ok(await registry.invoke("building.placeFunctional", { assetId, position: PLACEMENT, yaw: BUILDING_YAW }, at()));
const door = (placed.doors as string[])[0]!;
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
const local = (point: V3): V3 => { const dx = point[0] - PLACEMENT[0], dz = point[2] - PLACEMENT[2]; return [c * dx - s * dz, point[1] - PLACEMENT[1], s * dx + c * dz]; };

// Closed/open exterior leaf: the closed proof must stop outside; opening must permit both directions.
const exteriorClosed = local((await walk([-.72, .09, -4.35], [0, 1], 35)).final);
assert(exteriorClosed[2] < -3.1, `closed exterior leaf did not block the capsule (local z=${exteriorClosed[2]})`);
ok(await registry.invoke("door.setOpen", { door, open: true }, at()));
const exteriorIn = local((await walk([-.72, .09, -4.35], [0, 1], 55)).final);
const exteriorOut = local((await walk([-.72, .09, -2.5], [0, -1], 55)).final);
assert(exteriorIn[2] > -2.6, `open exterior portal failed outside-to-inside traversal (local z=${exteriorIn[2]})`);
assert(exteriorOut[2] < -3.8, `open exterior portal failed inside-to-outside traversal (local z=${exteriorOut[2]})`);

// Interior passage is physical, not merely a topology edge.
const serviceIn = local((await walk([2.62, .09, -2.65], [0, -1], 55)).final);
const serviceOut = local((await walk([2.62, .09, -4.75], [0, 1], 55)).final);
assert(serviceIn[2] < -3.75, `main-to-service passage is physically blocked (local z=${serviceIn[2]})`);
assert(serviceOut[2] > -3.0, `service-to-main passage is physically blocked (local z=${serviceOut[2]})`);

// The capsule must climb every tread, emerge through the explicit upper-floor void without a
// head strike, then descend the same construction-valid flight. This also proves arbitrary-yaw
// collider placement because all motion and assertions are transformed through BUILDING_YAW.
const upstairs = await walk([-2, .09, -3.0], [0, 1], 300), upstairsLocal = local(upstairs.final);
assert(upstairsLocal[1] > 4.3 && upstairsLocal[2] > 2.4, `capsule did not reach the upper storey through the stair void (${upstairsLocal})`);
assert(upstairs.maximumY < PLACEMENT[1] + 4.65, `capsule was launched or penetrated overhead geometry (max y=${upstairs.maximumY})`);
const downstairs = await walk([-2, 3.55, 3.0], [0, -1], 300), downstairsLocal = local(downstairs.final);
assert(downstairsLocal[1] < 1.2 && downstairsLocal[2] < -2.35, `capsule did not descend to the lower storey (${downstairsLocal})`);
assert(downstairs.minimumY > PLACEMENT[1] - .05, `capsule fell through the stair/floor system (min y=${downstairs.minimumY})`);

console.log(`p_functional_building_native_traversal OK: compiled contract placed at yaw=${BUILDING_YAW}; exterior portal and service passage traverse both directions; closed door blocks/open door clears; stair/upper-floor void traverses both directions`);
