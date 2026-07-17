import * as THREE from "../../../build/three.bundle.mjs";
import type { WaterRenderQuality } from "../quality.ts";
import {
  HYDROLOGY_COMBINED_WATER_TOPOLOGY_SCHEMA,
  HYDROLOGY_COMBINED_WATER_TOPOLOGY_VERSION,
} from "../../world/hydrology-water-topology.mjs";
import { WATER_LIMITS } from "../../world/water-ir.mjs";
import { smoothRiverPresentationReach } from "../../world/river-presentation-curve.mjs";
import { buildVariableRiverRibbonGeometry, buildWaterFootprintGeometry, type WaterPoint2 } from "./geometry.ts";
import { attachWaterMaterialAuxiliaries, createWaterMaterial, createWaterfallMaterial } from "./material.ts";
import { VisibleWaterManager, type VisibleWaterKind } from "./visible-water-manager.ts";

const GENERATED_BASIN_ID = /^gen-b-[0-9a-z]+-[0-9a-z]+$/;
const GENERATED_REACH_ID = /^gen-r-[0-9a-z]+-[0-9a-z]+$/;
const CONTENT_HASH = /^sha256:[0-9a-f]{64}$/;
// Temperate water body colour is deliberately dark and low-saturation. Sky/terrain reflection
// and verified depth transmission provide the visible colour; a bright cyan base recreates the
// flat blue veneer even when the optical graph is otherwise correct.
const WATER_COLOR = 0x173f43;
const presentationReachCache = new WeakMap<object, ReturnType<typeof smoothRiverPresentationReach>>();

function presentationReach<T extends object>(reach: T): ReturnType<typeof smoothRiverPresentationReach> {
  const cached = presentationReachCache.get(reach); if (cached !== undefined) return cached;
  const smoothed = smoothRiverPresentationReach(reach);
  presentationReachCache.set(reach, smoothed); return smoothed;
}

export interface GeneratedWaterfallSpanView {
  readonly startSegment: number;
  readonly endSegmentExclusive: number;
  readonly totalDropM: number;
}

export interface GeneratedBasinView {
  readonly id: string;
  readonly spillLevelM: number;
  readonly maxDepthM: number;
  readonly footprint: {
    readonly points: readonly WaterPoint2[];
    readonly holes: readonly (readonly WaterPoint2[])[];
  };
}

export interface GeneratedWaterFieldView {
  readonly placement: { readonly originX: number; readonly originZ: number };
  readonly rows: number;
  readonly cols: number;
  readonly cellSizeM: number;
  /** Descriptor-verified hydrology sea level; presentation consumers must not infer it from codec bounds. */
  readonly seaLevelM: number;
  readonly oceanMask: Uint8Array;
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
  /** Descriptor-verified hydrology domain used to reject pixels outside this water artifact's field. */
  readonly field: GeneratedWaterFieldView;
  /** Exact resident derived-terrain sampler. Missing tiles produce transparent water, never guessed depth. */
  readonly sampleTerrainHeight: (x: number, z: number) => number | null;
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

function pointInWaterRing(points: readonly WaterPoint2[], x: number, z: number): boolean {
  let inside = false;
  for (let index = 0, prior = points.length - 1; index < points.length; prior = index++) {
    const a = points[index], b = points[prior];
    if ((a[1] > z) !== (b[1] > z)
        && x < (b[0] - a[0]) * (z - a[1]) / (b[1] - a[1]) + a[0]) inside = !inside;
  }
  return inside;
}

/** Exact CPU-side semantic water coverage for vegetation exclusion and other presentation masks.
 * It consumes only a binding-verified render resource; callers cannot invent a second river path. */
export function generatedWaterCoversPoint(
  resource: VerifiedGeneratedWaterRenderResource,
  x: number,
  z: number,
  marginM = 0,
): boolean {
  if (!Number.isFinite(x) || !Number.isFinite(z) || !Number.isFinite(marginM) || marginM < 0) {
    throw new RangeError("generated-water coverage query must be finite with a non-negative margin");
  }
  const field = resource.field;
  const col = Math.round((x - field.placement.originX) / field.cellSizeM);
  const row = Math.round((z - field.placement.originZ) / field.cellSizeM);
  if (row >= 0 && row < field.rows && col >= 0 && col < field.cols
      && field.oceanMask[row * field.cols + col] !== 0) return true;
  for (const basin of resource.topology.basins) {
    if (pointInWaterRing(basin.footprint.points, x, z)
        && !basin.footprint.holes.some((hole) => pointInWaterRing(hole, x, z))) return true;
  }
  for (const sourceReach of resource.topology.reaches) {
    const reach = presentationReach(sourceReach);
    for (let segment = 0; segment < reach.points.length - 1; segment++) {
      const a = reach.points[segment], b = reach.points[segment + 1];
      const dx = b[0] - a[0], dz = b[1] - a[1], length2 = dx * dx + dz * dz;
      const t = length2 === 0 ? 0 : Math.max(0, Math.min(1, ((x - a[0]) * dx + (z - a[1]) * dz) / length2));
      const px = a[0] + dx * t, pz = a[1] + dz * t;
      const width = reach.widths[segment] + (reach.widths[segment + 1] - reach.widths[segment]) * t;
      if (Math.hypot(x - px, z - pz) <= width / 2 + marginM) return true;
    }
  }
  return false;
}

interface BasinSnapshot {
  readonly id: string;
  readonly spillLevelM: number;
  readonly maxDepthM: number;
  readonly outer: readonly WaterPoint2[];
  readonly holes: readonly (readonly WaterPoint2[])[];
}

interface FieldSnapshot {
  readonly originX: number;
  readonly originZ: number;
  readonly rows: number;
  readonly cols: number;
  readonly cellSizeM: number;
  readonly seaLevelM: number;
  readonly oceanMask: Uint8Array;
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
  readonly waterfallSource: Readonly<{
    points: readonly WaterPoint2[]; widths: readonly number[];
    terrainElevationsM: readonly number[]; surfaceElevationsM: readonly number[];
  }>;
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
  if (typeof resource.sampleTerrainHeight !== "function") throw new TypeError("generated-water terrain sampler must be a function");
  const field = resource.field;
  if (field === null || typeof field !== "object") throw new TypeError("generated-water field must be an object");
  finite(field.placement?.originX, "generated-water field originX");
  finite(field.placement?.originZ, "generated-water field originZ");
  integer(field.rows, 2, 1025, "generated-water field rows");
  integer(field.cols, 2, 1025, "generated-water field cols");
  positive(field.cellSizeM, "generated-water field cellSizeM");
  finite(field.seaLevelM, "generated-water field seaLevelM");
  if (!(field.oceanMask instanceof Uint8Array) || field.oceanMask.length !== field.rows * field.cols) {
    throw new RangeError("generated-water field ocean mask does not match its dimensions");
  }
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
    positive(basin.maxDepthM, `generated-water basin ${basin.id} maxDepthM`);
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

function snapshotResource(resource: VerifiedGeneratedWaterRenderResource): {
  basins: readonly BasinSnapshot[];
  reaches: readonly ReachSnapshot[];
  field: FieldSnapshot;
  sampleTerrainHeight: (x: number, z: number) => number | null;
} {
  const basins = resource.topology.basins.map((basin) => Object.freeze({
    id: basin.id,
    spillLevelM: basin.spillLevelM,
    maxDepthM: basin.maxDepthM,
    outer: Object.freeze(basin.footprint.points.map(snapshotPoint)),
    holes: Object.freeze(basin.footprint.holes.map((ring) => Object.freeze(ring.map(snapshotPoint)))),
  }));
  const reaches = resource.topology.reaches.map((reach) => {
    const smoothed = presentationReach(reach);
    return Object.freeze({
    id: reach.id,
    class: reach.class,
    order: reach.order,
    points: Object.freeze(smoothed.points.map(snapshotPoint)),
    widths: Object.freeze([...smoothed.widths]),
    terrainElevationsM: Object.freeze([...smoothed.terrainElevationsM]),
    surfaceElevationsM: Object.freeze([...smoothed.surfaceElevationsM]),
    waterfallSource: Object.freeze({ points: Object.freeze(reach.points.map(snapshotPoint)),
      widths: Object.freeze([...reach.widths]), terrainElevationsM: Object.freeze([...reach.terrainElevationsM]),
      surfaceElevationsM: Object.freeze([...reach.surfaceElevationsM]) }),
    waterfalls: Object.freeze(reach.waterfalls.map((span) => Object.freeze({
      startSegment: span.startSegment,
      endSegmentExclusive: span.endSegmentExclusive,
      totalDropM: span.totalDropM,
    }))),
  }); });
  const field = Object.freeze({
    originX: resource.field.placement.originX,
    originZ: resource.field.placement.originZ,
    rows: resource.field.rows,
    cols: resource.field.cols,
    cellSizeM: resource.field.cellSizeM,
    seaLevelM: resource.field.seaLevelM,
    oceanMask: resource.field.oceanMask.slice(),
  });
  return {
    basins: Object.freeze(basins),
    reaches: Object.freeze(reaches),
    field,
    sampleTerrainHeight: resource.sampleTerrainHeight,
  };
}

function basinBounds(basin: BasinSnapshot): Readonly<{ minX: number; minZ: number; maxX: number; maxZ: number }> {
  let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
  for (const point of basin.outer) {
    minX = Math.min(minX, point[0]); minZ = Math.min(minZ, point[1]);
    maxX = Math.max(maxX, point[0]); maxZ = Math.max(maxZ, point[1]);
  }
  return Object.freeze({ minX, minZ, maxX, maxZ });
}

function rasterizeRing(
  coverage: Uint8Array,
  ring: readonly WaterPoint2[],
  bounds: Readonly<{ minX: number; minZ: number; maxX: number; maxZ: number }>,
  resolution: number,
  value: number,
): void {
  const intersections: number[] = [];
  const spanX = bounds.maxX - bounds.minX, spanZ = bounds.maxZ - bounds.minZ;
  for (let row = 0; row < resolution; row++) {
    const z = bounds.minZ + (row + 0.5) / resolution * spanZ;
    intersections.length = 0;
    for (let current = 0, previous = ring.length - 1; current < ring.length; previous = current++) {
      const a = ring[current], b = ring[previous];
      if ((a[1] > z) !== (b[1] > z)) intersections.push((b[0] - a[0]) * (z - a[1]) / (b[1] - a[1]) + a[0]);
    }
    intersections.sort((left, right) => left - right);
    for (let edge = 0; edge + 1 < intersections.length; edge += 2) {
      const first = Math.max(0, Math.ceil((intersections[edge] - bounds.minX) / spanX * resolution - 0.5));
      const last = Math.min(resolution - 1, Math.floor((intersections[edge + 1] - bounds.minX) / spanX * resolution - 0.5));
      for (let col = first; col <= last; col++) coverage[row * resolution + col] = value;
    }
  }
}

function rasterizeFootprint(
  basin: BasinSnapshot,
  bounds: Readonly<{ minX: number; minZ: number; maxX: number; maxZ: number }>,
  resolution: number,
): Uint8Array {
  const coverage = new Uint8Array(resolution * resolution);
  rasterizeRing(coverage, basin.outer, bounds, resolution, 1);
  for (const hole of basin.holes) rasterizeRing(coverage, hole, bounds, resolution, 0);
  return coverage;
}

function depthRasterDimension(quality: Readonly<WaterRenderQuality>, bodyCount: number): number {
  const perBodyPixels = Math.max(16, Math.floor(quality.depthTextureBudgetPixels / Math.max(1, bodyCount)));
  return Math.max(4, Math.min(quality.depthRasterSize, Math.floor(Math.sqrt(perBodyPixels))));
}

/** Build an owned RG raster: R=normalized true water-column depth, G=semantic coverage. */
export function buildGeneratedBasinDepthTexture(
  basin: BasinSnapshot,
  field: FieldSnapshot,
  sampleTerrainHeight: (x: number, z: number) => number | null,
  resolution: number,
): Readonly<{ texture: THREE.DataTexture; bounds: Readonly<{ minX: number; minZ: number; maxX: number; maxZ: number }>; maxDepthM: number }> {
  integer(resolution, 4, 256, "generated-water basin depth resolution");
  const bounds = basinBounds(basin);
  if (!(bounds.maxX > bounds.minX) || !(bounds.maxZ > bounds.minZ)) throw new RangeError("generated-water basin has empty depth bounds");
  const data = new Uint8Array(resolution * resolution * 2);
  const semanticCoverage = rasterizeFootprint(basin, bounds, resolution);
  const fieldMaxX = field.originX + (field.cols - 1) * field.cellSizeM;
  const fieldMaxZ = field.originZ + (field.rows - 1) * field.cellSizeM;
  for (let row = 0; row < resolution; row++) {
    const z = bounds.minZ + (row + 0.5) / resolution * (bounds.maxZ - bounds.minZ);
    for (let col = 0; col < resolution; col++) {
      const x = bounds.minX + (col + 0.5) / resolution * (bounds.maxX - bounds.minX);
      if (semanticCoverage[row * resolution + col] === 0
          || x < field.originX || x > fieldMaxX || z < field.originZ || z > fieldMaxZ) continue;
      const fieldCol = Math.max(0, Math.min(field.cols - 1, Math.round((x - field.originX) / field.cellSizeM)));
      const fieldRow = Math.max(0, Math.min(field.rows - 1, Math.round((z - field.originZ) / field.cellSizeM)));
      if (field.oceanMask[fieldRow * field.cols + fieldCol] !== 0) continue;
      const terrainY = sampleTerrainHeight(x, z);
      if (terrainY === null || !Number.isFinite(terrainY)) continue;
      const depthM = basin.spillLevelM - terrainY;
      if (!(depthM > 0)) continue;
      const offset = (row * resolution + col) * 2;
      data[offset] = Math.max(1, Math.min(255, Math.round(depthM / basin.maxDepthM * 255)));
      data[offset + 1] = 255;
    }
  }
  const texture = new THREE.DataTexture(data, resolution, resolution, THREE.RGFormat, THREE.UnsignedByteType);
  texture.name = `limina:generated-water-depth:${basin.id}`;
  texture.wrapS = texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.minFilter = texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = false;
  texture.flipY = false;
  texture.needsUpdate = true;
  return Object.freeze({ texture, bounds, maxDepthM: basin.maxDepthM });
}

function basinMesh(
  basin: BasinSnapshot,
  field: FieldSnapshot,
  sampleTerrainHeight: (x: number, z: number) => number | null,
  bodyCount: number,
  quality: Readonly<WaterRenderQuality>,
): THREE.Mesh {
  const built = buildWaterFootprintGeometry({ outer: basin.outer, holes: basin.holes });
  const depth = buildGeneratedBasinDepthTexture(
    basin, field, sampleTerrainHeight, depthRasterDimension(quality, bodyCount),
  );
  let material: THREE.Material | undefined;
  try {
    material = createWaterMaterial({
      color: WATER_COLOR,
      kind: "basin",
      orientation: "xz",
      waveCount: quality.waveCount,
      depth: { texture: depth.texture, bounds: depth.bounds, coverageChannel: true, maxDepthM: depth.maxDepthM },
      sceneOptics: quality.sceneOptics,
      reflectionScale: quality.sceneOptics === "refraction-reflection" ? 0.35 : undefined,
    });
    const mesh = new THREE.Mesh(built.geometry, material);
    attachWaterMaterialAuxiliaries(mesh);
    mesh.position.set(built.origin[0], basin.spillLevelM, built.origin[1]);
    mesh.name = "limina:generated-water-basin";
    mesh.renderOrder = 2;
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    return mesh;
  } catch (error) {
    if (material === undefined) depth.texture.dispose();
    material?.dispose();
    built.geometry.dispose();
    throw error;
  }
}

/** Low-pass only the presentation depth signal inside semantic coverage. Generated channel beds
 * are sampled on the compiler grid; exposing their point-to-point noise directly as opacity and
 * colour creates visible cross-river panels. Coverage and topology are never blurred. */
function smoothReachPresentationDepth(raw: Float64Array, resolution: number): Float64Array {
  let source = raw;
  for (let pass = 0; pass < 2; pass++) {
    const target = new Float64Array(raw.length);
    for (let row = 0; row < resolution; row++) for (let col = 0; col < resolution; col++) {
      const pixel = row * resolution + col;
      if (!(source[pixel] > 0)) continue;
      let sum = 0, weight = 0;
      for (let dz = -2; dz <= 2; dz++) for (let dx = -2; dx <= 2; dx++) {
        const sampleRow = row + dz, sampleCol = col + dx;
        if (sampleRow < 0 || sampleRow >= resolution || sampleCol < 0 || sampleCol >= resolution) continue;
        const value = source[sampleRow * resolution + sampleCol];
        if (!(value > 0)) continue;
        const sampleWeight = 1 / (1 + dx * dx + dz * dz);
        sum += value * sampleWeight; weight += sampleWeight;
      }
      target[pixel] = weight > 0 ? sum / weight : source[pixel];
    }
    source = target;
  }
  return source;
}

/** Build an owned RG raster for the exact variable-width reach: R=smoothed terrain-derived
 * presentation depth, G=unmodified semantic coverage. */
export function buildGeneratedReachDepthTexture(
  reach: ReachSnapshot,
  field: FieldSnapshot,
  sampleTerrainHeight: (x: number, z: number) => number | null,
  resolution: number,
): Readonly<{ texture: THREE.DataTexture; bounds: Readonly<{ minX: number; minZ: number; maxX: number; maxZ: number }>; maxDepthM: number }> {
  integer(resolution, 4, 256, "generated-water reach depth resolution");
  let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
  for (let index = 0; index < reach.points.length; index++) {
    const radius = reach.widths[index] / 2, point = reach.points[index];
    minX = Math.min(minX, point[0] - radius); maxX = Math.max(maxX, point[0] + radius);
    minZ = Math.min(minZ, point[1] - radius); maxZ = Math.max(maxZ, point[1] + radius);
  }
  if (!(maxX > minX) || !(maxZ > minZ)) throw new RangeError("generated-water reach has empty depth bounds");
  const bounds = Object.freeze({ minX, minZ, maxX, maxZ });
  const pixelCount = resolution * resolution;
  const ownerDistance = new Float64Array(pixelCount); ownerDistance.fill(Infinity);
  const surface = new Float64Array(pixelCount);
  const spanX = maxX - minX, spanZ = maxZ - minZ;
  for (let segment = 0; segment < reach.points.length - 1; segment++) {
    const a = reach.points[segment], b = reach.points[segment + 1];
    const dx = b[0] - a[0], dz = b[1] - a[1], length2 = dx * dx + dz * dz;
    const radius = Math.max(reach.widths[segment], reach.widths[segment + 1]) / 2;
    const firstCol = Math.max(0, Math.floor((Math.min(a[0], b[0]) - radius - minX) / spanX * resolution));
    const lastCol = Math.min(resolution - 1, Math.ceil((Math.max(a[0], b[0]) + radius - minX) / spanX * resolution));
    const firstRow = Math.max(0, Math.floor((Math.min(a[1], b[1]) - radius - minZ) / spanZ * resolution));
    const lastRow = Math.min(resolution - 1, Math.ceil((Math.max(a[1], b[1]) + radius - minZ) / spanZ * resolution));
    for (let row = firstRow; row <= lastRow; row++) for (let col = firstCol; col <= lastCol; col++) {
      const x = minX + (col + 0.5) / resolution * spanX, z = minZ + (row + 0.5) / resolution * spanZ;
      const t = length2 === 0 ? 0 : Math.max(0, Math.min(1, ((x - a[0]) * dx + (z - a[1]) * dz) / length2));
      const px = a[0] + dx * t, pz = a[1] + dz * t, distance = Math.hypot(x - px, z - pz);
      const width = reach.widths[segment] + (reach.widths[segment + 1] - reach.widths[segment]) * t;
      const pixel = row * resolution + col;
      if (distance <= width / 2 && distance < ownerDistance[pixel]) {
        ownerDistance[pixel] = distance;
        surface[pixel] = reach.surfaceElevationsM[segment]
          + (reach.surfaceElevationsM[segment + 1] - reach.surfaceElevationsM[segment]) * t;
      }
    }
  }
  const rawDepth = new Float64Array(pixelCount);
  const fieldMaxX = field.originX + (field.cols - 1) * field.cellSizeM;
  const fieldMaxZ = field.originZ + (field.rows - 1) * field.cellSizeM;
  let maximumDepth = 0;
  for (let row = 0; row < resolution; row++) for (let col = 0; col < resolution; col++) {
    const pixel = row * resolution + col;
    if (!Number.isFinite(ownerDistance[pixel])) continue;
    const x = minX + (col + 0.5) / resolution * spanX, z = minZ + (row + 0.5) / resolution * spanZ;
    if (x < field.originX || x > fieldMaxX || z < field.originZ || z > fieldMaxZ) continue;
    const fieldCol = Math.max(0, Math.min(field.cols - 1, Math.round((x - field.originX) / field.cellSizeM)));
    const fieldRow = Math.max(0, Math.min(field.rows - 1, Math.round((z - field.originZ) / field.cellSizeM)));
    if (field.oceanMask[fieldRow * field.cols + fieldCol] !== 0) continue;
    const terrainY = sampleTerrainHeight(x, z);
    if (terrainY === null || !Number.isFinite(terrainY)) continue;
    const depth = surface[pixel] - terrainY;
    if (depth > 0) { rawDepth[pixel] = depth; maximumDepth = Math.max(maximumDepth, depth); }
  }
  const presentationDepth = smoothReachPresentationDepth(rawDepth, resolution);
  maximumDepth = 0;
  for (const depth of presentationDepth) maximumDepth = Math.max(maximumDepth, depth);
  const data = new Uint8Array(pixelCount * 2);
  const scale = Math.max(0.25, maximumDepth);
  for (let pixel = 0; pixel < pixelCount; pixel++) if (presentationDepth[pixel] > 0) {
    data[pixel * 2] = Math.max(1, Math.min(255, Math.round(presentationDepth[pixel] / scale * 255)));
    data[pixel * 2 + 1] = 255;
  }
  const texture = new THREE.DataTexture(data, resolution, resolution, THREE.RGFormat, THREE.UnsignedByteType);
  texture.name = `limina:generated-water-depth:${reach.id}`;
  texture.wrapS = texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.minFilter = texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = false; texture.flipY = false; texture.needsUpdate = true;
  return Object.freeze({ texture, bounds, maxDepthM: scale });
}

function reachMesh(
  reach: ReachSnapshot,
  field: FieldSnapshot,
  sampleTerrainHeight: (x: number, z: number) => number | null,
  bodyCount: number,
  quality: Readonly<WaterRenderQuality>,
): THREE.Mesh {
  const built = buildVariableRiverRibbonGeometry({
    points: reach.points,
    widthsM: reach.widths,
    surfaceElevationsM: reach.surfaceElevationsM,
  });
  const depth = buildGeneratedReachDepthTexture(reach, field, sampleTerrainHeight, depthRasterDimension(quality, bodyCount));
  let material: THREE.Material | undefined;
  try {
    material = createWaterMaterial({ color: WATER_COLOR, kind: "river", orientation: "xz", waveCount: quality.waveCount,
      depth: { texture: depth.texture, bounds: depth.bounds, coverageChannel: true, maxDepthM: depth.maxDepthM },
      sceneOptics: quality.sceneOptics });
    const mesh = new THREE.Mesh(built.geometry, material);
    attachWaterMaterialAuxiliaries(mesh);
    mesh.position.set(built.origin[0], built.origin[1], built.origin[2]);
    mesh.name = "limina:generated-water-reach";
    mesh.renderOrder = 3;
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    return mesh;
  } catch (error) {
    if (material === undefined) depth.texture.dispose();
    material?.dispose();
    built.geometry.dispose();
    throw error;
  }
}

function waterfallGeometry(reach: ReachSnapshot, span: WaterfallSnapshot): THREE.BufferGeometry {
  const source = reach.waterfallSource;
  const endPoint = source.points[span.endSegmentExclusive];
  const directionPoint = source.points[span.endSegmentExclusive - 1];
  const dx = endPoint[0] - directionPoint[0];
  const dz = endPoint[1] - directionPoint[1];
  const directionLength = Math.hypot(dx, dz);
  if (!(directionLength > 0)) throw new RangeError(`generated-water waterfall in ${reach.id} has no final direction`);
  const halfWidth = source.widths[span.endSegmentExclusive] / 2;
  const offsetX = -dz / directionLength * halfWidth;
  const offsetZ = dx / directionLength * halfWidth;
  let topY = source.surfaceElevationsM[span.startSegment];
  let bottomY = source.surfaceElevationsM[span.endSegmentExclusive];
  if (!(topY > bottomY)) {
    topY = source.terrainElevationsM[span.startSegment];
    bottomY = source.terrainElevationsM[span.endSegmentExclusive];
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
  let mesh: THREE.Mesh | undefined;
  try {
    material = createWaterfallMaterial("curtain");
    mesh = new THREE.Mesh(geometry, material);
    const origin = geometry.userData.generatedWaterOrigin as readonly [number, number, number];
    mesh.position.set(origin[0], origin[1], origin[2]);
    mesh.name = "limina:generated-water-waterfall";
    mesh.renderOrder = 4;
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    const bottomLocalY = -span.totalDropM / 2;
    const width = reach.waterfallSource.widths[span.endSegmentExclusive];
    if (quality.waterfallExtras === "foam" || quality.waterfallExtras === "foam-mist") {
      const foamGeometry = new THREE.CircleGeometry(Math.max(0.35, width * 0.62), Math.max(12, Math.min(32, quality.oceanSegments / 2)));
      foamGeometry.rotateX(-Math.PI / 2);
      const foamPositions = foamGeometry.getAttribute("position");
      const foamArc = new Float32Array(foamPositions.count);
      const foamFlow = new Float32Array(foamPositions.count * 2);
      for (let index = 0; index < foamPositions.count; index++) {
        foamArc[index] = Math.hypot(foamPositions.getX(index), foamPositions.getZ(index));
        foamFlow[index * 2] = 1;
      }
      foamGeometry.setAttribute("waterArcDistance", new THREE.BufferAttribute(foamArc, 1));
      foamGeometry.setAttribute("waterFlowDirection", new THREE.BufferAttribute(foamFlow, 2));
      const foam = new THREE.Mesh(foamGeometry, createWaterfallMaterial("foam"));
      foam.position.y = bottomLocalY + 0.035;
      foam.name = "limina:generated-water-waterfall-foam";
      foam.renderOrder = 5; foam.castShadow = false; foam.receiveShadow = false;
      mesh.add(foam);
    }
    if (quality.waterfallExtras === "foam-mist") {
      const mistHeight = Math.max(0.8, Math.min(span.totalDropM * 0.42, width * 1.25));
      const mistWidth = Math.max(1, width * 1.45);
      const positions = new Float32Array([
        -0.5, -0.5, 0, 0.5, -0.5, 0, -0.5, 0.5, 0, 0.5, 0.5, 0,
        0, -0.5, -0.5, 0, -0.5, 0.5, 0, 0.5, -0.5, 0, 0.5, 0.5,
      ]);
      const mistGeometry = new THREE.BufferGeometry();
      mistGeometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
      mistGeometry.setIndex([0, 1, 2, 2, 1, 3, 4, 5, 6, 6, 5, 7]);
      mistGeometry.computeVertexNormals(); mistGeometry.computeBoundingBox(); mistGeometry.computeBoundingSphere();
      const mist = new THREE.Mesh(mistGeometry, createWaterfallMaterial("mist"));
      mist.position.y = bottomLocalY + mistHeight * 0.46;
      mist.scale.set(mistWidth, mistHeight, mistWidth);
      mist.name = "limina:generated-water-waterfall-mist";
      mist.renderOrder = 6; mist.castShadow = false; mist.receiveShadow = false;
      mesh.add(mist);
    }
    mesh.userData.waterfallExtras = quality.waterfallExtras;
    return mesh;
  } catch (error) {
    if (mesh === undefined) {
      material?.dispose();
      geometry.dispose();
    } else {
      const materials = new Set<THREE.Material>(), geometries = new Set<THREE.BufferGeometry>();
      mesh.traverse((object) => { if (object instanceof THREE.Mesh) {
        geometries.add(object.geometry);
        for (const candidate of Array.isArray(object.material) ? object.material : [object.material]) materials.add(candidate);
      } });
      for (const candidate of materials) candidate.dispose();
      for (const candidate of geometries) candidate.dispose();
      mesh.clear();
    }
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
      create: (quality: Readonly<WaterRenderQuality>) => basinMesh(
        basin, snapshot.field, snapshot.sampleTerrainHeight, snapshot.basins.length, quality,
      ),
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
      create: (quality: Readonly<WaterRenderQuality>) => reachMesh(
        reach, snapshot.field, snapshot.sampleTerrainHeight, snapshot.basins.length + snapshot.reaches.length, quality,
      ),
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
