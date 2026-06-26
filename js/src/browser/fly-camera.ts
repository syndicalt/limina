// Free-fly spectator camera for the browser terrain demo. WASD moves along the
// look direction (A/D strafe), Space/C rise/fall, ShiftLeft boosts; click the
// canvas to capture the pointer for mouse look (Esc releases). Browser-only (DOM
// events) — the demo uses it so you can fly the streamed terrain; terrain follows
// the camera's ground position.

interface CameraLike {
  position: { set(x: number, y: number, z: number): void };
  lookAt(x: number, y: number, z: number): void;
}
interface Listenable {
  addEventListener(type: string, cb: (ev: never) => void): void;
  removeEventListener(type: string, cb: (ev: never) => void): void;
}
interface CanvasLike extends Listenable {
  requestPointerLock?(): void;
}
interface DocLike extends Listenable {
  pointerLockElement?: unknown;
}

export interface FlyStart {
  x: number;
  y: number;
  z: number;
  yaw?: number;
  pitch?: number;
}

export class FlyCamera {
  x: number;
  y: number;
  z: number;
  private yaw: number;
  private pitch: number;
  private readonly keys = new Set<string>();
  private locked = false;
  /** Base move speed (units/sec); ShiftLeft applies a boost. */
  speed = 26;
  sensitivity = 0.0022;
  private win?: Listenable;
  private canvas?: CanvasLike;
  private doc?: DocLike;

  constructor(s: FlyStart) {
    this.x = s.x;
    this.y = s.y;
    this.z = s.z;
    this.yaw = s.yaw ?? 0;
    this.pitch = s.pitch ?? -0.25;
  }

  private readonly onKeyDown = (e: { code: string; preventDefault(): void }): void => {
    this.keys.add(e.code);
    if (e.code === "Space" || e.code.startsWith("Arrow")) e.preventDefault();
  };
  private readonly onKeyUp = (e: { code: string }): void => { this.keys.delete(e.code); };
  private readonly onMouse = (e: { movementX: number; movementY: number }): void => {
    if (!this.locked) return;
    this.yaw += e.movementX * this.sensitivity;
    this.pitch -= e.movementY * this.sensitivity;
    const lim = Math.PI / 2 - 0.01;
    this.pitch = Math.max(-lim, Math.min(lim, this.pitch));
  };
  private readonly onLockChange = (): void => { this.locked = this.doc?.pointerLockElement === this.canvas; };
  private readonly onClick = (): void => { this.canvas?.requestPointerLock?.(); };

  attach(win: Listenable, canvas: CanvasLike, doc: DocLike): void {
    this.win = win;
    this.canvas = canvas;
    this.doc = doc;
    win.addEventListener("keydown", this.onKeyDown as (ev: never) => void);
    win.addEventListener("keyup", this.onKeyUp as (ev: never) => void);
    canvas.addEventListener("click", this.onClick as (ev: never) => void);
    doc.addEventListener("mousemove", this.onMouse as (ev: never) => void);
    doc.addEventListener("pointerlockchange", this.onLockChange as (ev: never) => void);
  }

  detach(): void {
    this.win?.removeEventListener("keydown", this.onKeyDown as (ev: never) => void);
    this.win?.removeEventListener("keyup", this.onKeyUp as (ev: never) => void);
    this.canvas?.removeEventListener("click", this.onClick as (ev: never) => void);
    this.doc?.removeEventListener("mousemove", this.onMouse as (ev: never) => void);
    this.doc?.removeEventListener("pointerlockchange", this.onLockChange as (ev: never) => void);
  }

  /** Advance by `dt` seconds, write the pose into `camera`, return the new ground
   *  (x,z) so the caller can stream terrain around it. */
  update(dt: number, camera: CameraLike): { x: number; z: number } {
    const cp = Math.cos(this.pitch), sp = Math.sin(this.pitch);
    const sy = Math.sin(this.yaw), cy = Math.cos(this.yaw);
    const dir: [number, number, number] = [cp * sy, sp, -cp * cy]; // look direction
    const right: [number, number, number] = [cy, 0, sy];           // horizontal right
    const k = this.keys;
    let mx = 0, my = 0, mz = 0;
    if (k.has("KeyW")) { mx += dir[0]; my += dir[1]; mz += dir[2]; }
    if (k.has("KeyS")) { mx -= dir[0]; my -= dir[1]; mz -= dir[2]; }
    if (k.has("KeyD")) { mx += right[0]; mz += right[2]; }
    if (k.has("KeyA")) { mx -= right[0]; mz -= right[2]; }
    if (k.has("Space")) my += 1;
    if (k.has("KeyC")) my -= 1;
    const len = Math.hypot(mx, my, mz);
    if (len > 0) {
      const boost = k.has("ShiftLeft") || k.has("ShiftRight") ? 3.5 : 1;
      const s = (this.speed * boost * dt) / len;
      this.x += mx * s;
      this.y += my * s;
      this.z += mz * s;
    }
    camera.position.set(this.x, this.y, this.z);
    camera.lookAt(this.x + dir[0], this.y + dir[1], this.z + dir[2]);
    return { x: this.x, z: this.z };
  }
}
