// Euler <-> quaternion (kernel). The GDS world slice stores rotation as EULER radians [x,y,z]
// (human- and diff-readable), while the engine's `ecs.updateComponent` rotation takes a QUATERNION
// [x,y,z,w] and a live gizmo also produces one. These convert between the two at that boundary.
// Both use the intrinsic XYZ order that Three.js uses by default (Euler order "XYZ"), so a value
// authored against a Three-built scene round-trips. Pure + dependency-free (no three import), so it
// runs on the headless authoring path.

/** Euler radians [x,y,z] (XYZ order) -> quaternion [x,y,z,w]. Matches THREE.Quaternion.setFromEuler
 *  with order "XYZ". */
export function eulerToQuaternion(x: number, y: number, z: number): [number, number, number, number] {
  const c1 = Math.cos(x / 2), s1 = Math.sin(x / 2);
  const c2 = Math.cos(y / 2), s2 = Math.sin(y / 2);
  const c3 = Math.cos(z / 2), s3 = Math.sin(z / 2);
  return [
    s1 * c2 * c3 + c1 * s2 * s3,
    c1 * s2 * c3 - s1 * c2 * s3,
    c1 * c2 * s3 + s1 * s2 * c3,
    c1 * c2 * c3 - s1 * s2 * s3,
  ];
}

/** Quaternion [x,y,z,w] -> Euler radians [x,y,z] (XYZ order). Matches THREE.Euler.setFromQuaternion
 *  with order "XYZ": builds the rotation matrix from the quaternion, then extracts XYZ, clamping the
 *  y term and handling the gimbal pole (|m13| ~ 1) exactly as Three does. */
export function quaternionToEuler(x: number, y: number, z: number, w: number): [number, number, number] {
  const x2 = x + x, y2 = y + y, z2 = z + z;
  const xx = x * x2, xy = x * y2, xz = x * z2;
  const yy = y * y2, yz = y * z2, zz = z * z2;
  const wx = w * x2, wy = w * y2, wz = w * z2;
  const m11 = 1 - (yy + zz), m12 = xy - wz, m13 = xz + wy;
  const m22 = 1 - (xx + zz), m23 = yz - wx;
  const m32 = yz + wx, m33 = 1 - (xx + yy);
  const clamp = (v: number): number => (v < -1 ? -1 : v > 1 ? 1 : v);
  const ey = Math.asin(clamp(m13));
  if (Math.abs(m13) < 0.9999999) {
    return [Math.atan2(-m23, m33), ey, Math.atan2(-m12, m11)];
  }
  return [Math.atan2(m32, m22), ey, 0];
}
