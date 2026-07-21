import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, rm, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { test } from "node:test";
import { createC1AuthoringSession } from "./open-authoring.mjs";

const sha = (bytes) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const ROOT = resolve(new URL("../..", import.meta.url).pathname);
test("C1 launcher creates a private, exclusive copy of the exact approved source", async () => {
  const sourcePath = resolve(ROOT, "assets/buildings/authoring/functional-hall-house-v4/composition-r3/furnished-c1-r3.blend");
  const before = await readFile(sourcePath), created = await createC1AuthoringSession({ root: ROOT });
  try {
    const [directoryInfo, workingInfo, manifestInfo, workingBytes, manifestBytes, after] = await Promise.all([
      stat(created.sessionDirectory), stat(created.workingCopy), stat(created.sessionManifest), readFile(created.workingCopy), readFile(created.sessionManifest), readFile(sourcePath),
    ]);
    assert.equal(directoryInfo.mode & 0o777, 0o700);
    assert.equal(workingInfo.mode & 0o777, 0o600); assert.equal(manifestInfo.mode & 0o777, 0o600);
    assert.notEqual(created.workingCopy, sourcePath); assert.equal(sha(workingBytes), sha(before)); assert.equal(sha(after), sha(before));
    const session = JSON.parse(manifestBytes);
    assert.equal(session.schema, "limina.blender-authoring-session/v1");
    assert.equal(session.composition.id, "composition/functional-hall-house-v4/r3");
    assert.equal(session.composition.revision, 3); assert.equal(session.approvedArtifact.contentHash, "sha256:adabb56bd808ea0731ec6f45531bc99ecb7670a8cf232769c9e93cc3c8fe94dd");
    assert.equal(session.approvedSource.sha256, "sha256:5c0fa1aa5e237bf61eaa2e37690122b9b9d5fded8fca8ceb20e979a56eec34c1");
    assert.deepEqual(session.policy, { approvedSourceImmutable: true, genericGltfExportAllowed: false, enginePreviewRequiresHostOrchestrator: true });
    assert.equal(session.hostOrchestrator.path, "tools/architecture/run-building-authoring-session.mjs");
  } finally {
    await rm(created.sessionDirectory, { recursive: true, force: true });
  }
});
