import {
  FIDELITY_BENCHMARK_SCHEMA,
  FIDELITY_BUDGETS,
  FIDELITY_CAMERA_ROUTE,
  FIDELITY_VISUAL_FLAGS,
  FidelityBenchmarkRecorder,
  fidelityCameraPose,
} from "../src/render/fidelity-benchmark.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`p_fidelity_benchmark FAIL: ${message}`);
}
function rejects(fn: () => unknown, pattern: RegExp, message: string): void {
  let error: unknown;
  try { fn(); } catch (caught) { error = caught; }
  assert(error instanceof Error && pattern.test(error.message), `${message}: ${error instanceof Error ? error.message : "did not throw"}`);
}

assert(Object.isFrozen(FIDELITY_BUDGETS) && FIDELITY_BUDGETS.balanced.frameP95Ms === 16.7,
  "Balanced 60 FPS budget is not immutable and explicit");
const totalFrames = FIDELITY_CAMERA_ROUTE.reduce((sum, keyframe) => sum + keyframe.durationFrames, 0);
const first = fidelityCameraPose(0, [100, 20, -40]);
const wrapped = fidelityCameraPose(totalFrames, [100, 20, -40]);
assert(JSON.stringify(first) === JSON.stringify(wrapped), "camera route does not wrap deterministically");
assert(first.position[0] === 134 && first.position[1] === 25 && first.position[2] === -12,
  "camera route is not district-relative");
assert(Object.isFrozen(first) && Object.isFrozen(first.position) && Object.isFrozen(first.target),
  "camera pose escapes mutable benchmark state");
rejects(() => fidelityCameraPose(-1, [0, 0, 0]), /frame/, "negative camera frame was accepted");
rejects(() => fidelityCameraPose(0, [0, Number.NaN, 0]), /center/, "non-finite camera center was accepted");

const passing = new FidelityBenchmarkRecorder("balanced", 300, false);
for (let frame = 0; frame < 300; frame++) passing.record({
  frameMs: 15, submitMs: 3, presentMs: 1, gpuMs: null, drawCalls: 640, triangles: 2_000_000,
  gpuResourceBytes: 900_000_000, streamingMs: 1, visualFlags: 0,
});
const pass = passing.report();
assert(pass.schema === FIDELITY_BENCHMARK_SCHEMA && pass.passed && pass.samples === 300 && !pass.gpuTimingAvailable,
  `valid diagnostic benchmark failed: ${pass.violations.join(", ")}`);

const failing = new FidelityBenchmarkRecorder("balanced", 4, true);
failing.record({ frameMs: 60, submitMs: 8, presentMs: 42, gpuMs: null, drawCalls: 2_000, triangles: 4_000_000, gpuResourceBytes: 2_000_000_000, streamingMs: 9, visualFlags: FIDELITY_VISUAL_FLAGS.lodHole });
const fail = failing.report();
assert(!fail.passed && fail.violations.some((value) => value.includes("GPU timing"))
  && fail.violations.some((value) => value.includes("visual floor"))
  && fail.violations.some((value) => value.includes("draw calls")),
  `adversarial benchmark did not report independent violations: ${fail.violations.join(", ")}`);
rejects(() => failing.record({ frameMs: 1, submitMs: 1, presentMs: 1, gpuMs: -1, drawCalls: 1, triangles: 1, gpuResourceBytes: 1, streamingMs: 0, visualFlags: 0 }), /capacity|gpuMs/,
  "invalid or excess sample was accepted");

console.log("p_fidelity_benchmark OK: immutable quality budgets, deterministic camera route, allocation-bounded sampling, honest missing-GPU timing, and independent visual-floor/performance failures proven.");
