// Phase 9 — content-addressed tile cache + the cached terrain source + bit-exact
// tile serialization for the export package.
//
// The determinism invariant (mirrors the world log's "commands, not bytes" rule):
// the durable LOG records only the generateRegion REQUEST + a content hash; the
// heavy tile BYTES live here, in a cache keyed by the request, and are carried in
// the export as a separate `tiles` artifact. Replay/playback resolve tiles from
// the cache (or regenerate them with the deterministic procedural source) — the
// model is never re-run off the author's machine.

import { ops } from "../engine.ts";
import {
  CLIMATE_BIOME,
  CLIMATE_PRECIP_MM,
  CLIMATE_TEMP_C,
  type ClimateSample,
  type TerrainSource,
  type TerrainTile,
  type TileRequest,
} from "./types.ts";
import { sha256 } from "../world/sha256.mjs";
import {
  validateTerrainChunkCoordinate,
  validateTerrainLod,
  validateTerrainSeed,
} from "./grid.mjs";

/** Canonical, stable string key for a tile request — the cache/content address.
 *  Hints are emitted in sorted-key order so logically-equal requests collide. */
export function requestKey(req: TileRequest): string {
  const seed = validateTerrainSeed(req.seed);
  const tx = validateTerrainChunkCoordinate("tx", req.tx);
  const tz = validateTerrainChunkCoordinate("tz", req.tz);
  const lod = validateTerrainLod(req.lod);
  const hints = req.hints;
  let hintStr = "";
  if (hints !== undefined) {
    // JSON-encode sorted [k,v] pairs so delimiter chars in keys can't collide two
    // different hint maps onto the same content address.
    const keys = Object.keys(hints).sort();
    for (const key of keys) {
      if (typeof hints[key] !== "number" || !Number.isFinite(hints[key])) {
        throw new Error(`terrain tile hint '${key}' must be finite`);
      }
    }
    hintStr = JSON.stringify(keys.map((k) => [k, hints[k]]));
  }
  // Preserve legacy bytes throughout the supported domain without bitwise
  // coercion, which used to alias distinct out-of-range requests.
  return `s${seed}|x${tx}|z${tz}|l${lod}|h${hintStr}`;
}

// Bit-exact Float32 (de)serialization: a height/climate sample serializes as its
// int32 IEEE-754 bit pattern, not a decimal float, so the round-trip is exact
// (decimal JSON loses -0 and NaN/Inf — and the determinism gate is bit-identical).
const _f32 = new Float32Array(1);
const _i32 = new Int32Array(_f32.buffer);
function floatToBits(x: number): number { _f32[0] = x; return _i32[0]; }
function bitsToFloat(i: number): number { _i32[0] = i; return _f32[0]; }
function bitsOf(arr: Float32Array): number[] {
  const out = new Array<number>(arr.length);
  for (let i = 0; i < arr.length; i++) out[i] = floatToBits(arr[i]);
  return out;
}
function floatsFromBits(bits: number[]): Float32Array {
  const out = new Float32Array(bits.length);
  for (let i = 0; i < bits.length; i++) out[i] = bitsToFloat(bits[i]);
  return out;
}

/** The on-the-wire form of one cached tile (bit-exact, ASCII-only JSON). */
interface SerializedTile {
  key: string;
  hash: string;
  nrows: number;
  ncols: number;
  origin: [number, number, number];
  scale: [number, number, number];
  heights: number[];
  climate?: number[];
  climateChannels?: number;
}

/** A content hash over a tile's deterministic bytes (resolution + placement +
 *  bit-exact height/climate samples). Recorded for integrity + provenance — the
 *  "+ content hash" half of the log invariant. */
export function tileContentHash(tile: TerrainTile): string {
  const parts = [
    `${tile.nrows}x${tile.ncols}`,
    tile.origin.map(floatToBits).join(","),
    tile.scale.map(floatToBits).join(","),
    bitsOf(tile.heights).join(","),
    tile.climate !== undefined ? `${tile.climateChannels ?? 0}:${bitsOf(tile.climate).join(",")}` : "",
  ];
  return "sha256:" + ops.op_sha256(parts.join("|"));
}

/** Versioned complete artifact identity. The legacy tileContentHash intentionally
 * remains unchanged because its hashes are persisted in existing export bundles.
 *
 * Allocation note: this first complete contract canonicalizes channels as JSON
 * arrays. That is acceptable for today's 33x33 runtime tiles, but a future compiler
 * emitting 257x257 derived chunks must replace it with a streaming/binary v3 codec
 * rather than using this implementation in a high-throughput build path. */
export const TERRAIN_TILE_ARTIFACT_SCHEMA_V2 = "limina.terrain-tile-artifact/v2";

function optionalU8Bits(value: Uint8Array | undefined): number[] | null {
  return value === undefined ? null : Array.from(value);
}

function optionalF32Bits(value: Float32Array | undefined): number[] | null {
  return value === undefined ? null : bitsOf(value);
}

function assertFiniteChannel(name: string, values: Float32Array): void {
  for (let index = 0; index < values.length; index++) {
    if (!Number.isFinite(values[index])) throw new Error(`terrain tile artifact ${name}[${index}] must be finite`);
  }
}

function validateTileArtifactShape(tile: TerrainTile): void {
  if (!Number.isSafeInteger(tile.nrows) || !Number.isSafeInteger(tile.ncols) || tile.nrows < 2 || tile.ncols < 2) {
    throw new Error("terrain tile artifact requires integer dimensions >= 2");
  }
  const cells = tile.nrows * tile.ncols;
  if (!Number.isSafeInteger(cells) || tile.heights.length !== cells) {
    throw new Error(`terrain tile artifact heights length ${tile.heights.length} != ${cells}`);
  }
  if (tile.paintMat !== undefined && tile.paintMat.length !== cells) throw new Error("terrain tile artifact paintMat length mismatch");
  if (tile.paintW !== undefined && tile.paintW.length !== cells) throw new Error("terrain tile artifact paintW length mismatch");
  if (tile.blight !== undefined && tile.blight.length !== cells) throw new Error("terrain tile artifact blight length mismatch");
  if (tile.climate !== undefined) {
    if (!Number.isSafeInteger(tile.climateChannels) || (tile.climateChannels ?? 0) < 1) {
      throw new Error("terrain tile artifact climate requires a positive integer climateChannels");
    }
    if (tile.climate.length !== cells * tile.climateChannels!) throw new Error("terrain tile artifact climate length mismatch");
  } else if (tile.climateChannels !== undefined) {
    throw new Error("terrain tile artifact climateChannels requires climate data");
  }
  for (const value of [...tile.origin, ...tile.scale]) {
    if (!Number.isFinite(value)) throw new Error("terrain tile artifact placement must be finite");
  }
  assertFiniteChannel("heights", tile.heights);
  if (tile.paintW !== undefined) assertFiniteChannel("paintW", tile.paintW);
  if (tile.climate !== undefined) assertFiniteChannel("climate", tile.climate);
  if (tile.blight !== undefined) assertFiniteChannel("blight", tile.blight);
}

export function terrainTileArtifactHashV2(tile: TerrainTile): string {
  validateTileArtifactShape(tile);
  const canonical = {
    schema: TERRAIN_TILE_ARTIFACT_SCHEMA_V2,
    nrows: tile.nrows,
    ncols: tile.ncols,
    origin: tile.origin.map(floatToBits),
    scale: tile.scale.map(floatToBits),
    heights: bitsOf(tile.heights),
    paintMat: optionalU8Bits(tile.paintMat),
    paintW: optionalF32Bits(tile.paintW),
    climateChannels: tile.climateChannels ?? null,
    climate: optionalF32Bits(tile.climate),
    blight: optionalF32Bits(tile.blight),
  };
  return `sha256:${sha256(JSON.stringify(canonical))}`;
}

/** A content-addressed tile store: request -> generated tile. The same key resolves
 *  the same bytes for the life of the session; on a miss it generates (and caches)
 *  via the supplied source. */
export interface TileCacheOptions {
  /** Maximum export/replay-retained tiles before generation fails closed. */
  maxRetainedEntries?: number;
  /** Maximum transient, non-exported tiles held in memory with LRU eviction. */
  maxEvictableEntries?: number;
}

export interface TileCachePutOptions {
  /** True means the tile is part of the export/replay artifact. Default: true. */
  retainForExport?: boolean;
}

const DEFAULT_MAX_RETAINED_TILES = 8192;
const DEFAULT_MAX_EVICTABLE_TILES = 512;

function cacheLimit(name: string, value: number | undefined, fallback: number): number {
  const n = value ?? fallback;
  if (!Number.isSafeInteger(n) || n < 0) throw new Error(`TileCache: ${name} must be a non-negative safe integer`);
  return n;
}

export class TileCache {
  private readonly retained = new Map<string, TerrainTile>();
  private readonly evictable = new Map<string, TerrainTile>();
  private readonly maxRetainedEntries: number;
  private readonly maxEvictableEntries: number;

  constructor(opts: TileCacheOptions = {}) {
    this.maxRetainedEntries = cacheLimit("maxRetainedEntries", opts.maxRetainedEntries, DEFAULT_MAX_RETAINED_TILES);
    this.maxEvictableEntries = cacheLimit("maxEvictableEntries", opts.maxEvictableEntries, DEFAULT_MAX_EVICTABLE_TILES);
  }

  has(req: TileRequest): boolean {
    const key = requestKey(req);
    return this.retained.has(key) || this.evictable.has(key);
  }

  get(req: TileRequest): TerrainTile | undefined {
    const key = requestKey(req);
    const retained = this.retained.get(key);
    if (retained !== undefined) return retained;
    const evictable = this.evictable.get(key);
    if (evictable === undefined) return undefined;
    this.evictable.delete(key);
    this.evictable.set(key, evictable);
    return evictable;
  }

  put(req: TileRequest, tile: TerrainTile, opts: TileCachePutOptions = {}): void {
    this.store(requestKey(req), tile, opts.retainForExport !== false);
  }

  /** Resolve a tile: a cache hit returns the stored bytes; a miss generates it
   *  via `source`, caches it, and returns it. The single seam where "model at
   *  authoring / cache at replay / procedural offline" all flow through.
   *
   *  DERIVED-SOURCE EXEMPTION (Map Phase 3.2): a source flagged `derived: true`
   *  (MapTerrainSource) re-derives its tiles deterministically from a logged, hash-
   *  pinned artifact, so its tiles are NEVER export-retained — transient LRU only
   *  (the export ships the IR asset, not tiles), and the fail-closed retained limit
   *  (ensureRetainedCapacity) is unreachable for them by construction. */
  async resolve(req: TileRequest, source: TerrainSource, opts: TileCachePutOptions = {}): Promise<TerrainTile> {
    const key = requestKey(req);
    const retain = opts.retainForExport !== false && source.derived !== true;
    const hit = this.get(req);
    if (hit !== undefined) {
      if (retain && !this.retained.has(key)) this.store(key, hit, true);
      return hit;
    }
    if (retain) this.ensureRetainedCapacity(key);
    const tile = await source.generateTile(req);
    this.store(key, tile, retain);
    return tile;
  }

  /** All cached tiles with their keys + content hashes, for the export artifact. */
  entries(): { key: string; hash: string; tile: TerrainTile }[] {
    const out: { key: string; hash: string; tile: TerrainTile }[] = [];
    for (const [key, tile] of this.retained) out.push({ key, hash: tileContentHash(tile), tile });
    return out;
  }

  get size(): number {
    return this.retained.size + this.evictable.size;
  }

  get retainedSize(): number {
    return this.retained.size;
  }

  get evictableSize(): number {
    return this.evictable.size;
  }

  private store(key: string, tile: TerrainTile, retainForExport: boolean): void {
    if (retainForExport) {
      this.ensureRetainedCapacity(key);
      this.evictable.delete(key);
      this.retained.set(key, tile);
      return;
    }
    if (this.retained.has(key) || this.maxEvictableEntries === 0) return;
    this.evictable.delete(key);
    this.evictable.set(key, tile);
    while (this.evictable.size > this.maxEvictableEntries) {
      const oldest = this.evictable.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.evictable.delete(oldest);
    }
  }

  private ensureRetainedCapacity(key: string): void {
    if (!this.retained.has(key) && this.retained.size >= this.maxRetainedEntries) {
      throw new Error(
        `TileCache: retained tile limit exceeded (${this.maxRetainedEntries}); export/replay requires every recorded tile, so generation was refused instead of evicting it`,
      );
    }
  }
}

/** A TerrainSource backed entirely by cached tiles (the replay/playback source —
 *  NO model, NO generator). generateTile serves ONLY the cached bytes by request
 *  key and THROWS on a miss (so a replay whose export dropped a needed tile fails
 *  loudly instead of silently regenerating). Off-grid point queries (snapping/
 *  perception) delegate to a deterministic `pointSource` (the procedural source),
 *  which never re-runs the model. */
export class CachedTerrainSource implements TerrainSource {
  readonly name: string;
  private readonly byKey = new Map<string, TerrainTile>();

  constructor(
    tiles: { key: string; tile: TerrainTile }[],
    private readonly pointSource?: TerrainSource,
    name = "cache",
  ) {
    this.name = name;
    for (const { key, tile } of tiles) this.byKey.set(key, tile);
  }

  generateTile(req: TileRequest): TerrainTile {
    const hit = this.byKey.get(requestKey(req));
    if (hit === undefined) throw new Error(`CachedTerrainSource: no cached tile for ${requestKey(req)}`);
    return hit;
  }

  /** Bilinear-sample the cached tile that contains world (x,z), matching the
   *  heightfield collider's surface (origin.y + h*scaleY) — so a reloaded MODEL
   *  world samples the model terrain, not unrelated procedural noise. Returns
   *  undefined when no cached tile covers the point (caller falls back). */
  private sampleCached(x: number, z: number): number | undefined {
    for (const tile of this.byKey.values()) {
      const [ox, oy, oz] = tile.origin;
      const [sx, sy, sz] = tile.scale;
      const u = (x - (ox - sx / 2)) / sx;
      const v = (z - (oz - sz / 2)) / sz;
      if (u < 0 || u > 1 || v < 0 || v > 1) continue;
      const fc = u * (tile.ncols - 1), fr = v * (tile.nrows - 1);
      const c0 = Math.min(tile.ncols - 1, Math.floor(fc)), c1 = Math.min(tile.ncols - 1, c0 + 1);
      const r0 = Math.min(tile.nrows - 1, Math.floor(fr)), r1 = Math.min(tile.nrows - 1, r0 + 1);
      const tx = fc - c0, tz = fr - r0;
      const h = (r: number, c: number): number => tile.heights[r * tile.ncols + c];
      const top = h(r0, c0) * (1 - tx) + h(r0, c1) * tx;
      const bot = h(r1, c0) * (1 - tx) + h(r1, c1) * tx;
      return oy + (top * (1 - tz) + bot * tz) * sy;
    }
    return undefined;
  }

  private sampleCachedClimate(x: number, z: number): ClimateSample | undefined {
    for (const tile of this.byKey.values()) {
      if (tile.climate === undefined || tile.climateChannels === undefined) continue;
      const [ox, , oz] = tile.origin;
      const [sx, , sz] = tile.scale;
      const u = (x - (ox - sx / 2)) / sx;
      const v = (z - (oz - sz / 2)) / sz;
      if (u < 0 || u > 1 || v < 0 || v > 1) continue;
      const col = Math.min(tile.ncols - 1, Math.max(0, Math.round(u * (tile.ncols - 1))));
      const row = Math.min(tile.nrows - 1, Math.max(0, Math.round(v * (tile.nrows - 1))));
      const base = (row * tile.ncols + col) * tile.climateChannels;
      return {
        tempC: tile.climate[base + CLIMATE_TEMP_C],
        precipMm: tile.climate[base + CLIMATE_PRECIP_MM],
        biome: tile.climate[base + CLIMATE_BIOME],
      };
    }
    return undefined;
  }

  sampleHeight(seed: number, x: number, z: number, lod: number, hints?: Record<string, number>): number {
    const cached = this.sampleCached(x, z);
    if (cached !== undefined) return cached;
    if (this.pointSource === undefined) throw new Error("CachedTerrainSource.sampleHeight: off-grid and no point source");
    // Forward the shaping/erosion `hints` so an OFF-GRID fallback samples the SAME
    // shaped (and, when requested, eroded) surface the tiles were generated with —
    // dropping them here returns the flat un-shaped base field (measured ~5 m off).
    return this.pointSource.sampleHeight(seed, x, z, lod, hints);
  }

  sampleClimate(seed: number, x: number, z: number, hints?: Record<string, number>): ClimateSample {
    const cached = this.sampleCachedClimate(x, z);
    if (cached !== undefined) return cached;
    if (this.pointSource === undefined) throw new Error("CachedTerrainSource.sampleClimate: no point source");
    return this.pointSource.sampleClimate(seed, x, z, hints);
  }
}

// ---- Tile artifact (de)serialization for the export package ----------------

/** Serialize cached tiles as JSONL (one tile per line, ASCII-only, bit-exact
 *  samples). Empty input -> empty string (no artifact). */
export function serializeTiles(entries: { key: string; hash: string; tile: TerrainTile }[]): string {
  if (entries.length === 0) return "";
  return entries.map(({ key, hash, tile }) => {
    const line: SerializedTile = {
      key,
      hash,
      nrows: tile.nrows,
      ncols: tile.ncols,
      origin: tile.origin,
      scale: tile.scale,
      heights: bitsOf(tile.heights),
    };
    if (tile.climate !== undefined) {
      line.climate = bitsOf(tile.climate);
      line.climateChannels = tile.climateChannels ?? 0;
    }
    return JSON.stringify(line);
  }).join("\n") + "\n";
}

export interface ParsedTile {
  key: string;
  hash: string;
  tile: TerrainTile;
}

/** Parse the tiles artifact back into tiles, re-verifying each tile's content
 *  hash so a corrupted/torn artifact fails loudly rather than mis-loading. */
export function parseTiles(jsonl: string | undefined): ParsedTile[] {
  const out: ParsedTile[] = [];
  if (jsonl === undefined || jsonl.length === 0) return out;
  const lines = jsonl.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.length === 0) continue;
    let raw: SerializedTile;
    try {
      raw = JSON.parse(line) as SerializedTile;
    } catch (err) {
      throw new Error(`tiles: invalid JSON on line ${i + 1}: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (typeof raw.key !== "string" || !Array.isArray(raw.heights) || raw.heights.length !== raw.nrows * raw.ncols) {
      throw new Error(`tiles: malformed tile on line ${i + 1}`);
    }
    const tile: TerrainTile = {
      nrows: raw.nrows,
      ncols: raw.ncols,
      origin: raw.origin,
      scale: raw.scale,
      heights: floatsFromBits(raw.heights),
    };
    if (raw.climate !== undefined) {
      tile.climate = floatsFromBits(raw.climate);
      tile.climateChannels = raw.climateChannels;
    }
    const hash = tileContentHash(tile);
    // Verify when the host has a real sha256 (native op_sha256). A host without one
    // (the browser stub returns "") computes the empty "sha256:" sentinel — skip the
    // sync check rather than reject every tile (browser tile integrity should be
    // re-verified async via WebCrypto before load; tracked as a follow-up).
    if (hash !== "sha256:" && hash !== raw.hash) {
      throw new Error(`tiles: content hash mismatch on line ${i + 1} (stored ${raw.hash}, computed ${hash})`);
    }
    out.push({ key: raw.key, hash: raw.hash, tile });
  }
  return out;
}
