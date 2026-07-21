import { createHash } from "node:crypto";
import { access, chmod, lstat, mkdir, readFile, rename, rm, unlink, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "../../js/node_modules/sharp/lib/index.js";
import { portableAssetContentHash } from "../../js/src/world/asset-content-hash.mjs";
import {
  selectedFunctionalBuildingCycle,
  verifyFunctionalBuildingReferenceSources,
} from "../../js/src/assets/functional-building-iteration.mjs";
import {
  archiveGuardedCaptureSources,
  runGuardedCaptureWithSourceClosure,
  verifyGuardedCaptureEvidence,
} from "./guarded-capture-publication.mjs";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const binary = resolve(repo, "target/release/limina");
const modulePath = "js/src/demos/functional_cottage_capture_window.ts";
const tracePath = resolve(repo, "traces/functional-cottage-native-capture.json");
const outputPrefix = resolve(
  repo,
  (process.env.LIMINA_NATIVE_CAPTURE_OUTPUT ?? "assets/qc/internal/functional-cottage-hall-house-v4-native").replace(
    /\.png$/i,
    "",
  ),
);
const privateRelative = relative(resolve(repo, "assets/qc/internal"), outputPrefix);
if (!privateRelative || privateRelative === ".." || privateRelative.startsWith(`..${sep}`) || isAbsolute(privateRelative))
  throw new Error("functional cottage output escaped the private review root");
const evidenceRoot = `${outputPrefix}.evidence`;
const evidenceStaging = `${evidenceRoot}.staging-${process.pid}`;
const absent = async (path, label) => {
  try {
    await lstat(path);
    throw new Error(`${label} already exists: ${relative(repo, path)}`);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
};
await absent(evidenceRoot, "functional cottage evidence directory");
await absent(evidenceStaging, "functional cottage evidence staging directory");
const authorityBytes = await readFile(resolve(repo, "art-direction/functional-cottage-review-scene.json"));
const authority = JSON.parse(authorityBytes.toString("utf8"));
const iterationBytes = await readFile(resolve(repo, authority.iterationAuthority.path));
const iterationRawHash = `sha256:${createHash("sha256").update(iterationBytes).digest("hex")}`;
if (iterationRawHash !== authority.iterationAuthority.sha256)
  throw new Error("functional cottage iteration authority hash drifted");
const iterationManifest = JSON.parse(iterationBytes.toString("utf8"));
verifyFunctionalBuildingReferenceSources(
  iterationManifest,
  (path) => readFileSync(resolve(repo, path)),
  (bytes) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
);
const selectedIteration = selectedFunctionalBuildingCycle(iterationManifest);
if (
  selectedIteration.artifact.assetId !== authority.asset.assetId ||
  selectedIteration.artifact.rawSha256 !== authority.asset.sha256 ||
  selectedIteration.artifact.engineContentHash !== authority.asset.assetHash
)
  throw new Error("selected iteration does not match capture asset");
const [minimumWidth, minimumHeight] = authority.presentation.minimumResolution;
const fullscreenSetting = process.env.LIMINA_NATIVE_CAPTURE_FULLSCREEN ?? "";
if (fullscreenSetting !== "" && fullscreenSetting !== "0" && fullscreenSetting !== "1")
  throw new Error("LIMINA_NATIVE_CAPTURE_FULLSCREEN must be 0 or 1");
const fullscreen = fullscreenSetting === "1";
await access(binary);
const captureEnv = {
  ...process.env,
  LIMINA_ASSET_ROOT: repo,
  LIMINA_GPU_POWER_PREFERENCE: process.env.LIMINA_GPU_POWER_PREFERENCE ?? "",
};
delete captureEnv.LIMINA_GPU_TIMESTAMP_RISK_ACK;
delete captureEnv.LIMINA_GPU_TIMESTAMP_MODE;
delete captureEnv.LIMINA_GPU_TIMESTAMP_QUERIES;
for (const key of Object.keys(captureEnv)) if (/TIMESTAMP/i.test(key)) delete captureEnv[key];
const captureSession = await runGuardedCaptureWithSourceClosure({
  repoRoot: repo,
  runnerUrl: import.meta.url,
  modulePath,
  command: binary,
  args: [
    "--window",
    ...(fullscreen ? ["--fullscreen"] : []),
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
  failureLabel: "native functional cottage capture",
});

const artifact = JSON.parse(await readFile(tracePath, "utf8"));
if (
  artifact.schema !== "limina.functional-cottage-native-review-set/v2" ||
  artifact.primary !== "exterior-open" ||
  artifact.backend !== "native-webgpu" ||
  artifact.timingPolicy?.gpuTimestampMode !== "disabled" ||
  artifact.timingPolicy?.timestampQueriesEnabled !== false ||
  artifact.asset?.sha256 !== authority.asset.sha256 ||
  artifact.asset?.assetHash !== authority.asset.assetHash
) {
  throw new Error("functional cottage capture identity drifted");
}
if (
  artifact.authority?.path !== "art-direction/functional-cottage-review-scene.json" ||
  artifact.authority?.contentHash !== portableAssetContentHash(authorityBytes) ||
  JSON.stringify(artifact.generator) !== JSON.stringify(authority.generator) ||
  JSON.stringify(artifact.environmentAuthority) !== JSON.stringify(authority.environmentAuthority)
) {
  throw new Error("functional cottage capture source closure drifted");
}
if (
  JSON.stringify(artifact.iterationAuthority) !== JSON.stringify(authority.iterationAuthority) ||
  artifact.iteration?.selectedCycle !== selectedIteration.cycle ||
  artifact.iteration?.status !== selectedIteration.status
)
  throw new Error("functional cottage iteration provenance drifted");
if (artifact.functionalPlacement?.parts < 4) throw new Error("capture did not prove functional placement");
if (
  !Number.isSafeInteger(artifact.siteEvidence?.sampleCount) ||
  artifact.siteEvidence.sampleCount < 100 ||
  ![
    artifact.siteEvidence.terrainMinimum,
    artifact.siteEvidence.terrainMaximum,
    artifact.siteEvidence.terrainRelief,
    artifact.siteEvidence.rootY,
    artifact.siteEvidence.finishedFloorY,
    artifact.siteEvidence.terrainClearance,
  ].every(Number.isFinite) ||
  artifact.siteEvidence.terrainRelief < 0 ||
  artifact.siteEvidence.rootY + artifact.siteEvidence.finishedFloorY <
    artifact.siteEvidence.terrainMaximum + artifact.siteEvidence.terrainClearance - 1e-9 ||
  artifact.siteEvidence.ecologyExclusion !== "rotated-authored-footprint-before-population-mount"
) {
  throw new Error("functional cottage capture lacks authoritative site grading and ecology exclusion evidence");
}
if (
  artifact.lifecycleEvidence?.cycles !== 2 ||
  !Number.isSafeInteger(artifact.lifecycleEvidence.baselineEntities) ||
  artifact.lifecycleEvidence.baselineEntities < 0 ||
  !Array.isArray(artifact.lifecycleEvidence.afterDestroyEntities) ||
  artifact.lifecycleEvidence.afterDestroyEntities.length !== 2 ||
  artifact.lifecycleEvidence.afterDestroyEntities.some((count) => count !== artifact.lifecycleEvidence.baselineEntities)
) {
  throw new Error("functional cottage capture lacks repeated lifecycle entity-return evidence");
}
if (artifact.pixelFormat !== "rgba8unorm" || artifact.rowOrigin !== "top-left")
  throw new Error("functional cottage capture violates canonical pixel contract");
if (
  !Array.isArray(artifact.captures) ||
  artifact.captures.map((capture) => `${capture.id}:${capture.state}:${capture.role}`).join(",") !==
    "exterior-closed:closed:articulation-before,exterior-open:open:primary,threshold-detail:open:threshold-detail,interior-open:open:interior-traversal,hearth-detail:open:hearth-detail,lod-25m:closed:lod-proof" ||
  artifact.captures.map((capture) => `${capture.lodLevel}:${capture.distanceM}`).join(",") !==
    "0:18,0:18,0:3.58,0:5.25,0:2.31,1:25"
)
  throw new Error("functional cottage review set is incomplete or mislabeled");
for (const capture of artifact.captures) await absent(`${outputPrefix}-${capture.id}.png`, "functional cottage PNG");
await mkdir(dirname(evidenceRoot), { recursive: true, mode: 0o700 });
await mkdir(evidenceStaging, { recursive: false, mode: 0o700 });
await chmod(evidenceStaging, 0o700);
const publicationEvidence = await archiveGuardedCaptureSources({
  capture: captureSession,
  evidenceRoot: evidenceStaging,
});
const outputs = [],
  pendingOutputs = [];
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
    submission.renderCalls <= 1 ||
    !Number.isSafeInteger(submission.drawCalls) ||
    submission.drawCalls <= 1 ||
    !Number.isSafeInteger(submission.triangles) ||
    submission.triangles <= 1 ||
    !Number.isFinite(submission.cpuEncodeMs) ||
    submission.cpuEncodeMs < 0
  )
    throw new Error("functional cottage capture lacks whole-frame telemetry");
  const paired = capture.pairedRenderSubmission;
  if (
    paired?.schema !== "limina.paired-render-submission/v1" ||
    paired.basis !== "same-process-fixed-camera-time-residency-post-visibility-toggle" ||
    paired.baseline?.renderCalls !== 16 ||
    paired.candidate?.renderCalls !== 16 ||
    paired.candidate.frameId !== paired.baseline.frameId + 1 ||
    paired.candidate.drawCalls !== submission.drawCalls ||
    paired.candidate.triangles !== submission.triangles ||
    paired.delta?.renderCalls !== 0 ||
    paired.delta.drawCalls !== paired.candidate.drawCalls - paired.baseline.drawCalls ||
    paired.delta.triangles !== paired.candidate.triangles - paired.baseline.triangles ||
    !Number.isSafeInteger(paired.delta.drawCalls) ||
    paired.delta.drawCalls < 0 ||
    !Number.isSafeInteger(paired.delta.triangles) ||
    paired.delta.triangles < 0
  ) {
    throw new Error("functional cottage capture lacks strict paired incremental submission evidence");
  }
  const resources = capture.rendererResources;
  const resourceValues =
    resources === undefined ? [] : [...Object.values(resources.counts ?? {}), ...Object.values(resources.bytes ?? {})];
  if (
    resources?.schema !== "limina.three-render-resources/v1" ||
    resources.source !== "three-webgpu-renderer-info" ||
    resources.scope !== "renderer-live-after-production-frame" ||
    resourceValues.length !== 12 ||
    resourceValues.some((value) => !Number.isSafeInteger(value) || value < 0)
  ) {
    throw new Error("functional cottage capture lacks strict renderer resource telemetry");
  }
  const rgba = Buffer.from(capture.rgbaBase64, "base64");
  if (rgba.length !== capture.width * capture.height * 4 || capture.rgbaByteLength !== rgba.length)
    throw new Error("functional cottage capture has invalid RGBA bytes");
  const portableHash = `sha256:${createHash("sha256").update(rgba.toString("hex")).digest("hex")}`;
  if (portableHash !== capture.rgbaContentHash) throw new Error("functional cottage capture RGBA hash mismatch");
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
  const clippingLimit =
    capture.id === "interior-open" || capture.id === "hearth-detail"
      ? 0.01
      : capture.id === "threshold-detail"
        ? 0.03
        : 0.04;
  if (clippedFraction > clippingLimit || p99Luma > 250)
    throw new Error(
      `functional cottage ${capture.id} exposure is not reviewable: clipped=${clippedFraction.toFixed(4)} p99Luma=${p99Luma.toFixed(2)}`,
    );
  const exposureEvidence = {
    schema: "limina.cpu-pixel-exposure/v1",
    clippedDefinition: "any RGB channel equals 255",
    clippedPixels,
    totalPixels: capture.width * capture.height,
    clippedFraction,
    p99Luma,
    limits: { clippedFraction: clippingLimit, p99Luma: 250 },
  };
  const captureOutput = `${outputPrefix}-${capture.id}.png`;
  const png = await sharp(rgba, { raw: { width: capture.width, height: capture.height, channels: 4 } })
    .png({ compressionLevel: 9, adaptiveFiltering: true })
    .toBuffer();
  pendingOutputs.push({ path: captureOutput, png });
  const pngSha256 = createHash("sha256").update(png).digest("hex");
  outputs.push({
    id: capture.id,
    state: capture.state,
    role: capture.role,
    output: relative(repo, captureOutput),
    pngSha256: `sha256:${pngSha256}`,
    pngByteLength: png.length,
    rgbaContentHash: portableHash,
    exposureEvidence,
    renderSubmission: submission,
    pairedRenderSubmission: paired,
  });
}
const guardedArtifact = {
  ...artifact,
  ...publicationEvidence,
  sourceArchiveSidecar: {
    root: relative(repo, evidenceRoot),
    manifest: {
      ...publicationEvidence.sourceArchive.manifest,
      path: relative(repo, resolve(evidenceRoot, publicationEvidence.sourceArchive.manifest.path)),
    },
  },
  outputs: outputs.map(({ renderSubmission, pairedRenderSubmission, ...entry }) => entry),
};
try {
  for (const pending of pendingOutputs) {
    await writeFile(pending.path, pending.png, { flag: "wx", mode: 0o600 });
    await chmod(pending.path, 0o600);
  }
  await verifyGuardedCaptureEvidence({
    capture: captureSession,
    evidenceRoot: evidenceStaging,
    evidence: guardedArtifact,
  });
  await writeFile(resolve(evidenceStaging, "capture-evidence.json"), `${JSON.stringify(guardedArtifact, null, 2)}\n`, {
    flag: "wx",
    mode: 0o600,
  });
  await rename(evidenceStaging, evidenceRoot);
  await writeFile(tracePath, `${JSON.stringify(guardedArtifact)}\n`, { mode: 0o600 });
} catch (error) {
  for (const output of outputs) await unlink(resolve(repo, output.output)).catch(() => {});
  await rm(evidenceStaging, { recursive: true, force: true });
  throw error;
}
console.log(
  JSON.stringify(
    {
      schema: artifact.schema,
      primary: artifact.primary,
      adapter: artifact.adapter,
      asset: artifact.asset,
      functionalPlacement: artifact.functionalPlacement,
      lifecycleEvidence: artifact.lifecycleEvidence,
      outputs,
    },
    null,
    2,
  ),
);
