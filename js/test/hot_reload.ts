// Phase 3 T5 — REAL hot-reload. `dev.reload` performs an actual live registry
// swap: a skill registered with behavior A, reloaded to behavior B, runs B on the
// next invoke/callTool with no process restart. Scene reload re-runs its builder.
// Targets that genuinely cannot reload fail honestly (never a silent no-op), and
// every reload is traced with what was invalidated.
//
// Falsifiable: if dev.reload were a no-op event (the old behavior), the second
// invoke would still return A and the `expected behavior B` assert would throw.

import { z } from "../build/zod.bundle.mjs";
import { EntityTable, ops } from "../src/engine.ts";
import { createEcsWorld } from "../src/ecs/world.ts";
import { LiminaTracer } from "../src/observability/event.ts";
import { registerSystemSkills } from "../src/skills/system.ts";
import { resolveProfile } from "../src/skills/permissions.ts";
import { SkillRegistry, type SkillDefinition, type WorldContext } from "../src/skills/registry.ts";
import type { MCPResponse } from "../src/mcp/protocol.ts";

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function ok(res: MCPResponse): unknown {
  if (!res.success) throw new Error("call failed: " + JSON.stringify(res.error));
  return res.result;
}

function asRecord(value: unknown): Record<string, unknown> {
  assert(typeof value === "object" && value !== null, "expected object");
  return value as Record<string, unknown>;
}

const scene = { add() {}, remove() {}, position: { set() {}, x: 0, y: 0, z: 0 }, background: null as unknown };
const camera = { position: { set() {} }, aspect: 1, lookAt() {}, updateProjectionMatrix() {} };
const world: WorldContext = {
  ecs: createEcsWorld(),
  entities: new EntityTable(),
  tags: new Map(),
  scene,
  camera,
  ops,
  mode: "headless",
};

const tracer = new LiminaTracer("ses_hot_reload");
const registry = new SkillRegistry(tracer);
registerSystemSkills(registry); // provides dev.reload + discovery skills

const caller = {
  agentId: "agt_reloader",
  sessionId: "ses_hot_reload",
  permissions: resolveProfile("system.readonly"), // has scene.read => dev.reload allowed
  tick: 0,
  world,
};

// A skill whose behavior is *captured at definition time*: the handler returns
// the label it was built with. So the only way invoke() can return "B" is if the
// registry actually swapped the live definition — a live closure reading a shared
// variable would make this non-falsifiable, so we deliberately avoid that.
function makeBehaviorSkill(name: string, label: string, version: string): SkillDefinition {
  return {
    name,
    version,
    description: `returns behavior ${label}`,
    category: "system",
    permissions: [],
    input: z.object({}),
    output: z.object({ behavior: z.string() }),
    handler: () => ({ behavior: label }),
  };
}

// ---------------------------------------------------------------------------
// Case 1: skill X reloaded A -> B, observable behavior changes via dev.reload.
// ---------------------------------------------------------------------------
const X = "demo.behavior";
// Register behavior A and the source the runtime would re-import to get the new
// definition (here it yields behavior B with a bumped version).
registry.registerReloadable(makeBehaviorSkill(X, "A", "1.0.0"), () => makeBehaviorSkill(X, "B", "2.0.0"));

const before = asRecord(ok(await registry.invoke(X, {}, caller)));
assert(before.behavior === "A", `expected behavior A before reload, got ${String(before.behavior)}`);
assert(registry.describe(X)?.version === "1.0.0", "describe should report the pre-reload version");

const reload = asRecord(ok(await registry.invoke("dev.reload", { target: "skill", name: X, reason: "swap A->B" }, caller)));
assert(reload.ok === true, "skill reload should report ok");
assert(
  Array.isArray(reload.invalidated) && (reload.invalidated as string[]).includes(X),
  "skill reload should report the invalidated skill",
);

// THE falsifiable check: a no-op reload leaves A routed and this throws.
const after = asRecord(ok(await registry.invoke(X, {}, caller)));
assert(after.behavior === "B", `hot-reload did not change behavior: expected B, got ${String(after.behavior)}`);

// Discovery (describe/list) reflects the NEW definition, not the old one.
assert(registry.describe(X)?.version === "2.0.0", "describe should report the post-reload version");
assert(
  registry.list().some((t) => t.name === X && t.description.includes("behavior B")),
  "list should report the reloaded description",
);

// Reload is traced with an honest completed event naming what was invalidated.
const completed = tracer.trace("agt_reloader").find((e) => e.type === "dev.skill.reload.completed");
assert(completed !== undefined, "dev.skill.reload.completed event missing");
const completedPayload = asRecord(completed.payload);
assert(completedPayload.name === X, "reload completed event should name the skill");
assert(
  Array.isArray(completedPayload.invalidated) && (completedPayload.invalidated as string[]).includes(X),
  "reload completed event should list invalidations",
);
assert(
  !tracer.trace("agt_reloader").some((e) => e.type === "dev.skill.reload.requested"),
  "reload must complete, not merely be 'requested' (no-op)",
);

// ---------------------------------------------------------------------------
// Case 2: scene reload actually re-runs the registered builder (observable).
// ---------------------------------------------------------------------------
let rebuiltEntities = 0;
let builderRuns = 0;
registry.registerSceneBuilder("main", () => {
  builderRuns += 1;
  rebuiltEntities += 3; // simulate (re)constructing 3 entities each rebuild
  return { scene: "main", entities: rebuiltEntities, runs: builderRuns };
});

const sceneReload1 = asRecord(ok(await registry.invoke("dev.reload", { target: "scene", name: "main" }, caller)));
assert(sceneReload1.ok === true, "scene reload should succeed with a registered builder");
assert(builderRuns === 1, "scene reload must re-run the builder (run 1)");

const sceneReload2 = asRecord(ok(await registry.invoke("dev.reload", { target: "scene" }, caller))); // default to first builder
assert(sceneReload2.ok === true, "second scene reload should succeed");
assert(builderRuns === 2 && rebuiltEntities === 6, "scene reload must re-run the builder each time (run 2)");
const sceneCompleted = tracer.trace("agt_reloader").filter((e) => e.type === "dev.scene.reload.completed");
assert(sceneCompleted.length === 2, "each scene reload should emit a completed event");
const lastSummary = asRecord(asRecord(sceneCompleted[1].payload).summary);
assert(lastSummary.entities === 6 && lastSummary.runs === 2, "scene reload event summary should reflect the re-run");

// ---------------------------------------------------------------------------
// Case 3: honest failures — never a silent no-op success.
// ---------------------------------------------------------------------------
// (a) A skill with no registered reload source cannot be reloaded.
registry.register(makeBehaviorSkill("demo.static", "A", "1.0.0"));
const noSource = asRecord(ok(await registry.invoke("dev.reload", { target: "skill", name: "demo.static" }, caller)));
assert(noSource.ok === false, "reloading a skill without a reload source must fail honestly");
assert(typeof noSource.reason === "string" && (noSource.reason as string).includes("not reloadable"), "failure must explain why");
// The un-reloadable skill is untouched — still behavior A.
const stillA = asRecord(ok(await registry.invoke("demo.static", {}, caller)));
assert(stillA.behavior === "A", "a failed reload must not mutate the skill");

// (b) Unknown skill.
const unknown = asRecord(ok(await registry.invoke("dev.reload", { target: "skill", name: "does.not.exist" }, caller)));
assert(unknown.ok === false && typeof unknown.reason === "string", "reloading an unknown skill must fail honestly");

// (c) Scene reload with no builder for the named scene.
const noBuilder = asRecord(ok(await registry.invoke("dev.reload", { target: "scene", name: "ghost" }, caller)));
assert(noBuilder.ok === false, "scene reload without a builder must fail honestly");

// (d) An inherently un-reloadable target ("data": opaque, runtime-owned).
const dataReload = asRecord(ok(await registry.invoke("dev.reload", { target: "data" }, caller)));
assert(dataReload.ok === false, "data reload is not supported in-process and must fail honestly");

// All failure paths are traced as .failed (never .completed).
const failedTypes = ["dev.skill.reload.failed", "dev.scene.reload.failed", "dev.data.reload.failed"];
for (const t of failedTypes) {
  assert(tracer.trace("agt_reloader").some((e) => e.type === t), `honest failure event missing: ${t}`);
}

ops.op_log(
  "Hot-reload OK: dev.reload swaps skill X A->B live (describe/list updated), scene reload re-runs its builder, un-reloadable targets fail honestly, all reloads traced",
);
