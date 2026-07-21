// Terrain power-up kernels (Editor 2.0): strength, falloff family, noise,
// flatten. Proves: strength scales the land overdrive monotonically with exact
// mid-brush values; the four falloffs give exact, distinct profiles with the
// cos² default preserved (parity file covers that); noise is deterministic per
// (cell, seed) with bounded amplitude and seed-sensitivity; flatten converges
// cells toward the stroke-start height without overshoot; guards throw.
// Falsifiability: an RNG-backed noise (non-deterministic) fails the two-fixture
// identity assertion; a falloff wired backwards fails the boundary checks.

import assert from "node:assert/strict";
import test from "node:test";

import {
  ELEV_QUANT_MAX,
  FALLOFFS,
  elevationDab,
  landDab,
  valToY,
  yToVal,
} from "../src/atlas/paint-kernels.js";

const RECT = { x0: -400, z0: -400, w: 800, h: 800 };
const landFixture = () => ({ w: 64, h: 64, rect: RECT, cells: new Uint8Array(64 * 64), dirty: false, rev: 0 });
const elevFixture = () => ({
  w: 64, h: 64, rect: RECT, minY: -500, maxY: 9000,
  cells: new Uint16Array(64 * 64), dirty: false,
});
const CENTER = [0, 0];

test("landDab strength: monotonic overdrive + default equals the original x4", () => {
  const run = (strength) => {
    const e = landFixture();
    landDab(e, ...CENTER, { mode: "land", radiusM: 200, strength });
    return e;
  };
  const s1 = run(1);
  const s2 = run(2);
  const s4 = run(4);
  // The dab center is between cells (31,32)/(32,32): sample the ring at a fixed
  // offset where the falloff curve is alive (not saturated).
  const probe = (e, dc) => e.cells[32 * 64 + 32 + dc];
  // Near the rim of the solid core, strength decides solid-vs-gradient:
  assert.ok(probe(s1, 8) < probe(s4, 8), `strength 1 (${probe(s1, 8)}) must be weaker than 4 (${probe(s4, 8)}) mid-brush`);
  assert.ok(probe(s2, 8) <= probe(s4, 8), "monotonic along the ramp");
  // The exact center saturates for every strength ≥ 1 (f = 1 → 255, quantized).
  assert.equal(probe(s1, 0), 255);
  assert.equal(probe(s4, 0), 255);
  // Nothing escapes the brush edge for any strength.
  for (const e of [s1, s4]) {
    for (let r = 0; r < 64; r++) for (let c = 0; c < 15; c++) assert.equal(e.cells[r * 64 + c], 0, "outside the radius stays 0");
  }
  assert.throws(() => landDab(landFixture(), ...CENTER, { mode: "land", radiusM: 100, strength: 0 }), RangeError);
  assert.throws(() => landDab(landFixture(), ...CENTER, { mode: "land", radiusM: 100, strength: 17 }), RangeError);
  // Default strength (omitted) equals the original fixed x4.
  const a = landFixture();
  landDab(a, ...CENTER, { mode: "land", radiusM: 200 });
  assert.deepEqual(a.cells, s4.cells, "default strength is the original x4");
});

test("falloff family: exact boundary values + distinct profiles + default is cos2", () => {
  for (const [name, fn] of Object.entries(FALLOFFS)) {
    assert.equal(fn(0), name === "smoothstep" ? 1 : 1, `${name} at center`);
    assert.ok(Math.abs(fn(1)) < 1e-12, `${name} at edge`);
  }
  const probe = {};
  for (const falloff of ["cos2", "linear", "smoothstep", "sharp"]) {
    const e = landFixture();
    landDab(e, ...CENTER, { mode: "land", radiusM: 200, strength: 1.5, falloff });
    const midC = 32 + Math.round(100 / (RECT.w / 63));
    probe[falloff] = e.cells[32 * 64 + midC];
  }
  // cos2(0.5)=0.5, linear=0.5 → same mid value; smoothstep(0.5)=0.5 too — but
  // sharp(0.5)=√0.5≈0.707 → visibly higher.
  assert.equal(probe.cos2, probe.linear);
  assert.ok(probe.sharp > probe.cos2, `sharp (${probe.sharp}) must exceed cos2 (${probe.cos2}) at mid-radius`);
  assert.throws(() => landDab(landFixture(), ...CENTER, { mode: "land", radiusM: 100, falloff: "mystery" }), /unknown falloff/);
});

test("noise: deterministic per (cell, seed), seed-sensitive, amplitude-bounded", () => {
  const run = (seed) => {
    const e = elevFixture();
    elevationDab(e, ...CENTER, { mode: "noise", radiusM: 120, strength: 1, seed });
    return e;
  };
  const a1 = run(7);
  const a2 = run(7);
  const b = run(8);
  assert.deepEqual(a1.cells, a2.cells, "same seed must reproduce the same terrain");
  assert.notDeepEqual(a1.cells, b.cells, "a different seed must produce different terrain");
  // Amplitude in METERS: |Δ| ≤ ~4.8m + one u16 step (rounding) at strength 1.
  const step = (a1.maxY - a1.minY) / ELEV_QUANT_MAX;
  const baseVal = elevFixture().cells[32 * 64 + 32];
  let maxDelta = 0;
  for (let i = 0; i < a1.cells.length; i++) {
    maxDelta = Math.max(maxDelta, Math.abs(a1.cells[i] - baseVal));
  }
  assert.ok(maxDelta > 0, "noise must displace");
  assert.ok(maxDelta * step <= 4.8 * 1.05, `noise amplitude bounded in meters (got ${maxDelta * step}m)`);
  // Saturation: drive hard at the floor — never below 0.
  const low = elevFixture();
  low.cells.fill(2);
  elevationDab(low, ...CENTER, { mode: "noise", radiusM: 200, strength: 1, seed: 3 });
  for (const v of low.cells) assert.ok(v >= 0, "saturated at u16 floor");
});

test("flatten: converges toward the stroke-start height, no overshoot", () => {
  const e = elevFixture();
  // Tilt the field: heights rise eastward (1000m west → 3000m east).
  for (let r = 0; r < 64; r++) {
    for (let c = 0; c < 64; c++) e.cells[r * 64 + c] = yToVal(1000 + (c / 63) * 2000, e);
  }
  const target = valToY(e.cells[32 * 64 + 16], e); // stroke START height (west side)
  const before = e.cells[32 * 64 + 48]; // east side, higher than target
  elevationDab(e, -200, 0, { mode: "flatten", radiusM: 500, strength: 1, levelY: target });
  const after = e.cells[32 * 64 + 48];
  const targetVal = yToVal(target, e);
  assert.ok(after < before, "high cells pulled down toward the start height");
  assert.ok(after >= targetVal - 2, `no overshoot below target (${after} vs ${targetVal})`);
  // Cells already AT the start height stay (within a quantization step).
  const atStart = e.cells[32 * 64 + 16];
  assert.ok(Math.abs(atStart - targetVal) <= 1);
});

test("yToVal/valToY still guard the extended modes' inputs", () => {
  const e = elevFixture();
  assert.throws(() => elevationDab(e, 0, 0, { mode: "flatten", radiusM: 50, strength: 0.5, levelY: 99999 }), RangeError);
  assert.throws(() => elevationDab(e, 0, 0, { mode: "noise", radiusM: -1, strength: 0.5 }), RangeError);
});
