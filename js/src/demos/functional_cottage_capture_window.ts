import * as THREE from "../../build/three.bundle.mjs";
import { createEngine, ops } from "../engine.ts";
import { isSoftwareAdapter } from "../render/fidelity-benchmark.ts";
import { mountFunctionalCottageReview, validateFunctionalCottageReviewAuthority } from "../render/functional-cottage-review-scene.ts";
import { withFrozenRendererTime } from "../render/frozen-render-time.ts";
import { readNativeSurfaceRgba, withPresentedNativeSurfaceFrame } from "../render/native-surface-readback.ts";
import { captureRenderResourceTelemetry, captureRenderSubmissionTelemetry, requirePairedRenderSubmissionTelemetry, requireWholeFrameRenderSubmissionTelemetry, type RendererInfoLike } from "../render/telemetry.ts";
import { portableAssetContentHash } from "../world/asset-content-hash.mjs";
import { loadTemperateFidelityCandidate, mountTemperateFidelityScene } from "../render/temperate-fidelity-scene.ts";
import { GltfSceneCache, prewarmGltfScene } from "../skills/three.ts";
import { renderSyncSystem } from "../ecs/world.ts";
import { selectedFunctionalBuildingCycle, verifyFunctionalBuildingReferenceSources } from "../assets/functional-building-iteration.mjs";
import { sha256 } from "../world/sha256.mjs";
import { parseFunctionalBuildingContract } from "../assets/functional-building-contract.ts";
import { resolveFunctionalBuildingSitePlacement } from "../assets/functional-building-site.ts";

const TRACE_NAME = "functional-cottage-native-capture.json";
const AUTHORITY_PATH = "art-direction/functional-cottage-review-scene.json";
const decoder = new TextDecoder("utf-8", { fatal: true });
const authorityBytes = ops.op_read_asset(AUTHORITY_PATH);
const authority = validateFunctionalCottageReviewAuthority(JSON.parse(decoder.decode(authorityBytes)));
const authorityContentHash = portableAssetContentHash(authorityBytes);
const iterationBytes = ops.op_read_asset(authority.iterationAuthority.path);
if (`sha256:${sha256(iterationBytes)}` !== authority.iterationAuthority.sha256) throw new Error("functional cottage iteration authority hash drifted");
const iterationManifest = JSON.parse(decoder.decode(iterationBytes));
verifyFunctionalBuildingReferenceSources(iterationManifest, (path: string) => ops.op_read_asset(path), (bytes: Uint8Array) => `sha256:${sha256(bytes)}`);
const selectedIteration = selectedFunctionalBuildingCycle(iterationManifest);
if (selectedIteration.artifact.assetId !== authority.asset.assetId || selectedIteration.artifact.rawSha256 !== authority.asset.sha256
    || selectedIteration.artifact.engineContentHash !== authority.asset.assetHash) throw new Error("selected functional cottage iteration does not match capture asset closure");
const [minimumWidth, minimumHeight] = authority.presentation.minimumResolution;
const bytesToBase64 = (bytes: Uint8Array): string => {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 32_768) binary += String.fromCharCode(...bytes.subarray(offset, Math.min(offset + 32_768, bytes.length)));
  return btoa(binary);
};

const startedAt = performance.now();
const engine = await createEngine({ width: minimumWidth, height: minimumHeight, gpuTimestampMode: "disabled", gpuTextureCompression: "bc-required", renderBaseline: false });
const renderer = engine.renderer as unknown as THREE.WebGPURenderer;
let mounted: Awaited<ReturnType<typeof mountFunctionalCottageReview>> | undefined;
let environment: Awaited<ReturnType<typeof mountTemperateFidelityScene>> | undefined;
const gltfCache = new GltfSceneCache({ ktx2TranscoderPath: "/runtime/basis/", ktx2TranscoderBytes: {
  js: ops.op_read_asset("runtime/basis/basis_transcoder.js"), wasm: ops.op_read_asset("runtime/basis/basis_transcoder.wasm"),
} });
let captureFailure: unknown;
let siteEvidence: ReturnType<typeof resolveFunctionalBuildingSitePlacement> | undefined;
try {
  if (isSoftwareAdapter(engine.gpuAdapter)) throw new Error(`functional cottage capture resolved a software adapter: ${JSON.stringify(engine.gpuAdapter)}`);
  gltfCache.configureKtx2(renderer);
  renderer.info.autoReset = false;
  const reader = { readJson: async (path: string) => JSON.parse(decoder.decode(ops.op_read_asset(path))), readBytes: async (path: string) => ops.op_read_asset(path) };
  const buildingBytes=ops.op_read_asset(`assets/${authority.asset.assetId}`),buildingContract=parseFunctionalBuildingContract(buildingBytes);
  await prewarmGltfScene(authority.asset.assetId, buildingBytes, gltfCache);
  ops.op_log(`functional cottage stage asset-prewarm ${Number((performance.now() - startedAt).toFixed(1))}ms`);
  const loaded = await loadTemperateFidelityCandidate({ reader, shot: "river-leading-line" });
  ops.op_log(`functional cottage stage environment-loaded ${Number((performance.now() - startedAt).toFixed(1))}ms`);
  siteEvidence=resolveFunctionalBuildingSitePlacement({contract:buildingContract,position:authority.placement.position,yaw:authority.placement.yaw,
    sampleHeight:(x,z)=>loaded.candidate.snapshot.terrain.sampleHeight(x,z),maximumSampleSpacing:.5});
  environment = await mountTemperateFidelityScene({ loaded, renderer, scene: engine.scene as THREE.Scene, camera: engine.camera as THREE.PerspectiveCamera,
    ops, width: engine.width, height: engine.height, gltfCache, populationHardExclusionAt:siteEvidence.containsWorldXZ });
  ops.op_log(`functional cottage stage environment-mounted ${Number((performance.now() - startedAt).toFixed(1))}ms`);
  // Functional placement creates the same native shell/door bodies used by play; the review may
  // not silently degrade into a render-only GLB mount just because it captures a still frame.
  ops.op_physics_create_world(0);
  const terrainHeight = siteEvidence.rootY;
  const lifecycleBaselineEntities = environment.world.entities.ids().length;
  mounted = await mountFunctionalCottageReview(environment.world, authority, terrainHeight);
  ops.op_log(`functional cottage stage building-mounted ${Number((performance.now() - startedAt).toFixed(1))}ms`);
  const capturedPlacement = Object.freeze({ root: mounted.root, door: mounted.door, parts: mounted.parts.length, assetHash: mounted.assetHash });
  // The interactive engine loop normally projects authoritative ECS transforms immediately before
  // rendering. This bounded one-frame harness has no fixed-step loop, so perform that same production
  // projection explicitly after functional placement and door state authoring.
  renderSyncSystem(environment.world.ecs);
  const camera = engine.camera as THREE.PerspectiveCamera;
  camera.near = authority.camera.near; camera.far = authority.camera.far;
  const setCamera = (view: typeof authority.evidenceViews[number]): void => {
    const authored = view.camera === "hero" ? authority.camera : view.camera;
    camera.fov = authored.fovDeg;
    camera.position.set(authored.position[0], terrainHeight + authored.position[1], authored.position[2]);
    camera.lookAt(authored.target[0], terrainHeight + authored.target[1], authored.target[2]);
    camera.updateProjectionMatrix(); camera.updateMatrixWorld(true);
  };
  const captures = await withFrozenRendererTime(renderer, authority.presentation.fixedTimeSeconds, async (beginFrame) => {
    const results = [];
    for (let viewIndex = 0; viewIndex < authority.evidenceViews.length; viewIndex++) {
      const view = authority.evidenceViews[viewIndex];
      await mounted!.setDoorOpen(view.state === "open");
      mounted!.setLodLevel(view.lodLevel);
      renderSyncSystem(environment!.world.ecs);
      setCamera(view);
      const settleFrames = viewIndex === 0 ? authority.presentation.warmupFrames : 2;
      for (let frame = 0; frame < settleFrames; frame++) {
        beginFrame();
        await withPresentedNativeSurfaceFrame(() => ops.op_surface_present(engine.context), () => environment!.post.render());
      }
      mounted!.setRenderVisible(false);
      let baselineSubmission;
      try {
        baselineSubmission = await withPresentedNativeSurfaceFrame(() => ops.op_surface_present(engine.context), () => {
          renderer.info.reset(); beginFrame(); environment!.post.render();
          return requireWholeFrameRenderSubmissionTelemetry(captureRenderSubmissionTelemetry(renderer.info as unknown as RendererInfoLike));
        });
      } finally {
        mounted!.setRenderVisible(true);
      }
      const captured = await withPresentedNativeSurfaceFrame(() => ops.op_surface_present(engine.context), async () => {
        renderer.info.reset(); beginFrame();
        const encodeStartedAt = performance.now(); environment!.post.render();
        const cpuEncodeMs = Number((performance.now() - encodeStartedAt).toFixed(3));
        const submission = requireWholeFrameRenderSubmissionTelemetry(captureRenderSubmissionTelemetry(renderer.info as unknown as RendererInfoLike));
        const pairedSubmission = requirePairedRenderSubmissionTelemetry(baselineSubmission, submission, 16);
        const resources = captureRenderResourceTelemetry(renderer.info as unknown as RendererInfoLike);
        const readback = await readNativeSurfaceRgba({ device: engine.device as never, context: engine.context as never, minimumWidth, minimumHeight });
        return { readback, submission, pairedSubmission, resources, cpuEncodeMs };
      });
      results.push(Object.freeze({ id: view.id, state: view.state, role: view.role, camera: view.camera, lodLevel: view.lodLevel, distanceM: view.distanceM,
        width: captured.readback.width, height: captured.readback.height, surfaceFormat: captured.readback.format,
        rgbaContentHash: portableAssetContentHash(captured.readback.rgba),
        rgbaByteLength: captured.readback.rgba.byteLength, rgbaBase64: bytesToBase64(captured.readback.rgba),
        renderSubmission: Object.freeze({ ...captured.submission, cpuEncodeMs: captured.cpuEncodeMs }),
        pairedRenderSubmission: captured.pairedSubmission, rendererResources: captured.resources }));
      ops.op_log(`functional cottage stage view-${view.id} ${Number((performance.now() - startedAt).toFixed(1))}ms`);
    }
    return Object.freeze(results);
  });
  const lifecycleEntityCounts: number[] = [];
  await mounted.dispose(); mounted = undefined;
  lifecycleEntityCounts.push(environment.world.entities.ids().length);
  mounted = await mountFunctionalCottageReview(environment.world, authority, terrainHeight);
  await mounted.setDoorOpen(false);
  await mounted.setDoorOpen(true);
  await mounted.dispose(); mounted = undefined;
  lifecycleEntityCounts.push(environment.world.entities.ids().length);
  if (lifecycleEntityCounts.some((count) => count !== lifecycleBaselineEntities)) {
    throw new Error(`functional cottage repeated lifecycle leaked entities: ${lifecycleBaselineEntities} -> ${lifecycleEntityCounts.join(",")}`);
  }
  const artifact = Object.freeze({
    schema: "limina.functional-cottage-native-review-set/v2", primary: "exterior-open", backend: "native-webgpu",
    timingPolicy: Object.freeze({ gpuTimestampMode: "disabled", timestampQueriesEnabled: false }),
    adapter: engine.gpuAdapter, surfaceFormat: captures[0].surfaceFormat, pixelFormat: "rgba8unorm", rowOrigin: "top-left",
    authority: { path: AUTHORITY_PATH, contentHash: authorityContentHash }, asset: { assetId: authority.asset.assetId, sha256: authority.asset.sha256, assetHash: capturedPlacement.assetHash },
    generator: authority.generator, environmentAuthority: authority.environmentAuthority, iterationAuthority: authority.iterationAuthority,
    iteration: { iterationId: "functional-cottage/v4", selectedCycle: selectedIteration.cycle, status: selectedIteration.status },
    functionalPlacement: { root: capturedPlacement.root, door: capturedPlacement.door, parts: capturedPlacement.parts },
    siteEvidence: { sampleCount:siteEvidence.sampleCount,terrainMinimum:siteEvidence.terrainMinimum,terrainMaximum:siteEvidence.terrainMaximum,
      terrainRelief:siteEvidence.terrainRelief,rootY:siteEvidence.rootY,finishedFloorY:buildingContract.site!.finishedFloorY,
      terrainClearance:buildingContract.site!.terrainClearance,ecologyExclusion:"rotated-authored-footprint-before-population-mount" },
    lifecycleEvidence: Object.freeze({ cycles: 2, baselineEntities: lifecycleBaselineEntities, afterDestroyEntities: Object.freeze(lifecycleEntityCounts) }),
    fixedTimeSeconds: authority.presentation.fixedTimeSeconds, warmupFrames: authority.presentation.warmupFrames,
    captures,
    timingsMs: { total: Number((performance.now() - startedAt).toFixed(2)) },
  });
  ops.op_write_trace(TRACE_NAME, `${JSON.stringify(artifact)}\n`);
  ops.op_log(`functional cottage native capture wrote ${TRACE_NAME} (${captures.map((entry) => entry.id).join(", ")})`);
} catch (error) {
  captureFailure = error;
} finally {
  const cleanupFailures: unknown[] = [];
  const attempt = async (operation: () => void | Promise<void>): Promise<void> => { try { await operation(); } catch (error) { cleanupFailures.push(error); } };
  await attempt(async () => { await mounted?.dispose(); });
  await attempt(async () => { await environment?.dispose(); });
  await attempt(async () => { await gltfCache.dispose(); });
  await attempt(() => { engine.disposeRenderBaseline(); });
  await attempt(async () => { await renderer.dispose(); });
  if (cleanupFailures.length > 0) {
    captureFailure = new AggregateError(captureFailure === undefined ? cleanupFailures : [captureFailure, ...cleanupFailures], "functional cottage capture teardown failed");
  }
}
if (captureFailure !== undefined) throw captureFailure;
