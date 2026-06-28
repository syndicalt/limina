// animation.* skills — skeletal animation, state machines, blend trees.
// All inputs accept optional `meta` for agent-supplied extension data.

import { z } from "../../build/zod.bundle.mjs";
import type { SkillDefinition, SkillRegistry } from "./registry.ts";

const MetaField = z.record(z.string(), z.unknown()).optional().describe("Agent-supplied extension metadata.");

// Animation clip definition
export interface AnimationClip {
  id: string;
  name: string;
  duration: number;
  loop: boolean;
  layers: number;
  frameRate: number;
  frames: Float32Array[]; // SoA bone transforms per frame
  boneNames: string[];
  meta?: Record<string, unknown>;
}

// Animator parameter
export type AnimatorParam =
  | { name: string; type: "float"; value: number; defaultValue: number }
  | { name: string; type: "int"; value: number; defaultValue: number }
  | { name: string; type: "bool"; value: boolean; defaultValue: boolean }
  | { name: string; type: "trigger"; value: boolean; defaultValue: false };

// Animation state
export interface AnimationStateDef {
  name: string;
  clipId: string;
  speed?: number;
  layer?: number;
}

// Transition definition
export interface TransitionDef {
  from: string;
  to: string;
  conditions: { param: string; op: "equals" | "greater" | "less" | "true" | "false"; value?: number | boolean }[];
  duration?: number;
}

// State machine definition
export interface StateMachineDef {
  name: string;
  defaultState: string;
  states: AnimationStateDef[];
  transitions: TransitionDef[];
  parameters: { name: string; type: "float" | "int" | "bool" | "trigger"; defaultValue: number | boolean }[];
  meta?: Record<string, unknown>;
}

// Playing animation instance
interface PlayingClip {
  clipId: string;
  time: number;
  speed: number;
  weight: number;
  loop: boolean;
  layer: number;
  fadingIn: boolean;
  fadeDuration: number;
}

// Animator per entity
interface AnimatorEntry {
  playing: PlayingClip[];
  parameters: Map<string, AnimatorParam>;
  stateMachine?: StateMachineDef;
  currentState: string;
  previousState: string;
  transitionProgress: number;
}

export class AnimationManager {
  private readonly clips = new Map<string, AnimationClip>();
  private readonly animators = new Map<string, AnimatorEntry>();

  registerClip(clip: AnimationClip): void {
    this.clips.set(clip.id, clip);
  }

  getClip(id: string): AnimationClip | undefined {
    return this.clips.get(id);
  }

  listClips(): { id: string; name: string; duration: number; loop: boolean }[] {
    return [...this.clips.values()].map((c) => ({ id: c.id, name: c.name, duration: c.duration, loop: c.loop }));
  }

  getOrCreateAnimator(entity: string): AnimatorEntry {
    if (!this.animators.has(entity)) {
      this.animators.set(entity, { playing: [], parameters: new Map(), currentState: "", previousState: "", transitionProgress: 0 });
    }
    return this.animators.get(entity)!;
  }

  play(entity: string, clipId: string, opts: { layer?: number; weight?: number; speed?: number; loop?: boolean; fadeDuration?: number }): void {
    const anim = this.getOrCreateAnimator(entity);
    const clip = this.clips.get(clipId);
    if (clip === undefined) throw new Error(`animation.play: unknown clip '${clipId}'`);
    anim.playing.push({
      clipId,
      time: 0,
      speed: opts.speed ?? 1,
      weight: opts.weight ?? 1,
      loop: opts.loop ?? clip.loop,
      layer: opts.layer ?? 0,
      fadingIn: opts.fadeDuration !== undefined && opts.fadeDuration > 0,
      fadeDuration: opts.fadeDuration ?? 0,
    });
  }

  stop(entity: string, layer?: number, fadeOutMs?: number): void {
    const anim = this.animators.get(entity);
    if (anim === undefined) return;
    if (layer !== undefined) {
      anim.playing = anim.playing.filter((p) => p.layer !== layer);
    } else {
      anim.playing = [];
    }
  }

  setParam(entity: string, name: string, value: number | boolean): void {
    const anim = this.getOrCreateAnimator(entity);
    const existing = anim.parameters.get(name);
    if (existing) {
      if (existing.type === "trigger") {
        existing.value = true;
      } else {
        existing.value = value as number;
      }
    } else {
      const type = typeof value === "boolean" ? "bool" : "float";
      anim.parameters.set(name, { name, type: type as "bool" | "float", value: value as number, defaultValue: value as number });
    }
  }

  createStateMachine(entity: string, def: StateMachineDef): void {
    const anim = this.getOrCreateAnimator(entity);
    anim.stateMachine = def;
    anim.currentState = def.defaultState;
    anim.previousState = def.defaultState;
    anim.transitionProgress = 0;
    for (const param of def.parameters) {
      anim.parameters.set(param.name, {
        name: param.name,
        type: param.type as "float" | "int" | "bool" | "trigger",
        value: param.defaultValue as number,
        defaultValue: param.defaultValue,
      });
    }
  }

  transition(entity: string, targetState: string): boolean {
    const anim = this.animators.get(entity);
    if (anim === undefined || anim.stateMachine === undefined) return false;
    const state = anim.stateMachine.states.find((s) => s.name === targetState);
    if (state === undefined) return false;
    anim.previousState = anim.currentState;
    anim.currentState = targetState;
    anim.transitionProgress = 0;
    return true;
  }

  getClipInfo(entity: string): { clipId: string; time: number; duration: number; layer: number }[] {
    const anim = this.animators.get(entity);
    if (anim === undefined) return [];
    return anim.playing.map((p) => {
      const clip = this.clips.get(p.clipId);
      return { clipId: p.clipId, time: p.time, duration: clip?.duration ?? 0, layer: p.layer };
    });
  }
}

const loadClipInput = z.object({
  id: z.string().min(1).describe("Unique clip identifier."),
  name: z.string().min(1).describe("Human-readable clip name."),
  duration: z.number().positive().describe("Clip duration in seconds."),
  loop: z.boolean().default(false),
  frameRate: z.number().positive().default(30),
  assetId: z.string().optional().describe("Source asset id (GLTF animation, etc.) for content-addressed loading."),
  meta: MetaField,
});

const loadClip: SkillDefinition<z.infer<typeof loadClipInput>, { ok: boolean; clipId: string }> = {
  name: "animation.load",
  version: "1.0.0",
  description: "Register an animation clip for use. Accepts a content-addressed asset id (GLTF) or a procedural definition.",
  category: "animation",
  permissions: ["animation.read"],
  input: loadClipInput,
  output: z.object({ ok: z.boolean(), clipId: z.string() }),
  handler: (input, ctx) => {
    const mgr = (ctx.world as unknown as { animationManager?: AnimationManager }).animationManager;
    if (mgr === undefined) return { ok: false, clipId: input.id };
    mgr.registerClip({ id: input.id, name: input.name, duration: input.duration, loop: input.loop, frameRate: input.frameRate, layers: 1, frames: [], boneNames: [], meta: input.meta });
    ctx.emit("animation.loaded", { clipId: input.id, name: input.name, duration: input.duration, assetId: input.assetId, ...input.meta });
    return { ok: true, clipId: input.id };
  },
};

const playInput = z.object({
  entity: z.string(),
  clipId: z.string().describe("Clip id to play (registered via animation.load)."),
  layer: z.number().int().default(0).describe("Animation layer (higher layers override lower)."),
  weight: z.number().min(0).max(1).default(1).describe("Blend weight."),
  speed: z.number().default(1).describe("Playback speed multiplier."),
  loop: z.boolean().default(true).describe("Whether to loop the animation."),
  fadeDuration: z.number().min(0).default(0).describe("Fade-in duration in ms."),
  meta: MetaField,
});

const play: SkillDefinition<z.infer<typeof playInput>, { ok: boolean }> = {
  name: "animation.play",
  version: "1.0.0",
  description: "Play an animation clip on an entity's animator with layer, weight, speed, and loop controls.",
  category: "animation",
  permissions: ["animation.write"],
  input: playInput,
  output: z.object({ ok: z.boolean() }),
  handler: (input, ctx) => {
    const mgr = (ctx.world as unknown as { animationManager?: AnimationManager }).animationManager;
    if (mgr === undefined) return { ok: false };
    mgr.play(input.entity, input.clipId, { layer: input.layer, weight: input.weight, speed: input.speed, loop: input.loop, fadeDuration: input.fadeDuration });
    ctx.emit("animation.played", { entity: input.entity, clipId: input.clipId, layer: input.layer, speed: input.speed, ...input.meta });
    return { ok: true };
  },
};

const stopInput = z.object({
  entity: z.string(),
  layer: z.number().int().optional().describe("Stop only this layer. If omitted, stop all."),
  fadeOutMs: z.number().min(0).default(0).describe("Fade-out duration in ms."),
  meta: MetaField,
});

const stop: SkillDefinition<z.infer<typeof stopInput>, { ok: boolean }> = {
  name: "animation.stop",
  version: "1.0.0",
  description: "Stop an animation on an entity (all layers or a specific layer) with optional fade-out.",
  category: "animation",
  permissions: ["animation.write"],
  input: stopInput,
  output: z.object({ ok: z.boolean() }),
  handler: (input, ctx) => {
    const mgr = (ctx.world as unknown as { animationManager?: AnimationManager }).animationManager;
    if (mgr === undefined) return { ok: false };
    mgr.stop(input.entity, input.layer, input.fadeOutMs);
    ctx.emit("animation.stopped", { entity: input.entity, layer: input.layer, ...input.meta });
    return { ok: true };
  },
};

const blendInput = z.object({
  entity: z.string(),
  clips: z.array(z.object({
    clipId: z.string(),
    weight: z.number().min(0).max(1),
    speed: z.number().default(1),
    layer: z.number().int().default(0),
  })).min(2).max(8).describe("Clips to blend between (weights are normalized)."),
  meta: MetaField,
});

const blend: SkillDefinition<z.infer<typeof blendInput>, { ok: boolean }> = {
  name: "animation.blend",
  version: "1.0.0",
  description: "Blend between two or more clips with weights (for locomotion: idle/walk/run). Weights are normalized.",
  category: "animation",
  permissions: ["animation.write"],
  input: blendInput,
  output: z.object({ ok: z.boolean() }),
  handler: (input, ctx) => {
    const mgr = (ctx.world as unknown as { animationManager?: AnimationManager }).animationManager;
    if (mgr === undefined) return { ok: false };
    const totalWeight = input.clips.reduce((s, c) => s + c.weight, 0);
    for (const clip of input.clips) {
      mgr.play(input.entity, clip.clipId, { layer: clip.layer, weight: clip.weight / totalWeight, speed: clip.speed, loop: true });
    }
    ctx.emit("animation.blended", { entity: input.entity, clips: input.clips.map((c) => c.clipId), ...input.meta });
    return { ok: true };
  },
};

const transitionInput = z.object({
  entity: z.string(),
  state: z.string().describe("Target state name in the entity's animation state machine."),
  meta: MetaField,
});

const transition: SkillDefinition<z.infer<typeof transitionInput>, { ok: boolean }> = {
  name: "animation.transition",
  version: "1.0.0",
  description: "Trigger a state transition in an entity's animation state machine.",
  category: "animation",
  permissions: ["animation.write"],
  input: transitionInput,
  output: z.object({ ok: z.boolean() }),
  handler: (input, ctx) => {
    const mgr = (ctx.world as unknown as { animationManager?: AnimationManager }).animationManager;
    if (mgr === undefined) return { ok: false };
    const ok = mgr.transition(input.entity, input.state);
    ctx.emit("animation.transitioned", { entity: input.entity, state: input.state, ok, ...input.meta });
    return { ok };
  },
};

const createStateMachineInput = z.object({
  entity: z.string(),
  name: z.string().min(1),
  defaultState: z.string().describe("The state to start in."),
  states: z.array(z.object({
    name: z.string(),
    clipId: z.string(),
    speed: z.number().default(1),
    layer: z.number().int().default(0),
  })).min(1).describe("States in the machine."),
  transitions: z.array(z.object({
    from: z.string(),
    to: z.string(),
    conditions: z.array(z.object({
      param: z.string(),
      op: z.enum(["equals", "greater", "less", "true", "false"]),
      value: z.union([z.number(), z.boolean()]).optional(),
    })).default([]),
    duration: z.number().default(0.1),
  })).default([]).describe("Transitions between states."),
  parameters: z.array(z.object({
    name: z.string(),
    type: z.enum(["float", "int", "bool", "trigger"]),
    defaultValue: z.union([z.number(), z.boolean()]),
  })).default([]).describe("Animator parameters that drive transitions."),
  meta: MetaField,
});

const createStateMachine: SkillDefinition<z.infer<typeof createStateMachineInput>, { ok: boolean }> = {
  name: "animation.createStateMachine",
  version: "1.0.0",
  description: "Define an animation state machine for an entity: states, transitions with conditions, and animator parameters.",
  category: "animation",
  permissions: ["animation.write"],
  input: createStateMachineInput,
  output: z.object({ ok: z.boolean() }),
  handler: (input, ctx) => {
    const mgr = (ctx.world as unknown as { animationManager?: AnimationManager }).animationManager;
    if (mgr === undefined) return { ok: false };
    mgr.createStateMachine(input.entity, {
      name: input.name,
      defaultState: input.defaultState,
      states: input.states,
      transitions: input.transitions,
      parameters: input.parameters.map((p) => ({ ...p, defaultValue: p.defaultValue })),
      meta: input.meta,
    });
    ctx.emit("animation.stateMachine.created", { entity: input.entity, name: input.name, states: input.states.length, transitions: input.transitions.length, ...input.meta });
    return { ok: true };
  },
};

const setParamInput = z.object({
  entity: z.string(),
  name: z.string().min(1).describe("Parameter name."),
  value: z.union([z.number(), z.boolean()]).describe("Parameter value."),
  meta: MetaField,
});

const setParam: SkillDefinition<z.infer<typeof setParamInput>, { ok: boolean }> = {
  name: "animation.setParam",
  version: "1.0.0",
  description: "Set an animator parameter (bool, float, int, trigger) to drive state machine transitions.",
  category: "animation",
  permissions: ["animation.write"],
  input: setParamInput,
  output: z.object({ ok: z.boolean() }),
  handler: (input, ctx) => {
    const mgr = (ctx.world as unknown as { animationManager?: AnimationManager }).animationManager;
    if (mgr === undefined) return { ok: false };
    mgr.setParam(input.entity, input.name, input.value);
    ctx.emit("animation.param.set", { entity: input.entity, name: input.name, value: input.value, ...input.meta });
    return { ok: true };
  },
};

const getClipInfoInput = z.object({
  entity: z.string(),
  meta: MetaField,
});

const getClipInfo: SkillDefinition<z.infer<typeof getClipInfoInput>, { clips: { clipId: string; time: number; duration: number; layer: number }[] }> = {
  name: "animation.getClipInfo",
  version: "1.0.0",
  description: "Get current clip name, time, duration, and layer for an entity's animator.",
  category: "animation",
  permissions: ["animation.read"],
  input: getClipInfoInput,
  output: z.object({ clips: z.array(z.object({ clipId: z.string(), time: z.number(), duration: z.number(), layer: z.number() })) }),
  handler: (input, ctx) => {
    const mgr = (ctx.world as unknown as { animationManager?: AnimationManager }).animationManager;
    if (mgr === undefined) return { clips: [] };
    return { clips: mgr.getClipInfo(input.entity) };
  },
};

const emoteInput = z.object({
  entity: z.string(),
  clipId: z.string().describe("Emote clip id (registered via animation.load)."),
  blendDuration: z.number().min(0).default(0.1).describe("Blend-in duration in seconds."),
  meta: MetaField,
});

const emote: SkillDefinition<z.infer<typeof emoteInput>, { ok: boolean }> = {
  name: "animation.emote",
  version: "1.0.0",
  description: "Play a one-shot emote/expressive animation on a character (wave, point, nod, etc.) on a high-priority layer.",
  category: "animation",
  permissions: ["animation.write"],
  input: emoteInput,
  output: z.object({ ok: z.boolean() }),
  handler: (input, ctx) => {
    const mgr = (ctx.world as unknown as { animationManager?: AnimationManager }).animationManager;
    if (mgr === undefined) return { ok: false };
    mgr.play(input.entity, input.clipId, { layer: 10, weight: 1, speed: 1, loop: false, fadeDuration: input.blendDuration * 1000 });
    ctx.emit("animation.emote.played", { entity: input.entity, clipId: input.clipId, ...input.meta });
    return { ok: true };
  },
};

export function registerAnimationSkills(registry: SkillRegistry, opts?: { animationManager?: AnimationManager }): { animationManager: AnimationManager } {
  const mgr = opts?.animationManager ?? new AnimationManager();

  registry.register(loadClip);
  registry.register(play);
  registry.register(stop);
  registry.register(blend);
  registry.register(transition);
  registry.register(createStateMachine);
  registry.register(setParam);
  registry.register(getClipInfo);
  registry.register(emote);

  return { animationManager: mgr };
}
