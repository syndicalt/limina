import * as THREE from "../../build/three.bundle.mjs";
import { createEngine, ops } from "../engine.ts";
import { renderSyncSystem } from "../ecs/world.ts";
import { isSoftwareAdapter } from "../render/fidelity-benchmark.ts";
import { withFrozenRendererTime } from "../render/frozen-render-time.ts";
import {
  mountStagedMaterialReview,
  validateStagedMaterialReviewAuthority,
  verifyStagedMaterialReviewClosure,
} from "../render/staged-material-review-scene.ts";
import { readNativeSurfaceRgba, withPresentedNativeSurfaceFrame } from "../render/native-surface-readback.ts";
import {
  captureRenderResourceTelemetry,
  captureRenderSubmissionTelemetry,
  requirePairedRenderSubmissionTelemetry,
  requireWholeFrameRenderSubmissionTelemetry,
  type RendererInfoLike,
} from "../render/telemetry.ts";
import { portableAssetContentHash } from "../world/asset-content-hash.mjs";
import { sha256 } from "../world/sha256.mjs";
import { GltfSceneCache } from "../skills/three.ts";
import type { WorldContext } from "../skills/registry.ts";

const TRACE_NAME = "staged-material-native-capture.json",
  DEFAULT_AUTHORITY_PATH = "assets/buildings/authoring/functional-hall-house-v4/material-review-authority.json";
const AUTHORITY_PATH = ops.op_read_env("LIMINA_STAGED_MATERIAL_AUTHORITY") || DEFAULT_AUTHORITY_PATH;
const decoder = new TextDecoder("utf-8", { fatal: true }),
  authorityBytes = ops.op_read_asset(AUTHORITY_PATH),
  authority = validateStagedMaterialReviewAuthority(JSON.parse(decoder.decode(authorityBytes)));
// Fail closed on every CPU-verifiable identity before touching the adapter or renderer.
verifyStagedMaterialReviewClosure(authority, (path) => ops.op_read_asset(path));
const [width, height] = authority.presentation.minimumResolution;
const engine = await createEngine({
  width,
  height,
  gpuTimestampMode: "disabled",
  gpuTextureCompression: "bc-required",
  renderBaseline: false,
});
if (isSoftwareAdapter(engine.gpuAdapter))
  throw new Error(`M1 production review resolved a software adapter: ${JSON.stringify(engine.gpuAdapter)}`);
const renderer = engine.renderer as unknown as THREE.WebGPURenderer;
renderer.info.autoReset = false;
const gltfCache = new GltfSceneCache({
  ktx2TranscoderPath: "/runtime/basis/",
  ktx2TranscoderBytes: {
    js: ops.op_read_asset("runtime/basis/basis_transcoder.js"),
    wasm: ops.op_read_asset("runtime/basis/basis_transcoder.wasm"),
  },
});
gltfCache.configureKtx2(renderer);
const world = {
  ecs: engine.world,
  entities: engine.entities,
  tags: engine.tags,
  transforms: engine.transforms,
  spatial: engine.spatial,
  scene: engine.scene,
  camera: engine.camera,
  renderer: engine.renderer,
  gltfCache,
  ops: engine.ops,
  width: engine.width,
  height: engine.height,
  mode: engine.mode,
} as WorldContext;
const b64 = (bytes: Uint8Array) => {
  let out = "";
  for (let i = 0; i < bytes.length; i += 32768)
    out += String.fromCharCode(...bytes.subarray(i, Math.min(i + 32768, bytes.length)));
  return btoa(out);
};
let mounted: Awaited<ReturnType<typeof mountStagedMaterialReview>> | undefined, failure: unknown;
try {
  ops.op_physics_create_world(0);
  const baselineEntities = world.entities.ids().length;
  mounted = await mountStagedMaterialReview(world, authority);
  renderSyncSystem(world.ecs);
  const camera = engine.camera as THREE.PerspectiveCamera;
  const captures = await withFrozenRendererTime(
    renderer,
    authority.presentation.fixedTimeSeconds,
    async (beginFrame) => {
      const output = [];
      for (let index = 0; index < authority.evidenceViews.length; index++) {
        const view = authority.evidenceViews[index],
          c = view.camera;
        mounted!.setViewSubject(view.subject);
        camera.fov = c.fovDeg;
        camera.near = c.near;
        camera.far = c.far;
        camera.position.set(...c.position);
        camera.lookAt(...c.target);
        camera.updateProjectionMatrix();
        camera.updateMatrixWorld(true);
        for (let frame = 0; frame < (index === 0 ? authority.presentation.warmupFrames : 2); frame++) {
          beginFrame();
          await withPresentedNativeSurfaceFrame(
            () => ops.op_surface_present(engine.context),
            () => renderer.render(engine.scene, engine.camera),
          );
        }
        mounted!.setCurrentSubjectVisible(false);
        let baseline;
        try {
          baseline = await withPresentedNativeSurfaceFrame(
            () => ops.op_surface_present(engine.context),
            () => {
              renderer.info.reset();
              beginFrame();
              renderer.render(engine.scene, engine.camera);
              return requireWholeFrameRenderSubmissionTelemetry(
                captureRenderSubmissionTelemetry(renderer.info as unknown as RendererInfoLike),
              );
            },
          );
        } finally {
          mounted!.setCurrentSubjectVisible(true);
        }
        const captured = await withPresentedNativeSurfaceFrame(
          () => ops.op_surface_present(engine.context),
          async () => {
            renderer.info.reset();
            beginFrame();
            const started = performance.now();
            renderer.render(engine.scene, engine.camera);
            const cpuEncodeMs = Number((performance.now() - started).toFixed(3));
            const submission = requireWholeFrameRenderSubmissionTelemetry(
              captureRenderSubmissionTelemetry(renderer.info as unknown as RendererInfoLike),
            );
            const paired = requirePairedRenderSubmissionTelemetry(baseline, submission);
            const resources = captureRenderResourceTelemetry(renderer.info as unknown as RendererInfoLike);
            const pixels = await readNativeSurfaceRgba({
              device: engine.device as never,
              context: engine.context as never,
              expectedWidth: width,
              expectedHeight: height,
              minimumWidth: width,
              minimumHeight: height,
            });
            return { cpuEncodeMs, submission, paired, resources, pixels };
          },
        );
        output.push({
          id: view.id,
          role: view.role,
          subject: view.subject,
          camera: view.camera,
          width: captured.pixels.width,
          height: captured.pixels.height,
          surfaceFormat: captured.pixels.format,
          rgbaByteLength: captured.pixels.rgba.byteLength,
          rgbaContentHash: portableAssetContentHash(captured.pixels.rgba),
          rgbaBase64: b64(captured.pixels.rgba),
          renderSubmission: { ...captured.submission, cpuEncodeMs: captured.cpuEncodeMs },
          pairedRenderSubmission: captured.paired,
          rendererResources: captured.resources,
        });
      }
      return output;
    },
  );
  const mountedEvidence = {
    entity: mounted.entity,
    packSwatches: mounted.packSwatches,
    simpleSwatches: mounted.simpleSwatches,
    stageEntities: [...mounted.stageEntities],
  };
  await mounted.dispose();
  mounted = undefined;
  const afterDisposeEntities = world.entities.ids().length;
  if (afterDisposeEntities !== baselineEntities)
    throw new Error(`M1 review lifecycle leaked entities: ${baselineEntities} -> ${afterDisposeEntities}`);
  ops.op_write_trace(
    TRACE_NAME,
    JSON.stringify({
      schema: "limina.staged-material-native-review-set/v1",
      backend: "native-webgpu",
      captureClass: "production-engine",
      surfaceFormat: captures[0].surfaceFormat,
      pixelFormat: "rgba8unorm",
      rowOrigin: "top-left",
      timingPolicy: { gpuTimestampMode: "disabled", timestampQueriesEnabled: false },
      studio: { neutral: true, fixedTimeSeconds: authority.presentation.fixedTimeSeconds },
      adapter: engine.gpuAdapter,
      authority: {
        path: AUTHORITY_PATH,
        sha256: `sha256:${sha256(authorityBytes)}`,
        contentHash: portableAssetContentHash(authorityBytes),
      },
      approvedShell: authority.approvedShell,
      paletteLock: authority.paletteLock,
      derived: authority.derived,
      stageArtifact: authority.stageArtifact,
      mounted: mountedEvidence,
      lifecycle: { baselineEntities, afterDisposeEntities },
      captures,
    }) + "\n",
  );
} catch (error) {
  failure = error;
} finally {
  const failures: unknown[] = [];
  try {
    await mounted?.dispose();
  } catch (error) {
    failures.push(error);
  }
  try {
    gltfCache.dispose();
  } catch (error) {
    failures.push(error);
  }
  try {
    engine.disposeRenderBaseline();
  } catch (error) {
    failures.push(error);
  }
  try {
    await renderer.dispose();
  } catch (error) {
    failures.push(error);
  }
  if (failures.length)
    failure = new AggregateError(
      failure === undefined ? failures : [failure, ...failures],
      "M1 capture teardown failed",
    );
}
if (failure !== undefined) throw failure;
