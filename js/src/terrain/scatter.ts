// Phase 9.1 — deterministic prop SCATTER. Places trees/rocks/grass on a terrain
// tile as a PURE function of (seed, tile): a per-tile seeded RNG walks a jittered
// candidate grid, reads each point's surface height + local slope from the tile's
// own heights, and decides kind (steep -> rock; moderate/flat -> tree/grass) and
// density. Props are RENDER-ONLY and RECOMPUTED from the tile on load (NOT
// serialized/exported): because the scatter is portable-deterministic, replay and
// browser playback reproduce the EXACT same props from the cached tile for free.
//
// Source-agnostic by design: it reads only `heights` + placement (present on every
// source — procedural AND model), so the same scatter runs over procedural, model,
// and cached tiles. Props sit at the SAME bilinear surface the mesh + heightfield
// collider use (drop parity: a prop stands where a body would rest).

import type { TerrainTile } from "./types.ts";

export enum PropKind {
  Tree = 0,
  Rock = 1,
  Grass = 2,
}

/** One placed prop. `y` is the terrain surface at (x,z). Serializable / bit-exact. */
export interface PropInstance {
  kind: number;
  x: number;
  y: number;
  z: number;
  yaw: number;
  scale: number;
}

export interface ScatterOptions {
  /** Candidate samples per axis across the tile (placement density). Default 16. */
  density?: number;
  /** Height-gradient magnitude (rise/run) above which a cell is "steep" -> rock. Default 0.6. */
  rockSlope?: number;
}

// Deterministic per-tile seed: fold (seed, tile origin x/z) so each tile is stable
// and independent, and adjacent tiles don't repeat. Exported so the asset scatter
// (asset-scatter.ts) reuses the SAME hash/RNG primitives (one determinism contract).
export function hashSeed(seed: number, a: number, b: number): number {
  let h = (seed | 0) >>> 0;
  h = Math.imul(h ^ ((a | 0) >>> 0), 0x9e3779b1) >>> 0;
  h = Math.imul(h ^ ((b | 0) >>> 0), 0x85ebca77) >>> 0;
  h ^= h >>> 15;
  return h >>> 0;
}
export function mulberry32(s: number): () => number {
  let a = s >>> 0;
  return (): number => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Scatter props over a tile. Deterministic: identical (tile, seed[, opts]) -> identical props. */
export function scatterProps(tile: TerrainTile, seed: number, opts: ScatterOptions = {}): PropInstance[] {
  const density = opts.density ?? 16;
  const rockSlope = opts.rockSlope ?? 0.6;
  const [ox, oy, oz] = tile.origin;
  const [sx, sy, sz] = tile.scale;
  const { nrows, ncols, heights } = tile;
  const rng = mulberry32(hashSeed(seed, Math.round(ox), Math.round(oz)));

  // Bilinear raw height at fractional grid (fr along z/rows, fc along x/cols).
  const sampleRaw = (fr: number, fc: number): number => {
    const r0 = Math.min(nrows - 1, Math.max(0, Math.floor(fr)));
    const c0 = Math.min(ncols - 1, Math.max(0, Math.floor(fc)));
    const r1 = Math.min(nrows - 1, r0 + 1), c1 = Math.min(ncols - 1, c0 + 1);
    const tr = fr - r0, tc = fc - c0;
    const h = (r: number, c: number): number => heights[r * ncols + c];
    const top = h(r0, c0) * (1 - tc) + h(r0, c1) * tc;
    const bot = h(r1, c0) * (1 - tc) + h(r1, c1) * tc;
    return top * (1 - tr) + bot * tr;
  };

  // World run spanned by a ±1 grid sample (for slope = rise/run).
  const runX = ((sx / Math.max(1, ncols - 1)) * 2) || 1;
  const runZ = ((sz / Math.max(1, nrows - 1)) * 2) || 1;

  const props: PropInstance[] = [];
  for (let i = 0; i < density; i++) {
    for (let j = 0; j < density; j++) {
      // Jittered candidate within this cell (RNG order is fixed -> deterministic).
      const u = (i + rng()) / density; // across x
      const v = (j + rng()) / density; // across z
      const fc = u * (ncols - 1);
      const fr = v * (nrows - 1);
      const x = ox - sx / 2 + u * sx;
      const z = oz - sz / 2 + v * sz;
      const y = oy + sampleRaw(fr, fc) * sy;
      // Local slope (rise/run) from neighbouring samples, in world units.
      const dC = (sampleRaw(fr, Math.min(ncols - 1, fc + 1)) - sampleRaw(fr, Math.max(0, fc - 1))) * sy;
      const dR = (sampleRaw(Math.min(nrows - 1, fr + 1), fc) - sampleRaw(Math.max(0, fr - 1), fc)) * sy;
      // sqrt (IEEE correctly-rounded) not Math.hypot (impl-defined precision), so the
      // recompute is bit-identical across engines (author native V8 vs a user's browser).
      const ax = dC / runX, az = dR / runZ;
      const slope = Math.sqrt(ax * ax + az * az);

      const roll = rng();
      let kind: number;
      let accept: number;
      if (slope > rockSlope) {
        kind = PropKind.Rock;
        accept = 0.5; // rocks common on steep ground
      } else if (rng() < 0.3) {
        kind = PropKind.Tree;
        accept = 0.45; // trees sparser, on moderate/flat ground
      } else {
        kind = PropKind.Grass;
        accept = 0.75; // grass dense on flat ground
      }
      const yaw = rng() * Math.PI * 2;
      const sizeJitter = rng();
      if (roll > accept) continue;
      props.push({
        kind,
        x,
        y,
        z,
        yaw,
        scale: kind === PropKind.Grass ? 0.6 + sizeJitter * 0.5 : 0.8 + sizeJitter * 0.8,
      });
    }
  }
  return props;
}
