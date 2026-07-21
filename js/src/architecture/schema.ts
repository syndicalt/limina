export const ARCHITECTURE_SPEC = "limina.architecture-spec/v1" as const;
export const ARCHITECTURE_COMPILE = "limina.architecture-compile/v1" as const;
export type V2 = readonly [number, number];
export type V3 = readonly [number, number, number];

export interface FoundationSpec {
  id: string;
  center: V2;
  halfExtents: V2;
  topY: number;
  depth: number;
}
export interface WallOpeningSpec {
  id: string;
  kind: "door" | "window" | "passage";
  offset: number;
  width: number;
  sillY: number;
  height: number;
}
export interface WallRunSpec {
  id: string;
  from: V2;
  to: V2;
  bottomY: number;
  topY: number;
  thickness: number;
  openings?: readonly WallOpeningSpec[];
}
/**
 * A single compiler-owned wall separating two functional rooms inside one
 * structural shell. Room subdivision must not be modeled as coincident volume
 * envelopes: that produces duplicate walls, floors, and ceilings.
 */
export interface InteriorPartitionSpec extends WallRunSpec {
  roomIds: readonly [string, string];
}
export interface VolumeOpeningSpec extends WallOpeningSpec {
  edgeIndex: number;
}
export interface BuildingVolumeSpec {
  id: string;
  footprint: readonly V2[];
  floorY: number;
  eaveY: number;
  wallThickness: number;
  floorThickness: number;
  ceilingThickness: number;
  foundationId: string;
  /** Additive upper-storey bearing authority; omitted volumes retain foundation bearing. */
  supportVolumeId?: string;
  /**
   * Additive partition-bearing authority for an upper rectangular volume spanning multiple
   * adjacent rectangular volumes below. Mutually exclusive with supportVolumeId. The compiler
   * proves exact footprint coverage by the declared support union.
   */
  supportVolumeIds?: readonly string[];
  openings?: readonly VolumeOpeningSpec[];
}
/**
 * Compiler-owned, habitable cross-gable projection. The authored ids are
 * deliberately explicit so program synthesis and functional evidence can bind
 * the derived structure without reproducing any geometry calculations.
 *
 * The compiler derives a rectangular volume and foundation outside exactly one
 * host edge, suppresses the coincident rear wall, cuts one reciprocal passage
 * in the host wall, emits one front window, and terminates both cross-gable
 * planes against the declared upper headwall with continuous flashing.
 */
export interface AttachedBaySpec {
  id: string;
  hostVolumeId: string;
  hostEdgeIndex: number;
  headwallVolumeId: string;
  headwallEdgeIndex: number;
  volumeId: string;
  foundationId: string;
  roofSystemId: string;
  passageOpeningId: string;
  frontWindowId: string;
  functionalRoomId: string;
  portalId: string;
  alongOffset: number;
  width: number;
  projection: number;
  eaveY: number;
  foundationDepth: number;
  passageWidth: number;
  passageHeight: number;
  windowWidth: number;
  windowHeight: number;
  windowSillY: number;
  pitchDegrees: number;
  eaveOverhang: number;
  roofThickness: number;
  flashingWidth: number;
  flashingUpstand: number;
  /** Additive weather-face termination; omission preserves the legacy centerline junction. */
  headwallTermination?: "exterior-weather-face-v1";
  /** Additive eave cover/bearing authority; omission preserves the legacy roof datum. */
  roofWallConnection?: "weather-bearing-v1";
}
export interface EntranceSpec {
  id: string;
  wallId: string;
  openingId: string;
  exteriorSide: -1 | 1;
  exteriorGradeY: number;
  landingDepth: number;
  stepCount: number;
  treadDepth: number;
  width: number;
  /** Opts into final-walking-surface stair semantics and site-grade support authority. */
  constructionPolicy?: "finished-surface-authority";
  bearingDepth?: number;
}
/**
 * Compiler-owned weather protection bound to an existing entrance. Geometry is
 * derived from the entrance wall/opening so the canopy cannot drift away from
 * the threshold or establish a second doorway authority.
 */
export interface EntranceCanopySpec {
  id: string;
  entranceId: string;
  width: number;
  projection: number;
  wallPlateY: number;
  pitchDegrees: number;
  roofThickness: number;
  postSize: number;
  footingDepth: number;
  lateralClearance: number;
  flashingWidth: number;
  flashingThickness: number;
  counterflashingUpstand: number;
  /** Additive compiler-owned header/post joinery; omission preserves v1/v2 output. */
  joineryPolicy?: "wall-plate-header-post-brace";
}
export interface DoorAssemblySpec {
  id: string;
  wallId: string;
  openingId: string;
  hingeSide: "start" | "end";
  leafThickness: number;
  openYawDegrees: number;
}
export interface RoofPlaneSpec {
  id: string;
  origin: V3;
  normal: V3;
  boundary: readonly V3[];
  thickness: number;
}
export interface RoofSeamSpec {
  id: string;
  kind: "ridge" | "valley" | "eave" | "rake" | "abutment";
  planeIds: readonly [string, string];
  from: V3;
  to: V3;
  flashingWidth?: number;
}
export interface GableRoofSystemSpec {
  id: string;
  kind: "gable";
  volumeId: string;
  ridgeAxis: "x" | "z";
  pitchDegrees: number;
  eaveOverhang: number;
  ridgeEndOverhang: readonly [number, number];
  /** Additive inward trim at the two ridge-axis ends. */
  ridgeEndInset?: readonly [number, number];
  thickness: number;
  /** Additive eave cover/bearing authority; omission preserves the legacy roof datum. */
  roofWallConnection?: "weather-bearing-v1";
}
export interface RoofJunctionSpec {
  id: string;
  kind: "valley" | "abutment";
  systemIds: readonly [string, string];
  trimSystemId: string;
  flashingWidth: number;
  endInset?: readonly [number, number];
}
/** A compiler-validated sloped flashing where one roof terminates at a taller wall. */
export interface RoofWallAbutmentSpec {
  id: string;
  roofPlaneId: string;
  wallId: string;
  from: V3;
  to: V3;
  flashingWidth: number;
  upstandDepth: number;
}
export interface DormerSpec {
  id: string;
  hostPlaneId: string;
  alongCenter: number;
  width: number;
  downslopeRange: readonly [number, number];
  wallBaseY: number;
  eaveY: number;
  roofPitchDegrees: number;
  roofThickness: number;
  wallThickness: number;
  eaveOverhang: number;
  rakeOverhang: number;
  curbHeight: number;
  flashingWidth: number;
  flashingThickness: number;
  windowId: string;
  windowWidth: number;
  windowHeight: number;
  windowSillY: number;
  /**
   * Opt-in construction policy for dormers whose two roof planes must terminate
   * on the host roof instead of at a rectangular, free-standing rear edge.
   * Omitted specs retain the v1 compiler geometry for replay compatibility.
   */
  hostConnection?: "intersecting-gable";
  /** Seats the roof soffit on the dormer walls using the declared pitch and overhang. */
  roofWallConnection?: "soffit-bearing";
}
export interface FireplaceSpec {
  id: string;
  center: V3;
  apertureHalfExtents: V3;
  chimneyTopY: number;
  roofPlaneId: string;
  lightId?: string;
  /** Lowest structural bearing elevation for the hearth base. */
  supportY?: number;
  /** Opt-in corrected thin soot lining; omission preserves historical compiler replay. */
  fireboxPolicy?: "rear-soot-lining";
}
export interface PracticalLightSpec {
  id: string;
  position: V3;
  color: V3;
  intensityCandela: number;
  range: number;
}
export interface FurnishingSpec {
  id: string;
  kind:
    | "table"
    | "bench"
    | "hearth-settle"
    | "cupboard"
    | "shelf"
    | "settle"
    | "stool"
    | "chest"
    | "log-rack";
  center: V3;
  yawRadians?: number;
}
export type InteriorStructureSpec = Readonly<
  | {
      id: string;
      kind: "wall-plate" | "tie-beam" | "mantel";
      center: V3;
      halfExtents: V3;
      yawRadians?: number;
      /** Required with fireplace-clearance; omitted for v1 replay. */
      fireplaceId?: string;
      placementPolicy?: "fireplace-clearance";
    }
  | {
      id: string;
      kind: "knee-brace";
      from: V3;
      to: V3;
      width: number;
      depth: number;
    }
>;
export type Facade = "north" | "south" | "east" | "west";
/**
 * A visual construction-expression policy, never a load-path claim. Exact
 * members are derived by the compiler from the referenced exterior walls,
 * openings, and optional gable roof system so authored frame coordinates
 * cannot become a second geometry authority.
 */
export interface PerceptualTimberFrameSpec {
  id: string;
  verification: "perceptual-only";
  facade: Facade;
  wallIds: readonly string[];
  /** Required only on a gable-end facade. */
  roofSystemId?: string;
  baySpacing: number;
  memberWidth: number;
  memberDepth: number;
  apertureClearance: number;
}
export interface DomesticPropSpec {
  id: string;
  kind:
    "bowl" | "mug" | "jug" | "candle" | "folded-textile" | "fire-tool" | "log";
  center: V3;
  yawRadians?: number;
  supportY: number;
  supportStructureId?: string;
}
export interface RoofPenetrationSpec {
  id: string;
  fireplaceId: string;
  roofPlaneId: string;
  center: V2;
  shaftSize: V2;
  shaftBottomY: number;
  topY: number;
  clearance: number;
  minimumRoofProjection: number;
  curbWidth: number;
  curbHeight: number;
  flashingWidth: number;
  apronDepth: number;
  backpanDepth: number;
  flashingThickness: number;
  capOverhang: number;
  capThickness: number;
  cricketDepth: number;
  cricketRise: number;
  /** Opt-in proof that the complete flue remains centered on its fireplace. */
  alignmentPolicy?: "fireplace-centerline";
  /** Additive hollow masonry connection from the hearth hood to the shaft. */
  flueConnectionPolicy?: "enclosed-masonry-breast-v1";
}
export interface FunctionalArchitectureSpec {
  buildingId: string;
  roomId: string;
  portalId: string;
  entryAnchor: V3;
  site: {
    footprintCenter: V2;
    footprintHalfExtents: V2;
    finishedFloorY: number;
    terrainClearance: number;
    vegetationClearance: number;
    maximumTerrainRelief: number;
    entranceSupport?: {
      sourcePrimitiveId?: string;
      center: V2;
      halfExtents: V2;
      yawRadians: number;
      exteriorGradeY: number;
      bearingDepth: number;
      maximumCutDepth: number;
      maximumVariation: number;
    };
  };
  clearAisle: { from: V3; to: V3; halfWidth: number; minClearHeight: number };
  lod: {
    identity: string;
    triangleBudget: number;
    drawBudget: number;
    lod1TriangleBudget: number;
    lod2TriangleBudget: number;
  };
}
export interface FunctionalRoomSpec {
  id: string;
  /** Authored structural volume that exactly bounds this room; compiler-only mapping. */
  volumeId: string;
  bounds: { center: V3; halfExtents: V3 };
  finishedFloorY: number;
  ceilingY: number;
  storey: number;
  visibilityCellId: string;
  acoustics: { absorption: number; reverb: number };
}
export interface FunctionalPortalSpec {
  id: string;
  kind: "door" | "passage";
  exterior: boolean;
  /** A null endpoint denotes the exterior. Exactly one endpoint may be null. */
  roomIds: readonly [string | null, string | null];
  center: V3;
  halfExtents: V3;
  acousticTransmission: number;
  doorId?: string;
}
export interface FunctionalStairSpec {
  id: string;
  fromRoomId: string;
  toRoomId: string;
  from: V3;
  to: V3;
  clearWidth: number;
  clearHeight: number;
  rise: number;
  run: number;
  riserCount: number;
  treadDepth: number;
  bottomLandingDepth: number;
  topLandingDepth: number;
  /** Additive structural-wall and controller-socket clearance validation. */
  clearancePolicy?: "structural-footprints-and-controller-sockets-v1";
  /**
   * Additive multi-flight construction authority. Omission preserves the
   * original single straight flight between `from` and `to`.
   */
  flights?: readonly {
    from: V3;
    to: V3;
    riserCount: number;
  }[];
  intermediateLandings?: readonly {
    center: V3;
    halfExtents: V2;
    yawRadians: number;
  }[];
  /** Explicit clear-floor controller sockets outside the constructed landings. */
  approaches?: {
    bottom: { center: V3; direction: V3; halfExtents: V2 };
    top: { center: V3; direction: V3; halfExtents: V2 };
  };
  /** Compiler-owned void through the destination floor; retained in v2 traversal authority. */
  upperFloorOpening: { center: V2; halfExtents: V2 };
}
export interface FunctionalSpawnAnchorSpec {
  id: string;
  roomId: string;
  kind: "player" | "npc" | "item";
  position: V3;
  direction: V3;
  clearanceRadius: number;
  clearanceHeight: number;
}
export interface FunctionalVisibilityCellSpec {
  id: string;
  roomIds: readonly string[];
  nodeIds: readonly string[];
}
export type CompiledFunctionalRoom = Omit<FunctionalRoomSpec, "volumeId">;
/**
 * Additive FB-4 authoring authority. The discriminant deliberately lives only
 * on v2 so existing v1 specs and their canonical hashes remain unchanged.
 */
export interface FunctionalArchitectureSpecV2 {
  schema: "limina.functional-architecture/v2";
  /**
   * Additive authority for multiple rectangular rooms inside a shared storey
   * shell. Omitted retains the original one-room-per-volume replay contract.
   */
  layoutAuthority?: "partitioned-shell";
  buildingId: string;
  entryAnchor: V3;
  site: FunctionalArchitectureSpec["site"];
  clearAisle: FunctionalArchitectureSpec["clearAisle"];
  lod: FunctionalArchitectureSpec["lod"];
  rooms: readonly FunctionalRoomSpec[];
  portals: readonly FunctionalPortalSpec[];
  stairs: readonly FunctionalStairSpec[];
  spawnAnchors: readonly FunctionalSpawnAnchorSpec[];
  visibilityCells: readonly FunctionalVisibilityCellSpec[];
}
export type ReviewStageId =
  | "massing"
  | "envelope"
  | "construction-expression"
  | "roof-junctions"
  | "openings-circulation"
  | "interior-fireplace"
  | "materials-uv"
  | "lod-final";
export interface ArchitectureSpec {
  schema: typeof ARCHITECTURE_SPEC;
  id: string;
  foundations: readonly FoundationSpec[];
  volumes?: readonly BuildingVolumeSpec[];
  attachedBays?: readonly AttachedBaySpec[];
  walls?: readonly WallRunSpec[];
  /** Interior walls are additive to volume-derived exterior shell walls. */
  interiorPartitions?: readonly InteriorPartitionSpec[];
  entrances: readonly EntranceSpec[];
  entranceCanopies?: readonly EntranceCanopySpec[];
  doors?: readonly DoorAssemblySpec[];
  roofSystems?: readonly GableRoofSystemSpec[];
  roofJunctions?: readonly RoofJunctionSpec[];
  roofWallAbutments?: readonly RoofWallAbutmentSpec[];
  dormers?: readonly DormerSpec[];
  roofPenetrations?: readonly RoofPenetrationSpec[];
  roofPlanes?: readonly RoofPlaneSpec[];
  roofSeams?: readonly RoofSeamSpec[];
  fireplaces?: readonly FireplaceSpec[];
  practicalLights?: readonly PracticalLightSpec[];
  furnishings?: readonly FurnishingSpec[];
  interiorStructure?: readonly InteriorStructureSpec[];
  perceptualTimberFrames?: readonly PerceptualTimberFrameSpec[];
  domesticProps?: readonly DomesticPropSpec[];
  functional?: FunctionalArchitectureSpec | FunctionalArchitectureSpecV2;
}

export type Diagnostic = Readonly<{
  code: string;
  severity: "error" | "warning";
  owners: readonly string[];
  message: string;
  location?: V3;
}>;
export type SurfaceUvFrame = Readonly<{
  anchor: V3;
  ridge: V3;
  slope: V3;
  metresPerRepeat: number;
}>;
export type LodLevel = 0 | 1 | 2;
export type SolidBox = Readonly<{
  kind: "box";
  id: string;
  center: V3;
  halfExtents: V3;
  yawRadians?: number;
  doorPlaneAngleRadians?: number;
  materialRole?: string;
  lodLevels?: readonly LodLevel[];
  uvFrame?: SurfaceUvFrame;
  derivedFrom: readonly string[];
}>;
export type PlaneSlab = Readonly<{
  kind: "plane-slab";
  id: string;
  surfaceRole: "roof" | "wall";
  origin: V3;
  normal: V3;
  boundary: readonly V3[];
  thickness: number;
  materialRole?: string;
  lodLevels?: readonly LodLevel[];
  uvFrame?: SurfaceUvFrame;
  derivedFrom: readonly string[];
}>;
export type PolygonSlab = Readonly<{
  kind: "polygon-slab";
  id: string;
  boundary: readonly V2[];
  bottomY: number;
  topY: number;
  materialRole?: string;
  lodLevels?: readonly LodLevel[];
  uvFrame?: SurfaceUvFrame;
  derivedFrom: readonly string[];
}>;
export type LinearMember = Readonly<{
  kind: "linear-member";
  id: string;
  from: V3;
  to: V3;
  width: number;
  depth: number;
  materialRole?: string;
  lodLevels?: readonly LodLevel[];
  uvFrame?: SurfaceUvFrame;
  derivedFrom: readonly string[];
}>;
export type OrientedCylinder = Readonly<{
  kind: "oriented-cylinder";
  id: string;
  from: V3;
  to: V3;
  radius: number;
  vertices: number;
  materialRole?: string;
  lodLevels?: readonly LodLevel[];
  derivedFrom: readonly string[];
}>;
export type TaperedFlame = Readonly<{
  kind: "tapered-flame";
  id: string;
  baseCenter: V3;
  height: number;
  baseRadius: number;
  tipOffset: V3;
  vertices: number;
  materialRole?: string;
  lodLevels?: readonly LodLevel[];
  derivedFrom: readonly string[];
}>;
export type LathedProfile = Readonly<{
  kind: "lathed-profile";
  id: string;
  center: V3;
  profile: readonly V2[];
  vertices: number;
  materialRole?: string;
  lodLevels?: readonly LodLevel[];
  derivedFrom: readonly string[];
}>;
export type ArchitecturePrimitive =
  | SolidBox
  | PlaneSlab
  | PolygonSlab
  | LinearMember
  | OrientedCylinder
  | TaperedFlame
  | LathedProfile;
export interface CompiledVolume {
  id: string;
  wallIds: readonly string[];
  floor: PolygonSlab;
  /** Render/collision floor authority when compiler-owned voids replace the full slab. */
  floorFragments?: readonly PolygonSlab[];
  ceiling: PolygonSlab;
  /** Render ceiling authority when a vertical link opens the supporting storey. */
  ceilingFragments?: readonly PolygonSlab[];
}
export interface CompiledWall {
  id: string;
  openingIds: readonly string[];
  segments: readonly SolidBox[];
}
export interface CompiledEntrance {
  id: string;
  openingId: string;
  threshold: SolidBox;
  landing: SolidBox;
  steps: readonly SolidBox[];
  finishCourses: readonly SolidBox[];
  finishedFloorY: number;
  exteriorGradeY: number;
}
export interface CompiledEntranceCanopy {
  id: string;
  entranceId: string;
  roof: PlaneSlab;
  wallPlate: LinearMember;
  header: LinearMember;
  flashing: LinearMember;
  counterflashing: LinearMember;
  posts: readonly SolidBox[];
  footings: readonly SolidBox[];
  kneeBraces?: readonly [LinearMember, LinearMember];
  coveredThresholdId: string;
}
export interface CompiledAttachedBay {
  id: string;
  hostVolumeId: string;
  headwallVolumeId: string;
  volumeId: string;
  foundationId: string;
  roofSystemId: string;
  sharedBoundary: readonly [V2, V2];
  passageOpeningId: string;
  frontWindowId: string;
  functionalRoomId: string;
  portalId: string;
  passageThreshold: SolidBox;
  functionalFloorColliderIds: readonly [string, string, string];
  roofPlaneIds: readonly [string, string];
  roofAbutmentIds: readonly [string, string];
}
export interface CompiledDoor {
  id: string;
  wallId?: string;
  openingId: string;
  facade?: Facade;
  apertureCenter?: V3;
  apertureHalfExtents?: V3;
  leaf: SolidBox;
  hinge: V3;
  localCenter: V3;
  closedYaw: number;
  openYaw: number;
  runtimeClosedYaw?: number;
  runtimeOpenYaw?: number;
  frame: readonly SolidBox[];
  reveals: readonly SolidBox[];
  planks: readonly SolidBox[];
  ironwork: readonly SolidBox[];
}
export interface CompiledWindow {
  id: string;
  wallId: string;
  openingId: string;
  facade: Facade;
  apertureCenter: V3;
  apertureHalfExtents: V3;
  glazing: SolidBox;
  reveals: readonly SolidBox[];
  frame: readonly SolidBox[];
  mullions: readonly SolidBox[];
  came: readonly LinearMember[];
}
export interface CompiledDormer {
  id: string;
  hostPlaneId: string;
  cutBoundary: readonly V3[];
  wallIds: readonly string[];
  roofPlaneIds: readonly string[];
  ridgeId: string;
  windowId: string;
  hostConnection?: "intersecting-gable";
  roofWallConnection?: "soffit-bearing";
  valleyIds?: readonly [string, string];
}
export interface CompiledRoofSeam extends RoofSeamSpec {
  supported: true;
}
export interface CompiledFireplace {
  id: string;
  base: SolidBox;
  cavity: SolidBox;
  surround: readonly ArchitecturePrimitive[];
  fuel: readonly OrientedCylinder[];
  emberBed: SolidBox;
  flames: readonly TaperedFlame[];
  lightPosition: V3;
  flueTransition?: readonly PlaneSlab[];
  chimney?: SolidBox;
  penetrationId?: string;
}
export interface CompiledPracticalLight {
  id: string;
  position: V3;
  color: V3;
  intensityCandela: number;
  range: number;
}
export interface CompiledFurnishing {
  id: string;
  kind: FurnishingSpec["kind"];
  parts: readonly ArchitecturePrimitive[];
}
export interface CompiledInteriorStructure {
  id: string;
  kind: InteriorStructureSpec["kind"];
  parts: readonly ArchitecturePrimitive[];
}
export interface CompiledPerceptualTimberFrame {
  id: string;
  verification: "perceptual-only";
  facade: Facade;
  wallIds: readonly string[];
  roofSystemId?: string;
  parts: readonly LinearMember[];
}
export interface CompiledDomesticProp {
  id: string;
  kind: DomesticPropSpec["kind"];
  parts: readonly ArchitecturePrimitive[];
  supportY: number;
}
export interface CompiledRoofPenetration {
  id: string;
  fireplaceId: string;
  roofPlaneId: string;
  cutBoundary: readonly V3[];
  shaft: readonly SolidBox[];
  curb: readonly LinearMember[];
  flashing: readonly LinearMember[];
  counterflashing: readonly LinearMember[];
  cricket: readonly PlaneSlab[];
  cap: readonly SolidBox[];
  flueLiner: readonly SolidBox[];
}
export interface ArchitectureReviewStage {
  id: ReviewStageId;
  prerequisiteHash?: string;
  requiredOwners: readonly string[];
  checks: readonly string[];
  cameraIds: readonly string[];
}
export interface ArchitectureReviewManifest {
  schema: "limina.architecture-review/v1";
  specHash: string;
  irHash: string;
  stages: readonly ArchitectureReviewStage[];
}
export interface CompiledFunctionalContract {
  schema: "limina.functional-building/v1";
  units: "meter";
  up: "Y";
  buildingId: string;
  rootNodeId: "building/root";
  roomIds: readonly string[];
  portalIds: readonly string[];
  entryAnchor: V3;
  site: FunctionalArchitectureSpec["site"];
  colliders: readonly { id: string; center: V3; halfExtents: V3; rotation?: readonly [number, number, number, number] }[];
  doors: readonly {
    id: string;
    roomId: string;
    portalId: string;
    hinge: V3;
    center: V3;
    halfExtents: V3;
    closedYaw: number;
    openYaw: number;
  }[];
}
export interface CompiledFunctionalContractV2 {
  schema: "limina.functional-building/v2";
  units: "meter";
  up: "Y";
  buildingId: string;
  rootNodeId: "building/root";
  roomIds: readonly string[];
  portalIds: readonly string[];
  entryAnchor: V3;
  site: FunctionalArchitectureSpec["site"];
  colliders: readonly { id: string; center: V3; halfExtents: V3; rotation?: readonly [number, number, number, number] }[];
  doors: CompiledFunctionalContract["doors"];
  rooms: readonly CompiledFunctionalRoom[];
  portals: readonly FunctionalPortalSpec[];
  verticalLinks: readonly {
    id: string;
    kind: "stairs";
    fromRoomId: string;
    toRoomId: string;
    from: V3;
    to: V3;
    clearWidth: number;
    clearHeight: number;
    rise: number;
    run: number;
    riserCount: number;
    treadDepth: number;
    bottomLandingDepth?: number;
    topLandingDepth?: number;
    clearancePolicy?: FunctionalStairSpec["clearancePolicy"];
    flights?: FunctionalStairSpec["flights"];
    intermediateLandings?: FunctionalStairSpec["intermediateLandings"];
    approaches?: FunctionalStairSpec["approaches"];
    upperFloorOpening: { center: V2; halfExtents: V2 };
  }[];
  spawnAnchors: readonly FunctionalSpawnAnchorSpec[];
  visibilityCells: readonly FunctionalVisibilityCellSpec[];
}
export interface CompiledArchitecture {
  schema: typeof ARCHITECTURE_COMPILE;
  compilerVersion: 1;
  specHash: string;
  irHash: string;
  primitives: readonly ArchitecturePrimitive[];
  volumes: readonly CompiledVolume[];
  /** Present only when compiler-owned attached-bay authority was authored. */
  attachedBays?: readonly CompiledAttachedBay[];
  walls: readonly CompiledWall[];
  entrances: readonly CompiledEntrance[];
  /** Present only for additive specs that author compiler-owned entry weather protection. */
  entranceCanopies?: readonly CompiledEntranceCanopy[];
  doors: readonly CompiledDoor[];
  windows: readonly CompiledWindow[];
  dormers: readonly CompiledDormer[];
  roofPenetrations: readonly CompiledRoofPenetration[];
  roofSeams: readonly CompiledRoofSeam[];
  fireplaces: readonly CompiledFireplace[];
  practicalLights: readonly CompiledPracticalLight[];
  furnishings: readonly CompiledFurnishing[];
  interiorStructure: readonly CompiledInteriorStructure[];
  perceptualTimberFrames?: readonly CompiledPerceptualTimberFrame[];
  domesticProps: readonly CompiledDomesticProp[];
  visualContract?: unknown;
  functionalContract?: CompiledFunctionalContract | CompiledFunctionalContractV2;
  diagnostics: readonly Diagnostic[];
  review: ArchitectureReviewManifest;
}
