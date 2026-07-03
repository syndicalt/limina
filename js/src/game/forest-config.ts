import { z } from "../../build/zod.bundle.mjs";

const UnitInterval = z.number().min(0).max(1);

const SpeciesMixSchema = z.object({
  id: z.string().min(1),
  weight01: UnitInterval,
}).strict();

export const ForestConfigSchema = z.object({
  version: z.literal(1),
  seed: z.number().int(),
  region: z.object({
    extentM: z.number().positive(),
    center: z.tuple([z.number(), z.number()]),
  }).strict(),
  climate: z.object({
    latitude: z.number().min(-90).max(90),
    moisture01: UnitInterval,
    season: z.enum(["spring", "summer", "autumn", "winter"]),
  }).strict(),
  terrain: z.object({
    relief: z.enum(["lowland", "hills", "ridge"]),
    erosion01: UnitInterval,
    rivers: z.boolean(),
  }).strict(),
  canopy: z.object({
    species: z.array(SpeciesMixSchema).min(1),
    densityPerHa: z.number().min(0),
    ageMix01: UnitInterval,
  }).strict(),
  understory: z.object({
    moss01: UnitInterval,
    ferns01: UnitInterval,
    shrubs01: UnitInterval,
    deadfall01: UnitInterval,
    grassBlades: z.number().int().min(0),
  }).strict(),
  light: z.object({
    sunElevationDeg: z.number().min(0).max(90),
    timeOfDay: z.number().min(0).max(24),
    mist01: UnitInterval,
  }).strict(),
}).strict();

export type ForestConfig = z.infer<typeof ForestConfigSchema>;

export function parseForestConfig(json: string): ForestConfig {
  return ForestConfigSchema.parse(JSON.parse(json));
}

function canonicalForestConfig(c: ForestConfig): ForestConfig {
  return {
    version: c.version,
    seed: c.seed,
    region: {
      extentM: c.region.extentM,
      center: [c.region.center[0], c.region.center[1]],
    },
    climate: {
      latitude: c.climate.latitude,
      moisture01: c.climate.moisture01,
      season: c.climate.season,
    },
    terrain: {
      relief: c.terrain.relief,
      erosion01: c.terrain.erosion01,
      rivers: c.terrain.rivers,
    },
    canopy: {
      species: c.canopy.species.map((s) => ({
        id: s.id,
        weight01: s.weight01,
      })),
      densityPerHa: c.canopy.densityPerHa,
      ageMix01: c.canopy.ageMix01,
    },
    understory: {
      moss01: c.understory.moss01,
      ferns01: c.understory.ferns01,
      shrubs01: c.understory.shrubs01,
      deadfall01: c.understory.deadfall01,
      grassBlades: c.understory.grassBlades,
    },
    light: {
      sunElevationDeg: c.light.sunElevationDeg,
      timeOfDay: c.light.timeOfDay,
      mist01: c.light.mist01,
    },
  };
}

export function serializeForestConfig(c: ForestConfig): string {
  return JSON.stringify(canonicalForestConfig(c));
}

export const DEFAULT_FOREST_CONFIG: ForestConfig = {
  version: 1,
  seed: 1073741849,
  region: {
    extentM: 1200,
    center: [0, 0],
  },
  climate: {
    latitude: 61.5,
    moisture01: 0.78,
    season: "autumn",
  },
  terrain: {
    relief: "hills",
    erosion01: 0.42,
    rivers: true,
  },
  canopy: {
    species: [
      { id: "spruce", weight01: 0.56 },
      { id: "pine", weight01: 0.27 },
      { id: "birch", weight01: 0.17 },
    ],
    densityPerHa: 400,
    ageMix01: 0.86,
  },
  understory: {
    moss01: 0.82,
    ferns01: 0.34,
    shrubs01: 0.28,
    deadfall01: 0.62,
    grassBlades: 24000,
  },
  light: {
    sunElevationDeg: 18,
    timeOfDay: 9.5,
    mist01: 0.38,
  },
};
