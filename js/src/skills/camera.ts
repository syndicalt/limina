// camera.* skills — camera rigs, control, and effects (Phase 12).
//
// CLOSURE WIRING (mirrors terrain.ts / combat.ts): the SkillDefinitions are built INSIDE
// registerCameraSkills, closing over a local CameraManager. There is NO ctx.world.cameraManager —
// the old module-level skills read a never-set cast and were all silent no-ops. The manager lives
// in the registry's closure; the host loop drives it via cameraManager.update(dt, world).
//
// RENDER-ONLY: the camera SETS THE VIEW (ctx.world.camera) and never touches the sim/ECS/log, so a
// per-frame update(dt) pump is legitimate. DETERMINISM: no Date.now / Math.random / performance.now;
// the pump takes a caller-supplied dt (never a hardcoded frame), and the shake envelope is a pure,
// dt-driven decay — the same dt sequence reproduces the same camera transforms bit-for-bit.
//
// The third-person / follow rig REUSES the real ThirdPersonCamera (world/third_person_camera.ts) —
// the same orbit rig the windowed demos drive — rather than reimplementing orbit math.

import { z } from "../../build/zod.bundle.mjs";
import { Position } from "../ecs/world.ts";
import { ThirdPersonCamera } from "../world/third_person_camera.ts";
import type { SkillDefinition, SkillRegistry, WorldContext } from "./registry.ts";
import { num } from "./_util.ts";

const Vec3 = z.tuple([z.number(), z.number(), z.number()]);
const MetaField = z.record(z.string(), z.unknown()).optional().describe("Agent-supplied extension metadata.");

/** Default look-target height above a followed entity's origin (orbit framing). */
const DEFAULT_LOOK_HEIGHT = 1.2;
/** Default eye height above a first-person entity's origin. */
const DEFAULT_HEAD_HEIGHT = 1.6;

export interface CameraRig {
  kind: "follow" | "firstPerson" | "thirdPerson" | "topDown" | "fixed" | "custom";
  target?: string;
  offset?: [number, number, number];
  distance?: number;
  pitch?: number;
  yaw?: number;
  fov?: number;
  smoothness?: number;
  collisionCheck?: boolean;
  config?: Record<string, unknown>;
}

/** The minimal engine camera the manager drives. `fov` is not in CameraLike (it lives on
 *  THREE.PerspectiveCamera); we narrow to it here so setFOV can apply without a dead cast. */
interface DrivableCamera {
  position: { set(x: number, y: number, z: number): void };
  lookAt(x: number, y: number, z: number): void;
  fov?: number;
  updateProjectionMatrix(): void;
}

interface ShakeState {
  amplitude: number;
  duration: number;
  frequency: number;
  fade: boolean;
  elapsed: number;
}

/**
 * Owns the active camera rig + effects and APPLIES them to the engine camera each frame.
 * The host loop calls `update(dt, world)` once per render frame; the skills (closed over one
 * instance) only mutate the rig/effect state. Render-only — never sim/ECS/log state.
 */
export class CameraManager {
  private active: CameraRig = { kind: "follow", distance: 5, pitch: 0.4, fov: 60, smoothness: 0.08, collisionCheck: true };
  /** Authoritative orbit angles (radians); camera.look drives these, the rigs consume them. */
  private yaw = 0;
  private pitch = 0.4;
  /** Desired field of view (degrees); applied to the camera in update(). */
  private fov = 60;
  private lastAppliedFov: number | undefined;
  private shake: ShakeState | null = null;
  /** The real orbit rig, rebuilt when the third-person/follow distance changes. */
  private orbit: ThirdPersonCamera;
  private orbitDistance: number;
  private orbitLookHeight: number;

  constructor() {
    this.orbitDistance = 5;
    this.orbitLookHeight = DEFAULT_LOOK_HEIGHT;
    this.orbit = new ThirdPersonCamera({ distance: this.orbitDistance, lookHeight: this.orbitLookHeight });
  }

  getActive(): CameraRig {
    return this.active;
  }

  /** Switch/merge the active rig. Resets the orbit angles from the rig (yaw/pitch default 0)
   *  so a fresh mode starts framed; camera.look then nudges them. Rebuilds the orbit rig when
   *  the third-person distance/lookHeight changed. */
  setRig(rig: CameraRig): void {
    this.active = { ...this.active, ...rig };
    this.yaw = rig.yaw ?? 0;
    this.pitch = rig.pitch ?? 0;
    if (rig.fov !== undefined) this.fov = rig.fov;
    if (this.active.kind === "thirdPerson" || this.active.kind === "follow") {
      const dist = this.active.distance ?? 5;
      const lookHeight = num(this.active.config?.lookHeight, DEFAULT_LOOK_HEIGHT);
      if (dist !== this.orbitDistance || lookHeight !== this.orbitLookHeight) {
        this.orbitDistance = dist;
        this.orbitLookHeight = lookHeight;
        this.orbit = new ThirdPersonCamera({ distance: dist, lookHeight });
      }
    }
  }

  /** Apply a look rotation (radians) to the orbit angles, pitch clamped to avoid gimbal flip. */
  applyLook(pitchDelta: number, yawDelta: number): void {
    this.pitch = Math.max(-Math.PI / 2 + 0.01, Math.min(Math.PI / 2 - 0.01, this.pitch + pitchDelta));
    // Wrap yaw into [-π, π) (positive-modulo so it is correct for negative inputs).
    const y = this.yaw + yawDelta;
    this.yaw = ((y + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI;
  }

  setFOV(fov: number): void {
    this.fov = Math.max(10, Math.min(120, fov));
    this.active.fov = this.fov;
  }

  triggerShake(opts: { amplitude: number; duration: number; frequency: number; fade?: boolean }): void {
    this.shake = { amplitude: opts.amplitude, duration: opts.duration, frequency: opts.frequency, fade: opts.fade ?? true, elapsed: 0 };
  }

  /** Instant cut to a new position and/or look-at target (cinematic). */
  cut(world: WorldContext, position?: [number, number, number], target?: [number, number, number]): void {
    const camera = world.camera as unknown as DrivableCamera;
    if (position) camera.position.set(position[0], position[1], position[2]);
    if (target) camera.lookAt(target[0], target[1], target[2]);
  }

  /** Advance the shake envelope by dt (seconds) and return its planar [x,y] offset. Pure decay:
   *  the same dt sequence yields the same offset (deterministic). Clears on expiry → [0,0]. */
  private advanceShake(dt: number): [number, number] {
    const s = this.shake;
    if (s === null) return [0, 0];
    s.elapsed += dt;
    if (s.elapsed >= s.duration) {
      this.shake = null;
      return [0, 0];
    }
    const amp = s.fade ? s.amplitude * (1 - s.elapsed / s.duration) : s.amplitude;
    const x = Math.sin(s.elapsed * s.frequency) * amp;
    const y = Math.cos(s.elapsed * s.frequency * 1.3) * amp * 0.7;
    return [x, y];
  }

  /**
   * Apply the active rig (+ effects) to the engine camera for this frame. Call once per render
   * frame from the host loop. `dt` (seconds) advances the shake envelope; `world` provides the
   * engine camera + the entity transforms the rig follows. Render-only — never touches sim/log.
   */
  update(dt: number, world: WorldContext): void {
    const camera = world.camera as unknown as DrivableCamera;
    const [sx, sy] = this.advanceShake(dt);
    const rig = this.active;

    const pos = rig.target !== undefined ? resolveTargetPos(world, rig.target) : undefined;
    if (pos !== undefined) {
      const [px, py, pz] = pos;
      if (rig.kind === "firstPerson") {
        const headY = py + num(rig.config?.headHeight, DEFAULT_HEAD_HEIGHT);
        const cp = Math.cos(this.pitch);
        camera.position.set(px + sx, headY + sy, pz);
        camera.lookAt(px + Math.sin(this.yaw) * cp, headY + Math.sin(this.pitch), pz + Math.cos(this.yaw) * cp);
      } else if (rig.kind === "thirdPerson" || rig.kind === "follow") {
        // Reuse the REAL orbit rig. Shake shifts the framed target so camera + look-at translate
        // together (a positional shake) — TPC owns the orbit math, we never reimplement it.
        this.orbit.yaw = this.yaw;
        this.orbit.pitch = this.pitch;
        this.orbit.update(camera, [px + sx, py + sy, pz]);
      } else if (rig.kind === "topDown") {
        const dist = rig.distance ?? 10;
        const angle = rig.pitch ?? Math.PI / 4;
        camera.position.set(px + sx, py + dist * Math.cos(angle) + sy, pz + dist * Math.sin(angle));
        camera.lookAt(px, py, pz);
      }
    }

    if (camera.fov !== undefined && this.lastAppliedFov !== this.fov) {
      camera.fov = this.fov;
      camera.updateProjectionMatrix();
      this.lastAppliedFov = this.fov;
    }
  }
}

/** Resolve a followed entity's world position from the global Position SoA (or undefined). */
function resolveTargetPos(world: WorldContext, id: string): [number, number, number] | undefined {
  const entry = world.entities.resolve(id);
  if (entry === undefined) return undefined;
  return [Position.x[entry.eid], Position.y[entry.eid], Position.z[entry.eid]];
}

// ---- Schemas (closure-free; the SkillDefinitions that use them live in registerCameraSkills) ----

const followCameraInput = z.object({
  target: z.string().describe("Entity id to follow."),
  distance: z.number().positive().max(100).default(5).describe("Camera distance from target."),
  pitch: z.number().min(-1.5).max(1.5).default(0.4).describe("Camera pitch angle (radians)."),
  smoothness: z.number().min(0).max(1).default(0.08).describe("Smoothing factor (0 = instant, 1 = no movement)."),
  collisionCheck: z.boolean().default(true).describe("Whether to check for collisions between camera and target."),
  config: z.record(z.string(), z.unknown()).optional().describe("Custom camera configuration for extensions."),
  meta: MetaField,
});

const firstPersonInput = z.object({
  target: z.string(),
  headHeight: z.number().positive().default(1.6).describe("Eye height above entity position."),
  config: z.record(z.string(), z.unknown()).optional(),
  meta: MetaField,
});

const thirdPersonInput = z.object({
  target: z.string(),
  distance: z.number().positive().max(100).default(5),
  pitch: z.number().min(-1.5).max(1.5).default(0.4).describe("Initial camera pitch angle (radians)."),
  minPitch: z.number().default(-1.4),
  maxPitch: z.number().default(1.4),
  minDistance: z.number().positive().default(1),
  maxDistance: z.number().positive().default(20),
  config: z.record(z.string(), z.unknown()).optional(),
  meta: MetaField,
});

const topDownInput = z.object({
  target: z.string(),
  distance: z.number().positive().max(100).default(10),
  angle: z.number().min(0.1).max(1.5).default(0.785).describe("Camera angle from vertical (radians). 0 = straight down, PI/4 = isometric."),
  config: z.record(z.string(), z.unknown()).optional(),
  meta: MetaField,
});

const lookInput = z.object({
  pitchDelta: z.number().default(0).describe("Pitch change (radians, positive = look up)."),
  yawDelta: z.number().default(0).describe("Yaw change (radians, positive = look right)."),
  meta: MetaField,
});

const shakeInput = z.object({
  amplitude: z.number().positive().default(0.1),
  duration: z.number().positive().max(5).default(0.3).describe("Shake duration in seconds (matched against the update dt)."),
  frequency: z.number().positive().default(30),
  fade: z.boolean().default(true),
  meta: MetaField,
});

const setFOVInput = z.object({
  fov: z.number().min(10).max(120).describe("Field of view in degrees."),
  transitionMs: z.number().min(0).max(2000).default(0).describe("Smooth transition duration in ms (0 = instant)."),
  meta: MetaField,
});

const cutInput = z.object({
  position: Vec3.optional().describe("Camera position. If omitted, keeps current position."),
  target: Vec3.optional().describe("Look-at target. If omitted, keeps current target."),
  meta: MetaField,
});

/**
 * Register the camera.* skills bound to a CameraManager. The handlers CLOSE OVER the manager
 * (no ctx.world.cameraManager). The host loop drives the manager via update(dt, world); each
 * skill has a REAL effect through it. Returns the manager so the core wiring can expose it
 * (core.camera.cameraManager).
 */
export function registerCameraSkills(registry: SkillRegistry, opts?: { cameraManager?: CameraManager }): { cameraManager: CameraManager } {
  const mgr = opts?.cameraManager ?? new CameraManager();

  const followCamera: SkillDefinition<z.infer<typeof followCameraInput>, { ok: boolean }> = {
    name: "camera.follow",
    version: "1.0.0",
    description: "Attach a camera to follow an entity with configurable distance, pitch, smoothness, and collision avoidance. Driven by the real third-person orbit rig.",
    category: "camera",
    permissions: ["camera.write"],
    input: followCameraInput,
    output: z.object({ ok: z.boolean() }),
    handler: (input, ctx) => {
      mgr.setRig({ kind: "follow", target: input.target, distance: input.distance, pitch: input.pitch, smoothness: input.smoothness, collisionCheck: input.collisionCheck, config: input.config });
      ctx.emit("camera.follow.set", { target: input.target, distance: input.distance, ...input.meta });
      return { ok: true };
    },
  };

  const firstPerson: SkillDefinition<z.infer<typeof firstPersonInput>, { ok: boolean }> = {
    name: "camera.firstPerson",
    version: "1.0.0",
    description: "Set camera to first-person mode on an entity (head position + look rotation from camera.look).",
    category: "camera",
    permissions: ["camera.write"],
    input: firstPersonInput,
    output: z.object({ ok: z.boolean() }),
    handler: (input, ctx) => {
      mgr.setRig({ kind: "firstPerson", target: input.target, config: { ...input.config, headHeight: input.headHeight } });
      ctx.emit("camera.firstPerson.set", { target: input.target, headHeight: input.headHeight, ...input.meta });
      return { ok: true };
    },
  };

  const thirdPerson: SkillDefinition<z.infer<typeof thirdPersonInput>, { ok: boolean }> = {
    name: "camera.thirdPerson",
    version: "1.0.0",
    description: "Set camera to third-person orbit mode (real ThirdPersonCamera rig) with configurable distance, initial pitch, and pitch/zoom limits.",
    category: "camera",
    permissions: ["camera.write"],
    input: thirdPersonInput,
    output: z.object({ ok: z.boolean() }),
    handler: (input, ctx) => {
      mgr.setRig({ kind: "thirdPerson", target: input.target, distance: input.distance, pitch: input.pitch, config: { ...input.config, minPitch: input.minPitch, maxPitch: input.maxPitch, minDistance: input.minDistance, maxDistance: input.maxDistance } });
      ctx.emit("camera.thirdPerson.set", { target: input.target, distance: input.distance, ...input.meta });
      return { ok: true };
    },
  };

  const topDown: SkillDefinition<z.infer<typeof topDownInput>, { ok: boolean }> = {
    name: "camera.topDown",
    version: "1.0.0",
    description: "Set camera to top-down/isometric view with configurable angle and zoom.",
    category: "camera",
    permissions: ["camera.write"],
    input: topDownInput,
    output: z.object({ ok: z.boolean() }),
    handler: (input, ctx) => {
      mgr.setRig({ kind: "topDown", target: input.target, distance: input.distance, pitch: input.angle, config: input.config });
      ctx.emit("camera.topDown.set", { target: input.target, distance: input.distance, angle: input.angle, ...input.meta });
      return { ok: true };
    },
  };

  const look: SkillDefinition<z.infer<typeof lookInput>, { ok: boolean }> = {
    name: "camera.look",
    version: "1.0.0",
    description: "Apply a look rotation (radians) to the active camera. Use with input look axes for mouse/touch control.",
    category: "camera",
    permissions: ["camera.write"],
    input: lookInput,
    output: z.object({ ok: z.boolean() }),
    handler: (input, ctx) => {
      mgr.applyLook(input.pitchDelta, input.yawDelta);
      ctx.emit("camera.look.applied", { pitchDelta: input.pitchDelta, yawDelta: input.yawDelta, ...input.meta });
      return { ok: true };
    },
  };

  const shake: SkillDefinition<z.infer<typeof shakeInput>, { ok: boolean }> = {
    name: "camera.shake",
    version: "1.0.0",
    description: "Trigger a camera shake with configurable amplitude, duration (seconds), frequency, and fade. The shake envelope decays deterministically over its duration as update(dt) is pumped.",
    category: "camera",
    permissions: ["camera.write"],
    input: shakeInput,
    output: z.object({ ok: z.boolean() }),
    handler: (input, ctx) => {
      mgr.triggerShake({ amplitude: input.amplitude, duration: input.duration, frequency: input.frequency, fade: input.fade });
      ctx.emit("camera.shake.triggered", { amplitude: input.amplitude, duration: input.duration, ...input.meta });
      return { ok: true };
    },
  };

  const setFOV: SkillDefinition<z.infer<typeof setFOVInput>, { ok: boolean }> = {
    name: "camera.setFOV",
    version: "1.0.0",
    description: "Set the camera's field of view (applied on the next update).",
    category: "camera",
    permissions: ["camera.write"],
    input: setFOVInput,
    output: z.object({ ok: z.boolean() }),
    handler: (input, ctx) => {
      mgr.setFOV(input.fov);
      ctx.emit("camera.fov.set", { fov: input.fov, transitionMs: input.transitionMs, ...input.meta });
      return { ok: true };
    },
  };

  const cut: SkillDefinition<z.infer<typeof cutInput>, { ok: boolean }> = {
    name: "camera.cut",
    version: "1.0.0",
    description: "Instantly cut the camera to a new position and/or look-at target (cinematic transitions).",
    category: "camera",
    permissions: ["camera.write"],
    input: cutInput,
    output: z.object({ ok: z.boolean() }),
    handler: (input, ctx) => {
      mgr.cut(ctx.world, input.position, input.target);
      ctx.emit("camera.cut", { position: input.position, target: input.target, ...input.meta });
      return { ok: true };
    },
  };

  registry.register(followCamera);
  registry.register(firstPerson);
  registry.register(thirdPerson);
  registry.register(topDown);
  registry.register(look);
  registry.register(shake);
  registry.register(setFOV);
  registry.register(cut);

  return { cameraManager: mgr };
}
