import type { FunctionalBuildingContract } from "../assets/functional-building-contract.ts";
import { portableAssetContentHash } from "../world/asset-content-hash.mjs";
import { sha256 } from "../world/sha256.mjs";

type Hash = `sha256:${string}`;
type V3 = readonly [number, number, number];
export interface BuildingSiteReviewEnvelope {
  readonly schema: "limina.building-site-review-envelope/v1";
  readonly runtimePack: { readonly path: string; readonly sha256: Hash; readonly contentHash: Hash };
  readonly populationMaximumHorizontalReachM: number;
  readonly discretePopulationExclusion: {
    readonly structure: "authored-footprint-plus-vegetation-clearance-plus-population-reach";
    readonly cameraLineOfSight: "camera-to-subject-footprint-sweep-plus-population-reach";
    readonly exteriorViewIds: readonly string[];
  };
  readonly subjectBounds: { readonly minimum: V3; readonly maximum: V3 };
  readonly cameraChecks: {
    readonly minimumProjectedAreaFraction: number;
    readonly minimumProjectedHeightFraction: number;
    readonly maximumFullSubjectHeightFraction: number;
    readonly fullSubjectViewIds: readonly string[];
    readonly terrainRaySampleSpacingM: number;
    readonly minimumTerrainClearanceM: number;
    readonly interiorViewIds: readonly string[];
  };
}
export interface SiteReviewView {
  readonly id: string;
  readonly camera: {
    readonly position: V3;
    readonly target: V3;
    readonly fovDeg: number;
    readonly near: number;
    readonly far: number;
  };
}
const HASH = /^sha256:[0-9a-f]{64}$/;
const finite3 = (v: unknown): v is V3 => Array.isArray(v) && v.length === 3 && v.every(Number.isFinite);
export function validateBuildingSiteReviewEnvelope(value: any): BuildingSiteReviewEnvelope {
  if (
    value?.schema !== "limina.building-site-review-envelope/v1" ||
    !value.runtimePack?.path ||
    !HASH.test(value.runtimePack.sha256) ||
    !HASH.test(value.runtimePack.contentHash) ||
    !Number.isFinite(value.populationMaximumHorizontalReachM) ||
    value.populationMaximumHorizontalReachM < 0.1 ||
    value.populationMaximumHorizontalReachM > 30
  )
    throw new Error("building site review envelope identity is invalid");
  if (
    value.discretePopulationExclusion?.structure !==
      "authored-footprint-plus-vegetation-clearance-plus-population-reach" ||
    value.discretePopulationExclusion?.cameraLineOfSight !==
      "camera-to-subject-footprint-sweep-plus-population-reach" ||
    !Array.isArray(value.discretePopulationExclusion.exteriorViewIds) ||
    value.discretePopulationExclusion.exteriorViewIds.length < 1 ||
    new Set(value.discretePopulationExclusion.exteriorViewIds).size !==
      value.discretePopulationExclusion.exteriorViewIds.length
  )
    throw new Error("site review discrete-population policy is incomplete");
  if (
    !finite3(value.subjectBounds?.minimum) ||
    !finite3(value.subjectBounds?.maximum) ||
    value.subjectBounds.minimum.some((n: number, i: number) => n >= value.subjectBounds.maximum[i])
  )
    throw new Error("site review subject bounds are invalid");
  const checks = value.cameraChecks;
  if (
    !Number.isFinite(checks?.minimumProjectedAreaFraction) ||
    checks.minimumProjectedAreaFraction < 0.02 ||
    checks.minimumProjectedAreaFraction > 0.8 ||
    !Number.isFinite(checks.minimumProjectedHeightFraction) ||
    checks.minimumProjectedHeightFraction < 0.1 ||
    checks.minimumProjectedHeightFraction > 0.95 ||
    !Number.isFinite(checks.maximumFullSubjectHeightFraction) ||
    checks.maximumFullSubjectHeightFraction < checks.minimumProjectedHeightFraction ||
    checks.maximumFullSubjectHeightFraction > 0.98 ||
    !Array.isArray(checks.fullSubjectViewIds) ||
    checks.fullSubjectViewIds.length < 1 ||
    new Set(checks.fullSubjectViewIds).size !== checks.fullSubjectViewIds.length ||
    !Number.isFinite(checks.terrainRaySampleSpacingM) ||
    checks.terrainRaySampleSpacingM <= 0 ||
    checks.terrainRaySampleSpacingM > 1 ||
    !Number.isFinite(checks.minimumTerrainClearanceM) ||
    checks.minimumTerrainClearanceM < 0 ||
    checks.minimumTerrainClearanceM > 2 ||
    !Array.isArray(checks.interiorViewIds) ||
    new Set(checks.interiorViewIds).size !== checks.interiorViewIds.length
  )
    throw new Error("site review camera checks are invalid");
  const exterior = new Set(value.discretePopulationExclusion.exteriorViewIds),
    interior = new Set(checks.interiorViewIds),
    full = new Set(checks.fullSubjectViewIds);
  if ([...exterior].some((id) => interior.has(id)) || [...full].some((id) => !exterior.has(id)))
    throw new Error("site review view classifications are inconsistent");
  return Object.freeze(value);
}
export function derivePopulationMaximumHorizontalReach(runtimePack: any): number {
  if (runtimePack?.schema !== "limina.biome-runtime-pack/v1" || !Array.isArray(runtimePack.biomes))
    throw new Error("site review runtime pack is invalid");
  let maximum = 0,
    count = 0;
  for (const biome of runtimePack.biomes)
    for (const rule of biome.vegetationRules ?? []) {
      if (
        !Number.isFinite(rule.radiusM) ||
        !Array.isArray(rule.scale) ||
        rule.scale.length !== 2 ||
        !rule.scale.every(Number.isFinite) ||
        rule.radiusM < 0 ||
        rule.scale[1] < 0
      )
        throw new Error(`site review vegetation rule '${rule.role ?? "unknown"}' lacks finite reach authority`);
      maximum = Math.max(maximum, rule.radiusM * rule.scale[1]);
      count++;
    }
  if (count === 0 || maximum <= 0) throw new Error("site review runtime pack has no vegetation reach rules");
  return Number(maximum.toFixed(12));
}
export function verifySiteReviewRuntimePack(envelopeValue: unknown, bytes: Uint8Array): number {
  const envelope = validateBuildingSiteReviewEnvelope(envelopeValue),
    raw = `sha256:${sha256(bytes)}`;
  if (raw !== envelope.runtimePack.sha256 || portableAssetContentHash(bytes) !== envelope.runtimePack.contentHash)
    throw new Error("site review runtime pack exact bytes drifted");
  let pack: any;
  try {
    pack = JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(bytes));
  } catch (error) {
    throw new Error("site review runtime pack is not valid JSON", { cause: error });
  }
  const derived = derivePopulationMaximumHorizontalReach(pack);
  if (Math.abs(derived - envelope.populationMaximumHorizontalReachM) > 1e-9)
    throw new Error(
      `site review population reach drifted: authority=${envelope.populationMaximumHorizontalReachM} derived=${derived}`,
    );
  return derived;
}
const worldXZ = (position: V3, yaw: number, x: number, z: number): readonly [number, number] => {
  const c = Math.cos(yaw),
    s = Math.sin(yaw);
  return [position[0] + x * c + z * s, position[2] - x * s + z * c];
};
const segmentDistance = (x: number, z: number, ax: number, az: number, bx: number, bz: number) => {
  const dx = bx - ax,
    dz = bz - az,
    d2 = dx * dx + dz * dz,
    t = d2 === 0 ? 0 : Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / d2)),
    ox = x - (ax + dx * t),
    oz = z - (az + dz * t);
  return Math.hypot(ox, oz);
};
export function createSiteReviewDiscretePopulationExclusion(
  input: Readonly<{
    envelope: BuildingSiteReviewEnvelope;
    contract: FunctionalBuildingContract;
    position: V3;
    yaw: number;
    views: readonly SiteReviewView[];
  }>,
): (x: number, z: number) => boolean {
  const envelope = validateBuildingSiteReviewEnvelope(input.envelope),
    site = input.contract.site;
  if (!site) throw new Error("site review exclusion requires authored building site authority");
  const viewById = new Map(input.views.map((view) => [view.id, view]));
  const center = worldXZ(input.position, input.yaw, site.footprintCenter[0], site.footprintCenter[1]),
    halfX = site.footprintHalfExtents[0] + site.vegetationClearance + envelope.populationMaximumHorizontalReachM,
    halfZ = site.footprintHalfExtents[1] + site.vegetationClearance + envelope.populationMaximumHorizontalReachM,
    c = Math.cos(input.yaw),
    s = Math.sin(input.yaw),
    reach = envelope.populationMaximumHorizontalReachM;
  const localFootprint = [
      site.footprintCenter,
      [
        -site.footprintHalfExtents[0] + site.footprintCenter[0],
        -site.footprintHalfExtents[1] + site.footprintCenter[1],
      ],
      [site.footprintHalfExtents[0] + site.footprintCenter[0], -site.footprintHalfExtents[1] + site.footprintCenter[1]],
      [-site.footprintHalfExtents[0] + site.footprintCenter[0], site.footprintHalfExtents[1] + site.footprintCenter[1]],
      [site.footprintHalfExtents[0] + site.footprintCenter[0], site.footprintHalfExtents[1] + site.footprintCenter[1]],
    ] as const,
    footprint = localFootprint.map(([x, z]) => worldXZ(input.position, input.yaw, x, z));
  const corridors = envelope.discretePopulationExclusion.exteriorViewIds.flatMap((id) => {
    const view = viewById.get(id);
    if (!view) throw new Error(`site review exterior view '${id}' is missing`);
    return footprint.map((point) => [view.camera.position[0], view.camera.position[2], point[0], point[1]] as const);
  });
  return (x, z) => {
    const dx = x - center[0],
      dz = z - center[1],
      localX = dx * c - dz * s,
      localZ = dx * s + dz * c;
    if (Math.abs(localX) <= halfX && Math.abs(localZ) <= halfZ) return true;
    return corridors.some(([ax, az, bx, bz]) => segmentDistance(x, z, ax, az, bx, bz) <= reach);
  };
}
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2],
  sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]],
  norm = (v: V3): V3 => {
    const l = Math.hypot(...v);
    if (l < 1e-9) throw new Error("site review camera direction is degenerate");
    return [v[0] / l, v[1] / l, v[2] / l];
  },
  cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const localFromWorld = (position: V3, yaw: number, point: V3): V3 => {
  const dx = point[0] - position[0],
    dz = point[2] - position[2],
    c = Math.cos(yaw),
    s = Math.sin(yaw);
  return [dx * c - dz * s, point[1] - position[1], dx * s + dz * c];
};
export function verifySiteReviewCameras(
  input: Readonly<{
    envelope: BuildingSiteReviewEnvelope;
    position: V3;
    yaw: number;
    rootWorldY: number;
    views: readonly SiteReviewView[];
    width: number;
    height: number;
    sampleHeight: (x: number, z: number) => number | undefined;
  }>,
) {
  const envelope = validateBuildingSiteReviewEnvelope(input.envelope),
    bounds = envelope.subjectBounds,
    localCorners: V3[] = [];
  for (const x of [bounds.minimum[0], bounds.maximum[0]])
    for (const y of [bounds.minimum[1], bounds.maximum[1]])
      for (const z of [bounds.minimum[2], bounds.maximum[2]]) localCorners.push([x, y, z]);
  const worldCorners = localCorners.map(([x, y, z]) => {
      const [wx, wz] = worldXZ(input.position, input.yaw, x, z);
      return [wx, input.rootWorldY + y, wz] as V3;
    }),
    interior = new Set(envelope.cameraChecks.interiorViewIds),
    exterior = new Set(envelope.discretePopulationExclusion.exteriorViewIds),
    full = new Set(envelope.cameraChecks.fullSubjectViewIds);
  const metrics = [];
  for (const view of input.views) {
    const camera = [view.camera.position[0], view.camera.position[1] + input.rootWorldY, view.camera.position[2]] as V3,
      target = [view.camera.target[0], view.camera.target[1] + input.rootWorldY, view.camera.target[2]] as V3,
      forward = norm(sub(target, camera)),
      right = norm(cross(forward, [0, 1, 0])),
      up = norm(cross(right, forward)),
      tan = Math.tan((view.camera.fovDeg * Math.PI) / 360),
      aspect = input.width / input.height;
    let minX = Infinity,
      maxX = -Infinity,
      minY = Infinity,
      maxY = -Infinity,
      front = 0;
    for (const corner of worldCorners) {
      const rel = sub(corner, camera),
        depth = dot(rel, forward);
      if (depth <= view.camera.near) continue;
      front++;
      const x = dot(rel, right) / (depth * tan * aspect),
        y = dot(rel, up) / (depth * tan);
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
    }
    if (front === 0) throw new Error(`site review ${view.id} has no subject bounds in front of camera`);
    const visibleMinX = Math.max(-1, minX),
      visibleMaxX = Math.min(1, maxX),
      visibleMinY = Math.max(-1, minY),
      visibleMaxY = Math.min(1, maxY),
      area = (Math.max(0, visibleMaxX - visibleMinX) * Math.max(0, visibleMaxY - visibleMinY)) / 4,
      height = Math.max(0, visibleMaxY - visibleMinY) / 2,
      rawHeight = Math.max(0, maxY - minY) / 2;
    if (
      exterior.has(view.id) &&
      (area < envelope.cameraChecks.minimumProjectedAreaFraction ||
        height < envelope.cameraChecks.minimumProjectedHeightFraction)
    )
      throw new Error(
        `site review ${view.id} subject coverage is too small: area=${area.toFixed(4)} height=${height.toFixed(4)}`,
      );
    if (full.has(view.id) && rawHeight > envelope.cameraChecks.maximumFullSubjectHeightFraction)
      throw new Error(`site review ${view.id} clips the full subject: height=${rawHeight.toFixed(4)}`);
    if (interior.has(view.id)) {
      const local = localFromWorld([input.position[0], input.rootWorldY, input.position[2]], input.yaw, camera);
      if (local.some((n, i) => n <= bounds.minimum[i] || n >= bounds.maximum[i]))
        throw new Error(`site review interior camera ${view.id} leaves subject bounds`);
    }
    const distance = Math.hypot(...sub(target, camera)),
      samples = Math.max(1, Math.ceil(distance / envelope.cameraChecks.terrainRaySampleSpacingM));
    let minimumTerrainClearance = Infinity;
    for (let i = 0; i <= samples; i++) {
      const t = i / samples,
        x = camera[0] + (target[0] - camera[0]) * t,
        y = camera[1] + (target[1] - camera[1]) * t,
        z = camera[2] + (target[2] - camera[2]) * t,
        terrain = input.sampleHeight(x, z);
      if (terrain === undefined || !Number.isFinite(terrain))
        throw new Error(`site review ${view.id} ray leaves resident terrain`);
      minimumTerrainClearance = Math.min(minimumTerrainClearance, y - terrain);
    }
    if (minimumTerrainClearance < envelope.cameraChecks.minimumTerrainClearanceM)
      throw new Error(`site review ${view.id} terrain occludes the camera ray`);
    metrics.push(
      Object.freeze({
        id: view.id,
        projectedAreaFraction: Number(area.toFixed(9)),
        projectedHeightFraction: Number(height.toFixed(9)),
        rawProjectedHeightFraction: Number(rawHeight.toFixed(9)),
        fullSubjectFramed: full.has(view.id) ? true : null,
        minimumTerrainClearanceM: Number(minimumTerrainClearance.toFixed(9)),
        interiorContained: interior.has(view.id) ? true : null,
      }),
    );
  }
  return Object.freeze({ schema: "limina.building-site-review-camera-evidence/v1", views: Object.freeze(metrics) });
}
