import type { ScatterExclusion } from "../terrain/asset-scatter.ts";
import type { TerrainTile } from "../terrain/types.ts";
import {
  buildGrassFieldPlan,
  countGrassFieldPlanSlots,
  grassFieldCandidate,
  grassFieldPlacementAccepts,
  partitionGrassFieldBounds,
  validateGrassFieldResidentSlots,
  type GrassFieldBounds,
  type GrassFieldPlan,
  type GrassFieldPlacement,
} from "./grass-field-plan.ts";

const GRASS_PAINT_ID = 2;

export interface GrassFieldTerrainOptions {
  seed: number;
  spacing: number;
  elevationMin?: number;
  elevationMax?: number;
  slopeMax?: number;
  exclusions?: readonly ScatterExclusion[];
  /** Optional B3 biome-authority density. Pure world-coordinate callback; authored terrain paint
   * can add grass or suppress it without replacing this base field. */
  densityAt?: (x: number, z: number) => number;
  hardExclusionAt?: (x: number, z: number) => boolean;
  /** Editable terrain may merge authored grass paint with a density field. Published continuous
   * biome packages set "ignore": their package density is authoritative and legacy map paint must
   * not silently replace it with the retired TileGrass-era floor. */
  paintPolicy?: "merge" | "ignore";
  placement?: GrassFieldPlacement;
}

export interface PreparedGrassFieldPage {
  readonly plan: GrassFieldPlan;
  readonly heights: Float32Array;
  readonly featureOrigin: readonly [number, number, number];
}

interface TileFrame {
  x0: number; z0: number; x1: number; z1: number;
  dx: number; dz: number; oy: number; sy: number;
}

function frame(tile: TerrainTile): TileFrame {
  const [ox, oy, oz] = tile.origin, [sx, sy, sz] = tile.scale;
  return {
    x0: ox - sx / 2, z0: oz - sz / 2, x1: ox + sx / 2, z1: oz + sz / 2,
    dx: sx / Math.max(1, tile.ncols - 1), dz: sz / Math.max(1, tile.nrows - 1), oy, sy,
  };
}

export function grassFieldTerrainBounds(tile: TerrainTile): Readonly<GrassFieldBounds> {
  const f = frame(tile);
  return Object.freeze({ minX: f.x0, minZ: f.z0, maxX: f.x1, maxZ: f.z1 });
}

function bilinear(tile: TerrainTile, f: TileFrame, x: number, z: number,
  read: (index: number) => number): number {
  const fc = Math.min(tile.ncols - 1, Math.max(0, (x - f.x0) / f.dx));
  const fr = Math.min(tile.nrows - 1, Math.max(0, (z - f.z0) / f.dz));
  const c0 = Math.floor(fc), r0 = Math.floor(fr), c1 = Math.min(tile.ncols - 1, c0 + 1), r1 = Math.min(tile.nrows - 1, r0 + 1);
  const tx = fc - c0, tz = fr - r0;
  const a0 = read(r0 * tile.ncols + c0), a1 = read(r0 * tile.ncols + c1);
  const b0 = read(r1 * tile.ncols + c0), b1 = read(r1 * tile.ncols + c1);
  return a0 + (a1 - a0) * tx + (b0 + (b1 - b0) * tx - (a0 + (a1 - a0) * tx)) * tz;
}

function sampleHeight(tile: TerrainTile, f: TileFrame, x: number, z: number): number {
  return f.oy + bilinear(tile, f, x, z, (index) => tile.heights[index]) * f.sy;
}

function sampleSurface(tile: TerrainTile, f: TileFrame, x: number, z: number,
  densityAt?: (x: number, z: number) => number, paintPolicy: "merge" | "ignore" = "merge"): { y: number; weight: number } {
  const y = sampleHeight(tile, f, x, z);
  let weight = densityAt?.(x, z) ?? 0;
  if (!Number.isFinite(weight) || weight < 0 || weight > 1) throw new RangeError("grass field densityAt must return a finite value in [0,1]");
  if (paintPolicy === "merge" && tile.paintMat !== undefined && tile.paintW !== undefined) {
    const grass = bilinear(tile, f, x, z, (index) => tile.paintMat![index] === GRASS_PAINT_ID ? tile.paintW![index] : 0);
    const other = bilinear(tile, f, x, z, (index) => tile.paintMat![index] !== 0 && tile.paintMat![index] !== GRASS_PAINT_ID ? tile.paintW![index] : 0);
    weight = Math.max(weight, grass) * (1 - Math.max(0, Math.min(1, other)));
  }
  return { y, weight: Math.max(0, Math.min(1, weight)) };
}

function clippedTerrainBounds(tile: TerrainTile, requestedBounds: GrassFieldBounds): GrassFieldBounds | undefined {
  const f = frame(tile);
  const bounds = {
    minX: Math.max(f.x0, requestedBounds.minX), minZ: Math.max(f.z0, requestedBounds.minZ),
    maxX: Math.min(f.x1, requestedBounds.maxX), maxZ: Math.min(f.z1, requestedBounds.maxZ),
  };
  return bounds.maxX > bounds.minX && bounds.maxZ > bounds.minZ ? bounds : undefined;
}

/** Exact geometric residency count. This intentionally performs no terrain, density, paint,
 * exclusion, plan-allocation, or hashing work. */
export function countGrassFieldTerrainSlots(
  tile: TerrainTile,
  spacing: number,
  requestedBounds: GrassFieldBounds = grassFieldTerrainBounds(tile),
): number {
  const bounds = clippedTerrainBounds(tile, requestedBounds);
  if (bounds === undefined) return 0;
  return validateGrassFieldResidentSlots(partitionGrassFieldBounds(bounds, spacing)
    .map((pageBounds) => countGrassFieldPlanSlots(pageBounds, spacing)));
}

/** Exact terrain-independent upper bound for a package-selected placement distribution. Ecological
 * density and semantic vetoes may only reduce this count, so residency can reserve honest modeled
 * blades without charging rejected oversampling candidates as visible grass. */
export function countGrassFieldTerrainPlacementCapacity(
  tile: TerrainTile,
  spacing: number,
  seed: number,
  placement: GrassFieldPlacement | undefined,
  requestedBounds: GrassFieldBounds = grassFieldTerrainBounds(tile),
): number {
  const bounds = clippedTerrainBounds(tile, requestedBounds);
  if (bounds === undefined) return 0;
  let accepted = 0;
  for (const pageBounds of partitionGrassFieldBounds(bounds, spacing)) {
    const plan = buildGrassFieldPlan({ bounds: pageBounds, spacing, seed });
    for (let slot = 0; slot < plan.slots; slot++) {
      const candidate = grassFieldCandidate(plan, slot);
      if (candidate.inside && grassFieldPlacementAccepts(seed, candidate.gridX, candidate.gridZ, placement)) accepted++;
    }
  }
  return accepted;
}

/**
 * Author deterministic density/height uploads for canonical fixed-slot compute pages. Terrain
 * sampling remains CPU/replay-pure; native compute makes the density decision and publishes the
 * root/yaw/scale storage buffers without readback.
 */
export function prepareGrassFieldTerrainPages(
  tile: TerrainTile,
  options: GrassFieldTerrainOptions,
  requestedBounds: GrassFieldBounds = grassFieldTerrainBounds(tile),
): readonly PreparedGrassFieldPage[] {
  if (!Number.isFinite(options.slopeMax ?? 0.9) || (options.slopeMax ?? 0.9) < 0) throw new RangeError("grass field slopeMax must be finite and nonnegative");
  if (options.paintPolicy !== undefined && options.paintPolicy !== "merge" && options.paintPolicy !== "ignore") {
    throw new RangeError("grass field paintPolicy must be 'merge' or 'ignore'");
  }
  const f = frame(tile);
  const bounds = clippedTerrainBounds(tile, requestedBounds);
  if (bounds === undefined) return Object.freeze([]);
  const elevationMin = options.elevationMin ?? -Infinity, elevationMax = options.elevationMax ?? Infinity;
  const slopeMax = options.slopeMax ?? 0.9;
  const slopeStep = Math.max(0.25, Math.min(f.dx, f.dz) * 0.5);
  const exclusions = options.exclusions ?? [];
  const prepared: PreparedGrassFieldPage[] = [];
  for (const pageBounds of partitionGrassFieldBounds(bounds, options.spacing)) {
    const provisional = buildGrassFieldPlan({ bounds: pageBounds, spacing: options.spacing, seed: options.seed });
    const density = new Uint16Array(provisional.slots), heights = new Float32Array(provisional.slots);
    for (let slot = 0; slot < provisional.slots; slot++) {
      const candidate = grassFieldCandidate(provisional, slot);
      if (!grassFieldPlacementAccepts(options.seed, candidate.gridX, candidate.gridZ, options.placement)) continue;
      const surface = sampleSurface(tile, f, candidate.x, candidate.z, options.densityAt, options.paintPolicy);
      heights[slot] = surface.y;
      if (!candidate.inside || surface.y <= elevationMin || surface.y > elevationMax || surface.weight <= 0
          || options.hardExclusionAt?.(candidate.x, candidate.z) === true) continue;
      const gx = (sampleHeight(tile, f, candidate.x + slopeStep, candidate.z)
        - sampleHeight(tile, f, candidate.x - slopeStep, candidate.z)) / (2 * slopeStep);
      const gz = (sampleHeight(tile, f, candidate.x, candidate.z + slopeStep)
        - sampleHeight(tile, f, candidate.x, candidate.z - slopeStep)) / (2 * slopeStep);
      if (Math.sqrt(gx * gx + gz * gz) > slopeMax) continue;
      let excluded = false;
      for (const exclusion of exclusions) {
        const dx = candidate.x - exclusion.x, dz = candidate.z - exclusion.z;
        if (dx * dx + dz * dz <= exclusion.r * exclusion.r) { excluded = true; break; }
      }
      if (!excluded) density[slot] = Math.round(surface.weight * 0xffff);
    }
    const plan = buildGrassFieldPlan({ bounds: pageBounds, spacing: options.spacing, seed: options.seed, density });
    prepared.push(Object.freeze({
      plan, heights,
      featureOrigin: Object.freeze([pageBounds.minX, tile.origin[1], pageBounds.minZ] as const),
    }));
  }
  validateGrassFieldResidentSlots(prepared.map((entry) => entry.plan.slots));
  return Object.freeze(prepared);
}
