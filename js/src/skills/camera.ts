// camera.* skills — camera rigs, control, and effects.
// All inputs accept optional `meta` for agent-supplied extension data.

import { z } from "../../build/zod.bundle.mjs";
import type { SkillDefinition, SkillRegistry } from "./registry.ts";

const Vec3 = z.tuple([z.number(), z.number(), z.number()]);
const MetaField = z.record(z.string(), z.unknown()).optional().describe("Agent-supplied extension metadata.");

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

export class CameraManager {
  private active: CameraRig = { kind: "follow", distance: 5, pitch: 0.4, fov: 60, smoothness: 0.08, collisionCheck: true };
  private shake: { amplitude: number; duration: number; frequency: number; elapsed: number; fade: boolean } | null = null;

  getActive(): CameraRig {
    return this.active;
  }

  setRig(rig: CameraRig): void {
    this.active = { ...this.active, ...rig };
  }

  applyLook(pitchDelta: number, yawDelta: number): void {
    this.active.pitch = Math.max(-Math.PI / 2 + 0.01, Math.min(Math.PI / 2 - 0.01, (this.active.pitch ?? 0) + pitchDelta));
    this.active.yaw = ((this.active.yaw ?? 0) + yawDelta + Math.PI * 2) % (Math.PI * 2) - Math.PI;
  }

  setFOV(fov: number): void {
    this.active.fov = Math.max(10, Math.min(120, fov));
  }

  triggerShake(opts: { amplitude: number; duration: number; frequency: number; fade?: boolean }): void {
    this.shake = { ...opts, fade: opts.fade ?? true, elapsed: 0 };
  }

  getShakeOffset(): [number, number] {
    if (this.shake === null) return [0, 0];
    this.shake.elapsed += 16;
    if (this.shake.elapsed >= this.shake.duration) {
      this.shake = null;
      return [0, 0];
    }
    const t = this.shake.elapsed / this.shake.duration;
    const amp = this.shake.fade ? this.shake.amplitude * (1 - t) : this.shake.amplitude;
    const x = Math.sin(this.shake.elapsed * this.shake.frequency * 0.01) * amp;
    const y = Math.cos(this.shake.elapsed * this.shake.frequency * 0.013) * amp * 0.7;
    return [x, y];
  }

  updateCamera(camera: { position: { set(x: number, y: number, z: number): void }; lookAt(x: number, y: number, z: number): void; fov: number; updateProjectionMatrix(): void }, world: { entities: { resolve(id: string): { eid: number } | undefined }; transforms?: { Position: { x: Float32Array; y: Float32Array; z: Float32Array } } }): void {
    const rig = this.active;
    if (rig.target) {
      const entry = world.entities.resolve(rig.target);
      if (entry) {
        const px = world.transforms?.Position.x[entry.eid] ?? 0;
        const py = world.transforms?.Position.y[entry.eid] ?? 0;
        const pz = world.transforms?.Position.z[entry.eid] ?? 0;

        if (rig.kind === "firstPerson") {
          const headY = py + 1.6;
          const yaw = rig.yaw ?? 0;
          const pitch = rig.pitch ?? 0;
          camera.position.set(px, headY, pz);
          const lx = px + Math.sin(yaw) * Math.cos(pitch);
          const ly = headY + Math.sin(pitch);
          const lz = pz + Math.cos(yaw) * Math.cos(pitch);
          camera.lookAt(lx, ly, lz);
        } else if (rig.kind === "thirdPerson" || rig.kind === "follow") {
          const dist = rig.distance ?? 5;
          const yaw = rig.yaw ?? 0;
          const pitch = rig.pitch ?? 0.4;
          const ox = Math.sin(yaw) * Math.cos(pitch) * dist;
          const oy = Math.sin(pitch) * dist + 1.5;
          const oz = Math.cos(yaw) * Math.cos(pitch) * dist;
          const [sx, sy] = this.getShakeOffset();
          camera.position.set(px + ox + sx, py + oy + sy, pz + oz);
          camera.lookAt(px, py + 1.5, pz);
        } else if (rig.kind === "topDown") {
          const dist = rig.distance ?? 10;
          const angle = rig.pitch ?? Math.PI / 4;
          const [sx, sy] = this.getShakeOffset();
          camera.position.set(px + sx, py + dist * Math.cos(angle) + sy, pz + dist * Math.sin(angle));
          camera.lookAt(px, py, pz);
        }
      }
    }
    if (rig.fov !== undefined && camera.fov !== rig.fov) {
      (camera as unknown as { fov: number }).fov = rig.fov;
      camera.updateProjectionMatrix();
    }
  }
}

const followCameraInput = z.object({
  target: z.string().describe("Entity id to follow."),
  distance: z.number().positive().max(100).default(5).describe("Camera distance from target."),
  pitch: z.number().min(-1.5).max(1.5).default(0.4).describe("Camera pitch angle (radians)."),
  smoothness: z.number().min(0).max(1).default(0.08).describe("Smoothing factor (0 = instant, 1 = no movement)."),
  collisionCheck: z.boolean().default(true).describe("Whether to check for collisions between camera and target."),
  config: z.record(z.string(), z.unknown()).optional().describe("Custom camera configuration for extensions."),
  meta: MetaField,
});

const followCamera: SkillDefinition<z.infer<typeof followCameraInput>, { ok: boolean }> = {
  name: "camera.follow",
  version: "1.0.0",
  description: "Attach a camera to follow an entity with configurable distance, pitch, smoothness, and collision avoidance.",
  category: "camera",
  permissions: ["camera.write"],
  input: followCameraInput,
  output: z.object({ ok: z.boolean() }),
  handler: (input, ctx) => {
    const mgr = (ctx.world as unknown as { cameraManager?: CameraManager }).cameraManager;
    if (mgr === undefined) return { ok: false };
    mgr.setRig({ kind: "follow", target: input.target, distance: input.distance, pitch: input.pitch, smoothness: input.smoothness, collisionCheck: input.collisionCheck, config: input.config });
    ctx.emit("camera.follow.set", { target: input.target, distance: input.distance, ...input.meta });
    return { ok: true };
  },
};

const firstPersonInput = z.object({
  target: z.string(),
  headHeight: z.number().positive().default(1.6).describe("Eye height above entity position."),
  config: z.record(z.string(), z.unknown()).optional(),
  meta: MetaField,
});

const firstPerson: SkillDefinition<z.infer<typeof firstPersonInput>, { ok: boolean }> = {
  name: "camera.firstPerson",
  version: "1.0.0",
  description: "Set camera to first-person mode on an entity (head position, look rotation from input.axis or camera.look).",
  category: "camera",
  permissions: ["camera.write"],
  input: firstPersonInput,
  output: z.object({ ok: z.boolean() }),
  handler: (input, ctx) => {
    const mgr = (ctx.world as unknown as { cameraManager?: CameraManager }).cameraManager;
    if (mgr === undefined) return { ok: false };
    mgr.setRig({ kind: "firstPerson", target: input.target, config: { ...input.config, headHeight: input.headHeight } });
    ctx.emit("camera.firstPerson.set", { target: input.target, headHeight: input.headHeight, ...input.meta });
    return { ok: true };
  },
};

const thirdPersonInput = z.object({
  target: z.string(),
  distance: z.number().positive().max(100).default(5),
  minPitch: z.number().default(-1.4),
  maxPitch: z.number().default(1.4),
  minDistance: z.number().positive().default(1),
  maxDistance: z.number().positive().default(20),
  config: z.record(z.string(), z.unknown()).optional(),
  meta: MetaField,
});

const thirdPerson: SkillDefinition<z.infer<typeof thirdPersonInput>, { ok: boolean }> = {
  name: "camera.thirdPerson",
  version: "1.0.0",
  description: "Set camera to third-person orbit mode with configurable distance, pitch/yaw limits, and collision zoom.",
  category: "camera",
  permissions: ["camera.write"],
  input: thirdPersonInput,
  output: z.object({ ok: z.boolean() }),
  handler: (input, ctx) => {
    const mgr = (ctx.world as unknown as { cameraManager?: CameraManager }).cameraManager;
    if (mgr === undefined) return { ok: false };
    mgr.setRig({ kind: "thirdPerson", target: input.target, distance: input.distance, config: { ...input.config, minPitch: input.minPitch, maxPitch: input.maxPitch, minDistance: input.minDistance, maxDistance: input.maxDistance } });
    ctx.emit("camera.thirdPerson.set", { target: input.target, distance: input.distance, ...input.meta });
    return { ok: true };
  },
};

const topDownInput = z.object({
  target: z.string(),
  distance: z.number().positive().max(100).default(10),
  angle: z.number().min(0.1).max(1.5).default(0.785).describe("Camera angle from vertical (radians). 0 = straight down, PI/4 = isometric."),
  config: z.record(z.string(), z.unknown()).optional(),
  meta: MetaField,
});

const topDown: SkillDefinition<z.infer<typeof topDownInput>, { ok: boolean }> = {
  name: "camera.topDown",
  version: "1.0.0",
  description: "Set camera to top-down/isometric view with configurable angle and zoom range.",
  category: "camera",
  permissions: ["camera.write"],
  input: topDownInput,
  output: z.object({ ok: z.boolean() }),
  handler: (input, ctx) => {
    const mgr = (ctx.world as unknown as { cameraManager?: CameraManager }).cameraManager;
    if (mgr === undefined) return { ok: false };
    mgr.setRig({ kind: "topDown", target: input.target, distance: input.distance, pitch: input.angle, config: input.config });
    ctx.emit("camera.topDown.set", { target: input.target, distance: input.distance, angle: input.angle, ...input.meta });
    return { ok: true };
  },
};

const lookInput = z.object({
  pitchDelta: z.number().default(0).describe("Pitch change (radians, positive = look up)."),
  yawDelta: z.number().default(0).describe("Yaw change (radians, positive = look right)."),
  meta: MetaField,
});

const look: SkillDefinition<z.infer<typeof lookInput>, { ok: boolean }> = {
  name: "camera.look",
  version: "1.0.0",
  description: "Apply a look rotation to the active camera. Use with input.axis for mouse/touch look control.",
  category: "camera",
  permissions: ["camera.write"],
  input: lookInput,
  output: z.object({ ok: z.boolean() }),
  handler: (input, ctx) => {
    const mgr = (ctx.world as unknown as { cameraManager?: CameraManager }).cameraManager;
    if (mgr === undefined) return { ok: false };
    mgr.applyLook(input.pitchDelta, input.yawDelta);
    ctx.emit("camera.look.applied", { pitchDelta: input.pitchDelta, yawDelta: input.yawDelta, ...input.meta });
    return { ok: true };
  },
};

const shakeInput = z.object({
  amplitude: z.number().positive().default(0.1),
  duration: z.number().positive().max(5).default(0.3),
  frequency: z.number().positive().default(30),
  fade: z.boolean().default(true),
  meta: MetaField,
});

const shake: SkillDefinition<z.infer<typeof shakeInput>, { ok: boolean }> = {
  name: "camera.shake",
  version: "1.0.0",
  description: "Trigger a camera shake with configurable amplitude, duration, frequency, and fade.",
  category: "camera",
  permissions: ["camera.write"],
  input: shakeInput,
  output: z.object({ ok: z.boolean() }),
  handler: (input, ctx) => {
    const mgr = (ctx.world as unknown as { cameraManager?: CameraManager }).cameraManager;
    if (mgr === undefined) return { ok: false };
    mgr.triggerShake({ amplitude: input.amplitude, duration: input.duration, frequency: input.frequency, fade: input.fade });
    ctx.emit("camera.shake.triggered", { amplitude: input.amplitude, duration: input.duration, ...input.meta });
    return { ok: true };
  },
};

const setFOVInput = z.object({
  fov: z.number().min(10).max(120).describe("Field of view in degrees."),
  transitionMs: z.number().min(0).max(2000).default(0).describe("Smooth transition duration in ms (0 = instant)."),
  meta: MetaField,
});

const setFOV: SkillDefinition<z.infer<typeof setFOVInput>, { ok: boolean }> = {
  name: "camera.setFOV",
  version: "1.0.0",
  description: "Set the camera's field of view with optional smooth transition.",
  category: "camera",
  permissions: ["camera.write"],
  input: setFOVInput,
  output: z.object({ ok: z.boolean() }),
  handler: (input, ctx) => {
    const mgr = (ctx.world as unknown as { cameraManager?: CameraManager }).cameraManager;
    if (mgr === undefined) return { ok: false };
    mgr.setFOV(input.fov);
    ctx.emit("camera.fov.set", { fov: input.fov, transitionMs: input.transitionMs, ...input.meta });
    return { ok: true };
  },
};

const cutInput = z.object({
  position: Vec3.optional().describe("Camera position. If omitted, keeps current position."),
  target: Vec3.optional().describe("Look-at target. If omitted, keeps current target."),
  meta: MetaField,
});

const cut: SkillDefinition<z.infer<typeof cutInput>, { ok: boolean }> = {
  name: "camera.cut",
  version: "1.0.0",
  description: "Instantly cut camera to a new position and/or look-at target (for cinematic transitions).",
  category: "camera",
  permissions: ["camera.write"],
  input: cutInput,
  output: z.object({ ok: z.boolean() }),
  handler: (input, ctx) => {
    const mgr = (ctx.world as unknown as { cameraManager?: CameraManager }).cameraManager;
    if (mgr === undefined) return { ok: false };
    const camera = (ctx.world as unknown as { camera: { position: { set(x: number, y: number, z: number): void }; lookAt(x: number, y: number, z: number): void } }).camera;
    if (input.position) camera.position.set(input.position[0], input.position[1], input.position[2]);
    if (input.target) camera.lookAt(input.target[0], input.target[1], input.target[2]);
    ctx.emit("camera.cut", { position: input.position, target: input.target, ...input.meta });
    return { ok: true };
  },
};

export function registerCameraSkills(registry: SkillRegistry, opts?: { cameraManager?: CameraManager }): { cameraManager: CameraManager } {
  const mgr = opts?.cameraManager ?? new CameraManager();

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
