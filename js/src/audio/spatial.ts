// limina-audio — spatial math (limina-owned, pure, unit-tested headless).
//
// rodio applies the 1/d² panning/attenuation internally from emitter + two ear
// positions. What limina owns is (a) deriving the two ear positions from the
// camera and (b) an optional max-distance cutoff gain. Both are pure functions
// so they are verifiable without an audio device.

export type Vec3 = readonly [number, number, number];

/** Derive left/right ear positions from the camera: `cam_pos ± halfHead · cam_right`.
 *  `camRight` is normalized first so `halfHead` is a true world distance. */
export function deriveEars(
  camPos: Vec3,
  camRight: Vec3,
  halfHead: number,
): { left: [number, number, number]; right: [number, number, number] } {
  const len = Math.sqrt(camRight[0] * camRight[0] + camRight[1] * camRight[1] + camRight[2] * camRight[2]) || 1; // sqrt: IEEE correctly-rounded, bit-stable (Math.hypot is not)
  const rx = (camRight[0] / len) * halfHead;
  const ry = (camRight[1] / len) * halfHead;
  const rz = (camRight[2] / len) * halfHead;
  return {
    left: [camPos[0] - rx, camPos[1] - ry, camPos[2] - rz],
    right: [camPos[0] + rx, camPos[1] + ry, camPos[2] + rz],
  };
}

/** Distance between two world points. */
export function distance(a: Vec3, b: Vec3): number {
  const dx = a[0] - b[0], dy = a[1] - b[1], dz = a[2] - b[2];
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/** Optional max-distance cutoff gain on top of rodio's 1/d²: full `base` until
 *  80% of `maxDist`, then a smooth ramp to 0 at `maxDist`. `maxDist <= 0` disables. */
export function maxDistanceGain(dist: number, maxDist: number, base: number): number {
  if (maxDist <= 0) return base;
  const t = Math.max(0, Math.min(1, (maxDist - dist) / (maxDist * 0.2)));
  return base * t;
}
