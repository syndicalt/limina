import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  SOURCE_SHA256,
  ktx2ModeFieldFor,
  ktx2ModeFor,
  preflightKtx2Source,
  validateKtx2EncodingBudget,
  validateKtx2OutputDocument,
  validateKtx2SourceDocument,
} from "./compress-hall-house-v4-ktx2.mjs";

const root = new URL("../../", import.meta.url);
const approvedPath = new URL("assets/buildings/authoring/functional-hall-house-v4/shell-artifact-approved.json", root);
const decisionPath = new URL("assets/buildings/authoring/functional-hall-house-v4/shell-review-decision-approve.json", root);
const materialLockPath = new URL("assets/buildings/authoring/functional-hall-house-v4/materials.lock.json", root);
const approved = JSON.parse(await readFile(approvedPath, "utf8"));
const decision = JSON.parse(await readFile(decisionPath, "utf8"));
const materialLock = JSON.parse(await readFile(materialLockPath, "utf8"));
const sourcePath = new URL(approved.metadata.runtimeGlb.path, root);
const source = await readFile(sourcePath);
const legacySource = await readFile(new URL("assets/buildings/functional-hall-house-v4-lod.glb", root));
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const expectedInventory = Object.freeze({
  images: 18,
  textures: 27,
  materials: 13,
  packs: 6,
  runtimeSlotsPerPack: Object.freeze(["albedo", "normal", "roughness"]),
});
const encodingBudget = Object.freeze({ ...materialLock.encodingBudget });

test("exact A1-approved shell closes the M1 KTX2 source inventory and declared budgets", () => {
  assert.equal(approved.schema, "limina.building-stage-artifact/v1");
  assert.equal(approved.kind, "shell");
  assert.equal(approved.status, "approved");
  assert.equal(approved.artifactId, "shell/functional-hall-house-v4/r1");
  assert.equal(approved.contentHash, "sha256:25577df12c293923ed24c5df33d89b820e8a3e176cce671c95b62d3daf2ba344");
  assert.equal(approved.metadata.runtimeGlb.sha256, approved.contentHash);
  assert.equal(`sha256:${sha256(source)}`, approved.contentHash);
  assert.equal(materialLock.schema, "limina.building-material-palette/v1");
  assert.equal(materialLock.inputShell.artifactId, approved.artifactId);
  assert.equal(materialLock.inputShell.contractHash, approved.contractHash);
  assert.equal(materialLock.inputShell.contentHash, approved.contentHash);
  assert.equal(materialLock.inputShell.surfaceMappingFacetHash, approved.facets.find((facet) => facet.scope === "surface-mapping").hash);
  assert.equal(materialLock.inputShell.materialRoleSlotsFacetHash, approved.facets.find((facet) => facet.scope === "material-role-slots").hash);
  assert.equal(decision.decision, "approve");
  assert.equal(decision.gate, "A1-shell");
  for (const key of ["artifactId", "contractHash", "contentHash"]) assert.equal(decision[key], approved[key]);

  const result = preflightKtx2Source(source, {
    expectedSourceSha256: approved.contentHash.slice("sha256:".length),
    encodingBudget,
    expectedInventory,
  });
  assert.equal(result.json.images.length, 18);
  assert.equal(result.json.textures.length, 27);
  assert.equal(result.json.materials.length, 13);
  assert.equal(result.declaredPacks.size, 6);
  assert.equal(result.usage.length, 18);
  assert.ok(result.usage.every((entries) => entries.length >= 1));
  assert.ok(result.json.images.every((image) => Number.isInteger(image.bufferView) && new Set(["image/jpeg", "image/png"]).has(image.mimeType)));
  assert.ok(result.json.textures.every((texture) => Number.isInteger(texture.source) && texture.extensions?.KHR_texture_basisu === undefined));
  assert.equal(result.budget.maxArtifactBytes, 24 * 1024 * 1024);
  assert.equal(result.budget.maxGpuResidencyBytes, 72 * 1024 * 1024);
  assert.equal(result.budget.maxTextureObjects, 32);
  assert.equal(result.budget.maxUniqueImages, 18);
});

test("source closure rejects duplicate pack-slot images and missing pack slots", () => {
  const { json } = preflightKtx2Source(source, {
    expectedSourceSha256: approved.contentHash.slice("sha256:".length), encodingBudget, expectedInventory,
  });
  const duplicatePackSlots = structuredClone(json);
  duplicatePackSlots.materials.find((material) => material.name === "V4 chimney brick").extras.limina_material_pack = "cottage-grey-roof";
  assert.throws(() => validateKtx2SourceDocument(duplicatePackSlots, expectedInventory), /exactly one source image|exact runtime slot set/);

  const missingSlot = structuredClone(json);
  const roof = missingSlot.materials.find((material) => material.name === "V4 blue slate");
  roof.normalTexture = roof.pbrMetallicRoughness.baseColorTexture;
  assert.throws(() => validateKtx2SourceDocument(missingSlot, expectedInventory), /not closed|exactly one source image|exact runtime slot set/);
});

test("record mode selection keeps normal, critical albedo, and default encodings distinct", () => {
  const distinct = Object.freeze({
    ...encodingBudget,
    normalMode: "normal-mode-test",
    criticalAlbedoMode: "critical-albedo-mode-test",
    defaultMode: "default-mode-test",
  });
  // The production validator intentionally restricts the supported strings, so
  // use the exact declared budget to prove selection and guard field swaps.
  assert.equal(ktx2ModeFieldFor("normal", true), "normalMode");
  assert.equal(ktx2ModeFieldFor("albedo", true), "criticalAlbedoMode");
  assert.equal(ktx2ModeFieldFor("albedo", false), "defaultMode");
  assert.equal(ktx2ModeFor("normal", true, encodingBudget), encodingBudget.normalMode);
  assert.equal(ktx2ModeFor("albedo", true, encodingBudget), encodingBudget.criticalAlbedoMode);
  assert.equal(ktx2ModeFor("albedo", false, encodingBudget), encodingBudget.defaultMode);
  assert.throws(() => validateKtx2EncodingBudget(distinct), /normalMode is unsupported/);
});

test("post-derivation closure requires 18 KTX2 images and no fallback raster or texture source", () => {
  const { json } = preflightKtx2Source(source, {
    expectedSourceSha256: approved.contentHash.slice("sha256:".length), encodingBudget, expectedInventory,
  });
  const derived = structuredClone(json);
  derived.images = derived.images.map((image) => ({ ...image, mimeType: "image/ktx2" }));
  derived.textures = derived.textures.map((texture) => {
    const sourceIndex = texture.source;
    const result = { ...texture, extensions: { ...(texture.extensions ?? {}), KHR_texture_basisu: { source: sourceIndex } } };
    delete result.source;
    return result;
  });
  derived.extensionsUsed = [...new Set([...(derived.extensionsUsed ?? []), "KHR_texture_basisu"])];
  derived.extensionsRequired = [...new Set([...(derived.extensionsRequired ?? []), "KHR_texture_basisu"])];
  assert.equal(validateKtx2OutputDocument(derived, { encodingBudget, expectedInventory }), derived);

  const rasterFallback = structuredClone(derived);
  rasterFallback.images[0].mimeType = "image/png";
  assert.throws(() => validateKtx2OutputDocument(rasterFallback, { encodingBudget, expectedInventory }), /fallback raster/);
  const textureFallback = structuredClone(derived);
  textureFallback.textures[0].source = textureFallback.textures[0].extensions.KHR_texture_basisu.source;
  assert.throws(() => validateKtx2OutputDocument(textureFallback, { encodingBudget, expectedInventory }), /fallback or invalid Basis texture source/);
  const missingImage = structuredClone(derived);
  missingImage.images.pop();
  assert.throws(() => validateKtx2OutputDocument(missingImage, { encodingBudget, expectedInventory }), /image inventory drifted/);
});

test("explicit M1 budgets fail closed while legacy compressor authority remains unchanged", () => {
  assert.equal(SOURCE_SHA256, "8fcb0c7df015d7681d078f3ec6619411f7ec368c87705f5bf963fbb528865493");
  const legacy = preflightKtx2Source(legacySource, { expectedSourceSha256: SOURCE_SHA256 });
  assert.equal(legacy.json.images.length, 18);
  assert.equal(legacy.json.textures.length, 30);
  assert.equal(legacy.json.materials.length, 20);
  assert.throws(() => validateKtx2EncodingBudget({ ...encodingBudget, fallback: "png" }), /fallback is unsupported/);
  assert.throws(() => validateKtx2EncodingBudget({ ...encodingBudget, maxArtifactBytes: 0 }), /positive bounded integer/);
  assert.throws(() => validateKtx2EncodingBudget({ ...encodingBudget, maxUniqueImages: 33 }), /unique images exceed texture objects/);
  assert.throws(() => preflightKtx2Source(source, {
    expectedSourceSha256: SOURCE_SHA256, encodingBudget, expectedInventory,
  }), /source authority hash mismatch/);
});
