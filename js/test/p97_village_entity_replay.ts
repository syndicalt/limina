// P97 — village.build ENTITY-SEQUENCE determinism across hosts + record→replay equivalence.
//
// THE REGRESSION THIS GUARDS: the lawn/tint/decoration entities used to be created only when the
// context was render-capable (canRenderGrass) — so the ent_ id counter (load-bearing: worldlog
// entity identity is allocation-ordered) FORKED between a windowed record and a headless replay,
// and a silent catch could swallow a deco entity entirely. The fix makes entity creation
// UNCONDITIONAL (meshes stay render-only). This gate falsifies all of it:
//
//   1. HEADLESS LAWN ENTITIES — a headless village.build (yard defaults to "lawn") creates the
//      lawn entities (one per yard + one tint) with NO mesh. Pre-fix code creates ZERO → FAIL.
//   2. REPLAY-EQUIVALENCE — record terrain.create + village.build headless, replay the log into
//      a fresh world, compareWorldState BIT-IDENTICAL (entity ids included).
//   3. RENDER/HEADLESS ENTITY-ID PARITY — the same build on a render-capable-simulated world
//      (renderer present + injected grass package, the sim-worker shape) yields the IDENTICAL
//      entity id sequence AND bit-identical world state. Includes a lawnVegetation deco asset
//      whose stub GLB FAILS to parse in the render path — the deco entity must exist anyway
//      (mesh lost, entity kept), so a render fault can never fork the sequence. The deco leg is
//      NOT vacuous: the seeded plan must actually yield deco entities (count > 0).
//   4. CURATED-GLB AVAILABILITY PARITY (the D8 env-fork) — the same render-capable build with a
//      NON-RESOLVING assets stub (a bare checkout without the curated deco GLB) yields the
//      IDENTICAL entity id sequence and deco-entity count, and the resolve failure surfaces as a
//      village.lawn_deco_failed event instead of being swallowed. Pre-fix code dropped the
//      unresolvable asset from the scatter config BEFORE entity creation → fewer entities → FAIL.
//   5. NOT VACUOUS — a different terrain seed re-rolls the placements (the comparisons above
//      could not pass by comparing constants).
//
// Run: LIMINA_AUDIO=null ./target/release/limina js/test/p97_village_entity_replay.ts   (exit 0 = pass)

import { EntityTable, ops, type EngineOps, type WorldContext } from "../src/engine.ts";
import { createEcsWorld } from "../src/ecs/world.ts";
import { createTransformStorage } from "../src/ecs/facade.ts";
import { UniformGridSpatialIndex } from "../src/spatial/index.ts";
import { SkillRegistry } from "../src/skills/registry.ts";
import { resolveProfile } from "../src/skills/permissions.ts";
import { LiminaTracer } from "../src/observability/event.ts";
import { registerTerrainEditSkills, type EditableTerrain } from "../src/skills/terrain-edit.ts";
import { registerBuildingSkills } from "../src/skills/building/skill.ts";
import { registerVillageSkills } from "../src/skills/village.ts";
import { WorldRecorder } from "../src/worldlog/recorder.ts";
import { replayCommands } from "../src/worldlog/replay.ts";
import { captureWorldState, compareWorldState, type WorldStateSnapshot } from "../src/worldlog/log.ts";
import { INTERACTIVE_TEMPERATE_MEADOW_PACKAGE } from "../src/content/grass/interactive-temperate-meadow.ts";

function assert(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new Error("p97_village_entity_replay FAIL: " + msg);
}

function makeWorld(worldOps: EngineOps, renderGrass: boolean): WorldContext {
  const ecs = createEcsWorld();
  const scene = { add() {}, remove() {}, position: { set() {}, x: 0, y: 0, z: 0 }, background: null as unknown };
  const camera = { position: { set() {} }, aspect: 1, lookAt() {}, updateProjectionMatrix() {} };
  return {
    ecs, transforms: createTransformStorage(ecs), spatial: new UniformGridSpatialIndex(),
    entities: new EntityTable(), tags: new Map(), scene: scene as WorldContext["scene"],
    camera: camera as WorldContext["camera"], ops: worldOps, mode: "headless",
    ...(renderGrass ? { renderer: {} } : {}),
  };
}

// Kit-only steering (no GLB dependency) + a lawnVegetation deco id the stub resolver "resolves"
// to EMPTY bytes: headless never parses it; the render path parses, FAILS, and must still create
// the deco entity. The stub keeps this gate independent of the gitignored library GLBs (p78 style).
const stubAssets = { resolve: (id: string) => ({ assetId: id, bytes: new Uint8Array(), hash: "sha256:stub-" + id }) } as never;
// A BARE-CHECKOUT stub: the curated deco GLB does not resolve at all (leg 4 — the D8 env-fork).
const absentDecoAssets = {
  resolve: (id: string) => {
    if (id === "p97-stub-flower") throw new Error(`asset not found: ${id}`);
    return { assetId: id, bytes: new Uint8Array(), hash: "sha256:stub-" + id };
  },
} as never;
const perms = resolveProfile("builder.readWrite");
const SIZE = 120, RES = 128, SEED = 6;
const direction = { setting: "medieval", mood: "weathered, lived-in" };
const steering = {
  buildings: [
    { role: "hall", style: "half-timber", kit: true, sizeM: [10, 8, 4], count: 1 },
    { role: "cottage", style: "half-timber", kit: true, sizeM: [7.5, 6, 3.6], count: 6 },
  ],
  layout: { focal: "hall at the settlement heart", density: "loose" },
  siting: { lawnVegetation: [{ id: "p97-stub-flower", weight: 1 }] },
};

type Placement = { assetId: string; role: string; x: number; y: number; z: number; yaw: number };
interface RunResult {
  entities: string[]; placements: Placement[]; placed: number;
  state: WorldStateSnapshot; lawnEntities: number; lawnDecoEntities: number;
  tracer: LiminaTracer;
}

async function build(session: string, opts: {
  record?: WorldRecorder; renderGrass?: boolean; terrainSeed?: number; assets?: never;
}): Promise<RunResult> {
  const worldOps = opts.record !== undefined ? opts.record.wrapOps(ops) : ops;
  const world = makeWorld(worldOps, opts.renderGrass === true);
  const layers = new Map<string, EditableTerrain>();
  const tracer = new LiminaTracer(session);
  const registry = new SkillRegistry(tracer);
  registerTerrainEditSkills(registry, layers);
  registerBuildingSkills(registry);
  registerVillageSkills(registry, layers, opts.assets ?? stubAssets, new Map(), new Map(),
    opts.renderGrass === true ? INTERACTIVE_TEMPERATE_MEADOW_PACKAGE : undefined);
  opts.record?.attach(registry);
  const at = (t: number) => ({ agentId: "agt_p97", sessionId: session, permissions: perms, tick: t, world });

  // A fresh native physics world per run (top-level op: recorded when wrapped, reproduced on replay).
  worldOps.op_physics_create_world(-9.81);
  const rc = await registry.invoke("terrain.create", {
    size: SIZE, resolution: RES, color: 5926970,
    generate: { seed: opts.terrainSeed ?? SEED, amplitude: 16, seaCoverage: 0.2, erosion: { rain: 1.5, thermal: 6 } },
  }, at(1));
  assert(rc.success, `terrain.create must succeed: ${JSON.stringify(rc.error)}`);
  const rv = await registry.invoke("village.build", {
    direction, steering, seed: SEED, terrainEntity: (rc.result as { entity: string }).entity,
  }, at(2));
  assert(rv.success, `village.build must succeed: ${JSON.stringify(rv.error)}`);
  const res = rv.result as { entities: string[]; placements: Placement[]; placed: number };

  // Classify the appended entities by their recorded origin (the lawn/tint share {lawn:true}).
  let lawnEntities = 0, lawnDecoEntities = 0;
  for (const id of res.entities) {
    const origin = world.entities.resolve(id)?.origin as { tool?: string; input?: Record<string, unknown> } | undefined;
    if (origin?.tool !== "village.build") continue;
    if (origin.input?.lawn === true) lawnEntities++;
    if (origin.input?.lawnDeco === true) lawnDecoEntities++;
  }
  // Capture a value-copied snapshot NOW: the ECS transform SoA is process-global, so a later
  // run in this gate overwrites the live arrays (ids/copies below stay valid).
  return {
    entities: [...res.entities], placements: res.placements, placed: res.placed,
    state: captureWorldState(world), lawnEntities, lawnDecoEntities, tracer,
  };
}

// ── 1. HEADLESS record: lawn entities exist meshlessly ─────────────────────────────────────────
const recorder = new WorldRecorder("ses_p97_rec");
recorder.seed(SEED);
const runA = await build("ses_p97_rec", { record: recorder });
assert(runA.placements.length === 7, `expected 7 placed buildings, got ${runA.placements.length}`);
// One lawn field per yard + ONE ground tint, created UNCONDITIONALLY (pre-fix headless: 0).
assert(runA.lawnEntities === runA.placements.length + 1,
  `headless lawn entities must be placements+tint = ${runA.placements.length + 1}, got ${runA.lawnEntities} — render-gated entity creation forks the ent_ id sequence`);

// ── 2. REPLAY-EQUIVALENCE: replay the recorded log into a FRESH world ──────────────────────────
const replay = await replayCommands(recorder.commands, {
  makeWorld: () => makeWorld(ops, false),
  makeRegistry: (tr) => {
    const r = new SkillRegistry(tr as LiminaTracer);
    const layers = new Map<string, EditableTerrain>();
    registerTerrainEditSkills(r, layers);
    registerBuildingSkills(r);
    registerVillageSkills(r, layers, stubAssets, new Map(), new Map());
    return r;
  },
  tracer: new LiminaTracer("ses_p97_replay"),
});
const cmpReplay = compareWorldState(runA.state, replay.state);
assert(cmpReplay.identical, `record→replay world state diverged: ${cmpReplay.detail}`);

// ── 3. RENDER/HEADLESS ENTITY-ID PARITY (the H4 fork, plus the deco parse-failure path) ────────
// The deco leg must not pass vacuously: the seeded scatter has to actually yield deco entities,
// or every deco-count comparison below would be 0 === 0.
assert(runA.lawnDecoEntities > 0,
  `the seeded lawn-deco plan must create at least one deco entity (got ${runA.lawnDecoEntities}) — the deco legs would otherwise be vacuous`);
const runC = await build("ses_p97_render", { renderGrass: true });
assert(runC.entities.length === runA.entities.length,
  `render-capable run created ${runC.entities.length} entities vs headless ${runA.entities.length} — the ent_ sequence forked`);
for (let i = 0; i < runA.entities.length; i++) {
  assert(runA.entities[i] === runC.entities[i],
    `entity id sequence diverged at index ${i}: headless '${runA.entities[i]}' vs render '${runC.entities[i]}'`);
}
assert(runC.lawnEntities === runA.lawnEntities, `lawn entity count diverged (headless ${runA.lawnEntities}, render ${runC.lawnEntities})`);
assert(runC.lawnDecoEntities === runA.lawnDecoEntities,
  `lawn DECO entity count diverged (headless ${runA.lawnDecoEntities}, render ${runC.lawnDecoEntities}) — a deco mesh failure must never drop the entity`);
const cmpRender = compareWorldState(runA.state, runC.state);
assert(cmpRender.identical, `render-capable vs headless world state diverged: ${cmpRender.detail}`);

// ── 4. CURATED-GLB AVAILABILITY PARITY (D8): a bare checkout where the deco GLB does NOT resolve
//      must produce the IDENTICAL entity sequence — deco entities included — and surface the
//      resolve failure as a village.lawn_deco_failed event, never a silent drop. Pre-fix code
//      filtered the unresolvable asset out of the scatter config before entity creation, so this
//      leg FAILS on it (fewer entities than runC). ──
const runE = await build("ses_p97_absent", { renderGrass: true, assets: absentDecoAssets });
assert(runE.entities.length === runC.entities.length,
  `non-resolving deco checkout created ${runE.entities.length} entities vs resolving ${runC.entities.length} — curated-GLB availability forked the ent_ sequence (the D8 env-fork)`);
for (let i = 0; i < runC.entities.length; i++) {
  assert(runC.entities[i] === runE.entities[i],
    `entity id sequence diverged at index ${i} between resolving and non-resolving checkouts: '${runC.entities[i]}' vs '${runE.entities[i]}'`);
}
assert(runE.lawnDecoEntities === runC.lawnDecoEntities,
  `deco-entity count diverged between resolving (${runC.lawnDecoEntities}) and non-resolving (${runE.lawnDecoEntities}) assets stubs`);
const decoFailures = runE.tracer.trace("agt_p97").filter((e) => e.type === "village.lawn_deco_failed");
assert(decoFailures.length > 0,
  "a non-resolving deco GLB must surface a village.lawn_deco_failed event — not be silently swallowed");
const cmpAbsent = compareWorldState(runC.state, runE.state);
assert(cmpAbsent.identical, `resolving vs non-resolving assets stub world state diverged: ${cmpAbsent.detail}`);

// ── 5. NOT VACUOUS: a different terrain seed re-rolls the placements ───────────────────────────
const runD = await build("ses_p97_seed", { terrainSeed: 99 });
assert(runD.placements.length === runA.placements.length, "seed change must not change the building COUNT (steering-driven)");
let rerolled = false;
for (let k = 0; k < runA.placements.length; k++) {
  const a = runA.placements[k], d = runD.placements[k];
  if (a.x !== d.x || a.z !== d.z || a.y !== d.y || a.yaw !== d.yaw) { rerolled = true; break; }
}
assert(rerolled, "a different terrain seed must re-roll placements — the parity checks above would be comparing constants");

ops.op_log(
  `[js] p97_village_entity_replay OK: headless village.build created ${runA.lawnEntities} meshless lawn entities + ` +
  `${runA.lawnDecoEntities} deco entities (> 0, non-vacuous); record→replay BIT-IDENTICAL (${cmpReplay.comparisons} comparisons); ` +
  `render-capable run reproduced the exact ${runA.entities.length}-entity id sequence (deco GLB parse failure kept its entity); ` +
  `a NON-RESOLVING deco checkout reproduced the same sequence + ${runE.lawnDecoEntities} deco entities ` +
  `(${decoFailures.length} village.lawn_deco_failed event(s), never swallowed); ` +
  `terrain seed re-roll proves the comparisons are live.`,
);
