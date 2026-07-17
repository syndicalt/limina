import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { validateBuildingStageArtifact } from "../../js/src/assets/staged-building-pipeline.mjs";
import { validateStagedMaterialReviewAuthority, verifyStagedMaterialReviewClosure } from "../../js/src/render/staged-material-review-scene.ts";
import { finalizeMaterialPaletteStage } from "./finalize-material-palette-stage.mjs";

const repo = resolve(import.meta.dirname, "../.."), artifactPath = "assets/buildings/authoring/functional-hall-house-v4/material-palette-artifact-draft.json", authorityPath = "assets/buildings/authoring/functional-hall-house-v4/material-review-authority.json";

test("CPU M1 finalizer binds exact KTX2 runtime, manifest facets, and review authority reproducibly", async () => {
  const directory = await mkdtemp(join(tmpdir(), "limina-m1-finalizer-"));
  try {
    const artifact = join(directory, "artifact.json"), authority = join(directory, "authority.json");
    await finalizeMaterialPaletteStage({ repoRoot: repo, artifactOutputPath: artifact, artifactMetadataPath: artifactPath, authorityOutputPath: authority });
    const builtArtifact = validateBuildingStageArtifact(JSON.parse(await readFile(artifact, "utf8"))), builtAuthority = validateStagedMaterialReviewAuthority(JSON.parse(await readFile(authority, "utf8")));
    assert.equal(builtArtifact.status, "draft"); assert.equal(builtArtifact.contentHash, "sha256:2ce5606bb49fee1867901708da6ab79e42de9350cd69a7b9eede489dfb412f97"); assert.deepEqual(builtArtifact.evidence, []);
    assert.equal(builtAuthority.derived.sha256, builtArtifact.contentHash); assert.equal(builtAuthority.derived.fallback, "none"); assert.equal(builtAuthority.paletteLock.packIds.length, 6); assert.equal(builtAuthority.paletteLock.authoredSimpleRoles.length, 11);
    const oldArtifact = JSON.parse(await readFile(resolve(repo, "assets/buildings/authoring/functional-hall-house-v4/material-palette-artifact-pre-derivation-draft.json"), "utf8")), oldFacets = new Map(oldArtifact.facets.map((facet) => [facet.scope, facet.hash])), newFacets = new Map(builtArtifact.facets.map((facet) => [facet.scope, facet.hash]));
    for (const scope of ["role-contract","source-lock","surface-parameters"]) assert.equal(newFacets.get(scope), oldFacets.get(scope));
    assert.notEqual(newFacets.get("runtime-textures"), oldFacets.get("runtime-textures")); assert.notEqual(newFacets.get("encoding-budget"), oldFacets.get("encoding-budget"));
    assert.deepEqual(await readFile(artifact), await readFile(resolve(repo, artifactPath)), "checked-in derived M1 draft is not reproducible"); assert.deepEqual(await readFile(authority), await readFile(resolve(repo, authorityPath)), "checked-in M1 review authority is not reproducible");
    verifyStagedMaterialReviewClosure(builtAuthority, (path) => new Uint8Array(readFileSync(resolve(repo, path))));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("CPU M1 finalizer rejects a mutated no-fallback or budget manifest", async () => {
  const directory = await mkdtemp(join(tmpdir(), "limina-m1-manifest-mutation-"));
  try {
    const source = JSON.parse(await readFile(resolve(repo, "assets/buildings/authoring/functional-hall-house-v4/material-palette/shell-m1-production.ktx2.json"), "utf8")); source.policy.pngFallback = true;
    const manifest = join(directory, "manifest.json"); await writeFile(manifest, JSON.stringify(source));
    await assert.rejects(() => finalizeMaterialPaletteStage({ repoRoot: repo, manifestPath: manifest, artifactOutputPath: join(directory,"artifact.json"), authorityOutputPath: join(directory,"authority.json") }), /policy does not match/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
