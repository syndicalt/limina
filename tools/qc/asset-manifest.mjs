import { createHash } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, extname, relative, resolve, sep } from "node:path";
import { measureGlb, parseGltfJson } from "../../gates/design/asset-qc-gate.mjs";

export const ASSET_MANIFEST_SCHEMA = "limina.asset-manifest/1";
export const ASSET_QC_GATE_VERSION = "limina.asset-qc/2";

const HASH = /^sha256:[0-9a-f]{64}$/;
const CLASSES = new Set(["building", "character", "model", "prop", "vegetation"]);
const SUPPORTED_SPDX = new Set(["CC0-1.0", "CC-BY-3.0", "CC-BY-4.0", "MIT", "Apache-2.0"]);
const CLASS_POLICY = Object.freeze({
  building: { maxMeshes: 128, maxDrawCalls: 192, requiredSlots: ["baseColor"], requiresLod: false },
  character: { maxMeshes: 64, maxDrawCalls: 96, requiredSlots: [], requiresLod: false },
  model: { maxMeshes: 128, maxDrawCalls: 192, requiredSlots: [], requiresLod: false },
  prop: { maxMeshes: 32, maxDrawCalls: 64, requiredSlots: ["baseColor"], requiresLod: false },
  vegetation: { maxMeshes: 8, maxDrawCalls: 16, requiredSlots: ["baseColor"], requiresLod: true },
});

export function sha256(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function contained(root, candidate) {
  const rel = relative(root, candidate);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`));
}

function imageDimensions(bytes, mime) {
  if (mime === "image/png" && bytes.byteLength >= 24 && bytes[0] === 0x89) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return [view.getUint32(16, false), view.getUint32(20, false)];
  }
  if (mime === "image/jpeg") {
    let offset = 2;
    while (offset + 8 < bytes.byteLength) {
      if (bytes[offset] !== 0xff) break;
      const marker = bytes[offset + 1];
      const length = (bytes[offset + 2] << 8) | bytes[offset + 3];
      if (marker >= 0xc0 && marker <= 0xc3) return [(bytes[offset + 7] << 8) | bytes[offset + 8], (bytes[offset + 5] << 8) | bytes[offset + 6]];
      offset += 2 + length;
    }
  }
  if (mime === "image/webp" && bytes.byteLength >= 30 && String.fromCharCode(...bytes.subarray(12, 16)) === "VP8X") {
    const width = 1 + bytes[24] + (bytes[25] << 8) + (bytes[26] << 16);
    const height = 1 + bytes[27] + (bytes[28] << 8) + (bytes[29] << 16);
    return [width, height];
  }
  return [0, 0];
}

function glbBinaryStart(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const jsonLength = view.getUint32(12, true);
  return 20 + jsonLength + 8;
}

/** Mechanical metrics and embedded texture evidence derived directly from GLB bytes. */
export function inspectGlbAsset(bytes) {
  const measured = measureGlb(bytes);
  const json = parseGltfJson(bytes);
  const textures = [];
  if (json !== null) {
    const slotRefs = [];
    for (const material of json.materials ?? []) {
      const pbr = material.pbrMetallicRoughness ?? {};
      for (const [slot, ref] of [
        ["baseColor", pbr.baseColorTexture], ["metallicRoughness", pbr.metallicRoughnessTexture],
        ["normal", material.normalTexture], ["occlusion", material.occlusionTexture], ["emissive", material.emissiveTexture],
      ]) if (ref?.index !== undefined) slotRefs.push([slot, ref.index]);
    }
    const binaryStart = bytes.byteLength >= 20 ? glbBinaryStart(bytes) : 0;
    for (const [slot, textureIndex] of slotRefs) {
      const sourceIndex = json.textures?.[textureIndex]?.source;
      const image = sourceIndex === undefined ? undefined : json.images?.[sourceIndex];
      const view = image?.bufferView === undefined ? undefined : json.bufferViews?.[image.bufferView];
      let width = 0, height = 0;
      if (view !== undefined && binaryStart > 0) {
        const start = binaryStart + (view.byteOffset ?? 0);
        [width, height] = imageDimensions(bytes.subarray(start, start + view.byteLength), image.mimeType);
      }
      textures.push({ slot, mimeType: image?.mimeType ?? "external", width, height });
    }
  }
  const uniqueTextures = [...new Map(textures.map((texture) => [`${texture.slot}:${texture.mimeType}:${texture.width}:${texture.height}`, texture])).values()]
    .sort((a, b) => a.slot.localeCompare(b.slot) || a.width - b.width || a.height - b.height);
  return Object.freeze({
    boundsM: measured.bboxDims.map((value) => Number(value.toFixed(6))),
    vertexCount: measured.vertexCount,
    triangleCount: measured.triangleCount,
    meshCount: measured.meshCount,
    primitiveCount: (json?.meshes ?? []).reduce((sum, mesh) => sum + (mesh.primitives?.length ?? 0), 0),
    materialCount: measured.materialCount,
    textureSlots: [...new Set(uniqueTextures.map((texture) => texture.slot))].sort(),
    textures: uniqueTextures,
  });
}

function canonicalMetrics(metrics) {
  return JSON.stringify(metrics);
}

function failure(assetId, gate, detail) { return { assetId, gate, detail }; }

/** Fail-closed acceptance verification. Mechanical and human-visual results stay separate. */
export function runAssetManifestGate(manifest, { assetRoot }) {
  const failures = [], mechanicalFailures = [], humanFailures = [];
  const failMechanical = (id, gate, detail) => mechanicalFailures.push(failure(id, gate, detail));
  const failHuman = (id, gate, detail) => humanFailures.push(failure(id, gate, detail));
  if (manifest?.schema !== ASSET_MANIFEST_SCHEMA) failMechanical("<manifest>", "schema", `expected ${ASSET_MANIFEST_SCHEMA}`);
  if (manifest?.unlistedPolicy !== "excluded") failMechanical("<manifest>", "unlisted-policy", "unlisted assets must be explicitly excluded from acceptance");
  const root = resolve(assetRoot);
  const seen = new Set();
  for (const entry of Array.isArray(manifest?.entries) ? manifest.entries : []) {
    const id = typeof entry?.id === "string" ? entry.id : "<invalid>";
    if (seen.has(id)) { failMechanical(id, "duplicate", "duplicate accepted asset id"); continue; }
    seen.add(id);
    if (!CLASSES.has(entry?.class)) failMechanical(id, "class", "unknown asset class");
    const policy = CLASS_POLICY[entry?.class] ?? CLASS_POLICY.model;
    const modelPath = resolve(root, entry?.model?.path ?? "");
    if (!contained(root, modelPath) || modelPath === root) { failMechanical(id, "model-path", "model path escapes asset root"); continue; }
    if (!existsSync(modelPath)) { failMechanical(id, "model-missing", "accepted model file is missing"); continue; }
    const bytes = readFileSync(modelPath);
    const actualHash = sha256(bytes);
    if (!HASH.test(entry?.model?.sha256 ?? "") || actualHash !== entry.model.sha256) failMechanical(id, "model-hash", `model hash is stale (actual ${actualHash})`);
    const actualMetrics = inspectGlbAsset(bytes);
    if (canonicalMetrics(actualMetrics) !== canonicalMetrics(entry.metrics)) failMechanical(id, "metrics", "recorded GLB metrics/texture metadata are stale");
    if (actualMetrics.meshCount > policy.maxMeshes) failMechanical(id, "draw-calls", `mesh count ${actualMetrics.meshCount} exceeds class limit ${policy.maxMeshes}`);
    if (actualMetrics.primitiveCount > policy.maxDrawCalls) failMechanical(id, "draw-calls", `primitive draw count ${actualMetrics.primitiveCount} exceeds class limit ${policy.maxDrawCalls}`);
    for (const slot of policy.requiredSlots) if (!actualMetrics.textureSlots.includes(slot)) failMechanical(id, "texture-slot", `class '${entry.class}' requires ${slot}`);
    for (const texture of actualMetrics.textures) if (texture.width < 1 || texture.height < 1) failMechanical(id, "texture-resolution", `${texture.slot} texture resolution is not inspectable`);
    if (typeof entry?.provenance?.sourceUrl !== "string" || !entry.provenance.sourceUrl.startsWith("https://")) failMechanical(id, "source", "source URL must be a persisted HTTPS URL");
    if (!SUPPORTED_SPDX.has(entry?.provenance?.licenseSpdx)) failMechanical(id, "license", "SPDX license is missing, unknown, or unsupported");
    if (entry?.provenance?.licenseSpdx !== "CC0-1.0" && !entry?.provenance?.attribution) failMechanical(id, "attribution", "non-CC0 asset is missing required attribution");
    const lods = Array.isArray(entry?.lods) ? entry.lods : [];
    if (policy.requiresLod && lods.length < 1) failMechanical(id, "lod", `class '${entry.class}' requires at least one LOD`);
    let lastDistance = 0;
    for (const lod of lods) {
      const lodPath = resolve(root, lod?.path ?? "");
      if (!contained(root, lodPath) || !existsSync(lodPath)) { failMechanical(id, "lod-missing", `LOD '${lod?.path}' is missing or unsafe`); continue; }
      const lodHash = sha256(readFileSync(lodPath));
      if (lodHash !== lod.sha256) failMechanical(id, "lod-hash", `LOD '${lod.path}' hash is stale`);
      if (!(lod.distanceM > lastDistance)) failMechanical(id, "lod-distance", "LOD distances must increase strictly");
      lastDistance = lod.distanceM;
    }
    const impostor = entry?.impostor;
    if (impostor !== undefined) {
      if (entry.class !== "vegetation") failMechanical(id, "impostor-class", "derived impostors are only valid for vegetation entries");
      const impostorPath = resolve(root, impostor?.path ?? "");
      if (!contained(root, impostorPath) || !existsSync(impostorPath)) failMechanical(id, "impostor-missing", "derived impostor GLB is missing or unsafe");
      else {
        const impostorBytes = readFileSync(impostorPath);
        if (sha256(impostorBytes) !== impostor.sha256) failMechanical(id, "impostor-hash", "derived impostor hash is stale");
        const json = parseGltfJson(impostorBytes);
        const descriptor = (json?.nodes ?? []).find((node) => node?.extras?.liminaTreeImpostor)?.extras?.liminaTreeImpostor;
        const impostorMetrics = inspectGlbAsset(impostorBytes);
        if (descriptor?.schema !== "limina.tree-impostor/2" || descriptor?.config?.projection !== "upper-hemi-octa-rotated-diamond") {
          failMechanical(id, "impostor-schema", "derived impostor descriptor/projection is missing or unsupported");
        }
        if (descriptor?.sourceSha256 !== entry.model.sha256 || descriptor?.lodSha256 !== lods.at(-1)?.sha256) {
          failMechanical(id, "impostor-source", "derived impostor source/LOD hashes do not match the accepted chain");
        }
        if (!HASH.test(descriptor?.sourceContentHash ?? "") || !HASH.test(descriptor?.lodContentHash ?? "")) {
          failMechanical(id, "impostor-content-address", "derived impostor is missing Limina runtime source/LOD content addresses");
        }
        const material = json?.materials?.[0];
        if ((json?.meshes?.length ?? 0) !== 1 || (json?.meshes?.[0]?.primitives?.length ?? 0) !== 1 || impostorMetrics.triangleCount !== 2 ||
            material?.alphaMode !== "MASK" || material?.doubleSided !== true || !impostorMetrics.textureSlots.includes("baseColor") ||
            !impostorMetrics.textureSlots.includes("normal") || impostorMetrics.textures.length !== 2 ||
            impostorMetrics.textures.some((texture) => texture.mimeType !== "image/png" || texture.width !== descriptor?.config?.atlasSize || texture.height !== descriptor?.config?.atlasSize)) {
          failMechanical(id, "impostor-contract", "derived impostor must be one alpha-mask quad with two embedded descriptor-sized PNG textures");
        }
        if (!(impostor.distanceM > lastDistance)) failMechanical(id, "impostor-distance", "impostor distance must follow every geometry LOD");
        if (descriptor?.config?.normalEncoding !== "view-normal-xy-rg-unorm8-positive-z" || descriptor?.config?.depthEncoding !== "linear-view-depth-b-unorm8" ||
            descriptor?.config?.alphaEncoding !== "coverage-a-unorm8") {
          failMechanical(id, "impostor-channels", "derived impostor normal/depth/alpha channel contract is unsupported");
        }
      }
      const evidencePath = resolve(root, impostor?.qc?.evidence?.path ?? "");
      if (!contained(root, evidencePath) || !existsSync(evidencePath)) failMechanical(id, "impostor-evidence", "derived impostor mechanical evidence is missing or unsafe");
      else if (sha256(readFileSync(evidencePath)) !== impostor.qc.evidence.sha256) failMechanical(id, "impostor-evidence-hash", "derived impostor mechanical evidence hash is stale");
    }
    if (entry?.qc?.gateVersion !== ASSET_QC_GATE_VERSION) failMechanical(id, "qc-version", `expected ${ASSET_QC_GATE_VERSION}`);
    const evidencePath = resolve(root, entry?.qc?.evidence?.path ?? "");
    if (!contained(root, evidencePath) || !existsSync(evidencePath)) failMechanical(id, "evidence-missing", "QC evidence file is missing or unsafe");
    else if (sha256(readFileSync(evidencePath)) !== entry.qc.evidence.sha256) failMechanical(id, "evidence-hash", "QC evidence hash is stale");
    const human = entry?.qc?.humanVisualApproval;
    if (human?.approved !== true || typeof human?.approvedBy !== "string" || !human.approvedBy || typeof human?.referenceContract !== "string" || !human.referenceContract) {
      failHuman(id, "human-visual", "explicit human approval against a named reference contract is required");
    }
  }
  const acceptedCount = seen.size;
  let candidateCount = 0;
  for (const candidate of Array.isArray(manifest?.candidates) ? manifest.candidates : []) {
    const id = typeof candidate?.id === "string" ? candidate.id : "<invalid-candidate>";
    candidateCount++;
    if (seen.has(id)) { failMechanical(id, "duplicate", "candidate id collides with another manifest record"); continue; }
    seen.add(id);
    if (typeof candidate?.status !== "string" || !candidate.status.startsWith("candidate-")) failMechanical(id, "candidate-status", "candidate status must remain explicitly non-accepted");
    if (!CLASSES.has(candidate?.class)) failMechanical(id, "class", "unknown candidate asset class");
    const modelPath = resolve(root, candidate?.model?.path ?? "");
    if (!contained(root, modelPath) || modelPath === root || !existsSync(modelPath)) { failMechanical(id, "model-missing", "candidate model is missing or unsafe"); continue; }
    const bytes = readFileSync(modelPath);
    const modelHash = sha256(bytes);
    if (modelHash !== candidate.model.sha256) failMechanical(id, "model-hash", `candidate model hash is stale (actual ${modelHash})`);
    const actualMetrics = inspectGlbAsset(bytes);
    if (canonicalMetrics(actualMetrics) !== canonicalMetrics(candidate.metrics)) failMechanical(id, "metrics", "candidate model metrics are stale");
    const candidatePolicy = CLASS_POLICY[candidate?.class] ?? CLASS_POLICY.model;
    // Candidates may truthfully record optimization debt (mesh consolidation / LOD generation).
    // Acceptance policy ceilings are enforced only for entries[]; candidate integrity still pins the
    // exact measured counts and evidence so the debt cannot be hidden or silently rewritten.
    for (const slot of candidatePolicy.requiredSlots) if (!actualMetrics.textureSlots.includes(slot)) failMechanical(id, "texture-slot", `candidate class '${candidate.class}' requires ${slot}`);
    for (const texture of actualMetrics.textures) if (texture.width < 1 || texture.height < 1) failMechanical(id, "texture-resolution", `candidate ${texture.slot} resolution is not inspectable`);
    if (typeof candidate?.provenance?.sourceUrl !== "string" || !candidate.provenance.sourceUrl.startsWith("https://")) failMechanical(id, "source", "candidate source URL is missing");
    if (!SUPPORTED_SPDX.has(candidate?.provenance?.licenseSpdx)) failMechanical(id, "license", "candidate SPDX license is missing or unsupported");
    if (candidate?.provenance?.licenseSpdx !== "CC0-1.0" && !candidate?.provenance?.attribution) failMechanical(id, "attribution", "candidate attribution is missing");
    let priorTriangles = actualMetrics.triangleCount;
    for (const lod of Array.isArray(candidate?.lods) ? candidate.lods : []) {
      const lodPath = resolve(root, lod?.path ?? "");
      if (!contained(root, lodPath) || !existsSync(lodPath)) { failMechanical(id, "lod-missing", `candidate LOD '${lod?.path}' is missing or unsafe`); continue; }
      const lodBytes = readFileSync(lodPath);
      if (sha256(lodBytes) !== lod.sha256) failMechanical(id, "lod-hash", `candidate LOD '${lod.path}' hash is stale`);
      const lodMetrics = inspectGlbAsset(lodBytes);
      if (canonicalMetrics(lodMetrics) !== canonicalMetrics(lod.metrics)) failMechanical(id, "lod-metrics", `candidate LOD '${lod.path}' metrics are stale`);
      if (lodMetrics.triangleCount >= priorTriangles) failMechanical(id, "lod-reduction", `candidate LOD '${lod.path}' does not reduce triangles`);
      if (canonicalMetrics(lodMetrics.textureSlots) !== canonicalMetrics(actualMetrics.textureSlots)
          || lodMetrics.materialCount !== actualMetrics.materialCount) {
        failMechanical(id, "lod-materials", `candidate LOD '${lod.path}' did not preserve material/texture slots`);
      }
      if (lodMetrics.boundsM.some((value, axis) => Math.abs(value - actualMetrics.boundsM[axis]) > Math.max(0.1, actualMetrics.boundsM[axis] * 0.1))) {
        failMechanical(id, "lod-bounds", `candidate LOD '${lod.path}' changed bounds by more than 10%`);
      }
      priorTriangles = lodMetrics.triangleCount;
    }
    if (candidate?.qc?.gateVersion !== ASSET_QC_GATE_VERSION) failMechanical(id, "qc-version", `candidate expected ${ASSET_QC_GATE_VERSION}`);
    const evidence = candidate?.qc?.mechanicalEvidence;
    const evidencePath = resolve(root, evidence?.path ?? "");
    if (!contained(root, evidencePath) || !existsSync(evidencePath)) failMechanical(id, "mechanical-evidence", "candidate mechanical evidence is missing or unsafe");
    else if (sha256(readFileSync(evidencePath)) !== evidence.sha256) failMechanical(id, "mechanical-evidence-hash", "candidate mechanical evidence hash is stale");
    if (candidate?.qc?.humanVisualApproval) failMechanical(id, "candidate-approval", "candidate records cannot claim human approval; migrate deliberately to entries[]");
  }
  failures.push(...mechanicalFailures, ...humanFailures);
  return Object.freeze({
    pass: failures.length === 0,
    mechanicalPass: mechanicalFailures.length === 0,
    humanVisualPass: humanFailures.length === 0,
    acceptedEntries: acceptedCount,
    candidates: candidateCount,
    failures,
  });
}

export function readAssetManifest(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

/** Persist a fetched asset as a candidate. Fetching never self-approves visual evidence. */
export function upsertAssetCandidate(manifestPath, candidate) {
  const manifest = existsSync(manifestPath)
    ? readAssetManifest(manifestPath)
    : { schema: ASSET_MANIFEST_SCHEMA, unlistedPolicy: "excluded", entries: [], candidates: [] };
  if (manifest.schema !== ASSET_MANIFEST_SCHEMA) throw new Error(`asset manifest schema must be ${ASSET_MANIFEST_SCHEMA}`);
  const candidates = Array.isArray(manifest.candidates) ? manifest.candidates : [];
  const next = { ...manifest, candidates: [...candidates.filter((entry) => entry.id !== candidate.id), candidate].sort((a, b) => a.id.localeCompare(b.id)) };
  const temporary = `${manifestPath}.tmp-${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`, { flag: "wx" });
  renameSync(temporary, manifestPath);
  return candidate;
}
