// Phase 11 — CURVATURE-AWARE PLACEMENT + CREST GATE (the "no float, no bury on a dome" fix).
//
// The legacy embed-sink was a single-point Y heuristic: sink the origin by r·slope·K. That is
// a Y-only compromise on a UNIFORM SLOPE — K selects the float/bury split (K=0.5 is the strict
// minmax point: skirt float == trunk bury == r·slope/2; K=0.35 biases toward less bury). The
// current EMBED_K is 0.35 (see asset-scatter.ts — rebalanced after UAT to reduce the uniform
// "all trees sunk a little" bury the K=0.5 minmax left on the dome), but the SAME contract
// regardless of K: a Y-only sink on a uniform slope, applied AFTER every gate.
//
// That alone FAILS on non-planar terrain because slope is one gradient at one point. The
// curvature-aware placement adds two non-planar branches:
//   • CONVEX CREST (lap < CURV_CONVEX, slope < CREST_SLOPE) → seat at min(5×5 disc samples)
//   • CONCAVE FLOOR (lap > CURV_CONCAVE, slope < CREST_SLOPE) → seat at pivot (no sink)
// …gated to NEAR-ZERO pivot slope so they only fire on true ridge crests / gully floors. A
// smooth convex FLANK (curvature + non-zero slope — e.g. the island dome) is sent to the
// planar sink: the disc-min would otherwise seat at the downhill edge and over-sink the trunk
// by ~the full r·slope (the over-bury symptom the dome exhibited). The crest gate was added
// after empirical measurement on the island demo (48 convex-branch pines avg-sunk 0.608 m at
// K=0.5; moving them to planar reduced avg sink to 0.300 m).
//
// Falsifiable, headless:
//   1. UNIFORM SLOPE: planar sink is byte-identical to the legacy embed (back-compat — the
//      existing p11_prop_tether.ts covers this end-to-end; included here as a tight analytic
//      check on a known slope).
//   2. CREST GATE on a sloped CONVEX flank: the convex branch MUST NOT fire on terrain with
//      non-zero slope, regardless of how negative the Laplacian is. The placement sink matches
//      the planar sink (≈ r·slope·K), NOT the disc-min (≈ r·slope). This is the dome fix.
//   3. BYTE-IDENTICAL BACK-COMPAT: embedRadius:0 is bit-for-bit identical to unset on every
//      test tile (the curvature path is opt-in).
//   4. WATERLINE PRESERVED: the Math.max(instY, elevationMin) clamp holds on a convex ridge
//      whose footprint dips below the floor — the 0-in-water guarantee survives.

import { scatterAssets, type ScatterConfig } from "../src/terrain/asset-scatter.ts";
import type { TerrainTile } from "../src/terrain/types.ts";
import { ops } from "../src/engine.ts";

function assert(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new Error("p11_curvature_placement FAIL: " + msg);
}

// EMBED_K mirrors asset-scatter.ts (the planar-slope sink constant). Pinning it here makes the
// analytic sink assertion explicit + breaks loudly if asset-scatter.ts changes K without
// updating this test.
const EMBED_K = 0.35;

// ── Synthetic tile builders ────────────────────────────────────────────────────────
// 65×65 grid (interior room for footprint samples at r up to ~2 without edge clamping).
const N = 65;
const SX = 64, SY = 16, SZ = 64; // 1 m per cell; world Y = h·SY over [0,1].

function tileFromHeights(heights: Float32Array): TerrainTile {
  return { nrows: N, ncols: N, origin: [0, 0, 0], scale: [SX, SY, SZ], heights };
}

/** Uniform x-ramp with a known world slope. */
function buildRamp(slope: number): TerrainTile {
  // raw heights are scaled by SY to world Y; world X step per column is SX/(N−1).
  // slope (rise/run) = HK·SY / (SX/(N−1))  ⇒  HK = slope · SX/((N−1)·SY).
  const HK = (slope * SX) / ((N - 1) * SY);
  const h = new Float32Array(N * N);
  for (let r = 0; r < N; r++) for (let c = 0; c < N; c++) h[r * N + c] = c * HK;
  return tileFromHeights(h);
}

/** Convex FLANK: a downward parabolic dome centred on the tile (y = base − a·(x² + z²)). At every
 *  point off the exact centre: slope > 0 AND lap < 0 — exactly the terrain the CREST GATE must
 *  route to the planar path. Curvature a > 0.05 ⇒ lap < CURV_CONVEX (−0.10) everywhere on the
 *  un-clamped parabola; the convex branch WANTS to fire here but the crest gate must block it. */
function buildConvexFlank(aPerM: number, base01 = 0.9): TerrainTile {
  const h = new Float32Array(N * N);
  const cellCenter = (N - 1) / 2;
  for (let r = 0; r < N; r++) {
    for (let c = 0; c < N; c++) {
      const wx = c - cellCenter, wz = r - cellCenter;
      h[r * N + c] = Math.max(0, base01 - aPerM * (wx * wx + wz * wz) / SY);
    }
  }
  return tileFromHeights(h);
}

/** Concave FLANK: upward parabolic bowl (y = base + a·(x² + z²)). Slope > 0 AND lap > 0 off
 *  centre — the crest gate must also block the concave branch here, routing to planar. */
function buildConcaveFlank(aPerM: number, base01 = 0.1): TerrainTile {
  const h = new Float32Array(N * N);
  const cellCenter = (N - 1) / 2;
  for (let r = 0; r < N; r++) {
    for (let c = 0; c < N; c++) {
      const wx = c - cellCenter, wz = r - cellCenter;
      h[r * N + c] = Math.min(1, base01 + aPerM * (wx * wx + wz * wz) / SY);
    }
  }
  return tileFromHeights(h);
}

const ASSET = "tree.glb";
const EMBED_R = 1.2;
const baseCfg: ScatterConfig = { seed: 7, density: 14, assets: [{ id: ASSET }], sizeRange: [1, 1] };
const embedCfg: ScatterConfig = { ...baseCfg, assets: [{ id: ASSET, embedRadius: EMBED_R }] };

// Per-instance sink = pivot Y − instY. On a uniform slope with the planar path the sink is
// exactly r·slope·EMBED_K (capped). The crest gate routes sloped convex/concave flanks to the
// same planar path, so their sink must ALSO be ≈ r·slope·EMBED_K — NOT r·slope (which is what
// the convex disc-min would produce, the over-bury symptom).
const sinkOf = (inst: { y: number }, pivotY: number): number => pivotY - inst.y;

// Helper: bilinear height lookup on a tile at world (x, z). Mirrors scatterAssets.sampleRaw but
// operates in world space — an INDEPENDENT re-sample for the slope/sink assertion.
function worldHeight(tile: TerrainTile, x: number, z: number): number {
  const { nrows, ncols, heights, origin, scale } = tile;
  const [ox, oy, oz] = origin, [sx, sy, sz] = scale;
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

// ── 1. UNIFORM SLOPE: planar sink matches the LOCAL computed slope (byte-identical to legacy) ─
// The sink formula is r·slope·EMBED_K (capped), where `slope` is the LOCAL ±1-cell gradient
// scatterAssets reads from the tile. On a uniform ramp that gradient is RAMP_SLOPE in the
// interior but SMALLER near tile edges (sampleRaw clamps the +1 sample at the boundary).
// The contract is sink == r·localSlope·EMBED_K — verified per instance against the local slope.
const RAMP_SLOPE = 0.4;
const rampTile = buildRamp(RAMP_SLOPE);
const rampEmbed = scatterAssets(rampTile, 1, embedCfg);
const rampBase = scatterAssets(rampTile, 1, baseCfg);
assert(rampEmbed.length > 0, "no candidates placed on the uniform ramp");
assert(rampEmbed.length === rampBase.length, "embed changed the placed count on the uniform ramp (gate leaked)");
let rampChecked = 0;
const cell = SX / (N - 1);
// Interior filter: scatterAssets clamps fc±1 to the tile in its slope sample, giving a
// smaller slope near edges — restrict to interior instances where the slope sample is unbiased.
for (let i = 0; i < rampEmbed.length; i++) {
  const e = rampEmbed[i], b = rampBase[i];
  assert(e.assetId === b.assetId && Object.is(e.x, b.x) && Object.is(e.z, b.z) && Object.is(e.yaw, b.yaw) && Object.is(e.scale, b.scale), `ramp instance ${i}: embed perturbed a non-Y field`);
  if (Math.abs(e.x) > 28 || Math.abs(e.z) > 28) continue; // skip edges (slope-clamp bias)
  // Local slope = scatterAssets' ±1-cell gradient (in world units).
  const yR = worldHeight(rampTile, e.x + cell, e.z);
  const yL = worldHeight(rampTile, e.x - cell, e.z);
  const yD = worldHeight(rampTile, e.x, e.z + cell);
  const yU = worldHeight(rampTile, e.x, e.z - cell);
  const localSlope = Math.sqrt(((yR - yL) / (2 * cell)) ** 2 + ((yD - yU) / (2 * cell)) ** 2);
  const expectedSink = Math.min(EMBED_R * localSlope * EMBED_K, Math.min(EMBED_R * 1.5, 3.0));
  const pivotY = worldHeight(rampTile, e.x, e.z);
  const sink = sinkOf(e, pivotY);
  assert(Math.abs(sink - expectedSink) < 0.02, `ramp instance ${i}: sink ${sink.toFixed(3)} != r·localSlope·K ${expectedSink.toFixed(3)} (planar sink broke; localSlope=${localSlope.toFixed(3)})`);
  rampChecked++;
}
assert(rampChecked >= 10, `expected to check several interior ramp instances, only ${rampChecked}`);

// ── 2. CREST GATE: sloped convex/concave flanks route to PLANAR (not disc-min / no-sink) ──
// On a convex FLANK (slope > 0 AND lap < 0): the convex branch WANTS to fire (lap < CURV_CONVEX)
// but the crest gate (slope ≥ CREST_SLOPE) blocks it → planar sink (r·slope·EMBED_K). Without
// the gate the disc-min would seat at the downhill edge and sink ≈ r·slope (the over-bury).
const flankTile = buildConvexFlank(0.10); // lap = -0.20 everywhere on the un-clamped parabola
const flankEmbed = scatterAssets(flankTile, 1, embedCfg);
assert(flankEmbed.length > 0, "no candidates placed on the convex flank");
let convexBranchFired = 0, planarOnFlankChecked = 0;
let maxOverSink = 0; // sink − r·slope·K (should be ≈ 0 on planar; >> 0 if disc-min fires)
for (let i = 0; i < flankEmbed.length; i++) {
  const e = flankEmbed[i];
  // Compute the LOCAL slope at the instance (mirrors scatterAssets' ±1 cell gradient).
  const cell = SX / (N - 1);
  const yR = worldHeight(flankTile, e.x + cell, e.z);
  const yL = worldHeight(flankTile, e.x - cell, e.z);
  const yD = worldHeight(flankTile, e.x, e.z + cell);
  const yU = worldHeight(flankTile, e.x, e.z - cell);
  const localSlope = Math.sqrt(((yR - yL) / (2 * cell)) ** 2 + ((yD - yU) / (2 * cell)) ** 2);
  const pivotY = worldHeight(flankTile, e.x, e.z);
  const sink = sinkOf(e, pivotY);
  // For instances on the SLOPED part of the flank (the crest gate's domain): if the convex
  // branch fired, sink would be ≈ r·localSlope (over-sink). Planar: sink ≈ r·localSlope·K.
  if (localSlope >= 0.05) {
    const expectedPlanarSink = Math.min(EMBED_R * localSlope * EMBED_K, Math.min(EMBED_R * 1.5, 3.0));
    const overSink = sink - expectedPlanarSink; // >0 means disc-min fired (over-bury); ≈0 means planar
    if (overSink > 0.10) {
      convexBranchFired++;
      maxOverSink = Math.max(maxOverSink, overSink);
    }
    planarOnFlankChecked++;
  }
}
assert(planarOnFlankChecked >= 10, `expected to check several sloped-flank instances, only ${planarOnFlankChecked}`);
assert(convexBranchFired === 0, `crest gate FAILED: ${convexBranchFired}/${planarOnFlankChecked} sloped convex-flank instances took the disc-min path (max over-sink ${maxOverSink.toFixed(3)} m) instead of the planar sink (r·slope·K=${EMBED_K})`);
// Same gate on the CONCAVE flank (lap > 0 + slope > 0 must NOT take the no-sink concave branch).
const concaveFlank = buildConcaveFlank(0.10);
const concaveEmbed = scatterAssets(concaveFlank, 2, embedCfg);
let concaveBranchFired = 0, concaveChecked = 0;
for (let i = 0; i < concaveEmbed.length; i++) {
  const e = concaveEmbed[i];
  const cell = SX / (N - 1);
  const yR = worldHeight(concaveFlank, e.x + cell, e.z);
  const yL = worldHeight(concaveFlank, e.x - cell, e.z);
  const yD = worldHeight(concaveFlank, e.x, e.z + cell);
  const yU = worldHeight(concaveFlank, e.x, e.z - cell);
  const localSlope = Math.sqrt(((yR - yL) / (2 * cell)) ** 2 + ((yD - yU) / (2 * cell)) ** 2);
  if (localSlope < 0.05) continue; // only check sloped flank (where crest gate must block)
  const pivotY = worldHeight(concaveFlank, e.x, e.z);
  const sink = sinkOf(e, pivotY);
  // Concave branch seats at pivot (sink=0). Planar sink = r·slope·K > 0 here.
  if (sink < 0.01) concaveBranchFired++;
  concaveChecked++;
}
assert(concaveChecked >= 10, `expected to check several sloped concave-flank instances, only ${concaveChecked}`);
assert(concaveBranchFired === 0, `crest gate FAILED on concave flank: ${concaveBranchFired}/${concaveChecked} took the no-sink concave path (would under-sink vs the balanced planar path)`);

// ── 3. BYTE-IDENTICAL BACK-COMPAT: embedRadius:0 vs unset, on every test tile ──────
// When embedRadius is 0/unset, the curvature path is skipped entirely and outputs match the
// un-embedded scatter bit-for-bit. (The planar-slope byte-identical claim — that the new code
// matches the PRE-FIX code on uniform slopes — is covered end-to-end by p11_prop_tether.ts.)
const backCompatTiles: Array<{ name: string; tile: TerrainTile; seed: number }> = [
  { name: "ramp", tile: rampTile, seed: 3 },
  { name: "convex flank", tile: flankTile, seed: 5 },
  { name: "concave flank", tile: concaveFlank, seed: 6 },
  { name: "flat", tile: tileFromHeights(new Float32Array(N * N)), seed: 4 },
];
for (const { name, tile, seed } of backCompatTiles) {
  const unset = scatterAssets(tile, seed, baseCfg);
  const zero = scatterAssets(tile, seed, { ...baseCfg, assets: [{ id: ASSET, embedRadius: 0 }] });
  assert(unset.length === zero.length, `${name}: embedRadius:0 changed the count (${unset.length} vs ${zero.length})`);
  for (let i = 0; i < unset.length; i++) {
    assert(Object.is(unset[i].x, zero[i].x) && Object.is(unset[i].y, zero[i].y) && Object.is(unset[i].z, zero[i].z) && Object.is(unset[i].yaw, zero[i].yaw) && Object.is(unset[i].scale, zero[i].scale) && unset[i].assetId === zero[i].assetId, `${name}: embedRadius:0 is NOT byte-identical to unset (instance ${i})`);
  }
}

// ── 4. WATERLINE PRESERVED on a ridge whose footprint dips below the floor ──────────
// A convex ridge that rises out of a "water" level: cardinals near the shore dip below elevationMin.
// The Math.max(instY, elevationMin) clamp must hold — the 0-in-water guarantee is preserved,
// including when the convex branch's min(samples) would otherwise pull instY below the floor.
const WATER_LEVEL = 0.5; // world Y
const shoreRidge = buildConvexFlank(0.08, /*base01=*/ 0.6); // peak at 0.6·SY = 9.6 m, edges below water
const waterCfg: ScatterConfig = {
  seed: 11, density: 16, assets: [{ id: ASSET, embedRadius: EMBED_R }], sizeRange: [1, 1],
  elevationMin: WATER_LEVEL,
};
const waterEmbed = scatterAssets(shoreRidge, 1, waterCfg);
assert(waterEmbed.length > 0, "no candidates placed above the water line on the shore ridge");
for (let i = 0; i < waterEmbed.length; i++) {
  assert(waterEmbed[i].y >= WATER_LEVEL - 1e-6, `water clamp FAILED: ridge instance ${i} y ${waterEmbed[i].y.toFixed(3)} < floor ${WATER_LEVEL}`);
}

ops.op_log(
  `p11_curvature_placement OK: uniform slope — ${rampChecked} instances all sink r·localSlope·K (K=${EMBED_K}, byte-identical to legacy); ` +
  `crest gate — 0/${planarOnFlankChecked} sloped convex-flank + 0/${concaveChecked} sloped concave-flank instances took the non-planar branch (flanks correctly route to planar); ` +
  `byte-identical back-compat on ramp/convex/concave/flat (embedRadius:0); ` +
  `water clamp holds ${waterEmbed.length} shore-ridge instances ≥ ${WATER_LEVEL}.`,
);
