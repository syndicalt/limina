// Named PBR material palette — pick materials by intent ("sand", "wood") instead
// of tuning RGB/roughness/metalness per entity. Pure + portable: no host ops, no
// Deno, no scene access. A given name always yields identical params (deterministic).

import * as THREE from "../../build/three.bundle.mjs";

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

/**
 * Build a WebGPU-safe MeshStandardNodeMaterial from a palette name. Deterministic:
 * the same name always produces a material with identical color/roughness/metalness.
 * Throws on an unknown name (via getMaterialParams).
 */
export function createMaterial(name: string): THREE.MeshStandardNodeMaterial {
  const params = getMaterialParams(name);
  return new THREE.MeshStandardNodeMaterial({
    color: params.color,
    roughness: params.roughness,
    metalness: params.metalness,
  });
}
