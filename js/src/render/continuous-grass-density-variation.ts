/** Smooth, world-anchored ecological variation for continuous grass density.
 *
 * The biome field owns where grass may grow. This modulation prevents a uniform
 * biome contribution from becoming a visibly stamped placement lattice while
 * preserving exact zero/full coverage and the mean density of intermediate fields.
 */

function finite(value: number, label: string): number {
  if (!Number.isFinite(value)) throw new RangeError(`${label} must be finite`);
  return Object.is(value, -0) ? 0 : value;
}

function hash01(x: number, z: number, seed: number): number {
  let hash = (Math.imul(x | 0, 0x9e3779b1) ^ Math.imul(z | 0, 0x85ebca77) ^ seed) >>> 0;
  hash = Math.imul(hash ^ (hash >>> 16), 0x7feb352d) >>> 0;
  hash = Math.imul(hash ^ (hash >>> 15), 0x846ca68b) >>> 0;
  return ((hash ^ (hash >>> 16)) >>> 0) / 0x1_0000_0000;
}

function smooth(value: number): number { return value * value * (3 - 2 * value); }

function valueNoise(x: number, z: number, seed: number): number {
  const ix = Math.floor(x), iz = Math.floor(z), tx = smooth(x - ix), tz = smooth(z - iz);
  const a = hash01(ix, iz, seed), b = hash01(ix + 1, iz, seed);
  const c = hash01(ix, iz + 1, seed), d = hash01(ix + 1, iz + 1, seed);
  const top = a + (b - a) * tx, bottom = c + (d - c) * tx;
  return top + (bottom - top) * tz;
}

export function continuousGrassDensityVariation(densityInput: number, xInput: number, zInput: number): number {
  const density = finite(densityInput, "continuous grass density");
  const x = finite(xInput, "continuous grass x"), z = finite(zInput, "continuous grass z");
  if (density < 0 || density > 1) throw new RangeError("continuous grass density must be in [0,1]");
  if (density === 0 || density === 1) return density;
  // Rotate the fine octave so neither world axis becomes a preferred streak direction.
  const diagonalX = (x + z) * 0.7071067811865476;
  const diagonalZ = (z - x) * 0.7071067811865476;
  const macro = valueNoise(x / 11.5, z / 11.5, 0x4d454144);
  const detail = valueNoise(diagonalX / 3.75, diagonalZ / 3.75, 0x5f356495);
  const variation = macro * 0.68 + detail * 0.32;
  // 4*d*(1-d) makes the modulation vanish at the semantic endpoints. At d=.5
  // the maximum displacement is 0.26, retaining a dense ground layer while the
  // expected value remains d.
  return Math.max(0, Math.min(1, density + (variation - 0.5) * 0.52 * 4 * density * (1 - density)));
}
