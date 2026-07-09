// Map Phase 3.2 — MapTerrainSource: the STREAMED-path TerrainSource backed by a committed
// WorldMap IR (js/src/world/worldmap.ts). The editable path already rasterizes a map into ONE
// terrain.create tile (skills/terrain-edit.ts, generate.source==="map"); this source brings the
// SAME rasterizer (world/pipeline/map-raster.mjs — pure, deterministic) to the tiled/streamed
// world.generateRegion / world.streamFollow seam, so a design-space map can drive the open
// streaming world, not just a single editable slab.
//
// HOW IT WORKS: the IR is rasterized ONCE at construction into a MASTER FIELD (heights in world
// meters + paintMat/paintW + a biome-region channel) covering the IR's feature extent plus a
// one-tile (48 m) ocean margin, centered on world (0,0) — the same frame map-raster.mjs
// rasterizes in and the frame the IR's world-meter coordinates live in (axis convention,
// commit 1b04070: +x = east, NORTH = −z, right-handed y-up). generateTile then bilinearly
// SAMPLES that field for each tile's 33×33 window; sampleHeight is a bilinear point query of
// the SAME field, so a point query and a tile vertex agree to float32 quantization (a gate
// assertion). Outside the master field the world is open ocean: a deep-sea floor at
// seaLevel − 6 m (exactly the rasterizer's own far-sea depth, max(2, baseAmplitude·0.5) with
// the default baseAmplitude 12 — so the boundary is seamless) painted uniform sand.
//
// MASTER RESOLUTION (the fidelity choice): step = TILE_SIZE/(TILE_RES−1) = 1.5 m/sample —
// slightly FINER than the editable path's proven size 200 / res 129 ≈ 1.5625 m/sample, and
// chosen so the master lattice COINCIDES with the streamed tile lattice (tile sample x =
// tx·48 + c·1.5 lands exactly on a master sample when the half-size is a multiple of 1.5,
// which the constructor guarantees) — the bilinear tile fill degenerates to exact lookups.
// Memory: ~10 bytes/sample (f32 heights + f32 paintW + u8 paintMat + u8 biome); the 200 m
// primary island masters at ~191² samples ≈ 0.36 MB. Maps wider than ~1.5 km would exceed
// MAX_MASTER_RES and coarsen the step proportionally; masterTopologyHash makes that exact
// sampling topology explicit instead of letting two differently-coarsened fields alias.
//
// DETERMINISM: rasterizeWorldMap is a pure function of (worldMap, recorded seed/amplitude/erosion
// recipe). The master field, including erosion, is built ONCE in this constructor; generateTile
// only slices/samples it, so no HTTP request, authoritative tick, or tile request runs erosion.
// Replay reconstructs the source FROM the recorded world.setTerrainSource command.
//
// CACHE EXEMPTION (`derived: true`): map tiles re-derive deterministically from the IR asset
// the log pins, so TileCache.resolve keeps them TRANSIENT (LRU) instead of export-retained —
// the export ships the IR asset, not tiles (see tilecache.ts).

import {
  Biome,
  CLIMATE_BIOME, CLIMATE_CHANNELS, CLIMATE_PRECIP_MM, CLIMATE_TEMP_C,
  type ClimateSample, type TerrainSource, type TerrainTile, type TileRequest,
} from "./types.ts";
import { TILE_RES, TILE_SIZE } from "./procedural.ts";
import { rasterizeWorldMap } from "../world/pipeline/map-raster.mjs";
import { NO_EROSION_RECIPE, validateErosionRecipe } from "../world/pipeline/erosion.mjs";
import type { MapErosionRecipe } from "../world/pipeline/erosion-schema.ts";
import type { WorldMap } from "../world/worldmap.ts";
import {
  createTerrainGridSpec,
  terrainChunkBounds,
  terrainChunkTopology,
  terrainFieldTopologyHash,
  terrainGridIdForLogicalMap,
  validateTerrainSeed,
} from "./grid.mjs";

/** Master-field sample spacing (meters). Equal to the streamed tile lattice spacing
 *  (TILE_SIZE/(TILE_RES−1) = 1.5 m) so tile samples land exactly on master samples. */
export const MASTER_STEP = TILE_SIZE / (TILE_RES - 1);
/** Ocean apron beyond the IR's feature extent (one streamed tile). */
const MARGIN_M = TILE_SIZE;
/** Cap on the master grid edge (1025² ≈ 1.05 M samples ≈ 10.5 MB): a map wider than
 *  ~1.5 km coarsens the step proportionally instead of ballooning memory. */
const MAX_MASTER_RES = 1025;
/** Depth of the open-ocean floor beyond the master field, below the IR's seaLevel.
 *  Matches the rasterizer's own far-sea depth (max(2, baseAmplitude·0.5), default
 *  baseAmplitude 12 → 6 m) so the field border is seamless. */
const DEEP_SEA_DROP = 6;
/** terrain.paint material id + weight for the beyond-map seabed (uniform sand — the
 *  same id/weight the rasterizer paints its own open-sea cells with). */
const OUTSIDE_PAINT_MAT = 1;
const OUTSIDE_PAINT_W = 0.55;

/** The IR's biome kinds folded onto the CANONICAL Biome enum + representative climate —
 *  a deliberate fixed table (deterministic; the map's DRAWN regions are the truth here,
 *  not a noise-field classifier). "water" and unregioned cells read the temperate default. */
const BIOME_KIND_CLIMATE: Record<string, ClimateSample> = {
  grass: { tempC: 14, precipMm: 500, biome: Biome.STEPPE },
  forest: { tempC: 12, precipMm: 900, biome: Biome.TEMPERATE_FOREST },
  mountain: { tempC: 4, precipMm: 450, biome: Biome.STEPPE },
  desert: { tempC: 28, precipMm: 120, biome: Biome.DESERT },
  tundra: { tempC: -6, precipMm: 250, biome: Biome.ICE },
  swamp: { tempC: 16, precipMm: 1800, biome: Biome.BOREAL_WET },
};
const OPEN_CLIMATE: ClimateSample = { tempC: 14, precipMm: 800, biome: Biome.TEMPERATE_FOREST };

/** Even-odd point-in-ring (ray cast) — the same test map-raster.mjs rasterizes with
 *  (kept local: the module deliberately exports only its land classifier). */
function pointInRing(x: number, z: number, ring: [number, number][]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], zi = ring[i][1], xj = ring[j][0], zj = ring[j][1];
    const denom = (zj - zi) || 1e-12;
    const intersect = (zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / denom + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

function clamp01(v: number): number { return v < 0 ? 0 : v > 1 ? 1 : v; }

export interface MapTerrainSourceOptions {
  /** The PARSED + VERIFIED WorldMap IR (verifyWorldMap must have passed — the skill
   *  seam enforces this; the source trusts its input). */
  worldMap: WorldMap;
  /** Provenance name recorded in the log/events. */
  name?: string;
  /** Recorded rasterizer noise seed. Omitted legacy commands use the historical default 1. */
  seed?: number;
  /** Absolute-meter relief amplitude used by the WorldMap rasterizer. */
  baseAmplitude?: number;
  /** Recorded master-bake recipe. Omission is legacy disabled compatibility. */
  erosionRecipe?: MapErosionRecipe;
  /** Stable coordinate-frame identity. It must not include a source revision. */
  gridId?: string;
}

/** The map-backed streamed terrain source. Deterministic: same verified IR + same
 *  TileRequest → byte-identical tile (the world log records the setTerrainSource
 *  request + the IR content hash; tiles are never logged or export-retained). */
export class MapTerrainSource implements TerrainSource {
  readonly name: string;
  /** Tiles re-derive from the IR: TileCache keeps them transient-LRU, never retained. */
  readonly derived = true as const;
  /** The IR's sea level (world meters) — the water plane the tiles shape against. */
  readonly seaLevelM: number;
  /** Master grid edge (samples) and sample spacing (meters) actually used. */
  readonly masterRes: number;
  readonly masterStep: number;
  /** Vertical normalization of emitted tiles: origin.y = floorY, scale.y = spanY,
   *  FIELD-WIDE (every tile shares it → seam-consistent normalization). */
  readonly floorY: number;
  readonly spanY: number;
  /** Stable fixed-size coordinate frame used by every emitted chunk. */
  readonly grid: ReturnType<typeof createTerrainGridSpec>;
  /** Exact identity of the bounded master sampling topology. A map expansion that
   * triggers global coarsening changes this hash instead of silently aliasing it. */
  readonly masterTopologyHash: string;
  readonly erosionRecipe: MapErosionRecipe;

  private readonly half: number;
  /** Row-major master heights in WORLD METERS (row → z, col → x, both ascending). */
  private readonly heightsM: Float32Array;
  private readonly paintMat: Uint8Array;
  private readonly paintW: Float32Array;
  /** Per-cell biome-region index (0 = none/open; else 1 + index into biomeKinds). */
  private readonly biomeCell: Uint8Array;
  private readonly biomeKinds: string[];
  private readonly outsideH: number;

  constructor(opts: MapTerrainSourceOptions) {
    const map = opts.worldMap;
    const seed = validateTerrainSeed(opts.seed ?? 1);
    const baseAmplitude = opts.baseAmplitude ?? 12;
    if (!Number.isFinite(baseAmplitude) || baseAmplitude <= 0) {
      throw new Error("map terrain baseAmplitude must be a positive finite number");
    }
    this.erosionRecipe = validateErosionRecipe(opts.erosionRecipe ?? NO_EROSION_RECIPE) as MapErosionRecipe;
    this.name = opts.name ?? "map";
    this.seaLevelM = map.seaLevel;
    this.outsideH = map.seaLevel - DEEP_SEA_DROP;
    this.grid = createTerrainGridSpec({
      gridId: opts.gridId ?? terrainGridIdForLogicalMap(map.id),
      origin: [0, 0],
      chunkSizeM: TILE_SIZE,
      defaultSamples: TILE_RES,
    });

    // ── Master frame: centered on world (0,0) (the rasterizer's frame), covering the
    // IR's projected feature bbox + a one-tile ocean margin. half is a multiple of
    // MASTER_STEP so master samples land exactly on the streamed tile lattice. ──────
    const bbox = featureBBox(map);
    const coverR = Math.max(Math.abs(bbox.minX), Math.abs(bbox.maxX), Math.abs(bbox.minZ), Math.abs(bbox.maxZ)) + MARGIN_M;
    let half = Math.ceil(coverR / MASTER_STEP) * MASTER_STEP;
    if (!(half > 0)) half = MASTER_STEP;
    const size = 2 * half;
    let res = Math.round(size / MASTER_STEP) + 1;
    if (res > MAX_MASTER_RES) res = MAX_MASTER_RES; // documented coarsening cap
    const step = size / (res - 1);
    this.half = half;
    this.masterRes = res;
    this.masterStep = step;
    this.masterTopologyHash = terrainFieldTopologyHash({
      gridId: this.grid.gridId,
      bounds: { minX: -half, minZ: -half, maxX: half, maxZ: half },
      rows: res,
      cols: res,
    });

    // ── Rasterize ONCE (pure; fixed params ⇒ replay-identical). ─────────────────────
    const raster = rasterizeWorldMap(map, {
      size,
      resolution: res,
      seed,
      baseAmplitude,
      erosion: this.erosionRecipe,
    }) as {
      heights: Float32Array; paintMat: Uint8Array; paintW: Float32Array; seaLevelM: number;
    };
    this.heightsM = raster.heights;
    this.paintMat = raster.paintMat;
    this.paintW = raster.paintW;

    // ── Field-wide vertical normalization (fixed floor/span, like ModelTerrainSource's
    // fixed elevation range — never per-tile min/max, so tiles stay seam-consistent). ─
    let mn = Infinity, mx = -Infinity;
    for (let i = 0; i < this.heightsM.length; i++) {
      const h = this.heightsM[i];
      if (h < mn) mn = h;
      if (h > mx) mx = h;
    }
    const floorY = Math.min(mn, this.outsideH);
    const ceilY = Math.max(mx, map.seaLevel + 1);
    this.floorY = floorY;
    this.spanY = Math.max(ceilY - floorY, 1);

    // ── Biome-region channel: nearest-cell membership of the IR's drawn biome regions
    // (later regions override earlier — a fixed, deterministic precedence). ──────────
    this.biomeKinds = map.biomes.map((b) => b.biome);
    this.biomeCell = new Uint8Array(res * res);
    const rings = map.biomes.map((b) => b.points.map((p): [number, number] => [
      map.origin[0] + p[0] * map.unitsPerMeter,
      map.origin[1] + p[1] * map.unitsPerMeter,
    ]));
    for (let row = 0; row < res; row++) {
      const wz = -half + row * step;
      for (let col = 0; col < res; col++) {
        const wx = -half + col * step;
        let idx = 0;
        for (let b = 0; b < rings.length; b++) {
          if (pointInRing(wx, wz, rings[b])) idx = b + 1;
        }
        this.biomeCell[row * res + col] = idx;
      }
    }
  }

  /** Fractional master grid coords for world (x,z); undefined outside the field. */
  private gridCoords(x: number, z: number): { fx: number; fz: number } | undefined {
    const fx = (x + this.half) / this.masterStep;
    const fz = (z + this.half) / this.masterStep;
    const max = this.masterRes - 1;
    if (fx < 0 || fz < 0 || fx > max || fz > max) return undefined;
    return { fx, fz };
  }

  /** Bilinear master height (WORLD METERS) at (x,z); the deep-sea floor outside. */
  private masterHeightAt(x: number, z: number): number {
    const g = this.gridCoords(x, z);
    if (g === undefined) return this.outsideH;
    const n = this.masterRes;
    const c0 = Math.min(Math.floor(g.fx), n - 1), c1 = Math.min(c0 + 1, n - 1);
    const r0 = Math.min(Math.floor(g.fz), n - 1), r1 = Math.min(r0 + 1, n - 1);
    const dc = g.fx - c0, dr = g.fz - r0;
    const h = this.heightsM;
    const top = h[r0 * n + c0] + (h[r0 * n + c1] - h[r0 * n + c0]) * dc;
    const bot = h[r1 * n + c0] + (h[r1 * n + c1] - h[r1 * n + c0]) * dc;
    return top + (bot - top) * dr;
  }

  /** Nearest master cell index at (x,z); undefined outside the field. */
  private nearestCell(x: number, z: number): number | undefined {
    const g = this.gridCoords(x, z);
    if (g === undefined) return undefined;
    const n = this.masterRes;
    const col = Math.max(0, Math.min(n - 1, Math.round(g.fx)));
    const row = Math.max(0, Math.min(n - 1, Math.round(g.fz)));
    return row * n + col;
  }

  private climateOfCell(cell: number | undefined): ClimateSample {
    if (cell === undefined) return OPEN_CLIMATE;
    const idx = this.biomeCell[cell];
    if (idx === 0) return OPEN_CLIMATE;
    return BIOME_KIND_CLIMATE[this.biomeKinds[idx - 1]] ?? OPEN_CLIMATE;
  }

  /** Generate one streamed tile by sampling the master field. Synchronous + pure per
   *  request (req.seed / req.hints are ignored — the verified IR is the whole truth;
   *  hints stay the global-scalar bag they are, never a spatial channel). */
  generateTile(req: TileRequest): TerrainTile {
    const nrows = TILE_RES, ncols = TILE_RES;
    // The hot tile path needs validated bounds, not a topology hash. The latter is
    // exposed by chunkTopology() for compiler/manifests and computed on demand.
    const bounds = terrainChunkBounds(this.grid, req.tx, req.tz);
    const x0 = bounds.minX, z0 = bounds.minZ;
    const origin: [number, number, number] = [x0 + TILE_SIZE / 2, this.floorY, z0 + TILE_SIZE / 2];
    const scale: [number, number, number] = [TILE_SIZE, this.spanY, TILE_SIZE];
    const heights = new Float32Array(nrows * ncols);
    const paintMat = new Uint8Array(nrows * ncols);
    const paintW = new Float32Array(nrows * ncols);
    const climate = new Float32Array(CLIMATE_CHANNELS * nrows * ncols);
    const blight = new Float32Array(nrows * ncols); // per-cell caesura mask (0 clean .. 1 corrupt)
    for (let r = 0; r < nrows; r++) {
      const wz = z0 + (r / (nrows - 1)) * TILE_SIZE;
      for (let c = 0; c < ncols; c++) {
        const wx = x0 + (c / (ncols - 1)) * TILE_SIZE;
        const idx = r * ncols + c;
        heights[idx] = clamp01((this.masterHeightAt(wx, wz) - this.floorY) / this.spanY);
        const cell = this.nearestCell(wx, wz);
        if (cell === undefined) {
          paintMat[idx] = OUTSIDE_PAINT_MAT;
          paintW[idx] = OUTSIDE_PAINT_W;
        } else {
          paintMat[idx] = this.paintMat[cell];
          paintW[idx] = this.paintW[cell];
        }
        const cl = this.climateOfCell(cell);
        const cidx = idx * CLIMATE_CHANNELS;
        climate[cidx + CLIMATE_TEMP_C] = cl.tempC;
        climate[cidx + CLIMATE_PRECIP_MM] = cl.precipMm;
        climate[cidx + CLIMATE_BIOME] = cl.biome;
        // Blight is an OVERLAY, not a climate biome: a painted `blight` region marks the cell
        // corrupt regardless of the biome underneath, so the render can drain it (and, later, kill
        // its vegetation) without losing what it used to be.
        const bcell = cell !== undefined ? this.biomeCell[cell] : 0;
        if (bcell > 0 && this.biomeKinds[bcell - 1] === "blight") blight[idx] = 1;
      }
    }
    return { nrows, ncols, origin, scale, heights, paintMat, paintW, climate, climateChannels: CLIMATE_CHANNELS, blight };
  }

  /** Stable spatial identity + versioned topology for one emitted chunk. */
  chunkTopology(req: Pick<TileRequest, "tx" | "tz" | "lod">): ReturnType<typeof terrainChunkTopology> {
    return terrainChunkTopology(this.grid, { ...req, samples: TILE_RES });
  }

  /** O(1) point elevation (world meters) — a bilinear query of the SAME master field
   *  generateTile samples, so a tile vertex reconstructs to this value (within float32
   *  quantization of the normalized store, ≪ 1e-4). seed/lod/hints are ignored. */
  sampleHeight(_seed: number, x: number, z: number, _lod: number, _hints?: Record<string, number>): number {
    return this.masterHeightAt(x, z);
  }

  /** Per-coordinate climate from the IR's drawn biome regions (nearest master cell). */
  sampleClimate(_seed: number, x: number, z: number, _hints?: Record<string, number>): ClimateSample {
    return this.climateOfCell(this.nearestCell(x, z));
  }
}

/** World-meter bbox of every projected IR feature (land incl. holes, relief shapes,
 *  biome regions, waterways, routes, anchors). Falls back to origin ± extent/2 for a
 *  degenerate featureless map. */
function featureBBox(map: WorldMap): { minX: number; maxX: number; minZ: number; maxZ: number } {
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  const take = (p: [number, number]): void => {
    const x = map.origin[0] + p[0] * map.unitsPerMeter;
    const z = map.origin[1] + p[1] * map.unitsPerMeter;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (z < minZ) minZ = z;
    if (z > maxZ) maxZ = z;
  };
  for (const poly of map.land) {
    for (const p of poly.points) take(p);
    for (const h of poly.holes ?? []) for (const p of h) take(p);
  }
  for (const r of map.relief) {
    if (r.shape.polygon !== undefined) for (const p of r.shape.polygon) take(p);
    if (r.shape.point !== undefined) take(r.shape.point);
  }
  for (const b of map.biomes) for (const p of b.points) take(p);
  for (const w of map.waterways) for (const p of w.points) take(p);
  for (const rt of map.routes) for (const p of rt.points) take(p);
  for (const a of map.anchors) take(a.position);
  if (!Number.isFinite(minX)) {
    return {
      minX: map.origin[0] - map.extent.w / 2,
      maxX: map.origin[0] + map.extent.w / 2,
      minZ: map.origin[1] - map.extent.h / 2,
      maxZ: map.origin[1] + map.extent.h / 2,
    };
  }
  return { minX, maxX, minZ, maxZ };
}
