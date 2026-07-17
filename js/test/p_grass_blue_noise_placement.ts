import {
  grassFieldPlacementAccepts,
  grassFieldRandom,
  type GrassFieldPlacement,
} from "../src/render/grass-field-plan.ts";
import { prepareGrassFieldTerrainPages } from "../src/render/grass-field-terrain.ts";
import type { TerrainTile } from "../src/terrain/types.ts";

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(`p_grass_blue_noise_placement FAIL: ${message}`);
}

const seed = 0x4d454144;
const placement: GrassFieldPlacement = Object.freeze({
  strategy: "world-matern-blue-noise/v1", oversample: 2, minimumDistanceMultiplier: 0.84,
});
const point = (gridX: number, gridZ: number): readonly [number, number] => {
  const jitter = grassFieldRandom(seed, gridX, gridZ, 1);
  return [(gridX + (jitter & 0xffff) / 65536), (gridZ + (jitter >>> 16) / 65536)];
};

const accepted = new Set<string>();
for (let gridZ = -128; gridZ < 128; gridZ++) for (let gridX = -128; gridX < 128; gridX++) {
  if (grassFieldPlacementAccepts(seed, gridX, gridZ, placement)) accepted.add(`${gridX}:${gridZ}`);
}
const retained = accepted.size / (256 * 256);
assert(retained > 0.5 && retained < 0.52,
  `two-times oversampling did not preserve the authored root density (${retained.toFixed(4)} retained)`);

// No accepted root may violate the hard world-space separation, including across signed grid and
// page boundaries. This is the property the rejected one-jittered-root-per-cell lattice lacked.
let minimumDistance = Infinity;
for (let gridZ = -126; gridZ < 126; gridZ++) for (let gridX = -126; gridX < 126; gridX++) {
  if (!accepted.has(`${gridX}:${gridZ}`)) continue;
  const [x, z] = point(gridX, gridZ);
  for (let dz = -2; dz <= 2; dz++) for (let dx = -2; dx <= 2; dx++) {
    if (dx === 0 && dz === 0 || !accepted.has(`${gridX + dx}:${gridZ + dz}`)) continue;
    const [nx, nz] = point(gridX + dx, gridZ + dz);
    minimumDistance = Math.min(minimumDistance, Math.hypot(nx - x, nz - z));
  }
}
assert(minimumDistance >= placement.minimumDistanceMultiplier - 1e-12,
  `accepted roots violate the blue-noise minimum distance (${minimumDistance})`);

// Nearest-neighbor azimuths must remain isotropic. A square lattice concentrates these bins around
// its axes and is exactly the grazing-angle striping regression this gate is meant to reject.
const azimuthBins = new Uint32Array(12);
let azimuthSamples = 0;
for (let gridZ = -63; gridZ < 63; gridZ++) for (let gridX = -63; gridX < 63; gridX++) {
  if (!accepted.has(`${gridX}:${gridZ}`)) continue;
  const [x, z] = point(gridX, gridZ);
  let bestDistance = Infinity, bestX = 0, bestZ = 0;
  for (let dz = -3; dz <= 3; dz++) for (let dx = -3; dx <= 3; dx++) {
    if (dx === 0 && dz === 0 || !accepted.has(`${gridX + dx}:${gridZ + dz}`)) continue;
    const [nx, nz] = point(gridX + dx, gridZ + dz), distance = (nx - x) ** 2 + (nz - z) ** 2;
    if (distance < bestDistance) { bestDistance = distance; bestX = nx - x; bestZ = nz - z; }
  }
  assert(Number.isFinite(bestDistance), "accepted root has no local blue-noise neighbor");
  const azimuth = ((Math.atan2(bestZ, bestX) % Math.PI) + Math.PI) % Math.PI;
  azimuthBins[Math.min(azimuthBins.length - 1, Math.floor(azimuth / Math.PI * azimuthBins.length))]++;
  azimuthSamples++;
}
const azimuthMean = azimuthSamples / azimuthBins.length;
const azimuthDeviation = Math.max(...Array.from(azimuthBins, (value) => Math.abs(value - azimuthMean) / azimuthMean));
assert(azimuthDeviation < 0.15, `blue-noise roots retain a preferred axis (${azimuthDeviation.toFixed(3)})`);

// Rebuilding the same tile as one region or four arbitrary half-open regions must publish the same
// accepted signed-grid identities. Neighbor competition deliberately reaches outside each region.
const n = 33;
const tile: TerrainTile = { nrows: n, ncols: n, origin: [0, 0, 0], scale: [48, 1, 48],
  heights: new Float32Array(n * n) };
const options = { seed, spacing: 1 / Math.sqrt(3), densityAt: () => 1, paintPolicy: "ignore" as const,
  placement };
const collect = (bounds: { minX: number; minZ: number; maxX: number; maxZ: number }[]) => {
  const identities = new Set<string>();
  for (const bound of bounds) for (const page of prepareGrassFieldTerrainPages(tile, options, bound)) {
    for (let slot = 0; slot < page.plan.slots; slot++) if (page.plan.accepted[slot] === 1) {
      identities.add(`${page.plan.gridCoordinates[slot * 2]}:${page.plan.gridCoordinates[slot * 2 + 1]}`);
    }
  }
  return [...identities].sort();
};
const whole = collect([{ minX: -24, minZ: -24, maxX: 24, maxZ: 24 }]);
const split = collect([
  { minX: -24, minZ: -24, maxX: -1.37, maxZ: 2.19 },
  { minX: -1.37, minZ: -24, maxX: 24, maxZ: 2.19 },
  { minX: -24, minZ: 2.19, maxX: 5.73, maxZ: 24 },
  { minX: 5.73, minZ: 2.19, maxX: 24, maxZ: 24 },
]);
assert(JSON.stringify(split) === JSON.stringify(whole), "blue-noise placement changed under region repartitioning");

console.log(`p_grass_blue_noise_placement OK: retained=${retained.toFixed(4)}, min=${minimumDistance.toFixed(4)} cells, azimuth deviation=${azimuthDeviation.toFixed(3)}, roots=${whole.length}`);
