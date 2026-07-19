import { createHash } from "node:crypto";
import { access, chmod, lstat, mkdir, readFile, rename, rm, unlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "../../js/node_modules/sharp/lib/index.js";
import {
  archiveGuardedCaptureSources,
  runGuardedCaptureWithSourceClosure,
  verifyGuardedCaptureEvidence,
} from "./guarded-capture-publication.mjs";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const binary = resolve(repo, "target/release/limina");
const modulePath = "js/src/demos/temperate_fidelity_capture_window.ts";
const tracePath = resolve(repo, "traces/temperate-fidelity-native-capture.json");
const output = resolve(
  repo,
  process.env.LIMINA_NATIVE_CAPTURE_OUTPUT ?? "assets/qc/internal/temperate-river-leading-line-native-candidate.png",
);
const privateRelative = relative(resolve(repo, "assets/qc/internal"), output);
if (!privateRelative || privateRelative === ".." || privateRelative.startsWith(`..${sep}`) || isAbsolute(privateRelative))
  throw new Error("temperate capture output escaped the private review root");
const reuseTrace = process.env.LIMINA_NATIVE_CAPTURE_REUSE_TRACE === "1";
if (reuseTrace)
  throw new Error("trace reuse cannot publish a new guarded temperate capture; use a fresh output and guarded run");
const outputStem = output.replace(/\.png$/i, ""),
  evidenceRoot = `${outputStem}.evidence`,
  evidenceStaging = `${evidenceRoot}.staging-${process.pid}`,
  absent = async (path, label) => {
    try {
      await lstat(path);
      throw new Error(`${label} already exists: ${relative(repo, path)}`);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  };
await absent(output, "temperate capture output");
await absent(evidenceRoot, "temperate capture evidence directory");
await absent(evidenceStaging, "temperate capture evidence staging directory");
const fullscreenSetting = process.env.LIMINA_NATIVE_CAPTURE_FULLSCREEN ?? "";
if (fullscreenSetting !== "" && fullscreenSetting !== "0" && fullscreenSetting !== "1") {
  throw new Error("LIMINA_NATIVE_CAPTURE_FULLSCREEN must be empty, '0', or '1'");
}
const fullscreen = fullscreenSetting === "1";
const authority = JSON.parse(await readFile(resolve(repo, "art-direction/temperate-fidelity-scene.json"), "utf8"));
const [minimumWidth, minimumHeight] = authority.presentation.minimumResolution;
await access(binary);
let captureSession;
{
  const captureArguments = [
    "--window",
    ...(fullscreen ? ["--fullscreen"] : []),
    "--width",
    String(minimumWidth),
    "--height",
    String(minimumHeight),
    "--frames",
    "1",
    modulePath,
  ];
  const captureEnvironment = {
    ...process.env,
    LIMINA_ASSET_ROOT: repo,
    // Fidelity capture never requests timestamp-query. Preserve an explicit caller preference,
    // otherwise let WebGPU select the machine's normal hardware adapter.
    LIMINA_GPU_POWER_PREFERENCE: process.env.LIMINA_GPU_POWER_PREFERENCE ?? "",
  };
  for (const key of Object.keys(captureEnvironment)) if (/TIMESTAMP/i.test(key)) delete captureEnvironment[key];
  captureSession = await runGuardedCaptureWithSourceClosure({
    repoRoot: repo,
    runnerUrl: import.meta.url,
    modulePath,
    command: binary,
    args: captureArguments,
    cwd: repo,
    environment: captureEnvironment,
    failureLabel: "native temperate fidelity capture",
  });
}

const artifact = JSON.parse(await readFile(tracePath, "utf8"));
if (
  artifact.schema !== "limina.temperate-fidelity-native-capture/v2" ||
  artifact.backend !== "native-webgpu" ||
  artifact.shot !== "river-leading-line"
) {
  throw new Error("native capture trace has the wrong schema, backend, or acceptance camera");
}
if (
  artifact.width < minimumWidth ||
  artifact.height < minimumHeight ||
  artifact.pixelFormat !== "rgba8unorm" ||
  artifact.rowOrigin !== "top-left"
) {
  throw new Error(`native capture trace violates the minimum ${minimumWidth}x${minimumHeight} canonical RGBA contract`);
}
const submission = artifact.renderSubmission;
if (
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
) {
  throw new Error("native capture trace is missing valid single-frame render submission telemetry");
}
const { width, height } = artifact;
const rgba = Buffer.from(artifact.rgbaBase64, "base64");
if (rgba.byteLength !== width * height * 4 || artifact.rgbaByteLength !== rgba.byteLength) {
  throw new Error("native capture trace has an invalid RGBA byte length");
}
// Limina's portable asset address intentionally hashes the lowercase hex encoding because the
// historical host op accepts strings. Verify that exact address, and record raw SHA-256 separately.
const rgbaContentHash = `sha256:${createHash("sha256").update(rgba.toString("hex")).digest("hex")}`;
const rgbaRawSha256 = createHash("sha256").update(rgba).digest("hex");
if (rgbaContentHash !== artifact.rgbaContentHash) {
  throw new Error(`native capture RGBA hash mismatch: ${rgbaContentHash} != ${artifact.rgbaContentHash}`);
}
await mkdir(dirname(output), { recursive: true, mode: 0o700 });
await mkdir(evidenceStaging, { recursive: false, mode: 0o700 });
await chmod(evidenceStaging, 0o700);
const publicationEvidence = await archiveGuardedCaptureSources({
    capture: captureSession,
    evidenceRoot: evidenceStaging,
  }),
  png = await sharp(rgba, { raw: { width, height, channels: 4 } })
    .png({ compressionLevel: 9, adaptiveFiltering: true })
    .toBuffer(),
  evidence = {
    ...artifact,
    rgbaBase64: undefined,
    ...publicationEvidence,
    sourceArchiveSidecar: {
      root: relative(repo, evidenceRoot),
      manifest: {
        ...publicationEvidence.sourceArchive.manifest,
        path: relative(repo, resolve(evidenceRoot, publicationEvidence.sourceArchive.manifest.path)),
      },
    },
    output: relative(repo, output),
    pngSha256: `sha256:${createHash("sha256").update(png).digest("hex")}`,
    pngByteLength: png.byteLength,
    rgbaContentHash,
    rgbaRawSha256,
  };
try {
  await writeFile(output, png, { flag: "wx", mode: 0o600 });
  await chmod(output, 0o600);
  await verifyGuardedCaptureEvidence({ capture: captureSession, evidenceRoot: evidenceStaging, evidence });
  await writeFile(resolve(evidenceStaging, "capture-evidence.json"), `${JSON.stringify(evidence, null, 2)}\n`, {
    flag: "wx",
    mode: 0o600,
  });
  await rename(evidenceStaging, evidenceRoot);
  await writeFile(tracePath, `${JSON.stringify(evidence)}\n`, { mode: 0o600 });
} catch (error) {
  await unlink(output).catch(() => {});
  await rm(evidenceStaging, { recursive: true, force: true });
  throw error;
}
console.log(
  JSON.stringify(
    {
      output,
      evidenceRoot: relative(repo, evidenceRoot),
      pngSha256: evidence.pngSha256,
      pngByteLength: png.byteLength,
      rgbaContentHash,
      rgbaRawSha256,
      adapter: artifact.adapter,
      resolution: [width, height],
      scene: artifact.scene,
      renderSubmission: submission,
      timingsMs: artifact.timingsMs,
      ...publicationEvidence,
    },
    null,
    2,
  ),
);
