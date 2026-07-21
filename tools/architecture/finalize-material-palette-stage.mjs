import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { validateBuildingMaterialPalette } from "../../js/src/assets/building-material-palette.mjs";
import {
  validateBuildingHitlDecision,
  validateBuildingStageArtifact,
} from "../../js/src/assets/staged-building-pipeline.mjs";
import { validateStagedMaterialReviewAuthority } from "../../js/src/render/staged-material-review-scene.ts";
import { portableAssetContentHash } from "../../js/src/world/asset-content-hash.mjs";
import {
  APPROVED_A1,
  APPROVED_A1_R4,
  MATERIAL_PACK_IDS,
  MATERIAL_PALETTE_ARTIFACT_ID,
  MATERIAL_PALETTE_R2_ARTIFACT_ID,
  MATERIAL_ROLE_IDS,
} from "./build-material-palette-stage.mjs";

const FACETS = Object.freeze([
  "role-contract",
  "source-lock",
  "surface-parameters",
  "runtime-textures",
  "encoding-budget",
]);
const DERIVED_PATH = "assets/buildings/authoring/functional-hall-house-v4/material-palette/shell-m1-production.glb";
const MANIFEST_PATH =
  "assets/buildings/authoring/functional-hall-house-v4/material-palette/shell-m1-production.ktx2.json";
const sha = (bytes) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const compactHash = (value) => sha(Buffer.from(JSON.stringify(value)));
const jsonBytes = (value) => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
const portable = (repo, path) => relative(repo, path).split(sep).join("/");

function parseGlb(bytes) {
  if (
    bytes.length < 28 ||
    bytes.readUInt32LE(0) !== 0x46546c67 ||
    bytes.readUInt32LE(4) !== 2 ||
    bytes.readUInt32LE(8) !== bytes.length ||
    bytes.readUInt32LE(16) !== 0x4e4f534a
  )
    throw new Error("M1 derived runtime is not canonical GLB2");
  const jsonLength = bytes.readUInt32LE(12),
    jsonEnd = 20 + jsonLength;
  if (bytes.readUInt32LE(jsonEnd + 4) !== 0x004e4942) throw new Error("M1 derived runtime lacks a binary chunk");
  return {
    json: JSON.parse(bytes.subarray(20, jsonEnd).toString().trim()),
    bin: bytes.subarray(jsonEnd + 8, jsonEnd + 8 + bytes.readUInt32LE(jsonEnd)),
  };
}
function imageBytes(glb, index) {
  const image = glb.json.images?.[index],
    view = glb.json.bufferViews?.[image?.bufferView];
  if (!image || !view) throw new Error(`M1 KTX2 image ${index} is unresolved`);
  return glb.bin.subarray(view.byteOffset ?? 0, (view.byteOffset ?? 0) + view.byteLength);
}
function exactFacets(artifact) {
  return new Map(artifact.facets.map((facet) => [facet.scope, facet.hash]));
}

function verifyApprovedShell(shell, decision, shellBytes, decisionBytes, runtimeBytes, approvedShell) {
  if (
    shell.kind !== "shell" ||
    shell.status !== "approved" ||
    shell.artifactId !== approvedShell.artifactId ||
    shell.contractHash !== approvedShell.contractHash ||
    shell.contentHash !== approvedShell.contentHash
  )
    throw new Error("M1 finalizer requires the exact approved A1 shell");
  const facets = exactFacets(shell);
  if (
    facets.get("surface-mapping") !== approvedShell.surfaceMappingFacetHash ||
    facets.get("material-role-slots") !== approvedShell.materialRoleSlotsFacetHash
  )
    throw new Error("approved A1 material facets drifted");
  if (shell.metadata?.approval?.path === undefined || shell.metadata.approval.sha256 !== sha(decisionBytes))
    throw new Error("approved A1 decision file does not match shell approval metadata");
  if (
    decision.gate !== "A1-shell" ||
    decision.decision !== "approve" ||
    decision.reviewer !== "user" ||
    decision.artifactId !== shell.artifactId ||
    decision.contractHash !== shell.contractHash ||
    decision.contentHash !== shell.contentHash ||
    decision.blockingFindings.length !== 0
  )
    throw new Error("M1 finalizer requires an exact unblocked user A1 approval");
  if (
    JSON.stringify([...decision.evidenceHashes].sort()) !==
    JSON.stringify(shell.evidence.map((entry) => entry.contentHash).sort())
  )
    throw new Error("A1 approval does not bind the complete shell evidence set");
  if (shell.metadata.runtimeGlb?.sha256 !== sha(runtimeBytes) || sha(runtimeBytes) !== approvedShell.contentHash)
    throw new Error("approved A1 runtime GLB drifted");
  if (sha(shellBytes) === sha(decisionBytes)) throw new Error("shell and decision identities unexpectedly alias");
}

function verifyManifest(
  lock,
  manifest,
  manifestBytes,
  derivedBytes,
  shellBytes,
  expectedSourcePath,
  expectedDerivedPath,
) {
  if (manifest.schema !== "limina.ktx2-production/1") throw new Error("unsupported M1 KTX2 manifest schema");
  if (
    manifest.source?.path !== expectedSourcePath ||
    `sha256:${manifest.source.sha256}` !== sha(shellBytes) ||
    manifest.source.bytes !== shellBytes.length
  )
    throw new Error("M1 KTX2 source is not the exact approved A1 shell GLB");
  if (
    manifest.output?.path !== expectedDerivedPath ||
    `sha256:${manifest.output.sha256}` !== sha(derivedBytes) ||
    manifest.output.bytes !== derivedBytes.length ||
    manifest.output.engineHash !== portableAssetContentHash(derivedBytes)
  )
    throw new Error("M1 KTX2 manifest output identity drifted");
  if (
    manifest.policy?.pngFallback !== false ||
    manifest.policy.mipmaps !== true ||
    JSON.stringify(manifest.policy.encodingBudget) !== JSON.stringify(lock.encodingBudget)
  )
    throw new Error("M1 KTX2 policy does not match materials.lock");
  if (
    manifest.gpuResidency?.bytes > lock.encodingBudget.maxGpuResidencyBytes ||
    manifest.gpuResidency?.limitMiB * 1024 * 1024 !== lock.encodingBudget.maxGpuResidencyBytes ||
    derivedBytes.length > lock.encodingBudget.maxArtifactBytes
  )
    throw new Error("M1 KTX2 output exceeds its locked budget");
  if (
    !Array.isArray(manifest.textures) ||
    manifest.textures.length !== 18 ||
    new Set(manifest.textures.map((entry) => entry.image)).size !== 18
  )
    throw new Error("M1 KTX2 manifest must close exactly 18 unique images");
  if (manifest.textures.length > lock.encodingBudget.maxUniqueImages)
    throw new Error("M1 KTX2 image count exceeds materials.lock");
  const packById = new Map(lock.packs.map((pack) => [pack.id, pack])),
    kindsByPack = new Map();
  for (const record of manifest.textures) {
    if (
      !packById.has(record.pack) ||
      !Number.isSafeInteger(record.image) ||
      record.image < 0 ||
      record.image >= 18 ||
      record.width !== 1024 ||
      record.height !== 1024 ||
      !["albedo", "normal", "roughness"].includes(record.kind)
    )
      throw new Error("M1 KTX2 texture record is outside the locked inventory");
    const kinds = kindsByPack.get(record.pack) ?? [];
    kinds.push(record.kind);
    kindsByPack.set(record.pack, kinds);
    const expectedColor = record.kind === "albedo" ? "sRGB" : "linear",
      expectedMode =
        record.kind === "normal" || (record.kind === "albedo" && manifest.policy.criticalRoles.includes(record.pack))
          ? "UASTC+Zstd"
          : "ETC1S/BasisLZ";
    if (
      record.colorSpace !== expectedColor ||
      record.mode !== expectedMode ||
      (record.kind === "normal" ? record.channelEncoding !== "rgb-tangent-space" : record.channelEncoding !== "rgb")
    )
      throw new Error(`M1 KTX2 ${record.pack}/${record.kind} encoding semantics drifted`);
  }
  for (const packId of MATERIAL_PACK_IDS)
    if (JSON.stringify((kindsByPack.get(packId) ?? []).sort()) !== JSON.stringify(["albedo", "normal", "roughness"]))
      throw new Error(`M1 KTX2 pack ${packId} lacks its exact three runtime maps`);
}

function verifyDerivedGlb(lock, manifest, derivedBytes) {
  const glb = parseGlb(derivedBytes),
    json = glb.json;
  if (!json.extensionsUsed?.includes("KHR_texture_basisu") || !json.extensionsRequired?.includes("KHR_texture_basisu"))
    throw new Error("M1 derived GLB does not require KHR_texture_basisu");
  if (
    json.images?.length !== 18 ||
    json.textures?.length > lock.encodingBudget.maxTextureObjects ||
    json.textures?.length !== 27
  )
    throw new Error("M1 derived GLB image/texture-object counts drifted");
  if (
    !json.images.every((image) => image.mimeType === "image/ktx2") ||
    !json.textures.every(
      (texture) => texture.source === undefined && Number.isSafeInteger(texture.extensions?.KHR_texture_basisu?.source),
    )
  )
    throw new Error("M1 derived GLB contains a fallback texture source");
  const records = new Map(manifest.textures.map((record) => [record.image, record]));
  for (let index = 0; index < json.images.length; index++) {
    const payload = imageBytes(glb, index),
      record = records.get(index);
    if (!record || payload.length !== record.payloadBytes || sha(payload) !== `sha256:${record.payloadSha256}`)
      throw new Error(`M1 embedded KTX2 payload ${index} does not match the manifest`);
    if (
      !payload
        .subarray(0, 12)
        .equals(Buffer.from([0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x30, 0xbb, 0x0d, 0x0a, 0x1a, 0x0a]))
    )
      throw new Error(`M1 embedded payload ${index} is not KTX2`);
  }
}

export async function finalizeMaterialPaletteStage({
  repoRoot = resolve(import.meta.dirname, "../.."),
  lockPath = "assets/buildings/authoring/functional-hall-house-v4/materials.lock.json",
  preDerivationArtifactPath = "assets/buildings/authoring/functional-hall-house-v4/material-palette-artifact-pre-derivation-draft.json",
  shellArtifactPath = "assets/buildings/authoring/functional-hall-house-v4/shell-artifact-approved.json",
  shellDecisionPath = "assets/buildings/authoring/functional-hall-house-v4/shell-review-decision-approve.json",
  derivedPath = DERIVED_PATH,
  manifestPath = MANIFEST_PATH,
  artifactOutputPath = "assets/buildings/authoring/functional-hall-house-v4/material-palette-artifact-draft.json",
  artifactMetadataPath = artifactOutputPath,
  authorityOutputPath = "assets/buildings/authoring/functional-hall-house-v4/material-review-authority.json",
  authorityMetadataPath = authorityOutputPath,
  approvedShell = APPROVED_A1,
  paletteArtifactId = MATERIAL_PALETTE_ARTIFACT_ID,
  includeRoofContinuityView = false,
} = {}) {
  const repo = resolve(repoRoot),
    paths = Object.fromEntries(
      Object.entries({
        lockPath,
        preDerivationArtifactPath,
        shellArtifactPath,
        shellDecisionPath,
        derivedPath,
        manifestPath,
        artifactOutputPath,
        artifactMetadataPath,
        authorityOutputPath,
        authorityMetadataPath,
      }).map(([key, value]) => [key, resolve(repo, value)]),
    );
  const [lockBytes, preBytes, shellBytes, decisionBytes, derivedBytes, manifestBytes] = await Promise.all(
    [
      paths.lockPath,
      paths.preDerivationArtifactPath,
      paths.shellArtifactPath,
      paths.shellDecisionPath,
      paths.derivedPath,
      paths.manifestPath,
    ].map((path) => readFile(path)),
  );
  const lock = validateBuildingMaterialPalette(JSON.parse(lockBytes), {
    expectedRoles: MATERIAL_ROLE_IDS,
    expectedPackIds: MATERIAL_PACK_IDS,
    inputShell: approvedShell,
  });
  const pre = validateBuildingStageArtifact(JSON.parse(preBytes)),
    shell = validateBuildingStageArtifact(JSON.parse(shellBytes)),
    decision = validateBuildingHitlDecision(JSON.parse(decisionBytes)),
    manifest = JSON.parse(manifestBytes);
  if (
    pre.kind !== "material-palette" ||
    pre.status !== "draft" ||
    pre.artifactId !== paletteArtifactId ||
    pre.contentHash !== sha(lockBytes) ||
    pre.metadata?.materialsLock?.sha256 !== sha(lockBytes)
  )
    throw new Error("pre-derivation M1 draft does not bind materials.lock");
  if (shell.metadata?.approval?.path !== portable(repo, paths.shellDecisionPath))
    throw new Error("shell approval path does not match the exact decision input");
  const shellRuntimePath = resolve(repo, shell.metadata.runtimeGlb.path),
    shellRuntimeBytes = await readFile(shellRuntimePath);
  verifyApprovedShell(shell, decision, shellBytes, decisionBytes, shellRuntimeBytes, approvedShell);
  verifyManifest(
    lock,
    manifest,
    manifestBytes,
    derivedBytes,
    shellRuntimeBytes,
    portable(repo, shellRuntimePath),
    portable(repo, paths.derivedPath),
  );
  verifyDerivedGlb(lock, manifest, derivedBytes);
  const prior = exactFacets(pre),
    manifestSha256 = sha(manifestBytes),
    runtimePayload = {
      schema: "limina.material-runtime-textures/v1",
      manifestSha256,
      output: manifest.output,
      textures: manifest.textures,
    },
    encodingPayload = {
      schema: "limina.material-encoding-closure/v1",
      manifestSha256,
      policy: manifest.policy,
      gpuResidency: manifest.gpuResidency,
    };
  const facets = FACETS.map((scope) => ({
    scope,
    hash:
      scope === "runtime-textures"
        ? compactHash(runtimePayload)
        : scope === "encoding-budget"
          ? compactHash(encodingPayload)
          : prior.get(scope),
  }));
  const artifact = validateBuildingStageArtifact({
    ...pre,
    contentHash: sha(derivedBytes),
    facets,
    evidence: [],
    metadata: {
      ...pre.metadata,
      humanDecision: "not-reviewed",
      preDerivationDraft: {
        path: portable(repo, paths.preDerivationArtifactPath),
        sha256: sha(preBytes),
        contentHash: portableAssetContentHash(preBytes),
      },
      approvedShellDecision: {
        path: portable(repo, paths.shellDecisionPath),
        sha256: sha(decisionBytes),
        decisionId: decision.decisionId,
      },
      derivedRuntime: {
        assetId: portable(resolve(repo, "assets"), paths.derivedPath),
        path: portable(repo, paths.derivedPath),
        sha256: sha(derivedBytes),
        assetHash: portableAssetContentHash(derivedBytes),
        bytes: derivedBytes.length,
        manifestPath: portable(repo, paths.manifestPath),
        manifestSha256,
        manifestContentHash: portableAssetContentHash(manifestBytes),
      },
      policy: { ...pre.metadata.policy, gpuRequired: true, fallback: "none", extension: "KHR_texture_basisu" },
    },
  });
  const artifactBytes = jsonBytes(artifact),
    packIds = lock.packs.map((pack) => pack.id),
    authoredSimpleRoles = lock.roles.filter((role) => role.kind === "authored-simple").map((role) => role.role);
  const authority = validateStagedMaterialReviewAuthority({
    schema: "limina.staged-material-review-scene/v1",
    approvalPolicy: {
      renderer: "limina-production-native-engine",
      blenderApprovalProhibited: true,
      nonEngineApprovalProhibited: true,
      humanDecisionRequired: true,
    },
    approvedShell: {
      path: portable(repo, paths.shellArtifactPath),
      sha256: sha(shellBytes),
      contentHash: portableAssetContentHash(shellBytes),
      artifactId: shell.artifactId,
      contractHash: shell.contractHash,
      runtimeGlbPath: portable(repo, shellRuntimePath),
      runtimeGlbSha256: sha(shellRuntimeBytes),
      surfaceMappingFacetHash: approvedShell.surfaceMappingFacetHash,
      materialRoleSlotsFacetHash: approvedShell.materialRoleSlotsFacetHash,
    },
    paletteLock: {
      path: portable(repo, paths.lockPath),
      sha256: sha(lockBytes),
      contentHash: portableAssetContentHash(lockBytes),
      paletteId: lock.paletteId,
      packIds,
      authoredSimpleRoles,
    },
    derived: {
      assetId: portable(resolve(repo, "assets"), paths.derivedPath),
      sha256: sha(derivedBytes),
      assetHash: portableAssetContentHash(derivedBytes),
      manifestPath: portable(repo, paths.manifestPath),
      manifestSha256,
      manifestContentHash: portableAssetContentHash(manifestBytes),
      sourceShellSha256: sha(shellRuntimeBytes),
      fallback: "none",
      extension: "KHR_texture_basisu",
    },
    stageArtifact: {
      path: portable(repo, paths.artifactMetadataPath),
      sha256: sha(artifactBytes),
      contentHash: portableAssetContentHash(artifactBytes),
      artifactId: artifact.artifactId,
      kind: "material-palette",
      status: "draft",
    },
    presentation: {
      minimumResolution: [1920, 1080],
      fixedTimeSeconds: 12,
      warmupFrames: 8,
      neutralStudio: true,
      ...(includeRoofContinuityView
        ? {
            lighting: {
              ambientColor: 0xe9edf2,
              ambientIntensity: 1.2,
              directionalColor: 0xfff4e2,
              directionalIntensity: 1.1,
              direction: [5, 8, 6],
            },
          }
        : {}),
    },
    evidenceViews: [
      {
        id: "poly-haven-pack-swatches",
        role: "six locked Poly Haven packs on spheres and planes",
        subject: "pack-swatches",
        camera: { position: [0, 4.2, 10.5], target: [0, 0.6, 0.7], fovDeg: 48, near: 0.03, far: 120 },
      },
      {
        id: "authored-simple-role-swatches",
        role: "eleven authored-simple roles under neutral studio light",
        subject: "simple-swatches",
        camera: { position: [0, 3.8, 12], target: [0, 0.55, 3.2], fovDeg: 54, near: 0.03, far: 120 },
      },
      {
        id: "representative-exterior-shell-crop",
        role: "exterior material mapping, scale, and continuity",
        subject: "shell",
        camera: { position: [9.5, 5.8, -13], target: [0, 2.4, 0], fovDeg: 45, near: 0.05, far: 160 },
      },
      {
        id: "representative-interior-hearth-crop",
        role: "interior plaster, timber, floor, and hearth response",
        subject: "shell",
        camera: { position: [-0.6, 1.65, -2.6], target: [2.95, 1.2, 2.7], fovDeg: 58, near: 0.03, far: 120 },
      },
      ...(includeRoofContinuityView
        ? [
            {
              id: "roof-dormer-eave-continuity",
              role: "roof tile orientation, dormer junction, flashing, and eave continuity",
              subject: "shell",
              camera: { position: [7.6, 6.9, -9.4], target: [0.35, 4.45, -0.15], fovDeg: 38, near: 0.05, far: 120 },
            },
          ]
        : []),
    ],
  });
  const authorityBytes = jsonBytes(authority);
  await Promise.all([
    mkdir(dirname(paths.artifactOutputPath), { recursive: true }),
    mkdir(dirname(paths.authorityOutputPath), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(paths.artifactOutputPath, artifactBytes, { mode: 0o600 }),
    writeFile(paths.authorityOutputPath, authorityBytes, { mode: 0o600 }),
  ]);
  return Object.freeze({ artifact, authority, artifactBytes, authorityBytes });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2),
    value = (flag, fallback) => {
      const index = args.indexOf(flag);
      return index < 0 ? fallback : args[index + 1];
    };
  const profile = value("--profile", "r1"),
    profileOptions =
      profile === "r1"
        ? {}
        : profile === "r2"
          ? {
              approvedShell: APPROVED_A1_R4,
              paletteArtifactId: MATERIAL_PALETTE_R2_ARTIFACT_ID,
              includeRoofContinuityView: true,
              lockPath: "assets/buildings/authoring/functional-hall-house-v4/material-r2/materials.lock.json",
              preDerivationArtifactPath:
                "assets/buildings/authoring/functional-hall-house-v4/material-r2/material-palette-artifact-pre-derivation-draft.json",
              shellArtifactPath:
                "assets/buildings/authoring/functional-hall-house-v4/shell-r4/shell-artifact-approved.json",
              shellDecisionPath:
                "assets/buildings/authoring/functional-hall-house-v4/shell-r4/shell-review-decision-approve.json",
              derivedPath:
                "assets/buildings/authoring/functional-hall-house-v4/material-r2/runtime/shell-m1-production.glb",
              manifestPath:
                "assets/buildings/authoring/functional-hall-house-v4/material-r2/runtime/shell-m1-production.ktx2.json",
              artifactOutputPath:
                "assets/buildings/authoring/functional-hall-house-v4/material-r2/material-palette-artifact-draft.json",
              artifactMetadataPath:
                "assets/buildings/authoring/functional-hall-house-v4/material-r2/material-palette-artifact-draft.json",
              authorityOutputPath:
                "assets/buildings/authoring/functional-hall-house-v4/material-r2/material-review-authority.json",
              authorityMetadataPath:
                "assets/buildings/authoring/functional-hall-house-v4/material-r2/material-review-authority.json",
            }
          : (() => {
              throw new Error(`unsupported material profile ${profile}`);
            })();
  const result = await finalizeMaterialPaletteStage({
    ...profileOptions,
    artifactOutputPath: value("--out-artifact", profileOptions.artifactOutputPath),
    artifactMetadataPath: value("--artifact-metadata-path", profileOptions.artifactMetadataPath),
    authorityOutputPath: value("--out-authority", profileOptions.authorityOutputPath),
  });
  console.log(
    JSON.stringify(
      {
        artifactId: result.artifact.artifactId,
        status: result.artifact.status,
        runtimeContentHash: result.artifact.contentHash,
        authoritySchema: result.authority.schema,
      },
      null,
      2,
    ),
  );
}
