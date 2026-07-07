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
// PROVENANCE + THE HASH SEAM: stableStringifyWorldMap / worldMapContentHash live in
// worldmap-hash.mjs (a plain .mjs, not here) because they must be byte-identical whether called
// from this engine module (.ts importing .mjs — the established terrain-heightfield.mjs pattern)
// or from the compiler CLI (plain Node, cannot import a .ts). This module re-exports them so a TS
// caller never needs to know the split exists.

import { z } from "../../build/zod.bundle.mjs";
import { stableStringifyWorldMap as stableStringifyWorldMapImpl, worldMapContentHash as worldMapContentHashImpl } from "./worldmap-hash.mjs";

export const WORLD_MAP_VERSION = 1 as const;

export const RELIEF_KINDS = ["mountain", "hills", "plateau", "peak", "depression"] as const;
export const BIOME_KINDS = ["grass", "forest", "mountain", "desert", "tundra", "swamp", "water"] as const;
export const WATERWAY_CLASSES = ["river", "stream"] as const;
export const ROUTE_CLASSES = ["road", "trail"] as const;
export const ANCHOR_SOURCES = ["world-bible", "map"] as const;
export const PROVENANCE_TOOLS = ["design-space", "fmg"] as const;

const PointSchema = z.tuple([z.number(), z.number()]);
const PointsSchema = z.array(PointSchema);

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

const BiomeRegionSchema = z.object({
  biome: z.enum(BIOME_KINDS),
  points: PointsSchema.min(3),
}).strict();

const WaterwaySchema = z.object({
  points: PointsSchema.min(2),
  widthM: z.number().positive().optional(),
  class: z.enum(WATERWAY_CLASSES),
}).strict();

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
  source: z.enum(ANCHOR_SOURCES),
}).strict();

const ProvenanceSchema = z.object({
  tool: z.enum(PROVENANCE_TOOLS),
  sourceHash: z.string().optional(),
  compiledAt: z.string().optional(),
  contentHash: z.string().min(1),
}).strict();

export const WorldMapSchema = z.object({
  version: z.literal(WORLD_MAP_VERSION),
  id: z.string().min(1),
  unitsPerMeter: z.number().positive(),
  origin: PointSchema,
  extent: z.object({ w: z.number().positive(), h: z.number().positive() }).strict(),
  seaLevel: z.number(),
  land: z.array(PolygonSchema),
  relief: z.array(ReliefHintSchema),
  biomes: z.array(BiomeRegionSchema),
  waterways: z.array(WaterwaySchema),
  routes: z.array(RouteSchema),
  anchors: z.array(AnchorSchema),
  provenance: ProvenanceSchema,
}).strict();

export type Point = z.infer<typeof PointSchema>;
export type Polygon = z.infer<typeof PolygonSchema>;
export type ReliefHint = z.infer<typeof ReliefHintSchema>;
export type BiomeRegion = z.infer<typeof BiomeRegionSchema>;
export type Waterway = z.infer<typeof WaterwaySchema>;
export type Route = z.infer<typeof RouteSchema>;
export type Anchor = z.infer<typeof AnchorSchema>;
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
 * zod-parse `parsed` as a WorldMap, recompute its content hash, and compare against the embedded
 * provenance.contentHash. Reports {ok, expected, actual} — this function never throws on a hash
 * mismatch (a malformed/non-WorldMap `parsed` still throws via WorldMapSchema.parse, since there
 * is no hash to compare in that case); whether a mismatch is fatal is the CALLER's choice.
 */
export function verifyWorldMap(parsed: unknown): WorldMapVerifyResult {
  const map = WorldMapSchema.parse(parsed);
  const expected = map.provenance.contentHash;
  const actual = worldMapContentHash(map);
  return { ok: expected === actual, expected, actual };
}
