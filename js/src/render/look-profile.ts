import { z } from "../../build/zod.bundle.mjs";

const UnitInterval = z.number().min(0).max(1);

export const LookProfileSchema = z.object({
  id: z.string().min(1),
  shading: z.enum(["pbr", "toon", "flat"]),
  sky: z.enum(["hillaire", "gradient", "painted"]),
  grade: z.object({
    tonemap: z.enum(["aces", "filmic", "lut"]),
    lut: z.string().optional(),
    exposure: z.number(),
  }).strict(),
  effects: z.object({
    volumetrics: z.boolean(),
    gi: z.enum(["probes", "flat"]),
    bloom01: UnitInterval,
    dof: z.boolean(),
  }).strict(),
  referenceFrames: z.array(z.string()),
}).strict();

export type LookProfile = z.infer<typeof LookProfileSchema>;

export type ResolvedLook = {
  shading: LookProfile["shading"];
  sky: LookProfile["sky"];
  tonemap: LookProfile["grade"]["tonemap"];
  volumetrics: LookProfile["effects"]["volumetrics"];
  gi: LookProfile["effects"]["gi"];
  bloom01: LookProfile["effects"]["bloom01"];
  dof: LookProfile["effects"]["dof"];
  exposure: LookProfile["grade"]["exposure"];
};

export function parseLookProfile(json: string): LookProfile {
  return LookProfileSchema.parse(JSON.parse(json));
}

function canonicalLookProfile(p: LookProfile): LookProfile {
  return {
    id: p.id,
    shading: p.shading,
    sky: p.sky,
    grade: {
      tonemap: p.grade.tonemap,
      lut: p.grade.lut,
      exposure: p.grade.exposure,
    },
    effects: {
      volumetrics: p.effects.volumetrics,
      gi: p.effects.gi,
      bloom01: p.effects.bloom01,
      dof: p.effects.dof,
    },
    referenceFrames: p.referenceFrames.map((frame) => frame),
  };
}

export function serializeLookProfile(p: LookProfile): string {
  return JSON.stringify(canonicalLookProfile(p));
}

export const LAAS_PHOTOREAL: LookProfile = {
  id: "laas-photoreal",
  shading: "pbr",
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
  referenceFrames: [],
};

export function resolveLook(p: LookProfile): ResolvedLook {
  return {
    shading: p.shading,
    sky: p.sky,
    tonemap: p.grade.tonemap,
    volumetrics: p.effects.volumetrics,
    gi: p.effects.gi,
    bloom01: p.effects.bloom01,
    dof: p.effects.dof,
    exposure: p.grade.exposure,
  };
}
