import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import { buildFireRuntimeStageR4 } from "./build-fire-runtime-stage-r4.mjs";
const ROOT = resolve(import.meta.dirname, "../..");
test("fire r4 revises only close-view light authority and preserves locked evidence", async () => {
  const sourceContract = JSON.parse(await Bun.file(resolve(ROOT, "assets/buildings/authoring/functional-hall-house-v4/fire-r3/fire-runtime-contract.json")).text());
  const sourceArtifact = JSON.parse(await Bun.file(resolve(ROOT, "assets/buildings/authoring/functional-hall-house-v4/fire-r3/fire-runtime-artifact-draft.json")).text());
  const result = await buildFireRuntimeStageR4({ repoRoot: ROOT, write: false });
  assert.equal(result.contract.revision, 4); assert.equal(result.contract.light.baseCandela, 1.6); assert.equal(result.contract.light.flickerAmplitudeCandela, .08);
  assert.deepEqual(result.contract.visuals, sourceContract.visuals); assert.deepEqual(result.contract.evidenceContract, sourceContract.evidenceContract); assert.equal(result.artifact.metadata.lightRevision.exposureGateChanged, false);
  const changed = new Set(["authoritative-parameters", "light-exposure"]), old = new Map(sourceArtifact.facets.map((facet) => [facet.scope, facet.hash]));
  for (const facet of result.artifact.facets) changed.has(facet.scope) ? assert.notEqual(facet.hash, old.get(facet.scope)) : assert.equal(facet.hash, old.get(facet.scope));
});
