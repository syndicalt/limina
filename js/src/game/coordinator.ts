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
import type { ArchitecturePlan, PipelineTrace, Slice } from "./plan.ts";
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

/** Summarize a GateReport for the `director.pipeline.gate.report` event: totals plus the
 *  per-DoD failures (id, statement, failure messages) — the detail that used to live only
 *  in the returned ledger. */
function gateReportPayload(sliceId: string, report: GateReport): Record<string, unknown> {
  return {
    sliceId,
    passed: report.passed,
    automatedPassed: report.automatedPassed,
    automatedTotal: report.automatedTotal,
    failures: report.results
      .filter((r) => r.status === "failed")
      .map((r) => ({ id: r.id, statement: r.statement, failures: r.failures })),
  };
}

/** Run the coordinator over a plan: build + gate each slice in order, halting on the first failure.
 *  Returns the ledger (the cross-stage progress record the production run-record is stitched from).
 *  `trace` (optional, additive; return value unchanged) emits the `director.pipeline.*` run events —
 *  slice.started / gate.report / slice.failed (the previously-swallowed error string) /
 *  run.halted | run.passed — each causally chained to its predecessor (seeded from
 *  `trace.causedBy`, e.g. the plan.created event id) so the editor renders the run as ONE tree. */
export async function coordinate(
  gds: GameDesignSpec,
  plan: ArchitecturePlan,
  buildSlice: SliceBuilder,
  opts: RunOptions = {},
  trace?: PipelineTrace,
): Promise<Ledger> {
  const entries: SliceLedgerEntry[] = [];
  let prev: string[] | undefined = trace?.causedBy;
  const emit = (type: string, payload: unknown): void => {
    if (trace === undefined) return;
    prev = [trace.emit(type, payload, prev)];
  };

  for (const slice of plan.slices) {
    const dods = gds.dod.filter((d) => slice.dodIds.includes(d.id));
    emit("director.pipeline.slice.started", { gdsId: gds.id, sliceId: slice.id, name: slice.name, goal: slice.goal, dodIds: slice.dodIds, gated: dods.length > 0 });
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
      emit("director.pipeline.gate.report", gateReportPayload(slice.id, report));
      if (!report.passed) {
        emit("director.pipeline.run.halted", { gdsId: gds.id, haltedAt: slice.id, reason: "gate_failed" });
        return { gdsId: gds.id, entries, passed: false, haltedAt: slice.id };
      }
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      entries.push({ sliceId: slice.id, name: slice.name, status: "failed", error });
      emit("director.pipeline.slice.failed", { gdsId: gds.id, sliceId: slice.id, error });
      emit("director.pipeline.run.halted", { gdsId: gds.id, haltedAt: slice.id, reason: "build_error" });
      return { gdsId: gds.id, entries, passed: false, haltedAt: slice.id };
    }
  }

  const passed = entries.every((e) => e.status !== "failed");
  emit(passed ? "director.pipeline.run.passed" : "director.pipeline.run.halted", { gdsId: gds.id, slices: entries.length });
  return { gdsId: gds.id, entries, passed };
}
