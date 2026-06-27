// Phase 11 — RENDER-ONLY sea-level water surface (headless).
//
// world.addWater adds a COSMETIC water plane at a sea-level Y so beaches/lakes/
// oceans read as water. It must be render-only: typed/permissioned/traced, it adds
// exactly ONE mesh at the requested level, and it touches NEITHER the physics world
// NOR the ECS/entity table — so it can never perturb the deterministic sim or replay.
//
// Proves:
//   (1) registered, Zod-typed, gated by scene.write (a profile without it is denied,
//       with zero effect).
//   (2) one render-only mesh at y=level; physics body-add count UNCHANGED; no ECS
//       entity created.
//   (3) the REQUEST (level) is on the trace (world.water.added + skill.executed).
//   (4) deterministic + FALSIFIABLE: the mesh sits at the REQUESTED level, not a
//       default; identical options -> identical surface.
//   (5) REPLAY-SAFE: an identical native sim with vs without water captures
//       BIT-IDENTICAL world state (water contributes nothing to sim state).
//
// Run: limina js/test/p11_water.ts   (exit 0 = pass)

import * as THREE from "../build/three.bundle.mjs";
import { EntityTable, ops, type EngineOps } from "../src/engine.ts";
import { createEcsWorld } from "../src/ecs/world.ts";
import { createTransformStorage } from "../src/ecs/facade.ts";
import { UniformGridSpatialIndex } from "../src/spatial/index.ts";
import { SkillRegistry, type WorldContext } from "../src/skills/registry.ts";
import { registerCoreSkills } from "../src/skills/index.ts";
import { resolveProfile } from "../src/skills/permissions.ts";
import { LiminaTracer } from "../src/observability/event.ts";
import { captureWorldState, compareWorldState, syncAllBodies } from "../src/worldlog/log.ts";
import { buildWaterSurface, DEFAULT_WATER_COLOR, DEFAULT_WATER_SIZE } from "../src/water.ts";

function assert(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new Error("p11_water FAIL: " + msg);
}

interface SceneChild { name?: string; position?: { y: number } }
function waterMeshes(scene: unknown): SceneChild[] {
  return (scene as { children: SceneChild[] }).children.filter((c) => c.name === "limina:water");
}

// A counting view over the native ops: every physics body-creating op increments a
// shared counter, so a "no body created" claim is checked against the REAL op surface
// (not just the entity table). All other ops pass straight through.
function countingOps(target: EngineOps, counter: { adds: number }): EngineOps {
  return new Proxy(target, {
    get(t, prop, recv) {
      const v = Reflect.get(t, prop, recv);
      if (typeof v !== "function") return v;
      const fn = v as (...a: unknown[]) => unknown;
      if (typeof prop === "string" && prop.startsWith("op_physics_add")) {
        return (...args: unknown[]) => { counter.adds++; return fn.apply(t, args); };
      }
      return fn.bind(t);
    },
  }) as EngineOps;
}

function makeHeadlessWorld(worldOps: EngineOps): WorldContext & { scene: THREE.Scene } {
  const ecs = createEcsWorld();
  const scene = new THREE.Scene(); // REAL scene so we can count/inspect children
  const camera = { position: { set() {} }, aspect: 1, lookAt() {}, updateProjectionMatrix() {} };
  return {
    ecs, transforms: createTransformStorage(ecs), spatial: new UniformGridSpatialIndex(),
    entities: new EntityTable(), tags: new Map(), scene: scene as unknown as WorldContext["scene"],
    camera, ops: worldOps, mode: "headless",
  } as WorldContext & { scene: THREE.Scene };
}

// ===========================================================================
// (1) registered, typed, permissioned
// ===========================================================================
const tracer = new LiminaTracer("ses_p11_water");
const registry = new SkillRegistry(tracer);
registerCoreSkills(registry);

assert(registry.has("world.addWater"), "world.addWater not registered");
const tool = registry.list().find((t) => t.name === "world.addWater");
assert(tool !== undefined && typeof tool.input_schema === "object", "world.addWater not Zod-typed in list()");
assert(registry.describe("world.addWater")?.permissions.includes("scene.write") === true, "world.addWater not gated by scene.write");

const counter = { adds: 0 };
const world = makeHeadlessWorld(countingOps(ops, counter));
const author = { agentId: "limina:builder", sessionId: "ses_p11_water", permissions: resolveProfile("builder.readWrite"), tick: 0, world };
const denied = { agentId: "limina:player", sessionId: "ses_p11_water", permissions: resolveProfile("player.limited"), tick: 0, world };

// A profile without scene.write is denied — with ZERO effect on the scene.
const denyRes = await registry.invoke("world.addWater", { level: 0 }, denied);
assert(!denyRes.success && denyRes.error?.code === "forbidden", "player.limited was NOT denied world.addWater");
assert(waterMeshes(world.scene).length === 0, "denied call must not add a water mesh");

// ===========================================================================
// (2) one render-only mesh at y=level; no physics body; no ECS entity
// ===========================================================================
const addsBefore = counter.adds; // 0 (no physics world even created yet)
const entitiesBefore = world.entities.ids().length;

const res = await registry.invoke("world.addWater", { level: 0 }, author);
assert(res.success, `world.addWater failed: ${JSON.stringify(res.error)}`);
const out = res.result as { level: number; size: number; color: number };
assert(out.level === 0, `expected resolved level 0, got ${out.level}`);
assert(out.size === DEFAULT_WATER_SIZE && out.color === DEFAULT_WATER_COLOR, "defaults not applied to size/color");

const waters = waterMeshes(world.scene);
assert(waters.length === 1, `expected exactly one water mesh, got ${waters.length}`);
assert(waters[0].position!.y === 0, `water mesh must sit at y=level (0), got ${waters[0].position!.y}`);

// RENDER-ONLY: no physics body created, no ECS entity created.
assert(counter.adds === addsBefore, `world.addWater created a physics body (adds ${addsBefore} -> ${counter.adds})`);
assert(world.entities.ids().length === entitiesBefore, "world.addWater created an ECS/entity-table entry (must be render-only)");

// ===========================================================================
// (3) the request (level) is on the trace
// ===========================================================================
const events = tracer.trace("limina:builder");
const added = events.find((e) => e.type === "world.water.added");
assert(added !== undefined, "world.water.added not emitted on the trace");
assert((added.payload as { level: number }).level === 0, "traced water request missing the level");
const executed = events.find((e) => e.type === "skill.executed" && (e.payload as { skill?: string }).skill === "world.addWater");
assert(executed !== undefined, "skill.executed for world.addWater not on the trace");
assert(((executed.payload as { input: { level: number } }).input).level === 0, "logged skill.executed input missing the level");

// ===========================================================================
// (4) deterministic + FALSIFIABLE: the mesh is at the REQUESTED level, not a default
// ===========================================================================
const NON_DEFAULT = 3.5;
const res2 = await registry.invoke("world.addWater", { level: NON_DEFAULT }, author);
assert(res2.success, "second world.addWater failed");
const all = waterMeshes(world.scene);
assert(all.length === 2, `expected two water meshes after second add, got ${all.length}`);
const second = all[1];
assert(second.position!.y === NON_DEFAULT, `water must be at requested level ${NON_DEFAULT}, got ${second.position!.y}`);
assert(second.position!.y !== 0, "FALSIFIABILITY: a non-zero requested level must NOT collapse to the default 0");

// Same options -> same surface (deterministic build).
const s1 = buildWaterSurface({ level: NON_DEFAULT });
const s2 = buildWaterSurface({ level: NON_DEFAULT });
assert(s1.position.y === s2.position.y && s1.position.y === NON_DEFAULT, "buildWaterSurface non-deterministic in level");
assert(s1.name === "limina:water" && s2.name === "limina:water", "water mesh name unstable");

// ===========================================================================
// (5) REPLAY-SAFE: identical native sim with vs without water -> identical state
// ===========================================================================
const STEPS = 60;
const DROP: [number, number, number] = [0, 20, 0];

async function runSim(withWater: boolean): Promise<ReturnType<typeof captureWorldState>> {
  const t = new LiminaTracer("ses_p11_parity");
  const r = new SkillRegistry(t);
  registerCoreSkills(r);
  const w = makeHeadlessWorld(ops); // shared native world (reset below)
  const base = { agentId: "limina:builder", sessionId: "ses_p11_parity", permissions: resolveProfile("builder.readWrite"), tick: 0, world: w };
  w.ops.op_physics_create_world(-9.81); // fresh native world -> body ids restart
  // Cosmetic water BEFORE the sim runs — if it leaked into physics, the sphere's
  // rest state (or body-id allocation) would diverge from the no-water run.
  if (withWater) {
    const wr = await r.invoke("world.addWater", { level: 0 }, base);
    assert(wr.success, "parity: addWater failed");
  }
  const sphere = await r.invoke("scene.createEntity", {
    shape: "sphere", collider: "sphere", size: 1.0, color: 0x88ccee,
    position: DROP, dynamic: true, friction: 0.5, restitution: 0.1,
  }, base);
  assert(sphere.success, "parity: sphere createEntity failed");
  for (let i = 1; i <= STEPS; i++) { w.ops.op_physics_step(); syncAllBodies(w); }
  return captureWorldState(w);
}

const noWater = await runSim(false);
const yesWater = await runSim(true);
assert(noWater.entities.length === 1 && yesWater.entities.length === 1, "parity: each run should capture exactly the sphere entity (water adds none)");
const cmp = compareWorldState(noWater, yesWater);
assert(cmp.identical, `parity: water perturbed sim state (${cmp.comparisons} fields): ${cmp.detail ?? "?"}`);
const restY = yesWater.entities[0].body![1];
assert(Number.isFinite(restY) && restY < DROP[1] - 2, `parity: sphere did not fall (y=${restY})`);

ops.op_log(
  `p11_water OK: world.addWater registered + Zod-typed + gated by scene.write (player denied, zero effect); ` +
  `adds exactly one RENDER-ONLY mesh at y=level (no physics body — adds=${counter.adds}, no ECS entity); ` +
  `request on trace (world.water.added + skill.executed input level); ` +
  `mesh at requested level ${NON_DEFAULT} (not default 0, falsifiable) + deterministic build; ` +
  `replay-safe: sim WITH vs WITHOUT water BIT-IDENTICAL over ${cmp.comparisons} fields (sphere rests y=${restY.toFixed(3)}).`,
);
