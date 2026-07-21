import { FUNCTIONAL_BUILDING_CONTRACT_V2, type FunctionalBuildingContractV2, type V3 } from "../src/assets/functional-building-contract.ts";
import { FunctionalBuildingTopologyManager } from "../src/skills/functional-building-topology.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`p_functional_building_topology FAIL: ${message}`);
}
const near = (actual: number, expected: number, label: string) => assert(Math.abs(actual - expected) < 1e-9, `${label}: ${actual} != ${expected}`);
const room = (id: string, center: V3, storey: number, cell: string) => ({ id,
  bounds: { center, halfExtents: [2, 1.5, 2] as V3 }, finishedFloorY: storey * 3,
  ceilingY: storey * 3 + 3, storey, visibilityCellId: cell, acoustics: { absorption: .35, reverb: .2 } });

const contract: FunctionalBuildingContractV2 = {
  schema: FUNCTIONAL_BUILDING_CONTRACT_V2, buildingId: "fixture/fb4", rootNodeId: "building/root",
  roomIds: ["room/main", "room/service", "room/upper"], portalIds: ["portal/exterior", "portal/service"],
  entryAnchor: [-2.5, 0, 0], colliders: [], doors: [],
  rooms: [room("room/main", [0, 1.5, 0], 0, "cell/main"), room("room/service", [4, 1.5, 0], 0, "cell/service"),
    room("room/upper", [0, 4.5, 0], 1, "cell/upper")],
  portals: [
    { id: "portal/exterior", kind: "door", exterior: true, roomIds: [null, "room/main"], center: [-2, 1, 0], halfExtents: [.1, 1, .6], acousticTransmission: .15, doorId: "door/front" },
    { id: "portal/service", kind: "door", exterior: false, roomIds: ["room/main", "room/service"], center: [2, 1, 0], halfExtents: [.1, 1, .6], acousticTransmission: .3, doorId: "door/service" },
  ],
  verticalLinks: [{ id: "stairs/main-upper", kind: "stairs", fromRoomId: "room/main", toRoomId: "room/upper",
    from: [-2, 0, 0], to: [2, 3, 0], clearWidth: 1, clearHeight: 2, rise: 3, run: 4, riserCount: 16, treadDepth: .25,
    upperFloorOpening: { center: [1.5, 0], halfExtents: [.5, .5] } }],
  spawnAnchors: [
    { id: "spawn/z-main", roomId: "room/main", kind: "player", position: [0, 0, 1], direction: [0, 0, 1], clearanceRadius: .35, clearanceHeight: 1.8 },
    { id: "spawn/a-service", roomId: "room/service", kind: "npc", position: [4, 0, 0], direction: [-1, 0, 0], clearanceRadius: .4, clearanceHeight: 1.7 },
    { id: "spawn/m-upper", roomId: "room/upper", kind: "item", position: [0, 3, 0], direction: [0, 0, -1], clearanceRadius: .2, clearanceHeight: .5 },
  ],
  visibilityCells: [
    { id: "cell/main", roomIds: ["room/main"], nodeIds: ["room/main"] },
    { id: "cell/service", roomIds: ["room/service"], nodeIds: ["room/service"] },
    { id: "cell/upper", roomIds: ["room/upper"], nodeIds: ["room/upper"] },
  ],
};

const manager = new FunctionalBuildingTopologyManager(), position: V3 = [8_000_000.25, 120, -7_000_000.75], yaw = .713;
assert(manager.registerBuilding("settlement/alpha/house-07", contract, { position, yaw }), "valid building did not register");
assert(!manager.registerBuilding("settlement/alpha/house-07", contract, { position, yaw }), "duplicate building registered");
assert(manager.getRevision() === 1, "rejected registration changed revision");
const c = Math.cos(yaw), s = Math.sin(yaw);
const world = (local: V3): V3 => [position[0] + c * local[0] + s * local[2], position[1] + local[1], position[2] - s * local[0] + c * local[2]];

const lower = manager.queryRoom(world([0, 1, 0]));
const upper = manager.queryRoom(world([0, 4, 0]));
assert(lower?.roomId === "room/main" && lower.storey === 0, "large-coordinate rotated lower room query failed");
assert(upper?.roomId === "room/upper" && upper.storey === 1, "stacked upper room aliased to lower floor");
assert(manager.queryRoom(world([20, 1, 0])) === undefined, "outside point hit a room");

assert(manager.isPortalOpen("settlement/alpha/house-07", "portal/service") === false, "door portal did not default closed");
assert(manager.findRoomPath("settlement/alpha/house-07", "room/main", "room/service") === undefined, "closed door retained a room path");
const vertical = manager.findRoomPath("settlement/alpha/house-07", "room/upper", "room/main");
assert(vertical?.roomIds.join(",") === "room/upper,room/main" && vertical.connectionIds[0] === "stairs/main-upper", "stairs path is incorrect");
near(manager.acousticGain("settlement/alpha/house-07", "room/main", "room/upper"), .65 * .65, "vertical acoustic gain");
near(manager.acousticGain("settlement/alpha/house-07", "room/main", "room/service"), .65 * .3 * .65, "closed-door acoustic leakage");

const closedCells = manager.queryResidentCells(world([0, 1, 0]), undefined, 2)!;
assert(closedCells.cellIds.join(",") === "cell/main,cell/upper", "closed portal residency crossed into service room");
assert(manager.queryVisibleCells(world([0, 1, 0]))!.cellIds.join(",") === "cell/main,cell/upper", "closed visibility ignored stair connectivity");
const portalRevision = manager.getRevision();
assert(manager.setPortalOpen("settlement/alpha/house-07", "portal/service", true), "service portal did not open");
assert(manager.getRevision() === portalRevision + 1, "portal state did not advance revision");
assert(manager.setPortalOpen("settlement/alpha/house-07", "portal/service", true) && manager.getRevision() === portalRevision + 1, "idempotent portal write advanced revision");
const path = manager.findRoomPath("settlement/alpha/house-07", "room/service", "room/upper")!;
assert(path.roomIds.join(",") === "room/service,room/main,room/upper" && path.connectionIds.join(",") === "portal/service,stairs/main-upper", "open stable path is incorrect");
near(manager.acousticGain("settlement/alpha/house-07", "room/service", "room/upper"), .65 * .65 * .65, "open-door cross-room acoustic gain");
assert(manager.queryResidentCells(world([0, 1, 0]), undefined, 2)!.cellIds.join(",") === "cell/main,cell/service,cell/upper", "open connectivity did not expand resident cells");
assert(manager.queryVisibleCells(world([0, 1, 0]))!.cellIds.join(",") === "cell/main,cell/service,cell/upper", "open connectivity did not expand visible cells");
assert(manager.queryResidentCells(world([0, 1, 0]), undefined, 1, 2)!.cellIds.join(",") === "cell/main,cell/service", "stable resident cap failed");

const anchors = manager.worldSpawnAnchors("settlement/alpha/house-07");
assert(anchors.map((anchor) => anchor.id).join(",") === "spawn/a-service,spawn/m-upper,spawn/z-main", "anchors are not stable-sorted");
const mainAnchor = anchors[2];
near(mainAnchor.position[0], world([0, 0, 1])[0], "anchor world x");
near(mainAnchor.position[2], world([0, 0, 1])[2], "anchor world z");
near(mainAnchor.direction[0], s, "anchor direction x");
near(mainAnchor.direction[2], c, "anchor direction z");
assert(mainAnchor.kind === "player" && mainAnchor.clearanceRadius === .35 && mainAnchor.clearanceHeight === 1.8, "spawn semantics were not preserved");
contract.spawnAnchors[0].position[0] = 999;
near(manager.worldSpawnAnchors("settlement/alpha/house-07")[2].position[0], mainAnchor.position[0], "registered topology was mutated through caller contract");

const beforeCleanup = manager.getRevision();
assert(manager.unregisterBuilding("settlement/alpha/house-07") && manager.getRevision() === beforeCleanup + 1, "cleanup failed");
assert(manager.size() === 0 && manager.queryRoom(world([0, 1, 0])) === undefined && manager.worldSpawnAnchors("settlement/alpha/house-07").length === 0, "cleanup leaked runtime state");
assert(!manager.unregisterBuilding("settlement/alpha/house-07") && manager.getRevision() === beforeCleanup + 1, "missing cleanup changed revision");

console.log("p_functional_building_topology OK: oriented stacked-room queries, stable paths, portal acoustics/residency, transformed typed spawn anchors, bounded cleanup");
