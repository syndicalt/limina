// make-card.mjs — generate an assets/<id>.card.json for an authored GLB by MEASURING its real
// world bbox (reusing tools/qc/asset-sanity.mjs's transform-aware GLB-bbox walk) instead of a human
// hand-typing boundsM. Closes the "no card generator for Blender/agent-authored GLBs" gap: every
// hand-written card in assets/*.card.json to date risked drifting from the actual baked geometry.
//
// Refuses (non-zero exit) to card a broken asset — same DEGENERATE/OVERSIZE thresholds
// asset-sanity.mjs scans the whole library with — so a bad bake can't silently get a card and
// flow downstream into the catalog.
//
// Usage: node tools/asset/make-card.mjs <assetId.glb> <title> [--category <prop|dwelling|civic|military|religious>]
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, resolve, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { glbBbox, classifyBounds } from "../qc/asset-sanity.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CATEGORIES = ["prop", "dwelling", "civic", "military", "religious"];

/** Measure assetId's GLB and return the card object {id, title, boundsM} — boundsM rounded to 3
 *  decimals, in the same [dx,dy,dz] world-meters order asset-sanity.mjs reports. Throws (does not
 *  print or exit) on a missing file, a non-.glb id, no POSITION bounds, or a DEGENERATE/OVERSIZE
 *  bbox — callers (this file's CLI, architect-run.mjs) decide how to surface that.
 *  `category`, if given, is validated against the catalog.publish enum but is NOT written into the
 *  card — no card in the repo carries a category key; that's catalog.publish's field, assigned at
 *  propose time, not a property of the baked geometry. */
export function measureCard(assetId, title, category) {
  if (!assetId.endsWith(".glb")) throw new Error(`assetId must end in .glb: ${assetId}`);
  if (category !== undefined && !CATEGORIES.includes(category)) {
    throw new Error(`--category must be one of ${CATEGORIES.join("|")}, got: ${category}`);
  }
  const glbPath = join(ROOT, "assets", assetId);
  if (!existsSync(glbPath)) throw new Error(`no such asset: assets/${assetId}`);

  const buf = readFileSync(glbPath);
  let bb;
  try {
    bb = glbBbox(buf);
  } catch (e) {
    throw new Error(`${assetId}: failed to parse GLB (${String(e).slice(0, 100)})`);
  }
  if (bb === null) throw new Error(`${assetId}: NO-BOUNDS — no POSITION min/max found, can't measure`);

  const d = bb.mx.map((v, i) => v - bb.mn[i]);
  const flags = classifyBounds(d, bb.mn);
  const blocking = flags.filter((f) => f.startsWith("DEGENERATE") || f.startsWith("OVERSIZE"));
  if (blocking.length > 0) {
    const size = d.map((v) => v.toFixed(2)).join(" × ");
    throw new Error(`${assetId}: ${blocking.join(" ")} [${size} m] — refusing to card a broken asset`);
  }

  const boundsM = d.map((v) => Math.round(v * 1000) / 1000);
  const id = basename(assetId, ".glb");
  return { id, title, boundsM };
}

/** Write the card to assets/<id>.card.json and return the path written. Separated from
 *  measureCard so architect-run.mjs can measure once and reuse the same card object without a
 *  double file round-trip if it ever needs to. */
export function writeCard(card) {
  const cardPath = join(ROOT, "assets", `${card.id}.card.json`);
  writeFileSync(cardPath, JSON.stringify(card) + "\n");
  return cardPath;
}

function isMain() {
  return resolve(process.argv[1] || "") === fileURLToPath(import.meta.url);
}

if (isMain()) {
  const args = process.argv.slice(2);
  const positional = [];
  let category;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--category") { category = args[++i]; continue; }
    positional.push(args[i]);
  }
  const [assetId, title] = positional;
  if (!assetId || !title) {
    console.error("usage: node tools/asset/make-card.mjs <assetId.glb> <title> [--category <prop|dwelling|civic|military|religious>]");
    process.exit(2);
  }
  try {
    const card = measureCard(assetId, title, category);
    const path = writeCard(card);
    console.log(`wrote ${path}`);
    console.log(JSON.stringify(card, null, 2));
  } catch (e) {
    console.error("make-card failed:", e.message);
    process.exit(1);
  }
}
