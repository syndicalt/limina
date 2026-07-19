import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { classifyBounds, glbBbox } from "../qc/asset-sanity.mjs";

export const ARCHITECT_IMAGE = "postgres@sha256:be01cf82fc7dbba824acf0a82e150b4b360f3ff93c6631d7844af431e841a95c";
export const ARCHITECT_STAGE_SCHEMA = "limina.architect-isolated-stage/v1";
export const ARCHITECT_REVIEW_SCHEMA = "limina.architect-import-review/v1";
const DOCKER = "/usr/bin/docker";
const HOST_USR = "/usr";
const HOST_ALTERNATIVES = "/etc/alternatives";
const MAX_SOURCE_BYTES = 512 * 1024;
const MAX_GLB_BYTES = 128 * 1024 * 1024;
const HASH = /^sha256:[0-9a-f]{64}$/;
const ASSET_ID = /^[a-z0-9][a-z0-9-]{0,62}\.glb$/;
const HERE = dirname(fileURLToPath(import.meta.url));
const GENERATION_WORKER = join(HERE, "architect-generation-worker.mjs");
const QC_WORKER = join(HERE, "architect-qc-worker.mjs");

export class ArchitectIsolationError extends Error {
  constructor(code, message, options) { super(message, options); this.name = "ArchitectIsolationError"; this.code = code; }
}
const fail = (code, message, options) => { throw new ArchitectIsolationError(code, message, options); };
const sha256 = (bytes) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

function assertCanonicalGlbEnvelope(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.byteLength < 20) fail("INVALID_ARTIFACT", "candidate is too small to be a GLB");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const jsonLength = view.getUint32(12, true);
  if (view.getUint32(0, true) !== 0x46546c67 || view.getUint32(4, true) !== 2
      || view.getUint32(8, true) !== bytes.byteLength || jsonLength <= 0
      || 20 + jsonLength > bytes.byteLength || view.getUint32(16, true) !== 0x4e4f534a) {
    fail("INVALID_ARTIFACT", "candidate is not a canonical complete GLB v2 file");
  }
}

function assertRealDirectory(path, mode = 0o700) {
  mkdirSync(path, { recursive: true, mode });
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail("UNSAFE_PATH", `architect path must be a real directory: ${path}`);
  chmodSync(path, mode);
  return realpathSync(path);
}

function assertContained(root, path, label) {
  const rel = relative(root, path);
  if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`)) fail("UNSAFE_PATH", `${label} escapes its authority root`);
}

export function validateArchitectRequestId(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/.test(value)
      || new Set(["__proto__", "prototype", "constructor"]).has(value)) fail("INVALID_REQUEST", "requestId is invalid");
  return value;
}

export function validateArchitectRequest(value) {
  if (value === null || Array.isArray(value) || typeof value !== "object") fail("INVALID_REQUEST", "architect request must be an object");
  const requestId = validateArchitectRequestId(value.requestId);
  if (typeof value.description !== "string" || value.description.length < 1 || value.description.length > 8_192 || value.description.includes("\0")) fail("INVALID_REQUEST", "description is invalid");
  if (typeof value.title !== "string" || value.title.length < 1 || value.title.length > 256 || value.title.includes("\0")) fail("INVALID_REQUEST", "title is invalid");
  if (value.category !== "prop") fail("INVALID_REQUEST", "isolated generic architect accepts prop requests only");
  return Object.freeze({ requestId, description: value.description, title: value.title, category: value.category });
}

function privateWrite(path, bytes) {
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
  try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
}

export function createArchitectStage(projectRoot, requestValue) {
  const request = validateArchitectRequest(requestValue);
  const root = realpathSync(resolve(projectRoot));
  const liminaPath = join(root, ".limina");
  let liminaStat = lstatSync(liminaPath, { throwIfNoEntry: false });
  if (liminaStat === undefined) {
    mkdirSync(liminaPath, { mode: 0o700 });
    liminaStat = lstatSync(liminaPath);
  }
  if (!liminaStat.isDirectory() || liminaStat.isSymbolicLink()) fail("UNSAFE_PATH", ".limina must be a real directory");
  const limina = realpathSync(liminaPath);
  assertContained(root, limina, ".limina root");
  const stages = assertRealDirectory(join(limina, "architect-staging"));
  assertContained(root, stages, "architect staging root");
  const stage = join(stages, `job-${randomUUID()}`);
  mkdirSync(stage, { mode: 0o700 });
  const input = assertRealDirectory(join(stage, "input"));
  const generated = assertRealDirectory(join(stage, "generated"));
  const output = assertRealDirectory(join(stage, "output"));
  const evidence = assertRealDirectory(join(stage, "evidence"));
  const sealed = assertRealDirectory(join(stage, "sealed"));
  privateWrite(join(input, "request.json"), Buffer.from(JSON.stringify(request) + "\n"));
  return Object.freeze({ root, stages, stage, input, generated, output, evidence, sealed, request });
}

function dockerCliEnvironment(extra = {}) {
  return Object.freeze({ PATH: "/usr/bin:/bin", HOME: "/tmp", LANG: "C.UTF-8", ...extra });
}

export function assertArchitectDockerAvailable() {
  if (!existsSync(DOCKER) || !existsSync(HOST_USR) || !existsSync(HOST_ALTERNATIVES)) fail("ISOLATION_UNAVAILABLE", "required Docker/host runtime paths are unavailable");
  const result = spawnSync(DOCKER, ["image", "inspect", ARCHITECT_IMAGE, "--format", "{{.Architecture}}/{{.Os}} {{json .RepoDigests}}"], {
    encoding: "utf8", timeout: 10_000, env: dockerCliEnvironment(), maxBuffer: 64 * 1024,
  });
  if (result.status !== 0 || !result.stdout.includes("arm64/linux") || !result.stdout.includes(ARCHITECT_IMAGE)) {
    fail("ISOLATION_UNAVAILABLE", `required pinned local image is unavailable; refusing to pull: ${(result.stderr || result.stdout || "inspect failed").trim()}`);
  }
}

function mount(source, target, readonly = false) {
  const value = `type=bind,src=${source},dst=${target}${readonly ? ",readonly" : ""}`;
  return ["--mount", value];
}

function commonRunArgs({ name, network, memory, cpus, pids, tmpfsSize, sealedDirectory }) {
  return [
    "run", "--rm", "--pull=never", "--name", name,
    `--network=${network}`, "--read-only", "--cap-drop=ALL",
    "--security-opt=no-new-privileges:true", "--ipc=none",
    `--pids-limit=${pids}`, `--memory=${memory}`, `--cpus=${cpus}`,
    "--ulimit", "core=0:0", "--ulimit", "nofile=256:256",
    `--ulimit=fsize=${MAX_GLB_BYTES}:${MAX_GLB_BYTES}`,
    "--user", `${process.getuid()}:${process.getgid()}`,
    "--tmpfs", `/tmp:rw,nosuid,nodev,size=${tmpfsSize}`,
    ...mount(HOST_USR, "/usr", true),
    ...mount(HOST_ALTERNATIVES, "/etc/alternatives", true),
    // The pinned PostgreSQL carrier image declares this as a writable VOLUME.
    // Override it explicitly so --read-only really leaves only broker-authorized writes.
    ...mount(sealedDirectory, "/var/lib/postgresql/data", true),
  ];
}

function removeContainer(name) {
  if (!/^limina-architect-[a-z0-9-]+$/.test(name)) return;
  spawnSync(DOCKER, ["rm", "--force", name], {
    encoding: "utf8", timeout: 10_000, env: dockerCliEnvironment(), maxBuffer: 64 * 1024,
  });
}

function runDocker(args, { timeoutMs, environment = {}, onProcess, containerName } = {}) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(DOCKER, args, { env: dockerCliEnvironment(environment), stdio: ["ignore", "pipe", "pipe"] });
    onProcess?.(child);
    let stdout = "", stderr = "", settled = false, timedOut = false;
    const capture = (current, chunk) => (current + String(chunk)).slice(-64 * 1024);
    child.stdout.on("data", (chunk) => { stdout = capture(stdout, chunk); });
    child.stderr.on("data", (chunk) => { stderr = capture(stderr, chunk); });
    const timer = setTimeout(() => {
      timedOut = true;
      removeContainer(containerName);
      child.kill("SIGTERM");
    }, timeoutMs);
    timer.unref();
    const finish = (error, result) => {
      if (settled) return;
      settled = true; clearTimeout(timer); onProcess?.(null);
      if (error) rejectRun(error); else resolveRun(result);
    };
    child.once("error", (error) => finish(new ArchitectIsolationError("ISOLATION_UNAVAILABLE", `Docker launch failed: ${error.message}`, { cause: error })));
    child.once("close", (code, signal) => {
      if (timedOut) { removeContainer(containerName); finish(new ArchitectIsolationError("ISOLATION_TIMEOUT", `isolated job exceeded ${timeoutMs}ms`)); return; }
      if (code !== 0) { removeContainer(containerName); finish(new ArchitectIsolationError("ISOLATION_FAILED", `isolated container failed (${signal ?? `exit ${code}`}): ${(stderr || stdout).slice(-4_000)}`)); return; }
      finish(undefined, Object.freeze({ stdout, stderr }));
    });
  });
}

function sourceIntoStage(stage, source) {
  if (typeof source !== "string" || Buffer.byteLength(source) < 64 || Buffer.byteLength(source) > MAX_SOURCE_BYTES || source.includes("\0")) fail("INVALID_SOURCE", "architect source is outside the allowed bounds");
  const target = join(stage.input, "source.py");
  privateWrite(target, Buffer.from(source));
  return target;
}

async function runBlender(stage, { onProcess } = {}) {
  const name = `limina-architect-blender-${randomBytes(8).toString("hex")}`;
  const candidate = join(stage.output, "candidate.glb");
  privateWrite(candidate, Buffer.alloc(0));
  const args = [
    ...commonRunArgs({ name, network: "none", memory: "4g", cpus: "4", pids: "256", tmpfsSize: "512m", sealedDirectory: stage.sealed }),
    ...mount(stage.input, "/input", true), ...mount(candidate, "/output/candidate.glb"),
    "--workdir", "/tmp", "--entrypoint", "/usr/bin/env", ARCHITECT_IMAGE,
    "-i", "PATH=/usr/bin:/bin", "HOME=/tmp", "LANG=C.UTF-8", "BLENDER_USER_CONFIG=/tmp/blender-config",
    "/usr/bin/blender", "--background", "--factory-startup", "--python", "/input/source.py", "--", "--out", "/output/candidate.glb",
  ];
  await runDocker(args, { timeoutMs: 20 * 60_000, onProcess, containerName: name });
  const stat = lstatSync(candidate);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1_024 || stat.size > MAX_GLB_BYTES) fail("INVALID_ARTIFACT", "isolated Blender did not produce a bounded regular candidate.glb");
  return candidate;
}

async function runQc(stage, candidate, { onProcess } = {}) {
  const name = `limina-architect-qc-${randomBytes(8).toString("hex")}`;
  const args = [
    ...commonRunArgs({ name, network: "none", memory: "512m", cpus: "1", pids: "32", tmpfsSize: "32m", sealedDirectory: stage.sealed }),
    ...mount(candidate, "/input/candidate.glb", true), ...mount(QC_WORKER, "/broker/qc.mjs", true),
    ...mount(stage.evidence, "/evidence"),
    "--workdir", "/evidence", "--entrypoint", "/usr/bin/env", ARCHITECT_IMAGE,
    "-i", "PATH=/usr/bin:/bin", "HOME=/tmp", "LANG=C.UTF-8", "/usr/bin/node", "/broker/qc.mjs",
  ];
  await runDocker(args, { timeoutMs: 60_000, onProcess, containerName: name });
  const path = join(stage.evidence, "qc.json");
  const report = JSON.parse(readFileSync(path, "utf8"));
  if (report.schema !== "limina.architect-isolated-qc/v1" || !HASH.test(report.sha256)) fail("INVALID_QC", "isolated QC report is invalid");
  const bytes = readFileSync(candidate);
  if (report.sha256 !== sha256(bytes) || report.bytes !== bytes.byteLength) fail("INVALID_QC", "isolated QC report is not bound to candidate bytes");
  assertCanonicalGlbEnvelope(bytes);
  const bbox = glbBbox(bytes);
  if (bbox === null) fail("INVALID_QC", "canonical transform-aware QC found no POSITION bounds");
  const dimensionsM = bbox.mx.map((value, index) => value - bbox.mn[index]);
  const flags = classifyBounds(dimensionsM, bbox.mn);
  if (flags.some((flag) => flag.startsWith("DEGENERATE") || flag.startsWith("OVERSIZE"))) {
    fail("INVALID_QC", `canonical transform-aware QC rejected candidate: ${flags.join(" ")}`);
  }
  return Object.freeze({ path, report, canonical: Object.freeze({ min: bbox.mn, max: bbox.mx, dimensionsM, flags }) });
}

function finalizeManifest(stage, sourcePath, candidate, qc, generation) {
  const source = readFileSync(sourcePath);
  const artifact = readFileSync(candidate);
  const manifest = {
    schema: ARCHITECT_STAGE_SCHEMA,
    status: "awaiting-reviewed-import",
    image: ARCHITECT_IMAGE,
    request: stage.request,
    source: { path: "input/source.py", sha256: sha256(source), bytes: source.byteLength },
    artifact: { path: "output/candidate.glb", sha256: sha256(artifact), bytes: artifact.byteLength },
    qc: { path: "evidence/qc.json", sha256: sha256(readFileSync(qc.path)), report: qc.report, canonical: qc.canonical },
    generation,
    isolation: { executionNetwork: "none", repositoryMounted: false, homeMounted: false, dockerSocketMounted: false, gpuDevicesMounted: false },
  };
  const path = join(stage.stage, "manifest.json");
  privateWrite(path, Buffer.from(JSON.stringify(manifest, null, 2) + "\n"));
  return Object.freeze({ path, manifest, sha256: sha256(readFileSync(path)) });
}

export async function runIsolatedExecutionFromSource({ projectRoot, request, source, onProcess }) {
  assertArchitectDockerAvailable();
  const stage = createArchitectStage(projectRoot, request);
  const sourcePath = sourceIntoStage(stage, source);
  const candidate = await runBlender(stage, { onProcess });
  const qc = await runQc(stage, candidate, { onProcess });
  return finalizeManifest(stage, sourcePath, candidate, qc, { mode: "provided-untrusted-source" });
}

export async function runIsolatedArchitectJob({ projectRoot, request, apiKey, model = "claude-sonnet-5", onProcess }) {
  assertArchitectDockerAvailable();
  if (typeof apiKey !== "string" || !/^sk-ant-[A-Za-z0-9_-]{20,}$/.test(apiKey)) fail("GENERATION_UNAVAILABLE", "ANTHROPIC_API_KEY is required for isolated generation");
  if (!new Set(["claude-sonnet-5", "claude-opus-4-8"]).has(model)) fail("GENERATION_UNAVAILABLE", "requested architect model is not allowed");
  const stage = createArchitectStage(projectRoot, request);
  const secretDir = assertRealDirectory(join(stage.stage, "secret"));
  const keyPath = join(secretDir, "anthropic-key");
  privateWrite(keyPath, Buffer.from(apiKey + "\n"));
  try {
    const name = `limina-architect-generate-${randomBytes(8).toString("hex")}`;
    const args = [
      ...commonRunArgs({ name, network: "bridge", memory: "1g", cpus: "1", pids: "32", tmpfsSize: "64m", sealedDirectory: stage.sealed }),
      ...mount(stage.input, "/input", true), ...mount(stage.generated, "/generated"),
      ...mount(GENERATION_WORKER, "/broker/generate.mjs", true), ...mount(keyPath, "/run/secret/anthropic-key", true),
      ...mount("/etc/ssl/certs", "/etc/ssl/certs", true),
      "--workdir", "/generated", "--entrypoint", "/usr/bin/env", ARCHITECT_IMAGE,
      "-i", "PATH=/usr/bin:/bin", "HOME=/tmp", "LANG=C.UTF-8", `ARCHITECT_MODEL=${model}`,
      "/usr/bin/node", "/broker/generate.mjs",
    ];
    await runDocker(args, { timeoutMs: 5 * 60_000, onProcess, containerName: name });
  } finally {
    rmSync(keyPath, { force: true });
    chmodSync(secretDir, 0o700);
  }
  const generatedPath = join(stage.generated, "source.py");
  const generatedStat = lstatSync(generatedPath);
  if (!generatedStat.isFile() || generatedStat.isSymbolicLink() || generatedStat.size < 64 || generatedStat.size > MAX_SOURCE_BYTES) fail("INVALID_SOURCE", "generation did not produce bounded regular source.py");
  const source = readFileSync(generatedPath, "utf8");
  const sourcePath = sourceIntoStage(stage, source);
  const generation = JSON.parse(readFileSync(join(stage.generated, "generation.json"), "utf8"));
  const candidate = await runBlender(stage, { onProcess });
  const qc = await runQc(stage, candidate, { onProcess });
  return finalizeManifest(stage, sourcePath, candidate, qc, generation);
}

function readRegular(path, maximum, label) {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maximum) fail("UNSAFE_PATH", `${label} must be a bounded regular file`);
  return readFileSync(path);
}

export function importReviewedArchitectArtifact({ projectRoot, manifestPath, reviewPath }) {
  const root = realpathSync(resolve(projectRoot));
  const stages = realpathSync(join(root, ".limina", "architect-staging"));
  assertContained(root, stages, "architect staging root");
  const manifestReal = realpathSync(resolve(manifestPath));
  assertContained(stages, manifestReal, "stage manifest");
  if (basename(manifestReal) !== "manifest.json") fail("UNSAFE_PATH", "reviewed manifest must be a stage manifest.json");
  const manifestBytes = readRegular(manifestReal, 256 * 1024, "stage manifest");
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  if (manifest.schema !== ARCHITECT_STAGE_SCHEMA || manifest.status !== "awaiting-reviewed-import" || manifest.image !== ARCHITECT_IMAGE) fail("INVALID_MANIFEST", "stage manifest is invalid");
  validateArchitectRequest(manifest.request);
  if (manifest.generation === null || Array.isArray(manifest.generation) || typeof manifest.generation !== "object"
      || (manifest.generation.model !== undefined && (typeof manifest.generation.model !== "string" || manifest.generation.model.length > 128))) {
    fail("INVALID_MANIFEST", "stage generation declaration is invalid");
  }
  if (typeof manifest.artifact?.path !== "string" || !HASH.test(manifest.artifact?.sha256)
      || !Number.isSafeInteger(manifest.artifact?.bytes) || manifest.artifact.bytes < 1_024 || manifest.artifact.bytes > MAX_GLB_BYTES) {
    fail("INVALID_MANIFEST", "stage artifact declaration is invalid");
  }
  const reviewBytes = readRegular(realpathSync(resolve(reviewPath)), 64 * 1024, "import review");
  const review = JSON.parse(reviewBytes.toString("utf8"));
  if (review?.schema !== ARCHITECT_REVIEW_SCHEMA || review.decision !== "approve" || !HASH.test(review.manifestSha256)
      || !HASH.test(review.artifactSha256) || !ASSET_ID.test(review.targetAssetId)
      || typeof review.reviewer !== "string" || review.reviewer.length < 1 || review.reviewer.length > 128) {
    fail("INVALID_REVIEW", "review approval is invalid");
  }
  if (review.manifestSha256 !== sha256(manifestBytes) || review.artifactSha256 !== manifest.artifact.sha256) fail("REVIEW_DRIFT", "review approval does not bind the current manifest/artifact");
  const stage = dirname(manifestReal);
  const artifactPath = resolve(stage, manifest.artifact.path);
  assertContained(stage, artifactPath, "staged artifact");
  const artifactReal = realpathSync(artifactPath);
  if (artifactReal !== artifactPath) fail("UNSAFE_PATH", "staged artifact path may not traverse symbolic links");
  const artifact = readRegular(artifactPath, MAX_GLB_BYTES, "staged artifact");
  if (sha256(artifact) !== manifest.artifact.sha256 || artifact.byteLength !== manifest.artifact.bytes) fail("ARTIFACT_DRIFT", "staged artifact bytes drifted after review");
  assertCanonicalGlbEnvelope(artifact);
  let bbox;
  try { bbox = glbBbox(artifact); } catch (error) { fail("INVALID_ARTIFACT", `reviewed artifact GLB parse failed: ${error.message}`); }
  if (bbox === null) fail("INVALID_ARTIFACT", "reviewed artifact has no transform-aware POSITION bounds");
  const dimensionsM = bbox.mx.map((value, index) => value - bbox.mn[index]);
  const blocking = classifyBounds(dimensionsM, bbox.mn).filter((flag) => flag.startsWith("DEGENERATE") || flag.startsWith("OVERSIZE"));
  if (blocking.length > 0) fail("INVALID_ARTIFACT", `reviewed artifact failed canonical bounds: ${blocking.join(" ")}`);
  const assets = realpathSync(join(root, "assets"));
  assertContained(root, assets, "asset import root");
  const destination = join(assets, review.targetAssetId);
  if (existsSync(destination)) fail("DESTINATION_EXISTS", `reviewed import will not replace existing asset ${review.targetAssetId}`);
  const provenancePath = `${destination}.architect.json`;
  if (existsSync(provenancePath)) fail("DESTINATION_EXISTS", `reviewed import provenance already exists for ${review.targetAssetId}`);
  const nonce = randomBytes(8).toString("hex");
  const temporary = join(assets, `.${review.targetAssetId}.${nonce}.tmp`);
  const temporaryProvenance = join(assets, `.${review.targetAssetId}.${nonce}.architect.tmp`);
  const provenance = Buffer.from(JSON.stringify({
    schema: "limina.architect-reviewed-import/v1", targetAssetId: review.targetAssetId,
    manifestSha256: review.manifestSha256, artifactSha256: review.artifactSha256,
    reviewSha256: sha256(reviewBytes), reviewer: review.reviewer, request: manifest.request,
    image: manifest.image, generation: manifest.generation,
    sourceSha256: manifest.source?.sha256, isolatedQcSha256: manifest.qc?.sha256,
  }, null, 2) + "\n");
  privateWrite(temporary, artifact);
  privateWrite(temporaryProvenance, provenance);
  let destinationLinked = false;
  let provenanceLinked = false;
  try {
    linkSync(temporary, destination);
    destinationLinked = true;
    linkSync(temporaryProvenance, provenancePath);
    provenanceLinked = true;
    chmodSync(destination, 0o644);
    chmodSync(provenancePath, 0o644);
  } catch (error) {
    if (provenanceLinked) unlinkSync(provenancePath);
    if (destinationLinked) unlinkSync(destination);
    throw error;
  } finally {
    rmSync(temporary, { force: true });
    rmSync(temporaryProvenance, { force: true });
  }
  return Object.freeze({ assetId: review.targetAssetId, path: destination, provenancePath, manifest });
}
