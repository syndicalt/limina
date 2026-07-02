// Scene-hierarchy transform propagation. limina keeps WORLD-space transforms in the SoA
// as the render/physics authority (see js/src/ecs/world.ts) — it is NOT a local-transform
// scene graph. Parenting is therefore a relation (parent id + captured localOffset on the
// entity) plus this propagation pass: when a parent's transform changes, recompute each
// descendant's WORLD transform = parentWorld ∘ localOffset and write it to the SoA.
//
// SCOPE: propagation writes the SoA, so body-LESS renderables follow. A body-bound child's
// SoA is overwritten by the physics authority (`syncAllBodies`) on the next tick — the same
// pre-existing limitation that stops `ecs.updateComponent` from moving a body-bound entity.
// Body-follow needs a future set-body-transform op; it is not introduced (or hidden) here.

import * as THREE from "../../build/three.bundle.mjs";
import { Position, Rotation, Scale } from "./world.ts";
import type { TransformOffset } from "../engine.ts";
import type { WorldContext } from "../skills/registry.ts";

// Scratch decompose targets — reused within a single node (consumed before recursion).
const _p = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3();

function worldMatrixOf(eid: number, out: THREE.Matrix4): THREE.Matrix4 {
  _p.set(Position.x[eid], Position.y[eid], Position.z[eid]);
  _q.set(Rotation.x[eid], Rotation.y[eid], Rotation.z[eid], Rotation.w[eid]);
  _s.set(Scale.x[eid], Scale.y[eid], Scale.z[eid]);
  return out.compose(_p, _q, _s);
}
function offsetMatrix(off: TransformOffset, out: THREE.Matrix4): THREE.Matrix4 {
  _p.set(off.pos[0], off.pos[1], off.pos[2]);
  _q.set(off.rot[0], off.rot[1], off.rot[2], off.rot[3]);
  _s.set(off.scale[0], off.scale[1], off.scale[2]);
  return out.compose(_p, _q, _s);
}

/** Recompute + write the WORLD transform of every descendant of `parentId` from the parent's
 *  current world transform and each child's stored localOffset. Recurses to grandchildren. */
export function propagateTransform(world: WorldContext, parentId: string): void {
  const parent = world.entities.resolve(parentId);
  if (parent === undefined) return;
  const parentWorld = worldMatrixOf(parent.eid, new THREE.Matrix4());
  propagateFrom(world, parentId, parentWorld);
}

function propagateFrom(world: WorldContext, parentId: string, parentWorld: THREE.Matrix4): void {
  for (const childId of world.entities.childrenOf(parentId)) {
    const child = world.entities.resolve(childId);
    if (child === undefined || child.localOffset === undefined) continue;
    // childWorld = parentWorld ∘ localOffset. Own Matrix4 per node so it survives as the
    // parentWorld for the recursion into this child's grandchildren.
    const childWorld = offsetMatrix(child.localOffset, new THREE.Matrix4()).premultiply(parentWorld);
    childWorld.decompose(_p, _q, _s);
    world.transforms.writePosition(child.eid, _p.x, _p.y, _p.z);
    world.transforms.writeRotation(child.eid, _q.x, _q.y, _q.z, _q.w);
    world.transforms.writeScale(child.eid, _s.x, _s.y, _s.z);
    propagateFrom(world, childId, childWorld);
  }
}

/** True if `ancestorId` is `nodeId` itself or any ancestor of it (walks the parent chain).
 *  Used to reject a reparent that would create a cycle (bounded by chain length). */
export function isAncestor(world: WorldContext, ancestorId: string, nodeId: string): boolean {
  let cur: string | undefined = nodeId;
  const seen = new Set<string>();
  while (cur !== undefined) {
    if (cur === ancestorId) return true;
    if (seen.has(cur)) break; // defensive: never loop on a pre-existing corrupt chain
    seen.add(cur);
    cur = world.entities.resolve(cur)?.parent;
  }
  return false;
}

/** Capture a child's transform RELATIVE to a parent: localOffset = parentWorld⁻¹ ∘ childWorld.
 *  Used when parenting/reparenting with keep-world-transform (the child stays put; only its
 *  offset is (re)computed). Reads both entities' current world transforms from the SoA. */
export function computeLocalOffset(world: WorldContext, parentId: string, childEid: number): TransformOffset {
  const parent = world.entities.resolve(parentId);
  if (parent === undefined) return { pos: [0, 0, 0], rot: [0, 0, 0, 1], scale: [1, 1, 1] };
  const parentWorld = worldMatrixOf(parent.eid, new THREE.Matrix4()).invert();
  const childWorld = worldMatrixOf(childEid, new THREE.Matrix4());
  childWorld.premultiply(parentWorld); // parentWorld⁻¹ ∘ childWorld
  childWorld.decompose(_p, _q, _s);
  return { pos: [_p.x, _p.y, _p.z], rot: [_q.x, _q.y, _q.z, _q.w], scale: [_s.x, _s.y, _s.z] };
}
