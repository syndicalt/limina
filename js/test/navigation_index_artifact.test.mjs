import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import test from "node:test";
import { ATLAS_DESIGN_REF_SCHEMA } from "../src/world/design-ref.mjs";

import {
  MAX_NAVIGATION_INDEX_ARTIFACT_BYTES,
  MAX_NAVIGATION_INDEX_ENTRIES,
  MAX_NAVIGATION_INDEX_SEARCH_KEYS_PER_ENTRY,
  NAVIGATION_INDEX_ARTIFACT_MEDIA_TYPE,
  NAVIGATION_INDEX_ARTIFACT_SCHEMA,
  NAVIGATION_INDEX_ARTIFACT_TYPE,
  decodeNavigationIndexArtifact,
  encodeNavigationIndexArtifact,
  searchNavigationIndexPrefix,
} from "../src/world/compiler/navigation-index-artifact.mjs";

const bounds = () => ({ minX: -1000, minZ: -800, maxX: 1200, maxZ: 900 });
const entry = (id, overrides = {}) => ({
  designRef: { schema: ATLAS_DESIGN_REF_SCHEMA, mapId: "primary", kind: "place", id },
  position: [0, 0],
  label: id,
  kind: "landmark",
  searchKeys: [id],
  ...overrides,
});
const source = (entries) => ({ worldBounds: bounds(), entries });

test("artifact constants identify the versioned binary resource", () => {
  assert.equal(NAVIGATION_INDEX_ARTIFACT_TYPE, "navigation-index/v1");
  assert.equal(NAVIGATION_INDEX_ARTIFACT_MEDIA_TYPE, "application/vnd.limina.navigation-index");
  assert.equal(MAX_NAVIGATION_INDEX_ENTRIES, 100_000);
});

test("encoding is deterministic and decoding retains a compact frozen index", () => {
  const oldMill = entry("old-mill", {
    position: [-766, 264],
    label: "Old Mill",
    searchKeys: ["mill", " OLD   MILL ", "old-mill"],
  });
  const caesura = entry("the-caesura", {
    position: [939, -77],
    radiusM: 120,
    label: "The Caesura",
    searchKeys: ["the caesura", "caesura"],
  });
  const first = encodeNavigationIndexArtifact(source([caesura, oldMill]));
  const second = encodeNavigationIndexArtifact(source([
    { ...oldMill, searchKeys: [...oldMill.searchKeys].reverse() },
    caesura,
  ]));
  assert.deepEqual(first, second);
  const decoded = decodeNavigationIndexArtifact(first);
  assert.equal(decoded.schema, NAVIGATION_INDEX_ARTIFACT_SCHEMA);
  assert.equal(decoded.entryCount, 2);
  assert.equal(decoded.keyCount, 5);
  assert.equal(decoded.byteLength, first.byteLength);
  assert.equal("entries" in decoded, false);
  assert.equal("keys" in decoded, false);
  assert.equal(Object.isFrozen(decoded), true);
  assert.equal(Object.isFrozen(decoded.worldBounds), true);
  const materialized = searchNavigationIndexPrefix(decoded, "old mill")[0];
  assert.equal(materialized.designRef.id, "old-mill");
  assert.deepEqual(materialized.searchKeys, ["mill", "old mill", "old-mill"]);
  assert.equal(Object.isFrozen(materialized), true);
  assert.equal(Object.isFrozen(materialized.designRef), true);
  assert.equal(Object.isFrozen(materialized.position), true);
  assert.equal(Object.isFrozen(materialized.searchKeys), true);
});

test("prefix search uses canonical keys, stable key order, deduplication, and a hard result bound", () => {
  const bytes = encodeNavigationIndexArtifact(source([
    entry("old-mill", { label: "Old Mill", searchKeys: ["old mill", "old landmark"] }),
    entry("old-road", { label: "Old Road", searchKeys: ["old road", "old landmark"] }),
    entry("orchard", { label: "Orchard", searchKeys: ["orchard"] }),
  ]));
  const decoded = decodeNavigationIndexArtifact(bytes);
  assert.deepEqual(searchNavigationIndexPrefix(decoded, "  OLD ").map((item) => item.designRef.id), ["old-mill", "old-road"]);
  assert.deepEqual(searchNavigationIndexPrefix(decoded, "old", { limit: 1 }).map((item) => item.designRef.id), ["old-mill"]);
  assert.deepEqual(searchNavigationIndexPrefix(decoded, "zzz"), []);
  assert.throws(() => searchNavigationIndexPrefix(source([]), "old"), /decoded/);
  assert.throws(() => searchNavigationIndexPrefix(decoded, "old", { limit: 0 }), /limit/);
  assert.throws(() => searchNavigationIndexPrefix(decoded, "old", { limit: 1, extra: true }), /fields/);
});

test("UTF-8 ordering and normalized non-ASCII prefix search round-trip", () => {
  const bytes = encodeNavigationIndexArtifact(source([
    entry("\u{10000}", { label: "Astral", searchKeys: ["ＡＳＴＲＡＬ"] }),
    entry("\ue000", { label: "Private", searchKeys: ["privé"] }),
  ]));
  const decoded = decodeNavigationIndexArtifact(bytes);
  assert.deepEqual(searchNavigationIndexPrefix(decoded, "astr").map((item) => item.label), ["Astral"]);
  assert.deepEqual(searchNavigationIndexPrefix(decoded, "PRIVÉ").map((item) => item.label), ["Private"]);
});

test("hostile direct data fails before accessors, prototypes, symbols, sparse arrays, or extra fields can enter", () => {
  let getterRead = false;
  const hostile = entry("hostile");
  Object.defineProperty(hostile, "label", { enumerable: true, get() { getterRead = true; return "Hostile"; } });
  assert.throws(() => encodeNavigationIndexArtifact(source([hostile])), /data field/);
  assert.equal(getterRead, false);

  const polluted = entry("polluted");
  Object.setPrototypeOf(polluted.designRef, { admin: true });
  assert.throws(() => encodeNavigationIndexArtifact(source([polluted])), /plain object/);

  const symbol = entry("symbol");
  symbol[Symbol("hidden")] = true;
  assert.throws(() => encodeNavigationIndexArtifact(source([symbol])), /fields/);

  const sparseKeys = ["a", "b"];
  delete sparseKeys[0];
  assert.throws(() => encodeNavigationIndexArtifact(source([entry("sparse", { searchKeys: sparseKeys })])), /dense/);
  assert.throws(() => encodeNavigationIndexArtifact(source([entry("extra", { extra: true })])), /fields/);
  assert.equal(Object.prototype.admin, undefined);
});

test("bounds, positions, radii, references, kinds, keys, and aggregate limits fail closed", () => {
  assert.throws(() => encodeNavigationIndexArtifact({ worldBounds: { minX: 0, minZ: 0, maxX: 0, maxZ: 1 }, entries: [] }), /positive/);
  assert.throws(() => encodeNavigationIndexArtifact(source([entry("outside", { position: [1201, 0] })])), /outside/);
  assert.throws(() => encodeNavigationIndexArtifact(source([entry("radius", { radiusM: 0 })])), /positive/);
  assert.throws(() => encodeNavigationIndexArtifact(source([entry("same"), entry("same")])), /duplicate designRef/);
  assert.throws(() => encodeNavigationIndexArtifact(source([entry("wrong-kind", { kind: "Not A Kind" })])), /kind is invalid/);
  assert.throws(() => encodeNavigationIndexArtifact(source([entry("bad-key", { searchKeys: ["A", "a"] })])), /duplicate canonical/);
  assert.throws(() => encodeNavigationIndexArtifact(source([entry("too-many-keys", {
    searchKeys: Array.from({ length: MAX_NAVIGATION_INDEX_SEARCH_KEYS_PER_ENTRY + 1 }, (_, index) => `key-${index}`),
  })])), /at most/);
  assert.throws(() => encodeNavigationIndexArtifact(source(Array(MAX_NAVIGATION_INDEX_ENTRIES + 1).fill(entry("x")))), /at most/);
});

test("decoder rejects oversized, malformed, noncanonical, and forged binary sections", () => {
  assert.throws(() => decodeNavigationIndexArtifact(new Uint8Array(MAX_NAVIGATION_INDEX_ARTIFACT_BYTES + 1)), /bytes/);
  const canonical = encodeNavigationIndexArtifact(source([entry("mill")]));
  const badMagic = Uint8Array.from(canonical);
  badMagic[0] ^= 0xff;
  assert.throws(() => decodeNavigationIndexArtifact(badMagic), /magic/);
  const reserved = Uint8Array.from(canonical);
  new DataView(reserved.buffer).setUint32(12, 1, true);
  assert.throws(() => decodeNavigationIndexArtifact(reserved), /reserved/);
  const forgedKey = Uint8Array.from(canonical);
  const forgedView = new DataView(forgedKey.buffer);
  const keyOffset = forgedView.getUint32(36, true);
  forgedView.setUint32(keyOffset + 4, 99, true);
  assert.throws(() => decodeNavigationIndexArtifact(forgedKey), /entry reference/);
  const malformedUtf8 = Uint8Array.from(canonical);
  malformedUtf8[new DataView(malformedUtf8.buffer).getUint32(48, true)] = 0xff;
  assert.throws(() => decodeNavigationIndexArtifact(malformedUtf8), /UTF-8/);
});

test("decode owns its transferable bytes and supports cooperative cancellation", () => {
  const bytes = encodeNavigationIndexArtifact(source([entry("mill")]));
  const decoded = decodeNavigationIndexArtifact(bytes);
  bytes.fill(0);
  assert.deepEqual(searchNavigationIndexPrefix(decoded, "mill").map((item) => item.designRef.id), ["mill"]);

  const cancellationFlag = new Int32Array(new SharedArrayBuffer(4));
  Atomics.store(cancellationFlag, 0, 1);
  assert.throws(
    () => encodeNavigationIndexArtifact(source([]), { cancellationFlag }),
    (error) => error?.code === "navigation_index_artifact_cancelled",
  );
  assert.throws(
    () => decodeNavigationIndexArtifact(encodeNavigationIndexArtifact(source([])), { cancellationFlag }),
    (error) => error?.code === "navigation_index_artifact_cancelled",
  );
  assert.throws(
    () => encodeNavigationIndexArtifact(source([]), { shouldCancel: () => true }),
    (error) => error?.code === "navigation_index_artifact_cancelled",
  );
  assert.throws(
    () => encodeNavigationIndexArtifact(source([]), { shouldCancel: () => false, cancellationFlag }),
    /one cancellation mechanism/,
  );
});

test("binary decode and far-end lookup remain bounded at the Atlas production ceiling", (context) => {
  const entries = Array.from({ length: MAX_NAVIGATION_INDEX_ENTRIES }, (_, index) => {
    const suffix = String(index).padStart(6, "0");
    return entry(`poi-${suffix}`, { label: `POI ${suffix}`, searchKeys: [`poi ${suffix}`] });
  });
  const bytes = encodeNavigationIndexArtifact(source(entries));
  assert.ok(bytes.byteLength <= 12 * 1024 * 1024, `${bytes.byteLength} exceeds the 12 MiB ceiling`);
  const decodeStarted = performance.now();
  const decoded = decodeNavigationIndexArtifact(bytes);
  const decodeMs = performance.now() - decodeStarted;
  context.diagnostic(`100k entries: ${(bytes.byteLength / 1024 / 1024).toFixed(2)} MiB, decode ${decodeMs.toFixed(2)} ms`);
  assert.ok(decodeMs <= 100, `binary decode ${decodeMs.toFixed(2)} ms exceeds the 100 ms budget`);
  assert.equal(decoded.entryCount, MAX_NAVIGATION_INDEX_ENTRIES);
  assert.deepEqual(searchNavigationIndexPrefix(decoded, "poi 099999").map((item) => item.designRef.id), ["poi-099999"]);
});
