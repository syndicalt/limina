// Step 0 (the keystone) — the WORLD-GENERATION wire format.
//
// WorldConfig is the composable, recorded, DETERMINISTIC config the agent authors and the
// world log stores. It describes a LARGE, streamed area (region + tile addressing), not a
// single editable patch. It is the single upstream input the deterministic generator reads;
// the durable log records THIS (a pure value), never the generated tile bytes.
//
// COMPOSITION IS REAL (the anti-reward-hack contract). This file does NOT invent enums or
// re-declare shapes that already exist in the engine — it REUSES the actual generator
// surfaces so the schema can never drift from what the generator understands:
//   - terrain.type          = z.enum(TERRAIN_TYPE_NAMES)          (terrain/terrain-types.ts)
//   - terrain.erosion        maps to ErosionParams {rain,thermal,talus} (terrain/erosion.ts)
//   - climate.{latitude,season,moisture01}  reuse ForestConfig.climate's field schemas
//   - atmosphere.{sky,grade,effects}        reuse LookProfile's field schemas
//   - vegetation.{canopy,understory,light}  reuse ForestConfig's field schemas (incl. SpeciesMix)
// If a real generator surface does not fit here, that is a REPORTED mismatch — never a made-up
// value to make a test green.
//
// Follows js/src/game/forest-config.ts exactly: version literal, int seed, .strict() sub-objects,
// parse*/canonical*/serialize* + a DEFAULT_* const, with a byte-stable canonical JSON round-trip.
// No Date / Math.random anywhere (deterministic + replay-safe).

import { z } from "../../build/zod.bundle.mjs";
import { ForestConfigSchema } from "../game/forest-config.ts";
import { LookProfileSchema } from "../render/look-profile.ts";
import { TERRAIN_TYPE_NAMES } from "../terrain/terrain-types.ts";

const UnitInterval = z.number().min(0).max(1);

// ── REUSED field schemas (genuine composition — no duplicate definitions) ────────────────
// Pull the EXACT sub-schemas the engine already ships so constraints stay in one place.
const ForestClimateShape = ForestConfigSchema.shape.climate.shape; // latitude/moisture01/season
const LookShape = LookProfileSchema.shape;                          // sky/grade/effects/...
const ForestShape = ForestConfigSchema.shape;                       // canopy/understory/light/...

// ── region: TILE ADDRESSING for streaming / massive worlds ───────────────────────────────
// A WorldConfig describes a LARGE area addressed as a tile grid, not one patch. This is
// load-bearing for streaming and must exist from the start.
const RegionSchema = z.object({
  // World-space center of the region [x, z] (meters).
  center: z.tuple([z.number(), z.number()]),
  // Side length of the region (meters). Positive.
  extentM: z.number().positive(),
  // Side length of one streaming tile (meters). Positive; the region is addressed in these.
  tileSizeM: z.number().positive(),
  // Level of detail for generation/streaming (0 = finest). Non-negative integer.
  lod: z.number().int().min(0),
}).strict();

// ── terrain ──────────────────────────────────────────────────────────────────────────────
// A single ground band (Phase 2 rock/sand/snow): a material applied where slope/elevation fall
// inside the given inclusive window. All bounds optional (an omitted bound = unbounded on that
// side). Kept minimal but real — bands are DATA the material system reads, not engine code.
const GroundMaterialBandSchema = z.object({
  material: z.string().min(1),
  minSlope01: UnitInterval.optional(),
  maxSlope01: UnitInterval.optional(),
  minElevM: z.number().optional(),
  maxElevM: z.number().optional(),
}).strict();

// Erosion knobs mapped 1:1 onto terrain/erosion.ts ErosionParams field-for-field (rain / thermal /
// talus — the exact struct names, so the schema can never drift from what the generator reads). The
// remaining ErosionParams knobs are not part of that struct's authored surface here; they keep their
// balanced DEFAULT_EROSION values.
const ErosionSchema = z.object({
  rain: z.number().min(0),           // droplets seeded per cell (hydraulic intensity) — ErosionParams.rain
  thermal: z.number().int().min(0),  // thermal-erosion passes — ErosionParams.thermal
  talus: z.number().positive(),      // thermal talus threshold (elevation units) — ErosionParams.talus
}).strict();

const TerrainSchema = z.object({
  // The REAL shipped terrain-type catalog — never an invented name.
  type: z.enum(TERRAIN_TYPE_NAMES),
  erosion: ErosionSchema,
  // Optional relief amplitude multiplier (maps to the terrain-type `amp` knob when set).
  reliefAmp: z.number().positive().optional(),
  // Optional slope/elevation-banded ground materials (Phase 2).
  groundMaterials: z.array(GroundMaterialBandSchema).min(1).optional(),
  // Optional sea level (meters) for derived water / coastlines.
  seaLevelM: z.number().optional(),
}).strict();

// ── climate (LOOSE coupling — an OPTIONAL input systems read) ────────────────────────────
// Reuses ForestConfig.climate's field schemas + the tempBias/precipBias that match
// terrain-types.ts TerrainTypeConfig.tempBias (°C) / precipBias (mm).
const ClimateSchema = z.object({
  latitude: ForestClimateShape.latitude,     // -90..90
  season: ForestClimateShape.season,         // spring/summer/autumn/winter
  moisture01: ForestClimateShape.moisture01, // 0..1
  tempBiasC: z.number().optional(),          // °C added to the climate field (terrain-types tempBias)
  precipBiasMm: z.number().optional(),       // mm added to the climate field (terrain-types precipBias)
}).strict();

// ── atmosphere (OPTIONAL) — composes LookProfile pieces + sun/fog ────────────────────────
const SunSchema = z.object({
  elevationDeg: z.number().min(0).max(90),
  azimuthDeg: z.number().min(0).max(360).optional(),
  timeOfDay: z.number().min(0).max(24).optional(),
}).strict();

const FogSchema = z.object({
  density01: UnitInterval,
  heightM: z.number().optional(),
  colorHex: z.string().optional(),
}).strict();

const AtmosphereSchema = z.object({
  sky: LookShape.sky,       // REUSED LookProfile sky enum (hillaire/gradient/painted)
  grade: LookShape.grade,   // REUSED LookProfile grade { tonemap, lut?, exposure }
  effects: LookShape.effects, // REUSED LookProfile effects { volumetrics, gi, bloom01, dof }
  sun: SunSchema,
  fog: FogSchema,
}).strict();

// ── water (OPTIONAL) — stylized first cut; lakes/rivers are DERIVED from terrain height ───
const WaterSchema = z.object({
  style: z.enum(["stylized"]),
  levelM: z.number(),
  colorHex: z.string().optional(),
  waves: z.object({
    amplitudeM: z.number().min(0),
    speed: z.number().min(0),
    scaleM: z.number().positive(),
  }).strict(),
}).strict();

// ── vegetation (OPTIONAL) — reuses ForestConfig canopy/understory/light (incl. SpeciesMix) ─
const VegetationSchema = z.object({
  seed: z.number().int(),
  density01: UnitInterval, // overall vegetation-coverage scalar
  canopy: ForestShape.canopy,         // { species: [{id, weight01}], densityPerHa, ageMix01 }
  understory: ForestShape.understory, // { moss01, ferns01, shrubs01, deadfall01, grassBlades }
  light: ForestShape.light,           // { sunElevationDeg, timeOfDay, mist01 }
}).strict();

export const WorldConfigSchema = z.object({
  version: z.literal(1),
  seed: z.number().int(),
  region: RegionSchema,
  terrain: TerrainSchema,
  climate: ClimateSchema.optional(),
  atmosphere: AtmosphereSchema.optional(),
  water: WaterSchema.optional(),
  vegetation: VegetationSchema.optional(),
}).strict();

export type WorldConfig = z.infer<typeof WorldConfigSchema>;

export function parseWorldConfig(json: string): WorldConfig {
  return WorldConfigSchema.parse(JSON.parse(json));
}

// ── Canonicalization: a stable, key-ordered clone so serialize() is byte-identical for equal
// values (deterministic wire format). Optional sub-objects are omitted when absent (JSON drops
// undefined), and every optional leaf is emitted in a fixed slot so present values stay stable. ─

function canonicalWorldConfig(c: WorldConfig): WorldConfig {
  const out: WorldConfig = {
    version: c.version,
    seed: c.seed,
    region: {
      center: [c.region.center[0], c.region.center[1]],
      extentM: c.region.extentM,
      tileSizeM: c.region.tileSizeM,
      lod: c.region.lod,
    },
    terrain: {
      type: c.terrain.type,
      erosion: {
        rain: c.terrain.erosion.rain,
        thermal: c.terrain.erosion.thermal,
        talus: c.terrain.erosion.talus,
      },
      ...(c.terrain.reliefAmp !== undefined ? { reliefAmp: c.terrain.reliefAmp } : {}),
      ...(c.terrain.groundMaterials !== undefined
        ? {
          groundMaterials: c.terrain.groundMaterials.map((b) => ({
            material: b.material,
            ...(b.minSlope01 !== undefined ? { minSlope01: b.minSlope01 } : {}),
            ...(b.maxSlope01 !== undefined ? { maxSlope01: b.maxSlope01 } : {}),
            ...(b.minElevM !== undefined ? { minElevM: b.minElevM } : {}),
            ...(b.maxElevM !== undefined ? { maxElevM: b.maxElevM } : {}),
          })),
        }
        : {}),
      ...(c.terrain.seaLevelM !== undefined ? { seaLevelM: c.terrain.seaLevelM } : {}),
    },
  };
  if (c.climate !== undefined) {
    out.climate = {
      latitude: c.climate.latitude,
      season: c.climate.season,
      moisture01: c.climate.moisture01,
      ...(c.climate.tempBiasC !== undefined ? { tempBiasC: c.climate.tempBiasC } : {}),
      ...(c.climate.precipBiasMm !== undefined ? { precipBiasMm: c.climate.precipBiasMm } : {}),
    };
  }
  if (c.atmosphere !== undefined) {
    const a = c.atmosphere;
    out.atmosphere = {
      sky: a.sky,
      grade: {
        tonemap: a.grade.tonemap,
        ...(a.grade.lut !== undefined ? { lut: a.grade.lut } : {}),
        exposure: a.grade.exposure,
      },
      effects: {
        volumetrics: a.effects.volumetrics,
        gi: a.effects.gi,
        bloom01: a.effects.bloom01,
        dof: a.effects.dof,
      },
      sun: {
        elevationDeg: a.sun.elevationDeg,
        ...(a.sun.azimuthDeg !== undefined ? { azimuthDeg: a.sun.azimuthDeg } : {}),
        ...(a.sun.timeOfDay !== undefined ? { timeOfDay: a.sun.timeOfDay } : {}),
      },
      fog: {
        density01: a.fog.density01,
        ...(a.fog.heightM !== undefined ? { heightM: a.fog.heightM } : {}),
        ...(a.fog.colorHex !== undefined ? { colorHex: a.fog.colorHex } : {}),
      },
    };
  }
  if (c.water !== undefined) {
    const w = c.water;
    out.water = {
      style: w.style,
      levelM: w.levelM,
      ...(w.colorHex !== undefined ? { colorHex: w.colorHex } : {}),
      waves: {
        amplitudeM: w.waves.amplitudeM,
        speed: w.waves.speed,
        scaleM: w.waves.scaleM,
      },
    };
  }
  if (c.vegetation !== undefined) {
    const v = c.vegetation;
    out.vegetation = {
      seed: v.seed,
      density01: v.density01,
      canopy: {
        species: v.canopy.species.map((s) => ({ id: s.id, weight01: s.weight01 })),
        densityPerHa: v.canopy.densityPerHa,
        ageMix01: v.canopy.ageMix01,
      },
      understory: {
        moss01: v.understory.moss01,
        ferns01: v.understory.ferns01,
        shrubs01: v.understory.shrubs01,
        deadfall01: v.understory.deadfall01,
        grassBlades: v.understory.grassBlades,
      },
      light: {
        sunElevationDeg: v.light.sunElevationDeg,
        timeOfDay: v.light.timeOfDay,
        mist01: v.light.mist01,
      },
    };
  }
  return out;
}

export function canonicalizeWorldConfig(c: WorldConfig): WorldConfig {
  return canonicalWorldConfig(c);
}

export function serializeWorldConfig(c: WorldConfig): string {
  return JSON.stringify(canonicalWorldConfig(c));
}

export const DEFAULT_WORLD_CONFIG: WorldConfig = {
  version: 1,
  seed: 1073741849,
  region: {
    center: [0, 0],
    extentM: 8192,
    tileSizeM: 256,
    lod: 0,
  },
  terrain: {
    type: "hills",
    erosion: {
      rain: 1,
      thermal: 12,
      talus: 0.012,
    },
    reliefAmp: 0.8,
    groundMaterials: [
      { material: "grass", maxSlope01: 0.35 },
      { material: "rock", minSlope01: 0.35 },
      { material: "snow", minElevM: 900 },
    ],
    seaLevelM: 0,
  },
  climate: {
    latitude: 61.5,
    season: "autumn",
    moisture01: 0.78,
    tempBiasC: 2,
    precipBiasMm: -1850,
  },
  atmosphere: {
    sky: "hillaire",
    grade: {
      tonemap: "aces",
      exposure: 1.0,
    },
    effects: {
      volumetrics: true,
      gi: "probes",
      bloom01: 0.22,
      dof: true,
    },
    sun: {
      elevationDeg: 18,
      azimuthDeg: 135,
      timeOfDay: 9.5,
    },
    fog: {
      density01: 0.12,
      heightM: 40,
      colorHex: "#b9c4cc",
    },
  },
  water: {
    style: "stylized",
    levelM: 0,
    colorHex: "#2c5a6e",
    waves: {
      amplitudeM: 0.15,
      speed: 0.6,
      scaleM: 12,
    },
  },
  vegetation: {
    seed: 1073741849,
    density01: 0.7,
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
  },
};
