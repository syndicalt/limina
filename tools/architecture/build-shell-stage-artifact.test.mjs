import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { validateBuildingStageArtifact, BUILDING_STAGE_FACETS } from "../../js/src/assets/staged-building-pipeline.mjs";

const artifact = validateBuildingStageArtifact(JSON.parse(await readFile(new URL("../../assets/buildings/authoring/functional-hall-house-v4/shell-artifact-draft.json", import.meta.url), "utf8")));
assert.equal(artifact.kind, "shell"); assert.equal(artifact.status, "draft"); assert.equal(artifact.metadata.gate, "A1-shell");
assert.deepEqual(artifact.metadata.exclusions, { furniture: true, domesticProps: true, fireVisuals: true, practicalLights: true });
assert.deepEqual(artifact.facets.map(({ scope }) => scope), BUILDING_STAGE_FACETS.shell);
assert.match(artifact.metadata.sourceBlend.sha256, /^sha256:[0-9a-f]{64}$/);
console.log("staged shell draft binds exact shell-only Blender and GLB sources");
