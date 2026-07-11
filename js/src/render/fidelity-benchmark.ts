import type { RenderQualityTier } from "./quality.ts";

export const FIDELITY_BENCHMARK_SCHEMA = "limina.fidelity-benchmark/v1";
export const FIDELITY_BENCHMARK_MAX_SAMPLES = 36_000;

export const FIDELITY_VISUAL_FLAGS = Object.freeze({
  missingRequiredContent: 1 << 0,
  invalidMaterial: 1 << 1,
  lodHole: 1 << 2,
  exposureClipping: 1 << 3,
  shaderCompilationAfterReady: 1 << 4,
} as const);

export interface FidelityBudget {
  frameP95Ms: number;
  submitP95Ms: number;
  gpuP95Ms: number;
  maxDrawCalls: number;
  maxTriangles: number;
  maxGpuResourceBytes: number;
  streamingP99Ms: number;
  hitchP99Ms: number;
}

export const FIDELITY_BUDGETS: Readonly<Record<RenderQualityTier, Readonly<FidelityBudget>>> = Object.freeze({
  performance: Object.freeze({
    frameP95Ms: 16.7, submitP95Ms: 4, gpuP95Ms: 10, maxDrawCalls: 700,
    maxTriangles: 1_500_000, maxGpuResourceBytes: 1024 ** 3, streamingP99Ms: 2, hitchP99Ms: 25,
  }),
  balanced: Object.freeze({
    frameP95Ms: 16.7, submitP95Ms: 4, gpuP95Ms: 12, maxDrawCalls: 1_000,
    maxTriangles: 3_000_000, maxGpuResourceBytes: 1.5 * 1024 ** 3, streamingP99Ms: 3, hitchP99Ms: 25,
  }),
  cinematic: Object.freeze({
    frameP95Ms: 33.3, submitP95Ms: 6, gpuP95Ms: 25, maxDrawCalls: 1_500,
    maxTriangles: 6_000_000, maxGpuResourceBytes: 2 * 1024 ** 3, streamingP99Ms: 4, hitchP99Ms: 40,
  }),
});

export interface FidelityCameraKeyframe {
  segment: "near-structure" | "vegetation-traverse" | "water-look" | "lod-transition";
  position: readonly [number, number, number];
  target: readonly [number, number, number];
  durationFrames: number;
}

function xyz(x: number, y: number, z: number): readonly [number, number, number] {
  return Object.freeze([x, y, z]);
}

export const FIDELITY_CAMERA_ROUTE: readonly Readonly<FidelityCameraKeyframe>[] = Object.freeze([
  Object.freeze({ segment: "near-structure", position: xyz(34, 5, 28), target: xyz(0, 3, 0), durationFrames: 180 }),
  Object.freeze({ segment: "vegetation-traverse", position: xyz(9, 4, 18), target: xyz(-22, 3, -8), durationFrames: 240 }),
  Object.freeze({ segment: "water-look", position: xyz(-28, 8, 10), target: xyz(-8, 0, -28), durationFrames: 180 }),
  Object.freeze({ segment: "lod-transition", position: xyz(-54, 22, 58), target: xyz(0, 2, 0), durationFrames: 300 }),
]);

export interface FidelityCameraPose {
  segment: FidelityCameraKeyframe["segment"];
  position: readonly [number, number, number];
  target: readonly [number, number, number];
}

function smoothstep(value: number): number { return value * value * (3 - 2 * value); }

export function fidelityCameraPose(frame: number, center: readonly [number, number, number]): Readonly<FidelityCameraPose> {
  if (!Number.isSafeInteger(frame) || frame < 0) throw new RangeError("fidelity camera frame must be a non-negative safe integer");
  if (!Array.isArray(center) || center.length !== 3 || center.some((value) => !Number.isFinite(value))) {
    throw new TypeError("fidelity camera center must be a finite xyz tuple");
  }
  const total = FIDELITY_CAMERA_ROUTE.reduce((sum, keyframe) => sum + keyframe.durationFrames, 0);
  let localFrame = frame % total;
  for (let index = 0; index < FIDELITY_CAMERA_ROUTE.length; index++) {
    const from = FIDELITY_CAMERA_ROUTE[index]!;
    if (localFrame >= from.durationFrames) { localFrame -= from.durationFrames; continue; }
    const to = FIDELITY_CAMERA_ROUTE[(index + 1) % FIDELITY_CAMERA_ROUTE.length]!;
    const t = smoothstep(localFrame / from.durationFrames);
    const interpolate = (a: readonly [number, number, number], b: readonly [number, number, number]): readonly [number, number, number] => Object.freeze([
      center[0] + a[0] + (b[0] - a[0]) * t,
      center[1] + a[1] + (b[1] - a[1]) * t,
      center[2] + a[2] + (b[2] - a[2]) * t,
    ]);
    return Object.freeze({ segment: from.segment, position: interpolate(from.position, to.position), target: interpolate(from.target, to.target) });
  }
  throw new Error("fidelity camera route is empty");
}

export interface FidelityFrameSample {
  frameMs: number;
  submitMs: number;
  presentMs: number;
  gpuMs: number | null;
  drawCalls: number;
  triangles: number;
  gpuResourceBytes: number;
  streamingMs: number;
  visualFlags: number;
}

export interface FidelityBenchmarkReport {
  schema: typeof FIDELITY_BENCHMARK_SCHEMA;
  tier: RenderQualityTier;
  samples: number;
  gpuTimingAvailable: boolean;
  metrics: Readonly<Record<string, number | null>>;
  violations: readonly string[];
  passed: boolean;
}

function finite(value: number, label: string): number {
  if (!Number.isFinite(value) || value < 0) throw new RangeError(`${label} must be finite and non-negative`);
  return value;
}

function percentile(source: Float64Array, count: number, fraction: number): number {
  const copy = source.slice(0, count);
  copy.sort();
  return copy[Math.max(0, Math.ceil(copy.length * fraction) - 1)] ?? 0;
}

export class FidelityBenchmarkRecorder {
  readonly #tier: RenderQualityTier;
  readonly #budget: Readonly<FidelityBudget>;
  readonly #requireGpuTiming: boolean;
  readonly #frameMs: Float64Array;
  readonly #submitMs: Float64Array;
  readonly #presentMs: Float64Array;
  readonly #gpuMs: Float64Array;
  readonly #streamingMs: Float64Array;
  #count = 0;
  #gpuSamples = 0;
  #maxDrawCalls = 0;
  #maxTriangles = 0;
  #maxGpuResourceBytes = 0;
  #visualFlags = 0;

  constructor(tier: RenderQualityTier, capacity: number, requireGpuTiming = true) {
    const budget = FIDELITY_BUDGETS[tier];
    if (budget === undefined) throw new TypeError("fidelity benchmark tier is unsupported");
    if (!Number.isSafeInteger(capacity) || capacity < 1 || capacity > FIDELITY_BENCHMARK_MAX_SAMPLES) {
      throw new RangeError(`fidelity benchmark capacity must be in [1, ${FIDELITY_BENCHMARK_MAX_SAMPLES}]`);
    }
    this.#tier = tier;
    this.#budget = budget;
    this.#requireGpuTiming = requireGpuTiming;
    this.#frameMs = new Float64Array(capacity);
    this.#submitMs = new Float64Array(capacity);
    this.#presentMs = new Float64Array(capacity);
    this.#gpuMs = new Float64Array(capacity);
    this.#streamingMs = new Float64Array(capacity);
  }

  get size(): number { return this.#count; }
  get capacity(): number { return this.#frameMs.length; }

  record(sample: Readonly<FidelityFrameSample>): void {
    if (this.#count >= this.capacity) throw new RangeError("fidelity benchmark sample capacity exceeded");
    const index = this.#count++;
    this.#frameMs[index] = finite(sample.frameMs, "fidelity frameMs");
    this.#submitMs[index] = finite(sample.submitMs, "fidelity submitMs");
    this.#presentMs[index] = finite(sample.presentMs, "fidelity presentMs");
    this.#streamingMs[index] = finite(sample.streamingMs, "fidelity streamingMs");
    if (sample.gpuMs !== null) {
      this.#gpuMs[this.#gpuSamples++] = finite(sample.gpuMs, "fidelity gpuMs");
    }
    for (const [value, label] of [[sample.drawCalls, "drawCalls"], [sample.triangles, "triangles"], [sample.gpuResourceBytes, "gpuResourceBytes"]] as const) {
      if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`fidelity ${label} must be a non-negative safe integer`);
    }
    if (!Number.isSafeInteger(sample.visualFlags) || sample.visualFlags < 0 || sample.visualFlags > 0xffff_ffff) {
      throw new RangeError("fidelity visualFlags must be an unsigned 32-bit integer");
    }
    this.#maxDrawCalls = Math.max(this.#maxDrawCalls, sample.drawCalls);
    this.#maxTriangles = Math.max(this.#maxTriangles, sample.triangles);
    this.#maxGpuResourceBytes = Math.max(this.#maxGpuResourceBytes, sample.gpuResourceBytes);
    this.#visualFlags |= sample.visualFlags;
  }

  report(): Readonly<FidelityBenchmarkReport> {
    if (this.#count === 0) throw new Error("fidelity benchmark has no samples");
    const frameP95Ms = percentile(this.#frameMs, this.#count, 0.95);
    const hitchP99Ms = percentile(this.#frameMs, this.#count, 0.99);
    const submitP95Ms = percentile(this.#submitMs, this.#count, 0.95);
    const presentP95Ms = percentile(this.#presentMs, this.#count, 0.95);
    const streamingP99Ms = percentile(this.#streamingMs, this.#count, 0.99);
    const gpuP95Ms = this.#gpuSamples === 0 ? null : percentile(this.#gpuMs, this.#gpuSamples, 0.95);
    const violations: string[] = [];
    const over = (name: string, value: number, maximum: number): void => { if (value > maximum) violations.push(`${name} ${value.toFixed(3)} exceeds ${maximum}`); };
    over("frame p95 ms", frameP95Ms, this.#budget.frameP95Ms);
    over("hitch p99 ms", hitchP99Ms, this.#budget.hitchP99Ms);
    over("submit p95 ms", submitP95Ms, this.#budget.submitP95Ms);
    over("streaming p99 ms", streamingP99Ms, this.#budget.streamingP99Ms);
    over("draw calls", this.#maxDrawCalls, this.#budget.maxDrawCalls);
    over("triangles", this.#maxTriangles, this.#budget.maxTriangles);
    over("GPU resource bytes", this.#maxGpuResourceBytes, this.#budget.maxGpuResourceBytes);
    if (gpuP95Ms === null) {
      if (this.#requireGpuTiming) violations.push("GPU timing is unavailable");
    } else over("GPU p95 ms", gpuP95Ms, this.#budget.gpuP95Ms);
    if (this.#visualFlags !== 0) violations.push(`visual floor flags 0x${this.#visualFlags.toString(16)}`);
    return Object.freeze({
      schema: FIDELITY_BENCHMARK_SCHEMA,
      tier: this.#tier,
      samples: this.#count,
      gpuTimingAvailable: gpuP95Ms !== null,
      metrics: Object.freeze({ frameP95Ms, hitchP99Ms, submitP95Ms, presentP95Ms, gpuP95Ms, streamingP99Ms, maxDrawCalls: this.#maxDrawCalls, maxTriangles: this.#maxTriangles, maxGpuResourceBytes: this.#maxGpuResourceBytes, visualFlags: this.#visualFlags }),
      violations: Object.freeze(violations),
      passed: violations.length === 0,
    });
  }
}
