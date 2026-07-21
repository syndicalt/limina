import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import test from "node:test";
import { validateBuildingFireRuntimeV2 } from "../../js/src/assets/building-fire-runtime-v2.mjs";
import { buildFireRuntimeStageR3 } from "./build-fire-runtime-stage-r3.mjs";

const ROOT = resolve(import.meta.dirname, "../..");

test("builds append-only fire r3 with only the authoritative point-light envelope revised", async () => {
  const sourceContract = JSON.parse(await Bun.file(resolve(ROOT, "assets/buildings/authoring/functional-hall-house-v4/fire-r2/fire-runtime-contract.json")).text());
  const sourceArtifact = JSON.parse(await Bun.file(resolve(ROOT, "assets/buildings/authoring/functional-hall-house-v4/fire-r2/fire-runtime-artifact-draft.json")).text());
  const result = await buildFireRuntimeStageR3({ repoRoot: ROOT, write: false });
  assert.equal(result.contract.revision, 3); assert.equal(result.contract.packageId, "fire/functional-hall-house-v4/v3");
  assert.equal(result.contract.light.baseCandela, 2.8); assert.equal(result.contract.light.flickerAmplitudeCandela, .16);
  assert.equal(result.contract.simulation.parameters.lightBaseCandela, 2.8); assert.equal(result.contract.simulation.parameters.lightFlickerCandela, .16);
  assert.deepEqual(result.contract.visuals, sourceContract.visuals); assert.deepEqual(result.contract.evidenceContract, sourceContract.evidenceContract); assert.deepEqual(result.contract.budgets, sourceContract.budgets);
  assert.equal(result.artifact.metadata.lightRevision.exposureGateChanged, false); assert.equal(result.artifact.metadata.supersedes.artifactId, "fire/functional-hall-house-v4/r2");
  const changed = new Set(["authoritative-parameters", "light-exposure"]), old = new Map(sourceArtifact.facets.map((facet) => [facet.scope, facet.hash]));
  for (const facet of result.artifact.facets) changed.has(facet.scope) ? assert.notEqual(facet.hash, old.get(facet.scope)) : assert.equal(facet.hash, old.get(facet.scope));
  validateBuildingFireRuntimeV2(result.contract);
});

test("rejects light/simulation divergence and writes private append-only outputs", async (t) => {
  const { contract } = await buildFireRuntimeStageR3({ repoRoot: ROOT, write: false });
  const drift = structuredClone(contract); drift.simulation.parameters.lightBaseCandela = 3;
  assert.throws(() => validateBuildingFireRuntimeV2(drift), /exactly bind/);
  const directory = await mkdtemp(join(ROOT, ".tmp-fire-r3-")); t.after(() => rm(directory, { recursive: true, force: true }));
  const paths = { contractOutput: relative(ROOT, join(directory, "contract.json")), artifactOutput: relative(ROOT, join(directory, "artifact.json")) };
  await buildFireRuntimeStageR3({ repoRoot: ROOT, paths, write: true });
  await assert.rejects(buildFireRuntimeStageR3({ repoRoot: ROOT, paths, write: true }), /append-only/);
});
