// P80 — every grass blade sits EXACTLY on the terrain heightfield surface, and NO blade lands
// inside a settlement footprint disc.
//
// The visual grass upgrade (curved bezier blades, three-layer wind, SSS, ground tint, blade-count
// cap) is all render-side; the PLACEMENT still comes from planGrassBlades → scatterAssets with no
// embed radius, so each blade's base Y must equal the bilinear terrain surface at its (x,z) — the
// SAME surface the mesh + heightfield collider use. This gate falsifies grounding directly on the
// planner (complementing p79's determinism/exclusion checks):
//   1. GROUNDED: for every placed blade, |blade.y − bilinearSurfaceY(blade.x, blade.z)| < 0.05 m.
//   2. CLEARED: no blade sits inside any settlement footprint disc (the clearings hold).
//   3. NON-TRIVIAL: the carpet is populated and the discs actually removed blades (not a no-op).
//
// If a future change reintroduced an embed sink, a Y offset, or a leveling divergence, (1) fails.

import { ops } from "../src/engine.ts";
import { planGrassBlades, type GrassPlan } from "../src/skills/grass-plan.ts";
import type { ScatterExclusion } from "../src/terrain/asset-scatter.ts";
import type { TerrainTile } from "../src/terrain/types.ts";

function assert(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new Error("p80_grass_grounding: " + msg);
}

// A deterministic analytic tile: a gaussian knoll heightfield centred on the origin, 120 m square
// (matches p79's tile so the two gates exercise the same ground).
function makeTile(): TerrainTile {
  const n = 65, size = 120, amp = 14, sigma = 34;
  const heights = new Float32Array(n * n);
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      const x = -size / 2 + (c / (n - 1)) * size;
      const z = -size / 2 + (r / (n - 1)) * size;
      heights[r * n + c] = amp * Math.exp(-(x * x + z * z) / (2 * sigma * sigma));
    }
  }
  return { nrows: n, ncols: n, origin: [0, 0, 0], scale: [size, 1, size], heights };
}

const tile = makeTile();

// Bilinear terrain surface Y at world (x,z) — the SAME sampling scatterAssets grounds blades with
// (fractional grid indices → bilinear over tile.heights → world Y = origin.y + h·scale.y).
function surfaceY(x: number, z: number): number {
  const { nrows, ncols, heights } = tile;
  const [ox, oy, oz] = tile.origin;
  const [sx, sy, sz] = tile.scale;
  const u = (x - (ox - sx / 2)) / sx;
  const v = (z - (oz - sz / 2)) / sz;
  const fc = u * (ncols - 1);
  const fr = v * (nrows - 1);
  const r0 = Math.min(nrows - 1, Math.max(0, Math.floor(fr)));
  const c0 = Math.min(ncols - 1, Math.max(0, Math.floor(fc)));
  const r1 = Math.min(nrows - 1, r0 + 1), c1 = Math.min(ncols - 1, c0 + 1);
  const tr = fr - r0, tc = fc - c0;
  const h = (r: number, c: number): number => heights[r * ncols + c];
  const top = h(r0, c0) * (1 - tc) + h(r0, c1) * tc;
  const bot = h(r1, c0) * (1 - tc) + h(r1, c1) * tc;
  return oy + (top * (1 - tr) + bot * tr) * sy;
}

// Settlement-like keep-out discs (a focal courtyard + two building pads + a lane point).
const exclusions: ScatterExclusion[] = [
  { x: 0, z: 0, r: 22 },
  { x: 30, z: -14, r: 8 },
  { x: -26, z: 18, r: 8 },
  { x: 12, z: 24, r: 4 },
];
const inAnyDisc = (x: number, z: number): boolean =>
  exclusions.some((e) => (x - e.x) * (x - e.x) + (z - e.z) * (z - e.z) <= e.r * e.r);

const plan: GrassPlan = {
  seed: 6,
  density: 96,
  coverage: 0.9,
  cluster: 0.2,
  slopeMax: 0.85,
  sizeRange: [0.7, 1.3],
  elevationMin: 0.2,
  elevationMax: 13.5,
  exclusions,
};

const open = planGrassBlades(tile, { ...plan, exclusions: [] });
const carved = planGrassBlades(tile, plan);

// 3. Non-trivial.
assert(carved.length > 500, `expected a populated grass carpet, got ${carved.length}`);
assert(open.length - carved.length > 0, "the exclusion discs must actually remove grass blades");

// 1. GROUNDED: every blade base sits on the bilinear terrain surface within 5 cm.
const TOL = 0.05;
let maxErr = 0;
for (const b of carved) {
  const err = Math.abs(b.y - surfaceY(b.x, b.z));
  if (err > maxErr) maxErr = err;
  assert(err < TOL, `blade at (${b.x.toFixed(2)}, ${b.z.toFixed(2)}) floats/sinks: |${b.y.toFixed(4)} − ${surfaceY(b.x, b.z).toFixed(4)}| = ${err.toFixed(4)} m ≥ ${TOL} m`);
}

// 2. CLEARED: no blade inside any footprint disc.
for (const b of carved) {
  assert(!inAnyDisc(b.x, b.z), `a grass blade survived INSIDE an exclusion disc at (${b.x.toFixed(2)}, ${b.z.toFixed(2)})`);
}

ops.op_log(`[js] p80_grass_grounding OK: ${carved.length} blades all grounded on the terrain surface (max |ΔY| = ${maxErr.toFixed(5)} m < ${TOL} m) and none inside the ${exclusions.length} settlement footprint discs (${open.length - carved.length} blades cleared).`);
