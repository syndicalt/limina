import { canonicalStringify } from "../authoring/canonical.ts";
import { sha256 } from "../world/sha256.mjs";
import { buildingProgramHash, parseBuildingProgram, type BuildingProgramObjective, type BuildingProgramV1 } from "./building-program.ts";
import { compileArchitecture } from "./compiler.ts";
import type { ArchitectureSpec, BuildingVolumeSpec, CompiledArchitecture, FunctionalArchitectureSpecV2, InteriorPartitionSpec, V2, V3, VolumeOpeningSpec } from "./schema.ts";

export const TIMBER_HALL_HOUSE_RULEBOOK_V1 = "limina.architecture-rulebook/timber-hall-house/v1" as const;
export const BUILDING_SYNTHESIS_MANIFEST_V1 = "limina.building-synthesis-manifest/v1" as const;

const RULEBOOK = Object.freeze({
  schema: TIMBER_HALL_HOUSE_RULEBOOK_V1,
  compilerInput: "limina.architecture-spec/v1",
  compilerOutput: "limina.architecture-compile/v1",
  supportedSpaces: Object.freeze(["ground:hall", "ground:kitchen", "upper:landing", "upper:bedroom:front", "upper:bedroom:rear"]),
  stair: Object.freeze({ kind: "straight", placement: "exterior-wall-adjacent", maximumRiserM: .175, headroom: "capsule-swept-floor-opening" }),
  roof: Object.freeze({ kind: "continuous-gable", ridgeAxis: "x" }),
  hearth: Object.freeze({ geometry: "compiler-authored", light: "bounded-fire-spill" }),
  timberFrame: Object.freeze({ requirement: "required", verification: "perceptual-only" }),
});

const hash = (value: unknown): `sha256:${string}` => `sha256:${sha256(canonicalStringify(value))}`;
export const TIMBER_HALL_HOUSE_RULEBOOK_V1_HASH = hash(RULEBOOK);

type StairPlacement = "left-wall" | "right-wall" | "center";
type StairDirection = "front-to-rear" | "rear-to-front";
type EnvelopeVariant = "compact" | "target";

export interface TimberHallHouseDecisionV1 {
  readonly schema: "limina.timber-hall-house-decision/v1";
  readonly id: string;
  readonly stairPlacement: StairPlacement;
  readonly stairDirection: StairDirection;
  readonly envelopeVariant: EnvelopeVariant;
}

export interface SynthesisScoreEntry {
  readonly criterion: BuildingProgramObjective;
  /** Integer penalty; lexicographically lower is better. */
  readonly value: number;
  readonly unit: "millimetres" | "count-negated" | "parts-per-million" | "millidegrees";
}

export interface SynthesisBindingManifestV1 {
  readonly schema: typeof BUILDING_SYNTHESIS_MANIFEST_V1;
  readonly programHash: `sha256:${string}`;
  readonly rulebookId: typeof TIMBER_HALL_HOUSE_RULEBOOK_V1;
  readonly rulebookHash: `sha256:${string}`;
  readonly decisionId: string;
  readonly decisionHash: `sha256:${string}`;
  readonly architectureSpecHash: string;
  readonly architectureIrHash: string;
  readonly perceptualRequirements: readonly [{ readonly id: "timber-frame-expression"; readonly verification: "perceptual-only" }];
}

export interface SynthesizedArchitectureCandidate {
  readonly rank: number;
  readonly decision: TimberHallHouseDecisionV1;
  readonly score: readonly SynthesisScoreEntry[];
  readonly spec: ArchitectureSpec;
  readonly compiled: CompiledArchitecture;
  readonly manifest: SynthesisBindingManifestV1;
}

export interface SynthesisRejection {
  readonly decisionId: string;
  readonly stage: "rulebook" | "architecture-compiler";
  readonly code: string;
  readonly message: string;
}

export interface BuildingProgramSynthesisResult {
  readonly schema: "limina.building-program-synthesis-result/v1";
  readonly programHash: `sha256:${string}`;
  readonly rulebookHash: `sha256:${string}`;
  readonly evaluatedDecisionCount: number;
  readonly acceptedDecisionCount: number;
  readonly candidates: readonly SynthesizedArchitectureCandidate[];
  readonly rejections: readonly SynthesisRejection[];
}

type ProgramSpace = BuildingProgramV1["spaces"][number];
type Dimensions = { width: number; depth: number; groundY: number; upperY: number; upperEaveY: number; wall: number; floor: number; overhang: number; pitch: number };

class RulebookRejection extends Error {
  readonly code: string;
  constructor(code: string, message: string) { super(message); this.code = code; }
}

function decisions(): readonly TimberHallHouseDecisionV1[] {
  const result: TimberHallHouseDecisionV1[] = [];
  for (const envelopeVariant of ["compact", "target"] as const)
    for (const stairDirection of ["front-to-rear", "rear-to-front"] as const)
      for (const stairPlacement of ["left-wall", "right-wall", "center"] as const)
        result.push({
          schema: "limina.timber-hall-house-decision/v1",
          id: `${envelopeVariant}/${stairDirection}/${stairPlacement}`,
          envelopeVariant,
          stairDirection,
          stairPlacement,
        });
  return Object.freeze(result);
}

function supportedSpaces(program: BuildingProgramV1): {
  hall: ProgramSpace; kitchen: ProgramSpace; landing: ProgramSpace; frontBedroom: ProgramSpace; rearBedroom: ProgramSpace;
} {
  const on = (storey: "ground" | "upper", use: string) => program.spaces.filter((space) => space.storey === storey && space.use === use);
  const hall = on("ground", "hall"), kitchen = on("ground", "kitchen"), landing = on("upper", "landing"), bedrooms = on("upper", "bedroom");
  if (program.spaces.length !== 5 || hall.length !== 1 || kitchen.length !== 1 || landing.length !== 1 || bedrooms.length !== 2)
    throw new RulebookRejection("UNSUPPORTED_SPACE_PROGRAM", "v1 requires exactly a ground hall and kitchen plus an upper landing and two bedrooms");
  const frontBedroom = bedrooms.find((space) => space.daylight.preferredFacades.includes("front"));
  const rearBedroom = bedrooms.find((space) => space.daylight.preferredFacades.includes("rear") && space !== frontBedroom);
  if (!frontBedroom || !rearBedroom)
    throw new RulebookRejection("UNSUPPORTED_UPPER_DAYLIGHT", "v1 requires distinct front- and rear-daylit upper bedrooms");
  if (program.entrances.length !== 1 || program.entrances[0].role !== "primary" || program.entrances[0].facade !== "front" || program.entrances[0].connectsToSpaceId !== hall[0].id)
    throw new RulebookRejection("UNSUPPORTED_ENTRANCE", "v1 requires one front primary entrance into the hall");
  if (program.entrances[0].stepFree === "required")
    throw new RulebookRejection("STEP_FREE_ENTRANCE_UNSUPPORTED", "v1 emits a bounded exterior step and cannot satisfy a required step-free entrance");
  if (frontBedroom.daylight.minimumWindowCount > 4 || rearBedroom.daylight.minimumWindowCount > 4)
    throw new RulebookRejection("UPPER_WINDOW_FACADE_CAPACITY", "v1 supports at most four windows on each upper bedroom facade");
  return { hall: hall[0], kitchen: kitchen[0], landing: landing[0], frontBedroom, rearBedroom };
}

const rectangle = (minX: number, maxX: number, minZ: number, maxZ: number): readonly V2[] =>
  Object.freeze([[minX, minZ], [maxX, minZ], [maxX, maxZ], [minX, maxZ]] as V2[]);

function windowOpenings(space: ProgramSpace, edgeIndex: 0 | 2, wallWidth: number, sillY: number, worldAlongCenter = 0): VolumeOpeningSpec[] {
  const count = space.daylight.minimumWindowCount;
  const width = Math.min(1.2, (wallWidth - .3) / Math.max(1, 1 + Math.max(0, count - 1) * 1.35));
  if (count > 0 && width < .55) throw new RulebookRejection("UPPER_WINDOW_FACADE_CAPACITY", `${space.id} windows do not fit its facade`);
  return Array.from({ length: count }, (_, index) => {
    const centered = (index - (count - 1) / 2) * width * 1.35;
    const worldAlong = worldAlongCenter + centered;
    return { id: `window/${space.id}/${index}`, kind: "window" as const, edgeIndex, offset: edgeIndex === 0 ? worldAlong : -worldAlong, width, sillY, height: 1.25 };
  });
}

function volume(id: string, footprint: readonly V2[], floorY: number, eaveY: number, dimensions: Dimensions, openings: VolumeOpeningSpec[], supportVolumeIds?: readonly string[]): BuildingVolumeSpec {
  return { id, footprint, floorY, eaveY, wallThickness: dimensions.wall, floorThickness: dimensions.floor, ceilingThickness: Math.min(.16, dimensions.floor / 2), foundationId: "foundation/main", ...(supportVolumeIds ? { supportVolumeIds } : {}), openings };
}

function assertEnvelopeAreaFeasible(program: BuildingProgramV1): void {
  const envelopeMinimum = program.envelope.footprintWidthM.minimum * program.envelope.footprintDepthM.minimum;
  const envelopeMaximum = program.envelope.footprintWidthM.maximum * program.envelope.footprintDepthM.maximum;
  for (const storey of ["ground", "upper"] as const) {
    const spaces = program.spaces.filter((space) => space.storey === storey);
    const roomMinimum = spaces.reduce((sum, space) => sum + space.areaM2.minimum, 0);
    const roomMaximum = spaces.reduce((sum, space) => sum + space.areaM2.maximum, 0);
    if (roomMaximum < envelopeMinimum - 1e-6 || roomMinimum > envelopeMaximum + 1e-6)
      throw new RulebookRejection("ENVELOPE_STOREY_AREA_INFEASIBLE", `${storey} aggregate room range ${roomMinimum}..${roomMaximum}m2 does not intersect envelope area range ${envelopeMinimum}..${envelopeMaximum}m2`);
  }
}

function dimensionsFor(program: BuildingProgramV1, decision: TimberHallHouseDecisionV1): Dimensions {
  const rangeValue = (range: { minimum: number; target: number }, compactFactor = 1) =>
    decision.envelopeVariant === "target" ? range.target : Math.max(range.minimum, range.target * compactFactor);
  const width = rangeValue(program.envelope.footprintWidthM, .9), depth = rangeValue(program.envelope.footprintDepthM, .9);
  const groundY = 0, upperY = program.envelope.groundClearHeightM.target;
  const upperEaveY = upperY + program.envelope.upperClearHeightM.target;
  const desiredRise = program.envelope.gable.ridgeRiseM.target;
  const pitch = Math.max(program.envelope.gable.pitchDegrees.minimum, 180 / Math.PI * Math.atan(desiredRise / (depth / 2)));
  const actualRise = depth / 2 * Math.tan(pitch * Math.PI / 180);
  if (pitch > program.envelope.gable.pitchDegrees.maximum + 1e-9 || actualRise > program.envelope.gable.ridgeRiseM.maximum + 1e-9)
    throw new RulebookRejection("ROOF_RANGE_UNSATISFIED", "continuous gable pitch and ridge-rise ranges do not intersect at this envelope depth");
  return { width, depth, groundY, upperY, upperEaveY, wall: program.envelope.wallThicknessM.target, floor: program.envelope.floorAssemblyThicknessM.target, overhang: program.envelope.gable.overhangM.target, pitch };
}

function makeSpec(program: BuildingProgramV1, programHash: `sha256:${string}`, decision: TimberHallHouseDecisionV1): { spec: ArchitectureSpec; metrics: Record<BuildingProgramObjective, number> } {
  if (decision.stairPlacement === "center")
    throw new RulebookRejection("STAIR_NOT_WALL_ADJACENT", "primary stair placement violates wallAdjacentPrimaryStair");
  const spaces = supportedSpaces(program), d = dimensionsFor(program, decision), halfW = d.width / 2, halfD = d.depth / 2;
  const hallOnRight = decision.stairPlacement === "right-wall";
  const groundTotal = spaces.hall.areaM2.target + spaces.kitchen.areaM2.target;
  const upperTotal = spaces.landing.areaM2.target + spaces.frontBedroom.areaM2.target + spaces.rearBedroom.areaM2.target;
  const hallRatio = spaces.hall.areaM2.target / groundTotal, landingRatio = spaces.landing.areaM2.target / upperTotal;
  const hallWidth = d.width * hallRatio, landingWidth = d.width * landingRatio;
  const groundSplit = hallOnRight ? halfW - hallWidth : -halfW + hallWidth;
  const upperSplit = hallOnRight ? halfW - landingWidth : -halfW + landingWidth;
  const hallX: readonly [number, number] = hallOnRight ? [groundSplit, halfW] : [-halfW, groundSplit];
  const kitchenX: readonly [number, number] = hallOnRight ? [-halfW, groundSplit] : [groundSplit, halfW];
  const landingX: readonly [number, number] = hallOnRight ? [upperSplit, halfW] : [-halfW, upperSplit];
  const bedroomX: readonly [number, number] = hallOnRight ? [-halfW, upperSplit] : [upperSplit, halfW];
  const frontDepth = d.depth * spaces.frontBedroom.areaM2.target / (spaces.frontBedroom.areaM2.target + spaces.rearBedroom.areaM2.target);
  const bedroomSplitZ = -halfD + frontDepth;
  const actualAreas = new Map<ProgramSpace, number>([
    [spaces.hall, hallWidth * d.depth],
    [spaces.kitchen, (d.width - hallWidth) * d.depth],
    [spaces.landing, landingWidth * d.depth],
    [spaces.frontBedroom, (d.width - landingWidth) * frontDepth],
    [spaces.rearBedroom, (d.width - landingWidth) * (d.depth - frontDepth)],
  ]);
  for (const [space, actual] of actualAreas)
    if (actual < space.areaM2.minimum - 1e-6 || actual > space.areaM2.maximum + 1e-6)
      throw new RulebookRejection("SPACE_AREA_RANGE_UNSATISFIED", `${space.id} compiles to ${actual.toFixed(3)}m2 outside its hard ${space.areaM2.minimum}..${space.areaM2.maximum}m2 range; v1 cannot separate room volumes from the structural shell`);
  const passageWidth = Math.max(1.2, program.connections.find((connection) => connection.fromSpaceId === spaces.hall.id && connection.toSpaceId === spaces.kitchen.id || connection.fromSpaceId === spaces.kitchen.id && connection.toSpaceId === spaces.hall.id)?.minimumClearWidthM ?? 1.2);
  const entryWidth = 1.2, entryHeight = Math.min(2.25, program.envelope.groundClearHeightM.target - .25);
  const bedroomConnections = program.connections.filter((connection) => connection.kind === "door" && (connection.fromSpaceId === spaces.landing.id || connection.toSpaceId === spaces.landing.id));
  const bedroomDoorWidth = Math.max(.9, ...bedroomConnections.map((connection) => connection.minimumClearWidthM));
  const frontZ = (-halfD + bedroomSplitZ) / 2, rearZ = (bedroomSplitZ + halfD) / 2;
  const entryX = (hallX[0] + hallX[1]) / 2,
    hallRoom = `room/${spaces.hall.id}`, kitchenRoom = `room/${spaces.kitchen.id}`,
    landingRoom = `room/${spaces.landing.id}`, frontRoom = `room/${spaces.frontBedroom.id}`,
    rearRoom = `room/${spaces.rearBedroom.id}`,
    groundVolumeId = "volume/storey-ground", upperVolumeId = "volume/storey-upper",
    bedroomWorldCenterX = (bedroomX[0] + bedroomX[1]) / 2;
  const supportedGroundFacade = (space: ProgramSpace, avoid?: "front" | "rear") => {
    const facades = space.daylight.preferredFacades.filter((value): value is "front" | "rear" => value === "front" || value === "rear");
    const selected = facades.find((value) => value !== avoid) ?? facades[0];
    if (!selected && space.daylight.minimumWindowCount)
      throw new RulebookRejection("GROUND_DAYLIGHT_FACADE_UNSUPPORTED", `${space.id} requires a front or rear facade in v1`);
    return selected ?? "front";
  };
  const kitchenFacade = supportedGroundFacade(spaces.kitchen),
    hallFacade = spaces.hall.daylight.preferredFacades.includes("rear") ? "rear" as const : supportedGroundFacade(spaces.hall, "front");
  const groundWindows = (space: ProgramSpace, facade: "front" | "rear", section: readonly [number,number]) =>
    windowOpenings(space, facade === "front" ? 0 : 2, section[1]-section[0], d.groundY+.9, (section[0]+section[1])/2);
  const volumes: BuildingVolumeSpec[] = [
    volume(groundVolumeId, rectangle(-halfW, halfW, -halfD, halfD), d.groundY, d.upperY, d, [
      { id: "opening/entry", kind: "door", edgeIndex: 0, offset: entryX, width: entryWidth, sillY: d.groundY, height: entryHeight },
      ...groundWindows(spaces.kitchen,kitchenFacade,kitchenX),
      ...groundWindows(spaces.hall,hallFacade,hallX),
    ]),
    { ...volume(upperVolumeId, rectangle(-halfW, halfW, -halfD, halfD), d.upperY, d.upperEaveY, d, [
      ...windowOpenings(spaces.frontBedroom, 0, bedroomX[1] - bedroomX[0], d.upperY + .75, bedroomWorldCenterX),
      ...windowOpenings(spaces.rearBedroom, 2, bedroomX[1] - bedroomX[0], d.upperY + .75, bedroomWorldCenterX),
    ]), supportVolumeId: groundVolumeId },
  ];
  const interiorPartitions: InteriorPartitionSpec[] = [
    { id: "partition/hall-kitchen", roomIds: [hallRoom, kitchenRoom], from: [groundSplit, -halfD], to: [groundSplit, halfD], bottomY: d.groundY, topY: d.upperY, thickness: d.wall,
      openings: [{ id: "opening/hall-kitchen", kind: "passage", offset: 0, width: passageWidth, sillY: d.groundY, height: 2.2 }] },
    { id: "partition/landing-front", roomIds: [landingRoom, frontRoom], from: [upperSplit, -halfD], to: [upperSplit, bedroomSplitZ], bottomY: d.upperY, topY: d.upperEaveY, thickness: d.wall,
      openings: [{ id: "opening/landing-front", kind: "door", offset: 0, width: bedroomDoorWidth, sillY: d.upperY, height: 2.05 }] },
    { id: "partition/landing-rear", roomIds: [landingRoom, rearRoom], from: [upperSplit, bedroomSplitZ], to: [upperSplit, halfD], bottomY: d.upperY, topY: d.upperEaveY, thickness: d.wall,
      openings: [{ id: "opening/landing-rear", kind: "door", offset: 0, width: bedroomDoorWidth, sillY: d.upperY, height: 2.05 }] },
    { id: "partition/bedrooms", roomIds: [frontRoom, rearRoom], from: [bedroomX[0], bedroomSplitZ], to: [bedroomX[1], bedroomSplitZ], bottomY: d.upperY, topY: d.upperEaveY, thickness: d.wall },
  ];

  const stairConnection = program.connections.find((connection) => connection.kind === "stair");
  const stairWidth = Math.max(.8, program.circulation.minimumStairClearWidthM, stairConnection?.minimumClearWidthM ?? 0);
  const riserCount = Math.ceil(d.upperY / RULEBOOK.stair.maximumRiserM), treadDepth = .25, stairRun = riserCount * treadDepth;
  const landingDepth = Math.max(stairWidth, program.circulation.minimumLandingDepthM);
  if (stairRun + 2 * landingDepth > d.depth)
    throw new RulebookRejection("STAIR_ENVELOPE_TOO_SHALLOW", "straight stair plus both landings does not fit the requested envelope");
  if (landingX[1] - landingX[0] < stairWidth + 2 * d.wall)
    throw new RulebookRejection("LANDING_STRIP_TOO_NARROW", "upper landing area cannot contain the wall-adjacent stair clear width");
  const stairX = decision.stairPlacement === "right-wall" ? halfW - d.wall - stairWidth / 2 : -halfW + d.wall + stairWidth / 2;
  const lowZ = -stairRun / 2, highZ = stairRun / 2, forward = decision.stairDirection === "front-to-rear";
  const from: V3 = [stairX, d.groundY, forward ? lowZ : highZ], to: V3 = [stairX, d.upperY, forward ? highZ : lowZ];
  const direction = forward ? 1 : -1;
  const traversalApproach = program.circulation.minimumHeadroomM * stairRun / d.upperY + stairWidth;
  const approachZ = to[2] - direction * traversalApproach;
  const openingMinZ = Math.min(approachZ, to[2]) - .02, openingMaxZ = Math.max(approachZ, to[2]) + .02;
  const stairOpening = { center: [stairX, (openingMinZ + openingMaxZ) / 2] as V2, halfExtents: [stairWidth / 2 + .02, (openingMaxZ - openingMinZ) / 2] as V2 };
  if (Math.abs(stairOpening.center[1]) + stairOpening.halfExtents[1] > halfD)
    throw new RulebookRejection("STAIR_HEADROOM_VOID_ESCAPES", "capsule-swept headroom opening escapes the upper landing");

  const room = (id: string, volumeId: string, minX: number, maxX: number, minZ: number, maxZ: number, floorY: number, ceilingY: number, storey: number) => ({
    id, volumeId, bounds: { center: [(minX + maxX) / 2, (floorY + ceilingY) / 2, (minZ + maxZ) / 2] as V3, halfExtents: [(maxX - minX) / 2, (ceilingY - floorY) / 2, (maxZ - minZ) / 2] as V3 },
    finishedFloorY: floorY, ceilingY, storey, visibilityCellId: `cell/${id}`, acoustics: { absorption: .4, reverb: .18 },
  });
  const rooms = [
    room(hallRoom, groundVolumeId, hallX[0], hallX[1], -halfD, halfD, d.groundY, d.upperY, 0),
    room(kitchenRoom, groundVolumeId, kitchenX[0], kitchenX[1], -halfD, halfD, d.groundY, d.upperY, 0),
    room(landingRoom, upperVolumeId, landingX[0], landingX[1], -halfD, halfD, d.upperY, d.upperEaveY, 1),
    room(frontRoom, upperVolumeId, bedroomX[0], bedroomX[1], -halfD, bedroomSplitZ, d.upperY, d.upperEaveY, 1),
    room(rearRoom, upperVolumeId, bedroomX[0], bedroomX[1], bedroomSplitZ, halfD, d.upperY, d.upperEaveY, 1),
  ];
  const ridgeRise = halfD * Math.tan(d.pitch * Math.PI / 180), ridgeY = d.upperEaveY + ridgeRise;
  const functional: FunctionalArchitectureSpecV2 = {
    schema: "limina.functional-architecture/v2", layoutAuthority: "partitioned-shell", buildingId: `synth/${programHash.slice(7, 19)}/${decision.id}`, entryAnchor: [entryX, d.groundY, -halfD - .5],
    site: { footprintCenter: [0, 0], footprintHalfExtents: [halfW, halfD], finishedFloorY: d.groundY, terrainClearance: program.site.minimumTerrainClearanceM, vegetationClearance: Math.max(1.2, program.site.minimumVegetationClearanceM), maximumTerrainRelief: Math.max(.01, program.site.maximumTerrainReliefM),
      entranceSupport: { center: [entryX, -halfD - .925], halfExtents: [.75, .175], yawRadians: 0, exteriorGradeY: -.36,
        bearingDepth: .1, maximumCutDepth: .04, maximumVariation: .08, sourcePrimitiveId: "entrance/entrance/main/step-0" } },
    clearAisle: { from: [entryX, d.groundY, -halfD], to: [stairX, d.groundY, from[2]], halfWidth: .5, minClearHeight: 2 },
    lod: { identity: `synth/${programHash.slice(7, 19)}/${decision.id}`, triangleBudget: program.budgets.lod0MaximumTriangles, drawBudget: program.budgets.maximumDrawCalls, lod1TriangleBudget: program.budgets.lod1MaximumTriangles, lod2TriangleBudget: program.budgets.lod2MaximumTriangles },
    rooms,
    portals: [
      { id: "portal/exterior", kind: "door", exterior: true, roomIds: [null, hallRoom], center: [entryX, entryHeight / 2, -halfD], halfExtents: [entryWidth / 2, entryHeight / 2, d.wall / 2], acousticTransmission: .15, doorId: "door/entry" },
      { id: "portal/hall-kitchen", kind: "passage", exterior: false, roomIds: [hallRoom, kitchenRoom], center: [groundSplit, 1.1, 0], halfExtents: [d.wall / 2, 1.1, passageWidth / 2], acousticTransmission: .7 },
      { id: "portal/landing-front", kind: "door", exterior: false, roomIds: [landingRoom, frontRoom], center: [upperSplit, d.upperY + 1.025, frontZ], halfExtents: [d.wall / 2, 1.025, bedroomDoorWidth / 2], acousticTransmission: .25, doorId: "door/landing-front" },
      { id: "portal/landing-rear", kind: "door", exterior: false, roomIds: [landingRoom, rearRoom], center: [upperSplit, d.upperY + 1.025, rearZ], halfExtents: [d.wall / 2, 1.025, bedroomDoorWidth / 2], acousticTransmission: .25, doorId: "door/landing-rear" },
    ],
    stairs: [{ id: "stairs/primary", fromRoomId: hallRoom, toRoomId: landingRoom, from, to, clearWidth: stairWidth, clearHeight: program.circulation.minimumHeadroomM, rise: d.upperY, run: stairRun, riserCount, treadDepth, bottomLandingDepth: landingDepth, topLandingDepth: landingDepth, upperFloorOpening: stairOpening }],
    spawnAnchors: rooms.map((item, index) => ({ id: `spawn/${index}`, roomId: item.id, kind: index === 0 ? "player" as const : "item" as const, position: [item.bounds.center[0], item.finishedFloorY, item.bounds.center[2]] as V3, direction: [0, 0, 1] as V3, clearanceRadius: .2, clearanceHeight: .5 })),
    visibilityCells: rooms.map((item) => ({ id: item.visibilityCellId, roomIds: [item.id], nodeIds: [item.id] })),
  };
  const spec: ArchitectureSpec = {
    schema: "limina.architecture-spec/v1", id: `synth/${programHash.slice(7, 19)}/${decision.id}`,
    foundations: [{ id: "foundation/main", center: [0, 0], halfExtents: [halfW, halfD], topY: 0, depth: 1 }], volumes, interiorPartitions,
    entrances: [{ id: "entrance/main", wallId: `${groundVolumeId}/edge-0`, openingId: "opening/entry", exteriorSide: -1, exteriorGradeY: -.36, landingDepth: .75, stepCount: 2, treadDepth: .35, width: 1.5,
      constructionPolicy: "finished-surface-authority", bearingDepth: .1 }],
    doors: [
      { id: "door/entry", wallId: `${groundVolumeId}/edge-0`, openingId: "opening/entry", hingeSide: "start", leafThickness: .06, openYawDegrees: 95 },
      { id: "door/landing-front", wallId: "partition/landing-front", openingId: "opening/landing-front", hingeSide: "start", leafThickness: .05, openYawDegrees: 95 },
      { id: "door/landing-rear", wallId: "partition/landing-rear", openingId: "opening/landing-rear", hingeSide: "end", leafThickness: .05, openYawDegrees: 95 },
    ],
    roofSystems: [{ id: "roof/main", kind: "gable", volumeId: upperVolumeId, ridgeAxis: "x", pitchDegrees: d.pitch,
      eaveOverhang: d.overhang, ridgeEndOverhang: [d.overhang, d.overhang], thickness: .16 }],
    perceptualTimberFrames: [
      { id: "frame/south", verification: "perceptual-only", facade: "south", wallIds: [`${groundVolumeId}/edge-0`, `${upperVolumeId}/edge-0`], baySpacing: 1.55, memberWidth: .16, memberDepth: .12, apertureClearance: .05 },
      { id: "frame/east-gable", verification: "perceptual-only", facade: "east", wallIds: [`${groundVolumeId}/edge-1`, `${upperVolumeId}/edge-1`], roofSystemId: "roof/main", baySpacing: 1.55, memberWidth: .16, memberDepth: .12, apertureClearance: .05 },
      { id: "frame/north", verification: "perceptual-only", facade: "north", wallIds: [`${groundVolumeId}/edge-2`, `${upperVolumeId}/edge-2`], baySpacing: 1.55, memberWidth: .16, memberDepth: .12, apertureClearance: .05 },
      { id: "frame/west-gable", verification: "perceptual-only", facade: "west", wallIds: [`${groundVolumeId}/edge-3`, `${upperVolumeId}/edge-3`], roofSystemId: "roof/main", baySpacing: 1.55, memberWidth: .16, memberDepth: .12, apertureClearance: .05 },
    ],
    fireplaces: [{ id: "fireplace/hall", center: [entryX, .75, halfD - .65], apertureHalfExtents: [.6, .6, .45], chimneyTopY: ridgeY + .8, roofPlaneId: "roof/main/north", lightId: "light/hearth", supportY: 0 }],
    practicalLights: [{ id: "light/hearth", position: [entryX, .9, halfD - .9], color: [.75, .25, .08], intensityCandela: 6, range: 2 }],
    functional,
  };
  const upperWindowCount = spaces.frontBedroom.daylight.minimumWindowCount + spaces.rearBedroom.daylight.minimumWindowCount;
  const entryToStair = Math.hypot(stairX - entryX, from[2] + halfD);
  const ratioPenalty = Math.round([...actualAreas].reduce((sum, [space, actual]) => sum + Math.abs(actual - space.areaM2.target), 0) * 1e6);
  const allMetrics: Record<BuildingProgramObjective, number> = {
    "circulation-efficiency": Math.round(entryToStair * 1000),
    "daylight": -upperWindowCount,
    "usable-area": ratioPenalty,
    "structural-legibility": Math.round((d.wall + stairWidth / 2) * 1000),
    "facade-rhythm": Math.round(Math.abs(entryX) * 1000),
    "roof-simplicity": Math.round(Math.abs(d.pitch - program.envelope.gable.pitchDegrees.target) * 1000),
  };
  return { spec, metrics: allMetrics };
}

function assertDaylightFulfilled(program: BuildingProgramV1, compiled: CompiledArchitecture): void {
  const facade = { front: "south", rear: "north", left: "west", right: "east" } as const;
  for (const space of program.spaces) {
    if (space.daylight.exteriorWindows !== "required") continue;
    const windows = compiled.windows.filter((window) => window.openingId.startsWith(`window/${space.id}/`));
    if (windows.length < space.daylight.minimumWindowCount)
      throw new RulebookRejection("DAYLIGHT_WINDOW_COUNT_UNSATISFIED", `${space.id} requires ${space.daylight.minimumWindowCount} exterior windows but compiled ${windows.length}`);
    const allowed = new Set(space.daylight.preferredFacades.map((value) => facade[value as keyof typeof facade]));
    if (allowed.size && windows.some((window) => !allowed.has(window.facade)))
      throw new RulebookRejection("DAYLIGHT_FACADE_UNSATISFIED", `${space.id} window escaped its preferred exterior facades`);
  }
  const requiredUpper = program.requirements.daylight.minimumUpperFloorWindowCount,
    upperSpaceIds = new Set(program.spaces.filter((space) => space.storey === "upper" && space.daylight.exteriorWindows === "required").map((space) => space.id)),
    upperCount = compiled.windows.filter((window) => [...upperSpaceIds].some((id) => window.openingId.startsWith(`window/${id}/`))).length;
  if (upperCount < requiredUpper)
    throw new RulebookRejection("UPPER_DAYLIGHT_WINDOW_COUNT_UNSATISFIED", `upper floor requires ${requiredUpper} exterior windows but compiled ${upperCount}`);
}

const scoreUnit: Record<BuildingProgramObjective, SynthesisScoreEntry["unit"]> = {
  "circulation-efficiency": "millimetres", daylight: "count-negated", "usable-area": "parts-per-million",
  "structural-legibility": "millimetres", "facade-rhythm": "millimetres", "roof-simplicity": "millidegrees",
};

function compareScores(a: { score: readonly SynthesisScoreEntry[]; decision: TimberHallHouseDecisionV1 }, b: { score: readonly SynthesisScoreEntry[]; decision: TimberHallHouseDecisionV1 }): number {
  for (let index = 0; index < a.score.length; index++) {
    const difference = a.score[index].value - b.score[index].value;
    if (difference !== 0) return difference;
  }
  return a.decision.id.localeCompare(b.decision.id);
}

/**
 * Deterministic, bounded beam for one explicit rulebook. Every returned spec has passed the real
 * architecture compiler; unsupported semantics and compiler failures remain inspectable rejections.
 */
export function synthesizeTimberHallHouse(programInput: unknown): BuildingProgramSynthesisResult {
  const program = parseBuildingProgram(programInput), programHash = buildingProgramHash(program), allDecisions = decisions();
  const accepted: Omit<SynthesizedArchitectureCandidate, "rank">[] = [], rejections: SynthesisRejection[] = [];
  try { assertEnvelopeAreaFeasible(program); }
  catch (error) {
    if (!(error instanceof RulebookRejection)) throw error;
    return Object.freeze({
      schema: "limina.building-program-synthesis-result/v1", programHash, rulebookHash: TIMBER_HALL_HOUSE_RULEBOOK_V1_HASH,
      evaluatedDecisionCount: allDecisions.length, acceptedDecisionCount: 0, candidates: Object.freeze([]),
      rejections: Object.freeze(allDecisions.map((decision) => ({ decisionId: decision.id, stage: "rulebook" as const, code: error.code, message: error.message }))),
    });
  }
  for (const decision of allDecisions) {
    try {
      const { spec, metrics } = makeSpec(program, programHash, decision), compiled = compileArchitecture(spec);
      assertDaylightFulfilled(program, compiled);
      const score = program.objectives.map((criterion) => ({ criterion, value: metrics[criterion], unit: scoreUnit[criterion] }));
      accepted.push({
        decision, score, spec, compiled,
        manifest: {
          schema: BUILDING_SYNTHESIS_MANIFEST_V1, programHash, rulebookId: TIMBER_HALL_HOUSE_RULEBOOK_V1,
          rulebookHash: TIMBER_HALL_HOUSE_RULEBOOK_V1_HASH, decisionId: decision.id, decisionHash: hash(decision),
          architectureSpecHash: compiled.specHash, architectureIrHash: compiled.irHash,
          perceptualRequirements: [{ id: "timber-frame-expression", verification: "perceptual-only" }],
        },
      });
    } catch (error) {
      const rulebook = error instanceof RulebookRejection;
      rejections.push({ decisionId: decision.id, stage: rulebook ? "rulebook" : "architecture-compiler", code: rulebook ? error.code : "ARCHITECTURE_COMPILE_FAILED", message: error instanceof Error ? error.message : String(error) });
    }
  }
  const candidates = accepted.sort(compareScores).slice(0, 3).map((candidate, index) => Object.freeze({ ...candidate, rank: index + 1 }));
  return Object.freeze({ schema: "limina.building-program-synthesis-result/v1", programHash, rulebookHash: TIMBER_HALL_HOUSE_RULEBOOK_V1_HASH, evaluatedDecisionCount: allDecisions.length, acceptedDecisionCount: accepted.length, candidates: Object.freeze(candidates), rejections: Object.freeze(rejections) });
}
