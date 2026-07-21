import { createHash } from "node:crypto";
import { promises as fs, readFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "../../js/node_modules/sharp/lib/index.js";
import {
  validateBuildingCompositionReviewAuthority,
  verifyBuildingCompositionReviewClosure,
} from "../../js/src/render/building-composition-review-scene.ts";
import { portableAssetContentHash } from "../../js/src/world/asset-content-hash.mjs";
import {
  archiveGuardedCaptureSources,
  runGuardedCaptureWithSourceClosure,
  verifyGuardedCaptureEvidence,
} from "./guarded-capture-publication.mjs";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../.."),
  binary = resolve(repo, "target/release/limina"),
  modulePath = "js/src/demos/building_composition_capture_window.ts",
  tracePath = resolve(repo, "traces/building-composition-native-capture.json"),
  args = process.argv.slice(2),
  at = (flag) => {
    const index = args.indexOf(flag);
    if (index < 0 || !args[index + 1])
      throw new Error(
        "usage: bun tools/preview/run-native-building-composition-capture.mjs --authority <json> --out-dir <new-private-directory>",
      );
    return args[index + 1];
  },
  authorityAbsolute = resolve(repo, at("--authority")),
  authorityRelative = relative(repo, authorityAbsolute);
if (authorityRelative === ".." || authorityRelative.startsWith(`..${sep}`) || isAbsolute(authorityRelative))
  throw new Error("C1 authority escaped repository");
const authorityPath = authorityRelative.split(sep).join("/"),
  authorityBytes = await fs.readFile(authorityAbsolute),
  authority = validateBuildingCompositionReviewAuthority(JSON.parse(authorityBytes)),
  reviewRoot = resolve(repo, at("--out-dir")),
  internalRoot = resolve(repo, "assets/qc/internal/compositions"),
  reviewRelative = relative(internalRoot, reviewRoot);
if (!reviewRelative || reviewRelative === ".." || reviewRelative.startsWith(`..${sep}`) || isAbsolute(reviewRelative))
  throw new Error("C1 captures must remain in the private composition review directory");
verifyBuildingCompositionReviewClosure(authority, (path) => readFileSync(resolve(repo, path)));
try {
  await fs.access(reviewRoot);
  throw new Error(`append-only C1 output already exists: ${relative(repo, reviewRoot)}`);
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
}
const [minimumWidth, minimumHeight] = authority.presentation.minimumResolution,
  viewIds = "entry-circulation,dining-three-quarter,hearth-seating,service-storage,overall-room";
if (minimumWidth < 1920 || minimumHeight < 1080 || authority.evidenceViews.map((view) => view.id).join(",") !== viewIds)
  throw new Error("C1 authority lacks canonical five-view >=1920x1080 evidence");
const fullscreen = process.env.LIMINA_NATIVE_CAPTURE_FULLSCREEN ?? "";
if (!["", "0", "1"].includes(fullscreen)) throw new Error("LIMINA_NATIVE_CAPTURE_FULLSCREEN must be 0 or 1");
await fs.access(binary);
const captureEnv = {
  ...process.env,
  LIMINA_ASSET_ROOT: repo,
  LIMINA_BUILDING_COMPOSITION_REVIEW_AUTHORITY: authorityPath,
};
delete captureEnv.LIMINA_GPU_TIMESTAMP_RISK_ACK;
delete captureEnv.LIMINA_GPU_TIMESTAMP_MODE;
delete captureEnv.LIMINA_GPU_TIMESTAMP_QUERIES;
for (const key of Object.keys(captureEnv)) if (/TIMESTAMP/i.test(key)) delete captureEnv[key];
if (Object.keys(captureEnv).some((key) => /TIMESTAMP/i.test(key)))
  throw new Error("timestamp environment variables are forbidden for C1 capture");
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
    failureLabel: "native C1 capture",
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
  artifact.schema !== "limina.building-composition-native-review-set/v1" ||
  artifact.backend !== "native-webgpu" ||
  artifact.captureClass !== "production-engine" ||
  artifact.pixelFormat !== "rgba8unorm" ||
  artifact.rowOrigin !== "top-left" ||
  artifact.timingPolicy?.gpuTimestampMode !== "disabled" ||
  artifact.timingPolicy?.timestampQueriesEnabled !== false ||
  artifact.authority?.path !== authorityPath ||
  artifact.authority?.sha256 !== raw(authorityBytes) ||
  artifact.authority?.contentHash !== portableAssetContentHash(authorityBytes) ||
  JSON.stringify(artifact.manifest) !== JSON.stringify(authority.manifest) ||
  JSON.stringify(artifact.functionalEvidence) !== JSON.stringify(authority.functionalEvidence) ||
  JSON.stringify(artifact.integratedSource) !== JSON.stringify(authority.integratedSource)
)
  throw new Error("C1 capture identity or timestamp policy drifted");
const sourcePaths = [
  "js/src/render/building-composition-review-scene.ts",
  "js/src/demos/building_composition_capture_window.ts",
  "tools/preview/run-native-building-composition-capture.mjs",
];
if (!Array.isArray(artifact.source) || artifact.source.map((entry) => entry.path).join(",") !== sourcePaths.join(","))
  throw new Error("C1 capture lacks exact review source closure");
for (const entry of artifact.source) {
  const bytes = await fs.readFile(resolve(repo, entry.path));
  if (raw(bytes) !== entry.sha256 || portableAssetContentHash(bytes) !== entry.contentHash)
    throw new Error(`C1 review implementation drifted: ${entry.path}`);
}
if (
  artifact.mounted?.inventory?.instances !== 7 ||
  artifact.mounted?.instanceIds?.join(",") !==
    "instance/dining-table,instance/dining-chair-north,instance/dining-chair-south,instance/dining-chair-west,instance/dining-chair-east,instance/hearth-settle,instance/service-storage" ||
  !Number.isSafeInteger(artifact.mounted.inventory.colliders) ||
  artifact.mounted.inventory.colliders < 7 ||
  !Number.isSafeInteger(artifact.mounted.inventory.sockets) ||
  artifact.mounted.inventory.sockets < 7 ||
  !Number.isSafeInteger(artifact.lifecycle?.baselineEntities) ||
  artifact.lifecycle.afterDisposeEntities !== artifact.lifecycle.baselineEntities
)
  throw new Error("C1 capture lacks exact seven-instance lifecycle evidence");
if (
  !Array.isArray(artifact.captures) ||
  artifact.captures.length !== 5 ||
  artifact.captures.map((capture) => capture.id).join(",") !== viewIds
)
  throw new Error("C1 capture views are incomplete");
await fs.mkdir(reviewRoot, { recursive: true, mode: 0o700 });
await fs.chmod(reviewRoot, 0o700);
const publicationEvidence = await archiveGuardedCaptureSources({ capture: captureSession, evidenceRoot: reviewRoot });
const outputs = [];
for (const [index, capture] of artifact.captures.entries()) {
  const view = authority.evidenceViews[index],
    submission = capture.renderSubmission,
    paired = capture.pairedRenderSubmission,
    resources = capture.rendererResources;
  if (
    capture.role !== view.role ||
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
    throw new Error(`C1 ${capture.id} lacks whole-scene telemetry`);
  if (
    paired?.schema !== "limina.paired-render-submission/v1" ||
    paired.basis !== "same-process-fixed-camera-time-residency-post-visibility-toggle" ||
    paired.candidate?.frameId !== paired.baseline?.frameId + 1 ||
    paired.candidate?.drawCalls !== submission.drawCalls ||
    paired.candidate?.triangles !== submission.triangles ||
    paired.delta?.drawCalls !== paired.candidate.drawCalls - paired.baseline.drawCalls ||
    paired.delta?.triangles !== paired.candidate.triangles - paired.baseline.triangles ||
    !Number.isSafeInteger(paired.delta.drawCalls) ||
    paired.delta.drawCalls < 1 ||
    !Number.isSafeInteger(paired.delta.triangles) ||
    paired.delta.triangles < 1
  )
    throw new Error(`C1 ${capture.id} lacks strict furniture-delta telemetry`);
  const resourceValues =
    resources === undefined ? [] : [...Object.values(resources.counts ?? {}), ...Object.values(resources.bytes ?? {})];
  if (
    resources?.schema !== "limina.three-render-resources/v1" ||
    resources.source !== "three-webgpu-renderer-info" ||
    resources.scope !== "renderer-live-after-production-frame" ||
    resourceValues.length !== 12 ||
    resourceValues.some((value) => !Number.isSafeInteger(value) || value < 0)
  )
    throw new Error(`C1 ${capture.id} lacks renderer resource telemetry`);
  const rgba = Buffer.from(capture.rgbaBase64, "base64");
  if (
    rgba.length !== capture.width * capture.height * 4 ||
    capture.rgbaByteLength !== rgba.length ||
    portableAssetContentHash(rgba) !== capture.rgbaContentHash
  )
    throw new Error(`C1 ${capture.id} pixels are invalid`);
  let clippedPixels = 0;
  const luma = [];
  for (let offset = 0; offset < rgba.length; offset += 4) {
    const red = rgba[offset],
      green = rgba[offset + 1],
      blue = rgba[offset + 2];
    if (Math.max(red, green, blue) === 255) clippedPixels++;
    luma.push(0.2126 * red + 0.7152 * green + 0.0722 * blue);
  }
  luma.sort((a, b) => a - b);
  const clippedFraction = clippedPixels / (capture.width * capture.height),
    p99Luma = luma[Math.floor(luma.length * 0.99)];
  if (clippedFraction > 0.02 || p99Luma > 250)
    throw new Error(
      `C1 ${capture.id} exposure is not reviewable: clipped=${clippedFraction.toFixed(4)} p99=${p99Luma.toFixed(2)}`,
    );
  const png = await sharp(rgba, { raw: { width: capture.width, height: capture.height, channels: 4 } })
      .png({ compressionLevel: 9, adaptiveFiltering: true })
      .toBuffer(),
    output = resolve(reviewRoot, `${capture.id}.png`);
  await fs.writeFile(output, png, { mode: 0o600, flag: "wx" });
  outputs.push({
    id: capture.id,
    role: capture.role,
    path: relative(repo, output),
    width: capture.width,
    height: capture.height,
    pngSha256: raw(png),
    pngByteLength: png.length,
    rgbaContentHash: capture.rgbaContentHash,
    exposureEvidence: {
      schema: "limina.cpu-pixel-exposure/v1",
      clippedPixels,
      totalPixels: capture.width * capture.height,
      clippedFraction,
      p99Luma,
      limits: { clippedFraction: 0.02, p99Luma: 250 },
    },
    renderSubmission: submission,
    rendererResources: resources,
  });
}
const evidence = {
    ...artifact,
    captures: artifact.captures.map(({ rgbaBase64, ...capture }) => capture),
    ...publicationEvidence,
    outputs,
  },
  evidencePath = resolve(reviewRoot, "capture-evidence.json");
await verifyGuardedCaptureEvidence({ capture: captureSession, evidenceRoot: reviewRoot, evidence });
await fs.writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600, flag: "wx" });
console.log(JSON.stringify({ schema: evidence.schema, manifest: evidence.manifest, outputs }, null, 2));
