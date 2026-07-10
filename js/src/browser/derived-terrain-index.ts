import { createTerrainGridSpec, terrainWorldToChunk } from "../terrain/grid.mjs";
import { tileKey } from "../terrain/stream.ts";
import type { TerrainTile } from "../terrain/types.ts";

export interface DerivedTerrainArtifactDescriptor {
  readonly artifactType: string;
  readonly contentHash: string;
  readonly byteLength: number;
  readonly mediaType: string;
}

export interface DerivedTerrainGrid {
  readonly schema: string;
  readonly gridId: string;
  readonly origin: readonly [number, number];
  readonly chunkSizeM: number;
  readonly defaultSamples: number;
}

export interface DerivedTerrainManifestChunk {
  readonly chunkId: string;
  readonly gridId: string;
  readonly lod: number;
  readonly tx: number;
  readonly tz: number;
  readonly topologyHash: string;
  readonly sourceSliceHashes: readonly unknown[];
  readonly artifacts: readonly DerivedTerrainArtifactDescriptor[];
}

export interface DerivedTerrainIndexEntry {
  readonly chunk: DerivedTerrainManifestChunk;
  readonly tile: TerrainTile;
}

function plain(value: unknown, label: string): Record<string, unknown> {
  if (value === null || Array.isArray(value) || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new TypeError(`${label} must be a plain object`);
  }
  return value as Record<string, unknown>;
}

function exact(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  const expected = new Set(keys);
  const names = Object.getOwnPropertyNames(value);
  if (Object.getOwnPropertySymbols(value).length !== 0 || names.length !== expected.size
      || names.some((name) => !expected.has(name))) {
    throw new TypeError(`${label} fields are invalid`);
  }
  for (const name of names) {
    const descriptor = Object.getOwnPropertyDescriptor(value, name);
    if (descriptor?.enumerable !== true || descriptor.get !== undefined || descriptor.set !== undefined) {
      throw new TypeError(`${label}.${name} must be an enumerable data field`);
    }
  }
}

function float32(value: unknown, length: number, label: string): Float32Array {
  if (!(value instanceof Float32Array) || !(value.buffer instanceof ArrayBuffer) || value.length !== length
      || value.byteOffset !== 0 || value.byteLength !== value.buffer.byteLength) {
    throw new TypeError(`${label} must be an owned Float32Array of length ${length}`);
  }
  return value;
}

function uint8(value: unknown, length: number, label: string): Uint8Array {
  if (!(value instanceof Uint8Array) || !(value.buffer instanceof ArrayBuffer) || value.length !== length
      || value.byteOffset !== 0 || value.byteLength !== value.buffer.byteLength) {
    throw new TypeError(`${label} must be an owned Uint8Array of length ${length}`);
  }
  return value;
}

function tuple3(value: unknown, label: string): [number, number, number] {
  if (!Array.isArray(value) || value.length !== 3 || value.some((entry) => typeof entry !== "number" || !Number.isFinite(entry))) {
    throw new TypeError(`${label} must be a finite number tuple`);
  }
  return [value[0], value[1], value[2]];
}

/** Validate a transferred worker-decoded tile without importing render or host code. */
export function parseTransferredTerrainTile(
  value: unknown,
  expected: DerivedTerrainArtifactDescriptor,
  label: string,
): TerrainTile {
  const decoded = plain(value, `${label} decoded`);
  exact(decoded, ["metadata", "tile"], `${label} decoded`);
  const metadata = plain(decoded.metadata, `${label} metadata`);
  const tile = plain(decoded.tile, `${label} tile`);
  const allowedTileKeys = new Set(["nrows", "ncols", "origin", "scale", "heights", "paintMat", "paintW", "climate", "climateChannels", "blight"]);
  const tileNames = Object.getOwnPropertyNames(tile);
  if (Object.getOwnPropertySymbols(tile).length !== 0 || tileNames.some((key) => !allowedTileKeys.has(key))) {
    throw new TypeError(`${label} tile fields are invalid`);
  }
  for (const name of tileNames) {
    const field = Object.getOwnPropertyDescriptor(tile, name);
    if (field?.enumerable !== true || field.get !== undefined || field.set !== undefined) {
      throw new TypeError(`${label} tile.${name} must be an enumerable data field`);
    }
  }
  const nrows = tile.nrows, ncols = tile.ncols;
  if (!Number.isSafeInteger(nrows) || !Number.isSafeInteger(ncols) || (nrows as number) < 2 || (ncols as number) < 2) {
    throw new TypeError(`${label} tile dimensions are invalid`);
  }
  const cells = (nrows as number) * (ncols as number);
  if (metadata.mediaType !== expected.mediaType || metadata.byteLength !== expected.byteLength
      || metadata.nrows !== nrows || metadata.ncols !== ncols || metadata.cells !== cells) {
    throw new Error(`${label} decoded metadata does not match its artifact descriptor or tile`);
  }
  const result: TerrainTile = {
    nrows: nrows as number,
    ncols: ncols as number,
    origin: tuple3(tile.origin, `${label} tile origin`),
    scale: tuple3(tile.scale, `${label} tile scale`),
    heights: float32(tile.heights, cells, `${label} tile heights`),
  };
  if (tile.paintMat !== undefined) result.paintMat = uint8(tile.paintMat, cells, `${label} tile paintMat`);
  if (tile.paintW !== undefined) result.paintW = float32(tile.paintW, cells, `${label} tile paintW`);
  if (tile.climate !== undefined) {
    if (tile.climateChannels !== 3) throw new TypeError(`${label} tile climateChannels must be 3`);
    result.climate = float32(tile.climate, cells * 3, `${label} tile climate`);
    result.climateChannels = 3;
  } else if (tile.climateChannels !== undefined) throw new TypeError(`${label} tile climateChannels requires climate`);
  if (tile.blight !== undefined) result.blight = float32(tile.blight, cells, `${label} tile blight`);
  return Object.freeze(result);
}

export function assertDerivedTerrainTilePlacement(
  tile: TerrainTile,
  chunk: DerivedTerrainManifestChunk,
  grid: DerivedTerrainGrid,
): void {
  if (chunk.lod !== 0) throw new Error(`derived terrain index supports only LOD0, received '${chunk.chunkId}'`);
  const expectedX = grid.origin[0] + (chunk.tx + 0.5) * grid.chunkSizeM;
  const expectedZ = grid.origin[1] + (chunk.tz + 0.5) * grid.chunkSizeM;
  if (tile.origin[0] !== expectedX || tile.origin[2] !== expectedZ
      || tile.scale[0] !== grid.chunkSizeM || tile.scale[2] !== grid.chunkSizeM) {
    throw new Error(`derived terrain chunk '${chunk.chunkId}' tile placement does not match the manifest grid`);
  }
}

/** Complete immutable LOD0 index. It retains CPU tile data only; GPU residency is separately bounded. */
export class DerivedLod0TerrainIndex {
  readonly #byCoord: Map<string, DerivedTerrainIndexEntry>;
  readonly #grid: DerivedTerrainGrid;

  constructor(entries: readonly DerivedTerrainIndexEntry[], grid: DerivedTerrainGrid) {
    const canonicalGrid = createTerrainGridSpec(grid) as DerivedTerrainGrid;
    const byCoord = new Map<string, DerivedTerrainIndexEntry>();
    for (const entry of entries) {
      assertDerivedTerrainTilePlacement(entry.tile, entry.chunk, canonicalGrid);
      const key = tileKey(entry.chunk.tx, entry.chunk.tz);
      if (byCoord.has(key)) throw new Error(`derived terrain coordinate '${entry.chunk.lod}:${key}' is duplicated`);
      byCoord.set(key, Object.freeze({ chunk: entry.chunk, tile: entry.tile }));
    }
    this.#byCoord = byCoord;
    this.#grid = canonicalGrid;
  }

  get size(): number { return this.#byCoord.size; }
  has(tx: number, tz: number): boolean { return this.#byCoord.has(tileKey(tx, tz)); }

  tile(tx: number, tz: number): TerrainTile | undefined {
    return this.#byCoord.get(tileKey(tx, tz))?.tile;
  }

  /** O(1) chunk lookup plus O(1) bilinear interpolation. Outside the compiled domain returns null. */
  sampleHeight(worldX: number, worldZ: number): number | null {
    if (!Number.isFinite(worldX) || !Number.isFinite(worldZ)) throw new TypeError("derived terrain sample coordinates must be finite");
    const coord = terrainWorldToChunk(this.#grid, worldX, worldZ);
    const tile = this.#byCoord.get(tileKey(coord.tx, coord.tz))?.tile;
    if (tile === undefined) return null;
    const x0 = tile.origin[0] - tile.scale[0] / 2;
    const z0 = tile.origin[2] - tile.scale[2] / 2;
    const fc = Math.max(0, Math.min(tile.ncols - 1, (worldX - x0) / tile.scale[0] * (tile.ncols - 1)));
    const fr = Math.max(0, Math.min(tile.nrows - 1, (worldZ - z0) / tile.scale[2] * (tile.nrows - 1)));
    const c0 = Math.min(tile.ncols - 2, Math.floor(fc));
    const r0 = Math.min(tile.nrows - 2, Math.floor(fr));
    const tx = fc - c0, tz = fr - r0;
    const h = tile.heights;
    const h00 = h[r0 * tile.ncols + c0], h01 = h[r0 * tile.ncols + c0 + 1];
    const h10 = h[(r0 + 1) * tile.ncols + c0], h11 = h[(r0 + 1) * tile.ncols + c0 + 1];
    return tile.origin[1] + ((h00 * (1 - tx) + h01 * tx) * (1 - tz) + (h10 * (1 - tx) + h11 * tx) * tz) * tile.scale[1];
  }
}
