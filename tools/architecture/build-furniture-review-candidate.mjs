import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import {
  furnitureDesignContractHash,
  validateFurnitureDesignContract,
  validateVisualDesignContract,
  visualDesignContractHash,
} from "../../js/src/architecture/index.ts";
import {
  buildingInteriorPlanV2Hash,
  interiorPlacementFacetScope,
  validateBuildingInteriorPlanV2,
} from "../../js/src/assets/building-interior-plan-v2.mjs";
import {
  validateBuildingHitlDecision,
  validateBuildingStageArtifact,
} from "../../js/src/assets/staged-building-pipeline.mjs";
import { portableAssetContentHash } from "../../js/src/world/asset-content-hash.mjs";

const DEFAULT_ROOT = resolve(import.meta.dirname, "../..");
const sha = (bytes) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
  portable = (root, path) => {
    const value = relative(root, path).split(sep).join("/");
    if (!value || value === ".." || value.startsWith("../") || isAbsolute(value))
      throw new Error(`F1 candidate input escapes repository: ${path}`);
    return value;
  },
  exact = (a, b) => JSON.stringify(a) === JSON.stringify(b),
  integer = (value, minimum = 0) => Number.isSafeInteger(value) && value >= minimum;
const pngDimensions = (bytes) => {
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  if (
    bytes.length < 24 ||
    signature.some((value, index) => bytes[index] !== value) ||
    bytes.toString("ascii", 12, 16) !== "IHDR"
  )
    throw new Error("F1 evidence is not a PNG with an IHDR");
  return [bytes.readUInt32BE(16), bytes.readUInt32BE(20)];
};
const exactFile = async (root, entry, label) => {
  const absolute = resolve(root, entry.path);
  if (portable(root, absolute) !== entry.path) throw new Error(`${label} path is not canonical`);
  const bytes = await readFile(absolute);
  if (sha(bytes) !== entry.sha256 || portableAssetContentHash(bytes) !== entry.contentHash)
    throw new Error(`${label} bytes drifted`);
  return bytes;
};
const facets = (artifact, expected, label) => {
  const actual = expected.map(({ scope }) => artifact.facets.find((facet) => facet.scope === scope));
  if (actual.some((facet, index) => !facet || facet.hash !== expected[index].hash))
    throw new Error(`${label} facet closure drifted`);
};
function telemetry(record) {
  const submission = record.renderSubmission,
    paired = record.pairedRenderSubmission,
    resources = record.rendererResources;
  if (
    submission?.schema !== "limina.three-render-submission/v2" ||
    submission.source !== "three-webgpu-renderer-info" ||
    submission.scope !== "single-production-frame-all-passes" ||
    submission.instanceAccounting !== "full-draw-instance-count" ||
    !integer(submission.frameId, 1) ||
    !integer(submission.renderCalls, 1) ||
    !integer(submission.drawCalls, 1) ||
    !integer(submission.triangles, 1) ||
    !Number.isFinite(submission.cpuEncodeMs) ||
    submission.cpuEncodeMs < 0
  )
    throw new Error(`F1 ${record.id} lacks whole-frame telemetry`);
  if (
    paired?.schema !== "limina.paired-render-submission/v1" ||
    paired.basis !== "same-process-fixed-camera-time-residency-post-visibility-toggle" ||
    paired.candidate?.frameId !== paired.baseline?.frameId + 1 ||
    paired.candidate?.drawCalls !== submission.drawCalls ||
    paired.candidate?.triangles !== submission.triangles ||
    paired.delta?.drawCalls !== paired.candidate.drawCalls - paired.baseline.drawCalls ||
    paired.delta?.triangles !== paired.candidate.triangles - paired.baseline.triangles ||
    !integer(paired.delta.drawCalls, 1) ||
    !integer(paired.delta.triangles, 1)
  )
    throw new Error(`F1 ${record.id} lacks paired subject telemetry`);
  const values =
    resources === undefined ? [] : [...Object.values(resources.counts ?? {}), ...Object.values(resources.bytes ?? {})];
  if (
    resources?.schema !== "limina.three-render-resources/v1" ||
    resources.source !== "three-webgpu-renderer-info" ||
    resources.scope !== "renderer-live-after-production-frame" ||
    values.length !== 12 ||
    values.some((value) => !integer(value))
  )
    throw new Error(`F1 ${record.id} lacks renderer resource telemetry`);
}
async function dependency(root, entry, kind, gate) {
  const [artifactBytes, decisionBytes] = await Promise.all([
      exactFile(root, entry, `${kind} artifact`),
      exactFile(root, entry.decision, `${kind} decision`),
    ]),
    artifact = validateBuildingStageArtifact(JSON.parse(artifactBytes)),
    decision = validateBuildingHitlDecision(JSON.parse(decisionBytes));
  if (
    artifact.kind !== kind ||
    artifact.status !== "approved" ||
    artifact.artifactId !== entry.artifactId ||
    artifact.revision !== entry.revision ||
    artifact.contractHash !== entry.contractHash ||
    artifact.contentHash !== entry.assetContentHash ||
    decision.decision !== "approve" ||
    decision.gate !== gate ||
    decision.decisionId !== entry.decision.decisionId ||
    decision.artifactId !== artifact.artifactId ||
    decision.contractHash !== artifact.contractHash ||
    decision.contentHash !== artifact.contentHash ||
    artifact.metadata?.approval?.path !== entry.decision.path ||
    artifact.metadata?.approval?.sha256 !== entry.decision.sha256 ||
    artifact.metadata?.approval?.decisionId !== entry.decision.decisionId
  )
    throw new Error(`F1 exact approved ${kind} dependency drifted`);
  facets(artifact, entry.facets, kind);
  return artifact;
}

export function validateFurnitureCaptureEnvelope(authority, capture, authorityIdentity) {
  if (
    capture.schema !== "limina.furniture-pack-native-review-set/v1" ||
    capture.backend !== "native-webgpu" ||
    capture.captureClass !== "production-engine" ||
    capture.pixelFormat !== "rgba8unorm" ||
    capture.rowOrigin !== "top-left" ||
    capture.authority?.path !== authorityIdentity.path ||
    capture.authority?.sha256 !== authorityIdentity.sha256 ||
    capture.authority?.contentHash !== authorityIdentity.contentHash ||
    !exact(capture.pack, authority.pack) ||
    !exact(capture.source, authority.source) ||
    !exact(capture.dependencies, authority.dependencies) ||
    !exact(capture.functionalEvidence, authority.functionalEvidence) ||
    !exact(capture.mounted?.functionalEvidence, authority.functionalEvidence) ||
    capture.mounted?.collisionEvidence !== "compound-semantic-functional-placement"
  )
    throw new Error("capture does not bind the exact F1 authority and dependency closures");
  if (
    capture.guardEvidence?.schema !== "limina.nvidia-xid-guard/v1" ||
    capture.guardEvidence.preflight?.xidObserved !== false ||
    capture.guardEvidence.live?.xidObserved !== false ||
    capture.guardEvidence.postflight?.xidObserved !== false ||
    capture.timingPolicy?.gpuTimestampMode !== "disabled" ||
    capture.timingPolicy?.timestampQueriesEnabled !== false
  )
    throw new Error("F1 capture lacks the absolute native GPU guard contract");
  return capture;
}

/** CPU-only validation and promotion. This function never starts the engine or a renderer. */
export async function buildFurnitureReviewCandidate({
  repoRoot = DEFAULT_ROOT,
  authorityPath,
  capturePath,
  outputPath,
  write = true,
}) {
  const root = resolve(repoRoot),
    authorityAbsolute = resolve(root, authorityPath),
    captureAbsolute = resolve(root, capturePath),
    outputAbsolute = resolve(root, outputPath),
    privateRoot = resolve(root, "assets/qc/internal/furniture"),
    captureRelative = relative(privateRoot, captureAbsolute);
  if (
    !captureRelative ||
    captureRelative === ".." ||
    captureRelative.startsWith(`..${sep}`) ||
    isAbsolute(captureRelative)
  )
    throw new Error("F1 capture evidence must remain in the private furniture review directory");
  const [authorityBytes, captureBytes] = await Promise.all([readFile(authorityAbsolute), readFile(captureAbsolute)]),
    authority = JSON.parse(authorityBytes),
    capture = JSON.parse(captureBytes);
  if (
    authority.schema !== "limina.furniture-pack-review-scene/v1" ||
    authority.functionalEvidence?.schema !== "limina.furniture-functional-evidence/v1" ||
    authority.functionalEvidence.placementSkill !== "furniture.placeFunctional" ||
    authority.functionalEvidence.collisionPolicy !== "compound-semantic"
  )
    throw new Error("F1 authority lacks typed functional evidence");
  const functionalBytes = await exactFile(root, authority.functionalEvidence, "functional verifier evidence"),
    functionalArtifact = JSON.parse(functionalBytes),
    functionalFields = ({ schema, verdict, inputs, policy, checks, summary }) => ({
      schema,
      verdict,
      inputs,
      policy,
      checks,
      summary,
    });
  if (
    !exact(functionalFields(functionalArtifact), functionalFields(authority.functionalEvidence)) ||
    functionalArtifact.verdict !== "pass" ||
    !Array.isArray(functionalArtifact.checks) ||
    functionalArtifact.checks.length < 1 ||
    functionalArtifact.checks.some((check) => check.passed !== true || check.findings?.length !== 0) ||
    functionalArtifact.summary?.failed !== 0 ||
    functionalArtifact.summary?.passed !== functionalArtifact.checks.length
  )
    throw new Error("F1 functional verifier pass artifact drifted or no longer proves every check");
  const evidenceBytes = await readFile(resolve(root, authority.pack.evidencePath)),
    evidence = JSON.parse(evidenceBytes);
  if (
    sha(evidenceBytes) !== authority.pack.evidenceSha256 ||
    evidence.schema !== "limina.furniture-contract-build-evidence/v1" ||
    evidence.payloadHash !== authority.pack.payloadHash ||
    evidence.sourceSpecHash !== authority.pack.sourceSpecHash ||
    evidence.sourceIrHash !== authority.pack.sourceIrHash ||
    evidence.contract?.hash !== authority.functionalEvidence.contractHash
  )
    throw new Error("F1 authority typed build evidence bytes drifted");
  const visualBytes = await exactFile(root, authority.visualDesign, "visual design contract"),
    visual = validateVisualDesignContract(JSON.parse(visualBytes));
  if (
    visual.id !== authority.visualDesign.id ||
    visualDesignContractHash(visual) !== authority.visualDesign.hash ||
    !exact(
      visual.cues.map((cue) => cue.id),
      authority.visualDesign.cueIds,
    ) ||
    !exact(visual.requiredViews, authority.visualDesign.requiredViews)
  )
    throw new Error("F1 visual cue contract drifted");
  const [assetBytes, blendBytes, contractBytes] = await Promise.all([
    readFile(resolve(root, "assets", authority.pack.assetId)),
    readFile(resolve(root, authority.source.blendPath)),
    readFile(resolve(root, authority.functionalEvidence.contractPath)),
  ]);
  if (
    sha(assetBytes) !== authority.pack.sha256 ||
    portableAssetContentHash(assetBytes) !== authority.pack.assetHash ||
    sha(blendBytes) !== authority.source.blendSha256 ||
    sha(contractBytes) !== authority.functionalEvidence.contractSha256 ||
    portableAssetContentHash(contractBytes) !== authority.functionalEvidence.contractContentHash
  )
    throw new Error("F1 authority asset/source/contract bytes drifted");
  const contract = validateFurnitureDesignContract(JSON.parse(contractBytes), visual),
    functional = authority.functionalEvidence,
    contractCounts = {
      parts: contract.parts.length,
      joints: contract.joints.length,
      sockets: contract.sockets.length,
      occupancySockets: contract.sockets.filter((socket) => socket.kind === "occupancy").length,
      approachSockets: contract.sockets.filter((socket) => socket.kind === "approach").length,
      colliders: contract.colliders.length,
    };
  if (
    furnitureDesignContractHash(contract) !== functional.contractHash ||
    Object.entries(contractCounts).some(([key, value]) => functional[key] !== value) ||
    !exact(contract.materialRoles, functional.materialRoles)
  )
    throw new Error("F1 functional contract evidence drifted");
  const [i1, m1] = await Promise.all([
    dependency(root, authority.dependencies.interior.artifact, "interior-plan", "I1-layout"),
    dependency(root, authority.dependencies.materials.artifact, "material-palette", "M1-materials"),
  ]);
  const planBytes = await exactFile(root, authority.dependencies.interior.plan, "I1 plan"),
    plan = validateBuildingInteriorPlanV2(JSON.parse(planBytes));
  if (
    plan.planId !== authority.dependencies.interior.plan.planId ||
    plan.revision !== authority.dependencies.interior.plan.revision ||
    buildingInteriorPlanV2Hash(plan) !== authority.dependencies.interior.plan.canonicalHash ||
    sha(planBytes) !== i1.contentHash ||
    i1.contractHash !== authority.dependencies.interior.plan.canonicalHash
  )
    throw new Error("F1 exact approved I1 plan drifted");
  const selected = authority.dependencies.interior.selectedProxy,
    placementScope = plan.revision >= 2 ? interiorPlacementFacetScope(selected.archetypeId) : "placements",
    expectedInteriorScopes = [placementScope, "support-bindings"],
    interiorFacets = authority.dependencies.interior.artifact.facets,
    proxy = plan.proxyArchetypes.find((entry) => entry.id === selected.archetypeId),
    placementIds = plan.placements
      .filter((entry) => entry.archetypeId === selected.archetypeId)
      .map((entry) => entry.id),
    functionalInputs = authority.functionalEvidence.inputs;
  if (
    !proxy ||
    !exact(
      interiorFacets.map((facet) => facet.scope),
      expectedInteriorScopes,
    ) ||
    !exact(proxy, {
      dimensions: selected.dimensions,
      id: selected.archetypeId,
      kind: selected.kind,
      requiresApproach: selected.requiresApproach,
      requiresOccupancy: selected.requiresOccupancy,
      supportKind: selected.supportKind,
    }) ||
    !exact(placementIds, selected.placementIds) ||
    selected.placementFacetHash !== interiorFacets.find((facet) => facet.scope === placementScope)?.hash ||
    functionalInputs.furnitureContractHash !== authority.functionalEvidence.contractHash ||
    functionalInputs.runtimeGlbSha256 !== authority.pack.sha256 ||
    functionalInputs.runtimeSemanticInventorySha256 !== evidence.freshProcessValidation?.semanticInventorySha256 ||
    functionalInputs.interiorArtifactId !== i1.artifactId ||
    functionalInputs.interiorContractHash !== i1.contractHash ||
    functionalInputs.interiorContentHash !== i1.contentHash ||
    functionalInputs.selectedProxyArchetypeId !== selected.archetypeId
  )
    throw new Error("F1 selected I1 proxy/placement or verifier-input binding drifted");
  facets(m1, authority.dependencies.materials.requiredFacets, "required M1 material");
  validateFurnitureCaptureEnvelope(authority, capture, {
    path: portable(root, authorityAbsolute),
    sha256: sha(authorityBytes),
    contentHash: portableAssetContentHash(authorityBytes),
  });
  if (
    !integer(capture.lifecycle?.baselineEntities) ||
    capture.lifecycle.afterDisposeEntities !== capture.lifecycle.baselineEntities
  )
    throw new Error("F1 capture lacks lifecycle return evidence");
  const views = authority.evidenceViews;
  if (
    views.length < 5 ||
    views
      .slice(0, 5)
      .map(({ id }) => id)
      .join(",") !== "front,right-side,back,three-quarter,joinery-detail" ||
    !Array.isArray(capture.captures) ||
    capture.captures.length !== views.length ||
    !Array.isArray(capture.outputs) ||
    capture.outputs.length !== views.length
  )
    throw new Error("F1 capture lacks the authority evidence view set");
  const evidenceOut = [];
  for (let index = 0; index < views.length; index++) {
    const view = views[index],
      record = capture.captures[index],
      output = capture.outputs[index];
    if (
      record.id !== view.id ||
      output.id !== view.id ||
      record.role !== view.role ||
      output.role !== view.role ||
      !exact(record.reviewState, { type: view.type, state: view.state, appliedState: `${view.type}:${view.state}` }) ||
      record.width !== output.width ||
      record.height !== output.height ||
      record.rgbaContentHash !== output.rgbaContentHash ||
      output.width < authority.presentation.minimumResolution[0] ||
      output.height < authority.presentation.minimumResolution[1] ||
      !integer(output.pngByteLength, 1)
    )
      throw new Error(`F1 evidence view ${view.id} is incomplete or mislabeled`);
    telemetry(record);
    const pngAbsolute = resolve(root, output.path),
      privateRoot = resolve(root, "assets/qc/internal/furniture"),
      rel = relative(privateRoot, pngAbsolute);
    if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel))
      throw new Error(`F1 PNG escaped private furniture review directory: ${output.path}`);
    const png = await readFile(pngAbsolute),
      dimensions = pngDimensions(png);
    if (
      png.length !== output.pngByteLength ||
      sha(png) !== output.pngSha256 ||
      dimensions[0] !== output.width ||
      dimensions[1] !== output.height
    )
      throw new Error(`F1 PNG bytes or dimensions drifted: ${output.path}`);
    evidenceOut.push({
      evidenceId: `${authority.pack.id}/${view.id}`,
      kind: "production-engine-png",
      contentHash: output.pngSha256,
      width: output.width,
      height: output.height,
    });
  }
  if (new Set(evidenceOut.map((entry) => entry.contentHash)).size !== evidenceOut.length)
    throw new Error("F1 evidence PNG hashes must be distinct");
  const hashObject = (value) => sha(Buffer.from(JSON.stringify(value))),
    lodProof = evidence.glbValidation?.lodValidation,
    artifactFacets = [
      { scope: "placement-contract", hash: hashObject({ dimensions: contract.dimensions, proxy: selected }) },
      { scope: "interaction-sockets", hash: hashObject(contract.sockets) },
      { scope: "joinery-contract", hash: hashObject(contract.joints) },
      { scope: "collision", hash: hashObject(contract.colliders) },
      { scope: "material-role-slots", hash: hashObject(contract.materialRoles) },
      { scope: "runtime-geometry", hash: authority.pack.assetHash },
    ];
  if (lodProof?.proven === true) artifactFacets.push({ scope: "lod-contract", hash: hashObject(lodProof) });
  const candidate = validateBuildingStageArtifact({
    schema: "limina.building-stage-artifact/v1",
    artifactId: `furniture/${authority.pack.id}/r1`,
    kind: "furniture-pack",
    revision: 1,
    status: "candidate",
    contractHash: authority.pack.payloadHash,
    contentHash: authority.pack.sha256,
    facets: artifactFacets,
    inputs: [
      { artifactId: i1.artifactId, kind: "interior-plan", facets: authority.dependencies.interior.artifact.facets },
      { artifactId: m1.artifactId, kind: "material-palette", facets: authority.dependencies.materials.requiredFacets },
    ],
    evidence: evidenceOut,
    metadata: {
      gate: "F1-asset",
      authority: {
        path: portable(root, authorityAbsolute),
        sha256: sha(authorityBytes),
        contentHash: portableAssetContentHash(authorityBytes),
      },
      capture: {
        path: portable(root, captureAbsolute),
        sha256: sha(captureBytes),
        contentHash: portableAssetContentHash(captureBytes),
        backend: capture.backend,
      },
      selectedProxy: selected,
      functionalEvidence: authority.functionalEvidence,
      collisionEvidence: capture.mounted.collisionEvidence,
      lodEvidence: lodProof?.proven === true ? "proven" : "not-claimed",
      guardSchema: capture.guardEvidence.schema,
      humanDecision: "pending",
    },
  });
  if (write) {
    await mkdir(dirname(outputAbsolute), { recursive: true, mode: 0o700 });
    await writeFile(outputAbsolute, `${JSON.stringify(candidate, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  }
  return Object.freeze({ candidate, outputPath: outputAbsolute });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2),
    at = (flag) => {
      const index = args.indexOf(flag);
      if (index < 0 || !args[index + 1])
        throw new Error(
          "usage: bun tools/architecture/build-furniture-review-candidate.mjs --authority <json> --capture <json> --out <json>",
        );
      return args[index + 1];
    };
  const { candidate } = await buildFurnitureReviewCandidate({
    authorityPath: at("--authority"),
    capturePath: at("--capture"),
    outputPath: at("--out"),
  });
  console.log(
    JSON.stringify(
      {
        artifactId: candidate.artifactId,
        status: candidate.status,
        evidence: candidate.evidence,
        inputs: candidate.inputs,
      },
      null,
      2,
    ),
  );
}
