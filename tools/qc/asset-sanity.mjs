// Asset sanity scan — the guard that would have caught the 1.8km "grass tuft" and the
// 0-size leaves before they reached a build. For every assets/*.glb, parse the GLB JSON
// chunk, union the POSITION accessor min/max into one bbox, and flag:
//   • DEGENERATE  — any dimension ≈ 0 (empty / broken geometry)
//   • OVERSIZE    — any dimension beyond a sane world cap (garbage authored scale)
//   • OFF-GROUND  — min-y far from 0 (won't sit on terrain; informational)
//   • NO-BOUNDS   — no POSITION min/max in the file (can't be validated)
// Read-only. Usage: node tools/qc/asset-sanity.mjs [assetsDir]
//
// glbBbox / CAP_M / DEGEN_M / classifyBounds are exported so other host tools (make-card.mjs,
// architect-run.mjs) can measure + classify a single GLB's world bbox without re-deriving this
// transform-aware walk — the CLI below is unchanged (same output, same exit codes).
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { measureGlb } from "../../gates/design/asset-qc-gate.mjs";
import { readAssetManifest, runAssetManifestGate } from "./asset-manifest.mjs";

export const CAP_M = 60;        // nothing in the library should exceed ~60m in any axis (a big keep is ~20m)
export const DEGEN_M = 0.02;    // any axis under 2cm ⇒ effectively empty

// TRANSFORM-AWARE world bbox: walk the scene node hierarchy, accumulate each node's world
// matrix, and for every mesh transform its primitives' POSITION accessor min/max (all 8
// corners) into world space — the SAME size a scatter/place sees. Ignoring node transforms
// (raw accessor bounds) mis-reads assets that carry scale/offset in their nodes. The asset-QC
// gate owns this general-purpose walk; this compatibility wrapper preserves the long-standing
// {mn,mx} API used by host tools without maintaining a second matrix implementation.
export function glbBbox(buf) {
  if (!buf || buf.byteLength < 4) throw new RangeError("invalid GLB header");
  const header = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  if (header.getUint32(0, true) !== 0x46546c67) return null; // Preserve the GLB-only compatibility API.
  const measured = measureGlb(buf);
  if (!measured.readable) throw new Error("invalid GLB");
  if (measured.bboxMin === null || measured.bboxMax === null) return null;
  return { mn: measured.bboxMin.slice(), mx: measured.bboxMax.slice() };
}

// Given a world-space size [dx,dy,dz] and min-corner [x0,y0,z0] (as returned by glbBbox: d = mx-mn,
// mn = bb.mn), return the same flag strings the CLI prints — DEGENERATE / OVERSIZE / OFF-GROUND(y0=…).
// Empty array = clean. Kept as the single source of truth so make-card.mjs / architect-run.mjs
// classify a bbox identically to this scan.
export function classifyBounds(d, mn) {
  const flags = [];
  // DEGENERATE = no meaningful extent at all (a point/empty mesh). A single flat axis is fine
  // (billboards, leaves, decals, a ground quad), so gate on the LARGEST dimension, not any.
  if (Math.max(...d) < DEGEN_M) flags.push("DEGENERATE");
  if (d.some((v) => v > CAP_M)) flags.push("OVERSIZE");
  if (Math.abs(mn[1]) > 1.0) flags.push(`OFF-GROUND(y0=${mn[1].toFixed(1)})`);
  return flags;
}

// Guard the CLI scan behind an entry-point check: importing this module (make-card.mjs,
// architect-run.mjs) for its exports must NOT re-run the whole-library scan or process.exit —
// only `node tools/qc/asset-sanity.mjs [assetsDir]` does. Behavior/output when run directly is
// unchanged.
function isMain() {
  return resolve(process.argv[1] || "") === fileURLToPath(import.meta.url);
}

function recursiveGlbs(root, directory = root, output = []) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) recursiveGlbs(root, path, output);
    else if (entry.isFile() && entry.name.endsWith(".glb")) output.push(relative(root, path));
  }
  return output.sort();
}

if (isMain()) {
  const DIR = process.argv[2] || "assets";
  if (!existsSync(DIR)) { console.error("no dir:", DIR); process.exit(2); }
  const manifestPath = join(DIR, "manifest.json");
  const manifest = existsSync(manifestPath) ? readAssetManifest(manifestPath) : null;
  const acceptedPaths = new Set((manifest?.entries ?? []).map((entry) => entry?.model?.path).filter(Boolean));
  const glbs = recursiveGlbs(DIR);
  const rows = [];
  for (const f of glbs) {
    let bb; try { bb = glbBbox(readFileSync(join(DIR, f))); } catch (e) { rows.push({ f, flag: "PARSE-ERR", note: String(e).slice(0, 60) }); continue; }
    if (bb === null) { rows.push({ f, flag: "NO-BOUNDS", note: "no POSITION min/max" }); continue; }
    const d = bb.mx.map((v, i) => v - bb.mn[i]);
    const size = d.map((v) => v.toFixed(2)).join(" × ");
    const flags = classifyBounds(d, bb.mn);
    rows.push({ f, flag: flags.join(" ") || "ok", note: size + " m" });
  }
  const bad = rows.filter((r) => r.flag !== "ok");
  const acceptedBad = bad.filter((r) => acceptedPaths.has(r.f));
  for (const r of bad) {
    const accepted = acceptedPaths.has(r.f);
    console.log(`  ${accepted ? "✗" : "!"} ${(accepted ? r.flag : `EXCLUDED ${r.flag}`).padEnd(31)} ${r.f}  [${r.note}]`);
  }
  console.log(`\n${glbs.length} GLBs recursively scanned — ${acceptedBad.length} accepted failures, ${bad.length - acceptedBad.length} excluded warnings.`);
  let manifestFailed = false;
  if (manifest === null) {
    console.log("  ✗ MANIFEST-MISSING accepted assets have no canonical provenance boundary");
    manifestFailed = true;
  } else {
    const verdict = runAssetManifestGate(manifest, { assetRoot: DIR });
    for (const failure of verdict.failures) console.log(`  ✗ MANIFEST ${failure.assetId} ${failure.gate}: ${failure.detail}`);
    console.log(`Asset manifest — accepted=${verdict.acceptedEntries}, candidates=${verdict.candidates}, mechanical=${verdict.mechanicalPass ? "pass" : "FAIL"}, human-visual=${verdict.humanVisualPass ? "pass" : "FAIL"}.`);
    manifestFailed = !verdict.pass;
  }
  process.exit(manifestFailed || acceptedBad.some((r) => /DEGENERATE|OVERSIZE|PARSE-ERR/.test(r.flag)) ? 1 : 0);
}
