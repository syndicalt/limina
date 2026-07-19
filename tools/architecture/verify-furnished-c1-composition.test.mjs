import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { basename, relative, resolve, sep } from "node:path";
import test from "node:test";
import { buildFurnishedC1Composition } from "./build-furnished-c1-composition.mjs";
import {
  FURNISHED_C1_FUNCTIONAL_EVIDENCE_SCHEMA,
  verifyFurnishedC1Composition,
} from "./verify-furnished-c1-composition.mjs";

const root = resolve(import.meta.dirname, "../.."),
  sha = (bytes) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
  portable = (path) => relative(root, path).split(sep).join("/");
async function fixture() {
  const directory = await mkdtemp(resolve(root, ".tmp-c1-verifier-test-")),
    built = await buildFurnishedC1Composition({ repoRoot: root, write: false }),
    manifest = structuredClone(built.manifest),
    manifestPath = resolve(directory, "manifest.json");
  return {
    directory,
    manifest,
    manifestPath,
    async write() {
      await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
      return portable(manifestPath);
    },
    async copyJson(sourcePath, mutate) {
      const value = JSON.parse(await readFile(resolve(root, sourcePath), "utf8"));
      mutate(value);
      const path = resolve(directory, basename(sourcePath)),
        bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
      await writeFile(path, bytes);
      return { path: portable(path), sha256: sha(bytes) };
    },
  };
}
const failed = (evidence, id) => evidence.checks.find((entry) => entry.id === id)?.passed === false;

test("passes the exact C1 r3 and approved I1 r4 seven-instance closure without replacing approved F1 assets", async () => {
  const f = await fixture();
  try {
    const evidence = await verifyFurnishedC1Composition({ root, manifestPath: await f.write() });
    assert.equal(f.manifest.id, "composition/functional-hall-house-v4/r3");
    assert.equal(f.manifest.revision, 3);
    assert.equal(f.manifest.supersedes, "composition/functional-hall-house-v4/r2");
    assert.equal(f.manifest.dependencies.interiorPlan.artifact.artifactId, "interior/functional-hall-house-v4/r4");
    assert.equal(evidence.schema, FURNISHED_C1_FUNCTIONAL_EVIDENCE_SCHEMA);
    assert.equal(
      evidence.verdict,
      "pass",
      JSON.stringify(
        evidence.checks.filter((entry) => !entry.passed),
        null,
        2,
      ),
    );
    assert.deepEqual(evidence.summary, { passed: 8, failed: 0 });
    assert.equal(evidence.checks.find((entry) => entry.id === "furniture-functional-rerun-i1-r4").metrics.passed, 4);
    assert.equal(
      evidence.checks.find((entry) => entry.id === "seven-exact-i1-transforms-support-containment").metrics.instances,
      7,
    );
  } finally {
    await rm(f.directory, { recursive: true, force: true });
  }
});

test("requires append-only C1 r3 identity superseding preserved r2", async () => {
  const f = await fixture();
  try {
    f.manifest.id = "composition/functional-hall-house-v4/r2";
    f.manifest.revision = 2;
    f.manifest.supersedes = "composition/functional-hall-house-v4/r1";
    const evidence = await verifyFurnishedC1Composition({ root, manifestPath: await f.write() });
    assert.ok(failed(evidence, "exact-approved-byte-closure"));
    assert.ok(
      evidence.checks
        .find((entry) => entry.id === "exact-approved-byte-closure")
        .findings.some((value) => /r3 append-only identity|C1 r3/.test(value)),
    );
  } finally {
    await rm(f.directory, { recursive: true, force: true });
  }
});

test("rejects raw artifact/resource byte drift before composition checks", async () => {
  const f = await fixture();
  try {
    f.manifest.dependencies.shell.artifact.artifactSha256 = `sha256:${"0".repeat(64)}`;
    const evidence = await verifyFurnishedC1Composition({ root, manifestPath: await f.write() });
    assert.equal(evidence.verdict, "fail");
    assert.ok(failed(evidence, "exact-approved-byte-closure"));
    assert.match(
      evidence.checks.find((entry) => entry.id === "exact-approved-byte-closure").findings[0],
      /artifact bytes drifted/,
    );
  } finally {
    await rm(f.directory, { recursive: true, force: true });
  }
});

test("rejects furniture build evidence that no longer matches independently inspected GLB geometry", async () => {
  const f = await fixture();
  try {
    const catalog = f.manifest.dependencies.catalog.find((entry) => entry.role === "dining-chair"),
      copy = await f.copyJson(catalog.buildEvidence.path, (value) => (value.bounds.max[0] += 0.04));
    catalog.buildEvidence = copy;
    const evidence = await verifyFurnishedC1Composition({ root, manifestPath: await f.write() });
    assert.ok(failed(evidence, "furniture-functional-rerun-i1-r4"));
    assert.ok(
      evidence.checks
        .find((entry) => entry.id === "furniture-functional-rerun-i1-r4")
        .findings.some((value) => value.includes("independent GLB bounds")),
    );
  } finally {
    await rm(f.directory, { recursive: true, force: true });
  }
});

test("rejects transform drift and resulting transformed compound collision", async () => {
  const f = await fixture();
  try {
    const table = f.manifest.instances.find((entry) => entry.role === "dining-table"),
      chair = f.manifest.instances.find((entry) => entry.id === "instance/dining-chair-north");
    chair.placement.position = [...table.placement.position];
    const evidence = await verifyFurnishedC1Composition({ root, manifestPath: await f.write() });
    assert.ok(failed(evidence, "seven-exact-i1-transforms-support-containment"));
    assert.ok(failed(evidence, "transformed-compound-collider-separation"));
  } finally {
    await rm(f.directory, { recursive: true, force: true });
  }
});

test("rejects bound facing drift and door/circulation/hearth violations", async () => {
  for (const [id, mutate, expected] of [
    [
      "instance/dining-chair-west",
      (instance) => (instance.placement.yawRadians += Math.PI),
      "interaction-sockets-clearances-facing",
    ],
    [
      "instance/dining-chair-west",
      (instance) => (instance.placement.position = [-1.44, 0.09, -3.66]),
      "door-circulation-hearth-exclusions",
    ],
    [
      "instance/dining-table",
      (instance) => (instance.placement.position = [2.5, 0.09, 1.2]),
      "door-circulation-hearth-exclusions",
    ],
  ]) {
    const f = await fixture();
    try {
      const instance = f.manifest.instances.find((entry) => entry.id === id);
      mutate(instance);
      const evidence = await verifyFurnishedC1Composition({ root, manifestPath: await f.write() });
      assert.ok(failed(evidence, expected), `${id}: ${JSON.stringify(evidence.checks, null, 2)}`);
    } finally {
      await rm(f.directory, { recursive: true, force: true });
    }
  }
});

test("rejects proxy/legacy removal drift and false M1 resource provenance", async () => {
  const f = await fixture();
  try {
    f.manifest.legacyExclusions = f.manifest.legacyExclusions.slice(1);
    const shellSource = f.manifest.dependencies.shell.sourceBlend;
    f.manifest.dependencies.materialPalette.materialsLock = { ...shellSource };
    const evidence = await verifyFurnishedC1Composition({ root, manifestPath: await f.write() });
    assert.ok(failed(evidence, "semantic-uniqueness-proxy-legacy-removal"));
    assert.ok(failed(evidence, "approved-m1-runtime-provenance"));
  } finally {
    await rm(f.directory, { recursive: true, force: true });
  }
});

test("writes deterministic private evidence with exclusive-create semantics", async () => {
  const f = await fixture();
  try {
    const manifestPath = await f.write(),
      outputPath = portable(resolve(f.directory, "evidence.json")),
      first = await verifyFurnishedC1Composition({ root, manifestPath, outputPath, write: true });
    assert.equal(first.verdict, "pass");
    const bytes = await readFile(resolve(root, outputPath));
    assert.equal(JSON.parse(bytes).inputs.manifestHash, first.inputs.manifestHash);
    await assert.rejects(() => verifyFurnishedC1Composition({ root, manifestPath, outputPath, write: true }), /EEXIST/);
  } finally {
    await rm(f.directory, { recursive: true, force: true });
  }
});
