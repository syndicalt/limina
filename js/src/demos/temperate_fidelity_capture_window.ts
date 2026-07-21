import * as THREE from "../../build/three.bundle.mjs";
import { createEngine, ops } from "../engine.ts";
import { isSoftwareAdapter } from "../render/fidelity-benchmark.ts";
import { withFrozenRendererTime } from "../render/frozen-render-time.ts";
import { readNativeSurfaceRgba, withPresentedNativeSurfaceFrame } from "../render/native-surface-readback.ts";
import {
  captureRenderSubmissionTelemetry,
  requireWholeFrameRenderSubmissionTelemetry,
  type RendererInfoLike,
} from "../render/telemetry.ts";
import {
  loadTemperateFidelityCandidate,
  mountTemperateFidelityScene,
  temperateFidelityCaptureSchedule,
  type TemperateFidelityResourceReader,
  type TemperateFidelityStage,
} from "../render/temperate-fidelity-scene.ts";
import { portableAssetContentHash } from "../world/asset-content-hash.mjs";

const TRACE_NAME = "temperate-fidelity-native-capture.json";
const SHOT = "river-leading-line";

function bytesToBase64(bytes: Uint8Array): string {
  const chunkSize = 32_768;
  let binary = "";
  for (let offset = 0; offset < bytes.byteLength; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, Math.min(offset + chunkSize, bytes.byteLength)));
  }
  return btoa(binary);
}

const decoder = new TextDecoder("utf-8", { fatal: true });
const reader: TemperateFidelityResourceReader = {
  readJson: async (path) => JSON.parse(decoder.decode(ops.op_read_asset(path))),
  readBytes: async (path) => ops.op_read_asset(path),
};

const startedAt = performance.now();
let stageStartedAt = startedAt;
const timingsMs: Record<string, number> = {};
const finishStage = (stage: TemperateFidelityStage | "rendererInit" | "warmupAndReadback"): void => {
  const now = performance.now();
  timingsMs[stage] = Number((now - stageStartedAt).toFixed(2));
  stageStartedAt = now;
};

const loaded = await loadTemperateFidelityCandidate({ reader, shot: SHOT, stageComplete: finishStage });
const [minimumWidth, minimumHeight] = loaded.sceneAuthority.presentation.minimumResolution as [number, number];
const schedule = temperateFidelityCaptureSchedule(loaded.sceneAuthority);
const engine = await createEngine({ width: minimumWidth, height: minimumHeight, gpuTimestampMode: "disabled", renderBaseline: false });
finishStage("rendererInit");
const scene = engine.scene as THREE.Scene;
const camera = engine.camera as THREE.PerspectiveCamera;
const renderer = engine.renderer as unknown as THREE.WebGPURenderer;
let mounted: Awaited<ReturnType<typeof mountTemperateFidelityScene>> | undefined;
try {
  // Renderer ownership begins at createEngine, so adapter rejection and scene-mount failure must
  // remain inside the same terminal finally as successful capture.
  if (isSoftwareAdapter(engine.gpuAdapter)) {
    throw new Error(`native fidelity capture resolved a software adapter: ${JSON.stringify(engine.gpuAdapter)}`);
  }
  // This capture owns its frame boundary. Disable Three's animation-loop reset so every scene,
  // shadow, and post-processing pass remains in the one manually-reset submission population.
  renderer.info.autoReset = false;
  mounted = await mountTemperateFidelityScene({
    loaded,
    renderer,
    scene,
    camera,
    ops,
    width: engine.width,
    height: engine.height,
    stageComplete: finishStage,
  });
  const captured = await withFrozenRendererTime(renderer, schedule.fixedTimeSeconds, async (beginFrame) => {
    for (let frame = 0; frame < schedule.warmupFrames; frame++) {
      for (const lod of mounted.world.lods ?? []) (lod as { update(camera: unknown): void }).update(camera);
      beginFrame();
      await withPresentedNativeSurfaceFrame(
        () => ops.op_surface_present(engine.context),
        () => mounted.post.render(),
      );
    }
    for (const lod of mounted.world.lods ?? []) (lod as { update(camera: unknown): void }).update(camera);
    return withPresentedNativeSurfaceFrame(
      () => ops.op_surface_present(engine.context),
      async () => {
        renderer.info.reset();
        beginFrame();
        const encodeStartedAt = performance.now();
        mounted.post.render();
        const cpuEncodeMs = Number((performance.now() - encodeStartedAt).toFixed(3));
        const submission = requireWholeFrameRenderSubmissionTelemetry(
          captureRenderSubmissionTelemetry(renderer.info as unknown as RendererInfoLike),
        );
        const readback = await readNativeSurfaceRgba({
          device: engine.device as never,
          context: engine.context as never,
          minimumWidth,
          minimumHeight,
        });
        return Object.freeze({ readback, submission, cpuEncodeMs });
      },
    );
  });
  const { readback, submission, cpuEncodeMs } = captured;
  finishStage("warmupAndReadback");
  timingsMs.total = Number((performance.now() - startedAt).toFixed(2));
  const authoritySemanticHash = portableAssetContentHash(new TextEncoder().encode(JSON.stringify(loaded.sceneAuthority)));
  const rgbaContentHash = portableAssetContentHash(readback.rgba);
  const artifact = Object.freeze({
    schema: "limina.temperate-fidelity-native-capture/v2",
    shot: SHOT,
    backend: "native-webgpu",
    adapter: engine.gpuAdapter,
    width: readback.width,
    height: readback.height,
    surfaceFormat: readback.format,
    pixelFormat: "rgba8unorm",
    rowOrigin: "top-left",
    fixedTimeSeconds: schedule.fixedTimeSeconds,
    warmupFrames: schedule.warmupFrames,
    manifestHash: mounted.metadata.manifestHash,
    authoritySemanticHash,
    scene: mounted.metadata,
    rgbaContentHash,
    rgbaByteLength: readback.rgba.byteLength,
    rgbaBase64: bytesToBase64(readback.rgba),
    renderSubmission: Object.freeze({ ...submission, cpuEncodeMs }),
    timingsMs: Object.freeze({ ...timingsMs }),
  });
  ops.op_write_trace(TRACE_NAME, `${JSON.stringify(artifact)}\n`);
  ops.op_log(`native fidelity capture wrote ${TRACE_NAME} (${readback.width}x${readback.height}, ${rgbaContentHash})`);
} finally {
  await mounted?.dispose();
  engine.disposeRenderBaseline();
  await (renderer as unknown as { dispose(): Promise<void> | void }).dispose();
}
