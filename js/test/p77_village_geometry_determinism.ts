// P77 — the v2 village.build additions (generated terrain + the lane ribbon + ground pads) are
// DETERMINISTIC, so the record/replay spine holds: village.build records only the config and
// RECOMPUTES the eroded heightfield + lane + pad geometry on replay, which therefore MUST be a
// pure, byte-reproducible function of that config.
//
// This gate falsifies that on all three v2 pieces:
//   1. generateHeightfield(config) → byte-identical heights on replay (never logged; regenerated),
//      is non-trivial (real relief), and a different seed re-rolls it (not a constant).
//   2. buildLaneGeometry(heightAt, placed) → byte-identical positions/uvs/indices on replay.
//   3. buildGroundPadGeometry(heightAt, x, z, r, lift) → byte-identical positions/uvs/indices.

import { ops } from "../src/engine.ts";
import { generateHeightfield } from "../src/world/pipeline/terrain-heightfield.mjs";
import { buildGroundPadGeometry, buildLaneGeometry } from "../src/world/pipeline/village-geometry.mjs";

function assert(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new Error("p77_village_geometry_determinism: " + msg);
}

function sameFloats(a: ArrayLike<number>, b: ArrayLike<number>, what: string): void {
  assert(a.length === b.length, `${what}: length diverged (${a.length} vs ${b.length})`);
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) assert(false, `${what}: element ${i} diverged (${a[i]} vs ${b[i]})`);
  }
}

// ── 1. generated heightfield determinism ──────────────────────────────────────────
// deno-lint-ignore no-explicit-any
const genCfg: any = { seed: 6, amplitude: 16, sizeM: 120, gridN: 127, seaCoverage: 0.2, erosion: { rain: 1.5, thermal: 6 } };
// deno-lint-ignore no-explicit-any
const g1 = (generateHeightfield as any)(genCfg);
// deno-lint-ignore no-explicit-any
const g2 = (generateHeightfield as any)(genCfg);
assert(g1.heights.length === 128 * 128, `heightfield size: expected ${128 * 128}, got ${g1.heights.length}`);
sameFloats(g1.heights, g2.heights, "heightfield heights");
// non-trivial relief (erosion carved real geography, not a flat slab)
let lo = Infinity, hi = -Infinity;
for (let i = 0; i < g1.heights.length; i++) { const v = g1.heights[i]; if (v < lo) lo = v; if (v > hi) hi = v; }
assert(hi - lo > 4, `heightfield must have real relief (got ${(hi - lo).toFixed(2)}m)`);
// a different seed re-rolls the terrain (not a constant)
// deno-lint-ignore no-explicit-any
const g3 = (generateHeightfield as any)({ ...genCfg, seed: 99 });
let anyDiff = false;
for (let i = 0; i < g1.heights.length; i++) { if (g1.heights[i] !== g3.heights[i]) { anyDiff = true; break; } }
assert(anyDiff, "a different seed must re-roll the heightfield (else it is a constant)");

// ── a heightAt sampler over the generated field (bilinear), the same contract village.build uses ──
const cols = g1.cols, rows = g1.rows, step = g1.step, half = g1.half, heights = g1.heights as Float32Array;
const heightAt = (x: number, z: number): number => {
  let gx = (x + half) / step, gz = (z + half) / step;
  gx = Math.max(0, Math.min(cols - 1.0001, gx)); gz = Math.max(0, Math.min(rows - 1.0001, gz));
  const ix = Math.floor(gx), iz = Math.floor(gz), fx = gx - ix, fz = gz - iz, i = iz * cols + ix;
  return heights[i] * (1 - fx) * (1 - fz) + heights[i + 1] * fx * (1 - fz) + heights[i + cols] * (1 - fx) * fz + heights[i + cols + 1] * fx * fz;
};

// ── 2. lane ribbon determinism ───────────────────────────────────────────────────
// placed footprints (focal first) — the shape village.build passes after planVillage.
const placed = [
  { x: 0, z: 0, r: 9 },
  { x: 22, z: 8, r: 5 },
  { x: -14, z: 20, r: 5 },
  { x: 10, z: -24, r: 10 },
];
// deno-lint-ignore no-explicit-any
const lane1 = (buildLaneGeometry as any)(heightAt, placed);
// deno-lint-ignore no-explicit-any
const lane2 = (buildLaneGeometry as any)(heightAt, placed);
assert(lane1 !== null && lane1.positions.length > 0, "lane geometry must be produced for >=2 buildings");
sameFloats(lane1.positions, lane2.positions, "lane positions");
sameFloats(lane1.uvs, lane2.uvs, "lane uvs");
sameFloats(lane1.indices, lane2.indices, "lane indices");
// a lane needs 2+ buildings; a single footprint yields none.
// deno-lint-ignore no-explicit-any
assert((buildLaneGeometry as any)(heightAt, [placed[0]]) === null, "a single building yields no lane");

// ── 3. ground pad determinism ────────────────────────────────────────────────────
// deno-lint-ignore no-explicit-any
const pad1 = (buildGroundPadGeometry as any)(heightAt, 0, 0, 24, 0.2);
// deno-lint-ignore no-explicit-any
const pad2 = (buildGroundPadGeometry as any)(heightAt, 0, 0, 24, 0.2);
assert(pad1.positions.length > 0, "ground pad geometry must be produced");
sameFloats(pad1.positions, pad2.positions, "pad positions");
sameFloats(pad1.uvs, pad2.uvs, "pad uvs");
sameFloats(pad1.indices, pad2.indices, "pad indices");

ops.op_log(`[js] p77_village_geometry_determinism OK: generated heightfield (${(hi - lo).toFixed(1)}m relief), lane ribbon (${lane1.positions.length / 3} verts) and ground pad (${pad1.positions.length / 3} verts) are byte-identical on replay; a different seed re-rolls the terrain.`);
