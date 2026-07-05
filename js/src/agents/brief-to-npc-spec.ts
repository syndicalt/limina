// briefToNpcSpec — the REALIZER that turns a declarative CharacterBrief (game/character-brief.ts) into the
// durable NpcSpec the engine runs (agents/npc.ts). The character parallel to skills/building-recipe.ts's
// briefToRecipe: the build agent authors/edits the BRIEF, and this pure, deterministic mapping realizes it.
//
//   const spec = briefToNpcSpec(VILLAGER_BRIEF);   // → NpcSpec (validated through npcSpecSchema)
//
// The brief's reasoning `tier` selects the brain + cadence (reasoning-LOD); persona voice + disposition
// compose the NpcSpec system-prompt head; goals ride through; appearance.outfitPalette becomes the body
// tint. DETERMINISTIC: no Date / Math.random, so replay + the p95 gate reproduce identical specs.

import { npcSpecSchema, NPC_BUNDLE_PROFILE, type NpcSpec } from "./npc.ts";
import {
  type CharacterBrief,
  type Disposition,
  type ReasoningTier,
} from "../game/character-brief.ts";
import { type PaletteRole } from "../game/design-direction.ts";

/** Reasoning-LOD: the brief tier → (brain provider/model, decision cadence in ticks). Ambient crowd runs
 *  the deterministic scripted brain; functional/named reason on a local model, named ticked more often. */
const TIER_BRAIN: Record<ReasoningTier, { provider: string; model: string; cadence: number }> = {
  ambient: { provider: "scripted", model: "", cadence: 120 },
  functional: { provider: "ollama", model: "qwen2.5:7b", cadence: 30 },
  named: { provider: "ollama", model: "qwen2.5:7b", cadence: 15 },
};

/** A short behavioural cue appended to the voice so the system prompt carries the disposition. */
const DISPOSITION_CUE: Record<Disposition, string> = {
  friendly: "Speak warmly and openly.",
  wary: "Speak guardedly; watch strangers.",
  gruff: "Speak curtly, with little patience.",
  cheerful: "Speak brightly and eagerly.",
  dutiful: "Speak plainly and to your duty.",
};

/** Deterministic outfit tint from a DesignDirection palette role (a fixed role→hue table; no DD instance
 *  needed at spec time). Applied to the skinned character body's clothing material. */
const OUTFIT_HEX: Record<PaletteRole, number> = {
  stone: 0x8a8378, wood: 0x6b4f33, foliage: 0x4c6a3a, ground: 0x5a4a35, water: 0x3a6b8a,
  metal: 0x8a8f98, accent: 0xa8432f, trim: 0x5a4a30, skin: 0xcaa07a, sky: 0x8fb0c8, slate: 0x3f4650,
};

/** Compose the NpcSpec persona voice: the brief voice + a disposition cue. buildNpcSystemPrompt turns this
 *  (plus goals) into the full prompt. */
export function composeVoice(brief: CharacterBrief): string {
  const cue = DISPOSITION_CUE[brief.persona.disposition];
  return cue ? `${brief.persona.voice} ${cue}` : brief.persona.voice;
}

/** Realize a CharacterBrief into a validated NpcSpec. `index` disambiguates multiple instances of the
 *  same archetype (stable agent ids). Throws (via npcSpecSchema.parse) if the mapping produces an invalid
 *  spec — the same fail-loud discipline briefToRecipe uses. */
export function briefToNpcSpec(brief: CharacterBrief, index = 0): NpcSpec {
  const t = TIER_BRAIN[brief.tier];
  const spawn = brief.spawn?.plot !== undefined
    ? { plot: brief.spawn.plot }
    : brief.spawn?.role !== undefined
      ? { role: brief.spawn.role }
      : { role: brief.role };
  const outfit = brief.appearance.outfitPalette;
  return npcSpecSchema.parse({
    id: `agt_${brief.id.replace(/[^a-z0-9]+/gi, "_")}_${index}`,
    persona: { name: brief.name, voice: composeVoice(brief) },
    spawn,
    perceptionRadius: brief.perceptionRadius,
    actionProfile: NPC_BUNDLE_PROFILE,
    goals: brief.persona.goals,
    model: { provider: t.provider, model: t.model },
    cadence: t.cadence,
    ...(outfit !== undefined ? { color: OUTFIT_HEX[outfit] } : {}),
  });
}
