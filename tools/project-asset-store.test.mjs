import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import {
  MAX_PROJECT_ASSET_READ_BYTES,
  ProjectAssetStore,
  ProjectAssetStoreError,
  projectAssetHash,
} from "./project-asset-store.mjs";

function fixture() {
  const projectRoot = mkdtempSync(join(tmpdir(), "limina-project-assets-"));
  const assetRoot = join(projectRoot, "assets");
  mkdirSync(assetRoot);
  const store = new ProjectAssetStore({ projectId: "asset-fixture", projectRoot, assetRoot });
  return { projectRoot, assetRoot, store, cleanup: () => rmSync(projectRoot, { recursive: true, force: true }) };
}

function put(root, assetId, bytes) {
  assert.ok(assetId.startsWith("assets/"));
  const path = join(root, ...assetId.slice("assets/".length).split("/"));
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, bytes);
  return { assetId, hash: projectAssetHash(bytes) };
}

function code(expected) {
  return (error) => error instanceof ProjectAssetStoreError && error.code === expected;
}

test("reads bounded regular bytes only after exact hash verification", () => {
  const fx = fixture();
  try {
    const bytes = Buffer.from("authoritative bytes\n");
    const ref = put(fx.assetRoot, "assets/sources/map-doc/a.json", bytes);
    assert.deepEqual(fx.store.read(ref), bytes);
    assert.equal(fx.store.verify(ref), true);
    assert.throws(() => fx.store.read({ ...ref, hash: `sha256:${"0".repeat(64)}` }), code("HASH_MISMATCH"));
    assert.throws(() => fx.store.read(ref, { maximumBytes: bytes.length - 1 }), code("TOO_LARGE"));
    assert.throws(() => fx.store.read(ref, { maximumBytes: MAX_PROJECT_ASSET_READ_BYTES + 1 }), code("INVALID_LIMIT"));
  } finally { fx.cleanup(); }
});

test("rejects traversal, absolute paths, backslashes, malformed hashes, and accessor refs", () => {
  const fx = fixture();
  try {
    const hash = `sha256:${"0".repeat(64)}`;
    for (const assetId of ["../secret", "/etc/passwd", "assets/a/./b", "assets/a//b", "assets/a\\b", "C:/outside", "assets/a/%2e%2e/b"]) {
      assert.throws(() => fx.store.read({ assetId, hash }), code("INVALID_REFERENCE"), assetId);
    }
    assert.throws(() => fx.store.read({ assetId: "assets/ok", hash: `sha256:${"A".repeat(64)}` }), code("INVALID_REFERENCE"));
    assert.throws(() => fx.store.read({ assetId: "design/maps.json", hash }), code("OUTSIDE_ASSET_ROOT"));
    const accessor = { hash };
    Object.defineProperty(accessor, "assetId", { enumerable: true, get() { throw new Error("must not execute"); } });
    assert.throws(() => fx.store.read(accessor), code("INVALID_REFERENCE"));
  } finally { fx.cleanup(); }
});

test("rejects parent and leaf symlinks, directories, and fifos", () => {
  const fx = fixture();
  const outside = mkdtempSync(join(tmpdir(), "limina-project-assets-outside-"));
  try {
    const secret = join(outside, "secret");
    writeFileSync(secret, "secret");
    symlinkSync(secret, join(fx.assetRoot, "leaf"));
    const secretRef = { assetId: "assets/leaf", hash: projectAssetHash(Buffer.from("secret")) };
    assert.throws(() => fx.store.read(secretRef), code("UNSAFE_PATH"));

    symlinkSync(outside, join(fx.assetRoot, "parent"), "dir");
    assert.throws(() => fx.store.read({ ...secretRef, assetId: "assets/parent/secret" }), code("UNSAFE_PATH"));

    mkdirSync(join(fx.assetRoot, "directory"));
    assert.throws(() => fx.store.read({ ...secretRef, assetId: "assets/directory" }), code("NOT_REGULAR"));

    const fifo = join(fx.assetRoot, "pipe");
    execFileSync("mkfifo", [fifo]);
    assert.throws(() => fx.store.read({ ...secretRef, assetId: "assets/pipe" }), code("NOT_REGULAR"));
  } finally {
    fx.cleanup();
    rmSync(outside, { recursive: true, force: true });
  }
});

test("canonical JSON reads require exact sorted bytes, UTF-8, and a trailing newline", () => {
  const fx = fixture();
  try {
    const canonical = Buffer.from('{"a":[true,null],"z":1}\n');
    const parsed = fx.store.readCanonicalJson(put(fx.assetRoot, "assets/canonical/good.json", canonical));
    assert.deepEqual(parsed, { a: [true, null], z: 1 });
    assert.equal(Object.isFrozen(parsed), true);
    assert.equal(Object.isFrozen(parsed.a), true);

    for (const [name, bytes] of [
      ["unsorted", Buffer.from('{"z":1,"a":2}\n')],
      ["whitespace", Buffer.from('{ "a": 2 }\n')],
      ["newline", Buffer.from('{"a":2}')],
      ["duplicate", Buffer.from('{"a":1,"a":2}\n')],
      ["negative-zero", Buffer.from('{"a":-0}\n')],
      ["invalid-utf8", Buffer.from([0xff, 0x0a])],
    ]) {
      const ref = put(fx.assetRoot, `assets/canonical/${name}.json`, bytes);
      assert.throws(() => fx.store.readCanonicalJson(ref), code("INVALID_CANONICAL_JSON"), name);
    }
  } finally { fx.cleanup(); }
});

test("domain-hashed canonical JSON requires an explicit validating hash function", () => {
  const fx = fixture();
  try {
    const bytes = Buffer.from('{"contentHash":"semantic","value":7}\n');
    const semanticHash = projectAssetHash(Buffer.from("domain:value:7"));
    const ref = put(fx.assetRoot, "assets/canonical/domain.json", bytes);
    const semanticRef = { ...ref, hash: semanticHash };
    assert.throws(() => fx.store.readCanonicalJson(semanticRef), code("HASH_MISMATCH"));
    const parsed = fx.store.readCanonicalJson(semanticRef, {
      contentHashOf(value) {
        assert.equal(value.value, 7);
        return projectAssetHash(Buffer.from(`domain:value:${value.value}`));
      },
    });
    assert.equal(parsed.value, 7);
    assert.throws(() => fx.store.readCanonicalJson(semanticRef, {
      contentHashOf() { return `sha256:${"f".repeat(64)}`; },
    }), code("HASH_MISMATCH"));
  } finally { fx.cleanup(); }
});

test("construction fails closed for symlinked or escaping roots", () => {
  const fx = fixture();
  const outside = mkdtempSync(join(tmpdir(), "limina-project-root-outside-"));
  try {
    const link = join(fx.projectRoot, "linked-assets");
    symlinkSync(outside, link, "dir");
    assert.throws(
      () => new ProjectAssetStore({ projectId: "asset-fixture", projectRoot: fx.projectRoot, assetRoot: link }),
      code("INVALID_ROOT"),
    );
    assert.throws(
      () => new ProjectAssetStore({ projectId: "asset-fixture", projectRoot: fx.projectRoot, assetRoot: outside }),
      code("INVALID_ROOT"),
    );
  } finally {
    fx.cleanup();
    rmSync(outside, { recursive: true, force: true });
  }
});
