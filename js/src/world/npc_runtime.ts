// Scripted NPC runtime — a deterministic, NON-LLM "brain" that drives an NPC's
// BODY (movement + animation) through the existing engine seams. It is a sibling
// of character_model.ts / third_person_camera.ts: same world/ helper style.
//
//   new ScriptedNpc({ registry, base, world, model, navmeshManager, regionId }, config)
//     .tick(dt, playerPos)   // per-fixed-step driver
//
// THE PLUGGABLE-BRAIN CONTRACT: the engine provides the NPC's body (the
// NavmeshManager moves it; the CharacterModel animates it) and PERCEPTION (the
// player position the host hands in). This runtime is the deterministic SCRIPTED
// policy that composes them into a patrol: walk a waypoint loop, animate the
// gait, and notice the player. It does NOT do dialogue itself — it exposes a
// `wantsToTalk()` signal (true when the player is inside `talkRadius`) that the
// capstone wires to the dialogue runtime later. Keep it decoupled: this file
// never imports a dialogue or LLM module.
//
// HOW MOVEMENT IS DRIVEN: through `NavmeshManager.findPath` (the deterministic
// grid A*) plus an internal fixed-`dt` path integrator (the same `speed·dt`
// march as NavmeshManager.stepAgent), NOT the async `navmesh.moveTo` SKILL. Two
// reasons: (1) `tick()` is a SYNCHRONOUS fixed-step driver — `registry.invoke`
// returns a Promise, which would make every sim step async; (2) the NPC owns its
// OWN sim position here (it has no physics body and no registered entity in the
// headless path), so routing through moveTo's per-entity manager state would add
// a shared-mutable-state coupling (and an entity-key collision risk across NPCs)
// for no benefit. The integrator is pure math over the A* waypoints, so a re-run
// of the same tick sequence reproduces the identical trajectory bit-for-bit.
//
// SIM vs RENDER: the position advance is SIM (deterministic; the host drives it
// at the fixed step). `model.setPose` / `model.setLocomotion` / `syncSkinning`
// are RENDER-only (cosmetic, dt-driven) — exactly the character_model.ts
// contract. The model is OPTIONAL: with no model the runtime still advances the
// NPC's sim position deterministically (headless tests pass a recording stub).
//
// DETERMINISM: fixed `dt` (host-supplied), no Date.now / Math.random /
// performance.now. Any per-NPC variation comes from the seed/index, never RNG.

import type { CharacterModel, LocomotionState } from "./character_model.ts";
import type { NavmeshManager } from "../skills/navmesh.ts";
import type { InvokeBase, SkillRegistry, WorldContext } from "../skills/registry.ts";

/** A world-XZ patrol waypoint. */
export type Waypoint = [number, number, number] | [number, number];
type Vec3 = [number, number, number];

/** The minimal RENDER-only visual surface the runtime drives. `CharacterModel`
 *  satisfies this; headless tests pass a stub that records the calls. Kept narrow
 *  so the runtime never depends on the full glTF rig in a server context. */
export interface NpcVisual {
  setPose(footPos: readonly [number, number, number], yaw: number): void;
  setLocomotion(state: LocomotionState, dt: number): void;
  syncSkinning(): void;
}

/** Construction dependencies — the engine-provided body/perception seams. */
export interface ScriptedNpcDeps {
  registry: SkillRegistry;
  base: InvokeBase;
  world: WorldContext;
  /** RENDER-only visual + animation. Optional — omit it for a headless sim NPC. */
  model?: NpcVisual | CharacterModel;
  /** The shared grid navmesh the NPC pathfinds over (core.nav.navmeshManager). */
  navmeshManager: NavmeshManager;
  /** The world region this NPC patrols (provenance only; the grid is global). */
  regionId: string;
  /** Optional deterministic index/seed for per-NPC variation (never RNG). */
  seed?: number;
}

/** Scripted-policy tunables. */
export interface ScriptedNpcConfig {
  /** Patrol loop, as world-XZ points ([x,z]) or full [x,y,z]. */
  waypoints: Waypoint[];
  /** Patrol speed (world units / second). */
  speed: number;
  /** Player distance (world units) at which the NPC stops, faces, and wantsToTalk. */
  talkRadius: number;
  /** Arrival epsilon (world units) for "reached the current waypoint". Default 0.2. */
  arriveEps?: number;
  /** Spawn position [x,y,z]. Defaults to the first waypoint (or origin). */
  startPos?: Vec3;
  /** Initial facing yaw (radians, local +Z forward). Default 0. */
  startYaw?: number;
}

/** The NPC's high-level scripted state. */
export type NpcState = "patrol" | "greet";

const EPS = 1e-9;
const DEFAULT_ARRIVE_EPS = 0.2;

/** Squared XZ distance (Y is the navmesh surface and may differ between a flat
 *  waypoint and an interior cell centre, so proximity is judged on the ground
 *  plane — the gameplay-meaningful distance). */
function distXZ(a: Vec3, b: Vec3): number {
  const dx = a[0] - b[0];
  const dz = a[2] - b[2];
  return Math.sqrt(dx * dx + dz * dz);
}

/** Full 3D distance — used by the path integrator so it consumes the exact
 *  per-segment length the A* waypoints describe (matches NavmeshManager.stepAgent). */
function dist3(a: Vec3, b: Vec3): number {
  const dx = a[0] - b[0];
  const dy = a[1] - b[1];
  const dz = a[2] - b[2];
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/** Normalise a waypoint to a full [x,y,z], sampling the navmesh surface Y for its
 *  cell when only [x,z] was given (else 0). */
function toVec3(wp: Waypoint, surfaceY: (x: number, z: number) => number): Vec3 {
  if (wp.length === 3) return [wp[0], wp[1], wp[2]];
  return [wp[0], surfaceY(wp[0], wp[1]), wp[1]];
}

/**
 * A deterministic scripted NPC: patrols a waypoint loop over the grid navmesh,
 * drives a render-only character model, and raises a `wantsToTalk` signal when
 * the player comes within `talkRadius`. The host calls `tick(dt, playerPos)` once
 * per fixed step and `syncSkinning()` once per render frame (after renderSync).
 */
export class ScriptedNpc {
  private readonly registry: SkillRegistry;
  private readonly base: InvokeBase;
  private readonly world: WorldContext;
  private readonly nav: NavmeshManager;
  private readonly model?: NpcVisual | CharacterModel;
  readonly regionId: string;
  readonly seed: number;

  private waypoints: Vec3[];
  private speed: number;
  private talkRadius: number;
  private readonly arriveEps: number;

  /** Live sim position (the NPC's foot position on the navmesh plane). */
  private pos: Vec3;
  /** Facing yaw (radians); local +Z forward, matching the engine convention. */
  private yaw: number;
  /** Index of the waypoint currently being walked toward (loops). */
  private wpIndex = 0;

  /** Cached A* path to `waypoints[plannedWpIndex]`, or [] when none. */
  private path: Vec3[] = [];
  /** Index of the last path waypoint the NPC has reached (walks toward +1). */
  private pathIndex = 0;
  /** Which waypoint `path` was planned toward (so we replan on a waypoint change). */
  private plannedWpIndex = -1;

  private _wantsToTalk = false;
  private _state: NpcState = "patrol";

  constructor(deps: ScriptedNpcDeps, config: ScriptedNpcConfig) {
    this.registry = deps.registry;
    this.base = deps.base;
    this.world = deps.world;
    this.nav = deps.navmeshManager;
    this.model = deps.model;
    this.regionId = deps.regionId;
    this.seed = deps.seed ?? 0;

    this.speed = config.speed > 0 ? config.speed : 0;
    this.talkRadius = Math.max(0, config.talkRadius);
    this.arriveEps = config.arriveEps !== undefined && config.arriveEps > 0 ? config.arriveEps : DEFAULT_ARRIVE_EPS;
    this.waypoints = config.waypoints.map((w) => toVec3(w, (x, z) => this.surfaceY(x, z)));

    const start = config.startPos ?? (this.waypoints.length > 0 ? this.waypoints[0] : [0, 0, 0]);
    this.pos = [start[0], start[1], start[2]];
    this.yaw = config.startYaw ?? 0;

    // Frame 0: present a posed, idle NPC immediately (mirrors attachCharacterModel).
    this.model?.setPose(this.pos, this.yaw);
    this.model?.setLocomotion("idle", 0);
  }

  // ---- public API ----

  /** True when the player is inside `talkRadius` (the "wants to talk" signal the
   *  capstone wires to the dialogue runtime). */
  wantsToTalk(): boolean {
    return this._wantsToTalk;
  }

  /** The NPC's current sim position [x,y,z] (a copy — callers can't mutate state). */
  position(): Vec3 {
    return [this.pos[0], this.pos[1], this.pos[2]];
  }

  /** Current facing yaw (radians, local +Z forward). */
  facing(): number {
    return this.yaw;
  }

  /** "patrol" while walking the loop; "greet" while the player is within talkRadius. */
  state(): NpcState {
    return this._state;
  }

  /** Replace the patrol loop. Resets the cached path so the next tick replans
   *  toward the (clamped) current waypoint; never throws on an empty list. */
  setWaypoints(waypoints: Waypoint[]): void {
    this.waypoints = waypoints.map((w) => toVec3(w, (x, z) => this.surfaceY(x, z)));
    if (this.waypoints.length === 0) this.wpIndex = 0;
    else if (this.wpIndex >= this.waypoints.length) this.wpIndex = this.wpIndex % this.waypoints.length;
    this.invalidatePath();
  }

  /** Update the patrol speed (world units/second). */
  setSpeed(speed: number): void {
    this.speed = speed > 0 ? speed : 0;
  }

  /** Update the talk radius (world units). */
  setTalkRadius(radius: number): void {
    this.talkRadius = Math.max(0, radius);
  }

  /**
   * Per-fixed-step driver (DETERMINISTIC; `dt` is host-supplied and fixed):
   *   1. Perceive the player → greet (stop + face) when within talkRadius, else patrol.
   *   2. When patrolling, advance along the A* path toward the current waypoint by
   *      `speed·dt` (replanning on a no-path / waypoint change), cycling on arrival.
   *   3. Drive the render-only model: setPose(foot, yaw) + setLocomotion(walk|idle).
   * Returns the sim position after this step.
   */
  tick(dt: number, playerPos: readonly [number, number, number]): Vec3 {
    const step = dt > 0 ? dt : 0;
    const player: Vec3 = [playerPos[0], playerPos[1], playerPos[2]];

    // 1. PERCEPTION → talk signal. Proximity is judged on the ground plane.
    const near = this.talkRadius > 0 && distXZ(this.pos, player) <= this.talkRadius;
    this._wantsToTalk = near;
    this._state = near ? "greet" : "patrol";

    let moving = false;

    if (near) {
      // GREET: stop and turn to face the player (only when they're not exactly on
      // top of the NPC, to avoid a degenerate atan2(0,0) heading flip).
      const fx = player[0] - this.pos[0];
      const fz = player[2] - this.pos[2];
      if (fx * fx + fz * fz > EPS) this.yaw = Math.atan2(fx, fz);
    } else {
      moving = this.advance(step);
    }

    // 3. RENDER-only visual: place the feet at the sim position + drive the gait.
    this.model?.setPose(this.pos, this.yaw);
    this.model?.setLocomotion(moving ? "walk" : "idle", step);

    return this.position();
  }

  /** Refresh the model's skinning AFTER the host applies the ECS transform
   *  (renderSyncSystem) and BEFORE renderer.render(). Passthrough; no-op without
   *  a model. The host calls this once per render frame, like the player's model. */
  syncSkinning(): void {
    this.model?.syncSkinning();
  }

  // ---- internals (deterministic sim) ----

  /** Advance the NPC one fixed step toward the current waypoint along its A* path.
   *  Returns whether the NPC actually moved this step (drives the walk/idle gait).
   *  Handles empty waypoints / no path / off-navmesh by idling in place (no throw). */
  private advance(dt: number): boolean {
    if (this.waypoints.length === 0 || this.speed <= 0 || dt <= 0) return false;

    if (!this.ensurePath()) return false; // no grid / unreachable → idle in place

    const before: Vec3 = [this.pos[0], this.pos[1], this.pos[2]];
    let budget = this.speed * dt;

    while (budget > EPS && this.pathIndex < this.path.length - 1) {
      const next = this.path[this.pathIndex + 1];
      const d = dist3(this.pos, next);
      if (d <= EPS) {
        // Degenerate zero-length segment — consume it without spending budget.
        this.pos[0] = next[0]; this.pos[1] = next[1]; this.pos[2] = next[2];
        this.pathIndex++;
        continue;
      }
      if (d <= budget) {
        this.pos[0] = next[0]; this.pos[1] = next[1]; this.pos[2] = next[2];
        this.pathIndex++;
        budget -= d;
      } else {
        const t = budget / d;
        this.pos[0] += (next[0] - this.pos[0]) * t;
        this.pos[1] += (next[1] - this.pos[1]) * t;
        this.pos[2] += (next[2] - this.pos[2]) * t;
        budget = 0;
      }
    }

    // Face the direction actually travelled this step (engine yaw: atan2(dx, dz)).
    const dx = this.pos[0] - before[0];
    const dz = this.pos[2] - before[2];
    const moved = dx * dx + dz * dz > EPS;
    if (moved) this.yaw = Math.atan2(dx, dz);

    // 2b. Waypoint cycling: arrived at the current waypoint (path end reached, or
    // within the arrival epsilon) → advance to the next, looping.
    const target = this.waypoints[this.wpIndex];
    const atEnd = this.pathIndex >= this.path.length - 1;
    if (atEnd || distXZ(this.pos, target) <= this.arriveEps) {
      this.wpIndex = (this.wpIndex + 1) % this.waypoints.length;
      this.invalidatePath();
    }

    return moved;
  }

  /** Ensure `path` is a valid A* route from the current position to the current
   *  waypoint, (re)planning when stale. Returns false when no route exists (no
   *  grid, blocked endpoint, or disconnected) — the caller idles. */
  private ensurePath(): boolean {
    if (this.wpIndex !== this.plannedWpIndex || this.path.length === 0) {
      const target = this.waypoints[this.wpIndex];
      const route = this.nav.findPath(this.pos, target) as Vec3[];
      if (route.length === 0) {
        this.path = [];
        this.pathIndex = 0;
        this.plannedWpIndex = -1;
        return false;
      }
      this.path = route;
      this.pathIndex = 0;
      this.plannedWpIndex = this.wpIndex;
    }
    // A single-waypoint path (start==goal cell) still returns true: advance() runs,
    // detects arrival (pathIndex == end), and cycles to the next waypoint.
    return this.path.length > 0;
  }

  private invalidatePath(): void {
    this.path = [];
    this.pathIndex = 0;
    this.plannedWpIndex = -1;
  }

  /** Sample the navmesh surface Y at a world-XZ (the cell's height field), else 0. */
  private surfaceY(x: number, z: number): number {
    const g = this.nav.getGrid();
    if (g === null || g.heights === undefined) return 0;
    let col = Math.floor((x - g.originX) / g.cellSize);
    let row = Math.floor((z - g.originZ) / g.cellSize);
    if (col < 0) col = 0; else if (col >= g.cols) col = g.cols - 1;
    if (row < 0) row = 0; else if (row >= g.rows) row = g.rows - 1;
    return g.heights[row * g.cols + col];
  }
}
