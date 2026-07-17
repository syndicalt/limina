import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { validateBuildingHitlDecision, validateBuildingStageArtifact } from "../../js/src/assets/staged-building-pipeline.mjs";
import { validateBuildingCompositionManifestV2, buildingCompositionManifestV2Hash } from "../../js/src/assets/building-composition-manifest-v2.mjs";

const DEFAULTS = Object.freeze({
  shellArtifact: "assets/buildings/authoring/functional-hall-house-v4/shell-r4/shell-artifact-approved.json",
  materialArtifact: "assets/buildings/authoring/functional-hall-house-v4/material-r2/material-palette-artifact-approved.json",
  interiorArtifact: "assets/buildings/authoring/functional-hall-house-v4/interior-r4/interior-plan-artifact-approved.json",
  catalog: Object.freeze([
    Object.freeze({ role: "dining-table", archetypeId: "proxy/dining-table", artifact: "assets/buildings/authoring/furniture/dining-table-v1/approved-artifact.json" }),
    Object.freeze({ role: "dining-chair", archetypeId: "proxy/dining-chair", artifact: "assets/buildings/authoring/furniture/dining-chair-v1-r4/approved-artifact.json" }),
    Object.freeze({ role: "hearth-settle", archetypeId: "proxy/hearth-settle", artifact: "assets/buildings/authoring/furniture/hearth-settle-v3-r6/approved-artifact.json" }),
    Object.freeze({ role: "service-storage", archetypeId: "proxy/storage-shelf", artifact: "assets/buildings/authoring/furniture/service-storage-v1-r1/approved-artifact.json" }),
  ]),
  output: "assets/buildings/authoring/functional-hall-house-v4/composition-r3/composition-manifest.json",
});
const EXPECTED = Object.freeze({
  shell: "shell/functional-hall-house-v4/r4",
  materials: "materials/functional-hall-house-v4/r2",
  interior: "interior/functional-hall-house-v4/r4",
});
const FACING_MAX_DEGREES = Object.freeze({ "dining-chair": 1, "hearth-settle": 7 });

const sha = (bytes) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const portable = (root, path) => relative(root, path).split(sep).join("/");
const absolute = (root, path) => resolve(root, path);

async function loadBytes(root, path) {
  const fullPath = absolute(root, path), bytes = await readFile(fullPath);
  return Object.freeze({ path: portable(root, fullPath), fullPath, bytes, sha256: sha(bytes) });
}
async function loadJson(root, path) {
  const loaded = await loadBytes(root, path);
  return Object.freeze({ ...loaded, json: JSON.parse(loaded.bytes.toString("utf8")) });
}
function resource(loaded) { return Object.freeze({ path: loaded.path, sha256: loaded.sha256 }); }
function stageRef(loaded, artifact) {
  return Object.freeze({ artifactPath: loaded.path, artifactSha256: loaded.sha256, artifactId: artifact.artifactId, kind: artifact.kind,
    status: artifact.status, contractHash: artifact.contractHash, contentHash: artifact.contentHash });
}
function exactApproval(artifact, decision, gate, label) {
  if (decision.decision !== "approve" || decision.gate !== gate || decision.blockingFindings.length !== 0) throw new Error(`${label} lacks an exact ${gate} approval`);
  for (const key of ["artifactId", "contractHash", "contentHash"]) if (decision[key] !== artifact[key]) throw new Error(`${label} approval disagrees on ${key}`);
}
function exactPathRecord(record, loaded, label) {
  if (!record || record.path !== loaded.path || record.sha256 !== loaded.sha256) throw new Error(`${label} exact resource identity drifted`);
}

async function approvedStage(root, artifactPath, expectedId, gate) {
  const artifactFile = await loadJson(root, artifactPath), artifact = validateBuildingStageArtifact(artifactFile.json);
  if (artifact.artifactId !== expectedId || artifact.status !== "approved") throw new Error(`${expectedId} is not the selected approved artifact`);
  const decisionPath = artifact.metadata?.approval?.path;
  if (typeof decisionPath !== "string") throw new Error(`${expectedId} lacks an approval decision path`);
  const decisionFile = await loadJson(root, decisionPath), decision = validateBuildingHitlDecision(decisionFile.json);
  exactApproval(artifact, decision, gate, expectedId);
  if (artifact.metadata.approval.sha256 !== decisionFile.sha256) throw new Error(`${expectedId} approval bytes drifted`);
  return Object.freeze({ artifactFile, artifact, decisionFile, decision });
}

async function approvedFurniture(root, config) {
  // Furniture artifact ids are derived from the exact approved artifacts rather than duplicated in configuration.
  const artifactFile = await loadJson(root, config.artifact), artifact = validateBuildingStageArtifact(artifactFile.json);
  if (artifact.kind !== "furniture-pack" || artifact.status !== "approved") throw new Error(`${config.role} is not an approved furniture pack`);
  const decisionFile = await loadJson(root, artifact.metadata?.approval?.path ?? "__missing_approval__");
  const decision = validateBuildingHitlDecision(decisionFile.json); exactApproval(artifact, decision, "F1-asset", config.role);
  if (artifact.metadata.approval.sha256 !== decisionFile.sha256) throw new Error(`${config.role} approval bytes drifted`);
  const stage = Object.freeze({ artifactFile, artifact, decisionFile, decision });
  if (stage.artifact.kind !== "furniture-pack") throw new Error(`${config.role} artifact kind drifted`);
  const authorityFile = await loadJson(root, stage.artifact.metadata?.authority?.path ?? "__missing_authority__");
  exactPathRecord(stage.artifact.metadata.authority, authorityFile, `${config.role} review authority`);
  const authority = authorityFile.json;
  if (authority.pack?.sha256 !== stage.artifact.contentHash) throw new Error(`${config.role} authority runtime identity drifted`);
  const [contractFile, buildEvidenceFile, functionalEvidenceFile, sourceBlendFile, runtimeGlbFile] = await Promise.all([
    loadJson(root, stage.artifact.metadata?.functionalEvidence?.contractPath ?? "__missing_contract__"),
    loadJson(root, authority.pack?.evidencePath ?? "__missing_build_evidence__"),
    loadJson(root, stage.artifact.metadata?.functionalEvidence?.path ?? "__missing_functional_evidence__"),
    loadBytes(root, authority.source?.blendPath ?? "__missing_source_blend__"),
    loadBytes(root, `assets/${authority.pack?.assetId ?? "__missing_runtime_glb__"}`),
  ]);
  if (contractFile.json.role !== config.role) throw new Error(`${config.role} design contract role drifted`);
  if (stage.artifact.metadata.selectedProxy?.archetypeId !== config.archetypeId) throw new Error(`${config.role} selected I1 proxy drifted`);
  if (stage.artifact.metadata.functionalEvidence.contractHash !== stage.artifact.contractHash
      || stage.artifact.metadata.functionalEvidence.contractSha256 !== contractFile.sha256) throw new Error(`${config.role} contract identity drifted`);
  if (stage.artifact.metadata.functionalEvidence.sha256 !== functionalEvidenceFile.sha256
      || functionalEvidenceFile.json.verdict !== "pass") throw new Error(`${config.role} functional evidence is not an exact pass`);
  if (functionalEvidenceFile.json.inputs?.runtimeGlbSha256 !== stage.artifact.contentHash) throw new Error(`${config.role} functional evidence runtime drifted`);
  if (authority.pack.evidenceSha256 !== buildEvidenceFile.sha256) throw new Error(`${config.role} build evidence drifted`);
  if (authority.source.blendSha256 !== sourceBlendFile.sha256) throw new Error(`${config.role} source blend drifted`);
  if (runtimeGlbFile.sha256 !== stage.artifact.contentHash) throw new Error(`${config.role} runtime GLB drifted`);
  return Object.freeze({ ...stage, config, authorityFile, authority, contractFile, contract: contractFile.json, buildEvidenceFile,
    functionalEvidenceFile, sourceBlendFile, runtimeGlbFile });
}

function catalogEntry(item) {
  return Object.freeze({ role: item.config.role, artifact: stageRef(item.artifactFile, item.artifact), approvalDecision: resource(item.decisionFile),
    designContract: resource(item.contractFile), buildEvidence: resource(item.buildEvidenceFile), functionalEvidence: resource(item.functionalEvidenceFile),
    sourceBlend: resource(item.sourceBlendFile), runtimeGlb: resource(item.runtimeGlbFile) });
}

function instanceFor(plan, placement, catalogByArchetype) {
  const item = catalogByArchetype.get(placement.archetypeId);
  if (!item) throw new Error(`I1 placement ${placement.id} has no exact approved catalog asset`);
  const socket = plan.surfaceSockets.find((entry) => entry.id === placement.supportSocketId);
  if (!socket || socket.kind !== "floor" || socket.roomId !== placement.roomId) throw new Error(`I1 placement ${placement.id} has no exact floor support`);
  const clearances = plan.interactionClearances.filter((entry) => entry.placementId === placement.id);
  if (clearances.length === 0) throw new Error(`I1 placement ${placement.id} has no interaction clearance`);
  const occupancySocketIds = item.contract.sockets.filter((entry) => entry.kind === "occupancy").map((entry) => entry.id);
  const approachSocketIds = item.contract.sockets.filter((entry) => entry.kind === "approach").map((entry) => entry.id);
  const facingMaxDegrees = FACING_MAX_DEGREES[item.config.role];
  if ((placement.facingTargetId === null) !== (facingMaxDegrees === undefined)) throw new Error(`I1 placement ${placement.id} facing policy drifted`);
  const facing = placement.facingTargetId === null ? null : Object.freeze({ socketIds: occupancySocketIds,
    targetSemanticId: placement.facingTargetId, minimumDot: Math.cos(facingMaxDegrees * Math.PI / 180) });
  return Object.freeze({
    id: `instance/${placement.id.slice("placement/".length)}`, kind: "furniture", role: item.config.role,
    catalogArtifactId: item.artifact.artifactId,
    placement: Object.freeze({ position: [...placement.position], yawRadians: placement.yawRadians, scale: [1, 1, 1] }),
    replacesSemanticIds: Object.freeze([placement.id]),
    bindings: Object.freeze({ roomId: placement.roomId, zoneId: placement.zoneId, supportSocketId: placement.supportSocketId,
      facingTargetId: placement.facingTargetId, occupancySocketIds: Object.freeze(occupancySocketIds),
      approachSocketIds: Object.freeze(approachSocketIds), clearanceIds: Object.freeze(clearances.map((entry) => entry.id)) }),
    constraints: Object.freeze({ floorContact: Object.freeze({ surfaceId: socket.surfaceId, targetY: socket.position[1], toleranceM: 0.005 }),
      containment: Object.freeze({ roomId: placement.roomId }), facing, approachCollisionFree: approachSocketIds.length > 0 }),
  });
}

export async function buildFurnishedC1Composition({ repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../.."),
  outputPath = DEFAULTS.output, write = false } = {}) {
  const root = resolve(repoRoot);
  const [shell, materials, interior, ...catalog] = await Promise.all([
    approvedStage(root, DEFAULTS.shellArtifact, EXPECTED.shell, "A1-shell"),
    approvedStage(root, DEFAULTS.materialArtifact, EXPECTED.materials, "M1-materials"),
    approvedStage(root, DEFAULTS.interiorArtifact, EXPECTED.interior, "I1-layout"),
    ...DEFAULTS.catalog.map((entry) => approvedFurniture(root, entry)),
  ]);
  const shellSource = await loadBytes(root, shell.artifact.metadata?.sourceBlend?.path ?? "__missing_shell_source__");
  const shellRuntime = await loadBytes(root, shell.artifact.metadata?.runtimeGlb?.path ?? "__missing_shell_runtime__");
  exactPathRecord(shell.artifact.metadata.sourceBlend, shellSource, "shell source blend");
  exactPathRecord(shell.artifact.metadata.runtimeGlb, shellRuntime, "shell runtime GLB");
  const materialsLock = await loadBytes(root, materials.artifact.metadata?.materialsLock?.path ?? "__missing_materials_lock__");
  const materialRuntime = await loadBytes(root, materials.artifact.metadata?.derivedRuntime?.path ?? "__missing_material_runtime__");
  exactPathRecord(materials.artifact.metadata.materialsLock, materialsLock, "M1 materials lock");
  if (materials.artifact.metadata.derivedRuntime?.sha256 !== materialRuntime.sha256 || materialRuntime.sha256 !== materials.artifact.contentHash) throw new Error("M1 derived runtime drifted");
  const planFile = await loadJson(root, interior.artifact.metadata?.plan?.path ?? "__missing_i1_plan__"), plan = planFile.json;
  if (planFile.sha256 !== interior.artifact.contentHash || plan.planId !== EXPECTED.interior || plan.revision !== 4) throw new Error("I1 r4 plan identity drifted");
  const catalogByArchetype = new Map(catalog.map((entry) => [entry.config.archetypeId, entry]));
  const instances = plan.placements.map((placement) => instanceFor(plan, placement, catalogByArchetype));
  const counts = Object.fromEntries([...catalogByArchetype].map(([archetype]) => [archetype, plan.placements.filter((entry) => entry.archetypeId === archetype).length]));
  if (instances.length !== 7 || counts["proxy/dining-table"] !== 1 || counts["proxy/dining-chair"] !== 4
      || counts["proxy/hearth-settle"] !== 1 || counts["proxy/storage-shelf"] !== 1) throw new Error("I1 r4 furnished placement inventory drifted");
  const manifest = validateBuildingCompositionManifestV2({
    schema: "limina.building-composition-manifest/v2", id: "composition/functional-hall-house-v4/r3", revision: 3,
    supersedes: "composition/functional-hall-house-v4/r2",
    buildingId: "hall-house/temperate/v4", coordinateSystem: { units: "meter", up: "Y", front: "-Z" },
    dependencies: {
      shell: { artifact: stageRef(shell.artifactFile, shell.artifact), approvalDecision: resource(shell.decisionFile), sourceBlend: resource(shellSource), runtimeGlb: resource(shellRuntime) },
      materialPalette: { artifact: stageRef(materials.artifactFile, materials.artifact), approvalDecision: resource(materials.decisionFile), materialsLock: resource(materialsLock), runtimeGlb: resource(materialRuntime) },
      interiorPlan: { artifact: stageRef(interior.artifactFile, interior.artifact), approvalDecision: resource(interior.decisionFile), plan: resource(planFile) },
      catalog: catalog.map(catalogEntry),
    },
    instances,
    legacyExclusions: plan.placements.map((placement) => placement.id),
    metadata: { gate: "C1-composition", sourcePlanId: plan.planId, exactApprovedInputs: true, instanceCount: instances.length,
      facingPolicy: { diningChairMaxDegrees: 1, hearthSettlePerSeatMaxDegrees: 7, basis: "role-aware-shared-target-seat-parallax" },
      fireRuntime: { included: false, reason: "pending-v1-vfx-gate" } },
  });
  const result = Object.freeze({ manifest, manifestHash: buildingCompositionManifestV2Hash(manifest) });
  if (write) {
    if (typeof outputPath !== "string" || outputPath.startsWith("/") || outputPath.includes("\\") || outputPath.split("/").includes("..")) {
      throw new Error("C1 output must be a repository-relative portable path");
    }
    const output = absolute(root, outputPath); await mkdir(dirname(output), { recursive: true, mode: 0o700 });
    await writeFile(output, `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  }
  return result;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const args = process.argv.slice(2), at = (flag) => { const index = args.indexOf(flag); if (index < 0 || !args[index + 1]) throw new Error(`missing ${flag}`); return args[index + 1]; };
  const result = await buildFurnishedC1Composition({ outputPath: at("--out"), write: true });
  console.log(JSON.stringify({ schema: result.manifest.schema, id: result.manifest.id, instances: result.manifest.instances.length,
    manifestHash: result.manifestHash }, null, 2));
}
