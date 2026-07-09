#!/usr/bin/env node
// compile-designmap.mjs — compile a design-space vault's active (or named) map + world-bible
// into a WorldMap IR file under assets/maps/, the format the terrain/vegetation/structure build
// pipeline will consume (Phase 0 of "Map-Driven Worlds": this file only PRODUCES the IR — nothing
// downstream reads it yet).
//
//   node tools/map/compile-designmap.mjs <vault-dir> [--map <mapId>] [--out <path>]
//
// All the actual compilation logic (the frontmatter reading, the scale-contract check, the
// feature -> land/biome/relief/waterway/route/anchor mapping, the content hash) lives in the pure
// js/src/world/design-map-compile.mjs, gated directly by js/test/p_worldmap_compile.ts. This file
// is deliberately thin: read two files, call that function, write the result, print a summary.

import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync, rmSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { compileDesignMap } from "../../js/src/world/design-map-compile.mjs";

function parseArgs(argv) {
  const args = { vaultDir: undefined, mapId: undefined, out: undefined };
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--map") { args.mapId = argv[++i]; }
    else if (a === "--out") { args.out = argv[++i]; }
    else positional.push(a);
  }
  args.vaultDir = positional[0];
  return args;
}

const args = parseArgs(process.argv.slice(2));
if (!args.vaultDir) {
  console.error("usage: node tools/map/compile-designmap.mjs <vault-dir> [--map <mapId>] [--out <path>]");
  process.exit(1);
}

const vaultDir = resolve(args.vaultDir);
const projectRoot = basename(vaultDir) === "design" ? dirname(vaultDir) : vaultDir;
const mapsJsonPath = join(vaultDir, "maps.json");
const worldBiblePath = join(vaultDir, "world-bible.md");
if (!existsSync(mapsJsonPath)) { console.error(`not found: ${mapsJsonPath}`); process.exit(1); }
if (!existsSync(worldBiblePath)) { console.error(`not found: ${worldBiblePath}`); process.exit(1); }

const mapsJsonText = readFileSync(mapsJsonPath, "utf8");
const worldBibleText = readFileSync(worldBiblePath, "utf8");
// Places (Stage 4): thread places.md when the vault carries one, so the compiled asset embeds the
// gazetteer + place-marker anchors. Optional — a vault without a places doc compiles unchanged.
const placesPath = join(vaultDir, "places.md");
const placesText = existsSync(placesPath) ? readFileSync(placesPath, "utf8") : undefined;

let worldMap, warnings;
try {
  ({ worldMap, warnings } = compileDesignMap({ mapsJsonText, worldBibleText, mapId: args.mapId, placesText }));
} catch (err) {
  console.error(String(err.message || err));
  process.exit(1);
}

const outPath = args.out
  ? resolve(args.out)
  : join(projectRoot, "assets", "maps", worldMap.id, `${worldMap.provenance.contentHash}.worldmap.json`);
mkdirSync(dirname(outPath), { recursive: true });
// Pretty-printed for human review; the content hash is computed over the STABLE (compact,
// fixed-key-order) form, so pretty-printing here has no effect on verification.
const temporary = `${outPath}.tmp-${process.pid}`;
try {
  writeFileSync(temporary, JSON.stringify(worldMap, null, 2) + "\n", "utf8");
  renameSync(temporary, outPath);
} finally {
  rmSync(temporary, { force: true });
}

for (const w of warnings) console.warn("warning:", w);
console.log(`compiled map "${worldMap.id}" -> ${outPath}`);
console.log(`  asset id:     ${outPath.slice(join(projectRoot, "assets").length + 1).replaceAll("\\", "/")}`);
console.log(`  land rings:   ${worldMap.land.length}`);
console.log(`  relief hints: ${worldMap.relief.length}`);
console.log(`  biomes:       ${worldMap.biomes.length} (${worldMap.biomes.map((b) => b.biome).join(", ")})`);
console.log(`  waterways:    ${worldMap.waterways.length}`);
console.log(`  routes:       ${worldMap.routes.length}`);
console.log(`  anchors:      ${worldMap.anchors.length} (${worldMap.anchors.map((a) => `${a.id}:${a.kind}`).join(", ")})`);
console.log(`  extent:       ${worldMap.extent.w.toFixed(1)} x ${worldMap.extent.h.toFixed(1)} m`);
console.log(`  contentHash:  ${worldMap.provenance.contentHash}`);
