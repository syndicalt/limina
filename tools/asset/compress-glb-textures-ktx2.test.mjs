import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import {
  KTX2_COMPOSITION_POLICY,
  KTX_SOFTWARE_VERSION,
  PINNED_TOKTX_OPTIONS,
  PINNED_TOKTX_PATH,
  compressGlbTexturesKtx2,
  planGlbKtx2Compression,
} from "./compress-glb-textures-ktx2.mjs";

const repo = resolve(import.meta.dirname, "../..");
const composition = resolve(repo, "assets/buildings/authoring/functional-hall-house-v4/composition-r3/furnished-c1-r3.glb");
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

test("general KTX2 plan closes the exact C1 composition slots and deduplicates 90 textures to 21", async () => {
  const bytes = await readFile(composition);
  const plan = planGlbKtx2Compression(bytes, {
    expectedSourceSha256: sha256(bytes),
    uastcAlbedoImageIndices: [4, 7, 13],
  });
  assert.equal(plan.images.length, 21);
  assert.equal(plan.json.textures.length, 90);
  assert.equal(plan.json.materials.length, 34);
  assert.equal(plan.bindings.length, 90);
  assert.equal(plan.textures.length, 21);
  assert.deepEqual(new Set(plan.images.map((image) => `${image.width}x${image.height}`)), new Set(["1024x1024"]));
  assert.equal(new Set(plan.images.map((image) => image.sourceSha256)).size, 21);
  assert.deepEqual(new Set(plan.images.map((image) => image.kind)), new Set(["albedo", "roughness", "normal"]));
  assert.ok(plan.bindings.every((binding) => Number.isSafeInteger(binding.outputTexture) && binding.outputTexture >= 0 && binding.outputTexture < 21));
  assert.equal(plan.images.filter((image) => image.mode === "UASTC+Zstd").length, 10);
  assert.deepEqual(plan.images.filter((image) => image.kind === "albedo" && image.mode === "UASTC+Zstd").map((image) => image.image), [4, 7, 13]);
});

test("general KTX2 plan rejects authority drift and incomplete texture budgets", async () => {
  const bytes = await readFile(composition);
  await assert.rejects(async () => planGlbKtx2Compression(bytes, { expectedSourceSha256: "0".repeat(64) }), /authority hash mismatch/);
  assert.throws(() => planGlbKtx2Compression(bytes, {
    expectedSourceSha256: sha256(bytes),
    policy: { ...KTX2_COMPOSITION_POLICY, maxTextureObjects: 20 },
  }), /exceeds 20/);
  assert.throws(() => planGlbKtx2Compression(bytes, {
    expectedSourceSha256: sha256(bytes),
    uastcAlbedoImageIndices: [0],
  }), /selected as UASTC albedo but is normal/);
});

test("KTX authoring dependency and all encoder choices are version-pinned", () => {
  assert.equal(KTX_SOFTWARE_VERSION, "4.4.2");
  assert.equal(PINNED_TOKTX_PATH, "js/.tools/ktx/4.4.2/linux-arm64/root/usr/bin/toktx");
  assert.deepEqual(PINNED_TOKTX_OPTIONS.uastcNormal, ["--t2", "--encode", "uastc", "--uastc_quality", "3", "--uastc_rdo_l", "0.5", "--uastc_rdo_m", "--zcmp", "18"]);
  assert.deepEqual(PINNED_TOKTX_OPTIONS.uastcAlbedo, ["--t2", "--encode", "uastc", "--uastc_quality", "3", "--uastc_rdo_l", "0.75", "--uastc_rdo_m", "--zcmp", "18"]);
  assert.deepEqual(PINNED_TOKTX_OPTIONS.etc1s, ["--t2", "--encode", "etc1s", "--qlevel", "160", "--clevel", "5", "--threads", "1"]);
  assert.equal(KTX2_COMPOSITION_POLICY.fallback, "none");
  assert.equal(KTX2_COMPOSITION_POLICY.maxTextureObjects, 21);
  assert.equal(KTX2_COMPOSITION_POLICY.maxArtifactBytes, 24 * 1024 * 1024);
  assert.equal(KTX2_COMPOSITION_POLICY.maxGpuResidencyBytes, 72 * 1024 * 1024);
  assert.match(KTX2_COMPOSITION_POLICY.residencyAccounting, /produced-ktx2/);
  const run = spawnSync(resolve(repo, PINNED_TOKTX_PATH), ["--version"], { encoding: "utf8" });
  assert.equal(run.status, 0);
  assert.equal(`${run.stdout}${run.stderr}`.trim(), "toktx v4.4.2");
});

test("general KTX2 publication rejects absolute and escaping paths before I/O", async () => {
  const common = { expectedSourceSha256: "0".repeat(64), workspaceRoot: repo };
  await assert.rejects(compressGlbTexturesKtx2({ ...common, input: composition, output: "safe/out.glb", manifest: "safe/out.json" }), /input must be workspace-relative/);
  await assert.rejects(compressGlbTexturesKtx2({ ...common, input: "../escape.glb", output: "safe/out.glb", manifest: "safe/out.json" }), /input escapes the workspace/);
  await assert.rejects(compressGlbTexturesKtx2({ ...common, input: "safe/in.glb", output: "/tmp/out.glb", manifest: "safe/out.json" }), /output must be workspace-relative/);
  await assert.rejects(compressGlbTexturesKtx2({ ...common, input: "safe/in.glb", output: "safe/out.glb", manifest: "../../out.json" }), /manifest escapes the workspace/);
});
