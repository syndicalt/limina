import * as THREE from "../../../build/three.bundle.mjs";
import type { WaterRenderQuality } from "../quality.ts";
import {
  HYDROLOGY_COMBINED_WATER_TOPOLOGY_SCHEMA,
  HYDROLOGY_COMBINED_WATER_TOPOLOGY_VERSION,
} from "../../world/hydrology-water-topology.mjs";
import { WATER_LIMITS } from "../../world/water-ir.mjs";
import { buildVariableRiverRibbonGeometry, buildWaterFootprintGeometry, type WaterPoint2 } from "./geometry.ts";
import { createWaterMaterial } from "./material.ts";
import { VisibleWaterManager, type VisibleWaterKind } from "./visible-water-manager.ts";

const GENERATED_BASIN_ID = /^gen-b-[0-9a-z]+-[0-9a-z]+$/;
const GENERATED_REACH_ID = /^gen-r-[0-9a-z]+-[0-9a-z]+$/;
const CONTENT_HASH = /^sha256:[0-9a-f]{64}$/;
const WATER_COLOR = 0x2b5d72;

export interface GeneratedWaterfallSpanView {
  readonly startSegment: number;
  readonly endSegmentExclusive: number;
  readonly totalDropM: number;
}

export interface GeneratedBasinView {
  readonly id: string;
  readonly spillLevelM: number;
  readonly footprint: {
    readonly points: readonly WaterPoint2[];
    readonly holes: readonly (readonly WaterPoint2[])[];
  };
}

export interface GeneratedReachView {
  readonly id: string;
  readonly class: "stream" | "river";
  readonly order: number;
  readonly points: readonly WaterPoint2[];
  readonly widths: readonly number[];
  readonly terrainElevationsM: readonly number[];
  readonly surfaceElevationsM: readonly number[];
  readonly waterfalls: readonly GeneratedWaterfallSpanView[];
}

export interface GeneratedWaterTopologyView {
  readonly schema: string;
  readonly version: number;
  readonly basins: readonly GeneratedBasinView[];
  readonly reaches: readonly GeneratedReachView[];
}

/** Adapter boundary for a topology that was decoded and binding-verified off the render thread. */
export interface VerifiedGeneratedWaterRenderResource {
  readonly artifactHash: string;
  readonly topology: GeneratedWaterTopologyView;
}

export interface GeneratedWaterRenderMount {
  readonly artifactHash: string;
  readonly keys: readonly string[];
  readonly mountedKeys: readonly string[];
  readonly basinCount: number;
  readonly reachCount: number;
  readonly waterfallCount: number;
  dispose(): void;
}

interface BasinSnapshot {
  readonly id: string;
  readonly spillLevelM: number;
  readonly outer: readonly WaterPoint2[];
  readonly holes: readonly (readonly WaterPoint2[])[];
}

interface WaterfallSnapshot {
  readonly startSegment: number;
  readonly endSegmentExclusive: number;
  readonly totalDropM: number;
}

interface ReachSnapshot {
  readonly id: string;
  readonly class: "stream" | "river";
  readonly order: number;
  readonly points: readonly WaterPoint2[];
  readonly widths: readonly number[];
  readonly terrainElevationsM: readonly number[];
  readonly surfaceElevationsM: readonly number[];
  readonly waterfalls: readonly WaterfallSnapshot[];
}

interface MountDescriptor {
  readonly key: string;
  readonly kind: VisibleWaterKind;
  readonly identity: string;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly create: (quality: Readonly<WaterRenderQuality>) => THREE.Mesh;
}

function finite(value: number, label: string): number {
  if (!Number.isFinite(value) || Object.is(value, -0)) throw new TypeError(`${label} must be a canonical finite number`);
  return value;
}

function positive(value: number, label: string): number {
  finite(value, label);
  if (!(value > 0)) throw new RangeError(`${label} must be positive`);
  return value;
}

function integer(value: number, minimum: number, maximum: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`${label} must be an integer in [${minimum}, ${maximum}]`);
  }
  return value;
}

function inspectPoint(point: WaterPoint2, label: string): void {
  if (!Array.isArray(point) || point.length !== 2) throw new TypeError(`${label} must be a 2-tuple`);
  finite(point[0], `${label}[0]`);
  finite(point[1], `${label}[1]`);
  if (Math.abs(point[0]) > WATER_LIMITS.absCoordinateM || Math.abs(point[1]) > WATER_LIMITS.absCoordinateM) {
    throw new RangeError(`${label} exceeds the generated-water coordinate limit`);
  }
}

function inspectRing(ring: readonly WaterPoint2[], label: string): number {
  if (!Array.isArray(ring) || ring.length < 3 || ring.length > WATER_LIMITS.ringPoints) {
    throw new RangeError(`${label} must contain 3-${WATER_LIMITS.ringPoints} points`);
  }
  for (let index = 0; index < ring.length; index++) inspectPoint(ring[index], `${label}[${index}]`);
  return ring.length;
}

function inspectResource(resource: VerifiedGeneratedWaterRenderResource, manager: VisibleWaterManager): {
  waterfallCount: number;
} {
  if (manager.disposed) throw new Error("generated-water renderer requires a live visible-water manager");
  if (resource === null || typeof resource !== "object") throw new TypeError("generated-water render resource must be an object");
  if (!CONTENT_HASH.test(resource.artifactHash)) throw new TypeError("generated-water artifactHash must be a canonical sha256 hash");
  const topology = resource.topology;
  if (topology === null || typeof topology !== "object") throw new TypeError("generated-water topology must be an object");
  if (topology.schema !== HYDROLOGY_COMBINED_WATER_TOPOLOGY_SCHEMA
      || topology.version !== HYDROLOGY_COMBINED_WATER_TOPOLOGY_VERSION) {
    throw new TypeError("generated-water topology schema/version is unsupported");
  }
  if (!Array.isArray(topology.basins) || topology.basins.length > WATER_LIMITS.bodies) {
    throw new RangeError(`generated-water topology exceeds ${WATER_LIMITS.bodies} basins`);
  }
  if (!Array.isArray(topology.reaches) || topology.reaches.length > WATER_LIMITS.waterways) {
    throw new RangeError(`generated-water topology exceeds ${WATER_LIMITS.waterways} reaches`);
  }
  let basinPoints = 0;
  let reachPoints = 0;
  let waterfallCount = 0;
  const ids = new Set<string>();
  for (let basinIndex = 0; basinIndex < topology.basins.length; basinIndex++) {
    const basin = topology.basins[basinIndex];
    if (basin.id.length > 64 || !GENERATED_BASIN_ID.test(basin.id) || ids.has(basin.id)) throw new TypeError(`generated-water basin ${basinIndex} id is invalid or duplicated`);
    ids.add(basin.id);
    finite(basin.spillLevelM, `generated-water basin ${basin.id} spillLevelM`);
    basinPoints += inspectRing(basin.footprint.points, `generated-water basin ${basin.id} outer`);
    if (!Array.isArray(basin.footprint.holes) || basin.footprint.holes.length > WATER_LIMITS.holes) {
      throw new RangeError(`generated-water basin ${basin.id} exceeds the hole cap`);
    }
    for (let hole = 0; hole < basin.footprint.holes.length; hole++) {
      basinPoints += inspectRing(basin.footprint.holes[hole], `generated-water basin ${basin.id} hole ${hole}`);
    }
    if (basinPoints > WATER_LIMITS.totalBodyPoints) throw new RangeError("generated-water basin topology exceeds the total point cap");
  }
  ids.clear();
  for (let reachIndex = 0; reachIndex < topology.reaches.length; reachIndex++) {
    const reach = topology.reaches[reachIndex];
    if (reach.id.length > 64 || !GENERATED_REACH_ID.test(reach.id) || ids.has(reach.id)) throw new TypeError(`generated-water reach ${reachIndex} id is invalid or duplicated`);
    ids.add(reach.id);
    if (reach.class !== "stream" && reach.class !== "river") throw new TypeError(`generated-water reach ${reach.id} class is unsupported`);
    integer(reach.order, 1, WATER_LIMITS.streamOrder, `generated-water reach ${reach.id} order`);
    if (!Array.isArray(reach.points) || reach.points.length < 2 || reach.points.length > WATER_LIMITS.waterwayPoints) {
      throw new RangeError(`generated-water reach ${reach.id} point count is outside supported bounds`);
    }
    if (!Array.isArray(reach.widths) || !Array.isArray(reach.terrainElevationsM)
        || !Array.isArray(reach.surfaceElevationsM) || reach.widths.length !== reach.points.length
        || reach.terrainElevationsM.length !== reach.points.length || reach.surfaceElevationsM.length !== reach.points.length) {
      throw new RangeError(`generated-water reach ${reach.id} attributes are not point-aligned`);
    }
    for (let point = 0; point < reach.points.length; point++) {
      inspectPoint(reach.points[point], `generated-water reach ${reach.id} point ${point}`);
      const width = positive(reach.widths[point], `generated-water reach ${reach.id} width ${point}`);
      if (width > WATER_LIMITS.widthM) throw new RangeError(`generated-water reach ${reach.id} width ${point} exceeds the cap`);
      const terrain = finite(reach.terrainElevationsM[point], `generated-water reach ${reach.id} terrain elevation ${point}`);
      const surface = finite(reach.surfaceElevationsM[point], `generated-water reach ${reach.id} surface elevation ${point}`);
      if (surface < terrain) throw new RangeError(`generated-water reach ${reach.id} surface is below terrain at point ${point}`);
      if (point > 0) {
        const prior = reach.points[point - 1];
        if (prior[0] === reach.points[point][0] && prior[1] === reach.points[point][1]) {
          throw new RangeError(`generated-water reach ${reach.id} has duplicate consecutive points`);
        }
      }
    }
    reachPoints += reach.points.length;
    if (reachPoints > WATER_LIMITS.totalWaterwayPoints) throw new RangeError("generated-water reaches exceed the total point cap");
    if (!Array.isArray(reach.waterfalls)) throw new TypeError(`generated-water reach ${reach.id} waterfalls must be an array`);
    let priorEnd = 0;
    for (let spanIndex = 0; spanIndex < reach.waterfalls.length; spanIndex++) {
      const span = reach.waterfalls[spanIndex];
      const start = integer(span.startSegment, 0, reach.points.length - 2, `generated-water waterfall ${reach.id}/${spanIndex} startSegment`);
      const end = integer(span.endSegmentExclusive, 1, reach.points.length - 1, `generated-water waterfall ${reach.id}/${spanIndex} endSegmentExclusive`);
      if (start < priorEnd || end <= start) throw new RangeError(`generated-water waterfall spans for ${reach.id} overlap or are empty`);
      positive(span.totalDropM, `generated-water waterfall ${reach.id}/${spanIndex} totalDropM`);
      priorEnd = end;
      waterfallCount++;
      if (waterfallCount > WATER_LIMITS.totalWaterwayPoints) throw new RangeError("generated-water waterfall spans exceed the total cap");
    }
  }
  return { waterfallCount };
}

function snapshotPoint(point: WaterPoint2): WaterPoint2 {
  return Object.freeze([point[0], point[1]] as const);
}

function snapshotResource(resource: VerifiedGeneratedWaterRenderResource): { basins: readonly BasinSnapshot[]; reaches: readonly ReachSnapshot[] } {
  const basins = resource.topology.basins.map((basin) => Object.freeze({
    id: basin.id,
    spillLevelM: basin.spillLevelM,
    outer: Object.freeze(basin.footprint.points.map(snapshotPoint)),
    holes: Object.freeze(basin.footprint.holes.map((ring) => Object.freeze(ring.map(snapshotPoint)))),
  }));
  const reaches = resource.topology.reaches.map((reach) => Object.freeze({
    id: reach.id,
    class: reach.class,
    order: reach.order,
    points: Object.freeze(reach.points.map(snapshotPoint)),
    widths: Object.freeze([...reach.widths]),
    terrainElevationsM: Object.freeze([...reach.terrainElevationsM]),
    surfaceElevationsM: Object.freeze([...reach.surfaceElevationsM]),
    waterfalls: Object.freeze(reach.waterfalls.map((span) => Object.freeze({
      startSegment: span.startSegment,
      endSegmentExclusive: span.endSegmentExclusive,
      totalDropM: span.totalDropM,
    }))),
  }));
  return { basins: Object.freeze(basins), reaches: Object.freeze(reaches) };
}

function basinMesh(basin: BasinSnapshot, quality: Readonly<WaterRenderQuality>): THREE.Mesh {
  const built = buildWaterFootprintGeometry({ outer: basin.outer, holes: basin.holes });
  let material: THREE.Material | undefined;
  try {
    material = createWaterMaterial({ color: WATER_COLOR, kind: "basin", orientation: "xz", waveCount: quality.waveCount });
    const mesh = new THREE.Mesh(built.geometry, material);
    mesh.position.set(built.origin[0], basin.spillLevelM, built.origin[1]);
    mesh.name = "limina:generated-water-basin";
    mesh.renderOrder = 2;
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    return mesh;
  } catch (error) {
    material?.dispose();
    built.geometry.dispose();
    throw error;
  }
}

function reachMesh(reach: ReachSnapshot, quality: Readonly<WaterRenderQuality>): THREE.Mesh {
  const built = buildVariableRiverRibbonGeometry({
    points: reach.points,
    widthsM: reach.widths,
    surfaceElevationsM: reach.surfaceElevationsM,
  });
  let material: THREE.Material | undefined;
  try {
    material = createWaterMaterial({ color: WATER_COLOR, kind: "river", orientation: "xz", waveCount: quality.waveCount });
    const mesh = new THREE.Mesh(built.geometry, material);
    mesh.position.set(built.origin[0], built.origin[1], built.origin[2]);
    mesh.name = "limina:generated-water-reach";
    mesh.renderOrder = 3;
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    return mesh;
  } catch (error) {
    material?.dispose();
    built.geometry.dispose();
    throw error;
  }
}

function waterfallGeometry(reach: ReachSnapshot, span: WaterfallSnapshot): THREE.BufferGeometry {
  const endPoint = reach.points[span.endSegmentExclusive];
  const directionPoint = reach.points[span.endSegmentExclusive - 1];
  const dx = endPoint[0] - directionPoint[0];
  const dz = endPoint[1] - directionPoint[1];
  const directionLength = Math.hypot(dx, dz);
  if (!(directionLength > 0)) throw new RangeError(`generated-water waterfall in ${reach.id} has no final direction`);
  const halfWidth = reach.widths[span.endSegmentExclusive] / 2;
  const offsetX = -dz / directionLength * halfWidth;
  const offsetZ = dx / directionLength * halfWidth;
  let topY = reach.surfaceElevationsM[span.startSegment];
  let bottomY = reach.surfaceElevationsM[span.endSegmentExclusive];
  if (!(topY > bottomY)) {
    topY = reach.terrainElevationsM[span.startSegment];
    bottomY = reach.terrainElevationsM[span.endSegmentExclusive];
  }
  if (!(topY > bottomY)) throw new RangeError(`generated-water waterfall in ${reach.id} has no vertical drop`);
  const originX = endPoint[0];
  const originY = (topY + bottomY) / 2;
  const originZ = endPoint[1];
  const positions = new Float32Array([
    offsetX, topY - originY, offsetZ,
    -offsetX, topY - originY, -offsetZ,
    offsetX, bottomY - originY, offsetZ,
    -offsetX, bottomY - originY, -offsetZ,
  ]);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute("waterArcDistance", new THREE.Float32BufferAttribute([0, 0, span.totalDropM, span.totalDropM], 1));
  geometry.setAttribute("waterFlowDirection", new THREE.Float32BufferAttribute([
    dx / directionLength, dz / directionLength,
    dx / directionLength, dz / directionLength,
    dx / directionLength, dz / directionLength,
    dx / directionLength, dz / directionLength,
  ], 2));
  // The first face points upstream; DoubleSide rendering still covers downstream views.
  geometry.setIndex([0, 1, 2, 2, 1, 3]);
  geometry.computeVertexNormals();
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  geometry.userData.generatedWaterOrigin = Object.freeze([originX, originY, originZ]);
  return geometry;
}

function waterfallMesh(reach: ReachSnapshot, span: WaterfallSnapshot, quality: Readonly<WaterRenderQuality>): THREE.Mesh {
  const geometry = waterfallGeometry(reach, span);
  let material: THREE.Material | undefined;
  try {
    material = createWaterMaterial({ color: WATER_COLOR, kind: "river", orientation: "xz", waveCount: quality.waveCount });
    const mesh = new THREE.Mesh(geometry, material);
    const origin = geometry.userData.generatedWaterOrigin as readonly [number, number, number];
    mesh.position.set(origin[0], origin[1], origin[2]);
    mesh.name = "limina:generated-water-waterfall";
    mesh.renderOrder = 4;
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    return mesh;
  } catch (error) {
    material?.dispose();
    geometry.dispose();
    throw error;
  }
}

function descriptors(resource: VerifiedGeneratedWaterRenderResource): readonly MountDescriptor[] {
  const snapshot = snapshotResource(resource);
  const result: MountDescriptor[] = [];
  for (const basin of snapshot.basins) {
    const key = `generated:${resource.artifactHash}:basin:${basin.id}`;
    result.push(Object.freeze({
      key,
      kind: "basin" as const,
      identity: key,
      metadata: Object.freeze({ source: "generated-hydrology", feature: "basin", artifactHash: resource.artifactHash, basinId: basin.id }),
      create: (quality: Readonly<WaterRenderQuality>) => basinMesh(basin, quality),
    }));
  }
  for (const reach of snapshot.reaches) {
    const key = `generated:${resource.artifactHash}:reach:${reach.id}`;
    result.push(Object.freeze({
      key,
      kind: "river" as const,
      identity: key,
      metadata: Object.freeze({ source: "generated-hydrology", feature: "reach", artifactHash: resource.artifactHash,
        reachId: reach.id, class: reach.class, order: reach.order, gameplayAuthority: false }),
      create: (quality: Readonly<WaterRenderQuality>) => reachMesh(reach, quality),
    }));
    for (let spanIndex = 0; spanIndex < reach.waterfalls.length; spanIndex++) {
      const span = reach.waterfalls[spanIndex];
      const waterfallKey = `generated:${resource.artifactHash}:waterfall:${reach.id}:${spanIndex}`;
      result.push(Object.freeze({
        key: waterfallKey,
        kind: "river" as const,
        identity: waterfallKey,
        metadata: Object.freeze({ source: "generated-hydrology", feature: "waterfall", artifactHash: resource.artifactHash,
          reachId: reach.id, spanIndex, gameplayAuthority: false }),
        create: (quality: Readonly<WaterRenderQuality>) => waterfallMesh(reach, span, quality),
      }));
    }
  }
  return Object.freeze(result);
}

/** Mount generated hydrology as render-only fragments. The caller retains gameplay/contact authority elsewhere. */
export function mountGeneratedWaterResource(
  resource: VerifiedGeneratedWaterRenderResource,
  manager: VisibleWaterManager,
): GeneratedWaterRenderMount {
  const counts = inspectResource(resource, manager);
  const planned = descriptors(resource);
  const current = new Map(manager.entries().map((entry) => [entry.key, entry]));
  const keys = new Set<string>();
  let newMounts = 0;
  for (const descriptor of planned) {
    if (keys.has(descriptor.key)) throw new Error(`generated-water semantic key '${descriptor.key}' is duplicated`);
    keys.add(descriptor.key);
    const existing = current.get(descriptor.key);
    if (existing === undefined) newMounts++;
    else if (existing.kind !== descriptor.kind || existing.identity !== descriptor.identity) {
      throw new Error(`generated-water semantic key '${descriptor.key}' conflicts with a mounted fragment`);
    }
  }
  if (manager.size + newMounts > manager.quality.maxResidentFragments) {
    throw new RangeError("generated-water resource no longer fits the visible-water resident budget");
  }
  const mountedKeys: string[] = [];
  try {
    for (const descriptor of planned) {
      const mount = manager.mount(descriptor.key, descriptor.kind, descriptor.create, descriptor.metadata, descriptor.identity);
      if (mount.mounted) mountedKeys.push(descriptor.key);
    }
  } catch (error) {
    const rollbackErrors: unknown[] = [];
    for (let index = mountedKeys.length - 1; index >= 0; index--) {
      try { manager.remove(mountedKeys[index]); } catch (rollbackError) { rollbackErrors.push(rollbackError); }
    }
    if (rollbackErrors.length > 0) throw new AggregateError([error, ...rollbackErrors], "generated-water mount and rollback failed");
    throw error;
  }
  let disposed = false;
  const stableKeys = Object.freeze(planned.map((descriptor) => descriptor.key));
  const stableMountedKeys = Object.freeze([...mountedKeys]);
  return Object.freeze({
    artifactHash: resource.artifactHash,
    keys: stableKeys,
    mountedKeys: stableMountedKeys,
    basinCount: resource.topology.basins.length,
    reachCount: resource.topology.reaches.length,
    waterfallCount: counts.waterfallCount,
    dispose(): void {
      if (disposed) return;
      const errors: unknown[] = [];
      for (let index = stableMountedKeys.length - 1; index >= 0; index--) {
        try { manager.remove(stableMountedKeys[index]); } catch (error) { errors.push(error); }
      }
      if (errors.length > 0) throw new AggregateError(errors, "generated-water disposal failed");
      disposed = true;
    },
  });
}
