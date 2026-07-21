import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import sharp from "../../js/node_modules/sharp/lib/index.js";

const repo = resolve(import.meta.dirname, "../..");
const temp = await mkdtemp(join(tmpdir(), "limina-fixed-camera-"));
try {
  const baselinePath = join(repo, "assets/qc/internal/temperate-river-leading-line-native-candidate.png");
  const pass = spawnSync(process.execPath, ["tools/preview/compare-native-temperate-fidelity.mjs", baselinePath], {
    cwd: repo, encoding: "utf8",
  });
  assert.equal(pass.status, 0, pass.stderr || pass.stdout);
  const result = JSON.parse(pass.stdout);
  assert.equal(result.passed, true);
  assert.match(result.interpretation, /human approval remain mandatory/);

  const candidatePath = join(temp, "missing-scene.png");
  const { width, height } = await sharp(baselinePath).metadata();
  await sharp({ create: { width, height, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 1 } } }).png().toFile(candidatePath);
  const fail = spawnSync(process.execPath, ["tools/preview/compare-native-temperate-fidelity.mjs", candidatePath], {
    cwd: repo, encoding: "utf8",
  });
  assert.equal(fail.status, 1, "gross scene loss did not fail the CLI comparator");
  assert.equal(JSON.parse(fail.stdout).passed, false);
  console.log("compare-native-temperate-fidelity test OK: real PNG pass/fail behavior and human-review boundary are proven");
} finally {
  await rm(temp, { recursive: true, force: true });
}
