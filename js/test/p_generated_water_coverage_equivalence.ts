// Equivalence gate for the cached generated-water coverage index (M14): the indexed
// generatedWaterCoversPoint must answer bit-identically to the reference full-topology scan for
// every query — coverage feeds deterministic placement decisions, so a single changed answer is a
// replay divergence. The sweep covers dense lattices, seeded random probes, exact coverage-grid
// cell edges, basin ring vertices/edges, and exact capsule-boundary points, and proves its own
// discriminating power against deliberately skewed candidates.

import {
  generatedWaterCoverageGrids,
  generatedWaterCoversPoint,
  generatedWaterCoversPointReference,
  type VerifiedGeneratedWaterRenderResource,
} from "../src/render/water/generated-water-renderer.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`p_generated_water_coverage_equivalence FAIL: ${message}`);
}

const ARTIFACT_HASH = `sha256:${"c".repeat(64)}`;

function buildResource(): VerifiedGeneratedWaterRenderResource {
  const meanderPoints: [number, number][] = [];
  const meanderWidths: number[] = [];
  const meanderTerrain: number[] = [];
  const meanderSurface: number[] = [];
  for (let index = 0; index < 300; index++) {
    meanderPoints.push([-60 + index * 0.5, 50 + 12 * Math.sin(index * 0.21) + 4 * Math.sin(index * 0.043)]);
    meanderWidths.push(1.5 + 2.5 * (0.5 + 0.5 * Math.sin(index * 0.11)));
    meanderTerrain.push(5 - index * 0.01);
    meanderSurface.push(5.5 - index * 0.01);
  }
  const oceanMask = new Uint8Array(129 * 129);
  for (let row = 0; row < 5; row++) for (let col = 0; col < 129; col++) oceanMask[row * 129 + col] = 1;
  return {
    artifactHash: ARTIFACT_HASH,
    field: {
      placement: { originX: -64, originZ: -64 },
      rows: 129,
      cols: 129,
      cellSizeM: 1,
      seaLevelM: 0,
      oceanMask,
    },
    sampleTerrainHeight: () => null,
    topology: {
      schema: "limina.hydrology-generated-water/v1",
      version: 1,
      basins: [
        {
          id: "gen-b-1-1",
          spillLevelM: 4,
          maxDepthM: 6,
          footprint: {
            points: [[0, 0], [40, 0], [40, 40], [0, 40]],
            holes: [[[12, 12], [12, 28], [28, 28], [28, 12]]],
          },
        },
        {
          id: "gen-b-2-2",
          spillLevelM: 2,
          maxDepthM: 3,
          footprint: {
            points: [[-50, -50], [-10, -50], [-10, -40], [-40, -40], [-40, -10], [-50, -10]],
            holes: [],
          },
        },
        {
          id: "gen-b-3-3",
          spillLevelM: 1,
          maxDepthM: 1,
          footprint: { points: [[60, -30], [90, -29.5], [60, -29]], holes: [] },
        },
      ],
      reaches: [
        {
          id: "gen-r-1-1",
          class: "river",
          order: 4,
          points: meanderPoints,
          widths: meanderWidths,
          terrainElevationsM: meanderTerrain,
          surfaceElevationsM: meanderSurface,
          waterfalls: [],
        },
        {
          id: "gen-r-2-2",
          class: "stream",
          order: 1,
          points: [[70, 70], [75, 90]],
          widths: [1, 3],
          terrainElevationsM: [3, 2],
          surfaceElevationsM: [3.4, 2.4],
          waterfalls: [],
        },
        {
          // Duplicate consecutive points exercise the length2 === 0 branch in both paths.
          id: "gen-r-3-3",
          class: "stream",
          order: 1,
          points: [[100, 0], [100, 0], [110, 0]],
          widths: [2, 2, 2],
          terrainElevationsM: [1, 1, 0.5],
          surfaceElevationsM: [1.3, 1.3, 0.8],
          waterfalls: [],
        },
        {
          id: "gen-r-4-4",
          class: "river",
          order: 3,
          points: [[-5, -5], [45, 45]],
          widths: [6, 6],
          terrainElevationsM: [2, 1],
          surfaceElevationsM: [2.5, 1.5],
          waterfalls: [],
        },
      ],
    },
  };
}

const resource = buildResource();
const MARGINS = [0, 0.35, 0.8, 6] as const;

// Seeded LCG so probe generation is reproducible without wall-clock or ambient RNG.
let lcgState = 0x2545f491;
function lcg(): number {
  lcgState = (Math.imul(lcgState, 1664525) + 1013904223) >>> 0;
  return lcgState / 0x1_0000_0000;
}

type Probe = readonly [number, number, number];
const probes: Probe[] = [];

for (let x = -80; x <= 130; x += 2.9) {
  for (let z = -80; z <= 130; z += 2.9) {
    for (const margin of MARGINS) probes.push([x, z, margin]);
  }
}
for (let index = 0; index < 4000; index++) {
  probes.push([-80 + lcg() * 210, -80 + lcg() * 210, MARGINS[index % MARGINS.length]]);
}

// Exact coverage-grid cell edges: queries landing on cell boundaries must not fall through seams.
const grids = generatedWaterCoverageGrids(resource);
assert(grids.length === resource.topology.reaches.length, "coverage grids do not cover every reach");
for (const grid of grids) {
  assert(grid.cellSize > 0 && grid.cols >= 1 && grid.rows >= 1, "coverage grid has a degenerate cell layout");
  const colStep = Math.max(1, Math.floor(grid.cols / 16));
  const rowStep = Math.max(1, Math.floor(grid.rows / 16));
  for (let col = 0; col <= grid.cols; col += colStep) {
    const x = grid.minX + col * grid.cellSize;
    for (let row = 0; row <= grid.rows; row += rowStep) {
      const z = grid.minZ + row * grid.cellSize;
      for (const margin of [0, 0.8]) {
        probes.push([x, z, margin], [x + 1e-9, z - 1e-9, margin], [x - 1e-9, z + 1e-9, margin]);
      }
    }
  }
  for (const margin of MARGINS) {
    probes.push([grid.minX, grid.minZ, margin], [grid.maxX, grid.maxZ, margin],
      [grid.minX - margin, grid.minZ, margin], [grid.maxX + margin, grid.maxZ, margin]);
  }
}

// Basin ring vertices, edge midpoints, and near-boundary jitter.
for (const basin of resource.topology.basins) {
  const rings = [basin.footprint.points, ...basin.footprint.holes];
  for (const ring of rings) {
    for (let index = 0; index < ring.length; index++) {
      const a = ring[index], b = ring[(index + 1) % ring.length];
      const mid: [number, number] = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
      for (const [x, z] of [a, mid]) {
        for (const offset of [0, 1e-9, -1e-9, 1e-6, -1e-6]) {
          probes.push([x + offset, z, 0], [x, z + offset, 0], [x + offset, z + offset, 0.35]);
        }
      }
    }
  }
}

// Exact capsule-boundary points on the straight stream: distance is exactly width/2 + margin.
{
  const [a, b] = [[70, 70], [75, 90]] as const;
  const dx = b[0] - a[0], dz = b[1] - a[1];
  const length = Math.hypot(dx, dz);
  const nx = -dz / length, nz = dx / length;
  for (const t of [0, 0.25, 0.5, 0.75, 1]) {
    const px = a[0] + dx * t, pz = a[1] + dz * t;
    const width = 1 + (3 - 1) * t;
    for (const margin of MARGINS) {
      const reachOut = width / 2 + margin;
      for (const nudge of [0, 1e-9, -1e-9]) {
        probes.push([px + nx * (reachOut + nudge), pz + nz * (reachOut + nudge), margin]);
        probes.push([px - nx * (reachOut + nudge), pz - nz * (reachOut + nudge), margin]);
      }
    }
  }
}

type Coverage = (resource: VerifiedGeneratedWaterRenderResource, x: number, z: number, margin: number) => boolean;

function firstDisagreement(candidate: Coverage): Probe | null {
  for (const [x, z, margin] of probes) {
    if (generatedWaterCoversPointReference(resource, x, z, margin) !== candidate(resource, x, z, margin)) {
      return [x, z, margin];
    }
  }
  return null;
}

assert(probes.length > 25_000, `probe sweep collapsed to ${probes.length} points`);
const mismatch = firstDisagreement(generatedWaterCoversPoint);
assert(mismatch === null,
  `cached coverage diverged from the reference scan at (${mismatch?.[0]}, ${mismatch?.[1]}) margin ${mismatch?.[2]}`);

// The sweep must be able to detect divergence at all: deliberately skewed candidates FAIL it.
assert(firstDisagreement((res, x, z, margin) => generatedWaterCoversPointReference(res, x, z, margin + 0.25)) !== null,
  "sweep cannot detect a margin-skewed coverage candidate");
assert(firstDisagreement((res, x, z, margin) => generatedWaterCoversPointReference(res, x + 0.5, z, margin)) !== null,
  "sweep cannot detect a position-skewed coverage candidate");

// A content-identical but object-distinct topology builds a fresh index (identity keying) and
// still answers identically to the first resource.
const rebuilt = buildResource();
for (let index = 0; index < probes.length; index += 17) {
  const [x, z, margin] = probes[index];
  assert(generatedWaterCoversPoint(rebuilt, x, z, margin) === generatedWaterCoversPoint(resource, x, z, margin),
    `identity-keyed cache leaked state across topology versions at (${x}, ${z}) margin ${margin}`);
}

// Input rejection parity with the reference.
for (const [x, z, margin] of [[Number.NaN, 0, 0], [0, Number.POSITIVE_INFINITY, 0], [0, 0, -1], [0, 0, Number.NaN]]) {
  let referenceError: unknown, cachedError: unknown;
  try { generatedWaterCoversPointReference(resource, x, z, margin); } catch (error) { referenceError = error; }
  try { generatedWaterCoversPoint(resource, x, z, margin); } catch (error) { cachedError = error; }
  assert(referenceError instanceof RangeError && cachedError instanceof RangeError,
    `invalid query (${x}, ${z}, ${margin}) was not rejected identically by both paths`);
}

console.log(`p_generated_water_coverage_equivalence OK: ${probes.length} probes bit-identical across lattice, seeded random, grid cell-edge, ring-boundary, and exact capsule-boundary sweeps; skewed candidates detected; rejection parity holds`);
