// P4 / M2 -- snapshots + delta log + restart recovery (headless, falsifiable).
//
// Records a real running session's AUTHORITATIVE command stream (scene creation,
// ECS mutations, native physics inputs/steps, a deterministic RNG seed, agent
// actions, and seeded scene.scatter calls), STREAMING it to disk incrementally
// (M3 durable sink) while taking periodic full-world SNAPSHOTS at tick
// boundaries (configurable cadence). Each snapshot captures the real native
// Rapier physics state (op_physics_snapshot), every live entity's ECS transform,
// the entity-identity allocators (entity table + bitECS index), and the seeded
// RNG's internal state.
//
// Then it simulates a KILL (discards the live world) and RECOVERS from the
// persisted snapshot + delta on DISK ALONE: restore the snapshot at tick T, then
// replay ONLY the commands with seq >= snapshotSeq (a real mid-stream resume --
// NOT a genesis replay). The recovered final state must be BIT-IDENTICAL to the
// pre-kill state, recovery must complete in <= 2 s for a >=10k-event world, and
// it must be measurably faster than replaying from genesis. Falsifiability is
// proven: perturbing the persisted snapshot (a restored transform, the native
// physics blob, or the RNG state) MUST make recovery diverge.

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
import {
  base64ToBytes,
  bytesToBase64,
  captureWorldSnapshot,
  deltaCommandsAfter,
  parseSnapshot,
  recoverWorld,
  serializeSnapshot,
  type WorldSnapshot,
} from "../src/worldlog/snapshot.ts";

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error("p4_snapshot_recovery: " + message);
}

// ---- Tunables -------------------------------------------------------------
const SEED = 0x51a7c0de;
const TICKS = 3050; // >= 3000
const STIR_COUNT = 3;
const DECISION_INTERVAL = 15;
const SNAPSHOT_INTERVAL = 500; // snapshot cadence (configurable)
const SCATTER_INTERVAL = 500; // periodic RNG-consuming scatter (makes RNG state load-bearing in the delta)
const LOG_NAME = "p4_recovery_worldlog.jsonl";
const SNAP_LATE_NAME = "p4_recovery_snapshot_late.json"; // latest snapshot before the kill
const SNAP_MID_NAME = "p4_recovery_snapshot_mid.json"; // an earlier snapshot (bigger delta)
const MID_SNAPSHOT_TICK = 1000;

// ---- Scenario skill: scene.scatter (RNG-consuming) ------------------------
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
  registry.register(scatter);
  return registry;
}

// ===========================================================================
// PHASE 1 -- RECORD a real session (streaming to disk + periodic snapshots).
// ===========================================================================

// Warm up THREE so one-time lazy init draws on the DEFAULT rng before seeding.
void new THREE.Mesh(new THREE.SphereGeometry(0.5, 24, 16), new THREE.MeshStandardNodeMaterial({ color: 0x808080 }));
void new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardNodeMaterial({ color: 0x808080 }));

const recTracer = new LiminaTracer("ses_p4_recovery");
const registry = new SkillRegistry(recTracer);
registerCoreSkills(registry);
registry.register(scatter);

const recorder = new WorldRecorder("ses_p4_recovery");
recorder.attach(registry);
recorder.seed(SEED);
const recOps = recorder.wrapOps(ops);
const world = makeHeadlessWorld(recOps);

const durable = new DurableWorldLog(recorder, LOG_NAME);
durable.open();

const builderBase = {
  agentId: "limina:builder",
  sessionId: "ses_p4_recovery",
  permissions: resolveProfile("builder.readWrite"),
  tick: 0,
  world,
};

// Bootstrap: world + ground + 4 static rails (raw physics ops).
recOps.op_physics_create_world(-9.81);
recOps.op_physics_add_ground(0);
const RAIL_HX = 8;
const RAIL_HZ = 6;
recOps.op_physics_add_static_box(0, 0.75, RAIL_HZ + 0.25, RAIL_HX + 0.5, 0.75, 0.25, 0.4, 0.4);
recOps.op_physics_add_static_box(0, 0.75, -(RAIL_HZ + 0.25), RAIL_HX + 0.5, 0.75, 0.25, 0.4, 0.4);
recOps.op_physics_add_static_box(RAIL_HX + 0.25, 0.75, 0, 0.25, 0.75, RAIL_HZ + 0.5, 0.4, 0.4);
recOps.op_physics_add_static_box(-(RAIL_HX + 0.25), 0.75, 0, 0.25, 0.75, RAIL_HZ + 0.5, 0.4, 0.4);

// Dynamic spheres in a grid (scene.createEntity skill).
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
    const entry = world.entities.resolve(id);
    assert(entry !== undefined, "created entity not resolvable");
    ballIds.push({ id, eid: entry.eid });
  }
}
assert(ballIds.length >= STIR_COUNT, "not enough balls to stir");

// Seeded scatter at bootstrap (pure-ECS markers; positions depend on the seed).
for (let s = 0; s < 3; s++) {
  const r = await registry.invoke("scene.scatter", { count: 8, base: [0, 5 + s, 0], spread: 6 }, builderBase);
  assert(r.success === true, "scatter failed");
}
const scatterProbe = world.entities.ids().find((id) => world.entities.resolve(id)?.bodyId === undefined);
assert(scatterProbe !== undefined, "expected a body-less scatter entity to mutate via ECS");

await registry.invoke("ecs.updateComponent", { entity: scatterProbe, component: "scale", value: [2, 0.5, 1.5] }, builderBase);
await registry.invoke("ecs.updateComponent", { entity: scatterProbe, component: "rotation", value: [0, 0.3826834, 0, 0.9238795] }, builderBase);

// ---- Agents: 2 scripted players + 1 scripted builder ----------------------
const agents = new AgentRegistry();
const scheduler = new AgentScheduler();
agents.add({
  id: "limina:agt_p1", type: "player", entityId: ballIds[0].id, perceptionRadius: 20,
  decisionIntervalTicks: DECISION_INTERVAL, profile: "player.limited", sessionId: "ses_p4_recovery",
  llm: { provider: "prov_p1", model: "scripted", systemPrompt: "" },
});
agents.add({
  id: "limina:agt_p2", type: "player", entityId: ballIds[1].id, perceptionRadius: 20,
  decisionIntervalTicks: DECISION_INTERVAL, profile: "player.limited", sessionId: "ses_p4_recovery",
  llm: { provider: "prov_p2", model: "scripted", systemPrompt: "" },
});
agents.add({
  id: "limina:agt_b1", type: "builder", entityId: undefined, perceptionRadius: 20,
  decisionIntervalTicks: DECISION_INTERVAL, profile: "builder.readWrite", sessionId: "ses_p4_recovery",
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

// ---- Per-tick loop (record): systems -> stir -> scatter -> step -> sync ----
// Persist snapshots at cadence boundaries; the LATEST one (and the chosen MID
// one) are written to disk for recovery. scatterSeq makes scatter base points
// vary so successive scatters differ.
const stir = ballIds.slice(0, STIR_COUNT);
const GAIN = 0.05;
const SWIRL = 0.02;
let scatterSeq = 0;
let lateSnapshotTick = 0;
let lateSnapshotSeq = 0;

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
  // Periodic seeded scatter -> the delta replay must re-draw Math.random from the
  // restored RNG state, making the RNG state genuinely load-bearing on recovery.
  if (tick % SCATTER_INTERVAL === 0) {
    const k = scatterSeq++;
    await registry.invoke("scene.scatter", { count: 4, base: [k * 0.1, 8 + k, -2], spread: 5 }, builderBase);
  }
  recOps.op_physics_step();
  syncAllBodies(world);
  durable.flush(); // stream this tick's commands to disk as they occur (M3)

  // Snapshot at cadence boundaries (after step+sync, at the tick boundary).
  if (tick % SNAPSHOT_INTERVAL === 0) {
    const snap = captureWorldSnapshot(world, {
      sessionId: "ses_p4_recovery", tick, snapshotSeq: recorder.commands.length,
    });
    ops.op_write_trace(SNAP_LATE_NAME, serializeSnapshot(snap)); // overwrite -> "latest"
    lateSnapshotTick = tick;
    lateSnapshotSeq = snap.snapshotSeq;
    if (tick === MID_SNAPSHOT_TICK) {
      ops.op_write_trace(SNAP_MID_NAME, serializeSnapshot(snap));
    }
  }
}

const recordedState = captureWorldState(world);
const durableClose = durable.close();
const commandCount = recorder.commands.length;
const skillCmds = recorder.count("skill");
const physicsCmds = recorder.count("physics");

assert(commandCount >= 10000, `expected >= 10000 world-log commands, got ${commandCount}`);
assert(recorder.meta().ticks >= 3000, `expected >= 3000 ticks, got ${recorder.meta().ticks}`);
assert(durableClose.commands === commandCount, "durable sink command count mismatch");
assert(lateSnapshotTick > 0 && lateSnapshotTick < TICKS, `late snapshot tick ${lateSnapshotTick} not mid-stream`);

// ===========================================================================
// PHASE 2 -- KILL + RECOVER from the persisted snapshot + delta on DISK ALONE.
// ===========================================================================
// We touch NOTHING from the live run below except `recordedState` (the pre-kill
// ground truth to compare against) -- exactly the M1 anti-hack discipline.

const replayDeps = {
  makeWorld: () => makeHeadlessWorld(ops),
  makeRegistry: (tracer: LiminaTracer) => makeReplayRegistry(tracer),
};

// Read the FULL authoritative log + the latest snapshot back from disk.
const diskLog = ops.op_read_trace(LOG_NAME);
const allCommands = parseWorldLog(diskLog).commands;
assert(allCommands.length === commandCount, `disk log has ${allCommands.length} commands, expected ${commandCount}`);

const lateSnap = parseSnapshot(ops.op_read_trace(SNAP_LATE_NAME));
assert(lateSnap.snapshotSeq === lateSnapshotSeq, "persisted late snapshot seq mismatch");
const lateDelta = deltaCommandsAfter(allCommands, lateSnap.snapshotSeq);
assert(lateDelta.length > 0 && lateDelta.length < commandCount, "late delta must be a strict mid-stream tail");

const t0 = Date.now();
const recovered = await recoverWorld(lateSnap, lateDelta, { ...replayDeps, tracer: new LiminaTracer("ses_p4_recover_late") });
const recoveryMs = Date.now() - t0;

const cmp = compareWorldState(recordedState, recovered.state);
assert(cmp.identical, `recovery diverged from pre-kill state (${cmp.comparisons} fields): ${cmp.detail ?? "?"}`);
assert(recoveryMs <= 2000, `recovery took ${recoveryMs}ms (> 2000ms) for a ${commandCount}-event world`);

// Real mid-stream resume: the delta replayed ONLY the steps after the snapshot
// tick, NOT all TICKS. (Genesis replay would step TICKS times.)
const expectedDeltaSteps = TICKS - lateSnap.tick;
assert(recovered.deltaSteps === expectedDeltaSteps, `delta stepped ${recovered.deltaSteps}, expected ${expectedDeltaSteps} (mid-stream resume)`);
assert(recovered.deltaSteps < TICKS, "recovery replayed from genesis, not mid-stream");

// Contrast: recovery must be faster than replaying the whole log from genesis.
const g0 = Date.now();
const genesis = await replayWorldLog(diskLog, { ...replayDeps, tracer: new LiminaTracer("ses_p4_genesis") });
const genesisMs = Date.now() - g0;
assert(compareWorldState(recordedState, genesis.state).identical, "genesis replay diverged (control)");
assert(recoveryMs <= genesisMs, `recovery (${recoveryMs}ms) not faster than genesis replay (${genesisMs}ms)`);

// Recovery from an EARLIER snapshot (bigger delta) is ALSO bit-identical + <=2s.
const midSnap = parseSnapshot(ops.op_read_trace(SNAP_MID_NAME));
const midDelta = deltaCommandsAfter(allCommands, midSnap.snapshotSeq);
const m0 = Date.now();
const recoveredMid = await recoverWorld(midSnap, midDelta, { ...replayDeps, tracer: new LiminaTracer("ses_p4_recover_mid") });
const midMs = Date.now() - m0;
assert(compareWorldState(recordedState, recoveredMid.state).identical, "recovery from the mid snapshot diverged");
assert(midMs <= 2000, `mid-snapshot recovery took ${midMs}ms (> 2000ms)`);
assert(recoveredMid.deltaSteps === TICKS - midSnap.tick, "mid recovery delta step count wrong");

// ===========================================================================
// PHASE 3 -- FALSIFIABILITY: perturb the persisted snapshot -> MUST diverge.
// ===========================================================================
// (A) Tamper a restored ECS transform (scale is never rewritten by the delta).
const perturbA: WorldSnapshot = JSON.parse(serializeSnapshot(lateSnap));
perturbA.entities[0].scale = [perturbA.entities[0].scale[0] + 0.5, 1, 1];
const recA = await recoverWorld(perturbA, lateDelta, { ...replayDeps, tracer: new LiminaTracer("ses_p4_perturbA") });
const cmpA = compareWorldState(recordedState, recA.state);
assert(!cmpA.identical, "perturbing a restored transform did NOT diverge -- snapshot ECS state is not load-bearing");

// (B) Tamper the native physics blob: advance it one extra step before recovery.
// (Restore the genuine blob, step once, re-snapshot -> a physically-wrong start.)
ops.op_physics_restore(base64ToBytes(lateSnap.physics));
ops.op_physics_step();
const wrongPhysics = bytesToBase64(ops.op_physics_snapshot());
const perturbB: WorldSnapshot = JSON.parse(serializeSnapshot(lateSnap));
perturbB.physics = wrongPhysics;
const recB = await recoverWorld(perturbB, lateDelta, { ...replayDeps, tracer: new LiminaTracer("ses_p4_perturbB") });
const cmpB = compareWorldState(recordedState, recB.state);
assert(!cmpB.identical, "perturbing the native physics blob did NOT diverge -- physics restore is not load-bearing");

// (C) Tamper the RNG state -- applied to the MID snapshot, whose delta replays
// seeded scene.scatter calls (the late delta, ticks 3001-3050, draws no RNG by
// cadence). The post-snapshot scatter draws must change, so the marker positions
// they produce diverge -- proving the RNG internal state is load-bearing.
const perturbC: WorldSnapshot = JSON.parse(serializeSnapshot(midSnap));
perturbC.rngState = (midSnap.rngState ^ 0x9e3779b9) >>> 0;
const recC = await recoverWorld(perturbC, midDelta, { ...replayDeps, tracer: new LiminaTracer("ses_p4_perturbC") });
const cmpC = compareWorldState(recordedState, recC.state);
assert(!cmpC.identical, "perturbing the RNG state did NOT diverge -- RNG state is not load-bearing in the delta");

// A clean re-recovery after the perturbation runs is STILL bit-identical.
const recheck = await recoverWorld(lateSnap, lateDelta, { ...replayDeps, tracer: new LiminaTracer("ses_p4_recheck") });
assert(compareWorldState(recordedState, recheck.state).identical, "clean re-recovery diverged after perturbation runs");

ops.op_log(
  `p4_snapshot_recovery OK: ${commandCount} commands (${skillCmds} skill, ${physicsCmds} physics) over ${recorder.meta().ticks} ticks, ` +
    `streamed to disk in ${durableClose.commands} cmds; recovered from disk snapshot@tick${lateSnap.tick}+delta(${lateDelta.length} cmds, ` +
    `${recovered.deltaSteps} steps) BIT-IDENTICAL (${cmp.comparisons} fields, ${recovered.state.entities.length} live entities) in ${recoveryMs}ms ` +
    `(<=2000ms; genesis replay ${genesisMs}ms); mid snapshot@tick${midSnap.tick} also identical in ${midMs}ms (${midDelta.length}-cmd delta); ` +
    `falsified: transform[${cmpA.detail ?? "?"}] physics[${cmpB.detail ?? "?"}] rng[${cmpC.detail ?? "?"}]`,
);
