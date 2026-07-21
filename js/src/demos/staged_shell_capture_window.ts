import * as THREE from "../../build/three.bundle.mjs";
import { createEngine, ops } from "../engine.ts";
import { isSoftwareAdapter } from "../render/fidelity-benchmark.ts";
import { inspectStagedShellExclusions, mountStagedShellReview, validateStagedShellReviewAuthority } from "../render/staged-shell-review-scene.ts";
import { withFrozenRendererTime } from "../render/frozen-render-time.ts";
import { readNativeSurfaceRgba, withPresentedNativeSurfaceFrame } from "../render/native-surface-readback.ts";
import { captureRenderResourceTelemetry, captureRenderSubmissionTelemetry, requirePairedRenderSubmissionTelemetry, requireWholeFrameRenderSubmissionTelemetry, type RendererInfoLike } from "../render/telemetry.ts";
import { portableAssetContentHash } from "../world/asset-content-hash.mjs";
import { loadTemperateFidelityCandidate, mountTemperateFidelityScene } from "../render/temperate-fidelity-scene.ts";
import { GltfSceneCache, prewarmGltfScene } from "../skills/three.ts";
import { renderSyncSystem } from "../ecs/world.ts";
import { validateBuildingStageArtifact } from "../assets/staged-building-pipeline.mjs";
import { sha256 } from "../world/sha256.mjs";
import { parseFunctionalBuildingContract } from "../assets/functional-building-contract.ts";
import { resolveFunctionalBuildingSitePlacement } from "../assets/functional-building-site.ts";

const TRACE_NAME = "staged-shell-native-capture.json";
const DEFAULT_AUTHORITY_PATH = "assets/buildings/authoring/functional-hall-house-v4/shell-review-authority.json";
const AUTHORITY_PATH = ops.op_read_env("LIMINA_STAGED_SHELL_AUTHORITY") || DEFAULT_AUTHORITY_PATH;
const decoder = new TextDecoder("utf-8", { fatal: true });
const authorityBytes = ops.op_read_asset(AUTHORITY_PATH);
const authority = validateStagedShellReviewAuthority(JSON.parse(decoder.decode(authorityBytes)));
const authorityContentHash = portableAssetContentHash(authorityBytes);
const authorityRawSha256 = `sha256:${sha256(authorityBytes)}`;
const exactBytes = (path: string, expected: string, label: string): Uint8Array => {
  const bytes = ops.op_read_asset(path);
  if (`sha256:${sha256(bytes)}` !== expected) throw new Error(`staged shell ${label} hash drifted`);
  return bytes;
};
const artifactBytes = exactBytes(authority.artifact.path, authority.artifact.sha256, "draft artifact");
const draftArtifact = validateBuildingStageArtifact(JSON.parse(decoder.decode(artifactBytes)));
if (draftArtifact.kind !== "shell" || draftArtifact.status !== "draft" || draftArtifact.artifactId !== authority.artifact.artifactId
  || draftArtifact.contractHash !== authority.artifact.contractHash || draftArtifact.contentHash !== authority.asset.sha256
  || draftArtifact.evidence.length !== 0) throw new Error("staged shell draft artifact closure drifted");
const buildEvidenceBytes = exactBytes(authority.buildEvidence.path, authority.buildEvidence.sha256, "build evidence");
const buildEvidence = JSON.parse(decoder.decode(buildEvidenceBytes));
if (buildEvidence.schema !== "limina.building-shell-build-evidence/v1" || buildEvidence.asset?.sha256 !== authority.asset.sha256
  || buildEvidence.sourceBlend?.sha256 !== authority.source.blendSha256 || buildEvidence.shellPayloadHash !== authority.artifact.contractHash
  || buildEvidence.functional?.buildingId !== authority.functional.buildingId
  || buildEvidence.functional?.doors !== authority.functional.doors || buildEvidence.functional?.colliders !== authority.functional.colliders
  || buildEvidence.functional?.rooms !== authority.functional.rooms || buildEvidence.functional?.portals !== authority.functional.portals
  || Object.values(buildEvidence.exclusions ?? {}).some((entry) => entry !== true)) throw new Error("staged shell build evidence closure drifted");
exactBytes(authority.source.blendPath, authority.source.blendSha256, "source blend");
exactBytes(authority.source.buildToolPath, authority.source.buildToolSha256, "build tool");
exactBytes(authority.source.adapterPath, authority.source.adapterSha256, "Blender adapter");
exactBytes(authority.environment.authorityPath, authority.environment.authoritySha256, "temperate authority");
exactBytes(authority.environment.bundlePath, authority.environment.bundleSha256, "temperate runtime bundle");
const [minimumWidth, minimumHeight] = authority.presentation.minimumResolution;
const bytesToBase64 = (bytes: Uint8Array): string => {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 32_768) binary += String.fromCharCode(...bytes.subarray(offset, Math.min(offset + 32_768, bytes.length)));
  return btoa(binary);
};

const startedAt = performance.now();
const engine = await createEngine({ width: minimumWidth, height: minimumHeight, gpuTimestampMode: "disabled", gpuTextureCompression: "bc-required", renderBaseline: false });
const renderer = engine.renderer as unknown as THREE.WebGPURenderer;
let mounted: Awaited<ReturnType<typeof mountStagedShellReview>> | undefined;
let environment: Awaited<ReturnType<typeof mountTemperateFidelityScene>> | undefined;
const gltfCache = new GltfSceneCache({ ktx2TranscoderPath: "/runtime/basis/", ktx2TranscoderBytes: {
  js: ops.op_read_asset("runtime/basis/basis_transcoder.js"), wasm: ops.op_read_asset("runtime/basis/basis_transcoder.wasm"),
} });
let captureFailure: unknown;
let siteEvidence: ReturnType<typeof resolveFunctionalBuildingSitePlacement> | undefined;
try {
  if (isSoftwareAdapter(engine.gpuAdapter)) throw new Error(`staged shell capture resolved a software adapter: ${JSON.stringify(engine.gpuAdapter)}`);
  gltfCache.configureKtx2(renderer);
  renderer.info.autoReset = false;
  const reader = { readJson: async (path: string) => JSON.parse(decoder.decode(ops.op_read_asset(path))), readBytes: async (path: string) => ops.op_read_asset(path) };
  const buildingBytes=exactBytes(`assets/${authority.asset.assetId}`,authority.asset.sha256,"runtime GLB"),buildingContract=parseFunctionalBuildingContract(buildingBytes);
  if (portableAssetContentHash(buildingBytes) !== authority.asset.assetHash || buildingContract.buildingId !== authority.functional.buildingId
    || buildingContract.doors.length !== authority.functional.doors || buildingContract.colliders.length !== authority.functional.colliders
    || buildingContract.roomIds.length !== authority.functional.rooms || buildingContract.portalIds.length !== authority.functional.portals) throw new Error("staged shell functional contract drifted");
  const exclusionInventory=inspectStagedShellExclusions(buildingBytes);
  await prewarmGltfScene(authority.asset.assetId, buildingBytes, gltfCache);
  ops.op_log(`staged shell stage asset-prewarm ${Number((performance.now() - startedAt).toFixed(1))}ms`);
  const loaded = await loadTemperateFidelityCandidate({ reader, shot: "river-leading-line" });
  ops.op_log(`staged shell stage environment-loaded ${Number((performance.now() - startedAt).toFixed(1))}ms`);
  siteEvidence=resolveFunctionalBuildingSitePlacement({contract:buildingContract,position:authority.placement.position,yaw:authority.placement.yaw,
    sampleHeight:(x,z)=>loaded.candidate.snapshot.terrain.sampleHeight(x,z),maximumSampleSpacing:.5});
  environment = await mountTemperateFidelityScene({ loaded, renderer, scene: engine.scene as THREE.Scene, camera: engine.camera as THREE.PerspectiveCamera,
    ops, width: engine.width, height: engine.height, gltfCache, populationHardExclusionAt:siteEvidence.containsWorldXZ });
  ops.op_log(`staged shell stage environment-mounted ${Number((performance.now() - startedAt).toFixed(1))}ms`);
  // Functional placement creates the same native shell/door bodies used by play; the review may
  // not silently degrade into a render-only GLB mount just because it captures a still frame.
  ops.op_physics_create_world(0);
  const terrainHeight = siteEvidence.rootWorldY;
  const lifecycleBaselineEntities = environment.world.entities.ids().length;
  mounted = await mountStagedShellReview(environment.world, authority, terrainHeight);
  ops.op_log(`staged shell stage building-mounted ${Number((performance.now() - startedAt).toFixed(1))}ms`);
  const capturedPlacement = Object.freeze({ root: mounted.root, door: mounted.door, parts: mounted.parts.length, assetHash: mounted.assetHash });
  // The interactive engine loop normally projects authoritative ECS transforms immediately before
  // rendering. This bounded one-frame harness has no fixed-step loop, so perform that same production
  // projection explicitly after functional placement and door state authoring.
  renderSyncSystem(environment.world.ecs);
  const camera = engine.camera as THREE.PerspectiveCamera;
  const setCamera = (view: typeof authority.evidenceViews[number]): void => {
    const authored = view.camera;
    camera.near = authored.near; camera.far = authored.far;
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
      results.push(Object.freeze({ id: view.id, state: view.state, role: view.role, camera: view.camera, renderLevel: view.renderLevel, distanceM: view.distanceM,
        width: captured.readback.width, height: captured.readback.height, surfaceFormat: captured.readback.format,
        rgbaContentHash: portableAssetContentHash(captured.readback.rgba),
        rgbaByteLength: captured.readback.rgba.byteLength, rgbaBase64: bytesToBase64(captured.readback.rgba),
        renderSubmission: Object.freeze({ ...captured.submission, cpuEncodeMs: captured.cpuEncodeMs }),
        pairedRenderSubmission: captured.pairedSubmission, rendererResources: captured.resources }));
      ops.op_log(`staged shell stage view-${view.id} ${Number((performance.now() - startedAt).toFixed(1))}ms`);
    }
    return Object.freeze(results);
  });
  const lifecycleEntityCounts: number[] = [];
  await mounted.dispose(); mounted = undefined;
  lifecycleEntityCounts.push(environment.world.entities.ids().length);
  mounted = await mountStagedShellReview(environment.world, authority, terrainHeight);
  await mounted.setDoorOpen(false);
  await mounted.setDoorOpen(true);
  await mounted.dispose(); mounted = undefined;
  lifecycleEntityCounts.push(environment.world.entities.ids().length);
  if (lifecycleEntityCounts.some((count) => count !== lifecycleBaselineEntities)) {
    throw new Error(`staged shell repeated lifecycle leaked entities: ${lifecycleBaselineEntities} -> ${lifecycleEntityCounts.join(",")}`);
  }
  const artifact = Object.freeze({
    schema: "limina.staged-shell-native-review-set/v1", primary: "exterior-open", backend: "native-webgpu", captureClass: "production-engine",
    timingPolicy: Object.freeze({ gpuTimestampMode: "disabled", timestampQueriesEnabled: false }),
    adapter: engine.gpuAdapter, surfaceFormat: captures[0].surfaceFormat, pixelFormat: "rgba8unorm", rowOrigin: "top-left",
    authority: { path: AUTHORITY_PATH, sha256: authorityRawSha256, contentHash: authorityContentHash },
    artifact: { ...authority.artifact, portableContentHash: portableAssetContentHash(artifactBytes), status: draftArtifact.status },
    asset: { assetId: authority.asset.assetId, sha256: authority.asset.sha256, assetHash: capturedPlacement.assetHash },
    buildEvidence: authority.buildEvidence, source: authority.source, environmentAuthority: authority.environment,
    functionalPlacement: { root: capturedPlacement.root, door: capturedPlacement.door, parts: capturedPlacement.parts },
    functionalInventory: authority.functional, exclusions: { ...authority.exclusions, inspection: exclusionInventory },
    renderPolicy: { level: "source-lod0", reason: "exact-staged-shell-has-no-packaged-lod-roots" },
    siteEvidence: { sampleCount:siteEvidence.sampleCount,terrainMinimum:siteEvidence.terrainMinimum,terrainMaximum:siteEvidence.terrainMaximum,
      terrainRelief:siteEvidence.terrainRelief,rootY:siteEvidence.rootWorldY,finishedFloorY:buildingContract.site!.finishedFloorY,
      entranceSupport:siteEvidence.entranceSupport,
      terrainClearance:buildingContract.site!.terrainClearance,ecologyExclusion:"rotated-authored-footprint-before-population-mount" },
    lifecycleEvidence: Object.freeze({ cycles: 2, baselineEntities: lifecycleBaselineEntities, afterDestroyEntities: Object.freeze(lifecycleEntityCounts) }),
    fixedTimeSeconds: authority.presentation.fixedTimeSeconds, warmupFrames: authority.presentation.warmupFrames,
    captures,
    timingsMs: { total: Number((performance.now() - startedAt).toFixed(2)) },
  });
  ops.op_write_trace(TRACE_NAME, `${JSON.stringify(artifact)}\n`);
  ops.op_log(`staged shell native capture wrote ${TRACE_NAME} (${captures.map((entry) => entry.id).join(", ")})`);
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
    captureFailure = new AggregateError(captureFailure === undefined ? cleanupFailures : [captureFailure, ...cleanupFailures], "staged shell capture teardown failed");
  }
}
if (captureFailure !== undefined) throw captureFailure;
