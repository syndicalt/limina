// P4 / M3 -- authoritative world log -> durable, segmented sink (headless).
//
// Records a real running session and STREAMS the authoritative world command log
// to disk INCREMENTALLY via the DurableWorldLog sink (one fsync'd append per
// tick, like the P2 durable trace sink) -- NOT buffered and written once at the
// end. It proves:
//   * SEGMENTED durability: the on-disk log grows monotonically across ticks, and
//     a mid-stream read parses to exactly the commands flushed so far (no torn
//     final line), so a fresh engine could reload a crash prefix.
//   * ROUND-TRIP: after close(), reloading the persisted log from disk and
//     replaying it into a FRESH engine reproduces the final world state
//     BIT-IDENTICAL to the recorded run (persist -> reload -> replay).
//   * EQUIVALENCE: the streamed segments parse to the same authoritative command
//     stream as a one-shot WorldRecorder.toJsonl().

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
import { replayWorldLog } from "../src/worldlog/replay.ts";
import { captureWorldState, compareWorldState, parseWorldLog, syncAllBodies } from "../src/worldlog/log.ts";
import { DurableWorldLog } from "../src/worldlog/durable.ts";

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error("p4_worldlog_durable: " + message);
}

const SEED = 0x0dec0de1;
const TICKS = 1400;
const STIR_COUNT = 3;
const DECISION_INTERVAL = 15;
const LOG_NAME = "p4_durable_worldlog.jsonl";
const CHECKPOINTS = [350, 700, 1050]; // mid-run reads that must parse as valid prefixes

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
    return { entities };
  },
};

function makeHeadlessWorld(worldOps: typeof ops): WorldContext {
  const ecs = createEcsWorld();
  const scene = { add() {}, remove() {}, position: { set() {}, x: 0, y: 0, z: 0 }, background: null as unknown };
  const camera = { position: { set() {} }, aspect: 1, lookAt() {}, updateProjectionMatrix() {} };
  return {
    ecs, transforms: createTransformStorage(ecs), spatial: new UniformGridSpatialIndex(),
    entities: new EntityTable(), tags: new Map(), scene, camera, ops: worldOps, mode: "headless",
  };
}

function makeReplayRegistry(tracer: LiminaTracer): SkillRegistry {
  const registry = new SkillRegistry(tracer);
  registerCoreSkills(registry);
  registry.register(scatter);
  return registry;
}

// ---- RECORD + STREAM ------------------------------------------------------
void new THREE.Mesh(new THREE.SphereGeometry(0.5, 24, 16), new THREE.MeshStandardNodeMaterial({ color: 0x808080 }));
void new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardNodeMaterial({ color: 0x808080 }));

const recTracer = new LiminaTracer("ses_p4_durable");
const registry = new SkillRegistry(recTracer);
registerCoreSkills(registry);
registry.register(scatter);

const recorder = new WorldRecorder("ses_p4_durable");
recorder.attach(registry);
recorder.seed(SEED);
const recOps = recorder.wrapOps(ops);
const world = makeHeadlessWorld(recOps);

const durable = new DurableWorldLog(recorder, LOG_NAME);
durable.open();
assert(ops.op_read_trace(LOG_NAME).length === 0, "open() did not truncate the log file");

const builderBase = {
  agentId: "limina:builder", sessionId: "ses_p4_durable",
  permissions: resolveProfile("builder.readWrite"), tick: 0, world,
};

recOps.op_physics_create_world(-9.81);
recOps.op_physics_add_ground(0);
recOps.op_physics_add_static_box(0, 0.75, 6.25, 8.5, 0.75, 0.25, 0.4, 0.4);
recOps.op_physics_add_static_box(0, 0.75, -6.25, 8.5, 0.75, 0.25, 0.4, 0.4);

const ballIds: { id: string; eid: number }[] = [];
let colorSeq = 0x3366cc;
for (let gz = -2; gz <= 2; gz++) {
  for (let gx = -1; gx <= 1; gx++) {
    const res = await registry.invoke("scene.createEntity", {
      shape: "sphere", collider: "sphere", size: 1.0,
      color: (colorSeq = (colorSeq + 0x1111) & 0xffffff),
      position: [gx * 2.2, 0.5, gz * 2.0], dynamic: true, friction: 0.3, restitution: 0.5,
    }, builderBase);
    assert(res.success === true, "bootstrap createEntity failed");
    const idResult = res.result;
    assert(idResult !== null && typeof idResult === "object" && "entity" in idResult, "createEntity result missing entity");
    const id = idResult.entity;
    assert(typeof id === "string", "entity id not a string");
    ballIds.push({ id, eid: world.entities.resolve(id)!.eid });
  }
}
for (let s = 0; s < 3; s++) {
  const r = await registry.invoke("scene.scatter", { count: 8, base: [0, 5 + s, 0], spread: 6 }, builderBase);
  assert(r.success === true, "scatter failed");
}

const agents = new AgentRegistry();
const scheduler = new AgentScheduler();
agents.add({
  id: "limina:agt_p1", type: "player", entityId: ballIds[0].id, perceptionRadius: 20,
  decisionIntervalTicks: DECISION_INTERVAL, profile: "player.limited", sessionId: "ses_p4_durable",
  llm: { provider: "prov_p1", model: "scripted", systemPrompt: "" },
});
agents.add({
  id: "limina:agt_b1", type: "builder", entityId: undefined, perceptionRadius: 20,
  decisionIntervalTicks: DECISION_INTERVAL, profile: "builder.readWrite", sessionId: "ses_p4_durable",
  llm: { provider: "prov_b1", model: "scripted", systemPrompt: "" },
});
let builderDecisions = 0;
const providers: ProviderMap = {
  prov_p1: new ScriptedProvider((_req: DecideRequest): MCPRequest[] => [
    { tool: "physics.applyImpulse", input: { entity: ballIds[0].id, impulse: [0.4, 0, 0.25] } },
  ]),
  prov_b1: new ScriptedProvider((_req: DecideRequest): MCPRequest[] => {
    const n = builderDecisions++;
    return [{
      tool: "scene.createEntity",
      input: { shape: "box", collider: "box", size: 0.5, color: 0x99cc44, position: [(n % 6) - 3, 0.3, 3.5], static: true },
    }];
  }),
};

const stir = ballIds.slice(0, STIR_COUNT);
const GAIN = 0.05;
const SWIRL = 0.02;
let prevPersistedBytes = 0;
let prevPersistedCount = 0;
let grewAtLeastOnce = false;
const checkpoints = new Set(CHECKPOINTS);

for (let tick = 1; tick <= TICKS; tick++) {
  recorder.tick = tick;
  perceptionSystem(agents, world, recTracer, tick);
  decisionSystem(agents, registry, providers, recTracer, tick, scheduler);
  for (let d = 0; d < 8; d++) await Promise.resolve();
  await actionSystem(agents, registry, world, tick, scheduler);
  for (const ball of stir) {
    const px = Position.x[ball.eid];
    const pz = Position.z[ball.eid];
    await registry.invoke("physics.applyImpulse", {
      entity: ball.id, impulse: [-GAIN * px - SWIRL * pz, 0, -GAIN * pz + SWIRL * px],
    }, builderBase);
  }
  recOps.op_physics_step();
  syncAllBodies(world);
  const flushed = durable.flush(); // segment append (M3)

  // SEGMENTED durability: the on-disk log strictly grows as commands occur, and
  // every mid-run read is a valid JSONL prefix of exactly the flushed commands
  // (no meta yet, no torn line) -- a fresh engine could reload a crash prefix.
  if (checkpoints.has(tick)) {
    const onDisk = ops.op_read_trace(LOG_NAME);
    assert(onDisk.length > prevPersistedBytes, `log did not grow by checkpoint tick ${tick}`);
    if (flushed > 0 || durable.persisted > prevPersistedCount) grewAtLeastOnce = true;
    const parsed = parseWorldLog(onDisk);
    assert(parsed.meta === undefined, "meta trailer appeared before close() -- not a streaming prefix");
    assert(parsed.commands.length === durable.persisted, `prefix parsed ${parsed.commands.length} commands, expected ${durable.persisted} persisted`);
    prevPersistedBytes = onDisk.length;
    prevPersistedCount = durable.persisted;
  }
}

const recordedState = captureWorldState(world);
const closed = durable.close();
const commandCount = recorder.commands.length;
assert(grewAtLeastOnce, "durable log never grew incrementally during the run");
assert(closed.commands === commandCount, "durable close command count mismatch");
assert(durable.pending === 0, "commands remained unflushed after close()");

// ---- RELOAD + REPLAY (fresh engine, disk-only) ----------------------------
const diskLog = ops.op_read_trace(LOG_NAME);
const parsedFull = parseWorldLog(diskLog);
assert(parsedFull.meta !== undefined, "closed durable log has no meta trailer");
assert(parsedFull.meta.commands === commandCount, `meta trailer commands ${parsedFull.meta.commands} != ${commandCount}`);
assert(parsedFull.commands.length === commandCount, `disk log parsed ${parsedFull.commands.length} commands, expected ${commandCount}`);

// EQUIVALENCE: the streamed segments carry the same authoritative command stream
// (same seqs/kinds) as a one-shot serialization.
const oneShot = parseWorldLog(recorder.toJsonl());
assert(oneShot.commands.length === parsedFull.commands.length, "streamed vs one-shot command count differ");
for (let i = 0; i < oneShot.commands.length; i++) {
  assert(oneShot.commands[i].seq === parsedFull.commands[i].seq, `seq mismatch at index ${i}`);
  assert(oneShot.commands[i].kind === parsedFull.commands[i].kind, `kind mismatch at index ${i}`);
}

const replayResult = await replayWorldLog(diskLog, {
  makeWorld: () => makeHeadlessWorld(ops),
  makeRegistry: (tracer: LiminaTracer) => makeReplayRegistry(tracer),
  tracer: new LiminaTracer("ses_p4_durable_replay"),
});
const cmp = compareWorldState(recordedState, replayResult.state);
assert(cmp.identical, `durable reload replay diverged (${cmp.comparisons} fields): ${cmp.detail ?? "?"}`);
assert(replayResult.commands === commandCount, "replay command count mismatch");

ops.op_log(
  `p4_worldlog_durable OK: ${commandCount} commands streamed to disk in per-tick segments over ${recorder.meta().ticks} ticks ` +
    `(checkpoints ${CHECKPOINTS.join(",")} parsed clean prefixes); reload+replay from disk BIT-IDENTICAL ` +
    `(${cmp.comparisons} fields, ${replayResult.state.entities.length} live entities); streamed == one-shot stream`,
);
