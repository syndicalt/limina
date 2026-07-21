import { parallaxOcclusionUvCpu } from "../src/materials/surface-sampling.ts";

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(`p_material_surface_sampling FAIL: ${message}`);
}
function near(actual: number, expected: number, epsilon = 1e-6): void {
  assert(Math.abs(actual - expected) <= epsilon, `expected ${expected}, got ${actual}`);
}

const vertical = parallaxOcclusionUvCpu([0.5, 0.5], [0, 0, 1], () => 0.5, { heightScale: 0.1, layers: 10 });
near(vertical.uv[0], 0.5); near(vertical.uv[1], 0.5);
assert(vertical.iterations === 5, `white-high half-height should cross in 5 layers, got ${vertical.iterations}`);

const oblique = parallaxOcclusionUvCpu([0.5, 0.5], [1, 0, 1], () => 0.5, { heightScale: 0.1, layers: 10 });
near(oblique.uv[0], 0.45); near(oblique.uv[1], 0.5);
assert(oblique.iterations === 5, "oblique half-height march did not remain bounded");

const fullHeight = parallaxOcclusionUvCpu([0.5, 0.5], [1, 0, 1], () => 1, { heightScale: 0.1, layers: 10 });
near(fullHeight.uv[0], 0.4);
assert(fullHeight.iterations === 10, `full-height field exceeded/underran the exact layer cap: ${fullHeight.iterations}`);

const clamped = parallaxOcclusionUvCpu([0.5, 0.5], [1, 0, 1], () => 10, { heightScale: 0.1, layers: 8 });
assert(clamped.iterations === 8, "height samples must clamp to white-high [0,1] and respect the cap");
assert(Number.isFinite(clamped.uv[0]) && Number.isFinite(clamped.uv[1]), "refinement produced non-finite UVs");

console.log("p_material_surface_sampling OK: white-high convention, oblique shift, linear refinement, clamping, and bounded iteration cap are proven");
