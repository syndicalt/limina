import { createHash } from "node:crypto";
import { access, chmod, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "../../js/node_modules/sharp/lib/index.js";
import { validateFurniturePackReviewAuthority } from "../../js/src/render/furniture-pack-review-scene.ts";
import { portableAssetContentHash } from "../../js/src/world/asset-content-hash.mjs";
import {
  archiveGuardedCaptureSources,
  runGuardedCaptureWithSourceClosure,
  verifyGuardedCaptureEvidence,
} from "./guarded-capture-publication.mjs";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const binary = resolve(repo, "target/release/limina");
const modulePath = "js/src/demos/furniture_pack_capture_window.ts";
const tracePath = resolve(repo, "traces/furniture-pack-native-capture.json");
const args = process.argv.slice(2),
  value = (flag) => {
    const index = args.indexOf(flag);
    if (index < 0 || !args[index + 1])
      throw new Error(
        "usage: bun tools/preview/run-native-furniture-pack-capture.mjs --authority <json> --out-dir <new-private-directory>",
      );
    return args[index + 1];
  };
const authorityPath = resolve(repo, value("--authority"));
const reviewRoot = resolve(repo, value("--out-dir"));
const internalRoot = resolve(repo, "assets/qc/internal/furniture");
const authorityRelative = relative(repo, authorityPath),
  reviewRelative = relative(internalRoot, reviewRoot);
if (authorityRelative === ".." || authorityRelative.startsWith(`..${sep}`) || isAbsolute(authorityRelative))
  throw new Error("furniture authority escaped the repository root");
if (
  reviewRelative === "" ||
  reviewRelative === ".." ||
  reviewRelative.startsWith(`..${sep}`) ||
  isAbsolute(reviewRelative)
) {
  throw new Error("furniture captures must remain in the dedicated private Limina review directory");
}
const authorityBytes = await readFile(authorityPath);
const authority = validateFurniturePackReviewAuthority(JSON.parse(authorityBytes.toString("utf8")));
const [minimumWidth, minimumHeight] = authority.presentation.minimumResolution;
const expectedViews = authority.evidenceViews.map(({ id, role, distanceM, ...view }) => ({
  id,
  role,
  distanceM,
  ...view,
}));
const expectedAuthoritativeBounds = authority.bounds.max.map((value, index) => value - authority.bounds.min[index]);
if (
  expectedViews.length < 1 ||
  new Set(expectedViews.map(({ id }) => id)).size !== expectedViews.length ||
  expectedViews.some(({ id }) => !id || id.includes("/") || id.includes("\\"))
)
  throw new Error("furniture authority review view ids must be unique safe filenames");
try {
  await access(reviewRoot);
  throw new Error(`append-only furniture capture output already exists: ${relative(repo, reviewRoot)}`);
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
}
const fullscreenSetting = process.env.LIMINA_NATIVE_CAPTURE_FULLSCREEN ?? "";
if (!["", "0", "1"].includes(fullscreenSetting)) throw new Error("LIMINA_NATIVE_CAPTURE_FULLSCREEN must be 0 or 1");
await access(binary);
const captureEnv = {
  ...process.env,
  LIMINA_ASSET_ROOT: repo,
  LIMINA_FURNITURE_REVIEW_AUTHORITY: authorityRelative.split(sep).join("/"),
};
delete captureEnv.LIMINA_GPU_TIMESTAMP_RISK_ACK;
delete captureEnv.LIMINA_GPU_TIMESTAMP_MODE;
delete captureEnv.LIMINA_GPU_TIMESTAMP_QUERIES;
for (const key of Object.keys(captureEnv)) if (/TIMESTAMP/i.test(key)) delete captureEnv[key];
if (Object.keys(captureEnv).some((key) => /TIMESTAMP/i.test(key)))
  throw new Error("timestamp environment variables are forbidden for furniture capture");
await unlink(tracePath).catch((error) => {
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
      ...(fullscreenSetting === "1" ? ["--fullscreen"] : []),
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
    failureLabel: "native furniture capture",
  });
} catch (error) {
  await unlink(tracePath).catch(() => {});
  throw error;
}

let traceBytes;
try {
  traceBytes = await readFile(tracePath);
} finally {
  await unlink(tracePath).catch((error) => {
    if (error?.code !== "ENOENT") throw error;
  });
}
const artifact = JSON.parse(traceBytes.toString("utf8"));
if (
  artifact.schema !== "limina.furniture-pack-native-review-set/v1" ||
  artifact.backend !== "native-webgpu" ||
  artifact.captureClass !== "production-engine" ||
  artifact.pixelFormat !== "rgba8unorm" ||
  artifact.rowOrigin !== "top-left" ||
  artifact.timingPolicy?.gpuTimestampMode !== "disabled" ||
  artifact.timingPolicy?.timestampQueriesEnabled !== false ||
  artifact.authority?.path !== authorityRelative.split(sep).join("/") ||
  artifact.authority?.sha256 !== `sha256:${createHash("sha256").update(authorityBytes).digest("hex")}` ||
  artifact.authority?.contentHash !== portableAssetContentHash(authorityBytes) ||
  artifact.pack?.id !== authority.pack.id ||
  artifact.pack?.assetId !== authority.pack.assetId ||
  artifact.pack?.sha256 !== authority.pack.sha256 ||
  artifact.pack?.assetHash !== authority.pack.assetHash ||
  artifact.pack?.payloadHash !== authority.pack.payloadHash ||
  JSON.stringify(artifact.dependencies) !== JSON.stringify(authority.dependencies) ||
  JSON.stringify(artifact.source) !== JSON.stringify(authority.source) ||
  JSON.stringify(artifact.functionalEvidence) !== JSON.stringify(authority.functionalEvidence) ||
  JSON.stringify(artifact.mounted?.functionalEvidence) !== JSON.stringify(authority.functionalEvidence) ||
  artifact.mounted?.collisionEvidence !== "compound-semantic-functional-placement" ||
  !Array.isArray(artifact.mounted?.authoritativeBounds) ||
  artifact.mounted.authoritativeBounds.length !== 3 ||
  artifact.mounted.authoritativeBounds.some(
    (value, index) => !Number.isFinite(value) || Math.abs(value - expectedAuthoritativeBounds[index]) > 0.002,
  )
) {
  throw new Error("furniture capture identity or timestamp policy drifted");
}
if (
  !Array.isArray(artifact.captures) ||
  artifact.captures.length !== expectedViews.length ||
  artifact.captures.some(
    (capture, index) =>
      capture.id !== expectedViews[index].id ||
      capture.role !== expectedViews[index].role ||
      capture.camera?.distanceM !== expectedViews[index].distanceM ||
      JSON.stringify(capture.reviewState) !==
        JSON.stringify({
          type: expectedViews[index].type,
          state: expectedViews[index].state,
          appliedState: `${expectedViews[index].type}:${expectedViews[index].state}`,
        }),
  )
) {
  throw new Error("furniture capture review views are incomplete or mislabeled");
}
if (
  !Number.isSafeInteger(artifact.lifecycle?.baselineEntities) ||
  artifact.lifecycle.baselineEntities < 0 ||
  artifact.lifecycle?.afterDisposeEntities !== artifact.lifecycle.baselineEntities
)
  throw new Error("furniture capture lacks lifecycle return evidence");

await mkdir(reviewRoot, { recursive: true, mode: 0o700 });
await chmod(reviewRoot, 0o700);
const publicationEvidence = await archiveGuardedCaptureSources({ capture: captureSession, evidenceRoot: reviewRoot });
const outputs = [];
for (const capture of artifact.captures) {
  const submission = capture.renderSubmission;
  if (
    capture.width < minimumWidth ||
    capture.height < minimumHeight ||
    capture.surfaceFormat !== artifact.surfaceFormat ||
    submission?.schema !== "limina.three-render-submission/v2" ||
    submission.source !== "three-webgpu-renderer-info" ||
    submission.scope !== "single-production-frame-all-passes" ||
    submission.instanceAccounting !== "full-draw-instance-count" ||
    !Number.isSafeInteger(submission.frameId) ||
    submission.frameId < 1 ||
    !Number.isSafeInteger(submission.renderCalls) ||
    submission.renderCalls < 1 ||
    !Number.isSafeInteger(submission.drawCalls) ||
    submission.drawCalls < 1 ||
    !Number.isSafeInteger(submission.triangles) ||
    submission.triangles < 1 ||
    !Number.isFinite(submission.cpuEncodeMs) ||
    submission.cpuEncodeMs < 0
  )
    throw new Error(`furniture capture ${capture.id} lacks whole-frame telemetry`);
  const resources = capture.rendererResources;
  const resourceValues =
    resources === undefined ? [] : [...Object.values(resources.counts ?? {}), ...Object.values(resources.bytes ?? {})];
  if (
    resources?.schema !== "limina.three-render-resources/v1" ||
    resources.source !== "three-webgpu-renderer-info" ||
    resources.scope !== "renderer-live-after-production-frame" ||
    resourceValues.length !== 12 ||
    resourceValues.some((value) => !Number.isSafeInteger(value) || value < 0)
  )
    throw new Error(`furniture capture ${capture.id} lacks renderer resource telemetry`);
  const paired = capture.pairedRenderSubmission;
  if (
    paired?.schema !== "limina.paired-render-submission/v1" ||
    paired.basis !== "same-process-fixed-camera-time-residency-post-visibility-toggle" ||
    paired.candidate?.frameId !== paired.baseline?.frameId + 1 ||
    paired.candidate?.drawCalls !== submission.drawCalls ||
    paired.candidate?.triangles !== submission.triangles ||
    paired.delta?.renderCalls !== paired.candidate.renderCalls - paired.baseline.renderCalls ||
    paired.delta?.drawCalls !== paired.candidate.drawCalls - paired.baseline.drawCalls ||
    paired.delta?.triangles !== paired.candidate.triangles - paired.baseline.triangles ||
    !Number.isSafeInteger(paired.delta.drawCalls) ||
    paired.delta.drawCalls < 1 ||
    !Number.isSafeInteger(paired.delta.triangles) ||
    paired.delta.triangles < 1
  )
    throw new Error(`furniture capture ${capture.id} lacks strict paired subject telemetry`);
  const rgba = Buffer.from(capture.rgbaBase64, "base64");
  if (
    rgba.length !== capture.width * capture.height * 4 ||
    capture.rgbaByteLength !== rgba.length ||
    portableAssetContentHash(rgba) !== capture.rgbaContentHash
  )
    throw new Error(`furniture capture ${capture.id} has invalid pixels`);
  const output = resolve(reviewRoot, `${capture.id}.png`);
  const png = await sharp(rgba, { raw: { width: capture.width, height: capture.height, channels: 4 } })
    .png({ compressionLevel: 9, adaptiveFiltering: true })
    .toBuffer();
  await writeFile(output, png, { mode: 0o600, flag: "wx" });
  await chmod(output, 0o600);
  outputs.push({
    id: capture.id,
    role: capture.role,
    type: capture.reviewState.type,
    state: capture.reviewState.state,
    appliedState: capture.reviewState.appliedState,
    distanceM: capture.camera.distanceM,
    width: capture.width,
    height: capture.height,
    path: relative(repo, output),
    pngSha256: `sha256:${createHash("sha256").update(png).digest("hex")}`,
    pngByteLength: png.length,
    rgbaContentHash: capture.rgbaContentHash,
    renderSubmission: submission,
    rendererResources: resources,
  });
}
const guardedArtifact = {
  ...artifact,
  captures: artifact.captures.map(({ rgbaBase64, ...capture }) => capture),
  ...publicationEvidence,
  outputs,
};
const evidenceOutput = resolve(reviewRoot, "capture-evidence.json");
await verifyGuardedCaptureEvidence({ capture: captureSession, evidenceRoot: reviewRoot, evidence: guardedArtifact });
await writeFile(evidenceOutput, `${JSON.stringify(guardedArtifact, null, 2)}\n`, { mode: 0o600, flag: "wx" });
await chmod(evidenceOutput, 0o600);
console.log(JSON.stringify({ schema: guardedArtifact.schema, pack: guardedArtifact.pack, outputs }, null, 2));
