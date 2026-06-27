// S1 cross-component contract — the terrain-diffusion SHIM wire vs. a DEFAULT ModelTerrainSource.
//
// The shim (tools/terrain-diffusion/shim.py) and the in-process worker (tools/terrain-service/
// worker.py) emit the model's climate FAITHFULLY, channel-major, in the model's native order:
//     [ temp(BIO1)@0, t_season(BIO4)@1, precip(BIO12)@2, p_cv(BIO15)@3 ]
// and NO biome channel (model-source is the single source of truth for biome). This test pins
// that a DEFAULT-configured `ModelTerrainSource` — NO climateChannels/tempChannel/precipChannel
// override — decodes that wire correctly: tempC from channel 0, precipMm from channel 2 (NOT
// the t_season sentinel at channel 1), and a biome classified from temp+precip. This is exactly
// the integration that broke when the wire was reduced to a non-default 3-channel layout.
//
// Headless, deterministic, no GPU: a mock transport returns a synthetic shim-format envelope.

import { ModelTerrainSource, encodeBase64 } from "../src/terrain/model-source.ts";
import {
  Biome,
  CLIMATE_BIOME,
  CLIMATE_CHANNELS,
  CLIMATE_PRECIP_MM,
  CLIMATE_TEMP_C,
  type TileRequest,
} from "../src/terrain/types.ts";

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error("p9_shim_contract FAIL: " + msg);
}

const TILE = 8;
const NCHAN = 4; // the model's canonical climate channel count (shim + worker emit this)
const M_PER_PX = 30; // terrain-diffusion-30m native (scale 1)

// Reference port of model-source.ts:classifyBiome (the consumer's biome rule).
function classifyBiomeRef(tempC: number, precipMm: number): number {
  if (tempC < 0) return Biome.ICE;
  if (tempC < 5) return precipMm > 500 ? Biome.BOREAL_WET : Biome.STEPPE;
  if (tempC < 18) {
    if (precipMm < 350) return Biome.STEPPE;
    if (precipMm < 1500) return Biome.TEMPERATE_FOREST;
    return Biome.BOREAL_WET;
  }
  if (precipMm < 250) return Biome.DESERT;
  if (precipMm < 1000) return Biome.SAVANNA;
  return Biome.TROPICAL;
}

// Build a SHIM-FORMAT envelope (channel-major float32 climate, int16 elev) — the exact wire
// shim.py.translate_terrain produces. temp/precip vary per cell; t_season/p_cv are DISTINCT
// sentinels so a temp/precip-channel mixup is caught.
function tempAt(r: number): number { return -10 + 5 * r; }
function precipAt(c: number): number { return 200 * c; }

function buildShimEnvelope(req: TileRequest): string {
  const nrows = TILE, ncols = TILE, plane = nrows * ncols;
  const elev = new Int16Array(plane);
  for (let r = 0; r < nrows; r++) for (let c = 0; c < ncols; c++) elev[r * ncols + c] = r * 10 + c;
  // channel-major (C,H,W): [temp@0, t_season@1, precip@2, p_cv@3]
  const clim = new Float32Array(NCHAN * plane);
  for (let r = 0; r < nrows; r++) {
    for (let c = 0; c < ncols; c++) {
      const i = r * ncols + c;
      clim[0 * plane + i] = tempAt(r);   // temp
      clim[1 * plane + i] = 999;          // t_season sentinel
      clim[2 * plane + i] = precipAt(c);  // precip
      clim[3 * plane + i] = -999;         // p_cv sentinel
    }
  }
  return JSON.stringify({
    name: "model:terrain-diffusion-30m",
    seed: req.seed, tx: req.tx, tz: req.tz, lod: req.lod,
    nrows, ncols,
    elev: { dtype: "int16", b64: encodeBase64(new Uint8Array(elev.buffer.slice(0))) },
    climate: { channels: NCHAN, dtype: "float32", b64: encodeBase64(new Uint8Array(clim.buffer.slice(0))) },
  });
}

const mockTransport = {
  post(url: string, body: string): Promise<string> {
    if (url.endsWith("/health")) return Promise.resolve(JSON.stringify({ ok: true }));
    if (url.endsWith("/tile")) return Promise.resolve(buildShimEnvelope(JSON.parse(body) as TileRequest));
    return Promise.reject(new Error("mock: unknown route " + url));
  },
};

// DEFAULT-configured source: ONLY transport + geometry. NO climate channel overrides — the
// whole point is that the shim wire decodes out of the box.
const src = new ModelTerrainSource({
  transport: mockTransport,
  tilePx: TILE,
  metersPerPx: M_PER_PX,
  // climateChannels / tempChannel / precipChannel left at DEFAULTS (5 / 0 / 2).
});

const req: TileRequest = { seed: 7, tx: 0, tz: 0, lod: 0 };
const tile = await src.generateTile(req);

assert(tile.climateChannels === CLIMATE_CHANNELS, `climateChannels should be canonical ${CLIMATE_CHANNELS}`);
assert(tile.climate && tile.climate.length === CLIMATE_CHANNELS * TILE * TILE, "climate grid sized wrong");

// Every cell: tempC == channel-0 temp; precipMm == channel-2 precip (NOT the 999 sentinel
// at channel 1); biome == the canonical classification of (temp, precip).
let checked = 0;
for (let r = 0; r < TILE; r++) {
  for (let c = 0; c < TILE; c++) {
    const base = (r * TILE + c) * CLIMATE_CHANNELS;
    const gotTemp = tile.climate![base + CLIMATE_TEMP_C];
    const gotPrecip = tile.climate![base + CLIMATE_PRECIP_MM];
    const gotBiome = tile.climate![base + CLIMATE_BIOME];
    assert(gotTemp === tempAt(r), `tempC[${r},${c}] ${gotTemp} != ${tempAt(r)} (channel 0)`);
    assert(gotPrecip === precipAt(c), `precipMm[${r},${c}] ${gotPrecip} != ${precipAt(c)} — read t_season?`);
    assert(gotPrecip !== 999, `precip must NOT be the t_season sentinel at [${r},${c}]`);
    assert(gotBiome === classifyBiomeRef(tempAt(r), precipAt(c)), `biome[${r},${c}] ${gotBiome} mismatch`);
    checked++;
  }
}

// Spot-check the per-point climate API decodes the same way (a known warm+wet cell -> TROPICAL).
const extent = TILE * M_PER_PX;
// cell (r=7 -> temp 25, c=7 -> precip 1400): warm + wet -> TROPICAL
const sample = src.sampleClimate(req.seed, extent - 1, extent - 1);
assert(sample.precipMm > 900 && sample.precipMm < 1500, `sampleClimate precip ${sample.precipMm} wrong (sentinel leak?)`);
assert(sample.biome === Biome.TROPICAL, `warm+wet cell should be TROPICAL, got ${sample.biome}`);

console.log(
  `p9_shim_contract OK: a DEFAULT ModelTerrainSource decoded the shim's faithful 4-channel ` +
  `channel-major climate [temp@0,t_season@1,precip@2,p_cv@3] across ${checked} cells — tempC@0, ` +
  `precipMm@2 (not the t_season sentinel), biome classified canonically; sampleClimate warm+wet -> TROPICAL. ` +
  `No per-host channel override needed; worker.py + shim.py emit this same wire @ 30 m/px.`,
);
