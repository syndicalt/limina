import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { promises as fs } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "../../js/node_modules/sharp/lib/index.js";
import { validateBuildingStageArtifact } from "../../js/src/assets/staged-building-pipeline.mjs";
import {
  validateStagedInteriorProxyReviewAuthority,
  verifyStagedInteriorProxyReviewClosure,
} from "../../js/src/render/staged-interior-proxy-review-scene.ts";
import { portableAssetContentHash } from "../../js/src/world/asset-content-hash.mjs";
import {
  archiveGuardedCaptureSources,
  runGuardedCaptureWithSourceClosure,
  verifyGuardedCaptureEvidence,
} from "./guarded-capture-publication.mjs";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const binary = resolve(repo, "target/release/limina");
const modulePath = "js/src/demos/staged_interior_proxy_capture_window.ts";
const tracePath = resolve(repo, "traces/staged-interior-proxy-native-capture.json");
const args = process.argv.slice(2);
const value = (flag, fallback) => {
  const index = args.indexOf(flag);
  if (index >= 0 && !args[index + 1]) throw new Error(`missing value for ${flag}`);
  return index < 0 ? fallback : args[index + 1];
};
const defaultAuthorityPath =
  "assets/buildings/authoring/functional-hall-house-v4/interior-r1/interior-review-authority.json";
const authorityArgument = value("--authority", defaultAuthorityPath),
  explicitReviewArgument = value("--out-dir", undefined);
const authorityAbsolute = resolve(repo, authorityArgument),
  authorityRelative = relative(repo, authorityAbsolute);
if (authorityRelative.startsWith(`..${sep}`) || authorityRelative === ".." || isAbsolute(authorityRelative))
  throw new Error("I1 authority escaped the repository root");
const authorityPath = authorityRelative.split(sep).join("/");
const authorityBytes = await fs.readFile(authorityAbsolute),
  authority = validateStagedInteriorProxyReviewAuthority(JSON.parse(authorityBytes.toString("utf8")));
const reviewArgument =
    explicitReviewArgument ?? `assets/qc/internal/interiors/functional-hall-house-v4/i1-r${authority.plan.revision}`,
  privateRoot = resolve(repo, "assets/qc/internal/interiors"),
  reviewRoot = resolve(repo, reviewArgument),
  reviewRelative = relative(privateRoot, reviewRoot);
if (reviewRelative.startsWith(`..${sep}`) || reviewRelative === ".." || isAbsolute(reviewRelative))
  throw new Error("I1 captures must remain in the dedicated private Limina interior review directory");
// Repeat the complete closure check in the launcher so a drifted job never reaches the native renderer.
verifyStagedInteriorProxyReviewClosure(authority, (path) => readFileSync(resolve(repo, path)));
const stageBytes = await fs.readFile(resolve(repo, authority.stageArtifact.path)),
  stage = validateBuildingStageArtifact(JSON.parse(stageBytes));
if (
  stage.kind !== "interior-plan" ||
  stage.status !== "draft" ||
  stage.revision !== authority.plan.revision ||
  stage.revision !== authority.stageArtifact.revision ||
  stage.artifactId !== authority.plan.planId ||
  stage.artifactId !== authority.stageArtifact.artifactId ||
  stage.contractHash !== authority.plan.canonicalHash ||
  stage.contentHash !== authority.plan.sha256 ||
  stage.evidence.length !== 0
)
  throw new Error("I1 authority stage-artifact closure drifted");
try {
  await fs.access(reviewRoot);
  throw new Error(`append-only I1 output already exists: ${relative(repo, reviewRoot)}`);
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
}
const [minimumWidth, minimumHeight] = authority.presentation.minimumResolution,
  expectedViews = "layout-top-down,entry-walkthrough";
if (
  minimumWidth < 1920 ||
  minimumHeight < 1080 ||
  authority.evidenceViews.map((view) => view.id).join(",") !== expectedViews ||
  authority.evidenceViews.length !== 2
)
  throw new Error("I1 authority lacks exactly the canonical two-view >=1920x1080 evidence set");
const fullscreen = process.env.LIMINA_NATIVE_CAPTURE_FULLSCREEN ?? "";
if (!["", "0", "1"].includes(fullscreen)) throw new Error("LIMINA_NATIVE_CAPTURE_FULLSCREEN must be 0 or 1");

await fs.access(binary);
const captureEnv = { ...process.env, LIMINA_ASSET_ROOT: repo, LIMINA_STAGED_INTERIOR_PROXY_AUTHORITY: authorityPath };
delete captureEnv.LIMINA_GPU_TIMESTAMP_RISK_ACK;
delete captureEnv.LIMINA_GPU_TIMESTAMP_MODE;
delete captureEnv.LIMINA_GPU_TIMESTAMP_QUERIES;
for (const key of Object.keys(captureEnv)) if (/TIMESTAMP/i.test(key)) delete captureEnv[key];
if (Object.keys(captureEnv).some((key) => /TIMESTAMP/i.test(key)))
  throw new Error("timestamp environment variables are forbidden for I1 capture");
await fs.unlink(tracePath).catch((error) => {
  if (error?.code !== "ENOENT") throw error;
});
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
  failureLabel: "native I1 proxy capture",
});

let traceBytes;
try {
  traceBytes = await fs.readFile(tracePath);
} finally {
  await fs.unlink(tracePath).catch((error) => {
    if (error?.code !== "ENOENT") throw error;
  });
}
const artifact = JSON.parse(traceBytes.toString("utf8")),
  rawHash = (bytes) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
  authoritySha = rawHash(authorityBytes);
if (
  artifact.schema !== "limina.staged-interior-proxy-native-review-set/v1" ||
  artifact.backend !== "native-webgpu" ||
  artifact.captureClass !== "production-engine" ||
  artifact.pixelFormat !== "rgba8unorm" ||
  artifact.rowOrigin !== "top-left" ||
  artifact.timingPolicy?.gpuTimestampMode !== "disabled" ||
  artifact.timingPolicy?.timestampQueriesEnabled !== false ||
  artifact.studio?.neutral !== true ||
  artifact.studio?.world !== "none" ||
  artifact.studio?.fixedTimeSeconds !== authority.presentation.fixedTimeSeconds ||
  artifact.authority?.path !== authorityPath ||
  artifact.authority?.sha256 !== authoritySha ||
  artifact.authority?.contentHash !== portableAssetContentHash(authorityBytes)
)
  throw new Error("I1 capture identity, neutral studio, or disabled-timestamp policy drifted");
const expectedSourcePaths = [
  "js/src/render/staged-interior-proxy-review-scene.ts",
  "js/src/demos/staged_interior_proxy_capture_window.ts",
  "tools/preview/run-native-staged-interior-proxy-capture.mjs",
];
if (
  !Array.isArray(artifact.source) ||
  artifact.source.map((entry) => entry.path).join(",") !== expectedSourcePaths.join(",")
)
  throw new Error("I1 capture lacks exact review implementation source closure");
for (const entry of artifact.source) {
  const bytes = await fs.readFile(resolve(repo, entry.path));
  if (rawHash(bytes) !== entry.sha256 || portableAssetContentHash(bytes) !== entry.contentHash)
    throw new Error(`I1 capture review implementation drifted: ${entry.path}`);
}
for (const key of [
  "approvedShell",
  "approvedMaterials",
  "derived",
  "plan",
  "stageArtifact",
  ...(authority.yawConventionMigration === undefined ? [] : ["yawConventionMigration"]),
])
  if (JSON.stringify(artifact[key]) !== JSON.stringify(authority[key]))
    throw new Error(`I1 capture ${key} closure drifted`);
if (
  !Number.isSafeInteger(artifact.mounted?.labelCount) ||
  artifact.mounted.labelCount < 1 ||
  !artifact.mounted?.inventory ||
  !Number.isSafeInteger(artifact.lifecycle?.baselineEntities) ||
  artifact.lifecycle.baselineEntities < 0 ||
  artifact.lifecycle.afterDisposeEntities !== artifact.lifecycle.baselineEntities
)
  throw new Error("I1 capture lacks exact proxy inventory, labels, or lifecycle return evidence");
if (
  !Array.isArray(artifact.captures) ||
  artifact.captures.length !== 2 ||
  artifact.captures.map((capture) => capture.id).join(",") !== expectedViews ||
  artifact.captures.some((capture, index) => {
    const view = authority.evidenceViews[index];
    return capture.role !== view.role || capture.shellVisible !== view.shellVisible || capture.proxiesVisible !== true;
  })
)
  throw new Error("I1 capture views are incomplete or mislabeled");

await fs.mkdir(reviewRoot, { recursive: true, mode: 0o700 });
await fs.chmod(reviewRoot, 0o700);
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
    throw new Error(`I1 ${capture.id} lacks strict whole-frame telemetry`);
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
    throw new Error(`I1 ${capture.id} lacks strict paired incremental telemetry`);
  const resourceValues =
    resources === undefined ? [] : [...Object.values(resources.counts ?? {}), ...Object.values(resources.bytes ?? {})];
  if (
    resources?.schema !== "limina.three-render-resources/v1" ||
    resources.source !== "three-webgpu-renderer-info" ||
    resources.scope !== "renderer-live-after-production-frame" ||
    resourceValues.length !== 12 ||
    resourceValues.some((entry) => !Number.isSafeInteger(entry) || entry < 0)
  )
    throw new Error(`I1 ${capture.id} lacks renderer resource telemetry`);
  const rgba = Buffer.from(capture.rgbaBase64, "base64");
  if (
    rgba.length !== capture.width * capture.height * 4 ||
    capture.rgbaByteLength !== rgba.length ||
    portableAssetContentHash(rgba) !== capture.rgbaContentHash
  )
    throw new Error(`I1 ${capture.id} pixels are invalid`);
  let clippedPixels = 0;
  const luma = [];
  for (let offset = 0; offset < rgba.length; offset += 4) {
    const red = rgba[offset],
      green = rgba[offset + 1],
      blue = rgba[offset + 2];
    if (Math.max(red, green, blue) === 255) clippedPixels++;
    luma.push(0.2126 * red + 0.7152 * green + 0.0722 * blue);
  }
  luma.sort((left, right) => left - right);
  const clippedFraction = clippedPixels / (capture.width * capture.height),
    p99Luma = luma[Math.floor(luma.length * 0.99)];
  if (clippedFraction > 0.02 || p99Luma > 250)
    throw new Error(
      `I1 ${capture.id} exposure is not reviewable: clipped=${clippedFraction.toFixed(4)} p99=${p99Luma.toFixed(2)}`,
    );
  const exposureEvidence = {
    schema: "limina.cpu-pixel-exposure/v1",
    clippedDefinition: "any RGB channel equals 255",
    clippedPixels,
    totalPixels: capture.width * capture.height,
    clippedFraction,
    p99Luma,
    limits: { clippedFraction: 0.02, p99Luma: 250 },
  };
  const path = resolve(reviewRoot, `${capture.id}.png`),
    pngBytes = await sharp(rgba, { raw: { width: capture.width, height: capture.height, channels: 4 } })
      .png({ compressionLevel: 9, adaptiveFiltering: true })
      .toBuffer();
  await fs.writeFile(path, pngBytes, { mode: 0o600, flag: "wx" });
  await fs.chmod(path, 0o600);
  outputs.push({
    id: capture.id,
    role: capture.role,
    shellVisible: capture.shellVisible,
    proxiesVisible: capture.proxiesVisible,
    path: relative(repo, path),
    width: capture.width,
    height: capture.height,
    timestamp: new Date().toISOString(),
    pngSha256: rawHash(pngBytes),
    pngByteLength: pngBytes.length,
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
await fs.writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600, flag: "wx" });
await fs.chmod(evidencePath, 0o600);
console.log(JSON.stringify({ schema: evidence.schema, authority: evidence.authority, outputs }, null, 2));
