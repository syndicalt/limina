import { createHash } from "node:crypto";
import { access, chmod, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "../../js/node_modules/sharp/lib/index.js";
import { validateBuildingStageArtifact } from "../../js/src/assets/staged-building-pipeline.mjs";
import { portableAssetContentHash } from "../../js/src/world/asset-content-hash.mjs";
import {
  archiveGuardedCaptureSources,
  runGuardedCaptureWithSourceClosure,
  verifyGuardedCaptureEvidence,
} from "./guarded-capture-publication.mjs";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../.."),
  binary = resolve(repo, "target/release/limina");
const modulePath = "js/src/demos/staged_material_capture_window.ts",
  tracePath = resolve(repo, "traces/staged-material-native-capture.json");
const args = process.argv.slice(2),
  value = (flag, fallback) => {
    const index = args.indexOf(flag);
    if (index >= 0 && !args[index + 1]) throw new Error(`missing value for ${flag}`);
    return index < 0 ? fallback : args[index + 1];
  };
const defaultAuthorityPath = "assets/buildings/authoring/functional-hall-house-v4/material-review-authority.json",
  defaultReviewPath = "assets/qc/internal/materials/functional-hall-house-v4/m1-r1";
const authorityArgument = value("--authority", defaultAuthorityPath),
  reviewArgument = value("--out-dir", defaultReviewPath),
  authorityAbsolute = resolve(repo, authorityArgument),
  authorityRelative = relative(repo, authorityAbsolute);
if (authorityRelative.startsWith(`..${sep}`) || authorityRelative === ".." || isAbsolute(authorityRelative))
  throw new Error("staged material authority escaped the repository root");
const authorityPath = authorityRelative.split(sep).join("/"),
  privateRoot = resolve(repo, "assets/qc/internal/materials"),
  reviewRoot = resolve(repo, reviewArgument),
  reviewRelative = relative(privateRoot, reviewRoot);
if (reviewRelative.startsWith(`..${sep}`) || reviewRelative === ".." || isAbsolute(reviewRelative))
  throw new Error("M1 captures must remain in the dedicated private Limina material review directory");
const authorityBytes = await readFile(authorityAbsolute),
  authority = JSON.parse(authorityBytes.toString("utf8"));
const stageBytes = await readFile(resolve(repo, authority.stageArtifact?.path ?? "")),
  stage = validateBuildingStageArtifact(JSON.parse(stageBytes));
if (
  stage.kind !== "material-palette" ||
  stage.status !== "draft" ||
  stage.artifactId !== authority.stageArtifact?.artifactId ||
  `sha256:${createHash("sha256").update(stageBytes).digest("hex")}` !== authority.stageArtifact?.sha256
)
  throw new Error("M1 authority stage-artifact closure drifted");
const appendOnly = stage.revision > 1;
if (appendOnly && !args.includes("--out-dir"))
  throw new Error("revised staged material capture requires an explicit fresh --out-dir");
try {
  await access(reviewRoot);
  throw new Error(`staged material output already exists: ${relative(repo, reviewRoot)}`);
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
}
const [minimumWidth, minimumHeight] = authority.presentation.minimumResolution,
  expected = authority.evidenceViews?.map((v) => v.id).join(","),
  baseExpected =
    "poly-haven-pack-swatches,authored-simple-role-swatches,representative-exterior-shell-crop,representative-interior-hearth-crop",
  enhancedExpected = `${baseExpected},roof-dormer-eave-continuity`;
if (minimumWidth < 1920 || minimumHeight < 1080 || ![baseExpected, enhancedExpected].includes(expected))
  throw new Error("M1 authority lacks the canonical >=1920x1080 evidence set");
const fullscreen = process.env.LIMINA_NATIVE_CAPTURE_FULLSCREEN ?? "";
if (!["", "0", "1"].includes(fullscreen)) throw new Error("LIMINA_NATIVE_CAPTURE_FULLSCREEN must be 0 or 1");
await access(binary);
const captureEnv = { ...process.env, LIMINA_ASSET_ROOT: repo, LIMINA_STAGED_MATERIAL_AUTHORITY: authorityPath };
delete captureEnv.LIMINA_GPU_TIMESTAMP_RISK_ACK;
delete captureEnv.LIMINA_GPU_TIMESTAMP_MODE;
delete captureEnv.LIMINA_GPU_TIMESTAMP_QUERIES;
for (const key of Object.keys(captureEnv)) if (/TIMESTAMP/i.test(key)) delete captureEnv[key];
if (Object.keys(captureEnv).some((key) => /TIMESTAMP/i.test(key)))
  throw new Error("timestamp environment variables are forbidden for M1 capture");
const captureSession = await runGuardedCaptureWithSourceClosure({
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
  failureLabel: "native M1 capture",
});

let traceBytes;
try {
  traceBytes = await readFile(tracePath);
} finally {
  await unlink(tracePath).catch((error) => {
    if (error?.code !== "ENOENT") throw error;
  });
}
const artifact = JSON.parse(traceBytes.toString("utf8")),
  authoritySha = `sha256:${createHash("sha256").update(authorityBytes).digest("hex")}`;
if (
  artifact.schema !== "limina.staged-material-native-review-set/v1" ||
  artifact.backend !== "native-webgpu" ||
  artifact.captureClass !== "production-engine" ||
  artifact.pixelFormat !== "rgba8unorm" ||
  artifact.rowOrigin !== "top-left" ||
  artifact.timingPolicy?.gpuTimestampMode !== "disabled" ||
  artifact.timingPolicy?.timestampQueriesEnabled !== false ||
  artifact.studio?.neutral !== true ||
  artifact.studio?.fixedTimeSeconds !== authority.presentation.fixedTimeSeconds ||
  artifact.authority?.path !== authorityPath ||
  artifact.authority?.sha256 !== authoritySha ||
  artifact.authority?.contentHash !== portableAssetContentHash(authorityBytes) ||
  JSON.stringify(artifact.approvedShell) !== JSON.stringify(authority.approvedShell) ||
  JSON.stringify(artifact.paletteLock) !== JSON.stringify(authority.paletteLock) ||
  JSON.stringify(artifact.derived) !== JSON.stringify(authority.derived) ||
  JSON.stringify(artifact.stageArtifact) !== JSON.stringify(authority.stageArtifact)
)
  throw new Error("M1 capture identity, studio, or disabled-timestamp policy drifted");
if (
  artifact.mounted?.packSwatches !== 12 ||
  artifact.mounted?.simpleSwatches !== authority.paletteLock.authoredSimpleRoles.length ||
  !Number.isSafeInteger(artifact.lifecycle?.baselineEntities) ||
  artifact.lifecycle.baselineEntities < 0 ||
  artifact.lifecycle.afterDisposeEntities !== artifact.lifecycle.baselineEntities
)
  throw new Error("M1 capture lacks exact swatch inventory or lifecycle return evidence");
if (
  !Array.isArray(artifact.captures) ||
  artifact.captures.length !== authority.evidenceViews.length ||
  artifact.captures.map((c) => c.id).join(",") !== expected ||
  artifact.captures.some(
    (capture, index) =>
      capture.role !== authority.evidenceViews[index].role ||
      capture.subject !== authority.evidenceViews[index].subject,
  )
)
  throw new Error("M1 capture views are incomplete or mislabeled");

await mkdir(reviewRoot, { recursive: true, mode: 0o700 });
await chmod(reviewRoot, 0o700);
const publicationEvidence = await archiveGuardedCaptureSources({ capture: captureSession, evidenceRoot: reviewRoot });
const outputs = [];
for (const capture of artifact.captures) {
  const submission = capture.renderSubmission,
    paired = capture.pairedRenderSubmission,
    resources = capture.rendererResources;
  if (
    capture.width < minimumWidth ||
    capture.height < minimumHeight ||
    capture.width < 1920 ||
    capture.height < 1080 ||
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
    throw new Error(`M1 ${capture.id} lacks strict whole-frame telemetry`);
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
    throw new Error(`M1 ${capture.id} lacks strict paired incremental telemetry`);
  const resourceValues =
    resources === undefined ? [] : [...Object.values(resources.counts ?? {}), ...Object.values(resources.bytes ?? {})];
  if (
    resources?.schema !== "limina.three-render-resources/v1" ||
    resources.source !== "three-webgpu-renderer-info" ||
    resources.scope !== "renderer-live-after-production-frame" ||
    resourceValues.length !== 12 ||
    resourceValues.some((value) => !Number.isSafeInteger(value) || value < 0)
  )
    throw new Error(`M1 ${capture.id} lacks renderer resource telemetry`);
  const rgba = Buffer.from(capture.rgbaBase64, "base64");
  if (
    rgba.length !== capture.width * capture.height * 4 ||
    capture.rgbaByteLength !== rgba.length ||
    portableAssetContentHash(rgba) !== capture.rgbaContentHash
  )
    throw new Error(`M1 ${capture.id} pixels are invalid`);
  let clipped = 0;
  const luma = [];
  for (let i = 0; i < rgba.length; i += 4) {
    const r = rgba[i],
      g = rgba[i + 1],
      b = rgba[i + 2];
    if (Math.max(r, g, b) === 255) clipped++;
    luma.push(0.2126 * r + 0.7152 * g + 0.0722 * b);
  }
  luma.sort((a, b) => a - b);
  const clippedFraction = clipped / (capture.width * capture.height),
    p99Luma = luma[Math.floor(luma.length * 0.99)];
  if (clippedFraction > 0.02 || p99Luma > 250)
    throw new Error(
      `M1 ${capture.id} exposure is not reviewable: clipped=${clippedFraction.toFixed(4)} p99=${p99Luma.toFixed(2)}`,
    );
  const exposureEvidence = {
    schema: "limina.cpu-pixel-exposure/v1",
    clippedDefinition: "any RGB channel equals 255",
    clippedPixels: clipped,
    totalPixels: capture.width * capture.height,
    clippedFraction,
    p99Luma,
    limits: { clippedFraction: 0.02, p99Luma: 250 },
  };
  const path = resolve(reviewRoot, `${capture.id}.png`);
  const pngBytes = await sharp(rgba, { raw: { width: capture.width, height: capture.height, channels: 4 } })
      .png({ compressionLevel: 9, adaptiveFiltering: true })
      .toBuffer();
  await writeFile(path, pngBytes, { mode: 0o600, flag: "wx" });
  await chmod(path, 0o600);
  const png = await readFile(path);
  outputs.push({
    id: capture.id,
    role: capture.role,
    subject: capture.subject,
    path: relative(repo, path),
    width: capture.width,
    height: capture.height,
    pngSha256: `sha256:${createHash("sha256").update(png).digest("hex")}`,
    pngByteLength: png.length,
    rgbaContentHash: capture.rgbaContentHash,
    exposureEvidence,
  });
}
const evidence = {
  ...artifact,
  captures: artifact.captures.map(({ rgbaBase64, ...capture }) => capture),
  ...publicationEvidence,
  outputs,
};
const evidencePath = resolve(reviewRoot, "capture-evidence.json");
await verifyGuardedCaptureEvidence({ capture: captureSession, evidenceRoot: reviewRoot, evidence });
await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600, flag: "wx" });
await chmod(evidencePath, 0o600);
console.log(JSON.stringify({ schema: evidence.schema, authority: evidence.authority, outputs }, null, 2));
