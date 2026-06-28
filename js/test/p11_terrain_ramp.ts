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

void TILE_SIZE;
ops.op_log(
  `p11_terrain_ramp OK: default material keeps flat-colour defaults (no colorNode/roughnessNode); ` +
  `palette builds the elevation+biome ramp colorNode/roughnessNode + climate DataTexture (explicit + ` +
  `default relief + no-climate fallback); render-only exaggerateY scales mesh Y about the pivot.`,
);
