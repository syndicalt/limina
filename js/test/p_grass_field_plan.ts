import {
  buildGrassFieldPlan, countGrassFieldPlanSlots, densityAccepts, grassFieldCandidate, grassFieldRandom, pcg32,
  validateGrassFieldResidentSlots, GRASS_FIELD_MAX_RESIDENT_SLOTS, GRASS_FIELD_MAX_SLOTS,
  partitionGrassFieldBounds,
} from "../src/render/grass-field-plan.ts";
import { countGrassFieldTerrainSlots, prepareGrassFieldTerrainPages } from "../src/render/grass-field-terrain.ts";
import type { TerrainTile } from "../src/terrain/types.ts";

function assert(value: boolean, message: string): asserts value { if (!value) throw new Error(`p_grass_field_plan FAIL: ${message}`); }
function rejects(fn: () => unknown, pattern: RegExp, message: string): void {
  try { fn(); } catch (error) { assert(pattern.test(String(error)), `${message}: ${String(error)}`); return; }
  throw new Error(`p_grass_field_plan FAIL: ${message}`);
}

assert(JSON.stringify([pcg32(0), pcg32(1), pcg32(0xffffffff), pcg32(123456789)]) ===
  JSON.stringify([129708002, 2831084092, 3861530882, 4272394698]), "PCG32 golden vectors changed");
assert(grassFieldRandom(7, -3, 5, 0) !== grassFieldRandom(7, -3, 5, 1), "PCG substreams alias");
assert(densityAccepts(0xffff, 0xffff), "65535 density must be unconditional");
assert(!densityAccepts(0, 0), "zero density accepted a candidate");

const full = buildGrassFieldPlan({ bounds: { minX: -2, minZ: -2, maxX: 2, maxZ: 2 }, spacing: 1, seed: 7 });
assert(full.slots === 16 && full.gridCoordinates[0] === -2 && full.gridCoordinates[1] === -2, "negative half-open grid is wrong");
assert(full.gridCoordinates[30] === 1 && full.gridCoordinates[31] === 1, "half-open max edge leaked or lost a cell");
const left = buildGrassFieldPlan({ bounds: { minX: -2, minZ: -2, maxX: 0, maxZ: 2 }, spacing: 1, seed: 7 });
const right = buildGrassFieldPlan({ bounds: { minX: 0, minZ: -2, maxX: 2, maxZ: 2 }, spacing: 1, seed: 7 });
const signature = (plans: readonly typeof full[]) => plans.flatMap((p) => {
  const out: string[] = [];
  for (let i = 0; i < p.slots; i++) {
    const x = p.gridCoordinates[i * 2], z = p.gridCoordinates[i * 2 + 1];
    out.push(`${x}:${z}:${grassFieldRandom(p.seed, x, z, 0)}`);
  }
  return out;
}).sort();
assert(JSON.stringify(signature([full])) === JSON.stringify(signature([right, left])), "repartition/shuffled stream order changed candidates");

// A split that cuts through grid cells overlaps those cells in both plans, but the canonical
// jittered point is accepted by exactly one half-open side and the accepted union matches full.
const nonAlignedFull = buildGrassFieldPlan({ bounds: { minX: -1.7, minZ: -1.3, maxX: 2.2, maxZ: 1.8 }, spacing: 1, seed: 91 });
const nonAlignedLeft = buildGrassFieldPlan({ bounds: { minX: -1.7, minZ: -1.3, maxX: 0.35, maxZ: 1.8 }, spacing: 1, seed: 91 });
const nonAlignedRight = buildGrassFieldPlan({ bounds: { minX: 0.35, minZ: -1.3, maxX: 2.2, maxZ: 1.8 }, spacing: 1, seed: 91 });
const acceptedSignature = (plans: readonly typeof full[]) => plans.flatMap((plan) => {
  const values: string[] = [];
  for (let slot = 0; slot < plan.slots; slot++) if (plan.accepted[slot] === 1) {
    const candidate = grassFieldCandidate(plan, slot);
    values.push(`${candidate.gridX}:${candidate.gridZ}:${candidate.x}:${candidate.z}`);
  }
  return values;
}).sort();
assert(JSON.stringify(acceptedSignature([nonAlignedFull])) === JSON.stringify(acceptedSignature([nonAlignedRight, nonAlignedLeft])),
  "non-grid-aligned half-open split duplicated or lost accepted candidates");
for (let slot = 0; slot < nonAlignedFull.slots; slot++) {
  const candidate = grassFieldCandidate(nonAlignedFull, slot);
  assert(nonAlignedFull.accepted[slot] === (candidate.inside ? 1 : 0), "full-density boundary cell accepted outside its half-open bounds");
}

const seeded = buildGrassFieldPlan({ bounds: full.bounds, spacing: 1, seed: 8 });
assert(seeded.hash !== full.hash, "plan hash ignored seed");
const density = new Uint16Array(full.slots).fill(0xffff); density[3] = 0;
const masked = buildGrassFieldPlan({ bounds: full.bounds, spacing: 1, seed: 7, density });
assert(masked.hash !== full.hash && masked.accepted[3] === 0, "plan hash/decision ignored density mask");
assert(masked.density !== density, "plan retained mutable caller density storage");
assert(buildGrassFieldPlan({ bounds: full.bounds, spacing: 1, seed: 7 }).hash === full.hash, "identical plan is not hash-stable");

rejects(() => buildGrassFieldPlan({ bounds: { minX: 0, minZ: 0, maxX: 33, maxZ: 32 }, spacing: 1, seed: 1 }), /1024/, "slot cap was not enforced");
rejects(() => buildGrassFieldPlan({ bounds: full.bounds, spacing: 1, seed: Number.NaN }), /int32/, "non-integer seed was accepted");

const pageBounds = { minX: -80.1, minZ: -10.2, maxX: 75.3, maxZ: 50.7 };
const pages = partitionGrassFieldBounds(pageBounds, 0.34);
const pagePlans = pages.map((bounds) => buildGrassFieldPlan({ bounds, spacing: 0.34, seed: -19 }));
assert(pagePlans.length > 1 && pagePlans.every((plan) => plan.slots <= GRASS_FIELD_MAX_SLOTS), "canonical page partition exceeded the 32x32/1024-slot cap");
assert(JSON.stringify(pages) === JSON.stringify(partitionGrassFieldBounds(pageBounds, 0.34)), "canonical page order/bounds are not deterministic");
const splitPagePlans = [
  ...partitionGrassFieldBounds({ ...pageBounds, maxX: -3.17 }, 0.34),
  ...partitionGrassFieldBounds({ ...pageBounds, minX: -3.17 }, 0.34),
].map((bounds) => buildGrassFieldPlan({ bounds, spacing: 0.34, seed: -19 }));
assert(JSON.stringify(acceptedSignature(pagePlans)) === JSON.stringify(acceptedSignature(splitPagePlans)),
  "canonical page partition changed accepted candidates when source terrain was repartitioned");

const slotCountCases = [
  { bounds: { minX: 0, minZ: 0, maxX: 8, maxZ: 6 }, spacing: 1, expected: 48 },
  { bounds: { minX: -8, minZ: -6, maxX: 0, maxZ: 0 }, spacing: 1, expected: 48 },
  { bounds: { minX: -3.7, minZ: -2.9, maxX: 3.6, maxZ: 3.3 }, spacing: 1.3, expected: 36 },
  { bounds: { minX: -7 * 0.34, minZ: -5 * 0.34, maxX: 9 * 0.34, maxZ: 11 * 0.34 }, spacing: 0.34, expected: 256 },
] as const;
for (const entry of slotCountCases) {
  const counted = countGrassFieldPlanSlots(entry.bounds, entry.spacing);
  const built = buildGrassFieldPlan({ bounds: entry.bounds, spacing: entry.spacing, seed: 1 });
  assert(counted === entry.expected && counted === built.slots,
    `tolerance-aware geometric count drifted for ${JSON.stringify(entry.bounds)}: ${counted}/${built.slots}`);
}
const countTile: TerrainTile = {
  nrows: 5, ncols: 5, origin: [0, 0, 0], scale: [16, 1, 16], heights: new Float32Array(25),
};
for (const requestedBounds of [
  { minX: -8, minZ: -8, maxX: 8, maxZ: 8 },
  { minX: -10, minZ: -3.17, maxX: 2.6, maxZ: 10 },
  { minX: -7 * 0.34, minZ: -5 * 0.34, maxX: 9 * 0.34, maxZ: 11 * 0.34 },
]) {
  const counted = countGrassFieldTerrainSlots(countTile, 0.34, requestedBounds);
  const preparedCount = prepareGrassFieldTerrainPages(countTile, { seed: 5, spacing: 0.34 }, requestedBounds)
    .reduce((sum, page) => sum + page.plan.slots, 0);
  assert(counted === preparedCount, `terrain slot estimator drifted from authoritative pages: ${counted}/${preparedCount}`);
}
assert(countGrassFieldTerrainSlots(countTile, 0.34, { minX: 20, minZ: 20, maxX: 22, maxZ: 22 }) === 0,
  "fully disjoint terrain bounds did not estimate zero slots");

// Production streamed window: 9 fine 0.34m tiles + 16 outer 4x tiles at radius two.
// The exact page split is intentionally locked because it determines both storage and draw caps.
let streamedSlots = 0, streamedPages = 0, largestFineTile = 0;
for (let tz = -2; tz <= 2; tz++) for (let tx = -2; tx <= 2; tx++) {
  const n = 33;
  const tile: TerrainTile = { nrows: n, ncols: n, origin: [tx * 48 + 24, 0, tz * 48 + 24], scale: [48, 1, 48],
    heights: new Float32Array(n * n), paintMat: new Uint8Array(n * n).fill(2), paintW: new Float32Array(n * n).fill(1) };
  const fine = Math.max(Math.abs(tx), Math.abs(tz)) <= 1;
  const prepared = prepareGrassFieldTerrainPages(tile, { seed: 1337, spacing: 0.34 * (fine ? 1 : 4) });
  const slots = prepared.reduce((sum, page) => sum + page.plan.slots, 0);
  streamedSlots += slots; streamedPages += prepared.length;
  if (fine) largestFineTile = Math.max(largestFineTile, slots);
}
assert(streamedSlots === 202_212 && streamedPages === 289, `production radius-two page budget drifted: ${streamedSlots} slots/${streamedPages} pages`);
assert(streamedSlots + largestFineTile === 222_376 && streamedSlots + largestFineTile <= GRASS_FIELD_MAX_RESIDENT_SLOTS,
  "active streamed window plus one pending fine replacement drifted or exceeds the hard resident-slot cap");

const biomeTile: TerrainTile = { nrows: 3, ncols: 3, origin: [4, 0, 4], scale: [8, 1, 8], heights: new Float32Array(9) };
const biomePages = prepareGrassFieldTerrainPages(biomeTile, { seed: 9, spacing: 2, densityAt: () => 0.5 });
assert(biomePages.some((page) => page.plan.density.some((density) => density === 32_768)),
  "B3 biome density did not author the canonical B1 uint16 density field without grass paint");
const densityCalls: [number, number][] = [];
const onceSampled = prepareGrassFieldTerrainPages(biomeTile, {
  seed: 9, spacing: 2, densityAt: (x, z) => { densityCalls.push([x, z]); return 0.5; }, paintPolicy: "ignore",
});
const expectedDensityCalls = onceSampled.flatMap((page) => Array.from({ length: page.plan.slots }, (_, slot) => {
  const candidate = grassFieldCandidate(page.plan, slot);
  return [candidate.x, candidate.z] as [number, number];
}));
assert(JSON.stringify(densityCalls) === JSON.stringify(expectedDensityCalls),
  `density authority must be sampled exactly once per candidate in canonical order: ${densityCalls.length}/${expectedDensityCalls.length}`);
biomeTile.paintMat = new Uint8Array(9).fill(3); biomeTile.paintW = new Float32Array(9).fill(1);
const suppressed = prepareGrassFieldTerrainPages(biomeTile, { seed: 9, spacing: 2, densityAt: () => 0.5 });
assert(suppressed.every((page) => page.plan.density.every((density) => density === 0)),
  "explicit non-grass terrain paint did not suppress the biome grass field");
biomeTile.paintMat.fill(2);
const packageAuthoritative = prepareGrassFieldTerrainPages(biomeTile, {
  seed: 9, spacing: 2, densityAt: () => 0.25, paintPolicy: "ignore",
});
assert(packageAuthoritative.some((page) => page.plan.density.some((density) => density === 16_384))
  && packageAuthoritative.every((page) => page.plan.density.every((density) => density === 16_384 || density === 0)),
  "published continuous grass still inherited the legacy terrain-paint density floor");
const waterExcluded = prepareGrassFieldTerrainPages(biomeTile, {
  seed: 9, spacing: 2, densityAt: () => 0.5, hardExclusionAt: (x) => x < 4,
});
const waterExcludedDensity = waterExcluded.flatMap((page) => [...page.plan.density]);
assert(waterExcludedDensity.some((value) => value === 0) && waterExcludedDensity.some((value) => value === 0xffff),
  "hard semantic exclusion did not veto painted grass while preserving adjacent dry painted ground");
rejects(() => prepareGrassFieldTerrainPages(biomeTile, { seed: 9, spacing: 2, paintPolicy: "legacy" as never }), /paintPolicy/,
  "invalid grass paint combination policy was accepted");

// Exact pre-optimization terrain authority output. This pins density, slope, paint, exclusion,
// height, and accepted placement inputs while the hot path is made cheaper.
const goldenTile: TerrainTile = {
  nrows: 5, ncols: 5, origin: [0, 1, 0], scale: [8, 3, 8],
  heights: Float32Array.from({ length: 25 }, (_, index) => ((index * 7) % 11) / 10),
  paintMat: Uint8Array.from({ length: 25 }, (_, index) => index % 4 === 0 ? 3 : index % 3 === 0 ? 2 : 0),
  paintW: Float32Array.from({ length: 25 }, (_, index) => ((index * 5) % 9) / 8),
};
const goldenPages = prepareGrassFieldTerrainPages(goldenTile, {
  seed: -123, spacing: 1.3, elevationMin: 0.9, elevationMax: 4.1, slopeMax: 2,
  densityAt: (x, z) => 0.2 + Math.abs((Math.floor((x + 10) * 7) + Math.floor((z + 10) * 11)) % 6) * 0.1,
  exclusions: [{ x: -1.1, z: 0.8, r: 0.7 }], hardExclusionAt: (x, z) => x > 2.5 && z < -1,
}, { minX: -3.7, minZ: -2.9, maxX: 3.6, maxZ: 3.3 });
const goldenSummary = goldenPages.map((page) => ({
  bounds: page.plan.bounds, featureOrigin: page.featureOrigin, hash: page.plan.hash,
  density: [...page.plan.density], accepted: [...page.plan.accepted], heights: [...page.heights],
}));
assert(JSON.stringify(goldenSummary) === JSON.stringify([
  { bounds: { minX: -3.7, minZ: -2.9, maxX: 0, maxZ: 0 }, featureOrigin: [-3.7, 1, -2.9], hash: "fnv1a64:8245383c4ed50c09", density: [0, 0, 0, 39321, 19661, 10370, 0, 25956, 37097], accepted: [0, 0, 0, 0, 1, 0, 0, 1, 0], heights: [2.657506227493286, 2.866729497909546, 2.6471641063690186, 2.332991600036621, 3.090242624282837, 2.717689037322998, 1.993794322013855, 1.920259714126587, 2.586557149887085] },
  { bounds: { minX: 0, minZ: -2.9, maxX: 3.6, maxZ: 0 }, featureOrigin: [0, 1, -2.9], hash: "fnv1a64:1eea0278af2151e1", density: [0, 0, 0, 28732, 11708, 0, 14522, 10828, 24679], accepted: [0, 0, 0, 1, 1, 0, 1, 0, 0], heights: [2.187683582305908, 3.3559510707855225, 2.9320170879364014, 1.9051191806793213, 1.5690888166427612, 2.947371244430542, 2.655346632003784, 1.7628741264343262, 2.4808542728424072] },
  { bounds: { minX: -3.7, minZ: 0, maxX: 0, maxZ: 3.3 }, featureOrigin: [-3.7, 1, 0], hash: "fnv1a64:406a4df848bf320d", density: [27998, 14900, 20650, 0, 2815, 25697, 0, 0, 28839], accepted: [0, 0, 0, 0, 0, 0, 0, 0, 0], heights: [2.003051280975342, 1.2566264867782593, 2.776376724243164, 2.6799991130828857, 1.7438229322433472, 2.9675650596618652, 3.1605842113494873, 1.9940906763076782, 2.46683931350708] },
  { bounds: { minX: 0, minZ: 0, maxX: 3.6, maxZ: 3.3 }, featureOrigin: [0, 1, 0], hash: "fnv1a64:26ff246669e83307", density: [9090, 12505, 45875, 39321, 38205, 18709, 39321, 13065, 36658], accepted: [0, 0, 0, 1, 0, 0, 1, 0, 1], heights: [3.1720657348632812, 2.482745885848999, 2.703247547149658, 2.825322151184082, 2.599015235900879, 1.7886773347854614, 2.373849630355835, 2.825138568878174, 2.455502510070801] },
]), "terrain preparation changed exact pre-optimization density, placement, or height authority");

assert(validateGrassFieldResidentSlots(new Array(512).fill(1024)) === GRASS_FIELD_MAX_RESIDENT_SLOTS, "resident cap exact boundary failed");
rejects(() => validateGrassFieldResidentSlots([...new Array(512).fill(1024), 1]), /524288/, "resident cap overflow accepted");
rejects(() => validateGrassFieldResidentSlots([1025]), /invalid/, "per-tile cap overflow accepted");

console.log("p_grass_field_plan OK: PCG vectors, signed half-open grids/pages, seams, repartition/shuffle independence, hashes, density decisions, and hard caps are proven");
