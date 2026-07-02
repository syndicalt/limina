// P58 (s1) — scene hierarchy DATA MODEL: parent + localOffset live on the entity, are
// indexed (byParent / childrenOf), stay consistent across reparent + destroy, and survive
// a full WorldSnapshot round-trip (capture → JSON → recoverWorld). Propagation (moving a
// parent moves children) is gated separately in s2; this proves the identity/serialization
// foundation the rest builds on.

import { ops, EntityTable, type TransformOffset, type WorldContext } from "../src/engine.ts";
import { createEcsWorld, Position } from "../src/ecs/world.ts";
import { createTransformStorage } from "../src/ecs/facade.ts";
import { UniformGridSpatialIndex } from "../src/spatial/index.ts";
import { SkillRegistry } from "../src/skills/registry.ts";
import { registerCoreSkills } from "../src/skills/index.ts";
import { resolveProfile } from "../src/skills/permissions.ts";
import { LiminaTracer } from "../src/observability/event.ts";
import { installSeededRandom } from "../src/worldlog/log.ts";
import { captureWorldSnapshot, parseSnapshot, recoverWorld, serializeSnapshot } from "../src/worldlog/snapshot.ts";

function assert(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new Error("p58_hierarchy: " + msg);
}
function makeHeadlessWorld(): WorldContext {
  const ecs = createEcsWorld();
  const scene = { add() {}, remove() {}, position: { set() {}, x: 0, y: 0, z: 0 }, background: null as unknown };
  const camera = { position: { set() {} }, aspect: 1, lookAt() {}, updateProjectionMatrix() {} };
  return {
    ecs, transforms: createTransformStorage(ecs), spatial: new UniformGridSpatialIndex(),
    entities: new EntityTable(), tags: new Map(), scene, camera, ops, mode: "headless",
  };
}
function makeRegistry(tracer: LiminaTracer): SkillRegistry {
  const registry = new SkillRegistry(tracer);
  registerCoreSkills(registry);
  return registry;
}

const perms = resolveProfile("builder.readWrite");
installSeededRandom(0x58);
ops.op_physics_create_world(-9.81);

const world = makeHeadlessWorld();
const registry = makeRegistry(new LiminaTracer("ses_p58"));
const at = (tick: number) => ({ agentId: "agt_p58", sessionId: "ses_p58", permissions: perms, tick, world });

const parentId = ((await registry.invoke("scene.createEntity", { position: [0, 0, 0] }, at(1))).result as { entity: string }).entity;
const childId = ((await registry.invoke("scene.createEntity", { position: [2, 0, 0] }, at(2))).result as { entity: string }).entity;
const child2Id = ((await registry.invoke("scene.createEntity", { position: [0, 3, 0] }, at(3))).result as { entity: string }).entity;

// ---- byParent / childrenOf + reparent consistency ----
const offset: TransformOffset = { pos: [2, 0, 0], rot: [0, 0, 0, 1], scale: [1, 1, 1] };
world.entities.setParent(childId, parentId, offset);
world.entities.setParent(child2Id, parentId, { pos: [0, 3, 0], rot: [0, 0, 0, 1], scale: [1, 1, 1] });
assert(world.entities.resolve(childId)?.parent === parentId, "parent not set on child");
assert(world.entities.childrenOf(parentId).sort().join(",") === [childId, child2Id].sort().join(","), "childrenOf must list both children");

// Reparent child2 under child: it must leave parent's set and join child's set.
world.entities.setParent(child2Id, childId, { pos: [0, 1, 0], rot: [0, 0, 0, 1], scale: [1, 1, 1] });
assert(world.entities.childrenOf(parentId).join(",") === childId, "reparent must remove child2 from old parent's set");
assert(world.entities.childrenOf(childId).join(",") === child2Id, "reparent must add child2 to new parent's set");

// ---- snapshot round-trip via recoverWorld (empty delta = pure restore) ----
const snap = captureWorldSnapshot(world, { sessionId: "ses_p58", tick: 10, snapshotSeq: 9999 });
const capChild = snap.entities.find((e) => e.id === childId)!;
assert(capChild.parent === parentId && capChild.localOffset?.pos[0] === 2, "capture must record parent + localOffset");

const recovered = await recoverWorld(parseSnapshot(serializeSnapshot(snap)), [], { makeWorld: makeHeadlessWorld, makeRegistry, tracer: new LiminaTracer("ses_p58_recover") });
const rw = recovered.world;
assert(rw.entities.resolve(childId)?.parent === parentId, "parent not restored");
assert(rw.entities.resolve(childId)?.localOffset?.pos[0] === 2, "localOffset not restored");
assert(rw.entities.resolve(child2Id)?.parent === childId, "reparented parent not restored");
assert(rw.entities.childrenOf(parentId).join(",") === childId, "byParent index not rebuilt on restore");
assert(rw.entities.childrenOf(childId).join(",") === child2Id, "grandchild index not rebuilt on restore");

// ---- destroy keeps the index consistent ----
rw.entities.destroy(childId);
assert(rw.entities.childrenOf(parentId).length === 0, "destroy must remove the entity from its parent's child set");
assert(rw.entities.childrenOf(childId).length === 0, "destroy must drop the destroyed entity's own child set");

// ---- s2: PROPAGATION — moving a parent moves its (renderable) subtree ----
const P = ((await registry.invoke("scene.createEntity", { position: [0, 0, 0] }, at(20))).result as { entity: string }).entity;
const C = ((await registry.invoke("scene.createEntity", { position: [2, 0, 0], parent: P }, at(21))).result as { entity: string }).entity;
const G = ((await registry.invoke("scene.createEntity", { position: [2, 1, 0], parent: C }, at(22))).result as { entity: string }).entity;
const eC = world.entities.resolve(C)!.eid;
const eG = world.entities.resolve(G)!.eid;
assert(Math.abs(world.entities.resolve(C)!.localOffset!.pos[0] - 2) < 1e-5, "createEntity(parent) must capture the localOffset");

// Move the parent to [10,0,0]: child follows to [12,0,0], grandchild to [12,1,0].
await registry.invoke("ecs.updateComponent", { entity: P, component: "position", value: [10, 0, 0] }, at(23));
assert(Math.abs(Position.x[eC] - 12) < 1e-4 && Math.abs(Position.y[eC]) < 1e-4, `child did not follow parent move: x=${Position.x[eC]}`);
assert(Math.abs(Position.x[eG] - 12) < 1e-4 && Math.abs(Position.y[eG] - 1) < 1e-4, `grandchild did not follow: x=${Position.x[eG]} y=${Position.y[eG]}`);

// ---- s2: scene.reparent (keep-world) then follow ----
const D = ((await registry.invoke("scene.createEntity", { position: [5, 5, 5] }, at(24))).result as { entity: string }).entity;
const eD = world.entities.resolve(D)!.eid;
assert(((await registry.invoke("scene.reparent", { entity: D, parent: P }, at(25))).result as { ok: boolean }).ok, "reparent should succeed");
assert(Math.abs(Position.x[eD] - 5) < 1e-4 && Math.abs(Position.y[eD] - 5) < 1e-4, "keep-world reparent must leave D in place");
await registry.invoke("ecs.updateComponent", { entity: P, component: "position", value: [15, 0, 0] }, at(26));
assert(Math.abs(Position.x[eD] - 10) < 1e-4, `reparented D did not follow parent: x=${Position.x[eD]}`);

// ---- cycle rejection: P cannot become a child of its own descendant C ----
assert(!((await registry.invoke("scene.reparent", { entity: P, parent: C }, at(27))).result as { ok: boolean }).ok, "reparent must reject a cycle");
// Unparent D back to root.
await registry.invoke("scene.reparent", { entity: D, parent: null }, at(28));
assert(world.entities.resolve(D)!.parent === undefined, "unparent (parent:null) must clear the parent");

ops.op_log("[js] p58_hierarchy OK: data model + snapshot round-trip + propagation (parent move → subtree follows) + scene.reparent (keep-world, cycle-rejection, unparent)");
