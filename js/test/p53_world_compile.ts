// P53 -- GDS world-slice compile (doc -> live world), headless + deterministic.
//
// authorWorldSlice turns a GDS `world` slice into live entities by driving the real authoring
// skills in placement order, threading each placement's entity id so residual transform + material
// target the entity just created. This pins the doc->world direction of the kernel (the P5 compile
// foundation): a placement becomes an entity at the authored transform, an unsourced content
// placement FAILS LOUDLY (collected, not thrown), and the placement->entity map is returned.
//
// Headless-verifiable here: prop placement (scene.createEntity) + residual scale/rotation, the
// euler->quaternion conversion, the fail-loud-on-unsourced-content path, and the mapping. The
// asset.place happy path (needs real asset bytes) and material-on-GPU-mesh are verified by the
// browser/asset gate, not this headless tier.
//
// Run: limina js/test/p53_world_compile.ts   (exit 0 = pass)

import { EntityTable, ops, type EngineOps } from "../src/engine.ts";
import { createEcsWorld } from "../src/ecs/world.ts";
import { createTransformStorage } from "../src/ecs/facade.ts";
import { UniformGridSpatialIndex } from "../src/spatial/index.ts";
import { LiminaTracer } from "../src/observability/event.ts";
import { SkillRegistry, type WorldContext } from "../src/skills/registry.ts";
import { registerCoreSkills } from "../src/skills/index.ts";
import { resolveProfile } from "../src/skills/permissions.ts";
import { captureWorldState } from "../src/worldlog/log.ts";
import { validateGDS } from "../src/game/gds.ts";
import { authorWorldSlice } from "../src/game/world-compile.ts";
import { eulerToQuaternion, quaternionToEuler } from "../src/kernel/math.ts";

const SESSION = "ses_p53";
let pass = 0;
function assert(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new Error("p53_world_compile: " + msg);
  pass++;
}
const near = (a: number, b: number, eps = 1e-4): boolean => Math.abs(a - b) <= eps;
const vecNear = (a: readonly number[], b: readonly number[], eps = 1e-4): boolean =>
  a.length === b.length && a.every((v, i) => near(v, b[i], eps));

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

// ---- 0. math: euler <-> quaternion round-trips (a few non-gimbal angles) -----------------------
for (const [x, y, z] of [[0, 0, 0], [0, Math.PI / 2, 0], [0.3, -0.6, 1.1], [-1.2, 0.4, 0.8]]) {
  const [ex, ey, ez] = quaternionToEuler(...eulerToQuaternion(x, y, z));
  assert(vecNear([ex, ey, ez], [x, y, z], 1e-5), `0: euler->quat->euler round-trips for (${x},${y},${z}) got (${ex},${ey},${ez})`);
}

// ---- build a small GDS with a world slice ------------------------------------------------------
const spec = validateGDS({
  id: "p53_world",
  pitch: "test world-slice compile",
  loopSentence: "move · reach · avoid · score · fall · retry",
  controls: { scheme: "keyboard-mouse", intents: [{ name: "move-forward", binding: "KeyW" }] },
  winCondition: "reach the goal",
  loseCondition: "fall",
  artDirection: "grounded stylized",
  targetPlatforms: ["web"],
  scopeTier: "prototype",
  optIn: "record+export",
  entities: [
    { id: "player", name: "Warden", role: "player" },
    { id: "prop_rock", name: "Rock", role: "prop" },
  ],
  content: [{ id: "rock_content", kind: "prop", prompt: "a mossy rock", source: "procedural" }],
  world: {
    placements: [
      { id: "p_player", entity: "player", transform: { position: [1, 2, 3] } },
      { id: "p_rock", entity: "prop_rock", transform: { position: [4, 0, 4], rotation: [0, Math.PI / 2, 0], scale: [2, 2, 2] }, material: { roughness: 0.5 } },
      { id: "p_unsourced", content: "rock_content", transform: { position: [0, 0, 0] } },
    ],
  },
  dod: [{
    id: "d1", statement: "moving forward reaches the goal", kind: "state-transition",
    drives: { steps: [{ forward: 1, repeat: 10 }], assert: [{ check: "gameState", value: "won" }] },
  }],
});
assert(spec.ok && spec.data !== undefined, `spec must validate: ${JSON.stringify(spec.issues)}`);

// ---- author the world slice into a live world --------------------------------------------------
ops.op_physics_create_world(-9.81); // player.spawn builds a Rapier capsule; it needs a world.
const reg = new SkillRegistry(new LiminaTracer(SESSION));
registerCoreSkills(reg);
const world = makeWorld(ops);
const result = await authorWorldSlice(reg, world, spec.data!, {
  sessionId: SESSION, tick: 1, defaultAgentId: "human_editor", defaultPerms: resolveProfile("builder.readWrite"),
});
ops.op_log(`p53: placed=${result.placed} failures=${JSON.stringify(result.failures)} map=${JSON.stringify([...result.placementToEntity])}`);

// ---- A. the prop placement reproduces the authored transform in live ECS state -----------------
const rockEnt = result.placementToEntity.get("p_rock");
assert(rockEnt !== undefined, "A: the prop placement must map to a live entity");
const rock = captureWorldState(world).entities.find((e) => e.id === rockEnt);
assert(rock !== undefined, "A: the prop entity must exist in captured state");
assert(vecNear(rock!.pos, [4, 0, 4]), `A: prop position authored (got ${JSON.stringify(rock!.pos)})`);
assert(vecNear(rock!.scale, [2, 2, 2]), `A: prop scale authored via residual ecs.updateComponent (got ${JSON.stringify(rock!.scale)})`);
assert(vecNear(rock!.rot, eulerToQuaternion(0, Math.PI / 2, 0)), `A: prop rotation authored as euler->quat (got ${JSON.stringify(rock!.rot)})`);

// ---- B. an unsourced CONTENT placement fails LOUDLY (collected, not thrown) --------------------
assert(!result.placementToEntity.has("p_unsourced"), "B: an unsourced content placement must NOT produce an entity");
assert(result.failures.some((f) => f.id === "p_unsourced" && /no resolved asset/.test(f.reason)),
  `B: the unsourced content placement must be a collected failure with a clear reason (got ${JSON.stringify(result.failures)})`);

// ---- C. the player placement authored an entity (physics-driven; identity, not exact pose) -----
assert(result.placementToEntity.has("p_player"), `C: the player placement must map to a live entity (failures: ${JSON.stringify(result.failures)})`);

ops.op_log(
  `p53_world_compile OK: ${pass} assertions -- a GDS world slice authors into live entities at the ` +
    `authored transform (position + residual scale + euler->quat rotation), an unsourced content ` +
    `placement fails loudly, and the placement->entity map is returned.`,
);
