// p103 — PARTIAL-FAILURE ATOMICITY (adversarial-review fix H1, PRs B1+B2).
//
// THE BUG THIS GATE PINS: the recorder discards a failed skill's command, and
// replay throws on a failed command — a contract that is only sound if a failed
// skill left the world untouched. Multi-step skills (village.build above all)
// violated it wholesale: nested terrain.deform terraces cut, buildings placed,
// colliders added, then a throw — half-built world, NO command in the log, so
// live ≠ replay forever. The same hole opened with no throw at all via the
// output-schema contract_error path (handler succeeded, world mutated, response
// failed, command discarded).
//
// THE FIX UNDER TEST: the registry's per-chain undo ledger (ExecutionContext.undo,
// one LIFO ledger per HEAD chain; nested invokes append to their head's ledger)
// plus the head-frame capture (skill RNG state, EntityTable seq/version, bitECS
// entity-index) restored on unwind — so a failed chain is exactly "it never
// happened": live == log == replay. Undo failure and concurrent-chain conflicts
// POISON (skill.rollback.failed + SkillRegistry.poisoned) instead of guessing.
//
// PROOF SHAPE:
//   1. Fixture chain (asset.place entity+collider, terrain.deform, building.assemble,
//      a skill-RNG draw, a probe collider) failing by (a) handler throw and
//      (b) schema-violating output: world state, allocators, RNG, heights, physics
//      bodies, and recorder.commandCount are all bit-identical to before; the next
//      created entity gets the SAME ent_ id as if the failures never happened;
//      replay of the log reproduces the live world bit-identically.
//   2. village.build with an injected failing nested placement: same asserts,
//      including the terraced heights and the footprint registry.
//   3. FALSIFIABILITY: the same throw scenario on a registry with the ledger
//      DISABLED (test fixture flag) must fail every one of those checks.
//   4. An undo that throws ⇒ poison: skill.rollback.failed emitted, poisoned
//      surfaced, onRollbackFailure fired, writes fail closed, reads still served.
//   5. Concurrent-chain guard: a chain failing while another head chain was live
//      poisons (reason concurrent_chains) instead of rewinding shared allocators.
//   6. CATCH-ALL (D3): a fixture creating an entity + collider via ctx.world.ops
//      with NO ctx.undo, then throwing, is torn down by the catch-all — world
//      bit-identical to pre-invoke. FALSIFIABILITY: the same scenario on a
//      registry with disableChainEntityCatchAll leaves a live survivor, rewindAllocator
//      refuses, and the registry poisons (reason undo_failed, label 'allocator rewind')
//      — proving the catch-all is load-bearing, not decorative.
//
// Run: LIMINA_AUDIO=null ./target/release/limina js/test/p103_partial_failure_atomicity.ts

import { z } from "../build/zod.bundle.mjs";
import { EntityTable, ops, type EngineOps } from "../src/engine.ts";
import { createEcsWorld, spawnRenderable } from "../src/ecs/world.ts";
import { createTransformStorage } from "../src/ecs/facade.ts";
import { UniformGridSpatialIndex } from "../src/spatial/index.ts";
import { LiminaTracer } from "../src/observability/event.ts";
import { SkillRegistry, type InvokeBase, type SkillDefinition, type WorldContext } from "../src/skills/registry.ts";
import { resolveProfile } from "../src/skills/permissions.ts";
import { registerTerrainEditSkills, type EditableTerrain } from "../src/skills/terrain-edit.ts";
import { registerBuildingSkills } from "../src/skills/building/skill.ts";
import { registerVillageSkills } from "../src/skills/village.ts";
import { registerAssetSkills } from "../src/skills/asset.ts";
import { inertTransform } from "../src/skills/_util.ts";
import type { AssetRegistry } from "../src/asset-registry.ts";
import type { ScatterExclusion } from "../src/terrain/asset-scatter.ts";
import { WorldRecorder } from "../src/worldlog/recorder.ts";
import { replayWorldLog } from "../src/worldlog/replay.ts";
import {
  captureWorldState,
  compareWorldState,
  getInstalledSkillRng,
  installSeededRandom,
  syncAllBodies,
  type WorldStateSnapshot,
} from "../src/worldlog/log.ts";

function assert(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new Error("p103_partial_failure_atomicity FAIL: " + msg);
}

const SEED = 0x0103a70;
const PROFILE = "builder.readWrite";
const PERMS = resolveProfile(PROFILE);

// A raw .gltf JSON document carrying ONLY what gltfLocalAabb needs (accessor
// min/max): asset.place derives a real standalone box collider from it, while
// GLTFLoader's parse fails tolerated (meshless entity) — identical in live,
// replay, and every headless context.
const FIXTURE_GLTF = new TextEncoder().encode(JSON.stringify({
  asset: { version: "2.0" },
  scene: 0,
  scenes: [{ nodes: [0] }],
  nodes: [{ mesh: 0 }],
  meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
  accessors: [{ min: [-0.5, 0, -0.5], max: [0.5, 1, 0.5] }],
}));
const stubAssets = {
  resolve: (id: string) => {
    if (id !== "p103-box.gltf") throw new Error(`p103 stub assets: unknown id '${id}'`);
    return { assetId: id, bytes: FIXTURE_GLTF, hash: "sha256:p103-box" };
  },
} as unknown as AssetRegistry;

function makeWorld(worldOps: EngineOps): WorldContext {
  const ecs = createEcsWorld();
  const scene = { add() {}, remove() {}, position: { set() {}, x: 0, y: 0, z: 0 }, background: null as unknown };
  const camera = { position: { set() {} }, aspect: 1, lookAt() {}, updateProjectionMatrix() {} };
  return {
    ecs, transforms: createTransformStorage(ecs), spatial: new UniformGridSpatialIndex(),
    entities: new EntityTable(), tags: new Map(), scene: scene as WorldContext["scene"],
    camera: camera as WorldContext["camera"], ops: worldOps, mode: "headless",
    rng: getInstalledSkillRng(),
  };
}

// ── Failure injection + probes (module state; reset per part) ─────────────────
/** architecture.building call counter + the 1-based call that throws (0 = never).
 *  Replay registries leave it at 0, so a replayed log never re-injects. */
let archCalls = 0;
let failArchOn = 0;
/** Probe collider body ids the fixture chain added (one per invocation). */
const probeBodies: number[] = [];
/** Entity ids + collider body ids the bare-entity fixture created (one per
 *  invocation) — the catch-all's load-bearing probe: torn down with the
 *  catch-all on (part 6a), left as live survivors facing rewindAllocator with
 *  it off (part 6b). */
const bareEntityIds: string[] = [];
const bareEntityBodies: number[] = [];
let holdGate: Promise<void> | undefined;

interface Handles { registry: SkillRegistry; layers: Map<string, EditableTerrain>; footprints: Map<string, ScatterExclusion[]> }

function makeRegistry(tracer: LiminaTracer, opts: { ledger?: boolean; catchAll?: boolean } = {}): Handles {
  const registryOpts: { disableChainUndoLedger?: boolean; disableChainEntityCatchAll?: boolean } = {};
  if (opts.ledger === false) registryOpts.disableChainUndoLedger = true;
  if (opts.catchAll === false) registryOpts.disableChainEntityCatchAll = true;
  const registry = new SkillRegistry(tracer, undefined, Object.keys(registryOpts).length > 0 ? registryOpts : undefined);
  const layers = new Map<string, EditableTerrain>();
  const footprints = new Map<string, ScatterExclusion[]>();
  const vegetationClears = new Map<string, Array<() => void | Promise<void>>>();
  registerTerrainEditSkills(registry, layers, undefined, footprints, vegetationClears);
  registerBuildingSkills(registry);
  registerVillageSkills(registry, layers, stubAssets, footprints, vegetationClears);
  registerAssetSkills(registry, stubAssets, undefined, layers);

  const nested = (ctx: { agentId: string; sessionId: string; tick: number; world: WorldContext; chainId?: string }): InvokeBase => ({
    agentId: ctx.agentId, sessionId: ctx.sessionId, permissions: new Set<string>(["scene.write"]),
    tick: ctx.tick, world: ctx.world, chainId: ctx.chainId,
  });

  // The multi-step offender in miniature: entity + standalone collider (asset.place),
  // a height mutation (terrain.deform), a kit assembly (building.assemble), a probe
  // collider registered through ctx.undo directly, and a skill-RNG draw — then fail
  // per `mode`. "ok" is the recorded control (replay re-runs it deterministically).
  const multiStep: SkillDefinition<{ mode: "ok" | "throw" | "badOutput"; ox: number; oz: number }, { done: boolean }> = {
    name: "test.multiStep",
    version: "1.0.0",
    description: "p103 fixture: multi-step mutations, then fail per mode.",
    category: "system",
    permissions: ["scene.write"],
    input: z.object({ mode: z.enum(["ok", "throw", "badOutput"]), ox: z.number(), oz: z.number() }),
    output: z.object({ done: z.boolean() }),
    handler: async (input, ctx) => {
      const r1 = await registry.invoke("asset.place", { assetId: "p103-box.gltf", position: [input.ox, 0, input.oz] }, nested(ctx));
      if (!r1.success) throw new Error("fixture asset.place failed: " + JSON.stringify(r1.error));
      const r2 = await registry.invoke("terrain.deform", { center: [0, 0], radius: 6, delta: 2, mode: "raise" }, nested(ctx));
      if (!r2.success || (r2.result as { ok: boolean }).ok !== true) throw new Error("fixture terrain.deform failed");
      const r3 = await registry.invoke("building.assemble", { position: [-14, 0, -14], width: 5, depth: 4, height: 3, seed: 7 }, nested(ctx));
      if (!r3.success) throw new Error("fixture building.assemble failed: " + JSON.stringify(r3.error));
      const probe = ctx.world.ops.op_physics_add_static_box(input.ox + 4, 0.5, input.oz + 4, 0.5, 0.5, 0.5, 0.85, 0);
      probeBodies.push(probe);
      ctx.undo("p103 probe collider", () => ctx.world.ops.op_physics_remove_body(probe));
      ctx.world.rng?.next();
      if (input.mode === "throw") throw new Error("p103 injected failure");
      if (input.mode === "badOutput") return { done: "not-a-boolean" } as never;
      return { done: true };
    },
  };
  registry.register(multiStep);

  // The catch-all's minimal offender (D3): an entity + standalone collider
  // created through the canonical path (spawnRenderable → entities.create, with
  // a collider via ctx.world.ops) and NO ctx.undo enrolled. asset.place /
  // scene.createEntity do this internally — their ctx.undo covers only non-
  // entity effects (colliders via chainRuntimeDispose, terrain, footprints),
  // never the entity itself; the catch-all in unwindChainFrame is what tears
  // that entity down. This strips the pattern to its essence so the catch-all
  // is the ONLY compensation path between a failed chain and a live survivor.
  const bareEntity: SkillDefinition<{ ox: number; oz: number }, { done: boolean }> = {
    name: "test.bareEntity",
    version: "1.0.0",
    description: "p103 fixture: entity + collider with NO ctx.undo, then throw.",
    category: "system",
    permissions: ["scene.write"],
    input: z.object({ ox: z.number(), oz: z.number() }),
    output: z.object({ done: z.boolean() }),
    handler: (input, ctx) => {
      const eid = spawnRenderable(ctx.world.ecs, inertTransform(), input.ox, 0, input.oz);
      const bodyId = ctx.world.ops.op_physics_add_static_box(input.ox, 0.5, input.oz, 0.5, 0.5, 0.5, 0.85, 0);
      bareEntityIds.push(ctx.world.entities.create({ eid, bodyId }));
      bareEntityBodies.push(bodyId);
      throw new Error("p103 bareEntity failure");
    },
  };
  registry.register(bareEntity);

  // Undo-failure fixture: one real (compensated) mutation + one undo that throws.
  const badUndo: SkillDefinition<Record<string, never>, { done: boolean }> = {
    name: "test.badUndo",
    version: "1.0.0",
    description: "p103 fixture: mutation + a throwing undo, then fail.",
    category: "system",
    permissions: ["scene.write"],
    input: z.object({}),
    output: z.object({ done: z.boolean() }),
    handler: async (_input, ctx) => {
      const r = await registry.invoke("terrain.deform", { center: [5, 5], radius: 4, delta: 1, mode: "raise" }, nested(ctx));
      if (!r.success) throw new Error("fixture terrain.deform failed");
      ctx.undo("p103 exploding undo", () => { throw new Error("undo exploded"); });
      throw new Error("p103 badUndo failure");
    },
  };
  registry.register(badUndo);

  // Concurrent-chain fixture: held open across another head chain, then mutates + fails.
  const holdMutate: SkillDefinition<Record<string, never>, { done: boolean }> = {
    name: "test.holdMutate",
    version: "1.0.0",
    description: "p103 fixture: awaits an external gate, mutates, then fails.",
    category: "system",
    permissions: ["scene.write"],
    input: z.object({}),
    output: z.object({ done: z.boolean() }),
    handler: async (_input, ctx) => {
      if (holdGate !== undefined) await holdGate;
      const r = await registry.invoke("terrain.deform", { center: [-8, -8], radius: 4, delta: 1, mode: "raise" }, nested(ctx));
      if (!r.success) throw new Error("fixture terrain.deform failed");
      throw new Error("p103 concurrent failure");
    },
  };
  registry.register(holdMutate);

  const readProbe: SkillDefinition<Record<string, never>, { alive: boolean }> = {
    name: "test.readProbe",
    version: "1.0.0",
    description: "p103 fixture: declared read; must survive a poisoned registry.",
    category: "system",
    permissions: ["scene.write"],
    effect: "read",
    input: z.object({}),
    output: z.object({ alive: z.boolean() }),
    handler: () => ({ alive: true }),
  };
  registry.register(readProbe);

  // Failure injection for the village case: architecture.building (the kit path
  // village.build routes kit specs through) throws on the `failArchOn`-th call.
  const origArch = registry.describe("architecture.building");
  assert(origArch !== undefined, "architecture.building must be registered");
  registry.replace("architecture.building", {
    ...origArch,
    handler: (input: unknown, ctx: unknown) => {
      archCalls++;
      if (failArchOn !== 0 && archCalls === failArchOn) throw new Error("p103 injected placement failure");
      return (origArch.handler as (i: unknown, c: unknown) => unknown)(input, ctx);
    },
  } as SkillDefinition);

  return { registry, layers, footprints };
}

const base = (session: string, world: WorldContext, tick: number): InvokeBase =>
  ({ agentId: "agt_p103", sessionId: session, permissions: PERMS, profile: PROFILE, tick, world });

interface Probe { state: WorldStateSnapshot; nextSeq: number; version: number; rng: number | undefined; cmds: number | undefined; heights: Float32Array }
function probeWorld(world: WorldContext, layer: EditableTerrain, recorder?: WorldRecorder): Probe {
  return {
    state: captureWorldState(world),
    nextSeq: world.entities.nextSeq,
    version: world.entities.version,
    rng: world.rng?.getState(),
    cmds: recorder?.commandCount,
    heights: Float32Array.from(layer.tile.heights),
  };
}
function heightsIdentical(a: Float32Array, b: Float32Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (!Object.is(a[i], b[i])) return false;
  return true;
}
function bodyAlive(world: WorldContext, id: number): boolean {
  const out = new Float32Array(7);
  world.ops.op_physics_body_transform(id, out);
  // A removed/unknown id zero-fills; the zero quaternion is not a valid rotation.
  return !(out[3] === 0 && out[4] === 0 && out[5] === 0 && out[6] === 0);
}
/** Bodies intersecting a box floated ABOVE the flat terrain surface (so the
 *  heightfield never intersects): counts exactly the placed asset's collider.
 *  The overlap query reads the broad phase, which refreshes only on a step —
 *  callers `settle()` first. */
function bodiesAt(world: WorldContext, x: number, z: number): number {
  const out = new Uint32Array(64);
  return world.ops.op_physics_overlap_box(x, 0.6, z, 0.4, 0.25, 0.4, 0, 0, 0, 1, -1, out);
}
/** One recorded top-level step + the per-tick body sync (the windowed-loop rule),
 *  so overlap probes see a fresh broad phase. Static-only world: transforms are
 *  bit-stable across steps, and replay re-runs the identical recorded steps. */
function settle(recOps: EngineOps, world: WorldContext): void {
  recOps.op_physics_step();
  syncAllBodies(world);
}

/** The battery every failed chain must pass: bit-identical world, rewound
 *  allocators + RNG, untouched log, restored heights. */
function assertUnwound(tag: string, before: Probe, after: Probe): void {
  const cmp = compareWorldState(before.state, after.state);
  assert(cmp.identical, `${tag}: world state diverged after failed chain: ${cmp.detail}`);
  assert(after.nextSeq === before.nextSeq, `${tag}: ent_ allocator moved (${before.nextSeq} -> ${after.nextSeq})`);
  assert(after.version === before.version, `${tag}: entity table version moved (${before.version} -> ${after.version})`);
  assert(Object.is(after.rng, before.rng), `${tag}: skill RNG state moved (${before.rng} -> ${after.rng})`);
  assert(after.cmds === before.cmds, `${tag}: recorder.commandCount moved (${before.cmds} -> ${after.cmds})`);
  assert(heightsIdentical(before.heights, after.heights), `${tag}: terrain heights not restored`);
}

// ═════════ Parts 1+2 — one recorded session: fixture failures, village failure, replay ═════════
{
  const tracer = new LiminaTracer("ses_p103");
  const recorder = new WorldRecorder("ses_p103");
  const { registry, layers, footprints } = makeRegistry(tracer);
  recorder.attach(registry);
  recorder.seed(SEED, { forceInstall: true });
  const recOps = recorder.wrapOps(ops);
  const world = makeWorld(recOps);
  recOps.op_physics_create_world(-9.81);

  const rc = await registry.invoke("terrain.create", { size: 60, resolution: 33, baseHeight: 0 }, base("ses_p103", world, 1));
  assert(rc.success === true, "terrain.create failed: " + JSON.stringify(rc.error));
  const layerEntity = (rc.result as { entity: string }).entity;
  const layer = layers.get(layerEntity);
  assert(layer !== undefined, "terrain layer missing");

  // Recorded CONTROL chain: proves the probes detect the mutations the failed
  // chains must erase (collider present, heights raised, entities created).
  const okBefore = probeWorld(world, layer, recorder);
  const rok = await registry.invoke("test.multiStep", { mode: "ok", ox: 20, oz: 20 }, base("ses_p103", world, 2));
  assert(rok.success === true, "control multiStep failed: " + JSON.stringify(rok.error));
  settle(recOps, world);
  assert(probeBodies.length === 1 && bodyAlive(world, probeBodies[0]), "control probe collider must be live");
  assert(bodiesAt(world, 20, 20) === 1, "control placed-asset collider must be present");
  assert(world.entities.nextSeq > okBefore.nextSeq, "control chain must have created entities");
  assert(!heightsIdentical(okBefore.heights, Float32Array.from(layer.tile.heights)), "control chain must have deformed heights");
  assert(world.rng !== undefined && !Object.is(world.rng.getState(), okBefore.rng), "control chain must have advanced the skill RNG");

  // (1a) handler throw.
  const beforeThrow = probeWorld(world, layer, recorder);
  const rThrow = await registry.invoke("test.multiStep", { mode: "throw", ox: -20, oz: -20 }, base("ses_p103", world, 3));
  assert(rThrow.success === false && rThrow.error?.code === "handler_error", "throw mode must fail handler_error");
  assertUnwound("throw", beforeThrow, probeWorld(world, layer, recorder));
  assert(probeBodies.length === 2 && !bodyAlive(world, probeBodies[1]), "throw chain's probe collider must be removed");
  assert(bodyAlive(world, probeBodies[0]), "the CONTROL chain's probe collider must survive the unwind");
  settle(recOps, world);
  assert(bodiesAt(world, -20, -20) === 0, "throw chain's placed-asset collider must be removed (physics body count restored)");

  // (1b) schema-violating output (the no-throw hole).
  const beforeBad = probeWorld(world, layer, recorder);
  const rBad = await registry.invoke("test.multiStep", { mode: "badOutput", ox: 20, oz: -20 }, base("ses_p103", world, 4));
  assert(rBad.success === false && rBad.error?.code === "contract_error", "badOutput mode must fail contract_error");
  assertUnwound("badOutput", beforeBad, probeWorld(world, layer, recorder));
  settle(recOps, world);
  assert(bodiesAt(world, 20, -20) === 0, "badOutput chain's collider must be removed");

  // The next created entity gets the SAME ent_ id as if the failures never happened.
  const rNext = await registry.invoke("asset.place", { assetId: "p103-box.gltf", position: [24, 0, -24] }, base("ses_p103", world, 5));
  assert(rNext.success === true, "post-failure asset.place failed: " + JSON.stringify(rNext.error));
  const nextId = (rNext.result as { entity: string }).entity;
  assert(nextId === `ent_${beforeThrow.nextSeq}`, `next entity must reuse the pre-failure ent_ id: got ${nextId}, expected ent_${beforeThrow.nextSeq}`);

  // (2) village.build with an injected failing nested placement (3rd kit building).
  const steering = {
    buildings: [
      { role: "hall", style: "half-timber", kit: true, sizeM: [8, 6, 3.6], count: 1 },
      { role: "cottage", style: "half-timber", kit: true, sizeM: [6, 5, 3.2], count: 3 },
    ],
    layout: { focal: "hall", density: "loose" },
  };
  const footprintsBefore = footprints.get(layerEntity);
  archCalls = 0; failArchOn = 3;
  const beforeVillage = probeWorld(world, layer, recorder);
  const rVillage = await registry.invoke("village.build", {
    direction: { setting: "medieval" }, steering, seed: SEED, terrainEntity: layerEntity,
  }, base("ses_p103", world, 6));
  failArchOn = 0;
  assert(rVillage.success === false, "village.build with the injected placement failure must fail");
  assert(archCalls === 3, `injection must fire on the 3rd placement (fired after ${archCalls})`);
  assertUnwound("village", beforeVillage, probeWorld(world, layer, recorder));
  assert(footprints.get(layerEntity) === footprintsBefore, "footprint registry must be untouched by the failed village.build");

  // A clean village.build afterwards succeeds and is recorded.
  archCalls = 0;
  const rVillage2 = await registry.invoke("village.build", {
    direction: { setting: "medieval" }, steering, seed: SEED, terrainEntity: layerEntity,
  }, base("ses_p103", world, 7));
  assert(rVillage2.success === true, "clean village.build failed: " + JSON.stringify(rVillage2.error));

  // Replay the log alone: the failed chains are absent AND invisible — the fresh
  // world must be bit-identical to the live one (ids, eids, transforms, heights).
  const liveFinal = captureWorldState(world);
  const replayed = await replayWorldLog(recorder.toJsonl(), {
    makeWorld: () => makeWorld(ops),
    makeRegistry: (tr) => makeRegistry(tr as LiminaTracer).registry,
    tracer: new LiminaTracer("ses_p103_replay"),
  });
  const cmp = compareWorldState(liveFinal, replayed.state);
  assert(cmp.identical, `replay diverged from the live (failure-then-unwound) world: ${cmp.detail}`);
  assert(recorder.count("skill") === 4, `log must carry exactly the 4 successful heads, got ${recorder.count("skill")}`);
  ops.op_log(`p103 parts 1+2 OK: throw + contract_error + village mid-failure all unwound; replay bit-identical (${cmp.comparisons} fields).`);
}

// ═════════ Part 3 — FALSIFIABILITY: the ledger disabled fails every check ═════════
{
  const tracer = new LiminaTracer("ses_p103_off");
  const recorder = new WorldRecorder("ses_p103_off");
  const { registry, layers } = makeRegistry(tracer, { ledger: false });
  recorder.attach(registry);
  recorder.seed(SEED, { forceInstall: true });
  const recOps = recorder.wrapOps(ops);
  const world = makeWorld(recOps);
  recOps.op_physics_create_world(-9.81);
  const rc = await registry.invoke("terrain.create", { size: 60, resolution: 33, baseHeight: 0 }, base("ses_p103_off", world, 1));
  assert(rc.success === true, "ledger-off terrain.create failed");
  const layer = layers.get((rc.result as { entity: string }).entity);
  assert(layer !== undefined, "ledger-off terrain layer missing");

  const probesBefore = probeBodies.length;
  const before = probeWorld(world, layer, recorder);
  const r = await registry.invoke("test.multiStep", { mode: "throw", ox: -20, oz: -20 }, base("ses_p103_off", world, 2));
  assert(r.success === false, "ledger-off throw must still fail the invoke");
  const after = probeWorld(world, layer, recorder);

  assert(!compareWorldState(before.state, after.state).identical, "FALSIFIABILITY DEAD: world state unchanged with the ledger disabled");
  assert(after.nextSeq !== before.nextSeq, "FALSIFIABILITY DEAD: ent_ allocator did not move with the ledger disabled");
  assert(after.version !== before.version, "FALSIFIABILITY DEAD: table version did not move with the ledger disabled");
  assert(!Object.is(after.rng, before.rng), "FALSIFIABILITY DEAD: skill RNG did not move with the ledger disabled");
  assert(!heightsIdentical(before.heights, after.heights), "FALSIFIABILITY DEAD: heights unchanged with the ledger disabled");
  assert(bodyAlive(world, probeBodies[probesBefore]), "FALSIFIABILITY DEAD: probe collider was removed with the ledger disabled");
  settle(recOps, world);
  assert(bodiesAt(world, -20, -20) === 1, "FALSIFIABILITY DEAD: placed-asset collider was removed with the ledger disabled");
  const rNext = await registry.invoke("asset.place", { assetId: "p103-box.gltf", position: [24, 0, -24] }, base("ses_p103_off", world, 3));
  assert(rNext.success === true, "ledger-off post-failure asset.place failed");
  assert((rNext.result as { entity: string }).entity !== `ent_${before.nextSeq}`, "FALSIFIABILITY DEAD: next ent_ id unchanged with the ledger disabled");
  const replayed = await replayWorldLog(recorder.toJsonl(), {
    makeWorld: () => makeWorld(ops),
    makeRegistry: (tr) => makeRegistry(tr as LiminaTracer).registry,
    tracer: new LiminaTracer("ses_p103_off_replay"),
  });
  assert(!compareWorldState(captureWorldState(world), replayed.state).identical,
    "FALSIFIABILITY DEAD: replay matched a half-built world with the ledger disabled");
  ops.op_log("p103 part 3 OK: with the ledger disabled, every atomicity check fails as required.");
}

// ═════════ Part 4 — undo failure ⇒ poison ═════════
{
  const tracer = new LiminaTracer("ses_p103_poison");
  const { registry } = makeRegistry(tracer);
  installSeededRandom(SEED, true);
  const world = makeWorld(ops);
  world.rng = getInstalledSkillRng();
  ops.op_physics_create_world(-9.81);
  const rc = await registry.invoke("terrain.create", { size: 40, resolution: 17, baseHeight: 0 }, base("ses_p103_poison", world, 1));
  assert(rc.success === true, "poison-part terrain.create failed");
  let notified: Error | undefined;
  registry.onRollbackFailure((err) => { notified = err; });

  const r = await registry.invoke("test.badUndo", {}, base("ses_p103_poison", world, 2));
  assert(r.success === false, "badUndo must fail");
  assert(registry.poisoned !== undefined, "a throwing undo must poison the registry");
  assert(notified !== undefined && notified === registry.poisoned, "onRollbackFailure must fire with the poison error");
  const events = tracer.tail({ type: "skill.rollback.failed" }).events;
  assert(events.length === 1, `expected 1 skill.rollback.failed event, got ${events.length}`);
  const payload = events[0].payload as { reason?: string; failures?: Array<{ label: string }> };
  assert(payload.reason === "undo_failed", `poison reason must be undo_failed, got ${payload.reason}`);
  assert(payload.failures?.some((f) => f.label === "p103 exploding undo") === true, "the failing undo's label must be reported");

  const rw = await registry.invoke("terrain.deform", { center: [0, 0], radius: 3, delta: 1 }, base("ses_p103_poison", world, 3));
  assert(rw.success === false && rw.error?.code === "conflict", "writes after poison must fail closed with 'conflict'");
  const rr = await registry.invoke("test.readProbe", {}, base("ses_p103_poison", world, 4));
  assert(rr.success === true, "reads must stay available on a poisoned registry (diagnosis)");
  ops.op_log("p103 part 4 OK: throwing undo poisoned the registry, writes fail closed, reads survive.");
}

// ═════════ Part 5 — concurrent-chain guard ⇒ poison, never a blind rewind ═════════
{
  const tracer = new LiminaTracer("ses_p103_conc");
  const { registry } = makeRegistry(tracer);
  installSeededRandom(SEED, true);
  const world = makeWorld(ops);
  world.rng = getInstalledSkillRng();
  ops.op_physics_create_world(-9.81);
  const rc = await registry.invoke("terrain.create", { size: 40, resolution: 17, baseHeight: 0 }, base("ses_p103_conc", world, 1));
  assert(rc.success === true, "concurrent-part terrain.create failed");

  let release!: () => void;
  holdGate = new Promise<void>((resolve) => { release = resolve; });
  const inFlight = registry.invoke("test.holdMutate", {}, base("ses_p103_conc", world, 2));
  // An independent head chain lives (and completes) inside the held chain's window.
  const rb = await registry.invoke("terrain.deform", { center: [10, 10], radius: 3, delta: 1 }, base("ses_p103_conc", world, 3));
  assert(rb.success === true, "the interleaved head chain must succeed");
  release();
  holdGate = undefined;
  const ra = await inFlight;
  assert(ra.success === false, "the held chain must fail");
  assert(registry.poisoned !== undefined, "a failed chain that overlapped another head chain must poison, not rewind");
  const events = tracer.tail({ type: "skill.rollback.failed" }).events;
  assert(events.length === 1 && (events[0].payload as { reason?: string }).reason === "concurrent_chains",
    "poison reason must be concurrent_chains");
  ops.op_log("p103 part 5 OK: overlapped failing chain poisoned instead of rewinding shared allocators.");
}

// ═════════ Part 6 — CATCH-ALL (D3): entity w/o ctx.undo, on vs disabled ═════════
//
// The ledger (parts 1-3) compensates effects a skill registered via ctx.undo.
// The CATCH-ALL in unwindChainFrame compensates the entities a failed chain
// created WITHOUT a registered teardown — the common case: most entity-creating
// skills (asset.place, scene.createEntity, vegetation.scatter, ...) enroll
// ctx.undo only for NON-entity effects; the entity itself is never enrolled.
// Without the catch-all those survivors face rewindAllocator, which refuses
// (correctly — re-issuing a live ent_ id would corrupt identity) and poisons
// the whole session: a survivable partial failure becomes session loss.
//
// PROOF: the test.bareEntity fixture creates an entity + collider with NO
// ctx.undo, then throws. (6a) with the catch-all ON the entity is torn down and
// the world is bit-identical to pre-invoke. (6b) with disableChainEntityCatchAll
// the SAME scenario leaves a live survivor, rewindAllocator refuses, and the
// registry poisons — proving the asserts in 6a would FAIL without the catch-all.
{
  // (6a) catch-all ON: the un-enrolled entity is torn down; world restored.
  {
    const tracer = new LiminaTracer("ses_p103_ca_on");
    const recorder = new WorldRecorder("ses_p103_ca_on");
    const { registry, layers } = makeRegistry(tracer);
    recorder.attach(registry);
    recorder.seed(SEED, { forceInstall: true });
    const recOps = recorder.wrapOps(ops);
    const world = makeWorld(recOps);
    recOps.op_physics_create_world(-9.81);
    const rc = await registry.invoke("terrain.create", { size: 40, resolution: 17, baseHeight: 0 }, base("ses_p103_ca_on", world, 1));
    assert(rc.success === true, "catch-all-on terrain.create failed");
    const layer = layers.get((rc.result as { entity: string }).entity);
    assert(layer !== undefined, "catch-all-on terrain layer missing");

    const createdBefore = bareEntityIds.length;
    const before = probeWorld(world, layer, recorder);
    const r = await registry.invoke("test.bareEntity", { ox: 30, oz: 30 }, base("ses_p103_ca_on", world, 2));
    assert(r.success === false && r.error?.code === "handler_error", "bareEntity must fail handler_error");
    assert(bareEntityIds.length === createdBefore + 1, "bareEntity must have created exactly one entity");
    assert(world.entities.resolve(bareEntityIds[createdBefore]) === undefined,
      "catch-all must have torn down the un-enrolled entity");
    assert(!bodyAlive(world, bareEntityBodies[createdBefore]),
      "catch-all must have removed the un-enrolled entity's collider (via teardownEntity)");
    assertUnwound("catch-all-on", before, probeWorld(world, layer, recorder));
    ops.op_log("p103 part 6a OK: catch-all tore down the un-enrolled entity + collider; world bit-identical to pre-invoke.");
  }

  // (6b) catch-all DISABLED (falsifiability): the same scenario leaves a live
  //      survivor, rewindAllocator refuses, and the registry poisons — exactly
  //      the session loss the catch-all exists to prevent.
  {
    const tracer = new LiminaTracer("ses_p103_ca_off");
    const recorder = new WorldRecorder("ses_p103_ca_off");
    const { registry, layers } = makeRegistry(tracer, { catchAll: false });
    recorder.attach(registry);
    recorder.seed(SEED, { forceInstall: true });
    const recOps = recorder.wrapOps(ops);
    const world = makeWorld(recOps);
    recOps.op_physics_create_world(-9.81);
    const rc = await registry.invoke("terrain.create", { size: 40, resolution: 17, baseHeight: 0 }, base("ses_p103_ca_off", world, 1));
    assert(rc.success === true, "catch-all-off terrain.create failed");
    const layer = layers.get((rc.result as { entity: string }).entity);
    assert(layer !== undefined, "catch-all-off terrain layer missing");

    const createdBefore = bareEntityIds.length;
    const before = probeWorld(world, layer, recorder);
    const r = await registry.invoke("test.bareEntity", { ox: -30, oz: -30 }, base("ses_p103_ca_off", world, 2));
    assert(r.success === false, "catch-all-off bareEntity must still fail the invoke");
    const after = probeWorld(world, layer, recorder);
    assert(world.entities.resolve(bareEntityIds[createdBefore]) !== undefined,
      "FALSIFIABILITY DEAD: the un-enrolled entity was torn down with the catch-all disabled");
    assert(bodyAlive(world, bareEntityBodies[createdBefore]),
      "FALSIFIABILITY DEAD: the un-enrolled entity's collider was removed with the catch-all disabled");
    assert(!compareWorldState(before.state, after.state).identical,
      "FALSIFIABILITY DEAD: world state unchanged with the catch-all disabled");
    assert(after.nextSeq !== before.nextSeq,
      "FALSIFIABILITY DEAD: ent_ allocator did not move with the catch-all disabled");
    assert(after.version !== before.version,
      "FALSIFIABILITY DEAD: table version did not move with the catch-all disabled");
    assert(registry.poisoned !== undefined,
      "FALSIFIABILITY DEAD: rewindAllocator did not refuse (no poison) with the catch-all disabled");
    const events = tracer.tail({ type: "skill.rollback.failed" }).events;
    assert(events.length === 1, `expected 1 skill.rollback.failed event, got ${events.length}`);
    const payload = events[0].payload as { reason?: string; failures?: Array<{ label: string; message: string }> };
    assert(payload.reason === "undo_failed", `poison reason must be undo_failed, got ${payload.reason}`);
    assert(
      payload.failures?.some((f) => f.label === "allocator rewind") === true,
      "the rewindAllocator refusal must be reported as a failure (label 'allocator rewind')",
    );
    ops.op_log("p103 part 6b OK: with the catch-all disabled the survivor faces rewindAllocator, which refuses and poisons — exactly the failure the catch-all prevents.");
  }
}

ops.op_log(
  "p103_partial_failure_atomicity OK: failed chains (throw, contract_error, village mid-failure) unwind to a bit-identical world " +
    "with rewound ent_/eid/RNG allocators and an untouched log; replay matches live; ledger-disabled falsifiability shim fails every check; " +
    "undo failure and concurrent chains poison loudly; the entity catch-all tears down un-enrolled survivors (disabled-catch-all falsifiability proves it load-bearing).",
);
