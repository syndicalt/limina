import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { MANIFEST_PATH, verifyManifest } from "./source-evidence-archive.mjs";

const manifest = JSON.parse(await readFile(MANIFEST_PATH, "utf8"));
const clone = () => structuredClone(manifest);
const impossibleHash = `sha256:${"0".repeat(64)}`;

test("historical source archive and exact transitions verify", async () => {
  const result = await verifyManifest(clone());
  assert.deepEqual(result, {
    evidenceSets: 18,
    sourceReferences: 157,
    archived: 87,
    hashAttestedOnly: 70,
    transitions: 3,
  });
});

test("archive identity tampering fails closed", async () => {
  const candidate = clone();
  candidate.sourceReferences.find((entry) => entry.reproducibility.status === "archived-exact")
    .reproducibility.archiveSha256 = impossibleHash;
  await assert.rejects(verifyManifest(candidate), /historical archive drifted/);
});

test("hash-only legacy evidence cannot authorize a current-source transition", async () => {
  const candidate = clone();
  const transition = candidate.transitions[0];
  const row = candidate.sourceReferences.find(
    (entry) =>
      entry.evidencePath === transition.evidencePath &&
      entry.sourcePath === transition.sourcePath &&
      entry.expectedSha256 === transition.historicalSha256,
  );
  row.reproducibility = {
    status: "hash-attested-only",
    archivePath: null,
    archiveSha256: null,
    recoveryGitBlobOid: null,
  };
  await assert.rejects(verifyManifest(candidate), /transition lacks exact historical bytes/);
});

test("historical evidence identity tampering fails closed", async () => {
  const candidate = clone();
  candidate.evidenceSets[0].sha256 = impossibleHash;
  await assert.rejects(verifyManifest(candidate), /historical evidence drifted/);
});

test("transition current-byte tampering fails closed", async () => {
  const candidate = clone();
  candidate.transitions[0].currentSha256 = impossibleHash;
  await assert.rejects(verifyManifest(candidate), /transition current source drifted/);
});
