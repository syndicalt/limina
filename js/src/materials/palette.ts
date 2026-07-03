// Named PBR material palette — pick materials by intent ("sand", "wood") instead
// of tuning RGB/roughness/metalness per entity. Pure + portable: no host ops, no
// Deno, no scene access. A given name always yields identical params (deterministic).

import * as THREE from "../../build/three.bundle.mjs";
import { applyProceduralPbr, type ProceduralKnobs } from "./procedural-pbr.ts";
import type { DesignDirection, PaletteRole } from "../game/design-direction.ts";

/** A single PBR preset: base color + the two MeshStandard surface params. */
export interface MaterialParams {
  /** Base color as a 24-bit RGB hex (interpreted in sRGB, like THREE.Color.set). */
  color: number;
  /** Microsurface roughness, 0 (mirror) .. 1 (fully diffuse). */
  roughness: number;
  /** Metalness, 0 (dielectric) .. 1 (metal). */
  metalness: number;
}

/**
 * The named palette. Values are tuned for limina's bright, natural low-poly look:
 * saturated-but-grounded colors, mostly-diffuse dielectrics, with metal the only
 * true conductor and water the only low-roughness dielectric. Keep these stable —
 * scenes and tests pin to them.
 */
export const MATERIALS = {
  // Granular ground — warm, pale, fully matte.
  sand: { color: 0xe3cda0, roughness: 0.92, metalness: 0.0 },
  // Worked/quarried stone — neutral grey, matte.
  stone: { color: 0x9b9890, roughness: 0.82, metalness: 0.0 },
  // Raw rock — darker, browner, slightly rougher than stone.
  rock: { color: 0x6f675e, roughness: 0.88, metalness: 0.0 },
  // Tree trunk / dark timber — rich brown.
  wood: { color: 0x8a5a2b, roughness: 0.72, metalness: 0.0 },
  // Sawn/finished board — lighter, warmer, a touch smoother than raw wood.
  plank: { color: 0xc08a52, roughness: 0.62, metalness: 0.0 },
  // Dense canopy / bushes — deep saturated green.
  foliage: { color: 0x357a2b, roughness: 0.8, metalness: 0.0 },
  // Bright individual leaves — lighter, more vivid green.
  leaf: { color: 0x6fbf3f, roughness: 0.68, metalness: 0.0 },
  // Ground cover — vivid grass green, matte.
  grass: { color: 0x59a83a, roughness: 0.85, metalness: 0.0 },
  // Bare metal — neutral steel, true conductor with a low-ish roughness sheen.
  metal: { color: 0xc2c6cc, roughness: 0.38, metalness: 1.0 },
  // Water surface — saturated blue, smooth dielectric for specular highlights.
  water: { color: 0x2e8bc0, roughness: 0.14, metalness: 0.0 },
} as const satisfies Record<string, MaterialParams>;

/** A valid palette material name (literal union of the keys of MATERIALS). */
export type MaterialName = keyof typeof MATERIALS;

/** The available palette names, frozen for stable iteration/listing. */
export const MATERIAL_NAMES = Object.freeze(Object.keys(MATERIALS) as MaterialName[]);

/** True when `name` is a known palette material. */
export function isMaterialName(name: string): name is MaterialName {
  return Object.prototype.hasOwnProperty.call(MATERIALS, name);
}

/**
 * Look up a palette preset by name. Throws a clear, listing error on an unknown
 * name (no silent fallback to a default that would mask a typo). Returns a fresh
 * copy so callers can never mutate the shared preset.
 */
export function getMaterialParams(name: string): MaterialParams {
  if (!isMaterialName(name)) {
    throw new Error(
      `unknown material "${name}"; known materials: ${MATERIAL_NAMES.join(", ")}`,
    );
  }
  const preset = MATERIALS[name];
  return { color: preset.color, roughness: preset.roughness, metalness: preset.metalness };
}

/** Opt-in options for createMaterial. */
export interface CreateMaterialOptions {
  /** When true, upgrade the flat preset to a procedural-PBR surface — triplanar noise-driven
   *  albedo mottle + a real detail NORMAL + honest roughness, matching the terrain's "Grounded
   *  Stylized Realism" grain (materials/procedural-pbr.ts). Default false → flat, byte-identical
   *  to the legacy material. */
  pbr?: boolean;
  /** Per-material procedural knob overrides (only used when `pbr`). */
  pbrKnobs?: Partial<ProceduralKnobs>;
}

/**
 * Build a WebGPU-safe MeshStandardNodeMaterial from a palette name. Deterministic:
 * the same name always produces a material with identical color/roughness/metalness.
 * Throws on an unknown name (via getMaterialParams).
 *
 * With `{ pbr: true }` the material is upgraded IN PLACE to a procedural-PBR surface
 * (colorNode/normalNode/roughnessNode set from the shared triplanar detail noise). Without it
 * the flat-colour behaviour is unchanged (no nodes set) — existing callers/tests are untouched.
 */
export function createMaterial(name: string, opts?: CreateMaterialOptions): THREE.MeshStandardNodeMaterial {
  const params = getMaterialParams(name);
  const material = new THREE.MeshStandardNodeMaterial({
    color: params.color,
    roughness: params.roughness,
    metalness: params.metalness,
  });
  if (opts?.pbr) {
    applyProceduralPbr(material, { color: params.color, roughness: params.roughness }, name, opts.pbrKnobs);
  }
  return material;
}

// ── Design-Direction-aware resolution (ADDITIVE) ──────────────────────────────────────────────────
// The 10-name MATERIALS preset above is the fixed, project-agnostic library (unchanged). These
// functions add a SECOND path: resolve a palette ROLE through the ACTIVE Design Direction so a build
// can pick on-brief colors/materials declared by the project's art style (game/design-direction.ts).
// Pure + deterministic — same (dd, role) always yields the same result, no host ops / RNG / clock.

/** Parse a DD `#rrggbb` hex string to the 0xRRGGBB integer THREE.Color / MaterialParams use. */
function hexToInt(colorHex: string): number {
  return parseInt(colorHex.slice(1), 16);
}

/**
 * Resolve a palette ROLE to the Design Direction's declared color (as a 0xRRGGBB int). This is the
 * single color source the build-time material defaults and the style-conformance gate both read.
 * Throws a clear, listing error when the DD's palette does not declare the role (no silent fallback,
 * mirroring getMaterialParams). Deterministic: first matching palette entry wins.
 */
export function resolveRoleColor(dd: DesignDirection, role: PaletteRole): number {
  const entry = dd.palette.find((p) => p.role === role);
  if (entry === undefined) {
    const roles = dd.palette.map((p) => p.role).join(", ");
    throw new Error(`design direction "${dd.id}" declares no color for role "${role}"; declared roles: ${roles}`);
  }
  return hexToInt(entry.colorHex);
}

/**
 * Resolve a palette ROLE to a full on-brief MaterialParams from the Design Direction: the role's
 * declared color, plus roughness/metalness from the DD's per-role recipe hint when present, else the
 * midpoint of the DD's global material envelope. Additive — it never touches the fixed MATERIALS
 * presets; scene/material code can call this to honour the active art style. Deterministic.
 */
export function resolveRoleMaterial(dd: DesignDirection, role: PaletteRole): MaterialParams {
  const color = resolveRoleColor(dd, role);
  const hint = dd.material.roles.find((r) => r.role === role);
  if (hint !== undefined) {
    return { color, roughness: hint.roughness01, metalness: hint.metalness01 };
  }
  const rough = dd.material.roughness01;
  const metal = dd.material.metalness01;
  return { color, roughness: (rough.min + rough.max) / 2, metalness: (metal.min + metal.max) / 2 };
}
