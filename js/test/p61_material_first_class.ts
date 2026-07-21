// P61 — material is FIRST-CLASS world state, not merely a THREE mesh property. three.setMaterial
// and scene.createEntity write a MaterialState onto the entity, so an asset-backed / headless
// entity that has NO local mesh still (A) is seeded with material at creation, (B) accepts a
// material edit (returns ok:true — it was ok:false), (C) merges partial edits non-destructively,
// (D) reports its material through inspector.snapshot, and (E) round-trips through a v3 snapshot.
//
// This is the substrate fix behind "three.setMaterial returned ok=false for ent_0": the
// ground/crate/barrel — and any glTF-backed entity whose real mesh loads only in the browser —
// had no mesh in the headless authoritative context, so material had nowhere to live.

import { ops, EntityTable, type WorldContext } from "../src/engine.ts";
import { createEcsWorld, spawnRenderable } from "../src/ecs/world.ts";
import { createTransformStorage } from "../src/ecs/facade.ts";
import { UniformGridSpatialIndex } from "../src/spatial/index.ts";
import { SkillRegistry } from "../src/skills/registry.ts";
import { registerCoreSkills } from "../src/skills/index.ts";
import { resolveProfile } from "../src/skills/permissions.ts";
import { LiminaTracer } from "../src/observability/event.ts";
import { installSeededRandom } from "../src/worldlog/log.ts";
import { captureWorldSnapshot, parseSnapshot, recoverWorld, serializeSnapshot } from "../src/worldlog/snapshot.ts";

function assert(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new Error("p61_material_first_class: " + msg);
}

// A minimal Transformable so an entity gets an eid + transform WITHOUT a real THREE mesh —
// exactly the headless/asset-backed shape the fix has to support.
const STUB = { position: { set() {} }, quaternion: { set() {} }, scale: { set() {} } };
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
installSeededRandom(0x6161);
ops.op_physics_create_world(-9.81);

const world = makeHeadlessWorld();
const registry = makeRegistry(new LiminaTracer("ses_p61"));
const at = (tick: number) => ({ agentId: "agt_p61", sessionId: "ses_p61", permissions: perms, tick, world });

// ---- A) A primitive created via scene.createEntity carries material state from creation. ----
const rP = await registry.invoke("scene.createEntity", { shape: "box", size: 1, color: 0x4ade80, position: [0, 1, 0] }, at(1));
const idP = (rP.result as { entity: string }).entity;
const matP = world.entities.resolve(idP)!.material;
assert(matP?.color === 0x4ade80, `createEntity must store material color, got ${matP?.color}`);
assert(matP?.roughness === 0.6 && matP?.metalness === 0.1, "createEntity must store default roughness/metalness");

// ---- B) A MESH-LESS entity (asset-backed / headless) still accepts a material edit. ----
// Previously three.setMaterial hard-returned ok:false here (no mesh to touch).
const eidM = spawnRenderable(world.ecs, STUB, -3, 0, 2);
const idM = world.entities.create({ eid: eidM });
assert(world.entities.resolve(idM)!.mesh === undefined, "test setup: the entity must have no local mesh");

const rSet = await registry.invoke("three.setMaterial", { entity: idM, color: 0x8d6e63, roughness: 0.8, metalness: 0.0 }, at(2));
assert(rSet.success && (rSet.result as { ok: boolean }).ok === true, `three.setMaterial must return ok:true for a mesh-less entity (was ok:false); got ${JSON.stringify(rSet.result)}`);
const matM = world.entities.resolve(idM)!.material;
assert(matM?.color === 0x8d6e63 && matM?.roughness === 0.8 && matM?.metalness === 0.0, `material state not stored on mesh-less entity: ${JSON.stringify(matM)}`);
assert(world.entities.resolve(idM)!.mesh === undefined, "the entity must STILL have no mesh (state written without one)");

// ---- C) A partial edit merges non-destructively (only roughness changes). ----
await registry.invoke("three.setMaterial", { entity: idM, roughness: 0.2 }, at(3));
const matM2 = world.entities.resolve(idM)!.material;
assert(matM2?.roughness === 0.2, "partial edit must update roughness");
assert(matM2?.color === 0x8d6e63 && matM2?.metalness === 0.0, "partial edit must PRESERVE color/metalness (non-destructive merge)");

// ---- D) inspector.snapshot surfaces the material for the mesh-less entity. ----
const snapView = await registry.invoke("inspector.snapshot", { limit: 200 }, at(4));
const viewM = (snapView.result as { entities: Array<{ entity: string; material?: { color?: number; roughness?: number } }> })
  .entities.find((e) => e.entity === idM);
assert(viewM?.material?.color === 0x8d6e63 && viewM?.material?.roughness === 0.2,
  `inspector.snapshot must report first-class material for a mesh-less entity: ${JSON.stringify(viewM?.material)}`);

// ---- E) Material survives a snapshot capture → JSON round-trip → recover. ----
const snap = captureWorldSnapshot(world, { sessionId: "ses_p61", tick: 20, snapshotSeq: registry.tracer.inspect().eventCount + 500 });
const capM = snap.entities.find((e) => e.id === idM)!;
assert(capM.material?.color === 0x8d6e63 && capM.material?.roughness === 0.2, "snapshot capture must carry material state");
const parsed = parseSnapshot(serializeSnapshot(snap));
const parsedM = parsed.entities.find((e) => e.id === idM)!;
assert(parsedM.material?.color === 0x8d6e63 && parsedM.material?.metalness === 0.0, "material must survive JSON round-trip");

const recovered = await recoverWorld(parsed, [], { makeWorld: makeHeadlessWorld, makeRegistry, tracer: new LiminaTracer("ses_p61_recover") });
const recM = recovered.world.entities.resolve(idM)?.material;
assert(recM?.color === 0x8d6e63 && recM?.roughness === 0.2 && recM?.metalness === 0.0, `material was not restored from the snapshot: ${JSON.stringify(recM)}`);
const recP = recovered.world.entities.resolve(idP)?.material;
assert(recP?.color === 0x4ade80, "primitive material must also restore");

ops.op_log("[js] p61_material_first_class OK: material is first-class world state — three.setMaterial writes it without a local mesh (ok:true, was ok:false), scene.createEntity seeds it, inspector.snapshot reports it, and it round-trips through a v3 snapshot capture/restore");
