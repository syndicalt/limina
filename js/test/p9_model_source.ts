// Phase 9 · Workstream C — headless verification of the model-backed TerrainSource.
//
// This proves the IPC marshalling + wire-format parsing + lifecycle logic of
// `ModelTerrainSource` WITHOUT a GPU or the diffusion model. A MOCK transport stands
// in for the Flask worker: it encodes a known synthetic elev+climate payload with the
// EXACT wire format the Python worker uses (base64 of int16 LE elev + float32 LE
// channel-major climate), so the parser is exercised against the real envelope shape.
//
// What is verified here (headless, deterministic):
//   1. round-trip: request → TerrainTile with the right dims/geometry/units;
//   2. units: int16 metres → Float32 metres (lossless), heightfield-ready (scaleY=1);
//   3. determinism: two identical requests yield byte-identical tiles (replay contract);
//   4. climate: channel-major parse + sampleClimate temp/precip/biome mapping;
//   5. point queries: sampleHeight bilinear from the cache; cache-miss throws clearly;
//   6. lifecycle: /health probe, request timeout, and worker-error propagation.
//
// The MODEL OUTPUT itself (determinism/latency/VRAM of the diffusion net) is NOT tested
// here — that is S0-covered (spikes/s0-terrain-diffusion/RESULT.md). This file tests the
// engine-side seam only.

import {
  Biome,
  encodeBase64,
  ModelTerrainSource,
  type TileTransport,
} from "../src/terrain/model-source.ts";
import type { TileRequest } from "../src/terrain/types.ts";

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error("p9_model_source FAIL: " + msg);
}

const TILE = 8; // small grid so the synthetic payload is easy to reason about
const M_PER_PX = 30;
const CHANNELS = 5;

// --- synthetic payload: a known elev ramp + constant-per-channel climate ---
// elev[r][c] = r*10 + c   (metres, int16). Distinct per cell so bilinear + indexing
// errors are caught. climate channel ch is filled with a channel-specific value:
//   ch0 (temp °C) = 12.5, ch2 (precip mm) = 800  → biome = TemperateForest.
function buildSyntheticEnvelope(req: TileRequest): string {
  const nrows = TILE, ncols = TILE;
  const elev = new Int16Array(nrows * ncols);
  for (let r = 0; r < nrows; r++) {
    for (let c = 0; c < ncols; c++) elev[r * ncols + c] = r * 10 + c;
  }
  const climate = new Float32Array(CHANNELS * nrows * ncols);
  const chValues = [12.5, 4.0, 800.0, 15.0, 1.0]; // temp, tempSeason, precip, precipCV, +1
  for (let ch = 0; ch < CHANNELS; ch++) {
    for (let i = 0; i < nrows * ncols; i++) climate[ch * nrows * ncols + i] = chValues[ch];
  }
  const elevBytes = new Uint8Array(elev.buffer.slice(0));
  const climBytes = new Uint8Array(climate.buffer.slice(0));
  return JSON.stringify({
    name: "mock:terrain-diffusion-30m",
    seed: req.seed, tx: req.tx, tz: req.tz, lod: req.lod,
    nrows, ncols,
    elev: { dtype: "int16", b64: encodeBase64(elevBytes) },
    climate: { channels: CHANNELS, dtype: "float32", b64: encodeBase64(climBytes) },
  });
}

// A mock transport: routes /health and /tile like the real worker.
const mockTransport: TileTransport = {
  post(url, body) {
    if (url.endsWith("/health")) {
      return Promise.resolve(JSON.stringify({ ok: true, model: "mock", seed: 1234 }));
    }
    if (url.endsWith("/tile")) {
      const req = JSON.parse(body) as TileRequest;
      return Promise.resolve(buildSyntheticEnvelope(req));
    }
    return Promise.reject(new Error("mock: unknown route " + url));
  },
};

function makeSource(transport: TileTransport = mockTransport) {
  return new ModelTerrainSource({
    transport,
    tilePx: TILE,
    metersPerPx: M_PER_PX,
    climateChannels: CHANNELS,
    timeoutMs: 2000,
  });
}

const src = makeSource();
const extent = TILE * M_PER_PX; // 240 m per tile edge

// === 1. health probe ===
const h = await src.health();
assert(h.ok === true, "health() should report ok");

// === 2. round-trip + dims + geometry + units ===
const req: TileRequest = { seed: 1234, tx: 1, tz: 2, lod: 0 };
const tile = await src.generateTile(req);
assert(tile.nrows === TILE && tile.ncols === TILE, `dims ${tile.nrows}x${tile.ncols}`);
assert(tile.heights.length === TILE * TILE, "heights length");
// geometry: tile (1,2) centred at ((1+0.5)*extent, 0, (2+0.5)*extent)
assert(tile.origin[0] === 1.5 * extent && tile.origin[2] === 2.5 * extent,
  `origin ${tile.origin} (expected centred on tile 1,2 over extent ${extent})`);
assert(tile.scale[0] === extent && tile.scale[2] === extent, `xz scale ${tile.scale}`);
// scaleY === 1 so heights are already metres → drops straight into op_physics_add_heightfield
assert(tile.scale[1] === 1, "scaleY must be 1 (heights already in metres)");
// units: elev[r][c] = r*10 + c, exact int16 → float
assert(tile.heights[0] === 0, "height[0,0] should be 0 m");
assert(tile.heights[1 * TILE + 0] === 10, "height[1,0] should be 10 m");
assert(tile.heights[(TILE - 1) * TILE + (TILE - 1)] === (TILE - 1) * 10 + (TILE - 1),
  "height[max,max] mismatch (indexing/units bug)");

// === 3. climate parse ===
assert(tile.climateChannels === CHANNELS, "climateChannels");
assert(tile.climate && tile.climate.length === CHANNELS * TILE * TILE, "climate length");
// channel-major: channel 0 plane is all 12.5
assert(tile.climate![0] === 12.5, "climate ch0 value");
assert(tile.climate![2 * TILE * TILE] === 800, "climate ch2 (precip) plane value");

// === 4. determinism: a second identical request is byte-identical ===
const tileB = await makeSource().generateTile({ ...req });
assert(tile.heights.length === tileB.heights.length, "determinism: heights length");
for (let i = 0; i < tile.heights.length; i++) {
  assert(Object.is(tile.heights[i], tileB.heights[i]), `determinism: heights[${i}] differs`);
}
for (let i = 0; i < tile.climate!.length; i++) {
  assert(Object.is(tile.climate![i], tileB.climate![i]), `determinism: climate[${i}] differs`);
}
assert(tile.origin.every((v, i) => v === tileB.origin[i]) && tile.scale.every((v, i) => v === tileB.scale[i]),
  "determinism: geometry differs");

// === 5. point queries from the cache ===
// Pick a world point inside tile (1,2). minX = origin.x - extent/2 = 1*extent.
const minX = tile.origin[0] - extent / 2; // = 1*extent
const minZ = tile.origin[2] - extent / 2; // = 2*extent
// exact grid node (col=3,row=4): fractional position = node*spacing from min corner
const spacing = extent / (TILE - 1);
const px = minX + 3 * spacing;
const pz = minZ + 4 * spacing;
const y = src.sampleHeight(1234, px, pz, 0);
assert(Math.abs(y - (4 * 10 + 3)) < 1e-3, `sampleHeight at node (col3,row4) = ${y}, expected 43`);
// bilinear midpoint between two columns should land between their heights
const pxMid = minX + 3.5 * spacing;
const yMid = src.sampleHeight(1234, pxMid, pz, 0);
assert(yMid > 43 && yMid < 44, `bilinear midpoint ${yMid} not between 43 and 44`);

// climate point query → temp/precip/biome
const cs = src.sampleClimate(1234, px, pz);
assert(cs.tempC === 12.5, `sampleClimate tempC ${cs.tempC}`);
assert(cs.precipMm === 800, `sampleClimate precipMm ${cs.precipMm}`);
assert(cs.biome === Biome.TemperateForest, `biome ${cs.biome} (expected TemperateForest ${Biome.TemperateForest})`);

// has() reflects the cache; an ungenerated tile is a clean throw, not a silent 0.
assert(src.has(1234, px, pz, 0) === true, "has() should be true for generated tile");
assert(src.has(1234, px + 100 * extent, pz, 0) === false, "has() false for ungenerated tile");
let threw = false;
try { src.sampleHeight(1234, px + 100 * extent, pz, 0); } catch { threw = true; }
assert(threw, "sampleHeight on an ungenerated tile must throw (no silent default)");

// === 6. lifecycle: timeout + worker error ===
// timeout: a transport that never resolves must reject within timeoutMs.
const stallSrc = new ModelTerrainSource({
  tilePx: TILE, metersPerPx: M_PER_PX, timeoutMs: 80,
  transport: { post: () => new Promise<string>(() => {}) }, // never resolves
});
let timedOut = false;
try { await stallSrc.generateTile(req); } catch (e) { timedOut = /timed out/.test((e as Error).message); }
assert(timedOut, "a stalled worker must surface a timeout error");

// worker error: a transport that rejects must propagate with context.
const errSrc = new ModelTerrainSource({
  tilePx: TILE, metersPerPx: M_PER_PX, timeoutMs: 2000,
  transport: { post: () => Promise.reject(new Error("connection refused")) },
});
let propagated = false;
try { await errSrc.generateTile(req); } catch (e) { propagated = /connection refused/.test((e as Error).message); }
assert(propagated, "worker errors must propagate with context");

// worker returning an {error} envelope must throw.
const errEnvSrc = new ModelTerrainSource({
  tilePx: TILE, metersPerPx: M_PER_PX, timeoutMs: 2000,
  transport: { post: () => Promise.resolve(JSON.stringify({ error: "OOM" })) },
});
let envErr = false;
try { await errEnvSrc.generateTile(req); } catch (e) { envErr = /OOM/.test((e as Error).message); }
assert(envErr, "an {error} envelope must throw");

// malformed payload (wrong byte length) must be caught, not silently truncated.
const badSrc = new ModelTerrainSource({
  tilePx: TILE, metersPerPx: M_PER_PX, timeoutMs: 2000,
  transport: {
    post: () => Promise.resolve(JSON.stringify({
      seed: 1, tx: 0, tz: 0, lod: 0, nrows: TILE, ncols: TILE,
      elev: { dtype: "int16", b64: encodeBase64(new Uint8Array(4)) }, // too short
    })),
  },
});
let lenErr = false;
try { await badSrc.generateTile(req); } catch (e) { lenErr = /byte length/.test((e as Error).message); }
assert(lenErr, "a truncated elev payload must be rejected");

console.log(
  `p9_model_source OK: IPC marshalling + wire-format parse + lifecycle verified headless ` +
    `(mock transport). round-trip dims ${tile.nrows}x${tile.ncols}, ` +
    `heights in metres (scaleY=1, heightfield-ready), climate ${CHANNELS}ch channel-major, ` +
    `sampleHeight bilinear=${yMid.toFixed(3)}, sampleClimate→biome ${cs.biome}, ` +
    `byte-identical across two identical requests; timeout + error + bad-payload all rejected. ` +
    `[model output itself is S0-covered, not run here]`,
);
