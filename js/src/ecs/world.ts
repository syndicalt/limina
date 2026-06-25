// limina ECS (Phase 0): bitECS world with SoA TypedArray transform components
// and a render-sync system that copies ECS transforms onto three Object3Ds.
//
// Transforms are the load-bearing contract between simulation (physics) and
// rendering: physics writes Position/Rotation, renderSyncSystem pushes them to
// the scene graph. Storage is plain Float32Arrays (cache-friendly, JIT-able,
// and a zero-copy path to native systems later).

import { addComponent, addEntity, createWorld, query, removeEntity } from "../../build/bitecs.bundle.mjs";

export const MAX_ENTITIES = 16384;

export const Position = {
  x: new Float32Array(MAX_ENTITIES),
  y: new Float32Array(MAX_ENTITIES),
  z: new Float32Array(MAX_ENTITIES),
};
export const Rotation = {
  x: new Float32Array(MAX_ENTITIES),
  y: new Float32Array(MAX_ENTITIES),
  z: new Float32Array(MAX_ENTITIES),
  w: new Float32Array(MAX_ENTITIES),
};
export const Scale = {
  x: new Float32Array(MAX_ENTITIES),
  y: new Float32Array(MAX_ENTITIES),
  z: new Float32Array(MAX_ENTITIES),
};

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
