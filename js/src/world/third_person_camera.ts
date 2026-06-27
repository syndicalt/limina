// Phase 12 — third-person ORBIT camera.
//
// Follows a character at a distance, orbits with the mouse (op_input_look), and
// looks at the character (with a small head-height bias so the framing sits above
// the feet). Lives in the RENDER path, not the sim — it reads raw mouse deltas
// and the latest character position each frame; it holds no simulation state.

import type { CameraLike } from "../engine.ts";

/** Tunables for the orbit camera. */
export interface ThirdPersonCameraOptions {
  /** Orbit distance from the target (m). Default 7. */
  distance?: number;
  /** Height of the look-at point above the target center (m). Default 1.2. */
  lookHeight?: number;
  /** Radians of yaw/pitch per raw mouse unit. Default 0.0022. */
  sensitivity?: number;
  /** Initial yaw (radians); 0 places the camera behind a -Z-facing target. */
  yaw?: number;
  /** Initial pitch (radians, looking down is negative). Default -0.25. */
  pitch?: number;
  /** Min pitch (radians). Default -1.2 (~ -69deg). */
  minPitch?: number;
  /** Max pitch (radians). Default 1.05 (~ 60deg). */
  maxPitch?: number;
}

export class ThirdPersonCamera {
  /** Current orbit yaw (radians). Movement should be made relative to this so
   *  "forward" walks where the camera looks. */
  yaw: number;
  /** Current orbit pitch (radians). */
  pitch: number;

  private readonly distance: number;
  private readonly lookHeight: number;
  private readonly sensitivity: number;
  private readonly minPitch: number;
  private readonly maxPitch: number;

  constructor(opts: ThirdPersonCameraOptions = {}) {
    this.distance = opts.distance ?? 7;
    this.lookHeight = opts.lookHeight ?? 1.2;
    this.sensitivity = opts.sensitivity ?? 0.0022;
    this.yaw = opts.yaw ?? 0;
    this.pitch = opts.pitch ?? -0.25;
    this.minPitch = opts.minPitch ?? -1.2;
    this.maxPitch = opts.maxPitch ?? 1.05;
  }

  /** Apply a raw mouse-look delta (op_input_look output) to the orbit angles. */
  applyLook(dx: number, dy: number): void {
    this.yaw += dx * this.sensitivity;
    this.pitch -= dy * this.sensitivity;
    if (this.pitch < this.minPitch) this.pitch = this.minPitch;
    if (this.pitch > this.maxPitch) this.pitch = this.maxPitch;
  }

  /** Position the camera on its orbit around `target` (the character center) and
   *  look at the target (raised by `lookHeight`). Call once per render frame. */
  update(camera: CameraLike, target: readonly [number, number, number]): void {
    const cp = Math.cos(this.pitch);
    const sp = Math.sin(this.pitch);
    const sy = Math.sin(this.yaw);
    const cyaw = Math.cos(this.yaw);
    // Offset points BEHIND the target along the view direction. yaw=0 -> camera
    // sits at +Z behind a target that faces -Z; pitch raises/lowers it.
    const ox = -sy * cp * this.distance;
    const oy = -sp * this.distance + this.lookHeight;
    const oz = cyaw * cp * this.distance;
    camera.position.set(target[0] + ox, target[1] + oy, target[2] + oz);
    camera.lookAt(target[0], target[1] + this.lookHeight, target[2]);
  }
}
