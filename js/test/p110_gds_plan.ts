// P110 — gds.plan SKILL (Chunk D, Slice D3). The game-director planning stage as a typed,
// permissioned, read-computation skill: GDS object OR GDD markdown in; {plan, issues, gaps,
// newWork} out; `director.pipeline.plan.created` emitted through the D2 trace seam.
//
// Proves: schema round-trip (the returned plan validates against ArchitecturePlanSchema and
// matches the direct planFromGDS output), the gap report on a broken GDS, the GDD-markdown
// path, deterministic re-invocation, and FALSIFIABILITY — the skill rejects both/neither
// input forms and a read-only profile lacking `game.plan` is denied (the permission string is
// enforced, not decorative).
//
// Run: LIMINA_AUDIO=null ./target/release/limina js/test/p110_gds_plan.ts

import { ops } from "../src/engine.ts";
import { createHeadlessContext } from "../src/game/index.ts";
import { planFromGDS, ArchitecturePlanSchema, type ArchitecturePlan } from "../src/game/plan.ts";
import { resolveProfile } from "../src/skills/permissions.ts";
import { RELIC_SPRINT } from "../src/game/examples/relic_sprint.gds.ts";
import type { GameDesignSpec } from "../src/game/gds.ts";
import type { MCPResponse } from "../src/mcp/protocol.ts";
import type { LiminaTracer } from "../src/observability/event.ts";

let pass = 0;
function assert(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new Error("p110_gds_plan FAIL: " + msg);
  pass++;
}
function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

const ctx = createHeadlessContext({ session: "ses_p110_gds_plan" });
ops.op_physics_create_world(0);

const builderGrants = resolveProfile("builder.readWrite");
function invokePlan(input: unknown, permissions: ReadonlySet<string> = builderGrants): Promise<MCPResponse> {
  return ctx.registry.invoke("gds.plan", input, {
    agentId: "agt_p110",
    sessionId: "ses_p110_gds_plan",
    permissions,
    profile: "builder.readWrite",
    tick: 0,
    world: ctx.world,
  });
}

interface PlanOut {
  ok: boolean;
  plan?: ArchitecturePlan;
  issues: { path: string; message: string }[];
  gaps: string[];
  newWork: string[];
}

// ── 1. Happy path: GDS object → validated plan, byte-equal to the direct planner ─────────
{
  const res = await invokePlan({ gds: clone(RELIC_SPRINT) });
  assert(res.success, "gds.plan succeeds on a valid GDS: " + JSON.stringify(res.error));
  const out = res.result as PlanOut;
  assert(out.ok && out.plan !== undefined && out.issues.length === 0 && out.gaps.length === 0, "ok output carries a plan and no issues/gaps");
  ArchitecturePlanSchema.parse(out.plan); // schema round-trip
  const direct = planFromGDS(RELIC_SPRINT, (name) => ctx.registry.has(name));
  assert(JSON.stringify(out.plan) === JSON.stringify(direct), "the skill's plan is byte-identical to planFromGDS over the same catalog");
  assert(out.plan.slices[0].id === "slice-0" && out.plan.slices[0].dodIds.includes("collect-wins"), "Slice 0 = the playable loop, gated");
  assert(out.newWork.length === 0, "RELIC_SPRINT maps entirely to existing skills");

  // The D2 seam: plan.created rides the tracer via ctx.emit.
  const created = (ctx.registry.tracer as LiminaTracer).tail({ type: "director.pipeline.plan.created" });
  assert(created.events.length >= 1, "director.pipeline.plan.created was emitted through ctx.emit");

  // Deterministic re-invocation: same input, same plan.
  const res2 = await invokePlan({ gds: clone(RELIC_SPRINT) });
  assert(res2.success && JSON.stringify((res2.result as PlanOut).plan) === JSON.stringify(out.plan), "re-invocation is deterministic");
}

// ── 2. Unknown/new mappings surface in the plan + newWork ────────────────────────────────
{
  const g = clone(RELIC_SPRINT) as GameDesignSpec;
  g.mechanics.push({ id: "bogus", name: "Bogus", skill: "does.not.exist" });
  g.mechanics.push({ id: "novel", name: "Novel", skill: "NEW: teleport gun" });
  const res = await invokePlan({ gds: g });
  assert(res.success, "gds.plan succeeds on a GDS with unknown mappings");
  const out = res.result as PlanOut;
  assert(out.ok && out.plan !== undefined, "unknown mappings are a plan property, not a validation failure");
  assert(out.plan.systems.find((s) => s.mechanicId === "bogus")?.status === "unknown", "nonexistent skill flagged unknown");
  assert(out.plan.systems.find((s) => s.mechanicId === "novel")?.status === "new", "NEW: mechanic flagged new");
  assert(out.newWork.some((w) => w.includes("does.not.exist")) && out.newWork.some((w) => w.includes("teleport gun")), "newWork lists both");
}

// ── 3. GDD markdown path (fenced ```json block) ──────────────────────────────────────────
{
  const gdd = "# Relic Sprint GDD\n\nSome prose.\n\n```json\n" + JSON.stringify(RELIC_SPRINT) + "\n```\n";
  const res = await invokePlan({ gdd });
  assert(res.success, "gds.plan succeeds on a GDD markdown: " + JSON.stringify(res.error));
  const out = res.result as PlanOut;
  assert(out.ok && out.plan?.gdsId === "relic-sprint", "the GDD path parses + plans the embedded spec");
}

// ── 4. Gap report on a broken GDS ────────────────────────────────────────────────────────
{
  const broken = clone(RELIC_SPRINT) as Record<string, unknown>;
  delete broken.controls;
  delete broken.dod;
  const res = await invokePlan({ gds: broken });
  assert(res.success, "a broken spec is a REPORT, not a skill error");
  const out = res.result as PlanOut;
  assert(!out.ok && out.plan === undefined, "no plan for an invalid spec");
  assert(out.issues.length > 0, "issues are reported");
  assert(out.gaps.includes("controls") && out.gaps.includes("dod"), "the gap report names the missing top-level fields: " + JSON.stringify(out.gaps));

  const noBlock = await invokePlan({ gdd: "# A GDD with no spec block\n\njust prose\n" });
  assert(noBlock.success && !(noBlock.result as PlanOut).ok && (noBlock.result as PlanOut).gaps.includes("(entire spec)"),
    "a GDD without a json block gap-reports the entire spec");
}

// ── 5. FALSIFIABILITY: both/neither input forms rejected; permission enforced ────────────
{
  const both = await invokePlan({ gds: clone(RELIC_SPRINT), gdd: "```json\n{}\n```" });
  assert(!both.success && both.error?.code === "invalid_input", "gds AND gdd together is invalid_input");
  const neither = await invokePlan({});
  assert(!neither.success && neither.error?.code === "invalid_input", "neither gds nor gdd is invalid_input");

  const readonly = await invokePlan({ gds: clone(RELIC_SPRINT) }, resolveProfile("system.readonly"));
  assert(!readonly.success && readonly.error?.code === "forbidden", "a profile without game.plan is denied (permission enforced)");
}

ops.op_log(`p110_gds_plan OK: ${pass} assertions — schema round-trip vs planFromGDS, unknown/new mappings, GDD path, gap report, invalid-input + permission falsifiability, plan.created traced`);
