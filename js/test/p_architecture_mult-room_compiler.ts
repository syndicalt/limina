import fs from "node:fs";
import {
  compileArchitecture,
  serializeBlenderArchitectureInput,
  type ArchitectureSpec,
  type FunctionalArchitectureSpecV2,
} from "../src/architecture/index.ts";
import { makeMultiRoomArchitectureSpec } from "./fixtures/architecture-multi-room.ts";

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(`p_architecture_multi_room_compiler FAIL: ${message}`);
}
function throws(mutator: (functional: FunctionalArchitectureSpecV2) => void, pattern: RegExp, message: string): void {
  const candidate = structuredClone(spec);
  mutator(candidate.functional as FunctionalArchitectureSpecV2);
  try { compileArchitecture(candidate); }
  catch (error) { assert(pattern.test(String(error)), `${message}: ${String(error)}`); return; }
  throw new Error(`p_architecture_multi_room_compiler FAIL: ${message} was accepted`);
}

const legacy = JSON.parse(fs.readFileSync(
  "assets/buildings/functional-hall-house-architecture-v5.json", "utf8",
)) as ArchitectureSpec;
const legacyBefore = compileArchitecture(legacy);
const old = legacy.functional!;
assert(!("schema" in old), "legacy fixture unexpectedly changed schema");

const spec = makeMultiRoomArchitectureSpec(legacy);
const functional = spec.functional as FunctionalArchitectureSpecV2;
const first = compileArchitecture(spec), second = compileArchitecture(structuredClone(spec));
assert(first.functionalContract?.schema === "limina.functional-building/v2", "compiler did not emit v2 authority");
assert(first.irHash === second.irHash && JSON.stringify(first) === JSON.stringify(second), "v2 compile is not deterministic");
const contract = first.functionalContract;
assert(contract.schema === "limina.functional-building/v2" && contract.rooms.length === 3 && contract.portals.length === 2, "room/portal mappings drifted");
assert(!("volumeId" in contract.rooms[0]), "compiler-only room/volume mapping leaked into strict runtime authority");
assert(contract.verticalLinks[0].riserCount === 18 && contract.spawnAnchors[0].kind === "player", "stair/spawn authority was not retained");
assert(contract.verticalLinks[0].upperFloorOpening.center[1] === .85, "floor-opening traversal authority was not retained");
assert(contract.verticalLinks[0].upperFloorOpening.halfExtents[1] === 2.25, "capsule-swept stair headroom aperture drifted");
assert(contract.doors[0].portalId === "portal/exterior" && contract.doors[0].roomId === "room/main", "door did not map through its portal endpoints");
assert(first.volumes.some((volume) => volume.id === "upper-hall" && volume.wallIds.length === 4), "upper room lacks compiled structural volume/walls");
const upper = first.volumes.find((volume) => volume.id === "upper-hall")!;
assert(upper.floorFragments?.length === 4 && !first.primitives.some((part) => part.id === upper.floor.id), "upper floor was not structurally partitioned around its stair opening");
const opening = functional.stairs[0].upperFloorOpening;
assert(!contract.colliders.some((collider) => collider.id === `collider/${upper.floor.id}`), "solid upper-floor collider survived floor partition");
for (const collider of contract.colliders.filter((item) => item.id.startsWith("collider/volume/upper-hall/floor-fragment-"))) {
  const separated = collider.center[0] + collider.halfExtents[0] <= opening.center[0] - opening.halfExtents[0] + 1e-6 ||
    collider.center[0] - collider.halfExtents[0] >= opening.center[0] + opening.halfExtents[0] - 1e-6 ||
    collider.center[2] + collider.halfExtents[2] <= opening.center[1] - opening.halfExtents[1] + 1e-6 ||
    collider.center[2] - collider.halfExtents[2] >= opening.center[1] + opening.halfExtents[1] - 1e-6;
  assert(separated, `${collider.id} covers the explicit upper-floor opening`);
}
const stairParts = first.primitives.filter((part) => part.id.startsWith("stairs/stairs/main-upper/"));
assert(stairParts.length === 20 && stairParts.some((part) => part.id.endsWith("landing-bottom")) && stairParts.some((part) => part.id.endsWith("landing-top")), "stair treads/landings were not compiled as geometry");
assert(stairParts.every((part) => contract.colliders.some((collider) => collider.id === `collider/${part.id}`)), "stair geometry lacks collision authority");
for (const part of stairParts) {
  assert(part.kind === "box", `${part.id} is not a solid stair primitive`);
  const collider = contract.colliders.find((item) => item.id === `collider/${part.id}`)!;
  assert(collider.halfExtents[1] <= .05 + 1e-9, `${part.id} retained a cumulative full-height traversal block`);
  assert(Math.abs(collider.center[1] + collider.halfExtents[1] - (part.center[1] + part.halfExtents[1])) < 1e-9,
    `${part.id} collision walking surface drifted from its visible tread top`);
}
const blenderPayload = JSON.parse(serializeBlenderArchitectureInput(first));
assert(blenderPayload.multiRoom?.schema === "limina.blender-multi-room-realization/v1" && blenderPayload.multiRoom.partitionedFloors[0].fragmentIds.length === 4, "Blender input lacks explicit v2 stair/floor realization authority");

// Compiling v2 must not perturb the canonical legacy path or any nested bytes.
const legacyAfter = compileArchitecture(structuredClone(legacy));
assert(legacyBefore.specHash === legacyAfter.specHash && legacyBefore.irHash === legacyAfter.irHash && JSON.stringify(legacyBefore) === JSON.stringify(legacyAfter), "legacy v1 output changed after v2 compile");

throws((v) => { v.rooms[2].storey = 2; }, /storeys must be contiguous/, "non-contiguous storeys");
throws((v) => { v.rooms[2].volumeId = "main-hall"; }, /uniquely resolve/, "room without unique structural volume");
throws((v) => { v.portals[1].roomIds = ["room/main", "room/missing"]; }, /unresolved or degenerate endpoints/, "unresolved portal endpoint");
throws((v) => { v.stairs[0].riserCount = 12; }, /rise\/run\/riser\/headroom\/landing/, "unsafe riser height");
throws((v) => { v.stairs[0].bottomLandingDepth = .5; }, /rise\/run\/riser\/headroom\/landing/, "undersized stair landing");
throws((v) => { v.stairs[0].upperFloorOpening.halfExtents = [.55, .5]; }, /rise\/run\/riser\/headroom\/landing/, "floor opening without stair headroom");
throws((v) => { v.stairs[0].upperFloorOpening.halfExtents = [.55, 1.5]; }, /rise\/run\/riser\/headroom\/landing/, "floor opening without swept capsule headroom");
throws((v) => { v.stairs[0].to = [-1.9, 3.55, 2.25]; }, /rise\/run\/riser\/headroom\/landing/, "non-cardinal stair without oriented collider authority");
throws((v) => { v.stairs = []; }, /connected to an exterior portal/, "disconnected upper room");
throws((v) => { v.visibilityCells[2].roomIds = ["room/main"]; }, /visibility cells must uniquely/, "duplicate cell ownership");
const unsupportedUpper = structuredClone(spec);
unsupportedUpper.volumes!.find((volume) => volume.id === "upper-hall")!.supportVolumeId = "service-bay";
try { compileArchitecture(unsupportedUpper); throw new Error("unsupported upper volume was accepted"); }
catch (error) { assert(/upper volume .* not fully supported/.test(String(error)), `wrong upper-volume support diagnostic: ${String(error)}`); }

// Independent room partitions on adjacent storeys need not share one bearing line. The additive
// support union proves exact rectangular coverage without weakening the legacy one-support path.
const unionSpec: ArchitectureSpec = {
  schema: "limina.architecture-spec/v1", id: "partition-support-union/v1",
  foundations: [{ id: "union-foundation", center: [0, 0], halfExtents: [4, 3], topY: 0, depth: 1 }],
  volumes: [
    { id: "lower-west", footprint: [[-4,-3],[0,-3],[0,3],[-4,3]], floorY: 0, eaveY: 3, wallThickness: .3, floorThickness: .2, ceilingThickness: .15, foundationId: "union-foundation" },
    { id: "lower-east", footprint: [[0,-3],[4,-3],[4,3],[0,3]], floorY: 0, eaveY: 3, wallThickness: .3, floorThickness: .2, ceilingThickness: .15, foundationId: "union-foundation" },
    { id: "upper-crossing", footprint: [[-3,-2],[3,-2],[3,2],[-3,2]], floorY: 3, eaveY: 6, wallThickness: .3, floorThickness: .2, ceilingThickness: .15, foundationId: "union-foundation", supportVolumeIds: ["lower-west", "lower-east"] },
  ], entrances: [],
};
const unionCompiled = compileArchitecture(unionSpec);
assert(unionCompiled.volumes.some((volume) => volume.id === "upper-crossing"), "valid partition support union was not compiled");
const gappedUnion = structuredClone(unionSpec);
gappedUnion.volumes![1].footprint = [[.2,-3],[4,-3],[4,3],[.2,3]];
try { compileArchitecture(gappedUnion); throw new Error("gapped partition support union was accepted"); }
catch (error) { assert(/not fully supported/.test(String(error)), `wrong support-union gap diagnostic: ${String(error)}`); }
const ambiguousUnion = structuredClone(unionSpec);
ambiguousUnion.volumes![2].supportVolumeId = "lower-west";
try { compileArchitecture(ambiguousUnion); throw new Error("dual support authorities were accepted"); }
catch (error) { assert(/choose one support authority/.test(String(error)), `wrong dual-support diagnostic: ${String(error)}`); }

console.log("p_architecture_multi_room_compiler OK: structural room volumes, exact partition support unions, partitioned floor void, collidable stair/landing geometry, deterministic topology, and byte-stable legacy v1");
