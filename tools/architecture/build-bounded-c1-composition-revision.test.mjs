import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import test from "node:test";
import { BOUNDED_C1_BASE, BOUNDED_C1_EXTRACTION_SCHEMA, buildBoundedC1CompositionRevision, validateBoundedC1Extraction } from "./build-bounded-c1-composition-revision.mjs";

const root = resolve(import.meta.dirname, "../.."), sha = (bytes) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`, portable = (path) => relative(root, path).split(sep).join("/");
async function fixture() {
  const directory = await mkdtemp(resolve(root, ".tmp-bounded-c1-test-")), [manifestBytes, buildBytes, blendBytes, extractorBytes] = await Promise.all([
    readFile(resolve(root, BOUNDED_C1_BASE.manifestPath)), readFile(resolve(root, BOUNDED_C1_BASE.buildEvidencePath)), readFile(resolve(root, BOUNDED_C1_BASE.blendPath)), readFile(resolve(root, BOUNDED_C1_BASE.extractorPath)),
  ]), manifest = JSON.parse(manifestBytes), build = JSON.parse(buildBytes), adapter = build.adapterOutput;
  const extraction = { schema: BOUNDED_C1_EXTRACTION_SCHEMA, source: {
    baseManifest: { path: BOUNDED_C1_BASE.manifestPath, sha256: sha(manifestBytes) }, baseBuildEvidence: { path: BOUNDED_C1_BASE.buildEvidencePath, sha256: sha(buildBytes) },
    blend: { path: BOUNDED_C1_BASE.blendPath, sha256: sha(blendBytes) }, extractor: { path: BOUNDED_C1_BASE.extractorPath, sha256: sha(extractorBytes) },
  }, protected: {
    handoffSchema: "limina.blender-building-composition-handoff/v2", compositionRootId: manifest.id,
    materializedShellFingerprint: adapter.materializedShellFingerprint, materializedShellNodeTableHash: adapter.materializedShellNodeTableHash, materializedShellNodeFingerprint: adapter.materializedShellNodeFingerprint,
    sourceShellBlendHash: build.sourceValidation.sourceShellBlendHash,
    sourceCatalogBlendHashes: Object.fromEntries(adapter.instances.map((entry) => [entry.artifactId, entry.sourceBlendHash]).sort(([a], [b]) => a.localeCompare(b))), instances: adapter.instances,
  }, edits: manifest.instances.map((entry) => ({ id: entry.id, position: [...entry.placement.position], yawRadians: entry.placement.yawRadians, scale: [...entry.placement.scale] })) };
  const path = resolve(directory, "extraction.json");
  return { directory, extraction, path, async write() { await writeFile(path, `${JSON.stringify(extraction, null, 2)}\n`); return portable(path); }, async close() { await rm(directory, { recursive: true, force: true }); } };
}

test("safe Blender X/Z/yaw edit emits append-only C1 r4 and reruns all functional constraints", async () => {
  const f = await fixture(); try {
    const edit = f.extraction.edits.find((entry) => entry.id === "instance/dining-table"); edit.position[0] += .01; edit.position[2] += .01; edit.yawRadians += .01;
    const result = await buildBoundedC1CompositionRevision({ extractionPath: await f.write(), repoRoot: root, write: false });
    assert.equal(result.manifest.id, "composition/functional-hall-house-v4/r4"); assert.equal(result.manifest.revision, 4); assert.equal(result.manifest.supersedes, "composition/functional-hall-house-v4/r3");
    assert.equal(result.evidence.verdict, "pass", JSON.stringify(result.evidence.checks.filter((entry) => !entry.passed), null, 2)); assert.deepEqual(result.evidence.summary, { passed: 8, failed: 0 });
    const placement = result.manifest.instances.find((entry) => entry.id === "instance/dining-table").placement; assert.deepEqual(placement.position, [-2.99, .09, -.79]); assert.equal(placement.yawRadians, .01);
  } finally { await f.close(); }
});

test("bounded extraction rejects scale edits", async () => {
  const f = await fixture(); try { f.extraction.edits[0].scale[0] = 1.01; await assert.rejects(validateBoundedC1Extraction(f.extraction, { repoRoot: root }), /scale edits are forbidden/); } finally { await f.close(); }
});

test("bounded extraction rejects protected mesh/material fingerprint drift", async () => {
  const f = await fixture(); try { f.extraction.protected.instances[0].composedFingerprint = `sha256:${"0".repeat(64)}`; await assert.rejects(validateBoundedC1Extraction(f.extraction, { repoRoot: root }), /protected mesh\/material\/dependency\/semantic closure drifted/); } finally { await f.close(); }
});

test("bounded extraction rejects exact dependency closure drift", async () => {
  const f = await fixture(); try { const key = Object.keys(f.extraction.protected.sourceCatalogBlendHashes)[0]; f.extraction.protected.sourceCatalogBlendHashes[key] = `sha256:${"0".repeat(64)}`; await assert.rejects(validateBoundedC1Extraction(f.extraction, { repoRoot: root }), /protected mesh\/material\/dependency\/semantic closure drifted/); } finally { await f.close(); }
});

test("bounded revision rejects a Blender transform that creates compound collision", async () => {
  const f = await fixture(); try { const table = f.extraction.edits.find((entry) => entry.id === "instance/dining-table"), chair = f.extraction.edits.find((entry) => entry.id === "instance/dining-chair-north"); chair.position = [...table.position]; await assert.rejects(buildBoundedC1CompositionRevision({ extractionPath: await f.write(), repoRoot: root, write: false }), /functional verification failed:.*transformed-compound-collider-separation/s); } finally { await f.close(); }
});
