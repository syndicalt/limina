// WORLD BIBLE -- the project-level setting/place artifact produced by design studios.
//
// Mirrors design-direction.ts / building-brief.ts: a version literal, strict Zod objects,
// deterministic parse/canonicalize/serialize helpers, and semantic validation for ids/references.

import { z } from "../../build/zod.bundle.mjs";

export const WORLD_BIBLE_VERSION = "world-bible/1" as const;

export const REGION_BIOMES = [
  "temperate-forest",
  "marsh",
  "mountain",
  "coast",
  "grassland",
  "tundra",
  "desert",
  "blighted",
] as const;

export const LOCATION_KINDS = [
  "settlement",
  "landmark",
  "dungeon",
  "camp",
  "ruin",
  "wild",
] as const;

const SettingSchema = z.object({
  name: z.string().min(1),
  era: z.string().min(1),
  premise: z.string().min(1),
}).strict();

const RegionSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  biome: z.enum(REGION_BIOMES),
  climate: z.string().min(1).optional(),
  description: z.string().min(1),
}).strict();

const LocationSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  regionId: z.string().min(1),
  kind: z.enum(LOCATION_KINDS),
  description: z.string().min(1),
  position: z.tuple([z.number(), z.number()]).optional(),
}).strict();

const MapSchema = z.object({
  width: z.number().positive(),
  height: z.number().positive(),
  notes: z.string().min(1).optional(),
}).strict();

export const WorldBibleSchema = z.object({
  version: z.literal(WORLD_BIBLE_VERSION),
  setting: SettingSchema,
  regions: z.array(RegionSchema),
  locations: z.array(LocationSchema),
  map: MapSchema.optional(),
}).strict();

export type WorldBible = z.infer<typeof WorldBibleSchema>;
export type WorldBibleRegion = z.infer<typeof RegionSchema>;
export type WorldBibleLocation = z.infer<typeof LocationSchema>;
export type WorldBibleMap = z.infer<typeof MapSchema>;

export interface WorldBibleIssue {
  path: string;
  message: string;
}

export function parseWorldBible(json: string): WorldBible {
  return WorldBibleSchema.parse(JSON.parse(json));
}

export function canonicalizeWorldBible(w: WorldBible): WorldBible {
  return {
    version: w.version,
    setting: {
      name: w.setting.name,
      era: w.setting.era,
      premise: w.setting.premise,
    },
    regions: w.regions.map((r) => ({
      id: r.id,
      name: r.name,
      biome: r.biome,
      ...(r.climate !== undefined ? { climate: r.climate } : {}),
      description: r.description,
    })),
    locations: w.locations.map((l) => ({
      id: l.id,
      name: l.name,
      regionId: l.regionId,
      kind: l.kind,
      description: l.description,
      ...(l.position !== undefined ? { position: [l.position[0], l.position[1]] } : {}),
    })),
    ...(w.map !== undefined ? {
      map: {
        width: w.map.width,
        height: w.map.height,
        ...(w.map.notes !== undefined ? { notes: w.map.notes } : {}),
      },
    } : {}),
  };
}

export function serializeWorldBible(w: WorldBible): string {
  return JSON.stringify(canonicalizeWorldBible(w));
}

export function validateWorldBible(
  input: unknown,
): { ok: boolean; data?: WorldBible; issues: WorldBibleIssue[] } {
  const parsed = WorldBibleSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })) };
  }

  const bible = parsed.data;
  const issues: WorldBibleIssue[] = [];
  const regionIds = new Set<string>();
  for (const region of bible.regions) {
    if (regionIds.has(region.id)) issues.push({ path: `regions.${region.id}`, message: `duplicate region id "${region.id}"` });
    regionIds.add(region.id);
  }

  const locationIds = new Set<string>();
  for (const location of bible.locations) {
    if (locationIds.has(location.id)) issues.push({ path: `locations.${location.id}`, message: `duplicate location id "${location.id}"` });
    locationIds.add(location.id);
    if (!regionIds.has(location.regionId)) {
      issues.push({ path: `locations.${location.id}.regionId`, message: `location "${location.id}" references missing region "${location.regionId}"` });
    }
  }

  return issues.length === 0 ? { ok: true, data: bible, issues: [] } : { ok: false, data: bible, issues };
}

export const DEFAULT_WORLD_BIBLE: WorldBible = {
  version: WORLD_BIBLE_VERSION,
  setting: {
    name: "Relic Sprint Frontier",
    era: "late medieval frontier",
    premise: "A small border camp holds the line while a creeping blight pushes out of the old woods.",
  },
  regions: [
    {
      id: "home-region",
      name: "Greenward March",
      biome: "temperate-forest",
      climate: "cool, wet, and changeable",
      description: "A wooded frontier of old paths, damp clearings, and watchfires at the edge of settled land.",
    },
  ],
  locations: [
    {
      id: "home",
      name: "Signal Camp",
      regionId: "home-region",
      kind: "camp",
      description: "A rough palisade camp built around a signal fire and a muddy road into the forest.",
      position: [0, 0],
    },
  ],
  map: {
    width: 64,
    height: 64,
    notes: "Authoring-space map dimensions in world tiles.",
  },
};
