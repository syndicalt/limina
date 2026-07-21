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

import { type ClimateSample, type TerrainSource, type TerrainTile, type TileRequest } from "./types.ts";
import { NO_EROSION_RECIPE, validateErosionRecipe } from "../world/pipeline/erosion.mjs";
import type { MapErosionRecipe } from "../world/pipeline/erosion-schema.ts";
import type { WorldMap } from "../world/worldmap.ts";
import {
  terrainChunkTopology,
} from "./grid.mjs";
import {
  MAP_FIELD_MASTER_STEP_M,
  MAP_FIELD_CHUNK_SAMPLES,
  createMapTerrainField,
  mapFieldClimateAt,
  normalizedMapFieldTile,
  sampleMapFieldHeight,
} from "./map-field.mjs";

/** Master-field sample spacing (meters). Equal to the streamed tile lattice spacing
 *  (TILE_SIZE/(TILE_RES−1) = 1.5 m) so tile samples land exactly on master samples. */
export const MASTER_STEP = MAP_FIELD_MASTER_STEP_M;

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
  readonly grid: ReturnType<typeof createMapTerrainField>["grid"];
  /** Exact identity of the bounded master sampling topology. A map expansion that
   * triggers global coarsening changes this hash instead of silently aliasing it. */
  readonly masterTopologyHash: string;
  readonly erosionRecipe: MapErosionRecipe;

  private readonly field: ReturnType<typeof createMapTerrainField>;

  constructor(opts: MapTerrainSourceOptions) {
    const map = opts.worldMap;
    this.erosionRecipe = validateErosionRecipe(opts.erosionRecipe ?? NO_EROSION_RECIPE) as MapErosionRecipe;
    this.name = opts.name ?? "map";
    this.field = createMapTerrainField({
      worldMap: map,
      seed: opts.seed ?? 1,
      baseAmplitude: opts.baseAmplitude ?? 12,
      erosionRecipe: this.erosionRecipe,
      gridId: opts.gridId,
    });
    this.seaLevelM = this.field.seaLevelM;
    this.grid = this.field.grid;
    this.masterRes = this.field.masterRes;
    this.masterStep = this.field.masterStep;
    this.masterTopologyHash = this.field.masterTopologyHash;
    this.floorY = this.field.minimumHeightM;
    this.spanY = Math.max(this.field.maximumHeightM - this.floorY, 1);
  }

  /** Generate one streamed tile by sampling the master field. Synchronous + pure per
   *  request (req.seed / req.hints are ignored — the verified IR is the whole truth;
   *  hints stay the global-scalar bag they are, never a spatial channel). */
  generateTile(req: TileRequest): TerrainTile {
    return normalizedMapFieldTile(this.field, req.tx, req.tz, {
      minM: this.floorY,
      maxM: this.floorY + this.spanY,
    }).tile as TerrainTile;
  }

  /** Stable spatial identity + versioned topology for one emitted chunk. */
  chunkTopology(req: Pick<TileRequest, "tx" | "tz" | "lod">): ReturnType<typeof terrainChunkTopology> {
    return terrainChunkTopology(this.grid, { ...req, samples: MAP_FIELD_CHUNK_SAMPLES });
  }

  /** O(1) point elevation (world meters) — a bilinear query of the SAME master field
   *  generateTile samples, so a tile vertex reconstructs to this value (within float32
   *  quantization of the normalized store, ≪ 1e-4). seed/lod/hints are ignored. */
  sampleHeight(_seed: number, x: number, z: number, _lod: number, _hints?: Record<string, number>): number {
    return sampleMapFieldHeight(this.field, x, z);
  }

  /** Per-coordinate climate from the IR's drawn biome regions (nearest master cell). */
  sampleClimate(_seed: number, x: number, z: number, _hints?: Record<string, number>): ClimateSample {
    const climate = mapFieldClimateAt(this.field, x, z);
    return { tempC: climate[0], precipMm: climate[1], biome: climate[2] };
  }
}
