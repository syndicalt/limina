import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import test from "node:test";
import { validateBuildingFireRuntimeV2 } from "../../js/src/assets/building-fire-runtime-v2.mjs";
import { buildFireRuntimeStageR2 } from "./build-fire-runtime-stage-r2.mjs";

const ROOT = resolve(import.meta.dirname, "../..");

test("builds append-only fire r2 with deterministic THREE.Fire-derived volume and scoped invalidation", async () => {
  const result = await buildFireRuntimeStageR2({ repoRoot: ROOT, write: false });
  assert.equal(result.contract.schema, "limina.building-fire-runtime/v2");
  assert.equal(result.contract.visuals.flameVolume.representation, "three-fire-derived-volume-raymarch/v1");
  assert.equal(result.contract.visuals.flameVolume.timeAuthority, "explicit-runtime-tick-uniform");
  assert.equal(result.contract.visuals.flameVolume.seedAuthority, "simulation-seed");
  assert.equal(result.contract.visuals.flameVolume.depthTest, true);
  assert.equal(result.contract.budgets.timestampQueriesEnabled, false);
  assert.equal(result.contract.visuals.flameVolume.iterations * result.contract.visuals.flameVolume.noiseOctaves, 96);
  assert.equal(result.artifact.artifactId, "fire/functional-hall-house-v4/r2");
  assert.equal(result.artifact.metadata.supersedes.artifactId, "fire/functional-hall-house-v4/r1");
  assert.deepEqual(result.artifact.facets.slice(0, 3), JSON.parse(await Bun.file(resolve(ROOT, "assets/buildings/authoring/functional-hall-house-v4/fire-r1/fire-runtime-artifact-draft.json")).text()).facets.slice(0, 3));
});

test("v2 rejects random/wall-clock fields, depth leaks, and underbudgeted fragment work", async () => {
  const { contract } = await buildFireRuntimeStageR2({ repoRoot: ROOT, write: false });
  const mutate = (change, pattern) => { const value = structuredClone(contract); change(value); assert.throws(() => validateBuildingFireRuntimeV2(value), pattern); };
  mutate((value) => value.visuals.flameVolume.randomSeed = true, /unsupported/);
  mutate((value) => value.visuals.flameVolume.timeAuthority = "renderer-clock", /deterministic density, temporal, or depth/);
  mutate((value) => value.visuals.flameVolume.depthTest = false, /deterministic density, temporal, or depth/);
  mutate((value) => value.budgets.maxFragmentNoiseSamplesPerCoveredPixel = 95, /do not cover/);
  mutate((value) => value.visuals.flameVolume.halfExtentsM[0] = .8, /fit inside/);
});

test("writes private append-only r2 outputs", async (t) => {
  const directory = await mkdtemp(join(ROOT, ".tmp-fire-r2-")); t.after(() => rm(directory, { recursive: true, force: true }));
  const contractOutput = relative(ROOT, join(directory, "contract.json")), artifactOutput = relative(ROOT, join(directory, "artifact.json"));
  await buildFireRuntimeStageR2({ repoRoot: ROOT, paths: { contractOutput, artifactOutput }, write: true });
  await assert.rejects(buildFireRuntimeStageR2({ repoRoot: ROOT, paths: { contractOutput, artifactOutput }, write: true }), /append-only/);
  await writeFile(join(directory, "marker"), "untouched");
});
