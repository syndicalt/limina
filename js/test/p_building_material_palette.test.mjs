import assert from "node:assert/strict";
import test from "node:test";
import { BUILDING_MATERIAL_PALETTE_SCHEMA, validateBuildingMaterialPalette } from "../src/assets/building-material-palette.mjs";

const h = (digit) => `sha256:${digit.repeat(64)}`;
const map = (pack, sourceAssetId, slot, semantics, colorSpace) => ({
  assetId: `materials/${pack}/${slot}.jpg`, sha256: h("1"), assetHash: h("2"), sourceMd5: "a".repeat(32), bytes: 1024,
  width: 1024, height: 1024, sourceUrl: `https://dl.polyhaven.org/file/ph-assets/Textures/jpg/1k/${sourceAssetId}/${sourceAssetId}_${slot}_1k.jpg`,
  colorSpace, channelSemantics: semantics,
});
const textureRole = (role = "roof", materialName = "V4 blue slate") => {
  const pack = "cottage-grey-roof", assetId = "grey_roof_tiles_02", metresPerRepeat = 2.2;
  return {
    role, materialName, kind: "texture-pack", packId: pack,
    normal: { convention: "opengl-tangent-space", scale: 0.62, tangentBasis: "uv-derivative" },
    surface: { metresPerRepeat, sourceTexelsPerMetre: 1024 / metresPerRepeat, texelsPerMetreBand: { min: 400, max: 520 } },
    runtimePolicy: { occlusion: "source-only", displacement: "source-only" },
  };
};
const simpleRole = () => ({ role: "roof-flashing", materialName: "V4 weathered lead", kind: "authored-simple", authoredBy: "Limina Project",
  parameters: { baseColorSrgb: [0.16, 0.18, 0.18], roughness: 0.62, metallic: 0.25, alpha: 1, emissionSrgb: [0, 0, 0], emissionStrength: 0 } });
const inputShell = { artifactId: "shell/functional-hall-house-v4/r1", contractHash: h("4"), contentHash: h("5"), surfaceMappingFacetHash: h("6"), materialRoleSlotsFacetHash: h("7") };
const fixture = () => ({
  schema: BUILDING_MATERIAL_PALETTE_SCHEMA, paletteId: "materials/functional-hall-house-v4/r1", revision: 1, inputShell,
  packs: [{ id: "cottage-grey-roof", provider: "Poly Haven", assetId: "grey_roof_tiles_02", assetUrl: "https://polyhaven.com/a/grey_roof_tiles_02", apiUrl: "https://api.polyhaven.com/files/grey_roof_tiles_02", apiVersion: "v1", licenseSpdx: "CC0-1.0", manifestSha256: h("3"), maps: {
    albedo: map("cottage-grey-roof", "grey_roof_tiles_02", "albedo", "rgb-color", "sRGB"), normal: map("cottage-grey-roof", "grey_roof_tiles_02", "normal", "rgb-tangent-space", "linear"),
    roughness: map("cottage-grey-roof", "grey_roof_tiles_02", "roughness", "r-roughness", "linear"), occlusion: map("cottage-grey-roof", "grey_roof_tiles_02", "occlusion", "r-occlusion", "linear"),
    displacement: map("cottage-grey-roof", "grey_roof_tiles_02", "displacement", "r-height-white-high", "linear"),
  } }],
  roles: [textureRole(), simpleRole()],
  encodingBudget: { container: "KTX2", gltfExtension: "KHR_texture_basisu", fallback: "none", mipmaps: true, mipFilter: "lanczos4",
    normalMode: "UASTC+Zstd", criticalAlbedoMode: "UASTC+Zstd", defaultMode: "ETC1S/BasisLZ", maxArtifactBytes: 24 * 1024 * 1024,
    maxGpuResidencyBytes: 72 * 1024 * 1024, maxTextureObjects: 32, maxUniqueImages: 24, residencyAccounting: "exact-4x4-blocks-full-mip-chain" },
});
const authority = { expectedRoles: ["roof", "roof-flashing"], expectedPackIds: ["cottage-grey-roof"], inputShell };
const mutate = (change) => { const value = structuredClone(fixture()); change(value); return value; };

test("M1 palette closes exact shell, Poly Haven maps, authored roles, sampling, and encoding budgets", () => {
  const palette = validateBuildingMaterialPalette(fixture(), authority);
  assert.equal(palette.roles[0].surface.sourceTexelsPerMetre, 1024 / 2.2);
  assert.ok(Object.isFrozen(palette) && Object.isFrozen(palette.packs[0].maps.normal));
});

test("M1 palette rejects identity, map-contract, normal, density, and runtime-policy drift", () => {
  assert.throws(() => validateBuildingMaterialPalette(mutate((v) => { v.packs[0].assetUrl = "https://polyhaven.com/a/wrong"; }), authority), /URLs/);
  assert.throws(() => validateBuildingMaterialPalette(mutate((v) => { v.packs[0].maps.normal.colorSpace = "sRGB"; }), authority), /color-space/);
  assert.throws(() => validateBuildingMaterialPalette(mutate((v) => { v.packs[0].maps.normal.sourceMd5 = "unknown"; }), authority), /sourceMd5/);
  assert.throws(() => validateBuildingMaterialPalette(mutate((v) => { v.packs[0].maps.roughness.channelSemantics = "rgb-color"; }), authority), /channel semantics/);
  assert.throws(() => validateBuildingMaterialPalette(mutate((v) => { v.roles[0].normal.convention = "directx-tangent-space"; }), authority), /convention/);
  assert.throws(() => validateBuildingMaterialPalette(mutate((v) => { v.roles[0].normal.scale = 0; }), authority), /within/);
  assert.throws(() => validateBuildingMaterialPalette(mutate((v) => { v.roles[0].surface.sourceTexelsPerMetre = 300; }), authority), /disagrees/);
  assert.throws(() => validateBuildingMaterialPalette(mutate((v) => { v.roles[0].surface.texelsPerMetreBand.max = 450; }), authority), /outside/);
  assert.throws(() => validateBuildingMaterialPalette(mutate((v) => { v.roles[0].runtimePolicy.displacement = "silent-drop"; }), authority), /AO\/displacement/);
});

test("M1 palette rejects incomplete or non-canonical role assignment and shell drift", () => {
  assert.throws(() => validateBuildingMaterialPalette(mutate((v) => { v.roles.reverse(); }), authority), /canonically sorted/);
  assert.throws(() => validateBuildingMaterialPalette(mutate((v) => { v.roles.pop(); }), authority), /exact authoritative role set/);
  assert.throws(() => validateBuildingMaterialPalette(mutate((v) => { v.roles[1].role = "roof"; }), { expectedRoles: ["roof"] }), /unique/);
  assert.throws(() => validateBuildingMaterialPalette(mutate((v) => { v.roles[0].packId = "cottage-missing"; }), authority), /does not resolve/);
  assert.throws(() => validateBuildingMaterialPalette(fixture(), { ...authority, expectedPackIds: ["cottage-grey-roof", "cottage-extra"] }), /exact authoritative pack set/);
  assert.throws(() => validateBuildingMaterialPalette(fixture(), { ...authority, inputShell: { ...inputShell, contentHash: h("8") } }), /does not match authority/);
});

test("M1 palette rejects unbounded authored parameters and incomplete KTX2 residency policy", () => {
  assert.throws(() => validateBuildingMaterialPalette(mutate((v) => { v.roles[1].parameters.metallic = 1.1; }), authority), /within/);
  assert.throws(() => validateBuildingMaterialPalette(mutate((v) => { v.roles[1].parameters.extra = true; }), authority), /unsupported/);
  assert.throws(() => validateBuildingMaterialPalette(mutate((v) => { v.encodingBudget.fallback = "png"; }), authority), /fallback-free/);
  assert.throws(() => validateBuildingMaterialPalette(mutate((v) => { v.encodingBudget.maxGpuResidencyBytes = 0; }), authority), /positive bounded/);
  assert.throws(() => validateBuildingMaterialPalette(mutate((v) => { v.encodingBudget.maxUniqueImages = 33; }), authority), /cannot exceed/);
});
