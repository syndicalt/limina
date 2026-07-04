// Building-kit MATERIAL TEXTURES — deterministic, tileable, procedural PBR surfaces for the three
// roles a medieval building actually shows: a SLATE roof, WOOD timber framing, and rough PLASTER
// infill. Before this, every surface (walls AND roof) drew from the single generic stone-noise in
// triplanar-noise.ts, so everything read as stone. These bake bespoke height fields into the SAME
// RGBA8 DataTexture format `bakeDetailNoise()` uses (R,G = grad(height)*0.5+0.5, B = albedo value),
// so they flow through the EXACT same triplanar sampler + node wiring as the palette procedural-PBR
// (materials/procedural-pbr.ts) — no UVs, no new render path.
//
// Determinism + tiling: every field is built from integer-hash lattice noise (hashLattice) and
// periodic value/fbm noise (reused from triplanar-noise's family), and every index wraps modulo its
// tile/course/plank count, so the baked texture tiles seamlessly under RepeatWrapping. No Math.random,
// no Date — same bytes on every build.
//
// Colour constraint: `texturedRoleMaterial` keeps `material.color` = the caller's baseColorHex and
// only MODULATES albedo around it (base × mottle), exactly like applyProceduralPbr, so a downstream
// conformance gate that reads `material.color` still sees an on-palette colour.

import * as THREE from "../../build/three.bundle.mjs";
import { hashLattice } from "../terrain/procedural.ts";

// deno-lint-ignore no-explicit-any
const T = (THREE as any).TSL;

import { triplanarLayer } from "./triplanar-noise.ts";

// ── Tileable noise primitives (same family as triplanar-noise.ts, kept local so the bakers here are
//    self-contained) ─────────────────────────────────────────────────────────────────────────────
const FIELD_SEED = 0x9e3779b1 | 0;

function clamp01(x: number): number { return x < 0 ? 0 : x > 1 ? 1 : x; }
function smoothstep01(t: number): number { t = clamp01(t); return t * t * (3 - 2 * t); }
function smoothstep(a: number, b: number, x: number): number { return smoothstep01((x - a) / (b - a)); }
function lerp(a: number, b: number, t: number): number { return a + (b - a) * t; }
/** Shortest wrapped distance between two coords on the unit torus. */
function wrapDist(a: number, b: number): number { let d = Math.abs(a - b) % 1; return d > 0.5 ? 1 - d : d; }

/** Periodic value noise in [0,1] over a `period`-cell torus — bilinear smoothstep of four hashed
 *  lattice corners, indices mod `period`. Deterministic + tileable. */
function periodicValueNoise(seed: number, x: number, z: number, period: number): number {
  const ix = Math.floor(x), iz = Math.floor(z);
  const fx = x - ix, fz = z - iz;
  const wrap = (n: number) => ((n % period) + period) % period;
  const x0 = wrap(ix), x1 = wrap(ix + 1), z0 = wrap(iz), z1 = wrap(iz + 1);
  const v00 = hashLattice(seed, x0, z0), v10 = hashLattice(seed, x1, z0);
  const v01 = hashLattice(seed, x0, z1), v11 = hashLattice(seed, x1, z1);
  const ux = smoothstep01(fx), uz = smoothstep01(fz);
  return lerp(lerp(v00, v10, ux), lerp(v01, v11, ux), uz);
}

/** Tileable fbm over [0,1)²: summed octaves, each on its own (cells·2^o)-cell torus. Normalised. */
function periodicFbm(x: number, z: number, baseCells: number, octaves: number): number {
  let amp = 1, sum = 0, norm = 0, cells = baseCells;
  for (let o = 0; o < octaves; o++) {
    const s = (FIELD_SEED + Math.imul(o, 0x85ebca6b)) | 0;
    sum += amp * periodicValueNoise(s, x * cells, z * cells, cells);
    norm += amp;
    amp *= 0.5;
    cells *= 2;
  }
  return sum / norm;
}

// ── Generic baker: height + albedo field → RGBA8 DataTexture (RG = grad, B = albedo) ──────────────
// Mirrors bakeDetailNoise() byte-for-byte in format so triplanarLayer decodes it identically. The
// field returns h ∈ [0,1] (relief) and b ∈ [0,1] (albedo value) per texel (u,v ∈ [0,1)); this
// computes wrapped central-difference gradients of h, normalises by a robust cap so one sharp seam
// can't swallow the finer relief, and packs the bytes.
function bakeField(res: number, field: (u: number, v: number) => { h: number; b: number }): THREE.DataTexture {
  const h = new Float32Array(res * res);
  const b = new Float32Array(res * res);
  for (let r = 0; r < res; r++) {
    const v = r / res;
    for (let c = 0; c < res; c++) {
      const o = r * res + c;
      const f = field(c / res, v);
      h[o] = clamp01(f.h);
      b[o] = clamp01(f.b);
    }
  }
  const gx = new Float32Array(res * res);
  const gy = new Float32Array(res * res);
  const mags: number[] = [];
  for (let r = 0; r < res; r++) {
    for (let c = 0; c < res; c++) {
      const cL = (c - 1 + res) % res, cR = (c + 1) % res;
      const rU = (r - 1 + res) % res, rD = (r + 1) % res;
      const dx = (h[r * res + cR] - h[r * res + cL]) * 0.5;
      const dy = (h[rD * res + c] - h[rU * res + c]) * 0.5;
      gx[r * res + c] = dx;
      gy[r * res + c] = dy;
      mags.push(Math.abs(dx), Math.abs(dy));
    }
  }
  // Robust normaliser: the 99.5th-percentile gradient magnitude (not the raw max), so a single hard
  // shingle-step or crack doesn't compress every subtler slope into the flat mid-grey band. Values
  // above the cap simply clamp to full strength — which is what a crisp seam should read as anyway.
  mags.sort((a, b2) => a - b2);
  const cap = Math.max(1e-4, mags[Math.min(mags.length - 1, Math.floor(mags.length * 0.995))]);
  const inv = 1 / cap;
  const data = new Uint8Array(res * res * 4);
  for (let i = 0; i < h.length; i++) {
    const o = i * 4;
    data[o] = Math.round(clamp01(gx[i] * inv * 0.5 + 0.5) * 255);
    data[o + 1] = Math.round(clamp01(gy[i] * inv * 0.5 + 0.5) * 255);
    data[o + 2] = Math.round(clamp01(b[i]) * 255);
    data[o + 3] = 255;
  }
  const tex = new THREE.DataTexture(data, res, res, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  return tex;
}

// ── SLATE ─────────────────────────────────────────────────────────────────────────────────────────
// Overlapping "fish-scale" shingle courses: SLATE_COURSES rows × SLATE_TILES columns, brick-staggered
// (odd courses offset half a tile). Each shingle is a rounded-bottom scale that steps proud over the
// course below at its butt edge (strong gradient → the shingle relief + its self-shadow), and drops
// into a groove at the side seams between neighbouring tiles. Overlap is resolved by taking the MAX
// height over the current + lower candidate courses — the higher (nearer-butt) scale wins, so a
// course visibly laps the one beneath it. B = per-tile tone (hashLattice per shingle) so tiles differ.
const SLATE_RES = 512;
const SLATE_COURSES = 6;   // must be even so the half-tile stagger tiles across the v wrap
const SLATE_TILES = 8;
const SLATE_OVERLAP = 1.55; // how far up (in course-heights) a shingle extends → laps the next course
const SLATE_ROUND = 0.42;   // depth of the rounded (scalloped) bottom edge

/** Height of the shingle belonging to course `k` at (u, vk = vv−k). Returns -1 where this pixel is
 *  outside that shingle (below its rounded butt or above its top). */
function slateScale(u: number, vk: number, k: number): number {
  const uk = u * SLATE_TILES + (((k % 2) + 2) % 2) * 0.5;
  const ti = Math.floor(uk);
  const fu = uk - ti;                                   // 0..1 across the tile width
  // Rounded (semicircle) profile across the width: 1 at centre, 0 at the side seams.
  const cap = Math.sqrt(Math.max(0, 1 - (2 * fu - 1) * (2 * fu - 1)));
  // Scalloped bottom: the butt edge curves UP at the sides, so the exposed edge is a fish-scale.
  const vb = vk - (1 - cap) * SLATE_ROUND;
  if (vb < 0 || vb > SLATE_OVERLAP) return -1;
  const t = vb / SLATE_OVERLAP;                         // 0 at butt → 1 at covered top
  const body = 1 - 0.8 * t;                             // proud at the butt, receding upward
  const side = smoothstep(0.0, 0.16, cap);             // groove at the side seams
  return body * side;
}

function slateField(u: number, v: number): { h: number; b: number } {
  const vv = v * SLATE_COURSES;
  const ci = Math.floor(vv);
  // Overlap: consider the current course and the one below (whose scales reach up over this course).
  let best = -1, bestK = ci;
  for (const k of [ci, ci - 1]) {
    const hk = slateScale(u, vv - k, k);
    if (hk > best) { best = hk; bestK = k; }
  }
  // Gap (between/under scallops) → a low shadow groove; otherwise map the scale relief into [0.28,1].
  const h = best < 0 ? 0.08 : 0.28 + 0.72 * best;
  // Per-tile tone: hash of the WINNING shingle's (column, course), indices wrapped so it tiles.
  const uk = u * SLATE_TILES + (((bestK % 2) + 2) % 2) * 0.5;
  const ti = ((Math.floor(uk) % SLATE_TILES) + SLATE_TILES) % SLATE_TILES;
  const ck = ((bestK % SLATE_COURSES) + SLATE_COURSES) % SLATE_COURSES;
  const tone = hashLattice(0x51a7e | 0, ti, ck);        // 0..1 per shingle
  // A little within-tile blue-grey grain so a face isn't dead flat.
  const grain = periodicValueNoise(0xb1a2 | 0, u * 40, v * 40, 40);
  const b = clamp01(0.34 + tone * 0.42 + (grain - 0.5) * 0.10 + best * 0.06);
  return { h, b };
}

let SLATE_TEX: THREE.DataTexture | null = null;
/** Lazy singleton: the baked slate-shingle texture (bake once). */
export function slateTexture(): THREE.DataTexture {
  if (SLATE_TEX === null) SLATE_TEX = bakeField(SLATE_RES, slateField);
  return SLATE_TEX;
}

// ── WOOD ────────────────────────────────────────────────────────────────────────────────────────
// Planks stacked across v (WOOD_PLANKS of them), each running along u. Deep grooves between planks;
// fine grain lines running ALONG the plank (a v-frequency sinusoid made wavy by periodic noise, so
// the streaks lie parallel to the length); an occasional knot (radial rings + dark core) on some
// planks. B = grain darkening + plank-to-plank tone + knot core.
const WOOD_RES = 512;
const WOOD_PLANKS = 5;
const WOOD_GRAIN_LINES = 22;  // integer → grain sinusoid tiles across v

function woodField(u: number, v: number): { h: number; b: number } {
  const pv = v * WOOD_PLANKS;
  const pi = ((Math.floor(pv) % WOOD_PLANKS) + WOOD_PLANKS) % WOOD_PLANKS;
  const fpv = pv - Math.floor(pv);                       // 0..1 across the plank width
  // Groove between planks: → 0 at the seams (fpv near 0/1), 1 across the plank body.
  const groove = smoothstep(0.0, 0.07, fpv) * smoothstep(1.0, 0.93, fpv);
  // Grain: lines along u. Wave the v-frequency sinusoid with periodic noise so it isn't ruler-straight.
  const wob = (periodicValueNoise(0x9c3 | 0, u * 3, v * 3, 6) - 0.5) * 0.28
    + (periodicValueNoise(0x7d1 | 0, u * 6, v * 6, 12) - 0.5) * 0.12;
  const grain = 0.5 + 0.5 * Math.sin(2 * Math.PI * (v * WOOD_GRAIN_LINES + wob));
  const plankTone = hashLattice(0x2c7a1 | 0, pi, 3);     // per-plank base tone
  // Occasional knot: about half the planks carry one, at a hashed position along the plank.
  const hasKnot = hashLattice(0x4e11 | 0, pi, 7) < 0.5;
  let knotH = 0, knotDark = 0;
  if (hasKnot) {
    const ku = hashLattice(0x4e12 | 0, pi, 8);            // knot centre along u
    const kv = (pi + 0.35 + hashLattice(0x4e13 | 0, pi, 9) * 0.3) / WOOD_PLANKS;
    const du = wrapDist(u, ku), dv = Math.abs(v - kv);
    const d = Math.sqrt(du * du + dv * dv);
    const kr = 0.045;
    if (d < kr) {
      const rings = 0.5 + 0.5 * Math.cos(d / kr * Math.PI * 4);
      knotH = (1 - d / kr) * (0.35 + 0.25 * rings);       // raised knot with rings
      knotDark = (1 - d / kr) * 0.5;                      // darker core
    }
  }
  // Height: plank body proud, grooves cut deep, grain a subtle relief, knot rides on top.
  const h = clamp01(0.12 + 0.6 * groove + (grain - 0.5) * 0.14 * groove + knotH);
  // Albedo: grain darkening + plank tone, grooves read as dark seams, knot core darker.
  const b = clamp01(0.5 + (plankTone - 0.5) * 0.28 + (grain - 0.5) * 0.34
    - (1 - groove) * 0.22 - knotDark * 0.4);
  return { h, b };
}

let WOOD_TEX: THREE.DataTexture | null = null;
/** Lazy singleton: the baked wood-plank texture (bake once). */
export function woodTexture(): THREE.DataTexture {
  if (WOOD_TEX === null) WOOD_TEX = bakeField(WOOD_RES, woodField);
  return WOOD_TEX;
}

// ── PLASTER ──────────────────────────────────────────────────────────────────────────────────────
// Rough daub: lumpy low-frequency fbm relief (NOT smooth, NOT stone-craggy) + a faint finer grain,
// with an occasional hairline crack cut in. B = the lump mottle + a subtle independent low-freq stain
// so the surface reads weathered/dirtied rather than a flat colour.
const PLASTER_RES = 512;

function plasterField(u: number, v: number): { h: number; b: number } {
  const lump = periodicFbm(u, v, 4, 5);                  // big soft undulations
  const med = periodicFbm(u + 0.11, v + 0.23, 9, 4);     // medium daub bumps — the rough "tooth"
  const fine = periodicFbm(u, v, 20, 3);                 // fine surface grit
  let h = 0.5 + (lump - 0.5) * 0.45 + (med - 0.5) * 0.5 + (fine - 0.5) * 0.22;
  // One meandering hairline crack (+ a short branch). The path is periodic in v so it tiles; the
  // horizontal position uses wrapped distance so it tiles in u too.
  const crackU = 0.5 + 0.08 * Math.sin(2 * Math.PI * v) + (periodicValueNoise(0x3f1 | 0, v * 5, 0, 5) - 0.5) * 0.12;
  const dc = wrapDist(u, crackU);
  const crack = smoothstep(0.012, 0.0, dc);              // 1 on the crack line → 0 away
  const branchU = crackU + 0.14 + (periodicValueNoise(0x3f2 | 0, v * 7, 1, 7) - 0.5) * 0.06;
  const branchActive = v > 0.35 && v < 0.62 ? 1 : 0;
  const branch = smoothstep(0.008, 0.0, wrapDist(u, branchU)) * branchActive;
  const crackAmt = Math.max(crack, branch * 0.8);
  h -= crackAmt * 0.3;                                   // the crack is a groove
  const b0 = 0.55 + (lump - 0.5) * 0.18 + (med - 0.5) * 0.16; // mottle from the lumps + daub bumps
  const stain = periodicFbm(u + 0.37, v + 0.19, 3, 3);   // independent low-freq discolouration
  const b = clamp01(b0 + (stain - 0.5) * 0.22 - crackAmt * 0.3);
  return { h: clamp01(h), b };
}

let PLASTER_TEX: THREE.DataTexture | null = null;
/** Lazy singleton: the baked plaster-daub texture (bake once). */
export function plasterTexture(): THREE.DataTexture {
  if (PLASTER_TEX === null) PLASTER_TEX = bakeField(PLASTER_RES, plasterField);
  return PLASTER_TEX;
}

// ── Material builder ───────────────────────────────────────────────────────────────────────────────
export type TextureKind = "slate" | "wood" | "plaster";

interface KindDefaults { scale: number; normalStrength: number; mottle: number; roughVar: number; sharpness: number }

// Per-kind defaults. `scale` is cycles/m for the triplanar projection: the baked image spans one
// pattern period (SLATE → 8 tiles × 6 courses, WOOD → 5 planks, PLASTER → a few lumps), so 1/scale is
// the world size of that period. slate 0.5 → 2 m period → tiles ≈0.25 m; wood 0.6 → ~1.67 m period →
// planks ≈0.33 m wide; plaster 0.4 → 2.5 m lumps, right for a ~3 m wall / ~8 m roof.
const KIND_DEFAULTS: Record<TextureKind, KindDefaults> = {
  slate: { scale: 0.5, normalStrength: 0.95, mottle: 0.18, roughVar: 0.10, sharpness: 4 },
  wood: { scale: 0.6, normalStrength: 0.6, mottle: 0.30, roughVar: 0.14, sharpness: 4 },
  plaster: { scale: 0.4, normalStrength: 0.85, mottle: 0.22, roughVar: 0.16, sharpness: 4 },
};

function kindTexture(kind: TextureKind): THREE.DataTexture {
  return kind === "slate" ? slateTexture() : kind === "wood" ? woodTexture() : plasterTexture();
}

/**
 * Build a MeshStandardNodeMaterial whose surface is the baked `kind` texture, projected TRIPLANARLY
 * (no UVs) exactly like applyProceduralPbr: `colorNode` = baseColorHex × (1 + (value−0.5)·mottle),
 * `normalNode` = the baked detail normal in view space, `roughnessNode` = roughness ± value·roughVar.
 *
 * The visible albedo stays a VARIATION around `baseColorHex` (never a wholesale new colour), so a
 * conformance gate reading `material.color` still sees the on-palette base. Pass a base hex that
 * suits the role (e.g. slate ≈ 0x3b4653, timber ≈ 0x6b4a2f, plaster ≈ 0xcfc6b4).
 */
export function texturedRoleMaterial(
  kind: TextureKind,
  baseColorHex: number,
  roughness: number,
  opts?: { metalness?: number; scale?: number; normalStrength?: number; mottle?: number; roughVar?: number; sharpness?: number },
): THREE.MeshStandardNodeMaterial {
  const d = KIND_DEFAULTS[kind];
  const scale = opts?.scale ?? d.scale;
  const normalStrength = opts?.normalStrength ?? d.normalStrength;
  const mottle = opts?.mottle ?? d.mottle;
  const roughVar = opts?.roughVar ?? d.roughVar;
  const sharpness = opts?.sharpness ?? d.sharpness;
  const metalness = opts?.metalness ?? 0;

  const material = new THREE.MeshStandardNodeMaterial({ color: baseColorHex, roughness, metalness });
  const layer = triplanarLayer(kindTexture(kind), scale, normalStrength, sharpness);

  // Albedo: base colour modulated by the pattern value (controlled band around the base).
  const c = new THREE.Color(baseColorHex);
  const baseV = T.vec3(c.r, c.g, c.b);
  material.colorNode = baseV.mul(layer.value.sub(0.5).mul(mottle).add(1));

  // Detail NORMAL → view space (the proven terrain/water idiom).
  material.normalNode = T.transformNormalToView(layer.normal.normalize());

  // Roughness: honest variation around the preset, driven by the pattern value.
  material.roughnessNode = T.clamp(T.float(roughness).add(layer.value.sub(0.5).mul(roughVar)), 0, 1);

  return material;
}
