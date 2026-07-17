import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildingCompositionManifestV2Hash, validateBuildingCompositionManifestV2 } from "../../js/src/assets/building-composition-manifest-v2.mjs";
import { stageReviewArtifact } from "../review/dgx-spark-review-bridge.mjs";
import { BOUNDED_C1_BASE, buildBoundedC1CompositionRevision } from "./build-bounded-c1-composition-revision.mjs";
import { resolveBlender } from "./blender-toolchain.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const SESSION_ROOT = ".limina/authoring-sessions";
const EXTRACTOR = "tools/blender/extract-building-composition-revision.py";
const SOURCE_BUILDER = "tools/architecture/build-furnished-c1-source.mjs";
const AUTHORITY_BUILDER = "tools/architecture/build-composition-review-authority.mjs";
const GUARDED_CAPTURE_RUNNER = "tools/preview/run-native-building-composition-capture.mjs";
const APPROVED_BLEND = Object.freeze({ path: BOUNDED_C1_BASE.blendPath, sha256: BOUNDED_C1_BASE.blendSha256 });
const HASH = /^sha256:[0-9a-f]{64}$/;
const sha = (bytes) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const portable = (root, path) => relative(root, path).split(sep).join("/");
const isInside = (parent, child) => { const value = relative(parent, child); return value !== "" && value !== ".." && !value.startsWith(`..${sep}`) && !isAbsolute(value); };
const inside = (root, value, label) => {
  if (typeof value !== "string" || !value || value.includes("\\")) throw new Error(`${label} must be a workspace-relative path`);
  const path = resolve(root, value), rel = relative(root, path);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error(`${label} escapes the workspace`);
  return path;
};
async function regular(path, label) { const info = await lstat(path); if (!info.isFile() || info.isSymbolicLink()) throw new Error(`${label} must be a regular, non-symlink file`); return info; }
async function exact(path, expected, label) { await regular(path, label); const bytes = await readFile(path), actual = sha(bytes); if (expected && actual !== expected) throw new Error(`${label} hash mismatch`); return { bytes, sha256: actual }; }
async function exclusiveJson(path, value) { await mkdir(dirname(path), { recursive: true, mode: 0o700 }); await chmod(dirname(path), 0o700); await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 }); await chmod(path, 0o600); }

async function validateSession(sessionPath, root) {
  root = resolve(root); const sessionRoot = inside(root, SESSION_ROOT, "session root"), requested = resolve(sessionPath);
  if (!isInside(sessionRoot, requested) || basename(requested) !== "session-manifest.json") throw new Error("authoring session manifest escapes the private session root");
  await regular(requested, "authoring session manifest");
  const resolvedManifest = await realpath(requested), sessionDirectory = dirname(resolvedManifest), resolvedRoot = await realpath(sessionRoot);
  if (!isInside(resolvedRoot, sessionDirectory) || dirname(sessionDirectory) !== resolvedRoot) throw new Error("authoring session manifest is not a direct private session child");
  const [sessionDirectoryInfo, sessionManifestInfo] = await Promise.all([lstat(sessionDirectory), lstat(resolvedManifest)]);
  if (!sessionDirectoryInfo.isDirectory() || sessionDirectoryInfo.isSymbolicLink() || (sessionDirectoryInfo.mode & 0o077) !== 0 || (sessionManifestInfo.mode & 0o077) !== 0) throw new Error("authoring session permissions are not private");
  const sessionBytes = await readFile(resolvedManifest), session = JSON.parse(sessionBytes);
  if (session.schema !== "limina.blender-authoring-session/v1" || session.composition?.id !== "composition/functional-hall-house-v4/r3" || session.composition?.revision !== 3) throw new Error("unsupported authoring session identity");
  if (session.policy?.approvedSourceImmutable !== true || session.policy?.genericGltfExportAllowed !== false || session.policy?.enginePreviewRequiresHostOrchestrator !== true) throw new Error("authoring session safety policy drifted");
  if (session.approvedSource?.path !== APPROVED_BLEND.path || session.approvedSource?.sha256 !== APPROVED_BLEND.sha256) throw new Error("authoring session approved base drifted");
  const approvedSource = inside(root, session.approvedSource.path, "approved source"), approved = await exact(approvedSource, APPROVED_BLEND.sha256, "approved source");
  const workingCopy = inside(root, session.workingCopy?.path, "working copy");
  if (dirname(workingCopy) !== sessionDirectory || basename(workingCopy) !== "furnished-c1-r3.working.blend") throw new Error("working copy is not the exact private session file");
  const workingInfo = await regular(workingCopy, "working copy"); if (await realpath(workingCopy) !== workingCopy) throw new Error("working copy may not be reached through a symlink");
  if ((workingInfo.mode & 0o077) !== 0) throw new Error("working copy permissions are not private");
  if (workingCopy === approvedSource) throw new Error("working copy aliases the approved source");
  const working = await exact(workingCopy, null, "working copy");
  return Object.freeze({ root, sessionRoot, sessionDirectory, sessionManifest: resolvedManifest, sessionBytes, session, approvedSource, approvedHash: approved.sha256, workingCopy, workingHash: working.sha256 });
}

function defaultExecute({ command, args, cwd, env }) {
  return new Promise((accept, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] }); let stdout = "", stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; process.stdout.write(chunk); }); child.stderr.on("data", (chunk) => { stderr += chunk; process.stderr.write(chunk); });
    child.once("error", reject); child.once("exit", (code, signal) => code === 0 ? accept({ code, stdout, stderr }) : reject(new Error(`authoring subprocess exited ${code ?? signal}: ${command} ${args.join(" ")}\n${stderr}`)));
  });
}

async function assertApprovedUnchanged(context) { await exact(context.approvedSource, context.approvedHash, "approved source after authoring action"); }
async function assertWorkingUnchanged(context) { await exact(context.workingCopy, context.workingHash, "working copy changed during authoring action"); }
function safeUuid(value) { if (typeof value !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) throw new Error("authoring operation UUID is invalid"); return value.toLowerCase(); }
function safeAttemptId(now, uuid) { return `preview-${now.toISOString().replace(/[:.]/g, "-")}-${safeUuid(uuid).replace(/-/g, "").slice(0, 12)}`; }
async function verifyBuildOutputs(context, paths, manifestBytes, manifestHash) {
  const [blend, glb, evidenceFile] = await Promise.all([exact(paths.blend, null, "rebuilt C1 Blend"), exact(paths.glb, null, "rebuilt C1 GLB"), exact(paths.buildEvidence, null, "C1 build evidence")]);
  const evidence = JSON.parse(evidenceFile.bytes);
  if (evidence.schema !== "limina.building-composition-build-evidence/v1" || evidence.id !== "composition/functional-hall-house-v4/r4" || evidence.status !== "cpu-authored-unreviewed" || evidence.rendered !== false || evidence.gpuUsed !== false) throw new Error("clean C1 rebuild evidence is not CPU-authored r4");
  if (evidence.manifest?.path !== portable(context.root, paths.manifest) || evidence.manifest?.sha256 !== sha(manifestBytes) || evidence.manifest?.canonicalHash !== manifestHash) throw new Error("clean C1 rebuild manifest closure drifted");
  if (evidence.sourceBlend?.path !== portable(context.root, paths.blend) || evidence.sourceBlend?.sha256 !== blend.sha256 || evidence.asset?.path !== portable(context.root, paths.glb) || evidence.asset?.sha256 !== glb.sha256) throw new Error("clean C1 rebuild output closure drifted");
  return { blend, glb, evidence, evidenceFile };
}
async function verifyCapture(context, paths, authorityFile) {
  const capturePath = join(paths.capture, "capture-evidence.json"), captureFile = await exact(capturePath, null, "guarded C1 capture evidence"), capture = JSON.parse(captureFile.bytes);
  if (capture.schema !== "limina.building-composition-native-review-set/v1" || capture.backend !== "native-webgpu" || capture.captureClass !== "production-engine") throw new Error("preview did not use the production native C1 engine pipeline");
  if (capture.authority?.path !== portable(context.root, paths.authority) || capture.authority?.sha256 !== authorityFile.sha256) throw new Error("preview authority closure drifted");
  if (capture.timingPolicy?.gpuTimestampMode !== "disabled" || capture.timingPolicy?.timestampQueriesEnabled !== false) throw new Error("preview timestamp policy is unsafe");
  if (capture.guardEvidence?.preflight?.xidObserved !== false || capture.guardEvidence?.live?.xidObserved !== false || capture.guardEvidence?.postflight?.xidObserved !== false) throw new Error("preview lacks an all-clear NVIDIA Xid guard");
  if (!Array.isArray(capture.outputs) || capture.outputs.length !== 5) throw new Error("preview must finish all five C1 evidence PNGs");
  const outputs = [];
  for (const output of capture.outputs) {
    if (!/^[a-z0-9-]+$/.test(output.id) || !HASH.test(output.pngSha256) || !Number.isSafeInteger(output.width) || output.width < 1920 || !Number.isSafeInteger(output.height) || output.height < 1080) throw new Error("preview output metadata is incomplete");
    const outputPath = resolve(context.root, output.path); if (!isInside(paths.capture, outputPath)) throw new Error("preview PNG escaped its private capture directory");
    await exact(outputPath, output.pngSha256, `finished preview PNG ${output.id}`); outputs.push({ ...output, absolutePath: outputPath });
  }
  return { capture, captureFile, capturePath, outputs };
}

async function preview(context, { execute, stageArtifact, now, uuid, blender, bun, captureRoot }) {
  const attemptId = safeAttemptId(now(), uuid()), attempt = join(context.sessionDirectory, "attempts", attemptId);
  await mkdir(dirname(attempt), { recursive: true, mode: 0o700 }); await chmod(dirname(attempt), 0o700); await mkdir(attempt, { recursive: false, mode: 0o700 }); await chmod(attempt, 0o700);
  const capture = join(captureRoot, `authoring-${basename(context.sessionDirectory)}-${attemptId}`);
  const paths = Object.freeze({ attempt, extraction: join(attempt, "bounded-extraction.json"), manifest: join(attempt, "composition-manifest-r4.json"), functionalEvidence: join(attempt, "functional-evidence-r4.json"), blend: join(attempt, "furnished-c1-r4.blend"), glb: join(attempt, "furnished-c1-r4.glb"), buildEvidence: join(attempt, "build-evidence-r4.json"), authority: join(attempt, "review-authority-r4.json"), capture, result: join(attempt, "preview-result.json") });
  await execute({ kind: "extract", command: blender, args: ["--background", context.workingCopy, "--python", inside(context.root, EXTRACTOR, "extractor"), "--", "--base-manifest", inside(context.root, BOUNDED_C1_BASE.manifestPath, "base manifest"), "--base-build-evidence", inside(context.root, BOUNDED_C1_BASE.buildEvidencePath, "base build evidence"), "--out", paths.extraction], cwd: context.root, env: process.env, paths, context });
  await assertWorkingUnchanged(context);
  const revision = await buildBoundedC1CompositionRevision({ extractionPath: portable(context.root, paths.extraction), outputPath: portable(context.root, paths.manifest), functionalEvidenceOutputPath: portable(context.root, paths.functionalEvidence), repoRoot: context.root, write: true });
  if (revision.evidence.verdict !== "pass" || revision.evidence.summary?.passed !== 8 || revision.evidence.summary?.failed !== 0) throw new Error("bounded C1 revision did not pass all eight functional checks");
  await execute({ kind: "build-source", command: bun, args: [inside(context.root, SOURCE_BUILDER, "source builder"), "--manifest", paths.manifest, "--out", paths.glb, "--blend-out", paths.blend, "--evidence", paths.buildEvidence], cwd: context.root, env: process.env, paths, context, revision });
  const manifestFile = await exact(paths.manifest, null, "C1 r4 manifest"), manifest = validateBuildingCompositionManifestV2(JSON.parse(manifestFile.bytes)), manifestHash = buildingCompositionManifestV2Hash(manifest);
  if (manifest.id !== "composition/functional-hall-house-v4/r4" || manifest.revision !== 4 || manifest.supersedes !== "composition/functional-hall-house-v4/r3") throw new Error("bounded rebuild is not append-only C1 r4");
  const functionalFile = await exact(paths.functionalEvidence, null, "C1 r4 functional evidence"), functional = JSON.parse(functionalFile.bytes);
  if (functional.verdict !== "pass" || functional.summary?.passed !== 8 || functional.summary?.failed !== 0) throw new Error("written C1 evidence does not bind eight passing checks");
  const built = await verifyBuildOutputs(context, paths, manifestFile.bytes, manifestHash);
  await execute({ kind: "build-authority", command: bun, args: [inside(context.root, AUTHORITY_BUILDER, "authority builder"), "--manifest", paths.manifest, "--functional-evidence", paths.functionalEvidence, "--build-evidence", paths.buildEvidence, "--out", paths.authority], cwd: context.root, env: process.env, paths, context, revision });
  const authorityFile = await exact(paths.authority, null, "C1 r4 review authority"), authority = JSON.parse(authorityFile.bytes);
  if (authority.schema !== "limina.building-composition-review-scene/v1" || authority.approvalPolicy?.renderer !== "limina-production-native-engine" || authority.approvalPolicy?.humanDecisionRequired !== true || authority.manifest?.path !== portable(context.root, paths.manifest) || authority.manifest?.sha256 !== manifestFile.sha256 || authority.manifest?.canonicalHash !== manifestHash || authority.functionalEvidence?.path !== portable(context.root, paths.functionalEvidence) || authority.integratedSource?.evidence?.path !== portable(context.root, paths.buildEvidence) || authority.integratedSource?.blend?.sha256 !== built.blend.sha256 || authority.integratedSource?.glb?.sha256 !== built.glb.sha256) throw new Error("C1 r4 review authority closure drifted");
  await execute({ kind: "capture", command: bun, args: [inside(context.root, GUARDED_CAPTURE_RUNNER, "guarded capture runner"), "--authority", paths.authority, "--out-dir", paths.capture], cwd: context.root, env: Object.fromEntries(Object.entries(process.env).filter(([key]) => !/TIMESTAMP/i.test(key))), paths, context });
  const captured = await verifyCapture(context, paths, authorityFile), staged = [];
  for (const output of captured.outputs) {
    const name = `c1-r4-${attemptId}-${output.id}.png`;
    const item = await stageArtifact({ source: output.absolutePath, name, expectedSha256: output.pngSha256.slice("sha256:".length), expectedWidth: output.width, expectedHeight: output.height });
    staged.push({ id: output.id, name, sha256: `sha256:${item.sha256}`, width: item.width, height: item.height, staged: item.staged });
  }
  await assertWorkingUnchanged(context);
  const result = { schema: "limina.building-authoring-preview-result/v1", status: "completed", createdAt: now().toISOString(), sessionManifest: { path: portable(context.root, context.sessionManifest), sha256: sha(context.sessionBytes) }, workingCopy: { path: portable(context.root, context.workingCopy), sha256: context.workingHash }, revision: { id: manifest.id, manifestPath: portable(context.root, paths.manifest), manifestSha256: manifestFile.sha256, manifestHash, functionalEvidencePath: portable(context.root, paths.functionalEvidence), functionalEvidenceSha256: functionalFile.sha256, checksPassed: 8 }, integratedSource: { blend: { path: portable(context.root, paths.blend), sha256: built.blend.sha256 }, glb: { path: portable(context.root, paths.glb), sha256: built.glb.sha256 }, evidence: { path: portable(context.root, paths.buildEvidence), sha256: built.evidenceFile.sha256 } }, authority: { path: portable(context.root, paths.authority), sha256: authorityFile.sha256 }, capture: { runner: GUARDED_CAPTURE_RUNNER, evidencePath: portable(context.root, captured.capturePath), evidenceSha256: captured.captureFile.sha256, xidObserved: false, timestampQueriesEnabled: false }, stagedArtifacts: staged, humanDecision: "pending" };
  await exclusiveJson(paths.result, result); return Object.freeze({ result, resultPath: paths.result });
}

async function submit(context, { now, uuid }) {
  const attemptsRoot = join(context.sessionDirectory, "attempts"), matches = [];
  for (const entry of await readdir(attemptsRoot, { withFileTypes: true }).catch((error) => error?.code === "ENOENT" ? [] : Promise.reject(error))) {
    if (!entry.isDirectory()) continue; const path = join(attemptsRoot, entry.name, "preview-result.json");
    try {
      const file = await exact(path, null, "preview result"), value = JSON.parse(file.bytes);
      if (value.schema !== "limina.building-authoring-preview-result/v1" || value.status !== "completed" || value.workingCopy?.path !== portable(context.root, context.workingCopy) || value.workingCopy?.sha256 !== context.workingHash || value.humanDecision !== "pending") continue;
      if (value.revision?.id !== "composition/functional-hall-house-v4/r4" || value.revision?.checksPassed !== 8 || value.capture?.runner !== GUARDED_CAPTURE_RUNNER || value.capture?.xidObserved !== false || value.capture?.timestampQueriesEnabled !== false || !Array.isArray(value.stagedArtifacts) || value.stagedArtifacts.length !== 5 || new Set(value.stagedArtifacts.map((item) => item.name)).size !== 5 || value.stagedArtifacts.some((item) => !HASH.test(item.sha256))) continue;
      for (const resource of [value.revision && { path: value.revision.manifestPath, sha256: value.revision.manifestSha256 }, value.revision && { path: value.revision.functionalEvidencePath, sha256: value.revision.functionalEvidenceSha256 }, value.integratedSource?.blend, value.integratedSource?.glb, value.integratedSource?.evidence, value.authority, value.capture && { path: value.capture.evidencePath, sha256: value.capture.evidenceSha256 }]) {
        if (!resource?.path || !HASH.test(resource.sha256)) throw new Error("completed preview provenance is incomplete"); await exact(inside(context.root, resource.path, "preview provenance"), resource.sha256, "preview provenance");
      }
      matches.push({ path, file, value });
    } catch (error) { if (error?.code !== "ENOENT") throw error; }
  }
  if (matches.length === 0) throw new Error("submission requires a completed engine preview for the identical working-copy hash");
  matches.sort((a, b) => String(b.value.createdAt).localeCompare(String(a.value.createdAt))); const preview = matches[0];
  const submission = { schema: "limina.building-authoring-submission/v1", status: "hitl-pending", createdAt: now().toISOString(), submissionId: `c1-r4-${safeUuid(uuid())}`, sessionManifest: { path: portable(context.root, context.sessionManifest), sha256: sha(context.sessionBytes) }, workingCopy: { path: portable(context.root, context.workingCopy), sha256: context.workingHash }, preview: { path: portable(context.root, preview.path), sha256: preview.file.sha256, authority: preview.value.authority, capture: preview.value.capture, stagedArtifacts: preview.value.stagedArtifacts }, revision: preview.value.revision, integratedSource: preview.value.integratedSource, humanDecision: "pending", approvalGranted: false };
  const output = join(context.sessionDirectory, "submissions", `${submission.submissionId}.json`); await exclusiveJson(output, submission); return Object.freeze({ submission, submissionPath: output });
}

export async function runBuildingAuthoringSession({ action, sessionPath, root = ROOT, execute = defaultExecute, stageArtifact = stageReviewArtifact, now = () => new Date(), uuid = randomUUID, blender = resolveBlender().binary, bun = process.env.LIMINA_BUN ?? "bun", captureRoot } = {}) {
  if (!['engine-preview', 'submit-revision'].includes(action)) throw new Error("action must be engine-preview or submit-revision");
  if (!sessionPath) throw new Error("sessionPath is required"); const context = await validateSession(sessionPath, root), selectedCaptureRoot = captureRoot ? inside(context.root, portable(context.root, resolve(captureRoot)), "capture root") : join(context.root, "assets/qc/internal/compositions");
  try { return action === "engine-preview" ? await preview(context, { execute, stageArtifact, now, uuid, blender, bun, captureRoot: selectedCaptureRoot }) : await submit(context, { now, uuid }); }
  finally { await assertApprovedUnchanged(context); }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const [action, ...args] = process.argv.slice(2), index = args.indexOf("--session");
  if (index < 0 || !args[index + 1]) throw new Error("usage: run-building-authoring-session.mjs <engine-preview|submit-revision> --session <private-session-manifest>");
  runBuildingAuthoringSession({ action, sessionPath: args[index + 1] }).then((value) => console.log(JSON.stringify(value, null, 2))).catch((error) => { console.error(error.stack ?? error.message); process.exitCode = 1; });
}
