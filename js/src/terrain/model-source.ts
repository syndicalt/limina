// Phase 9 · Workstream C — the model-backed TerrainSource.
//
// `ModelTerrainSource` is the AUTHOR-SIDE bridge between the `terrain.*` skill seam
// and the S0-greenlit diffusion service (`xandergos/terrain-diffusion-30m`, fp16 —
// see `spikes/s0-terrain-diffusion/RESULT.md`). It marshals a `TileRequest` to a
// local generator worker over a thin HTTP IPC (the host's `op_http_post`), parses
// the worker's elevation + 5-channel climate response into a `TerrainTile`, and
// serves O(1) point queries from a tile cache.
//
// WHO RUNS THIS, AND WHEN:
//   - authoring  : this source runs the model via the worker, ONCE, on the author's
//                  GPU box. The generated tiles are snapshotted (Phase 8 / workstream E).
//   - replay/play: end users NEVER run the model. They replay cached tiles. This file
//                  is not on the playback path at all.
//
// DETERMINISM (the replay contract): a `TerrainTile` is a PURE function of
// `(request, source config)`. The model itself is bit-identical per request on a given
// machine (S0, measured). Parsing carries the worker's exact bytes through unchanged
// (int16 meters → f32 is lossless; climate f32 bytes are copied verbatim), so identical
// worker bytes ⇒ byte-identical tiles. We add NO timestamps/nondeterministic fields.
//
// TRANSPORT IS INJECTABLE: the default transport is the host `op_http_post` op (real
// HTTP to the Flask worker). Tests inject a mock transport that returns a known
// synthetic payload, so the IPC marshalling + wire-format parsing + lifecycle logic are
// verifiable headlessly without a GPU. The model output itself is S0-covered.

import { ops } from "../engine.ts";
import type {
  ClimateSample,
  TerrainSource,
  TerrainTile,
  TileRequest,
} from "./types.ts";

/** The IPC seam. `post` sends a JSON body to `url` and resolves the response text.
 *  The default impl is the host `op_http_post`; tests inject a mock. */
export interface TileTransport {
  post(url: string, body: string): Promise<string>;
}

/** Default transport: the host's `op_http_post` (reqwest POST, content-type JSON). */
export const httpTransport: TileTransport = {
  post: (url, body) => ops.op_http_post(url, body),
};

export interface ModelTerrainSourceOptions {
  /** Base URL of the running generator worker (no trailing slash). */
  baseUrl?: string;
  /** Tile edge in samples/native px. S0 native is 256 px @ 30 m/px. */
  tilePx?: number;
  /** World metres per sample (S0 native resolution = 30 m/px). */
  metersPerPx?: number;
  /** Number of climate channels the worker emits (S0 = 5, ≈ WorldClim BIO1/4/12/15+). */
  climateChannels?: number;
  /** Climate channel index carrying mean annual temperature in °C (WorldClim BIO1). */
  tempChannel?: number;
  /** Climate channel index carrying annual precipitation in mm (WorldClim BIO12). */
  precipChannel?: number;
  /** Per-request IPC timeout in ms. Generous: S0 worst-case isolated tile ≈ 5.5 s. */
  timeoutMs?: number;
  /** Provenance name recorded in the log. */
  name?: string;
  /** Injectable transport (defaults to {@link httpTransport}). */
  transport?: TileTransport;
}

/** The worker's JSON response envelope. Geometry (origin/scale) is owned by the
 *  source (single source of truth); the worker returns only model output + dims. */
interface TileEnvelope {
  name?: string;
  seed: number;
  tx: number;
  tz: number;
  lod: number;
  nrows: number;
  ncols: number;
  /** Row-major elevation in metres, int16 LE, base64. Length = nrows*ncols. */
  elev: { dtype: "int16"; b64: string };
  /** Channel-major (C,H,W) climate, float32 LE, base64. Optional. */
  climate?: { channels: number; dtype: "float32"; b64: string };
}

const DEFAULTS = {
  baseUrl: "http://127.0.0.1:8917",
  tilePx: 256,
  metersPerPx: 30,
  climateChannels: 5,
  tempChannel: 0, // BIO1  — mean annual temperature (°C)
  precipChannel: 2, // BIO12 — annual precipitation (mm)
  timeoutMs: 30_000,
  name: "model:terrain-diffusion-30m",
};

// ---- base64 (atob-backed; no TextEncoder/deno_web dependency) ---------------

/** Decode standard base64 to bytes. Uses the host `atob` (present in the runtime). */
export function decodeBase64(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Encode bytes to standard base64. Exported so the worker's wire format can be
 *  reproduced exactly by tests (the mock worker encodes the same way the Python one does). */
export function encodeBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

// ---- timeout helper ---------------------------------------------------------

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  // op_sleep_ms is the host's tokio sleep — the runtime exposes no browser timers and
  // no way to CANCEL a pending sleep. A single op_sleep_ms(ms) would stay pending in the
  // event loop after the real promise resolves, keeping the headless runtime alive for
  // the full `ms` (a 5-min timeout would hang a 13-s request for 5 min). So we poll in
  // small steps and stop as soon as the work settles — the longest dangling sleep is one
  // step. The losing branch never rejects spuriously.
  const STEP = 100;
  let settled = false;
  const wrapped = p.then(
    (v) => { settled = true; return v; },
    (e) => { settled = true; throw e; },
  );
  const guard = (async (): Promise<T> => {
    let waited = 0;
    while (!settled && waited < ms) {
      await ops.op_sleep_ms(Math.min(STEP, ms - waited));
      waited += STEP;
    }
    if (!settled) throw new Error(`${label}: timed out after ${ms} ms`);
    return await wrapped; // already settled — resolves immediately with the real value
  })();
  return Promise.race([wrapped, guard]);
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

// ---- biome classification (Whittaker-style, from temp + precip) -------------

/** A coarse biome enum derived from temperature (°C) and annual precip (mm).
 *  Perception input for agents; deterministic from the two climate channels. */
export const Biome = {
  Ice: 0,
  Tundra: 1,
  BorealForest: 2,
  TemperateGrassland: 3,
  TemperateForest: 4,
  TemperateRainforest: 5,
  Desert: 6,
  Savanna: 7,
  TropicalForest: 8,
  TropicalRainforest: 9,
} as const;

function classifyBiome(tempC: number, precipMm: number): number {
  if (tempC < -5) return Biome.Ice;
  if (tempC < 0) return Biome.Tundra;
  if (tempC < 5) return precipMm > 500 ? Biome.BorealForest : Biome.Tundra;
  if (tempC < 18) {
    if (precipMm < 350) return Biome.TemperateGrassland;
    if (precipMm < 1500) return Biome.TemperateForest;
    return Biome.TemperateRainforest;
  }
  // Warm.
  if (precipMm < 250) return Biome.Desert;
  if (precipMm < 1000) return Biome.Savanna;
  if (precipMm < 2500) return Biome.TropicalForest;
  return Biome.TropicalRainforest;
}

// ---- the source -------------------------------------------------------------

export class ModelTerrainSource implements TerrainSource {
  readonly name: string;
  readonly baseUrl: string;
  readonly tilePx: number;
  readonly metersPerPx: number;
  readonly climateChannels: number;
  readonly tempChannel: number;
  readonly precipChannel: number;
  readonly timeoutMs: number;

  /** World metres spanned by one tile edge. */
  readonly extent: number;

  private readonly transport: TileTransport;
  /** Generated tiles, keyed by `${seed}:${lod}:${tx}:${tz}`. Backs O(1) point queries
   *  and the snapshot path; the model is never re-run for a cached coordinate. */
  private readonly cache = new Map<string, TerrainTile>();

  constructor(opts: ModelTerrainSourceOptions = {}) {
    this.name = opts.name ?? DEFAULTS.name;
    this.baseUrl = (opts.baseUrl ?? DEFAULTS.baseUrl).replace(/\/$/, "");
    this.tilePx = opts.tilePx ?? DEFAULTS.tilePx;
    this.metersPerPx = opts.metersPerPx ?? DEFAULTS.metersPerPx;
    this.climateChannels = opts.climateChannels ?? DEFAULTS.climateChannels;
    this.tempChannel = opts.tempChannel ?? DEFAULTS.tempChannel;
    this.precipChannel = opts.precipChannel ?? DEFAULTS.precipChannel;
    this.timeoutMs = opts.timeoutMs ?? DEFAULTS.timeoutMs;
    this.transport = opts.transport ?? httpTransport;
    this.extent = this.tilePx * this.metersPerPx;
  }

  private key(seed: number, lod: number, tx: number, tz: number): string {
    return `${seed}:${lod}:${tx}:${tz}`;
  }

  /** Generate one tile via the worker (off-loop, async). Deterministic per request:
   *  the worker is bit-identical (S0) and parsing is byte-faithful. */
  async generateTile(req: TileRequest): Promise<TerrainTile> {
    const cacheKey = this.key(req.seed, req.lod, req.tx, req.tz);
    const cached = this.cache.get(cacheKey);
    if (cached) return cached;

    const body = JSON.stringify({
      seed: req.seed,
      tx: req.tx,
      tz: req.tz,
      lod: req.lod,
      tile: this.tilePx,
      hints: req.hints ?? {},
    });

    let text: string;
    try {
      text = await withTimeout(
        this.transport.post(`${this.baseUrl}/tile`, body),
        this.timeoutMs,
        `terrain worker /tile (${req.tx},${req.tz})`,
      );
    } catch (e) {
      throw new Error(
        `ModelTerrainSource: worker request failed for tile ` +
          `(seed=${req.seed} lod=${req.lod} tx=${req.tx} tz=${req.tz}): ` +
          `${(e as Error).message}`,
      );
    }

    const tile = this.parseEnvelope(text, req);
    this.cache.set(cacheKey, tile);
    return tile;
  }

  /** Parse + validate the worker envelope into a TerrainTile. Geometry is computed
   *  by the source from (tx,tz,config), so the source is the single authority on
   *  world placement and the worker only carries model output. */
  parseEnvelope(text: string, req: TileRequest): TerrainTile {
    let env: TileEnvelope;
    try {
      env = JSON.parse(text) as TileEnvelope;
    } catch (_e) {
      throw new Error(
        `ModelTerrainSource: worker returned non-JSON (${text.slice(0, 120)}…)`,
      );
    }
    if ((env as unknown as { error?: string }).error) {
      throw new Error(
        `ModelTerrainSource: worker error: ${(env as unknown as { error: string }).error}`,
      );
    }
    if (!env.elev || env.elev.dtype !== "int16" || typeof env.elev.b64 !== "string") {
      throw new Error("ModelTerrainSource: envelope missing int16 elev payload");
    }
    const nrows = env.nrows | 0;
    const ncols = env.ncols | 0;
    if (nrows <= 0 || ncols <= 0) {
      throw new Error(`ModelTerrainSource: bad tile dims ${nrows}x${ncols}`);
    }

    // --- elevation: int16 LE metres → Float32 metres (lossless) ---
    const elevBytes = decodeBase64(env.elev.b64);
    const expectElevBytes = nrows * ncols * 2;
    if (elevBytes.byteLength !== expectElevBytes) {
      throw new Error(
        `ModelTerrainSource: elev byte length ${elevBytes.byteLength} ≠ ` +
          `expected ${expectElevBytes} (${nrows}x${ncols} int16)`,
      );
    }
    const ev = new DataView(elevBytes.buffer, elevBytes.byteOffset, elevBytes.byteLength);
    const heights = new Float32Array(nrows * ncols);
    for (let i = 0; i < heights.length; i++) {
      heights[i] = ev.getInt16(i * 2, /* littleEndian */ true);
    }

    // --- climate: channel-major (C,H,W) float32 LE (verbatim copy) ---
    let climate: Float32Array | undefined;
    let climateChannels: number | undefined;
    if (env.climate && env.climate.b64) {
      if (env.climate.dtype !== "float32") {
        throw new Error("ModelTerrainSource: climate dtype must be float32");
      }
      const ch = env.climate.channels | 0;
      const cBytes = decodeBase64(env.climate.b64);
      const expectCBytes = ch * nrows * ncols * 4;
      if (cBytes.byteLength !== expectCBytes) {
        throw new Error(
          `ModelTerrainSource: climate byte length ${cBytes.byteLength} ≠ ` +
            `expected ${expectCBytes} (${ch}×${nrows}×${ncols} float32)`,
        );
      }
      const cv = new DataView(cBytes.buffer, cBytes.byteOffset, cBytes.byteLength);
      climate = new Float32Array(ch * nrows * ncols);
      for (let i = 0; i < climate.length; i++) {
        climate[i] = cv.getFloat32(i * 4, /* littleEndian */ true);
      }
      climateChannels = ch;
    }

    // Geometry: tile (tx,tz) covers world x∈[tx·extent,(tx+1)·extent), centred origin.
    // heights are already metres, so scaleY = 1 maps height samples → metres directly
    // (matches op_physics_add_heightfield, which multiplies samples by scaleY).
    const origin: [number, number, number] = [
      req.tx * this.extent + this.extent / 2,
      0,
      req.tz * this.extent + this.extent / 2,
    ];
    const scale: [number, number, number] = [this.extent, 1, this.extent];

    return { nrows, ncols, origin, scale, heights, climate, climateChannels };
  }

  /** O(1) point elevation (metres). Served from the tile cache (the model is async
   *  + tile-based; a synchronous coordinate query can only read already-generated
   *  tiles — exactly the snapshot/replay path). Throws if the covering tile isn't
   *  cached yet, directing the caller to generateTile first. */
  sampleHeight(seed: number, x: number, z: number, lod: number): number {
    const tx = Math.floor(x / this.extent);
    const tz = Math.floor(z / this.extent);
    const tile = this.cache.get(this.key(seed, lod, tx, tz));
    if (!tile) {
      throw new Error(
        `ModelTerrainSource.sampleHeight: no cached tile (seed=${seed} lod=${lod} ` +
          `tx=${tx} tz=${tz}) for (${x},${z}); call generateTile first`,
      );
    }
    const { fx, fz } = this.localCell(tile, x, z); // fractional col/row
    return bilinear(tile.heights, tile.ncols, tile.nrows, fx, fz);
  }

  /** Per-coordinate climate (agent perception). Served from the cache; nearest cell. */
  sampleClimate(seed: number, x: number, z: number): ClimateSample {
    // Point climate is independent of lod; use the finest cached lod that covers (x,z).
    const tile = this.findCoveringTile(seed, x, z);
    if (!tile) {
      throw new Error(
        `ModelTerrainSource.sampleClimate: no cached tile covers (${x},${z}); ` +
          `call generateTile for the covering region first`,
      );
    }
    if (!tile.climate || !tile.climateChannels) {
      throw new Error("ModelTerrainSource.sampleClimate: tile has no climate channels");
    }
    const { col, row } = this.localCell(tile, x, z);
    const plane = tile.nrows * tile.ncols;
    const idx = row * tile.ncols + col;
    const tempC = tile.climate[this.tempChannel * plane + idx];
    const precipMm = tile.climate[this.precipChannel * plane + idx];
    return { tempC, precipMm, biome: classifyBiome(tempC, precipMm) };
  }

  /** True if the tile covering (seed,lod,x,z) has been generated. */
  has(seed: number, x: number, z: number, lod: number): boolean {
    const tx = Math.floor(x / this.extent);
    const tz = Math.floor(z / this.extent);
    return this.cache.has(this.key(seed, lod, tx, tz));
  }

  /** Number of cached tiles (snapshot/streaming bookkeeping). */
  get cachedTileCount(): number {
    return this.cache.size;
  }

  /** Health probe against the worker's `/health`. Resolves the parsed status or throws. */
  async health(): Promise<{ ok: boolean; model?: string; [k: string]: unknown }> {
    const text = await withTimeout(
      this.transport.post(`${this.baseUrl}/health`, "{}"),
      this.timeoutMs,
      "terrain worker /health",
    );
    return JSON.parse(text);
  }

  /** Poll `/health` until the (externally launched) worker answers, or give up.
   *  NOTE: the sandboxed runtime exposes no subprocess op, so the worker process is
   *  launched out-of-band (documented run command). This is the readiness gate. */
  async waitForReady(retries = 30, intervalMs = 1000): Promise<void> {
    let last: unknown;
    for (let i = 0; i < retries; i++) {
      try {
        const h = await this.health();
        if (h.ok) return;
        last = h;
      } catch (e) {
        last = e;
      }
      await ops.op_sleep_ms(intervalMs);
    }
    throw new Error(
      `ModelTerrainSource: worker at ${this.baseUrl} not ready after ` +
        `${retries} tries (last: ${last instanceof Error ? last.message : JSON.stringify(last)})`,
    );
  }

  // --- internals ---

  private findCoveringTile(seed: number, x: number, z: number): TerrainTile | undefined {
    const tx = Math.floor(x / this.extent);
    const tz = Math.floor(z / this.extent);
    for (const [k, tile] of this.cache) {
      if (k.startsWith(`${seed}:`) && k.endsWith(`:${tx}:${tz}`)) return tile;
    }
    return undefined;
  }

  /** Map world (x,z) to fractional grid cell within `tile`, clamped to the grid. */
  private localCell(tile: TerrainTile, x: number, z: number) {
    const minX = tile.origin[0] - tile.scale[0] / 2;
    const minZ = tile.origin[2] - tile.scale[2] / 2;
    const fx = clamp01((x - minX) / tile.scale[0]) * (tile.ncols - 1); // x → col
    const fz = clamp01((z - minZ) / tile.scale[2]) * (tile.nrows - 1); // z → row
    return { col: Math.round(fx), row: Math.round(fz), fx, fz };
  }
}

/** Bilinear sample of a row-major grid (index = row*ncols + col) at fractional
 *  grid coords (fx=col, fz=row). Clamped at the grid edges. Deterministic. */
function bilinear(grid: Float32Array, ncols: number, nrows: number, fx: number, fz: number): number {
  const c0 = Math.min(Math.floor(fx), ncols - 1);
  const r0 = Math.min(Math.floor(fz), nrows - 1);
  const c1 = Math.min(c0 + 1, ncols - 1);
  const r1 = Math.min(r0 + 1, nrows - 1);
  const dc = fx - c0;
  const dr = fz - r0;
  const h00 = grid[r0 * ncols + c0];
  const h10 = grid[r0 * ncols + c1];
  const h01 = grid[r1 * ncols + c0];
  const h11 = grid[r1 * ncols + c1];
  const top = h00 + (h10 - h00) * dc;
  const bot = h01 + (h11 - h01) * dc;
  return top + (bot - top) * dr;
}
