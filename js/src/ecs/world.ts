// limina ECS (Phase 0): bitECS world with SoA TypedArray transform components
// and a render-sync system that copies ECS transforms onto three Object3Ds.
//
// Transforms are the load-bearing contract between simulation (physics) and
// rendering: physics writes Position/Rotation, renderSyncSystem pushes them to
// the scene graph. Storage is plain Float32Arrays (cache-friendly, JIT-able,
// and a zero-copy path to native systems later).

import { addComponent, addEntity, createWorld, query, removeEntity } from "../../build/bitecs.bundle.mjs";

export const MAX_ENTITIES = 16384;

// ---- Per-world transform storage (Finding #8) -----------------------------
// The transform SoA used to be module-global Float32Arrays. That made TWO worlds
// in one process (e.g. a replay/verify world beside a live one) collide on the
// same eid slots -- eids are allocated monotonically per bitECS world, so world A
// eid 5 and world B eid 5 aliased the same array cell. Now each world OWNS a
// TransformStore; the Position/Rotation/Scale views below are REBOUND to the
// active world's store on setActiveTransformStore().
//
// SINGLE-world callers never touch activation: the default store is bound at
// module init and stays bound, so every `Position.x[eid]` site reads/writes the
// exact same arrays as before -- byte-for-byte identical, no call-site changes.
//
// MULTI-world callers (see js/test/p32_two_worlds.ts) activate the target world's
// store before reading/writing/stepping it. Because the binding is process-global
// (three.js render sync, bitECS queries, and the worldlog snapshot all read the
// Position/Rotation/Scale views), the constraint is: at most one world is ACTIVE
// at a time, and a world's transform work must run while its store is active.

export interface Vec3Store {
  x: Float32Array;
  y: Float32Array;
  z: Float32Array;
}
export interface Vec4Store extends Vec3Store {
  w: Float32Array;
}

/** A world's private transform SoA (Position/Rotation/Scale), MAX_ENTITIES wide. */
export interface TransformStore {
  position: Vec3Store;
  rotation: Vec4Store;
  scale: Vec3Store;
}

/** Allocate a fresh, zeroed transform store for a new world. */
export function createTransformStore(): TransformStore {
  return {
    position: {
      x: new Float32Array(MAX_ENTITIES),
      y: new Float32Array(MAX_ENTITIES),
      z: new Float32Array(MAX_ENTITIES),
    },
    rotation: {
      x: new Float32Array(MAX_ENTITIES),
      y: new Float32Array(MAX_ENTITIES),
      z: new Float32Array(MAX_ENTITIES),
      w: new Float32Array(MAX_ENTITIES),
    },
    scale: {
      x: new Float32Array(MAX_ENTITIES),
      y: new Float32Array(MAX_ENTITIES),
      z: new Float32Array(MAX_ENTITIES),
    },
  };
}

const defaultTransformStore = createTransformStore();
let activeTransformStore: TransformStore = defaultTransformStore;

// Component views. Their object identity is STABLE (bitECS uses them as opaque
// component keys via addComponent/query); only their .x/.y/.z(/w) array fields
// are rebound on activation. Initialized to the default store so imports that use
// them at module-eval time see live arrays.
export const Position: Vec3Store = {
  x: defaultTransformStore.position.x,
  y: defaultTransformStore.position.y,
  z: defaultTransformStore.position.z,
};
export const Rotation: Vec4Store = {
  x: defaultTransformStore.rotation.x,
  y: defaultTransformStore.rotation.y,
  z: defaultTransformStore.rotation.z,
  w: defaultTransformStore.rotation.w,
};
export const Scale: Vec3Store = {
  x: defaultTransformStore.scale.x,
  y: defaultTransformStore.scale.y,
  z: defaultTransformStore.scale.z,
};

/** Bind `store` as the active world's transform storage, rebinding the shared
 *  Position/Rotation/Scale views to its arrays. Single-world code never calls
 *  this; multi-world code activates a world before touching its transforms. */
export function setActiveTransformStore(store: TransformStore): void {
  activeTransformStore = store;
  Position.x = store.position.x;
  Position.y = store.position.y;
  Position.z = store.position.z;
  Rotation.x = store.rotation.x;
  Rotation.y = store.rotation.y;
  Rotation.z = store.rotation.z;
  Rotation.w = store.rotation.w;
  Scale.x = store.scale.x;
  Scale.y = store.scale.y;
  Scale.z = store.scale.z;
}

/** The currently active transform store (the one Position/Rotation/Scale alias). */
export function getActiveTransformStore(): TransformStore {
  return activeTransformStore;
}

/** The process default store, active until a multi-world caller activates another. */
export function getDefaultTransformStore(): TransformStore {
  return defaultTransformStore;
}

interface Vec3Settable {
  set(x: number, y: number, z: number): void;
}
interface Vec4Settable {
  set(x: number, y: number, z: number, w: number): void;
}
export interface Transformable {
  position: Vec3Settable;
  quaternion: Vec4Settable;
  scale: Vec3Settable;
}

export interface PhysicsTransformOps {
  op_physics_body_transform(id: number, out: Float32Array): void;
}

// Sparse map eid -> scene object. AoS (object refs) deliberately, since three
// objects are not SoA-friendly; only the numeric transforms live in TypedArrays.
const renderables: (Transformable | undefined)[] = [];

export function createEcsWorld(): unknown {
  return createWorld();
}

/** Spawn an entity with identity transform bound to a scene object. */
export function spawnRenderable(
  world: unknown,
  object: Transformable,
  x: number,
  y: number,
  z: number,
): number {
  const eid: number = addEntity(world);
  addComponent(world, eid, Position);
  addComponent(world, eid, Rotation);
  addComponent(world, eid, Scale);
  Position.x[eid] = x;
  Position.y[eid] = y;
  Position.z[eid] = z;
  Rotation.x[eid] = 0;
  Rotation.y[eid] = 0;
  Rotation.z[eid] = 0;
  Rotation.w[eid] = 1;
  Scale.x[eid] = 1;
  Scale.y[eid] = 1;
  Scale.z[eid] = 1;
  renderables[eid] = object;
  return eid;
}

/** Tear down an entity: free the eid (bitECS may recycle it) and drop its scene
 *  object binding so a recycled eid never renders the old mesh. */
export function despawnRenderable(world: unknown, eid: number): void {
  renderables[eid] = undefined;
  removeEntity(world, eid);
}

/** Copy ECS transforms onto their bound scene objects. The ONLY path that
 *  drives object transforms - removing it freezes the scene. */
export function renderSyncSystem(world: unknown): void {
  for (const eid of query(world, [Position, Rotation, Scale])) {
    const object = renderables[eid];
    if (object === undefined) continue;
    object.position.set(Position.x[eid], Position.y[eid], Position.z[eid]);
    object.quaternion.set(Rotation.x[eid], Rotation.y[eid], Rotation.z[eid], Rotation.w[eid]);
    object.scale.set(Scale.x[eid], Scale.y[eid], Scale.z[eid]);
  }
}

/** Copy a native physics body's full transform into ECS SoA storage. */
export function syncPhysicsBodyTransform(
  eid: number,
  bodyId: number,
  ops: PhysicsTransformOps,
  scratch = new Float32Array(7),
): void {
  ops.op_physics_body_transform(bodyId, scratch);
  Position.x[eid] = scratch[0];
  Position.y[eid] = scratch[1];
  Position.z[eid] = scratch[2];
  Rotation.x[eid] = scratch[3];
  Rotation.y[eid] = scratch[4];
  Rotation.z[eid] = scratch[5];
  Rotation.w[eid] = scratch[6];
}
