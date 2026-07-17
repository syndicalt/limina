import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { readFileSync } from "node:fs";
import { access, chmod, lstat, mkdir, open, readFile, rename, rm, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { portableAssetContentHash } from "../../js/src/world/asset-content-hash.mjs";

export const PRODUCTION_R1_CAPTURE = Object.freeze({
  binary: "target/release/limina",
  module: "js/src/demos/building_production_review_window.ts",
  authorityModule: "js/src/render/building-production-review-authority.ts",
  sceneModule: "js/src/render/building-production-review-scene.ts",
  traceDirectory: "traces",
  tracePrefix: "building-production-r1-native-capture",
  traceEnvironment: "LIMINA_BUILDING_PRODUCTION_REVIEW_TRACE",
  lock: "traces/building-production-r1-native-capture.lock",
  privateRoot: "assets/qc/internal/production-r1",
  reviewArtifactRoot: ".limina/review-artifacts",
  reviewBindHost: "127.0.0.1",
  authorityEnvironment: "LIMINA_BUILDING_PRODUCTION_REVIEW_AUTHORITY",
  schema: "limina.building-production-native-review-set/v1",
  viewIds: Object.freeze(["exterior-three-quarter", "entry-door-stairs", "interior-overall", "hearth-fire-seating", "dining-service"]),
  sourcePaths: Object.freeze([
    "js/src/render/building-production-review-authority.ts",
    "js/src/render/building-production-review-scene.ts",
    "js/src/demos/building_production_review_window.ts",
    "tools/preview/run-native-building-production-r1-capture.mjs",
  ]),
});

const XID = /(?:NVRM:\s*)?Xid\b|Xid \(PCI/i;
const HASH = /^sha256:[0-9a-f]{64}$/;
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const rawHash = (bytes) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const portable = (repo, path) => relative(repo, path).split(sep).join("/");
const inside = (base, target) => { const rel = relative(base, target); return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel); };
const firstXid = (text) => String(text).split(/\r?\n/).find((line) => XID.test(line));

function systemKernelLog() {
  const result = spawnSync("journalctl", ["-k", "-b", "--no-pager", "-o", "cat"], { encoding: "utf8", timeout: 30_000, maxBuffer: 32 * 1024 * 1024 });
  if (result.error || result.status !== 0) throw new Error(`cannot establish required Xid guard: ${result.error?.message ?? result.stderr ?? `journalctl exit ${result.status}`}`);
  return result.stdout;
}

function systemRunGuarded(command, args, environment, { repoRoot, kernelLog }) {
  return new Promise((accept, reject) => {
    let guardFailure = "", settled = false;
    const monitor = spawn("journalctl", ["-k", "-f", "-n", "0", "--no-pager", "-o", "cat"], { cwd: repoRoot, stdio: ["ignore", "pipe", "pipe"] });
    const child = spawn(command, args, { cwd: repoRoot, env: environment, stdio: ["ignore", "pipe", "pipe"] });
    const stop = (message) => { if (!guardFailure) { guardFailure = message; child.kill("SIGTERM"); } };
    const finish = (error) => { if (settled) return; settled = true; clearInterval(poll); monitor.kill("SIGTERM"); error ? reject(error) : accept(); };
    monitor.stdout.on("data", (chunk) => { const event = firstXid(chunk); if (event) stop(`NVIDIA Xid detected; capture stopped and must not be retried before reboot: ${event.trim()}`); });
    monitor.stderr.on("data", (chunk) => process.stderr.write(chunk));
    monitor.on("error", (error) => stop(`live Xid monitor failed: ${error.message}`));
    monitor.on("close", (code, signal) => { if (!settled) stop(`live Xid monitor exited before capture completion: ${code ?? signal}`); });
    const poll = setInterval(() => { try { const event = firstXid(kernelLog()); if (event) stop(`NVIDIA Xid detected; capture stopped and must not be retried before reboot: ${event.trim()}`); } catch (error) { stop(`live Xid polling failed: ${error instanceof Error ? error.message : String(error)}`); } }, 250);
    child.stdout.on("data", (chunk) => process.stdout.write(chunk));
    child.stderr.on("data", (chunk) => process.stderr.write(chunk));
    child.on("error", (error) => finish(error));
    child.on("exit", (code, signal) => finish(guardFailure ? new Error(guardFailure) : code !== 0 ? new Error(`guarded native R1 capture exited ${code ?? signal}`) : undefined));
  });
}

async function defaultAuthorityTools() {
  const module = await import("../../js/src/render/building-production-review-authority.ts");
  return { validate: module.validateBuildingProductionReviewAuthority, verify: module.verifyBuildingProductionReviewClosure };
}

export async function verifyFrozenBuildingProductionReviewAuthority({ repoRoot = root, authorityPath } = {}, dependencies = {}) {
  const repository = resolve(repoRoot), authorityAbsolute = resolve(repository, authorityPath ?? "");
  if (!authorityPath || !inside(repository, authorityAbsolute)) throw new Error("R1 authority escaped repository");
  const authorityBytes = await regularFile(authorityAbsolute, "R1 authority"), authorityRelative = portable(repository, authorityAbsolute);
  const authorityTools = dependencies.authorityTools ?? await defaultAuthorityTools(), authority = authorityTools.validate(JSON.parse(authorityBytes));
  const closure = authorityTools.verify(authority, (path) => dependencies.readClosure?.(path) ?? readFileSync(resolve(repository, path)));
  const views = authority.evidenceViews;
  if (!Array.isArray(views) || views.map(({ id }) => id).join(",") !== PRODUCTION_R1_CAPTURE.viewIds.join(",")
    || !Array.isArray(authority.presentation?.minimumResolution) || authority.presentation.minimumResolution[0] < 1920 || authority.presentation.minimumResolution[1] < 1080
    || authority.approvalPolicy?.timestampQueriesEnabled !== false || authority.approvalPolicy?.humanDecision !== "pending" || authority.approvalPolicy?.visualApprovalClaimed !== false) {
    throw new Error("R1 authority lacks canonical five-view >=1920x1080 timestamp-disabled pending evidence");
  }
  return Object.freeze({ authority, authorityBytes, authorityPath: authorityRelative, closure });
}

async function defaultEncodePng(rgba, width, height) {
  const { default: sharp } = await import("../../js/node_modules/sharp/lib/index.js");
  return sharp(rgba, { raw: { width, height, channels: 4 } }).png({ compressionLevel: 9, adaptiveFiltering: true }).toBuffer();
}

function safeEnvironment(base, repoRoot, authorityPath, tracePath) {
  const environment = { ...base, LIMINA_ASSET_ROOT: repoRoot, [PRODUCTION_R1_CAPTURE.authorityEnvironment]: authorityPath, [PRODUCTION_R1_CAPTURE.traceEnvironment]: tracePath };
  delete environment.LIMINA_GPU_TIMESTAMP_RISK_ACK;
  delete environment.LIMINA_GPU_TIMESTAMP_MODE;
  delete environment.LIMINA_GPU_TIMESTAMP_QUERIES;
  for (const key of Object.keys(environment)) if (/TIMESTAMP/i.test(key)) delete environment[key];
  if (Object.keys(environment).some((key) => /TIMESTAMP/i.test(key))) throw new Error("timestamp environment variables are forbidden for R1 capture");
  return environment;
}

async function regularFile(path, label) {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${label} must be a regular non-symlink file`);
  return readFile(path);
}

async function absent(path, label) {
  try { await lstat(path); throw new Error(`append-only ${label} already exists: ${path}`); } catch (error) { if (error?.code !== "ENOENT") throw error; }
}

function validateTelemetry(capture) {
  const submission = capture.renderSubmission, resources = capture.rendererResources;
  if (submission?.schema !== "limina.three-render-submission/v2" || submission.source !== "three-webgpu-renderer-info"
    || submission.scope !== "single-production-frame-all-passes" || submission.instanceAccounting !== "full-draw-instance-count"
    || !Number.isSafeInteger(submission.frameId) || submission.frameId < 1 || !Number.isSafeInteger(submission.renderCalls) || submission.renderCalls <= 1
    || !Number.isSafeInteger(submission.drawCalls) || submission.drawCalls <= 1 || !Number.isSafeInteger(submission.triangles) || submission.triangles <= 1
    || !Number.isFinite(submission.cpuEncodeMs) || submission.cpuEncodeMs < 0) {
    throw new Error(`R1 ${capture.id} lacks whole-scene telemetry`);
  }
  const values = [...Object.values(resources?.counts ?? {}), ...Object.values(resources?.bytes ?? {})];
  if (resources?.schema !== "limina.three-render-resources/v1" || resources.source !== "three-webgpu-renderer-info"
    || resources.scope !== "renderer-live-after-production-frame" || values.length !== 12 || values.some((value) => !Number.isSafeInteger(value) || value < 0)) {
    throw new Error(`R1 ${capture.id} lacks renderer resource telemetry`);
  }
}

export function validateProductionReviewPixels(rgba, width, height) {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 || rgba.length !== width * height * 4) throw new Error("R1 pixel sanity input dimensions drifted");
  const histogram = new Array(64).fill(0), pixels = width * height;
  let sum = 0, sumSquares = 0, minimum = 255, maximum = 0, black = 0, white = 0;
  for (let offset = 0; offset < rgba.length; offset += 4) {
    const luminance = Math.round((rgba[offset] * 54 + rgba[offset + 1] * 183 + rgba[offset + 2] * 19) / 256);
    histogram[Math.min(63, luminance >>> 2)]++; sum += luminance; sumSquares += luminance * luminance;
    minimum = Math.min(minimum, luminance); maximum = Math.max(maximum, luminance);
    if (luminance <= 4) black++; if (luminance >= 250) white++;
  }
  const mean = sum / pixels, variance = Math.max(0, sumSquares / pixels - mean * mean), standardDeviation = Math.sqrt(variance), dynamicRange = maximum - minimum;
  const metrics = Object.freeze({ schema: "limina.rgba-luminance-sanity/v1", basis: "rec709-integer-rgba8", pixels, minimum, maximum, dynamicRange,
    mean: Number(mean.toFixed(4)), standardDeviation: Number(standardDeviation.toFixed(4)), blackCrushFraction: Number((black / pixels).toFixed(8)), whiteClipFraction: Number((white / pixels).toFixed(8)), histogram: Object.freeze(histogram) });
  if (dynamicRange < 4 || standardDeviation < 1.5) throw new Error(`R1 frame is blank or near-uniform: ${JSON.stringify(metrics)}`);
  if (metrics.blackCrushFraction > 0.985 && mean < 8) throw new Error(`R1 frame has severe black crush: ${JSON.stringify(metrics)}`);
  if (metrics.whiteClipFraction > 0.985 && mean > 247) throw new Error(`R1 frame has severe white clipping: ${JSON.stringify(metrics)}`);
  return metrics;
}

function validatePng(bytes) {
  if (bytes.length < 24 || !bytes.subarray(0, 8).equals(PNG_SIGNATURE) || bytes.toString("ascii", 12, 16) !== "IHDR") throw new Error("PNG encoder did not produce a complete PNG");
}

async function runBuildingProductionR1CaptureLocked(options, dependencies = {}) {
  const repoRoot = resolve(options?.repoRoot ?? root), authorityAbsolute = resolve(repoRoot, options?.authorityPath ?? ""), outRoot = resolve(repoRoot, options?.outDir ?? ""), reviewPrefix = options?.reviewPrefix;
  const binary = resolve(repoRoot, PRODUCTION_R1_CAPTURE.binary), modulePath = PRODUCTION_R1_CAPTURE.module, tracePath = options.tracePath;
  const privateRoot = resolve(repoRoot, PRODUCTION_R1_CAPTURE.privateRoot), reviewRoot = resolve(repoRoot, PRODUCTION_R1_CAPTURE.reviewArtifactRoot);
  if (!options?.authorityPath || !inside(repoRoot, authorityAbsolute)) throw new Error("R1 authority escaped repository");
  if (!options?.outDir || !inside(privateRoot, outRoot)) throw new Error("R1 captures must remain in a new private production review directory");
  if (typeof reviewPrefix !== "string" || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(reviewPrefix)) throw new Error("review prefix must be a bounded lowercase append-only artifact prefix");
  await absent(outRoot, "R1 private output");
  const { authority, authorityBytes, authorityPath,closure } = await verifyFrozenBuildingProductionReviewAuthority({ repoRoot, authorityPath: portable(repoRoot, authorityAbsolute) }, dependencies), views = authority.evidenceViews;
  const [width, height] = authority.presentation.minimumResolution, reviewTargets = PRODUCTION_R1_CAPTURE.viewIds.map((id) => resolve(reviewRoot, `${reviewPrefix}-${id}.png`));
  for (const target of reviewTargets) await absent(target, "loopback review artifact");
  await (dependencies.accessBinary ?? access)(binary);
  const kernelLog = dependencies.kernelLog ?? systemKernelLog, bootId = dependencies.bootId ?? (await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim();
  const preflight = firstXid(kernelLog());
  if (preflight) throw new Error(`current boot already contains an NVIDIA Xid; reboot before any native capture retry: ${preflight.trim()}`);
  const environment = safeEnvironment(dependencies.environment ?? process.env, repoRoot, authorityPath, basename(tracePath));
  await absent(tracePath, "unique native R1 trace");
  const fullscreen = dependencies.fullscreen ?? process.env.LIMINA_NATIVE_CAPTURE_FULLSCREEN ?? "";
  if (!["", "0", "1"].includes(fullscreen)) throw new Error("LIMINA_NATIVE_CAPTURE_FULLSCREEN must be 0 or 1");
  let captureFailure;
  try {
    const runGuarded = dependencies.runGuarded ?? systemRunGuarded;
    await runGuarded(binary, ["--window", ...(fullscreen === "1" ? ["--fullscreen"] : []), "--width", String(width), "--height", String(height), "--frames", "1", modulePath], environment, { repoRoot, kernelLog, tracePath });
  } catch (error) { captureFailure = error; }
  const postflight = firstXid(kernelLog());
  if (postflight) { await unlink(tracePath).catch(() => {}); throw new Error(`NVIDIA Xid detected after capture; stop immediately, report ${postflight.trim()}, and do not retry until reboot`); }
  if (captureFailure) { await unlink(tracePath).catch(() => {}); throw captureFailure; }
  let traceBytes;
  try { traceBytes = await regularFile(tracePath, "native R1 trace"); } finally { await unlink(tracePath).catch((error) => { if (error?.code !== "ENOENT") throw error; }); }
  const artifact = JSON.parse(traceBytes);
  if (artifact.schema !== PRODUCTION_R1_CAPTURE.schema || artifact.backend !== "native-webgpu" || artifact.captureClass !== "production-engine"
    || artifact.timingPolicy?.gpuTimestampMode !== "disabled" || artifact.timingPolicy?.timestampQueriesEnabled !== false
    || artifact.timingPolicy?.gpuTextureCompression !== "bc-required" || artifact.timingPolicy?.renderBaseline !== false
    || artifact.authority?.path !== authorityPath || artifact.authority?.sha256 !== rawHash(authorityBytes) || artifact.authority?.contentHash !== portableAssetContentHash(authorityBytes)) {
    throw new Error("R1 capture identity or timestamp policy drifted");
  }
  const expectedPresentation={fixedTimeSeconds:authority.presentation.fixedTimeSeconds,warmupFrames:authority.presentation.warmupFrames,cameraVerticalBasis:authority.presentation.cameraVerticalBasis};
  if(JSON.stringify(artifact.environment)!==JSON.stringify(authority.environment)||JSON.stringify(artifact.presentation)!==JSON.stringify(expectedPresentation))throw new Error("R1 capture production environment or presentation identity drifted");
  if(closure?.siteFit!==undefined){const expected=closure.siteFit.fit,actual=artifact.mounted?.site,round=value=>Number(value.toFixed(12));if(JSON.stringify(actual?.evidence)!==JSON.stringify(authority.siteFitEvidence)||round(actual?.rootWorldY)!==expected.rootWorldY||round(actual?.terrainMinimum)!==expected.terrainMinimum||round(actual?.terrainMaximum)!==expected.terrainMaximum||round(actual?.terrainRelief)!==expected.terrainRelief||actual?.sampleCount!==expected.sampleCount||round(actual?.entranceSupport?.terrainVariation)!==expected.entranceSupport.terrainVariation||round(actual?.entranceSupport?.cutDepth)!==expected.entranceSupport.cutDepth)throw new Error("R1 capture site fit drifted from exact CPU evidence");}
  if (!Array.isArray(artifact.source) || artifact.source.map(({ path }) => path).join(",") !== PRODUCTION_R1_CAPTURE.sourcePaths.join(",")) throw new Error("R1 capture lacks exact engine source closure");
  for (const source of artifact.source) { const bytes = await regularFile(resolve(repoRoot, source.path), `R1 source ${source.path}`); if (!HASH.test(source.sha256) || source.sha256 !== rawHash(bytes) || source.contentHash !== portableAssetContentHash(bytes)) throw new Error(`R1 engine source drifted: ${source.path}`); }
  if (/swiftshader|llvmpipe|lavapipe|software(?:\s+adapter)?|cpu renderer/i.test(JSON.stringify(artifact.adapter ?? ""))) throw new Error("R1 capture resolved a software adapter");
  if (!Number.isSafeInteger(artifact.lifecycle?.baselineEntities) || artifact.lifecycle.afterDisposeEntities !== artifact.lifecycle.baselineEntities || artifact.lifecycle.disposed !== true) throw new Error("R1 capture lacks complete engine lifecycle evidence");
  if (!Array.isArray(artifact.captures) || artifact.captures.length !== 5 || artifact.captures.map(({ id }) => id).join(",") !== PRODUCTION_R1_CAPTURE.viewIds.join(",")) throw new Error("R1 capture views are incomplete or out of order");
  const pending = [];
  for (const [index, capture] of artifact.captures.entries()) {
    const view = views[index]; validateTelemetry(capture);
    const rootWorldY=artifact.mounted?.site?.rootWorldY,resolvedCamera={position:[view.camera.position[0],view.camera.position[1]+rootWorldY,view.camera.position[2]],target:[view.camera.target[0],view.camera.target[1]+rootWorldY,view.camera.target[2]],fovDeg:view.camera.fovDeg,near:view.camera.near,far:view.camera.far,verticalBasis:"world"};
    if (authority.presentation.cameraVerticalBasis!=="terrain-root-relative"||!Number.isFinite(rootWorldY)
      ||JSON.stringify(capture.camera)!==JSON.stringify(view.camera)||JSON.stringify(capture.authorityCamera)!==JSON.stringify(view.camera)||JSON.stringify(capture.resolvedCamera)!==JSON.stringify(resolvedCamera)
      || capture.width < width || capture.height < height || typeof capture.surfaceFormat !== "string") throw new Error(`R1 ${capture.id} camera or resolution drifted`);
    const rgba = Buffer.from(capture.rgbaBase64, "base64");
    if (rgba.length !== capture.width * capture.height * 4 || capture.rgbaByteLength !== rgba.length || capture.rgbaContentHash !== portableAssetContentHash(rgba)) throw new Error(`R1 ${capture.id} pixels are invalid`);
    const pixelSanity=validateProductionReviewPixels(rgba,capture.width,capture.height),png = Buffer.from(await (dependencies.encodePng ?? defaultEncodePng)(rgba, capture.width, capture.height)); validatePng(png);
    pending.push({ capture, png, privatePath: resolve(outRoot, `${capture.id}.png`), reviewPath: reviewTargets[index], record: { id: capture.id, path: portable(repoRoot, resolve(outRoot, `${capture.id}.png`)), reviewArtifactPath: portable(repoRoot, reviewTargets[index]), width: capture.width, height: capture.height, pngSha256: rawHash(png), pngByteLength: png.length, rgbaContentHash: capture.rgbaContentHash, pixelSanity, renderSubmission: capture.renderSubmission, rendererResources: capture.rendererResources } });
  }
  for (const item of pending) await absent(item.privatePath, "R1 PNG");
  await mkdir(privateRoot, { recursive: true, mode: 0o700 });
  const privateRootStat = await lstat(privateRoot);
  if (!privateRootStat.isDirectory() || privateRootStat.isSymbolicLink()) throw new Error("R1 private capture root must be a real directory");
  await chmod(privateRoot, 0o700);
  const staging = `${outRoot}.staging-${process.pid}`; await absent(staging, "R1 staging directory"); await mkdir(staging, { recursive: false, mode: 0o700 });
  try {
    for (const item of pending) await writeFile(resolve(staging, `${item.capture.id}.png`), item.png, { flag: "wx", mode: 0o600 });
    const evidence = { ...artifact, captures: artifact.captures.map(({ rgbaBase64, ...capture }) => capture), guardEvidence: { schema: "limina.nvidia-xid-guard/v1", bootId, preflight: { source: "journalctl-kernel-current-boot", xidObserved: false }, live: { follower: "journalctl-kernel-follow", redundantPollMs: 250, xidObserved: false }, postflight: { source: "journalctl-kernel-current-boot", xidObserved: false } }, reviewBridge: { artifactDirectory: PRODUCTION_R1_CAPTURE.reviewArtifactRoot, bindHost: PRODUCTION_R1_CAPTURE.reviewBindHost, public: false }, outputs: pending.map(({ record }) => record) };
    await writeFile(resolve(staging, "capture-evidence.json"), `${JSON.stringify(evidence, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    await mkdir(reviewRoot, { recursive: true, mode: 0o700 }); await chmod(reviewRoot, 0o700);
    const publishedReview = [];
    try {
      for (const item of pending) { const handle = await (dependencies.openReview ?? open)(item.reviewPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600); try { await handle.writeFile(item.png); publishedReview.push(item.reviewPath); } finally { await handle.close(); } }
      await rename(staging, outRoot);
    } catch (error) { for (const path of publishedReview) await unlink(path).catch(() => {}); throw error; }
    return Object.freeze({ evidencePath: portable(repoRoot, resolve(outRoot, "capture-evidence.json")), outputs: evidence.outputs, reviewBindHost: PRODUCTION_R1_CAPTURE.reviewBindHost });
  } catch (error) { await rm(staging, { recursive: true, force: true }); throw error; }
}

export async function runBuildingProductionR1Capture(options, dependencies = {}) {
  const repoRoot = resolve(options?.repoRoot ?? root), traceRoot = resolve(repoRoot, PRODUCTION_R1_CAPTURE.traceDirectory), lockPath = resolve(repoRoot, PRODUCTION_R1_CAPTURE.lock);
  await mkdir(traceRoot, { recursive: true, mode: 0o700 });
  let lock;
  try { lock = await open(lockPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600); }
  catch (error) { if (error?.code === "EEXIST") throw new Error("guarded R1 capture lock already exists; refuse concurrent or unaudited retry", { cause: error }); throw error; }
  const traceId = dependencies.traceId ?? `${process.pid}-${randomUUID()}`, tracePath = resolve(traceRoot, `${PRODUCTION_R1_CAPTURE.tracePrefix}-${traceId}.json`);
  if (!inside(traceRoot, tracePath) || !/^[a-zA-Z0-9-]+$/.test(traceId)) { await lock.close(); await unlink(lockPath).catch(() => {}); throw new Error("R1 trace identity is unsafe"); }
  await lock.writeFile(`${JSON.stringify({ pid: process.pid, tracePath: portable(repoRoot, tracePath) })}\n`);
  try { return await runBuildingProductionR1CaptureLocked({ ...options, tracePath }, dependencies); }
  finally { await lock.close(); await unlink(lockPath).catch(() => {}); }
}

function cliValue(args, flag) { const index = args.indexOf(flag); if (index < 0 || !args[index + 1]) throw new Error(`usage: bun tools/preview/run-native-building-production-r1-capture.mjs --authority <json> --out-dir <new-private-directory> --review-prefix <unique-prefix>`); return args[index + 1]; }

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  console.log(JSON.stringify(await runBuildingProductionR1Capture({ authorityPath: cliValue(args, "--authority"), outDir: cliValue(args, "--out-dir"), reviewPrefix: cliValue(args, "--review-prefix") }), null, 2));
}
