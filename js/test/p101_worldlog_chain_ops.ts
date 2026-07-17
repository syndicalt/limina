// p101 — CHAIN-TAGGED OPS RECORDING (adversarial-review fix C3).
//
// THE BUG THIS GATE PINS: the recorder used to classify a physics op by an ambient
// `depth` counter spanning a skill handler's whole ASYNC lifetime. A fixed-step
// loop calling `ctx.ops.op_physics_step()` while an async skill was in flight saw
// depth > 0 — the step was misclassified as in-skill and silently DROPPED from the
// log, so replay ran fewer steps than the live world (silent divergence).
//
// THE FIX UNDER TEST: the recording proxy ALWAYS records what reaches it; skills
// execute against a chain-scoped world facade whose `ops` never records (the skill
// command reproduces in-skill ops on re-invoke). Additionally, a mutating op
// reaching the recording proxy while any head chain is live emits the
// `worldlog.ops.recordedDuringChain` trace event (diagnosis, not behavior).
//
// PROOF SHAPE:
//   1. Async fixture skill held open by an externally-resolved promise; while it
//      is pending, the loop drives N top-level steps. EVERY applied step must land
//      in recorder.commands; replay of toJsonl() reproduces the step count and
//      compareWorldState is bit-identical; the tripwire event fired once per step.
//   2. FALSIFIABILITY: the SAME scenario against a depth-classified recorder shim
//      (the old classification, kept here as a test fixture) must FAIL the same
//      checks — steps missing from the log, replay diverging — proving this gate
//      detects the original bug.
//
// Run: LIMINA_AUDIO=null ./target/release/limina js/test/p101_worldlog_chain_ops.ts

import { z } from "../build/zod.bundle.mjs";
import { EntityTable, ops, type EngineOps } from "../src/engine.ts";
import { createEcsWorld } from "../src/ecs/world.ts";
import { createTransformStorage } from "../src/ecs/facade.ts";
import { UniformGridSpatialIndex } from "../src/spatial/index.ts";
import { LiminaTracer } from "../src/observability/event.ts";
import { SkillRegistry, type InvokeBase, type SkillDefinition, type WorldContext } from "../src/skills/registry.ts";
import { registerCoreSkills } from "../src/skills/index.ts";
import { resolveProfile } from "../src/skills/permissions.ts";
import { WorldRecorder } from "../src/worldlog/recorder.ts";
import { replayCommands, replayWorldLog } from "../src/worldlog/replay.ts";
import {
  captureWorldState,
  compareWorldState,
  installSeededRandom,
  PHYSICS_OP_OUT_BUFFER,
  RECORDED_PHYSICS_METHODS,
  syncAllBodies,
  type PhysicsCommand,
  type SkillCommand,
  type WorldCommand,
} from "../src/worldlog/log.ts";

function assert(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new Error("p101_worldlog_chain_ops FAIL: " + msg);
}

const SEED = 0xc3c3c3c3;
const STEPS = 20;
const PROFILE = "builder.readWrite";
const PERMS = resolveProfile(PROFILE);

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

// ── Fixture skill: an async handler held open by an EXTERNAL promise. ────────────
// It mutates nothing, so recording it at chain start replays soundly regardless of
// when the hold resolves; the interesting state is the STEPS applied while it is
// in flight. On replay the gate is unarmed, so the handler resolves immediately.
let holdGate: Promise<void> | undefined;
const holdSkill: SkillDefinition<{ label: string }, { held: boolean }> = {
  name: "test.holdChain",
  version: "1.0.0",
  description: "Async fixture: awaits an externally-resolved promise, mutates nothing.",
  category: "system",
  permissions: ["scene.write"],
  input: z.object({ label: z.string() }),
  output: z.object({ held: z.boolean() }),
  handler: async (_input) => {
    if (holdGate !== undefined) await holdGate;
    return { held: true };
  },
};

function makeRegistry(tracer: LiminaTracer): SkillRegistry {
  const registry = new SkillRegistry(tracer);
  registerCoreSkills(registry);
  registry.register(holdSkill);
  return registry;
}

function stepCount(commands: readonly WorldCommand[]): number {
  return commands.filter((c) => c.kind === "physics" && c.op === "step").length;
}

/** Drive the shared record scenario: bootstrap world+ground+ball, start the held
 *  chain, apply STEPS top-level steps while it is pending, then release it.
 *  Returns the dynamic sphere's native body id. */
async function runScenario(
  registry: SkillRegistry,
  recOps: EngineOps,
  world: WorldContext,
  setTick: (t: number) => void,
): Promise<number> {
  recOps.op_physics_create_world(-9.81);
  recOps.op_physics_add_ground(0);
  const sphereId = recOps.op_physics_add_sphere(0, 6, 0, 0.5, 0.4, 0.6); // dynamic: steps integrate real motion
  let release!: () => void;
  holdGate = new Promise<void>((resolve) => { release = resolve; });
  const base: InvokeBase = { agentId: "agt_p101", sessionId: "ses_p101", permissions: PERMS, profile: PROFILE, tick: 0, world };
  const inFlight = registry.invoke("test.holdChain", { label: "hold" }, base);
  for (let tick = 1; tick <= STEPS; tick++) {
    setTick(tick);
    recOps.op_physics_step();
    syncAllBodies(world);
  }
  release();
  holdGate = undefined;
  const res = await inFlight;
  assert(res.success === true, "held fixture skill failed");
  return sphereId;
}

// ═══════════════ 1. The FIXED recorder: every applied step is recorded. ══════════
const tracer = new LiminaTracer("ses_p101");
const registry = makeRegistry(tracer);
const recorder = new WorldRecorder("ses_p101");
recorder.attach(registry);
recorder.seed(SEED, { forceInstall: true });
const recOps = recorder.wrapOps(ops);
const world = makeWorld(recOps);
const sphereId = await runScenario(registry, recOps, world, (t) => { recorder.tick = t; });

const liveState = captureWorldState(world);
const recordedSteps = stepCount(recorder.commands);
assert(recordedSteps === STEPS, `every applied step must be recorded: ${recordedSteps} of ${STEPS} in the log`);
assert(recorder.count("skill") === 1, `expected 1 skill command, got ${recorder.count("skill")}`);

// The steps were not no-ops: the dynamic sphere actually fell while the chain was live.
const liveSphere = new Float32Array(7);
world.ops.op_physics_body_transform(sphereId, liveSphere);
assert(liveSphere[1] < 6, `the sphere must have fallen during the held chain (y=${liveSphere[1]})`);

// Tripwire: one recordedDuringChain event per step applied while the chain was live.
const tripwire = tracer.tail({ type: "worldlog.ops.recordedDuringChain" }).events;
assert(tripwire.length === STEPS, `expected ${STEPS} recordedDuringChain events, got ${tripwire.length}`);
for (const ev of tripwire) {
  const p = ev.payload as { op?: string; recorded?: boolean; liveChains?: string[] };
  assert(p.op === "step" && p.recorded === true, "tripwire payload must name the recorded op");
  assert(Array.isArray(p.liveChains) && p.liveChains.length === 1, "tripwire must carry the live chain id");
}

// Replay from the serialized log alone: same step count, bit-identical world.
const jsonl = recorder.toJsonl();
const replayed = await replayWorldLog(jsonl, {
  makeWorld: () => makeWorld(ops),
  makeRegistry,
  tracer: new LiminaTracer("ses_p101_replay"),
});
assert(replayed.steps === STEPS, `replay must reproduce the step count: ${replayed.steps} != ${STEPS}`);
const cmp = compareWorldState(liveState, replayed.state);
assert(cmp.identical, `replay diverged: ${cmp.detail ?? "?"}`);
// The sphere is a RAW body (never enters the entity table), so compareWorldState
// cannot see it — probe its native transform with the same bit-exact strictness.
{
  const replaySphere = new Float32Array(7);
  replayed.world.ops.op_physics_body_transform(sphereId, replaySphere);
  for (let i = 0; i < 7; i++) {
    assert(Object.is(liveSphere[i], replaySphere[i]), `replayed sphere transform[${i}] diverged: ${liveSphere[i]} vs ${replaySphere[i]}`);
  }
}

// In-skill ops still classify as in-skill (not double-recorded): a skill that adds
// a body must contribute NO physics command of its own.
{
  const before = recorder.commands.filter((c) => c.kind === "physics").length;
  const base: InvokeBase = { agentId: "agt_p101", sessionId: "ses_p101", permissions: PERMS, profile: PROFILE, tick: STEPS, world };
  const res = await registry.invoke("scene.createEntity", { shape: "box", collider: "box", size: 0.5, position: [4, 0.25, 4] }, base);
  assert(res.success === true, "scene.createEntity failed");
  const after = recorder.commands.filter((c) => c.kind === "physics").length;
  assert(after === before, "an in-skill physics op leaked into the log as a raw physics command (double-record)");
  assert(recorder.count("skill") === 2, "the skill command itself must be recorded");
}

// The facade preserves WORLD IDENTITY per world: two chains see the same ctx.world
// object (WeakMap-keyed skill caches depend on it) — proven via a probe skill.
{
  const seen: unknown[] = [];
  registry.register({
    name: "test.worldIdentity", version: "1.0.0", description: "captures ctx.world identity",
    category: "system", permissions: ["scene.write"],
    input: z.object({}), output: z.object({ ok: z.boolean() }),
    handler: (_i, ctx) => { seen.push(ctx.world); return { ok: true }; },
  } as SkillDefinition<Record<string, never>, { ok: boolean }>);
  const base: InvokeBase = { agentId: "agt_p101", sessionId: "ses_p101", permissions: PERMS, profile: PROFILE, tick: STEPS, world };
  assert((await registry.invoke("test.worldIdentity", {}, base)).success === true, "identity probe 1 failed");
  assert((await registry.invoke("test.worldIdentity", {}, base)).success === true, "identity probe 2 failed");
  assert(seen.length === 2 && seen[0] === seen[1], "chain world facade identity must be stable across chains");
  assert(seen[0] !== world, "skills must NOT execute against the raw recording world");
}

// ═══════════════ 2. FALSIFIABILITY: the OLD depth classification fails these checks. ═══
// A minimal reconstruction of the pre-fix recorder: one ambient depth counter
// spanning each handler's async lifetime; the ops proxy records iff depth === 0.
class DepthClassifiedRecorder {
  readonly commands: WorldCommand[] = [];
  tick = 0;
  private seq = 0;
  private depth = 0;
  seed(seed: number): void {
    this.commands.push({ kind: "seed", seq: this.seq++, seed: seed >>> 0 });
    installSeededRandom(seed, true);
  }
  wrapOps(target: EngineOps): EngineOps {
    const rec = this;
    return new Proxy(target, {
      get(t, prop, receiver) {
        const value = Reflect.get(t, prop, receiver);
        if (typeof value !== "function") return value;
        const method = value as (...a: number[]) => unknown;
        const opName = typeof prop === "string" ? RECORDED_PHYSICS_METHODS[prop] : undefined;
        if (opName === undefined) return method.bind(t);
        return (...args: number[]): unknown => {
          if (rec.depth === 0) {
            const args2 = PHYSICS_OP_OUT_BUFFER[opName] === undefined ? args.slice() : args.slice(0, args.length - 1);
            const cmd: PhysicsCommand = { kind: "physics", seq: rec.seq++, tick: rec.tick, op: opName, args: args2 };
            rec.commands.push(cmd);
          }
          return method.apply(t, args);
        };
      },
    });
  }
  attach(registry: SkillRegistry): void {
    const rec = this;
    const original = registry.invoke.bind(registry);
    registry.invoke = function patched(name, input, base) {
      const isHead = base.chainId === undefined;
      const chainId = base.chainId ?? `old_chain_${rec.seq}`;
      if (isHead) {
        const cmd: SkillCommand = {
          kind: "skill", seq: rec.seq++, tick: base.tick, tool: name, input,
          actorId: base.agentId, sessionId: base.sessionId, perms: [...base.permissions].sort(),
        };
        rec.commands.push(cmd);
      }
      ++rec.depth;
      return original(name, input, { ...base, chainId }).finally(() => { --rec.depth; });
    };
  }
}

const oldTracer = new LiminaTracer("ses_p101_old");
const oldRegistry = makeRegistry(oldTracer);
const oldRecorder = new DepthClassifiedRecorder();
oldRecorder.attach(oldRegistry);
oldRecorder.seed(SEED);
const oldOps = oldRecorder.wrapOps(ops);
const oldWorld = makeWorld(oldOps);
const oldSphereId = await runScenario(oldRegistry, oldOps, oldWorld, (t) => { oldRecorder.tick = t; });
// Read the live sphere transform BEFORE replay: replay's create_world resets the
// one shared native physics world, destroying the live run's state.
const liveBody = new Float32Array(7);
oldWorld.ops.op_physics_body_transform(oldSphereId, liveBody);

// Check (a) FAILS: the steps applied under the in-flight chain are missing.
const oldSteps = stepCount(oldRecorder.commands);
assert(oldSteps === 0, `old classification must DROP the in-chain steps (recorded ${oldSteps}, expected 0)`);
assert(oldSteps !== STEPS, "old classification unexpectedly recorded every step — the falsifiability probe is dead");

// Check (b) FAILS: replay of the depth-classified log diverges from the live run.
const oldReplayed = await replayCommands(oldRecorder.commands, {
  makeWorld: () => makeWorld(ops),
  makeRegistry,
  tracer: new LiminaTracer("ses_p101_old_replay"),
});
assert(oldReplayed.steps !== STEPS, "old-classification replay must reproduce FEWER steps than were applied");
// The dynamic sphere fell for 20 steps live but 0 steps on replay: the native body
// transforms diverge. compareWorldState only walks table entities (none here), so
// probe the body transform directly with the same bit-exact strictness.
const replayBody = new Float32Array(7);
oldReplayed.world.ops.op_physics_body_transform(oldSphereId, replayBody);
let bodyDiverged = false;
for (let i = 0; i < 7; i++) if (!Object.is(liveBody[i], replayBody[i])) bodyDiverged = true;
assert(bodyDiverged, "old-classification replay must diverge from the live world (the sphere never fell on replay)");

ops.op_log(
  `p101_worldlog_chain_ops OK: ${STEPS}/${STEPS} steps recorded under an in-flight async chain, ` +
    `replay bit-identical (${cmp.comparisons} fields), ${tripwire.length} recordedDuringChain tripwire events, ` +
    `in-skill ops not double-recorded, world-facade identity stable; ` +
    `depth-classified shim FAILED as required (recorded ${oldSteps}/${STEPS} steps, replay diverged).`,
);
