// CHARACTER BRIEF — the PER-NPC-TYPE build description that comes OUT OF the GDD planning session.
//
// The mirror of game/building-brief.ts, for the settlement's PEOPLE instead of its structures. The
// project-level DesignDirection (design-direction.ts) governs ONE palette / style envelope for the whole
// game; a guard is not a priest is not a child. That per-TYPE character direction lives here, authored
// during GDD planning (the director intake stage fills a brief per NPC content item) and CONSUMED by the
// build agent + `briefToNpcSpec`, which turns it into the durable NpcSpec the engine already runs.
//
// A brief is DECLARATIVE CHARACTER DIRECTION, not a rig: it says "a gruff gate guard, dutiful, watches the
// gate, mail-clad, reasons at a functional cadence". `briefToNpcSpec` maps that to the NpcSpec (persona
// system prompt + reasoning tier + body binding); the build agent authors/edits the BRIEF, never a bespoke
// NpcSpec by hand. NPC bodies are REAL rigged humanoid ASSETS resolved through the Character AssetSource
// (world/character-body.ts) — the procedural spawnHumanoid is retired for NPCs; `appearance` here only
// selects/varies that real body (bodyAssetId + outfit/skin tint), it never describes geometry.
//
// UNIVERSAL vs PER-TYPE — the two-level split, exactly as building-brief.ts:
//   • CHARACTER_CRAFT_PRINCIPLES below = UNIVERSAL NPC discipline (bounded perception, least privilege,
//     recorded-action determinism, in-character voice, reasoning-LOD). They hold for EVERY NPC and are
//     enforced by the reasoning-engine gates — NOT re-authored per game.
//   • A CharacterBrief = PER-TYPE direction, authored per game in the planning session (a villager vs a priest).
//
// Follows design-direction.ts / building-brief.ts EXACTLY: a `version` literal, `.strict()` sub-objects,
// parse/validate + library consts, deterministic (no Date / Math.random) so it is replay-safe and its JSON
// Schema (via z.toJSONSchema) can gate the brief at the pipeline boundary.

import { z } from "../../build/zod.bundle.mjs";
import { PALETTE_ROLE_NAMES, type PaletteRole } from "./design-direction.ts";

// ── Universal NPC craft principles — the reasoning-NPC DISCIPLINE (not per-game) ────────────────────
// Each principle is (id, statement, realizedBy, gatedBy): the STATEMENT the NPC engine must honour, HOW it
// is realized, and HOW a gate falsifies a violation. Encoded as data (not prose) so the build agent reads
// them and gates reference them by id. The character parallel to BUILDING_CRAFT_PRINCIPLES.
export interface CraftPrinciple {
  id: string;
  statement: string;
  realizedBy: string;
  gatedBy: string;
}

export const CHARACTER_CRAFT_PRINCIPLES: readonly CraftPrinciple[] = [
  {
    id: "perception-bounded",
    statement:
      "An NPC perceives ONLY the entities + recent events within its perception radius (plus the world log) — never omniscient. Its reasoning sees a bounded, legible view, not the whole scene graph.",
    realizedBy: "agents/systems.ts perceptionSystem gathers nearby entities within perceptionRadius; the model only ever sees that snapshot.",
    gatedBy: "p14_npc / p81_npc_determinism assert the perception snapshot is radius-bounded and stable.",
  },
  {
    id: "least-privilege-action",
    statement:
      "An NPC may invoke ONLY its action bundle (move / speak / gesture); malformed, hallucinated, or out-of-scope skill calls are rejected before they execute.",
    realizedBy: "the npc.bundle profile (NPC_ACTION_BUNDLE) governs BOTH what the model sees (registry.list) and what it may invoke; decisionSystem validates candidates before actionSystem runs them.",
    gatedBy: "p81/m13 record 0 malformed executed calls; a bad candidate is dropped, not run.",
  },
  {
    id: "action-determinism",
    statement:
      "Reasoning is non-deterministic, but the skill CALLS an NPC emits are recorded to the world log, so the world replays bit-identically from the recorded action stream (the LLM is a logged 'player', never re-run on replay).",
    realizedBy: "every executed call flows through registry.invoke → the WorldRecorder; replay re-applies the recorded calls without the model.",
    gatedBy: "p81_npc_determinism replays byte-identical WITHOUT the model; perturbing the stream falsifies it.",
  },
  {
    id: "in-character-voice",
    statement:
      "Dialogue and behaviour stay inside the character's persona voice + disposition — a gruff guard does not chatter like a cheerful vendor.",
    realizedBy: "briefToNpcSpec composes persona.voice + disposition + goals into the NpcSpec system prompt (buildNpcSystemPrompt).",
    gatedBy: "m13_npc_ollama smoke: per-persona in-character dialogue under a live model.",
  },
  {
    id: "reasoning-lod",
    statement:
      "Cost scales with importance: an NPC is ticked at its tier's cadence (ambient crowd slow + scripted, named characters fast + reasoning) — never LLM-tick every NPC every frame.",
    realizedBy: "the brief's tier maps to model + cadence (decisionIntervalTicks); the AgentScheduler round-robins under per-tick budgets + timeouts.",
    gatedBy: "p3_scheduler_density / p3_scheduler_timeout hold the budget + timeout envelope.",
  },
] as const;

// ── Enums the brief is built from (closed sets — the planner picks from these) ──────────────────────

/** The NPC KIND — drives the default body asset, action bundle emphasis, and typical tier. */
export const ARCHETYPE_NAMES = ["villager", "guard", "vendor", "elder", "laborer", "child", "priest"] as const;
export type Archetype = (typeof ARCHETYPE_NAMES)[number];

/** The character's temperament — flavours the persona voice + dialogue register. */
export const DISPOSITION_NAMES = ["friendly", "wary", "gruff", "cheerful", "dutiful"] as const;
export type Disposition = (typeof DISPOSITION_NAMES)[number];

/** The ambient movement pattern the body plays when not reasoning toward a goal. */
export const ROUTINE_NAMES = ["wander", "tend-post", "patrol", "idle-social"] as const;
export type Routine = (typeof ROUTINE_NAMES)[number];

/** Reasoning-LOD tier — selects the brain + cadence. ambient = scripted crowd (npc_runtime); functional =
 *  a local model at a modest cadence; named = a local model ticked more often for important characters. */
export const REASONING_TIER = ["ambient", "functional", "named"] as const;
export type ReasoningTier = (typeof REASONING_TIER)[number];

// ── The brief schema ────────────────────────────────────────────────────────────────────────────────

const PaletteRoleEnum = z.enum(PALETTE_ROLE_NAMES);

/** Real-body selection + parametric variation. The body itself is a rigged humanoid ASSET from the
 *  Character AssetSource; this only picks WHICH asset (or the archetype default) and tints outfit/skin. */
const AppearanceSchema = z.object({
  /** Rigged humanoid GLB id from the Character AssetSource. Omitted → the archetype's default body. */
  bodyAssetId: z.string().optional(),
  /** Clothing tint, a DesignDirection palette role (material swap on the skinned mesh). */
  outfitPalette: PaletteRoleEnum.optional(),
  /** Parametric skin variation, 0 = light .. 1 = dark. */
  skinTone01: z.number().min(0).max(1).optional(),
}).strict();

export const CharacterBriefSchema = z.object({
  version: z.literal(1),
  /** Dotted archetype id matching the character library (e.g. "characters.medieval.villager.miller"). */
  id: z.string().min(1),
  name: z.string().min(1),
  archetype: z.enum(ARCHETYPE_NAMES),
  /** The concrete role within the archetype ("miller", "gate guard", "parish priest"). */
  role: z.string().min(1),
  persona: z.object({
    /** The character voice — becomes the head of the NpcSpec system prompt. */
    voice: z.string().min(1),
    disposition: z.enum(DISPOSITION_NAMES).default("friendly"),
    /** Short goal lines woven into the prompt (functional/named tiers; ignored by the ambient scripted brain). */
    goals: z.array(z.string()).max(6).default([]),
  }).strict(),
  tier: z.enum(REASONING_TIER).default("functional"),
  routine: z.enum(ROUTINE_NAMES).default("idle-social"),
  /** Where the NPC spawns. Omitted → placed by the settlement spawner from `role`. */
  spawn: z.object({ role: z.string().optional(), plot: z.number().int().nonnegative().optional() }).strict().optional(),
  appearance: AppearanceSchema.default({}),
  /** Perception radius (world units) the engine surfaces nearby entities within. */
  perceptionRadius: z.number().positive().max(60).default(18),
  /** Prose escape hatch for nuance the structured fields can't carry (the build agent reads it). */
  notes: z.string().optional(),
}).strict();

export type Appearance = z.infer<typeof AppearanceSchema>;
export type CharacterBrief = z.infer<typeof CharacterBriefSchema>;

export function parseCharacterBrief(json: string): CharacterBrief {
  return CharacterBriefSchema.parse(JSON.parse(json));
}

// ── Semantic validation (beyond structure) ──────────────────────────────────────────────────────────
export interface CharacterBriefIssue {
  path: string;
  message: string;
}

/** Structural parse THEN cross-field checks. When `paletteRoles` is supplied (the active DD's palette),
 *  an `outfitPalette` must name a role that palette defines — the same referential-integrity discipline
 *  building-brief.ts/design-direction.ts use. Returns the parsed brief when valid, else a flat issue list. */
export function validateCharacterBrief(
  input: unknown,
  paletteRoles?: readonly PaletteRole[],
): { ok: boolean; data?: CharacterBrief; issues: CharacterBriefIssue[] } {
  const parsed = CharacterBriefSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })) };
  }
  const brief = parsed.data;
  const issues: CharacterBriefIssue[] = [];

  if (paletteRoles !== undefined && brief.appearance.outfitPalette !== undefined) {
    const have = new Set<string>(paletteRoles);
    if (!have.has(brief.appearance.outfitPalette)) {
      issues.push({ path: "appearance.outfitPalette", message: `outfit tints with role "${brief.appearance.outfitPalette}" which the design direction's palette does not define` });
    }
  }

  // reasoning-LOD: an ambient NPC runs the SCRIPTED brain, which ignores goals — flag goals as dead weight.
  // (Kept as an issue so a strict gate can treat it as a fail; briefToNpcSpec still builds it.)
  if (brief.tier === "ambient" && brief.persona.goals.length > 0) {
    issues.push({ path: "persona.goals", message: "ambient tier runs the scripted brain and ignores goals; use functional/named for goal-driven NPCs" });
  }

  return issues.length === 0 ? { ok: true, data: brief, issues: [] } : { ok: false, data: brief, issues };
}

// ── Canonicalization (byte-stable clone, mirrors building-brief.ts) ───────────────────────────────────
export function canonicalizeCharacterBrief(b: CharacterBrief): CharacterBrief {
  const appearance: Appearance = {
    ...(b.appearance.bodyAssetId !== undefined ? { bodyAssetId: b.appearance.bodyAssetId } : {}),
    ...(b.appearance.outfitPalette !== undefined ? { outfitPalette: b.appearance.outfitPalette } : {}),
    ...(b.appearance.skinTone01 !== undefined ? { skinTone01: b.appearance.skinTone01 } : {}),
  };
  return {
    version: b.version,
    id: b.id,
    name: b.name,
    archetype: b.archetype,
    role: b.role,
    persona: { voice: b.persona.voice, disposition: b.persona.disposition, goals: [...b.persona.goals] },
    tier: b.tier,
    routine: b.routine,
    ...(b.spawn !== undefined ? { spawn: { ...(b.spawn.role !== undefined ? { role: b.spawn.role } : {}), ...(b.spawn.plot !== undefined ? { plot: b.spawn.plot } : {}) } } : {}),
    appearance,
    perceptionRadius: b.perceptionRadius,
    ...(b.notes !== undefined ? { notes: b.notes } : {}),
  };
}

export function serializeCharacterBrief(b: CharacterBrief): string {
  return JSON.stringify(canonicalizeCharacterBrief(b));
}

/** Emit the JSON Schema for a character brief so llmff's validate_json stage can gate it at the pipeline
 *  boundary (same pattern as building-brief.ts / gds.ts). Deterministic; no external dependency. */
export function characterBriefJsonSchema(): Record<string, unknown> {
  const toJSONSchema = (z as unknown as {
    toJSONSchema: (s: unknown, o?: Record<string, unknown>) => Record<string, unknown>;
  }).toJSONSchema;
  return toJSONSchema(CharacterBriefSchema, { unrepresentable: "any", target: "draft-7" });
}

// ── The starter archetype LIBRARY — reusable briefs GDD planning selects + customizes ────────────────
// One brief per NPC archetype, keyed to dotted character ids. GDD planning picks the archetypes a game
// needs and tweaks them; it does NOT re-derive a villager from scratch every game. Outfit roles reference
// the shipped DEFAULT_DESIGN_DIRECTION palette. Bodies default to the archetype's Character AssetSource
// entry (bodyAssetId omitted → resolved by world/character-body.ts).

/** A common VILLAGER (miller/farmer): functional reasoning, wanders + chats, earthy tunic. */
export const VILLAGER_BRIEF: CharacterBrief = {
  version: 1,
  id: "characters.medieval.villager.commoner",
  name: "Villager",
  archetype: "villager",
  role: "villager",
  persona: { voice: "A plain-spoken villager who works the land and knows everyone's business.", disposition: "friendly", goals: ["go about the day's work", "greet neighbours on the lane"] },
  tier: "functional",
  routine: "wander",
  appearance: { outfitPalette: "wood" },
  perceptionRadius: 18,
  notes: "Homespun tunic; unhurried gait; comfortable stopping to talk.",
};

/** A GATE GUARD: dutiful, holds a post / patrols, mail-clad, wary of strangers. */
export const GUARD_BRIEF: CharacterBrief = {
  version: 1,
  id: "characters.medieval.guard.gate",
  name: "Gate guard",
  archetype: "guard",
  role: "gate guard",
  persona: { voice: "A watchful gate guard, terse and dutiful, quick to challenge an unfamiliar face.", disposition: "dutiful", goals: ["watch the approach", "challenge strangers", "keep the peace"] },
  tier: "functional",
  routine: "patrol",
  appearance: { outfitPalette: "metal" },
  perceptionRadius: 24,
  notes: "Mail + tabard; stands square; short clipped speech.",
};

/** A market VENDOR: cheerful, tends a stall, colourful dress, keen to trade. */
export const VENDOR_BRIEF: CharacterBrief = {
  version: 1,
  id: "characters.medieval.vendor.market",
  name: "Market vendor",
  archetype: "vendor",
  role: "market vendor",
  persona: { voice: "A cheerful market trader, always ready with a greeting and a price.", disposition: "cheerful", goals: ["draw custom to the stall", "haggle a fair price"] },
  tier: "functional",
  routine: "tend-post",
  appearance: { outfitPalette: "accent" },
  perceptionRadius: 18,
  notes: "Brighter dyed cloth; animated hands; stays near the stall.",
};

/** A village ELDER: named-tier, gruff-wise, holds court, muted grey dress. */
export const ELDER_BRIEF: CharacterBrief = {
  version: 1,
  id: "characters.medieval.elder.reeve",
  name: "Village elder",
  archetype: "elder",
  role: "reeve",
  persona: { voice: "The village reeve — slow, weighty speech, long memory, little patience for foolishness.", disposition: "gruff", goals: ["counsel the village", "settle disputes", "recall how things were done"] },
  tier: "named",
  routine: "idle-social",
  appearance: { outfitPalette: "stone", skinTone01: 0.55 },
  perceptionRadius: 20,
  notes: "Plain grey robe; leans on a staff; stationary, others come to them.",
};

/** A LABORER: functional, roams to work, plain earthy dress. */
export const LABORER_BRIEF: CharacterBrief = {
  version: 1,
  id: "characters.medieval.laborer.hand",
  name: "Laborer",
  archetype: "laborer",
  role: "field hand",
  persona: { voice: "A weathered field hand, few words, glad of a rest and a jug at day's end.", disposition: "friendly", goals: ["haul and mend", "rest when the work's done"] },
  tier: "functional",
  routine: "wander",
  appearance: { outfitPalette: "ground" },
  perceptionRadius: 16,
  notes: "Rough undyed cloth; heavy tread.",
};

/** A CHILD: ambient (scripted) crowd, darts about, small scale. Goals empty — the ambient brain ignores them. */
export const CHILD_BRIEF: CharacterBrief = {
  version: 1,
  id: "characters.medieval.child.villager",
  name: "Village child",
  archetype: "child",
  role: "child",
  persona: { voice: "A village child, all energy, underfoot and curious.", disposition: "cheerful", goals: [] },
  tier: "ambient",
  routine: "wander",
  appearance: { outfitPalette: "wood", skinTone01: 0.4 },
  perceptionRadius: 12,
  notes: "Smaller body scale; quick darting movement; ambient-only, no dialogue depth.",
};

/** A parish PRIEST: named-tier, dutiful-calm, keeps the church, dark robes. */
export const PRIEST_BRIEF: CharacterBrief = {
  version: 1,
  id: "characters.medieval.priest.parish",
  name: "Parish priest",
  archetype: "priest",
  role: "parish priest",
  persona: { voice: "The parish priest — measured, kindly, given to a blessing and a gentle admonishment.", disposition: "dutiful", goals: ["tend the flock", "keep the church", "offer counsel"] },
  tier: "named",
  routine: "idle-social",
  appearance: { outfitPalette: "slate" },
  perceptionRadius: 22,
  notes: "Long dark robe; unhurried; lingers near the church door.",
};

/** The shipped library, keyed by archetype id. GDD planning selects + customizes. */
export const CHARACTER_ARCHETYPES: Readonly<Record<string, CharacterBrief>> = {
  [VILLAGER_BRIEF.id]: VILLAGER_BRIEF,
  [GUARD_BRIEF.id]: GUARD_BRIEF,
  [VENDOR_BRIEF.id]: VENDOR_BRIEF,
  [ELDER_BRIEF.id]: ELDER_BRIEF,
  [LABORER_BRIEF.id]: LABORER_BRIEF,
  [CHILD_BRIEF.id]: CHILD_BRIEF,
  [PRIEST_BRIEF.id]: PRIEST_BRIEF,
};

/** Look up a shipped archetype brief by dotted id (undefined if the game authors its own). */
export function archetypeCharacterBrief(id: string): CharacterBrief | undefined {
  return CHARACTER_ARCHETYPES[id];
}
