#!/usr/bin/env node
// compile-fmg.mjs — compile an Azgaar Fantasy-Map-Generator "Full JSON" export into a WorldMap
// IR file under assets/maps/, the same format tools/map/compile-designmap.mjs produces from a
// design-space vault (Phase 2.1 of "Map-Driven Worlds": FMG becomes a second front-end to the
// same IR the terrain/vegetation/structure pipeline consumes).
//
//   node tools/map/compile-fmg.mjs <full-export.json> [--out <path>] [--map-id <id>] [--min-pop N]
//     [--crop <burgName|x,y-px> --radius <meters>]
//
// --crop/--radius keep only a disc of cells around an anchor (a burg name, or raw "x,y-px" pixel
// coordinates) re-centered to world (0,0), at the export's NATIVE meters/px — the way a real
// (often whole-planet-scale) export becomes a walkable region without every feature shrinking
// into flat, uniform stripes. Both flags are required together.
//
// All the actual compilation logic (the version gate, the px->meter scale contract, the
// coastline trace, relief/biome grouping, river/route/burg mapping, the crop/subset + re-center,
// the content hash) lives in the pure js/src/world/fmg-map-compile.mjs, gated directly by
// js/test/p_fmg_compile.ts. This file is deliberately thin: read one file, call that function,
// write the result, print a summary.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { compileFmgMap } from "../../js/src/world/fmg-map-compile.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const LIMINA_HOME = resolve(__dirname, "..", "..");

function parseArgs(argv) {
  const args = { input: undefined, out: undefined, mapId: undefined, minPop: undefined, crop: undefined, radius: undefined };
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--out") { args.out = argv[++i]; }
    else if (a === "--map-id") { args.mapId = argv[++i]; }
    else if (a === "--min-pop") { args.minPop = Number(argv[++i]); }
    else if (a === "--crop") { args.crop = argv[++i]; }
    else if (a === "--radius") { args.radius = Number(argv[++i]); }
    else positional.push(a);
  }
  args.input = positional[0];
  return args;
}

const args = parseArgs(process.argv.slice(2));
if (!args.input) {
  console.error("usage: node tools/map/compile-fmg.mjs <full-export.json> [--out <path>] [--map-id <id>] [--min-pop N] [--crop <burgName|x,y-px> --radius <meters>]");
  process.exit(1);
}
const inputPath = resolve(args.input);
if (!existsSync(inputPath)) { console.error(`not found: ${inputPath}`); process.exit(1); }
if (args.minPop !== undefined && !(args.minPop >= 0)) { console.error("--min-pop must be a number >= 0"); process.exit(1); }
if ((args.crop !== undefined) !== (args.radius !== undefined)) {
  console.error("--crop and --radius must be given together");
  process.exit(1);
}
if (args.radius !== undefined && !(args.radius > 0)) { console.error("--radius must be a positive number of meters"); process.exit(1); }

const fmgJsonText = readFileSync(inputPath, "utf8");

let worldMap, warnings;
try {
  ({ worldMap, warnings } = compileFmgMap(fmgJsonText, {
    ...(args.mapId !== undefined ? { mapId: args.mapId } : {}),
    ...(args.minPop !== undefined ? { anchorMinPopulation: args.minPop } : {}),
    ...(args.crop !== undefined ? { crop: { anchor: args.crop, radiusM: args.radius } } : {}),
  }));
} catch (err) {
  console.error(String(err.message || err));
  process.exit(1);
}

const outPath = args.out
  ? resolve(args.out)
  : join(LIMINA_HOME, "assets", "maps", `${worldMap.id}.worldmap.json`);
mkdirSync(dirname(outPath), { recursive: true });
// Pretty-printed for human review; the content hash is computed over the STABLE (compact,
// fixed-key-order) form, so pretty-printing here has no effect on verification.
writeFileSync(outPath, JSON.stringify(worldMap, null, 2) + "\n", "utf8");

for (const w of warnings) console.warn("warning:", w);
console.log(`compiled FMG export "${worldMap.id}" -> ${outPath}`);
if (worldMap.provenance.cropOf) {
  const c = worldMap.provenance.cropOf;
  console.log(`  crop:           anchor="${c.anchor}" (px ${c.anchorPx[0].toFixed(1)},${c.anchorPx[1].toFixed(1)}) radius=${c.radiusM}m`);
}
console.log(`  islands (land): ${worldMap.land.length}${worldMap.land.some((l) => l.holes) ? " (with holes)" : ""}`);
console.log(`  relief hints:   ${worldMap.relief.length} (${worldMap.relief.map((r) => r.kind).join(", ")})`);
console.log(`  biomes:         ${worldMap.biomes.length} (${worldMap.biomes.map((b) => b.biome).join(", ")})`);
console.log(`  waterways:      ${worldMap.waterways.length}`);
console.log(`  routes:         ${worldMap.routes.length} (${worldMap.routes.map((r) => r.class).join(", ")})`);
console.log(`  anchors:        ${worldMap.anchors.length} (${worldMap.anchors.map((a) => `${a.id}:${a.kind}`).join(", ")})`);
console.log(`  extent:         ${worldMap.extent.w.toFixed(1)} x ${worldMap.extent.h.toFixed(1)} m`);
console.log(`  contentHash:    ${worldMap.provenance.contentHash}`);
