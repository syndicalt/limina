import * as THREE from "../../build/three.bundle.mjs";
import { createEngine, ops } from "../engine.ts";
import { renderSyncSystem } from "../ecs/world.ts";
import { isSoftwareAdapter } from "../render/fidelity-benchmark.ts";
import { withFrozenRendererTime } from "../render/frozen-render-time.ts";
import { readNativeSurfaceRgba, withPresentedNativeSurfaceFrame } from "../render/native-surface-readback.ts";
import {
  mountBuildingCompositionReview,
  validateBuildingCompositionReviewAuthority,
  verifyBuildingCompositionReviewClosure,
} from "../render/building-composition-review-scene.ts";
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

const TRACE_NAME = "building-composition-native-capture.json",
  AUTHORITY_PATH = ops.op_read_env("LIMINA_BUILDING_COMPOSITION_REVIEW_AUTHORITY");
if (!AUTHORITY_PATH) throw new Error("LIMINA_BUILDING_COMPOSITION_REVIEW_AUTHORITY is required");
const decoder = new TextDecoder("utf-8", { fatal: true }),
  authorityBytes = ops.op_read_asset(AUTHORITY_PATH),
  authority = validateBuildingCompositionReviewAuthority(JSON.parse(decoder.decode(authorityBytes)));
verifyBuildingCompositionReviewClosure(authority, (path) => ops.op_read_asset(path));
const sourcePaths = [
    "js/src/render/building-composition-review-scene.ts",
    "js/src/demos/building_composition_capture_window.ts",
    "tools/preview/run-native-building-composition-capture.mjs",
  ] as const,
  source = Object.freeze(
    sourcePaths.map((path) => {
      const bytes = ops.op_read_asset(path);
      return Object.freeze({ path, sha256: `sha256:${sha256(bytes)}`, contentHash: portableAssetContentHash(bytes) });
    }),
  ),
  [width, height] = authority.presentation.minimumResolution,
  toBase64 = (bytes: Uint8Array) => {
    let value = "";
    for (let offset = 0; offset < bytes.length; offset += 32768)
      value += String.fromCharCode(...bytes.subarray(offset, Math.min(offset + 32768, bytes.length)));
    return btoa(value);
  };
const engine = await createEngine({
    width,
    height,
    gpuTimestampMode: "disabled",
    gpuTextureCompression: "bc-required",
    renderBaseline: false,
  }),
  renderer = engine.renderer as unknown as THREE.WebGPURenderer;
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
  } as WorldContext,
  scene = engine.scene as THREE.Scene;
scene.background = new THREE.Color(0x8f9ba4);
const ambient = new THREE.HemisphereLight(0xfff4df, 0x293039, 1.35),
  key = new THREE.DirectionalLight(0xffe4bd, 2.5);
key.position.set(-3, 8, -4);
key.castShadow = true;
key.shadow.mapSize.set(2048, 2048);
const fill = new THREE.DirectionalLight(0xb9d7ff, 0.85);
fill.position.set(5, 4, 3);
scene.add(ambient, key, fill);
let mounted: Awaited<ReturnType<typeof mountBuildingCompositionReview>> | undefined, failure: unknown;
try {
  if (isSoftwareAdapter(engine.gpuAdapter))
    throw new Error(`C1 production review resolved a software adapter: ${JSON.stringify(engine.gpuAdapter)}`);
  ops.op_physics_create_world(0);
  const baselineEntities = world.entities.ids().length;
  mounted = await mountBuildingCompositionReview(world, authority);
  renderSyncSystem(world.ecs);
  const mountedEvidence = {
      inventory: mounted.inventory,
      instanceIds: mounted.furniture.map((entry) => entry.instanceId),
    },
    camera = engine.camera as THREE.PerspectiveCamera,
    render = async (beginFrame: () => void) => {
      beginFrame();
      await withPresentedNativeSurfaceFrame(
        () => ops.op_surface_present(engine.context),
        () => renderer.render(scene, camera),
      );
    };
  const captures = await withFrozenRendererTime(
    renderer,
    authority.presentation.fixedTimeSeconds,
    async (beginFrame) => {
      const output = [];
      for (let index = 0; index < authority.evidenceViews.length; index++) {
        const view = authority.evidenceViews[index];
        camera.fov = view.fovDeg;
        camera.near = view.near;
        camera.far = view.far;
        camera.position.set(...view.position);
        camera.lookAt(...view.target);
        camera.updateProjectionMatrix();
        camera.updateMatrixWorld(true);
        for (let frame = 0; frame < (index === 0 ? authority.presentation.warmupFrames : 2); frame++)
          await render(beginFrame);
        mounted!.setFurnitureVisible(false);
        let baseline;
        try {
          baseline = await withPresentedNativeSurfaceFrame(
            () => ops.op_surface_present(engine.context),
            () => {
              renderer.info.reset();
              beginFrame();
              renderer.render(scene, camera);
              return requireWholeFrameRenderSubmissionTelemetry(
                captureRenderSubmissionTelemetry(renderer.info as unknown as RendererInfoLike),
              );
            },
          );
        } finally {
          mounted!.setFurnitureVisible(true);
        }
        const captured = await withPresentedNativeSurfaceFrame(
          () => ops.op_surface_present(engine.context),
          async () => {
            renderer.info.reset();
            beginFrame();
            const started = performance.now();
            renderer.render(scene, camera);
            const cpuEncodeMs = Number((performance.now() - started).toFixed(3)),
              submission = requireWholeFrameRenderSubmissionTelemetry(
                captureRenderSubmissionTelemetry(renderer.info as unknown as RendererInfoLike),
              ),
              paired = requirePairedRenderSubmissionTelemetry(baseline, submission),
              resources = captureRenderResourceTelemetry(renderer.info as unknown as RendererInfoLike),
              pixels = await readNativeSurfaceRgba({
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
          camera: view,
          width: captured.pixels.width,
          height: captured.pixels.height,
          surfaceFormat: captured.pixels.format,
          rgbaByteLength: captured.pixels.rgba.byteLength,
          rgbaContentHash: portableAssetContentHash(captured.pixels.rgba),
          rgbaBase64: toBase64(captured.pixels.rgba),
          renderSubmission: { ...captured.submission, cpuEncodeMs: captured.cpuEncodeMs },
          pairedRenderSubmission: captured.paired,
          rendererResources: captured.resources,
        });
      }
      return output;
    },
  );
  await mounted.dispose();
  mounted = undefined;
  const afterDisposeEntities = world.entities.ids().length;
  if (afterDisposeEntities !== baselineEntities)
    throw new Error(`C1 review lifecycle leaked entities: ${baselineEntities} -> ${afterDisposeEntities}`);
  ops.op_write_trace(
    TRACE_NAME,
    JSON.stringify({
      schema: "limina.building-composition-native-review-set/v1",
      backend: "native-webgpu",
      captureClass: "production-engine",
      surfaceFormat: captures[0].surfaceFormat,
      pixelFormat: "rgba8unorm",
      rowOrigin: "top-left",
      timingPolicy: { gpuTimestampMode: "disabled", timestampQueriesEnabled: false },
      adapter: engine.gpuAdapter,
      authority: {
        path: AUTHORITY_PATH,
        sha256: `sha256:${sha256(authorityBytes)}`,
        contentHash: portableAssetContentHash(authorityBytes),
      },
      source,
      manifest: authority.manifest,
      functionalEvidence: authority.functionalEvidence,
      integratedSource: authority.integratedSource,
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
  scene.remove(ambient, key, fill);
  try {
    await gltfCache.dispose();
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
      "C1 capture teardown failed",
    );
}
if (failure !== undefined) throw failure;
