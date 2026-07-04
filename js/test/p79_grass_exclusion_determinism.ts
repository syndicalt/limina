// P79 — climate-aware instanced ground grass is DETERMINISTIC and honours the SAME
// footprint-exclusion seam trees do.
//
// vegetation.grass carpets the buildable terrain by handing planGrassBlades (a thin wrapper over
// scatterAssets, see grass-plan.ts) the settlement keep-out discs. For the record/replay spine to
// hold, the grass placement must be byte-identical on replay, and the discs must be a PURE post-RNG
// filter — grass blades are simply skipped inside a disc, never perturbing the RNG stream, so no
// blade ever appears on a building pad, the focal courtyard, or the lane. This gate falsifies that
// on the grass planner directly (mirrors p78 for scatterAssets):
//   1. Determinism: same (tile, plan+exclusions) → byte-identical blade transforms on replay.
//   2. Pure-filter property: carved run === (open run filtered to candidates OUTSIDE every disc),
//      element-for-element byte-identical — proves the RNG sequence is untouched.
//   3. Non-trivial + correct: the discs actually remove blades, and NO surviving blade sits inside
//      a disc.
//   4. Back-compat: an absent exclusions list is byte-identical to an empty one.

import { ops } from "../src/engine.ts";
import { planGrassBlades, type GrassPlan } from "../src/skills/grass-plan.ts";
import type { AssetInstance } from "../src/terrain/asset-scatter.ts";
import type { ScatterExclusion } from "../src/terrain/asset-scatter.ts";
import type { TerrainTile } from "../src/terrain/types.ts";

function assert(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new Error("p79_grass_exclusion_determinism: " + msg);
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

// Settlement-like keep-out discs (a focal courtyard + two building pads + a lane point).
const exclusions: ScatterExclusion[] = [
  { x: 0, z: 0, r: 22 },
  { x: 30, z: -14, r: 8 },
  { x: -26, z: 18, r: 8 },
  { x: 12, z: 24, r: 4 },
];
const inAnyDisc = (x: number, z: number): boolean =>
  exclusions.some((e) => (x - e.x) * (x - e.x) + (z - e.z) * (z - e.z) <= e.r * e.r);

const basePlan: GrassPlan = {
  seed: 6,
  density: 48,
  coverage: 0.85,
  cluster: 0.4,
  slopeMax: 0.85,
  sizeRange: [0.7, 1.3],
};

// ── run the variants ─────────────────────────────────────────────────────────
const open = planGrassBlades(tile, basePlan); // no exclusions
const carvedA = planGrassBlades(tile, { ...basePlan, exclusions });
const carvedB = planGrassBlades(tile, { ...basePlan, exclusions }); // replay

assert(open.length > 100, `expected a populated grass carpet, got ${open.length}`);

// 1. Determinism: the carved run reproduces byte-identically on replay.
assert(carvedA.length === carvedB.length, `replay count diverged (${carvedA.length} vs ${carvedB.length})`);
const sameInst = (a: AssetInstance, b: AssetInstance): boolean =>
  a.assetId === b.assetId && a.x === b.x && a.y === b.y && a.z === b.z && a.yaw === b.yaw && a.scale === b.scale;
for (let i = 0; i < carvedA.length; i++) {
  assert(sameInst(carvedA[i], carvedB[i]), `grass placement must be deterministic — blade ${i} diverged on replay`);
}

// 2. Pure-filter property: carved run === open run filtered to blades OUTSIDE every disc,
//    element-for-element byte-identical (RNG stream untouched; the discs are the only difference).
const expected = open.filter((inst) => !inAnyDisc(inst.x, inst.z));
assert(carvedA.length === expected.length, `pure-filter count mismatch: carved ${carvedA.length} vs open-minus-discs ${expected.length}`);
for (let i = 0; i < expected.length; i++) {
  assert(sameInst(carvedA[i], expected[i]), `pure-filter property broken — blade ${i} is not byte-identical to the open run minus the discs (RNG stream was perturbed)`);
}

// 3. Non-trivial + correct: the discs actually removed blades, and NONE survive inside a disc.
const removed = open.length - carvedA.length;
assert(removed > 0, "the exclusion discs must actually remove grass blades (else the seam is a no-op)");
for (const inst of carvedA) {
  assert(!inAnyDisc(inst.x, inst.z), `a grass blade survived INSIDE an exclusion disc at (${inst.x.toFixed(2)}, ${inst.z.toFixed(2)})`);
}

// 4. Back-compat: an absent exclusions list is byte-identical to an empty one.
const openEmpty = planGrassBlades(tile, { ...basePlan, exclusions: [] });
assert(openEmpty.length === open.length, "empty-exclusions path count changed vs absent");
for (let i = 0; i < open.length; i++) assert(sameInst(open[i], openEmpty[i]), `empty-vs-absent exclusions perturbed at ${i}`);

ops.op_log(`[js] p79_grass_exclusion_determinism OK: grass placement is deterministic and its exclusions are a pure post-RNG filter — ${open.length} open blades, ${carvedA.length} after carving ${exclusions.length} discs (${removed} removed), byte-identical to the open run minus the discs and identical on replay; no blade sits inside a disc.`);
