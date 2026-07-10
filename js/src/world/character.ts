// Phase 12 — input-driven CHARACTER CONTROLLER.
//
// A reusable, deterministic kinematic-capsule controller that walks/runs on the
// generated Rapier terrain. It wraps the native `op_physics_add_character` /
// `op_physics_move_character` ops (Rapier's `KinematicCharacterController`:
// slide, slope limit, autostep, snap-to-ground) and layers game-feel verticals
// (gravity integration + jump) on top.
//
// DETERMINISM: the controller holds its mutable movement/swim state on `this`.
// `step()` is deterministic for (controller state, command, dt, contact result),
// and the native correction is deterministic given the world state. The controller does NOT advance the simulation — it
// queues the body's next kinematic translation; the owning sim loop calls
// `ops.op_physics_step()` exactly once per fixed step AFTER `step()`.
//
// REPLAY / SNAPSHOT (limina's core invariant): when a session is being recorded,
// the `ops` passed in are the recorder's wrapped ops, so each `add_character` /
// `move_character` issued at depth 0 is logged as a `physics` command (see
// js/src/worldlog/log.ts). Replay re-issues those recorded scalar inputs and
// `move_shape` re-resolves the correction deterministically, so a recorded
// session with a character replays bit-identically. For M2 mid-stream snapshots,
// the body TRANSFORM rides in the native blob, but the controller's JS-owned
// vy/grounded/heading/swimming state do NOT — `serializeState`/`restoreState` carry them so the
// snapshot/restore path resumes a character exactly (see snapshot.ts).
//
// KNOWN LIMITATION: a per-step vertical move at terminal velocity
// (maxFallSpeed/60 m) approaches the capsule radius + snap reach. `move_shape`
// shape-casts the full desired translation (so it will not tunnel through a
// collider lying in the swept path), but extremely thin colliders combined with
// very high fall speeds are the classic kinematic-controller caveat;
// `maxFallSpeed` defaults conservatively below that threshold.

import type { PhysicsOps } from "../engine.ts";

function boundedPositiveOption(value: number, maximum: number, label: string): number {
  if (!Number.isFinite(value) || value <= 0 || value > maximum) {
    throw new RangeError(`character ${label} must be finite and in (0, ${maximum}]`);
  }
  return value;
}

/** A character controller's body-LESS resume state (the part of its state the
 *  native physics snapshot cannot carry). */
export interface CharacterState {
  vy: number;
  grounded: boolean;
  heading: number;
  /** Hysteresis-bearing swim mode. Contact/body identity is re-derived on the next step. */
  swimming: boolean;
}

export const PLAYER_EYE_OFFSET_M = 0.7;
export const SWIM_ENTER_IMMERSION_RATIO = 0.5;
export const SWIM_EXIT_IMMERSION_RATIO = 0.35;
export const SWIM_ENTER_COLUMN_DEPTH_M = 0.75;
export const SWIM_EXIT_COLUMN_DEPTH_M = 0.5;
export const SWIM_SUBMERGED_EPSILON_M = 0.05;
export const SWIM_SURFACE_ACCELERATION_MPS2 = 10;
export const MAX_SWIM_SPEED_MPS = 100;
export const MAX_BUOYANCY_GAIN_PER_S2 = 1_000;
export const MAX_WATER_DRAG_PER_S = 1_000;
export const MAX_SWIM_VERTICAL_SPEED_MPS = 100;

export interface CharacterWaterContact {
  wet: boolean;
  surfaceLevelM: number | null;
  columnDepthM: number;
  bodyId: string | null;
  kind: string | null;
}

export interface CharacterWaterContactProvider {
  query(worldX: number, worldZ: number): CharacterWaterContact;
}

export interface CharacterWaterState {
  mode: "dry" | "wading" | "swimming";
  submerged: boolean;
  surfaceLevelM: number | null;
  columnDepthM: number;
  immersionRatio: number;
  bodyId: string | null;
  kind: string | null;
}

/** Tunables for a character. All optional; defaults give a snappy third-person feel. */
export interface CharacterOptions {
  /** Capsule cylindrical half-height in meters (EXCLUDES the radius caps). Default 0.5. */
  halfHeight?: number;
  /** Capsule radius in meters. Default 0.35. */
  radius?: number;
  /** Ground walk speed (m/s). Default 4.5. */
  walkSpeed?: number;
  /** Run/sprint speed (m/s). Default 8.0. */
  runSpeed?: number;
  /** Downward gravity acceleration magnitude (m/s^2). Default 22 (snappier than 9.81). */
  gravity?: number;
  /** Initial upward velocity of a jump (m/s). Default 8. */
  jumpSpeed?: number;
  /** Terminal fall speed clamp (m/s). Default 40 — kept so the per-step descent
   *  (maxFallSpeed/60 m) stays below the capsule radius + snap reach (see the
   *  fall-tunneling note in the module header). */
  maxFallSpeed?: number;
  /** Canonical per-world water query. Omit to preserve the exact legacy dry trajectory. */
  waterContact?: CharacterWaterContactProvider;
  /** Horizontal swim speed (m/s). Sprint is deliberately ignored in water. Default 3.0. */
  swimSpeed?: number;
  /** Spring gain toward the capsule-relative float target (1/s²). Default 18. */
  buoyancyGain?: number;
  /** Linear vertical damping while swimming (1/s). Default 6. */
  waterDrag?: number;
  /** Symmetric vertical swim-speed clamp (m/s). Default 4. */
  maxSwimVerticalSpeed?: number;
}

/** One fixed-step movement intent. `forward`/`strafe` are axes in [-1, 1]
 *  (+forward, +strafe = right); they are rotated into world space by `yaw`
 *  (radians) — the caller chooses the basis: a SIM-owned heading (so the
 *  trajectory never depends on render state) or a camera yaw for camera-relative
 *  control. `jump` triggers on the rising edge while grounded; `run` swaps walk
 *  speed for run speed while held. */
export interface MoveCommand {
  forward: number;
  strafe: number;
  yaw: number;
  run: boolean;
  jump: boolean;
}

export class CharacterController {
  /** Stable native body id of the kinematic capsule. */
  readonly bodyId: number;
  /** Capsule cylindrical half-height (excludes the radius caps). */
  readonly halfHeight: number;
  /** Capsule radius. */
  readonly radius: number;

  private readonly ops: PhysicsOps;
  private readonly walkSpeed: number;
  private readonly runSpeed: number;
  private readonly gravity: number;
  private readonly jumpSpeed: number;
  private readonly maxFallSpeed: number;
  private readonly waterContact: CharacterWaterContactProvider | undefined;
  private readonly swimSpeed: number;
  private readonly buoyancyGain: number;
  private readonly waterDrag: number;
  private readonly maxSwimVerticalSpeed: number;

  /** Controller-integrated vertical velocity (m/s). The body is kinematic, so the
   *  controller — not the solver — owns gravity. */
  private vy = 0;
  private grounded = false;
  /** Facing yaw (radians); local +Z points along the last horizontal move dir,
   *  matching the engine's yaw->quaternion convention (Rotation.y=sin(yaw/2)). */
  private heading = 0;
  private touchingWater = false;
  private swimming = false;
  private submerged = false;
  private waterSurfaceLevelM: number | null = null;
  private waterColumnDepthM = 0;
  private waterImmersionRatio = 0;
  private waterBodyId: string | null = null;
  private waterKind: string | null = null;

  private readonly out = new Float32Array(4);
  private readonly _pos: [number, number, number];

  /** Spawn the capsule at `position` (the capsule CENTER). Use `groundOffset` to
   *  place the center the right distance above a surface height. */
  constructor(
    ops: PhysicsOps,
    position: readonly [number, number, number],
    opts: CharacterOptions = {},
  ) {
    this.ops = ops;
    this.halfHeight = opts.halfHeight ?? 0.5;
    this.radius = opts.radius ?? 0.35;
    this.walkSpeed = opts.walkSpeed ?? 4.5;
    this.runSpeed = opts.runSpeed ?? 8.0;
    this.gravity = opts.gravity ?? 22;
    this.jumpSpeed = opts.jumpSpeed ?? 8;
    this.maxFallSpeed = opts.maxFallSpeed ?? 40;
    this.waterContact = opts.waterContact;
    this.swimSpeed = boundedPositiveOption(opts.swimSpeed ?? 3, MAX_SWIM_SPEED_MPS, "swimSpeed");
    this.buoyancyGain = boundedPositiveOption(opts.buoyancyGain ?? 18, MAX_BUOYANCY_GAIN_PER_S2, "buoyancyGain");
    this.waterDrag = boundedPositiveOption(opts.waterDrag ?? 6, MAX_WATER_DRAG_PER_S, "waterDrag");
    this.maxSwimVerticalSpeed = boundedPositiveOption(
      opts.maxSwimVerticalSpeed ?? 4,
      MAX_SWIM_VERTICAL_SPEED_MPS,
      "maxSwimVerticalSpeed",
    );
    this.bodyId = ops.op_physics_add_character(
      position[0],
      position[1],
      position[2],
      this.halfHeight,
      this.radius,
    );
    this._pos = [position[0], position[1], position[2]];
  }

  /** Distance from the capsule CENTER to its lowest point (half-height + radius).
   *  Add to a surface height to get the resting center Y. */
  get groundOffset(): number {
    return this.halfHeight + this.radius;
  }

  /** Last known capsule-center world position [x, y, z] (the queued post-step
   *  target; equals the body position once `op_physics_step()` has run). */
  get position(): readonly [number, number, number] {
    return this._pos;
  }

  /** Whether the capsule was grounded after the most recent `step()`. */
  get isGrounded(): boolean {
    return this.grounded;
  }

  /** Facing yaw in radians (for orienting a mesh: Rotation.y=sin(yaw/2), w=cos(yaw/2)). */
  get facing(): number {
    return this.heading;
  }

  get isSwimming(): boolean { return this.swimming; }
  get isSubmerged(): boolean { return this.submerged; }
  get waterMode(): CharacterWaterState["mode"] {
    return this.swimming ? "swimming" : this.touchingWater ? "wading" : "dry";
  }

  /** Observable copy; the fixed-step loop itself mutates only scalar fields and allocates nothing. */
  get waterState(): Readonly<CharacterWaterState> {
    return Object.freeze({
      mode: this.waterMode,
      submerged: this.submerged,
      surfaceLevelM: this.waterSurfaceLevelM,
      columnDepthM: this.waterColumnDepthM,
      immersionRatio: this.waterImmersionRatio,
      bodyId: this.waterBodyId,
      kind: this.waterKind,
    });
  }

  /** Advance the controller ONE fixed step. MUST be called before
   *  `ops.op_physics_step()` in the same fixed step. Deterministic given
   *  (controller state, `cmd`, `dt`). */
  step(cmd: MoveCommand, dt: number): void {
    const priorSwimming = this.swimming;
    const contact = this.waterContact?.query(this._pos[0], this._pos[2]);
    const surfaceLevelM = contact?.surfaceLevelM;
    if (contact?.wet === true && surfaceLevelM !== null && surfaceLevelM !== undefined) {
      if (!Number.isFinite(surfaceLevelM) || !Number.isFinite(contact.columnDepthM) || contact.columnDepthM < 0) {
        throw new Error("character water contact returned invalid finite depth/surface data");
      }
      const immersion = Math.max(0, Math.min(2 * this.groundOffset, surfaceLevelM - (this._pos[1] - this.groundOffset)));
      this.waterImmersionRatio = immersion / (2 * this.groundOffset);
      this.touchingWater = immersion > 0;
      this.waterSurfaceLevelM = surfaceLevelM;
      this.waterColumnDepthM = contact.columnDepthM;
      this.waterBodyId = contact.bodyId;
      this.waterKind = contact.kind;
    } else {
      this.touchingWater = false;
      this.waterImmersionRatio = 0;
      this.waterSurfaceLevelM = null;
      this.waterColumnDepthM = 0;
      this.waterBodyId = null;
      this.waterKind = null;
    }
    this.swimming = priorSwimming
      ? this.touchingWater && this.waterColumnDepthM >= SWIM_EXIT_COLUMN_DEPTH_M && this.waterImmersionRatio >= SWIM_EXIT_IMMERSION_RATIO
      : this.touchingWater && this.waterColumnDepthM >= SWIM_ENTER_COLUMN_DEPTH_M && this.waterImmersionRatio >= SWIM_ENTER_IMMERSION_RATIO;

    // Horizontal move, rotated from camera-relative axes into world space.
    // yaw=0 -> forward is -Z, right is +X (matches the third-person camera basis).
    const sy = Math.sin(cmd.yaw);
    const cy = Math.cos(cmd.yaw);
    let mx = sy * cmd.forward + cy * cmd.strafe;
    let mz = -cy * cmd.forward + sy * cmd.strafe;
    const mag = Math.sqrt(mx * mx + mz * mz); // sqrt: IEEE correctly-rounded, bit-stable (Math.hypot is not)
    if (mag > 1) {
      mx /= mag;
      mz /= mag;
    }
    if (mag > 1e-5) this.heading = Math.atan2(mx, mz);
    const speed = this.swimming ? this.swimSpeed : cmd.run ? this.runSpeed : this.walkSpeed;
    const dx = mx * speed * dt;
    const dz = mz * speed * dt;

    if (this.swimming) {
      // Clamp inherited fall velocity on entry, then integrate a deterministic spring-damper
      // toward a capsule-relative float pose (center = surface - cylindrical half-height).
      if (this.vy < -this.maxSwimVerticalSpeed) this.vy = -this.maxSwimVerticalSpeed;
      if (this.vy > this.maxSwimVerticalSpeed) this.vy = this.maxSwimVerticalSpeed;
      const floatTargetY = (this.waterSurfaceLevelM as number) - this.halfHeight;
      const buoyancyAcceleration = (floatTargetY - this._pos[1]) * this.buoyancyGain - this.vy * this.waterDrag
        + (cmd.jump ? SWIM_SURFACE_ACCELERATION_MPS2 : 0);
      this.vy += buoyancyAcceleration * dt;
      if (this.vy < -this.maxSwimVerticalSpeed) this.vy = -this.maxSwimVerticalSpeed;
      if (this.vy > this.maxSwimVerticalSpeed) this.vy = this.maxSwimVerticalSpeed;
      this.grounded = false;
    } else {
      // Legacy dry/wading vertical path. Keep operation order exact for replay compatibility.
      if (cmd.jump && this.grounded) {
        this.vy = this.jumpSpeed;
        this.grounded = false;
      }
      this.vy -= this.gravity * dt;
      if (this.vy < -this.maxFallSpeed) this.vy = -this.maxFallSpeed;
    }
    const dy = this.vy * dt;

    // Resolve the desired translation against the world and queue it; the move is
    // applied on the next op_physics_step(). out = [newX, newY, newZ, grounded].
    this.ops.op_physics_move_character(this.bodyId, dx, dy, dz, this.out);
    this._pos[0] = this.out[0];
    this._pos[1] = this.out[1];
    this._pos[2] = this.out[2];
    const grounded = !this.swimming && this.out[3] === 1;
    // Cancel residual downward velocity once grounded so gravity doesn't
    // accumulate while standing (a tiny per-step gravity nudge keeps snap-to-
    // ground engaged on descents without building real fall speed).
    if (grounded && this.vy <= 0) this.vy = 0;
    this.grounded = grounded;
    if (this.waterSurfaceLevelM !== null) {
      const immersion = Math.max(0, Math.min(2 * this.groundOffset, this.waterSurfaceLevelM - (this._pos[1] - this.groundOffset)));
      this.waterImmersionRatio = immersion / (2 * this.groundOffset);
      this.touchingWater = immersion > 0;
      this.submerged = this.touchingWater && this._pos[1] + PLAYER_EYE_OFFSET_M < this.waterSurfaceLevelM - SWIM_SUBMERGED_EPSILON_M;
    } else {
      this.touchingWater = false;
      this.waterImmersionRatio = 0;
      this.submerged = false;
    }
  }

  /** Capture the JS-owned resume state for an M2 snapshot.
   *  The body transform itself rides in the native physics blob. */
  serializeState(): CharacterState {
    return { vy: this.vy, grounded: this.grounded, heading: this.heading, swimming: this.swimming };
  }

  /** Reinstall resume state after a snapshot restore. The native body transform
   *  is restored by `op_physics_restore`; this re-reads the body position into the
   *  cached `_pos` so the first post-restore frame frames the character correctly. */
  restoreState(state: Omit<CharacterState, "swimming"> & { swimming?: boolean }): void {
    this.vy = state.vy;
    this.grounded = state.grounded;
    this.heading = state.heading;
    this.swimming = state.swimming ?? false;
    this.touchingWater = false;
    this.submerged = false;
    this.waterSurfaceLevelM = null;
    this.waterColumnDepthM = 0;
    this.waterImmersionRatio = 0;
    this.waterBodyId = null;
    this.waterKind = null;
    this.ops.op_physics_body_pos(this.bodyId, this.out); // out is length 4 >= 3
    this._pos[0] = this.out[0];
    this._pos[1] = this.out[1];
    this._pos[2] = this.out[2];
  }

  /** Remove the character body from the world (tombstones its id). */
  dispose(): void {
    this.ops.op_physics_remove_body(this.bodyId);
  }
}
