export interface CachedBilinearScalarField {
  sample(x: number, z: number): number;
  readonly cachedLatticeSamples: number;
}

/** Reconstruct a continuous scalar field from a cached regular lattice.
 * This retains the source lattice's information while avoiding nearest-cell plateaus
 * when a higher-resolution consumer, such as a surface composite, samples it.
 */
export function createCachedBilinearScalarField(input: Readonly<{
  origin: readonly [number, number];
  step: number;
  sampleLattice(x: number, z: number): number;
}>): CachedBilinearScalarField {
  if (!Array.isArray(input.origin) || input.origin.length !== 2 || !input.origin.every(Number.isFinite)) {
    throw new RangeError("cached scalar field origin must be a finite [x,z]");
  }
  if (!Number.isFinite(input.step) || !(input.step > 0)) throw new RangeError("cached scalar field step must be positive");
  const cache = new Map<string, number>();
  const lattice = (ix: number, iz: number): number => {
    const key = `${ix}:${iz}`;
    const prior = cache.get(key); if (prior !== undefined) return prior;
    const value = input.sampleLattice(input.origin[0] + ix * input.step, input.origin[1] + iz * input.step);
    if (!Number.isFinite(value)) throw new RangeError("cached scalar lattice sample must be finite");
    cache.set(key, value); return value;
  };
  return Object.freeze({
    sample(x: number, z: number): number {
      if (!Number.isFinite(x) || !Number.isFinite(z)) throw new RangeError("cached scalar field coordinates must be finite");
      const gx = (x - input.origin[0]) / input.step, gz = (z - input.origin[1]) / input.step;
      const ix = Math.floor(gx), iz = Math.floor(gz), tx = gx - ix, tz = gz - iz;
      const a = lattice(ix, iz);
      if (tx === 0 && tz === 0) return a;
      const b = tx === 0 ? a : lattice(ix + 1, iz);
      const c = tz === 0 ? a : lattice(ix, iz + 1);
      const d = tx === 0 ? c : tz === 0 ? b : lattice(ix + 1, iz + 1);
      return a + (b - a) * tx + (c - a) * tz + (a - b - c + d) * tx * tz;
    },
    get cachedLatticeSamples(): number { return cache.size; },
  });
}
