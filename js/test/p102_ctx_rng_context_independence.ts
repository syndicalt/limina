// p102 — CTX-OWNED SKILL RNG: context independence (adversarial-review fix M4).
//
// THE BUG THIS GATE PINS: skills used to draw from the ONE global seeded
// Math.random stream — the same stream three.js consumes for UUID generation
// whenever a mesh is created, i.e. only in RENDER-CAPABLE contexts. The stream
// position at any tick (and every skill draw, and the snapshot's rngState) was
// therefore a function of WHICH CONTEXT ran, not of the command stream.
//
// THE FIX UNDER TEST: the seed installs TWO streams — the global Math.random slot
// (byte-identical to before, for three/legacy consumers) and a world-owned skill
// stream (`world.rng`, seed ^ SKILL_RNG_SEED_XOR) that skill handlers draw from.
//
// PROOF SHAPE:
//   1. The same command stream runs twice — plain, and with interleaved GLOBAL
//      stream consumption between commands (Math.random draws simulating three's
//      render-context UUID draws). Skill outputs, world state, and the captured
//      skill-stream state must be IDENTICAL across both runs (while the global
//      stream states demonstrably diverged).
//   2. FALSIFIABILITY: the same probe against a fixture skill drawing from the
//      GLOBAL stream must SHOW divergence — proving the interleaved consumption
//      actually perturbs the stream the gate guards against.
//   3. Mid-stream snapshot -> recoverWorld resumes the skill stream bit-identically
//      (WorldSnapshot.skillRngState), and a snapshot with the field STRIPPED (a
//      pre-change v3 snapshot) restores by seeding the skill stream from the
//      legacy rngState — the additive-optional back-compat rule.
//
// Run: LIMINA_AUDIO=null ./target/release/limina js/test/p102_ctx_rng_context_independence.ts

import { z } from "../build/zod.bundle.mjs";
import { EntityTable, ops, type EngineOps } from "../src/engine.ts";
import { createEcsWorld, spawnRenderable } from "../src/ecs/world.ts";
import { createTransformStorage } from "../src/ecs/facade.ts";
import { UniformGridSpatialIndex } from "../src/spatial/index.ts";
import { LiminaTracer } from "../src/observability/event.ts";
import { SkillRegistry, type ExecutionContext, type InvokeBase, type SkillDefinition, type WorldContext } from "../src/skills/registry.ts";
import { registerCoreSkills } from "../src/skills/index.ts";
import { resolveProfile } from "../src/skills/permissions.ts";
import { WorldRecorder } from "../src/worldlog/recorder.ts";
import {
  captureWorldState,
  compareWorldState,
  getInstalledRng,
  getInstalledSkillRng,
  type WorldCommand,
  type WorldStateSnapshot,
} from "../src/worldlog/log.ts";
import {
  captureWorldSnapshot,
  deltaCommandsAfter,
  parseSnapshot,
  recoverWorld,
  restoreSnapshot,
  serializeSnapshot,
} from "../src/worldlog/snapshot.ts";

function assert(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new Error("p102_ctx_rng_context_independence FAIL: " + msg);
}

const SEED = 0x4d4d4d4d;
const PROFILE = "builder.readWrite";
const PERMS = resolveProfile(PROFILE);
const CONTAMINATION_DRAWS = 7; // global-stream draws between commands (simulated three UUID draws)

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

// ── Fixture skills: identical shape, different randomness source. ────────────────
// test.rngScatter draws from the world-owned skill stream (the fix under test);
// test.globalScatter draws from the global Math.random stream (the falsifiability
// probe — the OLD behavior, which the interleaved consumption must perturb).
const scatterInput = z.object({ count: z.number().int().min(1).max(16), base: z.tuple([z.number(), z.number(), z.number()]) });
const scatterOutput = z.object({ entities: z.array(z.string()), draws: z.array(z.number()) });
type ScatterIn = z.infer<typeof scatterInput>;
type ScatterOut = z.infer<typeof scatterOutput>;

function scatterHandler(next: () => number, input: ScatterIn, ctx: ExecutionContext): ScatterOut {
  const entities: string[] = [];
  const draws: number[] = [];
  for (let i = 0; i < input.count; i++) {
    const x = input.base[0] + (next() - 0.5) * 10;
    const y = input.base[1] + (next() - 0.5) * 10;
    const zz = input.base[2] + (next() - 0.5) * 10;
    const obj = { position: { set() {} }, quaternion: { set() {} }, scale: { set() {} } };
    const eid = spawnRenderable(ctx.world.ecs, obj, x, y, zz);
    entities.push(ctx.world.entities.create({ eid }));
    draws.push(x, y, zz);
  }
  return { entities, draws };
}

const rngScatter: SkillDefinition<ScatterIn, ScatterOut> = {
  name: "test.rngScatter",
  version: "1.0.0",
  description: "Spawn N markers at offsets drawn from the world-owned skill RNG stream (ctx.world.rng).",
  category: "scene",
  permissions: ["scene.write"],
  input: scatterInput,
  output: scatterOutput,
  handler: (input, ctx) => {
    const rng = ctx.world.rng;
    if (rng === undefined) throw new Error("test.rngScatter: world has no skill RNG stream");
    return scatterHandler(rng.next, input, ctx);
  },
};

const globalScatter: SkillDefinition<ScatterIn, ScatterOut> = {
  name: "test.globalScatter",
  version: "1.0.0",
  description: "Spawn N markers at offsets drawn from the GLOBAL Math.random stream (the M4 bug).",
  category: "scene",
  permissions: ["scene.write"],
  input: scatterInput,
  output: scatterOutput,
  handler: (input, ctx) => scatterHandler(Math.random, input, ctx),
};

function makeRegistry(tracer: LiminaTracer): SkillRegistry {
  const registry = new SkillRegistry(tracer);
  registerCoreSkills(registry);
  registry.register(rngScatter);
  registry.register(globalScatter);
  return registry;
}

interface StreamRun {
  outputs: number[][];
  skillState: number;
  globalState: number;
  state: WorldStateSnapshot;
}

/** Record the SAME 3-command stream through `skillName`; when `contaminate`, draw
 *  from the global Math.random stream between commands (what a render context's
 *  mesh-creating three.js calls do). */
async function runStream(skillName: string, contaminate: boolean, session: string): Promise<StreamRun> {
  const registry = makeRegistry(new LiminaTracer(session));
  const recorder = new WorldRecorder(session);
  recorder.attach(registry);
  recorder.seed(SEED, { forceInstall: true });
  const recOps = recorder.wrapOps(ops);
  const world = makeWorld(recOps);
  world.rng = getInstalledSkillRng();
  recOps.op_physics_create_world(-9.81);
  const base: InvokeBase = { agentId: "agt_p102", sessionId: session, permissions: PERMS, profile: PROFILE, tick: 0, world };
  const outputs: number[][] = [];
  for (let i = 0; i < 3; i++) {
    if (contaminate) for (let d = 0; d < CONTAMINATION_DRAWS; d++) Math.random();
    const res = await registry.invoke(skillName, { count: 4, base: [i * 2, 1, 0] }, base);
    assert(res.success === true, `${skillName} invoke ${i} failed`);
    outputs.push((res.result as ScatterOut).draws);
  }
  assert(world.rng !== undefined, "seeded world must carry the skill stream");
  const globalRng = getInstalledRng();
  assert(globalRng !== undefined, "global stream must be installed");
  return {
    outputs,
    skillState: world.rng.getState(),
    globalState: globalRng.getState(),
    state: captureWorldState(world),
  };
}

function drawsEqual(a: number[][], b: number[][]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].length !== b[i].length) return false;
    for (let j = 0; j < a[i].length; j++) if (!Object.is(a[i][j], b[i][j])) return false;
  }
  return true;
}

// ═══════ 1. Skill-stream draws are independent of global-stream consumption. ══════
const plain = await runStream("test.rngScatter", false, "ses_p102_plain");
const contaminated = await runStream("test.rngScatter", true, "ses_p102_contam");
assert(drawsEqual(plain.outputs, contaminated.outputs), "skill outputs must be identical under interleaved global-stream consumption");
assert(plain.skillState === contaminated.skillState, `captured skill-stream state must be identical (${plain.skillState} vs ${contaminated.skillState})`);
const stateCmp = compareWorldState(plain.state, contaminated.state);
assert(stateCmp.identical, `world state diverged under global-stream contamination: ${stateCmp.detail ?? "?"}`);
// Sanity that the probe is live: the contamination genuinely moved the global stream.
assert(plain.globalState !== contaminated.globalState, "contamination did not move the global stream — the probe is dead");

// ═══════ 2. FALSIFIABILITY: the same probe against the GLOBAL stream diverges. ════
const plainGlobal = await runStream("test.globalScatter", false, "ses_p102_gplain");
const contaminatedGlobal = await runStream("test.globalScatter", true, "ses_p102_gcontam");
assert(!drawsEqual(plainGlobal.outputs, contaminatedGlobal.outputs), "global-stream skill draws did NOT diverge under contamination — the gate measures nothing");

// ═══════ 3. Mid-stream snapshot: recoverWorld resumes the skill stream exactly. ═══
{
  const session = "ses_p102_snap";
  const registry = makeRegistry(new LiminaTracer(session));
  const recorder = new WorldRecorder(session);
  recorder.attach(registry);
  recorder.seed(SEED, { forceInstall: true });
  const recOps = recorder.wrapOps(ops);
  const world = makeWorld(recOps);
  world.rng = getInstalledSkillRng();
  recOps.op_physics_create_world(-9.81);
  const base: InvokeBase = { agentId: "agt_p102", sessionId: session, permissions: PERMS, profile: PROFILE, tick: 0, world };
  for (let i = 0; i < 2; i++) {
    assert((await registry.invoke("test.rngScatter", { count: 4, base: [i, 1, 0] }, base)).success === true, "pre-snapshot invoke failed");
  }
  const snapshot = captureWorldSnapshot(world, { sessionId: session, tick: 0, snapshotSeq: recorder.flushableCount() });
  assert(snapshot.skillRngState === world.rng!.getState(), "snapshot must capture the skill stream state");
  assert(snapshot.skillRngState !== snapshot.rngState, "skill and global streams must be distinct streams (states coincided)");
  // Post-snapshot delta: contaminate the GLOBAL stream, then two more skill draws.
  for (let d = 0; d < CONTAMINATION_DRAWS; d++) Math.random();
  for (let i = 2; i < 4; i++) {
    assert((await registry.invoke("test.rngScatter", { count: 4, base: [i, 1, 0] }, base)).success === true, "post-snapshot invoke failed");
  }
  const finalLive = captureWorldState(world);
  const finalSkillState = world.rng!.getState();
  const delta: WorldCommand[] = deltaCommandsAfter(recorder.commands, snapshot.snapshotSeq);
  assert(delta.length === 2, `expected 2 delta commands, got ${delta.length}`);

  // Round-trip the snapshot through its serialized form (the persisted-boundary path).
  const parsed = parseSnapshot(serializeSnapshot(snapshot));
  const recovery = await recoverWorld(parsed, delta, {
    makeWorld: () => makeWorld(ops),
    makeRegistry,
    tracer: new LiminaTracer("ses_p102_recover"),
  });
  const recCmp = compareWorldState(finalLive, recovery.state);
  assert(recCmp.identical, `recovery diverged from the live run: ${recCmp.detail ?? "?"}`);
  assert(recovery.world.rng !== undefined, "recovered world must carry the skill stream");
  assert(recovery.world.rng.getState() === finalSkillState, "recovered skill-stream state must resume bit-identically");

  // Back-compat: a v3 snapshot WITHOUT skillRngState (pre-change) seeds the skill
  // stream from the legacy global rngState — the additive-optional rule.
  const legacyJson = JSON.parse(serializeSnapshot(snapshot)) as Record<string, unknown>;
  delete legacyJson.skillRngState;
  const legacy = parseSnapshot(JSON.stringify(legacyJson));
  assert(legacy.skillRngState === undefined, "stripped snapshot must parse with the field absent");
  const legacyWorld = makeWorld(ops);
  restoreSnapshot(legacyWorld, legacy);
  assert(legacyWorld.rng !== undefined, "legacy restore must still install a skill stream");
  assert(legacyWorld.rng.getState() === legacy.rngState, "legacy restore must seed the skill stream from the legacy rngState");
}

ops.op_log(
  "p102_ctx_rng_context_independence OK: skill draws + skill-stream state identical under interleaved " +
    "global-stream consumption (global stream demonstrably moved); global-stream probe DIVERGED as required; " +
    "mid-stream snapshot recovery resumes the skill stream bit-identically; stripped-field v3 snapshot " +
    "restores from the legacy rngState.",
);
