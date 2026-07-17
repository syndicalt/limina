import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import test from "node:test";
import { buildProductionPackageCandidate, verifyProductionPackageCandidate } from "./build-production-package-candidate.mjs";
import { portableAssetContentHash } from "../../js/src/world/asset-content-hash.mjs";

const ROOT = resolve(import.meta.dirname, "../..");
const OLD_KTX = ".limina/c1-ktx2-central-e2e.rWq9IC/c1-production-lod-ktx2.glb";
const FINAL_LOD = ".limina/c1-functional-package-E9QFYQ/c1-production-lod.glb";
const BASE_KTX_MANIFEST = ".limina/c1-ktx2-central-e2e.rWq9IC/c1-production-lod-ktx2.json";
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const portable = (path) => relative(ROOT, path).split(sep).join("/");

function parseGlb(bytes) {
  const jsonLength = bytes.readUInt32LE(12), binStart = 20 + jsonLength;
  return { json: JSON.parse(bytes.subarray(20, binStart).toString().trim()), binary: bytes.subarray(binStart + 8) };
}
function encodeGlb(json, binary) {
  const raw = Buffer.from(JSON.stringify(json)), jsonLength = (raw.length + 3) & ~3, binLength = (binary.length + 3) & ~3;
  const output = Buffer.alloc(12 + 8 + jsonLength + 8 + binLength, 0); output.writeUInt32LE(0x46546c67, 0); output.writeUInt32LE(2, 4); output.writeUInt32LE(output.length, 8);
  output.writeUInt32LE(jsonLength, 12); output.writeUInt32LE(0x4e4f534a, 16); raw.copy(output, 20); output.fill(0x20, 20 + raw.length, 20 + jsonLength);
  const header = 20 + jsonLength; output.writeUInt32LE(binLength, header); output.writeUInt32LE(0x004e4942, header + 4); binary.copy(output, header + 8); return output;
}

async function fixture({ mutateProduction, mutateKtxManifest } = {}) {
  const [finalLod, oldKtx, baseManifestBytes] = await Promise.all([readFile(resolve(ROOT, FINAL_LOD)), readFile(resolve(ROOT, OLD_KTX)), readFile(resolve(ROOT, BASE_KTX_MANIFEST))]);
  const finalJson = parseGlb(finalLod).json, parsedKtx = parseGlb(oldKtx), productionJson = structuredClone(parsedKtx.json);
  productionJson.asset.extras.liminaFunctionalBuilding = structuredClone(finalJson.asset.extras.liminaFunctionalBuilding);
  productionJson.asset.extras.liminaStaticBatch = structuredClone(finalJson.asset.extras.liminaStaticBatch);
  productionJson.scenes[productionJson.scene].nodes = structuredClone(finalJson.scenes[finalJson.scene].nodes);
  const root = finalJson.scenes[finalJson.scene].nodes[0]; productionJson.nodes[root].children = structuredClone(finalJson.nodes[root].children);
  mutateProduction?.(productionJson);
  const production = encodeGlb(productionJson, parsedKtx.binary), paths = { lod: ".limina/production-package-test/final-lod.glb", production: ".limina/production-package-test/final-ktx2.glb", lodManifest: ".limina/production-package-test/lod.json", ktxManifest: ".limina/production-package-test/ktx2.json" };
  const batch = finalJson.asset.extras.liminaStaticBatch;
  const lodManifest = { schema: "limina.composition-production-lod-result/v1", outputPath: paths.lod, sha256: sha(finalLod), bytes: finalLod.length, sourceSha256: batch.sourceSha256, compositionId: batch.sourceCompositionId, doorRoot: batch.doorRoot, lodRoots: batch.lodRoots, measurements: batch.measurements, representationDedupe: batch.representationDedupe, inspection: { method: "independent-embedded-static-batch-inspection", cpuOnly: true, rendered: false, gpuUsed: false } };
  const ktx = JSON.parse(baseManifestBytes); ktx.source = { ...ktx.source, path: paths.lod, sha256: sha(finalLod), bytes: finalLod.length }; ktx.output = { ...ktx.output, path: paths.production, sha256: sha(production), engineHash: portableAssetContentHash(production), bytes: production.length }; mutateKtxManifest?.(ktx, production);
  const resources = new Map([[paths.lod, finalLod], [paths.production, production], [paths.lodManifest, Buffer.from(JSON.stringify(lodManifest))], [paths.ktxManifest, Buffer.from(JSON.stringify(ktx))]]);
  return { paths, resources, lodManifest, ktx, production };
}
const outputs = { manifestOutputPath: ".limina/production-package-test/package.json", evidenceOutputPath: ".limina/production-package-test/evidence.json", candidateOutputPath: ".limina/production-package-test/candidate.json" };

test("CPU package candidate binds exact C1, separate V1, final LOD/KTX2, semantics, budgets, and pending R1", async () => {
  const f = await fixture(), result = await buildProductionPackageCandidate({ repoRoot: ROOT, lodManifestPath: f.paths.lodManifest, ktx2ManifestPath: f.paths.ktxManifest, assemblyOnly: true, ...outputs, write: false, injectedResources: f.resources });
  assert.equal(result.manifest.status, "draft"); assert.equal(result.manifest.humanDecision, "pending"); assert.equal(result.manifest.visualApprovalClaimed, false);
  assert.deepEqual(result.manifest.closure.counts, { semantics: 654, colliders: 123, sockets: 12, instances: 7 });
  assert.deepEqual(Object.fromEntries(Object.entries(result.manifest.closure.inventories).map(([key, value]) => [key, value.count])), { semantics: 654, colliders: 123, sockets: 12, instances: 7 });
  assert.ok(Object.values(result.manifest.closure.inventories).every(({ idsHash }) => /^sha256:[0-9a-f]{64}$/.test(idsHash)));
  assert.deepEqual(result.manifest.closure.lods.map(({ triangles }) => triangles), [9132, 5052, 2748]);
  assert.equal(result.manifest.closure.representation.rasterFallback, false); assert.equal(result.manifest.runtimeFacets.fire.mount, "separate-runtime-facet");
  assert.equal(result.manifest.runtimeFacets.fire.bakedIntoProductionGlb, false); assert.equal(result.manifest.runtimeFacets.fire.proceduralSources.length, 3);
  assert.ok(result.manifest.runtimeFacets.fire.fuel.sourceBlend.path.endsWith(".blend")); assert.ok(result.manifest.runtimeFacets.fire.fuel.runtimeGlb.path.endsWith(".glb"));
  assert.equal(result.candidate.status, "candidate"); assert.equal(result.candidate.metadata.humanDecision, "pending"); assert.equal(result.evidence.gpuUsed, false); assert.equal(result.evidence.rendered, false);

  for (const [path, value] of [[outputs.manifestOutputPath, result.manifest], [outputs.evidenceOutputPath, result.evidence], [outputs.candidateOutputPath, result.candidate]]) f.resources.set(path, Buffer.from(`${JSON.stringify(value, null, 2)}\n`));
  const verified = await verifyProductionPackageCandidate({ repoRoot: ROOT, manifestPath: outputs.manifestOutputPath, evidencePath: outputs.evidenceOutputPath, candidatePath: outputs.candidateOutputPath, injectedResources: f.resources });
  assert.equal(verified.verdict, "pass"); assert.equal(verified.humanDecision, "pending");
});

test("actual immutable 9ba6f653 publication and residual native mount evidence reproduce the final pending candidate", async () => {
  const directory = "assets/buildings/authoring/functional-hall-house-v4/production-r1-candidate-9ba6f653";
  const rebuilt = await buildProductionPackageCandidate({ repoRoot: ROOT, lodManifestPath: `${directory}/lod-manifest.json`, ktx2ManifestPath: `${directory}/ktx2-manifest.json`, mountEvidencePath: "traces/building-production-mount-cpu-9ba6f653aa2e8954-76eb0e9cbd511880-residual-v1.json", manifestOutputPath: `${directory}/package-manifest-mount-verified.json`, evidenceOutputPath: `${directory}/cpu-evidence-mount-verified.json`, candidateOutputPath: `${directory}/package-artifact-candidate-mount-verified.json`, write: false });
  assert.equal(rebuilt.evidence.verdict, "pass"); assert.equal(rebuilt.candidate.metadata.productionMountEvidence.sha256, "sha256:498e869f8e37faf04f05e9e4d334d305d5ea4d70b6383512ac35f10ed926f33c");
  const verified = await verifyProductionPackageCandidate({ repoRoot: ROOT, manifestPath: `${directory}/package-manifest-mount-verified.json`, evidencePath: `${directory}/cpu-evidence-mount-verified.json`, candidatePath: `${directory}/package-artifact-candidate-mount-verified.json` });
  assert.equal(verified.verdict, "pass"); assert.equal(verified.humanDecision, "pending"); assert.equal(verified.contractHash, "sha256:9c28cc3568d84caea0c04594d3c9273ff3b0205315b9e31a629a122c255bfb9f");
});

test("synthetic hybrid remains assembly-only and cannot reuse final evidence", async () => {
  const f = await fixture();
  const preliminary = await buildProductionPackageCandidate({ repoRoot: ROOT, lodManifestPath: f.paths.lodManifest, ktx2ManifestPath: f.paths.ktxManifest, assemblyOnly: true, ...outputs, write: false, injectedResources: f.resources });
  assert.equal(preliminary.evidence.verdict, "mount-pending");
  await assert.rejects(buildProductionPackageCandidate({ repoRoot: ROOT, lodManifestPath: f.paths.lodManifest, ktx2ManifestPath: f.paths.ktxManifest,
    mountEvidencePath: "traces/building-production-mount-cpu-9ba6f653aa2e8954-76eb0e9cbd511880-residual-v1.json", ...outputs, write: false, injectedResources: f.resources }),
  /assembly authority tuple drifted|exact immutable R1 publication/);
});

test("package rejects Basis fallback and budget overflow", async () => {
  const fallback = await fixture({ mutateProduction: (json) => { json.textures[0].source = json.textures[0].extensions.KHR_texture_basisu.source; } });
  await assert.rejects(buildProductionPackageCandidate({ repoRoot: ROOT, lodManifestPath: fallback.paths.lodManifest, ktx2ManifestPath: fallback.paths.ktxManifest, assemblyOnly: true, ...outputs, write: false, injectedResources: fallback.resources }), /Basis\/no-fallback/);
  const budget = await fixture({ mutateKtxManifest: (manifest, production) => { manifest.policy.maxArtifactBytes = production.length - 1; } });
  await assert.rejects(buildProductionPackageCandidate({ repoRoot: ROOT, lodManifestPath: budget.paths.lodManifest, ktx2ManifestPath: budget.paths.ktxManifest, assemblyOnly: true, ...outputs, write: false, injectedResources: budget.resources }), /budget\/policy/);
});

test("package rejects baked V1 fuel and shell functional authority drift", async () => {
  const baked = await fixture({ mutateProduction: (json) => { const node = json.nodes.find((entry) => typeof (entry.extras?.limina?.id ?? entry.extras?.["limina.id"]) === "string"); if (node.extras?.limina?.id) node.extras.limina.id = "fire/hall-hearth/fuel/log/lower-front"; else node.extras["limina.id"] = "fire/hall-hearth/fuel/log/lower-front"; } });
  await assert.rejects(buildProductionPackageCandidate({ repoRoot: ROOT, lodManifestPath: baked.paths.lodManifest, ktx2ManifestPath: baked.paths.ktxManifest, assemblyOnly: true, ...outputs, write: false, injectedResources: baked.resources }), /V1 fuel was baked/);
  const authority = await fixture({ mutateProduction: (json) => { json.asset.extras.liminaFunctionalBuilding.rootNodeId = "building/drift"; } });
  await assert.rejects(buildProductionPackageCandidate({ repoRoot: ROOT, lodManifestPath: authority.paths.lodManifest, ktx2ManifestPath: authority.paths.ktxManifest, assemblyOnly: true, ...outputs, write: false, injectedResources: authority.resources }), /functional authority drifted/);
});

test("writer is append-only and verifier refuses an R1 approval claim", async () => {
  const f = await fixture(), directory = await mkdtemp(resolve(ROOT, "tools/architecture/.production-package-test-"));
  try {
    const out = { manifestOutputPath: portable(resolve(directory, "package.json")), evidenceOutputPath: portable(resolve(directory, "evidence.json")), candidateOutputPath: portable(resolve(directory, "candidate.json")) };
    const result = await buildProductionPackageCandidate({ repoRoot: ROOT, lodManifestPath: f.paths.lodManifest, ktx2ManifestPath: f.paths.ktxManifest, assemblyOnly: true, ...out, injectedResources: f.resources });
    await assert.rejects(buildProductionPackageCandidate({ repoRoot: ROOT, lodManifestPath: f.paths.lodManifest, ktx2ManifestPath: f.paths.ktxManifest, assemblyOnly: true, ...out, injectedResources: f.resources }), /already exists/);
    const claimed = structuredClone(result.manifest); claimed.humanDecision = "approved"; claimed.visualApprovalClaimed = true;
    const injected = new Map(f.resources); injected.set(out.manifestOutputPath, Buffer.from(JSON.stringify(claimed))); injected.set(out.evidenceOutputPath, await readFile(resolve(ROOT, out.evidenceOutputPath))); injected.set(out.candidateOutputPath, await readFile(resolve(ROOT, out.candidateOutputPath)));
    await assert.rejects(verifyProductionPackageCandidate({ repoRoot: ROOT, manifestPath: out.manifestOutputPath, evidencePath: out.evidenceOutputPath, candidatePath: out.candidateOutputPath, injectedResources: injected }), /deterministic pending CPU closure|improperly claims/);
    await symlink("/tmp", resolve(directory, "escape"));
    const escaped = { manifestOutputPath: portable(resolve(directory, "escape/package.json")), evidenceOutputPath: portable(resolve(directory, "escape/evidence.json")), candidateOutputPath: portable(resolve(directory, "escape/candidate.json")) };
    await assert.rejects(buildProductionPackageCandidate({ repoRoot: ROOT, lodManifestPath: f.paths.lodManifest, ktx2ManifestPath: f.paths.ktxManifest, assemblyOnly: true, ...escaped, injectedResources: f.resources }), /output parent is not a regular directory/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
