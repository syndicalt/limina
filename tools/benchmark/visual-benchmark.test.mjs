import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  BenchmarkValidationError, loadAndValidateBenchmark, resolveProjectOutputDirectory, sha256File, sha256Tree,
  validateBenchmarkManifest,
} from "./visual-benchmark.mjs";

function fixture() {
  const parent = mkdtempSync(join(tmpdir(), "limina-visual-benchmark-"));
  const root = join(parent, "project");
  mkdirSync(join(root, "benchmarks"), { recursive: true });
  mkdirSync(join(root, "dist"), { recursive: true });
  writeFileSync(join(root, "world.ts"), "export const SEED = 7;\n");
  writeFileSync(join(root, "dist", "manifest.json"), "{}\n");
  writeFileSync(join(root, "dist", "log.jsonl"), '{"kind":"seed","seq":0,"seed":7}\n');
  const orbit = { center: [1, 2, 3], radius: 4, height: 5, maxRadius: 6, maxHeight: 7, far: 8 };
  writeFileSync(join(root, "dist", "view.json"), `${JSON.stringify(orbit)}\n`);
  const manifest = {
    schema: "limina.visual-benchmark/1",
    id: "valid-fixture",
    recordOnly: true,
    source: { algorithm: "sha256-tree-v1", files: ["world.ts"], sha256: sha256Tree(root, ["world.ts"]) },
    export: {
      algorithm: "sha256-tree-v1",
      files: ["dist/log.jsonl", "dist/manifest.json"],
      sha256: sha256Tree(root, ["dist/log.jsonl", "dist/manifest.json"]),
    },
    viewport: { width: 1280, height: 720, deviceScaleFactor: 1 },
    simulation: { seed: 7, fixedTimestepSeconds: 1 / 60, warmupFrames: 120, measureFrames: 600 },
    qualityProfile: "current-default",
    cameras: [{ id: "existing-camera", viewPath: "dist/view.json", viewSha256: sha256File(root, "dist/view.json"), orbit }],
    output: { directory: "benchmarks/results" },
  };
  writeFileSync(join(root, "benchmarks", "fixture.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return { parent, root, manifest };
}

test("valid fixture is schema-valid and hash-pinned", () => {
  const { root, manifest } = fixture();
  assert.equal(validateBenchmarkManifest(manifest), manifest);
  assert.deepEqual(loadAndValidateBenchmark(root, "benchmarks/fixture.json").manifest, manifest);
});

test("malformed schema produces stable, specific errors", () => {
  const { manifest } = fixture();
  const malformed = structuredClone(manifest);
  malformed.recordOnly = false;
  malformed.viewport.width = "1280";
  malformed.unexpected = true;
  let first;
  assert.throws(() => validateBenchmarkManifest(malformed), (error) => {
    assert(error instanceof BenchmarkValidationError);
    first = error.message;
    assert.match(error.message, /\$\.unexpected is not allowed/);
    assert.match(error.message, /recordOnly must be true/);
    assert.match(error.message, /viewport\.width must be integer/);
    return true;
  });
  assert.throws(() => validateBenchmarkManifest(malformed), (error) => error.message === first);
});

test("traversal, absolute paths, and escaping symlinks are rejected", () => {
  const { parent, root, manifest } = fixture();
  const outside = join(parent, "outside.txt");
  writeFileSync(outside, "outside\n");
  const traversing = structuredClone(manifest);
  traversing.source.files = ["../outside.txt"];
  assert.throws(() => validateBenchmarkManifest(traversing), /parent-directory/);
  traversing.source.files = [outside];
  assert.throws(() => validateBenchmarkManifest(traversing), /portable project-relative path/);

  symlinkSync(outside, join(root, "escaped.txt"));
  const linked = structuredClone(manifest);
  linked.source.files = ["escaped.txt"];
  linked.source.sha256 = `sha256:${"0".repeat(64)}`;
  writeFileSync(join(root, "benchmarks", "linked.json"), `${JSON.stringify(linked)}\n`);
  assert.throws(() => loadAndValidateBenchmark(root, "benchmarks/linked.json"), /resolves outside project root/);

  symlinkSync(parent, join(root, "escaped-output"));
  assert.throws(() => resolveProjectOutputDirectory(root, "escaped-output/results"), /resolves outside project root/);
});

test("source and export hash mismatches fail before a run", () => {
  const { root } = fixture();
  writeFileSync(join(root, "world.ts"), "export const SEED = 8;\n");
  assert.throws(() => loadAndValidateBenchmark(root, "benchmarks/fixture.json"), /source hash mismatch/);

  const second = fixture();
  writeFileSync(join(second.root, "dist", "manifest.json"), '{"changed":true}\n');
  assert.throws(() => loadAndValidateBenchmark(second.root, "benchmarks/fixture.json"), /export hash mismatch/);
});

test("declared seed must match the pinned export log", () => {
  const { root, manifest } = fixture();
  const wrongSeed = structuredClone(manifest);
  wrongSeed.simulation.seed = 8;
  writeFileSync(join(root, "benchmarks", "wrong-seed.json"), `${JSON.stringify(wrongSeed)}\n`);
  assert.throws(() => loadAndValidateBenchmark(root, "benchmarks/wrong-seed.json"), /simulation seed mismatch/);
});
