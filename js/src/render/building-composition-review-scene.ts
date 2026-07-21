import { AssetRegistry } from "../asset-registry.ts";
import {
  validateBuildingCompositionManifestV2,
  buildingCompositionManifestV2Hash,
} from "../assets/building-composition-manifest-v2.mjs";
import { validateBuildingHitlDecision, validateBuildingStageArtifact } from "../assets/staged-building-pipeline.mjs";
import { LiminaTracer } from "../observability/event.ts";
import { registerCoreSkills } from "../skills/index.ts";
import { resolveProfile } from "../skills/permissions.ts";
import { SkillRegistry, type WorldContext } from "../skills/registry.ts";
import { portableAssetContentHash } from "../world/asset-content-hash.mjs";
import { sha256 } from "../world/sha256.mjs";

type Hash = `sha256:${string}`;
type V3 = readonly [number, number, number];
type ExactFile = { readonly path: string; readonly sha256: Hash; readonly contentHash: Hash };
export type BuildingCompositionReviewView = {
  readonly id: "entry-circulation" | "dining-three-quarter" | "hearth-seating" | "service-storage" | "overall-room";
  readonly role: string;
  readonly position: V3;
  readonly target: V3;
  readonly fovDeg: number;
  readonly near: number;
  readonly far: number;
};
export interface BuildingCompositionReviewAuthority {
  readonly schema: "limina.building-composition-review-scene/v1";
  readonly approvalPolicy: {
    readonly renderer: "limina-production-native-engine";
    readonly blenderApprovalProhibited: true;
    readonly nonEngineApprovalProhibited: true;
    readonly humanDecisionRequired: true;
    readonly fireExcluded: true;
  };
  readonly manifest: ExactFile & { readonly id: string; readonly revision: number; readonly canonicalHash: Hash };
  readonly functionalEvidence: ExactFile & {
    readonly schema: "limina.building-composition-functional-evidence/v1";
    readonly verdict: "pass";
    readonly inputs: {
      readonly manifestId: string;
      readonly manifestHash: Hash;
      readonly manifestSha256: Hash;
      readonly shellArtifactId: string;
      readonly materialArtifactId: string;
      readonly interiorArtifactId: string;
    };
    readonly summary: { readonly passed: number; readonly failed: 0 };
  };
  readonly integratedSource: { readonly evidence: ExactFile; readonly blend: ExactFile; readonly glb: ExactFile };
  readonly presentation: {
    readonly minimumResolution: readonly [number, number];
    readonly fixedTimeSeconds: number;
    readonly warmupFrames: number;
  };
  readonly evidenceViews: readonly BuildingCompositionReviewView[];
}

const HASH = /^sha256:[0-9a-f]{64}$/;
const VIEW_IDS = "entry-circulation,dining-three-quarter,hearth-seating,service-storage,overall-room";
const exact = (value: unknown, keys: readonly string[], label: string) => {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error(`C1 ${label} must be an object`);
  const actual = Object.keys(value as object);
  for (const key of keys) if (!actual.includes(key)) throw new Error(`C1 ${label}.${key} is required`);
  for (const key of actual) if (!keys.includes(key)) throw new Error(`C1 ${label}.${key} is unsupported`);
};
const hash = (value: unknown, label: string) => {
  if (typeof value !== "string" || !HASH.test(value)) throw new Error(`C1 ${label} must be lowercase sha256`);
};
const path = (value: unknown, label: string) => {
  if (
    typeof value !== "string" ||
    !value ||
    value.startsWith("/") ||
    value.includes("\\") ||
    value.split("/").includes("..")
  )
    throw new Error(`C1 ${label} must be repository-relative`);
};
const vec3 = (value: unknown, label: string) => {
  if (!Array.isArray(value) || value.length !== 3 || !value.every(Number.isFinite))
    throw new Error(`C1 ${label} must be a finite vec3`);
};
function file(value: unknown, label: string) {
  exact(value, ["path", "sha256", "contentHash"], label);
  const entry = value as ExactFile;
  path(entry.path, `${label}.path`);
  hash(entry.sha256, `${label}.sha256`);
  hash(entry.contentHash, `${label}.contentHash`);
}

export function validateBuildingCompositionReviewAuthority(value: unknown): BuildingCompositionReviewAuthority {
  exact(
    value,
    ["schema", "approvalPolicy", "manifest", "functionalEvidence", "integratedSource", "presentation", "evidenceViews"],
    "authority",
  );
  const authority = value as BuildingCompositionReviewAuthority;
  if (authority.schema !== "limina.building-composition-review-scene/v1")
    throw new Error("unsupported C1 review authority schema");
  exact(
    authority.approvalPolicy,
    ["renderer", "blenderApprovalProhibited", "nonEngineApprovalProhibited", "humanDecisionRequired", "fireExcluded"],
    "approvalPolicy",
  );
  if (
    authority.approvalPolicy.renderer !== "limina-production-native-engine" ||
    authority.approvalPolicy.blenderApprovalProhibited !== true ||
    authority.approvalPolicy.nonEngineApprovalProhibited !== true ||
    authority.approvalPolicy.humanDecisionRequired !== true ||
    authority.approvalPolicy.fireExcluded !== true
  )
    throw new Error("C1 approval requires native-engine human review with fire excluded");
  exact(authority.manifest, ["path", "sha256", "contentHash", "id", "revision", "canonicalHash"], "manifest");
  file(
    { path: authority.manifest.path, sha256: authority.manifest.sha256, contentHash: authority.manifest.contentHash },
    "manifest",
  );
  if (!authority.manifest.id || !Number.isSafeInteger(authority.manifest.revision) || authority.manifest.revision < 1)
    throw new Error("C1 authority has an invalid manifest identity");
  hash(authority.manifest.canonicalHash, "manifest.canonicalHash");
  exact(
    authority.functionalEvidence,
    ["path", "sha256", "contentHash", "schema", "verdict", "inputs", "summary"],
    "functionalEvidence",
  );
  file(
    {
      path: authority.functionalEvidence.path,
      sha256: authority.functionalEvidence.sha256,
      contentHash: authority.functionalEvidence.contentHash,
    },
    "functionalEvidence",
  );
  if (
    authority.functionalEvidence.schema !== "limina.building-composition-functional-evidence/v1" ||
    authority.functionalEvidence.verdict !== "pass"
  )
    throw new Error("C1 authority requires passing integrated functional evidence");
  exact(
    authority.functionalEvidence.inputs,
    ["manifestId", "manifestHash", "manifestSha256", "shellArtifactId", "materialArtifactId", "interiorArtifactId"],
    "functionalEvidence.inputs",
  );
  for (const key of ["manifestHash", "manifestSha256"] as const)
    hash(authority.functionalEvidence.inputs[key], `functionalEvidence.inputs.${key}`);
  for (const key of ["manifestId", "shellArtifactId", "materialArtifactId", "interiorArtifactId"] as const)
    if (!authority.functionalEvidence.inputs[key]) throw new Error(`C1 functionalEvidence.inputs.${key} is required`);
  exact(authority.functionalEvidence.summary, ["passed", "failed"], "functionalEvidence.summary");
  if (
    !Number.isSafeInteger(authority.functionalEvidence.summary.passed) ||
    authority.functionalEvidence.summary.passed < 1 ||
    authority.functionalEvidence.summary.failed !== 0
  )
    throw new Error("C1 integrated functional summary is not all-pass");
  exact(authority.integratedSource, ["evidence", "blend", "glb"], "integratedSource");
  file(authority.integratedSource.evidence, "integratedSource.evidence");
  file(authority.integratedSource.blend, "integratedSource.blend");
  file(authority.integratedSource.glb, "integratedSource.glb");
  exact(authority.presentation, ["minimumResolution", "fixedTimeSeconds", "warmupFrames"], "presentation");
  if (
    !Array.isArray(authority.presentation.minimumResolution) ||
    authority.presentation.minimumResolution.length !== 2 ||
    authority.presentation.minimumResolution.some((value) => !Number.isSafeInteger(value) || value < 1080) ||
    !Number.isFinite(authority.presentation.fixedTimeSeconds) ||
    authority.presentation.fixedTimeSeconds < 0 ||
    !Number.isSafeInteger(authority.presentation.warmupFrames) ||
    authority.presentation.warmupFrames < 1 ||
    authority.presentation.warmupFrames > 120
  )
    throw new Error("C1 presentation policy is invalid");
  if (!Array.isArray(authority.evidenceViews) || authority.evidenceViews.map((view) => view.id).join(",") !== VIEW_IDS)
    throw new Error("C1 authority requires the canonical five-view sequence");
  for (const view of authority.evidenceViews) {
    exact(view, ["id", "role", "position", "target", "fovDeg", "near", "far"], `evidenceViews.${view.id}`);
    if (!view.role) throw new Error(`C1 view ${view.id} lacks a review role`);
    vec3(view.position, `${view.id}.position`);
    vec3(view.target, `${view.id}.target`);
    if (
      !Number.isFinite(view.fovDeg) ||
      view.fovDeg < 20 ||
      view.fovDeg > 80 ||
      !Number.isFinite(view.near) ||
      view.near <= 0 ||
      !Number.isFinite(view.far) ||
      view.far <= view.near
    )
      throw new Error(`C1 view ${view.id} camera is invalid`);
  }
  if (
    authority.functionalEvidence.inputs.manifestId !== authority.manifest.id ||
    authority.functionalEvidence.inputs.manifestHash !== authority.manifest.canonicalHash ||
    authority.functionalEvidence.inputs.manifestSha256 !== authority.manifest.sha256
  )
    throw new Error("C1 functional evidence does not bind the exact manifest");
  return authority;
}

const decode = (bytes: Uint8Array) => JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
const raw = (bytes: Uint8Array): Hash => `sha256:${sha256(bytes)}`;
function exactBytes(entry: { path: string; sha256: string }, read: (path: string) => Uint8Array, label: string) {
  const bytes = read(entry.path);
  if (raw(bytes) !== entry.sha256) throw new Error(`C1 ${label} bytes drifted`);
  return bytes;
}
function verifyApproval(manifestRef: any, decisionResource: any, read: (path: string) => Uint8Array, label: string) {
  const artifactBytes = exactBytes(
      { path: manifestRef.artifactPath, sha256: manifestRef.artifactSha256 },
      read,
      `${label} artifact`,
    ),
    artifact = validateBuildingStageArtifact(decode(artifactBytes)),
    decisionBytes = exactBytes(decisionResource, read, `${label} decision`),
    decision = validateBuildingHitlDecision(decode(decisionBytes));
  if (
    artifact.artifactId !== manifestRef.artifactId ||
    artifact.kind !== manifestRef.kind ||
    artifact.status !== "approved" ||
    artifact.contractHash !== manifestRef.contractHash ||
    artifact.contentHash !== manifestRef.contentHash ||
    decision.decision !== "approve" ||
    decision.artifactId !== artifact.artifactId ||
    decision.contractHash !== artifact.contractHash ||
    decision.contentHash !== artifact.contentHash ||
    artifact.metadata?.approval?.decisionId !== decision.decisionId ||
    artifact.metadata?.approval?.sha256 !== decisionResource.sha256
  )
    throw new Error(`C1 ${label} approved closure drifted`);
}

export function verifyBuildingCompositionReviewClosure(authorityValue: unknown, read: (path: string) => Uint8Array) {
  const authority = validateBuildingCompositionReviewAuthority(authorityValue),
    manifestBytes = exactBytes(authority.manifest, read, "manifest");
  if (portableAssetContentHash(manifestBytes) !== authority.manifest.contentHash)
    throw new Error("C1 manifest content address drifted");
  const manifest = validateBuildingCompositionManifestV2(decode(manifestBytes));
  if (
    manifest.id !== authority.manifest.id ||
    manifest.revision !== authority.manifest.revision ||
    buildingCompositionManifestV2Hash(manifest) !== authority.manifest.canonicalHash
  )
    throw new Error("C1 manifest canonical identity drifted");
  const evidenceBytes = exactBytes(authority.functionalEvidence, read, "functional evidence");
  if (portableAssetContentHash(evidenceBytes) !== authority.functionalEvidence.contentHash)
    throw new Error("C1 functional evidence content address drifted");
  const evidence = decode(evidenceBytes);
  if (
    evidence.schema !== authority.functionalEvidence.schema ||
    evidence.verdict !== "pass" ||
    !Array.isArray(evidence.checks) ||
    evidence.checks.length !== authority.functionalEvidence.summary.passed ||
    evidence.checks.some(
      (check: any) => check.passed !== true || !Array.isArray(check.findings) || check.findings.length !== 0,
    ) ||
    JSON.stringify(evidence.inputs) !== JSON.stringify(authority.functionalEvidence.inputs) ||
    JSON.stringify(evidence.summary) !== JSON.stringify(authority.functionalEvidence.summary)
  )
    throw new Error("C1 integrated functional evidence drifted or no longer passes");
  const buildEvidenceBytes = exactBytes(authority.integratedSource.evidence, read, "integrated source evidence"),
    blendBytes = exactBytes(authority.integratedSource.blend, read, "integrated source blend"),
    glbBytes = exactBytes(authority.integratedSource.glb, read, "integrated source GLB");
  for (const [label, entry, bytes] of [
    ["evidence", authority.integratedSource.evidence, buildEvidenceBytes],
    ["blend", authority.integratedSource.blend, blendBytes],
    ["GLB", authority.integratedSource.glb, glbBytes],
  ] as const)
    if (portableAssetContentHash(bytes) !== entry.contentHash)
      throw new Error(`C1 integrated source ${label} content address drifted`);
  const build = decode(buildEvidenceBytes);
  if (
    build.schema !== "limina.building-composition-build-evidence/v1" ||
    build.id !== manifest.id ||
    build.manifest?.sha256 !== authority.manifest.sha256 ||
    build.manifest?.canonicalHash !== authority.manifest.canonicalHash ||
    build.sourceBlend?.path !== authority.integratedSource.blend.path ||
    build.sourceBlend?.sha256 !== authority.integratedSource.blend.sha256 ||
    build.asset?.path !== authority.integratedSource.glb.path ||
    build.asset?.sha256 !== authority.integratedSource.glb.sha256 ||
    build.status !== "cpu-authored-unreviewed" ||
    build.rendered !== false ||
    build.gpuUsed !== false
  )
    throw new Error("C1 integrated CPU-authored source closure drifted");
  verifyApproval(manifest.dependencies.shell.artifact, manifest.dependencies.shell.approvalDecision, read, "shell");
  verifyApproval(
    manifest.dependencies.materialPalette.artifact,
    manifest.dependencies.materialPalette.approvalDecision,
    read,
    "materials",
  );
  verifyApproval(
    manifest.dependencies.interiorPlan.artifact,
    manifest.dependencies.interiorPlan.approvalDecision,
    read,
    "interior plan",
  );
  for (const [label, entry] of [
    ["shell source", manifest.dependencies.shell.sourceBlend],
    ["shell runtime", manifest.dependencies.shell.runtimeGlb],
    ["materials lock", manifest.dependencies.materialPalette.materialsLock],
    ["materialized shell runtime", manifest.dependencies.materialPalette.runtimeGlb],
    ["interior plan", manifest.dependencies.interiorPlan.plan],
  ] as const)
    exactBytes(entry, read, label);
  for (const [index, entry] of manifest.dependencies.catalog.entries()) {
    verifyApproval(entry.artifact, entry.approvalDecision, read, `catalog ${index}`);
    for (const key of ["designContract", "buildEvidence", "functionalEvidence", "sourceBlend", "runtimeGlb"] as const)
      exactBytes(entry[key], read, `catalog ${index} ${key}`);
  }
  return Object.freeze({ authority, manifest, evidence, manifestBytes, evidenceBytes });
}

export async function mountBuildingCompositionReview(world: WorldContext, authorityValue: unknown) {
  const closure = verifyBuildingCompositionReviewClosure(authorityValue, (path) => world.ops.op_read_asset(path)),
    authority = closure.authority,
    manifest = closure.manifest,
    assets = new AssetRegistry(world.ops),
    runtimePath = manifest.dependencies.materialPalette.runtimeGlb.path,
    shellId = runtimePath.replace(/^assets\//, ""),
    shellBytes = world.ops.op_read_asset(runtimePath),
    shellHash = portableAssetContentHash(shellBytes);
  assets.seed(shellId, shellBytes);
  for (const entry of manifest.dependencies.catalog) {
    const assetId = entry.runtimeGlb.path.replace(/^assets\//, ""),
      bytes = world.ops.op_read_asset(entry.runtimeGlb.path);
    assets.seed(assetId, bytes);
  }
  const registry = new SkillRegistry(new LiminaTracer("building-composition-c1-review"));
  registerCoreSkills(registry, { assets });
  const base = {
    agentId: "building-composition-c1-review",
    sessionId: "building-composition-c1-review",
    permissions: resolveProfile("builder.readWrite"),
    tick: 0,
    world,
  };
  let tick = 1;
  const invoke = async (name: string, input: unknown) => {
    const result = await registry.invoke(name, input, { ...base, tick: tick++ });
    if (!result.success) throw new Error(`${name} failed: ${JSON.stringify(result.error)}`);
    return result.result as Record<string, any>;
  };
  let shell: string | undefined;
  const furniture: { instanceId: string; root: string; colliders: string[]; sockets: any[] }[] = [];
  try {
    const placedShell = await invoke("asset.place", {
      assetId: shellId,
      hash: shellHash,
      position: [0, 0, 0],
      rotation: [0, 0, 0],
      scale: [1, 1, 1],
      ground: false,
    });
    shell = placedShell.entity;
    if (placedShell.hash !== shellHash) throw new Error("C1 asset.place returned an unpinned M1 runtime shell");
    const catalog = new Map(manifest.dependencies.catalog.map((entry: any) => [entry.artifact.artifactId, entry]));
    for (const instance of manifest.instances) {
      const entry: any = catalog.get(instance.catalogArtifactId);
      if (!entry) throw new Error(`C1 instance ${instance.id} lacks catalog content`);
      const functional = decode(world.ops.op_read_asset(entry.functionalEvidence.path)),
        contractHash = functional.inputs?.furnitureContractHash;
      if (typeof contractHash !== "string" || !HASH.test(contractHash))
        throw new Error(`C1 instance ${instance.id} lacks a functional contract hash`);
      const assetId = entry.runtimeGlb.path.replace(/^assets\//, ""),
        bytes = world.ops.op_read_asset(entry.runtimeGlb.path),
        assetHash = portableAssetContentHash(bytes),
        placed = await invoke("furniture.placeFunctional", {
          assetId,
          hash: assetHash,
          contractHash,
          position: instance.placement.position,
          yaw: instance.placement.yawRadians,
        });
      const expectedSockets = [...instance.bindings.occupancySocketIds, ...instance.bindings.approachSocketIds];
      if (
        placed.hash !== assetHash ||
        placed.contractHash !== contractHash ||
        !expectedSockets.every((id) => placed.sockets.some((socket: any) => socket.id === id))
      )
        throw new Error(`C1 instance ${instance.id} functional placement drifted`);
      furniture.push({
        instanceId: instance.id,
        root: placed.root,
        colliders: placed.colliders,
        sockets: placed.sockets,
      });
    }
    const setFurnitureVisible = (visible: boolean) => {
      for (const placed of furniture) {
        const entity = world.entities.resolve(placed.root);
        if (entity?.mesh) entity.mesh.visible = visible;
      }
    };
    return Object.freeze({
      shell,
      furniture: Object.freeze(furniture.map((entry) => Object.freeze({ ...entry }))),
      inventory: Object.freeze({
        instances: furniture.length,
        colliders: furniture.reduce((sum, entry) => sum + entry.colliders.length, 0),
        sockets: furniture.reduce((sum, entry) => sum + entry.sockets.length, 0),
      }),
      setFurnitureVisible,
      dispose: async () => {
        const failures: unknown[] = [];
        for (const entry of [...furniture].reverse()) {
          const result = await registry.invoke(
            "furniture.destroyFunctional",
            { root: entry.root },
            { ...base, tick: tick++ },
          );
          if (!result.success)
            failures.push(new Error(`failed to destroy ${entry.instanceId}: ${JSON.stringify(result.error)}`));
        }
        if (shell !== undefined) {
          const result = await registry.invoke("scene.destroyEntity", { entity: shell }, { ...base, tick: tick++ });
          if (!result.success) failures.push(new Error(`failed to destroy C1 shell: ${JSON.stringify(result.error)}`));
          shell = undefined;
        }
        if (failures.length) throw new AggregateError(failures, "C1 review disposal failed");
      },
    });
  } catch (error) {
    for (const entry of [...furniture].reverse())
      try {
        await registry.invoke("furniture.destroyFunctional", { root: entry.root }, { ...base, tick: tick++ });
      } catch {}
    if (shell !== undefined)
      try {
        await registry.invoke("scene.destroyEntity", { entity: shell }, { ...base, tick: tick++ });
      } catch {}
    throw error;
  }
}
