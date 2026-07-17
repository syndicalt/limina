import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "../../js/node_modules/sharp/lib/index.js";
import { portableAssetContentHash } from "../../js/src/world/asset-content-hash.mjs";
import { selectedFunctionalBuildingCycle, verifyFunctionalBuildingReferenceSources } from "../../js/src/assets/functional-building-iteration.mjs";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const binary = resolve(repo, "target/release/limina");
const modulePath = "js/src/demos/functional_cottage_capture_window.ts";
const tracePath = resolve(repo, "traces/functional-cottage-native-capture.json");
const outputPrefix = resolve(repo, (process.env.LIMINA_NATIVE_CAPTURE_OUTPUT ?? "assets/qc/internal/functional-cottage-hall-house-v4-native").replace(/\.png$/i, ""));
const authorityBytes = await readFile(resolve(repo, "art-direction/functional-cottage-review-scene.json"));
const authority = JSON.parse(authorityBytes.toString("utf8"));
const iterationBytes = await readFile(resolve(repo, authority.iterationAuthority.path));
const iterationRawHash = `sha256:${createHash("sha256").update(iterationBytes).digest("hex")}`;
if (iterationRawHash !== authority.iterationAuthority.sha256) throw new Error("functional cottage iteration authority hash drifted");
const iterationManifest = JSON.parse(iterationBytes.toString("utf8"));
verifyFunctionalBuildingReferenceSources(iterationManifest, (path) => readFileSync(resolve(repo, path)), (bytes) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`);
const selectedIteration = selectedFunctionalBuildingCycle(iterationManifest);
if (selectedIteration.artifact.assetId !== authority.asset.assetId || selectedIteration.artifact.rawSha256 !== authority.asset.sha256
    || selectedIteration.artifact.engineContentHash !== authority.asset.assetHash) throw new Error("selected iteration does not match capture asset");
const [minimumWidth, minimumHeight] = authority.presentation.minimumResolution;
const fullscreenSetting = process.env.LIMINA_NATIVE_CAPTURE_FULLSCREEN ?? "";
if (fullscreenSetting !== "" && fullscreenSetting !== "0" && fullscreenSetting !== "1") throw new Error("LIMINA_NATIVE_CAPTURE_FULLSCREEN must be 0 or 1");
const fullscreen = fullscreenSetting === "1";
const XID = /(?:NVRM:\s*)?Xid\b|Xid \(PCI/i;

function kernelLog() {
  const result = spawnSync("journalctl", ["-k", "-b", "--no-pager", "-o", "cat"], { encoding: "utf8", timeout: 30_000, maxBuffer: 32 * 1024 * 1024 });
  if (result.error || result.status !== 0) throw new Error(`cannot establish the required Xid guard: ${result.error?.message ?? result.stderr ?? `journalctl exit ${result.status}`}`);
  return result.stdout;
}
function runGuarded(command, args, env) {
  return new Promise((accept, reject) => {
    let guardFailure = "";
    const monitor = spawn("journalctl", ["-k", "-f", "-n", "0", "--no-pager", "-o", "cat"], { cwd: repo, stdio: ["ignore", "pipe", "pipe"] });
    const child = spawn(command, args, { cwd: repo, env, stdio: ["ignore", "pipe", "pipe"] });
    const stopForGuard = (message) => { if (!guardFailure) { guardFailure = message; child.kill("SIGTERM"); } };
    monitor.stdout.on("data", (chunk) => { const line = String(chunk); if (XID.test(line)) stopForGuard(`NVIDIA Xid detected; capture stopped and must not be retried before reboot: ${line.trim()}`); });
    monitor.stderr.on("data", (chunk) => process.stderr.write(chunk));
    monitor.on("error", (error) => stopForGuard(`live Xid monitor failed: ${error.message}`));
    // The follower and a bounded full-boot poll are intentionally redundant. Polling closes the
    // journal-follower startup race: an Xid between process spawn and follow attachment still kills
    // the child on the next 250 ms audit, while pre/postflight retain the complete-boot backstop.
    const poll = setInterval(() => { try { const event = kernelLog().split(/\r?\n/).find((line) => XID.test(line)); if (event) stopForGuard(`NVIDIA Xid detected; capture stopped and must not be retried before reboot: ${event.trim()}`); } catch (error) { stopForGuard(`live Xid polling failed: ${error instanceof Error ? error.message : String(error)}`); } }, 250);
    child.stdout.on("data", (chunk) => process.stdout.write(chunk)); child.stderr.on("data", (chunk) => process.stderr.write(chunk));
    child.on("error", (error) => { clearInterval(poll); monitor.kill("SIGTERM"); reject(error); });
    child.on("exit", (code, signal) => { clearInterval(poll); monitor.kill("SIGTERM"); if (guardFailure) reject(new Error(guardFailure)); else if (code !== 0) reject(new Error(`native capture exited ${code ?? signal}`)); else accept(); });
  });
}

await access(binary);
const bootId = (await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim();
const preflightKernelLog = kernelLog();
if (XID.test(preflightKernelLog)) throw new Error("current boot already contains an NVIDIA Xid; reboot before any native capture retry");
const captureEnv = {
  ...process.env, LIMINA_ASSET_ROOT: repo, LIMINA_GPU_POWER_PREFERENCE: process.env.LIMINA_GPU_POWER_PREFERENCE ?? "",
};
delete captureEnv.LIMINA_GPU_TIMESTAMP_RISK_ACK;
delete captureEnv.LIMINA_GPU_TIMESTAMP_MODE;
await runGuarded(binary, ["--window", ...(fullscreen ? ["--fullscreen"] : []), "--width", String(minimumWidth), "--height", String(minimumHeight), "--frames", "1", modulePath], captureEnv);
const postflightKernelLog = kernelLog();
if (XID.test(postflightKernelLog)) throw new Error("NVIDIA Xid detected after capture; stop and reboot before any retry");

const artifact = JSON.parse(await readFile(tracePath, "utf8"));
if (artifact.schema !== "limina.functional-cottage-native-review-set/v2" || artifact.primary !== "exterior-open" || artifact.backend !== "native-webgpu"
  || artifact.timingPolicy?.gpuTimestampMode !== "disabled" || artifact.timingPolicy?.timestampQueriesEnabled !== false
  || artifact.asset?.sha256 !== authority.asset.sha256 || artifact.asset?.assetHash !== authority.asset.assetHash) {
  throw new Error("functional cottage capture identity drifted");
}
if (artifact.authority?.path !== "art-direction/functional-cottage-review-scene.json"
  || artifact.authority?.contentHash !== portableAssetContentHash(authorityBytes)
  || JSON.stringify(artifact.generator) !== JSON.stringify(authority.generator)
  || JSON.stringify(artifact.environmentAuthority) !== JSON.stringify(authority.environmentAuthority)) {
  throw new Error("functional cottage capture source closure drifted");
}
if (JSON.stringify(artifact.iterationAuthority) !== JSON.stringify(authority.iterationAuthority)
  || artifact.iteration?.selectedCycle !== selectedIteration.cycle || artifact.iteration?.status !== selectedIteration.status) throw new Error("functional cottage iteration provenance drifted");
if (artifact.functionalPlacement?.parts < 4) throw new Error("capture did not prove functional placement");
if (!Number.isSafeInteger(artifact.siteEvidence?.sampleCount) || artifact.siteEvidence.sampleCount < 100
  || ![artifact.siteEvidence.terrainMinimum, artifact.siteEvidence.terrainMaximum, artifact.siteEvidence.terrainRelief,
    artifact.siteEvidence.rootY, artifact.siteEvidence.finishedFloorY, artifact.siteEvidence.terrainClearance].every(Number.isFinite)
  || artifact.siteEvidence.terrainRelief < 0
  || artifact.siteEvidence.rootY + artifact.siteEvidence.finishedFloorY
    < artifact.siteEvidence.terrainMaximum + artifact.siteEvidence.terrainClearance - 1e-9
  || artifact.siteEvidence.ecologyExclusion !== "rotated-authored-footprint-before-population-mount") {
  throw new Error("functional cottage capture lacks authoritative site grading and ecology exclusion evidence");
}
if (artifact.lifecycleEvidence?.cycles !== 2
  || !Number.isSafeInteger(artifact.lifecycleEvidence.baselineEntities)
  || artifact.lifecycleEvidence.baselineEntities < 0
  || !Array.isArray(artifact.lifecycleEvidence.afterDestroyEntities)
  || artifact.lifecycleEvidence.afterDestroyEntities.length !== 2
  || artifact.lifecycleEvidence.afterDestroyEntities.some((count) => count !== artifact.lifecycleEvidence.baselineEntities)) {
  throw new Error("functional cottage capture lacks repeated lifecycle entity-return evidence");
}
if (artifact.pixelFormat !== "rgba8unorm" || artifact.rowOrigin !== "top-left") throw new Error("functional cottage capture violates canonical pixel contract");
if (!Array.isArray(artifact.captures) || artifact.captures.map((capture) => `${capture.id}:${capture.state}:${capture.role}`).join(",")
    !== "exterior-closed:closed:articulation-before,exterior-open:open:primary,threshold-detail:open:threshold-detail,interior-open:open:interior-traversal,hearth-detail:open:hearth-detail,lod-25m:closed:lod-proof"
    || artifact.captures.map((capture) => `${capture.lodLevel}:${capture.distanceM}`).join(",") !== "0:18,0:18,0:3.58,0:5.25,0:2.31,1:25") throw new Error("functional cottage review set is incomplete or mislabeled");
const outputs = [];
for (const capture of artifact.captures) {
const submission = capture.renderSubmission;
if (capture.width < minimumWidth || capture.height < minimumHeight || capture.surfaceFormat !== artifact.surfaceFormat
  || submission?.schema !== "limina.three-render-submission/v2"
  || submission.source !== "three-webgpu-renderer-info"
  || submission.scope !== "single-production-frame-all-passes"
  || submission.instanceAccounting !== "full-draw-instance-count"
  || !Number.isSafeInteger(submission.frameId) || submission.frameId < 1
  || !Number.isSafeInteger(submission.renderCalls) || submission.renderCalls <= 1
  || !Number.isSafeInteger(submission.drawCalls) || submission.drawCalls <= 1
  || !Number.isSafeInteger(submission.triangles) || submission.triangles <= 1
  || !Number.isFinite(submission.cpuEncodeMs) || submission.cpuEncodeMs < 0) throw new Error("functional cottage capture lacks whole-frame telemetry");
const paired = capture.pairedRenderSubmission;
if (paired?.schema !== "limina.paired-render-submission/v1"
  || paired.basis !== "same-process-fixed-camera-time-residency-post-visibility-toggle"
  || paired.baseline?.renderCalls !== 16 || paired.candidate?.renderCalls !== 16
  || paired.candidate.frameId !== paired.baseline.frameId + 1
  || paired.candidate.drawCalls !== submission.drawCalls || paired.candidate.triangles !== submission.triangles
  || paired.delta?.renderCalls !== 0
  || paired.delta.drawCalls !== paired.candidate.drawCalls - paired.baseline.drawCalls
  || paired.delta.triangles !== paired.candidate.triangles - paired.baseline.triangles
  || !Number.isSafeInteger(paired.delta.drawCalls) || paired.delta.drawCalls < 0
  || !Number.isSafeInteger(paired.delta.triangles) || paired.delta.triangles < 0) {
  throw new Error("functional cottage capture lacks strict paired incremental submission evidence");
}
const resources = capture.rendererResources;
const resourceValues = resources === undefined ? [] : [...Object.values(resources.counts ?? {}), ...Object.values(resources.bytes ?? {})];
if (resources?.schema !== "limina.three-render-resources/v1"
  || resources.source !== "three-webgpu-renderer-info"
  || resources.scope !== "renderer-live-after-production-frame"
  || resourceValues.length !== 12
  || resourceValues.some((value) => !Number.isSafeInteger(value) || value < 0)) {
  throw new Error("functional cottage capture lacks strict renderer resource telemetry");
}
const rgba = Buffer.from(capture.rgbaBase64, "base64");
if (rgba.length !== capture.width * capture.height * 4 || capture.rgbaByteLength !== rgba.length) throw new Error("functional cottage capture has invalid RGBA bytes");
const portableHash = `sha256:${createHash("sha256").update(rgba.toString("hex")).digest("hex")}`;
if (portableHash !== capture.rgbaContentHash) throw new Error("functional cottage capture RGBA hash mismatch");
let clippedPixels=0;const luma=[];
for(let offset=0;offset<rgba.length;offset+=4){const red=rgba[offset],green=rgba[offset+1],blue=rgba[offset+2];if(Math.max(red,green,blue)===255)clippedPixels++;luma.push(.2126*red+.7152*green+.0722*blue);}
luma.sort((a,b)=>a-b);const clippedFraction=clippedPixels/(capture.width*capture.height),p99Luma=luma[Math.floor(luma.length*.99)];
const clippingLimit = (capture.id === "interior-open" || capture.id === "hearth-detail")
  ? 0.01
  : capture.id === "threshold-detail" ? 0.03 : 0.04;
if(clippedFraction>clippingLimit||p99Luma>250)throw new Error(`functional cottage ${capture.id} exposure is not reviewable: clipped=${clippedFraction.toFixed(4)} p99Luma=${p99Luma.toFixed(2)}`);
const exposureEvidence={schema:"limina.cpu-pixel-exposure/v1",clippedDefinition:"any RGB channel equals 255",clippedPixels,totalPixels:capture.width*capture.height,clippedFraction,p99Luma,limits:{clippedFraction:clippingLimit,p99Luma:250}};
const captureOutput = `${outputPrefix}-${capture.id}.png`;
await mkdir(dirname(captureOutput), { recursive: true });
await sharp(rgba, { raw: { width: capture.width, height: capture.height, channels: 4 } }).png({ compressionLevel: 9, adaptiveFiltering: true }).toFile(captureOutput);
const png = await readFile(captureOutput); const pngSha256 = createHash("sha256").update(png).digest("hex");
outputs.push({ id: capture.id, state: capture.state, role: capture.role, output: relative(repo, captureOutput), pngSha256: `sha256:${pngSha256}`, pngByteLength: png.length, rgbaContentHash: portableHash, exposureEvidence, renderSubmission: submission, pairedRenderSubmission: paired });
}
const guardedArtifact = {
  ...artifact,
  guardEvidence: {
    schema: "limina.nvidia-xid-guard/v1", bootId,
    preflight: { source: "journalctl-kernel-current-boot", xidObserved: false },
    live: { follower: "journalctl-kernel-follow", redundantPollMs: 250, xidObserved: false },
    postflight: { source: "journalctl-kernel-current-boot", xidObserved: false },
  },
  outputs: outputs.map(({ renderSubmission, pairedRenderSubmission, ...entry }) => entry),
};
await writeFile(tracePath, `${JSON.stringify(guardedArtifact)}\n`);
console.log(JSON.stringify({ schema: artifact.schema, primary: artifact.primary, adapter: artifact.adapter, asset: artifact.asset, functionalPlacement: artifact.functionalPlacement, lifecycleEvidence: artifact.lifecycleEvidence, outputs }, null, 2));
