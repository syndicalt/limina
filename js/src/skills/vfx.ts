// vfx.* skills — particle systems and visual effects.
// All inputs accept optional `meta` for agent-supplied extension data.

import { z } from "../../build/zod.bundle.mjs";
import type { SkillDefinition, SkillRegistry } from "./registry.ts";

const Vec3 = z.tuple([z.number(), z.number(), z.number()]);
const Vec4 = z.tuple([z.number(), z.number(), z.number(), z.number()]);
const MetaField = z.record(z.string(), z.unknown()).optional().describe("Agent-supplied extension metadata.");

export interface ParticleSystem {
  id: string;
  entity: string;
  attached: boolean;
  config: ParticleConfig;
  playing: boolean;
}

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

export class VFXManager {
  private readonly systems = new Map<string, ParticleSystem>();
  private seq = 0;

  create(config: ParticleConfig): string {
    const id = `vfx_${this.seq++}`;
    this.systems.set(id, { id, entity: "", attached: false, config, playing: false });
    return id;
  }

  play(id: string): boolean {
    const system = this.systems.get(id);
    if (system === undefined) return false;
    system.playing = true;
    return true;
  }

  stop(id: string): boolean {
    const system = this.systems.get(id);
    if (system === undefined) return false;
    system.playing = false;
    return true;
  }

  attach(id: string, entity: string): boolean {
    const system = this.systems.get(id);
    if (system === undefined) return false;
    system.entity = entity;
    system.attached = true;
    return true;
  }

  destroy(id: string): boolean {
    return this.systems.delete(id);
  }

  get(id: string): ParticleSystem | undefined {
    return this.systems.get(id);
  }

  list(): { id: string; playing: boolean; attached: boolean; entity: string }[] {
    return [...this.systems.values()].map((s) => ({ id: s.id, playing: s.playing, attached: s.attached, entity: s.entity }));
  }
}

const particleConfigSchema = z.object({
  maxParticles: z.number().int().min(1).max(10000).default(100),
  lifetime: z.number().positive().default(2),
  emissionRate: z.number().positive().default(10),
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

const createVFX: SkillDefinition<z.infer<typeof createVFXInput>, { vfxId: string }> = {
  name: "vfx.create",
  version: "1.0.0",
  description: "Create a particle system with full configuration (emitter, lifetime, color, size, velocity, gravity, shape, blend mode). Returns vfx id.",
  category: "vfx",
  permissions: ["vfx.write"],
  input: createVFXInput,
  output: z.object({ vfxId: z.string() }),
  handler: (input, ctx) => {
    const mgr = (ctx.world as unknown as { vfxManager?: VFXManager }).vfxManager;
    if (mgr === undefined) return { vfxId: "" };
    const id = mgr.create(input.config);
    ctx.emit("vfx.created", { vfxId: id, config: input.config, ...input.meta });
    return { vfxId: id };
  },
};

const playVFXInput = z.object({
  vfxId: z.string(),
  meta: MetaField,
});

const playVFX: SkillDefinition<z.infer<typeof playVFXInput>, { ok: boolean }> = {
  name: "vfx.play",
  version: "1.0.0",
  description: "Start emitting particles from a particle system.",
  category: "vfx",
  permissions: ["vfx.write"],
  input: playVFXInput,
  output: z.object({ ok: z.boolean() }),
  handler: (input, ctx) => {
    const mgr = (ctx.world as unknown as { vfxManager?: VFXManager }).vfxManager;
    if (mgr === undefined) return { ok: false };
    const ok = mgr.play(input.vfxId);
    ctx.emit("vfx.played", { vfxId: input.vfxId, ok, ...input.meta });
    return { ok };
  },
};

const stopVFX: SkillDefinition<z.infer<typeof playVFXInput>, { ok: boolean }> = {
  name: "vfx.stop",
  version: "1.0.0",
  description: "Stop emitting and fade out existing particles from a particle system.",
  category: "vfx",
  permissions: ["vfx.write"],
  input: playVFXInput,
  output: z.object({ ok: z.boolean() }),
  handler: (input, ctx) => {
    const mgr = (ctx.world as unknown as { vfxManager?: VFXManager }).vfxManager;
    if (mgr === undefined) return { ok: false };
    const ok = mgr.stop(input.vfxId);
    ctx.emit("vfx.stopped", { vfxId: input.vfxId, ok, ...input.meta });
    return { ok };
  },
};

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

const atPosition: SkillDefinition<z.infer<typeof atPositionInput>, { ok: boolean; vfxId: string }> = {
  name: "vfx.atPosition",
  version: "1.0.0",
  description: "Play a one-shot particle effect at a world position (explosion, spark, puff, etc.).",
  category: "vfx",
  permissions: ["vfx.write"],
  input: atPositionInput,
  output: z.object({ ok: z.boolean(), vfxId: z.string() }),
  handler: (input, ctx) => {
    const mgr = (ctx.world as unknown as { vfxManager?: VFXManager }).vfxManager;
    if (mgr === undefined) return { ok: false, vfxId: "" };
    const id = mgr.create({
      maxParticles: input.count,
      lifetime: input.lifetime,
      emissionRate: input.count / input.lifetime,
      startColor: input.color,
      endColor: [input.color[0], input.color[1], input.color[2], 0],
      startSize: input.size,
      endSize: input.size * 0.1,
      startSpeed: input.speed,
      gravity: 0,
      spread: 360,
      shape: "sphere",
      blendMode: "additive",
      config: input.config,
    });
    mgr.play(id);
    ctx.emit("vfx.atPosition", { position: input.position, color: input.color, count: input.count, vfxId: id, ...input.meta });
    return { ok: true, vfxId: id };
  },
};

const attachVFXInput = z.object({
  vfxId: z.string(),
  entity: z.string(),
  offset: Vec3.default([0, 0, 0]).describe("Offset from entity position."),
  meta: MetaField,
});

const attachVFX: SkillDefinition<z.infer<typeof attachVFXInput>, { ok: boolean }> = {
  name: "vfx.attach",
  version: "1.0.0",
  description: "Attach a particle system to an entity. The VFX follows the entity (trail, aura, weapon effect).",
  category: "vfx",
  permissions: ["vfx.write"],
  input: attachVFXInput,
  output: z.object({ ok: z.boolean() }),
  handler: (input, ctx) => {
    const mgr = (ctx.world as unknown as { vfxManager?: VFXManager }).vfxManager;
    if (mgr === undefined) return { ok: false };
    const ok = mgr.attach(input.vfxId, input.entity);
    ctx.emit("vfx.attached", { vfxId: input.vfxId, entity: input.entity, offset: input.offset, ok, ...input.meta });
    return { ok };
  },
};

const destroyVFX: SkillDefinition<z.infer<typeof playVFXInput>, { ok: boolean }> = {
  name: "vfx.destroy",
  version: "1.0.0",
  description: "Destroy a particle system and free resources.",
  category: "vfx",
  permissions: ["vfx.write"],
  input: playVFXInput,
  output: z.object({ ok: z.boolean() }),
  handler: (input, ctx) => {
    const mgr = (ctx.world as unknown as { vfxManager?: VFXManager }).vfxManager;
    if (mgr === undefined) return { ok: false };
    const ok = mgr.destroy(input.vfxId);
    ctx.emit("vfx.destroyed", { vfxId: input.vfxId, ok, ...input.meta });
    return { ok };
  },
};

export function registerVFXSkills(registry: SkillRegistry, opts?: { vfxManager?: VFXManager }): { vfxManager: VFXManager } {
  const mgr = opts?.vfxManager ?? new VFXManager();

  registry.register(createVFX);
  registry.register(playVFX);
  registry.register(stopVFX);
  registry.register(atPosition);
  registry.register(attachVFX);
  registry.register(destroyVFX);

  return { vfxManager: mgr };
}
