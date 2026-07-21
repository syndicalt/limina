import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants, copyFile, chmod, lstat, mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildingCompositionManifestV2Hash, validateBuildingCompositionManifestV2 } from "../../js/src/assets/building-composition-manifest-v2.mjs";
import { validateBuildingHitlDecision, validateBuildingStageArtifact } from "../../js/src/assets/staged-building-pipeline.mjs";
import { resolveBlender } from "./blender-toolchain.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "../..");
const PATHS = Object.freeze({
  manifest: "assets/buildings/authoring/functional-hall-house-v4/composition-r3/composition-manifest.json",
  artifact: "assets/buildings/authoring/functional-hall-house-v4/composition-r3/composition-artifact-approved.json",
  decision: "assets/qc/internal/compositions/functional-hall-house-v4-c1-r3-v2/review-decision-approve.json",
  evidence: "assets/buildings/authoring/functional-hall-house-v4/composition-r3/build-evidence.json",
  blend: "assets/buildings/authoring/functional-hall-house-v4/composition-r3/furnished-c1-r3.blend",
  glb: "assets/buildings/authoring/functional-hall-house-v4/composition-r3/furnished-c1-r3.glb",
  addon: "tools/blender/limina-authoring-addon.py",
  orchestrator: "tools/architecture/run-building-authoring-session.mjs",
  sessions: ".limina/authoring-sessions",
});
const APPROVED = Object.freeze({
  manifest: "sha256:12b822f1fc688d0b4fed45f8d4bfc1a1c7acf8a781d443c55e2ca2d90f002a3e",
  canonicalManifest: "sha256:5a904a1d629aa82fa2b32e0ebb82dbc70c7da45428ebae22793f0ab0078fecd6",
  artifact: "sha256:1c699d4f1a8c9fbfe7bab5e03c0f4664b16ba3e7141bb6928edb15b6e2717fdb",
  decision: "sha256:b4a53f78b4cf032b7989b2e88989aee976faaf1b5b5068e6aabe3c8d18e7a5e6",
  evidence: "sha256:7c18144a19ab9b8dadfd274734d24b66b4186ab91df1dfb936cd1502501ffd39",
  blend: "sha256:5c0fa1aa5e237bf61eaa2e37690122b9b9d5fded8fca8ceb20e979a56eec34c1",
  glb: "sha256:adabb56bd808ea0731ec6f45531bc99ecb7670a8cf232769c9e93cc3c8fe94dd",
});

const sha256 = (bytes) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const portable = (root, path) => relative(root, path).split(sep).join("/");
const inside = (root, path) => {
  const absolute = resolve(root, path), rel = relative(root, absolute);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error(`Authoring path escapes workspace: ${path}`);
  return absolute;
};
async function exactFile(root, path, expected, label) {
  const absolute = inside(root, path), info = await lstat(absolute);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error(`${label} must be a regular, non-symlink file`);
  const bytes = await readFile(absolute), actual = sha256(bytes);
  if (expected && actual !== expected) throw new Error(`${label} hash drifted: expected ${expected}, got ${actual}`);
  return Object.freeze({ absolute, path: portable(root, absolute), bytes, sha256: actual, size: info.size });
}

export async function createC1AuthoringSession({ root = ROOT } = {}) {
  root = resolve(root);
  const [manifestFile, artifactFile, decisionFile, evidenceFile, addonFile] = await Promise.all([
    exactFile(root, PATHS.manifest, APPROVED.manifest, "C1 manifest"), exactFile(root, PATHS.artifact, APPROVED.artifact, "C1 approved artifact"),
    exactFile(root, PATHS.decision, APPROVED.decision, "C1 approval decision"), exactFile(root, PATHS.evidence, APPROVED.evidence, "C1 build evidence"),
    exactFile(root, PATHS.addon, null, "Limina authoring add-on"),
  ]);
  const manifest = validateBuildingCompositionManifestV2(JSON.parse(manifestFile.bytes)), canonicalHash = buildingCompositionManifestV2Hash(manifest);
  const artifact = validateBuildingStageArtifact(JSON.parse(artifactFile.bytes)), decision = validateBuildingHitlDecision(JSON.parse(decisionFile.bytes));
  const evidence = JSON.parse(evidenceFile.bytes);
  if (manifest.id !== "composition/functional-hall-house-v4/r3" || manifest.revision !== 3 || canonicalHash !== APPROVED.canonicalManifest) throw new Error("C1 manifest is not the approved r3 identity");
  if (artifact.status !== "approved" || artifact.kind !== "composition" || artifact.artifactId !== manifest.id || artifact.contractHash !== canonicalHash) throw new Error("C1 approved artifact does not bind the manifest");
  if (decision.decision !== "approve" || decision.gate !== "C1-composition" || decision.artifactId !== artifact.artifactId || decision.contractHash !== artifact.contractHash || decision.contentHash !== artifact.contentHash) throw new Error("C1 approval decision does not bind the approved artifact");
  if (artifact.metadata?.approval?.path !== decisionFile.path || artifact.metadata?.approval?.sha256 !== decisionFile.sha256 || artifact.metadata?.approval?.decisionId !== decision.decisionId) throw new Error("C1 artifact does not bind the exact approval bytes");
  if (evidence.id !== manifest.id || evidence.manifest?.path !== manifestFile.path || evidence.manifest?.sha256 !== manifestFile.sha256 || evidence.manifest?.canonicalHash !== canonicalHash) throw new Error("C1 build evidence does not bind the exact manifest");
  const [blendFile, glbFile] = await Promise.all([
    exactFile(root, evidence.sourceBlend?.path ?? PATHS.blend, APPROVED.blend, "C1 approved Blend"),
    exactFile(root, evidence.asset?.path ?? PATHS.glb, APPROVED.glb, "C1 approved GLB"),
  ]);
  if (blendFile.path !== PATHS.blend || glbFile.path !== PATHS.glb || evidence.sourceBlend?.sha256 !== APPROVED.blend || evidence.asset?.sha256 !== APPROVED.glb || evidence.sourceBlend?.bytes !== blendFile.size || evidence.asset?.bytes !== glbFile.size) throw new Error("C1 build outputs do not match the locked approved paths, hashes, and sizes");
  if (artifact.contentHash !== glbFile.sha256 || artifact.metadata?.integratedSource?.blend?.sha256 !== blendFile.sha256 || artifact.metadata?.integratedSource?.glb?.sha256 !== glbFile.sha256 || artifact.metadata?.integratedSource?.evidence?.sha256 !== evidenceFile.sha256) throw new Error("C1 integrated-source closure drifted");

  const sessionParent = inside(root, PATHS.sessions);
  await mkdir(sessionParent, { recursive: true, mode: 0o700 }); await chmod(sessionParent, 0o700);
  const sessionDirectory = await mkdtemp(join(sessionParent, "c1-")); await chmod(sessionDirectory, 0o700);
  const workingCopy = join(sessionDirectory, "furnished-c1-r3.working.blend");
  await copyFile(blendFile.absolute, workingCopy, constants.COPYFILE_EXCL); await chmod(workingCopy, 0o600);
  const copied = await exactFile(root, portable(root, workingCopy), blendFile.sha256, "C1 private working copy");
  const orchestrator = inside(root, PATHS.orchestrator);
  let orchestratorAvailable = false;
  try { orchestratorAvailable = (await stat(orchestrator)).isFile(); } catch {}
  const session = Object.freeze({
    schema: "limina.blender-authoring-session/v1", createdAt: new Date().toISOString(),
    composition: { id: manifest.id, revision: manifest.revision },
    manifest: { path: manifestFile.path, sha256: manifestFile.sha256, canonicalHash },
    approvedArtifact: { path: artifactFile.path, sha256: artifactFile.sha256, artifactId: artifact.artifactId, contentHash: artifact.contentHash },
    approvalDecision: { path: decisionFile.path, sha256: decisionFile.sha256, decisionId: decision.decisionId },
    buildEvidence: { path: evidenceFile.path, sha256: evidenceFile.sha256 },
    approvedSource: { path: blendFile.path, sha256: blendFile.sha256, bytes: blendFile.size },
    approvedRuntime: { path: glbFile.path, sha256: glbFile.sha256, bytes: glbFile.size },
    workingCopy: { path: portable(root, workingCopy), sha256: copied.sha256, bytes: copied.size },
    addon: { path: addonFile.path, sha256: addonFile.sha256 },
    hostOrchestrator: { path: PATHS.orchestrator, available: orchestratorAvailable },
    policy: { approvedSourceImmutable: true, genericGltfExportAllowed: false, enginePreviewRequiresHostOrchestrator: true },
  });
  const sessionManifest = join(sessionDirectory, "session-manifest.json");
  await writeFile(sessionManifest, `${JSON.stringify(session, null, 2)}\n`, { flag: "wx", mode: 0o600 }); await chmod(sessionManifest, 0o600);
  return Object.freeze({ root, sessionDirectory, sessionManifest, workingCopy, addon: addonFile.absolute, orchestrator, approvedSource: blendFile.absolute, approvedSourceSha256: blendFile.sha256, session });
}

export async function launchC1Authoring() {
  const created = await createC1AuthoringSession(), toolchain = resolveBlender();
  const child = spawn(toolchain.binary, [created.workingCopy, "--python", created.addon], { stdio: "inherit", env: { ...process.env,
    LIMINA_AUTHORING_SESSION_MANIFEST: created.sessionManifest, LIMINA_AUTHORING_WORKSPACE_ROOT: created.root,
    LIMINA_AUTHORING_HOST_ORCHESTRATOR: created.orchestrator, LIMINA_AUTHORING_HOST_RUNTIME: process.execPath,
  }});
  const code = await new Promise((done, reject) => { child.once("error", reject); child.once("exit", (value) => done(value ?? 1)); });
  await exactFile(created.root, portable(created.root, created.approvedSource), created.approvedSourceSha256, "C1 approved Blend after authoring");
  if (code !== 0) throw new Error(`Blender authoring session exited with status ${code}`);
  return created;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) launchC1Authoring().catch((error) => { console.error(error.stack ?? error.message); process.exitCode = 1; });
