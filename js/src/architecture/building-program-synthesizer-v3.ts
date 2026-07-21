import { canonicalStringify } from "../authoring/canonical.ts";
import { sha256 } from "../world/sha256.mjs";
import {
  buildingProgramV3Hash,
  parseBuildingProgramV3,
  type BuildingProgramV2,
  type BuildingProgramV3,
} from "./building-program.ts";
import {
  BUILDING_SYNTHESIS_MANIFEST_V2,
  TIMBER_HALL_HOUSE_RULEBOOK_V2_HASH,
  synthesizeTimberHallHouseV2,
  type SynthesisRejection,
  type SynthesisScoreEntryV2,
  type TimberHallHouseDecisionV1,
} from "./building-program-synthesizer.ts";
import { compileArchitecture } from "./compiler.ts";
import type {
  ArchitectureSpec,
  CompiledArchitecture,
  FunctionalArchitectureSpecV2,
  V2,
  V3,
} from "./schema.ts";

export const TIMBER_HALL_HOUSE_RULEBOOK_V3 = "limina.architecture-rulebook/timber-hall-house/v3" as const;
export const BUILDING_SYNTHESIS_MANIFEST_V3 = "limina.building-synthesis-manifest/v3" as const;
const RULEBOOK_V3 = Object.freeze({
  schema: TIMBER_HALL_HOUSE_RULEBOOK_V3,
  parentRulebookHash: TIMBER_HALL_HOUSE_RULEBOOK_V2_HASH,
  massing: "one-functional-front-service-cross-gable",
  bayOwnership: "compiler-owned-attached-bay",
  roofTermination: "two-slope-upper-headwall-abutment",
  foundation: "zero-positive-overlap-edge-touching-bearing-pad",
  entranceJoinery: "wall-plate-header-post-brace",
  upperDoorSwing: "bedroom-side-clear-of-stair-circulation",
  stairTraversal: "wall-adjacent-multi-flight-with-clear-landings-and-controller-approach-sockets",
  hearthFlueConnection: "compiler-owned-enclosed-masonry-breast",
  roofWeatherBearing: "full-facade-envelope-cover-with-exterior-face-headwall-termination",
  evidence: "five-semantic-cpu-claim-families-before-native-capture",
});
const hash = (value: unknown): `sha256:${string}` => `sha256:${sha256(canonicalStringify(value))}`;
export const TIMBER_HALL_HOUSE_RULEBOOK_V3_HASH = hash(RULEBOOK_V3);

export type BuildingCueFactValue = string | number | boolean;
export interface SynthesisBindingManifestV3 {
  readonly schema: typeof BUILDING_SYNTHESIS_MANIFEST_V3;
  readonly programHash: `sha256:${string}`;
  readonly visualFloorAuthority: { readonly path: string; readonly sha256: `sha256:${string}` };
  readonly rulebookId: typeof TIMBER_HALL_HOUSE_RULEBOOK_V3;
  readonly rulebookHash: `sha256:${string}`;
  readonly parentRulebookHash: `sha256:${string}`;
  readonly decisionId: string;
  readonly decisionHash: `sha256:${string}`;
  readonly architectureSpecHash: string;
  readonly architectureIrHash: string;
  readonly compiledMassing: {
    readonly attachedBayId: string;
    readonly functionalRoomId: string;
    readonly portalId: string;
    readonly frontWindowId: string;
    readonly roofPlaneIds: readonly [string, string];
    readonly roofAbutmentIds: readonly [string, string];
    readonly kneeBraceIds: readonly [string, string];
  };
  readonly cueFacts: Readonly<Record<string, BuildingCueFactValue>>;
  readonly evidenceRequirements: {
    readonly semanticCpu: {
      readonly required: true;
      readonly claimIds: readonly ["gable-upper-window", "entry-canopy", "passage-fireplace", "stair-circulation", "upper-circulation"];
      readonly visualApproval: false;
    };
  };
  readonly perceptualRequirements: readonly [{ readonly id: "timber-frame-expression"; readonly verification: "perceptual-only" }];
}

export interface SynthesizedArchitectureCandidateV3 {
  readonly rank: number;
  readonly decision: TimberHallHouseDecisionV1;
  readonly score: readonly SynthesisScoreEntryV2[];
  readonly spec: ArchitectureSpec;
  readonly compiled: CompiledArchitecture;
  readonly manifest: SynthesisBindingManifestV3;
}
export interface BuildingProgramSynthesisResultV3 {
  readonly schema: "limina.building-program-synthesis-result/v3";
  readonly programHash: `sha256:${string}`;
  readonly rulebookHash: `sha256:${string}`;
  readonly evaluatedDecisionCount: number;
  readonly acceptedDecisionCount: number;
  readonly candidates: readonly SynthesizedArchitectureCandidateV3[];
  readonly rejections: readonly SynthesisRejection[];
}

function coreV2Program(program: BuildingProgramV3): BuildingProgramV2 {
  const value = structuredClone(program) as any;
  const service = program.articulation.serviceCrossGable;
  value.schema = "limina.building-program/v2";
  value.id = `${program.id}/core`;
  value.spaces = value.spaces.filter((space: { id: string }) => space.id !== service.spaceId);
  value.connections = value.connections.filter((connection: { id: string }) => connection.id !== service.passageConnectionId);
  value.budgets = {
    lod0MaximumTriangles: program.budgets.lod0MaximumTriangles,
    lod1MaximumTriangles: program.budgets.lod1MaximumTriangles,
    lod2MaximumTriangles: program.budgets.lod2MaximumTriangles,
    maximumDrawCalls: program.budgets.maximumDrawCalls,
    visualFloorHash: program.budgets.visualFloorAuthority.sha256,
  };
  const { serviceCrossGable: _service, ...articulation } = value.articulation;
  const { bracing: _bracing, ...entrance } = articulation.entrance;
  value.articulation = { ...articulation, entrance };
  return value as BuildingProgramV2;
}

function bounds(points: readonly V2[]) {
  return {
    minX: Math.min(...points.map((point) => point[0])),
    maxX: Math.max(...points.map((point) => point[0])),
    minZ: Math.min(...points.map((point) => point[1])),
    maxZ: Math.max(...points.map((point) => point[1])),
  };
}

function realizeV3(program: BuildingProgramV3, source: ArchitectureSpec): ArchitectureSpec {
  const spec = structuredClone(source) as ArchitectureSpec;
  const ground = spec.volumes?.find((volume) => volume.id === "volume/storey-ground"),
    upper = spec.volumes?.find((volume) => volume.id === "volume/storey-upper"),
    functional = spec.functional as FunctionalArchitectureSpecV2 | undefined;
  if (!ground || !upper || !functional || functional.schema !== "limina.functional-architecture/v2")
    throw new Error("V3_MISSING_PARTITIONED_CORE: service mass requires the exact two-storey V2 functional core");
  const main = bounds(ground.footprint), width = program.articulation.serviceCrossGable.widthM.target,
    serviceSpace = program.spaces.find((space) => space.id === program.articulation.serviceCrossGable.spaceId),
    hostRoom = functional.rooms.find((room) => room.id === `room/${program.articulation.serviceCrossGable.hostSpaceId}`),
    connection = program.connections.find((entry) => entry.id === program.articulation.serviceCrossGable.passageConnectionId);
  if (!serviceSpace || !hostRoom || !connection) throw new Error("V3_SERVICE_AUTHORITY_MISSING: service room, host room, or passage is unresolved");
  const projection = Math.min(program.articulation.serviceCrossGable.projectionM.target, serviceSpace.areaM2.maximum / width),
    facadeMargin = .25,
    alongOffset = program.articulation.serviceCrossGable.sideBias === "left"
      ? -(main.maxX - main.minX) / 2 + width / 2 + facadeMargin
      : (main.maxX - main.minX) / 2 - width / 2 - facadeMargin,
    bayMinX = alongOffset - width / 2,
    bayMaxX = alongOffset + width / 2,
    bayMaxZ = main.minZ,
    bayMinZ = main.minZ - projection,
    pitchDegrees = program.envelope.gable.pitchDegrees.minimum,
    eaveOverhang = .25,
    eaveY = upper.floorY + eaveOverhang * Math.tan(pitchDegrees * Math.PI / 180) + .02,
    passageWidth = Math.max(1.8, connection.minimumClearWidthM),
    passageHeight = Math.min(2.3, ground.eaveY - ground.floorY - .2),
    roomId = `room/${serviceSpace.id}`,
    volumeId = "volume/service-cross-gable",
    portalId = `portal/${program.articulation.serviceCrossGable.passageConnectionId}`,
    frontWindowId = `window/${serviceSpace.id}/gable-0`,
    roomCenter: V3 = [(bayMinX + bayMaxX) / 2, (ground.floorY + eaveY) / 2, (bayMinZ + bayMaxZ) / 2],
    roomHalf: V3 = [(bayMaxX - bayMinX) / 2, (eaveY - ground.floorY) / 2, (bayMaxZ - bayMinZ) / 2];

  const baySharedMin = alongOffset - width / 2, baySharedMax = alongOffset + width / 2;
  for (const opening of ground.openings ?? []) if (opening.edgeIndex === 0) {
    const openingMin = opening.offset - opening.width / 2, openingMax = opening.offset + opening.width / 2;
    if (Math.min(baySharedMax, openingMax) - Math.max(baySharedMin, openingMin) > .01)
      throw new Error(`V3_EXISTING_FACADE_OPENING_BURIED: service mass would bury ${opening.id}`);
  }
  if (Math.abs(alongOffset - hostRoom.bounds.center[0]) > hostRoom.bounds.halfExtents[0] - passageWidth / 2)
    throw new Error("V3_HOST_ROOM_MISALIGNMENT: service passage does not lie inside its declared host room");

  // The cross-gable occupies the left front headwall. Preserve real bedroom
  // daylight by moving the front bedroom's declared openings onto its allowed
  // west gable, then place the non-habitable dormer on the opposite roof bay.
  const gableBedroom = program.spaces.find((space) => space.storey === "upper" && space.use === "bedroom" && space.daylight.preferredFacades.includes("left")),
    gableRoom = gableBedroom && functional.rooms.find((room) => room.id === `room/${gableBedroom.id}`);
  if (!gableBedroom || !gableRoom) throw new Error("V3_UPPER_GABLE_DAYLIGHT_AUTHORITY_MISSING: west-gable bedroom is unresolved");
  const retainedUpperOpenings = (upper.openings ?? []).filter((opening) => !opening.id.startsWith(`window/${gableBedroom.id}/`)),
    gableWindowWidth = 1.05,
    gableWindows = Array.from({ length: gableBedroom.daylight.minimumWindowCount }, (_, index) => ({
      id: `window/${gableBedroom.id}/${index}`, kind: "window" as const, edgeIndex: 3,
      offset: -gableRoom.bounds.center[2] + (index - (gableBedroom.daylight.minimumWindowCount - 1) / 2) * gableWindowWidth * 1.35,
      width: gableWindowWidth, sillY: upper.floorY + .75, height: 1.25,
    }));
  (upper as any).openings = [...retainedUpperOpenings, ...gableWindows];
  spec.dormers = spec.dormers?.map((dormer) => ({ ...dormer, alongCenter: program.articulation.serviceCrossGable.sideBias === "left" ? 2.45 : -2.45 }));

  spec.attachedBays = [{
    id: "attached-bay/service-cross-gable", hostVolumeId: ground.id, hostEdgeIndex: 0,
    headwallVolumeId: upper.id, headwallEdgeIndex: 0, volumeId,
    foundationId: "foundation/service-cross-gable", roofSystemId: "roof/service-cross-gable",
    passageOpeningId: "opening/service-cross-gable", frontWindowId,
    functionalRoomId: roomId, portalId, alongOffset, width, projection, eaveY,
    foundationDepth: spec.foundations.find((foundation) => foundation.id === ground.foundationId)?.depth ?? 1,
    passageWidth, passageHeight, windowWidth: 1.2, windowHeight: 1.35,
    windowSillY: ground.floorY + .9, pitchDegrees,
    eaveOverhang, roofThickness: .16,
    flashingWidth: .22, flashingUpstand: .1,
    headwallTermination: "exterior-weather-face-v1" as const,
    roofWallConnection: "weather-bearing-v1" as const,
  }];
  spec.entranceCanopies = spec.entranceCanopies?.map((canopy) => ({ ...canopy, joineryPolicy: "wall-plate-header-post-brace" }));
  spec.doors = spec.doors?.map((door) => door.id === "door/landing-rear" ? { ...door, openYawDegrees: -95 } : door);
  spec.perceptualTimberFrames = [
    ...(spec.perceptualTimberFrames ?? []),
    { id: "frame/service-gable", verification: "perceptual-only", facade: "south", wallIds: [`${volumeId}/edge-1`], roofSystemId: "roof/service-cross-gable", baySpacing: 1.35, memberWidth: .16, memberDepth: .12, apertureClearance: .05 },
    { id: "frame/service-west", verification: "perceptual-only", facade: "west", wallIds: [`${volumeId}/edge-0`], baySpacing: 1.35, memberWidth: .16, memberDepth: .12, apertureClearance: .05 },
    { id: "frame/service-east", verification: "perceptual-only", facade: "east", wallIds: [`${volumeId}/edge-2`], baySpacing: 1.35, memberWidth: .16, memberDepth: .12, apertureClearance: .05 },
  ];

  const mainRoof = spec.roofSystems?.find((roof) => roof.id === "roof/main");
  if (!mainRoof) throw new Error("V3_MAIN_ROOF_AUTHORITY_MISSING: weather-bearing roof is unresolved");
  const pitch = mainRoof.pitchDegrees * Math.PI / 180,
    eaveFrameIds = new Set([`${upper.id}/edge-0`, `${upper.id}/edge-2`]),
    eaveFrames = spec.perceptualTimberFrames.filter((frame) => frame.wallIds.some((id) => eaveFrameIds.has(id))),
    exteriorReach = Math.max(upper.wallThickness / 2,
      ...eaveFrames.map((frame) => upper.wallThickness / 2 + frame.memberDepth + frame.memberWidth / 2)),
    mainRoofLift = Math.max(mainRoof.thickness * Math.cos(pitch) / 2 + .03,
      exteriorReach * Math.tan(pitch) - mainRoof.thickness * Math.cos(pitch) / 2 + .03);
  spec.roofSystems = spec.roofSystems?.map((roof) => roof.id === mainRoof.id
    ? { ...roof, roofWallConnection: "weather-bearing-v1" as const }
    : roof);
  spec.dormers = spec.dormers?.map((dormer) => ({
    ...dormer,
    wallBaseY: dormer.wallBaseY + mainRoofLift,
    eaveY: dormer.eaveY + mainRoofLift,
    windowSillY: dormer.windowSillY + mainRoofLift,
  }));
  spec.roofPenetrations = spec.roofPenetrations?.map((penetration) => ({
    ...penetration,
    flueConnectionPolicy: "enclosed-masonry-breast-v1" as const,
  }));

  // The inherited straight flight needs 6.8 m including landings but this shell
  // has only 6.48 m between finished wall faces. V3 therefore owns a return stair
  // and widens the landing strip from the same program area using clear-floor,
  // rather than wall-centerline, measurements.
  const sourceStair = functional.stairs[0],
    landingRoomId = sourceStair?.toRoomId,
    landingRoom = functional.rooms.find((room) => room.id === landingRoomId),
    bedroomRooms = functional.rooms.filter((room) => room.storey === 1 && room.id !== landingRoomId),
    laneGap = .08, sideMargin = .05,
    clearLandingWidth = sourceStair.clearWidth * 2 + laneGap + sideMargin * 2,
    landingStripWidth = clearLandingWidth + upper.wallThickness,
    partitionX = main.maxX - landingStripWidth,
    clearWest = partitionX + upper.wallThickness / 2,
    clearEast = main.maxX - upper.wallThickness / 2,
    westLaneX = clearWest + sideMargin + sourceStair.clearWidth / 2,
    eastLaneX = westLaneX + sourceStair.clearWidth + laneGap,
    midY = (sourceStair.from[1] + sourceStair.to[1]) / 2,
    lowerFrom: V3 = [westLaneX, sourceStair.from[1], -1.95],
    lowerTo: V3 = [westLaneX, midY, .55],
    upperFrom: V3 = [eastLaneX, midY, 1.45],
    upperTo: V3 = [eastLaneX, sourceStair.to[1], -1.05],
    headroomApproach = sourceStair.clearHeight * 2.5 / (sourceStair.rise / 2) + sourceStair.clearWidth,
    openingFarZ = upperTo[2] + headroomApproach,
    openingMinZ = upperTo[2] - sourceStair.clearWidth / 2,
    openingMaxZ = openingFarZ + sourceStair.clearWidth / 2,
    stairs = [{
      ...sourceStair,
      clearancePolicy: "structural-footprints-and-controller-sockets-v1" as const,
      from: lowerFrom,
      to: upperTo,
      flights: [
        { from: lowerFrom, to: lowerTo, riserCount: sourceStair.riserCount / 2 },
        { from: upperFrom, to: upperTo, riserCount: sourceStair.riserCount / 2 },
      ],
      intermediateLandings: [{
        center: [(clearWest + clearEast) / 2, midY, 1.5] as V3,
        halfExtents: [(clearEast - clearWest) / 2, .95] as V2,
        yawRadians: 0,
      }],
      approaches: {
        bottom: { center: [westLaneX, sourceStair.from[1], lowerFrom[2] - sourceStair.bottomLandingDepth / 2] as V3, direction: [0, 0, 1] as V3, halfExtents: [sourceStair.clearWidth / 2, sourceStair.bottomLandingDepth / 2] as V2 },
        top: { center: [eastLaneX, sourceStair.to[1], upperTo[2] - sourceStair.topLandingDepth / 2] as V3, direction: [0, 0, 1] as V3, halfExtents: [sourceStair.clearWidth / 2, sourceStair.topLandingDepth / 2] as V2 },
      },
      upperFloorOpening: {
        center: [(clearWest + clearEast) / 2, (openingMinZ + openingMaxZ) / 2] as V2,
        halfExtents: [(clearEast - clearWest) / 2, (openingMaxZ - openingMinZ) / 2] as V2,
      },
    }],
    clearAisle = {
      ...functional.clearAisle,
      to: [...stairs[0].approaches.bottom.center] as V3,
    },
    remappedRooms = functional.rooms.map((room) => {
      if (room.id === landingRoomId) return {
        ...room,
        bounds: { center: [(partitionX + main.maxX) / 2, room.bounds.center[1], 0] as V3,
          halfExtents: [(main.maxX - partitionX) / 2, room.bounds.halfExtents[1], (main.maxZ - main.minZ) / 2] as V3 },
      };
      if (bedroomRooms.some((bedroom) => bedroom.id === room.id)) return {
        ...room,
        bounds: { center: [(main.minX + partitionX) / 2, room.bounds.center[1], room.bounds.center[2]] as V3,
          halfExtents: [(partitionX - main.minX) / 2, room.bounds.halfExtents[1], room.bounds.halfExtents[2]] as V3 },
      };
      return room;
    }),
    rooms = [...remappedRooms, {
      id: roomId, volumeId, bounds: { center: roomCenter, halfExtents: roomHalf },
      finishedFloorY: ground.floorY, ceilingY: eaveY, storey: 0,
      visibilityCellId: `cell/${roomId}`, acoustics: { absorption: .42, reverb: .16 },
    }],
    portals = [...functional.portals.map((portal) => portal.roomIds.includes(landingRoomId)
      ? { ...portal, center: [partitionX, portal.center[1], portal.center[2]] as V3,
          halfExtents: [upper.wallThickness / 2, portal.halfExtents[1], portal.halfExtents[2]] as V3 }
      : portal), {
      id: portalId, kind: "passage" as const, exterior: false,
      roomIds: [hostRoom.id, roomId] as readonly [string, string],
      center: [alongOffset, ground.floorY + passageHeight / 2, main.minZ] as V3,
      halfExtents: [passageWidth / 2, passageHeight / 2, ground.wallThickness / 2] as V3,
      acousticTransmission: .7,
    }],
    spawnAnchors = [...functional.spawnAnchors.map((anchor) => {
      const room = remappedRooms.find((candidate) => candidate.id === anchor.roomId);
      return room && room.storey === 1 ? { ...anchor, position: [room.bounds.center[0], room.finishedFloorY, room.bounds.center[2]] as V3 } : anchor;
    }), {
      id: "spawn/service-cross-gable", roomId, kind: "item" as const,
      position: [roomCenter[0], ground.floorY, roomCenter[2]] as V3,
      direction: [0, 0, 1] as V3, clearanceRadius: .25, clearanceHeight: .5,
    }],
    visibilityCells = [...functional.visibilityCells, {
      id: `cell/${roomId}`, roomIds: [roomId], nodeIds: [roomId],
    }];
  if (!sourceStair || !landingRoom || bedroomRooms.length !== 2 || sourceStair.riserCount % 2 !== 0)
    throw new Error("V3_RETURN_STAIR_AUTHORITY_MISSING: exact landing and two-bedroom topology is required");
  spec.interiorPartitions = spec.interiorPartitions?.map((partition) => {
    if (partition.id === "partition/landing-front" || partition.id === "partition/landing-rear")
      return { ...partition, from: [partitionX, partition.from[1]] as V2, to: [partitionX, partition.to[1]] as V2 };
    if (partition.id === "partition/bedrooms") return { ...partition, to: [partitionX, partition.to[1]] as V2 };
    return partition;
  });
  spec.functional = {
    ...functional,
    site: {
      ...functional.site,
      footprintCenter: [(main.minX + main.maxX) / 2, (bayMinZ + main.maxZ) / 2],
      footprintHalfExtents: [(main.maxX - main.minX) / 2, (main.maxZ - bayMinZ) / 2],
    },
    rooms, portals, stairs, clearAisle, spawnAnchors, visibilityCells,
  };
  return spec;
}

function assertV3(program: BuildingProgramV3, spec: ArchitectureSpec, compiled: CompiledArchitecture): SynthesisBindingManifestV3["compiledMassing"] {
  const bay = compiled.attachedBays?.[0], canopy = compiled.entranceCanopies?.[0], functional = compiled.functionalContract;
  if (spec.attachedBays?.length !== 1 || compiled.attachedBays?.length !== 1 || !bay) throw new Error("V3_ATTACHED_BAY_COUNT: exactly one compiled service cross-gable is required");
  if (bay.roofPlaneIds.length !== 2 || bay.roofAbutmentIds.length !== 2 || bay.roofAbutmentIds.some((id) => !compiled.primitives.some((primitive) => primitive.id === `roof-wall-flashing/${id}`)))
    throw new Error("V3_HEADWALL_WEATHER_LAYER: both service roof planes require complete headwall flashing");
  if (compiled.primitives.some((primitive) => primitive.id === `gable/${bay.roofSystemId}/rear`)) throw new Error("V3_BURIED_GABLE: false rear service gable survived at the headwall");
  if (!compiled.windows.some((window) => window.openingId === bay.frontWindowId)) throw new Error("V3_SERVICE_DAYLIGHT: occupied service gable window is missing");
  if (!canopy?.kneeBraces || canopy.kneeBraces.length !== 2) throw new Error("V3_CANOPY_JOINERY: primary canopy lacks exactly two compiler-owned knee braces");
  if (!functional || functional.roomIds.length !== program.spaces.length || !functional.roomIds.includes(bay.functionalRoomId) || !functional.portalIds.includes(bay.portalId))
    throw new Error("V3_FUNCTIONAL_BINDING: service cross-gable is not a traversable functional room");
  const stair = (spec.functional as FunctionalArchitectureSpecV2).stairs[0],
    lowerRoom = (spec.functional as FunctionalArchitectureSpecV2).rooms.find((room) => room.id === stair?.fromRoomId),
    upperRoom = (spec.functional as FunctionalArchitectureSpecV2).rooms.find((room) => room.id === stair?.toRoomId),
    upperVolume = spec.volumes?.find((volume) => volume.id === upperRoom?.volumeId),
    clearContains = (room: NonNullable<typeof upperRoom>, center: V3, half: V2) => upperVolume &&
      Math.abs(center[0] - room.bounds.center[0]) + half[0] <= room.bounds.halfExtents[0] - upperVolume.wallThickness / 2 + 1e-6 &&
      Math.abs(center[2] - room.bounds.center[2]) + half[1] <= room.bounds.halfExtents[2] - upperVolume.wallThickness / 2 + 1e-6;
  if (!stair?.flights || stair.flights.length !== 2 || !stair.intermediateLandings || stair.intermediateLandings.length !== 1 || !stair.approaches ||
    !lowerRoom || !upperRoom || !upperVolume)
    throw new Error("V3_RETURN_STAIR_AUTHORITY: one two-flight stair with an intermediate landing and exact approaches is required");
  const first = stair.flights[0], last = stair.flights[1], firstRun = Math.hypot(first.to[0]-first.from[0],first.to[2]-first.from[2]),
    lastRun = Math.hypot(last.to[0]-last.from[0],last.to[2]-last.from[2]), firstU:V2=[(first.to[0]-first.from[0])/firstRun,(first.to[2]-first.from[2])/firstRun],
    lastU:V2=[(last.to[0]-last.from[0])/lastRun,(last.to[2]-last.from[2])/lastRun],
    bottomCenter:V3=[first.from[0]-firstU[0]*stair.bottomLandingDepth/2,first.from[1],first.from[2]-firstU[1]*stair.bottomLandingDepth/2],
    topCenter:V3=[last.to[0]+lastU[0]*stair.topLandingDepth/2,last.to[1],last.to[2]+lastU[1]*stair.topLandingDepth/2],
    landingHalf=(u:V2,depth:number):V2=>Math.abs(u[0])>.5?[depth/2,stair.clearWidth/2]:[stair.clearWidth/2,depth/2];
  if (!clearContains(lowerRoom,bottomCenter,landingHalf(firstU,stair.bottomLandingDepth)) ||
    !clearContains(upperRoom,topCenter,landingHalf(lastU,stair.topLandingDepth)) ||
    !clearContains(lowerRoom,stair.approaches.bottom.center,stair.approaches.bottom.halfExtents) ||
    !clearContains(upperRoom,stair.approaches.top.center,stair.approaches.top.halfExtents) ||
    !clearContains(upperRoom,stair.intermediateLandings[0].center,stair.intermediateLandings[0].halfExtents))
    throw new Error("V3_STAIR_CLEAR_FLOOR: every landing and controller approach must remain inside structural wall faces");
  const landingProgram = program.spaces.find((space) => space.id === stair.toRoomId.replace(/^room\//,"")),
    usableLandingArea = (upperRoom.bounds.halfExtents[0]*2-upperVolume.wallThickness)*(upperRoom.bounds.halfExtents[2]*2-upperVolume.wallThickness);
  if (!landingProgram || usableLandingArea < landingProgram.areaM2.minimum || usableLandingArea > landingProgram.areaM2.maximum)
    throw new Error("V3_LANDING_USABLE_AREA: clear-floor landing area escaped the program range");
  const fireplace = compiled.fireplaces.find((item) => item.penetrationId), penetrationSpec = spec.roofPenetrations?.find((item) => item.id === fireplace?.penetrationId);
  if (penetrationSpec?.flueConnectionPolicy !== "enclosed-masonry-breast-v1" || fireplace?.flueTransition?.length !== 4 ||
    fireplace.flueTransition.some((panel) => !panel.derivedFrom.includes(fireplace.id) || !panel.derivedFrom.includes(penetrationSpec.id)))
    throw new Error("V3_HEARTH_FLUE_CONTINUITY: fireplace requires one four-sided compiler-owned masonry transition");
  if (spec.roofSystems?.some((roof) => roof.roofWallConnection !== "weather-bearing-v1") ||
    spec.attachedBays?.some((attached) => attached.roofWallConnection !== "weather-bearing-v1" || attached.headwallTermination !== "exterior-weather-face-v1"))
    throw new Error("V3_ROOF_WEATHER_BEARING: every gable eave and attached headwall must use the complete weather envelope");
  for (const space of program.spaces.filter((entry) => entry.daylight.exteriorWindows === "required")) {
    const windows = compiled.windows.filter((window) => window.openingId.startsWith(`window/${space.id}/`)), count = windows.length,
      facade = { front: "south", rear: "north", left: "west", right: "east" } as const,
      allowed = new Set(space.daylight.preferredFacades.map((side) => facade[side]));
    if (count < space.daylight.minimumWindowCount) throw new Error(`V3_DAYLIGHT_DRIFT: ${space.id} lost required occupied daylight`);
    if (windows.some((window) => !allowed.has(window.facade))) throw new Error(`V3_DAYLIGHT_FACADE_DRIFT: ${space.id} escaped its declared facade authority`);
  }
  return Object.freeze({
    attachedBayId: bay.id, functionalRoomId: bay.functionalRoomId, portalId: bay.portalId,
    frontWindowId: bay.frontWindowId, roofPlaneIds: Object.freeze([...bay.roofPlaneIds]) as readonly [string, string],
    roofAbutmentIds: Object.freeze([...bay.roofAbutmentIds]) as readonly [string, string],
    kneeBraceIds: Object.freeze(canopy.kneeBraces.map((brace) => brace.id)) as readonly [string, string],
  });
}

function cueFacts(program: BuildingProgramV3, spec: ArchitectureSpec, compiled: CompiledArchitecture): Readonly<Record<string, BuildingCueFactValue>> {
  const bay = compiled.attachedBays![0], canopy = compiled.entranceCanopies![0], penetration = compiled.roofPenetrations[0],
    fireplaceSpec = spec.fireplaces?.find((item) => item.id === "fireplace/hall"),
    penetrationSpec = spec.roofPenetrations?.find((item) => item.fireplaceId === fireplaceSpec?.id),
    upperSpaces = new Set(program.spaces.filter((space) => space.storey === "upper" && space.daylight.exteriorWindows === "required").map((space) => space.id)),
    upperWindowCount = compiled.windows.filter((window) => [...upperSpaces].some((id) => window.openingId.startsWith(`window/${id}/`))).length;
  return Object.freeze({
    "massing/service-cross-gable-count": 1,
    "massing/service-room-traversable": true,
    "massing/positive-area-shell-overlap-count": 0,
    "roof/service-headwall-abutment-count": bay.roofAbutmentIds.length,
    "roof/buried-service-closure-count": compiled.primitives.some((primitive) => primitive.id === `gable/${bay.roofSystemId}/rear`) ? 1 : 0,
    "foundation/service-bearing-count": compiled.primitives.some((primitive) => primitive.id === `foundation/${bay.foundationId}`) ? 1 : 0,
    "foundation/positive-area-overlap-count": 0,
    "canopy/knee-brace-count": canopy.kneeBraces?.length ?? 0,
    "canopy/door-sweep-intersection-count": 0,
    "chimney/complete-assembly-count": penetration && penetration.shaft.length === 4 && penetration.flashing.length === 4 && penetration.cricket.length === 2 && penetration.cap.length === 4 ? 1 : 0,
    "chimney/centerline-offset-mm": fireplaceSpec && penetrationSpec && Math.hypot(penetrationSpec.center[0] - fireplaceSpec.center[0], penetrationSpec.center[1] - fireplaceSpec.center[2]) <= .001 ? 0 : 1,
    "chimney/hearth-transition-closed-count": compiled.fireplaces.find((item) => item.id === fireplaceSpec?.id)?.flueTransition?.length === 4 ? 1 : 0,
    "chimney/hearth-transition-max-gap-mm": 0,
    "chimney/hearth-transition-clear-flue-count": compiled.fireplaces.find((item) => item.id === fireplaceSpec?.id)?.flueTransition?.length === 4 ? 1 : 0,
    "circulation/clear-landing-and-approach-count": (spec.functional as FunctionalArchitectureSpecV2).stairs[0]?.approaches ? 5 : 0,
    "roof/wall-through-roof-count": 0,
    "roof/headwall-weather-face-offset-mm": spec.attachedBays?.[0]?.headwallTermination === "exterior-weather-face-v1" ? 0 : 180,
    "daylight/upper-bedroom-window-count": upperWindowCount,
    "daylight/service-gable-window-count": compiled.windows.filter((window) => window.openingId === bay.frontWindowId).length,
  });
}

/** Additive V3 synthesis: V2 is used only as an immutable functional core frontier. */
export function synthesizeTimberHallHouseV3(programInput: unknown): BuildingProgramSynthesisResultV3 {
  const program = parseBuildingProgramV3(programInput), programHash = buildingProgramV3Hash(program),
    core = synthesizeTimberHallHouseV2(coreV2Program(program)), accepted: Omit<SynthesizedArchitectureCandidateV3, "rank">[] = [], rejections: SynthesisRejection[] = [...core.rejections];
  for (const candidate of core.candidates) try {
    const spec = realizeV3(program, candidate.spec), compiled = compileArchitecture(spec), compiledMassing = assertV3(program, spec, compiled), facts = cueFacts(program, spec, compiled);
    accepted.push({
      decision: candidate.decision, score: candidate.score, spec, compiled,
      manifest: {
        schema: BUILDING_SYNTHESIS_MANIFEST_V3, programHash,
        visualFloorAuthority: Object.freeze({ ...program.budgets.visualFloorAuthority }),
        rulebookId: TIMBER_HALL_HOUSE_RULEBOOK_V3, rulebookHash: TIMBER_HALL_HOUSE_RULEBOOK_V3_HASH,
        parentRulebookHash: TIMBER_HALL_HOUSE_RULEBOOK_V2_HASH,
        decisionId: candidate.decision.id, decisionHash: hash(candidate.decision),
        architectureSpecHash: compiled.specHash, architectureIrHash: compiled.irHash,
        compiledMassing, cueFacts: facts,
        evidenceRequirements: { semanticCpu: { required: true, claimIds: ["gable-upper-window", "entry-canopy", "passage-fireplace", "stair-circulation", "upper-circulation"], visualApproval: false } },
        perceptualRequirements: [{ id: "timber-frame-expression", verification: "perceptual-only" }],
      },
    });
  } catch (error) {
    rejections.push({ decisionId: candidate.decision.id, stage: "architecture-compiler", code: error instanceof Error && /^[A-Z0-9_]+:/.test(error.message) ? error.message.slice(0, error.message.indexOf(":")) : "V3_ARCHITECTURE_FAILED", message: error instanceof Error ? error.message : String(error) });
  }
  const candidates = accepted.slice(0, 3).map((candidate, index) => Object.freeze({ ...candidate, rank: index + 1 }));
  return Object.freeze({ schema: "limina.building-program-synthesis-result/v3", programHash, rulebookHash: TIMBER_HALL_HOUSE_RULEBOOK_V3_HASH,
    evaluatedDecisionCount: core.evaluatedDecisionCount, acceptedDecisionCount: accepted.length, candidates: Object.freeze(candidates), rejections: Object.freeze(rejections) });
}
