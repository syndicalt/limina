import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { validateVisualDesignContract } from "../../js/src/architecture/visual-design-contract.ts";
import { BUILDING_STAGE_FACETS, validateBuildingStageArtifact } from "../../js/src/assets/staged-building-pipeline.mjs";
import {
  BUILDING_BRIEF_VISUAL_PATH,
  USER_PG40_SOURCE_URL,
  buildBuildingBriefCandidate,
} from "./build-building-brief-candidate.mjs";

const ROOT = resolve(import.meta.dirname, "../..");

test("B0 candidate binds exact architecture-v5, private Gorgon references, modeling cue, and production budgets", async () => {
  const { candidate, visual, bundle } = await buildBuildingBriefCandidate({ repoRoot: ROOT, outputPath: "unused.json", write: false });
  validateVisualDesignContract(visual); validateBuildingStageArtifact(candidate);
  assert.equal(candidate.artifactId, "brief/functional-hall-house-v4/r1");
  assert.equal(candidate.kind, "brief"); assert.equal(candidate.status, "candidate");
  assert.equal(candidate.metadata.humanDecision, "pending");
  assert.deepEqual(candidate.facets.map(({ scope }) => scope), BUILDING_STAGE_FACETS.brief);
  assert.deepEqual(bundle.performance, {
    identity: "hall-house/temperate/v4", triangleBudget: 90000, drawBudget: 640,
    lod1TriangleBudget: 32000, lod2TriangleBudget: 8000,
    timestampQueriesEnabled: false, evidenceClass: "production-engine", requiredLodCount: 3,
  });
  assert.equal(candidate.evidence.length, 7);
  assert.equal(candidate.evidence.filter(({ kind }) => kind === "private-visual-reference").length, 3);
  assert.deepEqual(candidate.metadata.reviewSummary.dimensionsM, { mainHall: [9.6, 6.84], fullEnvelopeDepth: 8.44, mainEave: 3.55, serviceEave: 3.7 });
  assert.equal(candidate.metadata.supplementalUserReference.sourceUrl, USER_PG40_SOURCE_URL);
  assert.equal(candidate.metadata.supplementalUserReference.pinnedAsEvidence, false);
});

test("B0 visual contract makes construction and functional failures measurable", async () => {
  const visual = validateVisualDesignContract(JSON.parse(await readFile(resolve(ROOT, BUILDING_BRIEF_VISUAL_PATH), "utf8")));
  assert.deepEqual(visual.cues.map(({ id }) => id), [
    "locked-architectural-envelope", "coherent-roof-system", "functional-entry-construction",
    "explicit-load-path-and-bearing", "recessed-aperture-depth", "material-scale-direction-depth",
    "furnished-traversable-hall", "completed-functional-hearth", "stable-production-lods",
  ]);
  assert.ok(visual.avoid.some((value) => value.includes("Minecraft")));
  assert.ok(visual.avoid.some((value) => value.includes("glow-only")));
  assert.deepEqual(visual.requiredViews.slice(-3), ["lod0-18m", "lod1-25m", "lod2-75m"]);
});

test("B0 writer is append-only and never records approval", async () => {
  const directory = await mkdtemp(resolve(ROOT, "tools/architecture/.b0-brief-fixture-"));
  try {
    const outputPath = resolve(directory, "candidate.json");
    const { candidate } = await buildBuildingBriefCandidate({ repoRoot: ROOT, outputPath });
    assert.equal(candidate.status, "candidate"); assert.equal(candidate.metadata.humanDecision, "pending");
    await assert.rejects(buildBuildingBriefCandidate({ repoRoot: ROOT, outputPath }), /EEXIST/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
