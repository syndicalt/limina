// animation.* skills — skeletal animation, blend trees, and state machines, driven by
// three's REAL AnimationMixer (CPU keyframe sampling — runs headless, no GPU).
//
// CLOSURE WIRING (mirrors combat.ts / terrain.ts): the SkillDefinitions are built INSIDE
// registerAnimationSkills, closing over the local AnimationManager. There is NO
// `ctx.world.animationManager` — the old module-level skills read that (never set) and
// no-op'd, and the old manager was a metadata store that never advanced time. The manager
// is returned so the core wiring exposes it (core.animation.animationManager).
//
// REAL, NOT FAKE: every entity gets a THREE.AnimationMixer over its glTF Object3D. play()
// creates a real AnimationAction from a named clip (loop/weight/speed); blend() cross-weights
// actions; the state machine swaps the active clip via real crossfades; getClipInfo() reads
// the action's actual time/duration/weight. The host loop calls manager.update(dt), which
// pumps mixer.update(dt) for every entity — that is what advances time and samples bones.
//
// DETERMINISM: animation is RENDER-ONLY (bone transforms; never sim/log state), so a
// per-frame update(dt) pump is allowed. It is dt-DRIVEN ONLY — NO Date.now / new Date /
// Math.random / performance.now anywhere — so an identical dt sequence samples identical
// values, bit-for-bit.
//
// CLIP RESOLUTION: a clip id resolves first to a manager-REGISTERED clip (animation.load,
// or a programmatic THREE.AnimationClip via registerClip), else to the entity glTF object's
// own `.animations` (the standard three rigged-glTF path). NOTE: parseGltfScene in three.ts
// (not owned by this file) currently drops gltf.animations; the manager already reads
// root.animations, so attaching them there lights up rigged clips with no change here.

import * as THREE from "../../build/three.bundle.mjs";
import { z } from "../../build/zod.bundle.mjs";
import type { SceneObject } from "../engine.ts";
import type { SkillDefinition, SkillRegistry } from "./registry.ts";

const MetaField = z.record(z.string(), z.unknown()).optional().describe("Agent-supplied extension metadata.");

/** A condition on an animator parameter that gates a state-machine transition. */
export interface TransitionCondition {
  param: string;
  op: "equals" | "greater" | "less" | "true" | "false";
  value?: number | boolean;
}

/** One state of an animation state machine — a named clip with playback options. */
export interface AnimationStateDef {
  name: string;
  clipId: string;
  speed?: number;
  layer?: number;
}

/** A transition between states, taken when every condition holds (evaluated on update). */
export interface TransitionDef {
  from: string; // "*" / "any" matches any current state
  to: string;
  conditions: TransitionCondition[];
  duration?: number;
}

/** An agent-authored state machine: states, conditional transitions, and parameters. */
export interface StateMachineDef {
  name: string;
  defaultState: string;
  states: AnimationStateDef[];
  transitions: TransitionDef[];
  parameters: { name: string; type: "float" | "int" | "bool" | "trigger"; defaultValue: number | boolean }[];
  meta?: Record<string, unknown>;
}

/** Options for starting/updating a single clip action. fadeIn is in SECONDS. */
export interface PlayOptions {
  layer?: number;
  weight?: number;
  speed?: number;
  loop?: boolean;
  fadeIn?: number;
  reset?: boolean;
}

/** Per-entity mixer state: the real THREE.AnimationMixer, its root Object3D, and the
 *  AnimationActions created on it (keyed by clip id), with the layer each was played on. */
interface MixerEntry {
  mixer: THREE.AnimationMixer;
  root: THREE.Object3D;
  actions: Map<string, THREE.AnimationAction>;
  layers: Map<string, number>;
}

/** Per-entity state-machine instance (driven on update). */
interface MachineEntry {
  def: StateMachineDef;
  current: string;
  root: THREE.Object3D;
}

/** A live clip readout from a running AnimationAction (real time/duration/weight). */
export interface ClipInfo {
  clipId: string;
  time: number;
  duration: number;
  weight: number;
  layer: number;
}

/** Read a finite number from agent config, else a default. */
function num(v: unknown, d: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : d;
}

export class AnimationManager {
  /** Registered clips (animation.load / programmatic), resolvable by id across entities. */
  private readonly clips = new Map<string, THREE.AnimationClip>();
  private readonly mixers = new Map<string, MixerEntry>();
  private readonly machines = new Map<string, MachineEntry>();
  /** Animator parameters per entity (drive state-machine transitions). */
  private readonly params = new Map<string, Map<string, number | boolean>>();

  /** Register a REAL THREE.AnimationClip under an id (shared by all entities). */
  registerClip(id: string, clip: THREE.AnimationClip): void {
    this.clips.set(id, clip);
  }

  /** Register a track-less clip of a given duration (animation.load with only metadata).
   *  A valid clip the mixer will RUN (time advances) but that samples nothing — real clips
   *  carry tracks (from a glTF or registerClip). */
  loadClip(id: string, name: string, duration: number): void {
    this.clips.set(id, new THREE.AnimationClip(name, duration, []));
  }

  hasClip(id: string): boolean {
    return this.clips.has(id);
  }

  listClips(): { id: string; name: string; duration: number }[] {
    return [...this.clips.entries()].map(([id, c]) => ({ id, name: c.name, duration: c.duration }));
  }

  /** Resolve a clip id to a real THREE.AnimationClip: a registered clip first, else the
   *  entity glTF object's own `.animations` (standard rigged-glTF path). */
  private resolveClip(entry: MixerEntry, clipId: string): THREE.AnimationClip | undefined {
    const reg = this.clips.get(clipId);
    if (reg !== undefined) return reg;
    const own = (entry.root as unknown as { animations?: THREE.AnimationClip[] }).animations;
    return own?.find((c) => c.name === clipId);
  }

  /** Get (or create) the entity's mixer. A NEW root rebuilds the mixer (the entity's glTF
   *  was replaced). Throws cleanly when no root has ever been supplied — never fakes one. */
  private mixerFor(entity: string, root?: THREE.Object3D): MixerEntry {
    let e = this.mixers.get(entity);
    if (e !== undefined && root !== undefined && e.root !== root) {
      e.mixer.stopAllAction();
      e = undefined;
    }
    if (e === undefined) {
      if (root === undefined) throw new Error(`animation: entity '${entity}' has no glTF object (load one first)`);
      e = { mixer: new THREE.AnimationMixer(root), root, actions: new Map(), layers: new Map() };
      this.mixers.set(entity, e);
    }
    return e;
  }

  /** Get-or-create the AnimationAction for a clip on an entity's mixer. */
  private actionFor(entry: MixerEntry, clipId: string): THREE.AnimationAction | undefined {
    let action = entry.actions.get(clipId);
    if (action !== undefined) return action;
    const clip = this.resolveClip(entry, clipId);
    if (clip === undefined) return undefined;
    action = entry.mixer.clipAction(clip);
    entry.actions.set(clipId, action);
    return action;
  }

  /** Play a clip on an entity. `root` (the entity's glTF Object3D) is required on the first
   *  call for the entity; later calls reuse the mixer. Returns the live action. Throws
   *  cleanly when the clip cannot be resolved. */
  play(entity: string, clipId: string, opts: PlayOptions, root?: THREE.Object3D): THREE.AnimationAction {
    const entry = this.mixerFor(entity, root);
    const action = this.actionFor(entry, clipId);
    if (action === undefined) throw new Error(`animation.play: unknown clip '${clipId}' for entity '${entity}'`);
    const loop = opts.loop ?? true;
    action.enabled = true;
    action.setLoop(loop ? THREE.LoopRepeat : THREE.LoopOnce, loop ? Infinity : 1);
    action.clampWhenFinished = !loop;
    action.timeScale = opts.speed ?? 1;
    if (opts.reset === true) action.reset();
    action.setEffectiveWeight(opts.weight ?? 1);
    entry.layers.set(clipId, opts.layer ?? 0);
    if ((opts.fadeIn ?? 0) > 0) action.fadeIn(opts.fadeIn!);
    action.play();
    return action;
  }

  /** Stop actions on an entity (all, or one layer) — fade out over `fadeOut` SECONDS, or
   *  stop immediately. No-op for an unknown entity. */
  stop(entity: string, layer?: number, fadeOut = 0): void {
    const entry = this.mixers.get(entity);
    if (entry === undefined) return;
    for (const [clipId, action] of entry.actions) {
      if (layer !== undefined && entry.layers.get(clipId) !== layer) continue;
      if (fadeOut > 0) action.fadeOut(fadeOut);
      else action.stop();
    }
  }

  /** Blend a set of clips with NORMALIZED weights (locomotion idle/walk/run). */
  blend(entity: string, clips: { clipId: string; weight: number; speed?: number; layer?: number }[], root?: THREE.Object3D): void {
    const total = clips.reduce((s, c) => s + Math.max(0, c.weight), 0);
    const denom = total > 0 ? total : 1;
    for (const c of clips) {
      this.play(entity, c.clipId, { loop: true, speed: c.speed ?? 1, weight: Math.max(0, c.weight) / denom, layer: c.layer ?? 0 }, root);
    }
  }

  /** One-shot expressive clip on a high-priority layer (wave, nod, ...). */
  emote(entity: string, clipId: string, fadeIn: number, root?: THREE.Object3D): THREE.AnimationAction {
    return this.play(entity, clipId, { loop: false, weight: 1, speed: 1, layer: 10, fadeIn, reset: true }, root);
  }

  /** Define + start a state machine on an entity. Plays the default state's clip. */
  createStateMachine(entity: string, def: StateMachineDef, root?: THREE.Object3D): void {
    const entry = this.mixerFor(entity, root);
    const params = new Map<string, number | boolean>();
    for (const p of def.parameters) params.set(p.name, p.defaultValue);
    this.params.set(entity, params);
    this.machines.set(entity, { def, current: def.defaultState, root: entry.root });
    const start = def.states.find((s) => s.name === def.defaultState);
    if (start !== undefined) {
      this.play(entity, start.clipId, { loop: true, speed: start.speed ?? 1, weight: 1, layer: start.layer ?? 0, reset: true }, entry.root);
    }
  }

  /** Set an animator parameter (drives state-machine transitions on update). */
  setParam(entity: string, name: string, value: number | boolean): void {
    let p = this.params.get(entity);
    if (p === undefined) {
      p = new Map();
      this.params.set(entity, p);
    }
    p.set(name, value);
  }

  /** The entity's current state-machine state (or undefined when none). */
  getState(entity: string): string | undefined {
    return this.machines.get(entity)?.current;
  }

  /** Force a transition to a named state, crossfading from the current clip. Returns false
   *  for an unknown entity/state. */
  transition(entity: string, targetState: string): boolean {
    const m = this.machines.get(entity);
    if (m === undefined) return false;
    const target = m.def.states.find((s) => s.name === targetState);
    if (target === undefined) return false;
    return this.switchState(entity, m, targetState, this.transitionDuration(m, m.current, targetState));
  }

  /** The authored duration for from->to (default 0.1s) — used for crossfades. */
  private transitionDuration(m: MachineEntry, from: string, to: string): number {
    const t = m.def.transitions.find((tr) => (tr.from === from || tr.from === "*" || tr.from === "any") && tr.to === to);
    return t?.duration ?? 0.1;
  }

  /** Crossfade the machine's active clip to `toName`'s clip. */
  private switchState(entity: string, m: MachineEntry, toName: string, duration: number): boolean {
    const target = m.def.states.find((s) => s.name === toName);
    if (target === undefined) return false;
    const entry = this.mixers.get(entity);
    if (entry === undefined) return false;
    const fromState = m.def.states.find((s) => s.name === m.current);
    const fromAction = fromState !== undefined ? entry.actions.get(fromState.clipId) : undefined;
    const toAction = this.actionFor(entry, target.clipId);
    if (toAction === undefined) return false;
    toAction.enabled = true;
    toAction.setLoop(THREE.LoopRepeat, Infinity);
    toAction.timeScale = target.speed ?? 1;
    entry.layers.set(target.clipId, target.layer ?? 0);
    toAction.reset();
    toAction.play();
    if (fromAction !== undefined && fromAction !== toAction && duration > 0) {
      toAction.crossFadeFrom(fromAction, duration, true);
    } else {
      toAction.setEffectiveWeight(1);
      if (fromAction !== undefined && fromAction !== toAction) fromAction.stop();
    }
    m.current = toName;
    return true;
  }

  /** Whether a transition's conditions all hold against the entity's params. */
  private conditionsMet(conds: TransitionCondition[], params: Map<string, number | boolean> | undefined): boolean {
    for (const c of conds) {
      const v = params?.get(c.param);
      switch (c.op) {
        case "true": if (v !== true) return false; break;
        case "false": if (v === true) return false; break;
        case "equals": if (v !== c.value) return false; break;
        case "greater": if (!(typeof v === "number" && v > num(c.value, 0))) return false; break;
        case "less": if (!(typeof v === "number" && v < num(c.value, 0))) return false; break;
      }
    }
    return true;
  }

  /** Advance every entity by `dt` SECONDS: evaluate state-machine transitions against the
   *  current params (taking the FIRST matching transition out of the current state), then
   *  pump every mixer — the real keyframe sampling step. Fully dt-driven (deterministic). */
  update(dt: number): void {
    for (const [entity, m] of this.machines) {
      const params = this.params.get(entity);
      for (const t of m.def.transitions) {
        if (t.from !== m.current && t.from !== "*" && t.from !== "any") continue;
        if (t.to === m.current) continue;
        if (this.conditionsMet(t.conditions, params)) {
          this.switchState(entity, m, t.to, t.duration ?? 0.1);
          break;
        }
      }
    }
    for (const entry of this.mixers.values()) entry.mixer.update(dt);
  }

  /** Live readouts for an entity's RUNNING actions (real time/duration/weight). */
  getClipInfo(entity: string): ClipInfo[] {
    const entry = this.mixers.get(entity);
    if (entry === undefined) return [];
    const out: ClipInfo[] = [];
    for (const [clipId, action] of entry.actions) {
      const weight = action.getEffectiveWeight();
      if (!action.isRunning() && weight === 0) continue;
      out.push({ clipId, time: action.time, duration: action.getClip().duration, weight, layer: entry.layers.get(clipId) ?? 0 });
    }
    return out;
  }
}

// ---- Skills (built INSIDE registerAnimationSkills, closing over the manager) ----

const loadClipInput = z.object({
  id: z.string().min(1).describe("Unique clip identifier."),
  name: z.string().min(1).describe("Human-readable clip name."),
  duration: z.number().positive().describe("Clip duration in seconds."),
  loop: z.boolean().default(false),
  frameRate: z.number().positive().default(30),
  assetId: z.string().optional().describe("Source asset id (GLTF animation, etc.) for content-addressed loading."),
  meta: MetaField,
});

const playInput = z.object({
  entity: z.string(),
  clipId: z.string().describe("Clip id to play (registered via animation.load or carried by the entity's glTF)."),
  layer: z.number().int().default(0).describe("Animation layer (tracked for stop/getClipInfo)."),
  weight: z.number().min(0).max(1).default(1).describe("Blend weight."),
  speed: z.number().default(1).describe("Playback speed multiplier (action timeScale)."),
  loop: z.boolean().default(true).describe("Whether to loop the animation."),
  fadeDuration: z.number().min(0).default(0).describe("Fade-in duration in ms."),
  meta: MetaField,
});

const stopInput = z.object({
  entity: z.string(),
  layer: z.number().int().optional().describe("Stop only this layer. If omitted, stop all."),
  fadeOutMs: z.number().min(0).default(0).describe("Fade-out duration in ms."),
  meta: MetaField,
});

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

const transitionInput = z.object({
  entity: z.string(),
  state: z.string().describe("Target state name in the entity's animation state machine."),
  meta: MetaField,
});

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
  })).default([]).describe("Transitions between states (evaluated on update)."),
  parameters: z.array(z.object({
    name: z.string(),
    type: z.enum(["float", "int", "bool", "trigger"]),
    defaultValue: z.union([z.number(), z.boolean()]),
  })).default([]).describe("Animator parameters that drive transitions."),
  meta: MetaField,
});

const setParamInput = z.object({
  entity: z.string(),
  name: z.string().min(1).describe("Parameter name."),
  value: z.union([z.number(), z.boolean()]).describe("Parameter value."),
  meta: MetaField,
});

const getClipInfoInput = z.object({
  entity: z.string(),
  meta: MetaField,
});

const emoteInput = z.object({
  entity: z.string(),
  clipId: z.string().describe("Emote clip id (registered via animation.load or carried by the glTF)."),
  blendDuration: z.number().min(0).default(0.1).describe("Blend-in (fade) duration in seconds."),
  meta: MetaField,
});

const clipInfoSchema = z.object({
  clipId: z.string(),
  time: z.number(),
  duration: z.number(),
  weight: z.number(),
  layer: z.number(),
});

/**
 * Register the animation.* skills bound to an AnimationManager. The skill handlers CLOSE
 * OVER the manager (no ctx.world.animationManager). The manager drives three's real
 * AnimationMixer per entity; the host loop calls manager.update(dt) each frame. Returns the
 * manager so the core wiring can expose it (core.animation.animationManager).
 */
export function registerAnimationSkills(registry: SkillRegistry, opts?: { animationManager?: AnimationManager }): { animationManager: AnimationManager } {
  const mgr = opts?.animationManager ?? new AnimationManager();

  /** The entity's glTF Object3D (mixer root), or undefined when it has no renderable. */
  function rootOf(ctx: { world: { entities: { resolve(id: string): { mesh?: SceneObject } | undefined } } }, entity: string): THREE.Object3D | undefined {
    const mesh = ctx.world.entities.resolve(entity)?.mesh;
    return mesh as unknown as THREE.Object3D | undefined;
  }

  const loadClip: SkillDefinition<z.infer<typeof loadClipInput>, { ok: boolean; clipId: string }> = {
    name: "animation.load",
    version: "1.0.0",
    description: "Register an animation clip for use. With only metadata it registers a track-less clip the mixer will run; rigged clips come from the entity's glTF (resolved by name at play time) or a programmatic THREE.AnimationClip.",
    category: "animation",
    permissions: ["animation.read"],
    input: loadClipInput,
    output: z.object({ ok: z.boolean(), clipId: z.string() }),
    handler: (input, ctx) => {
      mgr.loadClip(input.id, input.name, input.duration);
      ctx.emit("animation.loaded", { clipId: input.id, name: input.name, duration: input.duration, assetId: input.assetId, ...input.meta });
      return { ok: true, clipId: input.id };
    },
  };

  const play: SkillDefinition<z.infer<typeof playInput>, { ok: boolean }> = {
    name: "animation.play",
    version: "1.0.0",
    description: "Play an animation clip on an entity's mixer with layer, weight, speed, and loop. Fails cleanly (ok:false) when the entity has no glTF object.",
    category: "animation",
    permissions: ["animation.write"],
    input: playInput,
    output: z.object({ ok: z.boolean() }),
    handler: (input, ctx) => {
      const root = rootOf(ctx, input.entity);
      if (root === undefined) return { ok: false };
      mgr.play(input.entity, input.clipId, { layer: input.layer, weight: input.weight, speed: input.speed, loop: input.loop, fadeIn: input.fadeDuration / 1000 }, root);
      ctx.emit("animation.played", { entity: input.entity, clipId: input.clipId, layer: input.layer, speed: input.speed, ...input.meta });
      return { ok: true };
    },
  };

  const stop: SkillDefinition<z.infer<typeof stopInput>, { ok: boolean }> = {
    name: "animation.stop",
    version: "1.0.0",
    description: "Stop an animation on an entity (all layers or a specific layer) with optional fade-out.",
    category: "animation",
    permissions: ["animation.write"],
    input: stopInput,
    output: z.object({ ok: z.boolean() }),
    handler: (input, ctx) => {
      mgr.stop(input.entity, input.layer, input.fadeOutMs / 1000);
      ctx.emit("animation.stopped", { entity: input.entity, layer: input.layer, ...input.meta });
      return { ok: true };
    },
  };

  const blend: SkillDefinition<z.infer<typeof blendInput>, { ok: boolean }> = {
    name: "animation.blend",
    version: "1.0.0",
    description: "Blend two or more clips with weights (for locomotion: idle/walk/run). Weights are normalized across the set.",
    category: "animation",
    permissions: ["animation.write"],
    input: blendInput,
    output: z.object({ ok: z.boolean() }),
    handler: (input, ctx) => {
      const root = rootOf(ctx, input.entity);
      if (root === undefined) return { ok: false };
      mgr.blend(input.entity, input.clips, root);
      ctx.emit("animation.blended", { entity: input.entity, clips: input.clips.map((c) => c.clipId), ...input.meta });
      return { ok: true };
    },
  };

  const transition: SkillDefinition<z.infer<typeof transitionInput>, { ok: boolean }> = {
    name: "animation.transition",
    version: "1.0.0",
    description: "Force a state transition in an entity's animation state machine (crossfades to the target state's clip).",
    category: "animation",
    permissions: ["animation.write"],
    input: transitionInput,
    output: z.object({ ok: z.boolean() }),
    handler: (input, ctx) => {
      const ok = mgr.transition(input.entity, input.state);
      ctx.emit("animation.transitioned", { entity: input.entity, state: input.state, ok, ...input.meta });
      return { ok };
    },
  };

  const createStateMachine: SkillDefinition<z.infer<typeof createStateMachineInput>, { ok: boolean }> = {
    name: "animation.createStateMachine",
    version: "1.0.0",
    description: "Define an animation state machine for an entity: states (clips), conditional transitions, and animator parameters. Starts in the default state.",
    category: "animation",
    permissions: ["animation.write"],
    input: createStateMachineInput,
    output: z.object({ ok: z.boolean() }),
    handler: (input, ctx) => {
      const root = rootOf(ctx, input.entity);
      if (root === undefined) return { ok: false };
      mgr.createStateMachine(input.entity, {
        name: input.name,
        defaultState: input.defaultState,
        states: input.states,
        transitions: input.transitions,
        parameters: input.parameters,
        meta: input.meta,
      }, root);
      ctx.emit("animation.stateMachine.created", { entity: input.entity, name: input.name, states: input.states.length, transitions: input.transitions.length, ...input.meta });
      return { ok: true };
    },
  };

  const setParam: SkillDefinition<z.infer<typeof setParamInput>, { ok: boolean }> = {
    name: "animation.setParam",
    version: "1.0.0",
    description: "Set an animator parameter (bool, float, int, trigger) to drive state-machine transitions (evaluated on update).",
    category: "animation",
    permissions: ["animation.write"],
    input: setParamInput,
    output: z.object({ ok: z.boolean() }),
    handler: (input, ctx) => {
      mgr.setParam(input.entity, input.name, input.value);
      ctx.emit("animation.param.set", { entity: input.entity, name: input.name, value: input.value, ...input.meta });
      return { ok: true };
    },
  };

  const getClipInfo: SkillDefinition<z.infer<typeof getClipInfoInput>, { clips: ClipInfo[] }> = {
    name: "animation.getClipInfo",
    version: "1.0.0",
    description: "Get the current clip id, time, duration, weight, and layer for an entity's running actions (read from the live AnimationActions).",
    category: "animation",
    permissions: ["animation.read"],
    input: getClipInfoInput,
    output: z.object({ clips: z.array(clipInfoSchema) }),
    handler: (input) => {
      return { clips: mgr.getClipInfo(input.entity) };
    },
  };

  const emote: SkillDefinition<z.infer<typeof emoteInput>, { ok: boolean }> = {
    name: "animation.emote",
    version: "1.0.0",
    description: "Play a one-shot emote/expressive animation (wave, point, nod) on a high-priority layer. Fails cleanly (ok:false) when the entity has no glTF object.",
    category: "animation",
    permissions: ["animation.write"],
    input: emoteInput,
    output: z.object({ ok: z.boolean() }),
    handler: (input, ctx) => {
      const root = rootOf(ctx, input.entity);
      if (root === undefined) return { ok: false };
      mgr.emote(input.entity, input.clipId, input.blendDuration, root);
      ctx.emit("animation.emote.played", { entity: input.entity, clipId: input.clipId, ...input.meta });
      return { ok: true };
    },
  };

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
