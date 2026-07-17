import { FUNCTIONAL_BUILDING_CONTRACT_V2, parseFunctionalBuildingContract } from "../src/assets/functional-building-contract.ts";

function assert(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(`p_functional_building_contract_v2 FAIL: ${message}`); }
const enc = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
const node = (id: string, role: string, data: Record<string, unknown> = {}) => ({ extras: { limina: { id, role, ...data } } });
const room = (id: string, center: number[], halfExtents: number[], floor: number, ceiling: number, storey: number, cell: string) => ({
  id, bounds: { center, halfExtents }, finishedFloorY: floor, ceilingY: ceiling, storey, visibilityCellId: cell,
  acoustics: { absorption: .35, reverb: .2 },
});

const fixture = (): any => {
  const nodes = [
    node("building/root", "root"), node("room/main", "room"), node("room/service", "room"), node("room/upper", "room"),
    node("portal/exterior", "portal"), node("portal/service", "portal"),
    ...["floor-main", "floor-upper", "north", "south", "east", "west"].map((id) => node(`collider/${id}`, "collider", { shape: "box", center: [0, 1, 0], halfExtents: [1, 1, .1] })),
    node("door/front", "door", { roomId: "room/main", portalId: "portal/exterior", hinge: [-2, 0, 0], center: [0, 1, 0], halfExtents: [.06, 1, .5], closedYaw: 0, openYaw: -1.57 }),
    node("door/service", "door", { roomId: "room/main", portalId: "portal/service", hinge: [2, 0, 0], center: [0, 1, 0], halfExtents: [.06, 1, .5], closedYaw: 0, openYaw: 1.57 }),
  ];
  const authority = {
    schema: FUNCTIONAL_BUILDING_CONTRACT_V2, units: "meter", up: "Y", buildingId: "fixture/multi-storey/v2", rootNodeId: "building/root",
    roomIds: ["room/main", "room/service", "room/upper"], portalIds: ["portal/exterior", "portal/service"], entryAnchor: [-2.5, 0, 0],
    rooms: [room("room/main", [0, 1.5, 0], [2, 1.5, 2], 0, 3, 0, "cell/ground"), room("room/service", [3, 1.5, 0], [1, 1.5, 2], 0, 3, 0, "cell/service"), room("room/upper", [0, 4.5, 0], [2, 1.5, 2], 3, 6, 1, "cell/upper")],
    portals: [
      { id: "portal/exterior", kind: "door", exterior: true, roomIds: [null, "room/main"], center: [-2, 1, 0], halfExtents: [.1, 1, .6], acousticTransmission: .15, doorId: "door/front" },
      { id: "portal/service", kind: "door", exterior: false, roomIds: ["room/main", "room/service"], center: [2, 1, 0], halfExtents: [.1, 1, .6], acousticTransmission: .3, doorId: "door/service" },
    ],
    verticalLinks: [{ id: "stairs/main-upper", kind: "stairs", fromRoomId: "room/main", toRoomId: "room/upper", from: [-2, 0, 0], to: [2, 3, 0], clearWidth: 1, clearHeight: 2, rise: 3, run: 4, riserCount: 16, treadDepth: .25, upperFloorOpening: { center: [1.5, 0], halfExtents: [.5, .5] } }],
    spawnAnchors: [
      { id: "spawn/main", roomId: "room/main", kind: "player", position: [0, 0, 0], direction: [0, 0, 1], clearanceRadius: .35, clearanceHeight: 1.8 },
      { id: "spawn/service", roomId: "room/service", kind: "npc", position: [3, 0, 0], direction: [-1, 0, 0], clearanceRadius: .35, clearanceHeight: 1.8 },
      { id: "spawn/upper", roomId: "room/upper", kind: "item", position: [0, 3, 0], direction: [0, 0, -1], clearanceRadius: .2, clearanceHeight: .5 },
    ],
    visibilityCells: [
      { id: "cell/ground", roomIds: ["room/main"], nodeIds: ["room/main"] },
      { id: "cell/service", roomIds: ["room/service"], nodeIds: ["room/service"] },
      { id: "cell/upper", roomIds: ["room/upper"], nodeIds: ["room/upper"] },
    ],
  };
  const document: any = { asset: { version: "2.0", extras: { liminaFunctionalBuilding: authority } }, nodes,
    animations: [
      { name: "door/front/open", channels: [{ target: { node: 12, path: "rotation" } }] },
      { name: "door/service/open", channels: [{ target: { node: 13, path: "rotation" } }] },
    ], scenes: [{ nodes: [0] }], scene: 0 };
  document.nodes[0].children = document.nodes.slice(1).map((_: unknown, index: number) => index + 1);
  return document;
};

const parsed = parseFunctionalBuildingContract(enc(fixture()));
assert(parsed.schema === FUNCTIONAL_BUILDING_CONTRACT_V2, "valid v2 did not retain its schema");
assert(parsed.rooms.length === 3 && parsed.portals.length === 2 && parsed.verticalLinks.length === 1 && parsed.spawnAnchors.length === 3, "valid v2 semantic inventory drifted");

const rejects = (mutate: (value: any) => void, pattern: RegExp): void => {
  const value = fixture(); mutate(value);
  let error = ""; try { parseFunctionalBuildingContract(enc(value)); } catch (cause) { error = String(cause); }
  assert(pattern.test(error), `expected ${pattern}, got ${error}`);
};
rejects((v) => { v.asset.extras.liminaFunctionalBuilding.unreviewed = true; }, /unsupported/);
rejects((v) => { v.asset.extras.liminaFunctionalBuilding.rooms[2].bounds.center[1] = 4; }, /bounds must span/);
rejects((v) => { v.asset.extras.liminaFunctionalBuilding.rooms[0].acoustics.reverb = 1.1; }, /within \[0,1\]/);
rejects((v) => { v.asset.extras.liminaFunctionalBuilding.portals[1].roomIds[1] = "room/missing"; }, /unresolved or degenerate endpoints/);
rejects((v) => { v.asset.extras.liminaFunctionalBuilding.portals[0].exterior = false; }, /null exterior endpoint/);
rejects((v) => { v.nodes[13].extras.limina.portalId = "portal/exterior"; }, /inconsistent with portal/);
rejects((v) => { v.asset.extras.liminaFunctionalBuilding.verticalLinks = []; }, /every room must be connected/);
rejects((v) => { v.asset.extras.liminaFunctionalBuilding.verticalLinks[0].rise = 2.5; }, /stair construction/);
rejects((v) => { v.asset.extras.liminaFunctionalBuilding.verticalLinks[0].riserCount = 10; }, /stair construction/);
rejects((v) => { v.asset.extras.liminaFunctionalBuilding.spawnAnchors.pop(); }, /cover every room/);
rejects((v) => { v.asset.extras.liminaFunctionalBuilding.spawnAnchors[0].clearanceRadius = 3; }, /clearance must be contained/);
rejects((v) => { v.asset.extras.liminaFunctionalBuilding.visibilityCells[2].roomIds = ["room/main"]; }, /visibility cells must uniquely own/);

console.log("p_functional_building_contract_v2 OK: strict bounded multi-room topology rejects disconnected and inconsistent authority");
