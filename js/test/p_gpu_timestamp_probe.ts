// Raw, offscreen WebGPU timestamp fault-localization probe.
//
// This deliberately does not use Three.js, a window surface, or the production engine. It tests
// cumulative boundaries so a hang/device fault can be attributed to timestamp write, resolve/copy,
// or map/readback. Supervise hardware runs with an external hard timeout.
//
// Iris examples (one pair, in safety order):
//   LIMINA_GPU_POWER_PREFERENCE=low-power LIMINA_GPU_EXPECTED_ADAPTER_SUBSTRING=Iris LIMINA_GPU_TIMESTAMP_STAGE=write ./target/release/limina js/test/p_gpu_timestamp_probe.ts
//   LIMINA_GPU_POWER_PREFERENCE=low-power LIMINA_GPU_EXPECTED_ADAPTER_SUBSTRING=Iris LIMINA_GPU_TIMESTAMP_STAGE=resolve-copy ./target/release/limina js/test/p_gpu_timestamp_probe.ts
//   LIMINA_GPU_POWER_PREFERENCE=low-power LIMINA_GPU_EXPECTED_ADAPTER_SUBSTRING=Iris LIMINA_GPU_TIMESTAMP_STAGE=map-read ./target/release/limina js/test/p_gpu_timestamp_probe.ts
// Delayed cross-submission resolve with an actual queue-completion fence:
//   LIMINA_GPU_TIMESTAMP_SUBMISSION=delayed-fenced LIMINA_GPU_TIMESTAMP_PAIRS=32
//
// NVIDIA additionally requires:
//   LIMINA_GPU_TIMESTAMP_RISK_ACK=I_UNDERSTAND_XID_RISK

import {
  GPU_TIMESTAMP_DIAGNOSTIC_SCHEMA,
  assertGpuTimestampAdapter,
  assertGpuTimestampRiskAccepted,
  decodeGpuTimestampPairs,
  parseGpuTimestampPairs,
  parseGpuTimestampStage,
  parseGpuTimestampSubmissionMode,
} from "../src/render/gpu-timestamp-diagnostic.ts";

type PowerPreference = "low-power" | "high-performance";

interface ProbeOps {
  op_log(message: string): void;
  op_read_env(name: string): string;
  op_sleep_ms(milliseconds: number): Promise<void>;
}

declare const Deno: { core: { ops: ProbeOps } };

const ops = Deno.core.ops;
const stage = parseGpuTimestampStage(ops.op_read_env("LIMINA_GPU_TIMESTAMP_STAGE") || "write");
const pairCount = parseGpuTimestampPairs(ops.op_read_env("LIMINA_GPU_TIMESTAMP_PAIRS") || "1");
const submissionMode = parseGpuTimestampSubmissionMode(ops.op_read_env("LIMINA_GPU_TIMESTAMP_SUBMISSION") || "same-submit");
const expectedAdapter = ops.op_read_env("LIMINA_GPU_EXPECTED_ADAPTER_SUBSTRING");
const acknowledgement = ops.op_read_env("LIMINA_GPU_TIMESTAMP_RISK_ACK");
const configuredPreference = ops.op_read_env("LIMINA_GPU_POWER_PREFERENCE");
if (configuredPreference !== "low-power" && configuredPreference !== "high-performance") {
  throw new Error("GPU timestamp probe requires LIMINA_GPU_POWER_PREFERENCE=low-power|high-performance");
}
const powerPreference = configuredPreference as PowerPreference;

ops.op_log(`GPU timestamp probe: stage=${stage} submission=${submissionMode} pairs=${pairCount} preference=${powerPreference}`);
const adapter = await navigator.gpu.requestAdapter({ powerPreference });
if (!adapter) throw new Error("GPU timestamp probe: no WebGPU adapter");
const adapterDescription = adapter.info?.description ?? adapter.info?.device ?? "";
assertGpuTimestampAdapter(adapterDescription, expectedAdapter);
assertGpuTimestampRiskAccepted(adapterDescription, acknowledgement);
if (!adapter.features.has("timestamp-query")) throw new Error("GPU timestamp probe: adapter lacks timestamp-query");
const adapterMetadata = Object.freeze({
  vendor: adapter.info?.vendor ?? "",
  architecture: adapter.info?.architecture ?? "",
  device: adapter.info?.device ?? "",
  description: adapterDescription,
});
ops.op_log(`GPU timestamp probe: adapter accepted ${JSON.stringify(adapterMetadata)}`);

const device = await adapter.requestDevice({ requiredFeatures: ["timestamp-query"] });
ops.op_log("GPU timestamp probe: timestamp-query device created");

const queryCount = pairCount * 2;
const bytesUsed = queryCount * BigUint64Array.BYTES_PER_ELEMENT;
const allocationSize = Math.max(256, bytesUsed);
const querySet = device.createQuerySet({ type: "timestamp", count: queryCount, label: "limina_timestamp_probe_queries" });
const offscreen = device.createTexture({
  label: "limina_timestamp_probe_target",
  size: [1, 1, 1],
  format: "rgba8unorm",
  usage: GPUTextureUsage.RENDER_ATTACHMENT,
});

const writeResolveEncoder = device.createCommandEncoder({ label: "limina_timestamp_probe_write_resolve" });
for (let pair = 0; pair < pairCount; pair++) {
  const pass = writeResolveEncoder.beginRenderPass({
    label: `limina_timestamp_probe_pass_${pair}`,
    colorAttachments: [{
      view: offscreen.createView(),
      loadOp: "clear",
      storeOp: "store",
      clearValue: { r: pair / pairCount, g: 0, b: 0, a: 1 },
    }],
    timestampWrites: {
      querySet,
      beginningOfPassWriteIndex: pair * 2,
      endOfPassWriteIndex: pair * 2 + 1,
    },
  });
  pass.end();
}
ops.op_log("GPU timestamp probe: timestamp passes encoded");

let resolveBuffer: GPUBuffer | undefined;
let readBuffer: GPUBuffer | undefined;
if (stage === "write") {
  device.queue.submit([writeResolveEncoder.finish()]);
  ops.op_log("GPU timestamp probe: submitted timestamp writes only");
} else {
  resolveBuffer = device.createBuffer({
    label: "limina_timestamp_probe_resolve",
    size: allocationSize,
    usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC,
  });
  readBuffer = device.createBuffer({
    label: "limina_timestamp_probe_read",
    size: allocationSize,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  });
  let resolveEncoder = writeResolveEncoder;
  if (submissionMode === "delayed-fenced") {
    device.queue.submit([writeResolveEncoder.finish()]);
    ops.op_log("GPU timestamp probe: timestamp writes submitted; awaiting queue completion fence");
    await device.queue.onSubmittedWorkDone();
    ops.op_log("GPU timestamp probe: timestamp-write queue completion fence passed");
    resolveEncoder = device.createCommandEncoder({ label: "limina_timestamp_probe_delayed_resolve" });
  }
  // wgpu #6406: keep query resolution and the readback copy in separate encoders.
  // `delayed-fenced` additionally proves resolution of writes from an earlier completed submission.
  resolveEncoder.resolveQuerySet(querySet, 0, queryCount, resolveBuffer, 0);
  const copyEncoder = device.createCommandEncoder({ label: "limina_timestamp_probe_copy" });
  copyEncoder.copyBufferToBuffer(resolveBuffer, 0, readBuffer, 0, bytesUsed);
  device.queue.submit([resolveEncoder.finish(), copyEncoder.finish()]);
  ops.op_log(`GPU timestamp probe: resolve and copy submitted separately after ${submissionMode}`);
}
ops.op_log("GPU timestamp probe: waiting 250ms with no window surface");
await ops.op_sleep_ms(250);

if (stage !== "map-read") {
  ops.op_log(`GPU timestamp probe: PASS stage=${stage} survived the post-submit settle window`);
} else {
  if (!readBuffer) throw new Error("GPU timestamp probe: map-read stage has no read buffer");
  const mapStartedAt = performance.now();
  ops.op_log("GPU timestamp probe: mapAsync starting");
  await readBuffer.mapAsync(GPUMapMode.READ, 0, bytesUsed);
  const copied = new BigUint64Array(readBuffer.getMappedRange(0, bytesUsed)).slice();
  readBuffer.unmap();
  const decoded = decodeGpuTimestampPairs(copied, pairCount);
  if (decoded.validPairs !== pairCount) {
    throw new Error(`GPU timestamp probe: only ${decoded.validPairs}/${pairCount} timestamp pairs were valid`);
  }
  const report = Object.freeze({
    schema: GPU_TIMESTAMP_DIAGNOSTIC_SCHEMA,
    stage,
    submissionMode,
    adapter: adapterMetadata,
    ...decoded,
    mapWallMs: performance.now() - mapStartedAt,
  });
  ops.op_log(`GPU timestamp probe: PASS ${JSON.stringify(report)}`);
}
