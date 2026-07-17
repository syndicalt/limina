import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { createTerrainGridSpec, terrainChunkId } from "../../js/src/terrain/grid.mjs";
import {
  COMPILER_SNAPSHOT_SCHEMA,
  DERIVED_REVISION_MANIFEST_SCHEMA,
  compilerContentHash,
  createDerivedRevisionManifest,
  derivedArtifactContentHash,
} from "../../js/src/world/compiler/index.mjs";
import {
  BIOME_CONTENT_CLOSURE_ARTIFACT_MEDIA_TYPE,
  BIOME_CONTENT_CLOSURE_ARTIFACT_TYPE,
  encodeBiomeContentClosureArtifact,
} from "../../js/src/world/compiler/biome-content-closure-artifact.mjs";
import { BIOME_CONTENT_BUNDLE_SCHEMA, deriveBiomeContentBundleClosureHash } from "../../js/src/world/biome-content-bundle.mjs";
import { portableAssetContentHash } from "../../js/src/world/asset-content-hash.mjs";
import { publishDerivedRevision } from "./derived-publisher.mjs";
import {
  DERIVED_RUNTIME_CURRENT_RATE_CAPACITY,
  DERIVED_RUNTIME_CURRENT_SCHEMA,
  DerivedRuntimeServer,
} from "./derived-runtime-server.mjs";

const ORIGIN = "http://localhost:5173";
const TOKEN = new Uint8Array(32).fill(0x5a);

function hash(label) { return compilerContentHash({ label }); }

function projectFixture() {
  const root = mkdtempSync(join(tmpdir(), "limina-derived-runtime-"));
  mkdirSync(join(root, "assets"));
  mkdirSync(join(root, ".limina"));
  writeFileSync(join(root, "limina.project.json"), `${JSON.stringify({
    schema: "limina-project/1",
    projectId: "grey-field",
    assetRoot: "assets",
    stateDir: ".limina",
  })}\n`);
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function revisionFixture(tag, source, artifactBytes = Buffer.from(`artifact:${tag}`)) {
  const bytes = new Uint8Array(artifactBytes);
  const contentHash = derivedArtifactContentHash(bytes);
  const grid = createTerrainGridSpec({ gridId: "grey-field.surface", origin: [0, 0], chunkSizeM: 64, defaultSamples: 65 });
  const chunkId = terrainChunkId(grid.gridId, 0, 0, 0);
  const graphHash = hash("graph:runtime");
  const snapshotCore = {
    schema: COMPILER_SNAPSHOT_SCHEMA,
    graphHash,
    chunks: [{ chunkId, gridId: grid.gridId, lod: 0, tx: 0, tz: 0, chunkTopologyHash: hash(`topology:${tag}`) }],
    stageKeys: { render: { [chunkId]: hash(`render:${tag}`) } },
  };
  const snapshot = { ...snapshotCore, snapshotHash: compilerContentHash(snapshotCore) };
  const manifest = createDerivedRevisionManifest({
    schema: DERIVED_REVISION_MANIFEST_SCHEMA,
    projectId: "grey-field",
    branchId: "main",
    source: {
      revision: source.revision,
      headHash: source.headHash,
      contentRefs: [{
        refId: "map-document", refType: "map-document/v1", scope: "global",
        assetId: "design/maps/grey-field.json", contentHash: hash(`map:${source.revision}`),
      }],
    },
    compiler: {
      version: "1.0.0", configHash: hash(`config:${tag}`), graphHash, snapshotHash: snapshot.snapshotHash,
    },
    grid,
    globalArtifacts: [],
    chunks: [{
      chunkId, gridId: grid.gridId, lod: 0, tx: 0, tz: 0,
      topologyHash: hash(`topology:${tag}`), sourceSliceHashes: [],
      artifacts: [{ artifactType: "terrain-chunk/v1", contentHash, byteLength: bytes.byteLength, mediaType: "application/vnd.limina.terrain-chunk" }],
    }],
  });
  return { manifest, snapshot, bytes, contentHash };
}

async function publish(root, fixture, jobId, readHead) {
  return publishDerivedRevision({
    projectRoot: root,
    jobId,
    manifest: fixture.manifest,
    snapshot: fixture.snapshot,
    artifacts: fixture.artifacts ?? [{ contentHash: fixture.contentHash, bytes: fixture.bytes }],
    ...(fixture.contentEntries === undefined ? {} : { contentEntries: fixture.contentEntries }),
    readHead,
  });
}

function contentRevisionFixture(tag, source, contentBytes = randomBytes(1024 * 1024 + 73), status = "candidate") {
  const base = revisionFixture(tag, source);
  const bytes = new Uint8Array(contentBytes);
  const engineHash = portableAssetContentHash(bytes);
  const entry = {
    assetId: `models/${tag}.glb`, contentHash: engineHash, kind: "model-source", byteLength: bytes.byteLength,
    provenance: { licenseSpdx: "CC0-1.0", sourceUri: `limina://test/${tag}` },
  };
  const draft = {
    schema: BIOME_CONTENT_BUNDLE_SCHEMA, id: `test-${tag}`, version: "1.0.0", status,
    runtimePack: { assetId: `biomes/${tag}.json`, contentHash: hash(`runtime-pack:${tag}`) },
    entries: [entry],
  };
  const bundle = { ...draft, closureHash: deriveBiomeContentBundleClosureHash(draft) };
  const closureBytes = encodeBiomeContentClosureArtifact(bundle);
  const closureContentHash = derivedArtifactContentHash(closureBytes);
  const { manifestHash: _oldHash, ...core } = base.manifest;
  const manifest = createDerivedRevisionManifest({ ...core, globalArtifacts: [{
    artifactType: BIOME_CONTENT_CLOSURE_ARTIFACT_TYPE,
    contentHash: closureContentHash,
    byteLength: closureBytes.byteLength,
    mediaType: BIOME_CONTENT_CLOSURE_ARTIFACT_MEDIA_TYPE,
  }] });
  return {
    ...base, manifest, engineHash, contentBytes: bytes, closureBytes, closureContentHash,
    artifacts: [
      { contentHash: base.contentHash, bytes: base.bytes },
      { contentHash: closureContentHash, bytes: closureBytes },
    ],
    contentEntries: [{ id: entry.assetId, path: `assets/${entry.assetId}`, hash: engineHash, bytes }],
  };
}

function artifactPath(root, contentHash) {
  return join(root, ".limina", "derived", "main", "artifacts", `${contentHash.slice(7)}.bin`);
}

function manifestPath(root, manifestHash) {
  return join(root, ".limina", "derived", "main", "manifests", `${manifestHash.slice(7)}.json`);
}

function snapshotPath(root, snapshotHash) {
  return join(root, ".limina", "derived", "main", "snapshots", `${snapshotHash.slice(7)}.json`);
}

async function startServer(root, readHead, options = {}) {
  const server = new DerivedRuntimeServer({
    projectId: "grey-field",
    projectRoot: root,
    branchId: "main",
    readHead,
    token: options.token ?? TOKEN,
    port: 0,
    allowedHosts: options.allowedHosts ?? ["127.0.0.1"],
    allowedOrigins: options.allowedOrigins ?? [ORIGIN],
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  const owner = await server.start();
  return { server, owner };
}

function bearer(owner) { return `Bearer ${owner.token}`; }

function http(owner, path, options = {}) {
  const target = new URL(path, owner.baseUrl);
  return new Promise((resolve, reject) => {
    const req = httpRequest({
      hostname: target.hostname,
      port: target.port,
      path: `${target.pathname}${target.search}`,
      method: options.method ?? "GET",
      headers: {
        Host: options.host ?? target.host,
        Origin: options.origin ?? ORIGIN,
        ...(options.auth === false ? {} : { Authorization: options.authorization ?? bearer(owner) }),
        ...(options.headers ?? {}),
      },
    }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
      res.on("error", reject);
    });
    req.on("error", reject);
    if (options.body !== undefined) req.write(options.body);
    req.end();
  });
}

function artifactUrl(fixture, contentHash = fixture.contentHash) {
  return `/v1/derived/manifests/${fixture.manifest.manifestHash.slice(7)}/artifacts/${contentHash.slice(7)}`;
}

function contentUrl(fixture, engineHash = fixture.engineHash) {
  return `/v1/derived/manifests/${fixture.manifest.manifestHash.slice(7)}/content/${engineHash.slice(7)}`;
}

function contentPath(root, engineHash) {
  return join(root, ".limina", "derived", "main", "content", `${engineHash.slice(7)}.bin`);
}

function openPausedArtifact(running, fixture) {
  return new Promise((resolve, reject) => {
    const target = new URL(artifactUrl(fixture), running.owner.baseUrl);
    const req = httpRequest({ hostname: target.hostname, port: target.port, path: target.pathname, headers: {
      Host: target.host, Origin: ORIGIN, Authorization: bearer(running.owner),
    } }, (res) => { res.on("error", () => {}); res.pause(); resolve({ req, res, status: res.statusCode }); });
    req.on("error", reject);
    req.end();
  });
}

function errorCode(response) {
  return response.body.byteLength === 0 ? undefined : JSON.parse(response.body.toString("utf8")).code;
}

test("current endpoint is capability-scoped, CORS-bounded, bodyless, current-only, and cache-correct", async () => {
  const fx = projectFixture();
  const source = { revision: 7, headHash: hash("head:7") };
  const fixture = revisionFixture("current", source);
  const authority = () => ({ projectId: "grey-field", branchId: "main", ...source });
  let running;
  try {
    await publish(fx.root, fixture, "job-current", authority);
    running = await startServer(fx.root, authority);
    assert.equal((await http(running.owner, "/v1/derived/current", { auth: false })).status, 401);
    assert.equal((await http(running.owner, "/v1/derived/current", { authorization: `Bearer ${Buffer.alloc(32).toString("base64url")}` })).status, 401);
    assert.equal((await http(running.owner, "/v1/derived/current", { origin: "http://evil.invalid" })).status, 403);
    assert.equal((await http(running.owner, "/v1/derived/current", { host: "localhost:1" })).status, 403);
    assert.equal((await http(running.owner, "/v1/derived/current", { method: "POST" })).status, 405);
    assert.equal((await http(running.owner, "/v1/derived/current", { headers: { "Content-Length": "1" }, body: "x" })).status, 400);
    assert.equal((await http(running.owner, `/${"x".repeat(2200)}`)).status, 400);
    assert.equal((await http(running.owner, "/v1/derived/%2e%2e/secret")).status, 404);
    assert.equal((await http(running.owner, "/v1/derived/unknown")).status, 404);

    const preflight = await http(running.owner, "/v1/derived/current", {
      method: "OPTIONS", auth: false,
      headers: { "Access-Control-Request-Method": "GET", "Access-Control-Request-Headers": "authorization, if-none-match" },
    });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers["access-control-allow-origin"], ORIGIN);
    assert.equal(preflight.headers["access-control-allow-credentials"], undefined);

    const current = await http(running.owner, "/v1/derived/current");
    assert.equal(current.status, 200);
    assert.equal(current.headers["cache-control"], "no-store");
    assert.equal(current.headers["cross-origin-resource-policy"], "cross-origin");
    assert.equal(
      current.headers["access-control-expose-headers"],
      "ETag, X-Limina-Content-Hash, X-Limina-Generation, X-Limina-Head-Hash, X-Limina-Manifest-Hash, X-Limina-Revision",
    );
    const body = JSON.parse(current.body.toString("utf8"));
    assert.deepEqual(Object.keys(body).sort(), ["branchId", "generation", "manifest", "projectId", "schema", "source"]);
    assert.equal(body.schema, DERIVED_RUNTIME_CURRENT_SCHEMA);
    assert.equal(body.manifest.manifestHash, fixture.manifest.manifestHash);
    assert.deepEqual(body.source, source);
    assert.equal(JSON.stringify(body).includes(fx.root), false);

    const head = await http(running.owner, "/v1/derived/current", { method: "HEAD" });
    assert.equal(head.status, 200);
    assert.equal(head.body.byteLength, 0);
    assert.equal(head.headers.etag, current.headers.etag);
    assert.equal(head.headers["content-length"], current.headers["content-length"]);
    const unchanged = await http(running.owner, "/v1/derived/current", { headers: { "If-None-Match": current.headers.etag } });
    assert.equal(unchanged.status, 304);
    assert.equal(unchanged.body.byteLength, 0);
    await publish(fx.root, fixture, "job-current-identical", authority);
    const republished = await http(running.owner, "/v1/derived/current", { headers: { "If-None-Match": current.headers.etag } });
    assert.equal(republished.status, 200, "a new pointer generation must not reuse the prior current ETag");
    assert.equal(JSON.parse(republished.body.toString("utf8")).generation, 2);
    assert.notEqual(republished.headers.etag, current.headers.etag);
  } finally {
    await running?.server.stop();
    fx.cleanup();
  }
});

for (const target of ["manifest", "snapshot"]) {
  test(`runtime cache invalidates when the installed current ${target} changes`, async () => {
    const fx = projectFixture();
    const source = { revision: 17, headHash: hash(`head:cache-${target}`) };
    const fixture = revisionFixture(`cache-${target}`, source);
    const authority = () => ({ projectId: "grey-field", branchId: "main", ...source });
    let running;
    try {
      await publish(fx.root, fixture, `job-cache-${target}`, authority);
      running = await startServer(fx.root, authority);
      assert.equal((await http(running.owner, "/v1/derived/current")).status, 200);
      const path = target === "manifest"
        ? manifestPath(fx.root, fixture.manifest.manifestHash)
        : snapshotPath(fx.root, fixture.snapshot.snapshotHash);
      writeFileSync(path, "{\"corrupt\":true}\n");
      const response = await http(running.owner, "/v1/derived/current");
      assert.equal(response.status, 503);
      assert.equal(errorCode(response), "PUBLICATION_UNAVAILABLE");
    } finally {
      await running?.server.stop();
      fx.cleanup();
    }
  });
}

test("runtime cache rejects a manifest changed while authoritative head validation is in flight", async () => {
  const fx = projectFixture();
  const source = { revision: 17, headHash: hash("head:cache-authority-race") };
  const fixture = revisionFixture("cache-authority-race", source);
  let mutateDuringHead = false;
  const authority = () => {
    if (mutateDuringHead) {
      mutateDuringHead = false;
      writeFileSync(manifestPath(fx.root, fixture.manifest.manifestHash), "{\"corrupt\":true}\n");
    }
    return { projectId: "grey-field", branchId: "main", ...source };
  };
  let running;
  try {
    await publish(fx.root, fixture, "job-cache-authority-race", authority);
    running = await startServer(fx.root, authority);
    assert.equal((await http(running.owner, "/v1/derived/current")).status, 200);
    mutateDuringHead = true;
    const response = await http(running.owner, "/v1/derived/current");
    assert.equal(response.status, 409);
    assert.equal(errorCode(response), "CURRENT_CHANGED");
  } finally {
    await running?.server.stop();
    fx.cleanup();
  }
});

test("runtime endpoint never serves stale, absent, corrupt-current, or fallback publication", async () => {
  const empty = projectFixture();
  const source = { revision: 1, headHash: hash("head:1") };
  const authority = () => ({ projectId: "grey-field", branchId: "main", ...source });
  let emptyServer;
  try {
    emptyServer = await startServer(empty.root, authority);
    const response = await http(emptyServer.owner, "/v1/derived/current");
    assert.equal(response.status, 404);
    assert.equal(errorCode(response), "NO_PUBLICATION");
  } finally { await emptyServer?.server.stop(); empty.cleanup(); }

  const fx = projectFixture();
  let currentSource = { revision: 2, headHash: hash("head:2") };
  const readHead = () => ({ projectId: "grey-field", branchId: "main", ...currentSource });
  let running;
  try {
    const first = revisionFixture("first", currentSource);
    await publish(fx.root, first, "job-first", readHead);
    running = await startServer(fx.root, readHead);
    currentSource = { revision: 3, headHash: hash("head:3") };
    const stale = await http(running.owner, "/v1/derived/current");
    assert.equal(stale.status, 409);
    assert.equal(errorCode(stale), "NOT_CURRENT");
    await running.server.stop();

    const second = revisionFixture("second", currentSource);
    await publish(fx.root, second, "job-second", readHead);
    unlinkSync(join(fx.root, ".limina", "derived", "main", "manifests", `${second.manifest.manifestHash.slice(7)}.json`));
    running = await startServer(fx.root, readHead);
    const fallbackRejected = await http(running.owner, "/v1/derived/current");
    assert.equal(fallbackRejected.status, 503);
    assert.equal(errorCode(fallbackRejected), "PUBLICATION_UNAVAILABLE");
  } finally { await running?.server.stop(); fx.cleanup(); }
});

test("artifact endpoint streams referenced multi-megabyte bytes exactly and rejects arbitrary CAS access", async () => {
  const fx = projectFixture();
  const source = { revision: 4, headHash: hash("head:4") };
  const bytes = randomBytes(5 * 1024 * 1024 + 137);
  const fixture = revisionFixture("large", source, bytes);
  const authority = () => ({ projectId: "grey-field", branchId: "main", ...source });
  let running;
  try {
    await publish(fx.root, fixture, "job-large", authority);
    running = await startServer(fx.root, authority);
    const path = artifactUrl(fixture);
    const response = await http(running.owner, path);
    assert.equal(response.status, 200);
    assert.deepEqual(response.body, bytes);
    assert.equal(response.headers["content-type"], "application/vnd.limina.terrain-chunk");
    assert.equal(response.headers["content-length"], String(bytes.byteLength));
    assert.equal(response.headers["cache-control"], "private, max-age=31536000, immutable");

    const unchanged = await http(running.owner, path, { headers: { "If-None-Match": response.headers.etag } });
    assert.equal(unchanged.status, 304);
    assert.equal((await http(running.owner, path, { method: "HEAD" })).status, 405);
    assert.equal((await http(running.owner, path, { headers: { Range: "bytes=0-9" } })).status, 416);
    const unknown = `sha256:${"f".repeat(64)}`;
    assert.equal((await http(running.owner, artifactUrl(fixture, unknown))).status, 404);
    assert.equal((await http(running.owner, `/v1/derived/manifests/${"e".repeat(64)}/artifacts/${fixture.contentHash.slice(7)}`)).status, 412);
    assert.equal((await http(running.owner, `/v1/derived/manifests/../../artifacts/${fixture.contentHash.slice(7)}`)).status, 404);
  } finally { await running?.server.stop(); fx.cleanup(); }
});

for (const status of ["candidate", "accepted"]) {
  test(`content endpoint serves only the exact current ${status} closure`, async () => {
    const fx = projectFixture();
    const source = { revision: 40, headHash: hash(`head:content-${status}`) };
    const fixture = contentRevisionFixture(`content-${status}`, source, randomBytes(2 * 1024 * 1024 + 91), status);
    const authority = () => ({ projectId: "grey-field", branchId: "main", ...source });
    let running;
    try {
      await publish(fx.root, fixture, `job-content-${status}`, authority);
      running = await startServer(fx.root, authority);
      const path = contentUrl(fixture);
      assert.equal((await http(running.owner, path, { auth: false })).status, 401);
      assert.equal((await http(running.owner, path, { origin: "http://evil.invalid" })).status, 403);
      const preflight = await http(running.owner, path, { method: "OPTIONS", auth: false,
        headers: { "Access-Control-Request-Method": "GET", "Access-Control-Request-Headers": "authorization, if-none-match" } });
      assert.equal(preflight.status, 204);

      const response = await http(running.owner, path);
      assert.equal(response.status, 200);
      assert.deepEqual(response.body, Buffer.from(fixture.contentBytes));
      assert.equal(response.headers["content-type"], "application/octet-stream");
      assert.equal(response.headers["content-length"], String(fixture.contentBytes.byteLength));
      assert.equal(response.headers["x-limina-content-hash"], fixture.engineHash);
      assert.equal(response.headers["x-limina-manifest-hash"], fixture.manifest.manifestHash);
      assert.equal(response.headers["cache-control"], "private, max-age=31536000, immutable");

      const unchanged = await http(running.owner, path, { headers: { "If-None-Match": response.headers.etag } });
      assert.equal(unchanged.status, 304);
      assert.equal(unchanged.body.byteLength, 0);
      assert.equal((await http(running.owner, path, { method: "HEAD" })).status, 405);
      assert.equal((await http(running.owner, path, { headers: { Range: "bytes=0-9" } })).status, 416);
      assert.equal((await http(running.owner,
        `/v1/derived/manifests/${"e".repeat(64)}/content/${fixture.engineHash.slice(7)}`)).status, 412);
    } finally { await running?.server.stop(); fx.cleanup(); }
  });
}

test("content endpoint rejects an installed but closure-unreferenced engine hash with a fixed 404", async () => {
  const fx = projectFixture();
  const source = { revision: 41, headHash: hash("head:content-unreferenced") };
  const fixture = contentRevisionFixture("content-unreferenced", source);
  const authority = () => ({ projectId: "grey-field", branchId: "main", ...source });
  let running;
  try {
    await publish(fx.root, fixture, "job-content-unreferenced", authority);
    const arbitraryBytes = new Uint8Array(Buffer.from("installed but not closure authorized"));
    const arbitraryHash = portableAssetContentHash(arbitraryBytes);
    writeFileSync(contentPath(fx.root, arbitraryHash), arbitraryBytes);
    running = await startServer(fx.root, authority);
    const response = await http(running.owner, contentUrl(fixture, arbitraryHash));
    assert.equal(response.status, 404);
    assert.equal(errorCode(response), "NOT_FOUND");
    assert.deepEqual(JSON.parse(response.body.toString("utf8")), {
      schema: "limina.derived-runtime-error/v1", code: "NOT_FOUND", message: "derived runtime resource was not found",
    });
  } finally { await running?.server.stop(); fx.cleanup(); }
});

test("content endpoint rejects tampered installed bytes and never falls back to the live asset root", async () => {
  const fx = projectFixture();
  const source = { revision: 42, headHash: hash("head:content-tamper") };
  const fixture = contentRevisionFixture("content-tamper", source, randomBytes(1024 * 1024 + 17));
  const authority = () => ({ projectId: "grey-field", branchId: "main", ...source });
  let running;
  try {
    await publish(fx.root, fixture, "job-content-tamper", authority);
    running = await startServer(fx.root, authority);
    assert.equal((await http(running.owner, contentUrl(fixture))).status, 200, "warm current content did not serve");
    const liveAsset = join(fx.root, "assets", fixture.contentEntries[0].id);
    mkdirSync(dirname(liveAsset), { recursive: true });
    writeFileSync(liveAsset, fixture.contentBytes);
    const corrupt = Buffer.from(fixture.contentBytes); corrupt[corrupt.length >>> 1] ^= 0xff;
    writeFileSync(contentPath(fx.root, fixture.engineHash), corrupt);
    const response = await http(running.owner, contentUrl(fixture));
    assert.equal(response.status, 503);
    assert.ok(["ARTIFACT_INVALID", "PUBLICATION_UNAVAILABLE"].includes(errorCode(response)),
      "tampered installed content did not fail through an integrity-closed fixed error");
    assert.equal(response.body.toString("utf8").includes(fx.root), false);
  } finally { await running?.server.stop(); fx.cleanup(); }
});

test("content endpoint fails closed when current generation changes during authorization", async () => {
  const fx = projectFixture();
  const source = { revision: 43, headHash: hash("head:content-race") };
  const first = contentRevisionFixture("content-race-a", source, randomBytes(1024 * 1024 + 5));
  const second = contentRevisionFixture("content-race-b", source, randomBytes(1024 * 1024 + 7));
  const authority = () => ({ projectId: "grey-field", branchId: "main", ...source });
  let running;
  try {
    await publish(fx.root, first, "job-content-race-a", authority);
    let reads = 0;
    running = await startServer(fx.root, async () => {
      reads++;
      if (reads === 2) await publish(fx.root, second, "job-content-race-b", authority);
      return authority();
    });
    const response = await http(running.owner, contentUrl(first));
    assert.ok(response.status === 409 || response.status === 412);
    assert.equal(errorCode(response), "CURRENT_CHANGED");
  } finally { await running?.server.stop(); fx.cleanup(); }
});

test("retained content serves again when an older manifest is republished as exact current", async () => {
  const fx = projectFixture();
  const source = { revision: 44, headHash: hash("head:content-retained") };
  const first = contentRevisionFixture("content-retained-a", source, randomBytes(4097));
  const second = contentRevisionFixture("content-retained-b", source, randomBytes(4099));
  const authority = () => ({ projectId: "grey-field", branchId: "main", ...source });
  let running;
  try {
    await publish(fx.root, first, "job-content-retained-a", authority);
    await publish(fx.root, second, "job-content-retained-b", authority);
    await publish(fx.root, first, "job-content-retained-a-again", authority);
    running = await startServer(fx.root, authority);
    const response = await http(running.owner, contentUrl(first));
    assert.equal(response.status, 200);
    assert.deepEqual(response.body, Buffer.from(first.contentBytes));
    assert.equal((await http(running.owner, contentUrl(second))).status, 412,
      "previous-manifest content was served without that manifest becoming exact current");
  } finally { await running?.server.stop(); fx.cleanup(); }
});

for (const mutation of ["symlink", "truncate", "corrupt"]) {
  test(`artifact safe-open and integrity checks reject ${mutation}`, async () => {
    const fx = projectFixture();
    const source = { revision: 5, headHash: hash("head:5") };
    const fixture = revisionFixture(`integrity-${mutation}`, source, randomBytes(1024 * 1024 + 17));
    const authority = () => ({ projectId: "grey-field", branchId: "main", ...source });
    let running;
    try {
      await publish(fx.root, fixture, `job-integrity-${mutation}`, authority);
      const path = artifactPath(fx.root, fixture.contentHash);
      if (mutation === "symlink") {
        const outside = join(fx.root, "outside.bin");
        writeFileSync(outside, fixture.bytes);
        unlinkSync(path);
        symlinkSync(outside, path);
      } else if (mutation === "truncate") writeFileSync(path, fixture.bytes.subarray(0, fixture.bytes.byteLength - 1));
      else {
        const corrupt = Buffer.from(fixture.bytes);
        corrupt[corrupt.length >>> 1] ^= 0xff;
        writeFileSync(path, corrupt);
      }
      running = await startServer(fx.root, authority);
      const response = await http(running.owner, artifactUrl(fixture));
      assert.equal(response.status, 503);
      assert.equal(errorCode(response), "ARTIFACT_INVALID");
      assert.equal(response.body.toString("utf8").includes(fx.root), false);
    } finally { await running?.server.stop(); fx.cleanup(); }
  });
}

test("pointer changes during current and artifact authority checks fail closed", async () => {
  const source = { revision: 6, headHash: hash("head:6") };
  const authority = () => ({ projectId: "grey-field", branchId: "main", ...source });

  const currentFx = projectFixture();
  let currentServer;
  try {
    const first = revisionFixture("race-current-a", source);
    const second = revisionFixture("race-current-b", source);
    await publish(currentFx.root, first, "job-race-current-a", authority);
    let changed = false;
    currentServer = await startServer(currentFx.root, async () => {
      if (!changed) { changed = true; await publish(currentFx.root, second, "job-race-current-b", authority); }
      return authority();
    });
    const response = await http(currentServer.owner, "/v1/derived/current");
    assert.equal(response.status, 409);
    assert.equal(errorCode(response), "CURRENT_CHANGED");
  } finally { await currentServer?.server.stop(); currentFx.cleanup(); }

  const artifactFx = projectFixture();
  let artifactServer;
  try {
    const first = revisionFixture("race-artifact-a", source, randomBytes(2 * 1024 * 1024));
    const second = revisionFixture("race-artifact-b", source);
    await publish(artifactFx.root, first, "job-race-artifact-a", authority);
    let reads = 0;
    artifactServer = await startServer(artifactFx.root, async () => {
      reads++;
      if (reads === 2) await publish(artifactFx.root, second, "job-race-artifact-b", authority);
      return authority();
    });
    const response = await http(artifactServer.owner, artifactUrl(first));
    assert.ok(response.status === 409 || response.status === 412);
    assert.equal(errorCode(response), "CURRENT_CHANGED");
  } finally { await artifactServer?.server.stop(); artifactFx.cleanup(); }
});

test("current token bucket and artifact stream slots are bounded and released after abort/stop", async () => {
  const fx = projectFixture();
  const source = { revision: 8, headHash: hash("head:8") };
  const fixture = revisionFixture("limits", source, randomBytes(12 * 1024 * 1024));
  const authority = () => ({ projectId: "grey-field", branchId: "main", ...source });
  let now = 1000;
  let running;
  try {
    await publish(fx.root, fixture, "job-limits", authority);
    running = await startServer(fx.root, authority, { now: () => now });
    for (let index = 0; index < DERIVED_RUNTIME_CURRENT_RATE_CAPACITY; index++) {
      assert.equal((await http(running.owner, "/v1/derived/current")).status, 200);
    }
    const limited = await http(running.owner, "/v1/derived/current");
    assert.equal(limited.status, 429);
    assert.equal(errorCode(limited), "RATE_LIMITED");
    now += 1000;
    assert.equal((await http(running.owner, "/v1/derived/current")).status, 200);

    const paused = await Promise.all([openPausedArtifact(running, fixture), openPausedArtifact(running, fixture)]);
    assert.equal(paused[0].status, 200);
    assert.equal(paused[1].status, 200);
    const third = await http(running.owner, artifactUrl(fixture));
    assert.equal(third.status, 429);
    assert.equal(errorCode(third), "STREAM_LIMIT");
    paused[0].req.destroy();
    paused[0].res.destroy();
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal((await http(running.owner, artifactUrl(fixture))).status, 200, "aborted stream did not release its token slot");

    const stopping = running.server.stop();
    paused[1].req.destroy();
    paused[1].res.destroy();
    await stopping;
    assert.equal(running.server.stop(), stopping);
  } finally { await running?.server.stop(); fx.cleanup(); }
});

test("artifact stream limit is bounded across server instances in one process", async () => {
  const fx = projectFixture();
  const source = { revision: 9, headHash: hash("head:9") };
  const fixture = revisionFixture("process-limit", source, randomBytes(10 * 1024 * 1024));
  const authority = () => ({ projectId: "grey-field", branchId: "main", ...source });
  const servers = [];
  const paused = [];
  try {
    await publish(fx.root, fixture, "job-process-limit", authority);
    for (let index = 0; index < 3; index++) servers.push(await startServer(fx.root, authority, { token: randomBytes(32) }));
    paused.push(...await Promise.all([
      openPausedArtifact(servers[0], fixture), openPausedArtifact(servers[0], fixture),
      openPausedArtifact(servers[1], fixture), openPausedArtifact(servers[1], fixture),
    ]));
    assert.ok(paused.every((entry) => entry.status === 200));
    const processLimited = await http(servers[2].owner, artifactUrl(fixture));
    assert.equal(processLimited.status, 429);
    assert.equal(errorCode(processLimited), "STREAM_LIMIT");
  } finally {
    for (const entry of paused) { entry.req.destroy(); entry.res.destroy(); }
    await Promise.allSettled(servers.map(({ server }) => server.stop()));
    fx.cleanup();
  }
});
