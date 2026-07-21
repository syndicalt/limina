import { isNvidiaGpuIdentity } from "./gpu-timestamp-diagnostic.ts";

export const THREE_GPU_TIMESTAMP_CAPTURE_METHOD = "three-r184-webgpu-prefenced-split-resolve-copy-v2";
export const THREE_GPU_TIMESTAMP_CAPTURE_FRAMES = 32;
export const THREE_GPU_TIMESTAMP_SETTLE_MS = 250;

export type ThreeGpuTimestampCapturePhase =
  | "idle"
  | "capturing"
  | "settling"
  | "resolving"
  | "complete"
  | "failed";

interface ThreeTimestampPoolLike {
  frames?: readonly number[];
  timestamps?: ReadonlyMap<string, number>;
}

interface ThreeTimestampBackendLike {
  trackTimestamp: boolean;
  device?: { queue: { onSubmittedWorkDone(): Promise<void> } };
  timestampQueryPool?: { render?: ThreeTimestampPoolLike | null };
}

export interface ThreeTimestampRendererLike {
  backend?: ThreeTimestampBackendLike;
  info?: { frame: number };
  resolveTimestampsAsync?(type?: "render" | "compute"): Promise<number | undefined>;
}

export interface ThreeGpuTimestampCaptureReport {
  status: "available";
  method: typeof THREE_GPU_TIMESTAMP_CAPTURE_METHOD;
  attemptedFrames: number;
  validFrames: number;
  coverage: number;
  routeFrames: readonly number[];
  threeFrameIds: readonly number[];
  sampleMs: readonly number[];
}

/** Reject a hardware path that clean-boot testing proved can hang in delayed pooled resolution. */
export function assertThreeGpuTimestampCapturePlatform(adapterIdentity: string): void {
  if (isNvidiaGpuIdentity(adapterIdentity)) {
    throw new Error("bounded Three GPU timing is disabled on NVIDIA because the prefenced resolve/map path timed out");
  }
}

export class ThreeGpuTimestampCapture {
  readonly #renderer: ThreeTimestampRendererLike;
  readonly #backend: ThreeTimestampBackendLike;
  readonly #captureFrames: number;
  readonly #settleMs: number;
  readonly #maximumFrameGpuMs: number;
  readonly #routeFrames: number[] = [];
  #phase: ThreeGpuTimestampCapturePhase = "idle";
  #renderInFlight = false;

  constructor(
    renderer: ThreeTimestampRendererLike,
    available: boolean,
    options: Readonly<{ captureFrames?: number; settleMs?: number; maximumFrameGpuMs?: number }> = {},
  ) {
    if (!available) throw new Error("Three GPU timestamp capture requires an available timestamp-query device");
    const backend = renderer.backend;
    if (!backend || typeof backend.device?.queue.onSubmittedWorkDone !== "function"
      || !renderer.info || !Number.isSafeInteger(renderer.info.frame)
      || typeof renderer.resolveTimestampsAsync !== "function") {
      throw new Error("Three GPU timestamp capture requires the pinned WebGPU renderer backend");
    }
    this.#captureFrames = options.captureFrames ?? THREE_GPU_TIMESTAMP_CAPTURE_FRAMES;
    this.#settleMs = options.settleMs ?? THREE_GPU_TIMESTAMP_SETTLE_MS;
    this.#maximumFrameGpuMs = options.maximumFrameGpuMs ?? 1_000;
    if (!Number.isSafeInteger(this.#captureFrames) || this.#captureFrames < 1 || this.#captureFrames > 256) {
      throw new RangeError("Three GPU timestamp captureFrames must be in [1, 256]");
    }
    if (!Number.isFinite(this.#settleMs) || this.#settleMs < 0 || this.#settleMs > 10_000) {
      throw new RangeError("Three GPU timestamp settleMs must be in [0, 10000]");
    }
    if (!Number.isFinite(this.#maximumFrameGpuMs) || this.#maximumFrameGpuMs <= 0) {
      throw new RangeError("Three GPU maximumFrameGpuMs must be positive");
    }
    this.#renderer = renderer;
    this.#backend = backend;
  }

  get phase(): ThreeGpuTimestampCapturePhase { return this.#phase; }
  get capturedFrames(): number { return this.#routeFrames.length; }

  start(): void {
    if (this.#phase !== "idle") throw new Error(`Three GPU timestamp capture cannot start from ${this.#phase}`);
    if (this.#backend.trackTimestamp) throw new Error("Three GPU timestamp tracking escaped enabled before capture");
    if (this.#backend.timestampQueryPool?.render != null) throw new Error("Three GPU timestamp capture found a stale render query pool");
    this.#backend.trackTimestamp = true;
    this.#phase = "capturing";
  }

  beforeRendered(routeFrame: number): void {
    if (this.#phase !== "capturing") throw new Error(`Three GPU timestamp frame recorded during ${this.#phase}`);
    if (this.#renderInFlight) throw new Error("Three GPU timestamp capture already has a render in flight");
    if (!Number.isSafeInteger(routeFrame) || routeFrame < 0) throw new RangeError("Three GPU timestamp route frame must be non-negative");
    if (this.#routeFrames.includes(routeFrame)) throw new Error(`Three GPU timestamp route frame ${routeFrame} is duplicated`);
    this.#routeFrames.push(routeFrame);
    // Limina drives renderer.render() from its native frame callback rather than Three's
    // setAnimationLoop(), so Three does not advance info.frame itself. The pinned r184 backend
    // incorporates this value into each timestamp UID; set it explicitly before encoding.
    this.#renderer.info!.frame = routeFrame;
    this.#renderInFlight = true;
  }

  afterRendered(): boolean {
    if (this.#phase !== "capturing") throw new Error(`Three GPU timestamp frame recorded during ${this.#phase}`);
    if (!this.#renderInFlight) throw new Error("Three GPU timestamp capture has no rendered frame to finish");
    this.#renderInFlight = false;
    if (this.#routeFrames.length < this.#captureFrames) return false;
    this.#backend.trackTimestamp = false;
    this.#phase = "settling";
    return true;
  }

  async settleAndResolve(
    wait: (milliseconds: number) => Promise<void>,
    awaitSubmittedWork: () => Promise<void> = () => this.#backend.device!.queue.onSubmittedWorkDone(),
  ): Promise<Readonly<ThreeGpuTimestampCaptureReport>> {
    if (this.#phase !== "settling") throw new Error(`Three GPU timestamp resolve cannot start from ${this.#phase}`);
    try {
      // Wall-clock settling does not prove that prior render submissions completed. Fence the
      // actual queue before issuing a delayed cross-submission query resolve. WebGPU queue order
      // makes this redundant in theory; NVIDIA remains guarded off because its fenced resolve/map
      // still did not complete, while the boundary is validated and inexpensive for bounded Iris.
      await awaitSubmittedWork();
      await wait(this.#settleMs);
      this.#phase = "resolving";
      this.#backend.trackTimestamp = true;
      let pending: Promise<number | undefined>;
      try {
        pending = this.#renderer.resolveTimestampsAsync!("render");
      } finally {
        // Three synchronously encodes/submits before the first await. Keep timestamp writes off
        // while the map promise is pending; the district also pauses render/present in this phase.
        this.#backend.trackTimestamp = false;
      }
      await pending;
      const report = this.#extractReport();
      this.#phase = "complete";
      return report;
    } catch (error) {
      this.#backend.trackTimestamp = false;
      this.#phase = "failed";
      throw error;
    }
  }

  #extractReport(): Readonly<ThreeGpuTimestampCaptureReport> {
    const pool = this.#backend.timestampQueryPool?.render;
    const frames = pool?.frames;
    const timestamps = pool?.timestamps;
    if (!frames || !timestamps) throw new Error("Three GPU timestamp resolution did not expose the pinned render pool");
    if (frames.length !== this.#captureFrames || new Set(frames).size !== this.#captureFrames) {
      throw new Error(`Three GPU timestamp capture resolved ${frames.length}/${this.#captureFrames} unique frame ids`);
    }

    const frameSet = new Set(frames);
    const sums = new Map<number, number>();
    const counts = new Map<number, number>();
    for (const [uid, duration] of timestamps) {
      const match = /:f([0-9]+)$/.exec(uid);
      if (!match) continue;
      const frame = Number(match[1]);
      if (!frameSet.has(frame)) continue;
      // Equal begin/end timestamps are valid for work below the adapter's timestamp period.
      if (!Number.isFinite(duration) || duration < 0 || duration > this.#maximumFrameGpuMs) {
        throw new Error(`Three GPU timestamp frame ${frame} contains invalid duration ${duration}`);
      }
      sums.set(frame, (sums.get(frame) ?? 0) + duration);
      counts.set(frame, (counts.get(frame) ?? 0) + 1);
    }

    const sampleMs = frames.map((frame) => {
      if ((counts.get(frame) ?? 0) < 1) throw new Error(`Three GPU timestamp frame ${frame} has no valid query samples`);
      const value = sums.get(frame)!;
      if (!Number.isFinite(value) || value < 0 || value > this.#maximumFrameGpuMs) {
        throw new Error(`Three GPU timestamp frame ${frame} aggregate is invalid: ${value}`);
      }
      return value;
    });

    return Object.freeze({
      status: "available",
      method: THREE_GPU_TIMESTAMP_CAPTURE_METHOD,
      attemptedFrames: this.#captureFrames,
      validFrames: sampleMs.length,
      coverage: sampleMs.length / this.#captureFrames,
      routeFrames: Object.freeze([...this.#routeFrames]),
      threeFrameIds: Object.freeze([...frames]),
      sampleMs: Object.freeze(sampleMs),
    });
  }
}
