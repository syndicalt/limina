import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { validateBuildingStageArtifact } from "../../js/src/assets/staged-building-pipeline.mjs";
import {
  BUILDING_FIRE_REVIEW_AUTHORITY_V4_SCHEMA,
  BUILDING_FIRE_REVIEW_FRAME_IDS,
  validateBuildingFireReviewAuthority,
  verifyBuildingFireReviewClosure,
} from "../../js/src/render/building-fire-review-authority.ts";
import { portableAssetContentHash } from "../../js/src/world/asset-content-hash.mjs";

const DEFAULT_ROOT = resolve(import.meta.dirname, "../..");
export const FIRE_R4_R7_AUTHORITY_PATH = "assets/buildings/authoring/functional-hall-house-v4/fire-r4/fire-review-authority-r7.json";
export const FIRE_R15_CAPTURE_PATH = "assets/qc/internal/fire/functional-hall-house-v4-v1-volumetric-r15/capture-evidence.json";
export const FIRE_R4_R7_AUTHORITY_SHA256 = "sha256:2443394c43b083e080bc154f6fa3395c19e7e041ea5b37e79f1f7e8e89580cf0";
export const FIRE_R15_CAPTURE_SHA256 = "sha256:05effbe228e0b55010239f45e8e92b51c633c7b6da1d341c3444f80f7f6bbeab";
const SOURCE_PATHS = Object.freeze([
  "js/src/assets/building-fire-runtime-v2.mjs",
  "js/src/render/building-fire-review-authority.ts",
  "js/src/render/building-composition-review-scene.ts",
  "js/src/render/building-fire-runtime.ts",
  "js/src/render/building-fire-render-binding.ts",
  "js/src/render/building-fire-volumetric.ts",
  "js/src/render/building-fire-review-scene.ts",
  "js/src/render/telemetry.ts",
  "js/src/skills/asset.ts",
  "js/src/skills/entity-teardown.ts",
  "js/src/demos/building_fire_capture_window.ts",
  "tools/preview/run-native-building-fire-capture.mjs",
]);
const HASH = /^sha256:[0-9a-f]{64}$/;
const sha = (bytes) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const exact = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const integer = (value, minimum = 0) => Number.isSafeInteger(value) && value >= minimum;
const decode = (bytes, label) => {
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch (error) { throw new Error(`${label} is not valid UTF-8 JSON`, { cause: error }); }
};
const portable = (root, path) => {
  const value = relative(root, path).split(sep).join("/");
  if (!value || value === ".." || value.startsWith("../") || isAbsolute(value)) throw new Error(`V1 candidate path escapes repository: ${path}`);
  return value;
};
const resourceEvidence = (value) => {
  const values = value === undefined ? [] : [...Object.values(value.counts ?? {}), ...Object.values(value.bytes ?? {})];
  return value?.schema === "limina.three-render-resources/v1"
    && value.source === "three-webgpu-renderer-info"
    && value.scope === "renderer-live-after-production-frame"
    && values.length === 12 && values.every((entry) => integer(entry));
};
const pngDimensions = (bytes, label) => {
  const value = Buffer.from(bytes);
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (value.length < 24 || !value.subarray(0, 8).equals(signature) || value.toString("ascii", 12, 16) !== "IHDR") throw new Error(`${label} is not a canonical PNG`);
  return [value.readUInt32BE(16), value.readUInt32BE(20)];
};

function requireExposure(output, limits) {
  const evidence = output.exposureEvidence;
  if (evidence?.schema !== "limina.cpu-channel-exposure/v1" || !exact(evidence.limits, {
    maxChannelP99: limits.maxChannelP99,
    maxClippedPixelFraction: limits.maxClippedPixelFraction,
  })) throw new Error(`V1 ${output.id} lacks exact passing exposure evidence`);
  for (const channel of ["red", "green", "blue"]) {
    const value = evidence[channel];
    if (!Number.isFinite(value?.p99) || value.p99 < 0 || value.p99 > limits.maxChannelP99
      || !integer(value?.clippedPixels) || !Number.isFinite(value?.clippedFraction) || value.clippedFraction < 0
      || value.clippedFraction > limits.maxClippedPixelFraction) throw new Error(`V1 ${output.id} ${channel} exposure evidence failed`);
  }
}

function requireSilhouetteEvidence(capture, authority) {
  const evidence = capture.silhouetteVariationEvidence, ids = authority.metrics.silhouetteVariation.frameIds;
  if (evidence?.schema !== "limina.deterministic-flame-silhouette-variation/v1"
    || evidence.threshold?.warmDominance !== true || !integer(evidence.threshold?.minimumChangedPixels, 128)
    || !Number.isFinite(evidence.threshold?.minimumJaccardDistance) || evidence.threshold.minimumJaccardDistance < .001
    || !Array.isArray(evidence.frames) || !exact(evidence.frames.map(({ id }) => id), ids)
    || evidence.frames.some((frame) => !HASH.test(frame.maskSha256) || frame.changedPixels < evidence.threshold.minimumChangedPixels)
    || new Set(evidence.frames.map(({ maskSha256 }) => maskSha256)).size !== ids.length
    || !Array.isArray(evidence.comparisons) || evidence.comparisons.length !== ids.length - 1) throw new Error("V1 capture lacks passing silhouette-variation evidence");
  for (let index = 0; index < evidence.comparisons.length; index++) {
    const comparison = evidence.comparisons[index];
    if (comparison.from !== ids[index] || comparison.to !== ids[index + 1] || !integer(comparison.xorPixels, 1)
      || !integer(comparison.unionPixels, comparison.xorPixels) || !Number.isFinite(comparison.jaccardDistance)
      || comparison.jaccardDistance < evidence.threshold.minimumJaccardDistance) throw new Error("V1 silhouette-variation evidence failed");
  }
}

function requireVolumeEvidence(capture, authority) {
  const evidence = capture.volumeProofEvidence, policy = authority.metrics.volumeProof;
  if (!policy || evidence?.schema !== "limina.cpu-volumetric-fire-proof/v1" || evidence.representation !== policy.representation
    || evidence.baseline !== "same-tick-volume-hidden-only" || !exact(evidence.thresholds, {
      minimumChangedPixels: policy.minimumChangedPixels,
      minimumJaccardDistance: policy.minimumJaccardDistance,
      maximumOcclusionLeakFraction: policy.maximumOcclusionLeakFraction,
    }) || !Array.isArray(evidence.frames) || !exact(evidence.frames.map(({ id }) => id), policy.primaryFrameIds)
    || evidence.frames.some((frame) => !HASH.test(frame.maskSha256) || frame.changedPixels < policy.minimumChangedPixels)
    || !Array.isArray(evidence.comparisons) || evidence.comparisons.length !== policy.primaryFrameIds.length - 1
    || !Array.isArray(evidence.views) || !exact(evidence.views.map(({ id }) => id), policy.multiViewFrameIds)) throw new Error("V1 capture lacks exact passing volumetric evidence");
  for (let index = 0; index < evidence.comparisons.length; index++) {
    const item = evidence.comparisons[index];
    if (item.from !== policy.primaryFrameIds[index] || item.to !== policy.primaryFrameIds[index + 1]
      || !integer(item.xorPixels, 1) || !integer(item.unionPixels, item.xorPixels)
      || !Number.isFinite(item.jaccardDistance) || item.jaccardDistance < policy.minimumJaccardDistance) throw new Error("V1 volumetric variation evidence failed");
  }
  for (const view of evidence.views) if (view.baseline !== "same-tick-volume-hidden-only" || view.changedPixels < policy.minimumChangedPixels
    || view.hotPixels < policy.minimumChangedPixels || !integer(view.leakedPixels) || !Number.isFinite(view.leakFraction)
    || view.leakFraction < 0 || view.leakFraction > policy.maximumOcclusionLeakFraction) throw new Error("V1 volumetric multi-view evidence failed");
}

function requireReflectedLightEvidence(capture, authority) {
  const evidence = capture.reflectedLightEvidence, pair = authority.metrics.reflectedLightPair;
  if (evidence?.schema !== "limina.cpu-reflected-light-off-on/v1" || evidence.offFrameId !== pair.offFrameId
    || evidence.onFrameId !== pair.onFrameId || !Number.isFinite(evidence.positiveLumaDeltaThreshold)
    || evidence.positiveLumaDeltaThreshold <= 0 || !integer(evidence.positivelyLitPixels, 128)
    || !Number.isFinite(evidence.positivePixelFraction) || evidence.positivePixelFraction <= 0
    || !Number.isFinite(evidence.meanPositiveLumaDelta)
    || evidence.meanPositiveLumaDelta <= evidence.positiveLumaDeltaThreshold) throw new Error("V1 capture lacks passing reflected-light evidence");
}

/** Strict CPU-only assembly from already captured evidence. No renderer or decision is invoked. */
export function validateFireReviewCandidateInputs({ repoRoot = DEFAULT_ROOT, authorityPath, authorityBytes, capturePath, captureBytes }) {
  const root = resolve(repoRoot), authorityAbsolute = resolve(root, authorityPath), captureAbsolute = resolve(root, capturePath);
  if (portable(root, authorityAbsolute) !== FIRE_R4_R7_AUTHORITY_PATH || portable(root, captureAbsolute) !== FIRE_R15_CAPTURE_PATH) throw new Error("V1 candidate requires the exact fire-r4/r7 authority and r15 capture paths");
  const authority = validateBuildingFireReviewAuthority(decode(authorityBytes, "V1 authority"));
  if (authority.schema !== BUILDING_FIRE_REVIEW_AUTHORITY_V4_SCHEMA || authority.fireStage.contract.revision !== 4
    || authority.fireStage.artifact.revision !== 4 || authority.fireStage.artifact.artifactId !== "fire/functional-hall-house-v4/r4") throw new Error("V1 candidate authority is not exact fire-r4");
  const closure = verifyBuildingFireReviewClosure(authority, (path) => new Uint8Array(readFileSync(resolve(root, path))));
  const capture = decode(captureBytes, "V1 r15 capture"), authorityIdentity = {
    path: FIRE_R4_R7_AUTHORITY_PATH,
    sha256: sha(authorityBytes),
    contentHash: portableAssetContentHash(authorityBytes),
  };
  if (capture.schema !== "limina.building-fire-native-review-set/v1" || capture.backend !== "native-webgpu"
    || capture.captureClass !== "production-engine" || capture.pixelFormat !== authority.presentation.pixelFormat
    || capture.rowOrigin !== authority.presentation.rowOrigin || !exact(capture.authority, authorityIdentity)
    || capture.timingPolicy?.gpuTimestampMode !== "disabled" || capture.timingPolicy?.timestampQueriesEnabled !== false) throw new Error("V1 candidate requires exact guarded native-webgpu production capture authority");
  if (capture.guardEvidence?.schema !== "limina.nvidia-xid-guard/v1" || capture.guardEvidence.preflight?.xidObserved !== false
    || capture.guardEvidence.live?.xidObserved !== false || capture.guardEvidence.postflight?.xidObserved !== false) throw new Error("V1 candidate requires all three NVIDIA Xid guard phases to pass");
  if (!Array.isArray(capture.source) || !exact(capture.source.map(({ path }) => path), SOURCE_PATHS)) throw new Error("V1 r15 capture source closure is incomplete");
  for (const entry of capture.source) {
    const bytes = readFileSync(resolve(root, entry.path));
    if (entry.sha256 !== sha(bytes) || entry.contentHash !== portableAssetContentHash(bytes)) throw new Error(`V1 r15 capture source drifted: ${entry.path}`);
  }
  if (capture.mounted?.trace?.authoritySchema !== authority.schema || capture.mounted.trace.packageId !== authority.fireStage.contract.packageId
    || capture.mounted.trace.contractHash !== authority.fireStage.contract.canonicalHash || capture.mounted.trace.timestampQueriesEnabled !== false
    || capture.mounted?.inventory?.fire?.flameRepresentation !== authority.metrics.volumeProof?.representation
    || capture.mounted.inventory.fire.flameVolumes !== 1 || capture.mounted.inventory.fire.flameRibbons !== 0) throw new Error("V1 r15 mounted authority identity drifted");
  if (!integer(capture.lifecycle?.baselineEntities) || !integer(capture.lifecycle?.mountedEntities, capture.lifecycle.baselineEntities + 1)
    || capture.lifecycle.afterDisposeEntities !== capture.lifecycle.baselineEntities || !resourceEvidence(capture.lifecycle.baselineResources)
    || !resourceEvidence(capture.lifecycle.mountedResources) || !resourceEvidence(capture.lifecycle.afterDisposeResources)) throw new Error("V1 r15 capture lifecycle evidence is incomplete");
  const frames = authority.evidenceFrames;
  if (frames.length !== 11 || !exact(frames.map(({ id }) => id), BUILDING_FIRE_REVIEW_FRAME_IDS)
    || !Array.isArray(capture.captures) || capture.captures.length !== 11
    || !Array.isArray(capture.outputs) || capture.outputs.length !== 11) throw new Error("V1 candidate requires exactly 11 canonical outputs");
  const evidence = [];
  for (let index = 0; index < 11; index++) {
    const frame = frames[index], record = capture.captures[index], output = capture.outputs[index];
    if (record.id !== frame.id || record.sampleId !== frame.sampleId || record.tick !== frame.tick || record.phase !== frame.phase
      || !exact(record.camera, frame.camera) || output.id !== frame.id || output.ordinal !== frame.ordinal
      || record.width !== output.width || record.height !== output.height || record.rgbaContentHash !== output.rgbaContentHash
      || output.width < authority.presentation.minimumResolution[0] || output.height < authority.presentation.minimumResolution[1]
      || !HASH.test(output.pngSha256) || !HASH.test(output.rgbaContentHash) || !integer(output.pngByteLength, 1)) throw new Error(`V1 ${frame.id} output identity is invalid`);
    const expectedPath = `${dirname(FIRE_R15_CAPTURE_PATH)}/${String(index).padStart(2, "0")}-${frame.id}.png`;
    if (output.path !== expectedPath) throw new Error(`V1 ${frame.id} is not the exact r15 production PNG`);
    const png = readFileSync(resolve(root, output.path)), [width, height] = pngDimensions(png, `V1 ${frame.id}`);
    if (png.length !== output.pngByteLength || sha(png) !== output.pngSha256 || width !== output.width || height !== output.height) throw new Error(`V1 ${frame.id} production PNG bytes drifted`);
    requireExposure(output, authority.metrics.exposure);
    evidence.push({ evidenceId: `${closure.artifact.artifactId}/${frame.id}`, kind: "production-engine-png", contentHash: output.pngSha256, width, height });
  }
  requireSilhouetteEvidence(capture, authority); requireVolumeEvidence(capture, authority); requireReflectedLightEvidence(capture, authority);
  const candidate = validateBuildingStageArtifact({
    ...closure.artifact,
    status: "candidate",
    evidence,
    metadata: {
      ...closure.artifact.metadata,
      humanDecision: "pending",
      authority: authorityIdentity,
      capture: {
        path: FIRE_R15_CAPTURE_PATH,
        sha256: sha(captureBytes),
        contentHash: portableAssetContentHash(captureBytes),
        backend: capture.backend,
        captureClass: capture.captureClass,
        adapter: capture.adapter,
        timingPolicy: capture.timingPolicy,
        guardSchema: capture.guardEvidence.schema,
      },
      automatedEvidence: {
        exposure: { schema: "limina.cpu-channel-exposure/v1", outputs: 11, passed: true },
        silhouetteVariation: { schema: capture.silhouetteVariationEvidence.schema, passed: true },
        volumeProof: { schema: capture.volumeProofEvidence.schema, passed: true },
        reflectedLight: { schema: capture.reflectedLightEvidence.schema, passed: true },
      },
    },
  });
  return Object.freeze({ candidate, authority, capture, closure });
}

export async function buildFireReviewCandidate({ repoRoot = DEFAULT_ROOT, authorityPath = FIRE_R4_R7_AUTHORITY_PATH, capturePath = FIRE_R15_CAPTURE_PATH, outputPath, write = true } = {}) {
  if (!outputPath) throw new Error("outputPath is required");
  const root = resolve(repoRoot), authorityAbsolute = resolve(root, authorityPath), captureAbsolute = resolve(root, capturePath), outputAbsolute = resolve(root, outputPath);
  const [authorityBytes, captureBytes] = await Promise.all([readFile(authorityAbsolute), readFile(captureAbsolute)]);
  if (sha(authorityBytes) !== FIRE_R4_R7_AUTHORITY_SHA256 || sha(captureBytes) !== FIRE_R15_CAPTURE_SHA256) throw new Error("exact fire-r4/r7 authority or r15 capture bytes drifted");
  const result = validateFireReviewCandidateInputs({ repoRoot: root, authorityPath: authorityAbsolute, authorityBytes, capturePath: captureAbsolute, captureBytes });
  if (write) {
    await mkdir(dirname(outputAbsolute), { recursive: true, mode: 0o700 });
    await writeFile(outputAbsolute, `${JSON.stringify(result.candidate, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  }
  return Object.freeze({ ...result, outputPath: outputAbsolute });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2), at = (flag) => { const index = args.indexOf(flag); if (index < 0 || !args[index + 1]) throw new Error("usage: bun tools/architecture/build-fire-review-candidate.mjs --out <json> [--authority <json>] [--capture <json>]"); return args[index + 1]; };
  const optional = (flag, fallback) => { const index = args.indexOf(flag); return index < 0 ? fallback : at(flag); };
  const { candidate } = await buildFireReviewCandidate({ authorityPath: optional("--authority", FIRE_R4_R7_AUTHORITY_PATH), capturePath: optional("--capture", FIRE_R15_CAPTURE_PATH), outputPath: at("--out") });
  console.log(JSON.stringify({ artifactId: candidate.artifactId, status: candidate.status, evidence: candidate.evidence, humanDecision: candidate.metadata.humanDecision }, null, 2));
}
