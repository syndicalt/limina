// Atlas paint kernels — differential parity against the originals (the retired
// SPA's map-paint.js: landDab/biomeDab; map-elevation.js: brushDab — the latter
// now at tools/design/map-elevation.js).
// The originals are copied VERBATIM into this file; the ported kernels in
// editor/src/atlas/paint-kernels.js must produce byte-identical rasters, rev/dirty
// flags, and bboxes across a seeded sequence of dabs. Falsifiability: any drift in
// falloff, overdrive, quantization, saturation, or bbox math fails a cell compare.

import assert from "node:assert/strict";
import test from "node:test";

import {
  ELEV_QUANT_MAX,
  biomeDab,
  elevationDab,
  landDab,
  valToY,
  yToVal,
} from "../src/atlas/paint-kernels.js";

// ── originals (verbatim copies; if the source changes, re-copy) ───────────────
function origLandDab(e, wx, wz, { mode, radiusM }) {
  const { w, h, rect } = e;
  const sx = rect.w / (w - 1), sz = rect.h / (h - 1);
  const c0 = Math.max(0, Math.floor((wx - radiusM - rect.x0) / sx));
  const c1 = Math.min(w - 1, Math.ceil((wx + radiusM - rect.x0) / sx));
  const r0 = Math.max(0, Math.floor((wz - radiusM - rect.z0) / sz));
  const r1 = Math.min(h - 1, Math.ceil((wz + radiusM - rect.z0) / sz));
  if (c0 > c1 || r0 > r1) return null;
  for (let r = r0; r <= r1; r++) {
    for (let c = c0; c <= c1; c++) {
      const dx = rect.x0 + c * sx - wx, dz = rect.z0 + r * sz - wz;
      const d = Math.hypot(dx, dz);
      if (d > radiusM) continue;
      const f = Math.cos((d / radiusM) * Math.PI * 0.5) ** 2;
      const i = r * w + c, v = e.cells[i];
      const nv = mode === "ocean"
        ? Math.min(v, Math.round(255 * (1 - Math.min(1, f * 4))))
        : Math.max(v, Math.round(255 * Math.min(1, f * 4)));
      e.cells[i] = Math.round(nv / 17) * 17;
    }
  }
  e.dirty = true; e.rev++;
  return { c0, r0, c1, r1 };
}

function origBiomeDab(e, wx, wz, { value, radiusM }) {
  const { w, h, rect } = e;
  const sx = rect.w / (w - 1), sz = rect.h / (h - 1);
  const c0 = Math.max(0, Math.floor((wx - radiusM - rect.x0) / sx));
  const c1 = Math.min(w - 1, Math.ceil((wx + radiusM - rect.x0) / sx));
  const r0 = Math.max(0, Math.floor((wz - radiusM - rect.z0) / sz));
  const r1 = Math.min(h - 1, Math.ceil((wz + radiusM - rect.z0) / sz));
  if (c0 > c1 || r0 > r1) return null;
  for (let r = r0; r <= r1; r++) {
    for (let c = c0; c <= c1; c++) {
      const dx = rect.x0 + c * sx - wx, dz = rect.z0 + r * sz - wz;
      if (dx * dx + dz * dz <= radiusM * radiusM) e.cells[r * w + c] = value;
    }
  }
  e.dirty = true; e.rev = (e.rev || 0) + 1;
  return { c0, r0, c1, r1 };
}

const ORIG_BRUSH_MODES = new Set(["raise", "lower", "smooth", "level"]);
const ELEV_MIN_Y = -500, ELEV_MAX_Y = 9000;
function origRange(g) {
  const minY = g ? g.minY : ELEV_MIN_Y, maxY = g ? g.maxY : ELEV_MAX_Y;
  if (!Number.isFinite(minY) || !Number.isFinite(maxY) || !(maxY > minY)) throw new RangeError("elevation: minY/maxY must be finite with maxY > minY");
  return { minY, maxY };
}
function origYToVal(y, g) {
  const { minY, maxY } = origRange(g);
  if (!Number.isFinite(y)) throw new TypeError("elevation: height must be finite");
  if (y < minY || y > maxY) throw new RangeError(`elevation: height ${y}m is outside [${minY}, ${maxY}]m`);
  return Math.round(((y - minY) / (maxY - minY)) * ELEV_QUANT_MAX);
}
function origBrushDab(e, wx, wz, { mode, radiusM, strength, levelY }) {
  if (!(e.cells instanceof Uint16Array) || e.cells.length !== e.w * e.h) throw new TypeError("elevation: brush requires a valid live u16 raster");
  if (!Number.isFinite(radiusM) || radiusM <= 0 || !Number.isFinite(strength) || strength < 0 || strength > 1) throw new RangeError("elevation: invalid brush radius/strength");
  if (!ORIG_BRUSH_MODES.has(mode)) throw new Error(`elevation: unknown brush mode "${mode}"`);
  const levelValue = mode === "level" ? origYToVal(levelY, e) : 0;
  const cellW = e.rect.w / (e.w - 1), cellH = e.rect.h / (e.h - 1);
  const cc = (wx - e.rect.x0) / cellW, cr = (wz - e.rect.z0) / cellH;
  const rc = radiusM / cellW, rr = radiusM / cellH;
  const c0 = Math.max(0, Math.floor(cc - rc)), c1 = Math.min(e.w - 1, Math.ceil(cc + rc));
  const r0 = Math.max(0, Math.floor(cr - rr)), r1 = Math.min(e.h - 1, Math.ceil(cr + rr));
  if (c1 < c0 || r1 < r0) return null;
  const stepPerDab = ((e.maxY - e.minY) / ELEV_QUANT_MAX);
  const amount = strength === 0 ? 0 : Math.max(1, (1.2 * strength) / stepPerDab);
  const src = mode === "smooth" ? e.cells.slice() : null;
  for (let r = r0; r <= r1; r++) {
    for (let c = c0; c <= c1; c++) {
      const dx = (c - cc) / rc, dz = (r - cr) / rr;
      const d = Math.hypot(dx, dz);
      if (d > 1) continue;
      const fall = Math.cos((d * Math.PI) / 2) ** 2;
      const i = r * e.w + c;
      let v = e.cells[i];
      if (mode === "raise") v += amount * fall;
      else if (mode === "lower") v -= amount * fall;
      else if (mode === "level") v += (levelValue - v) * 0.35 * strength * fall;
      else if (mode === "smooth") {
        const cm = Math.max(0, c - 1), cp = Math.min(e.w - 1, c + 1);
        const rm = Math.max(0, r - 1), rp = Math.min(e.h - 1, r + 1);
        const avg = (src[r * e.w + cm] + src[r * e.w + cp] + src[rm * e.w + c] + src[rp * e.w + c]) / 4;
        v += (avg - v) * 0.3 * (0.5 + 0.5 * strength) * fall;
      }
      e.cells[i] = Math.max(0, Math.min(ELEV_QUANT_MAX, Math.round(v)));
    }
  }
  e.dirty = true;
  return { c0, r0, c1, r1 };
}
// ── end originals ─────────────────────────────────────────────────────────────

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const RECT = { x0: -480, z0: -320, w: 960, h: 640 };
const landFixture = () => ({ w: 96, h: 64, rect: RECT, cells: new Uint8Array(96 * 64), dirty: false, rev: 0 });
const elevFixture = () => ({
  w: 96, h: 64, rect: RECT, cells: new Uint16Array(96 * 64),
  minY: ELEV_MIN_Y, maxY: ELEV_MAX_Y, dirty: false,
});

test("landDab parity: 200 seeded dabs, byte-identical raster + rev + bbox", () => {
  const rand = mulberry32(0x1a0d);
  const a = landFixture();
  const b = landFixture();
  for (let i = 0; i < 200; i++) {
    const dab = {
      mode: rand() < 0.5 ? "land" : "ocean",
      radiusM: 5 + rand() * 300,
    };
    const wx = RECT.x0 - 50 + rand() * (RECT.w + 100);
    const wz = RECT.z0 - 50 + rand() * (RECT.h + 100);
    const ba = landDab(a, wx, wz, dab);
    const bb = origLandDab(b, wx, wz, dab);
    assert.deepEqual(ba, bb, `bbox diverged at dab ${i}`);
    assert.deepEqual(a.cells, b.cells, `landmass raster diverged at dab ${i}`);
    assert.equal(a.rev, b.rev);
    assert.equal(a.dirty, b.dirty);
  }
});

test("biomeDab parity: 200 seeded dabs incl. erase + off-map", () => {
  const rand = mulberry32(0xb10be);
  const a = landFixture();
  const b = landFixture();
  for (let i = 0; i < 200; i++) {
    const dab = { value: Math.floor(rand() * 8), radiusM: 4 + rand() * 260 };
    const wx = RECT.x0 - 80 + rand() * (RECT.w + 160);
    const wz = RECT.z0 - 80 + rand() * (RECT.h + 160);
    assert.deepEqual(biomeDab(a, wx, wz, dab), origBiomeDab(b, wx, wz, dab), `bbox diverged at dab ${i}`);
    assert.deepEqual(a.cells, b.cells, `biome raster diverged at dab ${i}`);
    assert.equal(a.rev, b.rev);
  }
});

test("elevationDab parity: 200 seeded dabs across all four modes", () => {
  const rand = mulberry32(0xe7e7);
  const modes = ["raise", "lower", "smooth", "level"];
  const a = elevFixture();
  const b = elevFixture();
  for (let i = 0; i < 200; i++) {
    const dab = {
      mode: modes[Math.floor(rand() * modes.length)],
      radiusM: 2 + rand() * 200,
      strength: Math.floor(rand() * 21) / 20, // 0, 0.05 … 1.0 incl. both bounds
      levelY: -500 + rand() * 9500,
    };
    const wx = RECT.x0 - 40 + rand() * (RECT.w + 80);
    const wz = RECT.z0 - 40 + rand() * (RECT.h + 80);
    assert.deepEqual(elevationDab(a, wx, wz, dab), origBrushDab(b, wx, wz, dab), `bbox diverged at dab ${i} (${dab.mode})`);
    assert.deepEqual(a.cells, b.cells, `elevation raster diverged at dab ${i} (${dab.mode})`);
    assert.equal(a.dirty, b.dirty);
  }
});

test("yToVal/valToY: boundary + range errors + round-trip", () => {
  assert.equal(yToVal(ELEV_MIN_Y), 0);
  assert.equal(yToVal(ELEV_MAX_Y), ELEV_QUANT_MAX);
  assert.equal(valToY(0), ELEV_MIN_Y);
  assert.equal(valToY(ELEV_QUANT_MAX), ELEV_MAX_Y);
  assert.equal(yToVal(valToY(12345)), 12345);
  assert.throws(() => yToVal(-501), RangeError);
  assert.throws(() => yToVal(Number.NaN), TypeError);
  assert.throws(() => valToY(65536), RangeError);
});

test("elevationDab input guards match the original contract", () => {
  const e = elevFixture();
  assert.throws(() => elevationDab(e, 0, 0, { mode: "raise", radiusM: 0, strength: 0.5 }), RangeError);
  assert.throws(() => elevationDab(e, 0, 0, { mode: "raise", radiusM: 10, strength: 1.5 }), RangeError);
  assert.throws(() => elevationDab(e, 0, 0, { mode: "nope", radiusM: 10, strength: 0.5 }), /unknown brush mode/);
  assert.throws(() => elevationDab({ ...e, cells: new Uint8Array(4) }, 0, 0, { mode: "raise", radiusM: 10, strength: 0.5 }), TypeError);
});
