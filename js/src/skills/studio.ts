// studio.suggest — the co-authoring agent's suggestion channel (fluid agents).
// A suggestion mutates NO world state: the record is the traced event plus the
// returned suggestion object, which the studio host renders as an inline card in
// the active surface. Accepting a suggestion routes its optional action through
// the NORMAL skill path (recorded, policy-gated) — the suggestion itself is
// inert by construction.
//
// Effect "read": the recorder does not log suggestions as mutations, and the
// trace event IS the durable record (traced like every agent action).

import { z } from "../../build/zod.bundle.mjs";
import type { SkillDefinition, SkillRegistry } from "./registry.ts";

export const STUDIO_SUGGESTION_EVENT = "studio.suggestion";

const STUDIO_SURFACES = ["atlas", "viewport", "docs", "any"] as const;

const inputSchema = z.object({
  /** One-line summary the card leads with (≤120 chars). */
  title: z.string().min(1).max(120),
  /** Why + what changes if accepted (≤600 chars). */
  detail: z.string().max(600).optional(),
  /** Which surface the suggestion belongs to (the host renders it there). */
  surface: z.enum(STUDIO_SURFACES).default("any"),
  /** Optional one-click action: a REAL registered skill + its input. Validated
   *  at suggestion time so the card never offers a call that cannot parse. */
  action: z.object({
    skill: z.string().min(1),
    input: z.record(z.string(), z.unknown()).default({}),
    label: z.string().max(60).optional(),
  }).optional(),
  /** Optional Atlas region to highlight (world meters, any order corners). */
  region: z.object({
    x0: z.number().finite(),
    z0: z.number().finite(),
    x1: z.number().finite(),
    z1: z.number().finite(),
  }).optional(),
});

const outputSchema = z.object({
  ok: z.literal(true),
  suggestion: z.object({
    id: z.string(),
    title: z.string(),
    detail: z.string().optional(),
    surface: z.enum(STUDIO_SURFACES),
    action: z.object({
      skill: z.string(),
      input: z.record(z.string(), z.unknown()),
      label: z.string().optional(),
    }).optional(),
    region: z.object({
      x0: z.number(),
      z0: z.number(),
      x1: z.number(),
      z1: z.number(),
    }).optional(),
  }),
});

let suggestionSeq = 0;
let hostRegistry: SkillRegistry | undefined;

export const studioSuggestSkill: SkillDefinition<z.infer<typeof inputSchema>, z.infer<typeof outputSchema>> = {
  name: "studio.suggest",
  version: "1.0.0",
  description: "Offer the human an inline suggestion (card) in the studio — inert by itself; acceptance routes the optional action through the normal skill path.",
  category: "agent",
  permissions: ["studio.suggest"],
  effect: "read",
  // Conversational affordance, not catalog flood: the chat agent must see this
  // in its bootstrap tool set to offer suggestions without a search round-trip.
  priority: "core",
  input: inputSchema,
  output: outputSchema,
  handler: (input, ctx) => {
    // The action must name a REAL skill whose schema accepts the input — a card
    // that offers an unparseable call is a broken promise to the human. The
    // registry is captured at registration (handlers receive no registry ref).
    // Tool names reach the model dot-mangled (`world__generateRegion`), so the
    // suggestion's action may carry the encoded form — normalize before lookup.
    let action = input.action;
    if (action !== undefined) {
      const skillName = action.skill.replaceAll("__", ".");
      const def = hostRegistry?.describe(skillName);
      if (def === undefined) throw new Error(`studio.suggest: unknown action skill "${action.skill}"`);
      const parsed = def.input.safeParse(action.input);
      if (!parsed.success) throw new Error(`studio.suggest: action input does not parse for ${skillName}: ${parsed.error.message}`);
      action = { ...action, skill: skillName };
    }
    const region = input.region === undefined ? undefined : {
      x0: Math.min(input.region.x0, input.region.x1),
      z0: Math.min(input.region.z0, input.region.z1),
      x1: Math.max(input.region.x0, input.region.x1),
      z1: Math.max(input.region.z0, input.region.z1),
    };
    suggestionSeq += 1;
    const suggestion = {
      id: `sug_${ctx.tick.toString(36)}_${suggestionSeq.toString(36)}`,
      title: input.title,
      ...(input.detail !== undefined ? { detail: input.detail } : {}),
      surface: input.surface,
      ...(action !== undefined ? { action } : {}),
      ...(region !== undefined ? { region } : {}),
    };
    ctx.emit(STUDIO_SUGGESTION_EVENT, suggestion);
    return { ok: true as const, suggestion };
  },
};

export function registerStudioSkills(registry: SkillRegistry): void {
  hostRegistry = registry;
  registry.register(studioSuggestSkill);
}
