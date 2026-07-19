import { canonicalStringify } from "../authoring/canonical.ts";
import type { FurnitureDesignContract } from "./furniture-design-contract.ts";

type V2 = readonly [number, number];
type V3 = readonly [number, number, number];
type Bounds = Readonly<{ min: V3; max: V3 }>;

export interface FurnitureRuntimePartEvidence {
  readonly id: string;
  readonly bounds: Bounds;
  readonly vertexCount: number;
}

export interface FurnitureFunctionalBuildEvidence {
  readonly schema: "limina.furniture-contract-build-evidence/v1";
  readonly payloadHash: string;
  readonly bounds: Bounds;
  readonly asset: { readonly sha256: string; readonly bytes: number };
  readonly inventory: {
    readonly parts: number;
    readonly joints: number;
    readonly sockets: number;
    readonly colliders: number;
  };
  readonly freshProcessValidation: { readonly contractHash: string; readonly semanticInventorySha256: string };
  readonly glbValidation: {
    readonly finiteAccessorBounds: boolean;
    readonly contractIdentity: boolean;
    readonly boundsSource: string;
    readonly pivot?: V3;
    readonly partBounds?: readonly FurnitureRuntimePartEvidence[];
    readonly lodValidation?: {
      readonly proven: true;
      readonly levels: readonly {
        readonly id: string;
        readonly assetSha256: string;
        readonly semanticIdentity: true;
      }[];
    };
    readonly [key: string]: unknown;
  };
  readonly [key: string]: unknown;
}

export interface ApprovedInteriorPlanClosure {
  readonly artifact: {
    readonly schema: "limina.building-stage-artifact/v1";
    readonly artifactId: string;
    readonly kind: string;
    readonly status: string;
    readonly contractHash: string;
    readonly contentHash: string;
    readonly metadata?: { readonly plan?: { readonly canonicalHash?: string; readonly contentHash?: string } };
  };
  readonly plan: {
    readonly schema: "limina.building-interior-plan/v2";
    readonly planId: string;
    readonly revision?: number;
    readonly proxyArchetypes: readonly {
      readonly id: string;
      readonly kind: string;
      readonly dimensions: V3;
      readonly supportKind: string;
      readonly requiresApproach: boolean;
      readonly requiresOccupancy: boolean;
    }[];
    readonly placements: readonly {
      readonly id: string;
      readonly archetypeId: string;
      readonly roomId: string;
      readonly position: V3;
      readonly yawRadians: number;
      readonly supportSocketId: string;
      readonly facingTargetId: string | null;
      readonly footprint: { readonly localCenter: V2; readonly halfExtents: V2 };
    }[];
    readonly interactionClearances: readonly {
      readonly id: string;
      readonly kind: "approach" | "occupancy";
      readonly placementId: string;
      readonly roomId: string;
      readonly center: V3;
      readonly radiusM: number;
      readonly heightM: number;
    }[];
    readonly facingTargets: readonly { readonly id: string; readonly roomId: string; readonly position: V3 }[];
    readonly surfaceSockets: readonly {
      readonly id: string;
      readonly kind: string;
      readonly roomId: string;
      readonly position: V3;
      readonly normal: V3;
      readonly capacityKg: number;
    }[];
    readonly hearthExclusions?: readonly {
      readonly id: string;
      readonly roomId: string;
      readonly hearthId: string;
      readonly center: V3;
      readonly halfExtents: V2;
      readonly yawRadians: number;
      readonly minimumClearanceM: number;
      readonly heightM: number;
    }[];
  };
  /** Independently computed canonical plan hash. */
  readonly canonicalPlanHash: string;
  /** Independently computed SHA-256 of the exact plan file bytes. */
  readonly planContentHash: string;
}

export interface FurnitureFunctionalVerifierInput {
  readonly contract: FurnitureDesignContract;
  /** Independently computed canonical furniture contract hash. */
  readonly contractHash: string;
  readonly buildEvidence: FurnitureFunctionalBuildEvidence;
  /** Independently computed SHA-256 of the exact runtime GLB bytes. */
  readonly runtimeGlbSha256: string;
  readonly approvedI1: ApprovedInteriorPlanClosure;
  readonly selectedProxyArchetypeId: string;
  /** Defaults to the exact I1 closure used for F1 approval. C1 may explicitly re-run
   * the same functional proof against its newer, independently approved I1 layout. */
  readonly placementClosurePolicy?: "approved-f1-i1" | "current-composition-i1";
}

export interface FurnitureFunctionalCheck {
  readonly id: string;
  readonly passed: boolean;
  readonly findings: readonly string[];
  readonly metrics: Readonly<Record<string, number | string | boolean>>;
}

export interface FurnitureFunctionalEvidence {
  readonly schema: "limina.furniture-functional-evidence/v1";
  readonly verdict: "pass" | "fail";
  readonly inputs: {
    readonly furnitureContractHash: string;
    readonly runtimeGlbSha256: string;
    readonly runtimeSemanticInventorySha256: string;
    readonly interiorArtifactId: string;
    readonly interiorContractHash: string;
    readonly interiorContentHash: string;
    readonly selectedProxyArchetypeId: string;
  };
  readonly policy: typeof POLICY;
  readonly checks: readonly FurnitureFunctionalCheck[];
  readonly summary: { readonly passed: number; readonly failed: number };
}

const HASH = /^sha256:[0-9a-f]{64}$/;
const POLICY = Object.freeze({
  boundsToleranceM: 0.02,
  chairEnvelopeToleranceM: 0.002,
  storageEnvelopeToleranceM: 0.002,
  settleEnvelopeToleranceM: 0.002,
  floorToleranceM: 0.01,
  jointContactSlopM: 0.006,
  jointMaximumPenetrationFraction: 0.9,
  socketSupportSlopM: 0.04,
  postureToleranceM: 0.08,
  colliderSlopM: 0.04,
  maximumColliderToAssetVolumeRatio: 1.5,
  chairMinimumStabilityMarginM: 0.05,
  storageMinimumStabilityMarginM: 0.03,
  settleMinimumStabilityMarginM: 0.05,
  furnitureDensityKgM3: 650,
  chairFacingToleranceDeg: 1,
  settleFacingToleranceDeg: 1,
});

const finite = (value: number): boolean => Number.isFinite(value) && Math.abs(value) < 1_000_000;
const validBounds = (value: Bounds | undefined): value is Bounds =>
  value !== undefined &&
  value.min.length === 3 &&
  value.max.length === 3 &&
  value.min.every(finite) &&
  value.max.every(finite) &&
  value.min.every((entry, axis) => entry <= value.max[axis]);
const dimensions = (bounds: Bounds): V3 => [
  bounds.max[0] - bounds.min[0],
  bounds.max[1] - bounds.min[1],
  bounds.max[2] - bounds.min[2],
];
const volume = (bounds: Bounds): number =>
  dimensions(bounds).reduce((product, entry) => product * Math.max(entry, 1e-9), 1);
const inside = (point: V3, bounds: Bounds, slop = 0): boolean =>
  point.every((entry, axis) => entry >= bounds.min[axis] - slop && entry <= bounds.max[axis] + slop);
const overlaps = (left: Bounds, right: Bounds, slop = 0): boolean =>
  left.min.every((entry, axis) => entry <= right.max[axis] + slop && left.max[axis] >= right.min[axis] - slop);
const overlapDepths = (left: Bounds, right: Bounds): V3 =>
  left.min.map(
    (entry, axis) => Math.min(left.max[axis], right.max[axis]) - Math.max(entry, right.min[axis]),
  ) as unknown as V3;
const distanceBetween = (left: Bounds, right: Bounds): number =>
  Math.hypot(...left.min.map((entry, axis) => Math.max(entry - right.max[axis], right.min[axis] - left.max[axis], 0)));
const round = (value: number): number => Number(value.toFixed(9));

function hull(points: readonly V2[]): V2[] {
  const ordered = [...new Map(points.map((point) => [`${point[0]},${point[1]}`, point])).values()].sort(
    (a, b) => a[0] - b[0] || a[1] - b[1],
  );
  if (ordered.length < 3) return ordered;
  const cross = (origin: V2, left: V2, right: V2) =>
    (left[0] - origin[0]) * (right[1] - origin[1]) - (left[1] - origin[1]) * (right[0] - origin[0]);
  const half = (values: readonly V2[]) => {
    const result: V2[] = [];
    for (const point of values) {
      while (result.length >= 2 && cross(result.at(-2)!, result.at(-1)!, point) <= 0) result.pop();
      result.push(point);
    }
    return result;
  };
  return [...half(ordered).slice(0, -1), ...half([...ordered].reverse()).slice(0, -1)];
}

function pointInConvex(point: V2, polygon: readonly V2[], epsilon = 1e-8): boolean {
  if (polygon.length < 3) return false;
  let sign = 0;
  for (let index = 0; index < polygon.length; index++) {
    const left = polygon[index],
      right = polygon[(index + 1) % polygon.length],
      cross = (right[0] - left[0]) * (point[1] - left[1]) - (right[1] - left[1]) * (point[0] - left[0]);
    if (Math.abs(cross) <= epsilon) continue;
    if (sign === 0) sign = Math.sign(cross);
    else if (Math.sign(cross) !== sign) return false;
  }
  return true;
}

const rotate2 = (point: V2, yaw: number): V2 => {
  const c = Math.cos(yaw),
    s = Math.sin(yaw);
  return [c * point[0] + s * point[1], -s * point[0] + c * point[1]];
};
type Obb2 = Readonly<{ center: V2; half: V2; yaw: number }>;
function obbCorners(box: Obb2): V2[] {
  const result: V2[] = [];
  for (const x of [-box.half[0], box.half[0]])
    for (const z of [-box.half[1], box.half[1]]) {
      const offset = rotate2([x, z], box.yaw);
      result.push([box.center[0] + offset[0], box.center[1] + offset[1]]);
    }
  return result;
}
function project2(points: readonly V2[], axis: V2): V2 {
  const values = points.map((point) => point[0] * axis[0] + point[1] * axis[1]);
  return [Math.min(...values), Math.max(...values)];
}
function obbOverlaps(left: Obb2, right: Obb2, epsilon = 1e-8): boolean {
  const a = obbCorners(left),
    b = obbCorners(right),
    axes = [
      rotate2([1, 0], left.yaw),
      rotate2([0, 1], left.yaw),
      rotate2([1, 0], right.yaw),
      rotate2([0, 1], right.yaw),
    ];
  return axes.every((axis) => {
    const pa = project2(a, axis),
      pb = project2(b, axis);
    return pa[0] < pb[1] - epsilon && pa[1] > pb[0] + epsilon;
  });
}
function circleOverlapsObb(center: V2, radius: number, box: Obb2, epsilon = 1e-8): boolean {
  const delta: V2 = [center[0] - box.center[0], center[1] - box.center[1]],
    local = rotate2(delta, -box.yaw),
    x = Math.max(-box.half[0], Math.min(box.half[0], local[0])),
    z = Math.max(-box.half[1], Math.min(box.half[1], local[1]));
  return Math.hypot(local[0] - x, local[1] - z) < radius - epsilon;
}
function pointSegmentDistance2(point: V2, left: V2, right: V2): number {
  const dx = right[0] - left[0],
    dz = right[1] - left[1],
    length = dx * dx + dz * dz,
    t = length === 0 ? 0 : Math.max(0, Math.min(1, ((point[0] - left[0]) * dx + (point[1] - left[1]) * dz) / length));
  return Math.hypot(point[0] - left[0] - t * dx, point[1] - left[1] - t * dz);
}
function polygonMargin(point: V2, polygon: readonly V2[]): number {
  return pointInConvex(point, polygon)
    ? Math.min(
        ...polygon.map((left, index) => pointSegmentDistance2(point, left, polygon[(index + 1) % polygon.length])),
      )
    : -1;
}

function lodClaimPaths(value: unknown, path = "buildEvidence", found: string[] = []): string[] {
  if (value === null || typeof value !== "object") return found;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const childPath = `${path}.${key}`;
    if (/^lod(?:s|claims?)?$/i.test(key) && key !== "lodValidation") found.push(childPath);
    lodClaimPaths(child, childPath, found);
  }
  return found;
}

export function verifyFurnitureFunction(input: FurnitureFunctionalVerifierInput): FurnitureFunctionalEvidence {
  const checks: FurnitureFunctionalCheck[] = [];
  const check = (
    id: string,
    evaluate: () => { findings?: string[]; metrics?: Record<string, number | string | boolean> },
  ) => {
    try {
      const result = evaluate(),
        findings = [...(result.findings ?? [])].sort();
      checks.push({
        id,
        passed: findings.length === 0,
        findings,
        metrics: Object.fromEntries(Object.entries(result.metrics ?? {}).sort(([a], [b]) => a.localeCompare(b))),
      });
    } catch (error) {
      checks.push({
        id,
        passed: false,
        findings: [error instanceof Error ? error.message : String(error)],
        metrics: {},
      });
    }
  };
  const { contract, buildEvidence: build, approvedI1: i1 } = input;
  const currentCompositionPlacement = input.placementClosurePolicy === "current-composition-i1";
  const archetype = i1.plan.proxyArchetypes.find((entry) => entry.id === input.selectedProxyArchetypeId);
  const placements = i1.plan.placements.filter((entry) => entry.archetypeId === input.selectedProxyArchetypeId);
  const chair = contract.chair,
    settle = contract.settle,
    storage = contract.storage,
    envelopeTolerance = chair
      ? POLICY.chairEnvelopeToleranceM
      : settle
        ? POLICY.settleEnvelopeToleranceM
        : storage
          ? POLICY.storageEnvelopeToleranceM
          : POLICY.boundsToleranceM;
  const runtimeParts = new Map((build.glbValidation?.partBounds ?? []).map((entry) => [entry.id, entry]));

  check("input-identity", () => {
    const findings: string[] = [];
    if (
      !HASH.test(input.contractHash) ||
      build.payloadHash !== input.contractHash ||
      build.freshProcessValidation?.contractHash !== input.contractHash
    )
      findings.push("furniture contract/build identity is not exact");
    if (
      !HASH.test(build.asset?.sha256 ?? "") ||
      build.asset.sha256 !== input.runtimeGlbSha256 ||
      build.asset.bytes <= 0 ||
      build.glbValidation.contractIdentity !== true ||
      build.glbValidation.finiteAccessorBounds !== true ||
      build.glbValidation.boundsSource !== "exported-glb-scene-graph"
    )
      findings.push("runtime GLB bytes, identity, or finite exported-bound attestation are not exact");
    if (
      build.inventory?.parts !== contract.parts.length ||
      build.inventory?.joints !== contract.joints.length ||
      build.inventory?.sockets !== contract.sockets.length ||
      build.inventory?.colliders !== contract.colliders.length
    )
      findings.push("build inventory drifted from the typed contract");
    return { findings, metrics: { contractParts: contract.parts.length, runtimeParts: runtimeParts.size } };
  });

  check("approved-i1-closure", () => {
    const findings: string[] = [],
      artifact = i1.artifact;
    if (
      artifact.schema !== "limina.building-stage-artifact/v1" ||
      artifact.kind !== "interior-plan" ||
      artifact.status !== "approved"
    )
      findings.push("I1 artifact is not an approved interior plan");
    if (i1.plan.schema !== "limina.building-interior-plan/v2" || artifact.artifactId !== i1.plan.planId)
      findings.push("I1 artifact does not identify the supplied plan");
    if (
      artifact.contractHash !== i1.canonicalPlanHash ||
      artifact.contentHash !== i1.planContentHash ||
      artifact.metadata?.plan?.canonicalHash !== i1.canonicalPlanHash ||
      artifact.metadata?.plan?.contentHash !== i1.planContentHash
    )
      findings.push("I1 plan bytes/canonical contract are not exact to the approved artifact");
    if (!archetype || placements.length === 0)
      findings.push("selected proxy archetype has no approved I1 archetype/placement");
    else if (
      archetype.supportKind !== "floor" ||
      !(contract.role === archetype.kind || contract.role.endsWith(archetype.kind))
    )
      findings.push("furniture role/support is incompatible with the selected I1 proxy archetype");
    return { findings, metrics: { placements: placements.length } };
  });

  check("exported-bounds-envelope-floor-pivot", () => {
    const findings: string[] = [];
    if (!validBounds(build.bounds)) return { findings: ["exported GLB bounds are absent or invalid"] };
    const actual = dimensions(build.bounds),
      declared: V3 = [contract.dimensions.widthM, contract.dimensions.heightM, contract.dimensions.depthM];
    for (let axis = 0; axis < 3; axis++)
      if (Math.abs(actual[axis] - declared[axis]) > envelopeTolerance)
        findings.push(`exported bounds axis ${axis} differs from declared dimensions`);
    if (archetype) {
      for (let axis = 0; axis < 3; axis++)
        if (actual[axis] > archetype.dimensions[axis] + envelopeTolerance)
          findings.push(`exported bounds exceed I1 archetype on axis ${axis}`);
      if (
        build.bounds.min[0] < -archetype.dimensions[0] / 2 - envelopeTolerance ||
        build.bounds.max[0] > archetype.dimensions[0] / 2 + envelopeTolerance ||
        build.bounds.min[2] < -archetype.dimensions[2] / 2 - envelopeTolerance ||
        build.bounds.max[2] > archetype.dimensions[2] / 2 + envelopeTolerance
      )
        findings.push("exported geometry is offset outside the centered I1 archetype envelope");
    }
    for (const placement of placements) {
      const { localCenter, halfExtents } = placement.footprint;
      if (
        build.bounds.min[0] < localCenter[0] - halfExtents[0] - envelopeTolerance ||
        build.bounds.max[0] > localCenter[0] + halfExtents[0] + envelopeTolerance ||
        build.bounds.min[2] < localCenter[1] - halfExtents[1] - envelopeTolerance ||
        build.bounds.max[2] > localCenter[1] + halfExtents[1] + envelopeTolerance
      )
        findings.push(`exported footprint exceeds ${placement.id}`);
    }
    if (Math.abs(build.bounds.min[1]) > POLICY.floorToleranceM)
      findings.push("exported geometry does not contact the local floor");
    const pivot = build.glbValidation.pivot;
    if (!pivot || pivot.some((value) => !finite(value))) findings.push("exported pivot evidence is missing");
    else if (
      !inside(pivot, build.bounds, POLICY.floorToleranceM) ||
      Math.abs(pivot[1] - build.bounds.min[1]) > POLICY.floorToleranceM
    )
      findings.push("exported pivot is not a grounded in-bounds placement origin");
    return {
      findings,
      metrics: {
        actualDepthM: round(actual[2]),
        actualHeightM: round(actual[1]),
        actualWidthM: round(actual[0]),
        floorOffsetM: round(build.bounds.min[1]),
      },
    };
  });

  check("runtime-part-geometry", () => {
    const findings: string[] = [];
    if (runtimeParts.size !== contract.parts.length) findings.push("per-part exported GLB bounds are incomplete");
    for (const part of contract.parts) {
      const runtime = runtimeParts.get(part.id);
      if (
        !runtime ||
        !validBounds(runtime.bounds) ||
        !Number.isSafeInteger(runtime.vertexCount) ||
        runtime.vertexCount < 4
      )
        findings.push(`part ${part.id} lacks usable exported geometry evidence`);
      else if (
        !inside(runtime.bounds.min, build.bounds, POLICY.boundsToleranceM) ||
        !inside(runtime.bounds.max, build.bounds, POLICY.boundsToleranceM)
      )
        findings.push(`part ${part.id} escapes exported GLB bounds`);
    }
    return { findings, metrics: { expectedParts: contract.parts.length, provenParts: runtimeParts.size } };
  });

  check("joint-connectivity-contact", () => {
    const findings: string[] = [],
      adjacency = new Map(contract.parts.map((part) => [part.id, new Set<string>()]));
    for (const joint of contract.joints) {
      const [leftId, rightId] = joint.members,
        left = runtimeParts.get(leftId)?.bounds,
        right = runtimeParts.get(rightId)?.bounds;
      adjacency.get(leftId)?.add(rightId);
      adjacency.get(rightId)?.add(leftId);
      if (!left || !right) {
        findings.push(`joint ${joint.id} lacks both runtime members`);
        continue;
      }
      const gap = distanceBetween(left, right),
        depths = overlapDepths(left, right),
        smallestMember = Math.min(...dimensions(left), ...dimensions(right));
      if (gap > joint.toleranceM + POLICY.jointContactSlopM) findings.push(`joint ${joint.id} members do not contact`);
      const penetration = Math.max(0, Math.min(...depths));
      if (
        !["drawbore-peg", "wedged-through-tenon"].includes(joint.type) &&
        depths.every((entry) => entry > 0) &&
        penetration > smallestMember * POLICY.jointMaximumPenetrationFraction + joint.toleranceM
      )
        findings.push(`joint ${joint.id} has implausible member penetration`);
    }
    const start = contract.parts[0]?.id,
      reached = new Set<string>(),
      queue = start ? [start] : [];
    while (queue.length) {
      const id = queue.shift()!;
      if (reached.has(id)) continue;
      reached.add(id);
      for (const next of adjacency.get(id) ?? []) queue.push(next);
    }
    if (reached.size !== contract.parts.length) findings.push("joint graph does not connect every semantic part");
    return {
      findings,
      metrics: { connectedParts: reached.size, expectedParts: contract.parts.length, joints: contract.joints.length },
    };
  });

  check("support-polygon-center-of-mass", () => {
    const findings: string[] = [],
      parts = [...runtimeParts.values()].filter((entry) => validBounds(entry.bounds)),
      semanticLegIds = chair?.legPartIds ?? settle?.legPartIds,
      contactPool = semanticLegIds
        ? semanticLegIds
            .map((id) => runtimeParts.get(id))
            .filter((entry): entry is FurnitureRuntimePartEvidence => entry !== undefined)
        : parts,
      contacts = contactPool.filter((entry) => entry.bounds.min[1] <= build.bounds.min[1] + POLICY.floorToleranceM);
    const supportPoints = contacts.flatMap(
        (entry) =>
          [
            [entry.bounds.min[0], entry.bounds.min[2]],
            [entry.bounds.min[0], entry.bounds.max[2]],
            [entry.bounds.max[0], entry.bounds.min[2]],
            [entry.bounds.max[0], entry.bounds.max[2]],
          ] as V2[],
      ),
      polygon = hull(supportPoints);
    const totalVolume = parts.reduce((sum, entry) => sum + volume(entry.bounds), 0),
      com: V2 =
        totalVolume > 0
          ? [
              parts.reduce(
                (sum, entry) => sum + (entry.bounds.min[0] + entry.bounds.max[0]) * 0.5 * volume(entry.bounds),
                0,
              ) / totalVolume,
              parts.reduce(
                (sum, entry) => sum + (entry.bounds.min[2] + entry.bounds.max[2]) * 0.5 * volume(entry.bounds),
                0,
              ) / totalVolume,
            ]
          : [NaN, NaN];
    if (contacts.length === 0 || polygon.length < 3)
      findings.push("floor-contact geometry does not form a support polygon");
    else if (!pointInConvex(com, polygon))
      findings.push("geometry-derived projected center of mass lies outside the support polygon");
    let loadedCom = com,
      stabilityMargin = polygon.length >= 3 ? polygonMargin(com, polygon) : -1;
    if (chair) {
      if (contacts.length !== 4) findings.push("chair does not prove four grounded semantic legs");
      const occupancy = contract.sockets.find((socket) => socket.kind === "occupancy");
      if (occupancy && totalVolume > 0) {
        const furnitureMass = totalVolume * POLICY.furnitureDensityKgM3,
          totalMass = furnitureMass + chair.ratedLoadKg;
        loadedCom = [
          (com[0] * furnitureMass + occupancy.position[0] * chair.ratedLoadKg) / totalMass,
          (com[1] * furnitureMass + occupancy.position[2] * chair.ratedLoadKg) / totalMass,
        ];
        stabilityMargin = polygon.length >= 3 ? polygonMargin(loadedCom, polygon) : -1;
        if (stabilityMargin < POLICY.chairMinimumStabilityMarginM)
          findings.push("rated-load projected center of mass lacks the chair stability margin");
      }
    }
    if (settle) {
      if (contacts.length !== 4) findings.push("settle does not prove four grounded semantic legs/posts");
      const occupants = settle.occupancySocketIds
        .map((id) => contract.sockets.find((socket) => socket.id === id))
        .filter((socket): socket is FurnitureDesignContract["sockets"][number] => socket !== undefined);
      if (occupants.length === 2 && totalVolume > 0) {
        const furnitureMass = totalVolume * POLICY.furnitureDensityKgM3,
          totalMass = furnitureMass + settle.ratedLoadKg,
          payloadEach = settle.ratedLoadKg / 2;
        loadedCom = [
          (com[0] * furnitureMass + occupants.reduce((sum, socket) => sum + socket.position[0] * payloadEach, 0)) /
            totalMass,
          (com[1] * furnitureMass + occupants.reduce((sum, socket) => sum + socket.position[2] * payloadEach, 0)) /
            totalMass,
        ];
        stabilityMargin = polygon.length >= 3 ? polygonMargin(loadedCom, polygon) : -1;
        if (stabilityMargin < POLICY.settleMinimumStabilityMarginM)
          findings.push("two-person rated-load projected center of mass lacks the settle stability margin");
      }
    }
    return {
      findings,
      metrics: {
        comX: round(com[0]),
        comZ: round(com[1]),
        floorContactParts: contacts.length,
        loadedComX: round(loadedCom[0]),
        loadedComZ: round(loadedCom[1]),
        stabilityMarginM: round(stabilityMargin),
        supportHullVertices: polygon.length,
      },
    };
  });

  check("interaction-socket-geometry-posture", () => {
    const findings: string[] = [];
    for (const socket of contract.sockets) {
      const support = runtimeParts.get(socket.supportedBy)?.bounds;
      if (!support) {
        findings.push(`socket ${socket.id} lacks exported support geometry`);
        continue;
      }
      const facingLength = Math.hypot(...socket.facing);
      if (Math.abs(facingLength - 1) > 1e-5) findings.push(`socket ${socket.id} facing is not unit length`);
      if (socket.kind === "occupancy") {
        if (
          socket.position[0] < support.min[0] - POLICY.socketSupportSlopM ||
          socket.position[0] > support.max[0] + POLICY.socketSupportSlopM ||
          socket.position[2] < support.min[2] - POLICY.socketSupportSlopM ||
          socket.position[2] > support.max[2] + POLICY.socketSupportSlopM ||
          Math.abs(socket.position[1] - support.max[1]) > POLICY.socketSupportSlopM
        )
          findings.push(`occupancy socket ${socket.id} is not supported by actual top geometry`);
        if (
          Math.abs(socket.position[1] - contract.dimensions.seatHeightM) > POLICY.postureToleranceM ||
          socket.clearanceRadiusM < 0.18 ||
          socket.clearanceRadiusM > Math.max(0.45, contract.dimensions.seatDepthM + POLICY.postureToleranceM)
        )
          findings.push(`occupancy socket ${socket.id} is outside usable seated posture bounds`);
      } else {
        if (inside(socket.position, build.bounds, -POLICY.socketSupportSlopM))
          findings.push(`${socket.kind} socket ${socket.id} is buried inside furniture geometry`);
        if (
          socket.position[1] < build.bounds.min[1] - POLICY.floorToleranceM ||
          socket.position[1] > build.bounds.max[1] + POLICY.postureToleranceM
        )
          findings.push(`${socket.kind} socket ${socket.id} has an unusable posture height`);
      }
    }
    if (archetype?.requiresOccupancy && contract.sockets.every((socket) => socket.kind !== "occupancy"))
      findings.push("I1 archetype requires occupancy but the contract proves none");
    if (archetype?.requiresApproach && contract.sockets.every((socket) => socket.kind !== "approach"))
      findings.push("I1 archetype requires approach but the contract proves none");
    return { findings, metrics: { sockets: contract.sockets.length } };
  });

  check("chair-i1-functional-placement", () => {
    const findings: string[] = [];
    if (!chair)
      return { findings, metrics: { applicable: false, placements: 0, minimumOccupancyClearanceM: 0, ratedLoadKg: 0 } };
    if (archetype?.kind !== "chair") findings.push("chair semantics are not bound to an I1 chair archetype");
    if (input.selectedProxyArchetypeId === "proxy/dining-chair" && placements.length !== 4)
      findings.push("approved dining-chair proxy does not resolve exactly four placements");
    const seat = runtimeParts.get(chair.seatPartId)?.bounds,
      backs = chair.backPartIds
        .map((id) => runtimeParts.get(id)?.bounds)
        .filter((bounds): bounds is Bounds => bounds !== undefined),
      occupancy = contract.sockets.find((socket) => socket.kind === "occupancy");
    if (!seat) findings.push("semantic chair seat lacks actual geometry");
    else {
      const seatSize = dimensions(seat);
      if (
        seatSize[0] + envelopeTolerance < chair.usableSeatWidthM ||
        seatSize[2] + envelopeTolerance < contract.dimensions.seatDepthM ||
        Math.abs(seat.max[1] - contract.dimensions.seatHeightM) > POLICY.socketSupportSlopM
      )
        findings.push("actual chair seat does not prove declared usable ergonomics");
    }
    if (backs.length !== chair.backPartIds.length) findings.push("semantic chair back lacks actual geometry");
    else if (seat) {
      const top = Math.max(...backs.map((bounds) => bounds.max[1])),
        bottom = Math.min(...backs.map((bounds) => bounds.min[1]));
      if (top - Math.max(seat.max[1], bottom) + envelopeTolerance < chair.backSupportHeightM)
        findings.push("actual chair back does not prove declared support height");
    }
    if (!occupancy) findings.push("chair occupancy socket is missing");
    const actualCenter: V2 = [
        (build.bounds.min[0] + build.bounds.max[0]) / 2,
        (build.bounds.min[2] + build.bounds.max[2]) / 2,
      ],
      actualHalf: V2 = [
        (build.bounds.max[0] - build.bounds.min[0]) / 2,
        (build.bounds.max[2] - build.bounds.min[2]) / 2,
      ];
    const proxyBox = (placement: ApprovedInteriorPlanClosure["plan"]["placements"][number]): Obb2 => {
      const offset = rotate2(placement.footprint.localCenter, placement.yawRadians);
      return {
        center: [placement.position[0] + offset[0], placement.position[2] + offset[1]],
        half: placement.footprint.halfExtents,
        yaw: placement.yawRadians,
      };
    };
    const chairBox = (placement: ApprovedInteriorPlanClosure["plan"]["placements"][number]): Obb2 => {
      const offset = rotate2(actualCenter, placement.yawRadians);
      return {
        center: [placement.position[0] + offset[0], placement.position[2] + offset[1]],
        half: actualHalf,
        yaw: placement.yawRadians,
      };
    };
    let minimumClearance = Infinity;
    for (const placement of placements) {
      const support = i1.plan.surfaceSockets?.find((socket) => socket.id === placement.supportSocketId),
        target = i1.plan.facingTargets?.find((entry) => entry.id === placement.facingTargetId),
        clearances =
          i1.plan.interactionClearances?.filter(
            (clearance) => clearance.placementId === placement.id && clearance.kind === "occupancy",
          ) ?? [];
      if (
        !support ||
        support.kind !== "floor" ||
        support.capacityKg < chair.ratedLoadKg ||
        Math.hypot(
          support.position[0] - placement.position[0],
          support.position[1] - placement.position[1],
          support.position[2] - placement.position[2],
        ) > 0.05 ||
        support.normal[1] < 0.9
      )
        findings.push(`${placement.id} lacks a sufficient exact floor/load binding`);
      if (!target || target.roomId !== placement.roomId) findings.push(`${placement.id} lacks its exact facing target`);
      else {
        const dx = target.position[0] - placement.position[0],
          dz = target.position[2] - placement.position[2],
          length = Math.hypot(dx, dz),
          worldForward = rotate2([chair.canonicalForward[0], chair.canonicalForward[2]], placement.yawRadians),
          dot = length > 0 ? (worldForward[0] * dx + worldForward[1] * dz) / length : -1;
        if (dot < Math.cos((POLICY.chairFacingToleranceDeg * Math.PI) / 180))
          findings.push(`${placement.id} chair forward does not align with its dining target`);
      }
      if (clearances.length !== 1 || !occupancy) findings.push(`${placement.id} lacks one exact occupancy clearance`);
      else {
        const clearance = clearances[0],
          offset = rotate2([occupancy.position[0], occupancy.position[2]], placement.yawRadians),
          worldSocket: V2 = [placement.position[0] + offset[0], placement.position[2] + offset[1]];
        if (
          Math.hypot(worldSocket[0] - clearance.center[0], worldSocket[1] - clearance.center[2]) > envelopeTolerance ||
          occupancy.clearanceRadiusM > clearance.radiusM + envelopeTolerance ||
          clearance.heightM < 1.5
        )
          findings.push(`${placement.id} occupancy socket does not fit its approved I1 cylinder`);
        for (const other of i1.plan.placements) {
          if (other.id === placement.id) continue;
          const otherBox = other.archetypeId === input.selectedProxyArchetypeId ? chairBox(other) : proxyBox(other);
          const delta = rotate2(
              [clearance.center[0] - otherBox.center[0], clearance.center[2] - otherBox.center[1]],
              -otherBox.yaw,
            ),
            edge =
              Math.hypot(
                Math.max(Math.abs(delta[0]) - otherBox.half[0], 0),
                Math.max(Math.abs(delta[1]) - otherBox.half[1], 0),
              ) - clearance.radiusM;
          minimumClearance = Math.min(minimumClearance, edge);
          if (circleOverlapsObb([clearance.center[0], clearance.center[2]], clearance.radiusM, otherBox))
            findings.push(`${placement.id} approved occupancy cylinder intersects ${other.id}`);
        }
      }
      const placed = chairBox(placement);
      for (const other of i1.plan.placements) {
        if (
          other.id === placement.id ||
          (other.archetypeId === input.selectedProxyArchetypeId && other.id < placement.id)
        )
          continue;
        const otherBox = other.archetypeId === input.selectedProxyArchetypeId ? chairBox(other) : proxyBox(other);
        if (obbOverlaps(placed, otherBox))
          findings.push(`${placement.id} transformed runtime envelope intersects ${other.id}`);
      }
    }
    return {
      findings,
      metrics: {
        applicable: true,
        placements: placements.length,
        minimumOccupancyClearanceM: round(minimumClearance),
        ratedLoadKg: chair.ratedLoadKg,
      },
    };
  });

  check("settle-i1-r3-functional-placement", () => {
    const findings: string[] = [];
    if (!settle)
      return {
        findings,
        metrics: {
          applicable: false,
          placements: 0,
          occupancies: 0,
          approachErrorM: 0,
          loadedStabilityMarginM: 0,
          ratedLoadKg: 0,
        },
      };
    const expectedPlanId = "interior/functional-hall-house-v4/r3",
      expectedPlacementId = "placement/hearth-settle";
    if (
      !currentCompositionPlacement &&
      (i1.plan.planId !== expectedPlanId || i1.artifact.artifactId !== expectedPlanId || i1.plan.revision !== 3)
    )
      findings.push("settle is not bound to the exact approved I1 r3 dependency");
    if (
      input.selectedProxyArchetypeId !== "proxy/hearth-settle" ||
      archetype?.kind !== "settle" ||
      !archetype ||
      archetype.dimensions.some((value, axis) => Math.abs(value - [1.6, 1.3, 0.7][axis]) > 1e-8) ||
      archetype.requiresApproach !== true ||
      archetype.requiresOccupancy !== true
    )
      findings.push("settle semantics are not bound to the exact bounded I1 r3 hearth-settle archetype");
    if (placements.length !== 1 || placements[0]?.id !== expectedPlacementId)
      findings.push("approved I1 r3 hearth settle does not resolve exactly one canonical placement");

    const seat = runtimeParts.get(settle.seatPartId)?.bounds,
      backs = settle.backPartIds.map((id) => runtimeParts.get(id)?.bounds),
      legs = settle.legPartIds.map((id) => runtimeParts.get(id)?.bounds),
      arms = settle.armPartIds.map((id) => runtimeParts.get(id)?.bounds),
      armSupports = settle.armSupportPartIds.map((id) => runtimeParts.get(id)?.bounds);
    if (!seat) findings.push("semantic settle seat lacks actual continuous geometry");
    else {
      const size = dimensions(seat);
      if (
        size[0] + envelopeTolerance < settle.usableSeatWidthM ||
        size[2] + envelopeTolerance < contract.dimensions.seatDepthM ||
        Math.abs(seat.max[1] - contract.dimensions.seatHeightM) > POLICY.socketSupportSlopM
      )
        findings.push("actual continuous settle seat does not prove declared two-person ergonomics");
    }
    if (backs.some((bounds) => !bounds)) findings.push("semantic settle back lacks actual geometry");
    else if (seat) {
      const actualBacks = backs as Bounds[],
        ordered = actualBacks
          .map((bounds) => [bounds.min[0], bounds.max[0]] as V2)
          .sort((left, right) => left[0] - right[0]);
      let left = ordered[0]?.[0] ?? Infinity,
        right = ordered[0]?.[1] ?? -Infinity;
      for (const interval of ordered.slice(1)) {
        if (interval[0] > right + 0.08)
          findings.push("actual settle back support is discontinuous across the usable seat");
        right = Math.max(right, interval[1]);
      }
      const top = Math.max(...actualBacks.map((bounds) => bounds.max[1])),
        bottom = Math.min(...actualBacks.map((bounds) => bounds.min[1]));
      if (
        right - left + envelopeTolerance < settle.usableSeatWidthM ||
        top - Math.max(seat.max[1], bottom) + envelopeTolerance < settle.backSupportHeightM
      )
        findings.push("actual continuous settle back does not prove declared support width and height");
    }
    if (
      legs.some((bounds) => !bounds) ||
      legs
        .filter((bounds): bounds is Bounds => bounds !== undefined)
        .some((bounds) => bounds.min[1] > build.bounds.min[1] + POLICY.floorToleranceM)
    )
      findings.push("settle does not have four grounded semantic legs/posts");
    if (arms.some((bounds) => !bounds) || armSupports.some((bounds) => !bounds))
      findings.push("settle arms or dedicated arm supports lack actual geometry");

    const adjacency = new Map(contract.parts.map((part) => [part.id, new Set<string>()]));
    for (const joint of contract.joints) {
      adjacency.get(joint.members[0])?.add(joint.members[1]);
      adjacency.get(joint.members[1])?.add(joint.members[0]);
    }
    const excludedFromLoad = new Set([...settle.backPartIds, ...settle.armPartIds, ...settle.armSupportPartIds]);
    const hasLoadPath = (target: string) => {
      const queue = [settle.seatPartId],
        seen = new Set<string>();
      while (queue.length) {
        const id = queue.shift()!;
        if (seen.has(id)) continue;
        seen.add(id);
        if (id === target) return true;
        for (const next of adjacency.get(id) ?? [])
          if (next === target || !excludedFromLoad.has(next)) queue.push(next);
      }
      return false;
    };
    for (const legId of settle.legPartIds)
      if (!hasLoadPath(legId)) findings.push(`settle seat lacks a structural load path to ${legId}`);
    for (let index = 0; index < 2; index++) {
      const armId = settle.armPartIds[index],
        supportId = settle.armSupportPartIds[index],
        armNeighbors = adjacency.get(armId) ?? new Set(),
        supportNeighbors = adjacency.get(supportId) ?? new Set();
      if (
        !armNeighbors.has(supportId) ||
        ![...armNeighbors].some((id) => settle.backPartIds.includes(id) || settle.legPartIds.includes(id))
      )
        findings.push(`settle arm ${armId} is not joined to its support and rear structure`);
      if (
        !supportNeighbors.has(armId) ||
        ![...supportNeighbors].some((id) => id === settle.seatPartId || settle.legPartIds.includes(id))
      )
        findings.push(`settle arm support ${supportId} is not joined into the seat/leg structure`);
    }
    const backAnchors = new Set([settle.seatPartId, ...settle.legPartIds]),
      backParts = new Set(settle.backPartIds),
      backReachesAnchor = (start: string) => {
        const queue = [start],
          seen = new Set<string>();
        while (queue.length) {
          const id = queue.shift()!;
          if (seen.has(id)) continue;
          seen.add(id);
          for (const next of adjacency.get(id) ?? []) {
            if (backAnchors.has(next)) return true;
            if (backParts.has(next)) queue.push(next);
          }
        }
        return false;
      };
    for (const backId of settle.backPartIds)
      if (!backReachesAnchor(backId))
        findings.push(`settle back part ${backId} is in a disconnected back-structure island`);

    const allParts = [...runtimeParts.values()].filter((entry) => validBounds(entry.bounds)),
      totalVolume = allParts.reduce((sum, entry) => sum + volume(entry.bounds), 0),
      furnitureMassKg = totalVolume * POLICY.furnitureDensityKgM3;
    const legBounds = legs.filter((bounds): bounds is Bounds => bounds !== undefined),
      supportPolygon = hull(
        legBounds.flatMap(
          (entry) =>
            [
              [entry.min[0], entry.min[2]],
              [entry.min[0], entry.max[2]],
              [entry.max[0], entry.min[2]],
              [entry.max[0], entry.max[2]],
            ] as V2[],
        ),
      );
    const furnitureCom: V2 =
      totalVolume > 0
        ? [
            allParts.reduce(
              (sum, entry) => sum + (entry.bounds.min[0] + entry.bounds.max[0]) * 0.5 * volume(entry.bounds),
              0,
            ) / totalVolume,
            allParts.reduce(
              (sum, entry) => sum + (entry.bounds.min[2] + entry.bounds.max[2]) * 0.5 * volume(entry.bounds),
              0,
            ) / totalVolume,
          ]
        : [NaN, NaN];
    const occupancySockets = settle.occupancySocketIds
        .map((id) => contract.sockets.find((socket) => socket.id === id))
        .filter((socket): socket is FurnitureDesignContract["sockets"][number] => socket !== undefined),
      payloadEach = settle.ratedLoadKg / 2,
      totalMass = furnitureMassKg + settle.ratedLoadKg;
    const loadedCom: V2 =
        occupancySockets.length === 2 && totalMass > 0
          ? [
              (furnitureCom[0] * furnitureMassKg +
                occupancySockets.reduce((sum, socket) => sum + socket.position[0] * payloadEach, 0)) /
                totalMass,
              (furnitureCom[1] * furnitureMassKg +
                occupancySockets.reduce((sum, socket) => sum + socket.position[2] * payloadEach, 0)) /
                totalMass,
            ]
          : [NaN, NaN],
      loadedMargin = supportPolygon.length >= 3 ? polygonMargin(loadedCom, supportPolygon) : -1;
    if (supportPolygon.length < 3 || loadedMargin < POLICY.settleMinimumStabilityMarginM)
      findings.push("two-person loaded settle does not retain the required support-polygon stability margin");

    const actualCenter: V2 = [
        (build.bounds.min[0] + build.bounds.max[0]) / 2,
        (build.bounds.min[2] + build.bounds.max[2]) / 2,
      ],
      actualHalf: V2 = [
        (build.bounds.max[0] - build.bounds.min[0]) / 2,
        (build.bounds.max[2] - build.bounds.min[2]) / 2,
      ];
    const proxyBox = (placement: ApprovedInteriorPlanClosure["plan"]["placements"][number]): Obb2 => {
      const offset = rotate2(placement.footprint.localCenter, placement.yawRadians);
      return {
        center: [placement.position[0] + offset[0], placement.position[2] + offset[1]],
        half: placement.footprint.halfExtents,
        yaw: placement.yawRadians,
      };
    };
    const settleBox = (placement: ApprovedInteriorPlanClosure["plan"]["placements"][number]): Obb2 => {
      const offset = rotate2(actualCenter, placement.yawRadians);
      return {
        center: [placement.position[0] + offset[0], placement.position[2] + offset[1]],
        half: actualHalf,
        yaw: placement.yawRadians,
      };
    };
    let approachError = Infinity;
    for (const placement of placements) {
      if (
        placement.id !== expectedPlacementId ||
        placement.roomId !== "room/main" ||
        placement.supportSocketId !== "socket/floor/hearth-settle" ||
        placement.facingTargetId !== "facing/hall-hearth" ||
        (!currentCompositionPlacement &&
          (placement.position.some((value, axis) => Math.abs(value - [0.2, 0.09, 2.2][axis]) > 1e-8) ||
            Math.abs(placement.yawRadians - -1.750649826587375) > 1e-8)) ||
        placement.footprint.localCenter.some((value) => Math.abs(value) > 1e-8) ||
        placement.footprint.halfExtents.some((value, axis) => Math.abs(value - [0.8, 0.35][axis]) > 1e-8)
      )
        findings.push(
          `${placement.id} drifted from the ${currentCompositionPlacement ? "approved current-composition" : "exact approved I1 r3"} settle placement`,
        );
      const floor = i1.plan.surfaceSockets.find((socket) => socket.id === placement.supportSocketId);
      if (
        !floor ||
        floor.kind !== "floor" ||
        floor.roomId !== placement.roomId ||
        floor.normal[1] < 0.99999 ||
        floor.position.some((value, axis) => Math.abs(value - placement.position[axis]) > 0.05) ||
        floor.capacityKg < 350 ||
        floor.capacityKg + envelopeTolerance < furnitureMassKg + settle.ratedLoadKg
      )
        findings.push(`${placement.id} lacks the exact sufficient 350kg I1 r3 floor/load binding`);
      const target = i1.plan.facingTargets.find((entry) => entry.id === placement.facingTargetId);
      if (!target || target.roomId !== placement.roomId)
        findings.push(`${placement.id} lacks its exact hearth facing target`);
      else {
        const delta: V2 = [target.position[0] - placement.position[0], target.position[2] - placement.position[2]],
          length = Math.hypot(...delta),
          worldForward = rotate2([settle.canonicalForward[0], settle.canonicalForward[2]], placement.yawRadians),
          dot = length > 0 ? (worldForward[0] * delta[0] + worldForward[1] * delta[1]) / length : -1;
        if (dot < Math.cos((POLICY.settleFacingToleranceDeg * Math.PI) / 180))
          findings.push(`${placement.id} settle forward does not align with its approved hearth target`);
      }
      const clearances = i1.plan.interactionClearances.filter((clearance) => clearance.placementId === placement.id),
        occupancyClearances = clearances.filter((clearance) => clearance.kind === "occupancy"),
        approachClearances = clearances.filter((clearance) => clearance.kind === "approach"),
        expectedClearanceIds = new Set([
          "clearance/occupancy/hearth-settle-left",
          "clearance/occupancy/hearth-settle-right",
        ]);
      if (
        occupancyClearances.length !== 2 ||
        occupancyClearances.some((clearance) => !expectedClearanceIds.has(clearance.id)) ||
        occupancySockets.length !== 2
      )
        findings.push(`${placement.id} lacks the two exact I1 r3 occupancy clearances`);
      else
        for (const socket of occupancySockets) {
          const offset = rotate2([socket.position[0], socket.position[2]], placement.yawRadians),
            world: V2 = [placement.position[0] + offset[0], placement.position[2] + offset[1]],
            clearance = occupancyClearances.find(
              (entry) => Math.hypot(world[0] - entry.center[0], world[1] - entry.center[2]) <= envelopeTolerance,
            );
          if (
            !clearance ||
            clearance.roomId !== placement.roomId ||
            Math.abs(clearance.center[1] - placement.position[1]) > envelopeTolerance ||
            Math.abs(clearance.radiusM - 0.3) > 1e-8 ||
            clearance.heightM < 1.5
          )
            findings.push(`${placement.id} occupancy socket does not exactly fit its approved I1 r3 cylinder`);
        }
      const approach = contract.sockets.find((socket) => socket.id === settle.approachSocketId);
      if (
        approachClearances.length !== 1 ||
        approachClearances[0]?.id !== "clearance/approach/hearth-settle" ||
        !approach
      )
        findings.push(`${placement.id} lacks the exact front approach clearance`);
      else {
        const clearance = approachClearances[0],
          offset = rotate2([approach.position[0], approach.position[2]], placement.yawRadians),
          world: V3 = [
            placement.position[0] + offset[0],
            placement.position[1] + approach.position[1],
            placement.position[2] + offset[1],
          ];
        approachError = Math.hypot(
          world[0] - clearance.center[0],
          world[1] - clearance.center[1],
          world[2] - clearance.center[2],
        );
        const worldFacing = rotate2([approach.facing[0], approach.facing[2]], placement.yawRadians),
          worldForward = rotate2([settle.canonicalForward[0], settle.canonicalForward[2]], placement.yawRadians),
          inwardDot = worldFacing[0] * -worldForward[0] + worldFacing[1] * -worldForward[1];
        if (
          clearance.roomId !== placement.roomId ||
          approachError > envelopeTolerance ||
          Math.abs(clearance.radiusM - 0.35) > 1e-8 ||
          clearance.heightM < 1.9 ||
          inwardDot < 0.99999
        )
          findings.push(
            `${placement.id} front approach does not exactly fit or face inward through its I1 r3 cylinder`,
          );
        const own = settleBox(placement);
        if (circleOverlapsObb([clearance.center[0], clearance.center[2]], clearance.radiusM, own))
          findings.push(`${placement.id} front approach cylinder intersects the runtime settle`);
        for (const other of i1.plan.placements)
          if (
            other.id !== placement.id &&
            circleOverlapsObb([clearance.center[0], clearance.center[2]], clearance.radiusM, proxyBox(other))
          )
            findings.push(`${placement.id} front approach cylinder intersects ${other.id}`);
      }
      const placed = settleBox(placement);
      for (const other of i1.plan.placements)
        if (other.id !== placement.id && obbOverlaps(placed, proxyBox(other)))
          findings.push(`${placement.id} transformed runtime envelope intersects ${other.id}`);
      const hearths = i1.plan.hearthExclusions ?? [];
      if (hearths.length !== 1) findings.push(`${placement.id} lacks one exact I1 r3 hearth exclusion`);
      for (const hearth of hearths) {
        const frontOffset = hearth.halfExtents[1] + hearth.minimumClearanceM / 2,
          front: Obb2 = {
            center: [
              hearth.center[0] + Math.sin(hearth.yawRadians) * frontOffset,
              hearth.center[2] + Math.cos(hearth.yawRadians) * frontOffset,
            ],
            half: [hearth.halfExtents[0] + hearth.minimumClearanceM, hearth.minimumClearanceM / 2],
            yaw: hearth.yawRadians,
          };
        if (
          hearth.id !== "hearth-exclusion/hall-hearth" ||
          hearth.roomId !== placement.roomId ||
          hearth.minimumClearanceM < 0.8 ||
          obbOverlaps(placed, front)
        )
          findings.push(`${placement.id} transformed runtime envelope violates the approved hearth exclusion`);
      }
    }
    return {
      findings,
      metrics: {
        applicable: true,
        placements: placements.length,
        occupancies: occupancySockets.length,
        approachErrorM: round(approachError),
        loadedStabilityMarginM: round(loadedMargin),
        ratedLoadKg: settle.ratedLoadKg,
      },
    };
  });

  check("storage-i1-functional-placement", () => {
    const findings: string[] = [];
    if (!storage)
      return {
        findings,
        metrics: {
          applicable: false,
          placements: 0,
          tiers: 0,
          approachErrorM: 0,
          loadedStabilityMarginM: 0,
          ratedLoadKg: 0,
        },
      };
    if (archetype?.kind !== "storage") findings.push("storage semantics are not bound to an I1 storage archetype");
    if (input.selectedProxyArchetypeId === "proxy/storage-shelf" && placements.length !== 1)
      findings.push("approved service-storage proxy does not resolve exactly one placement");

    const tiers = storage.tierPartIds.map((id) => runtimeParts.get(id)?.bounds),
      supports = storage.verticalSupportPartIds.map((id) => runtimeParts.get(id)?.bounds);
    if (tiers.some((bounds) => !bounds)) findings.push("semantic storage tiers lack actual geometry");
    if (supports.some((bounds) => !bounds)) findings.push("semantic storage supports lack actual geometry");
    const actualTiers = tiers
      .filter((bounds): bounds is Bounds => bounds !== undefined)
      .sort((left, right) => left.max[1] - right.max[1]);
    for (const tier of actualTiers) {
      const size = dimensions(tier);
      if (size[1] > 0.08 + envelopeTolerance || size[0] < 0.28 - envelopeTolerance || size[2] < 0.8 - envelopeTolerance)
        findings.push("storage tier does not provide a usable horizontal service surface");
    }
    for (let index = 1; index < actualTiers.length; index++)
      if (actualTiers[index].min[1] - actualTiers[index - 1].max[1] < 0.3 - envelopeTolerance)
        findings.push("storage tiers do not provide ordered usable vertical clearance");
    for (const tierId of storage.tierPartIds) {
      const joinedSupports = new Set(
        contract.joints.flatMap((joint) => {
          if (!joint.members.includes(tierId)) return [];
          const other = joint.members[0] === tierId ? joint.members[1] : joint.members[0];
          return storage.verticalSupportPartIds.includes(other) ? [other] : [];
        }),
      );
      if (joinedSupports.size < 2)
        findings.push(`storage tier ${tierId} is not joined to two declared vertical supports`);
    }

    const supportBounds = supports.filter((bounds): bounds is Bounds => bounds !== undefined);
    for (const support of supportBounds)
      if (support.min[1] > build.bounds.min[1] + POLICY.floorToleranceM)
        findings.push("storage vertical support does not reach the floor");
    const supportPolygon = hull(
      supportBounds.flatMap(
        (entry) =>
          [
            [entry.min[0], entry.min[2]],
            [entry.min[0], entry.max[2]],
            [entry.max[0], entry.min[2]],
            [entry.max[0], entry.max[2]],
          ] as V2[],
      ),
    );
    const allParts = [...runtimeParts.values()].filter((entry) => validBounds(entry.bounds));
    const totalVolume = allParts.reduce((sum, entry) => sum + volume(entry.bounds), 0),
      furnitureMassKg = totalVolume * POLICY.furnitureDensityKgM3;
    const furnitureCom: V2 =
      totalVolume > 0
        ? [
            allParts.reduce(
              (sum, entry) => sum + (entry.bounds.min[0] + entry.bounds.max[0]) * 0.5 * volume(entry.bounds),
              0,
            ) / totalVolume,
            allParts.reduce(
              (sum, entry) => sum + (entry.bounds.min[2] + entry.bounds.max[2]) * 0.5 * volume(entry.bounds),
              0,
            ) / totalVolume,
          ]
        : [NaN, NaN];
    const payloadKg = storage.ratedLoadKgPerTier * storage.tierPartIds.length,
      payloadPoints = actualTiers.map((tier): V2 => [tier.min[0], (tier.min[2] + tier.max[2]) * 0.5]);
    const loadedCom: V2 =
      payloadPoints.length === 4 && furnitureMassKg + payloadKg > 0
        ? [
            (furnitureCom[0] * furnitureMassKg +
              payloadPoints.reduce((sum, point) => sum + point[0] * storage.ratedLoadKgPerTier, 0)) /
              (furnitureMassKg + payloadKg),
            (furnitureCom[1] * furnitureMassKg +
              payloadPoints.reduce((sum, point) => sum + point[1] * storage.ratedLoadKgPerTier, 0)) /
              (furnitureMassKg + payloadKg),
          ]
        : [NaN, NaN];
    const loadedMargin = supportPolygon.length >= 3 ? polygonMargin(loadedCom, supportPolygon) : -1;
    if (supportPolygon.length < 3 || loadedMargin < POLICY.storageMinimumStabilityMarginM)
      findings.push("front-loaded storage does not retain the required support-polygon stability margin");

    const tierSet = new Set(storage.tierPartIds),
      supportSet = new Set(storage.verticalSupportPartIds),
      centerX = (build.bounds.min[0] + build.bounds.max[0]) * 0.5;
    for (let index = 1; index < actualTiers.length; index++) {
      const lower = actualTiers[index - 1],
        upper = actualTiers[index],
        aperture: Bounds = {
          min: [build.bounds.min[0], lower.max[1] + 0.005, Math.max(lower.min[2], upper.min[2]) + 0.05],
          max: [centerX, upper.min[1] - 0.005, Math.min(lower.max[2], upper.max[2]) - 0.05],
        };
      if (aperture.max[2] - aperture.min[2] < 0.7 - envelopeTolerance)
        findings.push("storage open-front aperture is too narrow");
      for (const part of allParts) {
        if (tierSet.has(part.id) || supportSet.has(part.id)) continue;
        const depth = overlapDepths(part.bounds, aperture);
        if (depth.every((axis) => axis > 0.01)) findings.push(`storage open-front aperture is occluded by ${part.id}`);
      }
    }

    const approach = contract.sockets.find((socket) => socket.id === storage.approachSocketId);
    const actualCenter: V2 = [
        (build.bounds.min[0] + build.bounds.max[0]) / 2,
        (build.bounds.min[2] + build.bounds.max[2]) / 2,
      ],
      actualHalf: V2 = [
        (build.bounds.max[0] - build.bounds.min[0]) / 2,
        (build.bounds.max[2] - build.bounds.min[2]) / 2,
      ];
    const proxyBox = (placement: ApprovedInteriorPlanClosure["plan"]["placements"][number]): Obb2 => {
      const offset = rotate2(placement.footprint.localCenter, placement.yawRadians);
      return {
        center: [placement.position[0] + offset[0], placement.position[2] + offset[1]],
        half: placement.footprint.halfExtents,
        yaw: placement.yawRadians,
      };
    };
    const storageBox = (placement: ApprovedInteriorPlanClosure["plan"]["placements"][number]): Obb2 => {
      const offset = rotate2(actualCenter, placement.yawRadians);
      return {
        center: [placement.position[0] + offset[0], placement.position[2] + offset[1]],
        half: actualHalf,
        yaw: placement.yawRadians,
      };
    };
    let approachError = Infinity;
    for (const placement of placements) {
      const support = i1.plan.surfaceSockets.find((socket) => socket.id === placement.supportSocketId),
        clearances = i1.plan.interactionClearances.filter(
          (clearance) => clearance.placementId === placement.id && clearance.kind === "approach",
        );
      if (
        !support ||
        support.kind !== "floor" ||
        support.roomId !== placement.roomId ||
        support.normal[1] < 0.9 ||
        Math.hypot(
          support.position[0] - placement.position[0],
          support.position[1] - placement.position[1],
          support.position[2] - placement.position[2],
        ) > 0.05 ||
        support.capacityKg < furnitureMassKg + payloadKg
      )
        findings.push(`${placement.id} lacks a sufficient exact storage floor/load binding`);
      if (!approach || clearances.length !== 1)
        findings.push(`${placement.id} lacks one exact storage approach clearance`);
      else {
        const clearance = clearances[0],
          offset = rotate2([approach.position[0], approach.position[2]], placement.yawRadians),
          worldSocket: V3 = [
            placement.position[0] + offset[0],
            placement.position[1] + approach.position[1],
            placement.position[2] + offset[1],
          ];
        approachError = Math.hypot(
          worldSocket[0] - clearance.center[0],
          worldSocket[1] - clearance.center[1],
          worldSocket[2] - clearance.center[2],
        );
        const worldFacing = rotate2([approach.facing[0], approach.facing[2]], placement.yawRadians),
          worldFront = rotate2([storage.canonicalFront[0], storage.canonicalFront[2]], placement.yawRadians),
          facingDot = worldFacing[0] * -worldFront[0] + worldFacing[1] * -worldFront[1];
        if (
          clearance.roomId !== placement.roomId ||
          approachError > envelopeTolerance ||
          approach.clearanceRadiusM > clearance.radiusM + envelopeTolerance ||
          clearance.heightM < 1.9 ||
          facingDot < 0.99999
        )
          findings.push(
            `${placement.id} storage approach does not fit or face inward through its approved I1 cylinder`,
          );
        const ownBox = storageBox(placement);
        if (circleOverlapsObb([clearance.center[0], clearance.center[2]], clearance.radiusM, ownBox))
          findings.push(`${placement.id} storage approach cylinder intersects the runtime rack`);
        for (const other of i1.plan.placements)
          if (
            other.id !== placement.id &&
            circleOverlapsObb([clearance.center[0], clearance.center[2]], clearance.radiusM, proxyBox(other))
          )
            findings.push(`${placement.id} storage approach cylinder intersects ${other.id}`);
      }
      const placed = storageBox(placement);
      for (const other of i1.plan.placements)
        if (other.id !== placement.id && obbOverlaps(placed, proxyBox(other)))
          findings.push(`${placement.id} transformed runtime envelope intersects ${other.id}`);
    }
    return {
      findings,
      metrics: {
        applicable: true,
        placements: placements.length,
        tiers: actualTiers.length,
        approachErrorM: round(approachError),
        loadedStabilityMarginM: round(loadedMargin),
        ratedLoadKg: payloadKg,
      },
    };
  });

  check("compound-collider-coverage", () => {
    const findings: string[] = [],
      covered = new Set<string>(),
      assetVolume = volume(build.bounds),
      colliderVolume = contract.colliders.reduce(
        (sum, collider) => sum + 8 * collider.halfExtents[0] * collider.halfExtents[1] * collider.halfExtents[2],
        0,
      );
    if (contract.colliders.length < 2) findings.push("collision is not compound");
    for (const collider of contract.colliders) {
      const colliderBounds: Bounds = {
        min: collider.center.map((value, axis) => value - collider.halfExtents[axis]) as unknown as V3,
        max: collider.center.map((value, axis) => value + collider.halfExtents[axis]) as unknown as V3,
      };
      if (
        !inside(colliderBounds.min, build.bounds, POLICY.colliderSlopM) ||
        !inside(colliderBounds.max, build.bounds, POLICY.colliderSlopM)
      )
        findings.push(`collider ${collider.id} escapes runtime geometry envelope`);
      for (const partId of collider.covers) {
        const part = runtimeParts.get(partId)?.bounds;
        if (
          !part ||
          !overlaps(colliderBounds, part, POLICY.colliderSlopM) ||
          !inside(
            [(part.min[0] + part.max[0]) / 2, (part.min[1] + part.max[1]) / 2, (part.min[2] + part.max[2]) / 2],
            colliderBounds,
            POLICY.colliderSlopM,
          )
        )
          findings.push(`collider ${collider.id} does not plausibly cover ${partId}`);
        else covered.add(partId);
      }
    }
    for (const part of contract.parts)
      if (part.kind !== "peg" && !covered.has(part.id))
        findings.push(`semantic part ${part.id} has no plausible collider coverage`);
    if (assetVolume <= 0 || colliderVolume / assetVolume > POLICY.maximumColliderToAssetVolumeRatio)
      findings.push("compound collider volume is implausible for runtime geometry");
    return {
      findings,
      metrics: {
        colliderToAssetVolumeRatio: round(colliderVolume / assetVolume),
        colliders: contract.colliders.length,
        coveredParts: covered.size,
      },
    };
  });

  check("lod-proof", () => {
    const findings = lodClaimPaths(build),
      proof = build.glbValidation.lodValidation;
    if (
      proof &&
      (proof.proven !== true ||
        !Array.isArray(proof.levels) ||
        proof.levels.length === 0 ||
        proof.levels.some((level) => !level.id || !HASH.test(level.assetSha256) || level.semanticIdentity !== true))
    )
      findings.push("LOD validation is not exact and proven");
    if (findings.length > 0 && !proof) findings.push("build evidence makes an unproven LOD claim");
    return { findings, metrics: { claimedPaths: findings.length, provenLevels: proof?.levels.length ?? 0 } };
  });

  const failed = checks.filter((entry) => !entry.passed).length;
  return Object.freeze({
    schema: "limina.furniture-functional-evidence/v1",
    verdict: failed === 0 ? "pass" : "fail",
    inputs: {
      furnitureContractHash: input.contractHash,
      runtimeGlbSha256: input.runtimeGlbSha256,
      runtimeSemanticInventorySha256: build.freshProcessValidation?.semanticInventorySha256 ?? "",
      interiorArtifactId: i1.artifact.artifactId,
      interiorContractHash: i1.canonicalPlanHash,
      interiorContentHash: i1.planContentHash,
      selectedProxyArchetypeId: input.selectedProxyArchetypeId,
    },
    policy: POLICY,
    checks,
    summary: { passed: checks.length - failed, failed },
  });
}

export function furnitureFunctionalEvidenceCanonicalText(value: FurnitureFunctionalEvidence): string {
  return canonicalStringify(value);
}
