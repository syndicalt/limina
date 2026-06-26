// Phase 9 · Workstream C — REAL model tile through the worker (author GPU box only).
// Native 256px tile via the diffusion worker. Generous timeout (cold load + first
// tile). Not a CI test — requires the S0 .venv + weights + GPU + a running worker.py.
import { ModelTerrainSource } from "../src/terrain/model-source.ts";

function assert(c: unknown, m: string): asserts c { if (!c) throw new Error("p9_model_real_tile FAIL: " + m); }

const src = new ModelTerrainSource({ baseUrl: "http://127.0.0.1:8918", tilePx: 256, metersPerPx: 30, timeoutMs: 300_000 });
await src.waitForReady(40, 500);
assert((await src.health()).ok === true, "worker not healthy");

const t0 = Date.now();
const tile = await src.generateTile({ seed: 4242, tx: 0, tz: 0, lod: 0 });
const ms = Date.now() - t0;
assert(tile.nrows === 256 && tile.ncols === 256, `dims ${tile.nrows}x${tile.ncols}`);
assert(tile.heights.length === 256 * 256, "heights length");
assert(tile.scale[1] === 1, "scaleY must be 1 (metres)");
assert(tile.heights.every(Number.isFinite), "heights finite");

let hMin = Infinity, hMax = -Infinity;
for (const h of tile.heights) { if (h < hMin) hMin = h; if (h > hMax) hMax = h; }
const sx = src.sampleHeight(4242, tile.origin[0], tile.origin[2], 0);
const cs = src.sampleClimate(4242, tile.origin[0], tile.origin[2]);
console.log(
  `p9_model_real_tile OK: real diffusion tile in ${ms} ms (incl. cold load). ` +
    `256x256, elev[min=${hMin} max=${hMax}]m, climate ${tile.climateChannels}ch, ` +
    `center sampleHeight=${sx.toFixed(1)}m sampleClimate{temp=${cs.tempC.toFixed(1)}C precip=${cs.precipMm.toFixed(0)}mm biome=${cs.biome}}.`,
);
