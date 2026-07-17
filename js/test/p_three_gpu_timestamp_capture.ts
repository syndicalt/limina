import {
  ThreeGpuTimestampCapture,
  assertThreeGpuTimestampCapturePlatform,
} from "../src/render/three-gpu-timestamp-capture.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`p_three_gpu_timestamp_capture FAIL: ${message}`);
}

async function rejects(fn: () => unknown | Promise<unknown>, pattern: RegExp, message: string): Promise<void> {
  try { await fn(); } catch (error) {
    assert(pattern.test(String(error)), `${message}: wrong error ${String(error)}`);
    return;
  }
  throw new Error(`p_three_gpu_timestamp_capture FAIL: ${message}: did not reject`);
}

function fakeRenderer(
  sample: (frame: number) => number = () => 2,
  fence: () => Promise<void> = async () => {},
): {
  renderer: {
    backend: {
      trackTimestamp: boolean;
      device: { queue: { onSubmittedWorkDone(): Promise<void> } };
      timestampQueryPool: { render: null | { frames: number[]; timestamps: Map<string, number> } };
    };
    info: { frame: number };
    resolveTimestampsAsync(): Promise<number>;
  };
  calls(): number;
  fences(): number;
  sawTracking(): boolean;
} {
  let calls = 0;
  let fences = 0;
  let tracking = false;
  const backend = {
    trackTimestamp: false,
    device: { queue: { onSubmittedWorkDone: async (): Promise<void> => { fences++; await fence(); } } },
    timestampQueryPool: { render: null as null | { frames: number[]; timestamps: Map<string, number> } },
  };
  return {
    renderer: {
      backend,
      info: { frame: 0 },
      resolveTimestampsAsync(): Promise<number> {
        calls++;
        tracking = backend.trackTimestamp;
        const frames = Array.from({ length: 32 }, (_, index) => index + 100);
        const timestamps = new Map<string, number>();
        for (const frame of frames) {
          timestamps.set(`main:f${frame}`, sample(frame));
          timestamps.set(`post:f${frame}`, 0.5);
        }
        backend.timestampQueryPool.render = { frames, timestamps };
        return Promise.resolve(sample(frames.at(-1)!) + 0.5);
      },
    },
    calls: () => calls,
    fences: () => fences,
    sawTracking: () => tracking,
  };
}

const fake = fakeRenderer((frame) => frame / 100);
const capture = new ThreeGpuTimestampCapture(fake.renderer, true);
assert(capture.phase === "idle" && fake.renderer.backend.trackTimestamp === false, "capture did not start idle");
await rejects(() => capture.beforeRendered(0), /during idle/, "frame accepted before start");
capture.start();
assert(capture.phase === "capturing" && fake.renderer.backend.trackTimestamp === true, "start did not enable tracking");
await rejects(() => capture.settleAndResolve(async () => {}), /cannot start from capturing/, "early resolve accepted");
for (let frame = 0; frame < 31; frame++) {
  capture.beforeRendered(frame);
  assert(capture.afterRendered() === false, `capture ended early at frame ${frame}`);
}
capture.beforeRendered(31);
assert(capture.afterRendered() === true, "capture did not end at exactly 32 frames");
assert(capture.phase === "settling" && fake.renderer.backend.trackTimestamp === false, "capture did not disable tracking before settle");

let waited = -1;
let releaseFence!: () => void;
const fenceGate = new Promise<void>((resolve) => { releaseFence = resolve; });
fake.renderer.backend.device.queue.onSubmittedWorkDone = async (): Promise<void> => {
  await fenceGate;
};
const pending = capture.settleAndResolve(async (milliseconds) => { waited = milliseconds; });
assert(fake.renderer.backend.trackTimestamp === false, "tracking stayed enabled while resolve promise was pending");
await Promise.resolve();
assert(waited === -1 && fake.calls() === 0, "settle or resolve escaped ahead of the queue completion fence");
releaseFence();
const report = await pending;
assert(waited === 250 && fake.calls() === 1 && fake.sawTracking(),
  "queue fence and resolve were not invoked once with temporary tracking");
assert(capture.phase === "complete" && fake.renderer.backend.trackTimestamp === false, "capture did not complete with tracking disabled");
assert(report.validFrames === 32 && report.coverage === 1 && report.sampleMs.length === 32,
  "complete capture did not produce 32/32 samples");
assert(report.sampleMs[0] === 1.5 && report.sampleMs[31] === 1.81, "per-frame contexts were not aggregated in order");
assert(Object.isFrozen(report) && Object.isFrozen(report.sampleMs) && Object.isFrozen(report.routeFrames),
  "capture report escaped mutable state");
await rejects(() => capture.start(), /cannot start/, "second capture accepted");

const invalid = fakeRenderer(() => -1);
const invalidCapture = new ThreeGpuTimestampCapture(invalid.renderer, true);
invalidCapture.start();
for (let frame = 0; frame < 32; frame++) {
  invalidCapture.beforeRendered(frame);
  invalidCapture.afterRendered();
}
await rejects(() => invalidCapture.settleAndResolve(async () => {}), /invalid duration/, "negative GPU durations accepted");
assert(invalidCapture.phase === "failed" && invalid.renderer.backend.trackTimestamp === false,
  "failed capture did not disable tracking");

await rejects(
  () => Promise.resolve(new ThreeGpuTimestampCapture({ backend: { trackTimestamp: false } }, true)),
  /requires the pinned/,
  "renderer without resolve support accepted",
);
await rejects(
  () => Promise.resolve(new ThreeGpuTimestampCapture(fakeRenderer().renderer, false)),
  /available timestamp-query/,
  "unavailable timestamp device accepted",
);

assertThreeGpuTimestampCapturePlatform("Intel(R) Iris(R) Xe Graphics");
await rejects(
  () => assertThreeGpuTimestampCapturePlatform('{"vendor":"4318","description":""}'),
  /disabled on NVIDIA.*timed out/,
  "NVIDIA numeric PCI vendor bypassed the pooled capture guard",
);
await rejects(
  () => assertThreeGpuTimestampCapturePlatform("NVIDIA GeForce RTX 3050 Laptop GPU"),
  /disabled on NVIDIA.*timed out/,
  "known-hanging NVIDIA pooled capture platform accepted",
);

console.log("p_three_gpu_timestamp_capture OK: bounded phases, tracking isolation, exact coverage, aggregation, immutability, platform guard, and failure cleanup proven.");
