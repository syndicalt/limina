import assert from "node:assert/strict";
import { readFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { validateBuildingMaterialPalette } from "../../js/src/assets/building-material-palette.mjs";
import { validateBuildingStageArtifact } from "../../js/src/assets/staged-building-pipeline.mjs";
import { APPROVED_A1, MATERIAL_PACK_IDS, MATERIAL_PALETTE_ARTIFACT_ID, MATERIAL_ROLE_IDS, buildMaterialPaletteStage } from "./build-material-palette-stage.mjs";

const repo = resolve(import.meta.dirname, "../.."), shellPath = "assets/buildings/authoring/functional-hall-house-v4/shell-artifact-approved.json";

test("CPU M1 builder closes exact approved A1 into six packs, 21 roles, and five draft facets", async () => {
  const directory = await mkdtemp(join(tmpdir(), "limina-m1-materials-"));
  try {
    const oneLock = join(directory, "one.lock.json"), oneArtifact = join(directory, "one.artifact.json"), twoLock = join(directory, "two.lock.json"), twoArtifact = join(directory, "two.artifact.json");
    const canonicalLockPath = "assets/buildings/authoring/functional-hall-house-v4/materials.lock.json";
    await buildMaterialPaletteStage({ repoRoot: repo, shellArtifactPath: shellPath, lockOutputPath: oneLock, lockMetadataPath: canonicalLockPath, artifactOutputPath: oneArtifact });
    await buildMaterialPaletteStage({ repoRoot: repo, shellArtifactPath: shellPath, lockOutputPath: twoLock, lockMetadataPath: canonicalLockPath, artifactOutputPath: twoArtifact });
    assert.deepEqual(await readFile(oneLock), await readFile(twoLock), "material lock is not byte deterministic");
    assert.deepEqual(await readFile(oneLock), await readFile(resolve(repo, canonicalLockPath)), "checked-in material lock is not reproducible");
    assert.deepEqual(await readFile(oneArtifact), await readFile(resolve(repo, "assets/buildings/authoring/functional-hall-house-v4/material-palette-artifact-pre-derivation-draft.json")), "checked-in pre-derivation draft history is not reproducible");
    const lock = validateBuildingMaterialPalette(JSON.parse(await readFile(oneLock, "utf8")), { expectedRoles: MATERIAL_ROLE_IDS, expectedPackIds: MATERIAL_PACK_IDS, inputShell: APPROVED_A1 });
    const artifact = validateBuildingStageArtifact(JSON.parse(await readFile(oneArtifact, "utf8")));
    assert.equal(lock.packs.length, 6); assert.equal(lock.roles.length, 21);
    assert.ok(lock.packs.every((pack) => Object.keys(pack.maps).length === 5 && Object.values(pack.maps).every((map) => map.width === 1024 && map.height === 1024 && /^[0-9a-f]{32}$/.test(map.sourceMd5))));
    assert.ok(lock.roles.filter((role) => role.kind === "texture-pack").every((role) => role.normal.convention === "opengl-tangent-space" && role.normal.scale === .62 && role.normal.tangentBasis === "uv-derivative" && role.runtimePolicy.occlusion === "source-only" && role.runtimePolicy.displacement === "source-only"));
    assert.deepEqual(lock.encodingBudget, { container: "KTX2", gltfExtension: "KHR_texture_basisu", fallback: "none", mipmaps: true, mipFilter: "lanczos4", normalMode: "UASTC+Zstd", criticalAlbedoMode: "UASTC+Zstd", defaultMode: "ETC1S/BasisLZ", maxArtifactBytes: 25165824, maxGpuResidencyBytes: 75497472, maxTextureObjects: 32, maxUniqueImages: 18, residencyAccounting: "exact-4x4-blocks-full-mip-chain" });
    assert.equal(artifact.artifactId, MATERIAL_PALETTE_ARTIFACT_ID); assert.equal(artifact.kind, "material-palette"); assert.equal(artifact.status, "draft"); assert.deepEqual(artifact.evidence, []);
    assert.deepEqual(artifact.facets.map((facet) => facet.scope), ["role-contract", "source-lock", "surface-parameters", "runtime-textures", "encoding-budget"]);
    assert.deepEqual(artifact.inputs, [{ artifactId: APPROVED_A1.artifactId, kind: "shell", facets: [{ scope: "surface-mapping", hash: APPROVED_A1.surfaceMappingFacetHash }, { scope: "material-role-slots", hash: APPROVED_A1.materialRoleSlotsFacetHash }] }]);
    const adapter = await readFile(resolve(repo, "tools/blender/architecture-adapter.py"), "utf8"), snippets = [
      'def pbr_material(name,pack,tint=(1,1,1,1),normal_strength=.62):',
      '"foundation":pbr_material("V4 fieldstone","cottage-fieldstone")', '"mortar-reveal":pbr_material("V4 lime mortar","cottage-white-plaster")',
      '"wall-exterior":pbr_material("V4 warm lime plaster","cottage-white-plaster")', '"wall-interior":pbr_material("V4 interior lime","cottage-white-plaster")',
      '"structure-trim":pbr_material("V4 structural oak","cottage-structural-oak")', '"door-surface":pbr_material("V4 door oak","cottage-structural-oak")',
      '"floor-furnishing":pbr_material("V4 worn oak","cottage-worn-planks")', '"furniture-wood":pbr_material("V4 furniture oak","cottage-structural-oak")',
      '"domestic-ceramic":simple_material("V4 warm ceramic",(.34,.18,.09),.74)', '"domestic-ceramic-dark":simple_material("V4 ceramic interior",(.045,.024,.015),.88)',
      '"textile-wool":simple_material("V4 woven wool",(.23,.055,.035),.92)', '"wax":simple_material("V4 beeswax",(.76,.52,.16),.72)',
      '"roof":pbr_material("V4 blue slate","cottage-grey-roof")', '"roof-flashing":simple_material("V4 weathered lead",(.16,.18,.18),.62,.25)',
      '"hearth-masonry":pbr_material("V4 chimney brick","cottage-medieval-brick")', '"hearth-soot":simple_material("V4 hearth soot",(.012,.009,.007),.96)',
      '"hearth-embers":simple_material("V4 hearth embers",(.72,.065,.008),.54,emission=.55)', '"flame-outer":simple_material("V4 flame outer",(.78,.18,.018),.52,alpha=.72,emission=.85)',
      '"flame-inner":simple_material("V4 flame inner",(.88,.48,.045),.48,alpha=.78,emission=.85)', '"glazing":simple_material("V4 leadlight glass",(.12,.20,.22),.22,alpha=.24)',
      '"door-hardware":simple_material("V4 black iron",(.035,.032,.028),.46,.85)',
      'WORLD_UV={"V4 fieldstone":2.35,"V4 lime mortar":2.80,"V4 warm lime plaster":3.20,"V4 interior lime":3.20,"V4 blue slate":2.20,"V4 chimney brick":1.85}',
      'TIMBER_UV={"V4 structural oak":2.40,"V4 door oak":2.40,"V4 worn oak":2.40,"V4 furniture oak":1.60}',
    ];
    for (const snippet of snippets) assert.ok(adapter.includes(snippet), `M1 lock no longer matches adapter: ${snippet}`);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("CPU M1 builder rejects an approved-shell identity mutation before writing outputs", async () => {
  const directory = await mkdtemp(join(tmpdir(), "limina-m1-shell-mutation-"));
  try {
    const shell = JSON.parse(await readFile(resolve(repo, shellPath), "utf8")); shell.contentHash = `sha256:${"0".repeat(64)}`;
    const mutated = join(directory, "shell.json"); await writeFile(mutated, JSON.stringify(shell));
    await assert.rejects(() => buildMaterialPaletteStage({ repoRoot: repo, shellArtifactPath: mutated, lockOutputPath: join(directory, "lock.json"), artifactOutputPath: join(directory, "artifact.json") }), /approved A1 contentHash drifted/);
    await assert.rejects(() => readFile(join(directory, "lock.json")), /ENOENT/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
