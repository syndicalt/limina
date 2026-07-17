import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { test } from "node:test";
import { resolveBlender } from "../architecture/blender-toolchain.mjs";

const ROOT = resolve(new URL("../..", import.meta.url).pathname), addon = resolve(ROOT, "tools/blender/limina-authoring-addon.py");
function check(path) {
  const result = spawnSync(resolveBlender().binary, ["--background", resolve(ROOT, path), "--python", addon, "--", "--limina-headless-check"], { encoding: "utf8", env: process.env });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const match = result.stdout.match(/LIMINA_AUTHORING_UI_CHECK=(\{.+\})/); assert.ok(match, result.stdout);
  return JSON.parse(match[1]);
}
test("authoring add-on preserves shell-v1 support", () => {
  const report = check("assets/buildings/authoring/functional-hall-house-v4/shell-r4/shell.source.blend");
  assert.equal(report.ok, true); assert.equal(report.mode, "shell"); assert.equal(report.semanticCount, 393);
});
test("authoring add-on exposes only seven bounded C1 composition handles", () => {
  const report = check("assets/buildings/authoring/functional-hall-house-v4/composition-r3/furnished-c1-r3.blend");
  assert.equal(report.ok, true); assert.equal(report.mode, "composition"); assert.equal(report.semanticCount, 654); assert.equal(report.safeHandleCount, 7); assert.ok(report.protectedCount > 600);
});
