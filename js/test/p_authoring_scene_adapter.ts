import {
  EntityTable,
  ops,
  type EngineOps,
  type MaterialLike,
  type SceneObject,
} from "../src/engine.ts";
import { createTransformStorage } from "../src/ecs/facade.ts";
import { Position, Rotation, Scale, createEcsWorld, spawnRenderable } from "../src/ecs/world.ts";
import { UniformGridSpatialIndex } from "../src/spatial/index.ts";
import type { WorldContext } from "../src/skills/registry.ts";
import {
  AUTHORING_TRANSACTION_SCHEMA,
  AuthoringError,
  AuthoringTransactionKernel,
  StaticAuthoringAdapterAllowlist,
  canonicalHash,
  createWorldProjectHead,
  type AuthoringAdapter,
  type AuthoringAdapterContext,
  type AuthoringCapture,
  type AuthoringOperation,
  type AuthoringTransaction,
  type WorldProjectHead,
} from "../src/authoring/index.ts";
import { SceneAuthoringAdapter } from "../src/authoring/adapters/scene.ts";
import { sha256 } from "../src/world/sha256.mjs";

let assertions = 0;
function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`p_authoring_scene_adapter: ${message}`);
  assertions++;
}

async function expectCode(promise: Promise<unknown>, code: string, messageIncludes?: string): Promise<AuthoringError> {
  try {
    await promise;
  } catch (error) {
    assert(error instanceof AuthoringError, `expected AuthoringError, got ${String(error)}`);
    assert(error.code === code, `expected ${code}, got ${error.code}: ${error.message}`);
    if (messageIncludes !== undefined) {
      assert(error.message.includes(messageIncludes), `expected error to include '${messageIncludes}', got '${error.message}'`);
    }
    return error;
  }
  throw new Error(`p_authoring_scene_adapter: expected ${code}`);
}

class FakeColor {
  #hex: number;
  constructor(hex: number) { this.#hex = hex; }
  getHex(): number { return this.#hex; }
  set(value: number): void { this.#hex = value; }
}

class FakeSceneObject implements SceneObject {
  readonly children: FakeSceneObject[] = [];
  readonly position = { x: 0, y: 0, z: 0, set: (x: number, y: number, z: number): void => {
    this.position.x = x; this.position.y = y; this.position.z = z;
  } };
  readonly quaternion = { x: 0, y: 0, z: 0, w: 1, set: (x: number, y: number, z: number, w: number): void => {
    this.quaternion.x = x; this.quaternion.y = y; this.quaternion.z = z; this.quaternion.w = w;
  } };
  readonly scale = { x: 1, y: 1, z: 1, set: (x: number, y: number, z: number): void => {
    this.scale.x = x; this.scale.y = y; this.scale.z = z;
  } };
  visible = true;
  castShadow = false;
  receiveShadow = false;
  material: MaterialLike = { color: new FakeColor(0x112233), roughness: 0.4, metalness: 0.2 };
  add(_child: unknown): void {}
  remove(_child: unknown): void {}
  traverse(callback: (object: SceneObject) => void): void { callback(this); }
}

function makeWorld(worldOps: EngineOps): WorldContext {
  const ecs = createEcsWorld();
  return {
    ecs,
    transforms: createTransformStorage(ecs),
    spatial: new UniformGridSpatialIndex(),
    entities: new EntityTable(),
    tags: new Map(),
    scene: {
      add() {}, remove() {},
      position: { x: 0, y: 0, z: 0, set() {} },
      background: null,
    },
    camera: { position: { set() {} }, lookAt() {}, updateProjectionMatrix() {} },
    ops: worldOps,
    mode: "headless",
  };
}

function seedEntity(
  world: WorldContext,
  position: readonly [number, number, number],
  options: { bodyId?: number; parent?: string; localPosition?: [number, number, number] } = {},
): { id: string; object: FakeSceneObject; eid: number } {
  const object = new FakeSceneObject();
  const eid = spawnRenderable(world.ecs, object, ...position);
  const id = world.entities.create({
    eid,
    mesh: object,
    bodyId: options.bodyId,
    material: { color: 0x112233, roughness: 0.4, metalness: 0.2, name: "original", pbr: false },
  });
  if (options.parent !== undefined) {
    world.entities.setParent(id, options.parent, {
      pos: options.localPosition ?? [0, 0, 0],
      rot: [0, 0, 0, 1],
      scale: [1, 1, 1],
    });
  }
  return { id, object, eid };
}

class ApplyFailureAdapter implements AuthoringAdapter<null> {
  readonly id = "failure";
  readonly version = "1.0.0";
  stateKey(): string { return "injected"; }
  preflight(): void {}
  capture(_operation: AuthoringOperation, context: AuthoringAdapterContext): AuthoringCapture<null> {
    return { snapshot: null, stateHash: context.hashJson(null) };
  }
  apply(): void { throw new Error("injected failure after prior scene mutations"); }
  stateHash(_operation: AuthoringOperation, context: AuthoringAdapterContext): `sha256:${string}` {
    return context.hashJson(null);
  }
  rollback(): void {}
  compensate(): void {}
}

const hash = (input: string): string => sha256(input);
const PROJECT_ID = "project.scene-adapter";

function transaction(
  transactionId: string,
  head: WorldProjectHead,
  operations: AuthoringTransaction["operations"],
  compensates?: string,
): AuthoringTransaction {
  return {
    schema: AUTHORING_TRANSACTION_SCHEMA,
    transactionId,
    projectId: head.projectId,
    baseRevision: head.revision,
    baseHeadHash: head.headHash,
    operations,
    ...(compensates === undefined ? {} : { compensates: { transactionId: compensates } }),
  };
}

function sceneOperation(action: string, input: AuthoringOperation["input"]): AuthoringOperation {
  return { adapter: "scene", adapterVersion: "1.0.0", action, input };
}

const failOperation: AuthoringOperation = { adapter: "failure", adapterVersion: "1.0.0", action: "fail", input: null };

ops.op_physics_create_world(0);
const world = makeWorld(ops);
const root = seedEntity(world, [1, 2, 3]);
const child = seedEntity(world, [2, 2, 3], { parent: root.id, localPosition: [1, 0, 0] });
world.tags.set(root.eid, new Set(["zeta", "alpha"]));
const sceneAdapter = new SceneAuthoringAdapter({ world });
const failureAdapter = new ApplyFailureAdapter();

function makeKernel(): { kernel: AuthoringTransactionKernel; head: WorldProjectHead } {
  const head = createWorldProjectHead(PROJECT_ID, hash);
  return {
    head,
    kernel: new AuthoringTransactionKernel({
      head,
      sha256: hash,
      adapters: new StaticAuthoringAdapterAllowlist([sceneAdapter, failureAdapter]),
    }),
  };
}

// A move that propagates into a child subtree must roll every affected transform back exactly.
{
  const { kernel, head } = makeKernel();
  const beforeRoot = [Position.x[root.eid], Position.y[root.eid], Position.z[root.eid]];
  const beforeChild = [Position.x[child.eid], Position.y[child.eid], Position.z[child.eid]];
  await expectCode(kernel.commit(transaction("tx.move.rollback", head, [
    sceneOperation("transform.set", { entity: root.id, position: [8, 9, 10], scale: [2, 2, 2] }),
    failOperation,
  ])), "apply_failed");
  assert(JSON.stringify([Position.x[root.eid], Position.y[root.eid], Position.z[root.eid]]) === JSON.stringify(beforeRoot), "root move must roll back");
  assert(JSON.stringify([Position.x[child.eid], Position.y[child.eid], Position.z[child.eid]]) === JSON.stringify(beforeChild), "propagated child move must roll back");
  assert(!kernel.poisoned && kernel.head.revision === 0, "exact transform rollback must keep the writer healthy");
}

// Tags and live material state (entity state + scene object fields) roll back together.
{
  const { kernel, head } = makeKernel();
  await expectCode(kernel.commit(transaction("tx.tags.rollback", head, [
    sceneOperation("tags.replace", { entity: root.id, tags: ["edited", "selected"] }),
    failOperation,
  ])), "apply_failed");
  assert(JSON.stringify([...world.tags.get(root.eid)!]) === JSON.stringify(["alpha", "zeta"]), "tag rollback must restore a canonical exact set");
}
{
  const { kernel, head } = makeKernel();
  await expectCode(kernel.commit(transaction("tx.material.rollback", head, [
    sceneOperation("material.patch", {
      entity: root.id, color: 0xff00aa, roughness: 0.9, metalness: 0.8, castShadow: true, receiveShadow: true,
    }),
    failOperation,
  ])), "apply_failed");
  const material = root.object.material as MaterialLike & { color: FakeColor };
  const entityMaterial = world.entities.resolve(root.id)?.material;
  assert(material.color.getHex() === 0x112233 && material.roughness === 0.4 && material.metalness === 0.2, "mesh material rollback must restore exact numeric state");
  assert(root.object.castShadow === false && root.object.receiveShadow === false, "shadow flags must roll back");
  assert(entityMaterial?.name === "original" && entityMaterial.color === 0x112233, "first-class entity material must roll back without losing name/pbr fields");
}

// Compensation resolves the current mesh by traversal index; it must not retain or mutate a
// detached object captured at commit time.
{
  const { kernel, head } = makeKernel();
  await kernel.commit(transaction("tx.material.current-mesh", head, [
    sceneOperation("material.patch", {
      entity: root.id, color: 0x445566, roughness: 0.7, metalness: 0.6, castShadow: true,
    }),
  ]));
  const detached = world.entities.resolve(root.id)!.mesh as FakeSceneObject;
  const replacement = new FakeSceneObject();
  const replacementMaterial = replacement.material as MaterialLike & { color: FakeColor };
  replacementMaterial.color.set(0x445566);
  replacementMaterial.roughness = 0.7;
  replacementMaterial.metalness = 0.6;
  replacement.castShadow = true;
  world.entities.resolve(root.id)!.mesh = replacement;

  await kernel.commit(transaction("tx.material.current-mesh.undo", kernel.head, [], "tx.material.current-mesh"));
  assert(replacementMaterial.color.getHex() === 0x112233 && replacementMaterial.roughness === 0.4, "compensation must restore the currently bound mesh");
  const detachedMaterial = detached.material as MaterialLike & { color: FakeColor };
  assert(detachedMaterial.color.getHex() === 0x445566 && detached.castShadow === true, "compensation must not retain and mutate a detached mesh");
}

// Repeated writes to the same state key compensate in reverse and restore the original state.
{
  const { kernel, head } = makeKernel();
  const original = [Position.x[root.eid], Position.y[root.eid], Position.z[root.eid]];
  const receipt = await kernel.commit(transaction("tx.repeated", head, [
    sceneOperation("transform.set", { entity: root.id, position: [20, 0, 0] }),
    sceneOperation("transform.set", { entity: root.id, position: [30, 0, 0] }),
  ]));
  assert(receipt.operations[0].stateKey === receipt.operations[1].stateKey, "repeated transform scope must use one deterministic state key");
  assert(Position.x[root.eid] === 30, "both repeated transform operations must apply in order");
  await kernel.commit(transaction("tx.repeated.undo", kernel.head, [], "tx.repeated"));
  assert(JSON.stringify([Position.x[root.eid], Position.y[root.eid], Position.z[root.eid]]) === JSON.stringify(original), "compensation must restore the state before the first repeated write");
  assert(kernel.head.revision === 2, "compensation must advance history as a new revision");
}

// Hashes are independent of Set insertion order and stable across repeated captures.
{
  const head = createWorldProjectHead(PROJECT_ID, hash);
  const operation = sceneOperation("tags.replace", { entity: root.id, tags: ["alpha", "zeta"] });
  const tx = transaction("tx.hash", head, [operation]);
  const context: AuthoringAdapterContext = {
    transaction: tx,
    operationIndex: 0,
    head,
    mode: "apply",
    hashJson: (value) => canonicalHash(hash, value),
  };
  world.tags.set(root.eid, new Set(["zeta", "alpha"]));
  const first = await sceneAdapter.capture(operation, context);
  world.tags.set(root.eid, new Set(["alpha", "zeta"]));
  const second = await sceneAdapter.capture(operation, context);
  assert(first.stateHash === second.stateHash, "tag state hash must not depend on insertion order");
  assert(sceneAdapter.stateKey(operation) === "scene:tags:ent_0", "state key must be stable and domain-specific");
}

// Missing/stale identities and malformed values are rejected before mutation.
{
  const { kernel, head } = makeKernel();
  await expectCode(kernel.commit(transaction("tx.missing", head, [
    sceneOperation("transform.set", { entity: "ent_999999", position: [1, 2, 3] }),
  ])), "preflight_failed", "does not exist");
  await expectCode(kernel.commit(transaction("tx.bounds", head, [
    sceneOperation("transform.set", { entity: root.id, position: [1_000_001, 0, 0] }),
  ])), "preflight_failed");
  await expectCode(kernel.commit(transaction("tx.quaternion", head, [
    sceneOperation("transform.set", { entity: root.id, rotation: [0, 0, 0, 0] }),
  ])), "preflight_failed");
  await expectCode(kernel.commit(transaction("tx.tags.duplicate", head, [
    sceneOperation("tags.replace", { entity: root.id, tags: ["same", "same"] }),
  ])), "preflight_failed");
  await expectCode(kernel.commit(transaction("tx.parented", head, [
    sceneOperation("transform.set", { entity: child.id, position: [7, 8, 9] }),
  ])), "preflight_failed", "parented");
  assert(Position.x[root.eid] === 1, "invalid operations must not mutate a live entity");
}

// Lifecycle operations are not advertised until exact stable-ID restore exists. Whole-batch
// validation rejects them before any earlier supported edit can apply.
{
  const { kernel, head } = makeKernel();
  const before = Position.x[root.eid];
  await expectCode(kernel.commit(transaction("tx.create.rejected", head, [
    sceneOperation("transform.set", { entity: root.id, position: [99, 0, 0] }),
    sceneOperation("entity.create", {
      entity: "stable.box.1", primitive: "box", size: 1, position: [0, 0, 0], tags: ["prop"],
    }),
  ])), "preflight_failed");
  assert(Position.x[root.eid] === before && world.entities.resolve("stable.box.1") === undefined, "rejected create must leave the entire batch untouched");

  await expectCode(kernel.commit(transaction("tx.delete.rejected", head, [
    sceneOperation("transform.set", { entity: root.id, position: [98, 0, 0] }),
    sceneOperation("entity.delete", { entity: root.id }),
  ])), "preflight_failed");
  assert(Position.x[root.eid] === before && world.entities.resolve(root.id)?.eid === root.eid, "rejected delete must preserve identity and earlier batch operations");
}

// Body-bound transforms are explicitly unsupported until scoped native physics capture exists.
{
  const physicsEntity = seedEntity(world, [4, 5, 6], { bodyId: 42 });
  const { kernel, head } = makeKernel();
  await expectCode(kernel.commit(transaction("tx.physics.rejected", head, [
    sceneOperation("transform.set", { entity: physicsEntity.id, position: [7, 8, 9] }),
  ])), "preflight_failed", "physics-bearing entity");
  assert(Position.x[physicsEntity.eid] === 4 && Position.y[physicsEntity.eid] === 5, "rejected physics transform must not mutate ECS state");

  const materialReceipt = await kernel.commit(transaction("tx.physics.material", head, [
    sceneOperation("material.patch", { entity: physicsEntity.id, color: 0xabcdef }),
  ]));
  assert(materialReceipt.committedRevision === 1, "non-physics material state on a body-bound entity remains transaction-safe");
}

// Live-world complexity is independently bounded; transaction byte limits do not bound capture work.
{
  const deepMaterialEntity = seedEntity(world, [0, 0, 0]);
  let cursor = deepMaterialEntity.object;
  for (let depth = 0; depth <= 256; depth++) {
    const childObject = new FakeSceneObject();
    cursor.children.push(childObject);
    cursor = childObject;
  }
  const { kernel, head } = makeKernel();
  await expectCode(kernel.commit(transaction("tx.material.depth", head, [
    sceneOperation("material.patch", { entity: deepMaterialEntity.id, color: 0x123456 }),
  ])), "preflight_failed", "maximum depth");
}
{
  const excessiveSlotsEntity = seedEntity(world, [0, 0, 0]);
  const slots = Array.from({ length: 65 }, () => ({ color: new FakeColor(0), roughness: 0.5, metalness: 0 }));
  (excessiveSlotsEntity.object as unknown as { material: unknown }).material = slots;
  const { kernel, head } = makeKernel();
  await expectCode(kernel.commit(transaction("tx.material.slots", head, [
    sceneOperation("material.patch", { entity: excessiveSlotsEntity.id, roughness: 0.6 }),
  ])), "preflight_failed", "material slots");
}
{
  const wideMaterialEntity = seedEntity(world, [0, 0, 0]);
  for (let index = 0; index < 4_096; index++) wideMaterialEntity.object.children.push(new FakeSceneObject());
  const { kernel, head } = makeKernel();
  await expectCode(kernel.commit(transaction("tx.material.objects", head, [
    sceneOperation("material.patch", { entity: wideMaterialEntity.id, metalness: 0.1 }),
  ])), "preflight_failed", "material scope");
}
{
  const hierarchyRoot = seedEntity(world, [0, 0, 0]);
  let parent = hierarchyRoot.id;
  for (let depth = 0; depth <= 256; depth++) {
    parent = seedEntity(world, [0, 0, 0], { parent, localPosition: [0, 0, 0] }).id;
  }
  const { kernel, head } = makeKernel();
  await expectCode(kernel.commit(transaction("tx.transform.depth", head, [
    sceneOperation("transform.set", { entity: hierarchyRoot.id, position: [1, 0, 0] }),
  ])), "preflight_failed", "maximum depth");
  assert(Position.x[hierarchyRoot.eid] === 0, "oversized transform scope must be rejected before mutation");
}

// Keep direct transform evidence explicit; no render-sync side effects are needed for authoring state.
assert(Rotation.w[root.eid] === 1 && Scale.x[root.eid] === 1, "rollback/compensation must preserve untouched transform components");

ops.op_log(
  `p_authoring_scene_adapter OK: ${assertions} assertions -- exact transform/tag/material rollback, ` +
    "reverse compensation, deterministic hashes, strict validation, fail-closed lifecycle and physics boundaries",
);
