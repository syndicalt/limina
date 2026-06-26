// Phase 9 · Workstream C — REAL-HTTP IPC smoke for ModelTerrainSource.
//
// Unlike p9_model_source.ts (which injects a mock transport in-process), this exercises
// the DEFAULT transport — the host `op_http_post` op — against an actual HTTP worker on
// localhost. It proves the genuine network seam (URL, content-type, response text) works,
// not just the parsing. Point it at either:
//   - tools/terrain-service/mock_worker.py  (stdlib, no GPU — synthetic payload), or
//   - tools/terrain-service/worker.py       (the real diffusion model, author GPU box).
//
// The worker must already be running (the sandboxed runtime has no subprocess op, by
// design — process launch is out-of-band; see the run command in worker.py). URL via
// the LIMINA_TERRAIN_URL env, default http://127.0.0.1:8917.

import { ModelTerrainSource } from "../src/terrain/model-source.ts";
import type { TileRequest } from "../src/terrain/types.ts";

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error("p9_model_source_http FAIL: " + msg);
}

// The runtime exposes no env op; the URL is read from a global the harness can set,
// else the default. (Kept simple: override by editing this constant or the default.)
const URL = "http://127.0.0.1:8917";

// Defaults match mock_worker.py's synthetic 8×8 tile. Override tilePx via the worker.
const src = new ModelTerrainSource({ baseUrl: URL, tilePx: 8, metersPerPx: 30, timeoutMs: 60_000 });

await src.waitForReady(20, 250);
const health = await src.health();
assert(health.ok === true, "worker /health not ok");

const req: TileRequest = { seed: 4242, tx: 0, tz: 0, lod: 0 };
const tile = await src.generateTile(req);
assert(tile.heights.length === tile.nrows * tile.ncols, "heights length mismatch");
assert(tile.scale[1] === 1, "scaleY must be 1 (heights in metres)");
assert(tile.heights.every(Number.isFinite), "heights must be finite");

// Determinism over real HTTP: a second fetch (fresh source, fresh socket) is identical.
const src2 = new ModelTerrainSource({ baseUrl: URL, tilePx: 8, metersPerPx: 30, timeoutMs: 60_000 });
const tileB = await src2.generateTile({ ...req });
assert(tile.heights.length === tileB.heights.length, "determinism: length");
let identical = true;
for (let i = 0; i < tile.heights.length; i++) {
  if (!Object.is(tile.heights[i], tileB.heights[i])) { identical = false; break; }
}

let hMin = Infinity, hMax = -Infinity;
for (const h of tile.heights) { if (h < hMin) hMin = h; if (h > hMax) hMax = h; }

console.log(
  `p9_model_source_http OK: real op_http_post → worker → TerrainTile over HTTP. ` +
    `dims ${tile.nrows}x${tile.ncols}, elev[min=${hMin} max=${hMax}]m, ` +
    `climate ${tile.climateChannels ?? 0}ch, two fetches byte-identical=${identical}.`,
);
