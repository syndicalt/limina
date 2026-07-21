import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  ASSET_MANIFEST_SCHEMA,
  ASSET_QC_GATE_VERSION,
  inspectGlbAsset,
  readAssetManifest,
  runAssetManifestGate,
  sha256,
  upsertAssetCandidate,
} from "./asset-manifest.mjs";

const ROOT = new URL("../../", import.meta.url).pathname;
const fixtureBytes = readFileSync(join(ROOT, "assets/fixtures/building.glb"));
const evidenceBytes = readFileSync(join(ROOT, "assets/qc/a-basic-wooden-bridge.png"));

function setup() {
  const root = mkdtempSync(join(tmpdir(), "limina-asset-manifest-"));
  mkdirSync(join(root, "models"));
  mkdirSync(join(root, "qc"));
  writeFileSync(join(root, "models/building.glb"), fixtureBytes);
  writeFileSync(join(root, "qc/building.png"), evidenceBytes);
  const entry = {
    id: "building",
    class: "building",
    model: { path: "models/building.glb", sha256: sha256(fixtureBytes) },
    provenance: { sourceUrl: "https://example.test/assets/building", licenseSpdx: "CC0-1.0", attribution: null },
    metrics: inspectGlbAsset(fixtureBytes),
    lods: [],
    qc: {
      gateVersion: ASSET_QC_GATE_VERSION,
      evidence: { path: "qc/building.png", sha256: sha256(evidenceBytes) },
      humanVisualApproval: { approved: true, approvedBy: "test-reviewer", referenceContract: "test/reference-contract" },
    },
  };
  const manifest = { schema: ASSET_MANIFEST_SCHEMA, unlistedPolicy: "excluded", entries: [entry], candidates: [] };
  return { root, manifest, entry };
}

function clone(value) { return JSON.parse(JSON.stringify(value)); }
function gates(verdict) { return new Set(verdict.failures.map((failure) => failure.gate)); }

function withMeshCount(bytes, count) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const jsonLength = view.getUint32(12, true);
  const json = JSON.parse(new TextDecoder().decode(bytes.subarray(20, 20 + jsonLength)).trim());
  json.meshes = Array.from({ length: count }, () => clone(json.meshes[0]));
  let jsonBytes = new TextEncoder().encode(JSON.stringify(json));
  const jsonPadding = (4 - jsonBytes.length % 4) % 4;
  if (jsonPadding) { const padded = new Uint8Array(jsonBytes.length + jsonPadding).fill(0x20); padded.set(jsonBytes); jsonBytes = padded; }
  const oldBinaryHeader = 20 + jsonLength;
  const binaryLength = view.getUint32(oldBinaryHeader, true);
  const binary = bytes.subarray(oldBinaryHeader + 8, oldBinaryHeader + 8 + binaryLength);
  const total = 12 + 8 + jsonBytes.length + 8 + binary.length;
  const output = new Uint8Array(total);
  const outView = new DataView(output.buffer);
  outView.setUint32(0, 0x46546c67, true); outView.setUint32(4, 2, true); outView.setUint32(8, total, true);
  outView.setUint32(12, jsonBytes.length, true); outView.setUint32(16, 0x4e4f534a, true);
  output.set(jsonBytes, 20);
  const binaryHeader = 20 + jsonBytes.length;
  outView.setUint32(binaryHeader, binary.length, true); outView.setUint32(binaryHeader + 4, 0x004e4942, true);
  output.set(binary, binaryHeader + 8);
  return output;
}

test("valid, proven manifest entry passes both independent gates", () => {
  const { root, manifest } = setup();
  try {
    const verdict = runAssetManifestGate(manifest, { assetRoot: root });
    assert.equal(verdict.pass, true);
    assert.equal(verdict.mechanicalPass, true);
    assert.equal(verdict.humanVisualPass, true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("hash, provenance, evidence, texture, LOD, and human review fail closed", () => {
  const { root, manifest } = setup();
  try {
    for (const [mutate, expected] of [
      [(m) => { m.entries[0].model.sha256 = `sha256:${"0".repeat(64)}`; }, "model-hash"],
      [(m) => { m.entries[0].provenance.sourceUrl = null; }, "source"],
      [(m) => { m.entries[0].provenance.licenseSpdx = "unknown"; }, "license"],
      [(m) => { m.entries[0].qc.evidence.path = "qc/missing.png"; }, "evidence-missing"],
      [(m) => { m.entries[0].qc.evidence.sha256 = `sha256:${"f".repeat(64)}`; }, "evidence-hash"],
      [(m) => { m.entries[0].metrics.textureSlots = []; }, "metrics"],
      [(m) => { m.entries[0].class = "vegetation"; }, "lod"],
      [(m) => { m.entries[0].qc.humanVisualApproval.approved = false; }, "human-visual"],
    ]) {
      const hostile = clone(manifest);
      mutate(hostile);
      const verdict = runAssetManifestGate(hostile, { assetRoot: root });
      assert.equal(verdict.pass, false);
      assert.ok(gates(verdict).has(expected), `expected ${expected}, got ${[...gates(verdict)].join(",")}`);
      if (expected === "human-visual") {
        assert.equal(verdict.mechanicalPass, true, "human rejection contaminated the mechanical result");
        assert.equal(verdict.humanVisualPass, false);
      }
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("fetch persistence creates a candidate, never an accepted entry", () => {
  const { root } = setup();
  try {
    const path = join(root, "manifest.json");
    const candidate = {
      id: "candidate.glb", status: "candidate-awaiting-qc", class: "prop",
      model: { path: "candidate.glb", sha256: sha256(fixtureBytes) },
      provenance: { source: "library:test", sourceUrl: "https://example.test/candidate", licenseSpdx: "CC0-1.0", attribution: null },
      metrics: inspectGlbAsset(fixtureBytes), lods: [], qc: null,
    };
    upsertAssetCandidate(path, candidate);
    upsertAssetCandidate(path, { ...candidate, status: "candidate-awaiting-human-review" });
    const persisted = readAssetManifest(path);
    assert.equal(persisted.entries.length, 0);
    assert.equal(persisted.candidates.length, 1);
    assert.equal(persisted.candidates[0].status, "candidate-awaiting-human-review");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("excessive per-model mesh submissions fail the class draw-call ceiling", () => {
  const { root, manifest } = setup();
  try {
    const hostileBytes = withMeshCount(fixtureBytes, 129);
    writeFileSync(join(root, "models/building.glb"), hostileBytes);
    manifest.entries[0].model.sha256 = sha256(hostileBytes);
    manifest.entries[0].metrics = inspectGlbAsset(hostileBytes);
    const verdict = runAssetManifestGate(manifest, { assetRoot: root });
    assert.equal(verdict.pass, false);
    assert.ok(gates(verdict).has("draw-calls"));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("repository Poly Haven vegetation candidates are hash-pinned, mechanically complete, and not accepted", () => {
  const manifest = readAssetManifest(join(ROOT, "assets/manifest.json"));
  const verdict = runAssetManifestGate(manifest, { assetRoot: join(ROOT, "assets") });
  assert.equal(verdict.pass, true);
  assert.equal(verdict.acceptedEntries, 0);
  assert.equal(verdict.candidates, 11);
  const tree = manifest.candidates.find((candidate) => candidate.id === "polyhaven-tree-small-02");
  assert.ok(tree);
  assert.equal(tree.provenance.licenseSpdx, "CC0-1.0");
  assert.equal(tree.qc.humanVisualApproval, null);
  assert.deepEqual(tree.metrics.textureSlots, ["baseColor", "metallicRoughness", "normal"]);
  assert.deepEqual(tree.lods.map((lod) => lod.metrics.triangleCount), [21603, 6269]);
  assert.ok(tree.lods.every((lod) => lod.distanceM === null), "unverified LOD distances were invented");
  for (const id of ["polyhaven-pine-sapling-small", "polyhaven-fir-sapling"]) {
    const sapling = manifest.candidates.find((candidate) => candidate.id === id);
    assert.ok(sapling);
    assert.equal(sapling.qc.humanVisualApproval, null);
    assert.equal(sapling.lods.length, 2);
    assert.ok(sapling.lods.every((lod) => lod.distanceM === null), `${id} invented LOD distances`);
    assert.deepEqual(sapling.metrics.textureSlots, ["baseColor", "metallicRoughness", "normal"]);
  }
  const stump = manifest.candidates.find((candidate) => candidate.id === "polyhaven-tree-stump-01");
  assert.ok(stump);
  assert.equal(stump.class, "prop");
  assert.deepEqual(stump.lods, [], "stump invented an unavailable LOD chain");
  assert.equal(stump.qc.humanVisualApproval, null);

  for (const id of [
    "polyhaven-fern-02",
    "polyhaven-shrub-03",
    "polyhaven-moss-01",
    "polyhaven-grass-medium-01",
    "polyhaven-rock-moss-set-01",
    "polyhaven-boulder-01",
    "polyhaven-dead-tree-trunk",
  ]) {
    const candidate = manifest.candidates.find((entry) => entry.id === id);
    assert.ok(candidate, `${id} is missing from the candidate manifest`);
    assert.equal(candidate.provenance.licenseSpdx, "CC0-1.0");
    assert.equal(candidate.qc.humanVisualApproval, null);
    assert.deepEqual(candidate.lods, [], `${id} invented an unavailable LOD chain`);
    assert.deepEqual(candidate.metrics.textureSlots, ["baseColor", "metallicRoughness", "normal"]);
  }

  for (const id of [
    "polyhaven-fern-02",
    "polyhaven-shrub-03",
    "polyhaven-moss-01",
    "polyhaven-grass-medium-01",
  ]) {
    const candidate = manifest.candidates.find((entry) => entry.id === id);
    assert.equal(candidate.metrics.meshCount, 1, `${id} did not publish the flattened runtime mesh`);
    assert.equal(candidate.status, "candidate-awaiting-lod-generation-and-human-qc", `${id} has stale or incomplete remaining debt`);
  }
  const flattenedRock = manifest.candidates.find((entry) => entry.id === "polyhaven-rock-moss-set-01");
  assert.equal(flattenedRock.metrics.meshCount, 1);
  assert.equal(flattenedRock.status, "candidate-awaiting-human-qc");
});
