// tools/exchange/repo.mjs — the content-addressed asset REPOSITORY (Phase 13 / Track 4, X0).
//
// The cloud asset repository the pipeline leans on, as a pluggable STORE + a pure publish/resolve
// round-trip. This is HOST-SIDE tooling: the marketplace is a separate product, NEVER an engine
// runtime dependency (the engine consumes published assets through its existing AssetSource seam,
// js/src/asset/). This module owns the WIRE FORMAT of published identity — the X0 decision:
//
//   • Content address: "sha256:" + sha256( HEX-ENCODING of the bytes ) — byte-identical to the
//     engine's assetContentAddress (js/src/asset-registry.ts): op_sha256 hashes the hex string, so
//     a host repo must hash the hex string too, or addresses would diverge from what the engine
//     pins. assetId (the human id, e.g. "a-basic-wooden-bridge.glb") is the STABLE identity; the
//     content address is the integrity/version address. Both are recorded.
//   • Publishable unit: { CatalogEntry (versioned zod, carries authoredBy), glb bytes, optional
//     card + qcRender bytes }. The CatalogEntry schema lives with the engine (asset-catalog.ts);
//     this repo validates against a structural mirror so a malformed entry is rejected at publish.
//
// The Store is an interface (publish-first against LOCAL object storage; a CDN/bucket backend
// implements the same three methods later without touching callers):
//   put(address, bytes) · get(address) -> bytes · has(address) -> bool
//
// publish(store, unit)  -> { assetId, glb: address, card?: address, entry }  (writes objects + a
//                          catalog record keyed by assetId)
// resolve(store, id)    -> { entry, glbBytes, cardBytes? }  — re-verifies every fetched object's
//                          content address (a tamper/corruption THROWS: the repo is the trust root).

import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

/** "sha256:" + sha256(hex(bytes)) — matches js/src/asset-registry.ts assetContentAddress exactly. */
export function contentAddress(bytes) {
  const hex = Buffer.from(bytes).toString("hex");
  return "sha256:" + createHash("sha256").update(hex).digest("hex");
}

const CATEGORIES = new Set(["prop", "dwelling", "civic", "military", "religious"]);

/** Structural validation of a CatalogEntry (mirror of asset-catalog.ts's zod schema — the fields a
 *  published entry MUST carry). Returns null on ok, or a reason string. Kept dependency-free so the
 *  repo tooling runs under plain node without importing the engine's zod bundle. */
export function validateEntry(e) {
  if (!e || typeof e !== "object") return "entry is not an object";
  if (typeof e.id !== "string" || e.id.length === 0) return "entry.id missing";
  if (typeof e.title !== "string" || e.title.length === 0) return "entry.title missing";
  if (!CATEGORIES.has(e.category)) return `entry.category invalid (${e.category})`;
  if (!Array.isArray(e.boundsM) || e.boundsM.length !== 3 || e.boundsM.some((n) => typeof n !== "number")) return "entry.boundsM must be [w,h,d] numbers";
  if (e.authoredBy !== undefined && typeof e.authoredBy !== "string") return "entry.authoredBy must be a string";
  return null;
}

/** A local-filesystem object store: objects/<sha256-hex> for content, catalog/<id>.json for records.
 *  The X0 "local object storage" backend; a bucket/CDN store implements the same three methods. */
export function localStore(rootDir) {
  const objects = join(rootDir, "objects");
  const catalog = join(rootDir, "catalog");
  mkdirSync(objects, { recursive: true });
  mkdirSync(catalog, { recursive: true });
  const objPath = (address) => join(objects, address.replace(/^sha256:/, ""));
  return {
    kind: "local",
    put(address, bytes) { writeFileSync(objPath(address), bytes); },
    get(address) { return readFileSync(objPath(address)); },
    has(address) { return existsSync(objPath(address)); },
    putRecord(id, record) { writeFileSync(join(catalog, encodeURIComponent(id) + ".json"), JSON.stringify(record, null, 2)); },
    getRecord(id) { return JSON.parse(readFileSync(join(catalog, encodeURIComponent(id) + ".json"), "utf8")); },
    hasRecord(id) { return existsSync(join(catalog, encodeURIComponent(id) + ".json")); },
  };
}

/** Publish a QC-passed asset to the repo: content-address the bytes, store the objects, write a
 *  catalog record keyed by the (stable) assetId. Idempotent — re-publishing identical bytes is a
 *  no-op address. Throws on a malformed entry (a bad publishable unit never lands). */
export function publish(store, { entry, glbBytes, cardBytes }) {
  const reason = validateEntry(entry);
  if (reason) throw new Error(`publish: invalid CatalogEntry — ${reason}`);
  if (!(glbBytes && glbBytes.length > 0)) throw new Error("publish: glbBytes required");
  const glb = contentAddress(glbBytes);
  store.put(glb, glbBytes);
  let card;
  if (cardBytes && cardBytes.length > 0) { card = contentAddress(cardBytes); store.put(card, cardBytes); }
  const record = { assetId: entry.id, entry, glb, ...(card ? { card } : {}), format: "limina-asset/1" };
  store.putRecord(entry.id, record);
  return { assetId: entry.id, glb, card, entry };
}

/** Resolve a published asset by its stable assetId: read the record, fetch every object, and
 *  RE-VERIFY its content address. A mismatch THROWS — the repo is the integrity trust root, so a
 *  tampered/corrupted object must never be served (distinct from asset.place's in-world
 *  warn-not-throw, which tolerates the cross-HOST op_sha256 nuance; here host==host). */
export function resolve(store, id) {
  if (!store.hasRecord(id)) throw new Error(`resolve: no published asset '${id}'`);
  const record = store.getRecord(id);
  const glbBytes = store.get(record.glb);
  const glbActual = contentAddress(glbBytes);
  if (glbActual !== record.glb) throw new Error(`resolve: '${id}' glb content-address mismatch (record ${record.glb}, actual ${glbActual}) — refusing a tampered object`);
  let cardBytes;
  if (record.card) {
    cardBytes = store.get(record.card);
    const cardActual = contentAddress(cardBytes);
    if (cardActual !== record.card) throw new Error(`resolve: '${id}' card content-address mismatch — refusing a tampered object`);
  }
  return { entry: record.entry, glbBytes, cardBytes, record };
}
