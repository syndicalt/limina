// CAST -- the project-level player/NPC roster artifact produced by design studios.
//
// Mirrors design-direction.ts / building-brief.ts: a version literal, strict Zod objects,
// deterministic parse/canonicalize/serialize helpers, and semantic validation for roster ids.

import { z } from "../../build/zod.bundle.mjs";
import { ARCHETYPE_NAMES } from "./character-brief.ts";

export const CAST_VERSION = "cast/1" as const;

const ArchetypeSchema = z.union([z.enum(ARCHETYPE_NAMES), z.string().min(1)]);
const BriefSchema = z.record(z.string(), z.unknown());

const PlayerSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  archetype: ArchetypeSchema,
  brief: BriefSchema.optional(),
}).strict();

const NpcSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  archetype: ArchetypeSchema,
  role: z.string().min(1),
  locationId: z.string().min(1).optional(),
  brief: BriefSchema.optional(),
}).strict();

export const CastSchema = z.object({
  version: z.literal(CAST_VERSION),
  player: PlayerSchema,
  npcs: z.array(NpcSchema),
}).strict();

export type Cast = z.infer<typeof CastSchema>;
export type CastPlayer = z.infer<typeof PlayerSchema>;
export type CastNpc = z.infer<typeof NpcSchema>;

export interface CastIssue {
  path: string;
  message: string;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Object.prototype.toString.call(value) === "[object Object]";
}

function canonicalUnknown(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((v) => canonicalUnknown(v));
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) out[key] = canonicalUnknown(value[key]);
    return out;
  }
  return value;
}

function canonicalBrief(brief: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  return brief === undefined ? undefined : canonicalUnknown(brief) as Record<string, unknown>;
}

export function parseCast(json: string): Cast {
  return CastSchema.parse(JSON.parse(json));
}

export function canonicalizeCast(c: Cast): Cast {
  return {
    version: c.version,
    player: {
      id: c.player.id,
      name: c.player.name,
      archetype: c.player.archetype,
      ...(c.player.brief !== undefined ? { brief: canonicalBrief(c.player.brief)! } : {}),
    },
    npcs: c.npcs.map((n) => ({
      id: n.id,
      name: n.name,
      archetype: n.archetype,
      role: n.role,
      ...(n.locationId !== undefined ? { locationId: n.locationId } : {}),
      ...(n.brief !== undefined ? { brief: canonicalBrief(n.brief)! } : {}),
    })),
  };
}

export function serializeCast(c: Cast): string {
  return JSON.stringify(canonicalizeCast(c));
}

export function validateCast(
  input: unknown,
): { ok: boolean; data?: Cast; issues: CastIssue[] } {
  const parsed = CastSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })) };
  }

  const cast = parsed.data;
  const issues: CastIssue[] = [];
  const seen = new Set<string>();
  seen.add(cast.player.id);

  for (const npc of cast.npcs) {
    if (seen.has(npc.id)) issues.push({ path: `npcs.${npc.id}`, message: `duplicate cast id "${npc.id}"` });
    seen.add(npc.id);
  }

  return issues.length === 0 ? { ok: true, data: cast, issues: [] } : { ok: false, data: cast, issues };
}

export const DEFAULT_CAST: Cast = {
  version: CAST_VERSION,
  player: {
    id: "player",
    name: "Warden",
    archetype: "guard",
    brief: {
      role: "frontier warden",
      motive: "keep the signal fire lit and hold the camp together",
    },
  },
  npcs: [
    {
      id: "elder-mara",
      name: "Mara",
      archetype: "elder",
      role: "camp elder",
      locationId: "home",
      brief: {
        voice: "measured and practical",
        concern: "the blight is moving faster than the runners report",
      },
    },
  ],
};
