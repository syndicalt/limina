import { readFile, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdir } from "node:fs/promises";
import { parseFunctionalFurnitureContract } from "../../js/src/assets/furniture-functional-contract.ts";
import { loadApprovedFunctionalSettlementRelease } from "../../js/src/assets/functional-settlement-release.mjs";
import {
  FUNCTIONAL_SETTLEMENT_FURNISHING_SCHEMA,
  FUNCTIONAL_SETTLEMENT_FURNISHING_VISUAL_MODE,
  deriveFunctionalSettlementFurnishingVariantId,
  functionalSettlementFurnishingClosureHash,
  loadApprovedFunctionalSettlementFurnishingAuthority,
} from "../../js/src/assets/functional-settlement-furnishing.mjs";
import { sha256 } from "../../js/src/world/sha256.mjs";

const raw = (value: Uint8Array): string => `sha256:${sha256(value)}`;
const decode = (value: Uint8Array, label: string): any => { try { return JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(value)); } catch { throw new Error(`${label} is not valid UTF-8 JSON`); } };
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const safePath = (value: unknown, label: string): string => {
  if (typeof value !== "string" || !/^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[a-zA-Z0-9][a-zA-Z0-9._/-]{0,511}$/.test(value)) throw new Error(`${label} must be a safe workspace-relative path`);
  const absolute = resolve(ROOT, value); if (absolute !== ROOT && !absolute.startsWith(`${ROOT}/`)) throw new Error(`${label} escapes the workspace`); return value;
};
const exactKeys = (value: any, expected: string[], label: string): void => {
  if (value === null || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype || JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...expected].sort())) throw new Error(`${label} shape drifted`);
};

export async function buildFunctionalSettlementFurnishingAuthority(recipePath: string): Promise<any> {
  recipePath = safePath(recipePath, "recipe path");
  const read = (path: string): Uint8Array => new Uint8Array(readFileSync(resolve(ROOT, safePath(path, "authority input path"))));
  const recipeBytes = new Uint8Array(await readFile(resolve(ROOT, recipePath))), recipe = decode(recipeBytes, "furnishing recipe");
  exactKeys(recipe, ["schema", "authorityId", "revision", "releasePath", "library", "sockets", "variants", "assignmentSeed", "limits"], "furnishing recipe");
  if (recipe.schema !== "limina.functional-settlement-furnishing-recipe/v1") throw new Error("unsupported furnishing recipe schema");
  if (!Number.isSafeInteger(recipe.revision) || recipe.revision < 1 || !Array.isArray(recipe.library) || recipe.library.length < 1 || recipe.library.length > 64 || !Array.isArray(recipe.sockets) || recipe.sockets.length < 1 || recipe.sockets.length > 128 || !Array.isArray(recipe.variants) || recipe.variants.length < 2 || recipe.variants.length > 32) throw new Error("furnishing recipe bounds are invalid");
  recipe.releasePath = safePath(recipe.releasePath, "releasePath");
  for (const [index, source] of recipe.library.entries()) {
    exactKeys(source, ["libraryId", "assetPath", "approvalArtifactPath", "approvalDecisionPath"], `library[${index}]`);
    source.assetPath = safePath(source.assetPath, `library[${index}].assetPath`); source.approvalArtifactPath = safePath(source.approvalArtifactPath, `library[${index}].approvalArtifactPath`); source.approvalDecisionPath = safePath(source.approvalDecisionPath, `library[${index}].approvalDecisionPath`);
  }
  const releaseBytes = read(recipe.releasePath), release = loadApprovedFunctionalSettlementRelease(releaseBytes, read);
  const entry = release.publication.catalog.entries[0];
  const library = recipe.library.map((source: any) => {
    const assetBytes = read(source.assetPath), contract = parseFunctionalFurnitureContract(assetBytes), artifactBytes = read(source.approvalArtifactPath), decisionBytes = read(source.approvalDecisionPath);
    const artifact = decode(artifactBytes, `${source.libraryId} artifact`), decision = decode(decisionBytes, `${source.libraryId} decision`);
    if (artifact.artifactId !== source.libraryId || decision.artifactId !== source.libraryId) throw new Error(`library identity drifted: ${source.libraryId}`);
    return {
      libraryId: source.libraryId, role: contract.role, furnitureId: contract.furnitureId, contractHash: contract.contractHash,
      asset: { path: source.assetPath, sha256: raw(assetBytes), bytes: assetBytes.byteLength },
      approvalArtifact: { path: source.approvalArtifactPath, sha256: raw(artifactBytes) },
      approvalDecision: { path: source.approvalDecisionPath, sha256: raw(decisionBytes) },
    };
  });
  const variantIds = recipe.variants.map((variant: any) => variant.variantId);
  const placements = [...release.plan.placements].sort((a: any, b: any) => a.placementId.localeCompare(b.placementId)).map((placement: any) => ({
    placementId: placement.placementId,
    variantId: deriveFunctionalSettlementFurnishingVariantId(recipe.assignmentSeed, placement.placementId, variantIds),
  }));
  const authority: any = {
    schema: FUNCTIONAL_SETTLEMENT_FURNISHING_SCHEMA, authorityId: recipe.authorityId, revision: recipe.revision,
    release: { path: recipe.releasePath, sha256: raw(releaseBytes), releaseId: release.release.releaseId, settlementId: release.release.settlementId, closureHash: release.release.closureHash },
    building: { catalogEntryId: entry.entryId, contractHash: entry.functionalContract.hash, semanticFingerprint: entry.semanticIdentity.fingerprint },
    visualPolicy: { mode: FUNCTIONAL_SETTLEMENT_FURNISHING_VISUAL_MODE, activation: "dormant-authoring-sidecar", runtimeVisual: false, runtimeCollision: false, approvedBuildingAssetUnchanged: true, visualPromotionRequiresFreshEngineHitl: true },
    library, sockets: recipe.sockets, variants: recipe.variants,
    assignment: { algorithm: "sha256-canonical-modulo-v1", seed: recipe.assignmentSeed, placements }, limits: recipe.limits,
    closureHash: "sha256:" + "0".repeat(64),
  };
  authority.closureHash = functionalSettlementFurnishingClosureHash(authority);
  const output = new TextEncoder().encode(JSON.stringify(authority, null, 2) + "\n");
  loadApprovedFunctionalSettlementFurnishingAuthority(output, release, read);
  return authority;
}

if (import.meta.main) {
  const args = process.argv.slice(2), value = (name: string): string => { const index = args.indexOf(name); if (index < 0 || !args[index + 1]) throw new Error(`missing ${name}`); return args[index + 1]!; };
  const recipe = value("--recipe"), out = safePath(value("--out"), "output path");
  if (!out.startsWith("assets/settlements/")) throw new Error("output must remain beneath assets/settlements");
  const authority = await buildFunctionalSettlementFurnishingAuthority(recipe);
  await mkdir(dirname(resolve(ROOT, out)), { recursive: true });
  await writeFile(resolve(ROOT, out), JSON.stringify(authority, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  console.log(JSON.stringify({ authorityId: authority.authorityId, closureHash: authority.closureHash, output: out }, null, 2));
}
