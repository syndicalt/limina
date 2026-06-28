// Phase 11 — the SLOPE-AWARE PROP TETHER (the "floating trees" fix). A prop is tethered to
// the surface at its CENTER (x,z); its flat base is horizontal, so on a slope the downhill
// lip of a base of radius r hangs ~r·slope above the surface (it "floats"). The opt-in
// embedRadius sinks each instance into the slope so that downhill base lip lands BACK on the
// surface — without touching the placement RULES (the elevation/water/slope/climate gates all
// consult the SURFACE y; the sink is applied to the FINAL instance.y AFTER every gate, so the
// count + the 0-in-water guarantee are untouched). Falsifiable, headless:
//
//   1. SLOPED TILE: with embedRadius>0 the downhill base lip (the instance y) lands within a
//      small tolerance of the SURFACE at the downhill edge (center − radius along the gradient,
//      measured by an independent heightfield raycast) — i.e. it no longer floats by r·slope.
//      WITHOUT embed the same lip floats by exactly r·slope (the diagnosed artefact).
//   2. FLAT TILE: the sink ≈ 0 (planted placement unchanged on level ground).
//   3. embedRadius:0 ⇒ BYTE-IDENTICAL to the pre-fix scatter (the falsifiable revert: set it
//      back to 0 and every instance matches the un-embedded Y exactly; only Y changes when on).
//   4. The gate is on SURFACE y: turning embed on does NOT change the placed COUNT (acceptance
//      is unchanged — the sink can't pull a prop through an elevation/water gate).
//   5. CLAMP: on a near-cliff slope the sink is capped (the prop can't submerge).

import { ops } from "../src/engine.ts";
import { scatterAssets, type AssetInstance, type ScatterConfig } from "../src/terrain/asset-scatter.ts";
import type { TerrainTile } from "../src/terrain/types.ts";

function assert(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new Error("p11_prop_tether FAIL: " + msg);
}
const sameInstances = (a: AssetInstance[], b: AssetInstance[]): boolean => {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].assetId !== b[i].assetId) return false;
    for (const k of ["x", "y", "z", "yaw", "scale"] as (keyof AssetInstance)[]) if (!Object.is(a[i][k], b[i][k])) return false;
  }
  return true;
};

ops.op_physics_create_world(-9.81);

// A synthetic tile with a UNIFORM x-ramp: heights[r*N+c] = c·HK, so the surface is exactly
// linear and the local slope (rise/run) is the SAME constant everywhere interior. With
// scale [SX, SY, SZ] the world gradient dy/dx == SLOPE; downhill is the −x direction.
const N = 33;
const SX = 48, SY = 12, SZ = 48;
const HK = 0.05; // raw height per column
const rampH = new Float32Array(N * N);
for (let r = 0; r < N; r++) for (let c = 0; c < N; c++) rampH[r * N + c] = c * HK;
const sloped: TerrainTile = { nrows: N, ncols: N, origin: [0, 0, 0], scale: [SX, SY, SZ], heights: rampH };
// dC per ±1 col = HK·2·SY; run = (SX/(N−1))·2. slope = dC/run.
const SLOPE = (HK * 2 * SY) / ((SX / (N - 1)) * 2); // = 0.4
assert(Math.abs(SLOPE - 0.4) < 1e-9, `synthetic slope setup wrong (${SLOPE})`);

const ASSET = "tree.glb";
const EMBED_R = 1.2;
const HALF_MISMATCH = EMBED_R * SLOPE / 2; // the BALANCED outcome (K=0.5): skirt float == trunk bury
// scale fixed at 1 so the per-instance sink is exactly EMBED_R·SLOPE·EMBED_K (clean geometry).
const baseCfg: ScatterConfig = { seed: 7, density: 14, assets: [{ id: ASSET }], sizeRange: [1, 1] };
const embedCfg: ScatterConfig = { ...baseCfg, assets: [{ id: ASSET, embedRadius: EMBED_R }] };

// ── 3 + 4. Revert-proof + count-preserving ─────────────────────────────────────────────
const flatScatterBase = scatterAssets(sloped, 1, baseCfg);       // embedRadius unset → no sink
const flatScatterZero = scatterAssets(sloped, 1, { ...baseCfg, assets: [{ id: ASSET, embedRadius: 0 }] });
assert(flatScatterBase.length > 0, "no candidates placed on the sloped tile");
assert(sameInstances(flatScatterBase, flatScatterZero), "embedRadius:0 is NOT byte-identical to the un-embedded scatter (back-compat broken)");
const embedded = scatterAssets(sloped, 1, embedCfg);
// COUNT unchanged (the sink is applied AFTER the gates; acceptance is identical).
assert(embedded.length === flatScatterBase.length, `embed changed the placed count (${embedded.length} vs ${flatScatterBase.length}) — the sink leaked into the gate`);
// Only Y moves, and only DOWNWARD (into the slope), by exactly EMBED_R·SLOPE on this ramp.
for (let i = 0; i < embedded.length; i++) {
  const e = embedded[i], b = flatScatterBase[i];
  assert(e.assetId === b.assetId && Object.is(e.x, b.x) && Object.is(e.z, b.z) && Object.is(e.yaw, b.yaw) && Object.is(e.scale, b.scale), `embed perturbed a non-Y field on instance ${i}`);
  assert(e.y < b.y, `instance ${i} was not sunk on the slope (embed ${e.y} >= surface ${b.y})`);
}

// ── 1. BALANCED embed (K=0.5): the wide cone's downhill-skirt FLOAT equals its trunk BURY ─
// The trees are wide ground-touching cones, so there is no Y-only fix that grounds the
// downhill skirt without burying the trunk. K=0.5 splits the difference: it sinks by r·m/2,
// leaving the downhill skirt floating r·m/2 AND burying the trunk r·m/2 — equal, each HALF the
// un-embedded skirt float (r·m). Measured against an independent heightfield raycast.
const hId = ops.op_physics_add_heightfield(0, 0, 0, N, N, SX, SY, SZ, rampH);
ops.op_physics_step();
const ray = new Float32Array(6);
const surfaceAt = (x: number, z: number): number | undefined => {
  ops.op_physics_raycast(x, 80, z, 0, -1, 0, 160, ray);
  return ray[0] === 1 && ray[5] === hId ? ray[3] : undefined;
};
// Gradient is +x (height rises with column/x); downhill is −x. Skirt lip = base plane = instance y.
let checked = 0, maxFloatNoEmbed = 0, maxImbalance = 0;
for (let i = 0; i < embedded.length && checked < 12; i++) {
  const e = embedded[i], b = flatScatterBase[i];
  // Keep the candidate AND its downhill sample comfortably interior (uniform slope; on-tile ray).
  if (e.x < -16 || e.x > 20) continue;
  const downhillX = e.x - EMBED_R; // scale 1 · gradient unit (1,0)
  const surfC = surfaceAt(e.x, e.z);
  const surfD = surfaceAt(downhillX, e.z);
  if (surfC === undefined || surfD === undefined) continue;
  // Un-embedded: base at the CENTER surface, so its downhill skirt floats by the full r·slope.
  const floatNoEmbed = b.y - surfD;          // base plane (b.y == surfC) minus surface downhill
  // Embedded: the trunk/center is BURIED by the sink, the downhill skirt FLOATS by the remainder.
  const trunkBury = b.y - e.y;               // surfC − e.y  (== sink == r·m/2)
  const skirtFloat = e.y - surfD;            // embedded base lip above the downhill surface (== r·m/2)
  maxFloatNoEmbed = Math.max(maxFloatNoEmbed, floatNoEmbed);
  maxImbalance = Math.max(maxImbalance, Math.abs(trunkBury - skirtFloat));
  // Diagnosis: un-embedded skirt float is the full r·slope.
  assert(Math.abs(floatNoEmbed - EMBED_R * SLOPE) < 0.12, `instance ${i}: un-embedded float ${floatNoEmbed.toFixed(3)} != r·slope ${(EMBED_R * SLOPE).toFixed(3)}`);
  // Balanced: trunk bury ≈ skirt float ≈ r·m/2 (trunkBury is analytic → tight; skirtFloat via raycast).
  assert(Math.abs(trunkBury - HALF_MISMATCH) < 0.03, `instance ${i}: trunk bury ${trunkBury.toFixed(3)} != r·m/2 ${HALF_MISMATCH.toFixed(3)} (EMBED_K not 0.5?)`);
  assert(Math.abs(skirtFloat - HALF_MISMATCH) < 0.08, `instance ${i}: skirt float ${skirtFloat.toFixed(3)} != r·m/2 ${HALF_MISMATCH.toFixed(3)} (balance broken)`);
  assert(Math.abs(trunkBury - skirtFloat) < 0.08, `instance ${i}: NOT balanced — bury ${trunkBury.toFixed(3)} vs float ${skirtFloat.toFixed(3)}`);
  // The worst-case mismatch is HALVED vs no embed (both sides strictly less than the full float).
  assert(trunkBury < floatNoEmbed - 1e-6 && skirtFloat < floatNoEmbed - 1e-6, `instance ${i}: embed did not reduce the worst-case mismatch below r·slope`);
  checked++;
}
assert(checked >= 6, `expected to geometry-check several instances, only ${checked}`);
assert(maxFloatNoEmbed > 0.3, `the un-embedded float was negligible (${maxFloatNoEmbed.toFixed(3)}) — the test is vacuous (need a real slope)`);

// ── 2. FLAT TILE: the sink ≈ 0 (planted placement unchanged on level ground) ────────────
const flatH = new Float32Array(N * N); // all zero → no slope
const flat: TerrainTile = { nrows: N, ncols: N, origin: [0, 0, 0], scale: [SX, SY, SZ], heights: flatH };
const flatBase = scatterAssets(flat, 3, baseCfg);
const flatEmbed = scatterAssets(flat, 3, embedCfg);
assert(flatBase.length > 0, "no candidates on the flat tile");
assert(sameInstances(flatBase, flatEmbed), "embed sank instances on FLAT ground (slope≈0 must yield sink≈0)");

// ── 5. CLAMP: a near-cliff slope caps the sink so the prop can't submerge ────────────────
// A very steep ramp (HK 0.5 → slope 4.0). Raw sink r·slope·K = 1.2·4·0.5 = 2.4 would still
// bury the prop deeply; the cap (≤ 1.5·r and ≤ 3.0 world units) holds it to a sane depth.
const cliffH = new Float32Array(N * N);
for (let r = 0; r < N; r++) for (let c = 0; c < N; c++) cliffH[r * N + c] = c * 0.5;
const cliff: TerrainTile = { nrows: N, ncols: N, origin: [0, 0, 0], scale: [SX, SY, SZ], heights: cliffH };
const cliffBase = scatterAssets(cliff, 5, baseCfg);
const cliffEmbed = scatterAssets(cliff, 5, embedCfg);
let maxSink = 0;
for (let i = 0; i < cliffEmbed.length; i++) maxSink = Math.max(maxSink, cliffBase[i].y - cliffEmbed[i].y);
const CAP = Math.min(EMBED_R * 1.5, 3.0); // mirrors EMBED_MAX_RADII / EMBED_ABS_MAX
assert(maxSink <= CAP + 1e-9, `near-cliff sink ${maxSink.toFixed(3)} exceeded the clamp ${CAP} (a prop could submerge)`);
assert(maxSink > CAP - 0.2, `the clamp did not engage on a 4.0 slope (max sink ${maxSink.toFixed(3)}) — cap test vacuous`);

// ── 6. WATER CLAMP (FALSIFIABLE): the sink never beds a prop's origin below the water floor ──
// A water-gated layer accepts a prop on SURFACE y >= elevationMin (the waterline + any margin).
// On a sloped shore the embed-sink would pull a near-floor prop's origin BELOW the waterline; the
// `instY = max(y - sink, elevationMin)` clamp must stop it. Build a STEEP shore (slope 1.0) with
// a ZERO-margin water floor so the clamp actually engages, and prove it does real work: some props
// WOULD submerge without it (their surface − sink < floor), yet EVERY recorded origin is ≥ floor.
const SHK = 0.125; // slope = (SHK·2·SY)/run = 1.0
const shoreSlope = (SHK * 2 * SY) / ((SX / (N - 1)) * 2);
assert(Math.abs(shoreSlope - 1.0) < 1e-9, `shore slope setup wrong (${shoreSlope})`);
const shoreH = new Float32Array(N * N);
for (let r = 0; r < N; r++) for (let c = 0; c < N; c++) shoreH[r * N + c] = c * SHK;
const shore: TerrainTile = { nrows: N, ncols: N, origin: [0, 0, 0], scale: [SX, SY, SZ], heights: shoreH };
const WATER_FLOOR = 10.0; // surface y = c·1.5 spans 0..48, so a real band of shore sits just above it
const shoreCfg: ScatterConfig = { seed: 9, density: 16, assets: [{ id: ASSET, embedRadius: EMBED_R }], sizeRange: [1, 1], elevationMin: WATER_FLOOR };
const shoreSeated = scatterAssets(shore, 2, { ...shoreCfg, embedRadius: 0, assets: [{ id: ASSET }] }); // surface y of the accepted props
const shoreEmbed = scatterAssets(shore, 2, shoreCfg);
assert(shoreEmbed.length > 0 && shoreEmbed.length === shoreSeated.length, `water-gated shore placed nothing / count drift (${shoreEmbed.length} vs ${shoreSeated.length})`);
// Characterize the TRUE (clamp-free) sink K-agnostically from props seated WELL above the floor
// (their origin is untouched by the clamp, so surface − origin is the full uncapped sink). The
// shore slope is uniform, so this is the sink the near-floor props would also take without the clamp.
let fullSink = 0;
for (let i = 0; i < shoreEmbed.length; i++) if (shoreEmbed[i].y > WATER_FLOOR + 0.1) fullSink = Math.max(fullSink, shoreSeated[i].y - shoreEmbed[i].y);
assert(fullSink > 0.05, `could not characterize the embed sink on the shore (fullSink ${fullSink.toFixed(3)})`);
let clampEngaged = 0, wouldSubmerge = 0;
for (let i = 0; i < shoreEmbed.length; i++) {
  const e = shoreEmbed[i], s = shoreSeated[i];
  assert(s.y >= WATER_FLOOR - 1e-6, `gate leak: a prop seated below the water floor (surface ${s.y})`);
  // The clamp guarantee: NO recorded origin sits below the water floor.
  assert(e.y >= WATER_FLOOR - 1e-6, `water clamp FAILED: prop ${i} origin ${e.y.toFixed(3)} sank below the floor ${WATER_FLOOR}`);
  // Non-vacuous: this prop WOULD have submerged without the clamp (surface − full sink < floor).
  if (s.y - fullSink < WATER_FLOOR - 1e-6) wouldSubmerge++;
  if (Math.abs(e.y - WATER_FLOOR) < 1e-6) clampEngaged++;
}
assert(wouldSubmerge > 0, `the clamp test is vacuous — no prop would have submerged without it (need a prop within ${EMBED_R} m of the floor on the slope)`);
assert(clampEngaged > 0, "the clamp never engaged (no origin pinned to the floor) — remove the clamp and this test must fail");

ops.op_log(
  `p11_prop_tether OK: BALANCED embed (K=0.5) on a ${SLOPE} slope — trunk bury == downhill skirt float == r·m/2 (${HALF_MISMATCH.toFixed(3)} m), ` +
  `each HALF the un-embedded float up to ${maxFloatNoEmbed.toFixed(3)} m (= r·slope); max imbalance ${maxImbalance.toFixed(3)} m, ${checked} geometry-checked; ` +
  `placed count unchanged (${embedded.length}); embedRadius:0 byte-identical to pre-fix; flat ground sink≈0; near-cliff sink clamped to ${maxSink.toFixed(2)} ≤ ${CAP}; ` +
  `water clamp holds ${shoreEmbed.length} shore props ≥ floor ${WATER_FLOOR} (${wouldSubmerge} would submerge unclamped, ${clampEngaged} pinned to floor).`,
);
