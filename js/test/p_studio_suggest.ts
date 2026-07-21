// p_studio_suggest — the agent suggestion channel. Proves: studio.suggest is
// registered for the reviewer/builder profiles, validates + normalizes (region
// corners sorted), pre-validates its optional action against the REAL skill
// schema (a card never offers an unparseable call), emits the durable trace
// event, and records NOTHING (effect read — suggestions are not world
// mutations). Falsifiability: an unknown action skill or unparseable action
// input must throw; a recorded suggestion would fail the recorder count.
//
// Run: LIMINA_AUDIO=null ./target/release/limina js/test/p_studio_suggest.ts

import { z } from "../build/zod.bundle.mjs";
import { EntityTable, ops, type EngineOps } from "../src/engine.ts";
import { createEcsWorld } from "../src/ecs/world.ts";
import { createTransformStorage } from "../src/ecs/facade.ts";
import { UniformGridSpatialIndex } from "../src/spatial/index.ts";
import { LiminaTracer } from "../src/observability/event.ts";
import { SkillRegistry, type InvokeBase, type WorldContext } from "../src/skills/registry.ts";
import { registerCoreSkills } from "../src/skills/index.ts";
import { resolveProfile } from "../src/skills/permissions.ts";
import { WorldRecorder } from "../src/worldlog/recorder.ts";
import { STUDIO_SUGGESTION_EVENT } from "../src/skills/studio.ts";

function assert(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new Error("p_studio_suggest FAIL: " + msg);
}

function makeWorld(worldOps: EngineOps): WorldContext {
  const scene = { add() {}, remove() {}, position: { set() {}, x: 0, y: 0, z: 0 }, background: null as unknown };
  const camera = { position: { set() {} }, aspect: 1, lookAt() {}, updateProjectionMatrix() {} };
  const ecs = createEcsWorld();
  return {
    ecs, transforms: createTransformStorage(ecs), spatial: new UniformGridSpatialIndex(),
    entities: new EntityTable(), tags: new Map(), scene: scene as WorldContext["scene"],
    camera: camera as WorldContext["camera"], ops: worldOps, mode: "headless",
  };
}

const tracer = new LiminaTracer("ses_p_studio_suggest");
const registry = new SkillRegistry(tracer);
registerCoreSkills(registry);
const recorder = new WorldRecorder("ses_p_studio_suggest");
recorder.attach(registry);
const world = makeWorld(ops);

const base: InvokeBase = {
  agentId: "agt_chat",
  sessionId: "ses_p_studio_suggest",
  permissions: resolveProfile("reviewer"),
  profile: "reviewer",
  tick: 7,
  world,
};

// 1. A full suggestion: normalized, traced, unrecorded.
const res = await registry.invoke("studio.suggest", {
  title: "Carve a bay here",
  detail: "The east coast is straight for 3km; a bay breaks the silhouette.",
  surface: "atlas",
  region: { x0: 300, z0: 900, x1: 100, z1: 700 },
  action: { skill: "scene.createEntity", input: { shape: "box", size: 1, position: [0, 0.5, 0] }, label: "Mark it" },
}, base);
assert(res.success === true, `studio.suggest failed: ${JSON.stringify(res.error)}`);
const { suggestion } = res.result as { suggestion: { id: string; region: { x0: number; z0: number; x1: number; z1: number }; action: { label?: string } } };
assert(suggestion.id.startsWith("sug_"), "suggestion id minted");
assert(suggestion.region.x0 === 100 && suggestion.region.x1 === 300 && suggestion.region.z0 === 700 && suggestion.region.z1 === 900, "region corners sorted");
assert(suggestion.action.label === "Mark it", "action label preserved");
assert(recorder.count("skill") === 0, "a suggestion must NOT enter the world log (effect read)");
const traced = tracer.tail({ type: STUDIO_SUGGESTION_EVENT }).events;
assert(traced.length === 1, `the suggestion IS the trace event (got ${traced.length})`);
assert((traced[0].payload as { title: string }).title === "Carve a bay here", "trace payload carries the suggestion");

// 2. Unknown action skill → structured failure.
const unknown = await registry.invoke("studio.suggest", { title: "x", action: { skill: "ghost.skill", input: {} } }, base);
assert(unknown.success === false, "unknown action skill must fail");

// 3. Unparseable action input → structured failure (never a broken-promise card).
const badInput = await registry.invoke("studio.suggest", { title: "x", action: { skill: "scene.createEntity", input: { shape: 42 } } }, base);
assert(badInput.success === false, "unparseable action input must fail");

// 4. Permission boundary: a profile without studio.suggest is forbidden.
const denied = await registry.invoke("studio.suggest", { title: "x" }, { ...base, permissions: resolveProfile("system.readonly"), profile: "system.readonly" });
assert(denied.success === false && denied.error?.code === "forbidden", `system.readonly must be forbidden (got ${JSON.stringify(denied.error)})`);

// 5. Schema guards: oversized title rejected at the boundary.
const huge = await registry.invoke("studio.suggest", { title: "t".repeat(200) }, base);
assert(huge.success === false && huge.error?.code === "invalid_input", "oversized title is invalid_input");

ops.op_log(
  "p_studio_suggest OK: suggestion normalized + traced + unrecorded; unknown/unparseable actions fail; " +
    "forbidden without the grant; schema guards hold.",
);
