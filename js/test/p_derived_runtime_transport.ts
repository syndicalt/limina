import {
  DerivedRuntimeTransport,
  DerivedRuntimeTransportError,
  type DerivedRuntimeCurrent,
} from "../src/browser/derived-runtime-transport.ts";
import { createTerrainGridSpec, terrainChunkId } from "../src/terrain/grid.mjs";
import {
  DERIVED_REVISION_MANIFEST_SCHEMA_V2,
  compilerContentHash,
  createDerivedRevisionManifest,
  derivedArtifactContentHash,
} from "../src/world/compiler/index.mjs";
import { sha256 as portableSha256 } from "../src/world/sha256.mjs";
import { portableAssetContentHash } from "../src/world/asset-content-hash.mjs";

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(`p_derived_runtime_transport FAIL: ${message}`);
}

async function rejected(promise: Promise<unknown>, code: string, classification: string, message: string): Promise<void> {
  let failure: unknown;
  try { await promise; } catch (error) { failure = error; }
  assert(failure instanceof DerivedRuntimeTransportError, `${message}: wrong error type`);
  assert(failure.code === code && failure.classification === classification,
    `${message}: got ${failure.code}/${failure.classification}`);
}

function rejectsSync(fn: () => unknown, pattern: RegExp, message: string): void {
  let failure: unknown;
  try { fn(); } catch (error) { failure = error; }
  assert(failure instanceof TypeError && pattern.test(failure.message), `${message}: ${failure instanceof Error ? failure.message : "did not reject"}`);
}

const encoder = new TextEncoder();
const token = "A".repeat(43);
const baseConfig = Object.freeze({ baseUrl: "http://127.0.0.1:43127", token, projectId: "grey-field", branchId: "main" });
const grid = createTerrainGridSpec({ gridId: "grey-field.surface", origin: [-512, -512], chunkSizeM: 64, defaultSamples: 65 });
const artifactBytes = new Uint8Array([0, 1, 2, 128, 255]);
const contentHash = derivedArtifactContentHash(artifactBytes);
const hash = (label: string) => compilerContentHash({ label });
const chunkId = terrainChunkId(grid.gridId, 0, 0, 0);
const manifest = createDerivedRevisionManifest({
  schema: DERIVED_REVISION_MANIFEST_SCHEMA_V2,
  projectId: baseConfig.projectId,
  branchId: baseConfig.branchId,
  source: {
    revision: 17,
    headHash: hash("head"),
    contentRefs: [{ refId: "terrain", refType: "world-map/v1", scope: "chunk", assetId: "maps/grey-field", contentHash: hash("map") }],
  },
  compiler: { version: "1.2.0", configHash: hash("config"), graphHash: hash("graph"), snapshotHash: hash("snapshot") },
  grid,
  globalArtifacts: [],
  chunks: [{
    chunkId, gridId: grid.gridId, lod: 0, tx: 0, tz: 0, topologyHash: hash("topology"),
    sourceSliceHashes: [{ refId: "terrain", contentHash: hash("slice") }],
    artifacts: [{ artifactType: "render-mesh/v1", contentHash, byteLength: artifactBytes.byteLength, mediaType: "model/gltf-binary" }],
  }],
});
const descriptor = manifest.chunks[0].artifacts[0];
const contentBytes = new Uint8Array([255, 17, 0, 92, 31, 128]);
const engineHash = portableAssetContentHash(contentBytes);

function responseWithReader(
  status: number,
  headers: Record<string, string>,
  read: () => Promise<ReadableStreamReadResult<Uint8Array>>,
  bodyPresent = true,
): Response {
  const body = bodyPresent ? {
    getReader: () => ({ read, cancel: async () => {}, releaseLock: () => {} }),
  } : null;
  return { status, headers: new Headers(headers), body } as unknown as Response;
}

function bytesResponse(status: number, body: Uint8Array | null, headers: Record<string, string>): Response {
  let sent = false;
  return responseWithReader(status, headers, async () => {
    if (sent || body === null) return { done: true, value: undefined };
    sent = true;
    return { done: false, value: body };
  }, body !== null);
}

function currentHeaders(length: number): Record<string, string> {
  return {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": String(length),
    ETag: `"g3-${manifest.manifestHash}"`,
    "X-Limina-Manifest-Hash": manifest.manifestHash,
    "X-Limina-Revision": String(manifest.source.revision),
    "X-Limina-Head-Hash": manifest.source.headHash,
    "X-Limina-Generation": "3",
  };
}

function currentResponse(overrides: Record<string, unknown> = {}, headerOverrides: Record<string, string> = {}): Response {
  const payload = encoder.encode(`${JSON.stringify({
    schema: "limina.derived-runtime-current/v1",
    projectId: baseConfig.projectId,
    branchId: baseConfig.branchId,
    generation: 3,
    source: { revision: manifest.source.revision, headHash: manifest.source.headHash },
    manifest,
    ...overrides,
  })}\n`);
  return bytesResponse(200, payload, { ...currentHeaders(payload.byteLength), ...headerOverrides });
}

function artifactHeaders(length: number): Record<string, string> {
  return {
    "Content-Type": descriptor.mediaType,
    "Content-Length": String(length),
    ETag: `"${descriptor.contentHash}"`,
    "X-Limina-Content-Hash": descriptor.contentHash,
    "X-Limina-Manifest-Hash": manifest.manifestHash,
  };
}

function contentHeaders(length: number, overrides: Record<string, string> = {}): Record<string, string> {
  return {
    "Content-Type": "application/octet-stream",
    "Content-Length": String(length),
    ETag: `"${engineHash}"`,
    "X-Limina-Content-Hash": engineHash,
    "X-Limina-Manifest-Hash": manifest.manifestHash,
    "X-Limina-Generation": "3",
    ...overrides,
  };
}

function errorResponse(status: number, code: string): Response {
  const payload = encoder.encode(`${JSON.stringify({ schema: "limina.derived-runtime-error/v1", code, message: `fixed ${code}` })}\n`);
  return bytesResponse(status, payload, { "Content-Type": "application/json; charset=utf-8", "Content-Length": String(payload.byteLength) });
}

type RequestRecord = { url: string; init: RequestInit };
function harness(responses: Array<Response | Error>, requireUnboundReceiver = false) {
  const requests: RequestRecord[] = [];
  const fetchImpl = (async function (this: unknown, url: string | URL | Request, init?: RequestInit) {
    if (requireUnboundReceiver) assert(this === undefined, "transport invoked fetch with a branded receiver");
    requests.push({ url: String(url), init: init ?? {} });
    const response = responses.shift();
    if (response instanceof Error) throw response;
    if (response === undefined) throw new Error("unexpected fetch");
    return response;
  }) as typeof fetch;
  let digests = 0;
  const cryptoImpl = {
    subtle: {
      digest: async (algorithm: AlgorithmIdentifier, bytes: BufferSource) => {
        assert(algorithm === "SHA-256", "transport requested a non-SHA-256 digest");
        digests++;
        const view = bytes instanceof ArrayBuffer
          ? new Uint8Array(bytes)
          : new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        const hex = portableSha256(view);
        const digest = new Uint8Array(32);
        for (let index = 0; index < 32; index++) digest[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
        return digest.buffer;
      },
    },
  } as unknown as Pick<Crypto, "subtle">;
  return {
    transport: new DerivedRuntimeTransport(baseConfig, { fetch: fetchImpl, crypto: cryptoImpl }),
    requests,
    digests: () => digests,
  };
}

rejectsSync(() => new DerivedRuntimeTransport({ ...baseConfig, baseUrl: "https://127.0.0.1:43127" }), /canonical loopback/, "HTTPS accepted");
rejectsSync(() => new DerivedRuntimeTransport({ ...baseConfig, baseUrl: "http://localhost:43127" }), /canonical loopback/, "hostname loopback accepted");
rejectsSync(() => new DerivedRuntimeTransport({ ...baseConfig, baseUrl: "http://127.0.0.1:043127" }), /canonical loopback/, "non-canonical port accepted");
rejectsSync(() => new DerivedRuntimeTransport({ ...baseConfig, token: `${"A".repeat(42)}B` }), /canonical base64url/, "non-canonical 32-byte token accepted");
rejectsSync(() => new DerivedRuntimeTransport({ ...baseConfig, projectId: "Grey Field" }), /projectId/, "invalid project accepted");
rejectsSync(() => new DerivedRuntimeTransport({ ...baseConfig, extra: true } as any), /exactly/, "extra config field accepted");
const accessorConfig = { ...baseConfig };
Object.defineProperty(accessorConfig, "token", { enumerable: true, get: () => token });
rejectsSync(() => new DerivedRuntimeTransport(accessorConfig), /data properties/, "accessor config field accepted");

const initial = harness([currentResponse()]);
const currentResult = await initial.transport.fetchCurrent();
assert(currentResult.status === "current", "initial current request did not return current");
const current = currentResult.current;
assert(current.manifest === currentResult.current.manifest && Object.isFrozen(current.manifest), "manifest was not parsed/frozen");
assert(initial.requests.length === 1 && initial.requests[0].url === `${baseConfig.baseUrl}/v1/derived/current`, "current URL changed");
const initialHeaders = new Headers(initial.requests[0].init.headers);
assert(initialHeaders.get("authorization") === `Bearer ${token}`, "bearer header missing");
assert(initialHeaders.get("if-none-match") === null, "initial request sent If-None-Match");
assert(initial.requests[0].init.credentials === "omit" && initial.requests[0].init.redirect === "error"
  && initial.requests[0].init.referrerPolicy === "no-referrer", "safe fetch policy changed");

const receiverSafe = harness([currentResponse()], true);
await receiverSafe.transport.fetchCurrent();

const unchanged = bytesResponse(304, null, { ...currentHeaders(0), "Content-Length": "0" });
const conditional = harness([currentResponse(), unchanged]);
const bound = (await conditional.transport.fetchCurrent()).current;
const notModified = await conditional.transport.fetchCurrent({ previous: bound });
assert(notModified.status === "not-modified" && notModified.current === bound, "304 did not preserve bound current identity");
assert(new Headers(conditional.requests[1].init.headers).get("if-none-match") === `"g3-${manifest.manifestHash}"`, "current conditional ETag changed");

const republishedHeaders = { ...currentHeaders(0), ETag: `"g4-${manifest.manifestHash}"`, "X-Limina-Generation": "4" };
const republishedPayload = encoder.encode(`${JSON.stringify({
  schema: "limina.derived-runtime-current/v1",
  projectId: baseConfig.projectId,
  branchId: baseConfig.branchId,
  generation: 4,
  source: { revision: manifest.source.revision, headHash: manifest.source.headHash },
  manifest,
})}\n`);
const republished = harness([
  currentResponse(),
  bytesResponse(200, republishedPayload, { ...republishedHeaders, "Content-Length": String(republishedPayload.byteLength) }),
]);
const beforeRepublish = (await republished.transport.fetchCurrent()).current;
const afterRepublish = await republished.transport.fetchCurrent({ previous: beforeRepublish });
assert(afterRepublish.status === "current" && afterRepublish.current.generation === 4
    && afterRepublish.current.manifestHash === beforeRepublish.manifestHash,
"identical manifest republish did not advance generation as a new current publication");

const artifactHarness = harness([
  currentResponse(),
  bytesResponse(200, artifactBytes, artifactHeaders(artifactBytes.byteLength)),
  bytesResponse(304, null, { ...artifactHeaders(0), "Content-Length": "0" }),
]);
const artifactCurrent = (await artifactHarness.transport.fetchCurrent()).current;
const artifactResult = await artifactHarness.transport.fetchArtifact(artifactCurrent, artifactCurrent.manifest.chunks[0].artifacts[0]);
assert(artifactResult.status === "artifact" && artifactResult.bytes.every((byte, index) => byte === artifactBytes[index]), "artifact bytes changed");
assert(artifactHarness.digests() === 1, "artifact did not use injected WebCrypto exactly once");
assert(artifactHarness.requests[1].url === `${baseConfig.baseUrl}/v1/derived/manifests/${manifest.manifestHash.slice(7)}/artifacts/${contentHash.slice(7)}`,
  "artifact URL was not bound to manifest and descriptor hashes");

const reparsedDescriptor = { ...artifactCurrent.manifest.chunks[0].artifacts[0] };
const reparsedResult = await artifactHarness.transport.fetchArtifact(
  artifactCurrent,
  reparsedDescriptor,
  { allowNotModified: true },
);
assert(reparsedResult.status === "not-modified", "canonically identical reparsed descriptor lost publication binding");
await rejected(
  artifactHarness.transport.fetchArtifact(artifactCurrent, { ...reparsedDescriptor, contentHash: hash("unbound") }),
  "PROTOCOL_ERROR", "fatal", "unbound descriptor escaped canonical publication binding",
);
await rejected(
  initial.transport.fetchCurrent({ previous: artifactCurrent }),
  "PROTOCOL_ERROR", "fatal", "current from another transport escaped capability binding",
);

const artifact304Harness = harness([
  currentResponse(),
  bytesResponse(304, null, { ...artifactHeaders(0), "Content-Length": "0" }),
]);
const artifact304Current = (await artifact304Harness.transport.fetchCurrent()).current;
const artifact304 = await artifact304Harness.transport.fetchArtifact(
  artifact304Current,
  artifact304Current.manifest.chunks[0].artifacts[0],
  { allowNotModified: true },
);
assert(artifact304.status === "not-modified" && artifact304.contentHash === contentHash, "artifact 304 changed cache identity");
assert(new Headers(artifact304Harness.requests[1].init.headers).get("if-none-match") === `"${contentHash}"`, "artifact conditional ETag changed");

const contentHarness = harness([bytesResponse(200, contentBytes, contentHeaders(contentBytes.byteLength))]);
const contentResult = await contentHarness.transport.fetchContent(manifest.manifestHash, {
  contentHash: engineHash,
  byteLength: contentBytes.byteLength,
});
assert(contentResult.contentHash === engineHash
  && contentResult.bytes.every((byte, index) => byte === contentBytes[index]), "derived content bytes changed");
assert(contentHarness.requests[0].url === `${baseConfig.baseUrl}/v1/derived/manifests/${manifest.manifestHash.slice(7)}/content/${engineHash.slice(7)}`,
  "content URL was not bound to manifest and portable engine hashes");
assert(new Headers(contentHarness.requests[0].init.headers).get("authorization") === `Bearer ${token}`,
  "content request omitted bearer authentication");

const badContentHash = harness([bytesResponse(200, new Uint8Array([255, 17, 0, 92, 31, 129]), contentHeaders(contentBytes.byteLength))]);
await rejected(badContentHash.transport.fetchContent(manifest.manifestHash, {
  contentHash: engineHash, byteLength: contentBytes.byteLength,
}), "INTEGRITY_ERROR", "fatal", "portable engine content hash mismatch accepted");
const badContentManifest = harness([bytesResponse(200, contentBytes,
  contentHeaders(contentBytes.byteLength, { "X-Limina-Manifest-Hash": hash("wrong-content-manifest") }))]);
await rejected(badContentManifest.transport.fetchContent(manifest.manifestHash, {
  contentHash: engineHash, byteLength: contentBytes.byteLength,
}), "PROTOCOL_ERROR", "fatal", "content response escaped exact manifest binding");
const badContentLength = harness([bytesResponse(200, contentBytes, contentHeaders(contentBytes.byteLength - 1))]);
await rejected(badContentLength.transport.fetchContent(manifest.manifestHash, {
  contentHash: engineHash, byteLength: contentBytes.byteLength,
}), "PROTOCOL_ERROR", "fatal", "content response escaped exact closure byteLength binding");
const badContentGeneration = harness([bytesResponse(200, contentBytes,
  contentHeaders(contentBytes.byteLength, { "X-Limina-Generation": "03" }))]);
await rejected(badContentGeneration.transport.fetchContent(manifest.manifestHash, {
  contentHash: engineHash, byteLength: contentBytes.byteLength,
}), "PROTOCOL_ERROR", "fatal", "non-canonical content generation accepted");
const missingContent = harness([errorResponse(404, "NOT_FOUND")]);
await rejected(missingContent.transport.fetchContent(manifest.manifestHash, {
  contentHash: engineHash, byteLength: contentBytes.byteLength,
}), "NOT_FOUND", "fatal", "closure-unavailable content did not fail closed");

const badHashHarness = harness([currentResponse(), bytesResponse(200, new Uint8Array([9, 8, 7, 6, 5]), artifactHeaders(5))]);
const badHashCurrent = (await badHashHarness.transport.fetchCurrent()).current;
await rejected(badHashHarness.transport.fetchArtifact(badHashCurrent, badHashCurrent.manifest.chunks[0].artifacts[0]),
  "INTEGRITY_ERROR", "fatal", "artifact hash mismatch accepted");

for (const [status, code, expectedCode] of [
  [404, "NO_PUBLICATION", "NO_PUBLICATION"],
  [409, "NOT_CURRENT", "NOT_CURRENT"],
  [409, "CURRENT_CHANGED", "CURRENT_CHANGED"],
  [412, "CURRENT_CHANGED", "CURRENT_CHANGED"],
  [429, "RATE_LIMITED", "RATE_LIMITED"],
  [503, "PUBLICATION_UNAVAILABLE", "PUBLICATION_UNAVAILABLE"],
] as const) {
  const errors = harness([errorResponse(status, code)]);
  await rejected(errors.transport.fetchCurrent(), expectedCode, "transient", `${code} classification changed`);
}
for (const [status, code, expectedCode] of [
  [401, "UNAUTHORIZED", "UNAUTHORIZED"],
  [403, "FORBIDDEN_ORIGIN", "FORBIDDEN"],
  [503, "ARTIFACT_INVALID", "INTEGRITY_ERROR"],
] as const) {
  const errors = harness([errorResponse(status, code)]);
  await rejected(errors.transport.fetchCurrent(), expectedCode, "fatal", `${code} classification changed`);
}

const wrongProject = harness([currentResponse({ projectId: "another-project" })]);
await rejected(wrongProject.transport.fetchCurrent(), "PROTOCOL_ERROR", "fatal", "wrong project accepted");
const wrongHeader = harness([currentResponse({}, { "X-Limina-Manifest-Hash": hash("other") })]);
await rejected(wrongHeader.transport.fetchCurrent(), "PROTOCOL_ERROR", "fatal", "wrong manifest header accepted");
let cancelledProtocolBody = 0;
const invalidContentTypeResponse = {
  status: 200,
  headers: new Headers({ "Content-Type": "text/plain", "Content-Length": "3" }),
  body: { locked: false, cancel: async () => { cancelledProtocolBody++; } },
} as unknown as Response;
const invalidContentType = harness([invalidContentTypeResponse]);
await rejected(invalidContentType.transport.fetchCurrent(), "PROTOCOL_ERROR", "fatal", "invalid current content type accepted");
assert(cancelledProtocolBody === 1, "pre-read protocol rejection did not cancel its response body");
const wrongLength = harness([currentResponse({}, { "Content-Length": "1" })]);
await rejected(wrongLength.transport.fetchCurrent(), "PROTOCOL_ERROR", "fatal", "truncated declared length accepted");
const wrongErrorStatus = harness([errorResponse(409, "NO_PUBLICATION")]);
await rejected(wrongErrorStatus.transport.fetchCurrent(), "PROTOCOL_ERROR", "fatal", "error status/code mismatch accepted");
const network = harness([new Error("secret token should not leak")]);
await rejected(network.transport.fetchCurrent(), "NETWORK_ERROR", "transient", "network error classification changed");
const failedStreamResponse = responseWithReader(200, currentHeaders(12), async () => { throw new Error("socket reset"); });
const streamNetwork = harness([failedStreamResponse]);
await rejected(streamNetwork.transport.fetchCurrent(), "NETWORK_ERROR", "transient", "response stream failure leaked an unstable error");

const aborted = harness([]);
const abortedSignal = { aborted: true } as AbortSignal;
await rejected(aborted.transport.fetchCurrent({ signal: abortedSignal }), "ABORTED", "transient", "pre-aborted signal performed I/O");
assert(aborted.requests.length === 0, "pre-aborted request reached fetch");

console.log("[js] p_derived_runtime_transport OK: strict loopback/token/config, capability-bound artifact/content URLs, exact headers/lengths, raw artifact + portable engine hashes, bounded bodies, abort, and stable transient/fatal errors proven");
