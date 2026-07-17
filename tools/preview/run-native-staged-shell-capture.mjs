import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { access, chmod, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "../../js/node_modules/sharp/lib/index.js";
import { parseFunctionalBuildingContract } from "../../js/src/assets/functional-building-contract.ts";
import { portableAssetContentHash } from "../../js/src/world/asset-content-hash.mjs";
import { validateBuildingStageArtifact } from "../../js/src/assets/staged-building-pipeline.mjs";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const binary = resolve(repo, "target/release/limina");
const modulePath = "js/src/demos/staged_shell_capture_window.ts";
const tracePath = resolve(repo, "traces/staged-shell-native-capture.json");
const args=process.argv.slice(2),value=(flag,fallback)=>{const index=args.indexOf(flag);if(index>=0&&!args[index+1])throw new Error(`missing value for ${flag}`);return index<0?fallback:args[index+1];};
const defaultAuthorityPath = "assets/buildings/authoring/functional-hall-house-v4/shell-review-authority.json";
const defaultReviewPath = "assets/qc/internal/shell/functional-hall-house-v4/a1-r2";
const authorityArgument=value("--authority",defaultAuthorityPath),reviewArgument=value("--out-dir",defaultReviewPath);
const authorityAbsolute=resolve(repo,authorityArgument),authorityRelative=relative(repo,authorityAbsolute);
if(authorityRelative.startsWith(`..${sep}`)||authorityRelative===".."||isAbsolute(authorityRelative))throw new Error("staged shell authority escaped the repository root");
const authorityPath=authorityRelative.split(sep).join("/");
const reviewDirectory = resolve(repo, reviewArgument);
const privateRoot = resolve(repo, "assets/qc/internal/shell");
const privateRelative=relative(privateRoot,reviewDirectory);
if (privateRelative.startsWith(`..${sep}`)||privateRelative===".."||isAbsolute(privateRelative)) throw new Error("staged shell output escaped its private review root");
const authorityBytes = await readFile(authorityAbsolute);
const authority = JSON.parse(authorityBytes.toString("utf8"));
const rawHash = (bytes) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const exactFile = async (path, expected, label) => { const bytes=await readFile(resolve(repo,path));if(rawHash(bytes)!==expected)throw new Error(`staged shell ${label} hash drifted`);return bytes; };
const artifactBytes=await exactFile(authority.artifact.path,authority.artifact.sha256,"draft artifact"),draft=validateBuildingStageArtifact(JSON.parse(artifactBytes));
if(draft.kind!=="shell"||draft.status!=="draft"||draft.artifactId!==authority.artifact.artifactId||draft.contractHash!==authority.artifact.contractHash||draft.contentHash!==authority.asset.sha256||draft.evidence.length!==0)throw new Error("staged shell draft artifact closure drifted");
const appendOnly=draft.revision>1;
if(appendOnly&&!args.includes("--out-dir"))throw new Error("revised staged shell capture requires an explicit fresh --out-dir");
if(appendOnly){try{await access(reviewDirectory);throw new Error(`revised staged shell output already exists: ${relative(repo,reviewDirectory)}`);}catch(error){if(error?.code!=="ENOENT")throw error;}}
const buildEvidenceBytes=await exactFile(authority.buildEvidence.path,authority.buildEvidence.sha256,"build evidence"),buildEvidence=JSON.parse(buildEvidenceBytes);
const functionalKeys=["buildingId","doors","colliders","rooms","portals"];
if(buildEvidence.schema!=="limina.building-shell-build-evidence/v1"||buildEvidence.asset?.sha256!==authority.asset.sha256||buildEvidence.sourceBlend?.sha256!==authority.source.blendSha256||buildEvidence.shellPayloadHash!==authority.artifact.contractHash||functionalKeys.some(key=>buildEvidence.functional?.[key]!==authority.functional?.[key])||Object.values(buildEvidence.exclusions??{}).some(value=>value!==true))throw new Error("staged shell build evidence closure drifted");
await exactFile(authority.source.blendPath,authority.source.blendSha256,"source blend");
await exactFile(authority.source.buildToolPath,authority.source.buildToolSha256,"build tool");
await exactFile(authority.source.adapterPath,authority.source.adapterSha256,"Blender adapter");
await exactFile(authority.environment.authorityPath,authority.environment.authoritySha256,"temperate authority");
await exactFile(authority.environment.bundlePath,authority.environment.bundleSha256,"temperate runtime bundle");
const assetBytes=await exactFile(`assets/${authority.asset.assetId}`,authority.asset.sha256,"runtime GLB");
if(portableAssetContentHash(assetBytes)!==authority.asset.assetHash)throw new Error("staged shell portable asset hash drifted");
const buildingContract=parseFunctionalBuildingContract(assetBytes);
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
const preflightXid=preflightKernelLog.split(/\r?\n/).find(line=>XID.test(line));
if (preflightXid) throw new Error(`current boot already contains an NVIDIA Xid; reboot before any native capture retry: ${preflightXid.trim()}`);
const captureEnv = {
  ...process.env, LIMINA_ASSET_ROOT: repo, LIMINA_GPU_POWER_PREFERENCE: process.env.LIMINA_GPU_POWER_PREFERENCE ?? "", LIMINA_STAGED_SHELL_AUTHORITY: authorityPath,
};
delete captureEnv.LIMINA_GPU_TIMESTAMP_RISK_ACK;
delete captureEnv.LIMINA_GPU_TIMESTAMP_MODE;
delete captureEnv.LIMINA_GPU_TIMESTAMP_QUERIES;
await runGuarded(binary, ["--window", ...(fullscreen ? ["--fullscreen"] : []), "--width", String(minimumWidth), "--height", String(minimumHeight), "--frames", "1", modulePath], captureEnv);
const postflightKernelLog = kernelLog();
const postflightXid=postflightKernelLog.split(/\r?\n/).find(line=>XID.test(line));
if (postflightXid) throw new Error(`NVIDIA Xid detected after capture; stop and reboot before any retry: ${postflightXid.trim()}`);

const traceBytes=await readFile(tracePath);await unlink(tracePath);const artifact = JSON.parse(traceBytes.toString("utf8"));
if (artifact.schema !== "limina.staged-shell-native-review-set/v1" || artifact.primary !== "exterior-open" || artifact.backend !== "native-webgpu" || artifact.captureClass !== "production-engine"
  || artifact.timingPolicy?.gpuTimestampMode !== "disabled" || artifact.timingPolicy?.timestampQueriesEnabled !== false
  || artifact.asset?.sha256 !== authority.asset.sha256 || artifact.asset?.assetHash !== authority.asset.assetHash) {
  throw new Error("staged shell capture identity drifted");
}
if (artifact.authority?.path !== authorityPath || artifact.authority?.sha256 !== rawHash(authorityBytes)
  || artifact.authority?.contentHash !== portableAssetContentHash(authorityBytes)
  || artifact.artifact?.path !== authority.artifact.path || artifact.artifact?.sha256 !== authority.artifact.sha256
  || artifact.artifact?.portableContentHash !== portableAssetContentHash(artifactBytes) || artifact.artifact?.status !== "draft"
  || JSON.stringify(artifact.buildEvidence) !== JSON.stringify(authority.buildEvidence)
  || JSON.stringify(artifact.source) !== JSON.stringify(authority.source)
  || JSON.stringify(artifact.environmentAuthority) !== JSON.stringify(authority.environment)) {
  throw new Error("staged shell capture source closure drifted");
}
if (artifact.functionalPlacement?.parts !== authority.functional.colliders || typeof artifact.functionalPlacement?.door !== "string"
  || functionalKeys.some(key=>artifact.functionalInventory?.[key]!==authority.functional?.[key])
  || artifact.exclusions?.furniture!==true||artifact.exclusions?.domesticProps!==true||artifact.exclusions?.fireVisuals!==true||artifact.exclusions?.practicalLights!==true
  || artifact.renderPolicy?.level !== "source-lod0" || artifact.renderPolicy?.reason !== "exact-staged-shell-has-no-packaged-lod-roots") throw new Error("capture did not prove exact functional shell placement and exclusions");
if (!Number.isSafeInteger(artifact.siteEvidence?.sampleCount) || artifact.siteEvidence.sampleCount < 100
  || ![artifact.siteEvidence.terrainMinimum, artifact.siteEvidence.terrainMaximum, artifact.siteEvidence.terrainRelief,
    artifact.siteEvidence.rootY, artifact.siteEvidence.finishedFloorY, artifact.siteEvidence.terrainClearance].every(Number.isFinite)
  || artifact.siteEvidence.terrainRelief < 0
  || Math.abs(artifact.siteEvidence.terrainRelief-(artifact.siteEvidence.terrainMaximum-artifact.siteEvidence.terrainMinimum))>1e-9
  || Math.abs(artifact.siteEvidence.rootY+artifact.siteEvidence.finishedFloorY-artifact.siteEvidence.terrainMaximum-artifact.siteEvidence.terrainClearance)>1e-9
  || artifact.siteEvidence.ecologyExclusion !== "rotated-authored-footprint-before-population-mount") {
  throw new Error("staged shell capture lacks authoritative site grading and ecology exclusion evidence");
}
const supportPolicy=buildingContract.site?.entranceSupport;
if((supportPolicy===undefined)!==(artifact.siteEvidence?.entranceSupport===undefined))throw new Error("staged shell capture entrance-support presence drifted from its asset contract");
if(supportPolicy){
  const support=artifact.siteEvidence?.entranceSupport;
  if(!Number.isSafeInteger(support?.sampleCount)||support.sampleCount<4
    ||![support.terrainMinimum,support.terrainMaximum,support.terrainVariation,support.worldGradeY,support.fillDepth,support.cutDepth].every(Number.isFinite)
    ||support.terrainVariation<0||support.fillDepth<0||support.cutDepth<0
    ||Math.abs(support.terrainVariation-(support.terrainMaximum-support.terrainMinimum))>1e-9
    ||Math.abs(support.fillDepth-Math.max(0,support.worldGradeY-support.terrainMinimum))>1e-9
    ||Math.abs(support.cutDepth-Math.max(0,support.terrainMaximum-support.worldGradeY))>1e-9
    ||support.terrainVariation>supportPolicy.maximumVariation+1e-9
    ||support.fillDepth>supportPolicy.bearingDepth+1e-9
    ||support.cutDepth>supportPolicy.maximumCutDepth+1e-9
    ||Math.abs(support.worldGradeY-(artifact.siteEvidence.rootY+supportPolicy.exteriorGradeY))>1e-9){
    throw new Error("staged shell capture lacks buildable authored entrance-support evidence");
  }
}
if (artifact.lifecycleEvidence?.cycles !== 2
  || !Number.isSafeInteger(artifact.lifecycleEvidence.baselineEntities)
  || artifact.lifecycleEvidence.baselineEntities < 0
  || !Array.isArray(artifact.lifecycleEvidence.afterDestroyEntities)
  || artifact.lifecycleEvidence.afterDestroyEntities.length !== 2
  || artifact.lifecycleEvidence.afterDestroyEntities.some((count) => count !== artifact.lifecycleEvidence.baselineEntities)) {
  throw new Error("staged shell capture lacks repeated lifecycle entity-return evidence");
}
if (artifact.pixelFormat !== "rgba8unorm" || artifact.rowOrigin !== "top-left") throw new Error("staged shell capture violates canonical pixel contract");
if (!Array.isArray(artifact.captures) || artifact.captures.length!==authority.evidenceViews.length
    || artifact.captures.some((capture,index)=>{const view=authority.evidenceViews[index];return capture.id!==view.id||capture.state!==view.state||capture.role!==view.role||capture.renderLevel!==view.renderLevel||capture.distanceM!==view.distanceM;})) throw new Error("staged shell review set does not match its authority");
if(artifact.captures[0].rgbaContentHash===artifact.captures[1].rgbaContentHash)throw new Error("staged shell closed/open exterior proof is visually identical");
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
  || !Number.isFinite(submission.cpuEncodeMs) || submission.cpuEncodeMs < 0) throw new Error("staged shell capture lacks whole-frame telemetry");
const paired = capture.pairedRenderSubmission;
if (paired?.schema !== "limina.paired-render-submission/v1"
  || paired.basis !== "same-process-fixed-camera-time-residency-post-visibility-toggle"
  || paired.baseline?.renderCalls !== 16 || paired.candidate?.renderCalls !== 16
  || paired.candidate.frameId !== paired.baseline.frameId + 1
  || paired.candidate.drawCalls !== submission.drawCalls || paired.candidate.triangles !== submission.triangles
  || paired.delta?.renderCalls !== 0
  || paired.delta.drawCalls !== paired.candidate.drawCalls - paired.baseline.drawCalls
  || paired.delta.triangles !== paired.candidate.triangles - paired.baseline.triangles
  || !Number.isSafeInteger(paired.delta.drawCalls) || paired.delta.drawCalls < 1
  || !Number.isSafeInteger(paired.delta.triangles) || paired.delta.triangles < 1) {
  throw new Error("staged shell capture lacks strict paired incremental submission evidence");
}
const resources = capture.rendererResources;
const resourceValues = resources === undefined ? [] : [...Object.values(resources.counts ?? {}), ...Object.values(resources.bytes ?? {})];
if (resources?.schema !== "limina.three-render-resources/v1"
  || resources.source !== "three-webgpu-renderer-info"
  || resources.scope !== "renderer-live-after-production-frame"
  || resourceValues.length !== 12
  || resourceValues.some((value) => !Number.isSafeInteger(value) || value < 0)) {
  throw new Error("staged shell capture lacks strict renderer resource telemetry");
}
const rgba = Buffer.from(capture.rgbaBase64, "base64");
if (rgba.length !== capture.width * capture.height * 4 || capture.rgbaByteLength !== rgba.length) throw new Error("staged shell capture has invalid RGBA bytes");
const portableHash = `sha256:${createHash("sha256").update(rgba.toString("hex")).digest("hex")}`;
if (portableHash !== capture.rgbaContentHash) throw new Error("staged shell capture RGBA hash mismatch");
let clippedPixels=0;const luma=[];
for(let offset=0;offset<rgba.length;offset+=4){const red=rgba[offset],green=rgba[offset+1],blue=rgba[offset+2];if(Math.max(red,green,blue)===255)clippedPixels++;luma.push(.2126*red+.7152*green+.0722*blue);}
luma.sort((a,b)=>a-b);const clippedFraction=clippedPixels/(capture.width*capture.height),p99Luma=luma[Math.floor(luma.length*.99)];
const clippingLimit = (capture.id === "empty-interior-traversal" || capture.id === "hearth-structure")
  ? 0.01
  : capture.id === "threshold-stair-grade" ? 0.03 : 0.04;
if(clippedFraction>clippingLimit||p99Luma>250)throw new Error(`staged shell ${capture.id} exposure is not reviewable: clipped=${clippedFraction.toFixed(4)} p99Luma=${p99Luma.toFixed(2)}`);
const exposureEvidence={schema:"limina.cpu-pixel-exposure/v1",clippedDefinition:"any RGB channel equals 255",clippedPixels,totalPixels:capture.width*capture.height,clippedFraction,p99Luma,limits:{clippedFraction:clippingLimit,p99Luma:250}};
const captureOutput = resolve(reviewDirectory, `${capture.id}.png`);
await mkdir(reviewDirectory, { recursive: true, mode: 0o700 });
await chmod(reviewDirectory,0o700);
if(appendOnly){const pngBytes=await sharp(rgba,{raw:{width:capture.width,height:capture.height,channels:4}}).png({compressionLevel:9,adaptiveFiltering:true}).toBuffer();await writeFile(captureOutput,pngBytes,{mode:0o600,flag:"wx"});}
else await sharp(rgba, { raw: { width: capture.width, height: capture.height, channels: 4 } }).png({ compressionLevel: 9, adaptiveFiltering: true }).toFile(captureOutput);
const png = await readFile(captureOutput); const pngSha256 = createHash("sha256").update(png).digest("hex");
await chmod(captureOutput,0o600);
outputs.push({ id: capture.id, state: capture.state, role: capture.role, output: relative(repo, captureOutput), pngSha256: `sha256:${pngSha256}`, pngByteLength: png.length, width:capture.width, height:capture.height, timestamp:new Date().toISOString(), rgbaContentHash: portableHash, exposureEvidence, renderSubmission: submission, pairedRenderSubmission: paired });
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
const evidencePath=resolve(reviewDirectory,"capture-evidence.json");
await writeFile(evidencePath, `${JSON.stringify(guardedArtifact)}\n`,{mode:0o600,flag:appendOnly?"wx":"w"});await chmod(evidencePath,0o600);
console.log(JSON.stringify({ schema: artifact.schema, primary: artifact.primary, adapter: artifact.adapter, asset: artifact.asset, functionalPlacement: artifact.functionalPlacement, lifecycleEvidence: artifact.lifecycleEvidence, outputs }, null, 2));
