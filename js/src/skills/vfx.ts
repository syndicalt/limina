// vfx.* skills — CPU particle systems and visual effects.
// All inputs accept optional `meta` for agent-supplied extension data.
//
// CLOSURE WIRING (mirrors terrain.ts / combat.ts): the SkillDefinitions are built
// INSIDE registerVFXSkills, closing over the local VFXManager. There is no
// `ctx.world.vfxManager` — the manager lives in the registry's closure.
//
// HONEST PARTICLES: a created system holds + simulates REAL particles. The manager
// builds a THREE.Points object (one shared draw, per-particle position + colour
// buffers) added to `ctx.world.scene`, and `update(dt)` integrates every live
// particle (pos += vel·dt; vel += gravity·dt), ages/recycles them, and rewrites the
// GPU buffers. atPosition spawns an actual burst; attach re-bases the emitter on a
// followed entity's transform each update.
//
// RENDER-ONLY + DETERMINISM: VFX is never sim/log/replay state — it is a pure render
// pump driven by dt. There is NO Date.now / Math.random / performance.now. Per-particle
// spawn jitter is derived from a PURE integer hash of (system seed, monotonic spawn
// counter), so two identical create+update sequences produce byte-identical buffers.

import { z } from "../../build/zod.bundle.mjs";
import * as THREE from "../../build/three.bundle.mjs";
import { Position } from "../ecs/world.ts";
import type { SceneLike } from "../engine.ts";
import type { SkillDefinition, SkillRegistry, WorldContext } from "./registry.ts";

const Vec3 = z.tuple([z.number(), z.number(), z.number()]);
const Vec4 = z.tuple([z.number(), z.number(), z.number(), z.number()]);
const MetaField = z.record(z.string(), z.unknown()).optional().describe("Agent-supplied extension metadata.");

export interface ParticleConfig {
  maxParticles: number;
  lifetime: number;
  emissionRate: number;
  startColor: [number, number, number, number]; // RGBA
  endColor: [number, number, number, number];
  startSize: number;
  endSize: number;
  startSpeed: number;
  gravity: number;
  spread: number;
  shape: "sphere" | "cone" | "box" | "point";
  blendMode: "additive" | "alpha" | "multiply";
  config?: Record<string, unknown>;
}

/** Public view of a live system (read surface for hosts/tests). */
export interface ParticleSystem {
  id: string;
  entity: string;
  attached: boolean;
  config: ParticleConfig;
  playing: boolean;
  /** Live (un-recycled) particle count. */
  liveCount: number;
  /** Current emitter origin in world space (tracks an attached entity). */
  emitter: [number, number, number];
  /** A one-shot burst (atPosition) — no continuous emission; freed when it drains. */
  oneShot: boolean;
}

const TWO_PI = Math.PI * 2;
const DEG2RAD = Math.PI / 180;

/** A scene that can take/drop children (THREE.Scene or a headless stub). */
interface SceneAdd { add(child: unknown): void; remove(child: unknown): void }

/** Pure 32-bit integer hash → [0,1). Same input → same output (no RNG), so the
 *  per-particle spawn jitter is deterministic across runs. */
function hash01(n: number): number {
  let h = n | 0;
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b);
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b);
  h = (h ^ (h >>> 16)) >>> 0;
  return h / 0x100000000;
}

/** A deterministic launch velocity for spawn `s` of a system with `seed`. The
 *  direction is shaped by the emitter `shape`/`spread`; magnitude is `speed`. */
function spawnVelocity(
  shape: ParticleConfig["shape"],
  spreadDeg: number,
  speed: number,
  seed: number,
  s: number,
): [number, number, number] {
  const u = hash01((seed * 0x9e3779b1) ^ (s * 0x85ebca77) ^ 0x27d4eb2f);
  const v = hash01((seed * 0xc2b2ae35) ^ (s * 0x165667b1) ^ 0x9e3779b9);
  const theta = u * TWO_PI;
  let dx: number, dy: number, dz: number;
  if (shape === "sphere") {
    // Uniform direction on the unit sphere (omnidirectional burst).
    const cz = 2 * v - 1;
    const r = Math.sqrt(Math.max(0, 1 - cz * cz));
    dx = r * Math.cos(theta);
    dy = cz;
    dz = r * Math.sin(theta);
  } else {
    // Cone / point / box: a cone about +Y within the half-spread angle.
    const half = (spreadDeg * DEG2RAD) * 0.5;
    const cy = Math.cos(half * v); // v in [0,1) → angle in [0,half)
    const r = Math.sqrt(Math.max(0, 1 - cy * cy));
    dx = r * Math.cos(theta);
    dy = cy;
    dz = r * Math.sin(theta);
  }
  return [dx * speed, dy * speed, dz * speed];
}

/** Map an agent blend-mode name to a THREE blending constant. */
function blendOf(mode: ParticleConfig["blendMode"]): number {
  if (mode === "alpha") return THREE.NormalBlending;
  if (mode === "multiply") return THREE.MultiplyBlending;
  return THREE.AdditiveBlending;
}

/** A sentinel position for a dead/recycled particle (off-screen; deterministic so
 *  two runs compare equal). Reused slots overwrite it on the next spawn. */
const DEAD_Y = -1e9;

interface SystemState {
  id: string;
  config: ParticleConfig;
  playing: boolean;
  attached: boolean;
  entity: string;
  oneShot: boolean;
  seed: number;
  emitter: [number, number, number];
  offset: [number, number, number];
  count: number;
  positions: Float32Array; // count*3
  velocities: Float32Array; // count*3
  ages: Float32Array; // count
  alive: Uint8Array; // count
  liveCount: number;
  emittedTotal: number;
  emitAccum: number;
  spawnSeq: number;
  slotCursor: number;
  points: THREE.Points;
  posAttr: THREE.BufferAttribute;
  colAttr: THREE.BufferAttribute;
  scene?: SceneAdd;
  followWorld?: WorldContext;
}

export class VFXManager {
  private readonly systems = new Map<string, SystemState>();
  private seq = 0;

  /** Build a system's THREE.Points + CPU buffers. Never draws dead particles
   *  (parked at DEAD_Y). Works headlessly — the Points object is a plain CPU object. */
  private build(id: string, config: ParticleConfig, scene?: SceneAdd, oneShot = false): SystemState {
    const count = config.maxParticles;
    const positions = new Float32Array(count * 3);
    const colors = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) positions[i * 3 + 1] = DEAD_Y;
    const geom = new THREE.BufferGeometry();
    const posAttr = new THREE.BufferAttribute(positions, 3);
    const colAttr = new THREE.BufferAttribute(colors, 3);
    posAttr.setUsage(THREE.DynamicDrawUsage);
    colAttr.setUsage(THREE.DynamicDrawUsage);
    geom.setAttribute("position", posAttr);
    geom.setAttribute("color", colAttr);
    const material = new THREE.PointsMaterial({
      size: config.startSize,
      sizeAttenuation: true,
      vertexColors: true,
      transparent: true,
      opacity: config.startColor[3],
      depthWrite: false,
      blending: blendOf(config.blendMode),
    });
    const points = new THREE.Points(geom, material);
    points.frustumCulled = false; // particles move past the static bounds each frame
    if (scene !== undefined && typeof scene.add === "function") scene.add(points);
    const sys: SystemState = {
      id, config, playing: false, attached: false, entity: "", oneShot,
      seed: this.seq, emitter: [0, 0, 0], offset: [0, 0, 0],
      count, positions, velocities: new Float32Array(count * 3), ages: new Float32Array(count),
      alive: new Uint8Array(count), liveCount: 0, emittedTotal: 0, emitAccum: 0,
      spawnSeq: 0, slotCursor: 0, points, posAttr, colAttr, scene,
    };
    this.systems.set(id, sys);
    return sys;
  }

  /** Find a free (dead) particle slot from a round-robin cursor, or -1 when full. */
  private freeSlot(sys: SystemState): number {
    for (let k = 0; k < sys.count; k++) {
      const i = (sys.slotCursor + k) % sys.count;
      if (sys.alive[i] === 0) {
        sys.slotCursor = (i + 1) % sys.count;
        return i;
      }
    }
    return -1;
  }

  /** Spawn one particle at the emitter with a deterministic launch velocity. */
  private spawn(sys: SystemState): boolean {
    const i = this.freeSlot(sys);
    if (i < 0) return false;
    const s = sys.spawnSeq++;
    const [vx, vy, vz] = spawnVelocity(sys.config.shape, sys.config.spread, sys.config.startSpeed, sys.seed, s);
    const o = i * 3;
    sys.positions[o] = sys.emitter[0];
    sys.positions[o + 1] = sys.emitter[1];
    sys.positions[o + 2] = sys.emitter[2];
    sys.velocities[o] = vx;
    sys.velocities[o + 1] = vy;
    sys.velocities[o + 2] = vz;
    sys.ages[i] = 0;
    sys.alive[i] = 1;
    sys.liveCount++;
    sys.emittedTotal++;
    const c = sys.config.startColor;
    sys.colAttr.array[o] = c[0];
    sys.colAttr.array[o + 1] = c[1];
    sys.colAttr.array[o + 2] = c[2];
    return true;
  }

  /** Recycle a particle: mark dead and park it off-screen. */
  private kill(sys: SystemState, i: number): void {
    sys.alive[i] = 0;
    sys.liveCount--;
    sys.positions[i * 3 + 1] = DEAD_Y;
  }

  // ---- Authoring surface -------------------------------------------------

  create(config: ParticleConfig, scene?: SceneAdd): string {
    const id = `vfx_${this.seq++}`;
    this.build(id, config, scene, false);
    return id;
  }

  play(id: string): boolean {
    const sys = this.systems.get(id);
    if (sys === undefined) return false;
    sys.playing = true;
    return true;
  }

  /** Stop EMISSION; existing particles keep aging out (a natural fade). */
  stop(id: string): boolean {
    const sys = this.systems.get(id);
    if (sys === undefined) return false;
    sys.playing = false;
    return true;
  }

  attach(id: string, entity: string, world?: WorldContext, offset?: [number, number, number]): boolean {
    const sys = this.systems.get(id);
    if (sys === undefined) return false;
    sys.entity = entity;
    sys.attached = true;
    sys.followWorld = world;
    if (offset !== undefined) sys.offset = offset;
    this.refreshEmitter(sys);
    return true;
  }

  /** One-shot burst at a world position: a self-cleaning system that spawns `count`
   *  real particles immediately and frees itself once they drain. */
  atPosition(
    opts: { position: [number, number, number]; color: [number, number, number, number]; size: number; lifetime: number; count: number; speed: number; config?: Record<string, unknown> },
    scene?: SceneAdd,
  ): string {
    const id = `vfx_${this.seq++}`;
    const sys = this.build(id, {
      maxParticles: opts.count,
      lifetime: opts.lifetime,
      emissionRate: 0,
      startColor: opts.color,
      endColor: [opts.color[0], opts.color[1], opts.color[2], 0],
      startSize: opts.size,
      endSize: opts.size * 0.1,
      startSpeed: opts.speed,
      gravity: 0,
      spread: 360,
      shape: "sphere",
      blendMode: "additive",
      config: opts.config,
    }, scene, true);
    sys.emitter = [opts.position[0], opts.position[1], opts.position[2]];
    sys.playing = true;
    for (let k = 0; k < opts.count; k++) this.spawn(sys);
    sys.posAttr.needsUpdate = true;
    sys.colAttr.needsUpdate = true;
    return id;
  }

  destroy(id: string): boolean {
    const sys = this.systems.get(id);
    if (sys === undefined) return false;
    if (sys.scene !== undefined && typeof sys.scene.remove === "function") sys.scene.remove(sys.points);
    sys.points.geometry.dispose();
    const mat = sys.points.material as THREE.Material;
    mat.dispose();
    return this.systems.delete(id);
  }

  /** Re-base an attached system's emitter on its followed entity's transform. */
  private refreshEmitter(sys: SystemState): void {
    if (!sys.attached || sys.followWorld === undefined) return;
    const entry = sys.followWorld.entities.resolve(sys.entity);
    if (entry === undefined) return;
    const eid = entry.eid;
    sys.emitter = [
      Position.x[eid] + sys.offset[0],
      Position.y[eid] + sys.offset[1],
      Position.z[eid] + sys.offset[2],
    ];
  }

  /** Per-frame integration pump (render-only, deterministic given dt + seed).
   *  Emits, integrates (pos += vel·dt; vel += gravity·dt), ages/recycles, lerps
   *  colour, and rewrites the GPU buffers. One-shot systems free themselves when
   *  drained. */
  update(dt: number): void {
    for (const sys of [...this.systems.values()]) {
      this.refreshEmitter(sys);

      // Continuous emission (fractional accumulator → integer spawns).
      if (sys.playing && !sys.oneShot && sys.config.emissionRate > 0) {
        sys.emitAccum += sys.config.emissionRate * dt;
        while (sys.emitAccum >= 1) {
          sys.emitAccum -= 1;
          if (!this.spawn(sys)) { sys.emitAccum = 0; break; }
        }
      }

      const g = sys.config.gravity;
      const life = sys.config.lifetime;
      const sc = sys.config.startColor;
      const ec = sys.config.endColor;
      const col = sys.colAttr.array as Float32Array;
      for (let i = 0; i < sys.count; i++) {
        if (sys.alive[i] === 0) continue;
        sys.ages[i] += dt;
        if (sys.ages[i] >= life) { this.kill(sys, i); continue; }
        const o = i * 3;
        // Explicit Euler: advance position with current velocity, then apply gravity.
        sys.positions[o] += sys.velocities[o] * dt;
        sys.positions[o + 1] += sys.velocities[o + 1] * dt;
        sys.positions[o + 2] += sys.velocities[o + 2] * dt;
        sys.velocities[o + 1] += g * dt;
        // Lerp colour start→end over the particle's life.
        const t = sys.ages[i] / life;
        col[o] = sc[0] + (ec[0] - sc[0]) * t;
        col[o + 1] = sc[1] + (ec[1] - sc[1]) * t;
        col[o + 2] = sc[2] + (ec[2] - sc[2]) * t;
      }
      sys.posAttr.needsUpdate = true;
      sys.colAttr.needsUpdate = true;

      // A drained one-shot frees itself (resources released).
      if (sys.oneShot && sys.emittedTotal > 0 && sys.liveCount === 0) this.destroy(sys.id);
    }
  }

  // ---- Read surface (hosts / tests) --------------------------------------

  get(id: string): ParticleSystem | undefined {
    const s = this.systems.get(id);
    if (s === undefined) return undefined;
    return {
      id: s.id, entity: s.entity, attached: s.attached, config: s.config,
      playing: s.playing, liveCount: s.liveCount, emitter: [...s.emitter], oneShot: s.oneShot,
    };
  }

  /** Live particle count of a system (0 when unknown). */
  particleCount(id: string): number {
    return this.systems.get(id)?.liveCount ?? 0;
  }

  /** A COPY of a system's position buffer (for determinism checks / host readback). */
  positionsOf(id: string): Float32Array | undefined {
    const s = this.systems.get(id);
    return s === undefined ? undefined : Float32Array.from(s.positions);
  }

  list(): { id: string; playing: boolean; attached: boolean; entity: string; liveCount: number }[] {
    return [...this.systems.values()].map((s) => ({ id: s.id, playing: s.playing, attached: s.attached, entity: s.entity, liveCount: s.liveCount }));
  }
}

const particleConfigSchema = z.object({
  maxParticles: z.number().int().min(1).max(10000).default(100),
  lifetime: z.number().positive().default(2),
  emissionRate: z.number().min(0).default(10),
  startColor: Vec4.default([1, 1, 1, 1]).describe("RGBA start color (0-1)."),
  endColor: Vec4.default([1, 1, 1, 0]).describe("RGBA end color (0-1)."),
  startSize: z.number().positive().default(0.1),
  endSize: z.number().positive().default(0.01),
  startSpeed: z.number().default(1),
  gravity: z.number().default(-9.8),
  spread: z.number().min(0).max(360).default(30).describe("Emission spread angle (degrees)."),
  shape: z.enum(["sphere", "cone", "box", "point"]).default("sphere"),
  blendMode: z.enum(["additive", "alpha", "multiply"]).default("additive"),
  config: z.record(z.string(), z.unknown()).optional().describe("Custom particle system data (texture, noise, turbulence, etc.)."),
});

const createVFXInput = z.object({
  config: particleConfigSchema,
  meta: MetaField,
});

const playVFXInput = z.object({
  vfxId: z.string(),
  meta: MetaField,
});

const atPositionInput = z.object({
  position: Vec3,
  color: Vec4.default([1, 1, 1, 1]).describe("Particle color (RGBA 0-1)."),
  size: z.number().positive().default(0.2).describe("Particle size."),
  lifetime: z.number().positive().default(0.5).describe("Particle lifetime in seconds."),
  count: z.number().int().min(1).max(200).default(20).describe("Number of particles."),
  speed: z.number().default(3).describe("Emission speed."),
  config: z.record(z.string(), z.unknown()).optional().describe("Custom one-shot effect data (trail, explosion, sparkle, etc.)."),
  meta: MetaField,
});

const attachVFXInput = z.object({
  vfxId: z.string(),
  entity: z.string(),
  offset: Vec3.default([0, 0, 0]).describe("Offset from entity position."),
  meta: MetaField,
});

/**
 * Register the vfx.* skills bound to a VFXManager. The skill handlers CLOSE OVER
 * the manager (no ctx.world.vfxManager). Returns the manager so the core wiring can
 * expose it (core.vfx.vfxManager). The manager builds REAL THREE.Points particle
 * systems on ctx.world.scene; a host drives VFXManager.update(dt) each frame.
 */
export function registerVFXSkills(registry: SkillRegistry, opts?: { vfxManager?: VFXManager }): { vfxManager: VFXManager } {
  const mgr = opts?.vfxManager ?? new VFXManager();

  const createVFX: SkillDefinition<z.infer<typeof createVFXInput>, { vfxId: string }> = {
    name: "vfx.create",
    version: "1.0.0",
    description: "Create a CPU particle system with full configuration (emitter, lifetime, color, size, velocity, gravity, shape, blend mode). Builds a THREE.Points object on the scene; particles are simulated by the per-frame VFX update. Returns vfx id.",
    category: "vfx",
    permissions: ["vfx.write"],
    input: createVFXInput,
    output: z.object({ vfxId: z.string() }),
    handler: (input, ctx) => {
      const id = mgr.create(input.config, ctx.world.scene as unknown as SceneAdd);
      ctx.emit("vfx.created", { vfxId: id, config: input.config, ...input.meta });
      return { vfxId: id };
    },
  };

  const playVFX: SkillDefinition<z.infer<typeof playVFXInput>, { ok: boolean }> = {
    name: "vfx.play",
    version: "1.0.0",
    description: "Start emitting particles from a particle system.",
    category: "vfx",
    permissions: ["vfx.write"],
    input: playVFXInput,
    output: z.object({ ok: z.boolean() }),
    handler: (input, ctx) => {
      const ok = mgr.play(input.vfxId);
      ctx.emit("vfx.played", { vfxId: input.vfxId, ok, ...input.meta });
      return { ok };
    },
  };

  const stopVFX: SkillDefinition<z.infer<typeof playVFXInput>, { ok: boolean }> = {
    name: "vfx.stop",
    version: "1.0.0",
    description: "Stop emitting; existing particles age out (a natural fade) instead of vanishing.",
    category: "vfx",
    permissions: ["vfx.write"],
    input: playVFXInput,
    output: z.object({ ok: z.boolean() }),
    handler: (input, ctx) => {
      const ok = mgr.stop(input.vfxId);
      ctx.emit("vfx.stopped", { vfxId: input.vfxId, ok, ...input.meta });
      return { ok };
    },
  };

  const atPosition: SkillDefinition<z.infer<typeof atPositionInput>, { ok: boolean; vfxId: string }> = {
    name: "vfx.atPosition",
    version: "1.0.0",
    description: "Spawn a one-shot particle burst at a world position (explosion, spark, puff, etc.). Spawns REAL particles immediately; the system self-frees once they drain.",
    category: "vfx",
    permissions: ["vfx.write"],
    input: atPositionInput,
    output: z.object({ ok: z.boolean(), vfxId: z.string() }),
    handler: (input, ctx) => {
      const id = mgr.atPosition({
        position: input.position, color: input.color, size: input.size,
        lifetime: input.lifetime, count: input.count, speed: input.speed, config: input.config,
      }, ctx.world.scene as unknown as SceneAdd);
      ctx.emit("vfx.atPosition", { position: input.position, color: input.color, count: input.count, vfxId: id, ...input.meta });
      return { ok: true, vfxId: id };
    },
  };

  const attachVFX: SkillDefinition<z.infer<typeof attachVFXInput>, { ok: boolean }> = {
    name: "vfx.attach",
    version: "1.0.0",
    description: "Attach a particle system to an entity. The emitter follows the entity's transform each update (trail, aura, weapon effect), offset by `offset`.",
    category: "vfx",
    permissions: ["vfx.write"],
    input: attachVFXInput,
    output: z.object({ ok: z.boolean() }),
    handler: (input, ctx) => {
      const ok = mgr.attach(input.vfxId, input.entity, ctx.world, input.offset);
      ctx.emit("vfx.attached", { vfxId: input.vfxId, entity: input.entity, offset: input.offset, ok, ...input.meta });
      return { ok };
    },
  };

  const destroyVFX: SkillDefinition<z.infer<typeof playVFXInput>, { ok: boolean }> = {
    name: "vfx.destroy",
    version: "1.0.0",
    description: "Destroy a particle system: remove its THREE.Points from the scene and free its geometry/material.",
    category: "vfx",
    permissions: ["vfx.write"],
    input: playVFXInput,
    output: z.object({ ok: z.boolean() }),
    handler: (input, ctx) => {
      const ok = mgr.destroy(input.vfxId);
      ctx.emit("vfx.destroyed", { vfxId: input.vfxId, ok, ...input.meta });
      return { ok };
    },
  };

  registry.register(createVFX);
  registry.register(playVFX);
  registry.register(stopVFX);
  registry.register(atPosition);
  registry.register(attachVFX);
  registry.register(destroyVFX);

  return { vfxManager: mgr };
}
