import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const jsRoot = resolve(root, "js");
const checkedIn = [resolve(root, "tools/scaffold/public/limina-player.js"), resolve(root, "site/public/examples/limina-player.js")];

test("scaffold player is the exact current browser-entry bundle with coordinated failure behavior", async () => {
  const scratch = await mkdtemp(resolve(tmpdir(), "limina-player-closure-"));
  try {
    const output = resolve(scratch, "limina-player.js");
    const result = spawnSync(resolve(jsRoot, "node_modules/.bin/esbuild"), [
      "src/browser-entry.ts", "--bundle", "--format=iife", "--global-name=LiminaPlayer", "--platform=browser",
      "--define:import.meta.url=document.baseURI", `--outfile=${output}`, "--loader:.ts=ts",
    ], { cwd: jsRoot, encoding: "utf8", timeout: 120_000, maxBuffer: 4 * 1024 * 1024 });
    assert.equal(result.status, 0, result.stderr || result.stdout || "esbuild failed");
    const expected = await readFile(output), actuals = await Promise.all(checkedIn.map(path => readFile(path)));
    for (const actual of actuals) assert.deepEqual(actual, expected, "a distributed limina-player.js is stale; run npm --prefix js run bundle:player");
    const text = actuals[0].toString("utf8");
    assert.match(text, /hash\d* !== "sha256:"/, "hash-less tree-impostor host behavior is absent from the scaffold player");
    assert.match(text, /first divergence @\$\{at\d*\}/, "windowed durable replay diff is absent from the scaffold player");
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});
