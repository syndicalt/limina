import * as THREE from "../../../build/three.bundle.mjs";
import { WATER_LIMITS } from "../../world/water-ir.mjs";

export type WaterPoint2 = readonly [number, number];

export interface WaterFootprintGeometryInput {
  outer: readonly WaterPoint2[];
  holes?: readonly (readonly WaterPoint2[])[];
}

export interface WaterFootprintGeometry {
  geometry: THREE.BufferGeometry;
  origin: readonly [number, number];
  bounds: Readonly<{ minX: number; minZ: number; maxX: number; maxZ: number }>;
}

export interface RiverRibbonGeometryInput {
  points: readonly WaterPoint2[];
  widthsM: readonly number[];
  surfaceElevationsM: readonly number[];
  miterLimit?: number;
}

export interface RiverRibbonGeometry {
  geometry: THREE.BufferGeometry;
  origin: readonly [number, number, number];
  pointCount: number;
  segmentCount: number;
  bevelJoinCount: number;
  lengthM: number;
}

interface CleanRiverPoint {
  x: number;
  z: number;
  widthM: number;
  elevationM: number;
}

interface JoinOffsets {
  incoming: [number, number];
  outgoing: [number, number];
  bevel: boolean;
  turn: number;
}

const DUPLICATE_EPSILON_M = 1e-7;
const DEFAULT_MITER_LIMIT = 4;

function finite(value: number, label: string): number {
  if (!Number.isFinite(value)) throw new TypeError(`${label} must be finite`);
  return Object.is(value, -0) ? 0 : value;
}

function point(value: WaterPoint2, label: string): [number, number] {
  if (!Array.isArray(value) || value.length !== 2) throw new TypeError(`${label} must be a 2-tuple`);
  return [finite(value[0], `${label}[0]`), finite(value[1], `${label}[1]`)];
}

function ring(value: readonly WaterPoint2[], label: string): [number, number][] {
  if (!Array.isArray(value) || value.length < 3 || value.length > WATER_LIMITS.ringPoints) {
    throw new RangeError(`${label} must contain 3-${WATER_LIMITS.ringPoints} points`);
  }
  const parsed = value.map((entry, index) => point(entry, `${label}[${index}]`));
  if (parsed.length > 3) {
    const first = parsed[0], last = parsed[parsed.length - 1];
    if (first[0] === last[0] && first[1] === last[1]) parsed.pop();
  }
  if (parsed.length < 3) throw new RangeError(`${label} collapses below three points`);
  return parsed;
}

/** Triangulate one already-validated WaterBody footprint in a feature-local coordinate frame. */
export function buildWaterFootprintGeometry(input: WaterFootprintGeometryInput): WaterFootprintGeometry {
  const outer = ring(input.outer, "water footprint outer");
  const holes = (input.holes ?? []).map((hole, index) => ring(hole, `water footprint hole ${index}`));
  if (holes.length > WATER_LIMITS.holes) throw new RangeError(`water footprint exceeds ${WATER_LIMITS.holes} holes`);
  const all = [outer, ...holes];
  const totalPoints = all.reduce((total, contour) => total + contour.length, 0);
  if (totalPoints > WATER_LIMITS.bodyPoints) throw new RangeError(`water footprint exceeds ${WATER_LIMITS.bodyPoints} points`);
  let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
  for (const contour of all) for (const [x, z] of contour) {
    minX = Math.min(minX, x); minZ = Math.min(minZ, z);
    maxX = Math.max(maxX, x); maxZ = Math.max(maxZ, z);
  }
  const originX = (minX + maxX) / 2;
  const originZ = (minZ + maxZ) / 2;
  const localOuter = outer.map(([x, z]) => new THREE.Vector2(x - originX, z - originZ));
  const localHoles = holes.map((contour) => contour.map(([x, z]) => new THREE.Vector2(x - originX, z - originZ)));
  const faces = THREE.ShapeUtils.triangulateShape(localOuter, localHoles);
  if (faces.length === 0) throw new Error("water footprint triangulation produced no faces");
  const vertices = [...localOuter, ...localHoles.flat()];
  const positions = new Float32Array(vertices.length * 3);
  const normals = new Float32Array(vertices.length * 3);
  const uvs = new Float32Array(vertices.length * 2);
  const spanX = Math.max(maxX - minX, Number.EPSILON);
  const spanZ = Math.max(maxZ - minZ, Number.EPSILON);
  for (let index = 0; index < vertices.length; index++) {
    const vertex = vertices[index];
    positions[index * 3] = vertex.x;
    positions[index * 3 + 1] = 0;
    positions[index * 3 + 2] = vertex.y;
    normals[index * 3 + 1] = 1;
    uvs[index * 2] = (vertex.x + originX - minX) / spanX;
    uvs[index * 2 + 1] = (vertex.y + originZ - minZ) / spanZ;
  }
  const indices = faces.flatMap((face) => [face[0], face[2], face[1]]);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute("normal", new THREE.BufferAttribute(normals, 3));
  geometry.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return {
    geometry,
    origin: Object.freeze([originX, originZ]),
    bounds: Object.freeze({ minX, minZ, maxX, maxZ }),
  };
}

function cleanRiver(input: RiverRibbonGeometryInput): CleanRiverPoint[] {
  if (!Array.isArray(input.points) || input.points.length < 2 || input.points.length > WATER_LIMITS.waterwayPoints) {
    throw new RangeError(`river points must contain 2-${WATER_LIMITS.waterwayPoints} entries`);
  }
  if (!Array.isArray(input.widthsM) || input.widthsM.length !== input.points.length) {
    throw new RangeError("river widthsM must have exactly one value per point");
  }
  if (!Array.isArray(input.surfaceElevationsM) || input.surfaceElevationsM.length !== input.points.length) {
    throw new RangeError("river surfaceElevationsM must have exactly one value per point");
  }
  const cleaned: CleanRiverPoint[] = [];
  for (let index = 0; index < input.points.length; index++) {
    const [x, z] = point(input.points[index], `river points[${index}]`);
    const widthM = finite(input.widthsM[index], `river widthsM[${index}]`);
    if (!(widthM > 0) || widthM > WATER_LIMITS.widthM) throw new RangeError(`river widthsM[${index}] is outside supported bounds`);
    const elevationM = finite(input.surfaceElevationsM[index], `river surfaceElevationsM[${index}]`);
    const previous = cleaned[cleaned.length - 1];
    if (previous !== undefined && Math.hypot(x - previous.x, z - previous.z) <= DUPLICATE_EPSILON_M) {
      previous.widthM = Math.max(previous.widthM, widthM);
      previous.elevationM = elevationM;
      continue;
    }
    cleaned.push({ x, z, widthM, elevationM });
  }
  if (cleaned.length < 2) throw new RangeError("river collapses below two distinct points");
  return cleaned;
}

function direction(a: CleanRiverPoint, b: CleanRiverPoint): [number, number] {
  const dx = b.x - a.x, dz = b.z - a.z;
  const length = Math.hypot(dx, dz);
  return [dx / length, dz / length];
}

function joins(points: CleanRiverPoint[], miterLimit: number): { joins: JoinOffsets[]; directions: [number, number][] } {
  const directions = Array.from({ length: points.length - 1 }, (_, index) => direction(points[index], points[index + 1]));
  const result: JoinOffsets[] = [];
  for (let index = 0; index < points.length; index++) {
    const halfWidth = points[index].widthM / 2;
    if (index === 0 || index === points.length - 1) {
      const d = directions[index === 0 ? 0 : directions.length - 1];
      const normal: [number, number] = [-d[1] * halfWidth, d[0] * halfWidth];
      result.push({ incoming: normal, outgoing: normal, bevel: false, turn: 0 });
      continue;
    }
    const previous = directions[index - 1], next = directions[index];
    const previousNormal: [number, number] = [-previous[1], previous[0]];
    const nextNormal: [number, number] = [-next[1], next[0]];
    const mx = previousNormal[0] + nextNormal[0], mz = previousNormal[1] + nextNormal[1];
    const miterLength = Math.hypot(mx, mz);
    const turn = previous[0] * next[1] - previous[1] * next[0];
    if (miterLength > 1e-6) {
      const unitMiter: [number, number] = [mx / miterLength, mz / miterLength];
      const denominator = unitMiter[0] * nextNormal[0] + unitMiter[1] * nextNormal[1];
      const scale = Math.abs(denominator) > 1e-6 ? halfWidth / denominator : Infinity;
      if (Number.isFinite(scale) && Math.abs(scale) <= halfWidth * miterLimit) {
        const offset: [number, number] = [unitMiter[0] * scale, unitMiter[1] * scale];
        result.push({ incoming: offset, outgoing: offset, bevel: false, turn });
        continue;
      }
    }
    result.push({
      incoming: [previousNormal[0] * halfWidth, previousNormal[1] * halfWidth],
      outgoing: [nextNormal[0] * halfWidth, nextNormal[1] * halfWidth],
      bevel: true,
      turn,
    });
  }
  return { joins: result, directions };
}

/** Build a variable-width river ribbon with bounded miters and explicit bevel fallbacks. */
export function buildVariableRiverRibbonGeometry(input: RiverRibbonGeometryInput): RiverRibbonGeometry {
  const points = cleanRiver(input);
  const miterLimit = finite(input.miterLimit ?? DEFAULT_MITER_LIMIT, "river miterLimit");
  if (miterLimit < 1 || miterLimit > 16) throw new RangeError("river miterLimit must be in [1, 16]");
  const built = joins(points, miterLimit);
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const entry of points) {
    minX = Math.min(minX, entry.x); maxX = Math.max(maxX, entry.x);
    minY = Math.min(minY, entry.elevationM); maxY = Math.max(maxY, entry.elevationM);
    minZ = Math.min(minZ, entry.z); maxZ = Math.max(maxZ, entry.z);
  }
  const origin: readonly [number, number, number] = Object.freeze([
    (minX + maxX) / 2,
    (minY + maxY) / 2,
    (minZ + maxZ) / 2,
  ]);
  const distances = new Float64Array(points.length);
  for (let index = 1; index < points.length; index++) {
    distances[index] = distances[index - 1] + Math.hypot(points[index].x - points[index - 1].x, points[index].z - points[index - 1].z);
  }
  const positions: number[] = [], arcDistances: number[] = [], flowDirections: number[] = [], indices: number[] = [];
  const push = (x: number, y: number, z: number, arc: number, flow: [number, number]): number => {
    const index = positions.length / 3;
    positions.push(x - origin[0], y - origin[1], z - origin[2]);
    arcDistances.push(arc); flowDirections.push(flow[0], flow[1]);
    return index;
  };
  for (let segment = 0; segment < points.length - 1; segment++) {
    const start = points[segment], end = points[segment + 1], flow = built.directions[segment];
    const startOffset = built.joins[segment].outgoing, endOffset = built.joins[segment + 1].incoming;
    const a = push(start.x + startOffset[0], start.elevationM, start.z + startOffset[1], distances[segment], flow);
    const b = push(start.x - startOffset[0], start.elevationM, start.z - startOffset[1], distances[segment], flow);
    const c = push(end.x + endOffset[0], end.elevationM, end.z + endOffset[1], distances[segment + 1], flow);
    const d = push(end.x - endOffset[0], end.elevationM, end.z - endOffset[1], distances[segment + 1], flow);
    indices.push(a, c, b, b, c, d);
  }
  let bevelJoinCount = 0;
  for (let index = 1; index < points.length - 1; index++) {
    const join = built.joins[index];
    if (!join.bevel || Math.abs(join.turn) <= 1e-9) continue;
    bevelJoinCount++;
    const current = points[index];
    const flow: [number, number] = [
      built.directions[index - 1][0] + built.directions[index][0],
      built.directions[index - 1][1] + built.directions[index][1],
    ];
    const flowLength = Math.hypot(flow[0], flow[1]) || 1;
    flow[0] /= flowLength; flow[1] /= flowLength;
    const side = join.turn > 0 ? -1 : 1;
    const incoming = join.incoming, outgoing = join.outgoing;
    const a = push(current.x + incoming[0] * side, current.elevationM, current.z + incoming[1] * side, distances[index], flow);
    const b = push(current.x, current.elevationM, current.z, distances[index], flow);
    const c = push(current.x + outgoing[0] * side, current.elevationM, current.z + outgoing[1] * side, distances[index], flow);
    if (join.turn > 0) indices.push(a, b, c);
    else indices.push(a, c, b);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute("waterArcDistance", new THREE.Float32BufferAttribute(arcDistances, 1));
  geometry.setAttribute("waterFlowDirection", new THREE.Float32BufferAttribute(flowDirections, 2));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return {
    geometry,
    origin,
    pointCount: points.length,
    segmentCount: points.length - 1,
    bevelJoinCount,
    lengthM: distances[distances.length - 1],
  };
}
