// Phase 11 — OPT-IN procedural PBR terrain surface ("Grounded Stylized Realism").
//
// The flat ramp (terrain/render.ts `applyBiomeRamp`) shades a tile by elevation+climate
// into a single flat `colorNode`/`roughnessNode` — believable bands, but a CLAY read: no
// surface micro-relief, so light lands the same everywhere inside a band. This module is the
// opt-in upgrade: it keeps the EXACT same band logic (so the rock/grass/snow/sand zones land
// in the same places), but each band is now a real MATERIAL LAYER — procedural albedo + a
// real detail NORMAL + honest roughness — projected TRIPLANARLY (no UV stretch on slopes) and
// blended by the same slope+height+biome weights. The detail normals are the key "not clay"
// lever: they break up the flat shading so rock reads craggy, sand reads rippled, grass reads
// grained, snow reads soft — PBR-grounded but stylized + readable, not photoreal.
//
// RENDER-ONLY + OPT-IN: invoked only when `TerrainMeshOptions.pbr` is set (supersedes
// palette/shoreline). When absent the material keeps the flat-colour defaults byte-for-byte —
// no sim/physics/log impact, no regression to the default path.
//
// NOISE SOURCE — BAKED, not in-shader. The three TSL build here exposes MaterialX in-shader
// noise (`mx_noise_float`/`mx_noise_vec3`), but a single small tileable noise DataTexture is
// baked once at module load and sampled, because:
//   • PROVEN on this backend — DataTexture + `texture()` is the exact path water.ts and the
//     flat ramp already compile + run on deno_webgpu; in-shader mx_noise compiling to valid
//     WGSL on this backend is unverified (the look is windowed-only UAT, so we don't gamble).
//   • DETERMINISTIC — the bake is a pure function of a fixed seed (render-only; never the log).
//   • PERFORMANT over many tiles — the texture is a SHARED module-level singleton (baked once,
//     reused by every tile's material), and baking the gradient INTO the texture means the
//     per-layer detail-normal strength is a cheap multiply, with no per-fragment noise eval.
//     Cost per fragment is a fixed set of texture fetches (3 planes × the active layers), the
//     same primitive the proven ramp/water shaders already use.
//
// The bake + triplanar sampling now live in materials/triplanar-noise.ts (shared with the
// palette procedural-PBR primitives + the texture-pack import), so terrain and primitives draw
// from the SAME baked detail singleton — one upload, one implementation, identical grain.

import * as THREE from "../../build/three.bundle.mjs";
import type { TerrainTile } from "./types.ts";
import { sharedDetailTexture, triplanarLayer } from "../materials/triplanar-noise.ts";
import { bakeTileClimate, RAMP_DEFAULT_COLORS, shorelineBandMasks, type TerrainPaletteOptions } from "./render.ts";

// TSL handle (loosely typed — the fluent node API is dynamic; the graph is validated by the
// live WebGPU shader compile / in-tab UAT, and its CONSTRUCTION by js/test/p11_terrain_pbr.ts).
// deno-lint-ignore no-explicit-any
const T = (THREE as any).TSL;

/**
 * OPT-IN procedural-PBR surface recipe (via `TerrainMeshOptions.pbr`). Extends the flat ramp's
 * band options (`TerrainPaletteOptions`) — the SAME `seaLevel`/relief/climate/coast knobs place
 * the bands — and adds the per-layer surface-detail knobs. Only `seaLevel` is required.
 */
export interface TerrainPbrOptions extends TerrainPaletteOptions {
  /** Per-layer surface-detail tuning. All optional; defaults are tuned to Grounded Stylized
   *  Realism (crisp detail normals, controlled albedo mottling, honest roughness). */
  detail?: {
    /** World-space detail tiling frequency (cycles per metre) per layer. Higher = finer grain.
     *  Defaults: rock 0.14 (coarse crags), grass 0.45 (fine blades), snow 0.10 (soft drifts),
     *  sand 0.55 (tight ripples). */
    rockScale?: number;
    grassScale?: number;
    snowScale?: number;
    sandScale?: number;
    /** Detail-NORMAL intensity per layer (0 = flat/clay, 1 = strong relief). The "not clay"
     *  lever. Defaults: rock 1.0, grass 0.55, snow 0.30, sand 0.7. */
    rockNormal?: number;
    grassNormal?: number;
    snowNormal?: number;
    sandNormal?: number;
    /** Albedo mottling depth per layer (0 = flat colour, ~0.35 = lively). Default 0.22. */
    mottle?: number;
    /** Triplanar blend sharpness (higher = crisper plane transitions). Default 4. */
    triplanarSharpness?: number;
  };
  /** Per-layer base roughness (PBR honesty). Defaults: rock 0.92, grass 0.85, snow 0.6,
   *  sand 0.95, subSea 0.5. */
  layerRoughness?: Partial<{ rock: number; grass: number; snow: number; sand: number; subSea: number }>;
  /** OPT-IN WET-SHORE BAND (render-only). When set, wherever the terrain meets the waterline —
   *  a steep ROCK cliff OR a gentle sandy slope — a thin band right at/around sea level is
   *  DARKENED (wet look) over WHATEVER layer is there and made glossier (lower roughness), with
   *  an optional bright foam line exactly at sea level. Keyed to world-Y vs `seaLevel` (ground-
   *  truth, no depth buffer) using the SAME contact-band math as the flat ramp's shoreline
   *  (render.ts shorelineBandMasks). Omit to leave the surface byte-identical (default off). */
  waterline?: {
    /** Sea-level world Y the band centres on. Default: the material's `seaLevel`. */
    seaLevel?: number;
    /** Half-height (world Y) of the wet band above/below the waterline. Default 1.2. */
    wetBand?: number;
    /** Half-height (world Y) of the bright foam line. Default 0.25. */
    foamBand?: number;
    /** Albedo multiply at the wettest point (0..1; lower = darker/wetter). Default 0.55. */
    darken?: number;
    /** Roughness in the wet band (wet surfaces are glossier). Default 0.32. */
    wetRoughness?: number;
    /** Foam-line strength (0 disables the foam line). Default 0.5. */
    foam?: number;
    /** Foam colour. Default 0xf2f6f4 (sea-foam white). */
    foamColor?: number;
  };
}

/**
 * Apply the OPT-IN procedural-PBR surface to a terrain tile material. Sets `colorNode`,
 * `normalNode`, and `roughnessNode` from triplanar procedural layers blended by the SAME
 * slope+height+biome bands as the flat ramp. Render-only; deterministic; no sim/log impact.
 */
export function applyPbrMaterial(material: THREE.MeshStandardNodeMaterial, tile: TerrainTile, baseRough: number, pbr: TerrainPbrOptions): void {
  const tempRange = pbr.tempRange ?? [-30, 40];
  const precipMax = pbr.precipMax ?? 3000;
  const [precipDry, precipWet] = pbr.precipBand ?? [300, 1400];
  const [tMin, tMax] = tempRange;
  const tSpan = tMax - tMin;

  const cols = { ...RAMP_DEFAULT_COLORS, ...(pbr.colors ?? {}) };
  const C = (hex: number) => { const c = new THREE.Color(hex); return T.vec3(c.r, c.g, c.b); };
  const subSeaV = C(cols.subSea), sandV = C(cols.sand), dryV = C(cols.dryGrass);
  const forestV = C(cols.forest), rockV = C(cols.rock), snowV = C(cols.snow);

  const d = pbr.detail ?? {};
  const sharp = d.triplanarSharpness ?? 4;
  const mottle = d.mottle ?? 0.22;
  const tex = sharedDetailTexture();
  // The four surface layers: each its own tiling + detail-normal strength (the look knobs).
  // CUT-1 PERF LIMITATION: all 4 layers × 3 triplanar planes (~12 detail fetches) + 1 climate
  // fetch are evaluated UNCONDITIONALLY per fragment — the band masks blend the results, they do
  // not gate the fetches. Fine at landscape_window tile counts; a cost cliff at km-scale tile
  // counts (e.g. model_terrain_window), so `pbr` is intentionally NOT enabled on the model demo
  // yet. PHASE-4 OPTIMIZATION: reduce to a shared fine/coarse pair (6 fetches) or branch-gate
  // layers whose mask is ~0, and/or drop to a single triplanar pass with per-layer reprojection.
  const rockL = triplanarLayer(tex, d.rockScale ?? 0.14, d.rockNormal ?? 1.0, sharp);
  const grassL = triplanarLayer(tex, d.grassScale ?? 0.45, d.grassNormal ?? 0.55, sharp);
  const snowL = triplanarLayer(tex, d.snowScale ?? 0.10, d.snowNormal ?? 0.30, sharp);
  const sandL = triplanarLayer(tex, d.sandScale ?? 0.55, d.sandNormal ?? 0.70, sharp);

  // Per-layer albedo = base band colour modulated by its own mottle (controlled, not noisy).
  // deno-lint-ignore no-explicit-any
  const mod = (val: any) => val.sub(0.5).mul(mottle).add(1); // ~[1-m/2, 1+m/2]

  // ── Relief + climate bands — identical thresholds to applyBiomeRamp (zones land the same) ──
  const sea = pbr.seaLevel;
  let minY = pbr.minY, maxY = pbr.maxY;
  if (minY === undefined || maxY === undefined) {
    const oy = tile.origin[1], sy = tile.scale[1];
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < tile.heights.length; i++) { const h = tile.heights[i]; if (h < lo) lo = h; if (h > hi) hi = h; }
    minY = pbr.minY ?? (oy + lo * sy);
    maxY = pbr.maxY ?? (oy + hi * sy);
  }
  const aboveSpan = Math.max(1e-3, maxY - sea);
  const coastBand = Math.max(1e-3, aboveSpan * (pbr.coastFrac ?? 0.06));
  const subBand = Math.max(0.5, (sea - minY) * 0.6);

  const baked = bakeTileClimate(tile, tempRange, precipMax);
  const { minX, minZ, maxX, maxZ } = baked.bounds;
  const u = T.positionWorld.x.sub(minX).div(maxX - minX);
  const v = T.positionWorld.z.sub(minZ).div(maxZ - minZ);
  const clim = T.texture(baked.texture, T.vec2(u, v));
  const tempC = clim.r.mul(tSpan).add(tMin);
  const precip = clim.g.mul(precipMax);

  const y = T.positionWorld.y;
  const r = T.clamp(y.sub(sea).div(aboveSpan), 0, 1);
  const steep = T.clamp(T.oneMinus(T.normalWorld.y), 0, 1);
  const wet = T.smoothstep(precipDry, precipWet, precip);
  const cold = T.oneMinus(T.smoothstep(-5.0, 6.0, tempC));
  const rEff = T.clamp(r.add(cold.mul(0.06)), 0, 1);

  const rockMask = T.smoothstep(0.32, 0.46, rEff);
  const snowMask = T.smoothstep(0.84, 0.95, rEff);
  const cliff = T.smoothstep(0.55, 0.82, steep).mul(T.oneMinus(snowMask)).mul(0.7);
  const coastMask = T.oneMinus(T.smoothstep(0.0, coastBand, y.sub(sea)));
  const subMask = T.smoothstep(0.0, subBand, T.float(sea).sub(y));

  // ── Albedo: blend LAYER outputs (band colour × that layer's mottle) in ramp order ──
  const grassAlbedo = T.mix(dryV, forestV, wet).mul(mod(grassL.value));
  const rockAlbedo = rockV.mul(mod(rockL.value));
  const snowAlbedo = snowV.mul(mod(snowL.value));
  const sandAlbedo = sandV.mul(mod(sandL.value));
  const subAlbedo = subSeaV.mul(mod(sandL.value));

  let col = grassAlbedo;
  col = T.mix(col, rockAlbedo, rockMask);
  col = T.mix(col, snowAlbedo, snowMask);
  col = T.mix(col, rockAlbedo, cliff);
  col = T.mix(col, sandAlbedo, coastMask);
  col = T.mix(col, subAlbedo, subMask);
  material.colorNode = col;

  // ── Detail NORMAL: blend the LAYER detail normals by the same masks, then world→view ──
  let nrm = grassL.normal;
  nrm = T.mix(nrm, rockL.normal, rockMask);
  nrm = T.mix(nrm, snowL.normal, snowMask);
  nrm = T.mix(nrm, rockL.normal, cliff);
  nrm = T.mix(nrm, sandL.normal, coastMask);
  // Under the sea the floor is wet/smooth — fade detail back toward the geometric normal.
  nrm = T.mix(nrm, T.normalWorld, subMask.mul(0.7));
  // `normalNode` is consumed directly AS the VIEW-space normal (three's setupNormal returns it
  // as-is). The terrain mesh is identity-transformed (geometry positions are already world-space),
  // so local≈world and `transformNormalToView` (model-view normal matrix = view matrix here) lands
  // the perturbed normal in view space — the proven idiom water.ts uses for its bump normal. (Do
  // NOT use `transformDirection(vec, cameraViewMatrix)`: vec-first builds Mᵀ·v = the INVERSE
  // rotation, leaving a bogus camera-dependent frame that makes the relief swim as the camera moves.)
  material.normalNode = T.transformNormalToView(nrm.normalize());

  // ── Roughness: per-layer honest roughness blended by the same masks ──
  const lr = pbr.layerRoughness ?? {};
  let rough = T.float(lr.grass ?? Math.min(baseRough, 0.85));
  rough = T.mix(rough, T.float(lr.rock ?? 0.92), rockMask);
  rough = T.mix(rough, T.float(lr.snow ?? 0.6), snowMask);
  rough = T.mix(rough, T.float(lr.rock ?? 0.92), cliff);
  rough = T.mix(rough, T.float(lr.sand ?? 0.95), coastMask);
  rough = T.mix(rough, T.float(lr.subSea ?? 0.5), subMask);

  // ── OPT-IN WET-SHORE BAND: texture-terminate the waterline ──────────────────────────────
  // Wherever the terrain meets the water (cliff OR beach), darken the band colour already there
  // + drop roughness so the contact reads as an intentional WET shoreline over WHATEVER layer is
  // present (wet rock on a sea cliff, wet sand on a slope), plus an optional thin foam line right
  // at sea level. Reuses the flat ramp's contact-band math (render.ts shorelineBandMasks), so the
  // PBR waterline lands exactly where the ramp's would. Render-only; default off (byte-identical).
  const wl = pbr.waterline;
  if (wl !== undefined) {
    const wlSea = wl.seaLevel ?? sea;
    const { wetMask, foamMask } = shorelineBandMasks(wlSea, wl.wetBand ?? 1.2, wl.foamBand ?? 0.25);
    // Wet = darken WHATEVER albedo is here (multiply), so it works over rock/sand/grass alike.
    col = T.mix(col, col.mul(wl.darken ?? 0.55), wetMask);
    const foamStrength = wl.foam ?? 0.5;
    if (foamStrength > 0) {
      const foam = new THREE.Color(wl.foamColor ?? 0xf2f6f4);
      col = T.mix(col, T.vec3(foam.r, foam.g, foam.b), foamMask.mul(foamStrength));
    }
    material.colorNode = col;
    // Wet surfaces are glossier: pull roughness down toward wetRoughness across the wet band.
    rough = T.mix(rough, T.float(wl.wetRoughness ?? 0.32), wetMask);
  }
  material.roughnessNode = T.clamp(rough, 0, 1);
}
