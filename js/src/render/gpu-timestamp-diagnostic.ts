export const GPU_TIMESTAMP_DIAGNOSTIC_SCHEMA = "limina.gpu-timestamp-diagnostic/v1";
export const GPU_TIMESTAMP_MAX_PAIRS = 32;
export const GPU_TIMESTAMP_NVIDIA_ACK = "I_UNDERSTAND_XID_RISK";

export const GPU_TIMESTAMP_STAGES = Object.freeze([
  "write",
  "resolve-copy",
  "map-read",
] as const);

export const GPU_TIMESTAMP_SUBMISSION_MODES = Object.freeze([
  "same-submit",
  "delayed-fenced",
] as const);

export type GpuTimestampStage = typeof GPU_TIMESTAMP_STAGES[number];
export type GpuTimestampSubmissionMode = typeof GPU_TIMESTAMP_SUBMISSION_MODES[number];

export interface GpuTimestampDecodeReport {
  attemptedPairs: number;
  validPairs: number;
  rejectedPairs: number;
  durationsMs: readonly number[];
}

export function parseGpuTimestampStage(value: string): GpuTimestampStage {
  if ((GPU_TIMESTAMP_STAGES as readonly string[]).includes(value)) return value as GpuTimestampStage;
  throw new RangeError(`GPU timestamp stage must be one of ${GPU_TIMESTAMP_STAGES.join(", ")}`);
}

export function parseGpuTimestampSubmissionMode(value: string): GpuTimestampSubmissionMode {
  if ((GPU_TIMESTAMP_SUBMISSION_MODES as readonly string[]).includes(value)) {
    return value as GpuTimestampSubmissionMode;
  }
  throw new RangeError(`GPU timestamp submission mode must be one of ${GPU_TIMESTAMP_SUBMISSION_MODES.join(", ")}`);
}

export function parseGpuTimestampPairs(value: string): number {
  if (!/^[0-9]+$/.test(value)) {
    throw new RangeError(`GPU timestamp pairs must be an integer in [1, ${GPU_TIMESTAMP_MAX_PAIRS}]`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > GPU_TIMESTAMP_MAX_PAIRS) {
    throw new RangeError(`GPU timestamp pairs must be an integer in [1, ${GPU_TIMESTAMP_MAX_PAIRS}]`);
  }
  return parsed;
}

export function assertGpuTimestampAdapter(description: string, expectedSubstring: string): void {
  const expected = expectedSubstring.trim();
  if (expected.length === 0) throw new Error("GPU timestamp probe requires LIMINA_GPU_EXPECTED_ADAPTER_SUBSTRING");
  if (!description.toLocaleLowerCase().includes(expected.toLocaleLowerCase())) {
    throw new Error(`GPU timestamp adapter '${description || "unknown"}' does not match expected '${expected}'`);
  }
}

export function isNvidiaGpuIdentity(identity: string): boolean {
  return /nvidia/i.test(identity)
    || /vendor["']?\s*[:=]\s*["']?(?:4318|(?:0x)?10de)\b/i.test(identity)
    || /^\s*(?:4318|(?:0x)?10de)\s*$/i.test(identity);
}

export function assertGpuTimestampRiskAccepted(description: string, acknowledgement: string): void {
  if (isNvidiaGpuIdentity(description) && acknowledgement !== GPU_TIMESTAMP_NVIDIA_ACK) {
    throw new Error(`NVIDIA timestamp probing requires LIMINA_GPU_TIMESTAMP_RISK_ACK=${GPU_TIMESTAMP_NVIDIA_ACK}`);
  }
}

export function decodeGpuTimestampPairs(values: BigUint64Array, pairCount: number): Readonly<GpuTimestampDecodeReport> {
  if (!Number.isSafeInteger(pairCount) || pairCount < 1 || pairCount > GPU_TIMESTAMP_MAX_PAIRS) {
    throw new RangeError(`GPU timestamp pairCount must be in [1, ${GPU_TIMESTAMP_MAX_PAIRS}]`);
  }
  if (values.length < pairCount * 2) throw new RangeError("GPU timestamp result buffer is shorter than the requested pair count");

  const durationsMs: number[] = [];
  let rejectedPairs = 0;
  for (let pair = 0; pair < pairCount; pair++) {
    const start = values[pair * 2]!;
    const end = values[pair * 2 + 1]!;
    // WebGPU timestamps can reset. Reject reversed pairs instead of interpreting the unsigned
    // underflow as an enormous duration. Equal values are a valid zero-duration observation.
    if (end < start) {
      rejectedPairs++;
      continue;
    }
    durationsMs.push(Number(end - start) / 1_000_000);
  }
  return Object.freeze({
    attemptedPairs: pairCount,
    validPairs: durationsMs.length,
    rejectedPairs,
    durationsMs: Object.freeze(durationsMs),
  });
}
