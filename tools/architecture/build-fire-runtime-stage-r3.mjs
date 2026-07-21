import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { canonicalStringify } from "../../js/src/authoring/canonical.ts";
import { buildingFireRuntimeV2Hash, validateBuildingFireRuntimeV2 } from "../../js/src/assets/building-fire-runtime-v2.mjs";
import { BUILDING_STAGE_FACETS, validateBuildingStageArtifact } from "../../js/src/assets/staged-building-pipeline.mjs";

export const FIRE_RUNTIME_R3_DEFAULTS = Object.freeze({
  sourceContract: "assets/buildings/authoring/functional-hall-house-v4/fire-r2/fire-runtime-contract.json",
  sourceArtifact: "assets/buildings/authoring/functional-hall-house-v4/fire-r2/fire-runtime-artifact-draft.json",
  contractOutput: "assets/buildings/authoring/functional-hall-house-v4/fire-r3/fire-runtime-contract.json",
  artifactOutput: "assets/buildings/authoring/functional-hall-house-v4/fire-r3/fire-runtime-artifact-draft.json",
});

const sha = (value) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
const canonicalHash = (value) => sha(Buffer.from(canonicalStringify(value)));
const bytes = (value) => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
const portable = (root, path) => { const value = relative(root, path).split(sep).join("/"); if (!value || value === ".." || value.startsWith("../")) throw new Error(`fire r3 path escapes repository: ${path}`); return value; };

function exposureCorrectedContract(source) {
  const baseCandela = 2.8, flickerAmplitudeCandela = .16;
  return validateBuildingFireRuntimeV2({
    ...source,
    packageId: "fire/functional-hall-house-v4/v3",
    revision: 3,
    light: { ...source.light, baseCandela, flickerAmplitudeCandela },
    simulation: {
      ...source.simulation,
      parameters: { ...source.simulation.parameters, lightBaseCandela: baseCandela, lightFlickerCandela: flickerAmplitudeCandela },
    },
  });
}

export async function buildFireRuntimeStageR3({ repoRoot = resolve(import.meta.dirname, "../.."), paths = {}, write = true } = {}) {
  const root = resolve(repoRoot), selected = { ...FIRE_RUNTIME_R3_DEFAULTS, ...paths };
  const [sourceContractBytes, sourceArtifactBytes] = await Promise.all([readFile(resolve(root, selected.sourceContract)), readFile(resolve(root, selected.sourceArtifact))]);
  const sourceContract = validateBuildingFireRuntimeV2(JSON.parse(sourceContractBytes)), sourceArtifact = validateBuildingStageArtifact(JSON.parse(sourceArtifactBytes));
  if (sourceContract.revision !== 2 || sourceArtifact.artifactId !== "fire/functional-hall-house-v4/r2" || sourceArtifact.kind !== "fire-runtime" || sourceArtifact.revision !== 2 || sourceArtifact.status !== "draft" || sourceArtifact.contractHash !== buildingFireRuntimeV2Hash(sourceContract) || sourceArtifact.contentHash !== sha(sourceContractBytes)) throw new Error("fire r3 must supersede the exact draft r2 contract closure");
  const contract = exposureCorrectedContract(sourceContract), contractHash = buildingFireRuntimeV2Hash(contract), contractBytes = bytes(contract), contentHash = sha(contractBytes);
  const oldFacets = new Map(sourceArtifact.facets.map((facet) => [facet.scope, facet]));
  const changed = {
    "authoritative-parameters": { light: contract.light, tickHz: contract.simulation.tickHz, seed: contract.simulation.seed, parameters: contract.simulation.parameters, snapshot: contract.simulation.snapshot },
    "light-exposure": { light: contract.light, exposure: contract.evidenceContract.exposure },
  };
  const facets = BUILDING_STAGE_FACETS["fire-runtime"].map((scope) => {
    if (scope in changed) return Object.freeze({ scope, hash: canonicalHash({ schema: "limina.fire-runtime-facet/v3", scope, payload: changed[scope] }) });
    const inherited = oldFacets.get(scope); if (!inherited) throw new Error(`fire r2 lacks inherited facet ${scope}`); return Object.freeze({ ...inherited });
  });
  const contractOutput = resolve(root, selected.contractOutput), artifactOutput = resolve(root, selected.artifactOutput);
  const artifact = validateBuildingStageArtifact({
    schema: "limina.building-stage-artifact/v1", artifactId: "fire/functional-hall-house-v4/r3", kind: "fire-runtime", revision: 3,
    status: "draft", contractHash, contentHash, facets, inputs: sourceArtifact.inputs, evidence: [],
    metadata: {
      ...sourceArtifact.metadata,
      humanDecision: "not-reviewed",
      supersedes: { artifactId: sourceArtifact.artifactId, contractHash: sourceArtifact.contractHash, contentHash: sourceArtifact.contentHash },
      contract: { path: portable(root, contractOutput), sha256: contentHash, canonicalHash: contractHash },
      runtimeAuthority: { ...sourceArtifact.metadata.runtimeAuthority, timestampQueriesEnabled: false },
      lightRevision: { reason: "full-burn-channel-clipping-isolated-to-contract-owned-point-light", previousBaseCandela: sourceContract.light.baseCandela, baseCandela: contract.light.baseCandela, previousFlickerAmplitudeCandela: sourceContract.light.flickerAmplitudeCandela, flickerAmplitudeCandela: contract.light.flickerAmplitudeCandela, exposureGateChanged: false },
      cpuOnlyBuild: true,
    },
  });
  const artifactBytes = bytes(artifact);
  if (write) {
    for (const output of [contractOutput, artifactOutput]) try { await readFile(output); throw new Error(`append-only fire r3 output already exists: ${portable(root, output)}`); } catch (error) { if (error?.code !== "ENOENT") throw error; }
    await Promise.all([mkdir(dirname(contractOutput), { recursive: true, mode: 0o700 }), mkdir(dirname(artifactOutput), { recursive: true, mode: 0o700 })]);
    await writeFile(contractOutput, contractBytes, { flag: "wx", mode: 0o600 }); await writeFile(artifactOutput, artifactBytes, { flag: "wx", mode: 0o600 });
  }
  return Object.freeze({ contract, contractHash, contractBytes, artifact, artifactBytes });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const result = await buildFireRuntimeStageR3(); console.log(JSON.stringify({ artifactId: result.artifact.artifactId, contractHash: result.contractHash, light: result.contract.light }, null, 2));
}
