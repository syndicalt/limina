// gates/exchange/x0-roundtrip-check.mjs — Phase 13 / Track 4, X0 gate.
//
// Proves the asset-repository first cut: a QC-passed asset PUBLISHES to a content-addressed store
// and RESOLVES back byte-identically, its versioned CatalogEntry intact, against LOCAL object
// storage — the publish→hash→install→verify round-trip the X0 spike promises. Uses a REAL committed
// asset (the wooden bridge: glb + card + its catalog.json entry), not a fixture, so a break in the
// real publishable unit fails the gate.
//
// FALSIFIABILITY (failure mode #5): the gate proves it can FAIL — a TAMPERED object is caught by the
// content-address re-verify on resolve, a MALFORMED CatalogEntry is rejected at publish, and the
// host content address MUST equal the engine's assetContentAddress scheme (sha256 of the hex
// encoding) or a published asset's identity would diverge from what the engine pins on replay.
//
// Run: node gates/exchange/x0-roundtrip-check.mjs   (exit 0 = round-trip real · 1 = broken)

import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve as presolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { localStore, publish, resolve, contentAddress, validateEntry } from "../../tools/exchange/repo.mjs";

const ROOT = presolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
let failed = false;
const check = (name, cond) => { if (cond) console.log("  ok  " + name); else { console.error("  FAIL " + name); failed = true; } };

const GLB = join(ROOT, "assets/a-basic-wooden-bridge.glb");
const CARD = join(ROOT, "assets/a-basic-wooden-bridge.card.json");
if (!existsSync(GLB) || !existsSync(CARD)) {
  console.error("x0-roundtrip SKIP: the sample asset (a-basic-wooden-bridge.glb/.card.json) is missing.");
  process.exit(2);
}

// The published CatalogEntry: the wooden bridge's real catalog.json record.
const catalog = JSON.parse(readFileSync(join(ROOT, "assets/catalog.json"), "utf8"));
const entry = catalog.find((e) => e.id === "a-basic-wooden-bridge.glb");
if (!entry) { console.error("x0-roundtrip FAILED: the wooden bridge is not in assets/catalog.json."); process.exit(1); }

const glbBytes = readFileSync(GLB);
const cardBytes = readFileSync(CARD);

const dir = mkdtempSync(join(tmpdir(), "x0-repo-"));
try {
  const store = localStore(dir);

  // ── 1. PUBLISH → HASH → STORE ────────────────────────────────────────────────────────────────
  const pub = publish(store, { entry, glbBytes, cardBytes });
  check("publish content-addresses the glb (sha256: address)", /^sha256:[0-9a-f]{64}$/.test(pub.glb));
  check("publish content-addresses the card", /^sha256:[0-9a-f]{64}$/.test(pub.card));
  check("the object store holds the published bytes", store.has(pub.glb) && store.has(pub.card));
  check("a catalog record is keyed by the stable assetId", store.hasRecord("a-basic-wooden-bridge.glb"));

  // ── 2. RESOLVE (INSTALL) → VERIFY ─────────────────────────────────────────────────────────────
  const got = resolve(store, "a-basic-wooden-bridge.glb");
  check("resolve returns the glb bytes BYTE-IDENTICAL", Buffer.compare(got.glbBytes, glbBytes) === 0);
  check("resolve returns the card bytes byte-identical", Buffer.compare(got.cardBytes, cardBytes) === 0);
  check("the CatalogEntry survives the round-trip (id + authoredBy + boundsM)",
    got.entry.id === entry.id && got.entry.authoredBy === entry.authoredBy && JSON.stringify(got.entry.boundsM) === JSON.stringify(entry.boundsM));
  check("the published entry validates against the CatalogEntry contract", validateEntry(got.entry) === null);

  // ── 3. ENGINE-PARITY: the host address MUST match the engine's assetContentAddress scheme ──────
  // (sha256: + sha256(hex(bytes)) — proven against js/src/asset-registry.ts's documented algorithm).
  const expectHost = "sha256:" + (await import("node:crypto")).createHash("sha256").update(Buffer.from(glbBytes).toString("hex")).digest("hex");
  check("host content address == engine assetContentAddress scheme (sha256 of hex encoding)", contentAddress(glbBytes) === expectHost && pub.glb === expectHost);

  // ── 4. FALSIFIABILITY — tamper detection on resolve ───────────────────────────────────────────
  const tampered = Buffer.from(glbBytes); tampered[100] ^= 0xff; // flip one byte
  writeFileSync(join(dir, "objects", pub.glb.replace(/^sha256:/, "")), tampered); // corrupt the stored object
  let threw = false;
  try { resolve(store, "a-basic-wooden-bridge.glb"); } catch { threw = true; }
  check("(falsifiability) a TAMPERED object is caught by the content-address re-verify (throws)", threw);

  // ── 5. FALSIFIABILITY — a malformed CatalogEntry is rejected at publish ────────────────────────
  let rejected = false;
  try { publish(localStore(mkdtempSync(join(tmpdir(), "x0-bad-"))), { entry: { id: "x", title: "x", category: "NOPE", boundsM: [1, 1, 1] }, glbBytes }); }
  catch { rejected = true; }
  check("(falsifiability) a malformed CatalogEntry (bad category) is rejected at publish", rejected);
  check("(falsifiability) validateEntry flags a missing id", validateEntry({ title: "x", category: "prop", boundsM: [1, 1, 1] }) !== null);
} finally {
  rmSync(dir, { recursive: true, force: true });
}

if (failed) { console.error("\nx0-roundtrip: FAIL"); process.exit(1); }
console.log("\nx0-roundtrip OK: the asset-repository first cut round-trips — a real QC-passed asset publishes (content-addressed, engine-scheme identical), resolves back byte-identical with its CatalogEntry intact, and a tampered object or malformed entry is rejected. Local object storage; the marketplace stays a separate product, never an engine runtime dependency.");
process.exit(0);
