import { createHash } from "node:crypto";
import { promises as fs, readFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import sharp from "../../js/node_modules/sharp/lib/index.js";
import {
  BUILDING_FIRE_REVIEW_FRAME_IDS,
  validateBuildingFireReviewAuthority,
  verifyBuildingFireReviewClosure,
} from "../../js/src/render/building-fire-review-authority.ts";
import { portableAssetContentHash } from "../../js/src/world/asset-content-hash.mjs";
import {
  archiveGuardedCaptureSources,
  runGuardedCaptureWithSourceClosure,
  verifyGuardedCaptureEvidence,
} from "./guarded-capture-publication.mjs";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../.."),
  binary = resolve(repo, "target/release/limina"),
  modulePath = "js/src/demos/building_fire_capture_window.ts",
  tracePath = resolve(repo, "traces/building-fire-native-capture.json"),
  args = process.argv.slice(2);
const at = (flag) => {
  const index = args.indexOf(flag);
  if (index < 0 || !args[index + 1])
    throw new Error(
      "usage: bun tools/preview/run-native-building-fire-capture.mjs --authority <json> --out-dir <new-private-directory>",
    );
  return args[index + 1];
};
const authorityAbsolute = resolve(repo, at("--authority")),
  authorityRelative = relative(repo, authorityAbsolute);
if (authorityRelative === ".." || authorityRelative.startsWith(`..${sep}`) || isAbsolute(authorityRelative))
  throw new Error("V1 authority escaped repository");
const authorityPath = authorityRelative.split(sep).join("/"),
  authorityBytes = await fs.readFile(authorityAbsolute),
  authority = validateBuildingFireReviewAuthority(JSON.parse(authorityBytes)),
  closure = verifyBuildingFireReviewClosure(authority, (path) => readFileSync(resolve(repo, path)));
const reviewRoot = resolve(repo, at("--out-dir")),
  internalRoot = resolve(repo, "assets/qc/internal/fire"),
  reviewRelative = relative(internalRoot, reviewRoot);
if (!reviewRelative || reviewRelative === ".." || reviewRelative.startsWith(`..${sep}`) || isAbsolute(reviewRelative))
  throw new Error("V1 captures must remain in a new private fire review directory");
try {
  await fs.access(reviewRoot);
  throw new Error(`append-only V1 output already exists: ${relative(repo, reviewRoot)}`);
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
}
const [minimumWidth, minimumHeight] = authority.presentation.minimumResolution,
  frameIds = BUILDING_FIRE_REVIEW_FRAME_IDS.join(",");
if (
  minimumWidth < 1920 ||
  minimumHeight < 1080 ||
  authority.evidenceFrames.map((frame) => frame.id).join(",") !== frameIds
)
  throw new Error("V1 authority lacks canonical 11-frame >=1920x1080 evidence");

const fullscreen = process.env.LIMINA_NATIVE_CAPTURE_FULLSCREEN ?? "";
if (fullscreen !== "1") throw new Error("V1 exact 1920x1080 evidence requires LIMINA_NATIVE_CAPTURE_FULLSCREEN=1");
await fs.access(binary);
const captureEnv = { ...process.env, LIMINA_ASSET_ROOT: repo, LIMINA_BUILDING_FIRE_REVIEW_AUTHORITY: authorityPath };
delete captureEnv.LIMINA_GPU_TIMESTAMP_RISK_ACK;
delete captureEnv.LIMINA_GPU_TIMESTAMP_MODE;
delete captureEnv.LIMINA_GPU_TIMESTAMP_QUERIES;
for (const key of Object.keys(captureEnv)) if (/TIMESTAMP/i.test(key)) delete captureEnv[key];
if (Object.keys(captureEnv).some((key) => /TIMESTAMP/i.test(key)))
  throw new Error("timestamp environment variables are forbidden for V1 capture");
await fs.unlink(tracePath).catch((error) => {
  if (error?.code !== "ENOENT") throw error;
});
let captureSession;
try {
  captureSession = await runGuardedCaptureWithSourceClosure({
    repoRoot: repo,
    runnerUrl: import.meta.url,
    modulePath,
    command: binary,
    args: [
      "--window",
      ...(fullscreen === "1" ? ["--fullscreen"] : []),
      "--width",
      String(minimumWidth),
      "--height",
      String(minimumHeight),
      "--frames",
      "1",
      modulePath,
    ],
    cwd: repo,
    environment: captureEnv,
    failureLabel: "native V1 capture",
  });
} catch (error) {
  await fs.unlink(tracePath).catch(() => {});
  throw error;
}
let traceBytes;
try {
  traceBytes = await fs.readFile(tracePath);
} finally {
  await fs.unlink(tracePath).catch((error) => {
    if (error?.code !== "ENOENT") throw error;
  });
}

const artifact = JSON.parse(traceBytes),
  raw = (bytes) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
if (
  artifact.schema !== "limina.building-fire-native-review-set/v1" ||
  artifact.backend !== "native-webgpu" ||
  artifact.captureClass !== "production-engine" ||
  artifact.pixelFormat !== authority.presentation.pixelFormat ||
  artifact.rowOrigin !== authority.presentation.rowOrigin ||
  artifact.timingPolicy?.gpuTimestampMode !== "disabled" ||
  artifact.timingPolicy?.timestampQueriesEnabled !== false ||
  artifact.authority?.path !== authorityPath ||
  artifact.authority?.sha256 !== raw(authorityBytes) ||
  artifact.authority?.contentHash !== portableAssetContentHash(authorityBytes)
)
  throw new Error("V1 capture identity or timestamp policy drifted");
const sourcePaths = [
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
];
if (!Array.isArray(artifact.source) || artifact.source.map((entry) => entry.path).join(",") !== sourcePaths.join(","))
  throw new Error("V1 capture lacks exact review source closure");
for (const entry of artifact.source) {
  const bytes = await fs.readFile(resolve(repo, entry.path));
  if (raw(bytes) !== entry.sha256 || portableAssetContentHash(bytes) !== entry.contentHash)
    throw new Error(`V1 review implementation drifted: ${entry.path}`);
}
const resourceEvidence = (value) => {
  const values = value === undefined ? [] : [...Object.values(value.counts ?? {}), ...Object.values(value.bytes ?? {})];
  return (
    value?.schema === "limina.three-render-resources/v1" &&
    value.source === "three-webgpu-renderer-info" &&
    value.scope === "renderer-live-after-production-frame" &&
    values.length === 12 &&
    values.every((entry) => Number.isSafeInteger(entry) && entry >= 0)
  );
};
if (
  !Number.isSafeInteger(artifact.lifecycle?.baselineEntities) ||
  !Number.isSafeInteger(artifact.lifecycle?.mountedEntities) ||
  artifact.lifecycle.mountedEntities <= artifact.lifecycle.baselineEntities ||
  artifact.lifecycle.afterDisposeEntities !== artifact.lifecycle.baselineEntities ||
  !resourceEvidence(artifact.lifecycle?.baselineResources) ||
  !resourceEvidence(artifact.lifecycle?.mountedResources) ||
  !resourceEvidence(artifact.lifecycle?.afterDisposeResources) ||
  artifact.mounted?.trace?.timestampQueriesEnabled !== false ||
  artifact.mounted?.trace?.schema !== "limina.building-fire-review-mount-trace/v1"
)
  throw new Error("V1 capture lacks entity/resource lifecycle baselines or mount trace");
if (
  !Array.isArray(artifact.captures) ||
  artifact.captures.length !== BUILDING_FIRE_REVIEW_FRAME_IDS.length ||
  artifact.captures.map((capture) => capture.id).join(",") !== frameIds
)
  throw new Error("V1 capture frames are incomplete or out of order");

const pixelCount = (capture) => capture.width * capture.height,
  decodePixels = (capture, key = "rgbaBase64") => {
    const rgba = Buffer.from(capture[key], "base64");
    if (rgba.length !== pixelCount(capture) * 4) throw new Error(`V1 ${capture.id} ${key} byte length is invalid`);
    return rgba;
  };
const channelExposure = (rgba, channel, total, limitP99, limitClipped, frameId) => {
  const histogram = new Uint32Array(256);
  for (let offset = channel; offset < rgba.length; offset += 4) histogram[rgba[offset]]++;
  const rank = Math.ceil(total * 0.99);
  let cumulative = 0,
    p99 = 255;
  for (let value = 0; value < 256; value++) {
    cumulative += histogram[value];
    if (cumulative >= rank) {
      p99 = value;
      break;
    }
  }
  const clippedPixels = histogram[255],
    evidence = { p99: p99 / 255, clippedPixels, clippedFraction: clippedPixels / total };
  if (evidence.p99 > limitP99 || evidence.clippedFraction > limitClipped)
    throw new Error(
      `V1 ${frameId} exposure failed channel ${channel}: p99=${evidence.p99.toFixed(4)} clipped=${evidence.clippedFraction.toFixed(6)}`,
    );
  return evidence;
};
const pendingOutputs = [],
  decoded = new Map();
for (const [index, capture] of artifact.captures.entries()) {
  const frame = authority.evidenceFrames[index],
    submission = capture.renderSubmission,
    paired = capture.pairedRenderSubmission,
    resources = capture.rendererResources;
  if (
    capture.sampleId !== frame.sampleId ||
    capture.tick !== frame.tick ||
    capture.phase !== frame.phase ||
    JSON.stringify(capture.camera) !== JSON.stringify(frame.camera) ||
    capture.width < minimumWidth ||
    capture.height < minimumHeight ||
    capture.surfaceFormat !== artifact.surfaceFormat ||
    submission?.schema !== "limina.three-render-submission/v2" ||
    submission.source !== "three-webgpu-renderer-info" ||
    submission.scope !== "single-production-frame-all-passes" ||
    submission.instanceAccounting !== "full-draw-instance-count" ||
    !Number.isSafeInteger(submission.frameId) ||
    submission.frameId < 1 ||
    !Number.isSafeInteger(submission.drawCalls) ||
    submission.drawCalls < 1 ||
    !Number.isSafeInteger(submission.triangles) ||
    submission.triangles < 1 ||
    !Number.isFinite(submission.cpuEncodeMs) ||
    submission.cpuEncodeMs < 0
  )
    throw new Error(`V1 ${capture.id} lacks whole-scene telemetry`);
  if (
    paired?.schema !== "limina.paired-render-submission/v1" ||
    paired.basis !== "same-process-fixed-camera-time-residency-post-visibility-toggle" ||
    paired.candidate?.frameId !== paired.baseline?.frameId + 1 ||
    paired.candidate?.renderCalls !== submission.renderCalls ||
    paired.candidate?.drawCalls !== submission.drawCalls ||
    paired.candidate?.triangles !== submission.triangles ||
    paired.delta?.renderCalls !== paired.candidate.renderCalls - paired.baseline.renderCalls ||
    paired.delta?.drawCalls !== paired.candidate.drawCalls - paired.baseline.drawCalls ||
    paired.delta?.triangles !== paired.candidate.triangles - paired.baseline.triangles ||
    !Number.isSafeInteger(paired.delta.renderCalls) ||
    paired.delta.renderCalls < 0 ||
    !Number.isSafeInteger(paired.delta.drawCalls) ||
    paired.delta.drawCalls < 1 ||
    !Number.isSafeInteger(paired.delta.triangles) ||
    paired.delta.triangles < 1
  )
    throw new Error(`V1 ${capture.id} lacks paired fire telemetry`);
  if (frame.phase !== "off" && (paired.delta.drawCalls < 1 || paired.delta.triangles < 1))
    throw new Error(`V1 ${capture.id} lacks a visible dynamic-fire delta`);
  if (!resourceEvidence(resources)) throw new Error(`V1 ${capture.id} lacks renderer resource telemetry`);
  const rgba = decodePixels(capture),
    baselineRgba = decodePixels(capture, "pairedBaselineRgbaBase64"),
    volumeBaselineRgba = decodePixels(capture, "volumeBaselineRgbaBase64");
  if (
    capture.rgbaByteLength !== rgba.length ||
    portableAssetContentHash(rgba) !== capture.rgbaContentHash ||
    capture.pairedBaselineRgbaByteLength !== baselineRgba.length ||
    portableAssetContentHash(baselineRgba) !== capture.pairedBaselineRgbaContentHash ||
    capture.volumeBaselineRgbaByteLength !== volumeBaselineRgba.length ||
    portableAssetContentHash(volumeBaselineRgba) !== capture.volumeBaselineRgbaContentHash
  )
    throw new Error(`V1 ${capture.id} pixels are invalid`);
  decoded.set(capture.id, { capture, rgba, baselineRgba, volumeBaselineRgba });
  const exposureEvidence = {
    schema: "limina.cpu-channel-exposure/v1",
    red: channelExposure(
      rgba,
      0,
      pixelCount(capture),
      authority.metrics.exposure.maxChannelP99,
      authority.metrics.exposure.maxClippedPixelFraction,
      capture.id,
    ),
    green: channelExposure(
      rgba,
      1,
      pixelCount(capture),
      authority.metrics.exposure.maxChannelP99,
      authority.metrics.exposure.maxClippedPixelFraction,
      capture.id,
    ),
    blue: channelExposure(
      rgba,
      2,
      pixelCount(capture),
      authority.metrics.exposure.maxChannelP99,
      authority.metrics.exposure.maxClippedPixelFraction,
      capture.id,
    ),
    limits: {
      maxChannelP99: authority.metrics.exposure.maxChannelP99,
      maxClippedPixelFraction: authority.metrics.exposure.maxClippedPixelFraction,
    },
  };
  const encodeStarted = performance.now(),
    png = await sharp(rgba, { raw: { width: capture.width, height: capture.height, channels: 4 } })
      .png({ compressionLevel: 9, adaptiveFiltering: true })
      .toBuffer(),
    cpuPngEncodeMs = Number((performance.now() - encodeStarted).toFixed(3)),
    output = resolve(reviewRoot, `${String(frame.ordinal).padStart(2, "0")}-${capture.id}.png`);
  pendingOutputs.push({
    output,
    png,
    record: {
      id: capture.id,
      ordinal: frame.ordinal,
      path: relative(repo, output),
      width: capture.width,
      height: capture.height,
      pngSha256: raw(png),
      pngByteLength: png.length,
      rgbaContentHash: capture.rgbaContentHash,
      cpuPngEncodeMs,
      exposureEvidence,
      renderSubmission: submission,
      pairedRenderSubmission: paired,
      rendererResources: resources,
    },
  });
}

const silhouetteFor = (id, baselineKey = "baselineRgba") => {
  const item = decoded.get(id),
    { capture, rgba } = item,
    baselineRgba = item[baselineKey],
    mask = Buffer.alloc(pixelCount(capture));
  let changedPixels = 0,
    minX = capture.width,
    minY = capture.height,
    maxX = -1,
    maxY = -1,
    sumX = 0,
    sumY = 0;
  for (let pixel = 0, offset = 0; pixel < mask.length; pixel++, offset += 4) {
    const delta = Math.max(
      Math.abs(rgba[offset] - baselineRgba[offset]),
      Math.abs(rgba[offset + 1] - baselineRgba[offset + 1]),
      Math.abs(rgba[offset + 2] - baselineRgba[offset + 2]),
    );
    if (delta >= 10 && rgba[offset] >= rgba[offset + 1] && rgba[offset] > rgba[offset + 2]) {
      mask[pixel] = 1;
      changedPixels++;
      const x = pixel % capture.width,
        y = Math.floor(pixel / capture.width);
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
      sumX += x;
      sumY += y;
    }
  }
  if (changedPixels < 128) throw new Error(`V1 ${id} lacks a measurable warm flame silhouette`);
  return {
    id,
    mask,
    maskSha256: raw(mask),
    changedPixels,
    coverageFraction: changedPixels / mask.length,
    bounds: { minX, minY, maxX, maxY },
    centroid: { x: sumX / changedPixels, y: sumY / changedPixels },
  };
};
const silhouettes = authority.metrics.silhouetteVariation.frameIds.map((id) => silhouetteFor(id)),
  variation = [];
for (let index = 1; index < silhouettes.length; index++) {
  const left = silhouettes[index - 1],
    right = silhouettes[index];
  let xor = 0,
    union = 0;
  for (let pixel = 0; pixel < left.mask.length; pixel++) {
    if (left.mask[pixel] || right.mask[pixel]) union++;
    if (left.mask[pixel] !== right.mask[pixel]) xor++;
  }
  const jaccardDistance = union === 0 ? 0 : xor / union;
  if (jaccardDistance <= 0.001) throw new Error(`V1 flame silhouette did not vary between ${left.id} and ${right.id}`);
  variation.push({ from: left.id, to: right.id, xorPixels: xor, unionPixels: union, jaccardDistance });
}
if (new Set(silhouettes.map((item) => item.maskSha256)).size !== silhouettes.length)
  throw new Error("V1 flame silhouette hashes are not unique across burn frames");
const silhouetteVariationEvidence = {
  schema: "limina.deterministic-flame-silhouette-variation/v1",
  threshold: { maximumChannelDelta: 10, warmDominance: true, minimumChangedPixels: 128, minimumJaccardDistance: 0.001 },
  frames: silhouettes.map(({ mask, ...item }) => item),
  comparisons: variation,
};
let volumeProofEvidence = null;
if (authority.metrics.volumeProof) {
  const policy = authority.metrics.volumeProof,
    volume = closure.contract.visuals.flameVolume,
    flameSocket = closure.contract.shellInterface.sockets.find((socket) => socket.id === volume.socketId);
  if (
    !flameSocket ||
    volume.representation !== policy.representation ||
    artifact.mounted?.inventory?.fire?.flameRepresentation !== policy.representation ||
    artifact.mounted.inventory.fire.flameVolumes !== 1 ||
    artifact.mounted.inventory.fire.flameRibbons !== 0
  )
    throw new Error("V1 volumetric mount inventory or contract representation drifted");
  const normalize = (v) => {
      const length = Math.hypot(...v);
      return v.map((value) => value / length);
    },
    cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]],
    dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const projectBounds = (capture) => {
    const camera = capture.camera,
      forward = normalize(camera.target.map((value, index) => value - camera.position[index])),
      right = normalize(cross(forward, [0, 1, 0])),
      up = cross(right, forward),
      aspect = capture.width / capture.height,
      tan = Math.tan((camera.fovDeg * Math.PI) / 360),
      center = flameSocket.position.map((value, index) => value + volume.centerOffsetM[index]),
      points = [];
    for (const sx of [-1, 1])
      for (const sy of [-1, 1])
        for (const sz of [-1, 1]) {
          const point = [
              center[0] + sx * volume.halfExtentsM[0],
              center[1] + sy * volume.halfExtentsM[1],
              center[2] + sz * volume.halfExtentsM[2],
            ],
            relative = point.map((value, index) => value - camera.position[index]),
            depth = dot(relative, forward);
          if (depth <= 0.001) throw new Error(`V1 ${capture.id} volumetric bound is behind the evidence camera`);
          const ndcX = dot(relative, right) / (depth * tan * aspect),
            ndcY = dot(relative, up) / (depth * tan);
          points.push([(ndcX * 0.5 + 0.5) * capture.width, (0.5 - ndcY * 0.5) * capture.height]);
        }
    const padding = 16;
    return {
      minX: Math.max(0, Math.floor(Math.min(...points.map((point) => point[0])) - padding)),
      maxX: Math.min(capture.width - 1, Math.ceil(Math.max(...points.map((point) => point[0])) + padding)),
      minY: Math.max(0, Math.floor(Math.min(...points.map((point) => point[1])) - padding)),
      maxY: Math.min(capture.height - 1, Math.ceil(Math.max(...points.map((point) => point[1])) + padding)),
    };
  };
  const volumeSilhouettes = policy.primaryFrameIds.map((id) => silhouetteFor(id, "volumeBaselineRgba")),
    volumeVariation = [];
  for (let index = 1; index < volumeSilhouettes.length; index++) {
    const left = volumeSilhouettes[index - 1],
      right = volumeSilhouettes[index];
    let xor = 0,
      union = 0;
    for (let pixel = 0; pixel < left.mask.length; pixel++) {
      if (left.mask[pixel] || right.mask[pixel]) union++;
      if (left.mask[pixel] !== right.mask[pixel]) xor++;
    }
    const jaccardDistance = union === 0 ? 0 : xor / union;
    if (jaccardDistance < policy.minimumJaccardDistance)
      throw new Error(
        `V1 volumetric flame variation ${left.id} -> ${right.id} is ${jaccardDistance.toFixed(6)}, below ${policy.minimumJaccardDistance}`,
      );
    volumeVariation.push({ from: left.id, to: right.id, xorPixels: xor, unionPixels: union, jaccardDistance });
  }
  const views = [];
  for (const id of policy.multiViewFrameIds) {
    const item = volumeSilhouettes.find((entry) => entry.id === id) ?? silhouetteFor(id, "volumeBaselineRgba");
    if (item.changedPixels < policy.minimumChangedPixels)
      throw new Error(`V1 ${id} lacks the required multi-view volumetric fire pixels`);
    const { capture, rgba, volumeBaselineRgba } = decoded.get(id),
      bounds = projectBounds(capture);
    let hotPixels = 0,
      leakedPixels = 0;
    for (let pixel = 0, offset = 0; pixel < pixelCount(capture); pixel++, offset += 4) {
      const delta = Math.max(
        Math.abs(rgba[offset] - volumeBaselineRgba[offset]),
        Math.abs(rgba[offset + 1] - volumeBaselineRgba[offset + 1]),
        Math.abs(rgba[offset + 2] - volumeBaselineRgba[offset + 2]),
      );
      if (
        delta < 16 ||
        rgba[offset] < 160 ||
        rgba[offset] < rgba[offset + 1] * 1.15 ||
        rgba[offset] < rgba[offset + 2] * 1.6
      )
        continue;
      hotPixels++;
      const x = pixel % capture.width,
        y = Math.floor(pixel / capture.width);
      if (x < bounds.minX || x > bounds.maxX || y < bounds.minY || y > bounds.maxY) leakedPixels++;
    }
    if (hotPixels < policy.minimumChangedPixels) throw new Error(`V1 ${id} lacks a measurable hot volumetric core`);
    const leakFraction = leakedPixels / hotPixels;
    if (leakFraction > policy.maximumOcclusionLeakFraction)
      throw new Error(
        `V1 ${id} volumetric occlusion leak ${leakFraction.toFixed(6)} exceeds ${policy.maximumOcclusionLeakFraction}`,
      );
    views.push({
      id,
      baseline: "same-tick-volume-hidden-only",
      changedPixels: item.changedPixels,
      hotPixels,
      leakedPixels,
      leakFraction,
      projectedBounds: bounds,
    });
  }
  volumeProofEvidence = {
    schema: "limina.cpu-volumetric-fire-proof/v1",
    representation: policy.representation,
    baseline: "same-tick-volume-hidden-only",
    thresholds: {
      minimumChangedPixels: policy.minimumChangedPixels,
      minimumJaccardDistance: policy.minimumJaccardDistance,
      maximumOcclusionLeakFraction: policy.maximumOcclusionLeakFraction,
    },
    frames: volumeSilhouettes.map(({ mask, ...item }) => item),
    comparisons: volumeVariation,
    views,
  };
}
const off = decoded.get(authority.metrics.reflectedLightPair.offFrameId),
  on = decoded.get(authority.metrics.reflectedLightPair.onFrameId);
if (
  off.capture.width !== on.capture.width ||
  off.capture.height !== on.capture.height ||
  JSON.stringify(off.capture.camera) !== JSON.stringify(on.capture.camera)
)
  throw new Error("V1 reflected-light pair is not camera/resolution locked");
let positivelyLitPixels = 0,
  sumPositiveLumaDelta = 0;
for (let offset = 0; offset < off.rgba.length; offset += 4) {
  const hot =
    on.rgba[offset] > 220 &&
    on.rgba[offset] > on.rgba[offset + 1] * 1.35 &&
    on.rgba[offset] > on.rgba[offset + 2] * 1.6;
  if (hot) continue;
  const before = 0.2126 * off.rgba[offset] + 0.7152 * off.rgba[offset + 1] + 0.0722 * off.rgba[offset + 2],
    after = 0.2126 * on.rgba[offset] + 0.7152 * on.rgba[offset + 1] + 0.0722 * on.rgba[offset + 2],
    delta = after - before;
  if (delta > 2) {
    positivelyLitPixels++;
    sumPositiveLumaDelta += delta;
  }
}
if (positivelyLitPixels < 128) throw new Error("V1 reflected-light pair lacks measurable non-flame illumination");
const reflectedLightEvidence = {
  schema: "limina.cpu-reflected-light-off-on/v1",
  offFrameId: off.capture.id,
  onFrameId: on.capture.id,
  hotPixelExclusion: "r>220 && r>1.35g && r>1.6b",
  positiveLumaDeltaThreshold: 2,
  positivelyLitPixels,
  positivePixelFraction: positivelyLitPixels / pixelCount(on.capture),
  meanPositiveLumaDelta: sumPositiveLumaDelta / positivelyLitPixels,
};
await fs.mkdir(reviewRoot, { recursive: true, mode: 0o700 });
await fs.chmod(reviewRoot, 0o700);
const publicationEvidence = await archiveGuardedCaptureSources({ capture: captureSession, evidenceRoot: reviewRoot });
const outputs = [];
for (const pending of pendingOutputs) {
  await fs.writeFile(pending.output, pending.png, { mode: 0o600, flag: "wx" });
  outputs.push(pending.record);
}
const evidence = {
    ...artifact,
    captures: artifact.captures.map(
      ({ rgbaBase64, pairedBaselineRgbaBase64, volumeBaselineRgbaBase64, ...capture }) => capture,
    ),
    ...publicationEvidence,
    silhouetteVariationEvidence,
    volumeProofEvidence,
    reflectedLightEvidence,
    outputs,
  },
  evidencePath = resolve(reviewRoot, "capture-evidence.json");
await verifyGuardedCaptureEvidence({ capture: captureSession, evidenceRoot: reviewRoot, evidence });
await fs.writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600, flag: "wx" });
console.log(
  JSON.stringify(
    { schema: evidence.schema, outputs, silhouetteVariationEvidence, volumeProofEvidence, reflectedLightEvidence },
    null,
    2,
  ),
);
