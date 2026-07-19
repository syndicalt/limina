import * as THREE from "../../build/three.bundle.mjs";
import { createEngine, ops } from "../engine.ts";
import { renderSyncSystem } from "../ecs/world.ts";
import { parseFunctionalBuildingContract } from "../assets/functional-building-contract.ts";
import { resolveFunctionalBuildingSitePlacement } from "../assets/functional-building-site.ts";
import { isSoftwareAdapter } from "../render/fidelity-benchmark.ts";
import { withFrozenRendererTime } from "../render/frozen-render-time.ts";
import { readNativeSurfaceRgba, withPresentedNativeSurfaceFrame } from "../render/native-surface-readback.ts";
import {
  validateBuildingProductionReviewAuthority,
  verifyBuildingProductionReviewClosure,
  verifyBuildingProductionReviewSiteResolution,
} from "../render/building-production-review-authority.ts";
import { mountBuildingProductionReview } from "../render/building-production-review-scene.ts";
import { loadTemperateFidelityCandidate, mountTemperateFidelityScene } from "../render/temperate-fidelity-scene.ts";
import {
  captureRenderResourceTelemetry,
  captureRenderSubmissionTelemetry,
  requireWholeFrameRenderSubmissionTelemetry,
  type RendererInfoLike,
} from "../render/telemetry.ts";
import { GltfSceneCache, prewarmGltfScene } from "../skills/three.ts";
import { portableAssetContentHash } from "../world/asset-content-hash.mjs";
import { sha256 } from "../world/sha256.mjs";

export const BUILDING_PRODUCTION_REVIEW_AUTHORITY_ENV = "LIMINA_BUILDING_PRODUCTION_REVIEW_AUTHORITY" as const;
export const BUILDING_PRODUCTION_REVIEW_TRACE_ENV = "LIMINA_BUILDING_PRODUCTION_REVIEW_TRACE" as const;
export const BUILDING_PRODUCTION_REVIEW_TRACE = "building-production-r1-native-capture.json" as const;
export const BUILDING_PRODUCTION_REVIEW_TRACE_SCHEMA = "limina.building-production-native-review-set/v1" as const;

const SOURCE_PATHS = Object.freeze([
  "js/src/render/building-production-review-authority.ts",
  "js/src/render/building-production-review-scene.ts",
  "js/src/demos/building_production_review_window.ts",
  "tools/preview/run-native-building-production-r1-capture.mjs",
] as const);

const authorityPath = ops.op_read_env(BUILDING_PRODUCTION_REVIEW_AUTHORITY_ENV);
if (!authorityPath) throw new Error(`${BUILDING_PRODUCTION_REVIEW_AUTHORITY_ENV} is required`);
const traceName = ops.op_read_env(BUILDING_PRODUCTION_REVIEW_TRACE_ENV);
if (
  !traceName ||
  !/^[A-Za-z0-9][A-Za-z0-9._-]*\.json$/.test(traceName) ||
  traceName.includes("..") ||
  traceName.includes("/") ||
  traceName.includes("\\")
) {
  throw new Error(`${BUILDING_PRODUCTION_REVIEW_TRACE_ENV} must be a bare .json filename`);
}

const decoder = new TextDecoder("utf-8", { fatal: true });
const authorityBytes = ops.op_read_asset(authorityPath);
const authority = validateBuildingProductionReviewAuthority(JSON.parse(decoder.decode(authorityBytes)));
const closure = verifyBuildingProductionReviewClosure(authority, (path) => ops.op_read_asset(path));
const source = Object.freeze(
  SOURCE_PATHS.map((path) => {
    const bytes = ops.op_read_asset(path);
    return Object.freeze({ path, sha256: `sha256:${sha256(bytes)}`, contentHash: portableAssetContentHash(bytes) });
  }),
);
const [width, height] = authority.presentation.minimumResolution;
const reader = {
  readJson: async (path: string) => JSON.parse(decoder.decode(ops.op_read_asset(path))),
  readBytes: async (path: string) => ops.op_read_asset(path),
};
// Site authority is resolved and compared to append-only CPU evidence before renderer/GPU creation.
const loaded = await loadTemperateFidelityCandidate({ reader, shot: authority.environment.shot });
let siteEvidence: ReturnType<typeof resolveFunctionalBuildingSitePlacement>;
try {
  const productionContract = parseFunctionalBuildingContract(ops.op_read_asset(authority.package.productionGlb.path));
  siteEvidence = resolveFunctionalBuildingSitePlacement({
    contract: productionContract,
    position: authority.placement.position,
    yaw: authority.placement.yaw,
    sampleHeight: (x, z) => loaded.candidate.snapshot.terrain.sampleHeight(x, z),
    maximumSampleSpacing: 0.5,
  });
  verifyBuildingProductionReviewSiteResolution(authority, closure.siteFit, siteEvidence, (x, z) =>
    loaded.candidate.snapshot.terrain.sampleHeight(x, z),
  );
} catch (error) {
  loaded.candidate.dispose();
  throw error;
}

function toBase64(bytes: Uint8Array): string {
  let value = "";
  for (let offset = 0; offset < bytes.length; offset += 32_768) {
    value += String.fromCharCode(...bytes.subarray(offset, Math.min(offset + 32_768, bytes.length)));
  }
  return btoa(value);
}

const engine = await createEngine({
  width,
  height,
  gpuTimestampMode: "disabled",
  gpuTextureCompression: "bc-required",
  renderBaseline: false,
}).catch((error) => {
  loaded.candidate.dispose();
  throw error;
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
gltfCache.configureKtx2(renderer);
const scene = engine.scene as THREE.Scene;

let mounted: Awaited<ReturnType<typeof mountBuildingProductionReview>> | undefined;
let environment: Awaited<ReturnType<typeof mountTemperateFidelityScene>> | undefined;
let failure: unknown;
try {
  if (isSoftwareAdapter(engine.gpuAdapter)) {
    throw new Error(`R1 production review resolved a software adapter: ${JSON.stringify(engine.gpuAdapter)}`);
  }
  const productionAssetId = "buildings/functional-hall-house-v4-production.glb",
    fuelPath = closure.manifest.runtimeFacets.fire.fuel.runtimeGlb.path,
    fuelAssetId = fuelPath.replace(/^assets\//, "");
  await prewarmGltfScene(productionAssetId, closure.productionBytes, gltfCache);
  await prewarmGltfScene(fuelAssetId, ops.op_read_asset(fuelPath), gltfCache);
  environment = await mountTemperateFidelityScene({
    loaded,
    renderer,
    scene,
    camera: engine.camera as THREE.PerspectiveCamera,
    ops,
    width: engine.width,
    height: engine.height,
    gltfCache,
    populationHardExclusionAt: siteEvidence.containsWorldXZ,
  });
  ops.op_physics_create_world(0);
  const world = environment.world;
  const baselineEntities = world.entities.ids().length;
  mounted = await mountBuildingProductionReview(world, authority, siteEvidence.rootWorldY);
  renderSyncSystem(world.ecs);
  const mountedEvidence = Object.freeze({
    inventory: mounted.production.inventory,
    packageTrace: mounted.production.trace,
    fireSample: mounted.fireSample,
    buildingRoot: mounted.production.buildingRoot,
    doorEntities: mounted.production.doorEntities,
    furnitureInstanceIds: mounted.production.furniture.map(({ instanceId }) => instanceId),
    site: Object.freeze({
      rootWorldY: siteEvidence.rootWorldY,
      terrainMinimum: siteEvidence.terrainMinimum,
      terrainMaximum: siteEvidence.terrainMaximum,
      terrainRelief: siteEvidence.terrainRelief,
      sampleCount: siteEvidence.sampleCount,
      entranceSupport: siteEvidence.entranceSupport,
      evidence: authority.siteFitEvidence,
      populationExclusion: authority.environment.populationExclusion,
    }),
  });
  const camera = engine.camera as THREE.PerspectiveCamera;
  const renderWarmup = async (beginFrame: () => void): Promise<void> => {
    beginFrame();
    await withPresentedNativeSurfaceFrame(
      () => ops.op_surface_present(engine.context),
      () => environment!.post.render(),
    );
  };
  const captures = await withFrozenRendererTime(
    renderer,
    authority.presentation.fixedTimeSeconds,
    async (beginFrame) => {
      const output = [];
      for (let index = 0; index < authority.evidenceViews.length; index++) {
        const view = authority.evidenceViews[index];
        mounted!.setEvidenceView(view.id);
        for (let frame = 0; frame < (index === 0 ? authority.presentation.warmupFrames : 2); frame++) {
          await renderWarmup(beginFrame);
        }
        const captured = await withPresentedNativeSurfaceFrame(
          () => ops.op_surface_present(engine.context),
          async () => {
            renderer.info.reset();
            beginFrame();
            const started = performance.now();
            environment!.post.render();
            const cpuEncodeMs = Number((performance.now() - started).toFixed(3));
            const submission = requireWholeFrameRenderSubmissionTelemetry(
              captureRenderSubmissionTelemetry(renderer.info as unknown as RendererInfoLike),
            );
            if (submission.renderCalls <= 1 || submission.drawCalls <= 1 || submission.triangles <= 1) {
              throw new Error(`R1 ${view.id} did not submit a whole production frame`);
            }
            const resources = captureRenderResourceTelemetry(renderer.info as unknown as RendererInfoLike);
            const pixels = await readNativeSurfaceRgba({
              device: engine.device as never,
              context: engine.context as never,
              expectedWidth: width,
              expectedHeight: height,
              minimumWidth: width,
              minimumHeight: height,
            });
            return { cpuEncodeMs, submission, resources, pixels };
          },
        );
        output.push(
          Object.freeze({
            id: view.id,
            role: view.role,
            camera: view.camera,
            authorityCamera: view.camera,
            resolvedCamera: Object.freeze({
              position: Object.freeze([
                view.camera.position[0],
                view.camera.position[1] + siteEvidence.rootWorldY,
                view.camera.position[2],
              ]),
              target: Object.freeze([
                view.camera.target[0],
                view.camera.target[1] + siteEvidence.rootWorldY,
                view.camera.target[2],
              ]),
              fovDeg: view.camera.fovDeg,
              near: view.camera.near,
              far: view.camera.far,
              verticalBasis: "world",
            }),
            width: captured.pixels.width,
            height: captured.pixels.height,
            surfaceFormat: captured.pixels.format,
            rgbaByteLength: captured.pixels.rgba.byteLength,
            rgbaContentHash: portableAssetContentHash(captured.pixels.rgba),
            rgbaBase64: toBase64(captured.pixels.rgba),
            renderSubmission: Object.freeze({ ...captured.submission, cpuEncodeMs: captured.cpuEncodeMs }),
            rendererResources: captured.resources,
          }),
        );
      }
      return Object.freeze(output);
    },
  );
  await mounted.dispose();
  mounted = undefined;
  const afterDisposeEntities = world.entities.ids().length;
  if (afterDisposeEntities !== baselineEntities) {
    throw new Error(`R1 review lifecycle leaked entities: ${baselineEntities} -> ${afterDisposeEntities}`);
  }
  ops.op_write_trace(
    traceName,
    `${JSON.stringify({
      schema: BUILDING_PRODUCTION_REVIEW_TRACE_SCHEMA,
      backend: "native-webgpu",
      captureClass: "production-engine",
      surfaceFormat: captures[0].surfaceFormat,
      pixelFormat: "rgba8unorm",
      rowOrigin: "top-left",
      timingPolicy: {
        gpuTimestampMode: "disabled",
        timestampQueriesEnabled: false,
        gpuTextureCompression: "bc-required",
        renderBaseline: false,
      },
      adapter: engine.gpuAdapter,
      authority: {
        path: authorityPath,
        sha256: `sha256:${sha256(authorityBytes)}`,
        contentHash: portableAssetContentHash(authorityBytes),
      },
      source,
      environment: authority.environment,
      presentation: Object.freeze({
        fixedTimeSeconds: authority.presentation.fixedTimeSeconds,
        warmupFrames: authority.presentation.warmupFrames,
        cameraVerticalBasis: authority.presentation.cameraVerticalBasis,
      }),
      mounted: mountedEvidence,
      lifecycle: { baselineEntities, afterDisposeEntities, disposed: true },
      captures,
    })}\n`,
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
    if (environment !== undefined) await environment.dispose();
    else loaded.candidate.dispose();
  } catch (error) {
    failures.push(error);
  }
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
  if (failures.length) {
    failure = new AggregateError(
      failure === undefined ? failures : [failure, ...failures],
      "R1 capture teardown failed",
    );
  }
}
if (failure !== undefined) throw failure;
