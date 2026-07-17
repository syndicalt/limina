/** Capture-only control over Three's renderer-owned NodeFrame clock.
 *
 * TSL's shared `time` node reads `NodeFrame.time`. Fixed host frame counts are not
 * sufficient for pixel determinism because Three normally advances that clock from
 * `performance.now()`. Capture freezes elapsed and delta time while still advancing
 * `frameId`, preserving FRAME-scoped node update semantics.
 */

interface ThreeNodeFrameLike {
  frameId: number;
  time: number;
  deltaTime: number;
  update(): void;
}

interface ThreeRendererWithNodeFrame {
  _nodes?: { nodeFrame?: ThreeNodeFrameLike };
  info?: { frame?: number };
}

function rendererFrameState(renderer: unknown): Readonly<{
  frame: ThreeNodeFrameLike;
  info: { frame?: number };
}> {
  const candidate = renderer as ThreeRendererWithNodeFrame;
  const frame = candidate._nodes?.nodeFrame;
  if (frame === undefined || typeof frame.update !== "function") {
    throw new Error("renderer does not expose an initialized Three NodeFrame");
  }
  if (candidate.info === undefined || typeof candidate.info !== "object") {
    throw new Error("renderer does not expose initialized Three frame info");
  }
  return { frame, info: candidate.info };
}

export type BeginFrozenRendererFrame = () => number;

/** Run warmup and capture work at one authored TSL time, restoring Three afterward.
 * The scoped callback establishes each manually driven Three frame exactly as Animation does:
 * advance NodeFrame first, then publish that frame identity through renderer.info. */
export async function withFrozenRendererTime<T>(
  renderer: unknown,
  fixedSeconds: number,
  operation: (beginFrame: BeginFrozenRendererFrame) => T | Promise<T>,
): Promise<T> {
  if (!Number.isFinite(fixedSeconds) || fixedSeconds < 0) {
    throw new RangeError("fixed renderer time must be finite and nonnegative");
  }
  const { frame, info } = rendererFrameState(renderer);
  const originalUpdate = frame.update;
  let active = true;
  frame.update = function frozenNodeFrameUpdate(): void {
    this.frameId++;
    this.deltaTime = 0;
    this.time = fixedSeconds;
  };
  const beginFrame = (): number => {
    if (!active) throw new Error("frozen renderer frame boundary escaped its capture scope");
    frame.update();
    info.frame = frame.frameId;
    return frame.frameId;
  };
  try {
    return await operation(beginFrame);
  } finally {
    active = false;
    frame.update = originalUpdate;
  }
}
