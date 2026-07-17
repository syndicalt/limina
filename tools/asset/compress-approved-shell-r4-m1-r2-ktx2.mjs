import { mkdir, readFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { validateBuildingMaterialPalette } from "../../js/src/assets/building-material-palette.mjs";
import { validateBuildingHitlDecision, validateBuildingStageArtifact } from "../../js/src/assets/staged-building-pipeline.mjs";
import {
  APPROVED_A1_R4,
  MATERIAL_PACK_IDS,
  MATERIAL_PALETTE_R2_ARTIFACT_ID,
  MATERIAL_ROLE_IDS,
} from "../architecture/build-material-palette-stage.mjs";
import { compressHallHouse, preflightKtx2Source } from "./compress-hall-house-v4-ktx2.mjs";

export const M1_R2_KTX2_PATHS = Object.freeze({
  shellArtifact: "assets/buildings/authoring/functional-hall-house-v4/shell-r4/shell-artifact-approved.json",
  shellDecision: "assets/buildings/authoring/functional-hall-house-v4/shell-r4/shell-review-decision-approve.json",
  materialLock: "assets/buildings/authoring/functional-hall-house-v4/material-r2/materials.lock.json",
  paletteDirectory: "assets/buildings/authoring/functional-hall-house-v4/material-r2/runtime",
  output: "assets/buildings/authoring/functional-hall-house-v4/material-r2/runtime/shell-m1-production.glb",
  manifest: "assets/buildings/authoring/functional-hall-house-v4/material-r2/runtime/shell-m1-production.ktx2.json",
});

export const M1_R2_KTX2_INVENTORY = Object.freeze({
  images: 18,
  textures: 27,
  materials: 13,
  packs: 6,
  runtimeSlotsPerPack: Object.freeze(["albedo", "normal", "roughness"]),
});

const portable = (repo, path) => relative(repo, path).split(sep).join("/");

function confinedOutput(repo, value, label) {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${label} path is required`);
  const path = resolve(repo, value), directory = resolve(repo, M1_R2_KTX2_PATHS.paletteDirectory), rel = relative(directory, path);
  if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error(`${label} must remain inside the exact M1 r2 runtime directory`);
  return path;
}

export async function buildShellR4M1R2Ktx2Config({
  repoRoot = resolve(import.meta.dirname, "../.."),
  output = M1_R2_KTX2_PATHS.output,
  manifest = M1_R2_KTX2_PATHS.manifest,
} = {}) {
  const repo = resolve(repoRoot);
  const artifactPath = resolve(repo, M1_R2_KTX2_PATHS.shellArtifact);
  const decisionPath = resolve(repo, M1_R2_KTX2_PATHS.shellDecision);
  const lockPath = resolve(repo, M1_R2_KTX2_PATHS.materialLock);
  const [artifactBytes, decisionBytes, lockBytes] = await Promise.all([readFile(artifactPath), readFile(decisionPath), readFile(lockPath)]);
  const artifact = validateBuildingStageArtifact(JSON.parse(artifactBytes));
  const decision = validateBuildingHitlDecision(JSON.parse(decisionBytes));
  if (artifact.kind !== "shell" || artifact.status !== "approved" || artifact.metadata?.gate !== "A1-shell" || artifact.metadata?.humanDecision !== "approved") throw new Error("M1 r2 compression requires the approved A1 r4 shell");
  for (const [key, expected] of Object.entries(APPROVED_A1_R4)) {
    const actual = key.endsWith("FacetHash") ? new Map(artifact.facets.map((facet) => [facet.scope, facet.hash])).get(key === "surfaceMappingFacetHash" ? "surface-mapping" : "material-role-slots") : artifact[key];
    if (actual !== expected) throw new Error(`approved A1 r4 ${key} drifted`);
  }
  if (decision.gate !== "A1-shell" || decision.decision !== "approve" || decision.reviewer !== "user" || decision.blockingFindings.length !== 0) throw new Error("M1 r2 compression requires the unblocked user A1 r4 approval");
  for (const key of ["artifactId", "contractHash", "contentHash"]) if (decision[key] !== artifact[key]) throw new Error(`A1 r4 approval ${key} drifted`);
  const lock = validateBuildingMaterialPalette(JSON.parse(lockBytes), { expectedRoles: MATERIAL_ROLE_IDS, expectedPackIds: MATERIAL_PACK_IDS, inputShell: APPROVED_A1_R4 });
  if (lock.paletteId !== MATERIAL_PALETTE_R2_ARTIFACT_ID || lock.revision !== 2) throw new Error("M1 r2 lock identity drifted");
  const inputPath = resolve(repo, artifact.metadata?.runtimeGlb?.path ?? ""), source = await readFile(inputPath);
  preflightKtx2Source(source, { expectedSourceSha256: APPROVED_A1_R4.contentHash.slice(7), encodingBudget: lock.encodingBudget, expectedInventory: M1_R2_KTX2_INVENTORY });
  const outputPath = confinedOutput(repo, output, "output"), manifestPath = confinedOutput(repo, manifest, "manifest");
  if (outputPath === manifestPath || outputPath === inputPath || manifestPath === inputPath) throw new Error("M1 r2 compression paths must be distinct");
  return Object.freeze({ input: portable(repo, inputPath), output: portable(repo, outputPath), manifest: portable(repo, manifestPath), expectedSourceSha256: APPROVED_A1_R4.contentHash.slice(7), encodingBudget: lock.encodingBudget, expectedInventory: M1_R2_KTX2_INVENTORY });
}

export async function compressShellR4M1R2Ktx2(options = {}) {
  const config = await buildShellR4M1R2Ktx2Config(options);
  await Promise.all([...new Set([dirname(resolve(options.repoRoot ?? resolve(import.meta.dirname, "../.."), config.output)), dirname(resolve(options.repoRoot ?? resolve(import.meta.dirname, "../.."), config.manifest))])].map((directory) => mkdir(directory, { recursive: true, mode: 0o700 })));
  return compressHallHouse(config);
}

if (import.meta.url === `file://${process.argv[1]}`) console.log(JSON.stringify(await compressShellR4M1R2Ktx2(), null, 2));
