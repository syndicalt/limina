import { AssetRegistry } from "../src/asset-registry.ts";
import { FUNCTIONAL_BUILDING_CONTRACT_V2, parseFunctionalBuildingContract, type V3 } from "../src/assets/functional-building-contract.ts";
import { createTransformStorage } from "../src/ecs/facade.ts";
import { createEcsWorld } from "../src/ecs/world.ts";
import { EntityTable, ops, type EngineOps } from "../src/engine.ts";
import type { MCPResponse } from "../src/mcp/protocol.ts";
import { LiminaTracer } from "../src/observability/event.ts";
import { registerCoreSkills } from "../src/skills/index.ts";
import { resolveProfile } from "../src/skills/permissions.ts";
import { SkillRegistry, type WorldContext } from "../src/skills/registry.ts";
import { UniformGridSpatialIndex } from "../src/spatial/index.ts";
import { captureWorldSnapshot, restoreSnapshot } from "../src/worldlog/snapshot.ts";
import { installSeededRandom } from "../src/worldlog/log.ts";

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(`p_functional_building_multi_room FAIL: ${message}`);
}
function ok(response: MCPResponse): Record<string, unknown> {
  if (!response.success) throw new Error(`p_functional_building_multi_room FAIL: ${JSON.stringify(response.error)}`);
  return response.result as Record<string, unknown>;
}
function makeWorld(worldOps: EngineOps): WorldContext {
  const ecs = createEcsWorld();
  return { ecs, transforms: createTransformStorage(ecs), spatial: new UniformGridSpatialIndex(), entities: new EntityTable(), tags: new Map(),
    scene: { add() {}, remove() {}, position: { set() {}, x: 0, y: 0, z: 0 }, background: null },
    camera: { position: { set() {} }, aspect: 1, lookAt() {}, updateProjectionMatrix() {} },
    ops: worldOps, mode: "headless", simWorker: true } as WorldContext;
}
const node = (id: string, role: string, data: Record<string, unknown> = {}) => ({ extras: { limina: { id, role, ...data } } });
const rooms = [
  { id: "room/main", bounds: { center: [0, 1.5, 0], halfExtents: [2, 1.5, 2] }, finishedFloorY: 0, ceilingY: 3, storey: 0,
    visibilityCellId: "cell/main", acoustics: { absorption: .2, reverb: .3 } },
  { id: "room/service", bounds: { center: [4, 1.5, 0], halfExtents: [2, 1.5, 2] }, finishedFloorY: 0, ceilingY: 3, storey: 0,
    visibilityCellId: "cell/service", acoustics: { absorption: .4, reverb: .15 } },
];
const nodes = [
  node("building/root", "root"), node("room/main", "room"), node("room/service", "room"),
  node("portal/exterior", "portal"), node("portal/service", "portal"),
  ...Array.from({ length: 5 }, (_, index) => node(`collider/${index}`, "collider", {
    shape: "box", center: [index - 2, 1.5, index % 2 === 0 ? -2 : 2], halfExtents: [.15, 1.5, 1],
  })),
  node("door/service", "door", { roomId: "room/main", portalId: "portal/service", hinge: [2, 1.5, 0],
    center: [0, 0, 0], halfExtents: [.08, 1, .6], closedYaw: 0, openYaw: -Math.PI / 2 }),
];
nodes[0] = { ...nodes[0], children: nodes.slice(1).map((_, index) => index + 1) } as typeof nodes[number];
const fixture = {
  asset: { version: "2.0", extras: { liminaFunctionalBuilding: {
    schema: FUNCTIONAL_BUILDING_CONTRACT_V2, units: "meter", up: "Y", buildingId: "fixture/fb4-two-room",
    rootNodeId: "building/root", roomIds: ["room/main", "room/service"], portalIds: ["portal/exterior", "portal/service"], entryAnchor: [-2.5, 0, 0],
    rooms,
    portals: [
      { id: "portal/exterior", kind: "passage", exterior: true, roomIds: [null, "room/main"], center: [-2, 1.5, 0], halfExtents: [.1, 1, .6], acousticTransmission: .8 },
      { id: "portal/service", kind: "door", exterior: false, roomIds: ["room/main", "room/service"], center: [2, 1.5, 0], halfExtents: [.1, 1, .6], acousticTransmission: .4, doorId: "door/service" },
    ],
    verticalLinks: [],
    spawnAnchors: [
      { id: "spawn/main", roomId: "room/main", kind: "player", position: [0, 0, 0], direction: [0, 0, 1], clearanceRadius: .35, clearanceHeight: 1.8 },
      { id: "spawn/service", roomId: "room/service", kind: "npc", position: [4, 0, 0], direction: [-1, 0, 0], clearanceRadius: .35, clearanceHeight: 1.8 },
    ],
    visibilityCells: [
      { id: "cell/main", roomIds: ["room/main"], nodeIds: ["room/main"] },
      { id: "cell/service", roomIds: ["room/service"], nodeIds: ["room/service"] },
    ],
  } } },
  scene: 0, scenes: [{ nodes: [0] }], nodes,
  animations: [{ name: "door/service/open", channels: [{ target: { node: 10, path: "rotation" } }], samplers: [] }],
};
const bytes = new TextEncoder().encode(JSON.stringify(fixture));
const parsed = parseFunctionalBuildingContract(bytes);
assert(parsed.schema === FUNCTIONAL_BUILDING_CONTRACT_V2 && parsed.rooms.length === 2, "seed fixture is not valid v2 authority");

ops.op_physics_create_world(0);
installSeededRandom(0xFB4, true);
const assetId = "buildings/fb4-two-room.gltf", assets = new AssetRegistry(ops);
assets.seed(assetId, bytes);
const world = makeWorld(ops), registry = new SkillRegistry(new LiminaTracer("fb4-multi-room"));
const core = registerCoreSkills(registry, { assets }), topology = core.functionalBuildings.topologyManager;
const permissions = resolveProfile("builder.readWrite");
const at = (tick: number) => ({ agentId: "builder", sessionId: "fb4", permissions, tick, world });
const position: V3 = [750_000.25, 18, -420_000.75], yaw = .713;
const placed = ok(await registry.invoke("building.placeFunctional", { assetId, position, yaw }, at(1)));
const root = placed.root as string, door = (placed.doors as string[])[0]!;
assert(topology.hasBuilding(root) && topology.size() === 1, "real placement did not register topology");
const c = Math.cos(yaw), s = Math.sin(yaw);
const worldPoint = (local: V3): V3 => [position[0] + c * local[0] + s * local[2], position[1] + local[1], position[2] - s * local[0] + c * local[2]];
assert(topology.queryRoom(worldPoint([0, 1, 0]), root)?.roomId === "room/main", "placed arbitrary transform did not resolve main room");
assert(topology.queryRoom(worldPoint([4, 1, 0]), root)?.roomId === "room/service", "placed arbitrary transform did not resolve service room");
const queriedRoom = ok(await registry.invoke("building.queryRoom", { position: worldPoint([4, 1, 0]), root }, at(2)));
assert(queriedRoom.found === true && queriedRoom.roomId === "room/service", "engine skill did not expose transformed room authority");
assert(topology.findRoomPath(root, "room/main", "room/service") === undefined, "closed placed door left rooms connected");
assert(ok(await registry.invoke("building.findRoomPath", { root, fromRoomId: "room/main", toRoomId: "room/service" }, at(2))).found === false,
  "engine path skill crossed a closed layered door");
const closedGain = topology.acousticGain(root, "room/main", "room/service");
assert(Math.abs(closedGain - .8 * .4 * .6) < 1e-12, "closed placed door did not apply authored acoustic transmission");
assert(Math.abs((ok(await registry.invoke("building.roomAcousticGain", { root, sourceRoomId: "room/main", listenerRoomId: "room/service" }, at(2))).gain as number) - closedGain) < 1e-12,
  "engine acoustic skill diverged from layered authority");
assert(topology.queryVisibleCells(worldPoint([0, 1, 0]), root)!.cellIds.join(",") === "cell/main", "closed placed door leaked visibility");
assert((ok(await registry.invoke("building.queryResidentCells", { position: worldPoint([0, 1, 0]), root, maxConnections: 1 }, at(2))).cellIds as string[]).join(",") === "cell/main",
  "engine residency skill crossed a closed layered door");
assert((ok(await registry.invoke("building.querySpawnAnchors", { root, kind: "npc" }, at(2))).anchors as unknown[]).length === 1,
  "engine spawn-anchor skill did not filter typed anchors");

const beforeOpen = topology.getRevision();
const opened = ok(await registry.invoke("door.setOpen", { door, open: true }, at(2)));
assert(opened.ok === true && opened.open === true && topology.getRevision() === beforeOpen + 1, "door skill did not atomically open topology portal");
const openPath = topology.findRoomPath(root, "room/main", "room/service")!;
assert(openPath.roomIds.join(",") === "room/main,room/service" && openPath.connectionIds.join(",") === "portal/service", "door skill did not expose stable room path");
const skillPath = ok(await registry.invoke("building.findRoomPath", { root, fromRoomId: "room/main", toRoomId: "room/service" }, at(3)));
assert(skillPath.found === true && (skillPath.connectionIds as string[])[0] === "portal/service", "engine path skill did not observe the open door transaction");
const openGain = topology.acousticGain(root, "room/main", "room/service");
assert(Math.abs(openGain - .8 * .6) < 1e-12 && openGain > closedGain, "open door did not increase acoustic transmission");
assert(topology.queryVisibleCells(worldPoint([0, 1, 0]), root)!.cellIds.join(",") === "cell/main,cell/service", "open door did not expand visible cells");

const snapshot = captureWorldSnapshot(world, { sessionId: "fb4", tick: 2, snapshotSeq: 0 });
const restoredWorld = makeWorld(ops); restoreSnapshot(restoredWorld, snapshot);
const restoredAssets = new AssetRegistry(ops); restoredAssets.seed(assetId, bytes);
const restoredRegistry = new SkillRegistry(new LiminaTracer("fb4-restored"));
const restoredCore = registerCoreSkills(restoredRegistry, { assets: restoredAssets }), restoredTopology = restoredCore.functionalBuildings.topologyManager;
const restoredAt = (tick: number) => ({ agentId: "builder", sessionId: "fb4-restored", permissions, tick, world: restoredWorld });
assert(!restoredTopology.hasBuilding(root), "fresh registry unexpectedly retained topology closure state");
ok(await restoredRegistry.invoke("inventory.has", { entity: "reconcile/probe", itemId: "none" }, restoredAt(3)));
assert(restoredTopology.hasBuilding(root) && restoredTopology.size() === 1, "snapshot reconciliation did not rebuild building topology");
assert(restoredTopology.isPortalOpen(root, "portal/service") === true, "snapshot reconciliation lost open door topology state");
assert(restoredTopology.findRoomPath(root, "room/main", "room/service")?.connectionIds[0] === "portal/service", "snapshot-reconciled room path is unavailable");
assert(restoredTopology.queryVisibleCells(worldPoint([0, 1, 0]), root)!.cellIds.length === 2, "snapshot-reconciled visibility state is wrong");

const destroyed = ok(await restoredRegistry.invoke("building.destroyFunctional", { root }, restoredAt(4)));
assert((destroyed.removed as number) > 0, "destroy reported no removed entities");
assert(restoredTopology.size() === 0 && !restoredTopology.hasBuilding(root), "destroy leaked topology registration");
assert(restoredTopology.queryRoom(worldPoint([0, 1, 0]), root) === undefined, "destroy left queryable room state");

console.log("p_functional_building_multi_room OK: seeded v2 placement, transformed queries, door topology/audio/visibility, snapshot reconciliation, destroy cleanup");
