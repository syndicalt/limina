import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  AtlasMapDocBridge,
  AtlasSourceBridgeError,
  canonicalMapDocBytes,
  workspaceRevision,
} from "./atlas-source-bridge.mjs";

const hash = (value) => `sha256:${createHash("sha256").update(String(value)).digest("hex")}`;
const canonical = (value) => {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
};
const canonicalHash = (value) => `sha256:${createHash("sha256").update(canonical(value)).digest("hex")}`;

function mapDoc(name = "Primary") {
  return {
    version: 2,
    activeMapId: "primary",
    maps: [{
      id: "primary",
      name,
      scope: "site",
      parent: null,
      features: [],
      units: { kind: "m", unitsPerMeter: 1, origin: [0, 0] },
    }],
  };
}

function fixture() {
  const projectRoot = mkdtempSync(join(tmpdir(), "limina-atlas-bridge-"));
  const vaultDir = join(projectRoot, "design");
  const assetRoot = join(projectRoot, "assets");
  mkdirSync(vaultDir);
  mkdirSync(assetRoot);
  const initial = Buffer.from(`${JSON.stringify(mapDoc(), null, 2)}\n`);
  writeFileSync(join(vaultDir, "maps.json"), initial);
  return {
    projectRoot,
    vaultDir,
    assetRoot,
    initial,
    projectConfig: { projectId: "test-project", projectRoot },
    cleanup: () => rmSync(projectRoot, { recursive: true, force: true }),
  };
}

class FakeAuthority {
  constructor() {
    this.head = { schema: "limina.world-project-head/v1", projectId: "test-project", revision: 0, headHash: hash("genesis") };
    this.mapDoc = null;
    this.stateHash = hash("state:0");
    this.commits = [];
    this.beforeCommit = undefined;
    this.commitFailure = undefined;
    this.previousRecordHash = null;
    this.mutateCommitResult = undefined;
  }

  async callTool(name, args, options) {
    if (name === "authoring.head") return { ...this.head };
    if (name === "authoring.projectState") {
      return {
        schema: "limina.world-project-state/v1",
        projectId: "test-project",
        refs: { mapDoc: this.mapDoc, terrainEditLayers: [], scene: null, assets: [], lookProfile: null },
        stateHash: this.stateHash,
      };
    }
    assert.equal(name, "authoring.commit");
    assert.deepEqual(options, { retryTransport: true });
    await this.beforeCommit?.(args.transaction);
    if (this.commitFailure) throw this.commitFailure;
    const transaction = structuredClone(args.transaction);
    this.commits.push(transaction);
    const previous = this.head;
    const mapDocRef = transaction.operations[0].input.patch.mapDoc;
    this.mapDoc = structuredClone(mapDocRef);
    this.stateHash = canonicalHash({
      schema: "limina.world-project-state/v1",
      projectId: "test-project",
      refs: { mapDoc: this.mapDoc, terrainEditLayers: [], scene: null, assets: [], lookProfile: null },
    });
    const transactionHash = canonicalHash(transaction);
    const operationReceipts = [{
      index: 0,
      adapter: "project-state",
      action: "refs.patch",
      stateKey: "world-project:test-project:refs",
      beforeStateHash: transaction.operations[0].guard.beforeHash,
      afterStateHash: this.stateHash,
    }];
    this.head = {
      ...previous,
      revision: previous.revision + 1,
      headHash: canonicalHash({
        schema: "limina.world-project-head/v1",
        projectId: "test-project",
        revision: previous.revision + 1,
        parentHash: previous.headHash,
        transactionHash,
        operations: operationReceipts,
      }),
    };
    const receipt = {
      schema: "limina.authoring-receipt/v1",
      transactionId: transaction.transactionId,
      projectId: "test-project",
      transactionHash,
      previousRevision: previous.revision,
      committedRevision: this.head.revision,
      previousHeadHash: previous.headHash,
      headHash: this.head.headHash,
      operations: operationReceipts,
    };
    const commitRecord = {
      schema: "limina.authoring-commit-record/v1",
      previousRecordHash: this.previousRecordHash,
      receipt,
      recordHash: canonicalHash({
        schema: "limina.authoring-commit-record/v1",
        previousRecordHash: this.previousRecordHash,
        receipt,
      }),
    };
    this.previousRecordHash = commitRecord.recordHash;
    const result = {
      committed: true,
      commitRecord,
      receipt,
    };
    this.mutateCommitResult?.(result);
    return result;
  }
}

function bridge(fx, authority, overrides = {}) {
  return new AtlasMapDocBridge({
    projectConfig: fx.projectConfig,
    vaultDir: fx.vaultDir,
    assetRoot: fx.assetRoot,
    authoringClient: authority,
    ...overrides,
  });
}

test("persists canonical content-addressed MapDoc, commits its exact ref, then mirrors", async () => {
  const fx = fixture();
  try {
    const authority = new FakeAuthority();
    let committedAtMirror = false;
    const original = readFileSync(join(fx.vaultDir, "maps.json"));
    const result = await bridge(fx, authority, {
      mirrorWriter(path, bytes) {
        committedAtMirror = authority.commits.length === 1;
        writeFileSync(path, bytes);
      },
    }).save({ maps: mapDoc("Changed").maps, activeMapId: "primary", baseRev: workspaceRevision(original) });

    assert.equal(result.ok, true);
    assert.equal(result.authoring.committed, true);
    assert.equal(committedAtMirror, true);
    assert.equal(authority.commits.length, 1);
    const operation = authority.commits[0].operations[0];
    assert.equal(operation.adapter, "project-state");
    assert.equal(operation.action, "refs.patch");
    assert.equal(operation.guard.beforeHash, hash("state:0"));
    assert.deepEqual(operation.input.patch.mapDoc, result.source);
    const sourcePath = join(fx.projectRoot, result.source.assetId);
    const sourceBytes = readFileSync(sourcePath);
    assert.equal(`sha256:${createHash("sha256").update(sourceBytes).digest("hex")}`, result.source.hash);
    assert.equal(sourceBytes.at(-1), 0x0a);
    assert.equal(JSON.parse(sourceBytes).maps[0].name, "Changed");
    assert.equal(JSON.parse(readFileSync(join(fx.vaultDir, "maps.json"))).maps[0].name, "Changed");
  } finally { fx.cleanup(); }
});

test("repeated identical saves reuse one source and do not churn the authoritative revision", async () => {
  const fx = fixture();
  try {
    const authority = new FakeAuthority();
    const atlas = bridge(fx, authority);
    const first = await atlas.save({ maps: mapDoc("Same").maps, activeMapId: "primary", baseRev: workspaceRevision(fx.initial) });
    const second = await atlas.save({ maps: mapDoc("Same").maps, activeMapId: "primary", baseRev: first.mapsRev });
    assert.equal(authority.commits.length, 1);
    assert.equal(second.authoring.committed, false);
    assert.deepEqual(second.source, first.source);
    assert.equal(authority.head.revision, 1);
  } finally { fx.cleanup(); }
});

test("a stale workspace is rejected before source persistence or authority access", async () => {
  const fx = fixture();
  try {
    let sourceWrites = 0;
    let authorityCalls = 0;
    const atlas = bridge(fx, { callTool() { authorityCalls++; } }, { sourceWriter() { sourceWrites++; } });
    await assert.rejects(atlas.save({ maps: mapDoc("Stale").maps, activeMapId: "primary", baseRev: "stale" }), (error) => {
      assert.equal(error.code, "workspace_stale");
      assert.equal(error.status, 409);
      return true;
    });
    assert.equal(sourceWrites, 0);
    assert.equal(authorityCalls, 0);
  } finally { fx.cleanup(); }
});

test("source and authority failures preserve their ordering guarantees", async () => {
  const fx = fixture();
  try {
    const sourceAuthority = new FakeAuthority();
    await assert.rejects(bridge(fx, sourceAuthority, { sourceWriter() { throw new Error("disk full"); } }).save({
      maps: mapDoc("Source fail").maps, activeMapId: "primary", baseRev: workspaceRevision(fx.initial),
    }), (error) => error.code === "source_persist_failed");
    assert.equal(sourceAuthority.commits.length, 0);
    assert.deepEqual(readFileSync(join(fx.vaultDir, "maps.json")), fx.initial);

    const conflictAuthority = new FakeAuthority();
    const conflict = new Error("stale head");
    conflict.code = -32009;
    conflictAuthority.commitFailure = conflict;
    let conflictError;
    try {
      await bridge(fx, conflictAuthority).save({ maps: mapDoc("Conflict").maps, activeMapId: "primary", baseRev: workspaceRevision(fx.initial) });
    } catch (error) { conflictError = error; }
    assert.equal(conflictError.code, "authoring_conflict");
    assert.equal(conflictError.status, 409);
    assert.equal(existsSync(join(fx.projectRoot, conflictError.details.source.assetId)), true);
    assert.deepEqual(readFileSync(join(fx.vaultDir, "maps.json")), fx.initial);

  } finally { fx.cleanup(); }
});

test("invalid durable commit evidence is rejected before workspace publication", async () => {
  const fx = fixture();
  try {
    const authority = new FakeAuthority();
    authority.mutateCommitResult = (result) => { result.commitRecord.recordHash = hash("tampered-record"); };
    await assert.rejects(
      bridge(fx, authority).save({ maps: mapDoc("Tampered").maps, activeMapId: "primary", baseRev: workspaceRevision(fx.initial) }),
      (error) => error.code === "invalid_authority_response" && /durable commit evidence/.test(error.message),
    );
    assert.equal(authority.commits.length, 1);
    assert.deepEqual(readFileSync(join(fx.vaultDir, "maps.json")), fx.initial);
  } finally { fx.cleanup(); }
});

test("retry after committed mirror failure repairs maps.json without revision churn", async () => {
  const fx = fixture();
  try {
    const mirrorAuthority = new FakeAuthority();
    let mirrorError;
    try {
      await bridge(fx, mirrorAuthority, { mirrorWriter() { throw new Error("read-only mirror"); } }).save({
        maps: mapDoc("Mirror fail").maps, activeMapId: "primary", baseRev: workspaceRevision(fx.initial),
      });
    } catch (error) { mirrorError = error; }
    assert.equal(mirrorError.code, "workspace_mirror_failed");
    assert.equal(mirrorError.status, 503);
    assert.equal(mirrorError.committed, true);
    assert.equal(mirrorAuthority.commits.length, 1);
    assert.deepEqual(readFileSync(join(fx.vaultDir, "maps.json")), fx.initial);

    const repaired = await bridge(fx, mirrorAuthority).save({
      maps: mapDoc("Mirror fail").maps,
      activeMapId: "primary",
      baseRev: workspaceRevision(fx.initial),
    });
    assert.equal(repaired.authoring.committed, false);
    assert.equal(mirrorAuthority.commits.length, 1);
    assert.equal(mirrorAuthority.head.revision, 1);
    assert.deepEqual(repaired.source, mirrorError.details.source);
    assert.equal(JSON.parse(readFileSync(join(fx.vaultDir, "maps.json"))).maps[0].name, "Mirror fail");
  } finally { fx.cleanup(); }
});

test("two bridge instances cannot race the same workspace publication", async () => {
  const fx = fixture();
  try {
    const authority = new FakeAuthority();
    let release;
    const held = new Promise((resolve) => { release = resolve; });
    let entered;
    const enteredPromise = new Promise((resolve) => { entered = resolve; });
    authority.beforeCommit = async () => { entered(); await held; };
    const first = bridge(fx, authority).save({ maps: mapDoc("Winner").maps, activeMapId: "primary", baseRev: workspaceRevision(fx.initial) });
    await enteredPromise;
    await assert.rejects(
      bridge(fx, authority).save({ maps: mapDoc("Loser").maps, activeMapId: "primary", baseRev: workspaceRevision(fx.initial) }),
      (error) => error.code === "workspace_busy" && error.status === 423,
    );
    release();
    await first;
    assert.equal(authority.commits.length, 1);
    assert.equal(JSON.parse(readFileSync(join(fx.vaultDir, "maps.json"))).maps[0].name, "Winner");
  } finally { fx.cleanup(); }
});

test("dead-owner locks recover, while symlink boundaries fail closed", async () => {
  const fx = fixture();
  const outside = mkdtempSync(join(tmpdir(), "limina-atlas-outside-"));
  try {
    const lock = join(fx.vaultDir, ".atlas-map-save.lock");
    mkdirSync(lock);
    await assert.rejects(
      bridge(fx, new FakeAuthority()).save({ maps: mapDoc("Busy").maps, activeMapId: "primary", baseRev: workspaceRevision(fx.initial) }),
      (error) => error.code === "workspace_busy" && error.status === 423,
    );
    rmSync(lock, { recursive: true });
    writeFileSync(lock, JSON.stringify({ pid: 2_147_483_647, token: "a".repeat(32), createdAt: new Date().toISOString() }));
    const authority = new FakeAuthority();
    await bridge(fx, authority).save({ maps: mapDoc("Recovered").maps, activeMapId: "primary", baseRev: workspaceRevision(fx.initial) });
    assert.equal(authority.commits.length, 1);

    rmSync(fx.assetRoot, { recursive: true });
    symlinkSync(outside, fx.assetRoot, "dir");
    assert.throws(() => bridge(fx, new FakeAuthority()), (error) => error.code === "invalid_project_path");

    rmSync(fx.assetRoot);
    mkdirSync(fx.assetRoot);
    rmSync(join(fx.vaultDir, "maps.json"));
    const outsideMap = join(outside, "maps.json");
    writeFileSync(outsideMap, fx.initial);
    symlinkSync(outsideMap, join(fx.vaultDir, "maps.json"));
    const symlinkAuthority = new FakeAuthority();
    await assert.rejects(
      bridge(fx, symlinkAuthority).save({ maps: mapDoc("Escape").maps, activeMapId: "primary", baseRev: workspaceRevision(fx.initial) }),
      (error) => error.code === "workspace_read_failed",
    );
    assert.equal(symlinkAuthority.commits.length, 0);
    assert.deepEqual(readFileSync(outsideMap), fx.initial);
  } finally {
    fx.cleanup();
    rmSync(outside, { recursive: true, force: true });
  }
});

test("canonical MapDoc bytes reject accessors, symbols, non-enumerable fields, and custom arrays", () => {
  const accessor = { ok: true };
  Object.defineProperty(accessor, "secret", { enumerable: true, get() { throw new Error("must not execute"); } });
  assert.throws(() => canonicalMapDocBytes(accessor), /enumerable data property/);
  const symbol = { ok: true, [Symbol("hidden")]: true };
  assert.throws(() => canonicalMapDocBytes(symbol), /symbol properties/);
  const hidden = { ok: true };
  Object.defineProperty(hidden, "hidden", { value: true, enumerable: false });
  assert.throws(() => canonicalMapDocBytes(hidden), /enumerable data property/);
  const custom = [1];
  custom.extra = 2;
  assert.throws(() => canonicalMapDocBytes(custom), /sparse or custom array/);
  const protoKey = JSON.parse('{"__proto__":{"polluted":true},"a":1}');
  assert.deepEqual(JSON.parse(canonicalMapDocBytes(protoKey)), protoKey);
  assert.equal({}.polluted, undefined);
});
