import { buildBiomePopulationPlan, thinBiomePopulationCandidates } from "../src/world/biome-population-plan.mjs";

function assert(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(`p_biome_population_plan FAIL: ${message}`); }
const HASH_A = `sha256:${"a".repeat(64)}`, HASH_B = `sha256:${"b".repeat(64)}`;
function publication(offset = 0) {
  return { disposed: false, fieldContentHash: HASH_A, runtimePackContentHash: HASH_B, sample(x: number, z: number) {
    if (x < offset - 100 || x > offset + 100 || z < offset - 100 || z > offset + 100) return null;
    const rule = { role: "flora/oak", radiusM: 3, density01: 0.72, scale: [0.8, 1.2], slope01: [0, 0.8],
      elevationM: [-100, 500], moisture01: [0.2, 0.9], waterDistanceM: [2, 500], tintSrgb: [220, 235, 210] };
    return { vegetationDensity01: 0.72, vegetation: [{ role: rule.role, rule,
      binding: { assetId: "trees/oak-chain", contentHash: HASH_A }, weightU16: 65_535, weight01: 1 }] };
  } };
}
const surface = (x: number, z: number) => ({ y: (x + z) * 0.001, slope01: 0.2, moisture01: 0.6, waterDistanceM: 30 });
const options = { publication: publication(), sampleSurface: surface, seed: 77, bounds: [-48, -24, 48, 24],
  featureOrigin: [0, 0], cellSizeM: 2, pageSizeM: 48, maxRadiusM: 6 };
const first = buildBiomePopulationPlan(options), second = buildBiomePopulationPlan(options);
assert(first.placements.length > 0 && JSON.stringify(first) === JSON.stringify(second), "plan was empty or nondeterministic");
assert(first.placements.some((entry: any) => entry.pageX < 0) && first.placements.some((entry: any) => entry.pageX >= 0), "signed page coverage was not preserved");
for (let i = 0; i < first.placements.length; i++) for (let j = i + 1; j < first.placements.length; j++) {
  const a: any = first.placements[i], b: any = first.placements[j], distance = Math.hypot(a.x - b.x, a.z - b.z);
  assert(distance >= 3 - 1e-9, `minimum radius failed across pages: ${distance}`);
}

const shifted = buildBiomePopulationPlan({ ...options, publication: publication(1_000_000),
  bounds: [999_952, 999_976, 1_000_048, 1_000_024], featureOrigin: [1_000_000, 1_000_000],
  sampleSurface: (x: number, z: number) => surface(x - 1_000_000, z - 1_000_000) });
assert(JSON.stringify(first.placements.map((entry: any) => ({ ...entry, x: entry.localX, z: entry.localZ })))
  === JSON.stringify(shifted.placements.map((entry: any) => ({ ...entry, x: entry.localX, z: entry.localZ }))),
"million-metre translation changed the feature-local plan");

const raw = [
  { cellX: 0, cellZ: 0, cellSizeM: 1, maxRadiusM: 4, x: 0, z: 0, radiusM: 2, priority: 1 },
  { cellX: 1, cellZ: 0, cellSizeM: 1, maxRadiusM: 4, x: 1, z: 0, radiusM: 2, priority: 2 },
  { cellX: 4, cellZ: 0, cellSizeM: 1, maxRadiusM: 4, x: 4, z: 0, radiusM: 2, priority: 0 },
] as any[];
const forward = thinBiomePopulationCandidates(raw), reverse = thinBiomePopulationCandidates([...raw].reverse());
assert(JSON.stringify(forward) === JSON.stringify(reverse) && forward.length === 2, "priority thinning depended on candidate traversal order");

const layeredPublication = { ...publication(), sample() {
  const treeRule = { role: "flora/oak", radiusM: 6, density01: 1, scale: [1, 1], tintSrgb: [255, 255, 255] };
  const grassRule = { role: "flora/grass", radiusM: 0.2, density01: 1, scale: [1, 1], tintSrgb: [255, 255, 255] };
  return { vegetationDensity01: 1, vegetation: [
    { role: treeRule.role, rule: treeRule, binding: { assetId: "population/oak", contentHash: HASH_A }, weight01: 0.5 },
    { role: grassRule.role, rule: grassRule, binding: { assetId: "population/grass", contentHash: HASH_B }, weight01: 0.5 },
  ] };
} };
const layered = buildBiomePopulationPlan({ ...options, publication: layeredPublication, bounds: [-12, -12, 12, 12],
  stratumForRole: (role: string) => role === "flora/grass" ? "ground-cover" : "canopy" });
const trees = layered.placements.filter((entry: any) => entry.role === "flora/oak");
const grasses = layered.placements.filter((entry: any) => entry.role === "flora/grass");
assert(trees.length > 0 && grasses.length > trees.length * 4,
  `ecological strata did not preserve dense ground cover beneath canopy (${trees.length} trees, ${grasses.length} grasses)`);
assert(grasses.some((grass: any) => trees.some((tree: any) => Math.hypot(grass.x - tree.x, grass.z - tree.z) < 6)),
  "canopy radius still erased the ground-cover stratum");

let capped = false;
try { buildBiomePopulationPlan({ ...options, bounds: [-1000, -1000, 1000, 1000], maxCandidates: 100 }); }
catch (error) { capped = /exceeds cap/.test(String(error)); }
assert(capped, "candidate cap was not enforced before traversal");
console.log(`p_biome_population_plan OK: ${first.placements.length} deterministic variable-radius placements span signed pages; ${grasses.length} ground-cover placements coexist beneath ${trees.length} canopy placements`);
