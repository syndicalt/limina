// WorldMap — the versioned map-authoring IR: what a design-space map (maps.json) or an FMG import
// COMPILES INTO before the terrain/vegetation/structure pipeline ever runs. Mirrors world-bible.ts's
// shape (version literal, strict Zod objects, deterministic parse/stringify/hash helpers) but for
// the SPATIAL side of a design vault — outlines, biome regions, rivers, roads, and world-bible
// locations projected into world-meter anchors — rather than the narrative side.
//
// THE SCALE CONTRACT: every coordinate in a WorldMap is WORLD METERS, `unitsPerMeter` fixed at
// authoring time (1 = already meters), `origin` the map's (0,0) expressed in world space. A
// compiler (tools/map/compile-designmap.mjs) is the only thing that should ever produce one of
// these; the terrain/vegetation/structure build pipeline consumes it read-only.
//
// THE AXIS CONVENTION: +x = east, NORTH = -z (right-handed, y-up — matches THREE's default
// -z-forward camera and east × north = up: (1,0,0) × (0,0,-1) = (0,1,0)). A +z=north pairing
// would be left-handed and renders every north-up 2D map as an exact MIRROR of its 3D build —
// the bug this convention was locked to prevent. The map tool still draws north as screen-UP.
//
// PROVENANCE + THE HASH SEAM: stableStringifyWorldMap / worldMapContentHash live in
// worldmap-hash.mjs (a plain .mjs, not here) because they must be byte-identical whether called
// from this engine module (.ts importing .mjs — the established terrain-heightfield.mjs pattern)
// or from the compiler CLI (plain Node, cannot import a .ts). This module re-exports them so a TS
// caller never needs to know the split exists.

import { z } from "../../build/zod.bundle.mjs";
import { stableStringifyWorldMap as stableStringifyWorldMapImpl, worldMapContentHash as worldMapContentHashImpl } from "./worldmap-hash.mjs";
import { inspectWaterBodyTopology, isPlainJsonData, isPortableWaterId, WATER_BODY_KINDS, WATER_LIMITS, WATERWAY_CLASSES } from "./water-ir.mjs";
import { HYDROLOGY_LIMITS, HYDROLOGY_RECIPE_SCHEMA, parseAuthoredHydrologyRecipe } from "./hydrology-ir.mjs";
import {
  ATLAS_DESIGN_REF_KINDS,
  ATLAS_DESIGN_REF_SCHEMA,
  MAX_ATLAS_DESIGN_REF_IDENTIFIER_CHARS,
  MAX_DESIGN_INDEX_ENTRIES,
  atlasDesignRefKey,
  parseAtlasDesignRef,
} from "./design-ref.mjs";

export { WATER_BODY_KINDS, WATERWAY_CLASSES } from "./water-ir.mjs";
export { HYDROLOGY_LIMITS, HYDROLOGY_RECIPE_SCHEMA } from "./hydrology-ir.mjs";

export const WORLD_MAP_VERSION = 1 as const;

export const RELIEF_KINDS = ["mountain", "hills", "plateau", "peak", "depression"] as const;
export const BIOME_KINDS = ["grass", "forest", "mountain", "desert", "tundra", "swamp", "water", "blight"] as const;
export const ROUTE_CLASSES = ["road", "trail"] as const;
export const ANCHOR_SOURCES = ["world-bible", "map", "places"] as const;
export const PROVENANCE_TOOLS = ["design-space", "fmg"] as const;

const PointSchema = z.tuple([z.number(), z.number()]);
const PointsSchema = z.array(PointSchema);

const FiniteWaterCoordinateSchema = z.number().finite().min(-WATER_LIMITS.absCoordinateM).max(WATER_LIMITS.absCoordinateM);
const FinitePointSchema = z.tuple([FiniteWaterCoordinateSchema, FiniteWaterCoordinateSchema]);

const INVALID_PLAIN_DATA = Symbol("invalid-plain-json-data");
const INVALID_DESIGN_REF = Symbol("invalid-atlas-design-ref");
function plainJson<T extends z.ZodTypeAny>(schema: T) {
  return z.preprocess((value) => isPlainJsonData(value) ? value : INVALID_PLAIN_DATA, schema);
}

function isPlainRootRecord(value: unknown): boolean {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  if (Object.getOwnPropertySymbols(value).length !== 0) return false;
  return Object.values(Object.getOwnPropertyDescriptors(value)).every((descriptor) => "value" in descriptor && descriptor.enumerable);
}

export const AtlasDesignRefSchema = z.preprocess((value) => {
  try { return parseAtlasDesignRef(value); }
  catch { return INVALID_DESIGN_REF; }
}, z.object({
  schema: z.literal(ATLAS_DESIGN_REF_SCHEMA),
  mapId: z.string().min(1).max(MAX_ATLAS_DESIGN_REF_IDENTIFIER_CHARS),
  kind: z.enum(ATLAS_DESIGN_REF_KINDS),
  id: z.string().min(1).max(MAX_ATLAS_DESIGN_REF_IDENTIFIER_CHARS),
}).strict());

const PolygonSchema = z.object({
  points: PointsSchema.min(3),
  holes: z.array(PointsSchema.min(3)).optional(),
}).strict();

const ReliefShapeSchema = z.object({
  polygon: PointsSchema.min(3).optional(),
  point: PointSchema.optional(),
}).strict().refine(
  (s) => s.polygon !== undefined || s.point !== undefined,
  { message: "a relief hint's shape must carry a polygon or a point" },
);

const ReliefHintSchema = z.object({
  kind: z.enum(RELIEF_KINDS),
  shape: ReliefShapeSchema,
  amplitude: z.number(),
}).strict();

// A painted elevation raster (Map Studio S1): ABSOLUTE surface elevation in world meters. New
// Atlas maps use explicit little-endian u16; absent/'u8' remains the legacy value/255 form.
// Cells map linearly to [minY, maxY], row-major with +col = +x (east) and
// +row = +z (i.e. row 0 is the NORTHERNMOST row — north is -z), spanning the world-meter
// `rect`. PRECEDENCE CONTRACT: when a WorldMap carries a reliefGrid, it REPLACES the vector
// `relief` hints entirely (painted is authoritative; compilers emit hints only for maps
// without a raster) — enforced by the rasterizer (map-raster.mjs), gated by mapstudio-gate.
// HASH CONTRACT: this field is hashed via an explicit walk in worldmap-hash.mjs — adding a
// field here without adding it there ships a silently-unhashed field (see that module's header).
const ReliefGridSchema = z.object({
  w: z.number().int().min(2).max(1024),
  h: z.number().int().min(2).max(1024),
  rect: z.object({ x0: z.number(), z0: z.number(), w: z.number().positive(), h: z.number().positive() }).strict(),
  minY: z.number(),
  maxY: z.number(),
  /** Vertical quantization of `data`: 'u16' packs each cell as 2 LITTLE-ENDIAN bytes (65,536 levels —
   *  ~0.14m/step over a 9km range, real mountains without terracing); absent or 'u8' = the legacy
   *  1-byte cell. ABSENT is the version discriminator: every pre-u16 map reads as u8 unchanged and
   *  hashes byte-identically (worldmap-hash emits `encoding` only-when-present). */
  encoding: z.enum(["u8", "u16"]).optional(),
  /** base64 of w*h cells (u8 → w*h bytes; u16 → 2*w*h little-endian bytes). */
  data: z.string().min(1).max(2796204), // base64 ceiling for 1024*1024*2 bytes
}).strict().refine((g) => g.maxY > g.minY, { message: "reliefGrid maxY must be greater than minY" });

const BiomeRegionSchema = z.object({
  biome: z.enum(BIOME_KINDS),
  points: PointsSchema.min(3),
}).strict();

const WaterwaySchema = plainJson(z.object({
  points: z.array(FinitePointSchema).min(2).max(WATER_LIMITS.waterwayPoints),
  widthM: z.number().finite().positive().max(WATER_LIMITS.widthM).optional(),
  class: z.enum(WATERWAY_CLASSES),
  /** Strahler stream order: 1=headwater, increasing only at equal-order confluences. */
  order: z.number().int().min(1).max(WATER_LIMITS.streamOrder).optional(),
  /** Per-vertex channel widths in metres. When present, length exactly matches `points`. */
  widths: z.array(z.number().finite().positive().max(WATER_LIMITS.widthM)).min(2).max(WATER_LIMITS.waterwayPoints).optional(),
}).strict().superRefine((waterway, ctx) => {
  if (waterway.widths !== undefined && waterway.widths.length !== waterway.points.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["widths"], message: "waterway widths must have exactly one value per point" });
  }
}));

const WaterDepthZoneSchema = z.object({
  /** Inclusive horizontal distance inward from the shoreline, in metres. */
  minShoreDistanceM: z.number().finite().min(0).max(WATER_LIMITS.shoreDistanceM),
  /** Exclusive outer edge of this band. */
  maxShoreDistanceM: z.number().finite().positive().max(WATER_LIMITS.shoreDistanceM),
  /** Positive depth below this body's level, in metres. */
  depthM: z.number().finite().positive().max(WATER_LIMITS.depthM),
}).strict().refine((zone) => zone.maxShoreDistanceM > zone.minShoreDistanceM, {
  message: "depth zone maxShoreDistanceM must be greater than minShoreDistanceM",
});

const WaterFootprintSchema = z.object({
  points: z.array(FinitePointSchema).min(3).max(WATER_LIMITS.ringPoints),
  holes: z.array(z.array(FinitePointSchema).min(3).max(WATER_LIMITS.ringPoints)).max(WATER_LIMITS.holes).optional(),
}).strict();

const WaterBodySchema = z.object({
  /** Stable lowercase ASCII id; path separators, whitespace and host-case ambiguity are forbidden. */
  id: z.string().min(1).max(128).refine(isPortableWaterId, { message: "water body id must be portable lowercase ASCII" }),
  kind: z.enum(WATER_BODY_KINDS),
  level: z.number().finite().min(-WATER_LIMITS.absLevelM).max(WATER_LIMITS.absLevelM),
  footprint: WaterFootprintSchema,
  /** Contiguous shore-to-interior bands: first min=0, each next min=previous max, and depth
   *  strictly increases inward. This leaves no undefined bathymetry for WaterField consumers. */
  depthZones: z.array(WaterDepthZoneSchema).min(1).max(WATER_LIMITS.depthZones),
}).strict().superRefine((body, ctx) => {
  let previousMax = -Infinity, previousDepth = -Infinity;
  for (let index = 0; index < body.depthZones.length; index++) {
    const zone = body.depthZones[index];
    if (index === 0 && zone.minShoreDistanceM !== 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["depthZones", index, "minShoreDistanceM"], message: "the first depth zone must start at the shoreline (0m)" });
    }
    if (index > 0 && zone.minShoreDistanceM !== previousMax) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["depthZones", index], message: "depth zones must be ordered and contiguous without gaps or overlaps" });
    }
    if (zone.depthM <= previousDepth) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["depthZones", index, "depthM"], message: "depth must increase monotonically toward the interior" });
    }
    previousMax = zone.maxShoreDistanceM;
    previousDepth = zone.depthM;
  }
});

const WaterBodiesSchema = plainJson(z.array(WaterBodySchema).max(WATER_LIMITS.bodies).superRefine((bodies, ctx) => {
  const ids = new Set<string>();
  let points = 0;
  for (let index = 0; index < bodies.length; index++) {
    const body = bodies[index];
    if (ids.has(body.id)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: [index, "id"], message: "water body ids must be unique" });
    ids.add(body.id);
    points += body.footprint.points.length;
    for (const hole of body.footprint.holes ?? []) points += hole.length;
    const bodyPoints = body.footprint.points.length + (body.footprint.holes ?? []).reduce((total, hole) => total + hole.length, 0);
    if (bodyPoints > WATER_LIMITS.bodyPoints) ctx.addIssue({ code: z.ZodIssueCode.custom, path: [index, "footprint"], message: `water body footprint exceeds ${WATER_LIMITS.bodyPoints} points` });
  }
  if (points > WATER_LIMITS.totalBodyPoints) ctx.addIssue({ code: z.ZodIssueCode.custom, message: `water body geometry exceeds ${WATER_LIMITS.totalBodyPoints} points` });
  const topology = inspectWaterBodyTopology(bodies);
  if (!topology.ok) ctx.addIssue({ code: z.ZodIssueCode.custom, message: topology.message ?? "invalid water body topology" });
}));

const HydrologyRecipeSchema = z.preprocess((value) => {
  try { return parseAuthoredHydrologyRecipe(value); }
  catch { return INVALID_PLAIN_DATA; }
}, z.object({
  schema: z.literal(HYDROLOGY_RECIPE_SCHEMA),
  precipitationMmPerYear: z.number().finite().min(0).max(HYDROLOGY_LIMITS.precipitationMmPerYear),
  riverMinCatchmentAreaM2: z.number().finite().positive().max(HYDROLOGY_LIMITS.catchmentAreaM2),
  basinMinAreaM2: z.number().finite().positive().max(HYDROLOGY_LIMITS.basinAreaM2),
  basinMinDepthM: z.number().finite().positive().max(HYDROLOGY_LIMITS.basinDepthM),
  waterfallMinDropM: z.number().finite().positive().max(HYDROLOGY_LIMITS.waterfallDropM),
}).strict());

const RouteSchema = z.object({
  points: PointsSchema.min(2),
  class: z.enum(ROUTE_CLASSES),
}).strict();

const AnchorSchema = z.object({
  id: z.string().min(1),
  kind: z.string().min(1),
  position: PointSchema,
  count: z.number().int().positive().optional(),
  name: z.string().min(1).optional(),
  // Map Painter P3 stamps: an anchor that names its EXACT catalog asset (kind "asset"), with an
  // optional yaw (radians) and uniform scale. Optional so legacy anchors (and their content
  // hashes — worldmap-hash emits these only-when-present) are untouched.
  assetId: z.string().min(1).optional(),
  rot: z.number().optional(),
  scale: z.number().positive().optional(),
  designRef: AtlasDesignRefSchema.optional(),
  source: z.enum(ANCHOR_SOURCES),
}).strict();

// A REGION CROP descriptor (compile-fmg.mjs --crop/--radius): the crop anchor (a burg name or a
// raw "x,y-px" label, human-readable) + its resolved pixel position in the SOURCE export + the
// crop radius in meters. Present only when the compiled map is a cropped subset of a larger
// export; optional so whole-map compiles (the common case) are unaffected.
// GAZETTEER (Places Stage 4): the runtime named-place index NPCs navigate by. Each placed place
// (a `places.md` node with a map position) compiles to one entry — the SAME [x, z] world-meter
// convention as every other IR point (y is resolved at runtime from the terrain height; the IR is
// 2D). parentId preserves the nested-place hierarchy (Nation > Province > City); it may reference an
// UNPLACED ancestor (which has no gazetteer entry of its own — nothing to navigate to). radiusM is
// present only for area-bound places (binding:"area"). Additive + optional so every pre-Places map
// keeps its original bytes/hash (worldmap-hash emits this only-when-present, like reliefGrid).
// HASH CONTRACT: hashed via an explicit walk in worldmap-hash.mjs — adding a field here without
// adding it there ships a silently-unhashed field.
const GazetteerEntrySchema = z.object({
  placeId: z.string().min(1),
  name: z.string().min(1),
  kind: z.string().min(1),
  parentId: z.string().min(1).nullable(),
  position: PointSchema,
  radiusM: z.number().positive().optional(),
  designRef: AtlasDesignRefSchema.optional(),
}).strict();

const DesignIndexEntrySchema = z.object({
  designRef: AtlasDesignRefSchema,
  position: PointSchema,
  radiusM: z.number().positive().optional(),
}).strict();

const DesignIndexSchema = z.array(DesignIndexEntrySchema).max(MAX_DESIGN_INDEX_ENTRIES).superRefine((entries, ctx) => {
  const seen = new Set<string>();
  for (let index = 0; index < entries.length; index++) {
    const key = atlasDesignRefKey(entries[index].designRef);
    if (seen.has(key)) ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: [index, "designRef"],
      message: "duplicate Atlas designRef",
    });
    seen.add(key);
  }
});

const CropOfSchema = z.object({
  anchor: z.string().min(1),
  anchorPx: PointSchema,
  radiusM: z.number().positive(),
}).strict();

const ProvenanceSchema = z.object({
  tool: z.enum(PROVENANCE_TOOLS),
  sourceHash: z.string().optional(),
  compiledAt: z.string().optional(),
  contentHash: z.string().min(1),
  cropOf: CropOfSchema.optional(),
}).strict();

const WorldMapObjectSchema = z.object({
  version: z.literal(WORLD_MAP_VERSION),
  id: z.string().min(1),
  unitsPerMeter: z.number().positive(),
  origin: PointSchema,
  extent: z.object({ w: z.number().positive(), h: z.number().positive() }).strict(),
  seaLevel: z.number(),
  land: z.array(PolygonSchema),
  relief: z.array(ReliefHintSchema),
  reliefGrid: ReliefGridSchema.optional(),
  biomes: z.array(BiomeRegionSchema),
  waterways: z.array(WaterwaySchema).max(WATER_LIMITS.waterways).superRefine((waterways, ctx) => {
    const points = waterways.reduce((total, waterway) => total + waterway.points.length, 0);
    if (points > WATER_LIMITS.totalWaterwayPoints) ctx.addIssue({ code: z.ZodIssueCode.custom, message: `waterway geometry exceeds ${WATER_LIMITS.totalWaterwayPoints} points` });
  }),
  // Optional + additive: absent on every pre-WB-W1 map and never defaulted during migration.
  waterBodies: WaterBodiesSchema.optional(),
  // Optional authoring inputs only. Derived drainage topology is published as a compiler artifact.
  hydrology: HydrologyRecipeSchema.optional(),
  routes: z.array(RouteSchema),
  anchors: z.array(AnchorSchema),
  // The named-place index (Places Stage 4). Optional + additive: absent on every pre-Places map.
  gazetteer: z.array(GazetteerEntrySchema).optional(),
  // Exact reverse lookup for Atlas subjects, including features that do not materialize as entities.
  // Optional so every legacy WorldMap retains its original canonical bytes and content hash.
  designIndex: DesignIndexSchema.optional(),
  provenance: ProvenanceSchema,
}).strict();

// Inspect root descriptors before Zod reads any field. JSON.parse always produces this shape;
// direct engine callers cannot smuggle an accessor or polluted prototype into the public parser.
export const WorldMapSchema = z.preprocess((value) => isPlainRootRecord(value) ? value : INVALID_PLAIN_DATA, WorldMapObjectSchema);

export type Point = z.infer<typeof PointSchema>;
export type Polygon = z.infer<typeof PolygonSchema>;
export type ReliefHint = z.infer<typeof ReliefHintSchema>;
export type ReliefGrid = z.infer<typeof ReliefGridSchema>;
export type BiomeRegion = z.infer<typeof BiomeRegionSchema>;
export type Waterway = z.infer<typeof WaterwaySchema>;
export type WaterBody = z.infer<typeof WaterBodySchema>;
export type HydrologyRecipe = z.infer<typeof HydrologyRecipeSchema>;
export type Route = z.infer<typeof RouteSchema>;
export type Anchor = z.infer<typeof AnchorSchema>;
export type GazetteerEntry = z.infer<typeof GazetteerEntrySchema>;
export type AtlasDesignRef = z.infer<typeof AtlasDesignRefSchema>;
export type DesignIndexEntry = z.infer<typeof DesignIndexEntrySchema>;
export type WorldMapProvenance = z.infer<typeof ProvenanceSchema>;
export type WorldMap = z.infer<typeof WorldMapSchema>;

/** Deterministic serialization: fixed key order (schema declaration order), no whitespace
 *  variance. `omitContentHash: true` drops provenance.contentHash entirely (the form
 *  worldMapContentHash hashes — a hash cannot include itself). Delegates to worldmap-hash.mjs so
 *  the engine and the compiler CLI share one implementation. */
export function stableStringifyWorldMap(map: WorldMap, opts: { omitContentHash?: boolean } = {}): string {
  return stableStringifyWorldMapImpl(map, opts) as string;
}

/** sha256 hex (via the dependency-free sha256.mjs — NOT the host's op_sha256, which is not
 *  byte-identical across hosts) of the stable form with contentHash omitted. */
export function worldMapContentHash(map: WorldMap): string {
  return worldMapContentHashImpl(map) as string;
}

export interface WorldMapVerifyResult {
  ok: boolean;
  expected: string;
  actual: string;
}

/**
 * Forward-migrate a raw parsed WorldMap object (JSON.parse output, not yet schema-validated) up
 * to WORLD_MAP_VERSION, returning something ready for WorldMapSchema.parse. Structured as a
 * version-step LADDER — one `if (version === N)` rung per historical version — so a future v2
 * lands as one more rung, not a rewrite:
 *
 *   if (version === 1) { map = { ...map, version: 2, ...newV2Defaults }; }
 *   if (version === 2) { map = { ...map, version: 3, ... }; }
 *   // falls through to WORLD_MAP_VERSION
 *
 * TODAY WORLD_MAP_VERSION is 1 and there is no rung below it (v1 is the IR's origin version — no
 * v0 WorldMap ever shipped), so this function is a HASH-IDENTICAL NO-OP for every input it
 * recognizes as current or ladder-eligible: `raw` is returned BY REFERENCE, unmodified — no key
 * reordering, no field defaulting, nothing that could perturb worldMapContentHash. A
 * missing/non-numeric/unrecognized-lower `version` (garbage, or a hypothetical v0) is likewise
 * passed through untouched rather than guessed at — WorldMapSchema.parse is left to reject it,
 * so a non-map file can never be silently coerced into looking like one.
 *
 * Mirrors tools/design/map-doc.mjs's migrateMapDoc (the map DOC's migration-on-read) in shape,
 * but not in spirit: a map DOC is hand-authored and gets defaulting/repair on read. A WorldMap is
 * machine-compiled — an out-of-shape one is a real bug to surface via the schema, never to paper
 * over here.
 */
export function migrateWorldMap(raw: unknown): unknown {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return raw;
  const map = raw as Record<string, unknown>;
  if (typeof map.version !== "number") return raw;

  // Ladder rungs land here as WORLD_MAP_VERSION grows, e.g.:
  //   if (map.version === 1) map = { ...map, version: 2, newField: defaultFor(map) };
  // None exist yet: v1 is the origin version, so every currently-possible input already at
  // WORLD_MAP_VERSION (or below it with no rung defined) falls through unchanged.

  return map;
}

/**
 * zod-parse `parsed` as a WorldMap, recompute its content hash, and compare against the embedded
 * provenance.contentHash. Reports {ok, expected, actual} — this function never throws on a hash
 * mismatch (a malformed/non-WorldMap `parsed` still throws via WorldMapSchema.parse, since there
 * is no hash to compare in that case); whether a mismatch is fatal is the CALLER's choice.
 * Migrates forward (see migrateWorldMap) before validating, so an older-version map on disk keeps
 * loading as the IR evolves.
 */
export function verifyWorldMap(parsed: unknown): WorldMapVerifyResult {
  const map = WorldMapSchema.parse(migrateWorldMap(parsed));
  const expected = map.provenance.contentHash;
  const actual = worldMapContentHash(map);
  return { ok: expected === actual, expected, actual };
}
