import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import sharp from "../../js/node_modules/sharp/lib/index.js";
import { BUILDING_MATERIAL_PALETTE_SCHEMA, validateBuildingMaterialPalette } from "../../js/src/assets/building-material-palette.mjs";
import { BUILDING_STAGE_FACETS, validateBuildingStageArtifact } from "../../js/src/assets/staged-building-pipeline.mjs";

export const MATERIAL_PALETTE_ARTIFACT_ID = "materials/functional-hall-house-v4/r1";
export const APPROVED_A1 = Object.freeze({
  artifactId: "shell/functional-hall-house-v4/r1",
  contractHash: "sha256:f656b145b6a788e02fbf8fbc93bc91fcff9e44bbb279d39e53c95f92dd79ba93",
  contentHash: "sha256:25577df12c293923ed24c5df33d89b820e8a3e176cce671c95b62d3daf2ba344",
  surfaceMappingFacetHash: "sha256:231156e0e586c8102a895e5537bd946d397b648c443fef7316495d6757a2edf9",
  materialRoleSlotsFacetHash: "sha256:78a44bc30f281d99dbf1529e9b8585b8e635aa89168204ebb1db665e932e20f0",
});
export const MATERIAL_PALETTE_R2_ARTIFACT_ID = "materials/functional-hall-house-v4/r2";
export const APPROVED_A1_R4 = Object.freeze({
  artifactId: "shell/functional-hall-house-v4/r4",
  contractHash: "sha256:16e53efe05d769dc345687453a1ff2eca8bbfa734979fdc7065700d1ce2037ee",
  contentHash: "sha256:4aba79d5285d5bd0dddbc454b1949e986bf7cf52ce2e743a23814433b04b69ed",
  surfaceMappingFacetHash: "sha256:4d809e3a26c5581b0261e34011775f2979354a5dea8ee4caf296364f0d01e58a",
  materialRoleSlotsFacetHash: "sha256:d99f45d677b6f3a8b43d2d30e0107aa13d10dd052f2f8ac40a044d34a2f574c7",
});

const MAP_CONTRACT = Object.freeze({
  albedo: ["sRGB", "rgb-color"], normal: ["linear", "rgb-tangent-space"], roughness: ["linear", "r-roughness"],
  occlusion: ["linear", "r-occlusion"], displacement: ["linear", "r-height-white-high"],
});
const PACKS = Object.freeze({
  "cottage-fieldstone": "castle_wall_slates", "cottage-grey-roof": "grey_roof_tiles_02", "cottage-medieval-brick": "medieval_red_brick",
  "cottage-structural-oak": "rough_wood", "cottage-white-plaster": "white_plaster_02", "cottage-worn-planks": "medieval_wood",
});
const TEXTURED = Object.freeze([
  ["door-surface", "V4 door oak", "cottage-structural-oak", 2.4, 384, 512],
  ["floor-furnishing", "V4 worn oak", "cottage-worn-planks", 2.4, 384, 512],
  ["foundation", "V4 fieldstone", "cottage-fieldstone", 2.35, 384, 512],
  ["furniture-wood", "V4 furniture oak", "cottage-structural-oak", 1.6, 576, 704],
  ["hearth-masonry", "V4 chimney brick", "cottage-medieval-brick", 1.85, 500, 640],
  ["mortar-reveal", "V4 lime mortar", "cottage-white-plaster", 2.8, 320, 420],
  ["roof", "V4 blue slate", "cottage-grey-roof", 2.2, 420, 512],
  ["structure-trim", "V4 structural oak", "cottage-structural-oak", 2.4, 384, 512],
  ["wall-exterior", "V4 warm lime plaster", "cottage-white-plaster", 3.2, 300, 384],
  ["wall-interior", "V4 interior lime", "cottage-white-plaster", 3.2, 300, 384],
]);
const SIMPLE = Object.freeze([
  ["domestic-ceramic", "V4 warm ceramic", [.34,.18,.09], .74, 0, 1, [0,0,0], 0],
  ["domestic-ceramic-dark", "V4 ceramic interior", [.045,.024,.015], .88, 0, 1, [0,0,0], 0],
  ["door-hardware", "V4 black iron", [.035,.032,.028], .46, .85, 1, [0,0,0], 0],
  ["flame-inner", "V4 flame inner", [.88,.48,.045], .48, 0, .78, [.88,.48,.045], .85],
  ["flame-outer", "V4 flame outer", [.78,.18,.018], .52, 0, .72, [.78,.18,.018], .85],
  ["glazing", "V4 leadlight glass", [.12,.20,.22], .22, 0, .24, [0,0,0], 0],
  ["hearth-embers", "V4 hearth embers", [.72,.065,.008], .54, 0, 1, [.72,.065,.008], .55],
  ["hearth-soot", "V4 hearth soot", [.012,.009,.007], .96, 0, 1, [0,0,0], 0],
  ["roof-flashing", "V4 weathered lead", [.16,.18,.18], .62, .25, 1, [0,0,0], 0],
  ["textile-wool", "V4 woven wool", [.23,.055,.035], .92, 0, 1, [0,0,0], 0],
  ["wax", "V4 beeswax", [.76,.52,.16], .72, 0, 1, [0,0,0], 0],
]);
export const MATERIAL_ROLE_IDS = Object.freeze([...TEXTURED.map(([role]) => role), ...SIMPLE.map(([role]) => role)].sort());
export const MATERIAL_PACK_IDS = Object.freeze(Object.keys(PACKS).sort());

const sha = (bytes) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const md5 = (bytes) => createHash("md5").update(bytes).digest("hex");
const assetHash = (bytes) => `sha256:${createHash("sha256").update(Buffer.from(bytes).toString("hex"), "utf8").digest("hex")}`;
const portable = (repo, path) => relative(repo, path).split(sep).join("/");
const jsonBytes = (value) => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
const compactHash = (value) => sha(Buffer.from(JSON.stringify(value)));

function parseGlbJson(bytes) {
  if (bytes.length < 20 || bytes.readUInt32LE(0) !== 0x46546c67 || bytes.readUInt32LE(4) !== 2 || bytes.readUInt32LE(8) !== bytes.length || bytes.readUInt32LE(16) !== 0x4e4f534a) throw new Error("approved A1 runtime asset is not canonical GLB2");
  return JSON.parse(bytes.subarray(20, 20 + bytes.readUInt32LE(12)).toString().trim());
}

async function lockPack(repo, id, sourceAssetId, embeddedManifestHash) {
  const manifestPath = resolve(repo, `assets/materials/${id}/material-pack.json`), manifestBytes = await readFile(manifestPath), manifestHash = sha(manifestBytes);
  if (manifestHash !== embeddedManifestHash) throw new Error(`approved A1 embedded material manifest drifted: ${id}`);
  const manifest = JSON.parse(manifestBytes);
  if (manifest.schema !== "limina.material-pack/v1" || manifest.id !== id || manifest.source?.provider !== "Poly Haven" || manifest.source.assetId !== sourceAssetId || manifest.source.apiVersion !== "v1" || manifest.source.licenseSpdx !== "CC0-1.0") throw new Error(`material pack ${id} source identity is not the approved Poly Haven CC0 source`);
  const maps = {};
  for (const [slot, [colorSpace, channelSemantics]] of Object.entries(MAP_CONTRACT)) {
    const record = manifest.maps?.[slot];
    if (record?.assetId !== `materials/${id}/${slot}.jpg` || typeof record.sourceUrl !== "string" || typeof record.md5 !== "string") throw new Error(`material pack ${id} lacks canonical ${slot} identity`);
    const bytes = await readFile(resolve(repo, "assets", record.assetId)), metadata = await sharp(bytes).metadata();
    if (sha(bytes) !== record.sha256 || assetHash(bytes) !== record.assetHash || md5(bytes) !== record.md5 || bytes.length !== record.bytes) throw new Error(`material pack ${id}/${slot} bytes drifted`);
    if (metadata.width !== 1024 || metadata.height !== 1024 || metadata.format !== "jpeg") throw new Error(`material pack ${id}/${slot} is not the locked 1024 JPEG source`);
    maps[slot] = { assetId: record.assetId, sha256: record.sha256, assetHash: record.assetHash, sourceMd5: record.md5, bytes: record.bytes, width: 1024, height: 1024, sourceUrl: record.sourceUrl, colorSpace, channelSemantics };
  }
  return { id, provider: "Poly Haven", assetId: sourceAssetId, assetUrl: manifest.source.assetUrl, apiUrl: manifest.source.apiUrl, apiVersion: "v1", licenseSpdx: "CC0-1.0", manifestSha256: manifestHash, maps };
}

function exactShellInput(shell) {
  const facets = new Map(shell.facets.map((facet) => [facet.scope, facet.hash]));
  return { artifactId: shell.artifactId, contractHash: shell.contractHash, contentHash: shell.contentHash,
    surfaceMappingFacetHash: facets.get("surface-mapping"), materialRoleSlotsFacetHash: facets.get("material-role-slots") };
}

function facetPayloads(lock) {
  return {
    "role-contract": lock.roles.map(({ role, materialName, kind, packId, authoredBy }) => ({ role, materialName, kind, ...(packId ? { packId } : {}), ...(authoredBy ? { authoredBy } : {}) })),
    "source-lock": lock.packs,
    "surface-parameters": lock.roles.map(({ role, normal, surface, parameters }) => ({ role, ...(normal ? { normal, surface } : { parameters }) })),
    "runtime-textures": lock.roles.map(({ role, kind, packId, runtimePolicy }) => ({ role, kind, ...(packId ? { packId, runtimePolicy } : {}) })),
    "encoding-budget": lock.encodingBudget,
  };
}

export async function buildMaterialPaletteStage({ repoRoot = resolve(import.meta.dirname, "../.."), shellArtifactPath = "assets/buildings/authoring/functional-hall-house-v4/shell-artifact-approved.json", lockOutputPath = "assets/buildings/authoring/functional-hall-house-v4/materials.lock.json", lockMetadataPath = lockOutputPath, artifactOutputPath = "assets/buildings/authoring/functional-hall-house-v4/material-palette-artifact-draft.json", approvedShell = APPROVED_A1, paletteArtifactId = MATERIAL_PALETTE_ARTIFACT_ID, revision = 1 } = {}) {
  const repo = resolve(repoRoot), shellPath = resolve(repo, shellArtifactPath), lockPath = resolve(repo, lockOutputPath), recordedLockPath = resolve(repo, lockMetadataPath), artifactPath = resolve(repo, artifactOutputPath);
  const shell = validateBuildingStageArtifact(JSON.parse(await readFile(shellPath, "utf8")));
  if (shell.kind !== "shell" || shell.status !== "approved" || shell.metadata?.gate !== "A1-shell" || shell.metadata?.humanDecision !== "approved") throw new Error("M1 requires the human-approved A1 shell artifact");
  const inputShell = exactShellInput(shell);
  for (const [key, expected] of Object.entries(approvedShell)) if (inputShell[key] !== expected) throw new Error(`approved A1 ${key} drifted`);
  const runtimePath = resolve(repo, shell.metadata?.runtimeGlb?.path ?? ""), runtimeBytes = await readFile(runtimePath);
  if (sha(runtimeBytes) !== approvedShell.contentHash) throw new Error("approved A1 runtime GLB does not match its content identity");
  const gltf = parseGlbJson(runtimeBytes), embedded = gltf.asset?.extras?.liminaMaterialSources?.packs;
  if (!Array.isArray(embedded) || embedded.length !== MATERIAL_PACK_IDS.length) throw new Error("approved A1 does not declare the exact six material packs");
  const embeddedById = new Map(embedded.map((record) => [record.id, `sha256:${record.manifestSha256}`]));
  if (JSON.stringify([...embeddedById.keys()].sort()) !== JSON.stringify(MATERIAL_PACK_IDS)) throw new Error("approved A1 material-pack inventory drifted");
  let texturedPrimitives = 0, tangentPrimitives = 0, missingUvPrimitives = 0;
  for (const node of gltf.nodes ?? []) for (const primitive of gltf.meshes?.[node.mesh]?.primitives ?? []) {
    const material = gltf.materials?.[primitive.material]; if (material?.extras?.limina_material_pack === undefined) continue;
    if (material.occlusionTexture !== undefined) throw new Error("approved A1 embeds AO despite the source-only M1 policy");
    texturedPrimitives++; if (primitive.attributes?.TEXCOORD_0 === undefined) missingUvPrimitives++; if (primitive.attributes?.TANGENT !== undefined) tangentPrimitives++;
  }
  if (texturedPrimitives < 1 || missingUvPrimitives !== 0 || tangentPrimitives !== 0) throw new Error("approved A1 does not support the locked UV-derivative tangent policy");
  const packs = [];
  for (const id of MATERIAL_PACK_IDS) packs.push(await lockPack(repo, id, PACKS[id], embeddedById.get(id)));
  const roles = [
    ...TEXTURED.map(([role, materialName, packId, metresPerRepeat, min, max]) => ({ role, materialName, kind: "texture-pack", packId,
      normal: { convention: "opengl-tangent-space", scale: .62, tangentBasis: "uv-derivative" },
      surface: { metresPerRepeat, sourceTexelsPerMetre: 1024 / metresPerRepeat, texelsPerMetreBand: { min, max } },
      runtimePolicy: { occlusion: "source-only", displacement: "source-only" } })),
    ...SIMPLE.map(([role, materialName, baseColorSrgb, roughness, metallic, alpha, emissionSrgb, emissionStrength]) => ({ role, materialName, kind: "authored-simple", authoredBy: "Limina Project", parameters: { baseColorSrgb, roughness, metallic, alpha, emissionSrgb, emissionStrength } })),
  ].sort((a, b) => a.role.localeCompare(b.role));
  const lock = validateBuildingMaterialPalette({ schema: BUILDING_MATERIAL_PALETTE_SCHEMA, paletteId: paletteArtifactId, revision, inputShell, packs, roles,
    encodingBudget: { container: "KTX2", gltfExtension: "KHR_texture_basisu", fallback: "none", mipmaps: true, mipFilter: "lanczos4", normalMode: "UASTC+Zstd", criticalAlbedoMode: "UASTC+Zstd", defaultMode: "ETC1S/BasisLZ", maxArtifactBytes: 24 * 1024 * 1024, maxGpuResidencyBytes: 72 * 1024 * 1024, maxTextureObjects: 32, maxUniqueImages: 18, residencyAccounting: "exact-4x4-blocks-full-mip-chain" } },
  { expectedRoles: MATERIAL_ROLE_IDS, expectedPackIds: MATERIAL_PACK_IDS, inputShell: approvedShell });
  const lockBytes = jsonBytes(lock), contentHash = sha(lockBytes), contractHash = compactHash(lock), payloads = facetPayloads(lock);
  const facets = BUILDING_STAGE_FACETS["material-palette"].map((scope) => ({ scope, hash: compactHash({ schema: "limina.material-palette-facet/v1", scope, payload: payloads[scope] }) }));
  const shellFacets = new Map(shell.facets.map((facet) => [facet.scope, facet]));
  const artifact = validateBuildingStageArtifact({ schema: "limina.building-stage-artifact/v1", artifactId: paletteArtifactId, kind: "material-palette", revision, status: "draft", contractHash, contentHash, facets,
    inputs: [{ artifactId: shell.artifactId, kind: "shell", facets: [shellFacets.get("surface-mapping"), shellFacets.get("material-role-slots")] }], evidence: [],
    metadata: { gate: "M1-materials", humanDecision: "not-reviewed", materialsLock: { path: portable(repo, recordedLockPath), sha256: contentHash }, approvedShell: { path: portable(repo, shellPath), artifactId: shell.artifactId, contractHash: shell.contractHash, contentHash: shell.contentHash }, roleCount: roles.length, packCount: packs.length, policy: { ao: "source-only", displacement: "source-only", tangentBasis: "uv-derivative", gpuRequired: false } } });
  await Promise.all([mkdir(dirname(lockPath), { recursive: true }), mkdir(dirname(artifactPath), { recursive: true })]);
  await Promise.all([writeFile(lockPath, lockBytes, { mode: 0o600 }), writeFile(artifactPath, jsonBytes(artifact), { mode: 0o600 })]);
  return Object.freeze({ lock, artifact, lockBytes });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2), value = (flag, fallback) => { const at = args.indexOf(flag); return at < 0 ? fallback : args[at + 1]; };
  const profile = value("--profile", "r1"), profileOptions = profile === "r1" ? {} : profile === "r2" ? { approvedShell: APPROVED_A1_R4, paletteArtifactId: MATERIAL_PALETTE_R2_ARTIFACT_ID, revision: 2 } : (() => { throw new Error(`unsupported material profile ${profile}`); })();
  const built = await buildMaterialPaletteStage({ ...profileOptions, shellArtifactPath: value("--shell-artifact", undefined), lockOutputPath: value("--out-lock", undefined), lockMetadataPath: value("--lock-metadata-path", undefined), artifactOutputPath: value("--out-artifact", undefined) });
  console.log(JSON.stringify({ artifactId: built.artifact.artifactId, status: built.artifact.status, contentHash: built.artifact.contentHash, roles: built.lock.roles.length, packs: built.lock.packs.length }, null, 2));
}
