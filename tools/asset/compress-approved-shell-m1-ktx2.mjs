import { mkdir, readFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { validateBuildingMaterialPalette } from "../../js/src/assets/building-material-palette.mjs";
import { validateBuildingHitlDecision, validateBuildingStageArtifact } from "../../js/src/assets/staged-building-pipeline.mjs";
import { APPROVED_A1, MATERIAL_PACK_IDS, MATERIAL_ROLE_IDS } from "../architecture/build-material-palette-stage.mjs";
import { compressHallHouse, preflightKtx2Source } from "./compress-hall-house-v4-ktx2.mjs";

export const APPROVED_M1_KTX2_PATHS = Object.freeze({
  shellArtifact: "assets/buildings/authoring/functional-hall-house-v4/shell-artifact-approved.json",
  shellDecision: "assets/buildings/authoring/functional-hall-house-v4/shell-review-decision-approve.json",
  materialLock: "assets/buildings/authoring/functional-hall-house-v4/materials.lock.json",
  paletteDirectory: "assets/buildings/authoring/functional-hall-house-v4/material-palette",
  output: "assets/buildings/authoring/functional-hall-house-v4/material-palette/shell-m1-production.glb",
  manifest: "assets/buildings/authoring/functional-hall-house-v4/material-palette/shell-m1-production.ktx2.json",
});
export const APPROVED_M1_KTX2_INVENTORY = Object.freeze({
  images: 18, textures: 27, materials: 13, packs: 6,
  runtimeSlotsPerPack: Object.freeze(["albedo", "normal", "roughness"]),
});

const portable = (repo, path) => relative(repo, path).split(sep).join("/");
function paletteOutput(repo, value, label) {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${label} path is required`);
  const path = resolve(repo, value), directory = resolve(repo, APPROVED_M1_KTX2_PATHS.paletteDirectory), rel = relative(directory, path);
  if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error(`${label} must remain inside the exact M1 material-palette directory`);
  return path;
}

export async function buildApprovedShellM1Ktx2Config({
  repoRoot = resolve(import.meta.dirname, "../.."),
  output = APPROVED_M1_KTX2_PATHS.output,
  manifest = APPROVED_M1_KTX2_PATHS.manifest,
} = {}) {
  const repo = resolve(repoRoot), artifactPath = resolve(repo, APPROVED_M1_KTX2_PATHS.shellArtifact), decisionPath = resolve(repo, APPROVED_M1_KTX2_PATHS.shellDecision), lockPath = resolve(repo, APPROVED_M1_KTX2_PATHS.materialLock);
  const [artifactBytes, decisionBytes, lockBytes] = await Promise.all([readFile(artifactPath), readFile(decisionPath), readFile(lockPath)]);
  const artifact = validateBuildingStageArtifact(JSON.parse(artifactBytes)), decision = validateBuildingHitlDecision(JSON.parse(decisionBytes));
  if (artifact.kind !== "shell" || artifact.status !== "approved" || artifact.metadata?.gate !== "A1-shell" || artifact.metadata?.humanDecision !== "approved") throw new Error("exact M1 compression requires the human-approved A1 shell");
  if (decision.gate !== "A1-shell" || decision.decision !== "approve" || decision.blockingFindings.length !== 0) throw new Error("exact M1 compression requires the non-blocking A1 approval decision");
  for (const key of ["artifactId", "contractHash", "contentHash"]) if (decision[key] !== artifact[key]) throw new Error(`A1 approval decision ${key} drifted`);
  const lock = validateBuildingMaterialPalette(JSON.parse(lockBytes), { expectedRoles: MATERIAL_ROLE_IDS, expectedPackIds: MATERIAL_PACK_IDS, inputShell: APPROVED_A1 });
  for (const key of ["artifactId", "contractHash", "contentHash"]) if (lock.inputShell[key] !== artifact[key]) throw new Error(`material lock inputShell.${key} drifted from approved A1`);
  const facets = new Map(artifact.facets.map((facet) => [facet.scope, facet.hash]));
  if (lock.inputShell.surfaceMappingFacetHash !== facets.get("surface-mapping") || lock.inputShell.materialRoleSlotsFacetHash !== facets.get("material-role-slots")) throw new Error("material lock shell facets drifted from approved A1");
  const inputPath = resolve(repo, artifact.metadata?.runtimeGlb?.path ?? ""), source = await readFile(inputPath), expectedSourceSha256 = artifact.contentHash.slice("sha256:".length);
  preflightKtx2Source(source, { expectedSourceSha256, encodingBudget: lock.encodingBudget, expectedInventory: APPROVED_M1_KTX2_INVENTORY });
  const outputPath = paletteOutput(repo, output, "output"), manifestPath = paletteOutput(repo, manifest, "manifest");
  if (outputPath === manifestPath || outputPath === inputPath || manifestPath === inputPath) throw new Error("exact M1 compression paths must be distinct");
  return Object.freeze({
    input: portable(repo, inputPath), output: portable(repo, outputPath), manifest: portable(repo, manifestPath),
    expectedSourceSha256, encodingBudget: lock.encodingBudget, expectedInventory: APPROVED_M1_KTX2_INVENTORY,
  });
}

export async function compressApprovedShellM1Ktx2(options = {}) {
  const config = await buildApprovedShellM1Ktx2Config(options);
  await prepareApprovedShellM1Ktx2Outputs(config, { repoRoot: options.repoRoot });
  return compressHallHouse(config);
}

export async function prepareApprovedShellM1Ktx2Outputs(config, { repoRoot = resolve(import.meta.dirname, "../..") } = {}) {
  if (config === null || typeof config !== "object") throw new Error("exact M1 compression config is required");
  const repo = resolve(repoRoot), outputPath = paletteOutput(repo, config.output, "output"), manifestPath = paletteOutput(repo, config.manifest, "manifest");
  await Promise.all([...new Set([dirname(outputPath), dirname(manifestPath)])].map((directory) => mkdir(directory, { recursive: true, mode: 0o700 })));
}

if (import.meta.url === `file://${process.argv[1]}`) console.log(JSON.stringify(await compressApprovedShellM1Ktx2(), null, 2));
