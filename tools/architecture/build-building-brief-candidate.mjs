import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { canonicalStringify } from "../../js/src/authoring/canonical.ts";
import { validateVisualDesignContract, visualDesignContractHash } from "../../js/src/architecture/visual-design-contract.ts";
import { validateBuildingStageArtifact } from "../../js/src/assets/staged-building-pipeline.mjs";

const DEFAULT_ROOT = resolve(import.meta.dirname, "../..");
export const BUILDING_BRIEF_VISUAL_PATH = "art-direction/functional-hall-house-v4-visual-design.json";
export const BUILDING_BRIEF_ITERATION_PATH = "art-direction/functional-cottage-v4-iteration.json";
export const BUILDING_BRIEF_ARCHITECTURE_PATH = "assets/buildings/functional-hall-house-architecture-v5.json";
export const BUILDING_BRIEF_CONCEPT_PATH = "art-direction/references/functional-cottage-v4-concept-sheet.png";
export const USER_PG40_SOURCE_URL = "https://stratics.com/wp-content/uploads/2014/05/PG40.jpg";
const CONCEPT_SHA256 = "sha256:b5d38c8e675f36fd3562f5320529f112cbee44b0bee9cd5bb976ee8918e8c7f4";
const sha = (bytes) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const canonicalHash = (value) => sha(Buffer.from(canonicalStringify(value)));
const decode = (bytes, label) => {
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch (error) { throw new Error(`${label} is not valid UTF-8 JSON`, { cause: error }); }
};
const portable = (root, path) => {
  const value = relative(root, path).split(sep).join("/");
  if (!value || value === ".." || value.startsWith("../") || isAbsolute(value)) throw new Error(`B0 path escapes repository: ${path}`);
  return value;
};
const exact = (left, right) => JSON.stringify(left) === JSON.stringify(right);

function requireArchitectureV5(architecture) {
  if (architecture?.schema !== "limina.architecture-spec/v1" || architecture.id !== "hall-house/temperate/architecture-v5") throw new Error("B0 requires exact architecture-v5 identity");
  const [hall, service] = architecture.volumes ?? [], mainRoof = architecture.roofSystems?.[0], door = architecture.doors?.[0], entrance = architecture.entrances?.[0], lod = architecture.functional?.lod;
  if (!exact(hall?.footprint, [[-4.8,-3.42],[4.8,-3.42],[4.8,3.42],[-4.8,3.42]]) || hall.eaveY !== 3.55
    || !exact(service?.footprint, [[1.1,-5.02],[4.14,-5.02],[4.14,-3.42],[1.1,-3.42]]) || service.eaveY !== 3.7
    || mainRoof?.pitchDegrees !== 44.5 || door?.openYawDegrees !== -95 || entrance?.stepCount !== 2
    || architecture.functional?.clearAisle?.halfWidth !== .5 || architecture.functional.clearAisle.minClearHeight !== 2.2
    || !exact(lod, { identity: "hall-house/temperate/v4", triangleBudget: 90000, drawBudget: 640, lod1TriangleBudget: 32000, lod2TriangleBudget: 8000 })) throw new Error("B0 architecture dimensions, interaction, or production budgets drifted");
  return architecture;
}

function requireIteration(iteration) {
  if (iteration?.schema !== "limina.functional-building-iteration/v1" || iteration.iterationId !== "functional-cottage/v4"
    || iteration.subject !== "Project Gorgon-quality Blender-authored functional cottage"
    || !iteration.referenceCues?.some(({ id }) => id === "gorgon-built-environment-floor")
    || !iteration.referenceCues?.some(({ id }) => id === "functional-cottage-v4-concept-sheet")) throw new Error("B0 legacy iteration provenance drifted");
  return iteration;
}

/** Strict CPU-only assembly. It records no human decision and invokes no renderer. */
export async function buildBuildingBriefCandidate({
  repoRoot = DEFAULT_ROOT,
  visualPath = BUILDING_BRIEF_VISUAL_PATH,
  iterationPath = BUILDING_BRIEF_ITERATION_PATH,
  architecturePath = BUILDING_BRIEF_ARCHITECTURE_PATH,
  conceptPath = BUILDING_BRIEF_CONCEPT_PATH,
  outputPath,
  write = true,
} = {}) {
  if (!outputPath) throw new Error("outputPath is required");
  const root = resolve(repoRoot), paths = [visualPath, iterationPath, architecturePath, conceptPath].map((path) => resolve(root, path));
  if (!exact(paths.map((path) => portable(root, path)), [BUILDING_BRIEF_VISUAL_PATH, BUILDING_BRIEF_ITERATION_PATH, BUILDING_BRIEF_ARCHITECTURE_PATH, BUILDING_BRIEF_CONCEPT_PATH])) throw new Error("B0 requires the exact formal brief source paths");
  const [visualBytes, iterationBytes, architectureBytes, conceptBytes] = await Promise.all(paths.map((path) => readFile(path)));
  const visual = validateVisualDesignContract(decode(visualBytes, "B0 visual contract"));
  if (visual.id !== "building/functional-hall-house-v4" || visual.subjectKind !== "building" || visual.status !== "candidate") throw new Error("B0 visual contract identity is invalid");
  const iteration = requireIteration(decode(iterationBytes, "B0 iteration")), architecture = requireArchitectureV5(decode(architectureBytes, "B0 architecture"));
  if (sha(conceptBytes) !== CONCEPT_SHA256) throw new Error("B0 generated concept-sheet bytes drifted");
  const referenceEvidence = [];
  for (const source of visual.references) {
    const sourcePath = resolve(root, source.localPath);
    if (portable(root, sourcePath) !== source.localPath) throw new Error(`B0 visual reference path is not canonical: ${source.id}`);
    const bytes = await readFile(sourcePath);
    if (sha(bytes) !== source.sha256) throw new Error(`B0 visual reference bytes drifted: ${source.id}`);
    referenceEvidence.push({ evidenceId: `brief/functional-hall-house-v4/r1/reference/${source.id.replaceAll("/", "-")}`, kind: "private-visual-reference", contentHash: source.sha256 });
  }
  const identities = {
    visual: { path: BUILDING_BRIEF_VISUAL_PATH, sha256: sha(visualBytes), canonicalHash: visualDesignContractHash(visual) },
    iteration: { path: BUILDING_BRIEF_ITERATION_PATH, sha256: sha(iterationBytes) },
    architecture: { path: BUILDING_BRIEF_ARCHITECTURE_PATH, sha256: sha(architectureBytes) },
    concept: { path: BUILDING_BRIEF_CONCEPT_PATH, sha256: sha(conceptBytes), width: 1536, height: 1024 },
  };
  const requirements = { intendedFunction: visual.intendedFunction, prompt: visual.prompt, avoid: visual.avoid, requiredViews: visual.requiredViews, architectureSha256: identities.architecture.sha256 };
  const visualCues = { visualContractHash: identities.visual.canonicalHash, references: visual.references.map(({ id, sha256 }) => ({ id, sha256 })), cues: visual.cues, conceptSha256: identities.concept.sha256, userSuppliedPg40Url: USER_PG40_SOURCE_URL };
  const performance = { ...architecture.functional.lod, timestampQueriesEnabled: false, evidenceClass: "production-engine", requiredLodCount: 3 };
  const bundle = { schema: "limina.building-brief-bundle/v1", identities, requirements, visualCues, performance };
  const candidate = validateBuildingStageArtifact({
    schema: "limina.building-stage-artifact/v1",
    artifactId: "brief/functional-hall-house-v4/r1",
    kind: "brief",
    revision: 1,
    status: "candidate",
    contractHash: canonicalHash({ schema: bundle.schema, visualContractHash: identities.visual.canonicalHash, architectureSha256: identities.architecture.sha256, iterationSha256: identities.iteration.sha256 }),
    contentHash: canonicalHash(bundle),
    facets: [
      { scope: "requirements", hash: canonicalHash(requirements) },
      { scope: "visual-cues", hash: canonicalHash(visualCues) },
      { scope: "performance-budget", hash: canonicalHash(performance) },
    ],
    inputs: [],
    evidence: [
      { evidenceId: "brief/functional-hall-house-v4/r1/visual-contract", kind: "visual-design-contract-json", contentHash: identities.visual.sha256 },
      ...referenceEvidence,
      { evidenceId: "brief/functional-hall-house-v4/r1/concept-sheet", kind: "modeling-cue-png", contentHash: identities.concept.sha256, width: 1536, height: 1024 },
      { evidenceId: "brief/functional-hall-house-v4/r1/architecture-v5", kind: "architecture-spec-json", contentHash: identities.architecture.sha256 },
      { evidenceId: "brief/functional-hall-house-v4/r1/iteration-history", kind: "iteration-history-json", contentHash: identities.iteration.sha256 },
    ],
    metadata: {
      gate: "B0-brief",
      humanDecision: "pending",
      identities,
      lockedReferenceSetId: "project-gorgon-floor-20260711",
      supplementalUserReference: {
        sourceUrl: USER_PG40_SOURCE_URL,
        role: "user-named-house-fidelity-target",
        byteStatus: "origin-refused-automated-retrieval-http-403",
        pinnedAsEvidence: false,
      },
      conceptRole: "private modeling cue only; not a texture source or production-engine result",
      reviewSummary: {
        dimensionsM: { mainHall: [9.6, 6.84], fullEnvelopeDepth: 8.44, mainEave: 3.55, serviceEave: 3.7 },
        interactions: { doorOpenYawDegrees: -95, entrySteps: 2, clearAisleWidthM: 1, clearAisleHeightM: 2.2 },
        budgets: { lod0Triangles: 90000, lod1Triangles: 32000, lod2Triangles: 8000, draws: 640 },
      },
    },
  });
  const outputAbsolute = resolve(root, outputPath);
  if (write) {
    await mkdir(dirname(outputAbsolute), { recursive: true, mode: 0o700 });
    await writeFile(outputAbsolute, `${JSON.stringify(candidate, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  }
  return Object.freeze({ candidate, visual, iteration, architecture, bundle, outputPath: outputAbsolute });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2), at = (flag) => { const index = args.indexOf(flag); if (index < 0 || !args[index + 1]) throw new Error("usage: bun tools/architecture/build-building-brief-candidate.mjs --out <json>"); return args[index + 1]; };
  const { candidate } = await buildBuildingBriefCandidate({ outputPath: at("--out") });
  console.log(JSON.stringify({ artifactId: candidate.artifactId, status: candidate.status, contractHash: candidate.contractHash, contentHash: candidate.contentHash, evidence: candidate.evidence }, null, 2));
}
