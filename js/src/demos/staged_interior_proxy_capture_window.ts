import * as THREE from "../../build/three.bundle.mjs";
import { createEngine, ops } from "../engine.ts";
import { renderSyncSystem } from "../ecs/world.ts";
import { isSoftwareAdapter } from "../render/fidelity-benchmark.ts";
import { withFrozenRendererTime } from "../render/frozen-render-time.ts";
import { readNativeSurfaceRgba, withPresentedNativeSurfaceFrame } from "../render/native-surface-readback.ts";
import {
  mountStagedInteriorProxyReview,
  validateStagedInteriorProxyReviewAuthority,
  verifyStagedInteriorProxyReviewClosure,
} from "../render/staged-interior-proxy-review-scene.ts";
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

const TRACE_NAME = "staged-interior-proxy-native-capture.json";
const DEFAULT_AUTHORITY_PATH =
  "assets/buildings/authoring/functional-hall-house-v4/interior-r1/interior-review-authority.json";
const AUTHORITY_PATH = ops.op_read_env("LIMINA_STAGED_INTERIOR_PROXY_AUTHORITY") || DEFAULT_AUTHORITY_PATH;
const decoder = new TextDecoder("utf-8", { fatal: true });
const authorityBytes = ops.op_read_asset(AUTHORITY_PATH);
const authority = validateStagedInteriorProxyReviewAuthority(JSON.parse(decoder.decode(authorityBytes)));
// Close the approved A1/M1-derived-shell/I1 graph before adapter or renderer initialization.
verifyStagedInteriorProxyReviewClosure(authority, (path) => ops.op_read_asset(path));
const sourcePaths = [
  "js/src/render/staged-interior-proxy-review-scene.ts",
  "js/src/demos/staged_interior_proxy_capture_window.ts",
  "tools/preview/run-native-staged-interior-proxy-capture.mjs",
] as const;
const source = Object.freeze(
  sourcePaths.map((path) => {
    const bytes = ops.op_read_asset(path);
    return Object.freeze({ path, sha256: `sha256:${sha256(bytes)}`, contentHash: portableAssetContentHash(bytes) });
  }),
);
const [width, height] = authority.presentation.minimumResolution;
const toBase64 = (bytes: Uint8Array): string => {
  let value = "";
  for (let offset = 0; offset < bytes.length; offset += 32_768)
    value += String.fromCharCode(...bytes.subarray(offset, Math.min(offset + 32_768, bytes.length)));
  return btoa(value);
};

const engine = await createEngine({
  width,
  height,
  gpuTimestampMode: "disabled",
  gpuTextureCompression: "bc-required",
  renderBaseline: false,
});
const renderer = engine.renderer as unknown as THREE.WebGPURenderer;
renderer.info.autoReset = false;
const gltfCache = new GltfSceneCache({
  ktx2TranscoderPath: "/runtime/basis/",
  ktx2TranscoderBytes: {
    js: ops.op_read_asset("runtime/basis/basis_transcoder.js"),
    wasm: ops.op_read_asset("runtime/basis/basis_transcoder.wasm"),
  },
});
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
const scene = engine.scene as THREE.Scene;
scene.background = new THREE.Color(0xd9dde2);
const ambient = new THREE.HemisphereLight(0xf5f7fa, 0x626871, 1.55);
const key = new THREE.DirectionalLight(0xfff4df, 2.2);
key.position.set(7, 11, -6);
const fill = new THREE.DirectionalLight(0xdce9ff, 1.1);
fill.position.set(-8, 6, 5);
const floorGeometry = new THREE.PlaneGeometry(40, 40),
  floorMaterial = new THREE.MeshStandardMaterial({ color: 0xaeb4ba, roughness: 0.92, metalness: 0 });
const floor = new THREE.Mesh(floorGeometry, floorMaterial);
floor.name = "I1 neutral studio floor";
floor.rotation.x = -Math.PI / 2;
floor.position.y = authority.placement.position[1] - 0.025;
scene.add(ambient, key, fill, floor);

let mounted: Awaited<ReturnType<typeof mountStagedInteriorProxyReview>> | undefined;
let failure: unknown;
try {
  if (isSoftwareAdapter(engine.gpuAdapter))
    throw new Error(`I1 production review resolved a software adapter: ${JSON.stringify(engine.gpuAdapter)}`);
  gltfCache.configureKtx2(renderer);
  ops.op_physics_create_world(0);
  const baselineEntities = world.entities.ids().length;
  mounted = await mountStagedInteriorProxyReview(world, authority);
  renderSyncSystem(world.ecs);
  const mountedEvidence = { entity: mounted.entity, inventory: mounted.inventory, labelCount: mounted.labelCount };
  const camera = engine.camera as THREE.PerspectiveCamera;
  const render = async (beginFrame: () => void) => {
    mounted!.updateLabels(camera, width, height, 0);
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
        const view = mounted!.setEvidenceView(authority.evidenceViews[index].id),
          authored = view.camera;
        camera.fov = authored.fovDeg;
        camera.near = authored.near;
        camera.far = authored.far;
        camera.position.set(...authored.position);
        camera.lookAt(...authored.target);
        camera.updateProjectionMatrix();
        camera.updateMatrixWorld(true);
        for (let frame = 0; frame < (index === 0 ? authority.presentation.warmupFrames : 2); frame++)
          await render(beginFrame);
        mounted!.setCurrentSubjectVisible(false);
        let baseline;
        try {
          baseline = await withPresentedNativeSurfaceFrame(
            () => ops.op_surface_present(engine.context),
            () => {
              mounted!.updateLabels(camera, width, height, 0);
              renderer.info.reset();
              beginFrame();
              renderer.render(scene, camera);
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
            mounted!.updateLabels(camera, width, height, 0);
            renderer.info.reset();
            beginFrame();
            const started = performance.now();
            renderer.render(scene, camera);
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
          shellVisible: view.shellVisible,
          proxiesVisible: view.proxiesVisible,
          camera: view.camera,
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
    throw new Error(`I1 proxy review lifecycle leaked entities: ${baselineEntities} -> ${afterDisposeEntities}`);
  ops.op_write_trace(
    TRACE_NAME,
    JSON.stringify({
      schema: "limina.staged-interior-proxy-native-review-set/v1",
      backend: "native-webgpu",
      captureClass: "production-engine",
      surfaceFormat: captures[0].surfaceFormat,
      pixelFormat: "rgba8unorm",
      rowOrigin: "top-left",
      timingPolicy: { gpuTimestampMode: "disabled", timestampQueriesEnabled: false },
      studio: { neutral: true, world: "none", fixedTimeSeconds: authority.presentation.fixedTimeSeconds },
      adapter: engine.gpuAdapter,
      authority: {
        path: AUTHORITY_PATH,
        sha256: `sha256:${sha256(authorityBytes)}`,
        contentHash: portableAssetContentHash(authorityBytes),
      },
      source,
      approvedShell: authority.approvedShell,
      approvedMaterials: authority.approvedMaterials,
      derived: authority.derived,
      plan: authority.plan,
      stageArtifact: authority.stageArtifact,
      ...(authority.yawConventionMigration === undefined
        ? {}
        : { yawConventionMigration: authority.yawConventionMigration }),
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
  scene.remove(ambient, key, fill, floor);
  floorGeometry.dispose();
  floorMaterial.dispose();
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
      "I1 proxy capture teardown failed",
    );
}
if (failure !== undefined) throw failure;
