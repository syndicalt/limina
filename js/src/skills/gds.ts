// gds.plan — the game-director planning stage (Stage 1→2) as a first-class skill, so the
// editor chat agent (and any builder) can turn a Game Design Spec — or a GDD markdown that
// embeds one — into an Architecture Plan through the recorded, permissioned path instead of
// a host-side script.
//
// SEAM / INVARIANT: this is a READ-COMPUTATION skill — `validateGDS` + `parseGdd` +
// `planFromGDS` are pure functions of the input plus registry catalog MEMBERSHIP
// (`registry.has`, the same authoritative check `defaultKnownSkill()` uses). It mutates no
// world state, draws no randomness, and reads no clock, so it is single-invoke atomic by
// construction: there is nothing to undo (`effect: "read"` also keeps it off the world log
// and out of chain capture). Its only side channel is the OBSERVABILITY event
// `director.pipeline.plan.created` emitted through ctx.emit via the D2 PipelineTrace seam —
// trace, not state. No nested registry invokes.

import { z } from "../../build/zod.bundle.mjs";
import type { SkillDefinition, SkillRegistry } from "./registry.ts";
import { SkillInvocationError } from "./registry.ts";
import { validateGDS, type GameDesignSpec, type GdsIssue } from "../game/gds.ts";
import { parseGdd } from "../game/intake.ts";
import { ArchitecturePlanSchema, planFromGDS } from "../game/plan.ts";

const planInput = z.object({
  /** The Game Design Spec object (GameDesignSpecSchema shape). Exactly one of gds/gdd. */
  gds: z.record(z.string(), z.unknown()).optional(),
  /** A GDD markdown document embedding the GDS as a fenced ```json block. */
  gdd: z.string().min(1).optional(),
}).strict();

const issueOutput = z.object({ path: z.string(), message: z.string() });

const planOutput = z.object({
  /** True iff the spec validated and a plan was produced. */
  ok: z.boolean(),
  /** The Architecture Plan (absent when the spec did not validate). */
  plan: ArchitecturePlanSchema.optional(),
  /** Structural + semantic validation issues (empty on ok). */
  issues: z.array(issueOutput),
  /** Gap report: the top-level GDS fields the input is missing/invalid. */
  gaps: z.array(z.string()),
  /** Mechanics whose skill mapping is NEW or unknown — the genuinely-new work. */
  newWork: z.array(z.string()),
});

/** Mirror parseGdd's gap derivation for the direct-GDS path: the distinct top-level
 *  fields the validation issues point at. */
function gapsFromIssues(issues: GdsIssue[]): string[] {
  return [...new Set(issues.map((i) => i.path.split(".")[0] || "(root)"))];
}

export function registerGdsSkills(registry: SkillRegistry): void {
  const planSkill: SkillDefinition<z.infer<typeof planInput>, z.infer<typeof planOutput>> = {
    name: "gds.plan",
    version: "1.0.0",
    description: "Validate a Game Design Spec (object, or GDD markdown embedding one) and derive its Architecture Plan: mechanics mapped to registered engine skills (unknown/NEW flagged), milestone slices with Slice 0 = the playable loop, and a gap report when the spec is incomplete.",
    category: "game",
    permissions: ["game.plan"],
    effect: "read",
    priority: "core",
    input: planInput,
    output: planOutput,
    handler: (input, ctx) => {
      const provided = [input.gds, input.gdd].filter((v) => v !== undefined).length;
      if (provided !== 1) {
        throw new SkillInvocationError("invalid_input", "gds.plan requires exactly one of { gds } (the spec object) or { gdd } (markdown embedding a ```json GDS block)");
      }

      let issues: GdsIssue[];
      let gaps: string[];
      let data: GameDesignSpec | undefined;
      if (input.gdd !== undefined) {
        const parsed = parseGdd(input.gdd);
        issues = parsed.issues;
        gaps = parsed.gaps;
        data = parsed.ok ? parsed.data : undefined;
      } else {
        const v = validateGDS(input.gds);
        issues = v.issues;
        gaps = v.ok ? [] : gapsFromIssues(v.issues);
        data = v.ok ? v.data : undefined;
      }

      if (data === undefined) {
        ctx.emit("director.pipeline.plan.rejected", { issues: issues.length, gaps });
        return { ok: false, issues, gaps, newWork: [] };
      }

      // The D2 observability seam: plan.created rides ctx.emit so the editor's
      // Activity tree chains it under this skill's causal parents.
      const plan = planFromGDS(data, (name) => registry.has(name), {
        emit: (type, payload, causedBy) => ctx.emit(type, payload, causedBy),
      });
      return { ok: true, plan, issues: [], gaps: [], newWork: plan.newWork };
    },
  };

  registry.register(planSkill);
}
