import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { portableAssetContentHash } from "../../js/src/world/asset-content-hash.mjs";
import {
  M1_R2_KTX2_PATHS,
  buildShellR4M1R2Ktx2Config,
} from "./compress-approved-shell-r4-m1-r2-ktx2.mjs";

const repo = resolve(import.meta.dirname, "../..");

test("M1 r2 compression binds approved shell r4 and append-only runtime paths", async () => {
  const config = await buildShellR4M1R2Ktx2Config({ repoRoot: repo });
  assert.equal(config.input, "assets/buildings/authoring/functional-hall-house-v4/shell-r4/shell.glb");
  assert.equal(config.output, M1_R2_KTX2_PATHS.output);
  assert.equal(config.manifest, M1_R2_KTX2_PATHS.manifest);
  assert.equal(config.expectedSourceSha256, "4aba79d5285d5bd0dddbc454b1949e986bf7cf52ce2e743a23814433b04b69ed");
  const [derived, manifestBytes] = await Promise.all([readFile(resolve(repo, config.output)), readFile(resolve(repo, config.manifest))]);
  const manifest = JSON.parse(manifestBytes);
  assert.equal(manifest.source.path, config.input);
  assert.equal(manifest.output.path, config.output);
  assert.equal(manifest.output.engineHash, portableAssetContentHash(derived));
  assert.equal(manifest.textures.length, 18);
});

test("M1 r2 compression rejects output outside its private derivation root", async () => {
  await assert.rejects(buildShellR4M1R2Ktx2Config({ repoRoot: repo, output: "assets/buildings/authoring/functional-hall-house-v4/shell-r4/escaped.glb" }), /must remain inside/);
});
