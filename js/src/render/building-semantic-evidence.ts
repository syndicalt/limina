import { canonicalHash, type JsonValue } from "../authoring/canonical.ts";
import { portableAssetContentHash } from "../world/asset-content-hash.mjs";
import { sha256 } from "../world/sha256.mjs";

type V2 = readonly [number, number];
type V3 = readonly [number, number, number];
type V4 = readonly [number, number, number, number];
type M4 = readonly number[];
type Bounds3 = Readonly<{ minimum: V3; maximum: V3 }>;

export const BUILDING_SEMANTIC_EVIDENCE_SCHEMA = "limina.building-semantic-cpu-evidence/v2" as const;
export const BUILDING_SEMANTIC_CLAIM_IDS = Object.freeze([
  "gable-upper-window",
  "entry-canopy",
  "passage-fireplace",
  "stair-circulation",
  "upper-circulation",
] as const);

export type BuildingSemanticClaimId = (typeof BUILDING_SEMANTIC_CLAIM_IDS)[number];
export type BuildingSemanticFacade = "left-gable" | "right-gable" | "entry" | "rear" | "interior";

export interface ExactSemanticEvidenceFile {
  readonly path: string;
  readonly sha256: string;
  readonly contentHash: string;
  readonly bytes: number;
}

export interface BuildingSemanticCamera {
  readonly position: V3;
  readonly target: V3;
  readonly fovYDegrees: number;
  readonly nearM: number;
  readonly farM: number;
}

export interface BuildingSemanticGlbTarget {
  readonly kind: "glb-semantic-group";
  readonly id: string;
  readonly nodeIds: readonly string[];
  readonly architectureOwnerId: string;
  /** Optional functional room whose floor region this group must overlap. */
  readonly architectureRegionId?: string;
}

export interface BuildingSemanticPortalWitness {
  readonly kind: "functional-portal-witness";
  readonly id: string;
  readonly portalId: string;
}

export interface BuildingSemanticHeadroomWitness {
  readonly kind: "stair-headroom-witness";
  readonly id: string;
  readonly stairId: string;
}

export interface BuildingSemanticTopArrivalWitness {
  readonly kind: "stair-top-arrival-witness";
  readonly id: string;
  readonly stairId: string;
}

export interface BuildingSemanticRoomFloorWitness {
  readonly kind: "functional-room-floor-witness";
  readonly id: string;
  readonly roomId: string;
}

export type BuildingSemanticTarget =
  | BuildingSemanticGlbTarget
  | BuildingSemanticPortalWitness
  | BuildingSemanticHeadroomWitness
  | BuildingSemanticTopArrivalWitness
  | BuildingSemanticRoomFloorWitness;

export interface BuildingSemanticClaimPolicy {
  readonly id: BuildingSemanticClaimId;
  readonly viewId: string;
  readonly expectedFacade: BuildingSemanticFacade;
  readonly viewedFacade: BuildingSemanticFacade;
  /** Required only for exterior claims. Points from the subject toward the camera. */
  readonly exteriorNormal?: V3;
  readonly camera: BuildingSemanticCamera;
  /** Functional door IDs to evaluate at the exact GLB open-animation endpoint. */
  readonly openDoorIds?: readonly string[];
  readonly targets: Readonly<Record<string, readonly BuildingSemanticTarget[]>>;
}

export interface BuildingSemanticEvidencePolicy {
  readonly schema: "limina.building-semantic-evidence-policy/v2";
  readonly viewport: readonly [number, number];
  readonly safeFrameNdc: number;
  readonly minimumVisibleAnchors: number;
  readonly minimumVisibleFraction: number;
  readonly minimumProjectedWidthNdc: number;
  readonly minimumProjectedHeightNdc: number;
  readonly maximumTrianglesPerTarget: number;
  readonly rayEpsilonM: number;
  readonly minimumFacadeAlignmentDot: number;
  readonly claims: readonly BuildingSemanticClaimPolicy[];
}

export interface BuildingSemanticEvidenceInput {
  readonly candidateId: string;
  readonly architectureId: string;
  readonly candidateManifest: Readonly<{ file: ExactSemanticEvidenceFile; bytes: Uint8Array }>;
  readonly architectureIr: Readonly<{ file: ExactSemanticEvidenceFile; bytes: Uint8Array }>;
  readonly productionGlb: Readonly<{ file: ExactSemanticEvidenceFile; bytes: Uint8Array }>;
  readonly policy: BuildingSemanticEvidencePolicy;
}

interface Triangle {
  readonly nodeId: string;
  readonly points: readonly [V3, V3, V3];
  readonly center: V3;
  readonly normal: V3;
  readonly bounds: Bounds3;
  readonly opaque: boolean;
  readonly key: string;
}

interface Geometry {
  readonly triangles: readonly Triangle[];
  readonly trianglesByNode: ReadonlyMap<string, readonly Triangle[]>;
  readonly verticesByNode: ReadonlyMap<string, readonly V3[]>;
  readonly semanticIds: readonly string[];
  readonly provenanceByNode: ReadonlyMap<
    string,
    Readonly<{ ownerId: string; derivedFrom: readonly string[]; role: string; editPolicy: string }>
  >;
}

const REQUIRED_ROLES: Readonly<Record<BuildingSemanticClaimId, Readonly<Record<string, number>>>> = Object.freeze({
  "gable-upper-window": Object.freeze({ glass: 1, frame: 4 }),
  // The two exact posts are one support assembly target. The attached service gable legitimately
  // occludes the west post from the single entry/window evidence view, while group provenance still
  // requires both compiler-owned post meshes and visibility still requires the assembly itself.
  "entry-canopy": Object.freeze({
    roof: 1,
    header: 1,
    "knee-brace": 2,
    post: 1,
    "adjacent-window-glass": 1,
    "adjacent-window-frame": 4,
  }),
  "passage-fireplace": Object.freeze({
    "passage-aperture": 1,
    "fireplace-hearth": 1,
    "fireplace-firebox": 1,
    "fireplace-mantle": 1,
    "fireplace-surround": 1,
  }),
  "stair-circulation": Object.freeze({
    "bottom-landing": 1,
    "stair-low-extreme": 1,
    "stair-high-extreme": 1,
    "top-landing": 1,
    "headroom-clearance": 1,
  }),
  // One coherent open-door route from the landing into an upper room is the visual claim.
  // Exhaustive bidirectional traversal of both upper doors remains the native topology gate;
  // requiring both opposing frames in one interior camera creates an impossible >180-degree view.
  "upper-circulation": Object.freeze({
    "upper-landing": 1,
    "access-frame": 1,
    "upper-window-glass": 1,
    "upper-window-frame": 4,
  }),
});
const OPTIONAL_ADDITIVE_ROLES: Readonly<Partial<Record<BuildingSemanticClaimId, readonly string[]>>> = Object.freeze({
  "passage-fireplace": Object.freeze(["fireplace-flue-transition"]),
  "stair-circulation": Object.freeze(["stair-turn-landing"]),
});

const HASH = /^sha256:[0-9a-f]{64}$/;
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const round = (value: number) => Number(value.toFixed(9));
const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const scale = (a: V3, amount: number): V3 => [a[0] * amount, a[1] * amount, a[2] * amount];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const magnitude = (a: V3) => Math.hypot(a[0], a[1], a[2]);
const normalize = (a: V3): V3 => {
  const length = magnitude(a);
  if (length < 1e-12) throw new Error("semantic evidence vector is degenerate");
  return scale(a, 1 / length);
};
const vec3 = (value: unknown): value is V3 => Array.isArray(value) && value.length === 3 && value.every(finite);
const vec4 = (value: unknown): value is V4 => Array.isArray(value) && value.length === 4 && value.every(finite);

function exactFile(file: ExactSemanticEvidenceFile, bytes: Uint8Array, label: string) {
  if (
    !file?.path ||
    !HASH.test(file.sha256) ||
    !HASH.test(file.contentHash) ||
    !Number.isSafeInteger(file.bytes) ||
    file.bytes < 1
  )
    throw new Error(`semantic evidence ${label} identity is invalid`);
  if (
    bytes.byteLength !== file.bytes ||
    `sha256:${sha256(bytes)}` !== file.sha256 ||
    portableAssetContentHash(bytes) !== file.contentHash
  )
    throw new Error(`semantic evidence ${label} exact bytes drifted`);
}

const identity = (): number[] => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const multiply = (a: M4, b: M4): number[] =>
  Array.from({ length: 16 }, (_, index) => {
    const row = index % 4,
      column = Math.floor(index / 4);
    let value = 0;
    for (let inner = 0; inner < 4; inner++) value += a[inner * 4 + row] * b[column * 4 + inner];
    return value;
  });
const localMatrix = (node: any, rotationOverride?: V4): number[] => {
  if (node.matrix !== undefined) {
    if (rotationOverride !== undefined) throw new Error("semantic evidence cannot pose an animated matrix node");
    if (!Array.isArray(node.matrix) || node.matrix.length !== 16 || !node.matrix.every(finite))
      throw new Error("semantic evidence GLB node matrix is invalid");
    return [...node.matrix];
  }
  const [x, y, z, w] = rotationOverride ?? node.rotation ?? [0, 0, 0, 1],
    [sx, sy, sz] = node.scale ?? [1, 1, 1],
    [tx, ty, tz] = node.translation ?? [0, 0, 0];
  if (![x, y, z, w, sx, sy, sz, tx, ty, tz].every(finite))
    throw new Error("semantic evidence GLB node transform is non-finite");
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
  if (bytes.byteLength < 20) throw new Error("semantic evidence requires exact GLB 2.0 bytes");
  const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (
    data.getUint32(0, true) !== 0x46546c67 ||
    data.getUint32(4, true) !== 2 ||
    data.getUint32(8, true) !== bytes.byteLength
  )
    throw new Error("semantic evidence requires an exact GLB 2.0 envelope");
  let offset = 12,
    document: any,
    binary: Uint8Array | undefined;
  while (offset < bytes.byteLength) {
    if (offset + 8 > bytes.byteLength) throw new Error("semantic evidence GLB chunk header is truncated");
    const length = data.getUint32(offset, true),
      type = data.getUint32(offset + 4, true);
    offset += 8;
    if (offset + length > bytes.byteLength) throw new Error("semantic evidence GLB chunk is truncated");
    const chunk = bytes.subarray(offset, offset + length);
    if (type === 0x4e4f534a) {
      if (document !== undefined) throw new Error("semantic evidence GLB duplicates JSON");
      document = JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(chunk).trimEnd());
    } else if (type === 0x004e4942) {
      if (binary !== undefined) throw new Error("semantic evidence GLB duplicates BIN");
      binary = chunk;
    }
    offset += length;
  }
  if (document === undefined || binary === undefined)
    throw new Error("semantic evidence GLB lacks JSON or BIN geometry");
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
    throw new Error(`semantic evidence accessor ${accessorIndex} is unsupported`);
  const bytes = COMPONENT_BYTES[accessor.componentType],
    components = TYPE_COMPONENTS[accessor.type];
  if (!bytes || !components || row < 0 || row >= accessor.count || component < 0 || component >= components)
    throw new Error(`semantic evidence accessor ${accessorIndex} is invalid`);
  const offset =
    (view.byteOffset ?? 0) +
    (accessor.byteOffset ?? 0) +
    row * (view.byteStride ?? bytes * components) +
    component * bytes;
  if (offset < 0 || offset + bytes > binary.byteLength)
    throw new Error(`semantic evidence accessor ${accessorIndex} leaves BIN bounds`);
  const data = new DataView(binary.buffer, binary.byteOffset + offset, bytes);
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
      throw new Error("unreachable semantic evidence accessor type");
  }
}

interface ResolvedDoorPose {
  readonly doorId: string;
  readonly portalId: string;
  readonly compilerClosedYaw: number;
  readonly compilerOpenYaw: number;
  readonly animationName: string;
  readonly targetNodeIndex: number;
  readonly inputAccessor: number;
  readonly outputAccessor: number;
  readonly endpointTime: number;
  readonly quaternion: V4;
  readonly poseHash: string;
}

function resolveOpenDoorPoses(
  parsed: ReturnType<typeof parseGlb>,
  architecture: ReturnType<typeof architectureIdentity>,
  doorIds: readonly string[],
): readonly ResolvedDoorPose[] {
  const { document, binary } = parsed,
    nodes = document.nodes ?? [],
    animations = document.animations ?? [];
  return Object.freeze(
    [...doorIds].sort().map((doorId) => {
      const doors = architecture.value.functionalContract.doors?.filter((entry: any) => entry.id === doorId);
      if (doors?.length !== 1)
        throw new Error(`semantic evidence open door '${doorId}' lacks one exact compiler functional door`);
      const door = doors[0],
        portals = architecture.value.functionalContract.portals?.filter(
          (entry: any) => entry.id === door.portalId && entry.kind === "door" && entry.doorId === doorId,
        );
      if (
        typeof door.portalId !== "string" ||
        portals?.length !== 1 ||
        !finite(door.closedYaw) ||
        !finite(door.openYaw)
      )
        throw new Error(`semantic evidence open door '${doorId}' lacks an exact compiler door/portal binding`);
      const animationName = `${doorId}/open`,
        matches = animations
          .map((entry: any, index: number) => ({ entry, index }))
          .filter(({ entry }: any) => entry?.name === animationName);
      if (matches.length !== 1)
        throw new Error(`semantic evidence open door '${doorId}' lacks one exact GLB '${animationName}' animation`);
      const animation = matches[0].entry;
      if (
        !Array.isArray(animation.channels) ||
        animation.channels.length !== 1 ||
        !Array.isArray(animation.samplers) ||
        animation.samplers.length !== 1
      )
        throw new Error(`semantic evidence door animation '${animationName}' must contain one exact rotation channel`);
      const channel = animation.channels[0],
        samplerIndex = channel?.sampler,
        targetNodeIndex = channel?.target?.node;
      if (
        samplerIndex !== 0 ||
        channel?.target?.path !== "rotation" ||
        !Number.isSafeInteger(targetNodeIndex) ||
        nodes[targetNodeIndex] === undefined
      )
        throw new Error(`semantic evidence door animation '${animationName}' channel is invalid`);
      const node = nodes[targetNodeIndex],
        semanticId = node.extras?.limina?.id ?? node.extras?.["limina.id"];
      if (
        semanticId !== doorId ||
        node.extras?.limina?.role !== "door" ||
        node.extras?.["limina.owner"] !== doorId ||
        !Array.isArray(node.extras?.["limina.derivedFrom"]) ||
        !node.extras["limina.derivedFrom"].includes(doorId)
      )
        throw new Error(
          `semantic evidence door animation '${animationName}' does not target its exact compiler-owned semantic door root`,
        );
      const sampler = animation.samplers[0],
        inputAccessor = sampler?.input,
        outputAccessor = sampler?.output,
        input = document.accessors?.[inputAccessor],
        output = document.accessors?.[outputAccessor];
      if (
        sampler?.interpolation !== "LINEAR" ||
        !Number.isSafeInteger(inputAccessor) ||
        !Number.isSafeInteger(outputAccessor) ||
        input?.componentType !== 5126 ||
        input.type !== "SCALAR" ||
        input.sparse !== undefined ||
        !Number.isSafeInteger(input.count) ||
        input.count < 2 ||
        output?.componentType !== 5126 ||
        output.type !== "VEC4" ||
        output.sparse !== undefined ||
        output.count !== input.count
      )
        throw new Error(`semantic evidence door animation '${animationName}' sampler is invalid`);
      let previous = -Infinity;
      for (let row = 0; row < input.count; row++) {
        const time = accessorValue(document, binary, inputAccessor, row, 0);
        if (!finite(time) || time <= previous)
          throw new Error(`semantic evidence door animation '${animationName}' times are invalid`);
        previous = time;
      }
      const raw = [0, 1, 2, 3].map((component) =>
        accessorValue(document, binary, outputAccessor, output.count - 1, component),
      );
      if (!vec4(raw))
        throw new Error(`semantic evidence door animation '${animationName}' endpoint quaternion is invalid`);
      const length = Math.hypot(...raw);
      if (Math.abs(length - 1) > 1e-4)
        throw new Error(`semantic evidence door animation '${animationName}' endpoint quaternion is not normalized`);
      const quaternion = Object.freeze(raw.map((value) => value / length)) as unknown as V4;
      const halfDelta = (door.openYaw - door.closedYaw) / 2,
        expected: V4 = [0, Math.sin(halfDelta), 0, Math.cos(halfDelta)];
      if (
        Math.abs(
          dot(quaternion.slice(0, 3) as unknown as V3, expected.slice(0, 3) as unknown as V3) +
            quaternion[3] * expected[3],
        ) <
        1 - 1e-4
      )
        throw new Error(
          `semantic evidence door animation '${animationName}' endpoint disagrees with the exact compiler open pose`,
        );
      const source = Object.freeze({
        doorId,
        portalId: door.portalId,
        compilerClosedYaw: round(door.closedYaw),
        compilerOpenYaw: round(door.openYaw),
        animationName,
        targetNodeIndex,
        inputAccessor,
        outputAccessor,
        endpointTime: round(previous),
        quaternion: quaternion.map(round),
      }) as unknown as JsonValue;
      return Object.freeze({
        ...(source as unknown as Omit<ResolvedDoorPose, "poseHash">),
        quaternion,
        poseHash: canonicalHash(sha256, source),
      });
    }),
  );
}

function boundsOf(points: readonly V3[]): Bounds3 {
  if (points.length === 0) throw new Error("semantic evidence cannot bound empty geometry");
  return Object.freeze({
    minimum: [0, 1, 2].map((axis) => Math.min(...points.map((point) => point[axis]))) as unknown as V3,
    maximum: [0, 1, 2].map((axis) => Math.max(...points.map((point) => point[axis]))) as unknown as V3,
  });
}

function parseGeometry(
  parsed: ReturnType<typeof parseGlb>,
  rotationOverrides: ReadonlyMap<number, V4> = new Map(),
): Geometry {
  const { document, binary } = parsed,
    nodes = document.nodes ?? [];
  const parents = new Map<number, number>();
  for (let parent = 0; parent < nodes.length; parent++)
    for (const child of nodes[parent].children ?? []) {
      if (!Number.isInteger(child) || nodes[child] === undefined || parents.has(child))
        throw new Error("semantic evidence GLB hierarchy is invalid or multiply parented");
      parents.set(child, parent);
    }
  const memo = new Map<number, number[]>(),
    active = new Set<number>();
  const world = (index: number): number[] => {
    const cached = memo.get(index);
    if (cached) return cached;
    if (active.has(index)) throw new Error("semantic evidence GLB hierarchy is cyclic");
    active.add(index);
    const parent = parents.get(index),
      value =
        parent === undefined
          ? localMatrix(nodes[index], rotationOverrides.get(index))
          : multiply(world(parent), localMatrix(nodes[index], rotationOverrides.get(index)));
    active.delete(index);
    memo.set(index, value);
    return value;
  };
  const semantic = new Map<string, number>(),
    provenanceByNode = new Map<
      string,
      Readonly<{ ownerId: string; derivedFrom: readonly string[]; role: string; editPolicy: string }>
    >();
  for (let index = 0; index < nodes.length; index++) {
    const extras = nodes[index].extras,
      id = extras?.limina?.id ?? extras?.["limina.id"];
    if (typeof id !== "string") continue;
    if (semantic.has(id)) throw new Error(`semantic evidence GLB duplicates target '${id}'`);
    semantic.set(id, index);
    provenanceByNode.set(
      id,
      Object.freeze({
        ownerId: extras?.["limina.owner"],
        derivedFrom: Object.freeze(
          Array.isArray(extras?.["limina.derivedFrom"]) ? [...extras["limina.derivedFrom"]] : [],
        ),
        role: extras?.["limina.role"],
        editPolicy: extras?.["limina.editPolicy"],
      }),
    );
  }
  const triangles: Triangle[] = [],
    verticesByNode = new Map<string, V3[]>();
  for (const [nodeId, index] of [...semantic].sort(([a], [b]) => a.localeCompare(b))) {
    const node = nodes[index],
      mesh = document.meshes?.[node.mesh];
    if (!mesh) continue;
    const vertices: V3[] = [];
    verticesByNode.set(nodeId, vertices);
    for (let primitiveIndex = 0; primitiveIndex < (mesh.primitives?.length ?? 0); primitiveIndex++) {
      const primitive = mesh.primitives[primitiveIndex];
      if ((primitive.mode ?? 4) !== 4) throw new Error(`semantic evidence target '${nodeId}' is not triangles`);
      const positionsIndex = primitive.attributes?.POSITION,
        positions = document.accessors?.[positionsIndex];
      if (positionsIndex === undefined || positions?.componentType !== 5126 || positions.type !== "VEC3")
        throw new Error(`semantic evidence target '${nodeId}' lacks float VEC3 positions`);
      const indices = primitive.indices === undefined ? undefined : document.accessors?.[primitive.indices];
      if (indices && (indices.type !== "SCALAR" || ![5121, 5123, 5125].includes(indices.componentType)))
        throw new Error(`semantic evidence target '${nodeId}' has unsupported indices`);
      const count = indices?.count ?? positions.count;
      if (count % 3 !== 0) throw new Error(`semantic evidence target '${nodeId}' has incomplete triangles`);
      const at = (row: number) => (indices ? accessorValue(document, binary, primitive.indices, row, 0) : row);
      const vertex = (row: number): V3 =>
        transform(world(index), [
          accessorValue(document, binary, positionsIndex, row, 0),
          accessorValue(document, binary, positionsIndex, row, 1),
          accessorValue(document, binary, positionsIndex, row, 2),
        ]);
      const material = document.materials?.[primitive.material],
        opaque = material?.alphaMode !== "BLEND";
      for (let triangleIndex = 0; triangleIndex < count / 3; triangleIndex++) {
        const row = triangleIndex * 3,
          points = [vertex(at(row)), vertex(at(row + 1)), vertex(at(row + 2))] as [V3, V3, V3];
        vertices.push(...points);
        const rawNormal = cross(sub(points[1], points[0]), sub(points[2], points[0])),
          length = magnitude(rawNormal);
        if (length <= 1e-12) continue;
        triangles.push(
          Object.freeze({
            nodeId,
            points,
            center: scale(add(add(points[0], points[1]), points[2]), 1 / 3),
            normal: scale(rawNormal, 1 / length),
            bounds: boundsOf(points),
            opaque,
            key: `${nodeId}\u0000${primitiveIndex.toString().padStart(4, "0")}\u0000${triangleIndex.toString().padStart(8, "0")}`,
          }),
        );
      }
    }
  }
  const byNode = new Map<string, Triangle[]>();
  for (const triangle of triangles) {
    const values = byNode.get(triangle.nodeId) ?? [];
    values.push(triangle);
    byNode.set(triangle.nodeId, values);
  }
  return Object.freeze({
    triangles: Object.freeze(triangles),
    trianglesByNode: byNode,
    verticesByNode,
    semanticIds: Object.freeze([...verticesByNode.keys()].sort()),
    provenanceByNode,
  });
}

const cameraBasis = (camera: BuildingSemanticCamera) => {
  const forward = normalize(sub(camera.target, camera.position)),
    right = normalize(cross(forward, [0, 1, 0])),
    up = normalize(cross(right, forward));
  return { forward, right, up };
};
function project(
  camera: BuildingSemanticCamera,
  point: V3,
  aspect: number,
): Readonly<{ point: V2; depth: number }> | undefined {
  const { forward, right, up } = cameraBasis(camera),
    relative = sub(point, camera.position),
    depth = dot(relative, forward);
  if (depth <= camera.nearM || depth >= camera.farM) return undefined;
  const tangent = Math.tan((camera.fovYDegrees * Math.PI) / 360);
  return Object.freeze({
    point: [dot(relative, right) / (depth * tangent * aspect), dot(relative, up) / (depth * tangent)] as V2,
    depth,
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

const exactKeys = (value: unknown, expected: readonly string[], label: string) => {
  if (
    value === null ||
    typeof value !== "object" ||
    JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...expected].sort())
  )
    throw new Error(`semantic evidence ${label} keys are invalid`);
};
function validatePolicy(policy: BuildingSemanticEvidencePolicy) {
  const claims: readonly BuildingSemanticClaimPolicy[] = policy.claims;
  if (
    policy?.schema !== "limina.building-semantic-evidence-policy/v2" ||
    !Array.isArray(policy.viewport) ||
    policy.viewport.length !== 2 ||
    !policy.viewport.every((entry) => Number.isInteger(entry) && entry >= 256) ||
    !finite(policy.safeFrameNdc) ||
    policy.safeFrameNdc <= 0.5 ||
    policy.safeFrameNdc > 1 ||
    !Number.isSafeInteger(policy.minimumVisibleAnchors) ||
    policy.minimumVisibleAnchors < 1 ||
    !finite(policy.minimumVisibleFraction) ||
    policy.minimumVisibleFraction <= 0 ||
    policy.minimumVisibleFraction > 1 ||
    !finite(policy.minimumProjectedWidthNdc) ||
    policy.minimumProjectedWidthNdc <= 0 ||
    !finite(policy.minimumProjectedHeightNdc) ||
    policy.minimumProjectedHeightNdc <= 0 ||
    !Number.isSafeInteger(policy.maximumTrianglesPerTarget) ||
    policy.maximumTrianglesPerTarget < 2 ||
    policy.maximumTrianglesPerTarget > 512 ||
    !finite(policy.rayEpsilonM) ||
    policy.rayEpsilonM <= 0 ||
    policy.rayEpsilonM > 0.02 ||
    !finite(policy.minimumFacadeAlignmentDot) ||
    policy.minimumFacadeAlignmentDot < 0.5 ||
    policy.minimumFacadeAlignmentDot > 1
  )
    throw new Error("semantic evidence policy thresholds are invalid");
  if (
    !Array.isArray(policy.claims) ||
    policy.claims.map((claim) => claim.id).join(",") !== BUILDING_SEMANTIC_CLAIM_IDS.join(",") ||
    new Set(policy.claims.map((claim) => claim.viewId)).size !== policy.claims.length
  )
    throw new Error("semantic evidence policy requires the canonical five claim views in order");
  const targetIds = new Set<string>(),
    nodeIds = new Set<string>();
  for (const claim of claims) {
    const claimKeys = [
      "id",
      "viewId",
      "expectedFacade",
      "viewedFacade",
      "camera",
      "targets",
      ...(claim.exteriorNormal === undefined ? [] : ["exteriorNormal"]),
      ...(claim.openDoorIds === undefined ? [] : ["openDoorIds"]),
    ];
    exactKeys(claim, claimKeys, `claim '${claim.id}'`);
    exactKeys(claim.camera, ["position", "target", "fovYDegrees", "nearM", "farM"], `claim '${claim.id}' camera`);
    const roles = REQUIRED_ROLES[claim.id],
      expectedRoles = Object.keys(roles).sort(),
      actualRoles = Object.keys(claim.targets ?? {}).sort(),
      allowedRoles = new Set([...expectedRoles, ...(OPTIONAL_ADDITIVE_ROLES[claim.id] ?? [])]);
    if (
      expectedRoles.some((role) => !actualRoles.includes(role)) ||
      actualRoles.some((role) => !allowedRoles.has(role))
    )
      throw new Error(`semantic evidence claim '${claim.id}' role inventory is incomplete`);
    if (
      !claim.viewId ||
      claim.viewedFacade !== claim.expectedFacade ||
      !vec3(claim.camera?.position) ||
      !vec3(claim.camera?.target) ||
      !finite(claim.camera.fovYDegrees) ||
      claim.camera.fovYDegrees < 20 ||
      claim.camera.fovYDegrees > 120 ||
      !finite(claim.camera.nearM) ||
      claim.camera.nearM <= 0 ||
      !finite(claim.camera.farM) ||
      claim.camera.farM <= claim.camera.nearM
    )
      throw new Error(`semantic evidence claim '${claim.id}' camera/facade authority is invalid`);
    if (claim.expectedFacade === "interior") {
      if (claim.exteriorNormal !== undefined)
        throw new Error(`semantic evidence interior claim '${claim.id}' cannot declare an exterior normal`);
    } else {
      if (!vec3(claim.exteriorNormal))
        throw new Error(`semantic evidence exterior claim '${claim.id}' lacks a facade normal`);
      if (
        dot(normalize(claim.exteriorNormal), normalize(sub(claim.camera.position, claim.camera.target))) <
        policy.minimumFacadeAlignmentDot
      )
        throw new Error(`semantic evidence claim '${claim.id}' observes the wrong facade`);
    }
    if (
      claim.openDoorIds !== undefined &&
      (claim.expectedFacade !== "interior" ||
        !Array.isArray(claim.openDoorIds) ||
        claim.openDoorIds.length === 0 ||
        new Set(claim.openDoorIds).size !== claim.openDoorIds.length ||
        claim.openDoorIds.some((id: unknown) => typeof id !== "string" || !id))
    )
      throw new Error(`semantic evidence claim '${claim.id}' open-door inventory is invalid`);
    for (const [role, count] of Object.entries(roles)) {
      const targets = claim.targets[role];
      if (!Array.isArray(targets) || targets.length !== count)
        throw new Error(
          `semantic evidence claim '${claim.id}' role '${role}' requires exactly ${count} unique target(s)`,
        );
      for (const target of targets) {
        if (
          target === null ||
          typeof target !== "object" ||
          typeof target.id !== "string" ||
          !target.id ||
          targetIds.has(target.id)
        )
          throw new Error(`semantic evidence target '${target?.id ?? "<invalid>"}' is duplicated or invalid`);
        targetIds.add(target.id);
        if (role === "passage-aperture") {
          if (target.kind !== "functional-portal-witness")
            throw new Error("semantic evidence passage aperture must be a compiler-derived portal witness");
          exactKeys(target, ["kind", "id", "portalId"], `${target.id} portal witness`);
          if (!target.portalId) throw new Error(`semantic evidence portal witness '${target.id}' is empty`);
        } else if (role === "headroom-clearance") {
          if (target.kind !== "stair-headroom-witness")
            throw new Error("semantic evidence headroom must be a compiler-derived stair witness");
          exactKeys(target, ["kind", "id", "stairId"], `${target.id} headroom witness`);
          if (!target.stairId) throw new Error(`semantic evidence headroom witness '${target.id}' is empty`);
        } else if (role === "top-landing") {
          if (target.kind !== "stair-top-arrival-witness")
            throw new Error("semantic evidence top landing must be a compiler-derived stair-arrival witness");
          exactKeys(target, ["kind", "id", "stairId"], `${target.id} stair-arrival witness`);
          if (!target.stairId) throw new Error(`semantic evidence stair-arrival witness '${target.id}' is empty`);
        } else if (role === "upper-landing") {
          if (target.kind !== "functional-room-floor-witness")
            throw new Error("semantic evidence upper landing must be a compiler-derived room-floor witness");
          exactKeys(target, ["kind", "id", "roomId"], `${target.id} room-floor witness`);
          if (!target.roomId) throw new Error(`semantic evidence room-floor witness '${target.id}' is empty`);
        } else {
          if (target.kind !== "glb-semantic-group")
            throw new Error(`semantic evidence role '${role}' requires a real GLB semantic group`);
          exactKeys(
            target,
            target.architectureRegionId === undefined
              ? ["kind", "id", "nodeIds", "architectureOwnerId"]
              : ["kind", "id", "nodeIds", "architectureOwnerId", "architectureRegionId"],
            `${target.id} GLB group`,
          );
          if (
            !target.architectureOwnerId ||
            !Array.isArray(target.nodeIds) ||
            target.nodeIds.length === 0 ||
            new Set(target.nodeIds).size !== target.nodeIds.length ||
            target.nodeIds.some((id: unknown) => typeof id !== "string" || !id)
          )
            throw new Error(`semantic evidence GLB group '${target.id}' is empty or duplicates nodes`);
          for (const nodeId of target.nodeIds) {
            if (nodeIds.has(nodeId))
              throw new Error(`semantic evidence GLB node '${nodeId}' belongs to multiple targets`);
            nodeIds.add(nodeId);
          }
        }
      }
    }
  }
}

const BARYCENTRIC = Object.freeze([
  [0.6, 0.2, 0.2],
  [0.2, 0.6, 0.2],
  [0.2, 0.2, 0.6],
] as const);
interface ResolvedTarget {
  readonly target: BuildingSemanticTarget;
  readonly vertices: readonly V3[];
  readonly triangles: readonly Triangle[];
  readonly framingOnly: boolean;
  readonly selfNodeIds: ReadonlySet<string>;
  readonly source: JsonValue;
}
function targetMetric(
  geometry: Geometry,
  resolved: ResolvedTarget,
  role: string,
  claim: BuildingSemanticClaimPolicy,
  policy: BuildingSemanticEvidencePolicy,
) {
  const { target, vertices, triangles: allTriangles, framingOnly, selfNodeIds } = resolved;
  if (!vertices.length || (!framingOnly && !allTriangles.length))
    throw new Error(`semantic evidence target '${target.id}' has no semantic geometry`);
  const aspect = policy.viewport[0] / policy.viewport[1],
    projectedVertices = vertices.map((point) => project(claim.camera, point, aspect));
  const insideClip = projectedVertices.every((entry) => entry !== undefined),
    points = projectedVertices
      .filter((entry): entry is NonNullable<typeof entry> => entry !== undefined)
      .map((entry) => entry.point);
  const minimum: V2 = points.length
    ? [Math.min(...points.map((point) => point[0])), Math.min(...points.map((point) => point[1]))]
    : [Infinity, Infinity];
  const maximum: V2 = points.length
    ? [Math.max(...points.map((point) => point[0])), Math.max(...points.map((point) => point[1]))]
    : [-Infinity, -Infinity];
  const withinSafeFrame =
    insideClip && [...minimum, ...maximum].every((value) => Math.abs(value) <= policy.safeFrameNdc);
  const widthNdc = points.length ? maximum[0] - minimum[0] : 0,
    heightNdc = points.length ? maximum[1] - minimum[1] : 0;
  const selected = [...allTriangles]
    .sort((a, b) => a.key.localeCompare(b.key))
    .filter(
      (_, index, values) =>
        values.length <= policy.maximumTrianglesPerTarget ||
        index % Math.ceil(values.length / policy.maximumTrianglesPerTarget) === 0,
    )
    .slice(0, policy.maximumTrianglesPerTarget);
  let eligible = 0,
    visible = 0;
  const occluders = new Map<string, number>();
  if (!framingOnly)
    for (const triangle of selected) {
      if (dot(triangle.normal, sub(claim.camera.position, triangle.center)) <= 1e-9) continue;
      for (const weights of BARYCENTRIC) {
        eligible++;
        const anchor = add(
          add(scale(triangle.points[0], weights[0]), scale(triangle.points[1], weights[1])),
          scale(triangle.points[2], weights[2]),
        );
        const ray = sub(anchor, claim.camera.position),
          distance = magnitude(ray),
          direction = scale(ray, 1 / distance),
          maximum = distance - policy.rayEpsilonM;
        let occluded = false;
        for (const candidate of geometry.triangles) {
          // Functional colliders/nav witnesses are embedded in the production GLB for runtime use
          // but are not submitted as rendered architecture. They cannot occlude a visual-semantic
          // camera ray; only protected generated architecture meshes may do so.
          if (
            !candidate.opaque ||
            geometry.provenanceByNode.get(candidate.nodeId)?.role !== "architecture-primitive" ||
            selfNodeIds.has(candidate.nodeId) ||
            !rayIntersectsBounds(claim.camera.position, direction, maximum, candidate.bounds)
          )
            continue;
          const hit = rayTriangleDistance(claim.camera.position, direction, candidate);
          if (hit !== undefined && hit < maximum) {
            occluded = true;
            occluders.set(candidate.nodeId, (occluders.get(candidate.nodeId) ?? 0) + 1);
            break;
          }
        }
        if (!occluded && project(claim.camera, anchor, aspect) !== undefined) visible++;
      }
    }
  const visibleFraction = framingOnly ? 1 : eligible === 0 ? 0 : visible / eligible;
  const pass =
    withinSafeFrame &&
    widthNdc >= policy.minimumProjectedWidthNdc &&
    heightNdc >= policy.minimumProjectedHeightNdc &&
    (framingOnly || (visible >= policy.minimumVisibleAnchors && visibleFraction >= policy.minimumVisibleFraction));
  return Object.freeze({
    role,
    targetId: target.id,
    targetKind: target.kind,
    source: resolved.source,
    mode: framingOnly ? "framing" : "visible",
    triangleCount: allTriangles.length,
    sampledTriangleCount: selected.length,
    eligibleAnchorCount: eligible,
    visibleAnchorCount: visible,
    visibleFraction: round(visibleFraction),
    occlusionLeaders: Object.freeze(
      [...occluders]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .slice(0, 5)
        .map(([nodeId, anchorCount]) => Object.freeze({ nodeId, anchorCount })),
    ),
    projectedBounds: points.length
      ? Object.freeze({ minimum: minimum.map(round) as unknown as V2, maximum: maximum.map(round) as unknown as V2 })
      : null,
    projectedWidthNdc: round(widthNdc),
    projectedHeightNdc: round(heightNdc),
    insideClip,
    withinSafeFrame,
    pass,
  });
}

const boxCorners = (center: V3, half: V3): readonly V3[] =>
  Object.freeze(
    [-1, 1].flatMap((sx) =>
      [-1, 1].flatMap((sy) =>
        [-1, 1].map(
          (sz) => Object.freeze([center[0] + sx * half[0], center[1] + sy * half[1], center[2] + sz * half[2]]) as V3,
        ),
      ),
    ),
  );
function architectureIdentity(bytes: Uint8Array, expectedId: string) {
  const value = JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(bytes));
  if (
    value?.schema !== "limina.blender-architecture-input/v1" ||
    value.compilerSchema !== "limina.architecture-compile/v1" ||
    !HASH.test(value.specHash) ||
    !HASH.test(value.irHash) ||
    value.functionalContract?.schema !== "limina.functional-building/v2" ||
    value.functionalContract.buildingId !== expectedId
  )
    throw new Error("semantic evidence architecture identity is invalid");
  const ownedIds = new Set<string>();
  const collect = (entry: unknown): void => {
    if (Array.isArray(entry)) {
      for (const item of entry) collect(item);
      return;
    }
    if (entry === null || typeof entry !== "object") return;
    const record = entry as Record<string, unknown>;
    if (typeof record.id === "string") ownedIds.add(record.id);
    // Compiler primitives retain their source ArchitectureSpec owners in exact derivedFrom
    // inventories even when the Blender sidecar does not repeat the source volume object.
    // Those strings are compiler authority, not policy-provided ownership claims.
    if (Array.isArray(record.derivedFrom))
      for (const id of record.derivedFrom) if (typeof id === "string") ownedIds.add(id);
    for (const item of Object.values(record)) collect(item);
  };
  collect(value);
  return Object.freeze({ value, ownedIds });
}

function resolveTarget(
  geometry: Geometry,
  architecture: ReturnType<typeof architectureIdentity>,
  target: BuildingSemanticTarget,
): ResolvedTarget {
  if (target.kind === "functional-portal-witness") {
    const portal = architecture.value.functionalContract.portals?.find(
      (entry: any) => entry.id === target.portalId && entry.kind === "passage" && entry.exterior === false,
    );
    if (
      !portal ||
      !vec3(portal.center) ||
      !vec3(portal.halfExtents) ||
      portal.halfExtents.some((value: number) => value <= 0)
    )
      throw new Error(`semantic evidence compiled architecture cannot derive portal witness '${target.portalId}'`);
    const source = Object.freeze({
      kind: target.kind,
      portalId: target.portalId,
      center: portal.center.map(round),
      halfExtents: portal.halfExtents.map(round),
    }) as unknown as JsonValue;
    return Object.freeze({
      target,
      vertices: boxCorners(portal.center, portal.halfExtents),
      triangles: Object.freeze([]),
      framingOnly: true,
      selfNodeIds: new Set<string>(),
      source,
    });
  }
  if (target.kind === "stair-headroom-witness") {
    const stair = architecture.value.functionalContract.verticalLinks?.find(
      (entry: any) => entry.id === target.stairId && entry.kind === "stairs",
    );
    if (
      !stair ||
      !vec3(stair.from) ||
      !vec3(stair.to) ||
      !finite(stair.clearWidth) ||
      stair.clearWidth <= 0 ||
      !finite(stair.clearHeight) ||
      stair.clearHeight <= 0
    )
      throw new Error(`semantic evidence compiled architecture cannot derive headroom witness '${target.stairId}'`);
    const dx = stair.to[0] - stair.from[0],
      dz = stair.to[2] - stair.from[2],
      run = Math.hypot(dx, dz);
    if (run < 1e-6) throw new Error(`semantic evidence stair '${target.stairId}' has degenerate headroom run`);
    const lateral: V2 = [((-dz / run) * stair.clearWidth) / 2, ((dx / run) * stair.clearWidth) / 2],
      vertices: V3[] = [];
    for (const point of [stair.from, stair.to] as V3[])
      for (const side of [-1, 1])
        for (const height of [0, stair.clearHeight])
          vertices.push([point[0] + lateral[0] * side, point[1] + height, point[2] + lateral[1] * side]);
    const source = Object.freeze({
      kind: target.kind,
      stairId: target.stairId,
      from: stair.from.map(round),
      to: stair.to.map(round),
      clearWidth: round(stair.clearWidth),
      clearHeight: round(stair.clearHeight),
    }) as unknown as JsonValue;
    return Object.freeze({
      target,
      vertices: Object.freeze(vertices),
      triangles: Object.freeze([]),
      framingOnly: true,
      selfNodeIds: new Set<string>(),
      source,
    });
  }
  if (target.kind === "stair-top-arrival-witness") {
    const stair = architecture.value.functionalContract.verticalLinks?.find(
      (entry: any) => entry.id === target.stairId && entry.kind === "stairs",
    );
    if (
      !stair ||
      !vec3(stair.from) ||
      !vec3(stair.to) ||
      !finite(stair.clearWidth) ||
      stair.clearWidth <= 0 ||
      !finite(stair.treadDepth) ||
      stair.treadDepth <= 0
    )
      throw new Error(`semantic evidence compiled architecture cannot derive top-arrival witness '${target.stairId}'`);
    const dx = stair.to[0] - stair.from[0],
      dz = stair.to[2] - stair.from[2],
      run = Math.hypot(dx, dz);
    if (run < 1e-6) throw new Error(`semantic evidence stair '${target.stairId}' has degenerate top arrival`);
    const along: V2 = [dx / run, dz / run],
      lateral: V2 = [-along[1], along[0]],
      halfAlong = Math.max(stair.treadDepth / 2, 0.1),
      halfWidth = stair.clearWidth / 2,
      vertices: V3[] = [];
    for (const side of [-1, 1])
      for (const alongSign of [-1, 1])
        for (const height of [-0.1, 0.1])
          vertices.push([
            stair.to[0] + lateral[0] * halfWidth * side + along[0] * halfAlong * alongSign,
            stair.to[1] + height,
            stair.to[2] + lateral[1] * halfWidth * side + along[1] * halfAlong * alongSign,
          ]);
    const source = Object.freeze({
      kind: target.kind,
      stairId: target.stairId,
      to: stair.to.map(round),
      clearWidth: round(stair.clearWidth),
      treadDepth: round(stair.treadDepth),
    }) as unknown as JsonValue;
    return Object.freeze({
      target,
      vertices: Object.freeze(vertices),
      triangles: Object.freeze([]),
      framingOnly: true,
      selfNodeIds: new Set<string>(),
      source,
    });
  }
  if (target.kind === "functional-room-floor-witness") {
    const room = architecture.value.functionalContract.rooms?.find((entry: any) => entry.id === target.roomId),
      anchors = architecture.value.functionalContract.spawnAnchors?.filter(
        (entry: any) => entry.roomId === target.roomId,
      );
    if (
      !room ||
      !vec3(room.bounds?.center) ||
      !vec3(room.bounds?.halfExtents) ||
      !finite(room.finishedFloorY) ||
      anchors?.length !== 1 ||
      !vec3(anchors[0].position) ||
      !finite(anchors[0].clearanceRadius) ||
      anchors[0].clearanceRadius <= 0 ||
      !finite(anchors[0].clearanceHeight) ||
      anchors[0].clearanceHeight <= 0
    )
      throw new Error(`semantic evidence compiled architecture cannot derive room-floor witness '${target.roomId}'`);
    // This is a compiler-derived identity/framing witness, not a substitute for the
    // room floor mesh or its clearance volume. Keep it compact at the exact spawn
    // anchor so a valid in-room camera can frame both the near landing and its
    // distant access/window evidence without fabricating policy-owned geometry.
    const anchor = anchors[0],
      radius = Math.min(anchor.clearanceRadius, 0.05),
      half: V3 = [radius, Math.min(anchor.clearanceHeight, 0.1) / 2, radius],
      center: V3 = [anchor.position[0], room.finishedFloorY + half[1], anchor.position[2]];
    const source = Object.freeze({
      kind: target.kind,
      roomId: target.roomId,
      spawnAnchorId: anchor.id,
      center: center.map(round),
      halfExtents: half.map(round),
    }) as unknown as JsonValue;
    return Object.freeze({
      target,
      vertices: boxCorners(center, half),
      triangles: Object.freeze([]),
      framingOnly: true,
      selfNodeIds: new Set<string>(),
      source,
    });
  }
  if (!architecture.ownedIds.has(target.architectureOwnerId))
    throw new Error(`semantic evidence compiled architecture lacks owner '${target.architectureOwnerId}'`);
  const vertices: V3[] = [],
    triangles: Triangle[] = [],
    provenance = [];
  for (const nodeId of target.nodeIds) {
    const nodeVertices = geometry.verticesByNode.get(nodeId),
      nodeTriangles = geometry.trianglesByNode.get(nodeId),
      nodeProvenance = geometry.provenanceByNode.get(nodeId);
    if (!nodeVertices?.length || !nodeTriangles?.length)
      throw new Error(`semantic evidence production GLB is missing target '${nodeId}'`);
    if (
      nodeProvenance?.ownerId !== target.architectureOwnerId ||
      nodeProvenance.role !== "architecture-primitive" ||
      nodeProvenance.editPolicy !== "protected-generated" ||
      !nodeProvenance.derivedFrom.includes(target.architectureOwnerId)
    )
      throw new Error(`semantic evidence GLB target '${nodeId}' lacks exact compiler owner/derivedFrom provenance`);
    vertices.push(...nodeVertices);
    triangles.push(...nodeTriangles);
    provenance.push({ nodeId, ownerId: nodeProvenance.ownerId, derivedFrom: nodeProvenance.derivedFrom });
  }
  if (target.architectureRegionId !== undefined) {
    const room = architecture.value.functionalContract.rooms?.find(
      (entry: any) => entry.id === target.architectureRegionId,
    );
    if (!room || !vec3(room.bounds?.center) || !vec3(room.bounds?.halfExtents) || !finite(room.finishedFloorY))
      throw new Error(`semantic evidence architecture region '${target.architectureRegionId}' is invalid`);
    const bounds = boundsOf(vertices),
      roomMinX = room.bounds.center[0] - room.bounds.halfExtents[0],
      roomMaxX = room.bounds.center[0] + room.bounds.halfExtents[0],
      roomMinZ = room.bounds.center[2] - room.bounds.halfExtents[2],
      roomMaxZ = room.bounds.center[2] + room.bounds.halfExtents[2];
    if (
      Math.min(bounds.maximum[0], roomMaxX) <= Math.max(bounds.minimum[0], roomMinX) ||
      Math.min(bounds.maximum[2], roomMaxZ) <= Math.max(bounds.minimum[2], roomMinZ) ||
      Math.min(Math.abs(bounds.minimum[1] - room.finishedFloorY), Math.abs(bounds.maximum[1] - room.finishedFloorY)) >
        0.25
    )
      throw new Error(
        `semantic evidence GLB group '${target.id}' does not overlap architecture region '${target.architectureRegionId}'`,
      );
  }
  const source = Object.freeze({
    kind: target.kind,
    architectureOwnerId: target.architectureOwnerId,
    architectureRegionId: target.architectureRegionId ?? null,
    nodeProvenance: provenance,
  }) as unknown as JsonValue;
  return Object.freeze({
    target,
    vertices: Object.freeze(vertices),
    triangles: Object.freeze(triangles),
    framingOnly: false,
    selfNodeIds: new Set(target.nodeIds),
    source,
  });
}

function validateManifest(
  bytes: Uint8Array,
  input: BuildingSemanticEvidenceInput,
  architecture: ReturnType<typeof architectureIdentity>,
) {
  const manifest = JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(bytes));
  if (
    !["limina.fb4-multi-room-production-candidate/v2", "limina.fb4-multi-room-production-candidate/v3"].includes(
      manifest?.schema,
    ) ||
    manifest.candidateId !== input.candidateId ||
    manifest.compiler?.specHash !== architecture.value.specHash ||
    manifest.compiler?.irHash !== architecture.value.irHash
  )
    throw new Error("semantic evidence candidate manifest/compiler binding is invalid");
  const bind = (role: string, file: ExactSemanticEvidenceFile) => {
    const entries = manifest.files?.filter((entry: any) => entry.role === role);
    if (
      entries?.length !== 1 ||
      entries[0].path !== file.path ||
      entries[0].sha256 !== file.sha256 ||
      entries[0].contentHash !== file.contentHash ||
      entries[0].bytes !== file.bytes
    )
      throw new Error(`semantic evidence candidate manifest ${role} binding drifted`);
  };
  bind("productionGlb", input.productionGlb.file);
  return manifest;
}

export function createBuildingSemanticEvidence(input: BuildingSemanticEvidenceInput) {
  if (!input.candidateId || !input.architectureId)
    throw new Error("semantic evidence candidate/architecture identity is empty");
  exactFile(input.candidateManifest.file, input.candidateManifest.bytes, "candidate manifest");
  exactFile(input.architectureIr.file, input.architectureIr.bytes, "compiled architecture IR");
  exactFile(input.productionGlb.file, input.productionGlb.bytes, "production GLB");
  validatePolicy(input.policy);
  const architecture = architectureIdentity(input.architectureIr.bytes, input.architectureId);
  validateManifest(input.candidateManifest.bytes, input, architecture);
  const parsedGlb = parseGlb(input.productionGlb.bytes);
  const geometryCache = new Map<string, Readonly<{ geometry: Geometry; poses: readonly ResolvedDoorPose[] }>>();
  const geometryFor = (doorIds: readonly string[] | undefined) => {
    const key = [...(doorIds ?? [])].sort().join("\u0000"),
      cached = geometryCache.get(key);
    if (cached) return cached;
    const poses = resolveOpenDoorPoses(parsedGlb, architecture, doorIds ?? []),
      overrides = new Map(poses.map((pose) => [pose.targetNodeIndex, pose.quaternion] as const));
    const value = Object.freeze({ geometry: parseGeometry(parsedGlb, overrides), poses });
    geometryCache.set(key, value);
    return value;
  };
  const baseGeometry = geometryFor([]).geometry;
  const failures: string[] = [];
  const claimEvidence = input.policy.claims.map((claim) => {
    const { geometry, poses } = geometryFor(claim.openDoorIds);
    const targets = Object.entries(claim.targets).flatMap(([role, entries]) =>
      entries.map((entry) =>
        targetMetric(geometry, resolveTarget(geometry, architecture, entry), role, claim, input.policy),
      ),
    );
    for (const target of targets)
      if (!target.pass)
        failures.push(
          `${claim.id}:${target.role}:${target.targetId}:${target.withinSafeFrame ? "visibility" : "clipped"}`,
        );
    const resolvedOpenDoorPoses = Object.freeze(
      poses.map((pose) =>
        Object.freeze({
          doorId: pose.doorId,
          portalId: pose.portalId,
          compilerClosedYaw: pose.compilerClosedYaw,
          compilerOpenYaw: pose.compilerOpenYaw,
          animationName: pose.animationName,
          targetNodeIndex: pose.targetNodeIndex,
          inputAccessor: pose.inputAccessor,
          outputAccessor: pose.outputAccessor,
          endpointTime: pose.endpointTime,
          quaternion: pose.quaternion.map(round),
          poseHash: pose.poseHash,
        }),
      ),
    );
    return Object.freeze({
      id: claim.id,
      viewId: claim.viewId,
      expectedFacade: claim.expectedFacade,
      viewedFacade: claim.viewedFacade,
      cameraHash: canonicalHash(sha256, claim.camera as unknown as JsonValue),
      targetInventoryHash: canonicalHash(sha256, claim.targets as unknown as JsonValue),
      resolvedOpenDoorPoses,
      openDoorPoseHash: canonicalHash(sha256, resolvedOpenDoorPoses as unknown as JsonValue),
      targets: Object.freeze(targets),
      pass: targets.every((target) => target.pass),
    });
  });
  const policyHash = canonicalHash(sha256, input.policy as unknown as JsonValue);
  const core = Object.freeze({
    schema: BUILDING_SEMANTIC_EVIDENCE_SCHEMA,
    algorithm: "exact-compiled-architecture-owned-glb-groups-witnesses-and-door-poses/v4",
    authority: Object.freeze({
      candidateId: input.candidateId,
      architectureId: input.architectureId,
      candidateManifest: input.candidateManifest.file,
      architectureIr: input.architectureIr.file,
      productionGlb: input.productionGlb.file,
      policyHash,
    }),
    policy: input.policy,
    policyHash,
    deterministicEvidence: Object.freeze({
      roundingDecimalPlaces: 9,
      anchorPattern: "front-facing-triangle-barycentric-0.6-0.2-0.2/v1",
      witnessDerivation: "functional-portal-and-stair-swept-headroom/v1",
      doorPoseDerivation: "exact-compiler-door-portal-bound-glb-open-animation-endpoint/v1",
      semanticInventoryHash: canonicalHash(sha256, baseGeometry.semanticIds as unknown as JsonValue),
      semanticMeshCount: baseGeometry.semanticIds.length,
      triangleCount: baseGeometry.triangles.length,
      posedGeometryCacheKeys: Object.freeze([...geometryCache.keys()].sort()),
      openDoorPoseInventoryHash: canonicalHash(
        sha256,
        claimEvidence.map((claim) => ({
          id: claim.id,
          openDoorPoseHash: claim.openDoorPoseHash,
        })) as unknown as JsonValue,
      ),
    }),
    claims: Object.freeze(claimEvidence),
    mechanicalVerdict: failures.length === 0 ? "pass" : "fail",
    failures: Object.freeze([...new Set(failures)].sort()),
    reviewBoundary: Object.freeze({
      rendering: false,
      gpu: false,
      visualQuality: false,
      humanDecision: "pending" as const,
    }),
  });
  return Object.freeze({ ...core, evidenceHash: canonicalHash(sha256, core as unknown as JsonValue) });
}

export function validateBuildingSemanticEvidence(value: any) {
  if (
    value?.schema !== BUILDING_SEMANTIC_EVIDENCE_SCHEMA ||
    value.algorithm !== "exact-compiled-architecture-owned-glb-groups-witnesses-and-door-poses/v4" ||
    !HASH.test(value.evidenceHash) ||
    !HASH.test(value.policyHash) ||
    value.authority?.policyHash !== value.policyHash ||
    !value.authority?.candidateManifest?.path
  )
    throw new Error("building semantic evidence identity is invalid");
  if (
    value.reviewBoundary?.rendering !== false ||
    value.reviewBoundary?.gpu !== false ||
    value.reviewBoundary?.visualQuality !== false ||
    value.reviewBoundary?.humanDecision !== "pending"
  )
    throw new Error("building semantic evidence crosses its mechanical-only review boundary");
  if (
    value.claims?.map((claim: any) => claim.id).join(",") !== BUILDING_SEMANTIC_CLAIM_IDS.join(",") ||
    !Array.isArray(value.failures) ||
    !["pass", "fail"].includes(value.mechanicalVerdict)
  )
    throw new Error("building semantic evidence claim coverage is incomplete");
  if (
    (value.mechanicalVerdict === "pass") !==
    (value.failures.length === 0 && value.claims.every((claim: any) => claim.pass === true))
  )
    throw new Error("building semantic evidence verdict is inconsistent");
  validatePolicy(value.policy);
  if (
    value.deterministicEvidence?.doorPoseDerivation !==
    "exact-compiler-door-portal-bound-glb-open-animation-endpoint/v1"
  )
    throw new Error("building semantic evidence door-pose derivation is invalid");
  for (let index = 0; index < value.claims.length; index++) {
    const claim = value.claims[index],
      policyClaim = value.policy.claims[index],
      expectedDoorIds = [...(policyClaim.openDoorIds ?? [])].sort();
    if (
      !Array.isArray(claim.resolvedOpenDoorPoses) ||
      JSON.stringify(claim.resolvedOpenDoorPoses.map((pose: any) => pose.doorId)) !== JSON.stringify(expectedDoorIds)
    )
      throw new Error(`building semantic evidence claim '${claim.id}' open-door pose coverage is invalid`);
    for (const pose of claim.resolvedOpenDoorPoses) {
      exactKeys(
        pose,
        [
          "doorId",
          "portalId",
          "compilerClosedYaw",
          "compilerOpenYaw",
          "animationName",
          "targetNodeIndex",
          "inputAccessor",
          "outputAccessor",
          "endpointTime",
          "quaternion",
          "poseHash",
        ],
        `claim '${claim.id}' resolved door pose`,
      );
      if (
        !pose.doorId ||
        !pose.portalId ||
        !finite(pose.compilerClosedYaw) ||
        !finite(pose.compilerOpenYaw) ||
        pose.animationName !== `${pose.doorId}/open` ||
        !Number.isSafeInteger(pose.targetNodeIndex) ||
        !Number.isSafeInteger(pose.inputAccessor) ||
        !Number.isSafeInteger(pose.outputAccessor) ||
        !finite(pose.endpointTime) ||
        !vec4(pose.quaternion) ||
        !HASH.test(pose.poseHash)
      )
        throw new Error(`building semantic evidence claim '${claim.id}' resolved door pose is invalid`);
      const { poseHash, ...source } = pose;
      if (canonicalHash(sha256, source as JsonValue) !== poseHash)
        throw new Error(`building semantic evidence claim '${claim.id}' resolved door pose hash drifted`);
    }
    if (
      !HASH.test(claim.openDoorPoseHash) ||
      canonicalHash(sha256, claim.resolvedOpenDoorPoses as JsonValue) !== claim.openDoorPoseHash
    )
      throw new Error(`building semantic evidence claim '${claim.id}' open-door pose inventory hash drifted`);
  }
  if (
    !HASH.test(value.deterministicEvidence.openDoorPoseInventoryHash) ||
    canonicalHash(
      sha256,
      value.claims.map((claim: any) => ({ id: claim.id, openDoorPoseHash: claim.openDoorPoseHash })) as JsonValue,
    ) !== value.deterministicEvidence.openDoorPoseInventoryHash
  )
    throw new Error("building semantic evidence open-door pose inventory drifted");
  const { evidenceHash, ...core } = value;
  if (canonicalHash(sha256, core as JsonValue) !== evidenceHash)
    throw new Error("building semantic evidence hash drifted");
  return Object.freeze(value);
}

export function verifyBuildingSemanticEvidence(value: any, read: (path: string) => Uint8Array) {
  const evidence: any = validateBuildingSemanticEvidence(value),
    manifestBytes = read(evidence.authority.candidateManifest.path),
    architectureBytes = read(evidence.authority.architectureIr.path),
    glbBytes = read(evidence.authority.productionGlb.path);
  const computed = createBuildingSemanticEvidence({
    candidateId: evidence.authority.candidateId,
    architectureId: evidence.authority.architectureId,
    candidateManifest: { file: evidence.authority.candidateManifest, bytes: manifestBytes },
    architectureIr: { file: evidence.authority.architectureIr, bytes: architectureBytes },
    productionGlb: { file: evidence.authority.productionGlb, bytes: glbBytes },
    policy: evidence.policy,
  });
  if (computed.evidenceHash !== evidence.evidenceHash)
    throw new Error("building semantic evidence recomputation drifted from exact architecture/GLB/policy authority");
  return evidence;
}
