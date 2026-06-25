// Phase 3 - collision contact geometry (point + normal) and static collider shapes.
//
// Exercises the real Rapier narrow-phase: Started collision events must carry a
// world-space contact point lying between the two bodies and a unit-length
// manifold normal. Also proves static sphere/capsule colliders actually stop a
// falling dynamic body (a ghost collider would let it tunnel through).

import { ops } from "../src/engine.ts";
import type { CollisionEventRecord } from "../src/engine.ts";

function dist(a: [number, number, number], b: [number, number, number]): number {
  const dx = a[0] - b[0];
  const dy = a[1] - b[1];
  const dz = a[2] - b[2];
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

function readPos(id: number, out: Float32Array): [number, number, number] {
  ops.op_physics_body_pos(id, out);
  return [out[0], out[1], out[2]];
}

// ---------------------------------------------------------------------------
// (1) Two dynamic spheres driven into contact: the Started event must carry a
//     real contact point (between the centers) and a unit-length normal.
// ---------------------------------------------------------------------------
ops.op_physics_create_world(0); // zero gravity: only the sphere-sphere contact matters
const left = ops.op_physics_add_sphere(-2, 0, 0, 0.5, 0.5, 0.0);
const right = ops.op_physics_add_sphere(0, 0, 0, 0.5, 0.5, 0.0);
ops.op_physics_apply_impulse(left, 2, 0, 0); // push the left sphere toward the right one

const scratch = new Float32Array(3);
let started: CollisionEventRecord | null = null;
let centerA: [number, number, number] = [0, 0, 0];
let centerB: [number, number, number] = [0, 0, 0];
for (let i = 0; i < 600 && started === null; i++) {
  ops.op_physics_step();
  for (const rec of ops.op_physics_drain_collisions()) {
    const isPair = (rec.a === left && rec.b === right) || (rec.a === right && rec.b === left);
    if (rec.kind === 1 && isPair && rec.point !== null) {
      started = rec;
      centerA = readPos(left, scratch);
      centerB = readPos(right, scratch);
      break;
    }
  }
}

if (started === null) {
  throw new Error("two spheres never reported a Started contact with a populated point");
}
if (started.point === null) {
  throw new Error("Started contact point is null on a real sphere-sphere collision");
}
if (started.normal === null) {
  throw new Error("Started contact normal is null on a real sphere-sphere collision");
}

const point = started.point;
const normal = started.normal;

// Normal must be a real unit vector (a stubbed/zeroed normal fails here).
const nLen = Math.sqrt(normal[0] * normal[0] + normal[1] * normal[1] + normal[2] * normal[2]);
if (nLen < 0.9 || nLen > 1.1) {
  throw new Error(`contact normal is not unit length: |n|=${nLen} (${normal.join(",")})`);
}
// Head-on collision along x: the normal must point predominantly along x.
if (Math.abs(normal[0]) < 0.8) {
  throw new Error(`head-on contact normal is not along x: ${normal.join(",")}`);
}

// The contact point must lie physically on the segment between the two centers:
// |P-A| + |P-B| ~= |A-B|, with both gaps strictly positive (a zeroed point fails).
const dPA = dist(point, centerA);
const dPB = dist(point, centerB);
const dAB = dist(centerA, centerB);
if (dPA <= 1e-4 || dPB <= 1e-4) {
  throw new Error(`contact point coincides with a center (dPA=${dPA}, dPB=${dPB}) - not between them`);
}
if (Math.abs(dPA + dPB - dAB) > 0.15) {
  throw new Error(
    `contact point not between centers: |P-A|+|P-B|=${(dPA + dPB).toFixed(4)} vs |A-B|=${dAB.toFixed(4)} ` +
      `(P=${point.join(",")}, A=${centerA.join(",")}, B=${centerB.join(",")})`,
  );
}
// A literal hardcoded origin point would also fail the betweenness check above,
// since the centers straddle x=-0.5 at contact, not the origin.
if (point[0] > Math.max(centerA[0], centerB[0]) + 1e-3 || point[0] < Math.min(centerA[0], centerB[0]) - 1e-3) {
  throw new Error(`contact point x=${point[0]} is outside the span of the two centers`);
}

// ---------------------------------------------------------------------------
// (2) Static sphere collider: a dynamic body dropped straight down must rest
//     above it (a ghost collider would let it fall through to y << 0).
// ---------------------------------------------------------------------------
ops.op_physics_create_world(-9.81);
ops.op_physics_add_static_sphere(0, 0, 0, 1.0, 0.9, 0.0); // static surface: top at y=1.0
const dropOnSphere = ops.op_physics_add_sphere(0, 4, 0, 0.3, 0.9, 0.0);
let minYSphere = Infinity;
for (let i = 0; i < 360; i++) {
  ops.op_physics_step();
  const y = readPos(dropOnSphere, scratch)[1];
  if (y < minYSphere) minYSphere = y;
}
const restSphere = readPos(dropOnSphere, scratch);
// Real collider: rests with center near 1.0 (sphere top) + 0.3 (its radius) = 1.3,
// and never sinks below the static sphere's top surface.
if (restSphere[1] < 1.0) {
  throw new Error(`dynamic body sank into the static sphere: rest y=${restSphere[1]} (expected >= 1.0)`);
}
if (restSphere[1] > 2.0) {
  throw new Error(`dynamic body never settled onto the static sphere: rest y=${restSphere[1]}`);
}
if (minYSphere < 1.0 - 0.05) {
  throw new Error(`dynamic body tunneled below the static sphere surface: min y=${minYSphere}`);
}

// ---------------------------------------------------------------------------
// (3) Static capsule collider: same proof against a Y-axis capsule.
// ---------------------------------------------------------------------------
ops.op_physics_create_world(-9.81);
// half_height 1.0, radius 0.5 -> apex (top) at y = 1.0 + 0.5 = 1.5.
ops.op_physics_add_static_capsule(0, 0, 0, 1.0, 0.5, 0.9, 0.0);
const dropOnCapsule = ops.op_physics_add_sphere(0, 5, 0, 0.3, 0.9, 0.0);
let minYCapsule = Infinity;
for (let i = 0; i < 420; i++) {
  ops.op_physics_step();
  const y = readPos(dropOnCapsule, scratch)[1];
  if (y < minYCapsule) minYCapsule = y;
}
const restCapsule = readPos(dropOnCapsule, scratch);
// Real collider: rests on the capsule apex near 1.5 + 0.3 = 1.8; never tunnels
// below the apex region. A ghost capsule would let it fall to deeply negative y.
if (restCapsule[1] < 1.4) {
  throw new Error(`dynamic body sank into the static capsule: rest y=${restCapsule[1]} (expected >= 1.4)`);
}
if (restCapsule[1] > 2.5) {
  throw new Error(`dynamic body never settled onto the static capsule: rest y=${restCapsule[1]}`);
}
if (minYCapsule < 1.4 - 0.05) {
  throw new Error(`dynamic body tunneled below the static capsule surface: min y=${minYCapsule}`);
}

ops.op_log(
  `Collision geometry OK: contact point ${point.map((c) => c.toFixed(3)).join(",")} ` +
    `normal ${normal.map((c) => c.toFixed(3)).join(",")} |n|=${nLen.toFixed(3)}; ` +
    `static sphere rest y=${restSphere[1].toFixed(3)}, static capsule rest y=${restCapsule[1].toFixed(3)}`,
);
