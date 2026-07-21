// Atlas paint kernels (Editor 2.0, D2): the brush dab math for the native Atlas
// surface. Faithful ports of the retired Atlas SPA's map-paint.js (landDab,
// biomeDab) and map-elevation.js (brushDab, now tools/design/map-elevation.js);
// byte-parity is enforced by
// editor/test/atlas_paint_kernels.test.mjs (differential, not eyeball).
//
// Every dab mutates `e.cells` in place and returns the touched cell bbox (or
// null) — the undo command captures exactly this bbox (before/after slices),
// so the stroke commit and its inverse are always the same rectangle.

export const ELEV_MIN_Y = -500; // configured Atlas authoring floor (deep ocean / trenches)
export const ELEV_MAX_Y = 9000; // configured Atlas authoring ceiling (Everest-class peaks)
export const ELEV_QUANT_MAX = 65535;

// Brush falloff shapes. cos2 is the ORIGINAL (differential parity with the old
// frontend is asserted against it); the rest are 2.0 extensions — declared per
// brush via the Tool Contract, evaluated here.
export const FALLOFFS = {
  cos2: (d) => Math.cos(d * Math.PI * 0.5) ** 2,
  linear: (d) => 1 - d,
  smoothstep: (d) => 1 - d * d * (3 - 2 * d),
  sharp: (d) => Math.sqrt(Math.max(0, 1 - d)),
};

function falloffFn(falloff) {
  if (falloff === undefined) return FALLOFFS.cos2;
  const fn = FALLOFFS[falloff];
  if (fn === undefined) throw new Error(`unknown falloff "${falloff}"`);
  return fn;
}

// Deterministic per-cell hash noise (Squirrel3-style integer mix): noise modes
// must reproduce EXACTLY cell-for-cell on undo/redo and on any re-render — no
// RNG state may leak into a dab.
function cellNoise(c, r, seed) {
  let v = (c * 0xb5297a4d) ^ (r * 0x68e31da4) ^ (seed * 0x1b56c4e9);
  v = Math.imul(v ^ (v >>> 8), 0x85ebca6b);
  v ^= v >>> 13;
  v = Math.imul(v, 0xc2b2ae35);
  v ^= v >>> 16;
  return ((v >>> 0) / 4294967296) * 2 - 1; // [-1, 1)
}

function elevationRange(g) {
  const minY = g ? g.minY : ELEV_MIN_Y;
  const maxY = g ? g.maxY : ELEV_MAX_Y;
  if (!Number.isFinite(minY) || !Number.isFinite(maxY) || !(maxY > minY)) {
    throw new RangeError("elevation: minY/maxY must be finite with maxY > minY");
  }
  return { minY, maxY };
}

export function yToVal(y, g) {
  const { minY, maxY } = elevationRange(g);
  if (!Number.isFinite(y)) throw new TypeError("elevation: height must be finite");
  if (y < minY || y > maxY) throw new RangeError(`elevation: height ${y}m is outside [${minY}, ${maxY}]m`);
  return Math.round(((y - minY) / (maxY - minY)) * ELEV_QUANT_MAX);
}

export function valToY(v, g) {
  const { minY, maxY } = elevationRange(g);
  if (!Number.isFinite(v) || v < 0 || v > ELEV_QUANT_MAX) throw new RangeError(`elevation: quantized value ${v} is outside u16`);
  return (v / ELEV_QUANT_MAX) * (maxY - minY) + minY;
}

/** One landmass dab. mode "land" raises toward 255, "ocean" carves toward 0;
 *  overdrive (the old fixed x4) is now the strength option; falloff defaults to
 *  the original cos². Returns the touched cell bbox or null. */
export function landDab(e, wx, wz, { mode, radiusM, strength = 4, falloff }) {
  const { w, h, rect } = e;
  if (!Number.isFinite(strength) || strength <= 0 || strength > 16) {
    throw new RangeError("land: strength must be in (0, 16]");
  }
  const fall = falloffFn(falloff);
  const sx = rect.w / (w - 1);
  const sz = rect.h / (h - 1);
  const c0 = Math.max(0, Math.floor((wx - radiusM - rect.x0) / sx));
  const c1 = Math.min(w - 1, Math.ceil((wx + radiusM - rect.x0) / sx));
  const r0 = Math.max(0, Math.floor((wz - radiusM - rect.z0) / sz));
  const r1 = Math.min(h - 1, Math.ceil((wz + radiusM - rect.z0) / sz));
  if (c0 > c1 || r0 > r1) return null;
  for (let r = r0; r <= r1; r++) {
    for (let c = c0; c <= c1; c++) {
      const dx = rect.x0 + c * sx - wx;
      const dz = rect.z0 + r * sz - wz;
      const d = Math.hypot(dx, dz);
      if (d > radiusM) continue;
      const f = fall(d / radiusM); // 1 at center -> 0 at edge
      const i = r * w + c;
      const v = e.cells[i];
      // Over-drive: the inner part of the brush paints SOLID land, only the rim
      // is shore gradient — a beach skirt, not a halo half the brush wide.
      const nv = mode === "ocean"
        ? Math.min(v, Math.round(255 * (1 - Math.min(1, f * strength))))
        : Math.max(v, Math.round(255 * Math.min(1, f * strength)));
      // Quantize the shore gradient to 16 levels (multiples of 17, preserving 0 and
      // 255): visually identical at map zoom, but rle8 runs get ~5-10x longer.
      e.cells[i] = Math.round(nv / 17) * 17;
    }
  }
  e.dirty = true;
  e.rev = (e.rev || 0) + 1;
  return { c0, r0, c1, r1 };
}

/** One biome dab: writes the class value (0 erases) hard within the radius — a
 *  paletted raster has no per-cell alpha; the soft look comes from the render. */
export function biomeDab(e, wx, wz, { value, radiusM }) {
  const { w, h, rect } = e;
  const sx = rect.w / (w - 1);
  const sz = rect.h / (h - 1);
  const c0 = Math.max(0, Math.floor((wx - radiusM - rect.x0) / sx));
  const c1 = Math.min(w - 1, Math.ceil((wx + radiusM - rect.x0) / sx));
  const r0 = Math.max(0, Math.floor((wz - radiusM - rect.z0) / sz));
  const r1 = Math.min(h - 1, Math.ceil((wz + radiusM - rect.z0) / sz));
  if (c0 > c1 || r0 > r1) return null;
  for (let r = r0; r <= r1; r++) {
    for (let c = c0; c <= c1; c++) {
      const dx = rect.x0 + c * sx - wx;
      const dz = rect.z0 + r * sz - wz;
      if (dx * dx + dz * dz <= radiusM * radiusM) e.cells[r * w + c] = value;
    }
  }
  e.dirty = true;
  e.rev = (e.rev || 0) + 1;
  return { c0, r0, c1, r1 };
}

const BRUSH_MODES = new Set(["raise", "lower", "smooth", "level", "noise", "flatten"]);

/** One elevation dab. mode: raise|lower|smooth|level. radiusM in meters,
 *  strength 0..1, `levelY` the target for level. Smooth cos² falloff. */
export function elevationDab(e, wx, wz, { mode, radiusM, strength, levelY, falloff, seed = 0 }) {
  if (!(e.cells instanceof Uint16Array) || e.cells.length !== e.w * e.h) {
    throw new TypeError("elevation: brush requires a valid live u16 raster");
  }
  if (!Number.isFinite(radiusM) || radiusM <= 0 || !Number.isFinite(strength) || strength < 0 || strength > 1) {
    throw new RangeError("elevation: invalid brush radius/strength");
  }
  if (!BRUSH_MODES.has(mode)) throw new Error(`elevation: unknown brush mode "${mode}"`);
  const fallFn = falloffFn(falloff);
  const levelValue = mode === "level" || mode === "flatten" ? yToVal(levelY, e) : 0;
  const cellW = e.rect.w / (e.w - 1);
  const cellH = e.rect.h / (e.h - 1);
  const cc = (wx - e.rect.x0) / cellW;
  const cr = (wz - e.rect.z0) / cellH;
  const rc = radiusM / cellW;
  const rr = radiusM / cellH;
  const c0 = Math.max(0, Math.floor(cc - rc));
  const c1 = Math.min(e.w - 1, Math.ceil(cc + rc));
  const r0 = Math.max(0, Math.floor(cr - rr));
  const r1 = Math.min(e.h - 1, Math.ceil(cr + rr));
  if (c1 < c0 || r1 < r0) return null;
  const stepPerDab = (e.maxY - e.minY) / ELEV_QUANT_MAX;
  // raise/lower move up to ~1.2m per dab at strength 1; level pulls 35%/dab; smooth
  // blends 30%/dab. Across 9.5km one u16 step is ~0.145m, so without this explicit
  // floor the weakest center dab rounds to zero and the brush appears broken.
  const amount = strength === 0 ? 0 : Math.max(1, (1.2 * strength) / stepPerDab);
  const src = mode === "smooth" ? e.cells.slice() : null;
  for (let r = r0; r <= r1; r++) {
    for (let c = c0; c <= c1; c++) {
      const dx = (c - cc) / rc;
      const dz = (r - cr) / rr;
      const d = Math.hypot(dx, dz);
      if (d > 1) continue;
      const fall = fallFn(d);
      const i = r * e.w + c;
      let v = e.cells[i];
      if (mode === "raise") v += amount * fall;
      else if (mode === "lower") v -= amount * fall;
      else if (mode === "level") v += (levelValue - v) * 0.35 * strength * fall;
      else if (mode === "flatten") v += (levelValue - v) * 0.5 * strength * fall;
      else if (mode === "noise") {
        // Deterministic per-cell displacement: same stroke seed + same cells =
        // same terrain on undo/redo. 4x the raise amount — a noise brush must
        // roughen visibly (±~4.8m per dab at strength 1), not tickle.
        v += amount * 4 * fall * cellNoise(c, r, seed);
      }
      else if (mode === "smooth") {
        const cm = Math.max(0, c - 1);
        const cp = Math.min(e.w - 1, c + 1);
        const rm = Math.max(0, r - 1);
        const rp = Math.min(e.h - 1, r + 1);
        const avg = (src[r * e.w + cm] + src[r * e.w + cp] + src[rm * e.w + c] + src[rp * e.w + c]) / 4;
        v += (avg - v) * 0.3 * (0.5 + 0.5 * strength) * fall;
      }
      // Saturation at the authoring boundary is deliberate brush behavior, unlike
      // persistence/import conversions which must never silently clamp.
      e.cells[i] = Math.max(0, Math.min(ELEV_QUANT_MAX, Math.round(v)));
    }
  }
  e.dirty = true;
  return { c0, r0, c1, r1 };
}
