import { continuousGrassDensityVariation } from "../src/render/continuous-grass-density-variation.ts";
import { createCachedBilinearScalarField } from "../src/world/cached-bilinear-scalar-field.ts";

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(`p_continuous_grass_density_variation FAIL: ${message}`);
}

assert(continuousGrassDensityVariation(0, 3, 7) === 0 && continuousGrassDensityVariation(1, 3, 7) === 1,
  "world variation changed semantic zero/full grass coverage");
const samples: number[] = [];
for (let z = -32; z <= 32; z += 0.5) for (let x = -32; x <= 32; x += 0.5) {
  const value = continuousGrassDensityVariation(0.5, x, z);
  assert(value >= 0 && value <= 1 && value === continuousGrassDensityVariation(0.5, x, z),
    "world variation is out of range or nondeterministic");
  samples.push(value);
}
const mean = samples.reduce((sum, value) => sum + value, 0) / samples.length;
const min = Math.min(...samples), max = Math.max(...samples);
assert(Math.abs(mean - 0.5) < 0.035 && min < 0.34 && max > 0.66,
  `world variation lost mean-preserving natural patches (${min.toFixed(3)}/${mean.toFixed(3)}/${max.toFixed(3)})`);
let maxStep = 0, xDelta = 0, zDelta = 0, deltaSamples = 0;
for (let z = -24; z < 24; z += 0.5) for (let x = -24; x < 24; x += 0.5) {
  const here = continuousGrassDensityVariation(0.5, x, z);
  const dx = Math.abs(continuousGrassDensityVariation(0.5, x + 0.1, z) - here);
  const dz = Math.abs(continuousGrassDensityVariation(0.5, x, z + 0.1) - here);
  maxStep = Math.max(maxStep, dx, dz); xDelta += dx; zDelta += dz; deltaSamples++;
}
assert(maxStep < 0.04 && Math.max(xDelta, zDelta) / Math.min(xDelta, zDelta) < 1.25,
  "world variation contains a discontinuity or strong preferred world axis");

let latticeCalls = 0;
const field = createCachedBilinearScalarField({ origin: [-3, 5], step: 1.5,
  sampleLattice: (x, z) => { latticeCalls++; return x * 0.2 + z * 0.3 + 4; } });
for (let z = 5; z <= 8; z += 0.1875) for (let x = -3; x <= 0; x += 0.1875) {
  assert(Math.abs(field.sample(x, z) - (x * 0.2 + z * 0.3 + 4)) < 1e-12,
    "cached bilinear reconstruction introduced a nearest-cell plateau");
}
assert(latticeCalls <= 16 && field.cachedLatticeSamples === latticeCalls,
  `cached bilinear field repeated lattice work (${latticeCalls})`);

console.log(`p_continuous_grass_density_variation OK: mean=${mean.toFixed(3)} range=${min.toFixed(3)}..${max.toFixed(3)}, smooth isotropic world patches and cached bilinear splat reconstruction proven`);
