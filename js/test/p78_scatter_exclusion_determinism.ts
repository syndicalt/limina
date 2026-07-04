// P78 — the scatter footprint-EXCLUSION seam is DETERMINISTIC and a PURE post-RNG filter.
//
// vegetation.scatter / asset.scatter carve tree-free clearings around a settlement by handing
// scatterAssets a set of keep-out discs (ScatterConfig.exclusions). For the record/replay spine
// to hold, the exclusion must NOT perturb the per-candidate RNG stream: an excluded candidate is
// simply skipped, so the surviving placements are byte-identical to an un-excluded run MINUS the
// removed ones. This gate falsifies that on scatterAssets directly:
//   1. Determinism: same (tile, seed, config+exclusions) → byte-identical instances.
//   2. Pure-filter property: excluded-run === (un-excluded run filtered to candidates OUTSIDE every
//      disc), element-for-element byte-identical (assetId + x/y/z/yaw/scale). This is the strongest
//      statement — it proves the RNG sequence is untouched AND the discs are the only difference.
//   3. Non-trivial: the discs actually remove instances, and NO surviving instance sits inside a disc.

import { ops } from "../src/engine.ts";
import { scatterAssets, type ScatterConfig, type ScatterExclusion, type AssetInstance } from "../src/terrain/asset-scatter.ts";
import type { TerrainTile } from "../src/terrain/types.ts";

function assert(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new Error("p78_scatter_exclusion_determinism: " + msg);
}

// A deterministic analytic tile: a gaussian knoll heightfield centred on the origin, 120 m square.
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
const SEED = 6;
const palette = [{ id: "trees/spruce-1.glb" }, { id: "trees/pine-1.glb", weight: 1 }];
const baseCfg: ScatterConfig = { seed: 4242, density: 30, assets: palette, slopeMax: 0.85, coverage: 0.9, cluster: 0.5 };

// Settlement-like keep-out discs (a focal courtyard + two cottage pads + a lane point).
const exclusions: ScatterExclusion[] = [
  { x: 0, z: 0, r: 22 },
  { x: 30, z: -14, r: 8 },
  { x: -26, z: 18, r: 8 },
  { x: 12, z: 24, r: 4 },
];
const inAnyDisc = (x: number, z: number): boolean =>
  exclusions.some((e) => (x - e.x) * (x - e.x) + (z - e.z) * (z - e.z) <= e.r * e.r);

// ── run the three variants ──────────────────────────────────────────────────
const open = scatterAssets(tile, SEED, baseCfg);                                   // no exclusions
const carvedA = scatterAssets(tile, SEED, { ...baseCfg, exclusions });             // with exclusions
const carvedB = scatterAssets(tile, SEED, { ...baseCfg, exclusions });             // replay

assert(open.length > 100, `expected a populated forest, got ${open.length}`);

// 1. Determinism: the excluded run reproduces byte-identically.
assert(carvedA.length === carvedB.length, `replay count diverged (${carvedA.length} vs ${carvedB.length})`);
const sameInst = (a: AssetInstance, b: AssetInstance): boolean =>
  a.assetId === b.assetId && a.x === b.x && a.y === b.y && a.z === b.z && a.yaw === b.yaw && a.scale === b.scale;
for (let i = 0; i < carvedA.length; i++) {
  assert(sameInst(carvedA[i], carvedB[i]), `excluded scatter must be deterministic — instance ${i} diverged on replay`);
}

// 2. Pure-filter property: excluded run === un-excluded run filtered to candidates OUTSIDE every disc,
//    element-for-element byte-identical. Proves the RNG stream is untouched (only the discs differ).
const expected = open.filter((inst) => !inAnyDisc(inst.x, inst.z));
assert(carvedA.length === expected.length, `pure-filter count mismatch: excluded run ${carvedA.length} vs open-minus-discs ${expected.length}`);
for (let i = 0; i < expected.length; i++) {
  assert(sameInst(carvedA[i], expected[i]), `pure-filter property broken — instance ${i} is not byte-identical to the un-excluded run minus the discs (RNG stream was perturbed)`);
}

// 3. Non-trivial + correct: the discs actually removed instances, and NONE survive inside a disc.
const removed = open.length - carvedA.length;
assert(removed > 0, "the exclusion discs must actually remove instances (else the seam is a no-op)");
for (const inst of carvedA) {
  assert(!inAnyDisc(inst.x, inst.z), `an instance survived INSIDE an exclusion disc at (${inst.x.toFixed(2)}, ${inst.z.toFixed(2)})`);
}

// 4. Back-compat: absent exclusions is byte-identical to the legacy (no-exclusions) path.
const openReplay = scatterAssets(tile, SEED, { ...baseCfg });
assert(openReplay.length === open.length, "no-exclusions path count changed");
for (let i = 0; i < open.length; i++) assert(sameInst(open[i], openReplay[i]), `no-exclusions path perturbed at ${i} (back-compat broken)`);

ops.op_log(`[js] p78_scatter_exclusion_determinism OK: exclusions are a pure post-RNG filter — ${open.length} open placements, ${carvedA.length} after carving ${exclusions.length} discs (${removed} removed), byte-identical to the open run minus the discs and identical on replay; no survivor sits inside a disc; the no-exclusions path is unchanged.`);
