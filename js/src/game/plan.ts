// ARCHITECTURE PLAN (M4) — the Stage-2 artifact. A deterministic transform of the GDS into a
// buildable plan: each mechanic mapped to an EXISTING engine skill (or flagged NEW/unknown via the
// authoritative registry catalog), the content manifest carried forward, and the milestone slices
// derived — Slice 0 always being the playable loop (the substrate's "playable-loop-first" rule).
//
// Like the GDS it is TS + Zod (one source of truth, JSON-Schema-emittable for llmff validate_json).
// Planning here is structural + deterministic; an LLM may later enrich it, but the mapping/slicing
// that the coordinator depends on is reproducible and testable.

import { z } from "../../build/zod.bundle.mjs";
import { ContentItemSchema, type GameDesignSpec } from "./gds.ts";

export const SystemMappingSchema = z.object({
  mechanicId: z.string().min(1),
  mechanicName: z.string().min(1),
  /** The skill that implements it (e.g. "player.move"), or "NEW:<desc>". */
  skill: z.string().min(1),
  /** existing → a registered engine skill covers it; new → explicitly NEW:…; unknown → names a
   *  skill that does not exist (a planning gap the coordinator must resolve). */
  status: z.enum(["existing", "new", "unknown"]),
});

export const SliceSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  goal: z.string().min(1),
  /** The GDS DoD ids this slice is gated by (empty → not auto-gated, e.g. a content slice). */
  dodIds: z.array(z.string().min(1)).default([]),
});

export const ArchitecturePlanSchema = z.object({
  gdsId: z.string().min(1),
  optIn: z.enum(["direct-path", "record+export", "multiplayer"]),
  systems: z.array(SystemMappingSchema).default([]),
  contentManifest: z.array(ContentItemSchema).default([]),
  slices: z.array(SliceSchema).min(1),
  /** The genuinely-new work: mechanics whose skill is NEW or unknown. */
  newWork: z.array(z.string().min(1)).default([]),
});

export type SystemMapping = z.infer<typeof SystemMappingSchema>;
export type Slice = z.infer<typeof SliceSchema>;
export type ArchitecturePlan = z.infer<typeof ArchitecturePlanSchema>;

/** Map each mechanic to an existing skill (or flag it), derive slices (Slice 0 = playable loop),
 *  and carry the content manifest. `knownSkill` is the authoritative catalog check (registry.has).
 *  The result is validated against ArchitecturePlanSchema before return. */
export function planFromGDS(gds: GameDesignSpec, knownSkill: (name: string) => boolean): ArchitecturePlan {
  const systems: SystemMapping[] = gds.mechanics.map((m) => {
    let status: SystemMapping["status"];
    if (m.skill.startsWith("NEW:")) status = "new";
    else status = knownSkill(m.skill) ? "existing" : "unknown";
    return { mechanicId: m.id, mechanicName: m.name, skill: m.skill, status };
  });

  const newWork = systems
    .filter((s) => s.status !== "existing")
    .map((s) => `${s.mechanicName} → ${s.skill} (${s.status})`);

  // Slice 0 — the playable loop — is gated by every automated (state-transition) DoD. A game with
  // content gets a follow-on content slice (not auto-gated; sourced/placed by the asset pipeline).
  const automatedDodIds = gds.dod.filter((d) => d.kind === "state-transition").map((d) => d.id);
  const slices: Slice[] = [
    { id: "slice-0", name: "Playable loop", goal: gds.loopSentence, dodIds: automatedDodIds },
  ];
  if (gds.content.length > 0) {
    slices.push({ id: "slice-content", name: "Content", goal: "Source + place the content manifest", dodIds: [] });
  }

  return ArchitecturePlanSchema.parse({
    gdsId: gds.id,
    optIn: gds.optIn,
    systems,
    contentManifest: gds.content,
    slices,
    newWork,
  });
}
