#!/usr/bin/env node
// migrate-north-negz.mjs — one-shot COORDINATE CONVENTION migration for a design-space vault
// (maps.json + world-bible.md): negate every z coordinate so the vault's world-space matches the
// locked convention NORTH = -z, EAST = +x (right-handed, consistent with THREE's default -z-forward
// and with east × north = up). Before this migration, vaults declared "+x = east, +z = north" — a
// left-handed geographic pairing that renders every north-up 3D view as an exact MIRROR of the 2D
// map (verified via the editor's viewport compass). See js/src/world/worldmap.ts's header for the
// engine-side statement of the same convention.
//
//   node tools/map/migrate-north-negz.mjs <vault-dir>
//
// What it negates:
//   - maps.json:   every feature's points[[x,z],...] -> [[x,-z],...]; every glyph {x,z} -> {x,-z}
//   - world-bible.md frontmatter: every `position: [x, z]` (locations[].position AND spawn.position)
//     -> [x, -z]; the zone note's coordinate declaration text is rewritten to state the new
//     convention (north = -z instead of +z = north).
//
// IDEMPOTENCE GUARD: a migrated maps.json carries a top-level "axes":"north-negz" marker. If that
// marker is already present, this script refuses to run again (negating twice would silently
// un-migrate the vault) — delete the marker only if you really mean to re-run from pre-migration
// data.
//
// Both files are rewritten IN PLACE. This script does not commit anything — the vault is expected
// to be its own git repo (or ungit); commit/inspect the diff yourself.

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";

function negNum(n) {
  const v = -n;
  return Object.is(v, -0) ? 0 : v;
}

function negatePoints(points) {
  let count = 0;
  for (const p of points) {
    if (Array.isArray(p) && p.length >= 2 && typeof p[1] === "number") {
      p[1] = negNum(p[1]);
      count++;
    }
  }
  return count;
}

function migrateMapsJson(mapsJsonPath) {
  const doc = JSON.parse(readFileSync(mapsJsonPath, "utf8"));
  if (doc.axes === "north-negz") {
    throw new Error(`${mapsJsonPath}: already migrated (axes:"north-negz" marker present) — refusing to run twice`);
  }
  let featureCount = 0;
  let pointCount = 0;
  for (const map of doc.maps || []) {
    for (const f of map.features || []) {
      if (Array.isArray(f.points)) {
        pointCount += negatePoints(f.points);
        featureCount++;
      }
      if (f.type === "glyph" && typeof f.z === "number") {
        f.z = negNum(f.z);
        featureCount++;
        pointCount++;
      }
    }
  }
  doc.axes = "north-negz";
  writeFileSync(mapsJsonPath, JSON.stringify(doc, null, 2) + "\n", "utf8");
  return { featureCount, pointCount };
}

// ---- world-bible.md frontmatter: negate every `position: [x, z]` (locations + spawn), and
// rewrite the zone note's coordinate-declaration text. Operates on raw text (not a YAML parse) to
// preserve the vault author's exact formatting elsewhere in the frontmatter — mirrors the targeted
// regex-reader strategy js/src/world/design-map-compile.mjs already uses for this same file. ----

function migrateWorldBible(worldBiblePath) {
  const text = readFileSync(worldBiblePath, "utf8");
  const fmMatch = text.match(/^(---\r?\n)([\s\S]*?)(\r?\n---)/);
  if (!fmMatch) throw new Error(`${worldBiblePath}: no YAML frontmatter block found`);
  const [whole, open, fmBody, close] = fmMatch;

  let positionCount = 0;
  const posRe = /position:\s*\[\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*\]/g;
  let newFmBody = fmBody.replace(posRe, (match, x, z) => {
    positionCount++;
    const negZ = negNum(Number(z));
    return `position: [${x}, ${negZ}]`;
  });

  // Zone note: "... +x = east (toward the Blight), +z = north" -> lead with the new convention,
  // keep any parenthetical flavor text attached to +x, drop the now-redundant "+z = north" tail.
  const combinedRe = /\+x\s*=\s*east([^,\n]*),\s*\+z\s*=\s*north/i;
  let noteRewritten = false;
  if (combinedRe.test(newFmBody)) {
    newFmBody = newFmBody.replace(combinedRe, (match, xFlavor) => {
      noteRewritten = true;
      return `north = -z (screen-up in the map tool); +x = east${xFlavor}`;
    });
  } else if (/\+z\s*=\s*north/i.test(newFmBody)) {
    newFmBody = newFmBody.replace(/\+z\s*=\s*north/i, () => {
      noteRewritten = true;
      return "north = -z (screen-up in the map tool); +x = east";
    });
  }

  const newText = text.slice(0, fmMatch.index) + open + newFmBody + close + text.slice(fmMatch.index + whole.length);
  writeFileSync(worldBiblePath, newText, "utf8");
  return { positionCount, noteRewritten };
}

const vaultDir = process.argv[2];
if (!vaultDir) {
  console.error("usage: node tools/map/migrate-north-negz.mjs <vault-dir>");
  process.exit(1);
}
const dir = resolve(vaultDir);
const mapsJsonPath = join(dir, "maps.json");
const worldBiblePath = join(dir, "world-bible.md");
if (!existsSync(mapsJsonPath)) { console.error(`not found: ${mapsJsonPath}`); process.exit(1); }
if (!existsSync(worldBiblePath)) { console.error(`not found: ${worldBiblePath}`); process.exit(1); }

let mapsResult, bibleResult;
try {
  mapsResult = migrateMapsJson(mapsJsonPath);
  bibleResult = migrateWorldBible(worldBiblePath);
} catch (err) {
  console.error(String(err.message || err));
  process.exit(1);
}

console.log(`migrated ${dir}`);
console.log(`  maps.json:       ${mapsResult.featureCount} features, ${mapsResult.pointCount} points/glyphs z-negated; marker "axes":"north-negz" written`);
console.log(`  world-bible.md:  ${bibleResult.positionCount} position:[x,z] entries z-negated; zone note ${bibleResult.noteRewritten ? "rewritten" : "UNCHANGED (pattern not found — check manually)"}`);
