import {
  GPU_TIMESTAMP_NVIDIA_ACK,
  assertGpuTimestampAdapter,
  assertGpuTimestampRiskAccepted,
  decodeGpuTimestampPairs,
  isNvidiaGpuIdentity,
  parseGpuTimestampPairs,
  parseGpuTimestampStage,
  parseGpuTimestampSubmissionMode,
} from "../src/render/gpu-timestamp-diagnostic.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`p_gpu_timestamp_diagnostic FAIL: ${message}`);
}

function rejects(fn: () => unknown, pattern: RegExp, message: string): void {
  try { fn(); } catch (error) {
    assert(pattern.test(String(error)), `${message}: wrong error ${String(error)}`);
    return;
  }
  throw new Error(`p_gpu_timestamp_diagnostic FAIL: ${message}: did not reject`);
}

assert(parseGpuTimestampStage("write") === "write", "write stage rejected");
assert(parseGpuTimestampStage("resolve-copy") === "resolve-copy", "resolve-copy stage rejected");
assert(parseGpuTimestampStage("map-read") === "map-read", "map-read stage rejected");
rejects(() => parseGpuTimestampStage("live"), /stage must be one of/, "unknown stage accepted");

assert(parseGpuTimestampSubmissionMode("same-submit") === "same-submit", "same-submit mode rejected");
assert(parseGpuTimestampSubmissionMode("delayed-fenced") === "delayed-fenced", "delayed-fenced mode rejected");
rejects(() => parseGpuTimestampSubmissionMode("delayed"), /submission mode must be one of/, "unknown submission mode accepted");

assert(parseGpuTimestampPairs("1") === 1, "one pair rejected");
assert(parseGpuTimestampPairs("32") === 32, "maximum pair count rejected");
for (const invalid of ["", "0", "33", "1.5", "-1", " 1"]) {
  rejects(() => parseGpuTimestampPairs(invalid), /pairs must be an integer/, `invalid pair count '${invalid}' accepted`);
}

assertGpuTimestampAdapter("Intel(R) Iris(R) Xe Graphics", "iris");
rejects(
  () => assertGpuTimestampAdapter("NVIDIA GeForce RTX 3050 Laptop GPU", "Iris"),
  /does not match expected/,
  "adapter mismatch accepted",
);
rejects(() => assertGpuTimestampAdapter("Intel Iris Xe", ""), /requires LIMINA_GPU_EXPECTED/, "empty adapter expectation accepted");

assertGpuTimestampRiskAccepted("Intel Iris Xe", "");
assertGpuTimestampRiskAccepted("NVIDIA GeForce RTX 3050", GPU_TIMESTAMP_NVIDIA_ACK);
assert(isNvidiaGpuIdentity('{"vendor":"4318","description":""}'), "decimal NVIDIA PCI vendor identity was missed");
assert(isNvidiaGpuIdentity("vendor=0x10de"), "hex NVIDIA PCI vendor identity was missed");
assert(!isNvidiaGpuIdentity('{"vendor":"32902","device":"4318"}'), "non-vendor numeric device was misclassified as NVIDIA");
rejects(
  () => assertGpuTimestampRiskAccepted("NVIDIA GeForce RTX 3050", "yes"),
  /requires LIMINA_GPU_TIMESTAMP_RISK_ACK/,
  "NVIDIA probe accepted without exact acknowledgement",
);

const decoded = decodeGpuTimestampPairs(new BigUint64Array([10n, 2_000_010n, 50n, 50n, 99n, 80n]), 3);
assert(decoded.attemptedPairs === 3, "attempted pair count is wrong");
assert(decoded.validPairs === 2 && decoded.rejectedPairs === 1, "valid/rejected coverage is wrong");
assert(decoded.durationsMs[0] === 2 && decoded.durationsMs[1] === 0, "duration decoding is wrong");
rejects(
  () => decodeGpuTimestampPairs(new BigUint64Array([1n]), 1),
  /shorter than/,
  "short result buffer accepted",
);

console.log("p_gpu_timestamp_diagnostic OK: stages, submission modes, bounds, adapter guard, NVIDIA acknowledgement, and timestamp decoding proven.");
