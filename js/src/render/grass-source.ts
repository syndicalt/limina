// grass-source.ts — pure, deterministic PAINT-DRIVEN grass-blade placement.
//
// The terrain carries a per-vertex surface-material channel (TerrainTile.paintMat/paintW —
// written by terrain.paint brush strokes and by the map rasterizer's biome regions). Until now
// that channel rendered as mere vertex TINT (applyPaintOverlay); this module turns it into the
// placement field for REAL instanced grass blades: blade density is proportional to the painted
// grass weight (paintW where paintMat === grass), zero on sand/rock/dirt/unpainted ground and
// underwater. The render side (terrain/grass-render.ts) consumes these placements; this module
// is THREE-free so the determinism gate (js/test/p_grass.ts) imports it headlessly — the same
// split as grass-plan.ts (pure) vs grass.ts (render).
//
// Technique adapted from the MIT-licensed GrassSystemThreeJS (achrefelouafi — coverage-mask-
// driven blade density over a conforming heightfield). Their mask is a GPU FBM threshold; ours
// is the tile's OWN paint channel, sampled CPU-side so placement stays a pure, replay-stable
// function — the engine's determinism contract (like vegetation.scatter, the log records paint
// OPS, never blade transforms; blades recompute on every mount).
//
// DETERMINISM (load-bearing): placements are a pure function of (tile content, world-anchored
// candidate lattice, seed). The candidate lattice is anchored in WORLD space (index = the
// integer lattice cell of world x/z at `spacing`), so:
//   • the same painted tile + seed reproduces byte-identical placements on every mount,
//   • recomputing ONE chunk yields exactly the blades a whole-tile compute puts there (the
//     live terrain.paint brush refreshes only the chunks it touched), and
//   • adjacent STREAMED tiles agree at their seam (no doubled/missing row at tile borders).
// No Math.random, no clocks — all variation from hashSeed over (seed, lattice i, lattice k).

import { hashSeed } from "../terrain/scatter.ts";
import type { TerrainTile } from "../terrain/types.ts";
import type { ScatterExclusion } from "../terrain/asset-scatter.ts";

/** The terrain.paint material id blades grow on (PAINT_MATERIALS.grass / PAINT_ALBEDO[2]). */
export const GRASS_PAINT_ID = 2;

/** One placed blade. `y` is the terrain surface at (x,z). Never serialized into the log —
 *  recomputed from the tile + seed on every mount (the vegetation.scatter pattern). */
export interface GrassPlacement {
  x: number;
  y: number;
  z: number;
  /** Heading about +Y (radians). */
  yaw: number;
  /** Uniform per-blade scale. */
  scale: number;
}

export interface GrassSourceOptions {
  /** Placement salt — same (tile, seed) reproduces the same field. */
  seed: number;
  /** Candidate lattice pitch (metres). Max density = 1/spacing² blades/m² where paintW = 1.
   *  Default 0.45 (≈ 4.9 blades/m² at full weight — the vegetation.grass carpet ballpark). */
  spacing?: number;
  /** Chunk cell size (metres) for the render-side spatial bucketing (one InstancedMesh per
   *  chunk → per-chunk frustum culling + targeted paint-brush refresh). Default 24. */
  chunkSize?: number;
  /** World-Y floor — no blades at or below it (the waterline). Default -Infinity. */
  elevationMin?: number;
  /** Max local slope (rise/run) — steeper faces stay bare. Default 0.9. */
  slopeMax?: number;
  /** Per-blade uniform scale range. Default [0.7, 1.3]. */
  sizeRange?: [number, number];
  /** Keep-out discs (world XZ) — the settlement-footprint seam vegetation.scatter/grass honour,
   *  so paint-grown grass also stops at building pads / courtyards / lanes. */
  exclusions?: readonly ScatterExclusion[];
  /** Safety cap on blades per chunk (a 24 m chunk at spacing 0.45 tops out ≈ 2.8k). */
  maxBladesPerChunk?: number;
}

const DEFAULT_SPACING = 0.45;
const DEFAULT_CHUNK = 24;
const DEFAULT_SLOPE_MAX = 0.9;
const DEFAULT_SIZE_RANGE: [number, number] = [0.7, 1.3];
const DEFAULT_MAX_PER_CHUNK = 8000;

/** Stable string key for a chunk cell (world-anchored: cx = floor(x / chunkSize)). */
export function grassChunkKey(cx: number, cz: number): string {
  return `${cx}:${cz}`;
}

interface TileFrame {
  x0: number; z0: number; // world coords of grid node (row 0, col 0)
  dx: number; dz: number; // grid step (m) along cols / rows
  ncols: number; nrows: number;
  oy: number; sy: number;
}

function tileFrame(tile: TerrainTile): TileFrame {
  const [ox, oy, oz] = tile.origin;
  const [sx, sy, sz] = tile.scale;
  return {
    x0: ox - sx / 2,
    z0: oz - sz / 2,
    dx: sx / Math.max(1, tile.ncols - 1),
    dz: sz / Math.max(1, tile.nrows - 1),
    ncols: tile.ncols,
    nrows: tile.nrows,
    oy,
    sy,
  };
}

/** Bilinear surface height (world Y) at world (x,z) — the same node lattice the render mesh and
 *  collider are built from, so blades sit ON the ground. */
function heightAt(tile: TerrainTile, f: TileFrame, x: number, z: number): number {
  const fc = Math.min(f.ncols - 1, Math.max(0, (x - f.x0) / f.dx));
  const fr = Math.min(f.nrows - 1, Math.max(0, (z - f.z0) / f.dz));
  const c0 = Math.floor(fc), r0 = Math.floor(fr);
  const c1 = Math.min(f.ncols - 1, c0 + 1), r1 = Math.min(f.nrows - 1, r0 + 1);
  const tx = fc - c0, tz = fr - r0;
  const h = tile.heights;
  const a = h[r0 * f.ncols + c0] + (h[r0 * f.ncols + c1] - h[r0 * f.ncols + c0]) * tx;
  const b = h[r1 * f.ncols + c0] + (h[r1 * f.ncols + c1] - h[r1 * f.ncols + c0]) * tx;
  return f.oy + (a + (b - a) * tz) * f.sy;
}

/** Bilinear GRASS weight at world (x,z): each grid node contributes paintW only where its
 *  paintMat is grass (non-grass nodes contribute 0), so density feathers to zero across a
 *  paint border instead of hard-clipping at the nearest-node boundary. */
function grassWeightAt(tile: TerrainTile, f: TileFrame, x: number, z: number): number {
  const mat = tile.paintMat, w = tile.paintW;
  if (mat === undefined || w === undefined) return 0;
  const fc = Math.min(f.ncols - 1, Math.max(0, (x - f.x0) / f.dx));
  const fr = Math.min(f.nrows - 1, Math.max(0, (z - f.z0) / f.dz));
  const c0 = Math.floor(fc), r0 = Math.floor(fr);
  const c1 = Math.min(f.ncols - 1, c0 + 1), r1 = Math.min(f.nrows - 1, r0 + 1);
  const tx = fc - c0, tz = fr - r0;
  const g = (r: number, c: number): number => {
    const i = r * f.ncols + c;
    return mat[i] === GRASS_PAINT_ID ? w[i] : 0;
  };
  const a = g(r0, c0) + (g(r0, c1) - g(r0, c0)) * tx;
  const b = g(r1, c0) + (g(r1, c1) - g(r1, c0)) * tx;
  return a + (b - a) * tz;
}

/** True when NO grid node covering the chunk's world rect carries grass paint — the cheap
 *  whole-chunk early-out that keeps unpainted (sand/rock/ocean) ground near-free to scan. */
function chunkHasNoGrass(tile: TerrainTile, f: TileFrame, minX: number, minZ: number, maxX: number, maxZ: number): boolean {
  const mat = tile.paintMat, w = tile.paintW;
  if (mat === undefined || w === undefined) return true;
  const c0 = Math.max(0, Math.floor((minX - f.x0) / f.dx) - 1);
  const c1 = Math.min(f.ncols - 1, Math.ceil((maxX - f.x0) / f.dx) + 1);
  const r0 = Math.max(0, Math.floor((minZ - f.z0) / f.dz) - 1);
  const r1 = Math.min(f.nrows - 1, Math.ceil((maxZ - f.z0) / f.dz) + 1);
  for (let r = r0; r <= r1; r++) {
    for (let c = c0; c <= c1; c++) {
      const i = r * f.ncols + c;
      if (mat[i] === GRASS_PAINT_ID && w[i] > 0) return false;
    }
  }
  return true;
}

/** Chunk cell coords whose square overlaps the tile's world footprint. */
export function grassChunkCoordsForTile(tile: TerrainTile, chunkSize: number = DEFAULT_CHUNK): { cx: number; cz: number }[] {
  const [ox, , oz] = tile.origin;
  const [sx, , sz] = tile.scale;
  const minCx = Math.floor((ox - sx / 2) / chunkSize);
  const maxCx = Math.floor((ox + sx / 2 - 1e-9) / chunkSize);
  const minCz = Math.floor((oz - sz / 2) / chunkSize);
  const maxCz = Math.floor((oz + sz / 2 - 1e-9) / chunkSize);
  const out: { cx: number; cz: number }[] = [];
  for (let cz = minCz; cz <= maxCz; cz++) for (let cx = minCx; cx <= maxCx; cx++) out.push({ cx, cz });
  return out;
}

/** Chunk cell coords whose square intersects a world-XZ disc ∩ the tile footprint — the set the
 *  live terrain.paint / terrain.deform brush must refresh. */
export function grassChunkCoordsInCircle(tile: TerrainTile, x: number, z: number, r: number, chunkSize: number = DEFAULT_CHUNK): { cx: number; cz: number }[] {
  const out: { cx: number; cz: number }[] = [];
  for (const c of grassChunkCoordsForTile(tile, chunkSize)) {
    const minX = c.cx * chunkSize, minZ = c.cz * chunkSize;
    const nx = Math.min(Math.max(x, minX), minX + chunkSize);
    const nz = Math.min(Math.max(z, minZ), minZ + chunkSize);
    const dx = x - nx, dz = z - nz;
    if (dx * dx + dz * dz <= r * r) out.push(c);
  }
  return out;
}

/**
 * Deterministic blade placements for ONE chunk cell of a tile. A world-anchored jittered
 * lattice at `spacing`: each lattice cell (i,k) draws its jitter/accept/yaw/scale from
 * hashSeed(seed', i, k) alone, and a candidate survives only when
 *   • a uniform hash draw falls under the local painted GRASS weight (density ∝ paintW),
 *   • the surface at its (x,z) is above `elevationMin` (no blades underwater),
 *   • the local slope is ≤ `slopeMax`, and
 *   • it sits outside every exclusion disc (the settlement-footprint seam).
 * Pure: identical (tile, cx, cz, opts) → byte-identical placements, and the union over a
 * tile's chunks equals a whole-tile compute (chunk membership is by lattice cell).
 */
export function grassChunkPlacements(tile: TerrainTile, cx: number, cz: number, opts: GrassSourceOptions): GrassPlacement[] {
  const spacing = opts.spacing ?? DEFAULT_SPACING;
  const chunkSize = opts.chunkSize ?? DEFAULT_CHUNK;
  const elevationMin = opts.elevationMin ?? -Infinity;
  const slopeMax = opts.slopeMax ?? DEFAULT_SLOPE_MAX;
  const [sizeLo, sizeHi] = opts.sizeRange ?? DEFAULT_SIZE_RANGE;
  const maxBlades = opts.maxBladesPerChunk ?? DEFAULT_MAX_PER_CHUNK;
  const f = tileFrame(tile);

  // Chunk world rect ∩ tile footprint.
  const tMinX = f.x0, tMaxX = f.x0 + f.dx * (f.ncols - 1);
  const tMinZ = f.z0, tMaxZ = f.z0 + f.dz * (f.nrows - 1);
  const minX = Math.max(cx * chunkSize, tMinX), maxX = Math.min((cx + 1) * chunkSize, tMaxX);
  const minZ = Math.max(cz * chunkSize, tMinZ), maxZ = Math.min((cz + 1) * chunkSize, tMaxZ);
  if (minX >= maxX || minZ >= maxZ) return [];
  if (chunkHasNoGrass(tile, f, minX, minZ, maxX, maxZ)) return [];

  const exclusions = opts.exclusions ?? [];
  const exN = exclusions.length;

  // World-anchored lattice cells covering the chunk rect. Membership is by LATTICE CELL
  // (a jittered position may stray ≤ spacing outside the cell), so a per-chunk recompute
  // reproduces exactly the whole-tile compute's blades for this chunk.
  const i0 = Math.ceil(minX / spacing - 1e-9), i1 = Math.floor(maxX / spacing);
  const k0 = Math.ceil(minZ / spacing - 1e-9), k1 = Math.floor(maxZ / spacing);
  const seed = (opts.seed | 0) ^ 0x67a55a17;
  const out: GrassPlacement[] = [];
  const slopeStep = Math.max(0.25, Math.min(f.dx, f.dz) * 0.5);

  for (let k = k0; k <= k1; k++) {
    for (let i = i0; i <= i1; i++) {
      const h0 = hashSeed(seed, i, k);
      // Independent draws off one lattice hash (cheap sub-streams, all hash-derived).
      const accept = h0 / 4294967296;
      const h1 = hashSeed(h0 ^ 0x9e3779b9, i, k);
      const h2 = hashSeed(h0 ^ 0x85ebca77, k, i);
      const jx = ((h1 & 0xffff) / 65536 - 0.5) * spacing;
      const jz = (((h1 >>> 16) & 0xffff) / 65536 - 0.5) * spacing;
      const x = i * spacing + jx;
      const z = k * spacing + jz;
      if (x < tMinX || x > tMaxX || z < tMinZ || z > tMaxZ) continue;
      // Density ∝ painted grass weight — the paint channel IS the coverage mask.
      const w = grassWeightAt(tile, f, x, z);
      if (w <= 0 || accept >= w) continue;
      const y = heightAt(tile, f, x, z);
      if (y <= elevationMin) continue;
      // Local slope (rise/run) by central difference at a sub-grid step.
      const gx = (heightAt(tile, f, x + slopeStep, z) - heightAt(tile, f, x - slopeStep, z)) / (2 * slopeStep);
      const gz = (heightAt(tile, f, x, z + slopeStep) - heightAt(tile, f, x, z - slopeStep)) / (2 * slopeStep);
      if (Math.sqrt(gx * gx + gz * gz) > slopeMax) continue;
      if (exN > 0) {
        let excluded = false;
        for (let e = 0; e < exN; e++) {
          const ex = exclusions[e], dxr = x - ex.x, dzr = z - ex.z;
          if (dxr * dxr + dzr * dzr <= ex.r * ex.r) { excluded = true; break; }
        }
        if (excluded) continue;
      }
      const yaw = ((h2 & 0xffff) / 65536) * Math.PI * 2;
      const scale = sizeLo + (((h2 >>> 16) & 0xffff) / 65536) * (sizeHi - sizeLo);
      out.push({ x, y, z, yaw, scale });
      if (out.length >= maxBlades) return out;
    }
  }
  return out;
}

/** All non-empty chunks for a tile: chunkKey → placements. The mount-time compute for both the
 *  editable slab and a streamed tile; the live brush path recomputes single chunks instead. */
export function grassChunksForTile(tile: TerrainTile, opts: GrassSourceOptions): Map<string, GrassPlacement[]> {
  const chunkSize = opts.chunkSize ?? DEFAULT_CHUNK;
  const out = new Map<string, GrassPlacement[]>();
  if (tile.paintMat === undefined || tile.paintW === undefined) return out;
  for (const { cx, cz } of grassChunkCoordsForTile(tile, chunkSize)) {
    const placements = grassChunkPlacements(tile, cx, cz, opts);
    if (placements.length > 0) out.set(grassChunkKey(cx, cz), placements);
  }
  return out;
}
