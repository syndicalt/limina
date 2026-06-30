// COORDINATOR (M4) — the Stage-3 spine. Sequences a plan's slices, builds each (via an injected
// SliceBuilder), runs the M3 functional gate after each, and records a ledger. Enforces the
// playable-loop-first rule: it HALTS on the first slice whose gate goes red — nothing downstream
// proceeds until the gate passes.
//
// THE BOUNDARY (per the llmff fit analysis): the coordinator owns the spine, sequencing, gating,
// and ledger. The SliceBuilder is where the real work plugs in — in production it spawns specialist
// agents in git worktrees / calls `llmff run` to produce the slice's code, then hands back a
// GameUnderTest. Here it is injected, so the spine is deterministic and testable without live
// agents (the "build the pipeline generically first" milestone).

import { SkillRegistry } from "../skills/registry.ts";
import { registerCoreSkills } from "../skills/index.ts";
import { LiminaTracer } from "../observability/event.ts";
import { runGate, type GameUnderTest, type GateReport, type RunOptions } from "./gate.ts";
import type { ArchitecturePlan, Slice } from "./plan.ts";
import type { GameDesignSpec } from "./gds.ts";

/** Produce a GameUnderTest for a slice — the seam where specialist agents / llmff plug in. Called
 *  fresh per gate run (a GameUnderTest holds live sim state). */
export type SliceBuilder = (slice: Slice, gds: GameDesignSpec) => GameUnderTest | Promise<GameUnderTest>;

export interface SliceLedgerEntry {
  sliceId: string;
  name: string;
  status: "passed" | "failed" | "skipped";
  /** The gate report for an auto-gated slice (absent for skipped/un-gated slices). */
  gate?: GateReport;
  /** A build/throw error, if the slice failed before/around the gate. */
  error?: string;
}

export interface Ledger {
  gdsId: string;
  entries: SliceLedgerEntry[];
  /** True iff every gated slice passed and no slice errored. */
  passed: boolean;
  /** The slice that halted the run (first failure), if any. */
  haltedAt?: string;
}

/** The authoritative skill catalog: a predicate over the real registered core skills. Build once
 *  and reuse (registering the core set is non-trivial). */
export function defaultKnownSkill(): (name: string) => boolean {
  const registry = new SkillRegistry(new LiminaTracer("ses_skill_catalog"));
  registerCoreSkills(registry);
  return (name: string) => registry.has(name);
}

/** Run the coordinator over a plan: build + gate each slice in order, halting on the first failure.
 *  Returns the ledger (the cross-stage progress record the production run-record is stitched from). */
export async function coordinate(
  gds: GameDesignSpec,
  plan: ArchitecturePlan,
  buildSlice: SliceBuilder,
  opts: RunOptions = {},
): Promise<Ledger> {
  const entries: SliceLedgerEntry[] = [];

  for (const slice of plan.slices) {
    const dods = gds.dod.filter((d) => slice.dodIds.includes(d.id));
    if (dods.length === 0) {
      // An un-gated slice (e.g. content): recorded as skipped by the functional gate (it has no
      // state-transition DoDs to drive). Build is still expected to happen in production.
      entries.push({ sliceId: slice.id, name: slice.name, status: "skipped" });
      continue;
    }

    try {
      // Gate this slice against just its DoDs, building a fresh game per DoD.
      const sliceGds: GameDesignSpec = { ...gds, dod: dods };
      const report = await runGate(sliceGds, () => buildSlice(slice, gds), opts);
      const status: SliceLedgerEntry["status"] = report.passed ? "passed" : "failed";
      entries.push({ sliceId: slice.id, name: slice.name, status, gate: report });
      if (!report.passed) {
        return { gdsId: gds.id, entries, passed: false, haltedAt: slice.id };
      }
    } catch (e) {
      entries.push({
        sliceId: slice.id,
        name: slice.name,
        status: "failed",
        error: e instanceof Error ? e.message : String(e),
      });
      return { gdsId: gds.id, entries, passed: false, haltedAt: slice.id };
    }
  }

  return { gdsId: gds.id, entries, passed: entries.every((e) => e.status !== "failed") };
}
