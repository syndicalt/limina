// terrain.create / terrain.deform — an EDITABLE heightfield terrain layer as first-class,
// recorded, replayable world state. Distinct from world.generateRegion (generate-only tile
// streaming): this is a ground grid the agent (or the editor's sculpt brush) OWNS and reshapes.
//
// DATA MODEL (the record/replay spine): the durable log records the OPS — terrain.create's
// params + each terrain.deform brush stamp — NOT the height bytes. Replay re-invokes the same
// skills in the same order and reconstructs identical heights (the deform math is pure +
// deterministic). Heights are meters relative to origin.y (scaleY === 1), so a deform delta is
// a real-world height change and the render mesh matches 1:1 (terrain/mesh.ts: y = origin.y +
// heights[i]*scaleY).
//
// DERIVED-TERRAIN PATH (D5.1): when no EditableTerrain layer resolves AND the authority has a
// derived MapDoc mounted, terrain.deform materializes the SAME brush weights as sparse metre
// deltas on the derived grid's LOD0 lattice (edit-layer.mjs), appends them to the project's
// derived edit layer, and commits the layer ref through a NESTED authoring.commit (folded into
// this recorded command). The derived compiler composes the layer, so strokes land on the
// terrain the user sees. The recorded command pins the base topology + resulting layer ref via
// commitFields, so replay never re-resolves the map and a drifted recompute throws.
//
// DERIVED PAINT (D5.3): terrain.paint takes the same path — the brush stamp materializes as
// sparse SIGNED weight deltas + material ids (paint-layer.mjs, overlap = ordered additive
// clamp, exactly the EditableTerrain blend), commits through a nested authoring.commit into
// refs.terrainEditLayers (shared array; paint refs are distinguished by their content schema
// so no project-state migration is needed), and the compiler recolors the chunk paint channels
// AFTER biome rasterization + height composition. Paint-driven grass blades do NOT regrow on
// derived terrain here: derived grass comes from the compiler's biome/grass stages, not the
// live EditableTerrain grass refresh — a separate concern.

import { z } from "../../build/zod.bundle.mjs";
import { MAX_ENTITIES, despawnRenderable, spawnRenderable } from "../ecs/world.ts";
import type { Transformable } from "../ecs/world.ts";
import type { TerrainTile } from "../terrain/types.ts";
import { applyElevationColors, applyPaintOverlay, buildTerrainMesh, type ElevationColorRamp, terrainTileBufferGeometry } from "../terrain/render.ts";
import { GrassFieldTileMount } from "../render/grass-field-render.ts";
import type { GrassFieldVisualPackage } from "../render/grass-field-package.ts";
import { buildBlightMist } from "../mist.ts";
import type { ScatterExclusion } from "../terrain/asset-scatter.ts";
import { generateHeightfield } from "../world/pipeline/terrain-heightfield.mjs";
import { rasterizeWorldMap } from "../world/pipeline/map-raster.mjs";
import { MapErosionRecipeSchema } from "../world/pipeline/erosion-schema.ts";
import { WorldMapSchema, verifyWorldMap, migrateWorldMap, type WorldMap } from "../world/worldmap.ts";
import {
  editableTerrainHeightSampler,
  type PreparedWaterContactBinding,
  type WaterContactBindingSpec,
} from "../world/water-contact.ts";
import type { AssetRegistry } from "../asset-registry.ts";
import { SkillInvocationError, type SkillDefinition, type SkillRegistry, type WorldContext } from "./registry.ts";
import type { MCPErrorCode } from "../mcp/protocol.ts";
import { DurableAuthoringRecordSchema } from "../authoring/durability.ts";
import {
  brushWeightAt,
  falloffWeight,
  hashNoise,
  materializeLatticeBrushDeltas,
} from "../terrain/brush-kernel.mjs";
import {
  appendTerrainEditStroke,
  parseTerrainEditBaseTopology,
  parseTerrainEditLayer,
  rebaseTerrainEditLayer,
  terrainEditLatticeGeometry,
} from "../terrain/edit-layer.mjs";
import {
  TERRAIN_PAINT_MATERIAL_IDS,
  appendTerrainPaintStroke,
  parseTerrainPaintLayer,
  rebaseTerrainPaintLayer,
} from "../terrain/paint-layer.mjs";
import type { WorldProjectState, WorldProjectStateReader } from "../authoring/project-state.ts";

/** An inert transform for the terrain entity's ECS slot (the mesh is world-fixed at its origin). */
const inertTransform = (): Transformable => ({ position: { set() {} }, quaternion: { set() {} }, scale: { set() {} } });

/** The live editable layer: its mutable tile + rendered mesh (mesh is undefined in a headless
 *  context whose scene is a stub — the tile state is still maintained + records/replays). */
export interface EditableTerrain { tile: TerrainTile; mesh: MeshLike | undefined; eid: number; elevationColors?: ElevationColorRamp; entity: string; bodyId: number; grass?: GrassFieldTileMount; blightMist?: MeshLike; }
interface MeshLike { geometry: { dispose?: () => void }; }

export interface EditableTerrainWaterContactHooks {
  prepareVerifiedMap(worldMap: WorldMap, spec: WaterContactBindingSpec): PreparedWaterContactBinding;
  activate(prepared: PreparedWaterContactBinding, sampleTerrainHeight: (worldX: number, worldZ: number) => number): void;
}

const Vec3 = z.tuple([z.number(), z.number(), z.number()]);

const ProceduralErosionOverridesSchema = z.object({
  rain: z.number().min(0).optional(),
  thermal: z.number().int().min(0).optional(),
  talus: z.number().min(0).optional(),
}).strict();
const ErosionInputSchema = z.union([
  ProceduralErosionOverridesSchema,
  MapErosionRecipeSchema,
]);

const createInput = z.object({
  /** Square terrain extent in world meters. */
  size: z.number().positive().max(8192).default(256),
  /** Grid vertices per edge (resolution). Higher = finer sculpting, more geometry. */
  resolution: z.number().int().min(2).max(1025).default(129),
  /** World-space center of the layer [x, y, z]. */
  origin: Vec3.default([0, 0, 0]),
  /** Starting height (meters, relative to origin.y) for every cell — a flat slab by default. */
  baseHeight: z.number().default(0),
  /** Ground color for the render mesh. */
  color: z.number().int().min(0).max(0xffffff).default(0x4a6b3a),
  /**
   * OPTIONAL procedural eroded terrain. When present, the layer starts NOT as a flat slab but
   * as a real eroded heightfield (fBm → hydraulic + thermal erosion → drainage channels) filled
   * by the PURE, deterministic generator (world/pipeline/terrain-heightfield.mjs), and the render
   * mesh gets sand/grass/rock/snow elevation colors. Only these PARAMS are recorded — replay
   * regenerates byte-identical heights (never the height array). Absent → the flat slab default
   * (backward compatible; existing flat terrain.create ops replay unchanged).
   */
  generate: z.object({
    seed: z.number().int().default(1337),
    /** Peak relief in meters (0..amplitude above origin.y). */
    amplitude: z.number().positive().default(14),
    /** Fraction of the map below the derived sea level (drives the sand/grass line). */
    seaCoverage: z.number().min(0).max(1).optional(),
    /** Base fBm frequency (smaller = broader landforms). */
    noiseScale: z.number().positive().optional(),
    octaves: z.number().int().min(1).max(12).optional(),
    lacunarity: z.number().positive().optional(),
    gain: z.number().positive().optional(),
    /** Domain-warp strength (meanders the ridgelines). */
    warp: z.number().min(0).optional(),
    /** Procedural overrides, or the strict versioned recipe used by map master bakes. */
    erosion: ErosionInputSchema.optional(),
    /**
     * Generation SOURCE. "procedural" (default): the eroded-heightfield generator above.
     * "map": rasterize a COMMITTED WorldMap IR (js/src/world/worldmap.ts) into the tile instead
     * — its land polygons, relief hints, biomes, and waterways become the heightfield + paint
     * overlay (world/pipeline/map-raster.mjs, a pure function of the map + these params). The
     * other procedural-only fields above are ignored on this branch except `seed` and
     * `amplitude` (reused as the map rasterizer's noise seed / base relief amplitude).
     */
    source: z.enum(["procedural", "map"]).default("procedural"),
    /** Required when source==="map": the asset id of the compiled WorldMap JSON (e.g.
     *  "maps/primary.worldmap.json"), resolved via the AssetRegistry threaded into
     *  registerTerrainEditSkills. */
    mapAssetId: z.string().optional(),
  }).optional(),
  /**
   * The COMMITTED content hash (the WorldMap's own provenance.contentHash) of the map used by
   * generate.source==="map". Absent at authoring (resolved + returned as output.mapHash, then
   * committed back into the recorded command by the WorldRecorder via commitFields — mirrors
   * asset.place's `hash`). Present on REPLAY: the freshly-resolved map's contentHash is checked
   * against it, and a MISMATCH THROWS (deliberately stricter than asset.place's warn-not-throw —
   * maps are load-bearing, and cross-host safety here comes from the pure-JS sha256 in
   * worldmap-hash.mjs, so the check IS host-stable). This pins the AUTHORED map version itself,
   * distinct from verifyWorldMap's internal tamper check (which only proves the resolved bytes
   * are SELF-consistent, not that they're the SAME map a replay was authored against).
   */
  mapHash: z.string().optional(),
});

const DEFORM_MODES = ["raise", "lower", "smooth", "flatten", "noise"] as const;
const FALLOFFS = ["smooth", "linear", "constant"] as const;
/** The edit-layer base-topology wire shape (terrain/edit-layer.mjs is the truth; this
 *  zod mirrors it so a recorded pin validates on replay). */
const baseTopologyInput = z.object({
  schema: z.literal("limina.terrain-edit-base-topology/v1"),
  grid: z.object({
    schema: z.literal("limina.terrain-grid/v1"),
    gridId: z.string(),
    origin: z.tuple([z.number(), z.number()]),
    chunkSizeM: z.number(),
    defaultSamples: z.number().int(),
  }).strict(),
  domain: z.object({
    minTx: z.number().int(),
    minTz: z.number().int(),
    maxTx: z.number().int(),
    maxTz: z.number().int(),
  }).strict(),
  topologyHash: z.string(),
}).strict();
const layerRefInput = z.object({
  assetId: z.string(),
  hash: z.string(),
  layerId: z.string(),
  baseTopologyHash: z.string(),
}).strict();
const deformInput = z.object({
  /** Which terrain layer to reshape. Defaults to the most recently created one. */
  entity: z.string().optional(),
  /** Brush center in WORLD space [x, z]. */
  center: z.tuple([z.number(), z.number()]),
  /** Brush radius in world meters. */
  radius: z.number().positive(),
  /** raise/lower/noise: amount in meters. flatten: TARGET height. */
  delta: z.number().default(1),
  mode: z.enum(DEFORM_MODES).default("raise"),
  /** Brush weight profile from center (1) to edge (0). */
  falloff: z.enum(FALLOFFS).default("smooth"),
  /** Replay pin (commitFields): the derived-terrain base topology the stroke
   *  materialized against. Absent live (resolved from the authoritative MapDoc);
   *  present on replay, so a replayed stroke never re-reads the map. */
  baseTopology: baseTopologyInput.optional(),
  /** Replay pin (commitFields): the layer identity the stroke committed. A recomputed
   *  layer that disagrees throws — replay divergence is loud, never silent. */
  layerRef: layerRefInput.optional(),
  /** Replay pin (commitFields): the nested authoring.commit's durable record. The
   *  authoring record chain is ONE contiguous sequence across top-level and nested
   *  commits, so replay must re-commit with the pinned record (commitRecorded) —
   *  exactly like a top-level authoring.commit — or a later top-level commit's pinned
   *  record no longer chains. */
  commitRecord: DurableAuthoringRecordSchema.optional(),
});
const deformOutput = z.object({
  ok: z.boolean(),
  baseTopology: baseTopologyInput.optional(),
  layerRef: layerRefInput.optional(),
  commitRecord: DurableAuthoringRecordSchema.optional(),
  derived: z.object({
    layerId: z.string(),
    deltaCount: z.number().int(),
    folded: z.boolean(),
    contentHash: z.string(),
  }).strict().optional(),
});

/** The terrain-edit-layer wire shape for authoring.terrainEditLayer output (zod mirror
 *  of terrain/edit-layer.mjs; the service re-validates with parseTerrainEditLayer). */
const editLayerOutput = z.object({
  schema: z.literal("limina.terrain-edit-layer/v1"),
  layerId: z.string(),
  gridId: z.string(),
  baseTopology: baseTopologyInput,
  operations: z.array(z.object({
    operationId: z.string(),
    kind: z.literal("add"),
    deltas: z.array(z.object({ gx: z.number().int(), gz: z.number().int(), deltaM: z.number() }).strict()),
  }).strict()),
  contentHash: z.string(),
}).strict();

// The falloff/hash/lattice math lives in terrain/brush-kernel.mjs — THE single copy,
// shared with the editor's optimistic sculpt preview (D5.2) so the preview and the
// recompiled revision compute byte-identical weights. Do NOT re-inline it here.

// Material ids for terrain.paint live in terrain/paint-layer.mjs — they MUST match
// TERRAIN_PAINT_ALBEDO_HEX in terrain/material-palette.ts (id 0 = unpainted).
const PAINT_MATERIALS = TERRAIN_PAINT_MATERIAL_IDS;
const paintInput = z.object({
  entity: z.string().optional(),
  center: z.tuple([z.number(), z.number()]),
  radius: z.number().positive(),
  strength: z.number().min(0).max(1).default(0.5),
  falloff: z.enum(FALLOFFS).default("smooth"),
  material: z.enum(["sand", "grass", "rock", "dirt", "snow", "murk", "tundra"]).default("grass"),
  erase: z.boolean().default(false),
  /** Replay pins (commitFields), derived path only — identical contract to terrain.deform's. */
  baseTopology: baseTopologyInput.optional(),
  layerRef: layerRefInput.optional(),
  commitRecord: DurableAuthoringRecordSchema.optional(),
});
const paintOutput = z.object({
  ok: z.boolean(),
  baseTopology: baseTopologyInput.optional(),
  layerRef: layerRefInput.optional(),
  commitRecord: DurableAuthoringRecordSchema.optional(),
  derived: z.object({
    layerId: z.string(),
    deltaCount: z.number().int(),
    folded: z.boolean(),
    contentHash: z.string(),
  }).strict().optional(),
});
/** Apply one paint stamp to a tile's material-weight channel, in place (mirrors applyBrush; pure +
 *  deterministic so replay reconstructs identical paint from the recorded terrain.paint commands).
 *  Exported so the derived-lattice port (materializeTerrainPaintOp) can be differentially gated
 *  against the original byte-for-byte. */
export function applyBrushPaint(tile: TerrainTile, input: z.infer<typeof paintInput>): void {
  const { nrows, ncols, origin, scale } = tile;
  if (tile.paintMat === undefined) tile.paintMat = new Uint8Array(nrows * ncols);
  if (tile.paintW === undefined) tile.paintW = new Float32Array(nrows * ncols);
  const x0 = origin[0] - scale[0] / 2;
  const z0 = origin[2] - scale[2] / 2;
  const dxStep = scale[0] / (ncols - 1);
  const dzStep = scale[2] / (nrows - 1);
  const [cx, cz] = input.center;
  const r = input.radius, r2 = r * r;
  const matId = PAINT_MATERIALS[input.material];
  for (let row = 0; row < nrows; row++) {
    const wz = z0 + row * dzStep;
    for (let col = 0; col < ncols; col++) {
      const wx = x0 + col * dxStep;
      const dx = wx - cx, dz = wz - cz;
      const d2 = dx * dx + dz * dz;
      if (d2 > r2) continue;
      const t = 1 - Math.sqrt(d2) / r;
      const f = falloffWeight(input.falloff, t);
      const i = row * ncols + col;
      if (input.erase) {
        tile.paintW[i] = Math.max(0, tile.paintW[i] - input.strength * f);
        if (tile.paintW[i] <= 0) tile.paintMat[i] = 0;
      } else {
        tile.paintMat[i] = matId;
        tile.paintW[i] = Math.min(1, tile.paintW[i] + input.strength * f);
      }
    }
  }
}

/** The brush-affected height sub-rectangle, captured BEFORE a deform mutates the
 *  tile (H1 compensation). Bounds use the same world→grid mapping as applyBrush,
 *  padded to the enclosing cell rect, so every cell the stamp can touch is inside.
 *  Bounded memory: one patch per deform per in-flight chain. */
interface HeightPatch { row0: number; col0: number; rows: number; cols: number; data: Float32Array }

function captureHeightPatch(tile: TerrainTile, center: [number, number], radius: number): HeightPatch {
  const { nrows, ncols, origin, scale, heights } = tile;
  const x0 = origin[0] - scale[0] / 2;
  const z0 = origin[2] - scale[2] / 2;
  const dxStep = scale[0] / (ncols - 1);
  const dzStep = scale[2] / (nrows - 1);
  const col0 = Math.min(ncols - 1, Math.max(0, Math.floor((center[0] - radius - x0) / dxStep)));
  const col1 = Math.max(0, Math.min(ncols - 1, Math.ceil((center[0] + radius - x0) / dxStep)));
  const row0 = Math.min(nrows - 1, Math.max(0, Math.floor((center[1] - radius - z0) / dzStep)));
  const row1 = Math.max(0, Math.min(nrows - 1, Math.ceil((center[1] + radius - z0) / dzStep)));
  const cols = Math.max(0, col1 - col0 + 1);
  const rows = Math.max(0, row1 - row0 + 1);
  const data = new Float32Array(rows * cols);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) data[r * cols + c] = heights[(row0 + r) * ncols + (col0 + c)];
  }
  return { row0, col0, rows, cols, data };
}

function restoreHeightPatch(tile: TerrainTile, patch: HeightPatch): void {
  const { ncols, heights } = tile;
  for (let r = 0; r < patch.rows; r++) {
    for (let c = 0; c < patch.cols; c++) heights[(patch.row0 + r) * ncols + (patch.col0 + c)] = patch.data[r * patch.cols + c];
  }
}

/** Re-derive everything downstream of a mutated heights array. REBUILD THE GROUND
 *  COLLIDER so physics follows the reshaped surface: without this, a deform moves
 *  the visual mesh but leaves the heightfield collider at its pre-deform heights —
 *  the player floats where terrain was cut down and sinks THROUGH where it was
 *  raised. Rapier exposes no in-place heightfield update, so the old body is
 *  removed and a fresh heightfield added from the current heights (the SAME op
 *  pair native streaming uses → identical on the headless-authoritative and
 *  render Rapier worlds). Then the render geometry is rebuilt (elevation colors
 *  re-applied so a leveled terrace keeps its shading) and the grass the brush
 *  moved is re-seated. Shared by terrain.deform AND its H1 undo, so a restored
 *  patch propagates through the exact rebuild the deform ran. */
function reprojectLayerHeights(world: WorldContext, layer: EditableTerrain, cx: number, cz: number, radius: number): void {
  const { tile } = layer;
  const [dox, doy, doz] = tile.origin;
  const [dsx, dsy, dsz] = tile.scale;
  world.ops.op_physics_remove_body(layer.bodyId);
  const newBodyId = world.ops.op_physics_add_heightfield(dox, doy, doz, tile.nrows, tile.ncols, dsx, dsy, dsz, tile.heights);
  layer.bodyId = newBodyId;
  world.entities.rebindBody(layer.entity, newBodyId);
  if (layer.mesh !== undefined) {
    const next = terrainTileBufferGeometry(tile);
    if (layer.elevationColors !== undefined) applyElevationColors(next, tile, layer.elevationColors);
    const old = layer.mesh.geometry;
    (layer.mesh as unknown as { geometry: unknown }).geometry = next;
    old.dispose?.();
  }
  layer.grass?.refreshCircle(cx, cz, radius + 3);
}

/** Apply one deterministic brush stamp to a tile's heights, in place. Exported so the
 *  derived-lattice port (materializeTerrainBrushOp) can be differentially gated against
 *  the original byte-for-byte. */
export function applyBrush(tile: TerrainTile, input: z.infer<typeof deformInput>): void {
  const { nrows, ncols, origin, scale, heights } = tile;
  const x0 = origin[0] - scale[0] / 2;
  const z0 = origin[2] - scale[2] / 2;
  const dxStep = scale[0] / (ncols - 1);
  const dzStep = scale[2] / (nrows - 1);
  const [cx, cz] = input.center;
  const r = input.radius;
  const r2 = r * r;
  // "smooth" reads the pre-stamp field so the blur is order-independent within the stamp.
  const src = input.mode === "smooth" ? Float32Array.from(heights) : heights;

  for (let row = 0; row < nrows; row++) {
    const wz = z0 + row * dzStep;
    for (let col = 0; col < ncols; col++) {
      const wx = x0 + col * dxStep;
      const dx = wx - cx, dz = wz - cz;
      const d2 = dx * dx + dz * dz;
      if (d2 > r2) continue;
      const t = 1 - Math.sqrt(d2) / r;
      const f = falloffWeight(input.falloff, t);
      const i = row * ncols + col;
      switch (input.mode) {
        case "raise": heights[i] += input.delta * f; break;
        case "lower": heights[i] -= input.delta * f; break;
        case "flatten": heights[i] += (input.delta - heights[i]) * f; break;
        case "noise": heights[i] += (hashNoise(col, row) * 2 - 1) * input.delta * f; break;
        case "smooth": {
          let sum = 0, cnt = 0;
          for (let rr = -1; rr <= 1; rr++) {
            const nr = row + rr; if (nr < 0 || nr >= nrows) continue;
            for (let cc = -1; cc <= 1; cc++) {
              const nc = col + cc; if (nc < 0 || nc >= ncols) continue;
              sum += src[nr * ncols + nc]; cnt++;
            }
          }
          heights[i] += (sum / cnt - heights[i]) * f;
          break;
        }
      }
    }
  }
}

/** Live-state + host seams the derived-terrain deform/paint paths need. Created per registry by
 *  registerTerrainEditSkills; the HOST binds authority capabilities after the authoring
 *  runtime exists (net/server.ts, browser/authoring-runtime.ts call sites). */
export interface DerivedTerrainEditDeps {
  /** Authority project-state reader; absent → the derived path is inert (legacy ok:false). */
  projectState?: WorldProjectStateReader;
  /** LIVE base-topology resolver over the authoritative MapDoc ref. Replay never calls
   *  it — the recorded command pins baseTopology via commitFields. */
  resolveBaseTopology?: (mapDocRef: { assetId: string; hash: string }) => unknown;
  /** Current composed-height sampler for smooth/flatten on the derived lattice. Absent
   *  → those modes are rejected on the derived path (raise/lower/noise need no heights). */
  sampleHeightM?: (gx: number, gz: number) => number;
  /** Optional content reader for layer refs not in the live store (e.g. layers committed
   *  by an external tool with fs-backed content). */
  readLayer?: (ref: { assetId: string; hash: string }) => unknown;
  /** Paint-layer sibling of readLayer (D5.3). */
  readPaintLayer?: (ref: { assetId: string; hash: string }) => unknown;
  /** Live layer-content store, contentHash → canonical layer. Rebuilt by replaying the
   *  recorded deform ops — the same live-state contract as the EditableTerrain map. */
  readonly layers: Map<string, unknown>;
  /** Live paint-layer store (D5.3), rebuilt by replaying the recorded paint ops. Separate
   *  from `layers` so the two read tools stay unambiguous about the content they serve. */
  readonly paintLayers: Map<string, unknown>;
}

/** Port of applyBrush onto the global LOD0 sample lattice of a derived-terrain base
 *  topology: same weights, same arithmetic, expressed as sparse additive metre deltas
 *  (the durable edit-layer artifact — brush params are never replayed). The loop itself
 *  lives in terrain/brush-kernel.mjs (materializeLatticeBrushDeltas) so the editor's
 *  D5.2 sculpt preview shares the EXACT math; this shell resolves the lattice from the
 *  base topology and maps the missing-sampler case onto the skill's coded error. */
export function materializeTerrainBrushOp(
  baseTopologyInput: unknown,
  input: { center: [number, number]; radius: number; delta: number; mode: (typeof DEFORM_MODES)[number]; falloff: (typeof FALLOFFS)[number] },
  sampleHeightM?: (gx: number, gz: number) => number,
): { gx: number; gz: number; deltaM: number }[] {
  const lattice = terrainEditLatticeGeometry(baseTopologyInput);
  if ((input.mode === "smooth" || input.mode === "flatten") && sampleHeightM === undefined) {
    throw new SkillInvocationError("invalid_input", `terrain.deform: ${input.mode} on derived terrain requires a composed-height sampler (host must wire authoring.readMapDoc + derivedTerrainTopology)`);
  }
  return materializeLatticeBrushDeltas(lattice, input, sampleHeightM);
}

/** Port of applyBrushPaint onto the global LOD0 sample lattice of a derived-terrain base
 *  topology: same falloff weights, same arithmetic, expressed as sparse SIGNED blend deltas
 *  (the durable paint-layer artifact — brush params are never replayed). Every in-circle
 *  sample is emitted, including zero-weight ones: a zero-weight paint still sets the material
 *  id and a zero-weight erase still clears it where the weight is already 0, exactly like
 *  applyBrushPaint, so the composed channels stay byte-identical to the EditableTerrain path. */
export function materializeTerrainPaintOp(
  baseTopologyInput: unknown,
  input: { center: [number, number]; radius: number; strength: number; falloff: (typeof FALLOFFS)[number]; material: keyof typeof TERRAIN_PAINT_MATERIAL_IDS; erase: boolean },
): { gx: number; gz: number; material: string; weight: number }[] {
  const lattice = terrainEditLatticeGeometry(baseTopologyInput);
  const cols = lattice.maxGx - lattice.minGx; // last domain-relative column index
  const rows = lattice.maxGz - lattice.minGz;
  const x0 = lattice.minX, z0 = lattice.minZ;
  const step = lattice.stepM;
  const [cx, cz] = input.center;
  const r = input.radius, r2 = r * r;
  // Enclosing-cell clamp, mirroring materializeTerrainBrushOp, so the iteration rect covers
  // exactly the samples the tile path can touch.
  const col0 = Math.min(cols, Math.max(0, Math.floor((cx - r - x0) / step)));
  const col1 = Math.max(0, Math.min(cols, Math.ceil((cx + r - x0) / step)));
  const row0 = Math.min(rows, Math.max(0, Math.floor((cz - r - z0) / step)));
  const row1 = Math.max(0, Math.min(rows, Math.ceil((cz + r - z0) / step)));
  const deltas: { gx: number; gz: number; material: string; weight: number }[] = [];
  for (let row = row0; row <= row1; row++) {
    const wz = z0 + row * step;
    for (let col = col0; col <= col1; col++) {
      const wx = x0 + col * step;
      // brushWeightAt (brush-kernel.mjs — THE single copy of the falloff math) is 0 both
      // out-of-radius and at the exact rim; only the rim counts as a touch, because a
      // zero-weight stamp still carries applyBrushPaint's material side effects.
      const f = brushWeightAt(input.falloff, wx, wz, cx, cz, r);
      const dx = wx - cx, dz = wz - cz;
      if (f === 0 && dx * dx + dz * dz > r2) continue;
      deltas.push({
        gx: lattice.minGx + col,
        gz: lattice.minGz + row,
        material: input.erase ? "none" : input.material,
        weight: input.erase ? -(input.strength * f) : input.strength * f,
      });
    }
  }
  return deltas;
}

/** Register terrain.create + terrain.deform. `layers` is the per-registry live state (each
 *  context — headless authoritative, browser render — keeps its own; both reconstruct identically
 *  from the recorded ops). */
export function registerTerrainEditSkills(
  registry: SkillRegistry,
  layers: Map<string, EditableTerrain> = new Map(),
  assets?: AssetRegistry,
  /** Shared settlement-footprint registry (keyed by terrain id) that village.build fills.
   *  The paint-driven grass reads it LIVE (via a provider) so blades stop at building pads /
   *  courtyards / lanes — the same exclusion seam vegetation.scatter / vegetation.grassField honour. */
  footprints: Map<string, ScatterExclusion[]> = new Map(),
  /** Shared VEGETATION-CLEAR registry (keyed by terrain id). The paint-grass registers a
   *  refresh closure so village.build's footprint registration carves already-grown blades. */
  vegetationClears: Map<string, Array<() => void | Promise<void>>> = new Map(),
  waterContact?: EditableTerrainWaterContactHooks,
  grassVisualPackage?: GrassFieldVisualPackage,
  /** Derived-terrain seams (D5.1). Hosts share ONE box so authority capabilities bound
   *  after registration (the authoring runtime is created after core skills) are visible
   *  to the handler at invoke time. */
  derivedDeps?: DerivedTerrainEditDeps,
): { layers: Map<string, EditableTerrain> } {
  const derived: DerivedTerrainEditDeps = derivedDeps ?? { layers: new Map(), paintLayers: new Map() };

  /** The D5.1 derived path: materialize the stroke as sparse lattice deltas and commit
   *  the updated edit layer through a nested authoring.commit (folded into this recorded
   *  command — the commit is atomic, and nothing after it can throw, so no compensation
   *  is registered). Returns the legacy ok:false when no derived authority is wired or
   *  no MapDoc is mounted. */
  const derivedDeform = async (input: z.infer<typeof deformInput>, ctx: Parameters<SkillDefinition<z.infer<typeof deformInput>, z.infer<typeof deformOutput>>["handler"]>[1]): Promise<z.infer<typeof deformOutput>> => {
    const projectState = derived.projectState;
    if (projectState === undefined) return { ok: false };
    // Legacy replay: a deform recorded BEFORE the derived path existed carries
    // no baseTopology pin. Reproducing it through the derived path would mint a
    // nested commit the record never had and break the durable authoring-record
    // chain — replay it as the no-op it was. Pinned (new-style) replays and all
    // live invokes take the derived path.
    if (ctx.replay === true && input.baseTopology === undefined) return { ok: false };
    const nested = {
      agentId: ctx.agentId,
      sessionId: ctx.sessionId,
      permissions: ctx.permissions,
      tick: ctx.tick,
      world: ctx.world,
      chainId: ctx.chainId,
      chainToken: ctx.chainToken,
      ...(ctx.profile !== undefined ? { profile: ctx.profile } : {}),
    };
    const snapshotRes = await registry.invoke("authoring.sourceSnapshot", {}, nested);
    if (!snapshotRes.success) {
      throw new SkillInvocationError(
        (snapshotRes.error?.code ?? "handler_error") as MCPErrorCode,
        `terrain.deform could not read the authoritative source snapshot: ${snapshotRes.error?.message ?? "unknown error"}`,
      );
    }
    const snapshot = snapshotRes.result as { head: { revision: number; headHash: string }; projectState: WorldProjectState };
    const mapDocRef = snapshot.projectState.refs.mapDoc;
    if (mapDocRef === null) return { ok: false };
    let baseTopology;
    if (input.baseTopology !== undefined) {
      baseTopology = parseTerrainEditBaseTopology(input.baseTopology);
    } else {
      if (derived.resolveBaseTopology === undefined) return { ok: false };
      baseTopology = parseTerrainEditBaseTopology(derived.resolveBaseTopology(mapDocRef));
    }
    const layerId = `derived-${baseTopology.grid.gridId}`;
    const refs = snapshot.projectState.refs.terrainEditLayers;
    const existingRef = refs.find((ref) => ref.layerId === layerId);
    let existingLayer;
    if (existingRef !== undefined) {
      const content = derived.layers.get(existingRef.hash) ?? derived.readLayer?.(existingRef);
      if (content === undefined) {
        throw new Error(`terrain.deform: derived edit layer '${layerId}' content (${existingRef.hash}) is unavailable to this host`);
      }
      existingLayer = parseTerrainEditLayer(content);
      if (existingLayer.baseTopology.topologyHash !== baseTopology.topologyHash) {
        const rebase = rebaseTerrainEditLayer(existingLayer, baseTopology);
        if (!rebase.ok) {
          throw new SkillInvocationError(
            "conflict",
            `terrain.deform: derived edit layer '${layerId}' cannot rebase onto the mounted topology: ${rebase.conflicts.map((conflict) => conflict.code).join(", ")}`,
          );
        }
        existingLayer = rebase.layer;
      }
    }
    const deltas = materializeTerrainBrushOp(baseTopology, input, derived.sampleHeightM);
    if (deltas.length === 0) return { ok: false }; // the brush covered no lattice sample
    const stroke = appendTerrainEditStroke(existingLayer, { layerId, baseTopology, deltas });
    const layerRef = {
      assetId: `assets/sources/terrain-edit-layer/${stroke.layer.contentHash.slice("sha256:".length)}.layer.json`,
      hash: stroke.layer.contentHash,
      layerId,
      baseTopologyHash: baseTopology.topologyHash,
    };
    if (input.layerRef !== undefined
      && (input.layerRef.assetId !== layerRef.assetId || input.layerRef.hash !== layerRef.hash
        || input.layerRef.layerId !== layerRef.layerId || input.layerRef.baseTopologyHash !== layerRef.baseTopologyHash)) {
      throw new Error(`terrain.deform replay diverged: the recorded layer pin ${input.layerRef.hash} recomputed to ${layerRef.hash}`);
    }
    const nextRefs = existingRef === undefined
      ? [...refs, layerRef]
      : refs.map((ref) => (ref.layerId === layerId ? layerRef : ref));
    const transaction = {
      schema: "limina.authoring-transaction/v1",
      transactionId: `terrain-edit-${stroke.layer.contentHash.slice(7, 39)}-${snapshot.head.headHash.slice(7, 39)}`,
      projectId: projectState.projectId,
      baseRevision: snapshot.head.revision,
      baseHeadHash: snapshot.head.headHash,
      operations: [{
        adapter: "project-state",
        adapterVersion: "1.0.0",
        action: "refs.patch",
        input: { projectId: projectState.projectId, patch: { terrainEditLayers: nextRefs } },
        guard: { beforeHash: snapshot.projectState.stateHash },
      }],
    };
    const commitRes = await registry.invoke("authoring.commit", {
      transaction,
      // Replay forwards the pinned durable record so the authoring record chain stays
      // contiguous across nested + top-level commits (see the input commitRecord pin).
      ...(input.commitRecord !== undefined ? { commitRecord: input.commitRecord } : {}),
    }, nested);
    if (!commitRes.success) {
      throw new SkillInvocationError(
        (commitRes.error?.code ?? "handler_error") as MCPErrorCode,
        `terrain.deform could not commit the derived edit layer: ${commitRes.error?.message ?? "unknown error"}`,
      );
    }
    const commitRecord = (commitRes.result as { commitRecord: z.infer<typeof DurableAuthoringRecordSchema> }).commitRecord;
    derived.layers.set(stroke.layer.contentHash, stroke.layer);
    ctx.emit("terrain.deformed", {
      derived: true,
      layerId,
      contentHash: stroke.layer.contentHash,
      deltaCount: deltas.length,
      folded: stroke.folded,
      mode: input.mode,
    });
    return {
      ok: true,
      baseTopology,
      layerRef,
      commitRecord,
      derived: { layerId, deltaCount: deltas.length, folded: stroke.folded, contentHash: stroke.layer.contentHash },
    };
  };

  /** The D5.3 derived paint path: materialize the stamp as sparse signed lattice deltas and
   *  commit the updated paint layer through a nested authoring.commit — the mirror of
   *  derivedDeform. Returns the legacy ok:false when no derived authority is wired, no
   *  MapDoc is mounted, or a pin-less record replays (a paint recorded BEFORE this path
   *  existed never committed; replay must not mint one). */
  const derivedPaint = async (input: z.infer<typeof paintInput>, ctx: Parameters<SkillDefinition<z.infer<typeof paintInput>, z.infer<typeof paintOutput>>["handler"]>[1]): Promise<z.infer<typeof paintOutput>> => {
    const projectState = derived.projectState;
    if (projectState === undefined) return { ok: false };
    if (ctx.replay === true && input.baseTopology === undefined) return { ok: false };
    const nested = {
      agentId: ctx.agentId,
      sessionId: ctx.sessionId,
      permissions: ctx.permissions,
      tick: ctx.tick,
      world: ctx.world,
      chainId: ctx.chainId,
      chainToken: ctx.chainToken,
      ...(ctx.profile !== undefined ? { profile: ctx.profile } : {}),
    };
    const snapshotRes = await registry.invoke("authoring.sourceSnapshot", {}, nested);
    if (!snapshotRes.success) {
      throw new SkillInvocationError(
        (snapshotRes.error?.code ?? "handler_error") as MCPErrorCode,
        `terrain.paint could not read the authoritative source snapshot: ${snapshotRes.error?.message ?? "unknown error"}`,
      );
    }
    const snapshot = snapshotRes.result as { head: { revision: number; headHash: string }; projectState: WorldProjectState };
    const mapDocRef = snapshot.projectState.refs.mapDoc;
    if (mapDocRef === null) return { ok: false };
    let baseTopology;
    if (input.baseTopology !== undefined) {
      baseTopology = parseTerrainEditBaseTopology(input.baseTopology);
    } else {
      if (derived.resolveBaseTopology === undefined) return { ok: false };
      baseTopology = parseTerrainEditBaseTopology(derived.resolveBaseTopology(mapDocRef));
    }
    const layerId = `derived-paint-${baseTopology.grid.gridId}`;
    const refs = snapshot.projectState.refs.terrainEditLayers;
    const existingRef = refs.find((ref) => ref.layerId === layerId);
    let existingLayer;
    if (existingRef !== undefined) {
      const content = derived.paintLayers.get(existingRef.hash) ?? derived.readPaintLayer?.(existingRef);
      if (content === undefined) {
        throw new Error(`terrain.paint: derived paint layer '${layerId}' content (${existingRef.hash}) is unavailable to this host`);
      }
      existingLayer = parseTerrainPaintLayer(content);
      if (existingLayer.baseTopology.topologyHash !== baseTopology.topologyHash) {
        const rebase = rebaseTerrainPaintLayer(existingLayer, baseTopology);
        if (!rebase.ok) {
          throw new SkillInvocationError(
            "conflict",
            `terrain.paint: derived paint layer '${layerId}' cannot rebase onto the mounted topology: ${rebase.conflicts.map((conflict) => conflict.code).join(", ")}`,
          );
        }
        existingLayer = rebase.layer;
      }
    }
    const deltas = materializeTerrainPaintOp(baseTopology, input);
    if (deltas.length === 0) return { ok: false }; // the brush covered no lattice sample
    const stroke = appendTerrainPaintStroke(existingLayer, { layerId, baseTopology, deltas });
    const layerRef = {
      assetId: `assets/sources/terrain-paint-layer/${stroke.layer.contentHash.slice("sha256:".length)}.layer.json`,
      hash: stroke.layer.contentHash,
      layerId,
      baseTopologyHash: baseTopology.topologyHash,
    };
    if (input.layerRef !== undefined
      && (input.layerRef.assetId !== layerRef.assetId || input.layerRef.hash !== layerRef.hash
        || input.layerRef.layerId !== layerRef.layerId || input.layerRef.baseTopologyHash !== layerRef.baseTopologyHash)) {
      throw new Error(`terrain.paint replay diverged: the recorded layer pin ${input.layerRef.hash} recomputed to ${layerRef.hash}`);
    }
    const nextRefs = existingRef === undefined
      ? [...refs, layerRef]
      : refs.map((ref) => (ref.layerId === layerId ? layerRef : ref));
    const transaction = {
      schema: "limina.authoring-transaction/v1",
      transactionId: `terrain-paint-${stroke.layer.contentHash.slice(7, 39)}-${snapshot.head.headHash.slice(7, 39)}`,
      projectId: projectState.projectId,
      baseRevision: snapshot.head.revision,
      baseHeadHash: snapshot.head.headHash,
      operations: [{
        adapter: "project-state",
        adapterVersion: "1.0.0",
        action: "refs.patch",
        input: { projectId: projectState.projectId, patch: { terrainEditLayers: nextRefs } },
        guard: { beforeHash: snapshot.projectState.stateHash },
      }],
    };
    const commitRes = await registry.invoke("authoring.commit", {
      transaction,
      ...(input.commitRecord !== undefined ? { commitRecord: input.commitRecord } : {}),
    }, nested);
    if (!commitRes.success) {
      throw new SkillInvocationError(
        (commitRes.error?.code ?? "handler_error") as MCPErrorCode,
        `terrain.paint could not commit the derived paint layer: ${commitRes.error?.message ?? "unknown error"}`,
      );
    }
    const commitRecord = (commitRes.result as { commitRecord: z.infer<typeof DurableAuthoringRecordSchema> }).commitRecord;
    derived.paintLayers.set(stroke.layer.contentHash, stroke.layer);
    ctx.emit("terrain.painted", {
      derived: true,
      layerId,
      contentHash: stroke.layer.contentHash,
      deltaCount: deltas.length,
      folded: stroke.folded,
      material: input.material,
      erase: input.erase,
    });
    return {
      ok: true,
      baseTopology,
      layerRef,
      commitRecord,
      derived: { layerId, deltaCount: deltas.length, folded: stroke.folded, contentHash: stroke.layer.contentHash },
    };
  };

  const create: SkillDefinition<z.infer<typeof createInput>, { entity: string; mapHash?: string }> = {
    name: "terrain.create",
    version: "1.0.0",
    description: "Create an editable heightfield terrain layer — a flat, deformable/paintable ground grid — as a world entity. Reshape it with terrain.deform. Records its params so it replays; heights are meters relative to origin.y. generate.source: 'map' rasterizes a committed WorldMap IR instead of the procedural generator.",
    category: "terrain",
    permissions: ["scene.write"],
    // Pins the AUTHORED map version (generate.source==='map' only) into the replay log —
    // mirrors asset.place's `hash` commitField. Absent for procedural/flat creates.
    commitFields: ["mapHash"],
    input: createInput,
    output: z.object({ entity: z.string(), mapHash: z.string().optional() }),
    handler: (input, ctx) => {
      const n = input.resolution;
      // Heights: a flat slab by default, OR a PURE eroded heightfield / rasterized WorldMap when
      // `generate` is set. Both generators produce an n×n grid over `size` meters deterministically
      // from the recorded params, so replay reconstructs identical heights.
      let heights: Float32Array;
      let elevationColors: ElevationColorRamp | undefined;
      let paintMat: Uint8Array | undefined;
      let paintW: Float32Array | undefined;
      let blightMask: Float32Array | undefined;
      let mapHash: string | undefined;
      let preparedWater: PreparedWaterContactBinding | undefined;
      if (input.generate !== undefined && input.generate.source === "map") {
        const g = input.generate;
        if (assets === undefined) {
          throw new Error("terrain.create: generate.source 'map' requires an AssetRegistry (thread one via registerTerrainEditSkills)");
        }
        if (g.mapAssetId === undefined) {
          throw new Error("terrain.create: generate.source 'map' requires generate.mapAssetId");
        }
        const resolved = assets.resolve(g.mapAssetId);
        let parsedJson: unknown;
        try {
          parsedJson = JSON.parse(new TextDecoder().decode(resolved.bytes));
        } catch (e) {
          throw new Error(`terrain.create: map asset '${g.mapAssetId}' is not valid JSON: ${e instanceof Error ? e.message : String(e)}`);
        }
        // Zod-parse as WorldMap — THROWS on a malformed/non-WorldMap shape. Maps are
        // load-bearing (unlike a cosmetic GLB), so a parse failure must fail loudly, not warn.
        // Forward-migrated to the current version first (migrateWorldMap — a no-op for an
        // already-current map) so an older-version map on disk keeps loading as the IR evolves.
        const worldMap = WorldMapSchema.parse(migrateWorldMap(parsedJson));
        const verify = verifyWorldMap(worldMap);
        if (!verify.ok) {
          throw new Error(`terrain.create: map asset '${g.mapAssetId}' content hash mismatch (expected ${verify.expected}, actual ${verify.actual}) — refusing a tampered/corrupted map`);
        }
        // Pin the AUTHORED map version: a different-but-still-internally-consistent map swapped
        // in at the same assetId would pass verifyWorldMap above but must still be rejected.
        if (input.mapHash !== undefined && input.mapHash !== worldMap.provenance.contentHash) {
          throw new Error(`terrain.create: map asset '${g.mapAssetId}' identity mismatch (committed ${input.mapHash}, resolved ${worldMap.provenance.contentHash}) — the map changed since this terrain was authored`);
        }
        mapHash = worldMap.provenance.contentHash;
        preparedWater = waterContact?.prepareVerifiedMap(worldMap, {
          bindingId: `editable-terrain:${layers.size}`,
          offset: input.origin,
          bounds: {
            minX: input.origin[0] - input.size / 2,
            maxX: input.origin[0] + input.size / 2,
            minZ: input.origin[2] - input.size / 2,
            maxZ: input.origin[2] + input.size / 2,
          },
        });
        const raster = rasterizeWorldMap(worldMap, {
          size: input.size,
          resolution: n,
          center: [input.origin[0], input.origin[2]],
          seed: g.seed,
          baseAmplitude: g.amplitude,
          ...(g.erosion !== undefined ? { erosion: g.erosion } : {}),
        }) as {
          heights: Float32Array;
          paintMat: Uint8Array;
          paintW: Float32Array;
          blight?: Float32Array;
          seaLevelM: number;
          cfg: { amplitude: number };
        };
        heights = raster.heights;
        paintMat = raster.paintMat;
        paintW = raster.paintW;
        blightMask = raster.blight;
        elevationColors = { seaLevel: input.origin[1] + raster.seaLevelM, amplitude: raster.cfg.amplitude, snowFrac: 1.0 };
      } else if (input.generate !== undefined) {
        const g = input.generate;
        if (g.erosion !== undefined && "schema" in g.erosion) {
          throw new Error("terrain.create: versioned map erosion recipes require generate.source 'map'");
        }
        const gh = generateHeightfield({
          seed: g.seed,
          amplitude: g.amplitude,
          sizeM: input.size,
          gridN: n - 1,
          ...(g.seaCoverage !== undefined ? { seaCoverage: g.seaCoverage } : {}),
          ...(g.noiseScale !== undefined ? { noiseScale: g.noiseScale } : {}),
          ...(g.octaves !== undefined ? { octaves: g.octaves } : {}),
          ...(g.lacunarity !== undefined ? { lacunarity: g.lacunarity } : {}),
          ...(g.gain !== undefined ? { gain: g.gain } : {}),
          ...(g.warp !== undefined ? { warp: g.warp } : {}),
          ...(g.erosion !== undefined ? { erosion: g.erosion } : {}),
        }) as { heights: Float32Array; cfg: { seaLevelM: number; amplitude: number } };
        heights = gh.heights;
        // snowFrac 1.0: snow only where terrain rises to the summit of the sea-relative relief.
        // applyElevationColors now measures the snow line off the tile's ACTUAL relief (sea→peak).
        // village.build seats the focal on the HIGHEST ground and grades a flat terrace + smooth
        // shoulder across the top of that relief, so the settlement IS the local summit — a snow line
        // below 1.0 painted the graded shoulder as a harsh white ring. Keying it to the summit leaves
        // the inhabited knoll reading grass/rock/dirt; a bare generated peak (no settlement leveling it)
        // still whitens at its very top. This is the harsh-white-scree fix for authored village terrain.
        elevationColors = { seaLevel: input.origin[1] + gh.cfg.seaLevelM, amplitude: gh.cfg.amplitude, snowFrac: 1.0 };
      } else {
        heights = new Float32Array(n * n);
        if (input.baseHeight !== 0) heights.fill(input.baseHeight);
      }
      const tile: TerrainTile = { nrows: n, ncols: n, origin: [input.origin[0], input.origin[1], input.origin[2]], scale: [input.size, 1, input.size], heights };
      // Install the map-rasterized paint overlay BEFORE geometry build so the mesh reads it
      // immediately (terrain.paint installs this same channel later via brush strokes; a
      // map-sourced tile starts already painted by its biome regions).
      if (paintMat !== undefined) tile.paintMat = paintMat;
      if (paintW !== undefined) tile.paintW = paintW;
      // Caesura overlay (painted blight regions) — the elevation-color vertex path reads this to
      // drain the ground toward ash. Absent = no blight painted, so the slab renders clean.
      if (blightMask !== undefined) tile.blight = blightMask;

      // GROUND COLLIDER (the load-bearing fix so a spawned player stands on this layer instead of
      // falling forever). MIRRORS world.generateRegion (terrain.ts applyTile): build a Rapier
      // heightfield collider from the SAME tile heights/rows/cols/scale/origin. Deterministic +
      // replay-safe — the tile is reconstructed identically from the recorded terrain.create params,
      // so re-invoking on replay re-adds an identical collider. Runs once per authoring context
      // (headless authoritative sim-worker AND the render-main thread), each into its OWN Rapier
      // world — the same per-thread composition world.generateRegion already relies on (no
      // double-add within a thread). scaleY is 1 (heights are meters relative to origin.y).
      const [ox, oy, oz] = tile.origin;
      const [sx, sy, sz] = tile.scale;
      const bodyId = ctx.world.ops.op_physics_add_heightfield(ox, oy, oz, tile.nrows, tile.ncols, sx, sy, sz, tile.heights);

      let mesh: MeshLike | undefined;
      const scene = ctx.world.scene as { add?: (m: unknown) => void } | undefined;
      if (scene !== undefined && typeof scene.add === "function") {
        const built = buildTerrainMesh(tile, elevationColors !== undefined ? { color: input.color, elevationColors } : { color: input.color });
        // A map-rasterized tile arrives already painted (biome regions -> paintMat/paintW) —
        // blend that overlay into the just-built elevation-color vertex attribute immediately,
        // exactly like terrain.paint does for a brush stroke on an existing mesh.
        if (tile.paintMat !== undefined) {
          applyPaintOverlay(built.geometry, tile);
        }
        scene.add(built);
        mesh = built as unknown as MeshLike;
      }

      const eid = spawnRenderable(ctx.world.ecs, inertTransform(), input.origin[0], input.origin[1], input.origin[2]);
      if (eid >= MAX_ENTITIES) {
        despawnRenderable(ctx.world.ecs, eid);
        ctx.world.ops.op_physics_remove_body(bodyId);
        throw new Error("terrain.create: entity capacity exceeded (MAX_ENTITIES)");
      }
      const origin = { tool: "terrain.create", input: { ...input } };
      const entity = ctx.world.entities.create({ eid, mesh: mesh as never, bodyId, origin });
      // Stash the elevation ramp so terrain.deform can re-color the rebuilt geometry (a deform
      // that levels a terrace would otherwise drop the vertex colors → a white patch). Also stash
      // the entity id + physics bodyId so terrain.deform can REBUILD the heightfield collider to
      // follow the reshaped heights (see the deform handler — the sink-through fix).
      const layer: EditableTerrain = { tile, mesh, eid, entity, bodyId, ...(elevationColors !== undefined ? { elevationColors } : {}) };
      layers.set(entity, layer);
      // PAINT-DRIVEN GRASS (render context only): grow real instanced blades wherever the tile's
      // paint channel says grass (density ∝ paintW — a map-rasterized slab arrives painted; a
      // flat/procedural slab grows blades as terrain.paint strokes land). Scene-direct chunked
      // InstancedMeshes — ZERO entity slots, nothing recorded; replay re-mounts identically from
      // the recorded create/paint ops through the canonical grass-field placement pipeline. The exclusion
      // provider reads the terrain's CURRENT settlement footprints, and the registered clear
      // closure lets village.build carve blades off its pads after it registers them (the same
      // "veg grows first, civilization clears" order vegetation.scatter/grass follow).
      // An overview peek (ctx.world.peek) skips grass: from a whole-map turntable the blades are
      // sub-pixel, but a km-scale painted slab grows THOUSANDS of instanced chunks (the dominant
      // peek cost). The slab's own painted vertex-colors already tint the grassy ground.
      const supportsBladeDetail = Math.max(tile.scale[0], tile.scale[2]) <= 1024;
      if (ctx.world.mode !== "headless" && ctx.world.peek !== true && supportsBladeDetail
        && scene !== undefined && typeof scene.add === "function" && grassVisualPackage !== undefined) {
        const grassSeed = input.generate?.seed ?? 1337;
        const seaLevel = elevationColors?.seaLevel;
        layer.grass = new GrassFieldTileMount(
          scene as unknown as ConstructorParameters<typeof GrassFieldTileMount>[0],
          tile,
          () => ({
            seed: grassSeed,
            ...(seaLevel !== undefined ? { elevationMin: seaLevel + 0.05 } : {}),
            exclusions: footprints.get(entity) ?? [],
          }),
          grassVisualPackage,
        );
        const clears = vegetationClears.get(entity) ?? [];
        clears.push(() => { layer.grass?.refreshAll(); });
        vegetationClears.set(entity, clears);
      }
      // BLIGHT MIST (render-only, like grass/water): a low-lying, gravity-aware putrid miasma pooling in
      // the caesura's hollows. NOT peek-gated — from the overview it reads as a sickly haze marking the
      // blight (and it's a single mesh). Recomputed on replay from the recorded map's blight mask.
      if (ctx.world.mode !== "headless" && scene !== undefined && typeof scene.add === "function" && tile.blight !== undefined) {
        const mist = buildBlightMist(tile);
        if (mist !== undefined) { scene.add(mist); layer.blightMist = mist as unknown as MeshLike; }
      }
      if (preparedWater !== undefined) waterContact!.activate(preparedWater, editableTerrainHeightSampler(tile));
      ctx.emit("terrain.created", { entity, size: input.size, resolution: n, ...(mapHash !== undefined ? { mapHash } : {}) });
      return { entity, ...(mapHash !== undefined ? { mapHash } : {}) };
    },
  };

  const deform: SkillDefinition<z.infer<typeof deformInput>, z.infer<typeof deformOutput>> = {
    name: "terrain.deform",
    version: "1.1.0",
    description: "Reshape terrain with a brush stamp (raise/lower/smooth/flatten/noise) in a world-space radius. Targets the most recent editable layer; with no editable layer and a derived MapDoc mounted, the stroke materializes into the project's derived-terrain edit layer (sparse lattice deltas) and commits it to the authority, recompiling the terrain you see. Deterministic + recorded, so hand-sculpted terrain replays and is editable.",
    category: "terrain",
    permissions: ["scene.write"],
    // Pins the resolved lattice + committed layer identity + the nested commit's
    // durable record into the replay log (derived path only) — mirrors terrain.create's
    // mapHash and authoring.commit's own commitRecord pin. Absent on EditableTerrain.
    commitFields: ["baseTopology", "layerRef", "commitRecord"],
    input: deformInput,
    output: deformOutput,
    handler: (input, ctx) => {
      let id = input.entity;
      if (id === undefined) {
        let last: string | undefined;
        for (const k of layers.keys()) last = k; // most-recently created
        id = last;
      }
      const layer = id !== undefined ? layers.get(id) : undefined;
      if (layer === undefined) return derivedDeform(input, ctx);

      // H1 compensation: capture the brush-affected height patch BEFORE mutating;
      // on chain unwind, restore it and re-run the exact downstream rebuild the
      // deform itself runs (collider, render geometry, grass). The undo's collider
      // rebuild allocates a fresh native body id — count-neutral, per-world
      // self-consistent, which is what replay parity compares.
      const patch = captureHeightPatch(layer.tile, input.center, input.radius);
      const undoLayer = layer, undoWorld = ctx.world;
      ctx.undo("terrain.deform height patch", () => {
        restoreHeightPatch(undoLayer.tile, patch);
        reprojectLayerHeights(undoWorld, undoLayer, input.center[0], input.center[1], input.radius);
      });

      applyBrush(layer.tile, input);

      // REBUILD collider + render geometry + grass from the mutated heights (the
      // sink-through fix — see reprojectLayerHeights for the full argument).
      reprojectLayerHeights(ctx.world, layer, input.center[0], input.center[1], input.radius);
      ctx.emit("terrain.deformed", { entity: id, mode: input.mode });
      return { ok: true };
    },
  };

  const paint: SkillDefinition<z.infer<typeof paintInput>, z.infer<typeof paintOutput>> = {
    name: "terrain.paint",
    version: "1.1.0",
    description: "Paint a surface material (sand/grass/rock/dirt) onto terrain with a brush in a world-space radius. Targets the most recent editable layer; with no editable layer and a derived MapDoc mounted, the stamp materializes into the project's derived-terrain paint layer (sparse signed weight deltas) and commits it to the authority, recoloring the compiled terrain you see. Blends a per-vertex material weight into the ground shading; deterministic + recorded so painted ground replays. "
      + "Does NOT change height (pair with terrain.deform). Paint-driven grass regrows only on EditableTerrain; derived grass comes from the compiler's biome stages.",
    category: "terrain",
    permissions: ["scene.write"],
    // Pins the resolved lattice + committed layer identity + the nested commit's durable
    // record into the replay log (derived path only) — mirrors terrain.deform's pins.
    commitFields: ["baseTopology", "layerRef", "commitRecord"],
    input: paintInput,
    output: paintOutput,
    handler: (input, ctx) => {
      let id = input.entity;
      if (id === undefined) { let last: string | undefined; for (const k of layers.keys()) last = k; id = last; }
      const layer = id !== undefined ? layers.get(id) : undefined;
      if (layer === undefined) return derivedPaint(input, ctx);
      applyBrushPaint(layer.tile, input);
      // Re-color the EXISTING geometry (render context only): rebuild the elevation base color, then
      // blend the paint overlay. No collider/geometry rebuild — paint never changes height.
      if (layer.mesh?.geometry !== undefined) {
        const g = layer.mesh.geometry as unknown as Parameters<typeof applyPaintOverlay>[0];
        if (layer.elevationColors !== undefined) applyElevationColors(g, layer.tile, layer.elevationColors);
        applyPaintOverlay(g, layer.tile);
      }
      // Refresh the grass chunks the stamp touched (render context only — layer.grass exists only
      // there). Padded by the paint's bilinear reach (~one grid step) + the placement jitter so a
      // stroke's density change lands on every affected blade. Cheap: a few chunks per stamp.
      layer.grass?.refreshCircle(input.center[0], input.center[1], input.radius + 3);
      ctx.emit("terrain.painted", { entity: id, material: input.material });
      return { ok: true };
    },
  };

  // Read seam for the derived-build sidecar: resolve a committed derived edit layer by
  // content hash from the authority's LIVE store (rebuilt by worldlog replay — the log
  // is the persistence path, so the sidecar never needs the layer bytes on disk).
  const editLayer: SkillDefinition<{ assetId: string; hash: string }, { layer: unknown }> = {
    name: "authoring.terrainEditLayer",
    version: "1.0.0",
    description: "Read one content-addressed derived-terrain edit layer (the materialized sparse height deltas terrain.deform commits via refs.terrainEditLayers) from the authority's live store.",
    category: "world",
    permissions: ["authoring.read"],
    effect: "read",
    priority: "standard",
    input: z.object({ assetId: z.string(), hash: z.string() }).strict(),
    output: z.object({ layer: editLayerOutput }),
    handler: (input) => {
      const layer = derived.layers.get(input.hash);
      if (layer === undefined) {
        throw new SkillInvocationError("not_found", `no live derived terrain edit layer with content hash ${input.hash}`);
      }
      return { layer };
    },
  };

  /** The terrain-paint-layer wire shape for authoring.terrainPaintLayer output (zod mirror
   *  of terrain/paint-layer.mjs; the service re-validates with parseTerrainPaintLayer). */
  const paintLayerOutput = z.object({
    schema: z.literal("limina.terrain-paint-layer/v1"),
    layerId: z.string(),
    gridId: z.string(),
    baseTopology: baseTopologyInput,
    operations: z.array(z.object({
      operationId: z.string(),
      deltas: z.array(z.object({ gx: z.number().int(), gz: z.number().int(), material: z.string(), weight: z.number() }).strict()),
    }).strict()),
    contentHash: z.string(),
  }).strict();

  // Read seam for the derived-build sidecar: resolve a committed derived paint layer by
  // content hash from the authority's LIVE store (rebuilt by worldlog replay — the log
  // is the persistence path, so the sidecar never needs the layer bytes on disk).
  const paintLayer: SkillDefinition<{ assetId: string; hash: string }, { layer: unknown }> = {
    name: "authoring.terrainPaintLayer",
    version: "1.0.0",
    description: "Read one content-addressed derived-terrain paint layer (the materialized sparse paint stamps terrain.paint commits into refs.terrainEditLayers) from the authority's live store.",
    category: "world",
    permissions: ["authoring.read"],
    effect: "read",
    priority: "standard",
    input: z.object({ assetId: z.string(), hash: z.string() }).strict(),
    output: z.object({ layer: paintLayerOutput }),
    handler: (input) => {
      const layer = derived.paintLayers.get(input.hash);
      if (layer === undefined) {
        throw new SkillInvocationError("not_found", `no live derived terrain paint layer with content hash ${input.hash}`);
      }
      return { layer };
    },
  };

  registry.register(create as unknown as Parameters<SkillRegistry["register"]>[0]);
  registry.register(deform as unknown as Parameters<SkillRegistry["register"]>[0]);
  registry.register(paint as unknown as Parameters<SkillRegistry["register"]>[0]);
  registry.register(editLayer as unknown as Parameters<SkillRegistry["register"]>[0]);
  registry.register(paintLayer as unknown as Parameters<SkillRegistry["register"]>[0]);
  return { layers };
}
