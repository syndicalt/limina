import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { portableAssetContentHash } from "../../js/src/world/asset-content-hash.mjs";
import {
  CAPTURE_SOURCE_ARCHIVE_SCHEMA,
  collectCaptureModuleClosure,
  verifyCaptureSourceArchive,
  writeCaptureSourceArchive,
} from "./capture-producer-closure.mjs";

const raw = (bytes) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

async function fixture() {
  const root = await mkdtemp(resolve(tmpdir(), "limina-capture-source-archive-")),
    repoRoot = resolve(root, "repo"),
    outputRoot = resolve(root, "staging");
  await mkdir(resolve(repoRoot, "src"), { recursive: true });
  await mkdir(outputRoot);
  const inputs = [
    ["src/capture.ts", Buffer.from("export const capture = true;\n")],
    ["src/review.mjs", Buffer.from("export const review = 'engine';\n")],
  ];
  for (const [path, bytes] of inputs) await writeFile(resolve(repoRoot, path), bytes);
  return {
    root,
    repoRoot,
    outputRoot,
    sources: inputs.map(([path, bytes]) => ({
      path,
      sha256: raw(bytes),
      contentHash: portableAssetContentHash(bytes),
      bytes: bytes.byteLength,
    })),
  };
}

test("new capture source closure is archived byte-completely and verifies", async () => {
  const value = await fixture();
  try {
    const record = await writeCaptureSourceArchive(value);
    assert.equal(record.schema, CAPTURE_SOURCE_ARCHIVE_SCHEMA);
    assert.equal(record.completeness, "complete");
    assert.equal(record.sourceCount, 2);
    const manifest = await verifyCaptureSourceArchive({
      evidenceRoot: value.outputRoot,
      record,
      expectedSources: value.sources,
    });
    assert.equal(manifest.sources.length, 2);
    for (const source of manifest.sources) {
      assert.match(source.archivePath, /^source-archive\/[0-9a-f]{64}\.blob$/);
      assert.equal(raw(await readFile(resolve(value.outputRoot, source.archivePath))), source.sha256);
    }
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("producer closure includes static, re-exported, and dynamic relative modules", async () => {
  const value = await fixture();
  try {
    await writeFile(
      resolve(value.repoRoot, "src/capture.ts"),
      'import "./review.mjs"; export { dynamic } from "./reexport.mjs"; await import("./dynamic.mjs");\n',
    );
    await writeFile(resolve(value.repoRoot, "src/reexport.mjs"), "export const dynamic = true;\n");
    await writeFile(resolve(value.repoRoot, "src/dynamic.mjs"), "export const loaded = true;\n");
    const closure = await collectCaptureModuleClosure(value.repoRoot, ["src/capture.ts"]);
    assert.deepEqual(
      closure.map(({ path }) => path),
      ["src/capture.ts", "src/dynamic.mjs", "src/reexport.mjs", "src/review.mjs"],
    );
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("hash-only declarations are upgraded to archived bytes, never emitted hash-only", async () => {
  const value = await fixture();
  try {
    const hashOnly = value.sources.map((entry) => ({ path: entry.path, sha256: entry.sha256 }));
    const record = await writeCaptureSourceArchive({ ...value, sources: hashOnly });
    const manifest = await verifyCaptureSourceArchive({ evidenceRoot: value.outputRoot, record });
    assert.ok(
      manifest.sources.every(
        (entry) => entry.archivePath?.endsWith(".blob") && entry.contentHash && entry.bytes > 0,
      ),
    );
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("source without an exact SHA-256 identity fails before evidence emission", async () => {
  const value = await fixture();
  try {
    value.sources[0].sha256 = undefined;
    await assert.rejects(writeCaptureSourceArchive(value), /capture source SHA-256 drifted/);
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("producer refuses stale source identity before emitting a manifest", async () => {
  const value = await fixture();
  try {
    value.sources[0].sha256 = `sha256:${"0".repeat(64)}`;
    await assert.rejects(writeCaptureSourceArchive(value), /capture source SHA-256 drifted/);
    await assert.rejects(readFile(resolve(value.outputRoot, "source-archive/manifest.json")), /ENOENT/);
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("alias paths with empty or dot segments cannot bypass source uniqueness", async () => {
  const value = await fixture();
  try {
    value.sources[1].path = "src/./review.mjs";
    await assert.rejects(writeCaptureSourceArchive(value), /path is not workspace-relative/);
    await assert.rejects(lstat(resolve(value.outputRoot, "source-archive")), /ENOENT/);
    value.sources[1].path = "src//review.mjs";
    await assert.rejects(writeCaptureSourceArchive(value), /path is not workspace-relative/);
    await assert.rejects(lstat(resolve(value.outputRoot, "source-archive")), /ENOENT/);
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("source symlinks and realpath escapes fail before archive creation", async () => {
  const value = await fixture();
  try {
    const outside = resolve(value.root, "outside.ts");
    await writeFile(outside, "export const escaped = true;\n");
    await symlink(outside, resolve(value.repoRoot, "src/escaped.ts"));
    const bytes = await readFile(outside);
    value.sources[1] = {
      path: "src/escaped.ts",
      sha256: raw(bytes),
      contentHash: portableAssetContentHash(bytes),
      bytes: bytes.length,
    };
    await assert.rejects(writeCaptureSourceArchive(value), /non-symlink|symlink or escaped/);
    await assert.rejects(lstat(resolve(value.outputRoot, "source-archive")), /ENOENT/);
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("a stale later source leaves no partial source-archive directory", async () => {
  const value = await fixture();
  try {
    value.sources[1].sha256 = `sha256:${"0".repeat(64)}`;
    await assert.rejects(writeCaptureSourceArchive(value), /capture source SHA-256 drifted/);
    await assert.rejects(lstat(resolve(value.outputRoot, "source-archive")), /ENOENT/);
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("source-archive manifest identity tampering fails closed", async () => {
  const value = await fixture();
  try {
    const record = structuredClone(await writeCaptureSourceArchive(value));
    record.manifest.sha256 = `sha256:${"0".repeat(64)}`;
    await assert.rejects(
      verifyCaptureSourceArchive({ evidenceRoot: value.outputRoot, record, expectedSources: value.sources }),
      /manifest drifted/,
    );
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("archive verification rejects an incomplete declared closure", async () => {
  const value = await fixture();
  try {
    const record = await writeCaptureSourceArchive(value);
    await assert.rejects(
      verifyCaptureSourceArchive({
        evidenceRoot: value.outputRoot,
        record,
        expectedSources: value.sources.slice(0, 1),
      }),
      /does not cover the declared producer closure/,
    );
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});
