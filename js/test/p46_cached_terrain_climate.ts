// CachedTerrainSource climate replay regression.
//
// Model-authored terrain bakes its canonical [tempC, precipMm, biome] grid into
// tiles.jsonl. Replay may install a throwing pointSource to prove the model is
// absent, so in-tile terrain.sampleClimate must read the baked tile grid before
// falling back to pointSource.

import { ops } from "../src/engine.ts";
import { CachedTerrainSource, requestKey } from "../src/terrain/tilecache.ts";
import { CLIMATE_BIOME, CLIMATE_CHANNELS, CLIMATE_PRECIP_MM, CLIMATE_TEMP_C, type ClimateSample, type TerrainSource, type TerrainTile, type TileRequest } from "../src/terrain/types.ts";

function assert(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new Error("p46_cached_terrain_climate FAIL: " + msg);
}

const req: TileRequest = { seed: 7, tx: 0, tz: 0, lod: 0 };
const climate = new Float32Array(2 * 2 * CLIMATE_CHANNELS);
function setCell(row: number, col: number, tempC: number, precipMm: number, biome: number): void {
  const base = (row * 2 + col) * CLIMATE_CHANNELS;
  climate[base + CLIMATE_TEMP_C] = tempC;
  climate[base + CLIMATE_PRECIP_MM] = precipMm;
  climate[base + CLIMATE_BIOME] = biome;
}
setCell(0, 0, 10, 100, 1);
setCell(0, 1, 11, 200, 2);
setCell(1, 0, 12, 300, 3);
setCell(1, 1, 13, 400, 4);

const tile: TerrainTile = {
  nrows: 2,
  ncols: 2,
  origin: [5, 0, 5],
  scale: [10, 1, 10],
  heights: new Float32Array([0, 0, 0, 0]),
  climate,
  climateChannels: CLIMATE_CHANNELS,
};

const throwingPointSource: TerrainSource = {
  name: "must-not-be-called",
  generateTile: () => { throw new Error("fallback generateTile must not be called"); },
  sampleHeight: () => { throw new Error("fallback sampleHeight must not be called"); },
  sampleClimate: () => { throw new Error("fallback sampleClimate must not be called for in-tile climate"); },
};

const cached = new CachedTerrainSource([{ key: requestKey(req), tile }], throwingPointSource);
const got = cached.sampleClimate(req.seed, 9.9, 9.9);
assert(got.tempC === 13 && got.precipMm === 400 && got.biome === 4, "in-tile climate did not come from the baked cached tile");

let fallbackCalled = false;
const fallbackSource: TerrainSource = {
  name: "fallback",
  generateTile: () => { throw new Error("fallback generateTile must not be called"); },
  sampleHeight: () => 0,
  sampleClimate: (): ClimateSample => { fallbackCalled = true; return { tempC: 1, precipMm: 2, biome: 3 }; },
};
const fallback = new CachedTerrainSource([{ key: requestKey(req), tile }], fallbackSource);
const offGrid = fallback.sampleClimate(req.seed, 99, 99);
assert(fallbackCalled, "off-grid climate should still delegate to the point source");
assert(offGrid.tempC === 1 && offGrid.precipMm === 2 && offGrid.biome === 3, "off-grid fallback climate changed");

ops.op_log("p46_cached_terrain_climate OK: cached in-tile climate is served from baked tiles before point-source fallback.");
