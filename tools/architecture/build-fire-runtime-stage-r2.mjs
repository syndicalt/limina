import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { canonicalStringify } from "../../js/src/authoring/canonical.ts";
import { validateBuildingFireRuntimeV1 } from "../../js/src/assets/building-fire-runtime-v1.mjs";
import { buildingFireRuntimeV2Hash, validateBuildingFireRuntimeV2 } from "../../js/src/assets/building-fire-runtime-v2.mjs";
import { BUILDING_STAGE_FACETS, validateBuildingStageArtifact } from "../../js/src/assets/staged-building-pipeline.mjs";

export const FIRE_RUNTIME_R2_DEFAULTS = Object.freeze({
  sourceContract: "assets/buildings/authoring/functional-hall-house-v4/fire-r1/fire-runtime-contract.json",
  sourceArtifact: "assets/buildings/authoring/functional-hall-house-v4/fire-r1/fire-runtime-artifact-draft.json",
  contractOutput: "assets/buildings/authoring/functional-hall-house-v4/fire-r2/fire-runtime-contract.json",
  artifactOutput: "assets/buildings/authoring/functional-hall-house-v4/fire-r2/fire-runtime-artifact-draft.json",
});

const sha = (bytes) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const canonicalHash = (value) => sha(Buffer.from(canonicalStringify(value)));
const bytes = (value) => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
const portable = (root, path) => { const value = relative(root, path).split(sep).join("/"); if (!value || value === ".." || value.startsWith("../")) throw new Error(`fire r2 path escapes repository: ${path}`); return value; };

function volumetricContract(source) {
  return validateBuildingFireRuntimeV2({
    ...source,
    schema: "limina.building-fire-runtime/v2",
    packageId: "fire/functional-hall-house-v4/v2",
    revision: 2,
    materialRoles: ["flame-volume", "hearth-embers", "hearth-soot"],
    visuals: {
      flameVolume: {
        id: "flame/volume-main", socketId: "socket/fire/flame",
        representation: "three-fire-derived-volume-raymarch/v1", geometry: "volumetric-raymarch-box", materialRole: "flame-volume",
        technique: { upstream: "typeWolffo/THREE.Fire", version: "1.4.0", license: "MIT", adaptation: "deterministic-limina-tsl/v1" },
        centerOffsetM: [0, .38, 0], halfExtentsM: [.26, .42, .22],
        iterations: 24, noiseOctaves: 4, noiseScale: [1, 2.1, 1, .35], magnitude: 1.25, lacunarity: 2, gain: .5,
        densityTextureResolution: [128, 192], densityProfile: "analytic-radial-height/v1",
        timeAuthority: "explicit-runtime-tick-uniform", seedAuthority: "simulation-seed", depthTest: true, depthWrite: false,
      },
      embers: source.visuals.embers,
      smoke: source.visuals.smoke,
    },
    budgets: {
      maxDrawCalls: 4, maxTriangles: 2048, maxParticles: source.budgets.maxParticles,
      maxCpuUpdateMsP95: source.budgets.maxCpuUpdateMsP95, maxOwnedLights: 1, maxOwnedMaterials: 3,
      timestampQueriesEnabled: false, maxVolumeDrawCalls: 1, maxVolumeProxyTriangles: 12,
      maxRaymarchSteps: 24, maxNoiseOctaves: 4, maxVolumeTextures: 1,
      maxVolumeTextureBytes: 128 * 192 * 4, maxFragmentNoiseSamplesPerCoveredPixel: 96,
    },
  });
}

export async function buildFireRuntimeStageR2({ repoRoot = resolve(import.meta.dirname, "../.."), paths = {}, write = true } = {}) {
  const root = resolve(repoRoot), selected = { ...FIRE_RUNTIME_R2_DEFAULTS, ...paths };
  const [sourceContractBytes, sourceArtifactBytes] = await Promise.all([readFile(resolve(root, selected.sourceContract)), readFile(resolve(root, selected.sourceArtifact))]);
  const sourceContract = validateBuildingFireRuntimeV1(JSON.parse(sourceContractBytes)), sourceArtifact = validateBuildingStageArtifact(JSON.parse(sourceArtifactBytes));
  if (sourceArtifact.artifactId !== "fire/functional-hall-house-v4/r1" || sourceArtifact.kind !== "fire-runtime" || sourceArtifact.revision !== 1 || sourceArtifact.status !== "draft" || sourceArtifact.contentHash !== sha(sourceContractBytes)) throw new Error("fire r2 must supersede the exact draft r1 contract closure");
  for (const asset of [sourceContract.fuelAsset.sourceBlend, sourceContract.fuelAsset.runtimeGlb]) {
    const assetBytes = await readFile(resolve(root, asset.path)); if (sha(assetBytes) !== asset.sha256) throw new Error(`fire r2 fuel authority drifted: ${asset.path}`);
  }
  const contract = volumetricContract(sourceContract), contractHash = buildingFireRuntimeV2Hash(contract), contractBytes = bytes(contract), contentHash = sha(contractBytes);
  const oldFacets = new Map(sourceArtifact.facets.map((facet) => [facet.scope, facet]));
  const changed = {
    "runtime-visuals": { materialRoles: contract.materialRoles, fuelAsset: contract.fuelAsset, visuals: contract.visuals },
    "performance-lifecycle": { lifecycle: contract.lifecycle, budgets: contract.budgets },
  };
  const facets = BUILDING_STAGE_FACETS["fire-runtime"].map((scope) => {
    if (scope in changed) return Object.freeze({ scope, hash: canonicalHash({ schema: "limina.fire-runtime-facet/v2", scope, payload: changed[scope] }) });
    const inherited = oldFacets.get(scope); if (!inherited) throw new Error(`fire r1 lacks inherited facet ${scope}`); return Object.freeze({ ...inherited });
  });
  const contractOutput = resolve(root, selected.contractOutput), artifactOutput = resolve(root, selected.artifactOutput);
  const artifact = validateBuildingStageArtifact({
    schema: "limina.building-stage-artifact/v1", artifactId: "fire/functional-hall-house-v4/r2", kind: "fire-runtime", revision: 2,
    status: "draft", contractHash, contentHash, facets, inputs: sourceArtifact.inputs, evidence: [],
    metadata: {
      gate: "V1-vfx", humanDecision: "not-reviewed", supersedes: { artifactId: sourceArtifact.artifactId, contractHash: sourceArtifact.contractHash, contentHash: sourceArtifact.contentHash },
      contract: { path: portable(root, contractOutput), sha256: contentHash, canonicalHash: contractHash },
      hearthFuel: sourceArtifact.metadata.hearthFuel, smoke: sourceArtifact.metadata.smoke,
      runtimeAuthority: { snapshotSchema: contract.simulation.snapshot.schema, tickHz: contract.simulation.tickHz, timestampQueriesEnabled: false },
      technique: { ...contract.visuals.flameVolume.technique, directPackageDependency: false, reason: "preserve-pinned-three-module-identity-and-authoritative-time-seed" },
      fragmentBudget: { iterations: contract.visuals.flameVolume.iterations, noiseOctaves: contract.visuals.flameVolume.noiseOctaves, maximumNoiseSamplesPerCoveredPixel: contract.budgets.maxFragmentNoiseSamplesPerCoveredPixel },
      cpuOnlyBuild: true,
    },
  });
  const artifactBytes = bytes(artifact);
  if (write) {
    for (const output of [contractOutput, artifactOutput]) try { await readFile(output); throw new Error(`append-only fire r2 output already exists: ${portable(root, output)}`); } catch (error) { if (error?.code !== "ENOENT") throw error; }
    await Promise.all([mkdir(dirname(contractOutput), { recursive: true, mode: 0o700 }), mkdir(dirname(artifactOutput), { recursive: true, mode: 0o700 })]);
    await writeFile(contractOutput, contractBytes, { flag: "wx", mode: 0o600 }); await writeFile(artifactOutput, artifactBytes, { flag: "wx", mode: 0o600 });
  }
  return Object.freeze({ contract, contractHash, contractBytes, artifact, artifactBytes });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const result = await buildFireRuntimeStageR2(); console.log(JSON.stringify({ artifactId: result.artifact.artifactId, contractHash: result.contractHash, representation: result.contract.visuals.flameVolume.representation }, null, 2));
}
