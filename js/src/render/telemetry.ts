import type { RenderQualityTier } from "./quality.ts";

export const RENDER_TELEMETRY_CAPACITY = 240;
export const RENDER_SUBMISSION_TELEMETRY_SCHEMA = "limina.three-render-submission/v2";

export interface RendererInfoLike {
  frame?: number;
  render?: { frameCalls?: number; drawCalls?: number; triangles?: number };
  memory?: { textures?: number; geometries?: number; programs?: number; renderTargets?: number; total?: number;
    texturesSize?: number; attributesSize?: number; indexAttributesSize?: number; storageAttributesSize?: number;
    indirectStorageAttributesSize?: number; readbackBuffersSize?: number; programsSize?: number };
  programs?: { length?: number } | null;
}

/**
 * Counters read immediately after one production render. Three's WebGPU backend increments these
 * where it encodes each draw command and multiplies triangle primitives by the draw's submitted
 * instanceCount. The result therefore includes every fixed InstancedMesh slot sent to the GPU,
 * even when the material later rejects that slot in a shader.
 */
export interface RenderSubmissionTelemetry {
  readonly schema: typeof RENDER_SUBMISSION_TELEMETRY_SCHEMA;
  readonly source: "three-webgpu-renderer-info";
  readonly scope: "single-production-frame-all-passes";
  readonly instanceAccounting: "full-draw-instance-count";
  readonly frameId: number;
  readonly renderCalls: number;
  readonly drawCalls: number;
  readonly triangles: number;
}

export const PAIRED_RENDER_SUBMISSION_SCHEMA = "limina.paired-render-submission/v1";
export interface PairedRenderSubmissionTelemetry {
  readonly schema: typeof PAIRED_RENDER_SUBMISSION_SCHEMA;
  readonly basis: "same-process-fixed-camera-time-residency-post-visibility-toggle";
  readonly baseline: Readonly<RenderSubmissionTelemetry>;
  readonly candidate: Readonly<RenderSubmissionTelemetry>;
  readonly delta: Readonly<{ renderCalls: number; drawCalls: number; triangles: number }>;
}

export const RENDER_RESOURCE_TELEMETRY_SCHEMA = "limina.three-render-resources/v1";
export interface RenderResourceTelemetry {
  readonly schema: typeof RENDER_RESOURCE_TELEMETRY_SCHEMA;
  readonly source: "three-webgpu-renderer-info";
  readonly scope: "renderer-live-after-production-frame";
  readonly counts: Readonly<{ textures: number; geometries: number; programs: number; renderTargets: number }>;
  readonly bytes: Readonly<{ total: number; textures: number; attributes: number; indexAttributes: number;
    storageAttributes: number; indirectStorageAttributes: number; readbackBuffers: number; programs: number }>;
}

export interface RenderTelemetrySnapshot {
  samples: number;
  tier: RenderQualityTier;
  backingWidth: number;
  backingHeight: number;
  pixelRatio: number;
  /** fps.p05 is the low-end rate 1000 / frameMs.p95 (the inverted high-frame-time percentile),
   * not an independently ranked fps quantile. */
  fps: Readonly<{ mean: number; p50: number; p05: number; minimum: number }>;
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

function submittedCounter(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`render submission ${label} must be a non-negative safe integer`);
  }
  return value;
}

/** Strict, immutable snapshot for release evidence. Call only after resetting renderer.info and
 * rendering exactly one frame; unlike the live telemetry ring this fails closed on bad counters. */
export function captureRenderSubmissionTelemetry(info: RendererInfoLike | undefined): Readonly<RenderSubmissionTelemetry> {
  const render = info?.render;
  return Object.freeze({
    schema: RENDER_SUBMISSION_TELEMETRY_SCHEMA,
    source: "three-webgpu-renderer-info" as const,
    scope: "single-production-frame-all-passes" as const,
    instanceAccounting: "full-draw-instance-count" as const,
    frameId: submittedCounter(info?.frame, "frameId"),
    renderCalls: submittedCounter(render?.frameCalls, "renderCalls"),
    drawCalls: submittedCounter(render?.drawCalls, "drawCalls"),
    triangles: submittedCounter(render?.triangles, "triangles"),
  });
}

/** Strict renderer-owned resource evidence. These are Three's tracked active allocation bytes and
 * object counts, not process RSS and not a driver-wide VRAM query. No GPU timestamp feature is used. */
export function captureRenderResourceTelemetry(info: RendererInfoLike | undefined): Readonly<RenderResourceTelemetry> {
  const memory = info?.memory;
  return Object.freeze({
    schema: RENDER_RESOURCE_TELEMETRY_SCHEMA,
    source: "three-webgpu-renderer-info" as const,
    scope: "renderer-live-after-production-frame" as const,
    counts: Object.freeze({
      textures: submittedCounter(memory?.textures, "resource textures"),
      geometries: submittedCounter(memory?.geometries, "resource geometries"),
      programs: submittedCounter(memory?.programs ?? info?.programs?.length, "resource programs"),
      renderTargets: submittedCounter(memory?.renderTargets, "resource renderTargets"),
    }),
    bytes: Object.freeze({
      total: submittedCounter(memory?.total, "resource total bytes"),
      textures: submittedCounter(memory?.texturesSize, "resource texture bytes"),
      attributes: submittedCounter(memory?.attributesSize, "resource attribute bytes"),
      indexAttributes: submittedCounter(memory?.indexAttributesSize, "resource index-attribute bytes"),
      storageAttributes: submittedCounter(memory?.storageAttributesSize, "resource storage-attribute bytes"),
      indirectStorageAttributes: submittedCounter(memory?.indirectStorageAttributesSize, "resource indirect-storage-attribute bytes"),
      readbackBuffers: submittedCounter(memory?.readbackBuffersSize, "resource readback-buffer bytes"),
      programs: submittedCounter(memory?.programsSize, "resource program bytes"),
    }),
  });
}

/** Release-evidence guard for a post-processed production frame. A single render/draw/triangle is
 * Three's final fullscreen RenderPipeline pass, not proof that the scene pass ran in this frame. */
export function requireWholeFrameRenderSubmissionTelemetry(
  submission: Readonly<RenderSubmissionTelemetry>,
): Readonly<RenderSubmissionTelemetry> {
  if (submission.frameId < 1 || submission.renderCalls <= 1
      || submission.drawCalls <= 1 || submission.triangles <= 1) {
    throw new Error(`render submission did not count the whole production frame: ${JSON.stringify(submission)}`);
  }
  return submission;
}

/** Accept only adjacent frames from the same fixed camera/time/residency/post sequence. The caller
 * may change subject visibility and nothing else between these snapshots. */
export function requirePairedRenderSubmissionTelemetry(
  baseline: Readonly<RenderSubmissionTelemetry>, candidate: Readonly<RenderSubmissionTelemetry>, expectedRenderCalls?: number,
): Readonly<PairedRenderSubmissionTelemetry> {
  requireWholeFrameRenderSubmissionTelemetry(baseline);
  requireWholeFrameRenderSubmissionTelemetry(candidate);
  if (expectedRenderCalls !== undefined && (!Number.isSafeInteger(expectedRenderCalls) || expectedRenderCalls < 2)) {
    throw new Error("paired render submission expected render-call count must be an integer of at least two");
  }
  if (baseline.renderCalls !== candidate.renderCalls || (expectedRenderCalls !== undefined && baseline.renderCalls !== expectedRenderCalls)) {
    throw new Error(`paired render submission did not preserve render-call scope: baseline=${baseline.renderCalls}, candidate=${candidate.renderCalls}, expected=${expectedRenderCalls ?? "same-as-baseline"}`);
  }
  if (candidate.frameId !== baseline.frameId + 1) throw new Error("paired render submission frames are not adjacent");
  const drawCalls = candidate.drawCalls - baseline.drawCalls;
  const triangles = candidate.triangles - baseline.triangles;
  if (!Number.isSafeInteger(drawCalls) || drawCalls < 0 || !Number.isSafeInteger(triangles) || triangles < 0) {
    throw new Error("paired render submission candidate regressed below its hidden-subject baseline");
  }
  return Object.freeze({ schema: PAIRED_RENDER_SUBMISSION_SCHEMA,
    basis: "same-process-fixed-camera-time-residency-post-visibility-toggle" as const,
    baseline, candidate, delta: Object.freeze({ renderCalls: 0 as const, drawCalls, triangles }) });
}

/** Visibility-paired subject evidence when the subject may own shadow-casting lights. The fixed
 * camera/time/residency/post sequence is preserved, but enabling the subject may legitimately add
 * shadow render passes. Draw and triangle deltas must still prove submitted subject geometry. */
export function requireSubjectPairedRenderSubmissionTelemetry(
  baseline: Readonly<RenderSubmissionTelemetry>, candidate: Readonly<RenderSubmissionTelemetry>,
): Readonly<PairedRenderSubmissionTelemetry> {
  requireWholeFrameRenderSubmissionTelemetry(baseline);
  requireWholeFrameRenderSubmissionTelemetry(candidate);
  if (candidate.frameId !== baseline.frameId + 1) throw new Error("subject-paired submission frames are not adjacent");
  const renderCalls = candidate.renderCalls - baseline.renderCalls;
  const drawCalls = candidate.drawCalls - baseline.drawCalls;
  const triangles = candidate.triangles - baseline.triangles;
  if (!Number.isSafeInteger(renderCalls) || renderCalls < 0
      || !Number.isSafeInteger(drawCalls) || drawCalls < 1
      || !Number.isSafeInteger(triangles) || triangles < 1) {
    throw new Error(`subject-paired submission lacks the required visible-subject cost: ${JSON.stringify({ baseline, candidate,
      delta: { renderCalls, drawCalls, triangles } })}`);
  }
  return Object.freeze({ schema: PAIRED_RENDER_SUBMISSION_SCHEMA,
    basis: "same-process-fixed-camera-time-residency-post-visibility-toggle" as const,
    baseline, candidate, delta: Object.freeze({ renderCalls, drawCalls, triangles }) });
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
    this.#drawCalls[index] = bounded(rendererInfo?.render?.drawCalls, MAX_COUNT);
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
        p05: fpsFromFrame(frame.p95),
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
