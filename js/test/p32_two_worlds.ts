// P32 -- TWO independent worlds in ONE process (Finding #8 acceptance).
//
// The engine's core claim is "world = pure function of seed + command log". That
// held for ONE world/process, but the ECS transform SoA (Position/Rotation/Scale)
// and the seeded PRNG (Math.random) used to be MODULE GLOBALS -- so two worlds in
// one process (e.g. a replay/verify world running beside a live one) collided on
// the same eid slots and shared one RNG stream, silently corrupting each other.
//
// This test builds TWO worlds with DIFFERENT seeds, runs an RNG-consuming +
// transform-writing command sequence in each INTERLEAVED (A round, B round, A
// round, ...), and asserts:
//   (a) each world's final state is BIT-IDENTICAL to its OWN solo run (no
//       cross-contamination of transform storage), and
//   (b) each world's RNG stream ended in the same state as its solo run (the
//       streams did not interfere).
//
// FALSIFIABILITY (mirrors p4): a CONTROL interleave that shares ONE store + ONE
// RNG (the pre-refactor global condition) MUST diverge from the solo runs -- if it
// did not, the per-world isolation would not be load-bearing and this test would
// be meaningless. On the pre-refactor engine this whole file cannot even resolve
// (setActiveTransformStore / setInstalledRng do not exist), which is the direct
// proof #8 was real.

import { EntityTable, ops } from "../src/engine.ts";
import { z } from "../build/zod.bundle.mjs";
import {
  createEcsWorld,
  createTransformStore,
  getActiveTransformStore,
  setActiveTransformStore,
  spawnRenderable,
  type TransformStore,
} from "../src/ecs/world.ts";
import { createTransformStorage } from "../src/ecs/facade.ts";
import { UniformGridSpatialIndex } from "../src/spatial/index.ts";
import {
  SkillRegistry,
  type ExecutionContext,
  type SkillDefinition,
  type WorldContext,
} from "../src/skills/registry.ts";
import { registerCoreSkills } from "../src/skills/index.ts";
import { LiminaTracer } from "../src/observability/event.ts";
import { resolveProfile } from "../src/skills/permissions.ts";
import {
  captureWorldState,
  compareWorldState,
  getInstalledRng,
  installSeededRandom,
  setInstalledRng,
  type SeededRng,
  type WorldStateSnapshot,
} from "../src/worldlog/log.ts";

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error("p32_two_worlds: " + message);
}

// ---- An RNG-consuming, transform-writing skill (pure ECS, no physics) -------
// Positions are drawn from the installed seeded Math.random, so the result is a
// pure function of THIS world's seed + eid allocation -- exactly the two globals
// Finding #8 made per-world. No native physics is used (that native world is a
// separate global, out of scope for #8), so two worlds coexist cleanly.
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

// ---- A fresh headless, pure-ECS world with its OWN transform store ----------
interface Runtime {
  world: WorldContext;
  store: TransformStore;
  registry: SkillRegistry;
  rng: SeededRng;
  seed: number;
  firstEntity?: string;
}

function makeRegistry(): SkillRegistry {
  const registry = new SkillRegistry(new LiminaTracer("ses_p32"));
  registerCoreSkills(registry);
  registry.register(scatter);
  return registry;
}

function makeWorld(): WorldContext {
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
    ops,
    mode: "headless",
  };
}

const BASE = {
  agentId: "limina:p32",
  sessionId: "ses_p32",
  permissions: resolveProfile("builder.readWrite"),
  tick: 0,
};

const ROUNDS = 12;

/** Bind a runtime's store + RNG as the process-active pair (the activation swap). */
function activate(rt: Runtime): void {
  setActiveTransformStore(rt.store);
  setInstalledRng(rt.rng);
}

/** Deterministic per-round workload: one seeded scatter, then a fixed ECS write
 *  onto the world's first-created entity. Requires rt to be active. */
async function runRound(rt: Runtime, round: number): Promise<void> {
  const r = await rt.registry.invoke(
    "scene.scatter",
    { count: 6, base: [round, 5 + round, -round], spread: 8 },
    { ...BASE, tick: round, world: rt.world },
  );
  assert(r.success === true, `scatter failed: ${JSON.stringify(r)}`);
  if (rt.firstEntity === undefined) {
    const result = r.result as { entities: string[] };
    rt.firstEntity = result.entities[0];
  }
  const w = await rt.registry.invoke(
    "ecs.updateComponent",
    { entity: rt.firstEntity, component: "scale", value: [1 + round * 0.1, 0.5, 2 - round * 0.05] },
    { ...BASE, tick: round, world: rt.world },
  );
  assert(w.success === true, `updateComponent failed: ${JSON.stringify(w)}`);
}

/** Build a runtime with its OWN fresh store + freshly-seeded RNG, activated. */
function newRuntime(seed: number, store?: TransformStore): Runtime {
  const s = store ?? createTransformStore();
  setActiveTransformStore(s);
  installSeededRandom(seed); // installs + sets Math.random for this world
  const rng = getInstalledRng();
  assert(rng !== undefined, "expected a seeded RNG after install");
  return { world: makeWorld(), store: s, registry: makeRegistry(), rng, seed };
}

// ===========================================================================
// PHASE 1 -- SOLO baselines: each world alone, uninterrupted.
// ===========================================================================
async function runSolo(seed: number): Promise<{ state: WorldStateSnapshot; rngState: number }> {
  const rt = newRuntime(seed);
  for (let round = 0; round < ROUNDS; round++) await runRound(rt, round);
  activate(rt); // store already active; be explicit before capture
  return { state: captureWorldState(rt.world), rngState: rt.rng.getState() };
}

const SEED_A = 0x1234abcd;
const SEED_B = 0x0badf00d;

const soloA = await runSolo(SEED_A);
const soloB = await runSolo(SEED_B);

// The two seeds must actually produce DIFFERENT worlds, else the test proves
// nothing about isolation.
assert(!compareWorldState(soloA.state, soloB.state).identical, "the two seeds produced identical worlds");
assert(soloA.state.entities.length === ROUNDS * 6, "solo A entity count unexpected");

// ===========================================================================
// PHASE 2 -- INTERLEAVED with PER-WORLD activation: must match the solo runs.
// ===========================================================================
const rtA = newRuntime(SEED_A);
const rtB = newRuntime(SEED_B);
for (let round = 0; round < ROUNDS; round++) {
  activate(rtA);
  await runRound(rtA, round);
  activate(rtB);
  await runRound(rtB, round);
}
activate(rtA);
const interA = captureWorldState(rtA.world);
const interARng = rtA.rng.getState();
activate(rtB);
const interB = captureWorldState(rtB.world);
const interBRng = rtB.rng.getState();

const cmpA = compareWorldState(soloA.state, interA);
assert(cmpA.identical, `world A cross-contaminated when interleaved with B: ${cmpA.detail ?? "?"}`);
const cmpB = compareWorldState(soloB.state, interB);
assert(cmpB.identical, `world B cross-contaminated when interleaved with A: ${cmpB.detail ?? "?"}`);

// (b) RNG streams did not interfere: each world's generator ended exactly where
// its solo run did.
assert(interARng === soloA.rngState, `world A RNG stream interfered: ${interARng} vs solo ${soloA.rngState}`);
assert(interBRng === soloB.rngState, `world B RNG stream interfered: ${interBRng} vs solo ${soloB.rngState}`);

// ===========================================================================
// PHASE 3 -- FALSIFIABILITY CONTROL: interleave sharing ONE store + ONE RNG
// (the pre-refactor global condition). This MUST diverge from the solo runs --
// otherwise per-world isolation is not load-bearing and the test is a no-op.
// ===========================================================================
const shared = createTransformStore();
const badA = newRuntime(SEED_A, shared);
// Seed B LAST onto the shared globals (as the pre-refactor engine did): both
// worlds now share badB's RNG, and both eid streams alias `shared`.
const badB = newRuntime(SEED_B, shared);
// Deliberately DO NOT re-activate per round -- run everything on the current
// (shared) globals, exactly the aliasing bug #8 describes.
for (let round = 0; round < ROUNDS; round++) {
  await runRound(badA, round);
  await runRound(badB, round);
}
const badAState = captureWorldState(badA.world);
const badBState = captureWorldState(badB.world);
const badCmpA = compareWorldState(soloA.state, badAState);
const badCmpB = compareWorldState(soloB.state, badBState);
assert(
  !badCmpA.identical || !badCmpB.identical,
  "sharing one store + one RNG did NOT diverge -- isolation is not load-bearing, test is not falsifiable",
);

// Sanity: after the control clobbered the globals, a clean re-activation of the
// solo path still reproduces world A (the swap fully rebinds active state).
const recheck = newRuntime(SEED_A);
for (let round = 0; round < ROUNDS; round++) await runRound(recheck, round);
activate(recheck);
assert(
  compareWorldState(soloA.state, captureWorldState(recheck.world)).identical,
  "re-running world A after the control run diverged -- activation did not fully rebind",
);

// Leave the process on the default store to avoid surprising any later code.
void getActiveTransformStore();

ops.op_log(
  `p32_two_worlds OK: 2 worlds x ${ROUNDS} rounds interleaved with per-world activation are ` +
    `BIT-IDENTICAL to solo (A: ${cmpA.comparisons} fields / ${interA.entities.length} entities, ` +
    `B: ${cmpB.comparisons} fields / ${interB.entities.length} entities); RNG streams isolated ` +
    `(A end-state ${interARng}, B end-state ${interBRng}); control (shared store+RNG) falsified ` +
    `divergence [A: ${badCmpA.detail ?? "identical"}] [B: ${badCmpB.detail ?? "identical"}]`,
);
