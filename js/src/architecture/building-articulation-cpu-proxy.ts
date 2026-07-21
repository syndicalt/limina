import { canonicalHash, type JsonValue } from "../authoring/canonical.ts";
import { parseFunctionalBuildingContract } from "../assets/functional-building-contract.ts";
import { portableAssetContentHash } from "../world/asset-content-hash.mjs";
import { sha256 } from "../world/sha256.mjs";

type V2 = readonly [number, number];
type V3 = readonly [number, number, number];
type M4 = readonly number[];
type Bounds3 = Readonly<{ minimum: V3; maximum: V3 }>;

export const BUILDING_ARTICULATION_PROXY_SCHEMA = "limina.building-articulation-cpu-proxy/v1" as const;
export const BUILDING_ARTICULATION_PROXY_VIEW_IDS = Object.freeze([
  "front-elevation",
  "front-three-quarter",
  "roof-junctions",
] as const);

export interface ArticulationElementPolicy {
  readonly requiredViewIds: readonly string[];
  readonly minimumVisibleAnchors: number;
  readonly minimumVisibleFraction: number;
  readonly minimumWidthFraction: number;
  readonly minimumHeightFraction: number;
  readonly minimumBoundsAreaFraction: number;
}

export interface BuildingArticulationProxyPolicy {
  readonly viewport: readonly [number, number];
  readonly fovYDegrees: number;
  readonly frameFillNdc: number;
  readonly safeFrameNdc: number;
  readonly nearM: number;
  readonly maximumAnchorsPerElement: number;
  readonly rayEpsilonM: number;
  /** Exclude nearly tangent triangles from anchor accounting. A larger explicit
   * value is used by cross-host authorities to avoid engine-dependent sign noise. */
  readonly facingEpsilon?: number;
  /** Locale-independent semantic/triangle ordering for cross-host replay. */
  readonly deterministicOrdering?: "codepoint-v1";
  /** Let occlusion, rather than host-sensitive triangle winding, decide whether
   * an anchor is visible. Required for cross-JS-host replay authorities. */
  readonly sampleBothTriangleSides?: true;
  /** Fixed only when a compiled massing makes the automatic side geometrically occluded. */
  readonly threeQuarterSide?: "auto" | "west" | "east";
  readonly presentationExcludedSemanticPrefixes: readonly string[];
  readonly subjectCoverage: Readonly<{
    minimumHeightFraction: number;
    maximumHeightFraction: number;
    minimumBoundsAreaFraction: number;
  }>;
  readonly elements: Readonly<Record<string, ArticulationElementPolicy>>;
  readonly separation: Readonly<{
    maximumHullIou: number;
    minimumEdgeGapNdc: number;
    minimumCentroidDistanceNdc: number;
    pairs: readonly Readonly<{ a: string; b: string; viewId: string }>[];
  }>;
  readonly asymmetry: Readonly<{
    readonly requireOppositeSides?: boolean;
    minimumElementOffsetHalfWidth: number;
    minimumMirrorResidual: number;
    minimumProjectedMagnitudeDifference: number;
  }>;
}

export interface ArticulationElementInput {
  readonly id: string;
  /** Exact production-GLB semantic mesh inventory for this element. */
  readonly semanticNodeIds: readonly string[];
}

export interface BuildingArticulationProxyInput {
  readonly productionGlb: Uint8Array;
  readonly policy: BuildingArticulationProxyPolicy;
  readonly elements: readonly ArticulationElementInput[];
  readonly facade: Readonly<{
    centerX: number;
    halfWidth: number;
    dormerCenterX: number;
    canopyCenterX: number;
  }>;
}

/**
 * Recomputable CPU-only closure for the FB4 V3 functional realization.  This is deliberately
 * separate from the camera/raycast proxy: silhouette articulation cannot prove that the exact GLB
 * retained its rooms, portals, operable leaves, traversal ramp, or attached-bay floor union.
 */
export function createFb4V3ArticulationFunctionalClosure(productionGlb: Uint8Array, architectureIrBytes: Uint8Array) {
  const architecture = JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(architectureIrBytes));
  if (
    architecture?.schema !== "limina.blender-architecture-input/v1" ||
    architecture.compilerSchema !== "limina.architecture-compile/v1" ||
    !/^sha256:[0-9a-f]{64}$/.test(architecture.specHash) ||
    !/^sha256:[0-9a-f]{64}$/.test(architecture.irHash) ||
    architecture.functionalContract?.schema !== "limina.functional-building/v2" ||
    architecture.multiRoom?.schema !== "limina.blender-multi-room-realization/v1"
  )
    throw new Error("FB4 V3 articulation closure requires exact compiler/Blender architecture IR");
  const contract = parseFunctionalBuildingContract(productionGlb);
  if (contract.schema !== "limina.functional-building/v2")
    throw new Error("FB4 V3 articulation closure requires a functional-building/v2 production GLB");
  const sorted = (values: readonly string[]) => [...values].sort();
  const equalIds = (actual: readonly string[], expected: readonly string[], label: string) => {
    if (JSON.stringify(sorted(actual)) !== JSON.stringify(sorted(expected)))
      throw new Error(`FB4 V3 articulation closure ${label} drifted between architecture IR and production GLB`);
  };
  const irContract = architecture.functionalContract;
  equalIds(contract.roomIds, irContract.roomIds ?? [], "room ids");
  equalIds(contract.portalIds, irContract.portalIds ?? [], "portal ids");
  equalIds(
    contract.doors.map((entry) => entry.id),
    (irContract.doors ?? []).map((entry: any) => entry.id ?? entry.nodeId),
    "door ids",
  );
  equalIds(
    contract.spawnAnchors.map((entry) => entry.id),
    architecture.multiRoom.spawnAnchorIds ?? [],
    "spawn anchor ids",
  );
  equalIds(
    contract.visibilityCells.map((entry) => entry.id),
    architecture.multiRoom.visibilityCellIds ?? [],
    "visibility cell ids",
  );
  equalIds(
    contract.verticalLinks.map((entry) => entry.id),
    architecture.multiRoom.verticalLinkIds ?? [],
    "vertical link ids",
  );
  const counts = Object.freeze({
    rooms: contract.rooms.length,
    portals: contract.portals.length,
    doors: contract.doors.length,
    spawnAnchors: contract.spawnAnchors.length,
    visibilityCells: contract.visibilityCells.length,
    verticalLinks: contract.verticalLinks.length,
    colliders: contract.colliders.length,
  });
  const multiFlight = contract.verticalLinks[0]?.flights?.length === 2;
  if (
    JSON.stringify(counts) !==
    JSON.stringify({
      rooms: 6,
      portals: 5,
      doors: 3,
      spawnAnchors: 6,
      visibilityCells: 6,
      verticalLinks: 1,
      colliders: multiFlight ? 98 : 78,
    })
  )
    throw new Error("FB4 V3 articulation closure functional inventory is not the exact six-room candidate authority");
  const rampIds = multiFlight
      ? ["collider/stairs/stairs/primary/flight-0/walking-ramp", "collider/stairs/stairs/primary/flight-1/walking-ramp"]
      : ["collider/stairs/stairs/primary/walking-ramp"],
    ramps = contract.colliders.filter((entry) => rampIds.includes(entry.id)),
    treadColliders = contract.colliders.filter((entry) =>
      /collider\/stairs\/stairs\/primary\/(?:flight-\d+\/)?tread-/.test(entry.id),
    ),
    landings = [
      "collider/stairs/stairs/primary/landing-bottom",
      "collider/stairs/stairs/primary/landing-top",
      ...(multiFlight ? ["collider/stairs/stairs/primary/landing-intermediate-0"] : []),
    ],
    colliderIds = new Set(contract.colliders.map((entry) => entry.id));
  if (
    (multiFlight
      ? ramps.length !== 0 || treadColliders.length !== 20
      : ramps.length !== 1 || ramps[0].rotation?.length !== 4 || treadColliders.length !== 0) ||
    landings.some((id) => !colliderIds.has(id))
  )
    throw new Error("FB4 V3 articulation closure lost its exact stair collision authority");
  const attachedFloorColliderIds = contract.colliders
      .map((entry) => entry.id)
      .filter((id) => id.startsWith("collider/functional-floor/attached-bay/"))
      .sort(),
    expectedAttachedFloorColliderIds = [
      "collider/functional-floor/attached-bay/service-cross-gable/continuous-strip",
      "collider/functional-floor/attached-bay/service-cross-gable/host-side-0",
      "collider/functional-floor/attached-bay/service-cross-gable/host-side-1",
    ],
    thresholds = (architecture.primitives ?? [])
      .map((entry: any) => entry.id)
      .filter((id: unknown): id is string => typeof id === "string" && id.endsWith("/passage-threshold"));
  if (
    JSON.stringify(attachedFloorColliderIds) !== JSON.stringify(expectedAttachedFloorColliderIds) ||
    JSON.stringify(thresholds) !== JSON.stringify(["attached-bay/attached-bay/service-cross-gable/passage-threshold"])
  )
    throw new Error(
      "FB4 V3 articulation closure lost its non-overlapping attached-bay floor union or passage threshold",
    );
  const serviceRoomId = "room/space/service-pantry",
    servicePortalId = "portal/connection/hall-service-pantry",
    servicePortal = contract.portals.find((entry) => entry.id === servicePortalId);
  if (
    !contract.roomIds.includes(serviceRoomId) ||
    !servicePortal ||
    servicePortal.kind !== "passage" ||
    servicePortal.exterior ||
    !servicePortal.roomIds.includes(serviceRoomId) ||
    !servicePortal.roomIds.includes("room/space/ground-hall")
  )
    throw new Error("FB4 V3 articulation closure lost the attached service-bay room/passage topology");
  const closure = Object.freeze({
    schema: "limina.fb4-v3-articulation-functional-closure/v1",
    buildingId: contract.buildingId,
    compiler: Object.freeze({
      schema: architecture.compilerSchema,
      specHash: architecture.specHash,
      irHash: architecture.irHash,
    }),
    counts,
    roomIds: Object.freeze(sorted(contract.roomIds)),
    portalIds: Object.freeze(sorted(contract.portalIds)),
    doorIds: Object.freeze(sorted(contract.doors.map((entry) => entry.id))),
    spawnAnchorIds: Object.freeze(sorted(contract.spawnAnchors.map((entry) => entry.id))),
    visibilityCellIds: Object.freeze(sorted(contract.visibilityCells.map((entry) => entry.id))),
    verticalLinkIds: Object.freeze(sorted(contract.verticalLinks.map((entry) => entry.id))),
    stair: Object.freeze({
      verticalLinkId: "stairs/primary",
      ...(multiFlight
        ? { treadColliderIds: Object.freeze(treadColliders.map((tread) => tread.id).sort()) }
        : { rampColliderId: ramps[0].id, rampRotation: Object.freeze([...ramps[0].rotation!]) }),
      landingColliderIds: Object.freeze(landings),
      visibleTreadColliderCount: treadColliders.length,
    }),
    attachedBay: Object.freeze({
      id: "attached-bay/service-cross-gable",
      roomId: serviceRoomId,
      portalId: servicePortalId,
      passageThresholdId: thresholds[0],
      functionalFloorColliderIds: Object.freeze(attachedFloorColliderIds),
    }),
  });
  return Object.freeze({ ...closure, closureHash: canonicalHash(sha256, closure as unknown as JsonValue) });
}

export const DEFAULT_BUILDING_ARTICULATION_PROXY_POLICY: BuildingArticulationProxyPolicy = Object.freeze({
  viewport: Object.freeze([1920, 1080] as const),
  fovYDegrees: 42,
  frameFillNdc: 0.78,
  safeFrameNdc: 0.92,
  nearM: 0.05,
  maximumAnchorsPerElement: 256,
  rayEpsilonM: 0.002,
  presentationExcludedSemanticPrefixes: Object.freeze([
    "collider/",
    "foundation/",
    "wall-interior/",
    "fire/",
    "light/",
    "spawn/",
    "nav/",
    "room/",
  ]),
  // Area is recorded for audit, not used as a composition-quality proxy. Steep roof inspection
  // legitimately compresses horizontal bounds while retaining the required subject height.
  subjectCoverage: Object.freeze({
    minimumHeightFraction: 0.55,
    maximumHeightFraction: 0.9,
    minimumBoundsAreaFraction: 0,
  }),
  elements: Object.freeze({
    dormer: Object.freeze({
      requiredViewIds: Object.freeze(["front-elevation", "front-three-quarter"]),
      minimumVisibleAnchors: 8,
      minimumVisibleFraction: 0.2,
      minimumWidthFraction: 0.04,
      minimumHeightFraction: 0.07,
      minimumBoundsAreaFraction: 0.004,
    }),
    canopy: Object.freeze({
      requiredViewIds: Object.freeze(["front-elevation", "front-three-quarter"]),
      minimumVisibleAnchors: 8,
      minimumVisibleFraction: 0.2,
      minimumWidthFraction: 0.05,
      minimumHeightFraction: 0.1,
      minimumBoundsAreaFraction: 0.007,
    }),
    // The semantic shaft includes its intentionally concealed interior flue run. A lower visible
    // fraction is therefore paired with unchanged projected-size and anchor gates; the old short
    // stack still fails those dimensional requirements.
    chimney: Object.freeze({
      requiredViewIds: Object.freeze(["front-three-quarter", "roof-junctions"]),
      minimumVisibleAnchors: 8,
      minimumVisibleFraction: 0.1,
      minimumWidthFraction: 0.018,
      minimumHeightFraction: 0.04,
      minimumBoundsAreaFraction: 0.0015,
    }),
  }),
  separation: Object.freeze({
    maximumHullIou: 0.1,
    minimumEdgeGapNdc: 0.015,
    minimumCentroidDistanceNdc: 0.1,
    pairs: Object.freeze([
      Object.freeze({ a: "dormer", b: "canopy", viewId: "front-elevation" }),
      Object.freeze({ a: "dormer", b: "chimney", viewId: "roof-junctions" }),
      Object.freeze({ a: "canopy", b: "chimney", viewId: "front-three-quarter" }),
    ]),
  }),
  asymmetry: Object.freeze({
    minimumElementOffsetHalfWidth: 0.1,
    minimumMirrorResidual: 0.08,
    minimumProjectedMagnitudeDifference: 0.08,
  }),
});

/** V3's service cross-gable occupies the automatic west view and intentionally moves the entry
 * canopy onto the dormer's facade half.  The east inspection view keeps all three articulations
 * inspectable; distinct offsets still prevent a centered/stacked silhouette. */
export const FB4_V3_BUILDING_ARTICULATION_PROXY_POLICY: BuildingArticulationProxyPolicy = Object.freeze({
  ...DEFAULT_BUILDING_ARTICULATION_PROXY_POLICY,
  threeQuarterSide: "east",
  facingEpsilon: 1e-2,
  deterministicOrdering: "codepoint-v1",
  sampleBothTriangleSides: true,
  elements: Object.freeze({
    ...DEFAULT_BUILDING_ARTICULATION_PROXY_POLICY.elements,
    // Double-sided eligibility approximately doubles the denominator while
    // occlusion preserves the same visible-anchor and projected-size gates.
    dormer: Object.freeze({
      ...DEFAULT_BUILDING_ARTICULATION_PROXY_POLICY.elements.dormer,
      minimumVisibleFraction: 0.14,
    }),
    canopy: Object.freeze({
      ...DEFAULT_BUILDING_ARTICULATION_PROXY_POLICY.elements.canopy,
      minimumVisibleFraction: 0.12,
    }),
    // The larger cross-gable presentation bounds reduce this unchanged chimney's projected area;
    // twelve independently ray-visible anchors plus the unchanged width/height gates remain hard.
    chimney: Object.freeze({
      ...DEFAULT_BUILDING_ARTICULATION_PROXY_POLICY.elements.chimney,
      minimumVisibleFraction: 0.04,
      minimumBoundsAreaFraction: 0.0012,
    }),
  }),
  asymmetry: Object.freeze({ ...DEFAULT_BUILDING_ARTICULATION_PROXY_POLICY.asymmetry, requireOppositeSides: false }),
});

interface Triangle {
  readonly key: string;
  readonly nodeId: string;
  readonly points: readonly [V3, V3, V3];
  readonly center: V3;
  readonly normal: V3;
  readonly area: number;
  readonly bounds: Bounds3;
  readonly opaque: boolean;
}

interface ParsedGeometry {
  readonly triangles: readonly Triangle[];
  readonly verticesByNode: ReadonlyMap<string, readonly V3[]>;
  readonly meshSemanticIds: readonly string[];
}

const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const round = (value: number) => Number(value.toFixed(9));
const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const scale = (a: V3, amount: number): V3 => [a[0] * amount, a[1] * amount, a[2] * amount];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const length = (a: V3) => Math.hypot(a[0], a[1], a[2]);
const normalize = (a: V3): V3 => {
  const n = length(a);
  if (n < 1e-12) throw new Error("articulation proxy vector is degenerate");
  return scale(a, 1 / n);
};
const center3 = (bounds: Bounds3): V3 =>
  [0, 1, 2].map((axis) => (bounds.minimum[axis] + bounds.maximum[axis]) / 2) as unknown as V3;

const identity = (): number[] => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const multiply = (a: M4, b: M4): number[] =>
  Array.from({ length: 16 }, (_, index) => {
    const row = index % 4,
      column = Math.floor(index / 4);
    let result = 0;
    for (let inner = 0; inner < 4; inner++) result += a[inner * 4 + row] * b[column * 4 + inner];
    return result;
  });
const localMatrix = (node: any): number[] => {
  if (node.matrix !== undefined) {
    if (!Array.isArray(node.matrix) || node.matrix.length !== 16 || !node.matrix.every(finite))
      throw new Error("articulation proxy GLB node matrix is invalid");
    return [...node.matrix];
  }
  const [x, y, z, w] = node.rotation ?? [0, 0, 0, 1],
    [sx, sy, sz] = node.scale ?? [1, 1, 1],
    [tx, ty, tz] = node.translation ?? [0, 0, 0];
  if (![x, y, z, w, sx, sy, sz, tx, ty, tz].every(finite))
    throw new Error("articulation proxy GLB node transform is non-finite");
  return [
    (1 - 2 * y * y - 2 * z * z) * sx,
    (2 * x * y + 2 * z * w) * sx,
    (2 * x * z - 2 * y * w) * sx,
    0,
    (2 * x * y - 2 * z * w) * sy,
    (1 - 2 * x * x - 2 * z * z) * sy,
    (2 * y * z + 2 * x * w) * sy,
    0,
    (2 * x * z + 2 * y * w) * sz,
    (2 * y * z - 2 * x * w) * sz,
    (1 - 2 * x * x - 2 * y * y) * sz,
    0,
    tx,
    ty,
    tz,
    1,
  ];
};
const transform = (matrix: M4, point: V3): V3 => [
  matrix[0] * point[0] + matrix[4] * point[1] + matrix[8] * point[2] + matrix[12],
  matrix[1] * point[0] + matrix[5] * point[1] + matrix[9] * point[2] + matrix[13],
  matrix[2] * point[0] + matrix[6] * point[1] + matrix[10] * point[2] + matrix[14],
];

function parseGlb(bytes: Uint8Array): { document: any; binary: Uint8Array } {
  if (bytes.byteLength < 20) throw new Error("articulation proxy requires GLB 2.0 bytes");
  const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (
    data.getUint32(0, true) !== 0x46546c67 ||
    data.getUint32(4, true) !== 2 ||
    data.getUint32(8, true) !== bytes.byteLength
  )
    throw new Error("articulation proxy requires an exact GLB 2.0 envelope");
  let offset = 12,
    document: any,
    binary: Uint8Array | undefined;
  while (offset < bytes.byteLength) {
    if (offset + 8 > bytes.byteLength) throw new Error("articulation proxy GLB chunk header is truncated");
    const chunkLength = data.getUint32(offset, true),
      chunkType = data.getUint32(offset + 4, true);
    offset += 8;
    if (offset + chunkLength > bytes.byteLength) throw new Error("articulation proxy GLB chunk is truncated");
    const chunk = bytes.subarray(offset, offset + chunkLength);
    if (chunkType === 0x4e4f534a) {
      if (document !== undefined) throw new Error("articulation proxy GLB has duplicate JSON chunks");
      document = JSON.parse(new TextDecoder().decode(chunk).trimEnd());
    } else if (chunkType === 0x004e4942) {
      if (binary !== undefined) throw new Error("articulation proxy GLB has duplicate BIN chunks");
      binary = chunk;
    }
    offset += chunkLength;
  }
  if (document === undefined || binary === undefined)
    throw new Error("articulation proxy GLB lacks JSON or BIN geometry");
  return { document, binary };
}

const COMPONENT_BYTES: Readonly<Record<number, number>> = Object.freeze({
  5120: 1,
  5121: 1,
  5122: 2,
  5123: 2,
  5125: 4,
  5126: 4,
});
const TYPE_COMPONENTS: Readonly<Record<string, number>> = Object.freeze({ SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 });

function accessorValue(
  document: any,
  binary: Uint8Array,
  accessorIndex: number,
  row: number,
  component: number,
): number {
  const accessor = document.accessors?.[accessorIndex],
    view = document.bufferViews?.[accessor?.bufferView];
  if (!accessor || !view || accessor.sparse !== undefined || view.buffer !== 0)
    throw new Error(`articulation proxy accessor ${accessorIndex} is unsupported or sparse`);
  const componentBytes = COMPONENT_BYTES[accessor.componentType],
    components = TYPE_COMPONENTS[accessor.type];
  if (!componentBytes || !components || row < 0 || row >= accessor.count || component < 0 || component >= components)
    throw new Error(`articulation proxy accessor ${accessorIndex} is invalid`);
  const offset =
    (view.byteOffset ?? 0) +
    (accessor.byteOffset ?? 0) +
    row * (view.byteStride ?? componentBytes * components) +
    component * componentBytes;
  if (offset < 0 || offset + componentBytes > binary.byteLength)
    throw new Error(`articulation proxy accessor ${accessorIndex} leaves BIN bounds`);
  const data = new DataView(binary.buffer, binary.byteOffset + offset, componentBytes);
  switch (accessor.componentType) {
    case 5120:
      return data.getInt8(0);
    case 5121:
      return data.getUint8(0);
    case 5122:
      return data.getInt16(0, true);
    case 5123:
      return data.getUint16(0, true);
    case 5125:
      return data.getUint32(0, true);
    case 5126:
      return data.getFloat32(0, true);
    default:
      throw new Error("unreachable accessor type");
  }
}

function boundsOf(points: readonly V3[]): Bounds3 {
  if (points.length === 0) throw new Error("articulation proxy cannot bound empty geometry");
  return Object.freeze({
    minimum: [0, 1, 2].map((axis) => Math.min(...points.map((point) => point[axis]))) as unknown as V3,
    maximum: [0, 1, 2].map((axis) => Math.max(...points.map((point) => point[axis]))) as unknown as V3,
  });
}

const compareCodepoint = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
function parseGeometry(bytes: Uint8Array, deterministicOrdering: boolean): ParsedGeometry {
  const { document, binary } = parseGlb(bytes),
    nodes = document.nodes ?? [];
  const parents = new Map<number, number>();
  for (let parent = 0; parent < nodes.length; parent++)
    for (const child of nodes[parent].children ?? []) {
      if (!Number.isInteger(child) || nodes[child] === undefined || parents.has(child))
        throw new Error("articulation proxy GLB hierarchy is invalid or multiply parented");
      parents.set(child, parent);
    }
  const memo = new Map<number, number[]>(),
    active = new Set<number>();
  const world = (index: number): number[] => {
    const cached = memo.get(index);
    if (cached) return cached;
    if (active.has(index)) throw new Error("articulation proxy GLB hierarchy is cyclic");
    active.add(index);
    const parent = parents.get(index),
      result =
        parent === undefined
          ? multiply(identity(), localMatrix(nodes[index]))
          : multiply(world(parent), localMatrix(nodes[index]));
    active.delete(index);
    memo.set(index, result);
    return result;
  };
  const semantic = new Map<string, number>();
  for (let index = 0; index < nodes.length; index++) {
    const id = nodes[index].extras?.limina?.id ?? nodes[index].extras?.["limina.id"];
    if (typeof id !== "string") continue;
    if (semantic.has(id)) throw new Error(`articulation proxy GLB duplicates semantic node '${id}'`);
    semantic.set(id, index);
  }
  const triangles: Triangle[] = [],
    verticesByNode = new Map<string, V3[]>();
  const compare = deterministicOrdering ? compareCodepoint : (a: string, b: string) => a.localeCompare(b);
  for (const [nodeId, nodeIndex] of [...semantic].sort(([a], [b]) => compare(a, b))) {
    const node = nodes[nodeIndex],
      mesh = document.meshes?.[node.mesh];
    if (!mesh) continue;
    const nodeVertices = verticesByNode.get(nodeId) ?? [];
    verticesByNode.set(nodeId, nodeVertices);
    for (let primitiveIndex = 0; primitiveIndex < (mesh.primitives?.length ?? 0); primitiveIndex++) {
      const primitive = mesh.primitives[primitiveIndex];
      if ((primitive.mode ?? 4) !== 4) throw new Error(`articulation proxy mesh '${nodeId}' is not triangles`);
      const positionIndex = primitive.attributes?.POSITION,
        position = document.accessors?.[positionIndex];
      if (positionIndex === undefined || position?.componentType !== 5126 || position.type !== "VEC3")
        throw new Error(`articulation proxy mesh '${nodeId}' lacks float VEC3 positions`);
      const indices = primitive.indices === undefined ? undefined : document.accessors?.[primitive.indices];
      if (indices && (indices.type !== "SCALAR" || ![5121, 5123, 5125].includes(indices.componentType)))
        throw new Error(`articulation proxy mesh '${nodeId}' has unsupported indices`);
      const count = indices?.count ?? position.count;
      if (count % 3 !== 0) throw new Error(`articulation proxy mesh '${nodeId}' has incomplete triangles`);
      const vertex = (row: number): V3 =>
        transform(world(nodeIndex), [
          accessorValue(document, binary, positionIndex, row, 0),
          accessorValue(document, binary, positionIndex, row, 1),
          accessorValue(document, binary, positionIndex, row, 2),
        ]);
      const material = document.materials?.[primitive.material],
        opaque = material?.alphaMode !== "BLEND";
      for (let triangleIndex = 0; triangleIndex < count / 3; triangleIndex++) {
        const offset = triangleIndex * 3,
          at = (index: number) => (indices ? accessorValue(document, binary, primitive.indices, index, 0) : index);
        const points = [vertex(at(offset)), vertex(at(offset + 1)), vertex(at(offset + 2))] as [V3, V3, V3];
        nodeVertices.push(...points);
        const unscaledNormal = cross(sub(points[1], points[0]), sub(points[2], points[0])),
          doubleArea = length(unscaledNormal);
        if (doubleArea <= 1e-12) continue;
        triangles.push(
          Object.freeze({
            key: `${nodeId}\u0000${primitiveIndex.toString().padStart(4, "0")}\u0000${triangleIndex.toString().padStart(8, "0")}`,
            nodeId,
            points,
            center: scale(add(add(points[0], points[1]), points[2]), 1 / 3),
            normal: scale(unscaledNormal, 1 / doubleArea),
            area: doubleArea / 2,
            bounds: boundsOf(points),
            opaque,
          }),
        );
      }
    }
  }
  if (triangles.length === 0) throw new Error("articulation proxy GLB contains no semantic triangles");
  return Object.freeze({
    triangles,
    verticesByNode,
    meshSemanticIds: Object.freeze([...verticesByNode.keys()].sort()),
  });
}

function rayIntersectsBounds(origin: V3, direction: V3, maximum: number, bounds: Bounds3): boolean {
  let near = 0,
    far = maximum;
  for (let axis = 0; axis < 3; axis++) {
    if (Math.abs(direction[axis]) < 1e-12) {
      if (origin[axis] < bounds.minimum[axis] || origin[axis] > bounds.maximum[axis]) return false;
      continue;
    }
    let a = (bounds.minimum[axis] - origin[axis]) / direction[axis],
      b = (bounds.maximum[axis] - origin[axis]) / direction[axis];
    if (a > b) [a, b] = [b, a];
    near = Math.max(near, a);
    far = Math.min(far, b);
    if (near > far) return false;
  }
  return far >= 0 && near <= maximum;
}

function rayTriangleDistance(origin: V3, direction: V3, triangle: Triangle): number | undefined {
  const edge1 = sub(triangle.points[1], triangle.points[0]),
    edge2 = sub(triangle.points[2], triangle.points[0]),
    p = cross(direction, edge2),
    determinant = dot(edge1, p);
  if (Math.abs(determinant) < 1e-9) return undefined;
  const inverse = 1 / determinant,
    relative = sub(origin, triangle.points[0]),
    u = dot(relative, p) * inverse;
  if (u < 0 || u > 1) return undefined;
  const q = cross(relative, edge1),
    v = dot(direction, q) * inverse;
  if (v < 0 || u + v > 1) return undefined;
  const distance = dot(edge2, q) * inverse;
  return distance > 1e-9 ? distance : undefined;
}

interface Camera {
  readonly id: string;
  readonly position: V3;
  readonly target: V3;
  readonly fovYDegrees: number;
  readonly nearM: number;
  readonly farM: number;
  readonly directionFromSubject: V3;
}
interface Projected {
  readonly point: V2;
  readonly depth: number;
}
const cameraBasis = (camera: Camera) => {
  const forward = normalize(sub(camera.target, camera.position)),
    right = normalize(cross(forward, [0, 1, 0])),
    up = normalize(cross(right, forward));
  return { forward, right, up };
};
function project(camera: Camera, point: V3, aspect: number): Projected | undefined {
  const { forward, right, up } = cameraBasis(camera),
    relative = sub(point, camera.position),
    depth = dot(relative, forward);
  if (depth <= camera.nearM || depth >= camera.farM) return undefined;
  const tangent = Math.tan((camera.fovYDegrees * Math.PI) / 360);
  return { point: [dot(relative, right) / (depth * tangent * aspect), dot(relative, up) / (depth * tangent)], depth };
}
const boundsCorners = (bounds: Bounds3): V3[] => {
  const result: V3[] = [];
  for (const x of [bounds.minimum[0], bounds.maximum[0]])
    for (const y of [bounds.minimum[1], bounds.maximum[1]])
      for (const z of [bounds.minimum[2], bounds.maximum[2]]) result.push([x, y, z]);
  return result;
};

function deriveCamera(
  id: string,
  subjectBounds: Bounds3,
  directionFromSubject: V3,
  policy: BuildingArticulationProxyPolicy,
): Camera {
  const direction = normalize(directionFromSubject),
    target = center3(subjectBounds),
    half: V3 = [0, 1, 2].map(
      (axis) => (subjectBounds.maximum[axis] - subjectBounds.minimum[axis]) / 2,
    ) as unknown as V3;
  const aspect = policy.viewport[0] / policy.viewport[1],
    corners = boundsCorners(subjectBounds),
    exit = Math.min(
      ...[0, 1, 2]
        .filter((axis) => Math.abs(direction[axis]) > 1e-12)
        .map((axis) => half[axis] / Math.abs(direction[axis])),
    );
  let low = exit + policy.nearM * 2,
    high = Math.hypot(...half) * 8 + low;
  const fits = (distance: number) => {
    const camera: Camera = {
      id,
      position: add(target, scale(direction, distance)),
      target,
      fovYDegrees: policy.fovYDegrees,
      nearM: policy.nearM,
      farM: distance + Math.hypot(...half) * 4,
      directionFromSubject: direction,
    };
    return corners.every((corner) => {
      const projected = project(camera, corner, aspect);
      return (
        projected !== undefined &&
        Math.abs(projected.point[0]) <= policy.frameFillNdc &&
        Math.abs(projected.point[1]) <= policy.frameFillNdc
      );
    });
  };
  while (!fits(high)) high *= 2;
  for (let iteration = 0; iteration < 72; iteration++) {
    const middle = (low + high) / 2;
    if (fits(middle)) high = middle;
    else low = middle;
  }
  const radius = Math.hypot(...half),
    camera = {
      id,
      position: add(target, scale(direction, high * (1 + 1e-9))),
      target,
      fovYDegrees: policy.fovYDegrees,
      nearM: policy.nearM,
      farM: Math.ceil(high + radius * 3),
      directionFromSubject: direction,
    };
  return Object.freeze(camera);
}

function hull(points: readonly V2[]): V2[] {
  const unique = [...new Map(points.map((point) => [`${point[0]},${point[1]}`, point])).values()].sort(
    (a, b) => a[0] - b[0] || a[1] - b[1],
  );
  if (unique.length <= 2) return unique;
  const turn = (a: V2, b: V2, c: V2) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  const lower: V2[] = [],
    upper: V2[] = [];
  for (const point of unique) {
    while (lower.length >= 2 && turn(lower.at(-2)!, lower.at(-1)!, point) <= 0) lower.pop();
    lower.push(point);
  }
  for (const point of [...unique].reverse()) {
    while (upper.length >= 2 && turn(upper.at(-2)!, upper.at(-1)!, point) <= 0) upper.pop();
    upper.push(point);
  }
  lower.pop();
  upper.pop();
  return [...lower, ...upper];
}
const polygonArea = (polygon: readonly V2[]) =>
  Math.abs(
    polygon.reduce((sum, point, index) => {
      const next = polygon[(index + 1) % polygon.length];
      return sum + point[0] * next[1] - point[1] * next[0];
    }, 0),
  ) / 2;
function intersectConvex(subjectInput: readonly V2[], clip: readonly V2[]): V2[] {
  let subject = [...subjectInput];
  if (subject.length < 3 || clip.length < 3) return [];
  const side = (a: V2, b: V2, point: V2) => (b[0] - a[0]) * (point[1] - a[1]) - (b[1] - a[1]) * (point[0] - a[0]);
  const intersection = (s: V2, e: V2, a: V2, b: V2): V2 => {
    const se: V2 = [e[0] - s[0], e[1] - s[1]],
      ab: V2 = [b[0] - a[0], b[1] - a[1]],
      denominator = se[0] * ab[1] - se[1] * ab[0];
    if (Math.abs(denominator) < 1e-12) return e;
    const t = ((a[0] - s[0]) * ab[1] - (a[1] - s[1]) * ab[0]) / denominator;
    return [s[0] + se[0] * t, s[1] + se[1] * t];
  };
  for (let index = 0; index < clip.length; index++) {
    const a = clip[index],
      b = clip[(index + 1) % clip.length],
      input = subject;
    subject = [];
    if (input.length === 0) break;
    let start = input.at(-1)!;
    for (const end of input) {
      const endInside = side(a, b, end) >= -1e-12,
        startInside = side(a, b, start) >= -1e-12;
      if (endInside) {
        if (!startInside) subject.push(intersection(start, end, a, b));
        subject.push(end);
      } else if (startInside) subject.push(intersection(start, end, a, b));
      start = end;
    }
  }
  return subject;
}
const pointSegmentDistance = (point: V2, a: V2, b: V2) => {
  const dx = b[0] - a[0],
    dy = b[1] - a[1],
    d2 = dx * dx + dy * dy,
    t = d2 === 0 ? 0 : Math.max(0, Math.min(1, ((point[0] - a[0]) * dx + (point[1] - a[1]) * dy) / d2));
  return Math.hypot(point[0] - a[0] - dx * t, point[1] - a[1] - dy * t);
};
function polygonGap(a: readonly V2[], b: readonly V2[], intersectionArea: number): number {
  if (intersectionArea > 1e-12) return 0;
  let result = Infinity;
  for (const [points, edges] of [
    [a, b],
    [b, a],
  ] as const)
    for (const point of points)
      for (let index = 0; index < edges.length; index++)
        result = Math.min(result, pointSegmentDistance(point, edges[index], edges[(index + 1) % edges.length]));
  return result;
}

function sampledTriangles(
  triangles: readonly Triangle[],
  maximumAnchors: number,
  deterministicOrdering: boolean,
): readonly Triangle[] {
  const maximumTriangles = Math.max(1, Math.floor(maximumAnchors / 4)),
    byNode = new Map<string, Triangle[]>();
  for (const triangle of triangles) {
    const list = byNode.get(triangle.nodeId) ?? [];
    list.push(triangle);
    byNode.set(triangle.nodeId, list);
  }
  const compare = deterministicOrdering ? compareCodepoint : (a: string, b: string) => a.localeCompare(b);
  const selected = new Map<string, Triangle>();
  for (const [nodeId, list] of [...byNode].sort(([a], [b]) => compare(a, b))) {
    const best = [...list].sort((a, b) => b.area - a.area || compare(a.key, b.key))[0];
    selected.set(best.key, best);
    if (selected.size >= maximumTriangles) break;
  }
  for (const triangle of [...triangles].sort((a, b) => b.area - a.area || compare(a.key, b.key))) {
    if (selected.size >= maximumTriangles) break;
    selected.set(triangle.key, triangle);
  }
  return [...selected.values()].sort((a, b) => compare(a.key, b.key));
}

const BARYCENTRIC: readonly (readonly [number, number, number])[] = Object.freeze([
  [1 / 3, 1 / 3, 1 / 3],
  [0.8, 0.1, 0.1],
  [0.1, 0.8, 0.1],
  [0.1, 0.1, 0.8],
]);
const anchor = (triangle: Triangle, weights: readonly [number, number, number]): V3 =>
  [0, 1, 2].map(
    (axis) =>
      triangle.points[0][axis] * weights[0] +
      triangle.points[1][axis] * weights[1] +
      triangle.points[2][axis] * weights[2],
  ) as unknown as V3;

function metricForElement(
  camera: Camera,
  group: ArticulationElementInput,
  target: readonly Triangle[],
  occluders: readonly Triangle[],
  policy: BuildingArticulationProxyPolicy,
) {
  const aspect = policy.viewport[0] / policy.viewport[1],
    selected = sampledTriangles(
      target,
      policy.maximumAnchorsPerElement,
      policy.deterministicOrdering === "codepoint-v1",
    ),
    projected: V2[] = [];
  let eligible = 0,
    visible = 0;
  const sampledNodes = new Set<string>();
  for (const triangle of selected) {
    if (
      policy.sampleBothTriangleSides !== true &&
      dot(triangle.normal, sub(camera.position, triangle.center)) <= (policy.facingEpsilon ?? 1e-9)
    )
      continue;
    sampledNodes.add(triangle.nodeId);
    for (const weights of BARYCENTRIC) {
      eligible++;
      const targetPoint = anchor(triangle, weights),
        ray = sub(targetPoint, camera.position),
        distance = length(ray),
        direction = scale(ray, 1 / distance),
        maximumHit = distance - policy.rayEpsilonM;
      let occluded = false;
      for (const candidate of occluders) {
        if (!rayIntersectsBounds(camera.position, direction, maximumHit, candidate.bounds)) continue;
        const hit = rayTriangleDistance(camera.position, direction, candidate);
        if (hit !== undefined && hit < maximumHit) {
          occluded = true;
          break;
        }
      }
      if (occluded) continue;
      const point = project(camera, targetPoint, aspect);
      if (!point) continue;
      visible++;
      projected.push(point.point);
    }
  }
  const visibleHull = hull(projected),
    bounds =
      projected.length === 0
        ? undefined
        : {
            minimum: [
              Math.min(...projected.map((point) => point[0])),
              Math.min(...projected.map((point) => point[1])),
            ] as V2,
            maximum: [
              Math.max(...projected.map((point) => point[0])),
              Math.max(...projected.map((point) => point[1])),
            ] as V2,
          };
  const width = bounds ? (bounds.maximum[0] - bounds.minimum[0]) / 2 : 0,
    height = bounds ? (bounds.maximum[1] - bounds.minimum[1]) / 2 : 0;
  return Object.freeze({
    elementId: group.id,
    sampledTriangleCount: selected.length,
    sampledNodeCount: sampledNodes.size,
    eligibleAnchorCount: eligible,
    visibleAnchorCount: visible,
    visibleFraction: round(eligible === 0 ? 0 : visible / eligible),
    visibleBounds: bounds
      ? Object.freeze({
          minimum: bounds.minimum.map(round) as unknown as V2,
          maximum: bounds.maximum.map(round) as unknown as V2,
        })
      : null,
    visibleWidthFraction: round(width),
    visibleHeightFraction: round(height),
    visibleBoundsAreaFraction: round(width * height),
    visibleHullAreaFraction: round(polygonArea(visibleHull) / 4),
    visibleHull: Object.freeze(visibleHull.map((point) => point.map(round) as unknown as V2)),
  });
}

function validatePolicy(policy: BuildingArticulationProxyPolicy, elementIds: readonly string[]) {
  if (
    !Array.isArray(policy.viewport) ||
    policy.viewport.length !== 2 ||
    !policy.viewport.every((value) => Number.isInteger(value) && value >= 256) ||
    policy.fovYDegrees < 20 ||
    policy.fovYDegrees > 80 ||
    policy.frameFillNdc <= 0.4 ||
    policy.frameFillNdc >= policy.safeFrameNdc ||
    policy.safeFrameNdc > 1 ||
    policy.nearM <= 0 ||
    !Number.isInteger(policy.maximumAnchorsPerElement) ||
    policy.maximumAnchorsPerElement < 32 ||
    policy.maximumAnchorsPerElement > 1024 ||
    policy.maximumAnchorsPerElement % 4 !== 0 ||
    policy.rayEpsilonM <= 0 ||
    policy.rayEpsilonM > 0.02 ||
    (policy.facingEpsilon !== undefined &&
      (!Number.isFinite(policy.facingEpsilon) || policy.facingEpsilon < 1e-9 || policy.facingEpsilon > 0.1)) ||
    (policy.deterministicOrdering !== undefined && policy.deterministicOrdering !== "codepoint-v1") ||
    (policy.sampleBothTriangleSides !== undefined && policy.sampleBothTriangleSides !== true)
  )
    throw new Error("articulation proxy camera/sampling policy is invalid");
  if (
    new Set(elementIds).size !== elementIds.length ||
    elementIds.length !== 3 ||
    elementIds.some((id) => !policy.elements[id])
  )
    throw new Error("articulation proxy requires exactly three uniquely governed elements");
  const expected = JSON.stringify(BUILDING_ARTICULATION_PROXY_VIEW_IDS);
  for (const element of Object.values(policy.elements))
    if (
      element.minimumVisibleAnchors < 4 ||
      element.minimumVisibleFraction <= 0 ||
      element.minimumVisibleFraction > 1 ||
      JSON.stringify([...new Set(element.requiredViewIds)]) !== JSON.stringify(element.requiredViewIds) ||
      element.requiredViewIds.some((id) => !BUILDING_ARTICULATION_PROXY_VIEW_IDS.includes(id as any))
    )
      throw new Error("articulation proxy element policy is invalid");
  const covered = new Set(Object.values(policy.elements).flatMap((element) => element.requiredViewIds));
  if (JSON.stringify([...BUILDING_ARTICULATION_PROXY_VIEW_IDS].filter((id) => covered.has(id))) !== expected)
    throw new Error("articulation proxy policy does not cover every required view");
}

export function createBuildingArticulationCpuProxy(input: BuildingArticulationProxyInput) {
  const elementIds = input.elements.map((element) => element.id);
  validatePolicy(input.policy, elementIds);
  if (
    ![input.facade.centerX, input.facade.halfWidth, input.facade.dormerCenterX, input.facade.canopyCenterX].every(
      finite,
    ) ||
    input.facade.halfWidth <= 0
  )
    throw new Error("articulation proxy facade authority is invalid");
  const geometry = parseGeometry(input.productionGlb, input.policy.deterministicOrdering === "codepoint-v1"),
    allIds = new Set(geometry.meshSemanticIds),
    used = new Set<string>();
  for (const element of input.elements) {
    if (
      element.semanticNodeIds.length === 0 ||
      new Set(element.semanticNodeIds).size !== element.semanticNodeIds.length
    )
      throw new Error(`articulation proxy element '${element.id}' has an empty or duplicate inventory`);
    for (const id of element.semanticNodeIds) {
      if (!allIds.has(id))
        throw new Error(`articulation proxy element '${element.id}' is missing semantic mesh '${id}'`);
      if (used.has(id)) throw new Error(`articulation proxy semantic mesh '${id}' belongs to multiple elements`);
      used.add(id);
    }
  }
  const presentationIds = geometry.meshSemanticIds.filter(
      (id) => !input.policy.presentationExcludedSemanticPrefixes.some((prefix) => id.startsWith(prefix)),
    ),
    presentationVertices = presentationIds.flatMap((id) => geometry.verticesByNode.get(id) ?? []);
  const subjectBounds = boundsOf(presentationVertices),
    opaque = geometry.triangles.filter((triangle) => triangle.opaque),
    targetByElement = new Map(
      input.elements.map((element) => [
        element.id,
        geometry.triangles.filter((triangle) => element.semanticNodeIds.includes(triangle.nodeId)),
      ]),
    );
  for (const [id, triangles] of targetByElement)
    if (triangles.length === 0) throw new Error(`articulation proxy element '${id}' has no triangles`);
  const sideScores = [-1, 1].map((side) => {
    const camera = deriveCamera("side-choice", subjectBounds, [side, 0.18, -1], input.policy),
      aspect = input.policy.viewport[0] / input.policy.viewport[1],
      points = input.elements.map(
        (element) =>
          project(
            camera,
            center3(boundsOf(element.semanticNodeIds.flatMap((id) => geometry.verticesByNode.get(id) ?? []))),
            aspect,
          )!.point,
      );
    let minimum = Infinity;
    for (let a = 0; a < points.length; a++)
      for (let b = a + 1; b < points.length; b++)
        minimum = Math.min(minimum, Math.hypot(points[a][0] - points[b][0], points[a][1] - points[b][1]));
    return { side, score: minimum };
  });
  sideScores.sort((a, b) => b.score - a.score || a.side - b.side);
  const selectedSide =
    input.policy.threeQuarterSide === "west" ? -1 : input.policy.threeQuarterSide === "east" ? 1 : sideScores[0].side;
  const cameras = [
    deriveCamera("front-elevation", subjectBounds, [0, 0, -1], input.policy),
    deriveCamera("front-three-quarter", subjectBounds, [selectedSide, 0.18, -1], input.policy),
    deriveCamera("roof-junctions", subjectBounds, [0.9 * selectedSide, 1.15, -0.65], input.policy),
  ];
  const aspect = input.policy.viewport[0] / input.policy.viewport[1],
    viewMetrics = cameras.map((camera) => {
      const subjectProjected = presentationVertices
          .map((point) => project(camera, point, aspect))
          .filter((value): value is Projected => value !== undefined),
        xs = subjectProjected.map((value) => value.point[0]),
        ys = subjectProjected.map((value) => value.point[1]);
      const projectedBounds = {
          minimum: [Math.min(...xs), Math.min(...ys)] as V2,
          maximum: [Math.max(...xs), Math.max(...ys)] as V2,
        },
        width = (projectedBounds.maximum[0] - projectedBounds.minimum[0]) / 2,
        height = (projectedBounds.maximum[1] - projectedBounds.minimum[1]) / 2;
      const elements = input.elements.map((element) =>
        metricForElement(camera, element, targetByElement.get(element.id)!, opaque, input.policy),
      );
      return Object.freeze({
        id: camera.id,
        camera: Object.freeze({
          position: camera.position.map(round) as unknown as V3,
          target: camera.target.map(round) as unknown as V3,
          fovYDegrees: camera.fovYDegrees,
          nearM: camera.nearM,
          farM: camera.farM,
          directionFromSubject: camera.directionFromSubject.map(round) as unknown as V3,
          azimuthDegrees: round(
            (Math.atan2(camera.directionFromSubject[0], -camera.directionFromSubject[2]) * 180) / Math.PI,
          ),
          elevationDegrees: round((Math.asin(camera.directionFromSubject[1]) * 180) / Math.PI),
        }),
        subject: Object.freeze({
          projectedBounds: Object.freeze({
            minimum: projectedBounds.minimum.map(round) as unknown as V2,
            maximum: projectedBounds.maximum.map(round) as unknown as V2,
          }),
          projectedWidthFraction: round(width),
          projectedHeightFraction: round(height),
          projectedBoundsAreaFraction: round(width * height),
          minimumDepthM: round(Math.min(...subjectProjected.map((value) => value.depth))),
          maximumDepthM: round(Math.max(...subjectProjected.map((value) => value.depth))),
        }),
        elements: Object.freeze(elements),
      });
    });
  const failures: string[] = [];
  const azimuth = (camera: Camera) =>
      (Math.atan2(camera.directionFromSubject[0], -camera.directionFromSubject[2]) * 180) / Math.PI,
    elevation = (camera: Camera) => (Math.asin(camera.directionFromSubject[1]) * 180) / Math.PI;
  if (Math.abs(azimuth(cameras[1]) - azimuth(cameras[0])) < 30) failures.push("camera-set:front-three-quarter-azimuth");
  if (Math.abs(elevation(cameras[2]) - elevation(cameras[1])) < 25)
    failures.push("camera-set:roof-junctions-elevation");
  for (const view of viewMetrics) {
    if (
      view.subject.projectedHeightFraction < input.policy.subjectCoverage.minimumHeightFraction ||
      view.subject.projectedHeightFraction > input.policy.subjectCoverage.maximumHeightFraction ||
      view.subject.projectedBoundsAreaFraction < input.policy.subjectCoverage.minimumBoundsAreaFraction ||
      Math.max(
        ...view.subject.projectedBounds.maximum.map(Math.abs),
        ...view.subject.projectedBounds.minimum.map(Math.abs),
      ) > input.policy.safeFrameNdc
    )
      failures.push(`${view.id}:subject-coverage`);
    for (const metric of view.elements) {
      const threshold = input.policy.elements[metric.elementId];
      if (!threshold.requiredViewIds.includes(view.id)) continue;
      if (
        metric.visibleAnchorCount < threshold.minimumVisibleAnchors ||
        metric.visibleFraction < threshold.minimumVisibleFraction ||
        metric.visibleWidthFraction < threshold.minimumWidthFraction ||
        metric.visibleHeightFraction < threshold.minimumHeightFraction ||
        metric.visibleBoundsAreaFraction < threshold.minimumBoundsAreaFraction ||
        !metric.visibleBounds ||
        Math.max(...metric.visibleBounds.maximum.map(Math.abs), ...metric.visibleBounds.minimum.map(Math.abs)) >
          input.policy.safeFrameNdc
      )
        failures.push(`${view.id}:${metric.elementId}-visibility`);
    }
  }
  const separations = input.policy.separation.pairs.map((pair) => {
    const view = viewMetrics.find((candidate) => candidate.id === pair.viewId)!,
      a = view.elements.find((element) => element.elementId === pair.a)!,
      b = view.elements.find((element) => element.elementId === pair.b)!,
      ah = a.visibleHull,
      bh = b.visibleHull,
      intersection = polygonArea(intersectConvex(ah, bh)),
      areaA = polygonArea(ah),
      areaB = polygonArea(bh),
      union = areaA + areaB - intersection,
      iou = union > 0 ? intersection / union : 1;
    const ac: V2 = a.visibleBounds
        ? [
            (a.visibleBounds.minimum[0] + a.visibleBounds.maximum[0]) / 2,
            (a.visibleBounds.minimum[1] + a.visibleBounds.maximum[1]) / 2,
          ]
        : [0, 0],
      bc: V2 = b.visibleBounds
        ? [
            (b.visibleBounds.minimum[0] + b.visibleBounds.maximum[0]) / 2,
            (b.visibleBounds.minimum[1] + b.visibleBounds.maximum[1]) / 2,
          ]
        : [0, 0],
      gap = polygonGap(ah, bh, intersection),
      distance = Math.hypot(ac[0] - bc[0], ac[1] - bc[1]);
    const pass =
      iou <= input.policy.separation.maximumHullIou &&
      (gap >= input.policy.separation.minimumEdgeGapNdc ||
        distance >= input.policy.separation.minimumCentroidDistanceNdc);
    if (!pass) failures.push(`${pair.viewId}:${pair.a}-${pair.b}-separation`);
    return Object.freeze({
      ...pair,
      hullIou: round(iou),
      edgeGapNdc: round(gap),
      centroidDistanceNdc: round(distance),
      pass,
    });
  });
  const dormerOffset = (input.facade.dormerCenterX - input.facade.centerX) / input.facade.halfWidth,
    canopyOffset = (input.facade.canopyCenterX - input.facade.centerX) / input.facade.halfWidth,
    mirrorResidual =
      Math.abs(
        input.facade.dormerCenterX - input.facade.centerX + (input.facade.canopyCenterX - input.facade.centerX),
      ) /
      (2 * input.facade.halfWidth);
  const front = viewMetrics.find((view) => view.id === "front-elevation")!,
    projectedCenterX = (front.subject.projectedBounds.minimum[0] + front.subject.projectedBounds.maximum[0]) / 2,
    projectedWidth = front.subject.projectedBounds.maximum[0] - front.subject.projectedBounds.minimum[0],
    projectedOffsets = ["dormer", "canopy"].map((id) => {
      const metric = front.elements.find((element) => element.elementId === id);
      if (!metric?.visibleBounds) return 0;
      return (
        ((metric.visibleBounds.minimum[0] + metric.visibleBounds.maximum[0]) / 2 - projectedCenterX) / projectedWidth
      );
    });
  const oppositeSides = dormerOffset * canopyOffset < 0 && projectedOffsets[0] * projectedOffsets[1] < 0,
    distinctOffsets =
      Math.abs(dormerOffset - canopyOffset) >= input.policy.asymmetry.minimumProjectedMagnitudeDifference &&
      Math.abs(projectedOffsets[0] - projectedOffsets[1]) >= input.policy.asymmetry.minimumProjectedMagnitudeDifference,
    asymmetryPass =
      (input.policy.asymmetry.requireOppositeSides === false ? distinctOffsets : oppositeSides) &&
      Math.min(Math.abs(dormerOffset), Math.abs(canopyOffset)) >=
        input.policy.asymmetry.minimumElementOffsetHalfWidth &&
      mirrorResidual >= input.policy.asymmetry.minimumMirrorResidual &&
      Math.abs(Math.abs(projectedOffsets[0]) - Math.abs(projectedOffsets[1])) >=
        input.policy.asymmetry.minimumProjectedMagnitudeDifference;
  if (!asymmetryPass) failures.push("front-elevation:facade-asymmetry");
  const cameraSet = cameras.map((camera) => ({
    id: camera.id,
    position: camera.position.map(round),
    target: camera.target.map(round),
    fovYDegrees: camera.fovYDegrees,
    nearM: camera.nearM,
    farM: camera.farM,
  }));
  const result = Object.freeze({
    schema: BUILDING_ARTICULATION_PROXY_SCHEMA,
    algorithm: "semantic-glb-triangle-raycast/v1",
    requiredViewIds: BUILDING_ARTICULATION_PROXY_VIEW_IDS,
    virtualViewport: input.policy.viewport,
    cameraDerivation: Object.freeze({
      frameFit: "exact-presentation-bounds-binary-fit",
      frameFillNdc: input.policy.frameFillNdc,
      selectedThreeQuarterSide: selectedSide < 0 ? "west" : "east",
      sideScores: Object.freeze(
        sideScores.map((entry) => ({
          side: entry.side < 0 ? "west" : "east",
          minimumProjectedCentroidSeparationNdc: round(entry.score),
        })),
      ),
      cameraSetHash: canonicalHash(sha256, cameraSet),
    }),
    inventory: Object.freeze({
      productionMeshSemanticCount: geometry.meshSemanticIds.length,
      productionTriangleCount: geometry.triangles.length,
      opaqueTriangleCount: opaque.length,
      presentationSemanticCount: presentationIds.length,
      presentationInventoryHash: canonicalHash(sha256, presentationIds),
      elements: Object.freeze(
        input.elements.map((element) => ({
          id: element.id,
          semanticNodeIds: Object.freeze([...element.semanticNodeIds]),
          semanticInventoryHash: canonicalHash(sha256, element.semanticNodeIds),
          triangleCount: targetByElement.get(element.id)!.length,
        })),
      ),
    }),
    subjectBounds: Object.freeze({
      minimum: subjectBounds.minimum.map(round) as unknown as V3,
      maximum: subjectBounds.maximum.map(round) as unknown as V3,
    }),
    views: Object.freeze(viewMetrics),
    separation: Object.freeze(separations),
    asymmetry: Object.freeze({
      facadeCenterX: input.facade.centerX,
      facadeHalfWidth: input.facade.halfWidth,
      dormerCenterX: input.facade.dormerCenterX,
      canopyCenterX: input.facade.canopyCenterX,
      dormerOffsetHalfWidth: round(dormerOffset),
      canopyOffsetHalfWidth: round(canopyOffset),
      mirrorResidual: round(mirrorResidual),
      projectedDormerOffsetFullWidth: round(projectedOffsets[0]),
      projectedCanopyOffsetFullWidth: round(projectedOffsets[1]),
      pass: asymmetryPass,
    }),
    mechanicalVerdict: failures.length === 0 ? "mechanically-sufficient-for-v3-site-review" : "fail",
    failures: Object.freeze([...new Set(failures)].sort()),
    claims: Object.freeze({
      renderingPerformed: false,
      gpuUsed: false,
      framebufferEvidence: false,
      pixelEvidence: false,
      visualQualityClaimed: false,
      siteFitClaimed: false,
      humanDecision: "pending",
    }),
  });
  return Object.freeze({ ...result, proxyHash: canonicalHash(sha256, result as unknown as JsonValue) });
}

export function validateBuildingArticulationCpuProxy(value: any) {
  if (
    value?.schema !== BUILDING_ARTICULATION_PROXY_SCHEMA ||
    value.algorithm !== "semantic-glb-triangle-raycast/v1" ||
    JSON.stringify(value.requiredViewIds) !== JSON.stringify(BUILDING_ARTICULATION_PROXY_VIEW_IDS) ||
    !/^sha256:[0-9a-f]{64}$/.test(value.proxyHash)
  )
    throw new Error("building articulation CPU proxy identity is invalid");
  if (
    value.claims?.renderingPerformed !== false ||
    value.claims?.gpuUsed !== false ||
    value.claims?.framebufferEvidence !== false ||
    value.claims?.pixelEvidence !== false ||
    value.claims?.visualQualityClaimed !== false ||
    value.claims?.siteFitClaimed !== false ||
    value.claims?.humanDecision !== "pending"
  )
    throw new Error("building articulation CPU proxy makes an unauthorized visual/GPU/site claim");
  if (
    !Array.isArray(value.views) ||
    JSON.stringify(value.views.map((view: any) => view.id)) !== JSON.stringify(BUILDING_ARTICULATION_PROXY_VIEW_IDS) ||
    value.views.some((view: any) => !Array.isArray(view.elements) || view.elements.length !== 3)
  )
    throw new Error("building articulation CPU proxy view coverage is incomplete");
  const { proxyHash, ...core } = value;
  if (canonicalHash(sha256, core) !== proxyHash) throw new Error("building articulation CPU proxy hash drifted");
  if (value.mechanicalVerdict === "mechanically-sufficient-for-v3-site-review" && value.failures.length !== 0)
    throw new Error("building articulation CPU proxy pass retains failures");
  return Object.freeze(value);
}

export function verifyBuildingArticulationCpuProxyEvidence(value: any, read: (path: string) => Uint8Array) {
  const evidence: any = validateBuildingArticulationCpuProxy(value);
  const exact = (entry: any, label: string) => {
    if (
      !entry?.path ||
      !/^sha256:[0-9a-f]{64}$/.test(entry.sha256) ||
      !/^sha256:[0-9a-f]{64}$/.test(entry.contentHash) ||
      !Number.isSafeInteger(entry.bytes) ||
      entry.bytes < 1
    )
      throw new Error(`articulation proxy ${label} identity is invalid`);
    const bytes = read(entry.path);
    if (
      bytes.byteLength !== entry.bytes ||
      `sha256:${sha256(bytes)}` !== entry.sha256 ||
      portableAssetContentHash(bytes) !== entry.contentHash
    )
      throw new Error(`articulation proxy ${label} exact bytes drifted`);
    return bytes;
  };
  const authority = evidence.authority;
  if (!authority?.candidateManifest || !authority.productionGlb || !authority.architectureSpec)
    throw new Error("articulation proxy authority closure is incomplete");
  const manifest = JSON.parse(
    new TextDecoder("utf8", { fatal: true }).decode(exact(authority.candidateManifest, "candidate manifest")),
  );
  for (const [entry, label] of [
    [authority.program, "program"],
    [authority.visualDesign, "visual design"],
    [authority.cueProfile, "cue profile"],
    [authority.synthesisEvidence, "synthesis evidence"],
    [authority.architectureSpec, "architecture spec"],
    [authority.productionGlb, "production GLB"],
  ])
    exact(entry, label as string);
  if (
    manifest.candidateId !== authority.candidateManifest.candidateId ||
    manifest.compiler?.irHash !== authority.compiler?.irHash ||
    manifest.compiler?.specHash !== authority.compiler?.specHash ||
    manifest.files?.find((entry: any) => entry.role === "productionGlb")?.sha256 !== authority.productionGlb.sha256
  )
    throw new Error("articulation proxy authority drifted from candidate manifest");
  if (canonicalHash(sha256, evidence.policy as JsonValue) !== evidence.policyHash)
    throw new Error("articulation proxy policy hash drifted");
  if (evidence.functionalClosure !== undefined) {
    if (manifest.schema !== "limina.fb4-multi-room-production-candidate/v3" || !authority.architectureIr)
      throw new Error("FB4 V3 articulation functional closure lacks V3 manifest/architecture authority");
    const architectureIrBytes = exact(authority.architectureIr, "architecture IR"),
      architectureIr = JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(architectureIrBytes));
    if (architectureIr.specHash !== authority.compiler.specHash || architectureIr.irHash !== authority.compiler.irHash)
      throw new Error("FB4 V3 articulation architecture IR compiler hashes drifted");
    const recomputed = createFb4V3ArticulationFunctionalClosure(
      read(authority.productionGlb.path),
      architectureIrBytes,
    );
    if (
      canonicalHash(sha256, recomputed as unknown as JsonValue) !==
      canonicalHash(sha256, evidence.functionalClosure as JsonValue)
    )
      throw new Error("FB4 V3 articulation functional closure recomputation drifted");
  }
  const elements = (evidence.inventory?.elements ?? []).map((entry: any) => ({
    id: entry.id,
    semanticNodeIds: entry.semanticNodeIds,
  }));
  const facade = {
    centerX: evidence.asymmetry?.facadeCenterX,
    halfWidth: evidence.asymmetry?.facadeHalfWidth,
    dormerCenterX: evidence.asymmetry?.dormerCenterX,
    canopyCenterX: evidence.asymmetry?.canopyCenterX,
  };
  const computed = createBuildingArticulationCpuProxy({
      productionGlb: read(authority.productionGlb.path),
      policy: evidence.policy,
      elements,
      facade,
    }),
    { proxyHash: analysisHash, ...computedCore } = computed;
  const {
    authority: _authority,
    implementation,
    policy: _policy,
    policyHash: _policyHash,
    reviewBoundary: _boundary,
    functionalClosure: _functionalClosure,
    proxyHash: _evidenceHash,
    ...recordedCore
  } = evidence;
  if (
    analysisHash !== implementation?.analysisHash ||
    canonicalHash(sha256, computedCore as unknown as JsonValue) !== canonicalHash(sha256, recordedCore as JsonValue)
  )
    throw new Error("articulation proxy recomputation drifted from exact production GLB");
  return evidence;
}
