// tree-source.ts — pure, standalone runtime tree generator.
//
// Turns (species, seed) into a Three.js Object3D grown live by @dgreenheck/ez-tree,
// using ez-tree's NATIVE materials (the proven-good look). This replaces the dead-end of
// picking from a handful of pre-baked GLBs: the agent can now grow oak/ash/aspen/pine/etc.
// from a seed, deterministically.
//
// DEPENDENCY DISCIPLINE: this module imports ONLY `three` and `@dgreenheck/ez-tree`.
// Nothing from the deno host / engine / ops layer. That keeps it importable unchanged by
// both a Node gate (js/test/p69_tree_source.mjs) and the browser sim worker / editor bundle.
//
// DETERMINISM (load-bearing for replay): no Math.random(), no Date/Date.now(). All variation
// comes from `seed` alone — the size-variant is chosen by a stable hash of the seed, and the
// tree geometry is driven by ez-tree's seeded RNG (Tree.options.seed).
//
// LANDMINE (verified against ez-tree's build): `Tree.loadPreset(name)` SILENTLY no-ops on an
// unknown name and generates ez-tree's DEFAULT tree instead of throwing. Therefore this module
// (a) only ever passes preset names that provably exist in the shipped catalog (see below), and
// (b) guards the species at the map level so an unknown species THROWS rather than falling back.
//
// SHIPPED PRESET CATALOG — the exact names Tree.loadPreset() accepts, taken from
// node_modules/@dgreenheck/ez-tree/src/lib/presets/index.js (the TreePreset map):
//   Ash Small/Medium/Large, Aspen Small/Medium/Large, Bush 1/2/3,
//   Oak Small/Medium/Large, Pine Small/Medium/Large, Trellis
// HONEST GAPS: ez-tree ships NO willow, birch, or spruce preset (the lowercase "willow"/"birch"
// strings in the build are TreeType/leaf enum values, not loadable presets). We deliberately do
// NOT alias them onto aspen/pine — an alias would advertise a species that renders byte-identical
// to another one (zero variety in a mixed stand, and a catalog that overstates what it can do).
// Every species exposed here is backed by its OWN distinct preset family; birch/spruce/willow are
// a follow-up that authors real ez-tree option sets (or ships preset JSONs) for them.

import * as THREE from "three";
import { Tree } from "@dgreenheck/ez-tree";

/**
 * species → the shipped ez-tree preset name(s) it maps to. Multiple entries are size variants
 * (small/medium/large or 1/2/3); generateTree picks one deterministically from the seed.
 * Every name here is verified to exist in ez-tree's TreePreset map.
 */
// Every species maps to its OWN distinct preset family — no two species share a preset list, so
// no advertised species can render identically to another (enforced by p69's pairwise check).
export const SPECIES_PRESETS: Record<string, readonly string[]> = {
  oak: ["Oak Small", "Oak Medium", "Oak Large"],
  ash: ["Ash Small", "Ash Medium", "Ash Large"],
  aspen: ["Aspen Small", "Aspen Medium", "Aspen Large"],
  pine: ["Pine Small", "Pine Medium", "Pine Large"],
  bush: ["Bush 1", "Bush 2", "Bush 3"], // understory shrub, not a tree — but a real distinct preset
};

/**
 * Agent-facing kebab species names. Derived from SPECIES_PRESETS keys so the two can never
 * drift — every listed species is guaranteed to have ≥1 preset.
 */
export const TREE_SPECIES: readonly string[] = Object.freeze(Object.keys(SPECIES_PRESETS));

export type GenerateTreeOptions = {
  /** Whether generated meshes cast shadows (default true). */
  castShadow?: boolean;
  /** Whether generated meshes receive shadows (default true). */
  receiveShadow?: boolean;
};

/**
 * Stable 32-bit hash of an integer seed. Deterministic and RNG-/clock-free — used only to
 * pick a size-variant index, so it needs to be well-distributed, not cryptographic.
 * (Based on the widely-used xxHash-style integer finalizer.)
 */
function hashSeed(seed: number): number {
  let h = (Math.trunc(seed) | 0) ^ 0x9e3779b9;
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b);
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b);
  h ^= h >>> 16;
  return h >>> 0;
}

/**
 * Grow a tree of `species` from `seed`, deterministically.
 *
 * Throws on a species not in SPECIES_PRESETS — NEVER silently falls back (see the landmine
 * note above). Two different species with the same seed produce different geometry; the same
 * (species, seed) always produces byte-identical geometry; the same species with different
 * seeds produces different geometry.
 *
 * @returns the generated ez-tree `Tree` (a THREE.Group / Object3D subclass) with native materials.
 */
export function generateTree(
  species: string,
  seed: number,
  opts: GenerateTreeOptions = {},
): THREE.Object3D {
  const presets = SPECIES_PRESETS[species];
  if (!presets || presets.length === 0) {
    throw new Error(
      `generateTree: unknown species "${species}" (known: ${TREE_SPECIES.join(", ")})`,
    );
  }

  const variant = presets[hashSeed(seed) % presets.length];

  const tree = new Tree();
  // loadPreset() also runs generate() using the preset's OWN baked seed; we immediately
  // override the seed and regenerate so the output is driven by the caller's seed.
  tree.loadPreset(variant);
  tree.options.seed = Math.trunc(seed);
  tree.generate();

  const castShadow = opts.castShadow ?? true;
  const receiveShadow = opts.receiveShadow ?? true;
  tree.traverse((obj: THREE.Object3D) => {
    const mesh = obj as THREE.Mesh;
    if (mesh.isMesh) {
      mesh.castShadow = castShadow;
      mesh.receiveShadow = receiveShadow;
    }
  });

  return tree;
}
