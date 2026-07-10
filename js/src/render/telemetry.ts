import type { RenderQualityTier } from "./quality.ts";

export const RENDER_TELEMETRY_CAPACITY = 240;

export interface RendererInfoLike {
  render?: { calls?: number; triangles?: number };
  memory?: { textures?: number; geometries?: number; programs?: number; renderTargets?: number; total?: number };
  programs?: { length?: number } | null;
}

export interface RenderTelemetrySnapshot {
  samples: number;
  tier: RenderQualityTier;
  backingWidth: number;
  backingHeight: number;
  pixelRatio: number;
  fps: Readonly<{ mean: number; p50: number; p95: number; minimum: number }>;
  frameMs: Readonly<{ mean: number; p50: number; p95: number; maximum: number }>;
  submitMs: Readonly<{ mean: number; p50: number; p95: number; maximum: number }>;
  render: Readonly<{ drawCalls: number; triangles: number }>;
  memory: Readonly<{ textures: number; geometries: number; programs: number; renderTargets: number; total: number }>;
}

const TIER_CODE: Record<RenderQualityTier, number> = { performance: 0, balanced: 1, cinematic: 2 };
const CODE_TIER: readonly RenderQualityTier[] = ["performance", "balanced", "cinematic"];
const MAX_DURATION_MS = 60_000;
const MAX_COUNT = 0xffff_ffff;
const MAX_TRIANGLES = Number.MAX_SAFE_INTEGER;

function bounded(value: unknown, maximum: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.min(value, maximum) : 0;
}

function quantile(sorted: Float64Array, fraction: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.max(0, Math.min(sorted.length - 1, Math.ceil(fraction * sorted.length) - 1));
  return sorted[index];
}

function stats(source: Float32Array, count: number, cursor: number): { mean: number; p50: number; p95: number; maximum: number } {
  const values = new Float64Array(count);
  let sum = 0;
  let maximum = 0;
  const start = count === RENDER_TELEMETRY_CAPACITY ? cursor : 0;
  for (let index = 0; index < count; index++) {
    const value = source[(start + index) % RENDER_TELEMETRY_CAPACITY];
    values[index] = value;
    sum += value;
    maximum = Math.max(maximum, value);
  }
  values.sort();
  return { mean: count === 0 ? 0 : sum / count, p50: quantile(values, 0.5), p95: quantile(values, 0.95), maximum };
}

export class RenderTelemetryRing {
  readonly capacity = RENDER_TELEMETRY_CAPACITY;
  #frameMs = new Float32Array(RENDER_TELEMETRY_CAPACITY);
  #submitMs = new Float32Array(RENDER_TELEMETRY_CAPACITY);
  #drawCalls = new Uint32Array(RENDER_TELEMETRY_CAPACITY);
  #triangles = new Float64Array(RENDER_TELEMETRY_CAPACITY);
  #textures = new Uint32Array(RENDER_TELEMETRY_CAPACITY);
  #geometries = new Uint32Array(RENDER_TELEMETRY_CAPACITY);
  #programs = new Uint32Array(RENDER_TELEMETRY_CAPACITY);
  #renderTargets = new Uint32Array(RENDER_TELEMETRY_CAPACITY);
  #totalMemory = new Float64Array(RENDER_TELEMETRY_CAPACITY);
  #width = new Uint32Array(RENDER_TELEMETRY_CAPACITY);
  #height = new Uint32Array(RENDER_TELEMETRY_CAPACITY);
  #pixelRatio = new Float32Array(RENDER_TELEMETRY_CAPACITY);
  #tier = new Uint8Array(RENDER_TELEMETRY_CAPACITY);
  #cursor = 0;
  #count = 0;

  get size(): number { return this.#count; }

  clear(): void {
    this.#cursor = 0;
    this.#count = 0;
  }

  record(
    frameDeltaMs: number,
    submitDurationMs: number,
    rendererInfo: RendererInfoLike | undefined,
    backingWidth: number,
    backingHeight: number,
    pixelRatio: number,
    tier: RenderQualityTier,
  ): void {
    const index = this.#cursor;
    const memory = rendererInfo?.memory;
    this.#frameMs[index] = bounded(frameDeltaMs, MAX_DURATION_MS);
    this.#submitMs[index] = bounded(submitDurationMs, MAX_DURATION_MS);
    this.#drawCalls[index] = bounded(rendererInfo?.render?.calls, MAX_COUNT);
    this.#triangles[index] = bounded(rendererInfo?.render?.triangles, MAX_TRIANGLES);
    this.#textures[index] = bounded(memory?.textures, MAX_COUNT);
    this.#geometries[index] = bounded(memory?.geometries, MAX_COUNT);
    this.#programs[index] = bounded(memory?.programs ?? rendererInfo?.programs?.length, MAX_COUNT);
    this.#renderTargets[index] = bounded(memory?.renderTargets, MAX_COUNT);
    this.#totalMemory[index] = bounded(memory?.total, Number.MAX_SAFE_INTEGER);
    this.#width[index] = bounded(backingWidth, MAX_COUNT);
    this.#height[index] = bounded(backingHeight, MAX_COUNT);
    this.#pixelRatio[index] = bounded(pixelRatio, 16);
    this.#tier[index] = TIER_CODE[tier] ?? TIER_CODE.balanced;
    this.#cursor = (index + 1) % RENDER_TELEMETRY_CAPACITY;
    this.#count = Math.min(RENDER_TELEMETRY_CAPACITY, this.#count + 1);
  }

  snapshot(): Readonly<RenderTelemetrySnapshot> {
    const count = this.#count;
    const latest = count === 0 ? 0 : (this.#cursor + RENDER_TELEMETRY_CAPACITY - 1) % RENDER_TELEMETRY_CAPACITY;
    const frame = stats(this.#frameMs, count, this.#cursor);
    const submit = stats(this.#submitMs, count, this.#cursor);
    const fpsFromFrame = (milliseconds: number): number => milliseconds > 0 ? 1000 / milliseconds : 0;
    return Object.freeze({
      samples: count,
      tier: CODE_TIER[this.#tier[latest]] ?? "balanced",
      backingWidth: this.#width[latest],
      backingHeight: this.#height[latest],
      pixelRatio: this.#pixelRatio[latest],
      fps: Object.freeze({
        mean: fpsFromFrame(frame.mean),
        p50: fpsFromFrame(frame.p50),
        p95: fpsFromFrame(frame.p95),
        minimum: fpsFromFrame(frame.maximum),
      }),
      frameMs: Object.freeze(frame),
      submitMs: Object.freeze(submit),
      render: Object.freeze({ drawCalls: this.#drawCalls[latest], triangles: this.#triangles[latest] }),
      memory: Object.freeze({
        textures: this.#textures[latest],
        geometries: this.#geometries[latest],
        programs: this.#programs[latest],
        renderTargets: this.#renderTargets[latest],
        total: this.#totalMemory[latest],
      }),
    });
  }
}
