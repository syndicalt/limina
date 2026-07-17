import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { access, mkdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "../../js/node_modules/sharp/lib/index.js";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const binary = resolve(repo, "target/release/limina");
const modulePath = "js/src/demos/temperate_fidelity_capture_window.ts";
const tracePath = resolve(repo, "traces/temperate-fidelity-native-capture.json");
const output = resolve(repo, process.env.LIMINA_NATIVE_CAPTURE_OUTPUT
  ?? "assets/qc/internal/temperate-river-leading-line-native-candidate.png");
const reuseTrace = process.env.LIMINA_NATIVE_CAPTURE_REUSE_TRACE === "1";
const fullscreenSetting = process.env.LIMINA_NATIVE_CAPTURE_FULLSCREEN ?? "";
if (fullscreenSetting !== "" && fullscreenSetting !== "0" && fullscreenSetting !== "1") {
  throw new Error("LIMINA_NATIVE_CAPTURE_FULLSCREEN must be empty, '0', or '1'");
}
const fullscreen = fullscreenSetting === "1";
const authority = JSON.parse(await readFile(resolve(repo, "art-direction/temperate-fidelity-scene.json"), "utf8"));
const [minimumWidth, minimumHeight] = authority.presentation.minimumResolution;
const XID = /(?:NVRM:\s*)?Xid\b|Xid \(PCI/i;

function bootKernelLog() {
  const result = spawnSync("journalctl", ["-k", "-b", "--no-pager", "-o", "cat"], {
    encoding: "utf8",
    timeout: 30_000,
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    throw new Error(`cannot establish the required Xid guard: ${result.error?.message ?? result.stderr ?? `journalctl exit ${result.status}`}`);
  }
  return result.stdout;
}

function runGuarded(command, args, env) {
  return new Promise((accept, reject) => {
    let xid = "";
    const monitor = spawn("journalctl", ["-k", "-f", "-n", "0", "--no-pager", "-o", "cat"], {
      cwd: repo,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const child = spawn(command, args, { cwd: repo, env, stdio: ["ignore", "pipe", "pipe"] });
    const inspect = (chunk) => {
      const text = String(chunk);
      if (!xid && XID.test(text)) {
        xid = text.trim();
        child.kill("SIGTERM");
      }
    };
    monitor.stdout.on("data", inspect);
    monitor.stderr.on("data", (chunk) => process.stderr.write(chunk));
    child.stdout.on("data", (chunk) => process.stdout.write(chunk));
    child.stderr.on("data", (chunk) => process.stderr.write(chunk));
    child.on("error", (error) => {
      monitor.kill("SIGTERM");
      reject(error);
    });
    child.on("exit", (code, signal) => {
      monitor.kill("SIGTERM");
      if (xid) reject(new Error(`NVIDIA Xid detected; capture stopped and must not be retried before reboot: ${xid}`));
      else if (code !== 0) reject(new Error(`native capture exited ${code ?? signal}`));
      else accept();
    });
  });
}

await access(binary);
const before = bootKernelLog();
if (XID.test(before)) {
  throw new Error("current boot already contains an NVIDIA Xid; reboot before any native capture retry");
}
if (!reuseTrace) {
  const captureArguments = [
    "--window",
    ...(fullscreen ? ["--fullscreen"] : []),
    "--width", String(minimumWidth),
    "--height", String(minimumHeight),
    "--frames", "1",
    modulePath,
  ];
  await runGuarded(binary, captureArguments, {
    ...process.env,
    LIMINA_ASSET_ROOT: repo,
    // Fidelity capture never requests timestamp-query. Preserve an explicit caller preference,
    // otherwise let WebGPU select the machine's normal hardware adapter.
    LIMINA_GPU_POWER_PREFERENCE: process.env.LIMINA_GPU_POWER_PREFERENCE ?? "",
  });
}
const after = bootKernelLog();
if (XID.test(after)) {
  throw new Error("NVIDIA Xid detected after capture; stop and reboot before any retry");
}

const artifact = JSON.parse(await readFile(tracePath, "utf8"));
if (artifact.schema !== "limina.temperate-fidelity-native-capture/v2"
    || artifact.backend !== "native-webgpu" || artifact.shot !== "river-leading-line") {
  throw new Error("native capture trace has the wrong schema, backend, or acceptance camera");
}
if (artifact.width < minimumWidth || artifact.height < minimumHeight
    || artifact.pixelFormat !== "rgba8unorm" || artifact.rowOrigin !== "top-left") {
  throw new Error(`native capture trace violates the minimum ${minimumWidth}x${minimumHeight} canonical RGBA contract`);
}
const submission = artifact.renderSubmission;
if (submission?.schema !== "limina.three-render-submission/v2"
    || submission.source !== "three-webgpu-renderer-info"
    || submission.scope !== "single-production-frame-all-passes"
    || submission.instanceAccounting !== "full-draw-instance-count"
    || !Number.isSafeInteger(submission.frameId) || submission.frameId < 1
    || !Number.isSafeInteger(submission.renderCalls) || submission.renderCalls <= 1
    || !Number.isSafeInteger(submission.drawCalls) || submission.drawCalls <= 1
    || !Number.isSafeInteger(submission.triangles) || submission.triangles <= 1
    || !Number.isFinite(submission.cpuEncodeMs) || submission.cpuEncodeMs < 0) {
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
await mkdir(dirname(output), { recursive: true });
await sharp(rgba, { raw: { width, height, channels: 4 } })
  .png({ compressionLevel: 9, adaptiveFiltering: true })
  .toFile(output);
const png = await readFile(output);
console.log(JSON.stringify({
  output,
  pngSha256: createHash("sha256").update(png).digest("hex"),
  pngByteLength: png.byteLength,
  rgbaContentHash,
  rgbaRawSha256,
  adapter: artifact.adapter,
  resolution: [width, height],
  scene: artifact.scene,
  renderSubmission: submission,
  timingsMs: artifact.timingsMs,
}, null, 2));
