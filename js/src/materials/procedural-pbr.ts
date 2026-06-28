// Phase 2b — OPT-IN procedural-PBR for PRIMITIVES/the palette. Brings the terrain's
// "Grounded Stylized Realism" surface quality (noise-driven albedo mottle + a real detail
// NORMAL + honest roughness, projected TRIPLANARLY so it never UV-stretches on an arbitrary
// box/sphere) to a named palette material — so `createMaterial("rock", { pbr: true })` yields
// a TACTILE primitive instead of a flat colour.
//
// Reuse, not reinvention: the detail comes from the SAME baked tileable noise singleton +
// triplanar sampler the terrain surface uses (materials/triplanar-noise.ts). The only thing
// added here is a per-MATERIAL knob table (each palette name gets a tiling/relief/mottle
// recipe) and the node wiring onto a MeshStandardNodeMaterial.
//
// OPT-IN + back-compat: this is applied ONLY when a caller passes `pbr: true`. Without it the
// material keeps the flat-colour defaults byte-for-byte (no colorNode/normalNode/roughnessNode)
// — `createMaterial(name)` / `createEntity({material})` are unchanged.

import * as THREE from "../../build/three.bundle.mjs";
import { sharedDetailTexture, triplanarLayer } from "./triplanar-noise.ts";

// deno-lint-ignore no-explicit-any
const T = (THREE as any).TSL;

/** Per-material procedural-PBR recipe — the LOOK knobs (UAT-tuned). */
export interface ProceduralKnobs {
  /** World-space detail tiling frequency (cycles/m). Higher = finer grain. */
  scale: number;
  /** Detail-NORMAL intensity (0 = flat/clay, 1 = strong relief). The "not clay" lever. */
  normal: number;
  /** Albedo mottling depth (0 = flat colour, ~0.35 = lively). */
  mottle: number;
  /** Roughness variation amplitude driven by the detail height (PBR honesty). */
  roughVar: number;
  /** Triplanar blend sharpness (higher = crisper plane transitions). */
  sharpness: number;
}

const DEFAULT_KNOBS: ProceduralKnobs = { scale: 0.35, normal: 0.6, mottle: 0.22, roughVar: 0.12, sharpness: 4 };

/**
 * Per-palette-name procedural-PBR recipes, tuned to Grounded Stylized Realism: coarse craggy
 * relief for rock/stone, fine grain for grass/foliage, tight ripples for sand, restrained
 * mottle + low relief for the smoother metal/water/plank surfaces. Any name not listed falls
 * back to DEFAULT_KNOBS, so a material can opt into PBR even without a bespoke recipe.
 */
export const PROCEDURAL_PBR_KNOBS: Record<string, Partial<ProceduralKnobs>> = {
  sand: { scale: 0.55, normal: 0.7, mottle: 0.20, roughVar: 0.06 },
  stone: { scale: 0.20, normal: 0.85, mottle: 0.18, roughVar: 0.14 },
  rock: { scale: 0.14, normal: 1.0, mottle: 0.26, roughVar: 0.16 },
  wood: { scale: 0.32, normal: 0.6, mottle: 0.30, roughVar: 0.14 },
  plank: { scale: 0.28, normal: 0.45, mottle: 0.22, roughVar: 0.10 },
  foliage: { scale: 0.45, normal: 0.55, mottle: 0.30, roughVar: 0.12 },
  leaf: { scale: 0.50, normal: 0.50, mottle: 0.28, roughVar: 0.10 },
  grass: { scale: 0.45, normal: 0.55, mottle: 0.28, roughVar: 0.12 },
  metal: { scale: 0.25, normal: 0.25, mottle: 0.08, roughVar: 0.06 },
  water: { scale: 0.30, normal: 0.35, mottle: 0.08, roughVar: 0.05 },
};

/** Resolve the procedural recipe for a palette name (merged over the defaults), with optional
 *  per-call overrides. Always returns a complete ProceduralKnobs. */
export function proceduralKnobs(name: string, override?: Partial<ProceduralKnobs>): ProceduralKnobs {
  return { ...DEFAULT_KNOBS, ...(PROCEDURAL_PBR_KNOBS[name] ?? {}), ...(override ?? {}) };
}

/**
 * Apply the OPT-IN procedural-PBR surface to `material` (a MeshStandardNodeMaterial). Sets
 * `colorNode` (base palette colour modulated by triplanar noise mottle), `normalNode` (a real
 * VIEW-SPACE detail normal from the baked gradient — the same idiom the terrain uses), and
 * `roughnessNode` (base roughness varied by the detail height). Deterministic + render-only.
 *
 * `base.color` is the palette base colour (sRGB hex); `base.roughness` the preset roughness.
 * `name` selects the per-material recipe; `override` tweaks individual knobs.
 */
export function applyProceduralPbr(
  material: THREE.MeshStandardNodeMaterial,
  base: { color: number; roughness: number },
  name: string,
  override?: Partial<ProceduralKnobs>,
): void {
  const k = proceduralKnobs(name, override);
  const tex = sharedDetailTexture();
  const layer = triplanarLayer(tex, k.scale, k.normal, k.sharpness);

  // Albedo: base palette colour modulated by the triplanar mottle (controlled, ~[1-m/2, 1+m/2]).
  const c = new THREE.Color(base.color);
  const baseV = T.vec3(c.r, c.g, c.b);
  const mod = layer.value.sub(0.5).mul(k.mottle).add(1);
  material.colorNode = baseV.mul(mod);

  // Detail NORMAL → view space (the proven terrain/water idiom: setupNormal returns normalNode
  // as-is as the view-space normal; the primitive's model-view normal matrix lands it correctly).
  material.normalNode = T.transformNormalToView(layer.normal.normalize());

  // Roughness: honest variation around the preset, driven by the same detail height.
  const rough = T.float(base.roughness).add(layer.value.sub(0.5).mul(k.roughVar));
  material.roughnessNode = T.clamp(rough, 0, 1);
}
