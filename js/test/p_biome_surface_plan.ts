import { buildBiomeSurfacePlan, BIOME_SURFACE_PLAN_NONE } from "../src/world/biome-surface-plan.mjs";

function assert(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(`p_biome_surface_plan FAIL: ${message}`); }
const A = `sha256:${"a".repeat(64)}`, B = `sha256:${"b".repeat(64)}`;
function publication(offset = 0, unfulfilled = false) {
  const binding = (assetId: string, contentHash: string) => ({ assetId, contentHash, licenseId: "CC0-1.0", sourceUri: "https://example.invalid" });
  return { disposed: false, fieldContentHash: A, runtimePackContentHash: B, sample(x: number) {
    const local = Math.max(0, Math.min(1, (x - offset) / 10));
    return { status: unfulfilled ? "unfulfilled" : "fulfilled", surfaces: [
      { role: "ground/earth", rule: { role: "ground/earth", weight: 1, tileScaleM: 4 }, binding: binding("materials/earth", A), weightU16: 65_535 - Math.round(local * 65_535) },
      { role: "rock/granite", rule: { role: "rock/granite", weight: 1, tileScaleM: 6 }, binding: binding("materials/rock", B), weightU16: Math.round(local * 65_535) },
    ].filter((entry) => entry.weightU16 > 0) };
  } };
}
const plan = buildBiomeSurfacePlan({ publication: publication(), grid: { origin: [0, 0], rows: 2, cols: 3, cellSizeM: 5 } });
assert(plan.roles.length === 2 && plan.indices.length === 96 && plan.weights.length === 96, "bounded role table or typed layout is wrong");
for (let cell = 0; cell < 6; cell++) {
  let sum = 0; for (let slot = 0; slot < 16; slot++) sum += plan.weights[cell * 16 + slot];
  assert(sum === 65_535, `cell ${cell} did not preserve exact normalization`);
  const used = plan.weights.slice(cell * 16, cell * 16 + 16).filter((weight: number) => weight > 0).length;
  assert([...plan.indices.slice(cell * 16 + used, cell * 16 + 16)].every((index) => index === BIOME_SURFACE_PLAN_NONE), "unused slots were not explicit NONE");
}
const roleWeight = (cell: number, roleIndex: number): number => {
  for (let slot = 0; slot < 16; slot++) if (plan.indices[cell * 16 + slot] === roleIndex) return plan.weights[cell * 16 + slot];
  return 0;
};
assert(roleWeight(0, 0) > roleWeight(1, 0) && roleWeight(1, 0) > roleWeight(2, 0)
  && roleWeight(0, 1) < roleWeight(1, 1) && roleWeight(1, 1) < roleWeight(2, 1),
"transition weights were not continuous and ordered across the blend");
const shifted = buildBiomeSurfacePlan({ publication: publication(1_000_000), grid: { origin: [1_000_000, 1_000_000], rows: 2, cols: 3, cellSizeM: 5 } });
assert(JSON.stringify([...plan.indices, ...plan.weights]) === JSON.stringify([...shifted.indices, ...shifted.weights]), "million-metre translation changed the local surface plan");
let rejected = false;
try { buildBiomeSurfacePlan({ publication: publication(0, true), grid: { origin: [0, 0], rows: 1, cols: 1, cellSizeM: 1 } }); }
catch (error) { rejected = /unfulfilled/.test(String(error)); }
assert(rejected, "unfulfilled content silently produced a production surface plan");
console.log("p_biome_surface_plan OK: bounded 16-slot/32-role surface publication preserves exact transition weights, large-world equivalence, and fail-closed fulfillment");
