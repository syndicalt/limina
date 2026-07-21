import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp as mkdtempAsync, rm as rmAsync, stat as statAsync } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { BUILDING_FIRE_REVIEW_FRAME_IDS, validateBuildingFireReviewAuthority, verifyBuildingFireReviewClosure } from "../../js/src/render/building-fire-review-authority.ts";
import { buildFireReviewAuthority, writeFireReviewAuthority } from "./build-fire-review-authority.mjs";

const ROOT = resolve(import.meta.dirname, "../..");

test("builds and verifies the exact CPU-only V1 review closure with canonical eleven-frame evidence", async () => {
  const { authority } = await buildFireReviewAuthority({ repoRoot: ROOT, write: false });
  const verified = verifyBuildingFireReviewClosure(authority, (path) => readFileSync(resolve(ROOT, path)));
  assert.equal(verified.contract.packageId, "fire/functional-hall-house-v4/v1");
  assert.equal(verified.artifact.status, "draft");
  assert.equal(verified.buildEvidence.gpuUsed, false);
  assert.equal(authority.approvalPolicy.timestampQueriesEnabled, false);
  assert.equal(authority.visualContext.contentDependency, false);
  assert.equal(authority.visualContext.purpose, "approved-c1-r3-v2-visual-context-only");
  assert.deepEqual(authority.evidenceFrames.map(({ id }) => id), BUILDING_FIRE_REVIEW_FRAME_IDS);
  assert.deepEqual(authority.evidenceFrames.slice(0, 8).map(({ tick, phase }) => ({ tick, phase })), [
    { tick: 0, phase: "off" }, { tick: 45, phase: "igniting" }, { tick: 120, phase: "burning" }, { tick: 150, phase: "burning" },
    { tick: 180, phase: "burning" }, { tick: 210, phase: "burning" }, { tick: 270, phase: "extinguishing" }, { tick: 420, phase: "off" },
  ]);
  assert.deepEqual(authority.metrics.exposure, { pairedOffOn: true, maxClippedPixelFraction: .0025, maxChannelP99: .98 });
});

test("fails closed on non-engine review, content promotion, evidence reordering, or source-byte drift", async () => {
  const { authority } = await buildFireReviewAuthority({ repoRoot: ROOT, write: false });
  const mutate = (change, pattern) => { const value = structuredClone(authority); change(value); assert.throws(() => validateBuildingFireReviewAuthority(value), pattern); };
  mutate((value) => value.approvalPolicy.timestampQueriesEnabled = true, /timestamps disabled/);
  mutate((value) => value.visualContext.contentDependency = true, /non-content visual context/);
  mutate((value) => [value.evidenceFrames[0], value.evidenceFrames[1]] = [value.evidenceFrames[1], value.evidenceFrames[0]], /canonical evidence order/);
  mutate((value) => value.metrics.reflectedLightPair.onFrameId = "hearth-motion--burn-a", /reflected-light pair drifted/);
  assert.throws(() => verifyBuildingFireReviewClosure(authority, (path) => path === authority.runtimeSources.runtime.path ? Buffer.from("drifted runtime") : readFileSync(resolve(ROOT, path))), /runtime source bytes drifted/);
});

test("writes private append-only authority bytes", async (t) => {
  const { authority } = await buildFireReviewAuthority({ repoRoot: ROOT, write: false }), directory = await mkdtempAsync(join(tmpdir(), "limina-v1-authority-")), output = join(directory, "fire-review-authority.json");
  t.after(() => rmAsync(directory, { recursive: true, force: true }));
  await writeFireReviewAuthority(authority, output); assert.equal((await statAsync(output)).mode & 0o777, 0o600);
  await assert.rejects(writeFireReviewAuthority(authority, output), (error) => error?.code === "EEXIST");
});
