// P56 -- editor take-control WRITE PATH (headless, deterministic).
//
// A human connected as an ungated write client must be able to author direct entity-transform edits
// into the same recorded stream agents use. This pins the end-to-end path: create an entity through
// the real registry, apply a take-control move + scale via the existing manipulation bridge, prove
// the live world changed, prove worldlog.tail exposes those edits as AUTHORING commands, then replay
// the recorded command stream into a FRESH world and require bit-identical transform state.
//
// Run: limina js/test/p56_take_control.ts   (exit 0 = pass)

import { EntityTable, ops, type EngineOps } from "../src/engine.ts";
import { createEcsWorld } from "../src/ecs/world.ts";
import { createTransformStorage } from "../src/ecs/facade.ts";
import { UniformGridSpatialIndex } from "../src/spatial/index.ts";
import { LiminaTracer, type Tracer } from "../src/observability/event.ts";
import { SkillRegistry, type WorldContext } from "../src/skills/registry.ts";
import { registerCoreSkills } from "../src/skills/index.ts";
import { resolveProfile } from "../src/skills/permissions.ts";
import { applyManipulation } from "../src/kernel/manipulation.ts";
import { WorldRecorder } from "../src/worldlog/recorder.ts";
import { registerWorldlogSkills } from "../src/skills/worldlog.ts";
import { captureWorldState, compareWorldState } from "../src/worldlog/log.ts";
import { replayCommands } from "../src/worldlog/replay.ts";
import type { MCPResponse } from "../src/mcp/protocol.ts";

const SESSION = "ses_p56";
const SEED = 0x56;
const BUILDER = resolveProfile("builder.readWrite");
let pass = 0;

function assert(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new Error("p56_take_control: " + msg);
  pass++;
}

function ok(res: MCPResponse): Record<string, unknown> {
  if (!res.success) throw new Error("call failed: " + JSON.stringify(res.error));
  return res.result as Record<string, unknown>;
}

function makeWorld(worldOps: EngineOps): WorldContext {
  const ecs = createEcsWorld();
  const scene = { add() {}, remove() {}, position: { set() {}, x: 0, y: 0, z: 0 }, background: null as unknown };
  const camera = { position: { set() {} }, aspect: 1, lookAt() {}, updateProjectionMatrix() {} };
  return {
    ecs, transforms: createTransformStorage(ecs), spatial: new UniformGridSpatialIndex(),
    entities: new EntityTable(), tags: new Map(), scene: scene as WorldContext["scene"],
    camera: camera as WorldContext["camera"], ops: worldOps, mode: "headless",
  };
}

function makeReplayRegistry(tracer: Tracer): SkillRegistry {
  const registry = new SkillRegistry(tracer);
  registerCoreSkills(registry);
  // The recording registry exposes worldlog.tail, and replayCommands replays the whole command
  // stream. A fresh empty recorder is enough because tail is read-only and has no world effect.
  registerWorldlogSkills(registry, { recorder: new WorldRecorder("ses_p56_replay_tail") });
  return registry;
}

// Wire a registry + recorder exactly as the AuthoritativeServer does (attach -> seed -> wrapOps).
const registry = new SkillRegistry(new LiminaTracer(SESSION));
registerCoreSkills(registry);
const recorder = new WorldRecorder(SESSION);
registerWorldlogSkills(registry, { recorder });
recorder.attach(registry);
recorder.seed(SEED);
const recOps = recorder.wrapOps(ops);
const world = makeWorld(recOps);
const base = { agentId: "agt_build", sessionId: SESSION, permissions: BUILDER, tick: 1, world };

const entity = ok(await registry.invoke("scene.createEntity", {
  shape: "box",
  position: [1, 2, 3],
  scale: [1, 1, 1],
}, base)).entity as string;

const moveResponses = await applyManipulation(registry, world, {
  kind: "move",
  entity,
  position: [7, 8, 9],
}, { sessionId: SESSION, tick: 2, defaultAgentId: "human_editor", defaultPerms: BUILDER });
assert(moveResponses.length === 1 && moveResponses[0].success, "A: take-control move must apply through applyManipulation");

const scaleResponses = await applyManipulation(registry, world, {
  kind: "scale",
  entity,
  scale: [2, 3, 4],
}, { sessionId: SESSION, tick: 3, defaultAgentId: "human_editor", defaultPerms: BUILDER });
assert(scaleResponses.length === 1 && scaleResponses[0].success, "A: take-control scale must apply through applyManipulation");

// ---- A. the edit applied to the live authoritative world ---------------------------------------
const recordedState = captureWorldState(world);
const edited = recordedState.entities.find((e) => e.id === entity);
assert(edited !== undefined, "A: the take-control entity must exist in captured world state");
assert(JSON.stringify(edited!.pos) === "[7,8,9]", `A: move applied to ECS state (got ${JSON.stringify(edited!.pos)})`);
assert(JSON.stringify(edited!.scale) === "[2,3,4]", `A: scale applied to ECS state (got ${JSON.stringify(edited!.scale)})`);

// ---- B. worldlog.tail exposes the take-control writes as AUTHORING commands --------------------
const tail = ok(await registry.invoke("worldlog.tail", { since: 0 }, base)) as {
  commands: Array<{ kind: string; tool?: string; input?: unknown }>;
  next: number;
  reset: boolean;
};
const updates = tail.commands.filter((cmd): cmd is { kind: "skill"; tool: string; input: Record<string, unknown> } =>
  cmd.kind === "skill" &&
  cmd.tool === "ecs.updateComponent" &&
  typeof cmd.input === "object" &&
  cmd.input !== null &&
  (cmd.input as Record<string, unknown>).entity === entity,
);
const components = new Set(updates.map((cmd) => cmd.input.component));
assert(tail.reset === false, "B: tail should not require a reset on a fresh recorder");
assert(updates.length >= 2, `B: take-control must author ecs.updateComponent commands (got ${updates.length})`);
assert(components.has("position"), "B: worldlog.tail must include the authored position update");
assert(components.has("scale"), "B: worldlog.tail must include the authored scale update");
assert(tail.next === recorder.commandCount, "B: tail cursor must advance to the recorder command count");

// ---- C. replay reproduces the moved + scaled transform BIT-IDENTICALLY -------------------------
const replay = await replayCommands(recorder.commands, {
  makeRegistry: makeReplayRegistry,
  makeWorld: () => makeWorld(ops),
  tracer: new LiminaTracer("ses_p56_replay"),
});
const cmp = compareWorldState(recordedState, replay.state);
assert(cmp.identical, `C: replay must reproduce take-control transform BIT-IDENTICALLY (${cmp.comparisons} fields: ${cmp.detail ?? "?"})`);
const replayed = replay.state.entities.find((e) => e.id === entity);
assert(replayed !== undefined, "C: replayed entity must exist");
assert(JSON.stringify(replayed!.pos) === "[7,8,9]", `C: replayed move must match (got ${JSON.stringify(replayed!.pos)})`);
assert(JSON.stringify(replayed!.scale) === "[2,3,4]", `C: replayed scale must match (got ${JSON.stringify(replayed!.scale)})`);

ops.op_log(
  `p56_take_control OK: ${pass} assertions -- ungated take-control move+scale applied through ` +
    `applyManipulation, worldlog.tail exposed ecs.updateComponent AUTHORING commands, and replayCommands ` +
    `reproduced the edited transform BIT-IDENTICALLY (${cmp.comparisons} fields, ${replay.commands} commands).`,
);
