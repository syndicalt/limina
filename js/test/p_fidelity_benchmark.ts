import {
  FIDELITY_BENCHMARK_SCHEMA,
  FIDELITY_BUDGETS,
  FIDELITY_CAMERA_ROUTE,
  FIDELITY_GPU_CAPTURE_ROUTE_FRAMES,
  FIDELITY_VISUAL_FLAGS,
  FidelityBenchmarkRecorder,
  fidelityCameraPose,
  isSoftwareAdapter,
} from "../src/render/fidelity-benchmark.ts";
import { THREE_GPU_TIMESTAMP_CAPTURE_METHOD } from "../src/render/three-gpu-timestamp-capture.ts";

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
assert(FIDELITY_GPU_CAPTURE_ROUTE_FRAMES.length === 32
  && new Set(FIDELITY_GPU_CAPTURE_ROUTE_FRAMES).size === 32
  && Object.isFrozen(FIDELITY_GPU_CAPTURE_ROUTE_FRAMES),
  "GPU capture route is not an immutable 32-frame population");
let captureSegmentStart = 0;
for (const segment of FIDELITY_CAMERA_ROUTE) {
  assert(FIDELITY_GPU_CAPTURE_ROUTE_FRAMES.filter((frame) =>
    frame >= captureSegmentStart && frame < captureSegmentStart + segment.durationFrames).length === 8,
  `GPU capture route does not contain eight samples for ${segment.segment}`);
  captureSegmentStart += segment.durationFrames;
}
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

const timed = new FidelityBenchmarkRecorder("balanced", 32, true);
for (let frame = 0; frame < 32; frame++) timed.record({
  frameMs: 15, submitMs: 3, presentMs: 1, gpuMs: null, drawCalls: 640, triangles: 2_000_000,
  gpuResourceBytes: 900_000_000, streamingMs: 1, visualFlags: 0,
});
const gpuCapture = Object.freeze({
  status: "available" as const,
  method: THREE_GPU_TIMESTAMP_CAPTURE_METHOD,
  attemptedFrames: 32,
  validFrames: 32,
  coverage: 1,
  routeFrames: FIDELITY_GPU_CAPTURE_ROUTE_FRAMES,
  threeFrameIds: Object.freeze([...FIDELITY_GPU_CAPTURE_ROUTE_FRAMES]),
  sampleMs: Object.freeze(Array.from({ length: 32 }, (_, index) => index + 1)),
});
timed.recordGpuCapture(gpuCapture);
const timedReport = timed.report();
assert(timedReport.gpuSamples === 32 && timedReport.gpuTiming === gpuCapture
  && timedReport.metrics.gpuP95Ms === 31 && timedReport.metrics.frameP95Ms === 15,
  "bounded GPU capture did not remain independent from CPU percentiles");
rejects(() => timed.recordGpuCapture(gpuCapture), /only be attached once/, "duplicate GPU capture accepted");

const partial = new FidelityBenchmarkRecorder("balanced", 32, true);
for (let frame = 0; frame < 32; frame++) partial.record({
  frameMs: 15, submitMs: 3, presentMs: 1, gpuMs: null, drawCalls: 1, triangles: 1,
  gpuResourceBytes: 1, streamingMs: 0, visualFlags: 0,
});
rejects(() => partial.recordGpuCapture(Object.freeze({ ...gpuCapture, validFrames: 31, coverage: 31 / 32 })), /32\/32/,
  "partial GPU capture accepted");

const failing = new FidelityBenchmarkRecorder("balanced", 4, true);
failing.record({ frameMs: 60, submitMs: 8, presentMs: 42, gpuMs: null, drawCalls: 2_000, triangles: 4_000_000, gpuResourceBytes: 2_000_000_000, streamingMs: 9, visualFlags: FIDELITY_VISUAL_FLAGS.lodHole });
const fail = failing.report();
assert(!fail.passed && fail.violations.some((value) => value.includes("GPU timing"))
  && fail.violations.some((value) => value.includes("visual floor"))
  && fail.violations.some((value) => value.includes("draw calls")),
  `adversarial benchmark did not report independent violations: ${fail.violations.join(", ")}`);
rejects(() => failing.record({ frameMs: 1, submitMs: 1, presentMs: 1, gpuMs: -1, drawCalls: 1, triangles: 1, gpuResourceBytes: 1, streamingMs: 0, visualFlags: 0 }), /capacity|gpuMs/,
  "invalid or excess sample was accepted");

// GPU-realness is ENFORCED, not merely recorded: a software rasterizer is a hard fidelity violation,
// a hardware adapter passes cleanly, and a hardware-required run with no adapter recorded fails.
const softwareInfo = { vendor: "Google Inc.", architecture: "", device: "", description: "Google SwiftShader" };
const hardwareInfo = { vendor: "Intel", architecture: "gen-12", device: "0x9a49", description: "Intel(R) Iris(R) Xe Graphics" };
assert(isSoftwareAdapter(softwareInfo) && !isSoftwareAdapter(hardwareInfo), "software-adapter classification is wrong");

function cleanRun(requireHardwareAdapter: boolean): FidelityBenchmarkRecorder {
  const recorder = new FidelityBenchmarkRecorder("balanced", 32, false, requireHardwareAdapter);
  for (let frame = 0; frame < 32; frame++) recorder.record({
    frameMs: 15, submitMs: 3, presentMs: 1, gpuMs: null, drawCalls: 640, triangles: 2_000_000,
    gpuResourceBytes: 900_000_000, streamingMs: 1, visualFlags: 0,
  });
  return recorder;
}

const software = cleanRun(true);
software.recordAdapter(softwareInfo);
const softwareReport = software.report();
assert(!softwareReport.passed && softwareReport.violations.some((value) => value.includes("software GPU adapter")),
  `software adapter was allowed to certify fidelity: ${softwareReport.violations.join(", ")}`);

const unrecorded = cleanRun(true);
assert(unrecorded.report().violations.some((value) => value.includes("adapter identity was not recorded")),
  "a hardware-required benchmark passed without recording any adapter identity");

const hardware = cleanRun(true);
hardware.recordAdapter(hardwareInfo);
const hardwareReport = hardware.report();
assert(hardwareReport.passed && hardwareReport.adapter?.description === hardwareInfo.description,
  `hardware adapter run did not pass cleanly: ${hardwareReport.violations.join(", ")}`);
rejects(() => hardware.recordAdapter(hardwareInfo), /only be recorded once/, "duplicate adapter identity accepted");

console.log("p_fidelity_benchmark OK: immutable quality budgets, deterministic camera route, allocation-bounded sampling, honest missing-GPU timing, enforced hardware-GPU adapter identity, and independent visual-floor/performance failures proven.");
