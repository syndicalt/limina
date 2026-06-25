// P4.0a / M1 -- world-log replay determinism (the Phase 4 keystone, headless).
//
// Records a real running session's AUTHORITATIVE command stream (scene creation,
// ECS mutations, native physics inputs/steps, a deterministic RNG seed, and
// AGENT ACTIONS captured at the SkillRegistry.invoke choke point), persists it to
// disk as JSONL, then rebuilds the final world state by replaying that log ALONE
// into a FRESH engine -- and asserts the result is BIT-IDENTICAL to the recorded
// run (every live entity's ECS Position/Rotation/Scale + every Rapier body
// transform). Replay never re-runs the decision providers; it re-applies recorded
// tool calls. Falsifiability is proven: perturbing one recorded input (a physics
// impulse, then the RNG seed) MUST make the comparison diverge.
//
// Scenario: a small arena (ground + static rails) holding dynamic spheres, stirred
// every tick by recorded physics.applyImpulse skill calls, plus two scripted
// "player" agents (apply impulses) and one scripted "builder" agent (creates
// entities / mutates components), plus a custom RNG-consuming `scene.scatter`
// skill -- so the seed is genuinely load-bearing. Runs >= 3000 ticks / >= 10000
// world-log commands.

import * as THREE from "../build/three.bundle.mjs";
import { z } from "../build/zod.bundle.mjs";
import { EntityTable, ops } from "../src/engine.ts";
import { createEcsWorld, Position, spawnRenderable } from "../src/ecs/world.ts";
import { createTransformStorage } from "../src/ecs/facade.ts";
import { UniformGridSpatialIndex } from "../src/spatial/index.ts";
import { SkillRegistry, type ExecutionContext, type SkillDefinition, type WorldContext } from "../src/skills/registry.ts";
import { registerCoreSkills } from "../src/skills/index.ts";
import { LiminaTracer } from "../src/observability/event.ts";
import { AgentRegistry } from "../src/agents/agent.ts";
import { ScriptedProvider, type DecideRequest } from "../src/agents/llm.ts";
import { actionSystem, decisionSystem, perceptionSystem, type ProviderMap } from "../src/agents/systems.ts";
import { AgentScheduler } from "../src/agents/scheduler.ts";
import { resolveProfile } from "../src/skills/permissions.ts";
import type { MCPRequest } from "../src/mcp/protocol.ts";
import { WorldRecorder } from "../src/worldlog/recorder.ts";
import { replayCommands, replayWorldLog } from "../src/worldlog/replay.ts";
import { captureWorldState, compareWorldState, parseWorldLog, syncAllBodies } from "../src/worldlog/log.ts";

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error("p4_worldlog_replay: " + message);
}

// ---- Tunables -------------------------------------------------------------
const SEED = 0x1234abcd;
const TICKS = 3050; // >= 3000
const STIR_COUNT = 3; // dynamic balls stirred (recorded applyImpulse) each tick
const LOG_NAME = "p4_worldlog.jsonl";
const DECISION_INTERVAL = 15;

// ---- Scenario-specific skill: scene.scatter (RNG-consuming) ---------------
// Spawns `count` pure-ECS entities at Math.random-jittered offsets. Because the
// jitter is drawn INSIDE the handler (not precomputed by the caller), replay can
// reproduce the positions ONLY by re-installing the recorded seed -- which makes
// the seed a real recorded input, falsifiable by perturbation.
const Vec3 = z.tuple([z.number(), z.number(), z.number()]);
const scatterInput = z.object({ count: z.number().int().min(1).max(64), base: Vec3, spread: z.number().min(0) });
const scatter: SkillDefinition<z.infer<typeof scatterInput>, { entities: string[] }> = {
  name: "scene.scatter",
  version: "1.0.0",
  description: "Spawn N marker entities at seeded-random offsets around a base point.",
  category: "scene",
  permissions: ["scene.write"],
  input: scatterInput,
  output: z.object({ entities: z.array(z.string()) }),
  handler: (input, ctx: ExecutionContext) => {
    const entities: string[] = [];
    for (let i = 0; i < input.count; i++) {
      const x = input.base[0] + (Math.random() - 0.5) * input.spread;
      const y = input.base[1] + (Math.random() - 0.5) * input.spread;
      const z = input.base[2] + (Math.random() - 0.5) * input.spread;
      const obj = { position: { set() {} }, quaternion: { set() {} }, scale: { set() {} } };
      const eid = spawnRenderable(ctx.world.ecs, obj, x, y, z);
      entities.push(ctx.world.entities.create({ eid }));
    }
    ctx.emit("scene.scattered", { count: input.count });
    return { entities };
  },
};

function registerScenarioSkills(registry: SkillRegistry): void {
  registry.register(scatter);
}

// ---- A fresh headless world (stub scene/camera, real ECS/physics surface) -
function makeHeadlessWorld(worldOps: typeof ops): WorldContext {
  const ecs = createEcsWorld();
  const scene = { add() {}, remove() {}, position: { set() {}, x: 0, y: 0, z: 0 }, background: null as unknown };
  const camera = { position: { set() {} }, aspect: 1, lookAt() {}, updateProjectionMatrix() {} };
  return {
    ecs,
    transforms: createTransformStorage(ecs),
    spatial: new UniformGridSpatialIndex(),
    entities: new EntityTable(),
    tags: new Map(),
    scene,
    camera,
    ops: worldOps,
    mode: "headless",
  };
}

function makeReplayRegistry(tracer: LiminaTracer): SkillRegistry {
  const registry = new SkillRegistry(tracer);
  registerCoreSkills(registry);
  registerScenarioSkills(registry);
  return registry;
}

// ===========================================================================
// PHASE 1 -- RECORD a real session.
// ===========================================================================

// Warm up THREE so any one-time lazy init (uuids / node prototypes draw from
// Math.random) happens on the DEFAULT rng BEFORE we install the seeded one;
// otherwise record's first object would consume seeded draws that replay (THREE
// already initialized in-process) would not, desyncing the shared rng stream.
void new THREE.Mesh(new THREE.SphereGeometry(0.5, 24, 16), new THREE.MeshStandardNodeMaterial({ color: 0x808080 }));
void new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardNodeMaterial({ color: 0x808080 }));

const recTracer = new LiminaTracer("ses_p4_record");
const registry = new SkillRegistry(recTracer);
registerCoreSkills(registry);
registerScenarioSkills(registry);

const recorder = new WorldRecorder("ses_p4_record");
recorder.attach(registry); // hook the invoke choke point
recorder.seed(SEED); // record + install the deterministic PRNG
const recOps = recorder.wrapOps(ops); // record raw physics ops issued outside skills
const world = makeHeadlessWorld(recOps);

const builderBase = {
  agentId: "limina:builder",
  sessionId: "ses_p4_record",
  permissions: resolveProfile("builder.readWrite"),
  tick: 0,
  world,
};

// Bootstrap: world + ground + 4 static rails (RAW physics ops -> recorded as
// `physics` commands, exercising the non-skill mutation path).
recOps.op_physics_create_world(-9.81);
recOps.op_physics_add_ground(0);
const RAIL_HX = 8;
const RAIL_HZ = 6;
recOps.op_physics_add_static_box(0, 0.75, RAIL_HZ + 0.25, RAIL_HX + 0.5, 0.75, 0.25, 0.4, 0.4);
recOps.op_physics_add_static_box(0, 0.75, -(RAIL_HZ + 0.25), RAIL_HX + 0.5, 0.75, 0.25, 0.4, 0.4);
recOps.op_physics_add_static_box(RAIL_HX + 0.25, 0.75, 0, 0.25, 0.75, RAIL_HZ + 0.5, 0.4, 0.4);
recOps.op_physics_add_static_box(-(RAIL_HX + 0.25), 0.75, 0, 0.25, 0.75, RAIL_HZ + 0.5, 0.4, 0.4);

// Dynamic spheres in a grid (scene.createEntity skill -> the body op is nested
// in the skill and reproduced on re-invoke, NOT separately logged).
const ballIds: { id: string; eid: number }[] = [];
let colorSeq = 0x3366cc;
for (let gz = -2; gz <= 2; gz++) {
  for (let gx = -1; gx <= 1; gx++) {
    const res = await registry.invoke("scene.createEntity", {
      shape: "sphere",
      collider: "sphere",
      size: 1.0,
      color: (colorSeq = (colorSeq + 0x1111) & 0xffffff),
      position: [gx * 2.2, 0.5, gz * 2.0],
      dynamic: true,
      friction: 0.3,
      restitution: 0.5,
    }, builderBase);
    assert(res.success === true, "bootstrap createEntity failed");
    const idResult = res.result;
    assert(idResult !== null && typeof idResult === "object" && "entity" in idResult, "createEntity result missing entity");
    const id = idResult.entity;
    assert(typeof id === "string", "entity id not a string");
    const entry = world.entities.resolve(id);
    assert(entry !== undefined, "created entity not resolvable");
    ballIds.push({ id, eid: entry.eid });
  }
}
assert(ballIds.length >= STIR_COUNT, "not enough balls to stir");

// Seeded scatter (pure-ECS markers; final positions depend ONLY on the seed).
for (let s = 0; s < 3; s++) {
  const r = await registry.invoke("scene.scatter", { count: 8, base: [0, 5 + s, 0], spread: 6 }, builderBase);
  assert(r.success === true, "scatter failed");
}
const scatterProbe = world.entities.ids().find((id) => world.entities.resolve(id)?.bodyId === undefined);
assert(scatterProbe !== undefined, "expected a body-less scatter entity to mutate via ECS");

// A few direct ECS mutations (position/rotation/scale) on a scatter marker --
// reproduced purely from the recorded skill inputs (seed-independent).
await registry.invoke("ecs.updateComponent", { entity: scatterProbe, component: "scale", value: [2, 0.5, 1.5] }, builderBase);
await registry.invoke("ecs.updateComponent", { entity: scatterProbe, component: "rotation", value: [0, 0.3826834, 0, 0.9238795] }, builderBase);

// ---- Agents: 2 scripted players (apply impulses) + 1 scripted builder ------
const agents = new AgentRegistry();
const scheduler = new AgentScheduler();
agents.add({
  id: "limina:agt_p1", type: "player", entityId: ballIds[0].id,
  perceptionRadius: 20, decisionIntervalTicks: DECISION_INTERVAL,
  profile: "player.limited", sessionId: "ses_p4_record",
  llm: { provider: "prov_p1", model: "scripted", systemPrompt: "" },
});
agents.add({
  id: "limina:agt_p2", type: "player", entityId: ballIds[1].id,
  perceptionRadius: 20, decisionIntervalTicks: DECISION_INTERVAL,
  profile: "player.limited", sessionId: "ses_p4_record",
  llm: { provider: "prov_p2", model: "scripted", systemPrompt: "" },
});
agents.add({
  id: "limina:agt_b1", type: "builder", entityId: undefined,
  perceptionRadius: 20, decisionIntervalTicks: DECISION_INTERVAL,
  profile: "builder.readWrite", sessionId: "ses_p4_record",
  llm: { provider: "prov_b1", model: "scripted", systemPrompt: "" },
});

let builderDecisions = 0;
const providers: ProviderMap = {
  prov_p1: new ScriptedProvider((_req: DecideRequest): MCPRequest[] => [
    { tool: "physics.applyImpulse", input: { entity: ballIds[0].id, impulse: [0.45, 0, 0.2] } },
  ]),
  prov_p2: new ScriptedProvider((_req: DecideRequest): MCPRequest[] => [
    { tool: "physics.applyImpulse", input: { entity: ballIds[1].id, impulse: [-0.3, 0, 0.28] } },
  ]),
  prov_b1: new ScriptedProvider((_req: DecideRequest): MCPRequest[] => {
    const n = builderDecisions++;
    if (n < 24) {
      return [{
        tool: "scene.createEntity",
        input: { shape: "box", collider: "box", size: 0.6, color: 0x99cc44, position: [(n % 6) - 3, 0.3, 3.5], static: true },
      }];
    }
    return [{ tool: "ecs.updateComponent", input: { entity: scatterProbe, component: "position", value: [n * 0.001, 7, 0] } }];
  }),
};

// ---- Per-tick engine processing (record): systems -> stir -> step -> sync --
const stir = ballIds.slice(0, STIR_COUNT);
const GAIN = 0.05;
const SWIRL = 0.02;
for (let tick = 1; tick <= TICKS; tick++) {
  recorder.tick = tick;
  perceptionSystem(agents, world, recTracer, tick);
  decisionSystem(agents, registry, providers, recTracer, tick, scheduler);
  for (let d = 0; d < 8; d++) await Promise.resolve(); // drain scripted decisions
  await actionSystem(agents, registry, world, tick, scheduler);
  // Recorded centering+swirl impulses (concrete inputs computed from live state).
  for (const ball of stir) {
    const px = Position.x[ball.eid];
    const pz = Position.z[ball.eid];
    await registry.invoke("physics.applyImpulse", {
      entity: ball.id,
      impulse: [-GAIN * px - SWIRL * pz, 0, -GAIN * pz + SWIRL * px],
    }, builderBase);
  }
  recOps.op_physics_step();
  // Per-tick engine rule -- the EXACT same helper replay runs after each step:
  // copy every body's full transform (position + rotation) into ECS SoA.
  syncAllBodies(world);
}

// Snapshot the recorded final state (deep copies of numbers; immune to the later
// array zeroing that replay performs) and persist the world log to disk.
const recordedState = captureWorldState(world);
const jsonl = recorder.toJsonl();
ops.op_write_trace(LOG_NAME, jsonl);

const commandCount = recorder.commands.length;
const skillCmds = recorder.count("skill");
const physicsCmds = recorder.count("physics");
const seedCmds = recorder.count("seed");
const traceEvents = recTracer.durableEventCount();

assert(commandCount >= 10000, `expected >= 10000 world-log commands, got ${commandCount}`);
assert(recorder.meta().ticks >= 3000, `expected >= 3000 ticks, got ${recorder.meta().ticks}`);
assert(seedCmds === 1, `expected exactly 1 seed command, got ${seedCmds}`);

// Sanity: the recorded run produced real, finite, non-trivial motion.
let movedBalls = 0;
const spawnY = 0.5;
for (const ball of ballIds) {
  const st = recordedState.entities.find((e) => e.id === ball.id);
  assert(st !== undefined, "recorded ball missing from snapshot");
  for (const v of [...st.pos, ...st.rot, ...st.scale]) assert(Number.isFinite(v), "non-finite recorded transform");
  if (Math.abs(st.pos[0]) + Math.abs(st.pos[2]) > 0.01 || Math.abs(st.pos[1] - spawnY) > 1e-6) movedBalls++;
}
assert(movedBalls >= 1, "no ball moved during the recorded run");

// ===========================================================================
// PHASE 2 -- REPLAY from the persisted log ALONE, into a FRESH engine.
// ===========================================================================
const diskJsonl = ops.op_read_trace(LOG_NAME); // read back what we persisted
const replayResult = await replayWorldLog(diskJsonl, {
  makeWorld: () => makeHeadlessWorld(ops), // raw ops: create_world resets native state
  makeRegistry: makeReplayRegistry,
  tracer: new LiminaTracer("ses_p4_replay"),
});

const main = compareWorldState(recordedState, replayResult.state);
assert(
  main.identical,
  `replay diverged from the recorded run (${main.comparisons} fields compared): ${main.detail ?? "?"}`,
);
assert(replayResult.commands === commandCount, `replay command count ${replayResult.commands} != recorded ${commandCount}`);
assert(replayResult.skillInvokes === skillCmds, "replay re-invoked a different number of skills");
assert(replayResult.steps >= 3000, `replay stepped ${replayResult.steps} times`);

// ===========================================================================
// PHASE 3 -- FALSIFIABILITY: perturb ONE recorded input -> MUST diverge.
// ===========================================================================
const replayDeps = {
  makeWorld: () => makeHeadlessWorld(ops),
  makeRegistry: makeReplayRegistry,
};

// (A) Perturb a physics input: bump the first applyImpulse skill command.
const perturbA = parseWorldLog(diskJsonl).commands;
let bumped = false;
for (const cmd of perturbA) {
  if (cmd.kind !== "skill" || cmd.tool !== "physics.applyImpulse") continue;
  const input = cmd.input;
  if (input !== null && typeof input === "object" && "impulse" in input) {
    const impulse = input.impulse;
    if (Array.isArray(impulse) && typeof impulse[0] === "number") {
      impulse[0] = impulse[0] + 5.0;
      bumped = true;
      break;
    }
  }
}
assert(bumped, "could not find a physics.applyImpulse command to perturb");
const perturbedA = await replayCommands(perturbA, { ...replayDeps, tracer: new LiminaTracer("ses_p4_perturbA") });
const cmpA = compareWorldState(recordedState, perturbedA.state);
assert(!cmpA.identical, "perturbing a recorded impulse did NOT diverge -- the test is not falsifiable");

// (B) Perturb the RNG seed -> seeded scatter positions must change.
const perturbB = parseWorldLog(diskJsonl).commands;
let reseeded = false;
for (const cmd of perturbB) {
  if (cmd.kind === "seed") {
    cmd.seed = (cmd.seed + 1) >>> 0;
    reseeded = true;
    break;
  }
}
assert(reseeded, "could not find the seed command to perturb");
const perturbedB = await replayCommands(perturbB, { ...replayDeps, tracer: new LiminaTracer("ses_p4_perturbB") });
const cmpB = compareWorldState(recordedState, perturbedB.state);
assert(!cmpB.identical, "perturbing the recorded seed did NOT diverge -- RNG is not load-bearing");

// Re-installing the genuine log once more must STILL be bit-identical (replay is
// repeatable, and the perturbation runs did not corrupt the determinism path).
const recheck = await replayWorldLog(diskJsonl, { ...replayDeps, tracer: new LiminaTracer("ses_p4_recheck") });
assert(compareWorldState(recordedState, recheck.state).identical, "second clean replay diverged");

ops.op_log(
  `p4_worldlog_replay OK: ${commandCount} commands (${skillCmds} skill, ${physicsCmds} physics, ${seedCmds} seed) over ` +
    `${recorder.meta().ticks} ticks, ${traceEvents} trace events; replay BIT-IDENTICAL ` +
    `(${main.comparisons} fields, ${replayResult.state.entities.length} live entities, ${replayResult.steps} steps); ` +
    `perturbation falsified divergence [impulse: ${cmpA.detail ?? "?"}] [seed: ${cmpB.detail ?? "?"}]`,
);
