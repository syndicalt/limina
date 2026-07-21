import type {
  ArchitectureSpec,
  FunctionalArchitectureSpecV2,
} from "../../src/architecture/index.ts";

/** Deterministic FB-4 fixture shared by compiler and Blender round-trip tests. */
export function makeMultiRoomArchitectureSpec(base: ArchitectureSpec): ArchitectureSpec {
  const legacy = JSON.parse(JSON.stringify(base)) as ArchitectureSpec;
  const old = legacy.functional!;
  if ("schema" in old) throw new Error("multi-room fixture requires the canonical legacy v1 base");
  const functional: FunctionalArchitectureSpecV2 = {
    schema: "limina.functional-architecture/v2",
    buildingId: "hall-house/multi-room/compiler-fixture/v2",
    entryAnchor: [...old.entryAnchor],
    site: JSON.parse(JSON.stringify(old.site)),
    clearAisle: JSON.parse(JSON.stringify(old.clearAisle)),
    lod: { ...old.lod, identity: "hall-house/multi-room/compiler-fixture/v2" },
    rooms: [
      { id: "room/main", volumeId: "main-hall", bounds: { center: [0, 1.82, 0], halfExtents: [4.8, 1.73, 3.42] }, finishedFloorY: .09, ceilingY: 3.55, storey: 0, visibilityCellId: "cell/main", acoustics: { absorption: .35, reverb: .22 } },
      { id: "room/service", volumeId: "service-bay", bounds: { center: [2.62, 1.895, -4.22], halfExtents: [1.52, 1.805, .8] }, finishedFloorY: .09, ceilingY: 3.7, storey: 0, visibilityCellId: "cell/service", acoustics: { absorption: .42, reverb: .16 } },
      { id: "room/upper", volumeId: "upper-hall", bounds: { center: [0, 5.05, 0], halfExtents: [4, 1.5, 3.42] }, finishedFloorY: 3.55, ceilingY: 6.55, storey: 1, visibilityCellId: "cell/upper", acoustics: { absorption: .5, reverb: .12 } },
    ],
    portals: [
      { id: "portal/exterior", kind: "door", exterior: true, roomIds: [null, "room/main"], center: [-.72, 1.3, -3.42], halfExtents: [.72, 1.21, .1], acousticTransmission: .15, doorId: "door/front" },
      { id: "portal/service", kind: "passage", exterior: false, roomIds: ["room/main", "room/service"], center: [2.62, 1.4, -3.42], halfExtents: [.7, 1.2, .1], acousticTransmission: .7 },
    ],
    stairs: [
      { id: "stairs/main-upper", fromRoomId: "room/main", toRoomId: "room/upper", from: [-2, .09, -2.25], to: [-2, 3.55, 2.25], clearWidth: .9, clearHeight: 2.1, rise: 3.46, run: 4.5, riserCount: 18, treadDepth: .25, bottomLandingDepth: .9, topLandingDepth: .9, upperFloorOpening: { center: [-2, .85], halfExtents: [.55, 2.25] } },
    ],
    spawnAnchors: [
      { id: "spawn/main", roomId: "room/main", kind: "player", position: [-2, .09, 0], direction: [0, 0, 1], clearanceRadius: .4, clearanceHeight: 1.8 },
      { id: "spawn/service", roomId: "room/service", kind: "npc", position: [2.62, .09, -4.22], direction: [-1, 0, 0], clearanceRadius: .35, clearanceHeight: 1.7 },
      { id: "spawn/upper", roomId: "room/upper", kind: "item", position: [1, 3.55, 0], direction: [0, 0, -1], clearanceRadius: .2, clearanceHeight: .5 },
    ],
    visibilityCells: [
      { id: "cell/main", roomIds: ["room/main"], nodeIds: ["room/main"] },
      { id: "cell/service", roomIds: ["room/service"], nodeIds: ["room/service"] },
      { id: "cell/upper", roomIds: ["room/upper"], nodeIds: ["room/upper"] },
    ],
  };
  legacy.id = "hall-house/multi-room/compiler-fixture/v2";
  legacy.volumes!.push({ id: "upper-hall", footprint: [[-4, -3.42], [4, -3.42], [4, 3.42], [-4, 3.42]], floorY: 3.55, eaveY: 6.55, wallThickness: .3, floorThickness: .16, ceilingThickness: .12, foundationId: "main-core", supportVolumeId: "main-hall" });
  // The second storey owns the primary gable. Keeping the R1 one-storey roof on
  // main-hall would put an otherwise mechanically valid room through the roof.
  // Retain the approved roof/material design, but raise its dependent dormer and
  // chimney construction as one architectural system.
  const mainRoof = legacy.roofSystems!.find(({ id }) => id === "main-roof")!;
  (mainRoof as { volumeId: string }).volumeId = "upper-hall";
  // The lower service gable now terminates against the upper-storey wall. It is
  // not a coplanar valley with the raised main roof and therefore must not emit
  // the old one-storey valley/trim solution.
  legacy.roofJunctions = [];
  const serviceRoof = legacy.roofSystems!.find(({ id }) => id === "service-roof")!;
  (serviceRoof as { ridgeEndOverhang: readonly [number, number] }).ridgeEndOverhang = [.51, .12];
  legacy.roofWallAbutments = [
    { id: "service-upper-headwall-west", roofPlaneId: "service-roof/west", wallId: "upper-hall/edge-0", from: [.9910186207991958, 3.55, -3.3], to: [2.62, 5.792100519116183, -3.3], flashingWidth: .22, upstandDepth: .1 },
    { id: "service-upper-headwall-east", roofPlaneId: "service-roof/east", wallId: "upper-hall/edge-0", from: [2.62, 5.792100519116183, -3.3], to: [4.248981379200805, 3.55, -3.3], flashingWidth: .22, upstandDepth: .1 },
  ];
  for (const dormer of legacy.dormers ?? []) {
    (dormer as { wallBaseY: number }).wallBaseY += 3;
    (dormer as { eaveY: number }).eaveY += 3;
    (dormer as { windowSillY: number }).windowSillY += 3;
  }
  for (const fireplace of legacy.fireplaces ?? []) (fireplace as { chimneyTopY: number }).chimneyTopY += 3;
  for (const penetration of legacy.roofPenetrations ?? []) (penetration as { topY: number }).topY += 3;
  // Visible upper-storey oak plates and ties continue the approved R1 timber
  // language instead of presenting a featureless extruded plaster box.
  legacy.interiorStructure = [...(legacy.interiorStructure ?? []),
    { id: "upper/plate-south", kind: "wall-plate", center: [0, 6.31, -3.25], halfExtents: [3.92, .13, .12] },
    { id: "upper/plate-north", kind: "wall-plate", center: [0, 6.31, 3.25], halfExtents: [3.92, .13, .12] },
    ...[-3.65, -1.85, 0, 1.85, 3.65].flatMap((x, index) => [
      { id: `upper/tie-south-${index}`, kind: "tie-beam" as const, center: [x, 5.05, -3.27] as const, halfExtents: [.11, 1.25, .1] as const },
      { id: `upper/tie-north-${index}`, kind: "tie-beam" as const, center: [x, 5.05, 3.27] as const, halfExtents: [.11, 1.25, .1] as const },
    ]),
  ];
  legacy.functional = functional;
  return legacy;
}
