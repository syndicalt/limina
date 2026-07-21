// Derived-terrain compiler field constants — the ONE source for the numbers that
// shape the compiled base height field. Two consumers MUST agree bit-for-bit or a
// runtime-composed height diverges from the chunk the user stands on: the compiler
// bundle (node-entry.ts) and the runtime composed-height sampler
// (terrain/composed-height.mjs). Changing any value here changes every derived
// world's compiled bytes AND its runtime sampler, in lockstep.

/** Master-field noise seed the derived compiler builds the base raster with. */
export const WORLD_TERRAIN_COMPILER_SEED = 11;

/** Base relief amplitude (metres) of the derived master field. */
export const WORLD_TERRAIN_COMPILER_BASE_AMPLITUDE = 12;

/** Compiled chunk tiles normalize heights into this range; the river-channel carve
 *  clamps at minM, so the sampler's carve mirror needs the same floor. */
export const WORLD_TERRAIN_COMPILER_VERTICAL_RANGE = Object.freeze({ minM: -500, maxM: 9000 });
