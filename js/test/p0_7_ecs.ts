// P0.7 - bitECS world + render-sync. Proves the scene object's transform is
// driven ENTIRELY by the ECS SoA arrays: mutating Position/Rotation and running
// renderSyncSystem moves the bound three Object3D and nothing else does.

import * as THREE from "../build/three.bundle.mjs";
import {
  createEcsWorld,
  Position,
  renderSyncSystem,
  Rotation,
  spawnRenderable,
} from "../src/ecs/world.ts";

declare const Deno: { core: { ops: { op_log(msg: string): void } } };
const log = Deno.core.ops.op_log;

const world = createEcsWorld();
const object = new THREE.Object3D();
const eid = spawnRenderable(world, object, 1, 2, 3);

// Initial sync reflects the spawn transform.
renderSyncSystem(world);
if (object.position.x !== 1 || object.position.y !== 2 || object.position.z !== 3) {
  throw new Error(`initial position ${object.position.x},${object.position.y},${object.position.z}`);
}
if (object.quaternion.w !== 1) throw new Error(`initial quaternion w ${object.quaternion.w}`);

// Mutating the ECS arrays + re-syncing moves the object.
Position.y[eid] = 42;
Position.x[eid] = -7;
// 90deg about Y as a quaternion (x,y,z,w).
const h = Math.SQRT1_2;
Rotation.y[eid] = h;
Rotation.w[eid] = h;
renderSyncSystem(world);

if (object.position.y !== 42 || object.position.x !== -7) {
  throw new Error(`after mutate position ${object.position.x},${object.position.y}`);
}
if (Math.abs(object.quaternion.y - h) > 1e-6 || Math.abs(object.quaternion.w - h) > 1e-6) {
  throw new Error(`after mutate quaternion ${object.quaternion.y},${object.quaternion.w}`);
}

// Without a re-sync, further ECS edits must NOT leak to the object (the sync
// system is the only driver).
Position.y[eid] = 999;
if (object.position.y !== 42) {
  throw new Error(`object changed without renderSyncSystem: ${object.position.y}`);
}

log(`P0.7 OK: render-sync drives the scene object from ECS SoA (eid ${eid})`);
