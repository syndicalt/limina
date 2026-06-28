// Headless construction check for the OPT-IN elevation+biome colour ramp (terrain/render.ts).
//
// The ramp's LOOK is UAT (landscape_window.ts / model_terrain_window.ts), but its node graph +
// climate DataTexture must BUILD without error headlessly (the same way p11_water builds the
// water node graph headlessly). Also pins the no-regression contract: with NO palette/shoreline
// the material keeps the flat-colour defaults byte-for-byte.
//
// Run: limina js/test/p11_terrain_ramp.ts   (exit 0 = pass)

import { buildTerrainMesh } from "../src/terrain/render.ts";
import { ProceduralTerrainSource, TILE_SIZE } from "../src/terrain/procedural.ts";
import { terrainTypeHints } from "../src/terrain/terrain-types.ts";
import { biomeScatterConfigs, surveyRegionRelief } from "../src/terrain/biome-content.ts";
import { scatterAssets } from "../src/terrain/asset-scatter.ts";
import { ops } from "../src/engine.ts";

function assert(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new Error("p11_terrain_ramp FAIL: " + msg);
}

const SEED = 1234;
const source = new ProceduralTerrainSource();
const bounds = { minTx: 0, minTz: 0, maxTx: 1, maxTz: 1 };
const hints = { ...terrainTypeHints("mountains", bounds), erode: 1 };
const tile = source.generateTile({ seed: SEED, tx: 0, tz: 0, lod: 0, hints });

// (1) DEFAULT (no palette, no shoreline): flat-colour material, no colorNode/roughnessNode set.
const flat = buildTerrainMesh(tile, { color: 0x4a6b3a, roughness: 0.9 });
// deno-lint-ignore no-explicit-any
const flatMat = flat.material as any;
assert(flatMat.colorNode === undefined || flatMat.colorNode === null, "default material must NOT set a colorNode (no regression)");
assert(flatMat.roughnessNode === undefined || flatMat.roughnessNode === null, "default material must NOT set a roughnessNode (no regression)");

// (2) PALETTE: the ramp builds a colorNode + roughnessNode + climate DataTexture without error.
const sea = tile.origin[1] + 0.2 * tile.scale[1];
const ramp = buildTerrainMesh(tile, {
  roughness: 0.95,
  palette: { seaLevel: sea, minY: tile.origin[1], maxY: tile.origin[1] + tile.scale[1] },
});
// deno-lint-ignore no-explicit-any
const rampMat = ramp.material as any;
assert(rampMat.colorNode !== undefined && rampMat.colorNode !== null, "palette must set a colorNode");
assert(rampMat.roughnessNode !== undefined && rampMat.roughnessNode !== null, "palette must set a roughnessNode");
assert(ramp.geometry.getAttribute("position").count === tile.nrows * tile.ncols, "ramp geometry vertex count wrong");

// (3) PALETTE with default relief (derived from the tile heights) also builds.
const ramp2 = buildTerrainMesh(tile, { palette: { seaLevel: sea } });
// deno-lint-ignore no-explicit-any
assert((ramp2.material as any).colorNode != null, "palette with default relief must still build a colorNode");

// (4) A tile with NO climate still bakes (neutral fallback) — robustness.
const noClimate = { ...tile, climate: undefined, climateChannels: undefined };
const ramp3 = buildTerrainMesh(noClimate, { palette: { seaLevel: sea } });
// deno-lint-ignore no-explicit-any
assert((ramp3.material as any).colorNode != null, "palette must build even when the tile has no climate grid");

// (5) Render-only vertical exaggeration: identity (factor 1) leaves Y untouched; factor>1 lifts
//     above the pivot and recomputes (geometry only).
const pivot = sea;
const plainGeomY = ramp.geometry.getAttribute("position").getY(0);
const exag = buildTerrainMesh(tile, { palette: { seaLevel: sea }, exaggerateY: { factor: 2, pivot } });
const exagY = exag.geometry.getAttribute("position").getY(0);
const expected = pivot + (plainGeomY - pivot) * 2;
assert(Math.abs(exagY - expected) < 1e-3, `exaggerateY must scale Y about the pivot (got ${exagY}, expected ${expected})`);

// (6) FALSIFIABLE NO-PROPS-IN-WATER: scatter the mountains content over an eroded, FLOODED
//     region and assert ZERO instances sit at/below the water line. The exclusion is the
//     waterGated layers' elevationMin = waterLevel + margin, evaluated by scatterAssets against
//     the SAME eroded tile heights the lakes sit in. Falsifiable: the un-gated configs (no
//     waterLevel) DO place props below the water, proving the gate is what excludes them.
const rbounds = { minTx: 0, minTz: 0, maxTx: 1, maxTz: 1 };
const rhints = { ...terrainTypeHints("mountains", rbounds), amp: 4.5, erode: 1 };
const rsurvey = surveyRegionRelief(source, SEED, rbounds, rhints);
// Flood the low 40% so a good chunk of the eroded surface is genuinely under water.
const waterLevel = rsurvey.minY + 0.4 * (rsurvey.maxY - rsurvey.minY);
const MARGIN = 1.0;
const rtiles = [];
for (let tz = rbounds.minTz; tz <= rbounds.maxTz; tz++) {
  for (let tx = rbounds.minTx; tx <= rbounds.maxTx; tx++) {
    rtiles.push(source.generateTile({ seed: SEED, tx, tz, lod: 0, hints: rhints }));
  }
}

const gatedConfigs = biomeScatterConfigs("mountains", rsurvey, waterLevel, MARGIN);
let gatedTotal = 0, gatedBelow = 0;
for (const cfg of gatedConfigs) {
  for (const t of rtiles) {
    for (const inst of scatterAssets(t, SEED, cfg)) { gatedTotal++; if (inst.y < waterLevel) gatedBelow++; }
  }
}
assert(gatedTotal > 0, "water-exclusion: expected SOME gated props to place above the water line");
assert(gatedBelow === 0, `water-exclusion: ${gatedBelow}/${gatedTotal} gated props are AT/BELOW the water line (must be 0)`);

// Falsifiability: the SAME content with NO water level placed props below the water line.
const looseConfigs = biomeScatterConfigs("mountains", rsurvey); // no waterLevel → no water floor
let looseBelow = 0;
for (const cfg of looseConfigs) {
  for (const t of rtiles) {
    for (const inst of scatterAssets(t, SEED, cfg)) { if (inst.y < waterLevel) looseBelow++; }
  }
}
assert(looseBelow > 0, "water-exclusion NOT falsifiable: even un-gated configs placed nothing below water (no flooded terrain to test against)");

// (7) HEALTHY PINES on the EXACT landscape config (mountains, amp 4.5, erode, 4×4, sea 18%,
//     margin 1.0): a forested lower mountain needs pines to dominate boulders, not the reverse.
//     Before the fix pines were cropped into a thin band (≈222) below the boulders (≈360).
const lbounds = { minTx: 0, minTz: 0, maxTx: 3, maxTz: 3 };
const lhints = { ...terrainTypeHints("mountains", lbounds), amp: 4.5, erode: 1 };
const lsurvey = surveyRegionRelief(source, SEED, lbounds, lhints);
const lsea = lsurvey.minY + 0.18 * (lsurvey.maxY - lsurvey.minY);
const ltiles = [];
for (let tz = lbounds.minTz; tz <= lbounds.maxTz; tz++) {
  for (let tx = lbounds.minTx; tx <= lbounds.maxTx; tx++) {
    ltiles.push(source.generateTile({ seed: SEED, tx, tz, lod: 0, hints: lhints }));
  }
}
const [pineCfg, boulderCfg] = biomeScatterConfigs("mountains", lsurvey, lsea, 1.0);
let pineN = 0, boulderN = 0, pineBelow = 0;
for (const t of ltiles) {
  for (const inst of scatterAssets(t, SEED, pineCfg)) { pineN++; if (inst.y < lsea) pineBelow++; }
  for (const _ of scatterAssets(t, SEED, boulderCfg)) boulderN++;
}
assert(pineN >= boulderN, `pines (${pineN}) must not be outnumbered by boulders (${boulderN}) on the landscape config`);
assert(pineN >= 300, `pine count ${pineN} is not a HEALTHY forest (expected well above the old ~222)`);
assert(pineBelow === 0, `landscape config placed ${pineBelow} pines below the water line (must be 0)`);

void TILE_SIZE;
ops.op_log(
  `p11_terrain_ramp OK: default material keeps flat-colour defaults (no colorNode/roughnessNode); ` +
  `palette builds the elevation+biome ramp colorNode/roughnessNode + climate DataTexture (explicit + ` +
  `default relief + no-climate fallback); render-only exaggerateY scales mesh Y about the pivot; ` +
  `water-exclusion: ${gatedTotal} gated props ALL above the water line (0 below), falsifiable ` +
  `(un-gated placed ${looseBelow} below water); landscape pines=${pineN} ≥ boulders=${boulderN} (0 pines below water).`,
);
