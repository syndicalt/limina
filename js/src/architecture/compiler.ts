import { canonicalStringify } from "../authoring/canonical.ts";
import { sha256 } from "../world/sha256.mjs";
import {
  ARCHITECTURE_COMPILE,
  ARCHITECTURE_SPEC,
  type ArchitecturePrimitive,
  type ArchitectureSpec,
  type CompiledArchitecture,
  type CompiledDomesticProp,
  type CompiledDoor,
  type CompiledDormer,
  type CompiledEntrance,
  type CompiledFireplace,
  type CompiledFurnishing,
  type CompiledInteriorStructure,
  type CompiledPerceptualTimberFrame,
  type CompiledPracticalLight,
  type CompiledRoofPenetration,
  type CompiledRoofSeam,
  type CompiledVolume,
  type CompiledWall,
  type CompiledWindow,
  type Diagnostic,
  type FunctionalArchitectureSpecV2,
  type InteriorPartitionSpec,
  type LinearMember,
  type LathedProfile,
  type OrientedCylinder,
  type PlaneSlab,
  type PolygonSlab,
  type RoofPlaneSpec,
  type RoofSeamSpec,
  type SolidBox,
  type TaperedFlame,
  type V2,
  type V3,
  type WallOpeningSpec,
  type WallRunSpec,
} from "./schema.ts";
import { createArchitectureReview } from "./stages.ts";

const EPS = 1e-6,
  hash = (value: unknown) => `sha256:${sha256(canonicalStringify(value))}`;
const finite = (n: number, label: string) => {
  if (!Number.isFinite(n))
    throw new Error(`architecture: ${label} must be finite`);
  return n;
};
const v2 = (v: V2, label: string): V2 => [
  finite(v[0], `${label}.x`),
  finite(v[1], `${label}.z`),
];
const v3 = (v: V3, label: string): V3 => [
  finite(v[0], `${label}.x`),
  finite(v[1], `${label}.y`),
  finite(v[2], `${label}.z`),
];
const len2 = (a: V2, b: V2) => Math.hypot(b[0] - a[0], b[1] - a[1]);
const box = (
  id: string,
  center: V3,
  halfExtents: V3,
  derivedFrom: readonly string[],
  yawRadians?: number,
): SolidBox => {
  v3(center, `${id}.center`);
  v3(halfExtents, `${id}.halfExtents`);
  if (halfExtents.some((n) => n <= 0))
    throw new Error(`architecture: primitive ${id} must have positive extents`);
  if (yawRadians !== undefined) finite(yawRadians, `${id}.yawRadians`);
  return Object.freeze({
    kind: "box",
    id,
    center: Object.freeze(center),
    halfExtents: Object.freeze(halfExtents),
    ...(yawRadians !== undefined ? { yawRadians } : {}),
    derivedFrom: Object.freeze([...derivedFrom]),
  });
};
const cylinder = (
  id: string,
  from: V3,
  to: V3,
  radius: number,
  vertices: number,
  derivedFrom: readonly string[],
): OrientedCylinder => {
  v3(from, `${id}.from`);
  v3(to, `${id}.to`);
  if (
    Math.hypot(to[0] - from[0], to[1] - from[1], to[2] - from[2]) <= EPS ||
    radius <= 0 ||
    !Number.isSafeInteger(vertices) ||
    vertices < 8
  )
    throw new Error(`architecture: invalid oriented cylinder ${id}`);
  return Object.freeze({
    kind: "oriented-cylinder",
    id,
    from: Object.freeze(from),
    to: Object.freeze(to),
    radius,
    vertices,
    derivedFrom: Object.freeze([...derivedFrom]),
  });
};
const taperedFlame = (
  id: string,
  baseCenter: V3,
  height: number,
  baseRadius: number,
  tipOffset: V3,
  vertices: number,
  derivedFrom: readonly string[],
): TaperedFlame => {
  v3(baseCenter, `${id}.baseCenter`);
  v3(tipOffset, `${id}.tipOffset`);
  if (
    height <= 0 ||
    baseRadius <= 0 ||
    !Number.isSafeInteger(vertices) ||
    vertices < 8
  )
    throw new Error(`architecture: invalid tapered flame ${id}`);
  return Object.freeze({
    kind: "tapered-flame",
    id,
    baseCenter: Object.freeze(baseCenter),
    height,
    baseRadius,
    tipOffset: Object.freeze(tipOffset),
    vertices,
    derivedFrom: Object.freeze([...derivedFrom]),
  });
};
const lathedProfile = (
  id: string,
  center: V3,
  profile: readonly V2[],
  vertices: number,
  derivedFrom: readonly string[],
): LathedProfile => {
  v3(center, `${id}.center`);
  if (
    profile.length < 3 ||
    profile.some(([radius, y]) =>
      !Number.isFinite(radius) || !Number.isFinite(y) || radius < 0
    ) ||
    !Number.isSafeInteger(vertices) ||
    vertices < 12
  ) throw new Error(`architecture: invalid lathed profile ${id}`);
  return Object.freeze({
    kind: "lathed-profile",
    id,
    center: Object.freeze(center),
    profile: Object.freeze(profile.map((point) => Object.freeze([...point]) as V2)),
    vertices,
    derivedFrom: Object.freeze([...derivedFrom]),
  });
};
const signedPlaneDistance = (p: V3, o: V3, n: V3) =>
  (p[0] - o[0]) * n[0] + (p[1] - o[1]) * n[1] + (p[2] - o[2]) * n[2];
const pointPlaneDistance = (p: V3, o: V3, n: V3) =>
  Math.abs(signedPlaneDistance(p, o, n));
const dominantAxis = (n: V3) =>
  Math.abs(n[0]) >= Math.abs(n[1]) && Math.abs(n[0]) >= Math.abs(n[2])
    ? 0
    : Math.abs(n[1]) >= Math.abs(n[2])
      ? 1
      : 2;
const projected = (p: V3, drop: number): V2 =>
  drop === 0 ? [p[1], p[2]] : drop === 1 ? [p[0], p[2]] : [p[0], p[1]];
const insideBoundary = (
  point: V3,
  boundary: readonly V3[],
  normal: V3,
  tolerance = 0.003,
) => {
  const drop = dominantAxis(normal),
    p = projected(point, drop),
    polygon = boundary.map((v) => projected(v, drop));
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[j],
      b = polygon[i],
      dx = b[0] - a[0],
      dy = b[1] - a[1],
      cross = dx * (p[1] - a[1]) - dy * (p[0] - a[0]),
      dot = (p[0] - a[0]) * (p[0] - b[0]) + (p[1] - a[1]) * (p[1] - b[1]);
    if (Math.abs(cross) <= tolerance && dot <= tolerance) return true;
    if (
      a[1] > p[1] !== b[1] > p[1] &&
      p[0] < (dx * (p[1] - a[1])) / (dy || Number.EPSILON) + a[0]
    )
      inside = !inside;
  }
  return inside;
};
const seamSamples = (a: V3, b: V3) =>
  Array.from({ length: 9 }, (_, i) => {
    const t = i / 8;
    return [
      a[0] + (b[0] - a[0]) * t,
      a[1] + (b[1] - a[1]) * t,
      a[2] + (b[2] - a[2]) * t,
    ] as V3;
  });
const polygonArea = (points: readonly V2[]) =>
  points.reduce((sum, p, i) => {
    const q = points[(i + 1) % points.length];
    return sum + p[0] * q[1] - q[0] * p[1];
  }, 0) / 2;
const orient = (a: V2, b: V2, c: V2) =>
  (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
const segmentsCross = (a: V2, b: V2, c: V2, d: V2) => {
  const ab1 = orient(a, b, c),
    ab2 = orient(a, b, d),
    cd1 = orient(c, d, a),
    cd2 = orient(c, d, b);
  return ab1 * ab2 < -EPS && cd1 * cd2 < -EPS;
};
const insideFootprint = (point: V2, polygon: readonly V2[]) => {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[j], b = polygon[i], cross = orient(a, b, point),
      dot = (point[0] - a[0]) * (point[0] - b[0]) + (point[1] - a[1]) * (point[1] - b[1]);
    if (Math.abs(cross) <= EPS && dot <= EPS) return true;
    if (a[1] > point[1] !== b[1] > point[1] &&
      point[0] < (b[0] - a[0]) * (point[1] - a[1]) / (b[1] - a[1]) + a[0]) inside = !inside;
  }
  return inside;
};
const validateFootprint = (id: string, points: readonly V2[]) => {
  if (points.length < 3)
    throw new Error(
      `architecture: volume ${id} footprint needs at least three vertices`,
    );
  points.forEach((p, i) => v2(p, `${id}.footprint[${i}]`));
  if (polygonArea(points) <= EPS)
    throw new Error(
      `architecture: volume ${id} footprint must be counter-clockwise and nondegenerate`,
    );
  for (let i = 0; i < points.length; i++) {
    const a = points[i],
      b = points[(i + 1) % points.length];
    if (len2(a, b) <= EPS)
      throw new Error(`architecture: volume ${id} has a zero-length edge`);
    for (let j = i + 1; j < points.length; j++) {
      if (
        j === i ||
        j === (i + 1) % points.length ||
        i === (j + 1) % points.length
      )
        continue;
      if (segmentsCross(a, b, points[j], points[(j + 1) % points.length]))
        throw new Error(`architecture: volume ${id} footprint self-intersects`);
    }
  }
};
type AxisAlignedBounds = Readonly<{ x0: number; x1: number; z0: number; z1: number }>;
const axisAlignedBounds = (points: readonly V2[]): AxisAlignedBounds | undefined => {
  if (points.length !== 4) return undefined;
  const xs = points.map((point) => point[0]), zs = points.map((point) => point[1]),
    x0 = Math.min(...xs), x1 = Math.max(...xs), z0 = Math.min(...zs), z1 = Math.max(...zs),
    corners = new Set([`${x0}/${z0}`, `${x1}/${z0}`, `${x1}/${z1}`, `${x0}/${z1}`]);
  return points.every((point) => corners.has(`${point[0]}/${point[1]}`))
    ? Object.freeze({ x0, x1, z0, z1 })
    : undefined;
};
const rectangularUnionCovers = (target: readonly V2[], supports: readonly (readonly V2[])[]): boolean => {
  const targetBounds = axisAlignedBounds(target), supportBounds = supports.map(axisAlignedBounds);
  if (!targetBounds || supportBounds.some((bounds) => bounds === undefined)) return false;
  const rectangles = supportBounds as AxisAlignedBounds[], uniqueSorted = (values: number[]) =>
    values.sort((a, b) => a - b).filter((value, index, ordered) => index === 0 || Math.abs(value - ordered[index - 1]) > EPS),
    xs = uniqueSorted([targetBounds.x0, targetBounds.x1, ...rectangles.flatMap(({ x0, x1 }) => [
      Math.max(targetBounds.x0, Math.min(targetBounds.x1, x0)),
      Math.max(targetBounds.x0, Math.min(targetBounds.x1, x1)),
    ])]),
    zs = uniqueSorted([targetBounds.z0, targetBounds.z1, ...rectangles.flatMap(({ z0, z1 }) => [
      Math.max(targetBounds.z0, Math.min(targetBounds.z1, z0)),
      Math.max(targetBounds.z0, Math.min(targetBounds.z1, z1)),
    ])]);
  for (let xi = 0; xi < xs.length - 1; xi++) for (let zi = 0; zi < zs.length - 1; zi++) {
    if (xs[xi + 1] - xs[xi] <= EPS || zs[zi + 1] - zs[zi] <= EPS) continue;
    const x = (xs[xi] + xs[xi + 1]) / 2, z = (zs[zi] + zs[zi + 1]) / 2;
    if (!rectangles.some((bounds) => x >= bounds.x0 - EPS && x <= bounds.x1 + EPS && z >= bounds.z0 - EPS && z <= bounds.z1 + EPS)) return false;
  }
  return true;
};
const polygonSlab = (
  id: string,
  boundary: readonly V2[],
  bottomY: number,
  topY: number,
  derivedFrom: readonly string[],
): PolygonSlab => {
  finite(bottomY, `${id}.bottomY`);
  finite(topY, `${id}.topY`);
  if (topY - bottomY <= EPS)
    throw new Error(`architecture: slab ${id} must have positive thickness`);
  return Object.freeze({
    kind: "polygon-slab",
    id,
    boundary: Object.freeze(boundary.map((p) => Object.freeze([...p]) as V2)),
    bottomY,
    topY,
    derivedFrom: Object.freeze([...derivedFrom]),
  });
};
const cross3 = (a: V3, b: V3): V3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const dot3 = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const scale3 = (v: V3, s: number): V3 => [v[0] * s, v[1] * s, v[2] * s];
const add3 = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub3 = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const unit3 = (v: V3): V3 => {
  const length = Math.hypot(...v);
  if (length < EPS)
    throw new Error("architecture: cannot normalize a zero vector");
  return scale3(v, 1 / length);
};
const mean3 = (a: V3, b: V3): V3 => scale3(add3(a, b), 0.5);
const planeNormal = (boundary: readonly V3[]) => {
  let normal = unit3(
    cross3(sub3(boundary[1], boundary[0]), sub3(boundary[2], boundary[0])),
  );
  if (normal[1] < 0) normal = scale3(normal, -1);
  return normal;
};
const intersectRoofPlanes = (
  a: RoofPlaneSpec,
  b: RoofPlaneSpec,
): readonly [V3, V3] | undefined => {
  const direction = cross3(a.normal, b.normal),
    denom = dot3(direction, direction);
  if (denom < EPS) return;
  const d1 = dot3(a.normal, a.origin),
    d2 = dot3(b.normal, b.origin),
    point = scale3(
      add3(
        scale3(cross3(b.normal, direction), d1),
        scale3(cross3(direction, a.normal), d2),
      ),
      1 / denom,
    );
  let lo = -1e6,
    hi = 1e6;
  for (const plane of [a, b]) {
    const drop = dominantAxis(plane.normal),
      p = projected(point, drop),
      d = projected(direction, drop),
      poly = plane.boundary.map((v) => projected(v, drop)),
      winding = Math.sign(polygonArea(poly));
    for (let i = 0; i < poly.length; i++) {
      const e0 = poly[i],
        e1 = poly[(i + 1) % poly.length],
        ex = e1[0] - e0[0],
        ey = e1[1] - e0[1],
        constant = winding * (ex * (p[1] - e0[1]) - ey * (p[0] - e0[0])),
        coefficient = winding * (ex * d[1] - ey * d[0]);
      if (Math.abs(coefficient) < EPS) {
        if (constant < -0.003) return;
        continue;
      }
      const bound = (-0.003 - constant) / coefficient;
      if (coefficient > 0) lo = Math.max(lo, bound);
      else hi = Math.min(hi, bound);
      if (lo > hi) return;
    }
  }
  const from = add3(point, scale3(direction, lo)),
    to = add3(point, scale3(direction, hi));
  return Math.hypot(to[0] - from[0], to[1] - from[1], to[2] - from[2]) > 0.05
    ? [from, to]
    : undefined;
};
const signedRoofPlaneDistance = (point: V3, plane: RoofPlaneSpec) =>
  dot3(sub3(point, plane.origin), plane.normal);
const clipRoofBoundary = (
  boundary: readonly V3[],
  plane: RoofPlaneSpec,
  keepSign: 1 | -1,
): V3[] => {
  const result: V3[] = [],
    distance = (point: V3) => keepSign * signedRoofPlaneDistance(point, plane),
    inside = (point: V3) => distance(point) >= -0.003;
  for (let index = 0; index < boundary.length; index++) {
    const from = boundary[index],
      to = boundary[(index + 1) % boundary.length],
      fromInside = inside(from),
      toInside = inside(to),
      fromDistance = distance(from),
      toDistance = distance(to);
    if (fromInside) result.push([...from] as V3);
    if (fromInside !== toInside) {
      const t = fromDistance / (fromDistance - toDistance);
      result.push(add3(from, scale3(sub3(to, from), t)));
    }
  }
  const deduplicated = result.filter(
    (point, index) =>
      index === 0 || Math.hypot(...sub3(point, result[index - 1])) > 1e-6,
  );
  if (
    deduplicated.length > 2 &&
    Math.hypot(...sub3(deduplicated[0], deduplicated.at(-1)!)) <= 1e-6
  )
    deduplicated.pop();
  if (deduplicated.length < 3)
    throw new Error("architecture: roof junction trim produced a degenerate substrate");
  return deduplicated;
};

export function compileArchitecture(
  input: ArchitectureSpec,
): CompiledArchitecture {
  if (input.schema !== ARCHITECTURE_SPEC)
    throw new Error("architecture: unsupported spec schema");
  if (!input.id.trim()) throw new Error("architecture: id is required");
  const diagnostics: Diagnostic[] = [],
    ids = new Set<string>();
  const own = (id: string) => {
    if (!id.trim() || ids.has(id))
      throw new Error(`architecture: duplicate or empty id ${id}`);
    ids.add(id);
  };
  const volumeSpecs = input.volumes ?? [],
    explicitWalls = input.walls ?? [],
    interiorPartitionSpecs = input.interiorPartitions ?? [],
    doorSpecs = input.doors ?? [],
    roofSystems = input.roofSystems ?? [],
    roofJunctions = input.roofJunctions ?? [],
    roofWallAbutmentSpecs = input.roofWallAbutments ?? [],
    dormerSpecs = input.dormers ?? [],
    penetrationSpecs = input.roofPenetrations ?? [],
    explicitRoofPlanes = input.roofPlanes ?? [],
    explicitRoofSeams = input.roofSeams ?? [];
  if (volumeSpecs.length && explicitWalls.length)
    throw new Error(
      "architecture: choose volume authority or explicit wall authority, not both",
    );
  if (roofSystems.length && explicitRoofPlanes.length)
    throw new Error(
      "architecture: choose roof-system authority or explicit roof-plane authority, not both",
    );
  for (const collection of [
    input.foundations,
    volumeSpecs,
    explicitWalls,
    interiorPartitionSpecs,
    input.entrances,
    doorSpecs,
    roofSystems,
    roofJunctions,
    roofWallAbutmentSpecs,
    dormerSpecs,
    penetrationSpecs,
    explicitRoofPlanes,
    explicitRoofSeams,
    input.fireplaces ?? [],
    input.practicalLights ?? [],
    input.furnishings ?? [],
    input.interiorStructure ?? [],
    input.perceptualTimberFrames ?? [],
    input.domesticProps ?? [],
  ])
    for (const item of collection) own(item.id);
  const foundations = input.foundations.map((f) => {
    v2(f.center, f.id);
    v2(f.halfExtents, f.id);
    if (f.halfExtents.some((n) => n <= 0) || f.depth <= 0)
      throw new Error(
        `architecture: ${f.id} foundation dimensions must be positive`,
      );
    return box(
      `foundation/${f.id}`,
      [f.center[0], f.topY - f.depth / 2, f.center[1]],
      [f.halfExtents[0], f.depth / 2, f.halfExtents[1]],
      [f.id],
    );
  });
  const foundationSpecById = new Map(input.foundations.map((f) => [f.id, f])),
    declaredVolumeById = new Map(volumeSpecs.map((volume) => [volume.id, volume])),
    derivedWalls: WallRunSpec[] = [],
    volumes: CompiledVolume[] = [];
  for (const volume of volumeSpecs) {
    validateFootprint(volume.id, volume.footprint);
    if (
      volume.eaveY <= volume.floorY ||
      volume.wallThickness <= 0 ||
      volume.floorThickness <= 0 ||
      volume.ceilingThickness <= 0
    )
      throw new Error(`architecture: invalid volume ${volume.id}`);
    if (volume.supportVolumeId !== undefined && volume.supportVolumeIds !== undefined)
      throw new Error(`architecture: upper volume ${volume.id} must choose one support authority`);
    const foundation = foundationSpecById.get(volume.foundationId), supportIds = volume.supportVolumeIds === undefined
        ? (volume.supportVolumeId === undefined ? [] : [volume.supportVolumeId])
        : [...volume.supportVolumeIds],
      supports = supportIds.map((id) => declaredVolumeById.get(id));
    if (volume.supportVolumeIds !== undefined && (supportIds.length < 2 || supportIds.length > 8 || new Set(supportIds).size !== supportIds.length))
      throw new Error(`architecture: upper volume ${volume.id} supportVolumeIds must contain 2..8 unique ids`);
    if (supportIds.length) {
      if (supports.some((support) => !support || support === volume || Math.abs(support.eaveY - volume.floorY) > .001))
        throw new Error(volume.supportVolumeIds === undefined
          ? `architecture: upper volume ${volume.id} is not fully supported by ${supportIds[0]}`
          : `architecture: upper volume ${volume.id} has invalid support volume authority`);
      const covered = volume.supportVolumeIds === undefined
        ? volume.footprint.every((point) => insideFootprint(point, supports[0]!.footprint))
        : rectangularUnionCovers(volume.footprint, supports.map((support) => support!.footprint));
      if (!covered)
        throw new Error(`architecture: upper volume ${volume.id} is not fully supported by ${supportIds.join(",")}`);
    } else {
      if (!foundation)
        throw new Error(`architecture: volume ${volume.id} has missing foundation`);
      if (
        Math.abs(foundation.topY - volume.floorY) > 0.15 ||
        volume.footprint.some((p) =>
          Math.abs(p[0] - foundation.center[0]) > foundation.halfExtents[0] + EPS ||
          Math.abs(p[1] - foundation.center[1]) > foundation.halfExtents[1] + EPS)
      ) throw new Error(`architecture: volume ${volume.id} is not fully supported by ${volume.foundationId}`);
    }
    const openingsByEdge = new Map<number, typeof volume.openings>();
    for (const opening of volume.openings ?? []) {
      if (
        !Number.isSafeInteger(opening.edgeIndex) ||
        opening.edgeIndex < 0 ||
        opening.edgeIndex >= volume.footprint.length
      )
        throw new Error(
          `architecture: opening ${opening.id} has invalid volume edge`,
        );
      openingsByEdge.set(opening.edgeIndex, [
        ...(openingsByEdge.get(opening.edgeIndex) ?? []),
        opening,
      ]);
    }
    const wallIds: string[] = [];
    for (let edge = 0; edge < volume.footprint.length; edge++) {
      const id = `${volume.id}/edge-${edge}`;
      own(id);
      wallIds.push(id);
      derivedWalls.push({
        id,
        from: volume.footprint[edge],
        to: volume.footprint[(edge + 1) % volume.footprint.length],
        bottomY: volume.floorY,
        topY: volume.eaveY,
        thickness: volume.wallThickness,
        openings: (openingsByEdge.get(edge) ?? []).map(
          ({ edgeIndex: _, ...opening }) => opening,
        ),
      });
    }
    const floor = polygonSlab(
        `volume/${volume.id}/floor`,
        volume.footprint,
        volume.floorY - volume.floorThickness,
        volume.floorY,
        [volume.id, ...(supportIds.length ? supportIds : [volume.foundationId])],
      ),
      ceiling = polygonSlab(
        `volume/${volume.id}/ceiling`,
        volume.footprint,
        volume.eaveY - volume.ceilingThickness,
        volume.eaveY,
        [volume.id],
      );
    volumes.push(
      Object.freeze({
        id: volume.id,
        wallIds: Object.freeze(wallIds),
        floor,
        ceiling,
      }),
    );
  }
  const volumeSpecById = new Map(
      volumeSpecs.map((volume) => [volume.id, volume]),
    ),
    roofPlaneSpecs: RoofPlaneSpec[] = [...explicitRoofPlanes],
    roofSeamSpecs: RoofSeamSpec[] = [...explicitRoofSeams],
    systemPlaneIds = new Map<string, string[]>(),
    gableClosures: any[] = [];
  for (const system of roofSystems) {
    const volume = volumeSpecById.get(system.volumeId);
    if (!volume)
      throw new Error(
        `architecture: roof system ${system.id} has missing volume`,
      );
    if (
      system.kind !== "gable" ||
      system.pitchDegrees < 20 ||
      system.pitchDegrees > 70 ||
      system.eaveOverhang < 0 ||
      system.ridgeEndOverhang.some((n) => !Number.isFinite(n) || n < 0) ||
      system.thickness <= 0
    )
      throw new Error(`architecture: invalid roof system ${system.id}`);
    const xs = volume.footprint.map((p) => p[0]),
      zs = volume.footprint.map((p) => p[1]),
      minX = Math.min(...xs),
      maxX = Math.max(...xs),
      minZ = Math.min(...zs),
      maxZ = Math.max(...zs);
    if (
      volume.footprint.some(
        (p) =>
          (Math.abs(p[0] - minX) > EPS && Math.abs(p[0] - maxX) > EPS) ||
          (Math.abs(p[1] - minZ) > EPS && Math.abs(p[1] - maxZ) > EPS),
      )
    )
      throw new Error(
        `architecture: gable roof ${system.id} currently requires an axis-aligned rectangular volume`,
      );
    const pitch = (system.pitchDegrees * Math.PI) / 180,
      s = Math.sin(pitch),
      c = Math.cos(pitch),
      o = system.eaveOverhang,
      eave = volume.eaveY;
    if (system.ridgeAxis === "x") {
      const ridgeZ = (minZ + maxZ) / 2,
        ridgeY = eave + ((maxZ - minZ) / 2) * Math.tan(pitch),
        gableApex = ridgeY - system.thickness / (2 * c) - 0.03,
        edgeY = eave - o * Math.tan(pitch),
        x0 = minX - system.ridgeEndOverhang[0],
        x1 = maxX + system.ridgeEndOverhang[1],
        z0 = minZ - o,
        z1 = maxZ + o,
        south = `${system.id}/south`,
        north = `${system.id}/north`;
      roofPlaneSpecs.push(
        {
          id: south,
          origin: [x0, edgeY, z0],
          normal: [0, c, -s],
          boundary: [
            [x0, edgeY, z0],
            [x1, edgeY, z0],
            [x1, ridgeY, ridgeZ],
            [x0, ridgeY, ridgeZ],
          ],
          thickness: system.thickness,
        },
        {
          id: north,
          origin: [x0, ridgeY, ridgeZ],
          normal: [0, c, s],
          boundary: [
            [x0, ridgeY, ridgeZ],
            [x1, ridgeY, ridgeZ],
            [x1, edgeY, z1],
            [x0, edgeY, z1],
          ],
          thickness: system.thickness,
        },
      );
      for (const [side, x, normal] of [
        ["west", minX, [-1, 0, 0] as V3],
        ["east", maxX, [1, 0, 0] as V3],
      ] as const)
        gableClosures.push(
          Object.freeze({
            kind: "plane-slab",
            id: `gable/${system.id}/${side}`,
            surfaceRole: "wall",
            origin: [x, eave, minZ],
            normal,
            boundary: Object.freeze([
              [x, eave, minZ],
              [x, eave, maxZ],
              [x, gableApex, ridgeZ],
            ] as V3[]),
            thickness: volume.wallThickness,
            derivedFrom: Object.freeze([system.id, volume.id]),
          }),
        );
      roofSeamSpecs.push({
        id: `${system.id}/ridge`,
        kind: "ridge",
        planeIds: [south, north],
        from: [x0, ridgeY, ridgeZ],
        to: [x1, ridgeY, ridgeZ],
      });
      systemPlaneIds.set(system.id, [south, north]);
    } else {
      const ridgeX = (minX + maxX) / 2,
        ridgeY = eave + ((maxX - minX) / 2) * Math.tan(pitch),
        gableApex = ridgeY - system.thickness / (2 * c) - 0.03,
        edgeY = eave - o * Math.tan(pitch),
        z0 = minZ - system.ridgeEndOverhang[0],
        z1 = maxZ + system.ridgeEndOverhang[1],
        x0 = minX - o,
        x1 = maxX + o,
        west = `${system.id}/west`,
        east = `${system.id}/east`;
      roofPlaneSpecs.push(
        {
          id: west,
          origin: [x0, edgeY, z0],
          normal: [-s, c, 0],
          boundary: [
            [x0, edgeY, z0],
            [ridgeX, ridgeY, z0],
            [ridgeX, ridgeY, z1],
            [x0, edgeY, z1],
          ],
          thickness: system.thickness,
        },
        {
          id: east,
          origin: [ridgeX, ridgeY, z0],
          normal: [s, c, 0],
          boundary: [
            [ridgeX, ridgeY, z0],
            [x1, edgeY, z0],
            [x1, edgeY, z1],
            [ridgeX, ridgeY, z1],
          ],
          thickness: system.thickness,
        },
      );
      for (const [side, z, normal] of [
        ["front", minZ, [0, 0, -1] as V3],
        ["rear", maxZ, [0, 0, 1] as V3],
      ] as const)
        gableClosures.push(
          Object.freeze({
            kind: "plane-slab",
            id: `gable/${system.id}/${side}`,
            surfaceRole: "wall",
            origin: [minX, eave, z],
            normal,
            boundary: Object.freeze([
              [minX, eave, z],
              [maxX, eave, z],
              [ridgeX, gableApex, z],
            ] as V3[]),
            thickness: volume.wallThickness,
            derivedFrom: Object.freeze([system.id, volume.id]),
          }),
        );
      roofSeamSpecs.push({
        id: `${system.id}/ridge`,
        kind: "ridge",
        planeIds: [west, east],
        from: [ridgeX, ridgeY, z0],
        to: [ridgeX, ridgeY, z1],
      });
      systemPlaneIds.set(system.id, [west, east]);
    }
  }
  for (const junction of roofJunctions) {
    if (
      junction.flashingWidth < 0.12 ||
      !junction.systemIds.includes(junction.trimSystemId) ||
      (junction.endInset ?? [0, 0]).some((n) => !Number.isFinite(n) || n < 0)
    )
      throw new Error(
        `architecture: roof junction ${junction.id} lacks credible flashing`,
      );
    const aIds = systemPlaneIds.get(junction.systemIds[0]),
      bIds = systemPlaneIds.get(junction.systemIds[1]);
    if (!aIds || !bIds)
      throw new Error(
        `architecture: roof junction ${junction.id} has missing roof system`,
      );
    const trimIsA = junction.systemIds[0] === junction.trimSystemId,
      primaryIds = trimIsA ? bIds : aIds,
      trimIds = trimIsA ? aIds : bIds,
      trimSystem = roofSystems.find((system) => system.id === junction.trimSystemId),
      trimVolume = trimSystem && volumeSpecById.get(trimSystem.volumeId);
    if (!trimSystem || !trimVolume)
      throw new Error(`architecture: roof junction ${junction.id} has invalid trim system`);
    const footprintCenter: V3 = [
        trimVolume.footprint.reduce((sum, point) => sum + point[0], 0) /
          trimVolume.footprint.length,
        trimVolume.eaveY,
        trimVolume.footprint.reduce((sum, point) => sum + point[1], 0) /
          trimVolume.footprint.length,
      ],
      clipByTrimId = new Map<string, RoofPlaneSpec>(),
      retainedIntersectionCount = new Map<string, number>();
    let index = 0;
    for (const primaryId of primaryIds)
      for (const trimId of trimIds) {
        const primary = roofPlaneSpecs.find((p) => p.id === primaryId)!,
          trim = roofPlaneSpecs.find((p) => p.id === trimId)!,
          a = trimIsA ? trim : primary,
          b = trimIsA ? primary : trim,
          segment = intersectRoofPlanes(a, b);
        if (segment) {
          clipByTrimId.set(trimId, primary);
          retainedIntersectionCount.set(
            trimId,
            (retainedIntersectionCount.get(trimId) ?? 0) + 1,
          );
          const delta: [number, number, number] = [
              segment[1][0] - segment[0][0],
              segment[1][1] - segment[0][1],
              segment[1][2] - segment[0][2],
            ],
            length = Math.hypot(...delta),
            unit = delta.map((n) => n / length) as unknown as V3,
            [startInset, endInset] = junction.endInset ?? [0, 0];
          if (startInset + endInset >= length - 0.05)
            throw new Error(
              `architecture: roof junction ${junction.id} inset consumes its substrate`,
            );
          const from = add3(segment[0], scale3(unit, startInset)),
            to = add3(segment[1], scale3(unit, -endInset));
          roofSeamSpecs.push({
            id: `${junction.id}/${index++}`,
            kind: junction.kind,
            planeIds: trimIsA
              ? [trimId, primaryId]
              : [primaryId, trimId],
            from,
            to,
            flashingWidth: junction.flashingWidth,
          });
        }
      }
    if (index === 0)
      throw new Error(
        `architecture: roof junction ${junction.id} has no shared substrate`,
      );
    for (const trimId of trimIds) {
      const host = clipByTrimId.get(trimId);
      if (!host)
        throw new Error(
          `architecture: roof junction ${junction.id} lacks trim overlap for ${trimId}`,
        );
      if (retainedIntersectionCount.get(trimId) !== 1)
        throw new Error(
          `architecture: roof junction ${junction.id} has ambiguous trim overlap for ${trimId}`,
        );
      const planeIndex = roofPlaneSpecs.findIndex((plane) => plane.id === trimId),
        source = roofPlaneSpecs[planeIndex],
        seedDistance = signedRoofPlaneDistance(footprintCenter, host),
        keepSign: 1 | -1 = seedDistance >= 0 ? 1 : -1,
        boundary = clipRoofBoundary(source.boundary, host, keepSign);
      roofPlaneSpecs[planeIndex] = { ...source, boundary };
    }
    const clipped = trimIds.map(
        (id) => roofPlaneSpecs.find((plane) => plane.id === id)!,
      ),
      clippedRidge = intersectRoofPlanes(clipped[0], clipped[1]),
      ridgeIndex = roofSeamSpecs.findIndex(
        (seam) => seam.id === `${junction.trimSystemId}/ridge`,
      );
    if (!clippedRidge || ridgeIndex < 0)
      throw new Error(
        `architecture: roof junction ${junction.id} cannot resolve its trimmed ridge`,
      );
    const oldRidge = roofSeamSpecs[ridgeIndex],
      forward =
        Math.hypot(...sub3(clippedRidge[0], oldRidge.from)) <=
        Math.hypot(...sub3(clippedRidge[1], oldRidge.from));
    roofSeamSpecs[ridgeIndex] = {
      ...oldRidge,
      from: forward ? clippedRidge[0] : clippedRidge[1],
      to: forward ? clippedRidge[1] : clippedRidge[0],
    };
    const joinedAtStart =
        Math.hypot(...sub3(roofSeamSpecs[ridgeIndex].from, oldRidge.from)) > 0.01,
      joinedAtEnd =
        Math.hypot(...sub3(roofSeamSpecs[ridgeIndex].to, oldRidge.to)) > 0.01,
      joinedClosureSuffix =
        trimSystem.ridgeAxis === "z"
          ? joinedAtStart
            ? "/front"
            : joinedAtEnd
              ? "/rear"
              : undefined
          : joinedAtStart
            ? "/west"
            : joinedAtEnd
              ? "/east"
              : undefined;
    if (joinedClosureSuffix) {
      const closureIndex = gableClosures.findIndex(
        (closure) =>
          closure.id === `gable/${junction.trimSystemId}${joinedClosureSuffix}`,
      );
      if (closureIndex >= 0) gableClosures.splice(closureIndex, 1);
    }
  }
  const roofSurfaceOverrides = new Map<string, RoofPlaneSpec[]>(),
    dormerPrimitives: ArchitecturePrimitive[] = [],
    dormers: CompiledDormer[] = [];
  const closureSlab = (
    id: string,
    surfaceRole: "roof" | "wall",
    boundary: readonly V3[],
    thickness: number,
    derivedFrom: readonly string[],
  ): ArchitecturePrimitive =>
    Object.freeze({
      kind: "plane-slab",
      id,
      surfaceRole,
      origin: Object.freeze([...boundary[0]]) as V3,
      normal: Object.freeze(planeNormal(boundary)),
      boundary: Object.freeze(
        boundary.map((point) => Object.freeze([...point]) as V3),
      ),
      thickness,
      derivedFrom: Object.freeze([...derivedFrom]),
    });
  for (const dormer of dormerSpecs) {
    const host = roofPlaneSpecs.find(
      (plane) => plane.id === dormer.hostPlaneId,
    );
    if (!host)
      throw new Error(
        `architecture: dormer ${dormer.id} has missing host roof plane`,
      );
    if (
      roofSurfaceOverrides.has(host.id) ||
      dormer.width <= 0.8 ||
      dormer.downslopeRange[0] < 0.3 ||
      dormer.downslopeRange[1] <= dormer.downslopeRange[0] + 0.5 ||
      dormer.eaveY <= dormer.wallBaseY + 0.8 ||
      dormer.roofPitchDegrees < 30 ||
      dormer.roofPitchDegrees > 65 ||
      dormer.roofThickness <= 0 ||
      dormer.wallThickness <= 0 ||
      dormer.eaveOverhang < 0.12 ||
      dormer.rakeOverhang < 0.12 ||
      dormer.curbHeight < 0.1 ||
      dormer.flashingWidth < 0.12 ||
      dormer.flashingThickness <= 0 ||
      dormer.windowWidth <= 0 ||
      dormer.windowHeight <= 0
    )
      throw new Error(`architecture: invalid dormer ${dormer.id}`);
    const sorted = [...host.boundary].sort((a, b) => b[1] - a[1]),
      ridgePair = sorted.slice(0, 2) as V3[],
      eavePair = sorted.slice(-2) as V3[],
      ridgeMid = mean3(ridgePair[0], ridgePair[1]),
      eaveMid = mean3(eavePair[0], eavePair[1]);
    let ridgeDirection = unit3(sub3(ridgePair[1], ridgePair[0]));
    const dominant =
      Math.abs(ridgeDirection[0]) >= Math.abs(ridgeDirection[2]) ? 0 : 2;
    if (ridgeDirection[dominant] < 0)
      ridgeDirection = scale3(ridgeDirection, -1);
    const downslope = unit3(sub3(eaveMid, ridgeMid)),
      maxDownslope = Math.max(
        ...host.boundary.map((point) => dot3(sub3(point, ridgeMid), downslope)),
      ),
      uValues = host.boundary.map((point) =>
        dot3(sub3(point, ridgeMid), ridgeDirection),
      ),
      uMin = Math.min(...uValues),
      uMax = Math.max(...uValues),
      u0 = dormer.alongCenter - dormer.width / 2,
      u1 = dormer.alongCenter + dormer.width / 2,
      [near, far] = dormer.downslopeRange,
      dormerPitch = (dormer.roofPitchDegrees * Math.PI) / 180,
      soffitBearing = dormer.roofWallConnection === "soffit-bearing",
      fixedXRoofHalfThickness =
        dormer.roofThickness / (2 * Math.cos(dormerPitch)),
      roofEaveY = soffitBearing
        ? dormer.eaveY +
          0.03 +
          fixedXRoofHalfThickness -
          dormer.eaveOverhang * Math.tan(dormerPitch)
        : dormer.eaveY +
          0.05 +
          (dormer.roofThickness / 2) * Math.cos(dormerPitch),
      ridgeY =
        roofEaveY +
        (dormer.width / 2 + (soffitBearing ? dormer.eaveOverhang : 0)) *
          Math.tan(dormerPitch),
      intersectingGable = dormer.hostConnection === "intersecting-gable",
      connectionEaveD = intersectingGable
        ? (roofEaveY - ridgeMid[1]) / downslope[1]
        : near,
      connectionRidgeD = intersectingGable
        ? (ridgeY - ridgeMid[1]) / downslope[1]
        : near;
    if (
      intersectingGable &&
      (!Number.isFinite(connectionEaveD) ||
        !Number.isFinite(connectionRidgeD) ||
        connectionRidgeD <= dormer.flashingWidth ||
        connectionEaveD <= connectionRidgeD + dormer.flashingWidth ||
        connectionEaveD >= far - dormer.flashingWidth ||
        dormer.windowSillY - (ridgeMid[1] + downslope[1] * far) < 0.18 ||
        dormer.windowSillY + dormer.windowHeight > dormer.eaveY - 0.02)
    )
      throw new Error(
        `architecture: intersecting dormer ${dormer.id} does not resolve a safe host connection`,
      );
    if (
      u0 - dormer.flashingWidth <= uMin ||
      u1 + dormer.flashingWidth >= uMax ||
      Math.min(near, connectionRidgeD) - dormer.flashingWidth <= 0 ||
      far + Math.max(dormer.flashingWidth, dormer.rakeOverhang) >= maxDownslope
    )
      throw new Error(
        `architecture: dormer ${dormer.id} cut escapes host roof substrate`,
      );
    const point = (u: number, d: number) =>
        add3(ridgeMid, add3(scale3(ridgeDirection, u), scale3(downslope, d))),
      structuralRearLeft = point(u0, connectionEaveD),
      structuralRearRight = point(u1, connectionEaveD),
      structuralRearRidge = point(dormer.alongCenter, connectionRidgeD),
      structuralFrontLeft = point(u0, far),
      structuralFrontRight = point(u1, far),
      cut = intersectingGable
        ? [
            structuralRearLeft,
            structuralRearRidge,
            structuralRearRight,
            structuralFrontRight,
            structuralFrontLeft,
          ]
        : [point(u0, near), point(u1, near), structuralFrontRight, structuralFrontLeft];
    const sideFragments: RoofPlaneSpec[] = [
      {
        ...host,
        id: `${host.id}/fragment-left`,
        boundary: [
          point(uMin, 0),
          point(u0, 0),
          point(u0, maxDownslope),
          point(uMin, maxDownslope),
        ],
      },
      {
        ...host,
        id: `${host.id}/fragment-right`,
        boundary: [
          point(u1, 0),
          point(uMax, 0),
          point(uMax, maxDownslope),
          point(u1, maxDownslope),
        ],
      },
      ...(intersectingGable
        ? [
            {
              ...host,
              id: `${host.id}/fragment-ridge-left`,
              boundary: [
                point(u0, 0),
                point(dormer.alongCenter, 0),
                structuralRearRidge,
                structuralRearLeft,
              ],
            },
            {
              ...host,
              id: `${host.id}/fragment-ridge-right`,
              boundary: [
                point(dormer.alongCenter, 0),
                point(u1, 0),
                structuralRearRight,
                structuralRearRidge,
              ],
            },
          ]
        : [
            {
              ...host,
              id: `${host.id}/fragment-ridge`,
              boundary: [
                point(u0, 0),
                point(u1, 0),
                point(u1, near),
                point(u0, near),
              ],
            },
          ]),
      {
        ...host,
        id: `${host.id}/fragment-eave`,
        boundary: [
          point(u0, far),
          point(u1, far),
          point(u1, maxDownslope),
          point(u0, maxDownslope),
        ],
      },
    ];
    roofSurfaceOverrides.set(host.id, sideFragments);
    const frontLeft = structuralFrontLeft,
      frontRight = structuralFrontRight,
      rearLeft = structuralRearLeft,
      rearRight = structuralRearRight,
      frontId = `${dormer.id}/front`,
      windowOpening: WallOpeningSpec = {
        id: dormer.windowId,
        kind: "window",
        offset: 0,
        width: dormer.windowWidth,
        sillY: dormer.windowSillY,
        height: dormer.windowHeight,
      };
    derivedWalls.push({
      id: frontId,
      from: [frontLeft[0], frontLeft[2]],
      to: [frontRight[0], frontRight[2]],
      bottomY: dormer.wallBaseY,
      topY: dormer.eaveY,
      thickness: dormer.wallThickness,
      openings: [windowOpening],
    });
    const gableApexY =
        ridgeY - dormer.roofThickness / (2 * Math.cos(dormerPitch)) - 0.03,
      frontRidge: V3 = [
        (frontLeft[0] + frontRight[0]) / 2,
        ridgeY,
        (frontLeft[2] + frontRight[2]) / 2,
      ],
      rearRidge: V3 = intersectingGable
        ? structuralRearRidge
        : [
            (rearLeft[0] + rearRight[0]) / 2,
            ridgeY,
            (rearLeft[2] + rearRight[2]) / 2,
          ],
      frontGableApex: V3 = [frontRidge[0], gableApexY, frontRidge[2]],
      horizontalDownslope = unit3([downslope[0], 0, downslope[2]]),
      frontRoofShift = scale3(
        intersectingGable ? horizontalDownslope : downslope,
        dormer.rakeOverhang,
      ),
      leftRoofShift = scale3(ridgeDirection, -dormer.eaveOverhang),
      rightRoofShift = scale3(ridgeDirection, dormer.eaveOverhang),
      frontRoofRidge = add3(frontRidge, frontRoofShift),
      frontLeftEave: V3 = add3(
        add3([frontLeft[0], roofEaveY, frontLeft[2]], leftRoofShift),
        frontRoofShift,
      ),
      frontRightEave: V3 = add3(
        add3([frontRight[0], roofEaveY, frontRight[2]], rightRoofShift),
        frontRoofShift,
      ),
      rearLeftEave: V3 = add3(
        [rearLeft[0], roofEaveY, rearLeft[2]],
        leftRoofShift,
      ),
      rearRightEave: V3 = add3(
        [rearRight[0], roofEaveY, rearRight[2]],
        rightRoofShift,
      );
    const leftCheek = [
        frontLeft,
        [frontLeft[0], dormer.eaveY, frontLeft[2]] as V3,
        [rearLeft[0], dormer.eaveY, rearLeft[2]] as V3,
        rearLeft,
      ],
      rightCheek = [
        frontRight,
        rearRight,
        [rearRight[0], dormer.eaveY, rearRight[2]] as V3,
        [frontRight[0], dormer.eaveY, frontRight[2]] as V3,
      ],
      frontGable = [
        [frontLeft[0], dormer.eaveY, frontLeft[2]] as V3,
        [frontRight[0], dormer.eaveY, frontRight[2]] as V3,
        frontGableApex,
      ],
      westRoof = [frontLeftEave, frontRoofRidge, rearRidge, rearLeftEave],
      eastRoof = [frontRoofRidge, frontRightEave, rearRightEave, rearRidge],
      flash = dormer.flashingWidth,
      flashingOffset =
        host.thickness / 2 + 0.035 + dormer.flashingThickness / 2 + 0.001,
      onFlashing = (u: number, d: number) =>
        add3(point(u, d), scale3(host.normal, flashingOffset)),
      sideLeft = [
        onFlashing(u0 - flash, connectionEaveD),
        onFlashing(u0 - flash, far),
        onFlashing(u0, far),
        onFlashing(u0, connectionEaveD),
      ],
      sideRight = [
        onFlashing(u1, connectionEaveD),
        onFlashing(u1, far),
        onFlashing(u1 + flash, far),
        onFlashing(u1 + flash, connectionEaveD),
      ],
      backpan = [
        onFlashing(u0, near - flash),
        onFlashing(u1, near - flash),
        onFlashing(u1, near),
        onFlashing(u0, near),
      ],
      apron = [
        onFlashing(u0, far),
        onFlashing(u1, far),
        onFlashing(u1, far + flash),
        onFlashing(u0, far + flash),
      ],
      valleyStrip = (fromU: number, fromD: number, toU: number, toD: number) => {
        const du = toU - fromU,
          dd = toD - fromD,
          length = Math.hypot(du, dd),
          offsetU = (-dd / length) * flash * 0.5,
          offsetD = (du / length) * flash * 0.5;
        return [
          onFlashing(fromU + offsetU, fromD + offsetD),
          onFlashing(toU + offsetU, toD + offsetD),
          onFlashing(toU - offsetU, toD - offsetD),
          onFlashing(fromU - offsetU, fromD - offsetD),
        ];
      },
      valleyLeft = valleyStrip(
        u0,
        connectionEaveD,
        dormer.alongCenter,
        connectionRidgeD,
      ),
      valleyRight = valleyStrip(
        dormer.alongCenter,
        connectionRidgeD,
        u1,
        connectionEaveD,
      ),
      curbBaseOffset = host.thickness / 2 + 0.035,
      curbBoundary = intersectingGable
        ? [rearLeft, frontLeft, frontRight, rearRight]
        : cut,
      curbBase = curbBoundary.map((vertex) =>
        add3(vertex, scale3(host.normal, curbBaseOffset)),
      ),
      curbTop = curbBase.map((vertex) => add3(vertex, [0, dormer.curbHeight, 0]));
    dormerPrimitives.push(
      closureSlab(
        `${dormer.id}/cheek-left`,
        "wall",
        leftCheek,
        dormer.wallThickness,
        [dormer.id, host.id],
      ),
      closureSlab(
        `${dormer.id}/cheek-right`,
        "wall",
        rightCheek,
        dormer.wallThickness,
        [dormer.id, host.id],
      ),
      closureSlab(
        `${dormer.id}/gable-front`,
        "wall",
        frontGable,
        dormer.wallThickness,
        [dormer.id],
      ),
      closureSlab(
        `${dormer.id}/roof-west`,
        "roof",
        westRoof,
        dormer.roofThickness,
        [dormer.id, host.id],
      ),
      closureSlab(
        `${dormer.id}/roof-east`,
        "roof",
        eastRoof,
        dormer.roofThickness,
        [dormer.id, host.id],
      ),
      closureSlab(
        `${dormer.id}/flashing-side-left`,
        "roof",
        sideLeft,
        dormer.flashingThickness,
        [dormer.id, host.id],
      ),
      closureSlab(
        `${dormer.id}/flashing-side-right`,
        "roof",
        sideRight,
        dormer.flashingThickness,
        [dormer.id, host.id],
      ),
      closureSlab(`${dormer.id}/flashing-apron`, "roof", apron, dormer.flashingThickness, [
        dormer.id,
        host.id,
      ]),
    );
    if (intersectingGable)
      dormerPrimitives.push(
        closureSlab(
          `${dormer.id}/flashing-valley-left`,
          "roof",
          valleyLeft,
          dormer.flashingThickness,
          [dormer.id, host.id],
        ),
        closureSlab(
          `${dormer.id}/flashing-valley-right`,
          "roof",
          valleyRight,
          dormer.flashingThickness,
          [dormer.id, host.id],
        ),
      );
    else
      dormerPrimitives.push(
        closureSlab(
          `${dormer.id}/flashing-backpan`,
          "roof",
          backpan,
          dormer.flashingThickness,
          [dormer.id, host.id],
        ),
      );
    const curbEdges: readonly (readonly [number, number])[] = intersectingGable
      ? [[0, 1], [1, 2], [2, 3]]
      : [[0, 1], [1, 2], [2, 3], [3, 0]];
    for (let edge = 0; edge < curbEdges.length; edge++) {
      const [current, next] = curbEdges[edge];
      dormerPrimitives.push(
        closureSlab(
          intersectingGable
            ? `${dormer.id}/curb-${["side-left", "apron", "side-right"][edge]}`
            : `${dormer.id}/curb-${edge}`,
          "wall",
          [curbBase[current], curbBase[next], curbTop[next], curbTop[current]],
          Math.min(0.1, dormer.wallThickness),
          [dormer.id, host.id],
        ),
        closureSlab(
          intersectingGable
            ? `${dormer.id}/counterflashing-${["side-left", "apron", "side-right"][edge]}`
            : `${dormer.id}/counterflashing-${edge}`,
          "wall",
          [
            add3(curbTop[current], [0, -0.08, 0]),
            add3(curbTop[next], [0, -0.08, 0]),
            curbTop[next],
            curbTop[current],
          ],
          dormer.flashingThickness,
          [dormer.id, host.id],
        ),
      );
    }
    const ridgeId = `${dormer.id}/roof-ridge`;
    dormerPrimitives.push(
      Object.freeze({
        kind: "linear-member",
        id: ridgeId,
        from: Object.freeze(frontRoofRidge),
        to: Object.freeze(rearRidge),
        width: 0.22,
        depth: 0.12,
        derivedFrom: Object.freeze([dormer.id]),
      }),
    );
    for (const [id, from, to] of [
      [`${dormer.id}/fascia-left`, frontLeftEave, rearLeftEave],
      [`${dormer.id}/fascia-right`, frontRightEave, rearRightEave],
      [`${dormer.id}/rake-left`, frontLeftEave, frontRoofRidge],
      [`${dormer.id}/rake-right`, frontRoofRidge, frontRightEave],
    ] as const)
      dormerPrimitives.push(
        Object.freeze({
          kind: "linear-member" as const,
          id,
          from: Object.freeze(from),
          to: Object.freeze(to),
          width: 0.14,
          depth: 0.1,
          derivedFrom: Object.freeze([dormer.id]),
        }),
      );
    dormers.push(
      Object.freeze({
        id: dormer.id,
        hostPlaneId: host.id,
        cutBoundary: Object.freeze(cut.map((p) => Object.freeze(p))),
        wallIds: Object.freeze([
          frontId,
          `${dormer.id}/cheek-left`,
          `${dormer.id}/cheek-right`,
          `${dormer.id}/gable-front`,
        ]),
        roofPlaneIds: Object.freeze([
          `${dormer.id}/roof-west`,
          `${dormer.id}/roof-east`,
        ]),
        ridgeId,
        windowId: dormer.windowId,
        ...(intersectingGable
          ? {
              hostConnection: "intersecting-gable" as const,
              ...(soffitBearing
                ? { roofWallConnection: "soffit-bearing" as const }
                : {}),
              valleyIds: Object.freeze([
                `${dormer.id}/flashing-valley-left`,
                `${dormer.id}/flashing-valley-right`,
              ]) as readonly [string, string],
            }
          : {}),
      }),
    );
  }
  const fireplaceSpecById = new Map(
      (input.fireplaces ?? []).map((fireplace) => [fireplace.id, fireplace]),
    ),
    roofPenetrations: CompiledRoofPenetration[] = [],
    penetrationPrimitives: ArchitecturePrimitive[] = [];
  for (const penetration of penetrationSpecs) {
    const fireplace = fireplaceSpecById.get(penetration.fireplaceId),
      host = roofPlaneSpecs.find(
        (plane) => plane.id === penetration.roofPlaneId,
      );
    if (!fireplace || !host)
      throw new Error(
        `architecture: roof penetration ${penetration.id} has missing fireplace or roof plane`,
      );
    if (
      fireplace.roofPlaneId !== host.id ||
      roofSurfaceOverrides.has(host.id) ||
      penetration.shaftSize.some((n) => !Number.isFinite(n) || n <= 0) ||
      penetration.clearance <= 0 ||
      penetration.minimumRoofProjection < 0.6 ||
      penetration.curbWidth < 0.08 ||
      penetration.curbHeight < 0.1 ||
      penetration.flashingWidth < 0.12 ||
      penetration.apronDepth < 0.18 ||
      penetration.backpanDepth < 0.18 ||
      penetration.flashingThickness <= 0 ||
      penetration.capOverhang < 0.08 ||
      penetration.capThickness < 0.1 ||
      penetration.cricketDepth < 0.2 ||
      penetration.cricketRise < 0.1
    )
      throw new Error(
        `architecture: invalid roof penetration ${penetration.id}`,
      );
    const yAt = (x: number, z: number) => {
        if (Math.abs(host.normal[1]) < 0.2)
          throw new Error(
            `architecture: roof penetration ${penetration.id} host is not weather-facing`,
          );
        return (
          host.origin[1] -
          (host.normal[0] * (x - host.origin[0]) +
            host.normal[2] * (z - host.origin[2])) /
            host.normal[1]
        );
      },
      halfX = penetration.shaftSize[0] / 2 + penetration.clearance,
      halfZ = penetration.shaftSize[1] / 2 + penetration.clearance,
      cornersXZ: [
        [number, number],
        [number, number],
        [number, number],
        [number, number],
      ] = [
        [penetration.center[0] - halfX, penetration.center[1] - halfZ],
        [penetration.center[0] + halfX, penetration.center[1] - halfZ],
        [penetration.center[0] + halfX, penetration.center[1] + halfZ],
        [penetration.center[0] - halfX, penetration.center[1] + halfZ],
      ],
      cut = cornersXZ.map(([x, z]) => [x, yAt(x, z), z] as V3),
      roofMinY = Math.min(...cut.map((p) => p[1])),
      roofMaxY = Math.max(...cut.map((p) => p[1]));
    if (
      penetration.shaftBottomY > roofMinY - 0.15 ||
      penetration.topY < roofMaxY + penetration.minimumRoofProjection
    )
      throw new Error(
        `architecture: roof penetration ${penetration.id} lacks continuous shaft projection`,
      );
    const sorted = [...host.boundary].sort((a, b) => b[1] - a[1]),
      ridgeMid = mean3(sorted[0], sorted[1]),
      eaveMid = mean3(sorted.at(-1)!, sorted.at(-2)!);
    let ridgeDirection = unit3(sub3(sorted[1], sorted[0]));
    const dominant =
      Math.abs(ridgeDirection[0]) >= Math.abs(ridgeDirection[2]) ? 0 : 2;
    if (ridgeDirection[dominant] < 0)
      ridgeDirection = scale3(ridgeDirection, -1);
    const downslope = unit3(sub3(eaveMid, ridgeMid)),
      uValues = host.boundary.map((p) =>
        dot3(sub3(p, ridgeMid), ridgeDirection),
      ),
      dValues = host.boundary.map((p) => dot3(sub3(p, ridgeMid), downslope)),
      uMin = Math.min(...uValues),
      uMax = Math.max(...uValues),
      dMin = Math.min(...dValues),
      dMax = Math.max(...dValues),
      cutU = cut.map((p) => dot3(sub3(p, ridgeMid), ridgeDirection)),
      cutD = cut.map((p) => dot3(sub3(p, ridgeMid), downslope)),
      u0 = Math.min(...cutU),
      u1 = Math.max(...cutU),
      d0 = Math.min(...cutD),
      d1 = Math.max(...cutD),
      margin =
        Math.max(
          penetration.flashingWidth,
          penetration.apronDepth,
          penetration.backpanDepth,
        ) + 0.05;
    if (
      u0 - uMin < margin ||
      uMax - u1 < margin ||
      d0 - dMin < margin ||
      dMax - d1 < margin
    )
      throw new Error(
        `architecture: roof penetration ${penetration.id} flashing envelope escapes host substrate`,
      );
    const point = (u: number, d: number) =>
      add3(ridgeMid, add3(scale3(ridgeDirection, u), scale3(downslope, d)));
    roofSurfaceOverrides.set(host.id, [
      {
        ...host,
        id: `${host.id}/fragment-left-${penetration.id}`,
        boundary: [
          point(uMin, dMin),
          point(u0, dMin),
          point(u0, dMax),
          point(uMin, dMax),
        ],
      },
      {
        ...host,
        id: `${host.id}/fragment-right-${penetration.id}`,
        boundary: [
          point(u1, dMin),
          point(uMax, dMin),
          point(uMax, dMax),
          point(u1, dMax),
        ],
      },
      {
        ...host,
        id: `${host.id}/fragment-up-${penetration.id}`,
        boundary: [
          point(u0, dMin),
          point(u1, dMin),
          point(u1, d0),
          point(u0, d0),
        ],
      },
      {
        ...host,
        id: `${host.id}/fragment-down-${penetration.id}`,
        boundary: [
          point(u0, d1),
          point(u1, d1),
          point(u1, dMax),
          point(u0, dMax),
        ],
      },
    ]);
    const line = (
        id: string,
        from: V3,
        to: V3,
        width: number,
        depth: number,
      ): LinearMember =>
        Object.freeze({
          kind: "linear-member",
          id,
          from: Object.freeze(from),
          to: Object.freeze(to),
          width,
          depth,
          derivedFrom: Object.freeze([penetration.id, host.id]),
        }),
      curb = cut.map((from, index) =>
        line(
          `${penetration.id}/curb-${index}`,
          from,
          cut[(index + 1) % 4],
          penetration.curbWidth,
          penetration.curbHeight,
        ),
      ),
      flashing = cut.map((from, index) =>
        line(
          `${penetration.id}/flashing-${index}`,
          from,
          cut[(index + 1) % 4],
          index === 0
            ? penetration.backpanDepth
            : index === 2
              ? penetration.apronDepth
              : penetration.flashingWidth,
          penetration.flashingThickness,
        ),
      ),
      counterflashing = cut.map((from, index) =>
        line(
          `${penetration.id}/counterflashing-${index}`,
          add3(from, [0, penetration.curbHeight, 0]),
          add3(cut[(index + 1) % 4], [0, penetration.curbHeight, 0]),
          penetration.curbWidth,
          0.08,
        ),
      );
    const backLeft = point(u0, d0),
      backRight = point(u1, d0),
      cricketBack = add3(point((u0 + u1) / 2, d0 - penetration.cricketDepth), [
        0,
        penetration.cricketRise * 0.35,
        0,
      ]),
      cricketNose = add3(point((u0 + u1) / 2, d0), [
        0,
        penetration.cricketRise,
        0,
      ]),
      cricket = [
        closureSlab(
          `${penetration.id}/cricket-left`,
          "roof",
          [backLeft, cricketBack, cricketNose],
          penetration.flashingThickness,
          [penetration.id],
        ) as PlaneSlab,
        closureSlab(
          `${penetration.id}/cricket-right`,
          "roof",
          [cricketNose, cricketBack, backRight],
          penetration.flashingThickness,
          [penetration.id],
        ) as PlaneSlab,
      ],
      sx = penetration.shaftSize[0],
      sz = penetration.shaftSize[1],
      shaftWall = 0.14,
      shaftMidY = (penetration.shaftBottomY + penetration.topY) / 2,
      shaftHalfY = (penetration.topY - penetration.shaftBottomY) / 2,
      shaft = [
        box(
          `${penetration.id}/shaft-west`,
          [
            penetration.center[0] - sx / 2 + shaftWall / 2,
            shaftMidY,
            penetration.center[1],
          ],
          [shaftWall / 2, shaftHalfY, sz / 2],
          [penetration.id, penetration.fireplaceId],
        ),
        box(
          `${penetration.id}/shaft-east`,
          [
            penetration.center[0] + sx / 2 - shaftWall / 2,
            shaftMidY,
            penetration.center[1],
          ],
          [shaftWall / 2, shaftHalfY, sz / 2],
          [penetration.id, penetration.fireplaceId],
        ),
        box(
          `${penetration.id}/shaft-north`,
          [
            penetration.center[0],
            shaftMidY,
            penetration.center[1] + sz / 2 - shaftWall / 2,
          ],
          [sx / 2 - shaftWall, shaftHalfY, shaftWall / 2],
          [penetration.id, penetration.fireplaceId],
        ),
        box(
          `${penetration.id}/shaft-south`,
          [
            penetration.center[0],
            shaftMidY,
            penetration.center[1] - sz / 2 + shaftWall / 2,
          ],
          [sx / 2 - shaftWall, shaftHalfY, shaftWall / 2],
          [penetration.id, penetration.fireplaceId],
        ),
      ],
      outerX = sx / 2 + penetration.capOverhang,
      outerZ = sz / 2 + penetration.capOverhang,
      capRing = 0.17,
      capY = penetration.topY + penetration.capThickness / 2,
      cap = [
        box(
          `${penetration.id}/cap-west`,
          [
            penetration.center[0] - outerX + capRing / 2,
            capY,
            penetration.center[1],
          ],
          [capRing / 2, penetration.capThickness / 2, outerZ],
          [penetration.id],
        ),
        box(
          `${penetration.id}/cap-east`,
          [
            penetration.center[0] + outerX - capRing / 2,
            capY,
            penetration.center[1],
          ],
          [capRing / 2, penetration.capThickness / 2, outerZ],
          [penetration.id],
        ),
        box(
          `${penetration.id}/cap-north`,
          [
            penetration.center[0],
            capY,
            penetration.center[1] + outerZ - capRing / 2,
          ],
          [outerX - capRing, penetration.capThickness / 2, capRing / 2],
          [penetration.id],
        ),
        box(
          `${penetration.id}/cap-south`,
          [
            penetration.center[0],
            capY,
            penetration.center[1] - outerZ + capRing / 2,
          ],
          [outerX - capRing, penetration.capThickness / 2, capRing / 2],
          [penetration.id],
        ),
      ],
      linerWall = 0.055,
      linerBottom = penetration.shaftBottomY,
      linerTop = penetration.topY + penetration.capThickness + 0.32,
      linerMid = (linerBottom + linerTop) / 2,
      linerHalf = (linerTop - linerBottom) / 2,
      innerX = sx / 2 - shaftWall - 0.035,
      innerZ = sz / 2 - shaftWall - 0.035,
      flueLiner = [
        box(
          `${penetration.id}/flue-liner-west`,
          [
            penetration.center[0] - innerX + linerWall / 2,
            linerMid,
            penetration.center[1],
          ],
          [linerWall / 2, linerHalf, innerZ],
          [penetration.id],
        ),
        box(
          `${penetration.id}/flue-liner-east`,
          [
            penetration.center[0] + innerX - linerWall / 2,
            linerMid,
            penetration.center[1],
          ],
          [linerWall / 2, linerHalf, innerZ],
          [penetration.id],
        ),
        box(
          `${penetration.id}/flue-liner-north`,
          [
            penetration.center[0],
            linerMid,
            penetration.center[1] + innerZ - linerWall / 2,
          ],
          [innerX - linerWall, linerHalf, linerWall / 2],
          [penetration.id],
        ),
        box(
          `${penetration.id}/flue-liner-south`,
          [
            penetration.center[0],
            linerMid,
            penetration.center[1] - innerZ + linerWall / 2,
          ],
          [innerX - linerWall, linerHalf, linerWall / 2],
          [penetration.id],
        ),
      ];
    penetrationPrimitives.push(
      ...shaft,
      ...curb,
      ...flashing,
      ...counterflashing,
      ...cricket,
      ...cap,
      ...flueLiner,
    );
    roofPenetrations.push(
      Object.freeze({
        id: penetration.id,
        fireplaceId: penetration.fireplaceId,
        roofPlaneId: host.id,
        cutBoundary: Object.freeze(cut.map((p) => Object.freeze(p))),
        shaft: Object.freeze(shaft),
        curb: Object.freeze(curb),
        flashing: Object.freeze(flashing),
        counterflashing: Object.freeze(counterflashing),
        cricket: Object.freeze(cricket),
        cap: Object.freeze(cap),
        flueLiner: Object.freeze(flueLiner),
      }),
    );
  }
  for (const record of [...roofPlaneSpecs, ...roofSeamSpecs])
    if (!ids.has(record.id)) own(record.id);
  if (interiorPartitionSpecs.length && !volumeSpecs.length)
    throw new Error("architecture: interior partitions require structural volume authority");
  const wallSpecs: readonly WallRunSpec[] = volumeSpecs.length
    ? [...derivedWalls, ...interiorPartitionSpecs]
    : explicitWalls;
  const wallById = new Map(wallSpecs.map((w) => [w.id, w]));
  const walls: CompiledWall[] = [];
  for (const wall of wallSpecs) {
    v2(wall.from, wall.id);
    v2(wall.to, wall.id);
    if (
      len2(wall.from, wall.to) <= EPS ||
      wall.topY <= wall.bottomY ||
      wall.thickness <= 0
    )
      throw new Error(`architecture: invalid wall ${wall.id}`);
    const length = len2(wall.from, wall.to),
      openings = [...(wall.openings ?? [])].sort((a, b) => a.offset - b.offset);
    let prior = -length / 2;
    for (const opening of openings) {
      own(opening.id);
      if (
        opening.width <= 0 ||
        opening.height <= 0 ||
        opening.sillY < wall.bottomY - EPS ||
        opening.sillY + opening.height > wall.topY + EPS
      )
        throw new Error(
          `architecture: opening ${opening.id} escapes ${wall.id}`,
        );
      const lo = opening.offset - opening.width / 2,
        hi = opening.offset + opening.width / 2;
      if (lo < -length / 2 - EPS || hi > length / 2 + EPS || lo < prior - EPS)
        throw new Error(
          `architecture: opening ${opening.id} overlaps or escapes ${wall.id}`,
        );
      prior = hi;
    }
    const dx = wall.to[0] - wall.from[0],
      dz = wall.to[1] - wall.from[1],
      tx = dx / length,
      tz = dz / length,
      mx = (wall.from[0] + wall.to[0]) / 2,
      mz = (wall.from[1] + wall.to[1]) / 2,
      yaw = Math.atan2(tz, tx),
      segments: SolidBox[] = [];
    const add = (
      id: string,
      lo: number,
      hi: number,
      bottom: number,
      top: number,
      owners: readonly string[],
    ) => {
      if (hi - lo <= EPS || top - bottom <= EPS) return;
      const along = (lo + hi) / 2;
      segments.push(
        box(
          `wall/${wall.id}/${id}`,
          [mx + tx * along, (bottom + top) / 2, mz + tz * along],
          [(hi - lo) / 2, (top - bottom) / 2, wall.thickness / 2],
          [wall.id, ...owners],
          yaw,
        ),
      );
    };
    let cursor = -length / 2;
    openings.forEach((opening, index) => {
      const lo = opening.offset - opening.width / 2,
        hi = opening.offset + opening.width / 2;
      add(`bay-${index}`, cursor, lo, wall.bottomY, wall.topY, []);
      add(`${opening.id}/below`, lo, hi, wall.bottomY, opening.sillY, [
        opening.id,
      ]);
      add(
        `${opening.id}/above`,
        lo,
        hi,
        opening.sillY + opening.height,
        wall.topY,
        [opening.id],
      );
      cursor = hi;
    });
    add("bay-end", cursor, length / 2, wall.bottomY, wall.topY, []);
    walls.push(
      Object.freeze({
        id: wall.id,
        openingIds: Object.freeze(openings.map((o) => o.id)),
        segments: Object.freeze(segments),
      }),
    );
  }
  const openingById = new Map<
    string,
    { wall: WallRunSpec; opening: WallOpeningSpec }
  >();
  for (const wall of wallSpecs)
    for (const opening of wall.openings ?? [])
      openingById.set(opening.id, { wall, opening });
  const wallBasis = (wall: WallRunSpec) => {
    const length = len2(wall.from, wall.to),
      tx = (wall.to[0] - wall.from[0]) / length,
      tz = (wall.to[1] - wall.from[1]) / length,
      mx = (wall.from[0] + wall.to[0]) / 2,
      mz = (wall.from[1] + wall.to[1]) / 2;
    return { length, tx, tz, nx: tz, nz: -tx, mx, mz, yaw: Math.atan2(tz, tx) };
  };
  const facade = (basis: ReturnType<typeof wallBasis>) =>
    Math.abs(basis.nx) > Math.abs(basis.nz)
      ? basis.nx > 0
        ? "east"
        : "west"
      : ((basis.nz > 0 ? "north" : "south") as
          "north" | "south" | "east" | "west");
  const at = (
    basis: ReturnType<typeof wallBasis>,
    along: number,
    y: number,
    outward: number,
  ): V3 => [
    basis.mx + basis.tx * along + basis.nx * outward,
    y,
    basis.mz + basis.tz * along + basis.nz * outward,
  ];
  const windows: CompiledWindow[] = [];
  for (const { wall, opening } of openingById.values()) {
    if (opening.kind !== "window") continue;
    const b = wallBasis(wall),
      y = opening.sillY + opening.height / 2,
      depth = wall.thickness + 0.18,
      outer = wall.thickness / 2 + 0.055,
      side = 0.13,
      rail = 0.13;
    const glazing = box(
        `${opening.id}/glass`,
        at(b, opening.offset, y, -wall.thickness / 2 - 0.025),
        [opening.width / 2, opening.height / 2, 0.025],
        [opening.id, wall.id],
        b.yaw,
      ),
      reveals = [
        box(
          `${opening.id}/reveal-left`,
          at(b, opening.offset - opening.width / 2 - side / 2, y, 0),
          [side / 2, (opening.height + 0.26) / 2, depth / 2],
          [opening.id, wall.id],
          b.yaw,
        ),
        box(
          `${opening.id}/reveal-right`,
          at(b, opening.offset + opening.width / 2 + side / 2, y, 0),
          [side / 2, (opening.height + 0.26) / 2, depth / 2],
          [opening.id, wall.id],
          b.yaw,
        ),
        box(
          `${opening.id}/reveal-top`,
          at(b, opening.offset, y + opening.height / 2 + rail / 2, 0),
          [opening.width / 2, rail / 2, depth / 2],
          [opening.id, wall.id],
          b.yaw,
        ),
        box(
          `${opening.id}/reveal-bottom`,
          at(b, opening.offset, y - opening.height / 2 - rail / 2, 0),
          [opening.width / 2, rail / 2, depth / 2],
          [opening.id, wall.id],
          b.yaw,
        ),
      ],
      frame = [
        box(
          `${opening.id}/frame-left`,
          at(b, opening.offset - opening.width / 2, y, outer),
          [0.065, (opening.height + 0.18) / 2, 0.09],
          [opening.id],
          b.yaw,
        ),
        box(
          `${opening.id}/frame-right`,
          at(b, opening.offset + opening.width / 2, y, outer),
          [0.065, (opening.height + 0.18) / 2, 0.09],
          [opening.id],
          b.yaw,
        ),
        box(
          `${opening.id}/frame-top`,
          at(b, opening.offset, y + opening.height / 2, outer),
          [(opening.width + 0.13) / 2, 0.065, 0.09],
          [opening.id],
          b.yaw,
        ),
        box(
          `${opening.id}/frame-bottom`,
          at(b, opening.offset, y - opening.height / 2, outer),
          [(opening.width + 0.13) / 2, 0.065, 0.09],
          [opening.id],
          b.yaw,
        ),
      ],
      mullions = [
        box(
          `${opening.id}/mullion`,
          at(b, opening.offset, y, outer + 0.015),
          [0.043, opening.height / 2, 0.055],
          [opening.id],
          b.yaw,
        ),
      ];
    const came: LinearMember[] = [-0.25, 0.25].map((fraction, index) => {
      const from = at(
          b,
          opening.offset + opening.width * fraction,
          y - opening.height / 2 + 0.06,
          outer + 0.08,
        ),
        to = at(
          b,
          opening.offset + opening.width * fraction,
          y + opening.height / 2 - 0.06,
          outer + 0.08,
        );
      return Object.freeze({
        kind: "linear-member",
        id: `${opening.id}/came-vertical-${index}`,
        from: Object.freeze(from),
        to: Object.freeze(to),
        width: 0.012,
        depth: 0.012,
        derivedFrom: Object.freeze([opening.id]),
      });
    });
    came.push(
      Object.freeze({
        kind: "linear-member",
        id: `${opening.id}/came-horizontal`,
        from: Object.freeze(
          at(b, opening.offset - opening.width / 2 + 0.06, y, outer + 0.08),
        ),
        to: Object.freeze(
          at(b, opening.offset + opening.width / 2 - 0.06, y, outer + 0.08),
        ),
        width: 0.012,
        depth: 0.012,
        derivedFrom: Object.freeze([opening.id]),
      }),
    );
    windows.push(
      Object.freeze({
        id: opening.id,
        wallId: wall.id,
        openingId: opening.id,
        facade: facade(b),
        apertureCenter: Object.freeze(at(b, opening.offset, y, 0)),
        apertureHalfExtents: Object.freeze(
          Math.abs(b.nx) > Math.abs(b.nz)
            ? [wall.thickness / 2, opening.height / 2, opening.width / 2]
            : [opening.width / 2, opening.height / 2, wall.thickness / 2],
        ) as V3,
        glazing,
        reveals: Object.freeze(reveals),
        frame: Object.freeze(frame),
        mullions: Object.freeze(mullions),
        came: Object.freeze(came),
      }),
    );
  }
  const doors: CompiledDoor[] = doorSpecs.map((spec) => {
    const record = openingById.get(spec.openingId);
    if (
      !record ||
      record.wall.id !== spec.wallId ||
      record.opening.kind !== "door"
    )
      throw new Error(
        `architecture: door ${spec.id} requires its authored door opening`,
      );
    if (
      spec.leafThickness <= 0.04 ||
      spec.leafThickness > 0.18 ||
      Math.abs(spec.openYawDegrees) < 80 ||
      Math.abs(spec.openYawDegrees) > 110
    )
      throw new Error(`architecture: invalid door assembly ${spec.id}`);
    const { wall, opening } = record,
      b = wallBasis(wall),
      hingeAlong =
        opening.offset +
        (spec.hingeSide === "start" ? -opening.width / 2 : opening.width / 2),
      direction = spec.hingeSide === "start" ? 1 : -1,
      hinge = at(b, hingeAlong, opening.sillY, wall.thickness / 2 + 0.06),
      center = at(
        b,
        opening.offset,
        opening.sillY + opening.height / 2,
        wall.thickness / 2 + 0.06,
      ),
      leaf = box(
        spec.id,
        center,
        [opening.width / 2, opening.height / 2, spec.leafThickness / 2],
        [spec.id, spec.openingId],
        b.yaw,
      ),
      frame = [
        box(
          `${spec.id}/frame-left`,
          at(
            b,
            opening.offset - opening.width / 2 - 0.1,
            opening.sillY + opening.height / 2,
            wall.thickness / 2 + 0.08,
          ),
          [0.1, opening.height / 2 + 0.1, 0.16],
          [spec.id],
          b.yaw,
        ),
        box(
          `${spec.id}/frame-right`,
          at(
            b,
            opening.offset + opening.width / 2 + 0.1,
            opening.sillY + opening.height / 2,
            wall.thickness / 2 + 0.08,
          ),
          [0.1, opening.height / 2 + 0.1, 0.16],
          [spec.id],
          b.yaw,
        ),
        box(
          `${spec.id}/frame-top`,
          at(
            b,
            opening.offset,
            opening.sillY + opening.height + 0.11,
            wall.thickness / 2 + 0.08,
          ),
          [opening.width / 2 + 0.2, 0.11, 0.16],
          [spec.id],
          b.yaw,
        ),
      ],
      reveals = [
        box(
          `${spec.id}/reveal-left`,
          at(
            b,
            opening.offset - opening.width / 2 - 0.06,
            opening.sillY + opening.height / 2,
            0,
          ),
          [0.06, opening.height / 2, wall.thickness / 2 + 0.03],
          [spec.id],
          b.yaw,
        ),
        box(
          `${spec.id}/reveal-right`,
          at(
            b,
            opening.offset + opening.width / 2 + 0.06,
            opening.sillY + opening.height / 2,
            0,
          ),
          [0.06, opening.height / 2, wall.thickness / 2 + 0.03],
          [spec.id],
          b.yaw,
        ),
        box(
          `${spec.id}/reveal-top`,
          at(b, opening.offset, opening.sillY + opening.height + 0.06, 0),
          [opening.width / 2, 0.06, wall.thickness / 2 + 0.03],
          [spec.id],
          b.yaw,
        ),
        box(
          `${spec.id}/reveal-bottom`,
          at(b, opening.offset, opening.sillY - 0.06, 0),
          [opening.width / 2, 0.06, wall.thickness / 2 + 0.03],
          [spec.id],
          b.yaw,
        ),
      ],
      leafLocalX = (direction * opening.width) / 2,
      localPart = (id: string, localCenter: V3, half: V3, role: string) =>
        Object.freeze({
          ...box(id, localCenter, half, [spec.id]),
          materialRole: role,
        }),
      boardHalf = opening.width / 10 - 0.006,
      braceRun = opening.width - 0.2,
      braceRise = opening.height - 0.64,
      braceLength = Math.hypot(braceRun, braceRise),
      planks = [
        ...Array.from({ length: 5 }, (_, index) =>
          localPart(
            `${spec.id}/plank-${index}`,
            [
              leafLocalX -
                opening.width / 2 +
                (opening.width * (index + 0.5)) / 5,
              opening.height / 2,
              0.012,
            ],
            [boardHalf, opening.height * 0.49, spec.leafThickness * 0.52],
            "door-surface",
          ),
        ),
        Object.freeze({
          ...localPart(
            `${spec.id}/brace`,
            [leafLocalX, opening.height / 2, 0.082],
            [braceLength / 2, 0.055, 0.035],
            "door-surface",
          ),
          doorPlaneAngleRadians: Math.atan2(braceRise, braceRun),
        }),
      ],
      ironwork = [
        localPart(
          `${spec.id}/strap-lower`,
          [leafLocalX, 0.42, 0.075],
          [opening.width * 0.42, 0.045, 0.018],
          "door-hardware",
        ),
        localPart(
          `${spec.id}/strap-upper`,
          [leafLocalX, opening.height - 0.42, 0.075],
          [opening.width * 0.42, 0.045, 0.018],
          "door-hardware",
        ),
        ...[0.42, opening.height / 2, opening.height - 0.42].map((y, index) =>
          localPart(
            `${spec.id}/hinge-knuckle-${index}`,
            [leafLocalX - direction * (opening.width / 2 - 0.035), y, 0.085],
            [0.035, 0.1, 0.025],
            "door-hardware",
          ),
        ),
        localPart(
          `${spec.id}/latch-plate`,
          [
            leafLocalX + direction * opening.width * 0.3,
            opening.height * 0.48,
            0.08,
          ],
          [0.08, 0.13, 0.02],
          "door-hardware",
        ),
        localPart(
          `${spec.id}/pull`,
          [
            leafLocalX + direction * opening.width * 0.3,
            opening.height * 0.6,
            0.1,
          ],
          [0.035, 0.12, 0.035],
          "door-hardware",
        ),
      ];
    return Object.freeze({
      id: spec.id,
      wallId: wall.id,
      openingId: spec.openingId,
      facade: facade(b),
      apertureCenter: Object.freeze(
        at(b, opening.offset, opening.sillY + opening.height / 2, 0),
      ),
      apertureHalfExtents: Object.freeze(
        Math.abs(b.nx) > Math.abs(b.nz)
          ? [wall.thickness / 2, opening.height / 2, opening.width / 2]
          : [opening.width / 2, opening.height / 2, wall.thickness / 2],
      ) as V3,
      leaf,
      hinge: Object.freeze(hinge),
      localCenter: Object.freeze([leafLocalX, opening.height / 2, 0]) as V3,
      closedYaw: 0,
      openYaw: (spec.openYawDegrees * Math.PI) / 180,
      runtimeClosedYaw: b.yaw,
      runtimeOpenYaw: b.yaw + (spec.openYawDegrees * Math.PI) / 180,
      frame: Object.freeze(frame),
      reveals: Object.freeze(reveals),
      planks: Object.freeze(planks),
      ironwork: Object.freeze(ironwork),
    });
  });
  const entrances: CompiledEntrance[] = input.entrances.map((entry) => {
    const wall = wallById.get(entry.wallId);
    if (!wall)
      throw new Error(`architecture: entrance ${entry.id} has missing wall`);
    const opening = wall.openings?.find((o) => o.id === entry.openingId);
    if (!opening || opening.kind !== "door")
      throw new Error(
        `architecture: entrance ${entry.id} requires a door opening`,
      );
    if (
      (entry.exteriorSide !== -1 && entry.exteriorSide !== 1) ||
      entry.stepCount < 1 ||
      !Number.isSafeInteger(entry.stepCount) ||
      entry.treadDepth <= 0 ||
      entry.landingDepth <= 0 ||
      entry.width < opening.width
    )
      throw new Error(`architecture: invalid entrance ${entry.id}`);
    const floor = opening.sillY,
      rise = (floor - entry.exteriorGradeY) / entry.stepCount,
      finishedSurface = entry.constructionPolicy === "finished-surface-authority",
      finishThickness = 0.05,
      bearingDepth = finishedSurface ? (entry.bearingDepth ?? NaN) : 0,
      structuralBottom = entry.exteriorGradeY - bearingDepth,
      landingSubstrateTop = finishedSurface ? floor - finishThickness : floor;
    if (finishedSurface && (!Number.isFinite(bearingDepth) || bearingDepth < 0.05 || bearingDepth > 0.5))
      throw new Error(`architecture: entrance ${entry.id} requires bounded grade bearing`);
    if (rise <= 0 || rise > 0.22 || entry.treadDepth < 0.25)
      throw new Error(
        `architecture: entrance ${entry.id} violates stair rise/run`,
      );
    const dx = wall.to[0] - wall.from[0],
      dz = wall.to[1] - wall.from[1],
      length = Math.hypot(dx, dz),
      tx = dx / length,
      tz = dz / length,
      nx = -tz * entry.exteriorSide,
      nz = tx * entry.exteriorSide,
      mx = (wall.from[0] + wall.to[0]) / 2 + tx * opening.offset,
      mz = (wall.from[1] + wall.to[1]) / 2 + tz * opening.offset,
      yaw = Math.atan2(tz, tx);
    const threshold = box(
      `entrance/${entry.id}/threshold`,
      [mx, floor - 0.06, mz],
      [entry.width / 2, 0.06, wall.thickness / 2 + 0.08],
      [entry.id, entry.openingId],
      yaw,
    );
    const landing = box(
      `entrance/${entry.id}/landing`,
      [
        mx + (nx * entry.landingDepth) / 2,
        (landingSubstrateTop + structuralBottom) / 2,
        mz + (nz * entry.landingDepth) / 2,
      ],
      [
        entry.width / 2,
        (landingSubstrateTop - structuralBottom) / 2,
        entry.landingDepth / 2,
      ],
      [entry.id, entry.openingId],
      yaw,
    );
    const emittedStepCount = finishedSurface
        ? entry.stepCount - 1
        : entry.stepCount,
      steps = Array.from({ length: emittedStepCount }, (_, index) => {
      const walkingTop = entry.exteriorGradeY + rise * (index + 1),
        top = finishedSurface ? walkingTop - finishThickness : walkingTop,
        distance =
          entry.landingDepth +
          entry.treadDepth * (emittedStepCount - index - 0.5);
      return box(
        `entrance/${entry.id}/step-${index}`,
        [
          mx + nx * distance,
          (top + structuralBottom) / 2,
          mz + nz * distance,
        ],
        [
          entry.width / 2,
          (top - structuralBottom) / 2,
          entry.treadDepth / 2,
        ],
        [entry.id, entry.openingId],
        yaw,
      );
    });
    const finishCourses: SolidBox[] = [
      box(
        `entry/${entry.id}/finish-landing`,
        [
          mx + (nx * entry.landingDepth) / 2,
          finishedSurface ? floor - finishThickness / 2 : floor + 0.025,
          mz + (nz * entry.landingDepth) / 2,
        ],
        [
          entry.width / 2,
          finishedSurface ? finishThickness / 2 : 0.025,
          entry.landingDepth / 2,
        ],
        [entry.id, entry.openingId],
        yaw,
      ),
      ...Array.from({ length: emittedStepCount }, (_, index) => {
        const top = entry.exteriorGradeY + rise * (index + 1),
          distance =
            entry.landingDepth +
            entry.treadDepth * (emittedStepCount - index - 0.5);
        return box(
          `entry/${entry.id}/finish-step-${index}`,
          [
            mx + nx * distance,
            finishedSurface ? top - finishThickness / 2 : top + 0.025,
            mz + nz * distance,
          ],
          [
            entry.width / 2,
            finishedSurface ? finishThickness / 2 : 0.025,
            entry.treadDepth / 2,
          ],
          [entry.id, entry.openingId],
          yaw,
        );
      }),
    ];
    const support = foundations.some(
      (f) =>
        Math.abs(f.center[0] - mx) <=
          f.halfExtents[0] +
            entry.landingDepth +
            entry.treadDepth * entry.stepCount &&
        Math.abs(f.center[2] - mz) <=
          f.halfExtents[2] +
            entry.landingDepth +
            entry.treadDepth * entry.stepCount,
    );
    if (!support)
      throw new Error(
        `architecture: entrance ${entry.id} lacks foundation support`,
      );
    return Object.freeze({
      id: entry.id,
      openingId: entry.openingId,
      threshold,
      landing,
      steps: Object.freeze(steps),
      finishCourses: Object.freeze(finishCourses),
      finishedFloorY: floor,
      exteriorGradeY: entry.exteriorGradeY,
    });
  });
  const emittedRoofPlaneSpecs = roofPlaneSpecs.flatMap(
    (plane) => roofSurfaceOverrides.get(plane.id) ?? [plane],
  );
  const planes = emittedRoofPlaneSpecs.map((p) => {
    v3(p.origin, p.id);
    v3(p.normal, `${p.id}.normal`);
    p.boundary.forEach((vertex, index) =>
      v3(vertex, `${p.id}.boundary[${index}]`),
    );
    if (
      p.boundary.length < 3 ||
      !Number.isFinite(p.thickness) ||
      p.thickness <= 0
    )
      throw new Error(`architecture: invalid roof plane ${p.id}`);
    const l = Math.hypot(...p.normal);
    if (Math.abs(l - 1) > 0.001)
      throw new Error(`architecture: roof normal ${p.id} must be normalized`);
    if (
      p.boundary.some(
        (vertex) => pointPlaneDistance(vertex, p.origin, p.normal) > 0.003,
      )
    )
      throw new Error(`architecture: roof boundary ${p.id} leaves its plane`);
    return Object.freeze({
      kind: "plane-slab" as const,
      id: `roof/${p.id}`,
      surfaceRole: "roof" as const,
      origin: p.origin,
      normal: p.normal,
      boundary: Object.freeze([...p.boundary]),
      thickness: p.thickness,
      derivedFrom: Object.freeze([p.id]),
    });
  });
  const weatherSource = [
      ...planes,
      ...dormerPrimitives.filter(
        (primitive): primitive is PlaneSlab =>
          primitive.kind === "plane-slab" &&
          primitive.surfaceRole === "roof" &&
          /\/roof-(west|east)$/.test(primitive.id),
      ),
    ],
    weatherPlanes: PlaneSlab[] = weatherSource.map((slab) => {
      const offset = slab.thickness / 2 + 0.0175,
        shift = (point: V3): V3 => add3(point, scale3(slab.normal, offset));
      return Object.freeze({
        kind: "plane-slab",
        id: `roof-weather/${slab.id.replace(/^roof\//, "")}`,
        surfaceRole: "roof",
        origin: Object.freeze(shift(slab.origin)),
        normal: Object.freeze([...slab.normal]) as V3,
        boundary: Object.freeze(
          slab.boundary.map((point) => Object.freeze(shift(point))),
        ),
        thickness: 0.035,
        derivedFrom: Object.freeze([slab.id, ...slab.derivedFrom]),
      });
    });
  const eaveTrim: ArchitecturePrimitive[] = [];
  for (const plane of roofPlaneSpecs) {
    const ordered = [...plane.boundary].sort((a, b) => a[1] - b[1]),
      eave = ordered.slice(0, 2),
      ridge = ordered.slice(-2),
      eaveMid = mean3(eave[0], eave[1]),
      ridgeMid = mean3(ridge[0], ridge[1]),
      towardRidge = unit3(sub3(ridgeMid, eaveMid)),
      length = Math.hypot(...sub3(eave[1], eave[0])),
      count = Math.max(2, Math.ceil(length / 0.65)),
      member = (
        id: string,
        from: V3,
        to: V3,
        width: number,
        depth: number,
      ): LinearMember =>
        Object.freeze({
          kind: "linear-member",
          id,
          from: Object.freeze(from),
          to: Object.freeze(to),
          width,
          depth,
          derivedFrom: Object.freeze([plane.id]),
        });
    eaveTrim.push(
      member(`eave-trim/${plane.id}/fascia`, eave[0], eave[1], 0.18, 0.16),
    );
    for (let index = 0; index < count; index++) {
      const t = (index + 0.5) / count,
        root = add3(eave[0], scale3(sub3(eave[1], eave[0]), t));
      eaveTrim.push(
        member(
          `eave-trim/${plane.id}/rafter-tail-${index}`,
          root,
          add3(root, scale3(towardRidge, 0.42)),
          0.09,
          0.11,
        ),
      );
    }
    for (const endpoint of eave) {
      const boundaryIndex = plane.boundary.indexOf(endpoint),
        adjacent = [
          plane.boundary[(boundaryIndex - 1 + plane.boundary.length) % plane.boundary.length],
          plane.boundary[(boundaryIndex + 1) % plane.boundary.length],
        ],
        nearest =
          adjacent.find((candidate) => ridge.includes(candidate)) ??
          [...ridge].sort(
            (a, b) =>
              Math.hypot(...sub3(a, endpoint)) - Math.hypot(...sub3(b, endpoint)),
          )[0],
        liesOnSeamLine = (point: V3, seam: RoofSeamSpec) => {
          const direction = sub3(seam.to, seam.from),
            length = Math.hypot(...direction);
          return Math.hypot(...cross3(sub3(point, seam.from), direction)) / length <= 0.003;
        },
        joinedValleyEdge = roofSeamSpecs.some(
          (seam) =>
            seam.kind === "valley" &&
            seam.planeIds.includes(plane.id) &&
            liesOnSeamLine(endpoint, seam) &&
            liesOnSeamLine(nearest, seam),
        );
      if (joinedValleyEdge) continue;
      eaveTrim.push(
        member(
          `eave-trim/${plane.id}/barge-${endpoint === eave[0] ? 0 : 1}`,
          endpoint,
          nearest,
          0.15,
          0.1,
        ),
      );
    }
  }
  const planeById = new Map(
    roofPlaneSpecs.map((p, i) => [p.id, { spec: p, ir: planes[i] }]),
  );
  const roofSeams: CompiledRoofSeam[] = roofSeamSpecs.map((seam) => {
    v3(seam.from, `${seam.id}.from`);
    v3(seam.to, `${seam.id}.to`);
    if (
      seam.planeIds[0] === seam.planeIds[1] ||
      Math.hypot(
        seam.to[0] - seam.from[0],
        seam.to[1] - seam.from[1],
        seam.to[2] - seam.from[2],
      ) <= EPS
    )
      throw new Error(
        `architecture: seam ${seam.id} requires two planes and nonzero length`,
      );
    const a = planeById.get(seam.planeIds[0]),
      b = planeById.get(seam.planeIds[1]);
    if (!a || !b)
      throw new Error(`architecture: seam ${seam.id} has missing roof plane`);
    for (const p of seamSamples(seam.from, seam.to))
      if (
        pointPlaneDistance(p, a.spec.origin, a.spec.normal) > 0.003 ||
        pointPlaneDistance(p, b.spec.origin, b.spec.normal) > 0.003 ||
        !insideBoundary(p, a.spec.boundary, a.spec.normal, 0.01) ||
        !insideBoundary(p, b.spec.boundary, b.spec.normal, 0.01)
      )
        throw new Error(
          `architecture: seam ${seam.id} is not fully supported by both roof planes`,
        );
    if (seam.kind === "valley" && (seam.flashingWidth ?? 0) < 0.12)
      throw new Error(
        `architecture: valley ${seam.id} lacks credible flashing`,
      );
    return Object.freeze({ ...seam, supported: true as const });
  });
  const roofWallAbutmentMembers: ArchitecturePrimitive[] = roofWallAbutmentSpecs.map((abutment) => {
    v3(abutment.from, `${abutment.id}.from`);v3(abutment.to, `${abutment.id}.to`);
    const plane=planeById.get(abutment.roofPlaneId)?.spec,wall=wallSpecs.find(({id})=>id===abutment.wallId);
    if(!plane||!wall||abutment.flashingWidth<.12||abutment.upstandDepth<.04||abutment.upstandDepth>.3||Math.hypot(...sub3(abutment.to,abutment.from))<.4)throw new Error(`architecture: invalid roof-wall abutment ${abutment.id}`);
    const wallDistance=(point:V3)=>{const [ax,az]=wall.from,[bx,bz]=wall.to,dx=bx-ax,dz=bz-az,length2=dx*dx+dz*dz,t=Math.max(0,Math.min(1,((point[0]-ax)*dx+(point[2]-az)*dz)/length2)),x=ax+t*dx,z=az+t*dz;return Math.hypot(point[0]-x,point[2]-z);};
    for(const point of seamSamples(abutment.from,abutment.to))if(pointPlaneDistance(point,plane.origin,plane.normal)>.003||!insideBoundary(point,plane.boundary,plane.normal,.01)||wallDistance(point)>wall.thickness/2+.16||point[1]<wall.bottomY-.01||point[1]>wall.topY+.01)throw new Error(`architecture: roof-wall abutment ${abutment.id} leaves its roof or wall substrate`);
    return Object.freeze({kind:"linear-member" as const,id:`roof-wall-flashing/${abutment.id}`,from:Object.freeze([...abutment.from]) as V3,to:Object.freeze([...abutment.to]) as V3,width:abutment.flashingWidth,depth:abutment.upstandDepth,derivedFrom:Object.freeze([abutment.id,abutment.roofPlaneId,abutment.wallId])});
  });
  const fireplaces: CompiledFireplace[] = (input.fireplaces ?? []).map((f) => {
    if (
      !planeById.has(f.roofPlaneId) ||
      f.chimneyTopY <= f.center[1] + f.apertureHalfExtents[1]
    )
      throw new Error(`architecture: invalid fireplace ${f.id}`);
    const [x, y, z] = f.center,
      [hx, hy, hz] = f.apertureHalfExtents,
      legacyBaseBottom = y - hy - 0.08,
      baseBottom = f.supportY ?? legacyBaseBottom,
      baseTop = y - hy + 0.08;
    if (
      f.supportY !== undefined &&
      (!input.functional ||
        Math.abs(f.supportY - input.functional.site.finishedFloorY) > 0.001 ||
        baseTop - baseBottom < 0.1)
    )
      throw new Error(
        `architecture: fireplace ${f.id} support must bear on the finished floor`,
      );
    const base = box(
        `fireplace/${f.id}/base`,
        [x, (baseBottom + baseTop) / 2, z - 0.12],
        [hx + 0.18, (baseTop - baseBottom) / 2, hz + 0.28],
        [f.id],
      ),
      cavityDepth = 0.025,
      cavity = box(
        `fireplace/${f.id}/cavity`,
        [x, y + 0.12, z + hz - 0.22],
        [hx * 0.78, hy * 0.72, cavityDepth / 2],
        [f.id],
      );
    const firebackBottom: V3 = [x - hx * 0.88, y - hy + 0.08, z + hz - 0.2],
      firebackTop: V3 = [x - hx * 0.88, y + hy - 0.08, z + hz - 0.34],
      fireback: PlaneSlab = Object.freeze({
        kind: "plane-slab",
        id: `fireplace/${f.id}/fireback`,
        surfaceRole: "wall",
        origin: firebackBottom,
        normal: planeNormal([
          firebackBottom,
          [x + hx * 0.88, firebackBottom[1], firebackBottom[2]],
          [x + hx * 0.88, firebackTop[1], firebackTop[2]],
        ]),
        boundary: Object.freeze([
          firebackBottom,
          [x + hx * 0.88, firebackBottom[1], firebackBottom[2]] as V3,
          [x + hx * 0.88, firebackTop[1], firebackTop[2]] as V3,
          firebackTop,
        ]),
        thickness: 0.1,
        derivedFrom: Object.freeze([f.id]),
      }),
      throatFrontY = y + hy + 0.02,
      throatBackY = Math.min(y + hy + 0.42, 2.28),
      throat: PlaneSlab = Object.freeze({
        kind: "plane-slab",
        id: `fireplace/${f.id}/throat`,
        surfaceRole: "wall",
        origin: [x - hx * 0.72, throatFrontY, z - hz * 0.32] as V3,
        normal: planeNormal([
          [x - hx * 0.72, throatFrontY, z - hz * 0.32] as V3,
          [x + hx * 0.72, throatFrontY, z - hz * 0.32] as V3,
          [x + hx * 0.48, throatBackY, z + hz * 0.12] as V3,
        ]),
        boundary: Object.freeze([
          [x - hx * 0.72, throatFrontY, z - hz * 0.32] as V3,
          [x + hx * 0.72, throatFrontY, z - hz * 0.32] as V3,
          [x + hx * 0.48, throatBackY, z + hz * 0.12] as V3,
          [x - hx * 0.48, throatBackY, z + hz * 0.12] as V3,
        ]),
        thickness: 0.1,
        derivedFrom: Object.freeze([f.id]),
      }),
      surround: ArchitecturePrimitive[] = [
      fireback,
      throat,
      box(
        `fireplace/${f.id}/lining-left`,
        [x - hx + 0.055, y, z + 0.05],
        [0.055, hy, hz * 0.82],
        [f.id],
      ),
      box(
        `fireplace/${f.id}/lining-right`,
        [x + hx - 0.055, y, z + 0.05],
        [0.055, hy, hz * 0.82],
        [f.id],
      ),
      box(
        `fireplace/${f.id}/smoke-shelf`,
        [x, throatBackY + 0.055, z + hz * 0.2],
        [hx * 0.5, 0.055, hz * 0.48],
        [f.id],
      ),
      box(
        `fireplace/${f.id}/smoke-chamber-west`,
        [x - hx * 0.37, 2.32, z - 0.02],
        [hx * 0.12, 0.32, hz * 0.48],
        [f.id],
      ),
      box(
        `fireplace/${f.id}/smoke-chamber-east`,
        [x + hx * 0.37, 2.32, z - 0.02],
        [hx * 0.12, 0.32, hz * 0.48],
        [f.id],
      ),
      box(
        `fireplace/${f.id}/jamb-left`,
        [x - hx - 0.15, y, z],
        [0.15, hy + 0.15, hz],
        [f.id],
      ),
      box(
        `fireplace/${f.id}/jamb-right`,
        [x + hx + 0.15, y, z],
        [0.15, hy + 0.15, hz],
        [f.id],
      ),
      box(
        `fireplace/${f.id}/lintel`,
        [x, y + hy + 0.15, z],
        [hx + 0.3, 0.15, hz],
        [f.id],
      ),
      box(
        `fireplace/${f.id}/hood`,
        [x, y + hy + 0.38, z],
        [hx + 0.16, 0.18, hz * 0.72],
        [f.id],
      ),
    ];
    const fuel = [
        cylinder(
          `fireplace/${f.id}/log-x-a`,
          [x - hx * 0.65, y - hy + 0.19, z - hz * 0.18],
          [x + hx * 0.65, y - hy + 0.19, z - hz * 0.18],
          0.11,
          12,
          [f.id],
        ),
        cylinder(
          `fireplace/${f.id}/log-x-b`,
          [x - hx * 0.65, y - hy + 0.19, z + hz * 0.18],
          [x + hx * 0.65, y - hy + 0.19, z + hz * 0.18],
          0.11,
          12,
          [f.id],
        ),
        cylinder(
          `fireplace/${f.id}/log-z`,
          [x, y - hy + 0.23, z - hz * 0.65],
          [x, y - hy + 0.23, z + hz * 0.65],
          0.11,
          12,
          [f.id],
        ),
      ],
      emberBed = box(
        `fireplace/${f.id}/embers`,
        [x, y - hy + 0.06, z],
        [hx * 0.7, 0.04, hz * 0.7],
        [f.id],
      ),
      flames = [
        taperedFlame(
          `fireplace/${f.id}/flame-outer`,
          [x - 0.08, y - hy + 0.1, z - 0.15],
          hy * 0.94,
          hx * 0.24,
          [0.08, 0, -0.04],
          14,
          [f.id],
        ),
        taperedFlame(
          `fireplace/${f.id}/flame-inner`,
          [x + 0.02, y - hy + 0.1, z - 0.18],
          hy * 0.72,
          hx * 0.16,
          [-0.06, 0, 0.03],
          12,
          [f.id],
        ),
        taperedFlame(
          `fireplace/${f.id}/flame-outer-right`,
          [x + 0.22, y - hy + 0.1, z - 0.10],
          hy * 0.72,
          hx * 0.17,
          [-0.07, 0, -0.02],
          12,
          [f.id],
        ),
        taperedFlame(
          `fireplace/${f.id}/flame-inner-left`,
          [x - 0.25, y - hy + 0.1, z - 0.08],
          hy * 0.55,
          hx * 0.12,
          [0.05, 0, 0.02],
          12,
          [f.id],
        ),
      ],
      penetration = roofPenetrations.find((item) => item.fireplaceId === f.id);
    if (penetration)
      return Object.freeze({
        id: f.id,
        base,
        cavity,
        surround: Object.freeze(surround),
        fuel: Object.freeze(fuel),
        emberBed,
        flames: Object.freeze(flames),
        lightPosition: Object.freeze([x, y - hy + 0.38, z]) as V3,
        penetrationId: penetration.id,
      });
    const chimney = box(
      `fireplace/${f.id}/chimney`,
      [x, (y + hy + f.chimneyTopY) / 2, z],
      [hx * 0.42, (f.chimneyTopY - y - hy) / 2, hz * 0.42],
      [f.id, f.roofPlaneId],
    );
    return Object.freeze({
      id: f.id,
      base,
      cavity,
      surround: Object.freeze(surround),
      fuel: Object.freeze(fuel),
      emberBed,
      flames: Object.freeze(flames),
      lightPosition: Object.freeze([x, y - hy + 0.38, z]) as V3,
      chimney,
    });
  });
  const practicalLights: CompiledPracticalLight[] = (
    input.practicalLights ?? []
  ).map((light) => {
    v3(light.position, `${light.id}.position`);
    v3(light.color, `${light.id}.color`);
    if (
      light.color.some((channel) => channel < 0 || channel > 1) ||
      light.intensityCandela <= 0 ||
      light.intensityCandela > 40 ||
      light.range < 1 ||
      light.range > 8
    )
      throw new Error(`architecture: invalid practical light ${light.id}`);
    return Object.freeze({
      ...light,
      position: Object.freeze([...light.position]) as V3,
      color: Object.freeze([...light.color]) as V3,
    });
  });
  if (
    practicalLights.reduce((sum, light) => sum + light.intensityCandela, 0) > 60
  )
    throw new Error("architecture: practical light budget exceeds 60 candela");
  for (const fireplace of input.fireplaces ?? []) {
    if (!fireplace.lightId) continue;
    const light = practicalLights.find(
      (candidate) => candidate.id === fireplace.lightId,
    );
    if (!light)
      throw new Error(
        `architecture: fireplace ${fireplace.id} references missing practical light ${fireplace.lightId}`,
      );
    if (
      light.intensityCandela < 6 ||
      light.intensityCandela > 8 ||
      light.range < 2 ||
      light.range > 2.5 ||
      light.color[0] < 0.65 ||
      light.color[0] > 0.85 ||
      light.color[1] > light.color[0] * 0.5 ||
      light.color[2] > light.color[0] * 0.2 ||
      Math.max(...light.color) * light.intensityCandela > 5
    )
      throw new Error(
        `architecture: fireplace ${fireplace.id} practical light escapes bounded fire-spill authority`,
      );
  }
  const furnishings: CompiledFurnishing[] = (input.furnishings ?? []).map(
    (spec) => {
      v3(spec.center, `${spec.id}.center`);
      const yaw = spec.yawRadians ?? 0,
        c = Math.cos(yaw),
        s = Math.sin(yaw),
        atLocal = (x: number, y: number, z: number): V3 => [
          spec.center[0] + x * c + z * s,
          spec.center[1] + y,
          spec.center[2] - x * s + z * c,
        ],
        part = (name: string, local: V3, half: V3) =>
          box(
            `furnishing/${spec.id}/${name}`,
            atLocal(...local),
            half,
            [spec.id],
            yaw,
          ),
        parts: ArchitecturePrimitive[] = [];
      if (spec.kind === "table") {
        parts.push(part("top", [0, 0.74, 0], [1.05, 0.075, 0.62]));
        for (const x of [-0.86, 0.86])
          for (const z of [-0.44, 0.44])
            parts.push(
              part(`leg-${x}-${z}`, [x, 0.37, z], [0.075, 0.37, 0.075]),
            );
        parts.push(
          part("stretcher-long", [0, 0.34, 0], [0.82, 0.055, 0.055]),
          part("stretcher-end-a", [-0.86, 0.32, 0], [0.055, 0.05, 0.4]),
          part("stretcher-end-b", [0.86, 0.32, 0], [0.055, 0.05, 0.4]),
        );
        for (const x of [-0.86, 0.86])
          for (const z of [-0.44, 0.44])
            parts.push(
              part(`peg-${x}-${z}`, [x, 0.825, z], [0.025, 0.018, 0.025]),
            );
      } else if (spec.kind === "bench") {
        parts.push(
          part("seat", [0, 0.48, 0], [0.78, 0.07, 0.24]),
          part("apron", [0, 0.36, 0], [0.68, 0.09, 0.05]),
          part("stretcher", [0, 0.22, 0], [0.55, 0.045, 0.045]),
        );
        for (const x of [-0.62, 0.62])
          parts.push(
            part(`leg-${x}`, [x, 0.23, 0], [0.08, 0.23, 0.18]),
            part(`peg-${x}`, [x, 0.56, 0], [0.025, 0.018, 0.025]),
          );
      } else if (spec.kind === "hearth-settle") {
        parts.push(
          part("seat", [0, 0.46, 0], [0.82, 0.065, 0.29]),
          part("front-apron", [0, 0.35, -0.235], [0.70, 0.055, 0.045]),
          part("rear-seat-rail", [0, 0.35, 0.235], [0.70, 0.055, 0.045]),
          part("back-rail-low", [0, 0.82, 0.25], [0.70, 0.055, 0.045]),
          part("back-rail-high", [0, 1.42, 0.25], [0.70, 0.055, 0.045]),
          part("crest", [0, 1.58, 0.25], [0.80, 0.07, 0.07]),
          part("under-seat-stretcher", [0, 0.23, 0], [0.68, 0.045, 0.04]),
        );
        for (const x of [-0.68, 0.68]) {
          parts.push(
            part(`front-leg-${x}`, [x, 0.23, -0.21], [0.065, 0.23, 0.065]),
            part(`rear-post-${x}`, [x, 0.79, 0.25], [0.075, 0.79, 0.075]),
            part(`end-stretcher-${x}`, [x, 0.23, 0], [0.04, 0.045, 0.21]),
          );
        }
        for (let index = 0; index < 3; index++)
          parts.push(
            part(
              `back-board-${index}`,
              [-0.42 + index * 0.42, 1.12, 0.25],
              [0.15, 0.245, 0.035],
            ),
          );
      } else if (spec.kind === "cupboard") {
        parts.push(
          part("post-left", [-0.68, 1.0, 0], [0.07, 1, 0.3]),
          part("post-right", [0.68, 1.0, 0], [0.07, 1, 0.3]),
          part("top", [0, 1.95, 0], [0.75, 0.07, 0.34]),
          part("bottom", [0, 0.08, 0], [0.75, 0.08, 0.34]),
          part("back", [0, 1.0, 0.28], [0.68, 0.92, 0.04]),
          part("shelf-low", [0, 0.7, 0], [0.65, 0.045, 0.27]),
          part("shelf-high", [0, 1.34, 0], [0.65, 0.045, 0.27]),
        );
        for (const side of [-1, 1]) {
          const x = side * 0.335,
            prefix = side < 0 ? "door-left" : "door-right";
          parts.push(
            part(`${prefix}-panel-low`, [x, 0.57, -0.322], [0.235, 0.27, 0.025]),
            part(`${prefix}-panel-mid`, [x, 1.0, -0.322], [0.235, 0.12, 0.025]),
            part(`${prefix}-panel-high`, [x, 1.43, -0.322], [0.235, 0.27, 0.025]),
            part(
              `${prefix}-stile-out`,
              [x + side * 0.265, 1, -0.34],
              [0.055, 0.84, 0.035],
            ),
            part(
              `${prefix}-stile-in`,
              [x - side * 0.265, 1, -0.34],
              [0.055, 0.84, 0.035],
            ),
          );
          for (const y of [0.2, 1, 1.8])
            parts.push(
              part(`${prefix}-rail-${y}`, [x, y, -0.34], [0.31, 0.055, 0.035]),
            );
          parts.push(
            part(
              `${prefix}-hinge-upper`,
              [x + side * 0.29, 1.55, -0.382],
              [0.09, 0.025, 0.018],
            ),
            part(
              `${prefix}-hinge-lower`,
              [x + side * 0.29, 0.45, -0.382],
              [0.09, 0.025, 0.018],
            ),
            part(
              `${prefix}-knob`,
              [x - side * 0.22, 1, -0.39],
              [0.035, 0.045, 0.035],
            ),
          );
        }
      } else if (spec.kind === "shelf") {
        for (const y of [0.45, 1.05, 1.65])
          parts.push(part(`shelf-${y}`, [0, y, 0], [0.72, 0.055, 0.25]));
        parts.push(
          part("upright-left", [-0.66, 1.05, 0.18], [0.055, 1.05, 0.055]),
          part("upright-right", [0.66, 1.05, 0.18], [0.055, 1.05, 0.055]),
        );
      } else if (spec.kind === "settle") {
        parts.push(
          part("seat", [0, 0.48, 0], [0.76, 0.08, 0.32]),
          part("apron", [0, 0.34, 0], [0.66, 0.09, 0.05]),
          part("crest", [0, 1.62, 0.27], [0.84, 0.07, 0.07]),
          part("back-rail-low", [0, 0.82, 0.27], [0.70, 0.055, 0.045]),
          part("back-rail-high", [0, 1.48, 0.27], [0.70, 0.055, 0.045]),
          part("arm-left", [-0.68, 0.83, 0], [0.08, 0.07, 0.34]),
          part("arm-right", [0.68, 0.83, 0], [0.08, 0.07, 0.34]),
        );
        for (const x of [-0.64, 0.64])
          parts.push(
            part(`front-leg-${x}`, [x, 0.24, -0.2], [0.08, 0.24, 0.08]),
            part(`rear-post-${x}`, [x, 0.92, 0.25], [0.08, 0.92, 0.08]),
          );
        for (let index = 0; index < 3; index++)
          parts.push(
            part(
              `back-board-${index}`,
              [-0.42 + index * 0.42, 1.15, 0.27],
              [0.15, 0.30, 0.035],
            ),
          );
        parts.push(
          part("under-seat-stretcher", [0, 0.22, 0.1], [0.62, 0.045, 0.045]),
        );
      } else if (spec.kind === "stool") {
        parts.push(part("seat", [0, 0.48, 0], [0.3, 0.07, 0.3]));
        for (const x of [-0.22, 0.22])
          for (const z of [-0.22, 0.22])
            parts.push(
              part(`leg-${x}-${z}`, [x, 0.24, z], [0.055, 0.24, 0.055]),
            );
        parts.push(
          part("crossbar-x", [0, 0.2, 0], [0.23, 0.035, 0.035]),
          part("crossbar-z", [0, 0.2, 0], [0.035, 0.035, 0.23]),
        );
      } else if (spec.kind === "chest") {
        parts.push(
          part("base", [0, 0.1, 0], [0.68, 0.1, 0.34]),
          part("front", [0, 0.47, -0.31], [0.68, 0.37, 0.035]),
          part("back", [0, 0.47, 0.31], [0.68, 0.37, 0.035]),
          part("side-left", [-0.645, 0.47, 0], [0.035, 0.37, 0.28]),
          part("side-right", [0.645, 0.47, 0], [0.035, 0.37, 0.28]),
        );
        for (let index = 0; index < 4; index++)
          parts.push(
            part(
              `lid-board-${index}`,
              [-0.48 + index * 0.32, 0.89, 0],
              [0.15, 0.055, 0.36],
            ),
          );
        parts.push(
          part("strap-left", [-0.36, 0.91, -0.37], [0.035, 0.018, 0.08]),
          part("strap-right", [0.36, 0.91, -0.37], [0.035, 0.018, 0.08]),
          part("hasp", [0, 0.62, -0.37], [0.05, 0.13, 0.018]),
        );
      } else {
        parts.push(
          part("base-left", [-0.42, 0.1, 0], [0.06, 0.1, 0.32]),
          part("base-right", [0.42, 0.1, 0], [0.06, 0.1, 0.32]),
          part("upright-left", [-0.42, 0.55, 0.25], [0.055, 0.55, 0.055]),
          part("upright-right", [0.42, 0.55, 0.25], [0.055, 0.55, 0.055]),
          part("crossbar", [0, 0.55, 0.25], [0.42, 0.05, 0.05]),
        );
        for (let index = 0; index < 4; index++) {
          const z = -0.19 + index * 0.13;
          parts.push(
            cylinder(
              `furnishing/${spec.id}/log-${index}`,
              atLocal(-0.35 + (index % 2) * 0.08, 0.34, z),
              atLocal(0.35 + (index % 2) * 0.08, 0.34, z),
              0.075,
              10,
              [spec.id],
            ),
          );
        }
      }
      const requiredByKind: Record<typeof spec.kind, readonly string[]> = {
        table: ["top", "leg-", "stretcher"], bench: ["seat", "leg-", "stretcher"],
        "hearth-settle": ["seat", "front-leg", "rear-post", "back-board", "back-rail", "stretcher"],
        cupboard: ["post-left", "post-right", "door-left-panel", "door-right-panel"], shelf: ["shelf-", "upright-left", "upright-right"],
        settle: ["seat", "rear-post", "back-board", "back-rail"], stool: ["seat", "leg-", "crossbar"],
        chest: ["base", "front", "back", "lid-board", "hasp"], "log-rack": ["base-left", "base-right", "upright-left", "upright-right", "log-"],
      };
      for (const token of requiredByKind[spec.kind]) if (!parts.some((candidate) => candidate.id.includes(token)))
        throw new Error(`architecture: furnishing ${spec.id} lacks canonical ${token} joinery`);
      const bounds = parts.map((candidate) => {
        if (candidate.kind === "box") {
          const angle = candidate.yawRadians ?? 0, cosine = Math.abs(Math.cos(angle)), sine = Math.abs(Math.sin(angle));
          return { center: candidate.center, half: [cosine*candidate.halfExtents[0]+sine*candidate.halfExtents[2],candidate.halfExtents[1],sine*candidate.halfExtents[0]+cosine*candidate.halfExtents[2]] as V3 };
        }
        if (candidate.kind === "oriented-cylinder") return { center: scale3(add3(candidate.from,candidate.to),.5), half: [Math.abs(candidate.to[0]-candidate.from[0])*.5+candidate.radius,Math.abs(candidate.to[1]-candidate.from[1])*.5+candidate.radius,Math.abs(candidate.to[2]-candidate.from[2])*.5+candidate.radius] as V3 };
        throw new Error(`architecture: furnishing ${spec.id} uses unsupported connectivity primitive ${candidate.kind}`);
      });
      const connected = new Set<number>([0]), queue=[0], tolerance=.035;
      while(queue.length){const index=queue.shift()!,a=bounds[index];for(let other=0;other<bounds.length;other++){if(connected.has(other))continue;const b=bounds[other];if([0,1,2].every(axis=>Math.abs(a.center[axis]-b.center[axis])<=a.half[axis]+b.half[axis]+tolerance)){connected.add(other);queue.push(other);}}}
      if(connected.size!==parts.length)throw new Error(`architecture: furnishing ${spec.id} contains disconnected joinery (${connected.size}/${parts.length})`);
      return Object.freeze({
        id: spec.id,
        kind: spec.kind,
        parts: Object.freeze(parts),
      });
    },
  );
  const interiorStructure: CompiledInteriorStructure[] = (
    input.interiorStructure ?? []
  ).map((spec) => {
    const parts: ArchitecturePrimitive[] = [];
    if (spec.kind === "knee-brace") {
      v3(spec.from, `${spec.id}.from`);
      v3(spec.to, `${spec.id}.to`);
      if (spec.width < 0.08 || spec.depth < 0.08)
        throw new Error(
          `architecture: interior brace ${spec.id} is undersized`,
        );
      parts.push(
        Object.freeze({
          kind: "linear-member",
          id: `interior-structure/${spec.id}`,
          from: Object.freeze([...spec.from]) as V3,
          to: Object.freeze([...spec.to]) as V3,
          width: spec.width,
          depth: spec.depth,
          derivedFrom: Object.freeze([spec.id]),
        }),
      );
    } else {
      v3(spec.center, `${spec.id}.center`);
      v3(spec.halfExtents, `${spec.id}.halfExtents`);
      if (spec.halfExtents.some((value) => value <= 0.04))
        throw new Error(
          `architecture: interior structure ${spec.id} is undersized`,
        );
      if (spec.kind === "mantel") {
        const constrained = spec.placementPolicy === "fireplace-clearance";
        if (constrained !== Boolean(spec.fireplaceId))
          throw new Error(
            `architecture: mantel ${spec.id} must pair fireplace-clearance with a fireplaceId`,
          );
        if (constrained) {
          const fireplace = fireplaceSpecById.get(spec.fireplaceId!);
          if (!fireplace || !input.functional)
            throw new Error(
              `architecture: mantel ${spec.id} requires fireplace ${spec.fireplaceId} and functional floor authority`,
            );
          const openingTop =
              fireplace.center[1] + fireplace.apertureHalfExtents[1],
            mantelBottom = spec.center[1] - spec.halfExtents[1],
            mantelTop = spec.center[1] + spec.halfExtents[1],
            finishedFloorY = input.functional.site.finishedFloorY,
            lintelFront =
              fireplace.center[2] - fireplace.apertureHalfExtents[2],
            hoodFront =
              fireplace.center[2] - fireplace.apertureHalfExtents[2] * 0.72,
            mantelRear = spec.center[2] + spec.halfExtents[2];
          if (
            Math.abs(spec.center[0] - fireplace.center[0]) > 0.001 ||
            Math.abs(mantelBottom - (openingTop + 0.3)) > 0.001 ||
            mantelTop - finishedFloorY > 2.25 ||
            spec.halfExtents[0] < fireplace.apertureHalfExtents[0] + 0.3 ||
            mantelRear - lintelFront < 0.15 ||
            hoodFront - mantelRear < 0.02 - EPS ||
            Math.abs(spec.yawRadians ?? 0) > EPS
          )
            throw new Error(
              `architecture: mantel ${spec.id} violates fireplace clearance or bearing`,
            );
        }
      }
      parts.push(
        box(
          `interior-structure/${spec.id}`,
          spec.center,
          spec.halfExtents,
          [spec.id],
          spec.yawRadians,
        ),
      );
    }
    return Object.freeze({
      id: spec.id,
      kind: spec.kind,
      parts: Object.freeze(parts),
    });
  });
  const perceptualTimberFrames: CompiledPerceptualTimberFrame[] = (
    input.perceptualTimberFrames ?? []
  ).map((frame) => {
    if (!input.functional || frame.verification !== "perceptual-only")
      throw new Error(`architecture: timber frame ${frame.id} must remain perceptual-only and requires functional envelope authority`);
    if (frame.wallIds.length < 1 || frame.wallIds.length > 4 || new Set(frame.wallIds).size !== frame.wallIds.length)
      throw new Error(`architecture: timber frame ${frame.id} requires 1..4 unique exterior wall ids`);
    if (frame.baySpacing < .8 || frame.baySpacing > 2.4 || frame.memberWidth < .1 || frame.memberWidth > .3
      || frame.memberDepth < .06 || frame.memberDepth > .24 || frame.apertureClearance < .02 || frame.apertureClearance > .12)
      throw new Error(`architecture: timber frame ${frame.id} has unsafe visual-expression dimensions`);
    const volumeWallIds = new Set(volumes.flatMap((volume) => volume.wallIds));
    const ownedWalls = frame.wallIds.map((id) => {
      const wall = wallById.get(id);
      if (!wall || !volumeWallIds.has(id) || facade(wallBasis(wall)) !== frame.facade)
        throw new Error(`architecture: timber frame ${frame.id} references non-exterior or wrong-facade wall ${id}`);
      return wall;
    }).sort((a, b) => a.bottomY - b.bottomY || a.id.localeCompare(b.id));
    for (let index = 1; index < ownedWalls.length; index++) {
      const previous = ownedWalls[index - 1], current = ownedWalls[index], a = wallBasis(previous), b = wallBasis(current);
      if (Math.abs(previous.topY - current.bottomY) > .001 || Math.abs(a.length - b.length) > .001
        || Math.abs(a.mx - b.mx) > .001 || Math.abs(a.mz - b.mz) > .001)
        throw new Error(`architecture: timber frame ${frame.id} walls do not form one continuous facade stack`);
    }
    const gable = frame.roofSystemId
      ? gableClosures.find((item) => item.id === `gable/${frame.roofSystemId}/${frame.facade}`)
      : undefined;
    const facadeHasGable = gableClosures.some((item) => item.id.endsWith(`/${frame.facade}`));
    if (Boolean(frame.roofSystemId) !== facadeHasGable || (frame.roofSystemId && !gable))
      throw new Error(`architecture: timber frame ${frame.id} must reference exactly the compiler-owned gable on ${frame.facade}`);

    const parts: LinearMember[] = [], partIds = new Set<string>();
    const add = (suffix: string, from: V3, to: V3, lodLevels: readonly (0 | 1 | 2)[]) => {
      const id = `perceptual-timber-frame/${frame.id}/${suffix}`;
      if (partIds.has(id) || Math.hypot(to[0]-from[0], to[1]-from[1], to[2]-from[2]) <= frame.memberWidth * 1.1)
        throw new Error(`architecture: timber frame ${frame.id} emitted duplicate or disconnected-short member ${id}`);
      partIds.add(id);
      parts.push(Object.freeze({ kind: "linear-member", id, from: Object.freeze([...from]) as V3, to: Object.freeze([...to]) as V3,
        width: frame.memberWidth, depth: frame.memberDepth, materialRole: "timber-frame-exterior", lodLevels: Object.freeze([...lodLevels]),
        derivedFrom: Object.freeze([frame.id, ...frame.wallIds, ...(frame.roofSystemId ? [frame.roofSystemId] : []), "perceptual-only"]) }));
    };
    const subtract = (range: readonly [number, number], cuts: readonly (readonly [number, number])[]) => {
      let result: [number, number][] = [[range[0], range[1]]];
      for (const cut of [...cuts].sort((a,b)=>a[0]-b[0])) result = result.flatMap(([lo, hi]) =>
        cut[1] <= lo + EPS || cut[0] >= hi - EPS ? [[lo, hi]] : [[lo, Math.max(lo, cut[0])], [Math.min(hi, cut[1]), hi]].filter(([a,b])=>b-a>frame.memberWidth*1.1) as [number,number][]);
      return result;
    };
    for (const wall of ownedWalls) {
      const basis = wallBasis(wall), outward = wall.thickness / 2 + frame.memberDepth / 2 - .015,
        alongMin = -basis.length / 2 + frame.memberWidth / 2, alongMax = basis.length / 2 - frame.memberWidth / 2,
        openings = wall.openings ?? [], wallKey = wall.id.replaceAll("/", "_");
      const point = (along: number, y: number): V3 => at(basis, along, y, outward);
      const horizontal = (name: string, y: number, levels: readonly (0|1|2)[]) => {
        const cuts = openings.filter((opening) => y + frame.memberWidth / 2 > opening.sillY - frame.apertureClearance + EPS
          && y - frame.memberWidth / 2 < opening.sillY + opening.height + frame.apertureClearance - EPS)
          .map((opening) => [opening.offset-opening.width/2-frame.apertureClearance-frame.memberWidth/2,
            opening.offset+opening.width/2+frame.apertureClearance+frame.memberWidth/2] as const);
        for (const [index, [lo, hi]] of subtract([alongMin, alongMax], cuts).entries())
          add(`${wallKey}/${name}-${index}`, point(lo,y), point(hi,y), levels);
      };
      horizontal("sill", wall.bottomY + frame.memberWidth / 2, [0,1,2]);
      horizontal("belt", (wall.bottomY + wall.topY) / 2, [0,1]);
      horizontal("plate", wall.topY - frame.memberWidth / 2, [0,1,2]);
      const bayCount = Math.max(1, Math.ceil((alongMax-alongMin)/frame.baySpacing)), bayPositions = Array.from({length:bayCount+1},(_,index)=>alongMin+(alongMax-alongMin)*index/bayCount);
      for (const [index, along] of bayPositions.entries()) {
        if (openings.some((opening)=>Math.abs(along-opening.offset)<opening.width/2+frame.apertureClearance+frame.memberWidth)) continue;
        add(`${wallKey}/post-${index}`, point(along,wall.bottomY+frame.memberWidth/2), point(along,wall.topY-frame.memberWidth/2),
          index===0||index===bayPositions.length-1 ? [0,1,2] : [0,1]);
      }
      for (const opening of openings) {
        const left=opening.offset-opening.width/2-frame.apertureClearance-frame.memberWidth/2,
          right=opening.offset+opening.width/2+frame.apertureClearance+frame.memberWidth/2,
          lintelY=opening.sillY+opening.height+frame.apertureClearance+frame.memberWidth/2,
          baseY=wall.bottomY+frame.memberWidth/2, topY=Math.min(wall.topY-frame.memberWidth/2,lintelY);
        add(`${wallKey}/${opening.id.replaceAll("/","_")}/jamb-left`,point(left,baseY),point(left,topY),[0,1]);
        add(`${wallKey}/${opening.id.replaceAll("/","_")}/jamb-right`,point(right,baseY),point(right,topY),[0,1]);
        add(`${wallKey}/${opening.id.replaceAll("/","_")}/lintel`,point(left,lintelY),point(right,lintelY),[0,1]);
        if(opening.kind==="window"){
          const sillY=opening.sillY-frame.apertureClearance-frame.memberWidth/2;
          add(`${wallKey}/${opening.id.replaceAll("/","_")}/aperture-sill`,point(left,sillY),point(right,sillY),[0,1]);
        }
      }
      for (let index=0;index<bayPositions.length-1;index++) {
        const lo=bayPositions[index],hi=bayPositions[index+1];
        if(openings.some((opening)=>opening.offset+opening.width/2+frame.apertureClearance+frame.memberWidth>lo
          && opening.offset-opening.width/2-frame.apertureClearance-frame.memberWidth<hi))continue;
        const low=wall.bottomY+frame.memberWidth, high=(wall.bottomY+wall.topY)/2-frame.memberWidth;
        add(`${wallKey}/brace-${index}`,point(index%2?hi:lo,low),point(index%2?lo:hi,high),[0,1]);
      }
      for(const part of parts.filter((candidate)=>candidate.id.includes(`/${wallKey}/`))){
        const local=(value:V3)=>(value[0]-basis.mx)*basis.tx+(value[2]-basis.mz)*basis.tz,
          lo=Math.min(local(part.from),local(part.to))-frame.memberWidth/2,
          hi=Math.max(local(part.from),local(part.to))+frame.memberWidth/2,
          low=Math.min(part.from[1],part.to[1])-frame.memberWidth/2,
          high=Math.max(part.from[1],part.to[1])+frame.memberWidth/2;
        for(const opening of openings)if(lo<opening.offset+opening.width/2+frame.apertureClearance-EPS
          && hi>opening.offset-opening.width/2-frame.apertureClearance+EPS
          && low<opening.sillY+opening.height+frame.apertureClearance-EPS
          && high>opening.sillY-frame.apertureClearance+EPS)
          throw new Error(`architecture: timber frame member ${part.id} intrudes into clear aperture ${opening.id}`);
      }
    }
    if (gable) {
      const boundary = gable.boundary as readonly V3[], baseA=boundary[0],baseB=boundary[1],apex=boundary[2],
        normal = frame.facade==="west"?[-1,0,0] as V3:frame.facade==="east"?[1,0,0] as V3:frame.facade==="south"?[0,0,-1] as V3:[0,0,1] as V3,
        offset=ownedWalls[ownedWalls.length-1].thickness/2+frame.memberDepth/2-.015, shift=(p:V3):V3=>[p[0]+normal[0]*offset,p[1],p[2]+normal[2]*offset],
        inset=(from:V3,to:V3,distance:number):V3=>{const length=Math.hypot(to[0]-from[0],to[1]-from[1],to[2]-from[2]),t=distance/length;return [from[0]+(to[0]-from[0])*t,from[1]+(to[1]-from[1])*t,from[2]+(to[2]-from[2])*t];},
        center:[number,number,number]=[(baseA[0]+baseB[0])/2,baseA[1],(baseA[2]+baseB[2])/2], clearance=Math.max(.04,frame.memberWidth/2);
      add(`gable/rake-a`,shift(inset(baseA,apex,clearance)),shift(inset(apex,baseA,clearance)),[0,1,2]);
      add(`gable/rake-b`,shift(inset(baseB,apex,clearance)),shift(inset(apex,baseB,clearance)),[0,1,2]);
      add(`gable/king-post`,shift([center[0],center[1]+frame.memberWidth/2,center[2]]),shift([apex[0],apex[1]-clearance,apex[2]]),[0,1,2]);
      const collarY=baseA[1]+(apex[1]-baseA[1])*.48, ratio=(collarY-baseA[1])/(apex[1]-baseA[1]),
        left:[number,number,number]=[baseA[0]+(apex[0]-baseA[0])*ratio,collarY,baseA[2]+(apex[2]-baseA[2])*ratio],
        right:[number,number,number]=[baseB[0]+(apex[0]-baseB[0])*ratio,collarY,baseB[2]+(apex[2]-baseB[2])*ratio];
      add(`gable/collar`,shift(inset(left,right,clearance)),shift(inset(right,left,clearance)),[0,1]);
    }
    if (!parts.length || !parts.some((part)=>part.lodLevels?.includes(2)))
      throw new Error(`architecture: timber frame ${frame.id} lacks persistent perceptual expression`);
    const pointSegmentDistance=(point:V3,a:V3,b:V3)=>{const ab=sub3(b,a),denominator=dot3(ab,ab),t=denominator<=EPS?0:Math.max(0,Math.min(1,dot3(sub3(point,a),ab)/denominator)),closest=add3(a,scale3(ab,t));return Math.hypot(...sub3(point,closest));},
      touches=(a:LinearMember,b:LinearMember)=>Math.min(pointSegmentDistance(a.from,b.from,b.to),pointSegmentDistance(a.to,b.from,b.to),pointSegmentDistance(b.from,a.from,a.to),pointSegmentDistance(b.to,a.from,a.to))<=a.width/2+b.width/2+.004;
    const connected=new Set<number>([0]),queue=[0];
    while(queue.length){const index=queue.shift()!;for(let other=0;other<parts.length;other++)if(!connected.has(other)&&touches(parts[index],parts[other])){connected.add(other);queue.push(other);}}
    if(connected.size!==parts.length)throw new Error(`architecture: timber frame ${frame.id} contains disconnected visual members (${connected.size}/${parts.length})`);
    return Object.freeze({id:frame.id,verification:frame.verification,facade:frame.facade,wallIds:Object.freeze([...frame.wallIds]),
      ...(frame.roofSystemId?{roofSystemId:frame.roofSystemId}:{}),parts:Object.freeze(parts)});
  });
  const supportStructureById = new Map(
    interiorStructure.map((structure) => [structure.id, structure]),
  );
  const domesticProps: CompiledDomesticProp[] = (input.domesticProps ?? []).map(
    (spec) => {
      v3(spec.center, `${spec.id}.center`);
      if (
        !Number.isFinite(spec.supportY) ||
        Math.abs(spec.center[1] - spec.supportY) > 0.001
      )
        throw new Error(
          `architecture: domestic prop ${spec.id} must anchor at its support`,
        );
      if (spec.supportStructureId) {
        const support = supportStructureById.get(spec.supportStructureId),
          supportBox = support?.parts.length === 1 && support.parts[0].kind === "box"
            ? support.parts[0]
            : undefined;
        if (
          !supportBox ||
          Math.abs(
            spec.supportY -
              (supportBox.center[1] + supportBox.halfExtents[1]),
          ) > 0.001 ||
          Math.abs(spec.center[0] - supportBox.center[0]) >
            supportBox.halfExtents[0] ||
          Math.abs(spec.center[2] - supportBox.center[2]) >
            supportBox.halfExtents[2]
        )
          throw new Error(
            `architecture: domestic prop ${spec.id} is not supported by ${spec.supportStructureId}`,
          );
      }
      const yaw = spec.yawRadians ?? 0,
        c = Math.cos(yaw),
        s = Math.sin(yaw),
        atLocal = (x: number, y: number, z: number): V3 => [
          spec.center[0] + x * c + z * s,
          spec.center[1] + y,
          spec.center[2] - x * s + z * c,
        ],
        boxPart = (name: string, local: V3, half: V3) =>
          box(
            `domestic-prop/${spec.id}/${name}`,
            atLocal(...local),
            half,
            [spec.id],
            yaw,
          ),
        parts: ArchitecturePrimitive[] = [];
      if (spec.kind === "bowl")
        parts.push(
          lathedProfile(
            `domestic-prop/${spec.id}/ceramic-bowl`, atLocal(0, 0, 0),
            [[0.06,0],[0.10,0.018],[0.135,0.065],[0.145,0.09],[0.13,0.105],[0.105,0.09],[0.05,0.025]], 24, [spec.id],
          ),
          cylinder(
            `domestic-prop/${spec.id}/ceramic-dark-interior`,
            atLocal(0, 0.091, 0),
            atLocal(0, 0.098, 0),
            0.105,
            24,
            [spec.id],
          ),
        );
      else if (spec.kind === "mug") {
        parts.push(
          lathedProfile(`domestic-prop/${spec.id}/ceramic-cup`,atLocal(0,0,0),[[0.055,0],[0.07,.015],[0.072,.15],[0.078,.17],[0.06,.18],[0,.18]],24,[spec.id]),
          cylinder(`domestic-prop/${spec.id}/ceramic-handle-upper`,atLocal(.058,.145,0),atLocal(.14,.145,0),.018,12,[spec.id]),
          cylinder(`domestic-prop/${spec.id}/ceramic-handle-outer`,atLocal(.14,.055,0),atLocal(.14,.145,0),.018,12,[spec.id]),
          cylinder(`domestic-prop/${spec.id}/ceramic-handle-lower`,atLocal(.058,.055,0),atLocal(.14,.055,0),.018,12,[spec.id]),
        );
      } else if (spec.kind === "jug") {
        parts.push(
          lathedProfile(`domestic-prop/${spec.id}/ceramic-body`,atLocal(0,0,0),[[.055,0],[.10,.025],[.13,.10],[.125,.22],[.08,.28],[.055,.30],[.055,.36],[.07,.375],[.045,.39],[0,.39]],28,[spec.id]),
          cylinder(`domestic-prop/${spec.id}/ceramic-handle-upper`,atLocal(.05,.31,0),atLocal(.18,.31,0),.02,12,[spec.id]),
          cylinder(`domestic-prop/${spec.id}/ceramic-handle-outer`,atLocal(.18,.14,0),atLocal(.18,.31,0),.02,12,[spec.id]),
          cylinder(`domestic-prop/${spec.id}/ceramic-handle-lower`,atLocal(.09,.14,0),atLocal(.18,.14,0),.02,12,[spec.id]),
        );
      } else if (spec.kind === "candle") {
        parts.push(
          cylinder(
            `domestic-prop/${spec.id}/wax-body`,
            atLocal(0, 0.01, 0),
            atLocal(0, 0.26, 0),
            0.035,
            12,
            [spec.id],
          ),
          taperedFlame(
            `domestic-prop/${spec.id}/candle-flame`,
            atLocal(0, 0.27, 0),
            0.1,
            0.028,
            [0.008, 0, 0],
            10,
            [spec.id],
          ),
        );
      } else if (spec.kind === "folded-textile") {
        parts.push(
          boxPart("textile-fold-0", [0, 0.04, 0], [0.24, 0.04, 0.18]),
          boxPart("textile-fold-1", [0.025, 0.11, -0.015], [0.2, 0.035, 0.16]),
        );
      } else if (spec.kind === "fire-tool") {
        parts.push(
          Object.freeze({
            kind: "linear-member",
            id: `domestic-prop/${spec.id}/iron-shaft`,
            from: Object.freeze(atLocal(-0.04, 0.02, 0)),
            to: Object.freeze(atLocal(0.08, 0.92, 0.02)),
            width: 0.025,
            depth: 0.025,
            derivedFrom: Object.freeze([spec.id]),
          }),
          boxPart("iron-grip", [0.09, 0.92, 0.02], [0.06, 0.025, 0.025]),
        );
      } else
        parts.push(
          cylinder(
            `domestic-prop/${spec.id}/log`,
            atLocal(-0.32, 0.09, 0),
            atLocal(0.32, 0.09, 0),
            0.08,
            10,
            [spec.id],
          ),
        );
      const bottoms = parts.map((part) =>
        part.kind === "box"
          ? part.center[1] - part.halfExtents[1]
          : part.kind === "oriented-cylinder"
            ? (() => {
                const dx = part.to[0] - part.from[0],
                  dy = part.to[1] - part.from[1],
                  dz = part.to[2] - part.from[2],
                  length = Math.hypot(dx, dy, dz),
                  radialY = Math.sqrt(Math.max(0, 1 - (dy / length) ** 2));
                return Math.min(part.from[1], part.to[1]) - part.radius * radialY;
              })()
            : part.kind === "linear-member"
              ? Math.min(part.from[1], part.to[1]) -
                Math.max(part.width, part.depth) / 2
              : part.kind === "tapered-flame"
                ? part.baseCenter[1]
                : spec.supportY,
      );
      if (Math.min(...bottoms) < spec.supportY - 0.085)
        throw new Error(
          `architecture: domestic prop ${spec.id} penetrates its support`,
        );
      return Object.freeze({
        id: spec.id,
        kind: spec.kind,
        parts: Object.freeze(parts),
        supportY: spec.supportY,
      });
    },
  );
  const seamMembers: ArchitecturePrimitive[] = roofSeams.map((seam) =>
    Object.freeze({
      kind: "linear-member" as const,
      id: `roof-seam/${seam.id}`,
      from: Object.freeze([...seam.from]) as V3,
      to: Object.freeze([...seam.to]) as V3,
      width: seam.flashingWidth ?? 0.24,
      depth: seam.kind === "valley" ? 0.035 : 0.1,
      derivedFrom: Object.freeze([seam.id, ...seam.planeIds]),
    }),
  );
  const ridgeCaps: ArchitecturePrimitive[] = roofSeams
    .filter((seam) => seam.kind === "ridge")
    .flatMap((seam) => {
      const delta = sub3(seam.to, seam.from),
        length = Math.hypot(...delta),
        count = Math.max(1, Math.ceil(length / 0.58));
      return Array.from({ length: count }, (_, index) => {
        const from = add3(
            add3(seam.from, scale3(delta, index / count)),
            [0, 0.075, 0],
          ),
          to = add3(
            add3(seam.from, scale3(delta, (index + 1) / count)),
            [0, 0.075, 0],
          );
        return Object.freeze({
          kind: "linear-member" as const,
          id: `roof/ridge-cap/${seam.id}/${index}`,
          from: Object.freeze(from),
          to: Object.freeze(to),
          width: 0.25,
          depth: 0.13,
          derivedFrom: Object.freeze([seam.id, ...seam.planeIds]),
        });
      });
    });
  const interiorPartitionIds = new Set(interiorPartitionSpecs.map(({ id }) => id));
  const interiorShell: ArchitecturePrimitive[] = walls.flatMap((wall) => {
    const source = wallById.get(wall.id);
    if (!source) return [];
    const b = wallBasis(source),
      offset = source.thickness / 2 + 0.05;
    const sides = interiorPartitionIds.has(wall.id) ? [-1, 1] as const : [-1] as const;
    return wall.segments.flatMap((segment) => sides.map((side) =>
      Object.freeze({
        ...segment,
        id: `wall-interior/${segment.id.slice("wall/".length)}${sides.length === 2 ? `/side-${side < 0 ? "a" : "b"}` : ""}`,
        center: Object.freeze([
          segment.center[0] + b.tz * offset * side,
          segment.center[1],
          segment.center[2] - b.tx * offset * side,
        ]) as V3,
        halfExtents: Object.freeze([
          segment.halfExtents[0],
          segment.halfExtents[1],
          0.05,
        ]) as V3,
        derivedFrom: Object.freeze([...segment.derivedFrom, wall.id]),
      }),
    ));
  });
  const functionalStairPrimitives: SolidBox[] = input.functional && "schema" in input.functional
    ? input.functional.stairs.flatMap((stair) => {
        const fromIsLow = stair.from[1] <= stair.to[1],
          low = fromIsLow ? stair.from : stair.to,
          high = fromIsLow ? stair.to : stair.from,
          dx = high[0] - low[0], dz = high[2] - low[2], run = Math.hypot(dx, dz);
        if (!Number.isFinite(run) || run <= EPS || !Number.isSafeInteger(stair.riserCount) || stair.riserCount < 2)
          throw new Error(`architecture: invalid stair geometry ${stair.id}`);
        const ux = dx / run, uz = dz / run, yaw = Math.atan2(uz, ux),
          riser = (high[1] - low[1]) / stair.riserCount,
          treads = Array.from({ length: stair.riserCount }, (_, index) => {
            const topY = low[1] + riser * (index + 1), depth = stair.treadDepth;
            return box(`stairs/${stair.id}/tread-${index}`,
              [low[0] + ux * depth * (index + .5), topY - .04, low[2] + uz * depth * (index + .5)],
              [depth / 2, .04, stair.clearWidth / 2], [stair.id], yaw);
          }),
          bottom = box(`stairs/${stair.id}/landing-bottom`,
            [low[0] - ux * stair.bottomLandingDepth / 2, low[1] - .05, low[2] - uz * stair.bottomLandingDepth / 2],
            [stair.bottomLandingDepth / 2, .05, stair.clearWidth / 2], [stair.id], yaw),
          top = box(`stairs/${stair.id}/landing-top`,
            [high[0] + ux * stair.topLandingDepth / 2, high[1] - .05, high[2] + uz * stair.topLandingDepth / 2],
            [stair.topLandingDepth / 2, .05, stair.clearWidth / 2], [stair.id], yaw);
        return [bottom, ...treads, top];
      })
    : [];
  const functionalStairDetailPrimitives: ArchitecturePrimitive[] = input.functional && "schema" in input.functional
    ? input.functional.stairs.flatMap((stair) => {
        const low=stair.from[1]<=stair.to[1]?stair.from:stair.to,high=stair.from[1]<=stair.to[1]?stair.to:stair.from,dx=high[0]-low[0],dz=high[2]-low[2],run=Math.hypot(dx,dz),ux=dx/run,uz=dz/run,yaw=Math.atan2(uz,ux),riser=stair.rise/stair.riserCount;
        const risers=Array.from({length:stair.riserCount},(_,index)=>box(`stair-detail/${stair.id}/riser-${index}`,[low[0]+ux*stair.treadDepth*(index+1),low[1]+riser*(index+.5),low[2]+uz*stair.treadDepth*(index+1)],[.025,riser/2,stair.clearWidth/2],[stair.id],yaw));
        const side=(sign:number)=>{const px=-uz*sign*stair.clearWidth*.58,pz=ux*sign*stair.clearWidth*.58,suffix=sign<0?"left":"right";return [
          Object.freeze({kind:"linear-member" as const,id:`stair-detail/${stair.id}/stringer-${suffix}`,from:Object.freeze([low[0]+px,low[1]+.04,low[2]+pz]) as V3,to:Object.freeze([high[0]+px,high[1]+.04,high[2]+pz]) as V3,width:.14,depth:.18,derivedFrom:Object.freeze([stair.id])}),
          Object.freeze({kind:"linear-member" as const,id:`stair-detail/${stair.id}/handrail-${suffix}`,from:Object.freeze([low[0]+px,low[1]+.92,low[2]+pz]) as V3,to:Object.freeze([high[0]+px,high[1]+.92,high[2]+pz]) as V3,width:.1,depth:.1,derivedFrom:Object.freeze([stair.id])}),
          ...Array.from({length:7},(_,index)=>{const t=index/6,x=low[0]+(high[0]-low[0])*t+px,y=low[1]+(high[1]-low[1])*t,z=low[2]+(high[2]-low[2])*t+pz;return Object.freeze({kind:"linear-member" as const,id:`stair-detail/${stair.id}/baluster-${suffix}-${index}`,from:Object.freeze([x,y+.06,z]) as V3,to:Object.freeze([x,y+.9,z]) as V3,width:.075,depth:.075,derivedFrom:Object.freeze([stair.id])});}),
        ];};
        return [...risers,...side(-1),...side(1)];
      }) : [];
  const functionalFloorFragments = new Map<string, PolygonSlab[]>(),functionalCeilingFragments=new Map<string,PolygonSlab[]>();
  if (input.functional && "schema" in input.functional) {
    const rooms = new Map(input.functional.rooms.map((room) => [room.id, room]));
    const partition=(volume:typeof volumeSpecs[number],openings:{id:string;center:V2;halfExtents:V2}[],kind:"floor"|"ceiling")=>{
      if (openings.length === 0) return [];
      const xs = volume.footprint.map((point) => point[0]), zs = volume.footprint.map((point) => point[1]),
        x0 = Math.min(...xs), x1 = Math.max(...xs), z0 = Math.min(...zs), z1 = Math.max(...zs),
        corners = new Set([`${x0}/${z0}`, `${x1}/${z0}`, `${x1}/${z1}`, `${x0}/${z1}`]);
      if (volume.footprint.length !== 4 || volume.footprint.some((point) => !corners.has(`${point[0]}/${point[1]}`)))
        throw new Error(`architecture: stair floor openings require rectangular destination volume ${volume.id}`);
      type Rect = { x0: number; x1: number; z0: number; z1: number };
      let rectangles: Rect[] = [{ x0, x1, z0, z1 }];
      for (const opening of openings) {
        const hole: Rect = { x0: opening.center[0] - opening.halfExtents[0], x1: opening.center[0] + opening.halfExtents[0],
          z0: opening.center[1] - opening.halfExtents[1], z1: opening.center[1] + opening.halfExtents[1] };
        const next: Rect[] = [];
        for (const rectangle of rectangles) {
          const ix0 = Math.max(rectangle.x0, hole.x0), ix1 = Math.min(rectangle.x1, hole.x1),
            iz0 = Math.max(rectangle.z0, hole.z0), iz1 = Math.min(rectangle.z1, hole.z1);
          if (ix1 <= ix0 + EPS || iz1 <= iz0 + EPS) { next.push(rectangle); continue; }
          if (rectangle.x0 < ix0 - EPS) next.push({ x0: rectangle.x0, x1: ix0, z0: rectangle.z0, z1: rectangle.z1 });
          if (ix1 < rectangle.x1 - EPS) next.push({ x0: ix1, x1: rectangle.x1, z0: rectangle.z0, z1: rectangle.z1 });
          if (rectangle.z0 < iz0 - EPS) next.push({ x0: ix0, x1: ix1, z0: rectangle.z0, z1: iz0 });
          if (iz1 < rectangle.z1 - EPS) next.push({ x0: ix0, x1: ix1, z0: iz1, z1: rectangle.z1 });
        }
        rectangles = next;
      }
      const bottom=kind==="floor"?volume.floorY-volume.floorThickness:volume.eaveY-volume.ceilingThickness,top=kind==="floor"?volume.floorY:volume.eaveY;
      return rectangles.map((rectangle, index) => polygonSlab(
        `volume/${volume.id}/${kind}-fragment-${index}`,
        [[rectangle.x0, rectangle.z0], [rectangle.x1, rectangle.z0], [rectangle.x1, rectangle.z1], [rectangle.x0, rectangle.z1]],
        bottom,top,[volume.id,...openings.map((opening)=>opening.id)]));
    };
    for (const volume of volumeSpecs) {
      const openings = input.functional.stairs.filter((stair) => rooms.get(stair.toRoomId)?.volumeId === volume.id).map((stair) => ({ id: stair.id, ...stair.upperFloorOpening }));
      if(openings.length)functionalFloorFragments.set(volume.id,partition(volume,openings,"floor"));
      const ceilingOpenings=input.functional.stairs.filter(stair=>{const destination=volumeSpecs.find(v=>v.id===rooms.get(stair.toRoomId)?.volumeId), supportIds=destination?.supportVolumeIds??(destination?.supportVolumeId?[destination.supportVolumeId]:[]);return supportIds.includes(volume.id);}).map(stair=>({id:stair.id,...stair.upperFloorOpening}));
      if(ceilingOpenings.length)functionalCeilingFragments.set(volume.id,partition(volume,ceilingOpenings,"ceiling"));
    }
  }
  const unboundPrimitives: ArchitecturePrimitive[] = [
    ...foundations,
    ...volumes.flatMap((v) => [...(functionalFloorFragments.get(v.id) ?? [v.floor]),...(functionalCeilingFragments.get(v.id)??[v.ceiling])]),
    ...walls.flatMap((w) => w.segments),
    ...interiorShell,
    ...gableClosures,
    ...planes,
    ...weatherPlanes,
    ...dormerPrimitives,
    ...penetrationPrimitives,
    ...seamMembers,
    ...roofWallAbutmentMembers,
    ...ridgeCaps,
    ...eaveTrim,
    ...windows.flatMap((w) => [
      w.glazing,
      ...w.reveals,
      ...w.frame,
      ...w.mullions,
      ...w.came,
    ]),
    ...doors.flatMap((d) => [...d.frame, ...d.reveals]),
    ...entrances.flatMap((e) => [
      e.threshold,
      e.landing,
      ...e.steps,
      ...e.finishCourses,
    ]),
    ...functionalStairPrimitives,
    ...functionalStairDetailPrimitives,
    ...fireplaces.flatMap((f) => [
      f.base,
      f.cavity,
      ...f.surround,
      ...f.fuel,
      f.emberBed,
      ...f.flames,
      ...(f.chimney ? [f.chimney] : []),
    ]),
    ...furnishings.flatMap((f) => f.parts),
    ...interiorStructure.flatMap((item) => item.parts),
    ...perceptualTimberFrames.flatMap((item) => item.parts),
    ...domesticProps.flatMap((item) => item.parts),
  ];
  const materialRole = (id: string) =>
    id.includes("/glass")
      ? "glazing"
      : id.includes("/came-")
        ? "door-hardware"
        : id.startsWith("wall-interior/") || id.includes("/ceiling")
          ? "wall-interior"
          : id.startsWith("foundation/") ||
              id.startsWith("entrance/") ||
              id.startsWith("entry/")
            ? "foundation"
            : id.startsWith("interior-structure/")
              ? "structure-trim"
              : id.startsWith("perceptual-timber-frame/")
                ? "timber-frame-exterior"
              : id.startsWith("furnishing/") && /hinge|knob|strap|hasp/.test(id)
                ? "door-hardware"
                : id.startsWith("furnishing/")
                  ? "furniture-wood"
                  : id.startsWith("domestic-prop/") && id.includes("ceramic-dark-")
                    ? "domestic-ceramic-dark"
                    : id.startsWith("domestic-prop/") && id.includes("ceramic-")
                      ? "domestic-ceramic"
                    : id.startsWith("domestic-prop/") && id.includes("textile-")
                      ? "textile-wool"
                      : id.startsWith("domestic-prop/") && id.includes("wax-")
                        ? "wax"
                        : id.startsWith("domestic-prop/") &&
                            id.includes("candle-flame")
                          ? "flame-inner"
                          : id.startsWith("domestic-prop/") &&
                              id.includes("iron-")
                            ? "door-hardware"
                            : id.startsWith("domestic-prop/")
                              ? "structure-trim"
                              : id.includes("/reveal-")
                                ? "mortar-reveal"
                                : id.includes("flashing") ||
                                    id.includes("/curb-")
                                  ? "roof-flashing"
                                : id.startsWith("roof/") ||
                                    id.startsWith("roof-weather/") ||
                                    id.startsWith("roof-seam/") ||
                                    id.includes("/roof-") ||
                                    id.includes("/cricket-")
                                  ? "roof"
                                  : id.includes("chimney/") ||
                                      (id.startsWith("fireplace/") &&
                                        /jamb|lintel|hood|chimney|base|fireback|lining|throat|smoke-/.test(
                                          id,
                                        ))
                                    ? "hearth-masonry"
                                    : id.includes("/cavity")
                                      ? "hearth-soot"
                                      : id.includes("/embers")
                                        ? "hearth-embers"
                                        : id.includes("/flame-outer")
                                          ? "flame-outer"
                                          : id.includes("/flame-inner")
                                            ? "flame-inner"
                                            : id.includes("/floor")
                                              ? "floor-furnishing"
                                              : id.startsWith("stairs/")
                                                ? "floor-furnishing"
                                              : id.includes("/frame-") ||
                                                  id.includes("/mullion") ||
                                                  id.includes("/log-")
                                                ? "structure-trim"
                                                : id.startsWith("wall/") ||
                                                    id.startsWith("gable/") ||
                                                    id.includes("/cheek-") ||
                                                    id.includes("/gable-")
                                                  ? "wall-exterior"
                                                  : "structure-trim";
  const roofUvFrame = (primitive: ArchitecturePrimitive) => {
    if (primitive.kind === "plane-slab") {
      const host = roofPlaneSpecs.find(
          (plane) =>
            primitive.id === `roof/${plane.id}` ||
            primitive.id.startsWith(`roof/${plane.id}/fragment-`) ||
            primitive.id === `roof-weather/${plane.id}` ||
            primitive.id.startsWith(`roof-weather/${plane.id}/fragment-`),
        ),
        normal = unit3(host?.normal ?? primitive.normal),
        anchor = host?.origin ?? primitive.boundary[0];
      let ridge = unit3(cross3([0, 1, 0], normal));
      let slope = unit3(cross3(normal, ridge));
      if (slope[1] > 0) {
        ridge = scale3(ridge, -1);
        slope = scale3(slope, -1);
      }
      return Object.freeze({
        anchor: Object.freeze([...anchor]) as V3,
        ridge: Object.freeze(ridge),
        slope: Object.freeze(slope),
        metresPerRepeat: 2.2,
      });
    }
    if (primitive.kind === "linear-member") {
      const ridge = unit3(sub3(primitive.to, primitive.from)),
        down: V3 = [0, -1, 0],
        projection = sub3(down, scale3(ridge, dot3(down, ridge))),
        slope = unit3(
          Math.hypot(...projection) > EPS
            ? projection
            : cross3(ridge, [1, 0, 0]),
        );
      return Object.freeze({
        anchor: Object.freeze([...primitive.from]) as V3,
        ridge: Object.freeze(ridge),
        slope: Object.freeze(slope),
        metresPerRepeat: 2.2,
      });
    }
    if (primitive.kind === "box") {
      const yaw = primitive.yawRadians ?? 0,
        ridge: V3 = [Math.cos(yaw), 0, Math.sin(yaw)];
      return Object.freeze({
        anchor: Object.freeze([...primitive.center]) as V3,
        ridge: Object.freeze(ridge),
        slope: Object.freeze([0, -1, 0]) as V3,
        metresPerRepeat: 2.2,
      });
    }
    throw new Error(
      `architecture: roof material ${primitive.id} lacks UV-frame geometry`,
    );
  };
  const lodLevels = (id: string): readonly (0 | 1 | 2)[] =>
    id.startsWith("wall-interior/") ||
    id.startsWith("fireplace/") ||
    id.startsWith("furnishing/") ||
    id.startsWith("domestic-prop/") ||
    id.includes("/came-")
      ? [0]
      : id.startsWith("interior-structure/") ||
          (id.startsWith("window/") &&
            (id.includes("/reveal-") || id.includes("/mullion")))
        ? [0, 1]
        : [0, 1, 2];
  const primitiveMap = new Map<ArchitecturePrimitive, ArchitecturePrimitive>();
  const primitives: ArchitecturePrimitive[] = unboundPrimitives.map(
    (primitive) => {
      const role = materialRole(primitive.id),
        bound = Object.freeze({
          ...primitive,
          materialRole: role,
          lodLevels: Object.freeze(primitive.lodLevels ? [...primitive.lodLevels] : lodLevels(primitive.id)),
          ...(role === "roof" ? { uvFrame: roofUvFrame(primitive) } : {}),
        }) as ArchitecturePrimitive;
      primitiveMap.set(primitive, bound);
      return bound;
    },
  );
  const compiledVolumes: CompiledVolume[] = volumes.map((volume) =>
    Object.freeze((() => {
      const fragments = functionalFloorFragments.get(volume.id);
      return {
        ...volume,
        floor: (primitiveMap.get(volume.floor) ?? volume.floor) as PolygonSlab,
        ...(fragments ? { floorFragments: Object.freeze(fragments.map((fragment) => primitiveMap.get(fragment) as PolygonSlab)) } : {}),
        ceiling: (primitiveMap.get(volume.ceiling)??volume.ceiling) as PolygonSlab,
        ...(functionalCeilingFragments.get(volume.id)?{ceilingFragments:Object.freeze(functionalCeilingFragments.get(volume.id)!.map(fragment=>primitiveMap.get(fragment) as PolygonSlab))}:{}),
      };
    })()),
  );
  const compiledPerceptualTimberFrames: CompiledPerceptualTimberFrame[] = perceptualTimberFrames.map((frame) =>
    Object.freeze({...frame,parts:Object.freeze(frame.parts.map((part)=>(primitiveMap.get(part) ?? part) as LinearMember))}));
  const functionalContract = input.functional
    ? (() => {
        const functional = input.functional;
        if ("schema" in functional) {
          if (functional.schema !== "limina.functional-architecture/v2")
            throw new Error("architecture: unsupported functional architecture schema");
          const authority = functional as FunctionalArchitectureSpecV2,
            partitionedShell = authority.layoutAuthority === "partitioned-shell",
            fail = (detail: string): never => {
              throw new Error(`architecture: invalid multi-room authority: ${detail}`);
            },
            nonempty = (value: string, label: string) => {
              if (!/^[a-z0-9][a-z0-9._/-]{0,159}$/.test(value))
                fail(`${label} must be a stable lowercase id`);
              return value;
            },
            boundedCoefficient = (value: number, label: string) => {
              finite(value, label);
              if (value < 0 || value > 1) fail(`${label} must be within [0,1]`);
            },
            contains = (
              room: FunctionalArchitectureSpecV2["rooms"][number],
              point: V3,
              tolerance = 1e-6,
            ) => point.every((axis, dimension) =>
              Math.abs(axis - room.bounds.center[dimension]) <=
                room.bounds.halfExtents[dimension] + tolerance
            ),
            unique = <T extends { id: string }>(
              values: readonly T[],
              label: string,
              minimum: number,
              maximum: number,
            ) => {
              if (values.length < minimum || values.length > maximum)
                fail(`${label} must contain ${minimum}..${maximum} entries`);
              const found = new Set<string>();
              for (const value of values) {
                nonempty(value.id, `${label}.id`);
                if (found.has(value.id)) fail(`${label} contains duplicate id ${value.id}`);
                found.add(value.id);
              }
              return found;
            };
          nonempty(authority.buildingId, "buildingId");
          if (authority.layoutAuthority !== undefined && !partitionedShell)
            fail("layoutAuthority is unsupported");
          v3(authority.entryAnchor, "functional.entryAnchor");
          v2(authority.site.footprintCenter, "functional.site.footprintCenter");
          v2(authority.site.footprintHalfExtents, "functional.site.footprintHalfExtents");
          finite(authority.site.finishedFloorY, "functional.site.finishedFloorY");
          finite(authority.site.terrainClearance, "functional.site.terrainClearance");
          finite(authority.site.vegetationClearance, "functional.site.vegetationClearance");
          finite(authority.site.maximumTerrainRelief, "functional.site.maximumTerrainRelief");
          v3(authority.clearAisle.from, "functional.clearAisle.from");
          v3(authority.clearAisle.to, "functional.clearAisle.to");
          if (
            authority.site.footprintHalfExtents.some((axis) => axis <= 0) ||
            authority.site.terrainClearance < 0.05 ||
            authority.site.terrainClearance > 1 ||
            authority.site.vegetationClearance < 0 ||
            authority.site.vegetationClearance > 5 ||
            authority.site.maximumTerrainRelief <= 0 ||
            authority.site.maximumTerrainRelief > 5 ||
            authority.clearAisle.halfWidth < 0.45 ||
            authority.clearAisle.minClearHeight < 1.8 ||
            authority.lod.lod1TriangleBudget >= authority.lod.triangleBudget ||
            authority.lod.lod2TriangleBudget >= authority.lod.lod1TriangleBudget
          ) fail("site, aisle, or LOD policy is outside bounded limits");
          const entranceSupport = authority.site.entranceSupport;
          if (entranceSupport) {
            v2(entranceSupport.center, "functional.site.entranceSupport.center");
            v2(entranceSupport.halfExtents, "functional.site.entranceSupport.halfExtents");
            const entrance = entrances[0], entranceSpec = input.entrances[0], lowestStep = entrance?.steps[0];
            if (
              entranceSpec?.constructionPolicy !== "finished-surface-authority" || !lowestStep ||
              (entranceSupport.sourcePrimitiveId !== undefined && entranceSupport.sourcePrimitiveId !== lowestStep.id) ||
              entranceSupport.halfExtents.some((axis) => axis <= 0) ||
              !Number.isFinite(entranceSupport.yawRadians) ||
              !Number.isFinite(entranceSupport.exteriorGradeY) ||
              !Number.isFinite(entranceSupport.bearingDepth) || entranceSupport.bearingDepth <= 0 || entranceSupport.bearingDepth > .5 ||
              !Number.isFinite(entranceSupport.maximumCutDepth) || entranceSupport.maximumCutDepth < 0 || entranceSupport.maximumCutDepth > .2 ||
              !Number.isFinite(entranceSupport.maximumVariation) || entranceSupport.maximumVariation <= 0 || entranceSupport.maximumVariation > .25 ||
              Math.abs(entranceSupport.center[0] - lowestStep.center[0]) > .001 ||
              Math.abs(entranceSupport.center[1] - lowestStep.center[2]) > .001 ||
              Math.abs(entranceSupport.halfExtents[0] - lowestStep.halfExtents[0]) > .001 ||
              Math.abs(entranceSupport.halfExtents[1] - lowestStep.halfExtents[2]) > .001 ||
              Math.abs(entranceSupport.yawRadians - (lowestStep.yawRadians ?? 0)) > .001 ||
              Math.abs(entranceSupport.exteriorGradeY - entrance.exteriorGradeY) > .001 ||
              Math.abs(entranceSupport.bearingDepth - (entranceSpec.bearingDepth ?? 0)) > .001
            ) fail("entrance support must match the lowest authored tread");
          }

          const roomIds = unique(authority.rooms, "rooms", 2, 32),
            roomById = new Map(authority.rooms.map((room) => [room.id, room])),
            floorsByStorey = new Map<number, number>(), roomVolumeIds = new Set<string>();
          for (const [index, room] of authority.rooms.entries()) {
            const label = `rooms[${index}]`;
            nonempty(room.volumeId, `${label}.volumeId`);
            const structuralVolume = volumeSpecs.find((volume) => volume.id === room.volumeId);
            if (!structuralVolume || (!partitionedShell && roomVolumeIds.has(room.volumeId)))
              fail(`${label}.volumeId must ${partitionedShell ? "resolve to" : "uniquely resolve to"} an authored volume`);
            if (!structuralVolume) throw new Error("architecture: unreachable room volume validation");
            roomVolumeIds.add(room.volumeId);
            v3(room.bounds.center, `${label}.bounds.center`);
            v3(room.bounds.halfExtents, `${label}.bounds.halfExtents`);
            finite(room.finishedFloorY, `${label}.finishedFloorY`);
            finite(room.ceilingY, `${label}.ceilingY`);
            if (room.bounds.halfExtents.some((axis) => axis <= 0))
              fail(`${label} bounds must be positive`);
            if (!Number.isSafeInteger(room.storey) || room.storey < 0 || room.storey > 63)
              fail(`${label}.storey must be an integer within [0,63]`);
            if (
              room.ceilingY - room.finishedFloorY < 2 ||
              Math.abs(room.bounds.center[1] - room.bounds.halfExtents[1] - room.finishedFloorY) > 1e-4 ||
              Math.abs(room.bounds.center[1] + room.bounds.halfExtents[1] - room.ceilingY) > 1e-4
            ) fail(`${label} bounds must span its floor and ceiling with 2m headroom`);
            const xs = structuralVolume.footprint.map((point) => point[0]),
              zs = structuralVolume.footprint.map((point) => point[1]),
              expectedCenter: V3 = [(Math.min(...xs) + Math.max(...xs)) / 2,
                (structuralVolume.floorY + structuralVolume.eaveY) / 2,
                (Math.min(...zs) + Math.max(...zs)) / 2],
              expectedHalf: V3 = [(Math.max(...xs) - Math.min(...xs)) / 2,
                (structuralVolume.eaveY - structuralVolume.floorY) / 2,
                (Math.max(...zs) - Math.min(...zs)) / 2];
            const exactVolumeBounds =
              room.bounds.center.every((axis, dimension) => Math.abs(axis - expectedCenter[dimension]) <= 1e-4) &&
              room.bounds.halfExtents.every((axis, dimension) => Math.abs(axis - expectedHalf[dimension]) <= 1e-4),
              insideVolumeBounds = room.bounds.center.every((axis, dimension) =>
                dimension === 1 || Math.abs(axis - expectedCenter[dimension]) + room.bounds.halfExtents[dimension] <= expectedHalf[dimension] + 1e-4);
            if (Math.abs(room.finishedFloorY - structuralVolume.floorY) > 1e-4 ||
              Math.abs(room.ceilingY - structuralVolume.eaveY) > 1e-4 ||
              (partitionedShell ? !insideVolumeBounds : !exactVolumeBounds))
              fail(`${label} must ${partitionedShell ? "fit inside" : "exactly match the floor, ceiling, and bounds of"} volume ${room.volumeId}`);
            boundedCoefficient(room.acoustics.absorption, `${label}.acoustics.absorption`);
            boundedCoefficient(room.acoustics.reverb, `${label}.acoustics.reverb`);
            nonempty(room.visibilityCellId, `${label}.visibilityCellId`);
            const floor = floorsByStorey.get(room.storey);
            if (floor !== undefined && Math.abs(floor - room.finishedFloorY) > 1e-4)
              fail(`storey ${room.storey} has inconsistent finished floors`);
            floorsByStorey.set(room.storey, room.finishedFloorY);
          }
          const roomPairKey = (ids: readonly [string, string]) => [...ids].sort().join("\u0000"),
            partitionByRoomPair = new Map<string, InteriorPartitionSpec>();
          if (partitionedShell) {
            const roomsByVolume = new Map<string, typeof authority.rooms>();
            for (const room of authority.rooms)
              roomsByVolume.set(room.volumeId, [...(roomsByVolume.get(room.volumeId) ?? []), room]);
            for (const [volumeId, rooms] of roomsByVolume) {
              const structuralVolume = volumeSpecs.find((volume) => volume.id === volumeId)!;
              const roomFootprints = rooms.map((room) => {
                const [x, , z] = room.bounds.center, [hx, , hz] = room.bounds.halfExtents;
                return [[x - hx, z - hz], [x + hx, z - hz], [x + hx, z + hz], [x - hx, z + hz]] as readonly V2[];
              });
              const targetBounds = axisAlignedBounds(structuralVolume.footprint),
                roomArea = rooms.reduce((sum, room) => sum + 4 * room.bounds.halfExtents[0] * room.bounds.halfExtents[2], 0);
              if (!targetBounds || !rectangularUnionCovers(structuralVolume.footprint, roomFootprints) ||
                Math.abs(roomArea - (targetBounds.x1 - targetBounds.x0) * (targetBounds.z1 - targetBounds.z0)) > 1e-4)
                fail(`rooms mapped to ${volumeId} must form a non-overlapping exact rectangular partition`);
            }
            const sharedBoundary = (a: (typeof authority.rooms)[number], b: (typeof authority.rooms)[number]): readonly [V2, V2] | undefined => {
              if (a.volumeId !== b.volumeId || a.storey !== b.storey) return;
              const ax0 = a.bounds.center[0] - a.bounds.halfExtents[0], ax1 = a.bounds.center[0] + a.bounds.halfExtents[0],
                az0 = a.bounds.center[2] - a.bounds.halfExtents[2], az1 = a.bounds.center[2] + a.bounds.halfExtents[2],
                bx0 = b.bounds.center[0] - b.bounds.halfExtents[0], bx1 = b.bounds.center[0] + b.bounds.halfExtents[0],
                bz0 = b.bounds.center[2] - b.bounds.halfExtents[2], bz1 = b.bounds.center[2] + b.bounds.halfExtents[2];
              if (Math.abs(ax1 - bx0) <= 1e-4 || Math.abs(bx1 - ax0) <= 1e-4) {
                const x = Math.abs(ax1 - bx0) <= 1e-4 ? (ax1 + bx0) / 2 : (bx1 + ax0) / 2,
                  z0 = Math.max(az0, bz0), z1 = Math.min(az1, bz1);
                if (z1 - z0 > 1e-4) return [[x, z0], [x, z1]];
              }
              if (Math.abs(az1 - bz0) <= 1e-4 || Math.abs(bz1 - az0) <= 1e-4) {
                const z = Math.abs(az1 - bz0) <= 1e-4 ? (az1 + bz0) / 2 : (bz1 + az0) / 2,
                  x0 = Math.max(ax0, bx0), x1 = Math.min(ax1, bx1);
                if (x1 - x0 > 1e-4) return [[x0, z], [x1, z]];
              }
            };
            const expected = new Map<string, { rooms: readonly [string, string]; boundary: readonly [V2, V2] }>();
            for (let a = 0; a < authority.rooms.length; a++) for (let b = a + 1; b < authority.rooms.length; b++) {
              const boundary = sharedBoundary(authority.rooms[a], authority.rooms[b]);
              if (boundary) expected.set(roomPairKey([authority.rooms[a].id, authority.rooms[b].id]), { rooms: [authority.rooms[a].id, authority.rooms[b].id], boundary });
            }
            if (interiorPartitionSpecs.length !== expected.size)
              fail("interiorPartitions must exactly enumerate every shared room boundary");
            const samePoint = (a: V2, b: V2) => Math.abs(a[0] - b[0]) <= 1e-4 && Math.abs(a[1] - b[1]) <= 1e-4;
            for (const partition of interiorPartitionSpecs) {
              const key = roomPairKey(partition.roomIds), match = expected.get(key),
                roomA = roomById.get(partition.roomIds[0]), roomB = roomById.get(partition.roomIds[1]);
              if (!match || partitionByRoomPair.has(key))
                fail(`interior partition ${partition.id} has unresolved, duplicate, or non-adjacent room authority`);
              if (!roomA || !roomB)
                fail(`interior partition ${partition.id} has unresolved room authority`);
              const resolvedMatch = match!, resolvedRoomA = roomA!, resolvedRoomB = roomB!,
                [from, to] = resolvedMatch.boundary,
                matchesBoundary = (samePoint(partition.from, from) && samePoint(partition.to, to)) ||
                  (samePoint(partition.from, to) && samePoint(partition.to, from));
              if (!matchesBoundary || Math.abs(partition.bottomY - resolvedRoomA.finishedFloorY) > 1e-4 ||
                Math.abs(partition.topY - resolvedRoomA.ceilingY) > 1e-4 || resolvedRoomA.finishedFloorY !== resolvedRoomB.finishedFloorY || resolvedRoomA.ceilingY !== resolvedRoomB.ceilingY)
                fail(`interior partition ${partition.id} must exactly span its shared room boundary`);
              partitionByRoomPair.set(key, partition);
            }
          } else if (interiorPartitionSpecs.length)
            fail("interiorPartitions require partitioned-shell layoutAuthority");
          const storeys = [...floorsByStorey].sort((a, b) => a[0] - b[0]);
          if (storeys[0]?.[0] !== 0 || storeys.some(([storey], i) => storey !== i))
            fail("storeys must be contiguous and start at zero");
          for (let index = 1; index < storeys.length; index++)
            if (storeys[index][1] <= storeys[index - 1][1] + 1.8)
              fail("upper-storey floors must rise above the preceding storey");
          if (Math.abs(storeys[0][1] - authority.site.finishedFloorY) > 1e-4)
            fail("site.finishedFloorY must equal the ground-storey floor");
          if (
            volumeSpecs.some((volume) => !storeys.some(([, floor]) => Math.abs(volume.floorY - floor) <= 1e-4)) ||
            entrances.some((entrance) => Math.abs(entrance.finishedFloorY - authority.site.finishedFloorY) > 1e-4)
          ) fail("volumes, entrances, rooms, and site must share finished-floor authority");

          const portalIds = unique(authority.portals, "portals", 1, 64),
            portalById = new Map(authority.portals.map((portal) => [portal.id, portal]));
          for (const [index, portal] of authority.portals.entries()) {
            const label = `portals[${index}]`, [a, b] = portal.roomIds;
            if ((a === null && b === null) || a === b ||
              (a !== null && !roomIds.has(a)) || (b !== null && !roomIds.has(b)))
              fail(`${label} has unresolved or degenerate endpoints`);
            if (portal.exterior !== portal.roomIds.includes(null))
              fail(`${label}.exterior must exactly match its null endpoint`);
            v3(portal.center, `${label}.center`);
            v3(portal.halfExtents, `${label}.halfExtents`);
            if (portal.halfExtents.some((axis) => axis <= 0)) fail(`${label} extents must be positive`);
            boundedCoefficient(portal.acousticTransmission, `${label}.acousticTransmission`);
            for (const endpoint of portal.roomIds) if (endpoint !== null) {
              const room = roomById.get(endpoint)!;
              if (!portal.center.every((axis, dimension) =>
                Math.abs(axis - room.bounds.center[dimension]) <=
                  room.bounds.halfExtents[dimension] + portal.halfExtents[dimension] + 1e-6
              )) fail(`${label} does not touch room ${endpoint}`);
            }
            if (portal.kind === "door") {
              if (!portal.doorId || !doorSpecs.some((door) => door.id === portal.doorId))
                fail(`${label} doorId does not resolve to an authored door`);
            } else if (portal.kind !== "passage" || portal.doorId !== undefined)
              fail(`${label} kind/door mapping is inconsistent`);
          }
          if (partitionedShell) {
            const interiorPortals = authority.portals.filter((portal) => !portal.exterior),
              portalByPair = new Map<string, (typeof interiorPortals)[number]>();
            for (const portal of interiorPortals) {
              const ids = portal.roomIds;
              if (ids[0] === null || ids[1] === null)
                fail(`interior portal ${portal.id} cannot have an exterior endpoint`);
              const key = roomPairKey(ids as readonly [string, string]);
              if (portalByPair.has(key)) fail(`room pair for ${portal.id} has multiple portals`);
              portalByPair.set(key, portal);
            }
            for (const [key, partition] of partitionByRoomPair) {
              const portal = portalByPair.get(key), openings = partition.openings ?? [];
              if (!portal) {
                if (openings.length) fail(`solid partition ${partition.id} cannot contain an unmapped opening`);
                continue;
              }
              if (openings.length !== 1)
                fail(`partition ${partition.id} must contain exactly one opening for portal ${portal.id}`);
              const opening = openings[0], basis = wallBasis(partition),
                expectedCenter: V3 = [basis.mx + basis.tx * opening.offset, opening.sillY + opening.height / 2, basis.mz + basis.tz * opening.offset],
                expectedHalf: V3 = Math.abs(basis.tx) > Math.abs(basis.tz)
                  ? [opening.width / 2, opening.height / 2, partition.thickness / 2]
                  : [partition.thickness / 2, opening.height / 2, opening.width / 2];
              if (opening.kind !== portal.kind ||
                portal.center.some((axis, dimension) => Math.abs(axis - expectedCenter[dimension]) > 1e-4) ||
                portal.halfExtents.some((axis, dimension) => Math.abs(axis - expectedHalf[dimension]) > 1e-4))
                fail(`portal ${portal.id} must exactly match its compiler-owned partition opening`);
              if (portal.kind === "door") {
                const door = doorSpecs.find((candidate) => candidate.id === portal.doorId);
                if (!door || door.wallId !== partition.id || door.openingId !== opening.id)
                  fail(`door portal ${portal.id} must bind its partition and opening authority`);
              }
            }
            if (portalByPair.size !== [...partitionByRoomPair].filter(([, partition]) => (partition.openings?.length ?? 0) > 0).length)
              fail("every interior portal must resolve to exactly one partition opening");
          }
          const mappedDoorIds = authority.portals.flatMap((portal) => portal.doorId ? [portal.doorId] : []);
          if (new Set(mappedDoorIds).size !== mappedDoorIds.length ||
            doorSpecs.some((door) => !mappedDoorIds.includes(door.id)))
            fail("every authored door must map to exactly one door portal");

          unique(authority.stairs, "stairs", 0, 32);
          for (const [index, stair] of authority.stairs.entries()) {
            const label = `stairs[${index}]`, fromRoom = roomById.get(stair.fromRoomId),
              toRoom = roomById.get(stair.toRoomId);
            v3(stair.from, `${label}.from`);
            v3(stair.to, `${label}.to`);
            if (!fromRoom || !toRoom || fromRoom === toRoom ||
              !contains(fromRoom, stair.from) || !contains(toRoom, stair.to))
              fail(`${label} endpoints must resolve inside distinct rooms`);
            if (!fromRoom || !toRoom) throw new Error("architecture: unreachable stair endpoint validation");
            const actualRise = Math.abs(stair.to[1] - stair.from[1]),
              actualRun = Math.hypot(stair.to[0] - stair.from[0], stair.to[2] - stair.from[2]),
              deltaX = stair.to[0] - stair.from[0], deltaZ = stair.to[2] - stair.from[2],
              ux = (stair.to[0] - stair.from[0]) / actualRun,
              uz = (stair.to[2] - stair.from[2]) / actualRun,
              fromLandingFar: V3 = [stair.from[0] - ux * stair.bottomLandingDepth, stair.from[1], stair.from[2] - uz * stair.bottomLandingDepth],
              toLandingFar: V3 = [stair.to[0] + ux * stair.topLandingDepth, stair.to[1], stair.to[2] + uz * stair.topLandingDepth];
            v2(stair.upperFloorOpening.center, `${label}.upperFloorOpening.center`);
            v2(stair.upperFloorOpening.halfExtents, `${label}.upperFloorOpening.halfExtents`);
            const opening = stair.upperFloorOpening,
              approachDistance = stair.clearHeight * stair.run / stair.rise,
              // Clear the swept rounded character/controller envelope at the floor edge, not only
              // a zero-width vertical headroom ray. One stair clear-width is the conservative
              // horizontal body allowance used by the native bidirectional traversal gate.
              traversalApproachDistance = approachDistance + stair.clearWidth,
              approach: V2 = [stair.to[0] - ux * traversalApproachDistance, stair.to[2] - uz * traversalApproachDistance],
              perpendicular: V2 = [-uz * stair.clearWidth / 2, ux * stair.clearWidth / 2],
              openingContains = (point: V2) =>
                Math.abs(point[0] - opening.center[0]) <= opening.halfExtents[0] + 1e-6 &&
                Math.abs(point[1] - opening.center[1]) <= opening.halfExtents[1] + 1e-6,
              openingInsideRoom =
                Math.abs(opening.center[0] - toRoom.bounds.center[0]) + opening.halfExtents[0] <= toRoom.bounds.halfExtents[0] + 1e-6 &&
                Math.abs(opening.center[1] - toRoom.bounds.center[2]) + opening.halfExtents[1] <= toRoom.bounds.halfExtents[2] + 1e-6;
            for (const [value, name] of [
              [stair.clearWidth, "clearWidth"], [stair.clearHeight, "clearHeight"],
              [stair.rise, "rise"], [stair.run, "run"],
              [stair.treadDepth, "treadDepth"], [stair.bottomLandingDepth, "bottomLandingDepth"],
              [stair.topLandingDepth, "topLandingDepth"],
            ] as const) if (!Number.isFinite(value) || value <= 0) fail(`${label}.${name} must be positive`);
            if (
              fromRoom.storey === toRoom.storey ||
              Math.abs(stair.from[1] - fromRoom.finishedFloorY) > 1e-4 ||
              Math.abs(stair.to[1] - toRoom.finishedFloorY) > 1e-4 ||
              Math.abs(stair.rise - actualRise) > 1e-4 ||
              Math.abs(stair.rise - Math.abs(toRoom.finishedFloorY - fromRoom.finishedFloorY)) > 1e-4 ||
              Math.abs(stair.run - actualRun) > 1e-4 ||
              (Math.abs(deltaX) > 1e-4) === (Math.abs(deltaZ) > 1e-4) ||
              !Number.isSafeInteger(stair.riserCount) || stair.riserCount < 2 || stair.riserCount > 64 ||
              stair.rise / stair.riserCount > 0.2 || stair.treadDepth < 0.25 || stair.treadDepth > 0.45 ||
              Math.abs(stair.riserCount * stair.treadDepth - stair.run) > 1e-4 ||
              stair.clearWidth < 0.8 || stair.clearHeight < 2 ||
              stair.bottomLandingDepth < stair.clearWidth || stair.topLandingDepth < stair.clearWidth ||
              !contains(fromRoom, fromLandingFar) || !contains(toRoom, toLandingFar) ||
              opening.halfExtents.some((axis) => axis <= 0) || !openingInsideRoom ||
              !openingContains([stair.to[0] + perpendicular[0], stair.to[2] + perpendicular[1]]) ||
              !openingContains([stair.to[0] - perpendicular[0], stair.to[2] - perpendicular[1]]) ||
              !openingContains([approach[0] + perpendicular[0], approach[1] + perpendicular[1]]) ||
              !openingContains([approach[0] - perpendicular[0], approach[1] - perpendicular[1]])
            ) fail(`${label} violates rise/run/riser/headroom/landing constraints`);
          }

          unique(authority.spawnAnchors, "spawnAnchors", 1, 256);
          for (const [index, anchor] of authority.spawnAnchors.entries()) {
            const label = `spawnAnchors[${index}]`, room = roomById.get(anchor.roomId);
            v3(anchor.position, `${label}.position`);
            v3(anchor.direction, `${label}.direction`);
            if (!room || !contains(room, anchor.position) ||
              Math.abs(anchor.position[1] - room.finishedFloorY) > 1e-4)
              fail(`${label} must lie on its room's finished floor`);
            if (!room) throw new Error("architecture: unreachable spawn room validation");
            if (!(["player", "npc", "item"] as const).includes(anchor.kind) ||
              !Number.isFinite(anchor.clearanceRadius) || anchor.clearanceRadius <= 0 || anchor.clearanceRadius > 1 ||
              !Number.isFinite(anchor.clearanceHeight) || anchor.clearanceHeight < 0.1 || anchor.clearanceHeight > 3 ||
              Math.abs(anchor.position[0] - room.bounds.center[0]) + anchor.clearanceRadius > room.bounds.halfExtents[0] + 1e-6 ||
              Math.abs(anchor.position[2] - room.bounds.center[2]) + anchor.clearanceRadius > room.bounds.halfExtents[2] + 1e-6 ||
              anchor.position[1] + anchor.clearanceHeight > room.ceilingY + 1e-6)
              fail(`${label} clearance does not fit its room`);
            if (Math.abs(Math.hypot(...anchor.direction) - 1) > 1e-4)
              fail(`${label}.direction must be normalized`);
          }
          if (authority.rooms.some((room) => !authority.spawnAnchors.some((anchor) => anchor.roomId === room.id)))
            fail("spawn anchors must cover every room");

          const cellIds = unique(authority.visibilityCells, "visibilityCells", 1, 64),
            cellOwners = new Map<string, string>();
          for (const [index, cell] of authority.visibilityCells.entries()) {
            const label = `visibilityCells[${index}]`;
            if (cell.roomIds.length === 0 || cell.nodeIds.length === 0 ||
              new Set(cell.roomIds).size !== cell.roomIds.length ||
              new Set(cell.nodeIds).size !== cell.nodeIds.length)
              fail(`${label} mappings must be non-empty and unique`);
            for (const roomId of cell.roomIds) {
              const room = roomById.get(roomId);
              if (!room || room.visibilityCellId !== cell.id || cellOwners.has(roomId))
                fail("visibility cells must uniquely and consistently own every room");
              cellOwners.set(roomId, cell.id);
            }
          }
          if (cellOwners.size !== authority.rooms.length ||
            authority.rooms.some((room) => !cellIds.has(room.visibilityCellId)))
            fail("visibility cells must cover every room");
          const visibleNodeIds = authority.visibilityCells.flatMap((cell) => cell.nodeIds);
          if (new Set(visibleNodeIds).size !== visibleNodeIds.length)
            fail("visibility cells must uniquely own every node");
          const topologyIds = [
            ...authority.rooms.map((item) => item.id),
            ...authority.portals.map((item) => item.id),
            ...authority.stairs.map((item) => item.id),
            ...authority.spawnAnchors.map((item) => item.id),
            ...authority.visibilityCells.map((item) => item.id),
          ];
          if (new Set(topologyIds).size !== topologyIds.length)
            fail("room, portal, stair, spawn, and cell ids must be globally unique");

          const adjacency = new Map(authority.rooms.map((room) => [room.id, new Set<string>()]));
          for (const portal of authority.portals) {
            const [a, b] = portal.roomIds;
            if (a !== null && b !== null) { adjacency.get(a)!.add(b); adjacency.get(b)!.add(a); }
          }
          for (const stair of authority.stairs) {
            adjacency.get(stair.fromRoomId)!.add(stair.toRoomId);
            adjacency.get(stair.toRoomId)!.add(stair.fromRoomId);
          }
          const exteriorRooms = authority.portals.flatMap((portal) =>
            portal.roomIds.includes(null) ? portal.roomIds.filter((id): id is string => id !== null) : []
          );
          if (exteriorRooms.length === 0) fail("at least one exterior portal is required");
          if (!authority.portals.some((portal) => portal.exterior &&
            Math.abs(authority.entryAnchor[0] - portal.center[0]) <= portal.halfExtents[0] + 1 &&
            Math.abs(authority.entryAnchor[2] - portal.center[2]) <= portal.halfExtents[2] + 1))
            fail("entryAnchor must resolve beside an exterior portal");
          const visited = new Set<string>(), pending = [...exteriorRooms];
          while (pending.length) {
            const roomId = pending.pop()!;
            if (visited.has(roomId)) continue;
            visited.add(roomId);
            pending.push(...adjacency.get(roomId)!);
          }
          if (visited.size !== authority.rooms.length) fail("every room must be connected to an exterior portal");

          const colliders: { id: string; center: V3; halfExtents: V3 }[] = [];
          for (const wall of walls) for (const segment of wall.segments) {
            const yaw = segment.yawRadians ?? 0, quarter = Math.round(yaw / (Math.PI / 2));
            if (Math.abs(yaw - quarter * Math.PI / 2) > 1e-6)
              fail(`functional collider ${segment.id} is not cardinal`);
            const rotated = Math.abs(quarter) % 2 === 1;
            colliders.push({ id: `collider/${segment.id}`, center: [...segment.center],
              halfExtents: rotated
                ? [segment.halfExtents[2], segment.halfExtents[1], segment.halfExtents[0]]
                : [...segment.halfExtents] });
          }
          for (const volume of volumes) {
            for (const slab of functionalFloorFragments.get(volume.id) ?? [volume.floor]) {
              const xs = slab.boundary.map((point) => point[0]), zs = slab.boundary.map((point) => point[1]);
              colliders.push({ id: `collider/${slab.id}`,
                center: [(Math.min(...xs) + Math.max(...xs)) / 2, (slab.bottomY + slab.topY) / 2, (Math.min(...zs) + Math.max(...zs)) / 2],
                halfExtents: [(Math.max(...xs) - Math.min(...xs)) / 2, (slab.topY - slab.bottomY) / 2, (Math.max(...zs) - Math.min(...zs)) / 2] });
            }
          }
          for (const window of windows) colliders.push({ id: `collider/${window.id}`, center: [...window.apertureCenter], halfExtents: [...window.apertureHalfExtents] });
          for (const stairPart of functionalStairPrimitives) {
            const yaw = stairPart.yawRadians ?? 0, c = Math.abs(Math.cos(yaw)), s = Math.abs(Math.sin(yaw));
            // Render treads remain construction solids, but collision authority is the bounded
            // walking surface at each top. Full-height, mutually touching tread boxes make Rapier's
            // capsule repeatedly confront cumulative blocks instead of individual legal risers and
            // can strand it mid-flight. Thin slabs preserve every top/riser and bidirectional
            // support while keeping the under-stair volume out of traversal authority.
            const colliderHalfHeight = Math.min(.05, stairPart.halfExtents[1]),
              top = stairPart.center[1] + stairPart.halfExtents[1];
            colliders.push({ id: `collider/${stairPart.id}`, center: [stairPart.center[0], top - colliderHalfHeight, stairPart.center[2]],
              halfExtents: [c * stairPart.halfExtents[0] + s * stairPart.halfExtents[2], colliderHalfHeight, s * stairPart.halfExtents[0] + c * stairPart.halfExtents[2]] });
          }
          const contractDoors = doorSpecs.map((spec) => {
            const door = doors.find((item) => item.id === spec.id)!, record = openingById.get(spec.openingId)!,
              basis = wallBasis(record.wall), portal = authority.portals.find((item) => item.doorId === spec.id)!;
            return { id: door.id, roomId: portal.roomIds.find((id): id is string => id !== null)!, portalId: portal.id,
              hinge: [...door.hinge] as V3, center: [...door.localCenter] as V3,
              halfExtents: [...door.leaf.halfExtents] as V3, closedYaw: basis.yaw, openYaw: basis.yaw + door.openYaw };
          });
          return Object.freeze({
            schema: "limina.functional-building/v2" as const, units: "meter" as const, up: "Y" as const,
            buildingId: authority.buildingId, rootNodeId: "building/root" as const,
            roomIds: Object.freeze(authority.rooms.map((room) => room.id)),
            portalIds: Object.freeze(authority.portals.map((portal) => portal.id)),
            entryAnchor: Object.freeze([...authority.entryAnchor]) as V3,
            site: Object.freeze({ ...authority.site }), colliders: Object.freeze(colliders), doors: Object.freeze(contractDoors),
            rooms: Object.freeze(authority.rooms.map(({ volumeId: _volumeId, ...room }) => Object.freeze({ ...room, bounds: Object.freeze({ center: Object.freeze([...room.bounds.center]) as V3, halfExtents: Object.freeze([...room.bounds.halfExtents]) as V3 }), acoustics: Object.freeze({ ...room.acoustics }) }))),
            portals: Object.freeze(authority.portals.map((portal) => Object.freeze({ ...portal, roomIds: Object.freeze([...portal.roomIds]) as readonly [string | null, string | null], center: Object.freeze([...portal.center]) as V3, halfExtents: Object.freeze([...portal.halfExtents]) as V3 }))),
            verticalLinks: Object.freeze(authority.stairs.map((stair) => Object.freeze({ id: stair.id, kind: "stairs" as const, fromRoomId: stair.fromRoomId, toRoomId: stair.toRoomId, from: Object.freeze([...stair.from]) as V3, to: Object.freeze([...stair.to]) as V3, clearWidth: stair.clearWidth, clearHeight: stair.clearHeight, rise: stair.rise, run: stair.run, riserCount: stair.riserCount, treadDepth: stair.treadDepth, upperFloorOpening: Object.freeze({ center: Object.freeze([...stair.upperFloorOpening.center]) as V2, halfExtents: Object.freeze([...stair.upperFloorOpening.halfExtents]) as V2 }) }))),
            spawnAnchors: Object.freeze(authority.spawnAnchors.map((anchor) => Object.freeze({ ...anchor, position: Object.freeze([...anchor.position]) as V3, direction: Object.freeze([...anchor.direction]) as V3 }))),
            visibilityCells: Object.freeze(authority.visibilityCells.map((cell) => Object.freeze({ ...cell, roomIds: Object.freeze([...cell.roomIds]), nodeIds: Object.freeze([...cell.nodeIds]) }))),
          });
        }
        v3(functional.entryAnchor, "functional.entryAnchor");
        v2(functional.site.footprintCenter, "functional.site.footprintCenter");
        v2(
          functional.site.footprintHalfExtents,
          "functional.site.footprintHalfExtents",
        );
        if (
          !functional.buildingId.trim() ||
          !functional.roomId.trim() ||
          !functional.portalId.trim() ||
          functional.site.footprintHalfExtents.some((n) => n <= 0) ||
          functional.site.terrainClearance < 0.05 ||
          functional.site.terrainClearance > 1 ||
          functional.site.maximumTerrainRelief <= 0 ||
          functional.clearAisle.halfWidth < 0.45 ||
          functional.clearAisle.minClearHeight < 1.8 ||
          functional.lod.lod1TriangleBudget >= functional.lod.triangleBudget ||
          functional.lod.lod2TriangleBudget >= functional.lod.lod1TriangleBudget
        )
          throw new Error(
            "architecture: invalid functional building authority",
          );
        const entranceSupport = functional.site.entranceSupport;
        if(
          volumeSpecs.some((volume)=>Math.abs(volume.floorY-functional.site.finishedFloorY)>0.001) ||
          entrances.some((entrance)=>Math.abs(entrance.finishedFloorY-functional.site.finishedFloorY)>0.001)
        )
          throw new Error("architecture: volume, entrance, and functional finished-floor authority must agree");
        if (entranceSupport) {
          const entrance = entrances[0],
            entranceSpec = input.entrances[0],
            lowestStep = entrance?.steps[0];
          if (
            entranceSpec?.constructionPolicy !== "finished-surface-authority" ||
            !lowestStep ||
            (entranceSupport.sourcePrimitiveId !== undefined &&
              entranceSupport.sourcePrimitiveId !== lowestStep.id) ||
            Math.abs(entranceSupport.center[0] - lowestStep.center[0]) > 0.001 ||
            Math.abs(entranceSupport.center[1] - lowestStep.center[2]) > 0.001 ||
            Math.abs(entranceSupport.halfExtents[0] - lowestStep.halfExtents[0]) > 0.001 ||
            Math.abs(entranceSupport.halfExtents[1] - lowestStep.halfExtents[2]) > 0.001 ||
            Math.abs(entranceSupport.yawRadians - (lowestStep.yawRadians ?? 0)) > 0.001 ||
            Math.abs(entranceSupport.exteriorGradeY - entrance.exteriorGradeY) > 0.001
            || Math.abs(entranceSupport.bearingDepth - (entranceSpec.bearingDepth ?? 0)) > 0.001
          )
            throw new Error(
              "architecture: functional entrance support must match the lowest authored tread",
            );
        }
        const colliders: { id: string; center: V3; halfExtents: V3 }[] = [];
        for (const wall of walls)
          for (const segment of wall.segments) {
            const yaw = segment.yawRadians ?? 0,
              quarter = Math.round(yaw / (Math.PI / 2));
            if (Math.abs(yaw - (quarter * Math.PI) / 2) > 1e-6)
              throw new Error(
                `architecture: functional collider ${segment.id} is not cardinal`,
              );
            const rotated = Math.abs(quarter) % 2 === 1,
              halfExtents: V3 = rotated
                ? [
                    segment.halfExtents[2],
                    segment.halfExtents[1],
                    segment.halfExtents[0],
                  ]
                : [...segment.halfExtents];
            colliders.push({
              id: `collider/${segment.id}`,
              center: [...segment.center],
              halfExtents,
            });
          }
        for (const volume of volumes) {
          const xs = volume.floor.boundary.map((p) => p[0]), zs = volume.floor.boundary.map((p) => p[1]),
            center: V3 = [(Math.min(...xs) + Math.max(...xs)) / 2, (volume.floor.bottomY + volume.floor.topY) / 2, (Math.min(...zs) + Math.max(...zs)) / 2],
            half: V3 = [(Math.max(...xs) - Math.min(...xs)) / 2, (volume.floor.topY - volume.floor.bottomY) / 2, (Math.max(...zs) - Math.min(...zs)) / 2];
          colliders.push({ id: `collider/${volume.floor.id}`, center, halfExtents: half });
        }
        for (const window of windows)
          colliders.push({
            id: `collider/${window.id}`,
            center: [...window.apertureCenter],
            halfExtents: [...window.apertureHalfExtents],
          });
        const contractDoors = doorSpecs.map((spec) => {
          const door = doors.find((item) => item.id === spec.id)!,
            record = openingById.get(spec.openingId)!,
            basis = wallBasis(record.wall);
          return {
            id: door.id,
            roomId: functional.roomId,
            portalId: functional.portalId,
            hinge: [...door.hinge] as V3,
            center: [...door.localCenter] as V3,
            halfExtents: [...door.leaf.halfExtents] as V3,
            closedYaw: basis.yaw,
            openYaw: basis.yaw + door.openYaw,
          };
        });
        return Object.freeze({
          schema: "limina.functional-building/v1" as const,
          units: "meter" as const,
          up: "Y" as const,
          buildingId: functional.buildingId,
          rootNodeId: "building/root" as const,
          roomIds: Object.freeze([functional.roomId]),
          portalIds: Object.freeze([functional.portalId]),
          entryAnchor: Object.freeze([...functional.entryAnchor]) as V3,
          site: Object.freeze({ ...functional.site }),
          colliders: Object.freeze(colliders),
          doors: Object.freeze(contractDoors),
        });
      })()
    : undefined;
  const visualContract = input.functional
    ? (() => {
      const functional = input.functional,
          usedMaterialRoles = new Set([
            ...primitives.flatMap((primitive) => primitive.materialRole ? [primitive.materialRole] : []),
            ...(doors.length ? ["door-surface", "door-hardware"] : []),
          ]),
          materialRoles = [
            ["foundation", "V4 fieldstone"],
            ["mortar-reveal", "V4 lime mortar"],
            ["wall-exterior", "V4 warm lime plaster"],
            ["wall-interior", "V4 interior lime"],
            ["structure-trim", "V4 structural oak"],
            ["timber-frame-exterior", "V4 exterior frame oak"],
            ["door-surface", "V4 door oak"],
            ["floor-furnishing", "V4 worn oak"],
            ["furniture-wood", "V4 furniture oak"],
            ["domestic-ceramic", "V4 warm ceramic"],
            ["domestic-ceramic-dark", "V4 ceramic interior"],
            ["textile-wool", "V4 woven wool"],
            ["wax", "V4 beeswax"],
            ["roof", "V4 blue slate"],
            ["roof-flashing", "V4 weathered lead"],
            ["hearth-masonry", "V4 chimney brick"],
            ["hearth-soot", "V4 hearth soot"],
            ["hearth-embers", "V4 hearth embers"],
            ["flame-outer", "V4 flame outer"],
            ["flame-inner", "V4 flame inner"],
            ["glazing", "V4 leadlight glass"],
            ["door-hardware", "V4 black iron"],
          ].filter(([role]) => usedMaterialRoles.has(role)).map(([role, materialName]) => ({ role, materialName })),
          orderedReveals = (parts: readonly SolidBox[], face: string) =>
            [...parts.slice(0, 2)]
              .sort((a, b) =>
                face === "north" || face === "south"
                  ? a.center[0] - b.center[0]
                  : a.center[2] - b.center[2],
              )
              .concat(parts.slice(2))
              .map((item) => item.id),
          openings = [
            ...windows.map((window) => ({
              id: window.id,
              kind: "window",
              ...( "schema" in functional ? { exterior: true } : {}),
              facade: window.facade,
              aperture: {
                center: window.apertureCenter,
                halfExtents: window.apertureHalfExtents,
              },
              glazingNodeId: window.glazing.id,
              revealNodeIds: orderedReveals(window.reveals, window.facade),
              frameNodeIds: window.frame.map((item) => item.id),
              mullionNodeIds: window.mullions.map((item) => item.id),
              cameNodeIds: window.came.map((item) => item.id),
            })),
            ...doors.map((door) => ({
              id: "schema" in functional
                ? functional.portals.find((portal) => portal.doorId === door.id)?.id ?? door.id
                : functional.portalId,
              kind: "door",
              ...( "schema" in functional ? { exterior: functional.portals.find((portal) => portal.doorId === door.id)?.exterior ?? false } : {}),
              facade: door.facade,
              aperture: {
                center: door.apertureCenter,
                halfExtents: door.apertureHalfExtents,
              },
              leafNodeId: door.id,
              revealNodeIds: orderedReveals(
                door.reveals,
                door.facade ?? "south",
              ),
              plankNodeIds: door.planks.map((item) => item.id),
              ironworkNodeIds: door.ironwork.map((item) => item.id),
            })),
          ],
          fireplace = fireplaces[0],
          fireplaceSpec = (input.fireplaces ?? [])[0],
          hearthLight = fireplaceSpec?.lightId
            ? practicalLights.find(
                (light) => light.id === fireplaceSpec.lightId,
              )
            : undefined;
        if (!fireplace || !fireplaceSpec || !hearthLight)
          throw new Error(
            "architecture: functional visual contract requires a fireplace with a resolved practical light",
          );
        return Object.freeze({
          schema: "limina.functional-building-visual/v1" as const,
          openings: Object.freeze(openings),
          materialRoles: Object.freeze(materialRoles),
          interior: Object.freeze({
            walkableNodeIds: Object.freeze(
              compiledVolumes.flatMap((volume) =>
                "schema" in functional && volume.floorFragments
                  ? volume.floorFragments.map((fragment) => fragment.id)
                  : [volume.floor.id]),
            ),
            ceilingNodeIds: Object.freeze(
              compiledVolumes.flatMap((volume) =>
                "schema" in functional && volume.ceilingFragments
                  ? volume.ceilingFragments.map((fragment) => fragment.id)
                  : [volume.ceiling.id]),
            ),
            shellNodeIds: Object.freeze([
              ...interiorShell.map((item) => item.id),
              ...compiledVolumes.flatMap((volume) =>
                "schema" in functional && volume.ceilingFragments
                  ? volume.ceilingFragments.map((fragment) => fragment.id)
                  : [volume.ceiling.id]),
            ]),
            furnishingNodeIds: Object.freeze(
              [
                ...furnishings,
                ...interiorStructure,
                ...domesticProps,
              ].flatMap((item) => item.parts.map((part) => part.id)),
            ),
            hearth: Object.freeze({
              apertureCenter: Object.freeze([...fireplaceSpec.center]),
              apertureHalfExtents: Object.freeze([
                ...fireplaceSpec.apertureHalfExtents,
              ]),
              surroundNodeIds: Object.freeze([
                fireplace.base.id,
                ...fireplace.surround.map((item) => item.id),
              ]),
              fuelNodeIds: Object.freeze(fireplace.fuel.map((item) => item.id)),
              emberNodeId: fireplace.emberBed.id,
              flameNodeIds: Object.freeze(
                fireplace.flames.map((item) => item.id),
              ),
              lightNodeId: hearthLight.id,
            }),
            clearAisle: Object.freeze({ ...functional.clearAisle }),
          }),
          lod: Object.freeze({
            identity: functional.lod.identity,
            lod0RootNodeId: "building/root",
            triangleBudget: functional.lod.triangleBudget,
            drawBudget: functional.lod.drawBudget,
            lod1TriangleBudget: functional.lod.lod1TriangleBudget,
            lod2TriangleBudget: functional.lod.lod2TriangleBudget,
          }),
        });
      })()
    : undefined;
  const specHash = hash(input),
    irPayload = {
      primitives,
      volumes: compiledVolumes,
      walls,
      entrances,
      doors,
      windows,
      dormers,
      roofPenetrations,
      roofSeams,
      fireplaces,
      practicalLights,
      furnishings,
      interiorStructure,
      ...(compiledPerceptualTimberFrames.length ? { perceptualTimberFrames: compiledPerceptualTimberFrames } : {}),
      domesticProps,
      ...(functionalContract ? { functionalContract } : {}),
      ...(visualContract ? { visualContract } : {}),
    },
    irHash = hash(irPayload),
    review = createArchitectureReview(specHash, irHash, {
      foundations: input.foundations.map((x) => x.id),
      walls: wallSpecs.map((x) => x.id),
      frames: compiledPerceptualTimberFrames.map((x) => x.id),
      roofs: roofPlaneSpecs.map((x) => x.id),
      entrances: [
        ...input.entrances.map((x) => x.id),
        ...doorSpecs.map((x) => x.id),
        ...windows.map((x) => x.id),
        ...dormers.map((x) => x.id),
      ],
      fireplaces: [
        ...(input.fireplaces ?? []).map((x) => x.id),
        ...roofPenetrations.map((x) => x.id),
      ],
    });
  return Object.freeze({
    schema: ARCHITECTURE_COMPILE,
    compilerVersion: 1,
    specHash,
    irHash,
    primitives: Object.freeze(primitives),
    volumes: Object.freeze(compiledVolumes),
    walls: Object.freeze(walls),
    entrances: Object.freeze(entrances),
    doors: Object.freeze(doors),
    windows: Object.freeze(windows),
    dormers: Object.freeze(dormers),
    roofPenetrations: Object.freeze(roofPenetrations),
    roofSeams: Object.freeze(roofSeams),
    fireplaces: Object.freeze(fireplaces),
    practicalLights: Object.freeze(practicalLights),
    furnishings: Object.freeze(furnishings),
    interiorStructure: Object.freeze(interiorStructure),
    ...(compiledPerceptualTimberFrames.length ? { perceptualTimberFrames: Object.freeze(compiledPerceptualTimberFrames) } : {}),
    domesticProps: Object.freeze(domesticProps),
    ...(functionalContract ? { functionalContract } : {}),
    ...(visualContract ? { visualContract } : {}),
    diagnostics: Object.freeze(diagnostics),
    review,
  });
}
