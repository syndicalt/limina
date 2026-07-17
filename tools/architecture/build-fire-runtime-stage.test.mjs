import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { canonicalStringify } from "../../js/src/authoring/canonical.ts";
import { validateBuildingFireRuntimeV1 } from "../../js/src/assets/building-fire-runtime-v1.mjs";
import { BUILDING_STAGE_FACETS, validateBuildingStageArtifact } from "../../js/src/assets/staged-building-pipeline.mjs";
import { buildFireRuntimeStage } from "./build-fire-runtime-stage.mjs";

const SOURCE_ROOT = resolve(import.meta.dirname, "../..");
const FIRE_DIR = "assets/buildings/authoring/functional-hall-house-v4/fire-r1";
const ARTIFACTS = Object.freeze([
  "assets/buildings/authoring/functional-hall-house-v4/shell-r4/shell-artifact-approved.json",
  "assets/buildings/authoring/functional-hall-house-v4/material-r2/material-palette-artifact-approved.json",
  "assets/buildings/authoring/functional-hall-house-v4/interior-r4/interior-plan-artifact-approved.json",
]);
const sha = (bytes) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const canonicalHash = (value) => sha(Buffer.from(canonicalStringify(value)));

async function copy(root, path) {
  const destination = join(root, path);
  await mkdir(dirname(destination), { recursive: true });
  await copyFile(join(SOURCE_ROOT, path), destination);
}

async function json(root, path) {
  return JSON.parse(await readFile(join(root, path), "utf8"));
}

async function putJson(root, path, value) {
  await mkdir(dirname(join(root, path)), { recursive: true });
  await writeFile(join(root, path), `${JSON.stringify(value, null, 2)}\n`);
}

async function fixtureWorkspace() {
  const root = await mkdtemp(join(tmpdir(), "limina-fire-runtime-stage-"));
  for (const path of ARTIFACTS) {
    await copy(root, path);
    const artifact = await json(root, path);
    await copy(root, artifact.metadata.approval.path);
  }
  const recipePath = `${FIRE_DIR}/hearth-fuel-recipe.json`;
  await copy(root, recipePath);
  const recipe = await json(root, recipePath);
  for (const authority of Object.values(recipe.authority)) await copy(root, authority.path);

  const blendPath = `assets/${recipe.export.blendId}`;
  const glbPath = `assets/${recipe.export.assetId}`;
  const blendBytes = Buffer.from("isolated finalized Blender source fixture\n");
  const glbBytes = Buffer.from("isolated finalized semantic GLB fixture\n");
  await mkdir(dirname(join(root, blendPath)), { recursive: true });
  await writeFile(join(root, blendPath), blendBytes);
  await writeFile(join(root, glbPath), glbBytes);

  const evidencePath = `${FIRE_DIR}/build-evidence.json`;
  const evidence = {
    schema: "limina.hearth-fuel-build-evidence/v1",
    id: recipe.id,
    status: "cpu-authored-unreviewed",
    recipe: { path: recipePath, sha256: sha(await readFile(join(root, recipePath))), canonicalHash: canonicalHash(recipe) },
    authority: recipe.authority,
    sourceBlend: { path: blendPath, sha256: sha(blendBytes), bytes: blendBytes.length },
    asset: { path: glbPath, sha256: sha(glbBytes), bytes: glbBytes.length },
    inventory: {
      parts: recipe.parts.length,
      logs: recipe.parts.filter(({ kind }) => kind === "log").length,
      coalPockets: recipe.parts.filter(({ kind }) => kind === "coal-pocket").length,
      emberBeds: recipe.parts.filter(({ kind }) => kind === "ember-bed").length,
    },
    aggregateBounds: recipe.aggregateBounds,
    glbValidation: { semanticPartIds: recipe.parts.map(({ id }) => id), rootSemanticId: recipe.export.rootSemanticId, cameras: 0, lights: 0 },
    runtimeOwnership: { included: ["fuel-logs", "ember-bed"], excluded: ["flames", "light", "smoke", "soot-heat-treatment"] },
    rendered: false,
    gpuUsed: false,
  };
  await putJson(root, evidencePath, evidence);
  return { root, recipePath, evidencePath };
}

test("builds the strict append-only fire-r1 contract and all six draft facets from exact approved inputs", async (t) => {
  const { root } = await fixtureWorkspace();
  t.after(() => rm(root, { recursive: true, force: true }));
  const result = await buildFireRuntimeStage({ repoRoot: root });
  const contract = validateBuildingFireRuntimeV1(result.contract);
  const artifact = validateBuildingStageArtifact(result.artifact);

  assert.equal(contract.visuals.flameLayers.length, 4);
  assert.deepEqual(contract.visuals.smoke, { enabled: false, flueTraversalClaim: false, absorbBeforeThroat: true });
  assert.equal(contract.shellInterface.sockets.some(({ kind }) => kind === "smoke"), false);
  assert.equal(contract.simulation.authority, "explicit-authoritative-tick");
  assert.equal(contract.simulation.tickHz, 60);
  assert.deepEqual(contract.simulation.parameters, {
    ignitionTicks: 90,
    extinguishTicks: 150,
    lightBaseCandela: contract.light.baseCandela,
    lightFlickerCandela: contract.light.flickerAmplitudeCandela,
    lightDistanceM: contract.light.distanceM,
    lightDecay: contract.light.decay,
  });
  assert.deepEqual(contract.evidenceContract.sampleTicks.map(({ phase }) => phase), ["off", "igniting", "burning", "burning", "burning", "burning", "extinguishing", "off"]);
  assert.deepEqual(artifact.facets.map(({ scope }) => scope), BUILDING_STAGE_FACETS["fire-runtime"]);
  assert.equal(artifact.status, "draft");
  assert.equal(artifact.metadata.cpuOnlyBuild, true);
  assert.equal(artifact.metadata.runtimeAuthority.timestampQueriesEnabled, false);
  assert.deepEqual(JSON.parse(await readFile(join(root, `${FIRE_DIR}/fire-runtime-contract.json`), "utf8")), contract);
  assert.deepEqual(JSON.parse(await readFile(join(root, `${FIRE_DIR}/fire-runtime-artifact-draft.json`), "utf8")), artifact);
  await assert.rejects(buildFireRuntimeStage({ repoRoot: root }), /append-only fire runtime stage output already exists/);
});

test("fails closed on approval bytes, recipe authority, GPU attestation, and ownership drift", async (t) => {
  const { root, recipePath, evidencePath } = await fixtureWorkspace();
  t.after(() => rm(root, { recursive: true, force: true }));

  const shellArtifact = await json(root, ARTIFACTS[0]);
  const decisionPath = shellArtifact.metadata.approval.path;
  const decisionBytes = await readFile(join(root, decisionPath));
  const decision = JSON.parse(decisionBytes);
  decision.timestamp = "2099-01-01T00:00:00.000Z";
  await putJson(root, decisionPath, decision);
  await assert.rejects(buildFireRuntimeStage({ repoRoot: root, write: false }), /approval bytes or complete evidence set drifted/);
  await writeFile(join(root, decisionPath), decisionBytes);

  const recipeBytes = await readFile(join(root, recipePath));
  const recipe = JSON.parse(recipeBytes);
  recipe.authority.shell.sha256 = sha("stale shell");
  await putJson(root, recipePath, recipe);
  await assert.rejects(buildFireRuntimeStage({ repoRoot: root, write: false }), /authority shell bytes drifted/);
  await writeFile(join(root, recipePath), recipeBytes);

  const evidence = await json(root, evidencePath);
  evidence.gpuUsed = true;
  await putJson(root, evidencePath, evidence);
  await assert.rejects(buildFireRuntimeStage({ repoRoot: root, write: false }), /CPU-only attestation drifted/);

  evidence.gpuUsed = false;
  evidence.runtimeOwnership.included.push("smoke");
  await putJson(root, evidencePath, evidence);
  await assert.rejects(buildFireRuntimeStage({ repoRoot: root, write: false }), /ownership boundary drifted/);
});
