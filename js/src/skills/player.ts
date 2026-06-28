// player.* skills — character controller, movement, and input bindings.
// Every input accepts optional `meta` for agent-supplied extension data.

import { z } from "../../build/zod.bundle.mjs";
import type { SkillDefinition, SkillRegistry, ExecutionContext, WorldContext } from "./registry.ts";

const Vec3 = z.tuple([z.number(), z.number(), z.number()]);
const MetaField = z.record(z.string(), z.unknown()).optional().describe("Agent-supplied extension metadata.");

// ---- Character controller state (per-entity, stored in WorldContext) ----

export interface CharacterControllerState {
  grounded: boolean;
  speed: number;
  sprintMultiplier: number;
  isSprinting: boolean;
  isCrouching: boolean;
  jumpVelocity: number;
  crouchHeight: number;
  normalHeight: number;
}

export interface CharacterControllerRegistry {
  has(entity: string): boolean;
  create(entity: string, spec: { speed?: number; jumpVelocity?: number; crouchHeight?: number; normalHeight?: number }): CharacterControllerState;
  get(entity: string): CharacterControllerState | undefined;
  remove(entity: string): boolean;
  step(world: WorldContext, dtMs: number): void;
}

/** Default character controller: uses op_physics_move_character for kinematic
 *  capsule movement with grounded detection, slope sliding, and step climbing. */
export class DefaultCharacterController implements CharacterControllerRegistry {
  private readonly controllers = new Map<string, CharacterControllerState & { bodyId: number; eid: number }>();

  has(entity: string): boolean {
    return this.controllers.has(entity);
  }

  create(entity: string, spec: { speed?: number; jumpVelocity?: number; crouchHeight?: number; normalHeight?: number }): CharacterControllerState {
    const entry = {
      grounded: false,
      speed: spec.speed ?? 5.0,
      sprintMultiplier: 1.6,
      isSprinting: false,
      isCrouching: false,
      jumpVelocity: spec.jumpVelocity ?? 8.0,
      crouchHeight: spec.crouchHeight ?? 0.9,
      normalHeight: spec.normalHeight ?? 1.75,
    };
    return entry;
  }

  get(entity: string): CharacterControllerState | undefined {
    return this.controllers.get(entity);
  }

  remove(entity: string): boolean {
    return this.controllers.delete(entity);
  }

  step(_world: WorldContext, _dtMs: number): void {
    // Character controller stepping is handled per-skill-call (player.move etc.)
    // rather than as a blanket system, since movement is input-driven.
  }
}

// ---- Input binding system ----

export interface InputBinding {
  name: string;
  sources: string[]; // e.g. ["key:w", "key:arrowup", "gamepad:dpad:up"]
  type: "action" | "axis";
}

export class InputRegistry {
  private readonly bindings = new Map<string, InputBinding>();
  private readonly states = new Map<string, boolean | number>();

  register(binding: InputBinding): void {
    this.bindings.set(binding.name, binding);
    this.states.set(binding.name, binding.type === "axis" ? 0 : false);
  }

  unregister(name: string): boolean {
    this.bindings.delete(name);
    return this.states.delete(name);
  }

  getState(name: string): boolean | number | undefined {
    return this.states.get(name);
  }

  setState(name: string, value: boolean | number): void {
    this.states.set(name, value);
  }

  list(): InputBinding[] {
    return [...this.bindings.values()];
  }

  /** Poll discrete buttons (jump/run) and axes (move/look) from the native
   *  input ops and update registered binding states. */
  poll(ops: { op_input_axes?: (out: Float32Array) => void; op_input_buttons?: (out: Float32Array) => void }): void {
    if (ops.op_input_axes) {
      const axes = new Float32Array(4);
      ops.op_input_axes(axes);
      this.setState("moveX", axes[0]);
      this.setState("moveY", axes[1]);
      this.setState("lookX", axes[2]);
      this.setState("lookY", axes[3]);
    }
    if (ops.op_input_buttons) {
      const buttons = new Float32Array(2);
      ops.op_input_buttons(buttons);
      this.setState("jump", buttons[0] > 0.5);
      this.setState("run", buttons[1] > 0.5);
    }
  }
}

// ---- Skills ----

const bindInput = z.object({
  name: z.string().min(1).describe("Binding name (e.g. 'moveForward', 'jump', 'interact')."),
  sources: z.array(z.string().min(1)).describe("Input sources (e.g. 'key:w', 'key:space', 'gamepad:a', 'mouse:left')."),
  type: z.enum(["action", "axis"]).default("action").describe("Whether this binding is discrete (action) or continuous (axis)."),
  meta: MetaField,
});

const actionInput: SkillDefinition<z.infer<typeof bindInput>, { ok: boolean }> = {
  name: "input.bind",
  version: "1.0.0",
  description: "Bind an action or axis name to input sources (keyboard keys, mouse buttons, gamepad axes). Returns success. Use `input.action` / `input.axis` to query state.",
  category: "player",
  permissions: ["player.configure"],
  input: bindInput,
  output: z.object({ ok: z.boolean() }),
  handler: (input, ctx) => {
    const registry = (ctx.world as unknown as { input?: InputRegistry }).input;
    if (registry === undefined) return { ok: false };
    registry.register({ name: input.name, sources: input.sources, type: input.type });
    ctx.emit("input.bound", { name: input.name, sources: input.sources, type: input.type, ...input.meta });
    return { ok: true };
  },
};

const queryActionInput = z.object({
  name: z.string().min(1),
  meta: MetaField,
});

const queryAction: SkillDefinition<z.infer<typeof queryActionInput>, { active: boolean; meta?: Record<string, unknown> }> = {
  name: "input.action",
  version: "1.0.0",
  description: "Query whether a bound action is currently active (pressed/held). Poll input state via the native input ops first.",
  category: "player",
  permissions: ["player.read"],
  input: queryActionInput,
  output: z.object({ active: z.boolean(), meta: z.unknown().optional() }),
  handler: (input, ctx) => {
    const registry = (ctx.world as unknown as { input?: InputRegistry }).input;
    if (registry === undefined) return { active: false };
    const state = registry.getState(input.name);
    return { active: state === true };
  },
};

const queryAxisInput = z.object({
  name: z.string().min(1),
  meta: MetaField,
});

const queryAxis: SkillDefinition<z.infer<typeof queryAxisInput>, { value: number; meta?: Record<string, unknown> }> = {
  name: "input.axis",
  version: "1.0.0",
  description: "Query a continuous axis value (e.g. moveX, moveY, lookX, lookY). Range is typically -1 to 1.",
  category: "player",
  permissions: ["player.read"],
  input: queryAxisInput,
  output: z.object({ value: z.number(), meta: z.unknown().optional() }),
  handler: (input, ctx) => {
    const registry = (ctx.world as unknown as { input?: InputRegistry }).input;
    if (registry === undefined) return { value: 0 };
    const state = registry.getState(input.name);
    return { value: typeof state === "number" ? state : 0 };
  },
};

const movePlayerInput = z.object({
  entity: z.string().describe("Player entity to move."),
  delta: Vec3.describe("Movement delta vector (world-space or input-derived)."),
  grounded: z.boolean().default(true).describe("Whether the character is grounded (false = in-air, no vertical movement from delta)."),
  meta: MetaField,
});

const movePlayer: SkillDefinition<z.infer<typeof movePlayerInput>, { moved: boolean; grounded: boolean; newPosition: [number, number, number] }> = {
  name: "player.move",
  version: "1.0.0",
  description: "Move a player entity via the character controller, respecting collisions, slopes, and grounded state. Uses the native kinematic character controller op.",
  category: "player",
  permissions: ["player.write"],
  input: movePlayerInput,
  output: z.object({ moved: z.boolean(), grounded: z.boolean(), newPosition: Vec3 }),
  handler: (input, ctx) => {
    const entry = ctx.world.entities.resolve(input.entity);
    if (entry === undefined || entry.bodyId === undefined) {
      return { moved: false, grounded: false, newPosition: [0, 0, 0] };
    }
    const out = new Float32Array(4);
    ctx.world.ops.op_physics_move_character(
      entry.bodyId,
      input.delta[0],
      input.delta[1],
      input.delta[2],
      out,
    );
    const grounded = out[3] === 1;
    const newPos: [number, number, number] = [out[0], out[1], out[2]];
    ctx.emit("player.moved", { entity: input.entity, delta: input.delta, newPosition: newPos, grounded, ...input.meta });
    return { moved: true, grounded, newPosition: newPos };
  },
};

const jumpPlayerInput = z.object({
  entity: z.string(),
  meta: MetaField,
});

const jumpPlayer: SkillDefinition<z.infer<typeof jumpPlayerInput>, { jumped: boolean }> = {
  name: "player.jump",
  version: "1.0.0",
  description: "Trigger a jump on the player's character controller. Only works when grounded. Applies an upward impulse to the character body.",
  category: "player",
  permissions: ["player.write"],
  input: jumpPlayerInput,
  output: z.object({ jumped: z.boolean() }),
  handler: (input, ctx) => {
    const entry = ctx.world.entities.resolve(input.entity);
    if (entry === undefined || entry.bodyId === undefined) return { jumped: false };
    const registry = (ctx.world as unknown as { controllers?: CharacterControllerRegistry }).controllers;
    const state = registry?.get(input.entity);
    const velocity = state?.jumpVelocity ?? 8.0;
    ctx.world.ops.op_physics_apply_impulse(entry.bodyId, 0, velocity, 0);
    ctx.emit("player.jumped", { entity: input.entity, velocity, ...input.meta });
    return { jumped: true };
  },
};

const sprintPlayerInput = z.object({
  entity: z.string(),
  sprinting: z.boolean().default(true).describe("Toggle sprint on/off."),
  meta: MetaField,
});

const sprintPlayer: SkillDefinition<z.infer<typeof sprintPlayerInput>, { sprinting: boolean }> = {
  name: "player.sprint",
  version: "1.0.0",
  description: "Toggle sprint mode for a player entity. Multiplies movement speed by the character controller's sprint multiplier.",
  category: "player",
  permissions: ["player.write"],
  input: sprintPlayerInput,
  output: z.object({ sprinting: z.boolean() }),
  handler: (input, ctx) => {
    const registry = (ctx.world as unknown as { controllers?: CharacterControllerRegistry }).controllers;
    const state = registry?.get(input.entity);
    if (state === undefined) return { sprinting: false };
    (state as unknown as { isSprinting: boolean }).isSprinting = input.sprinting;
    ctx.emit("player.sprint.toggled", { entity: input.entity, sprinting: input.sprinting, ...input.meta });
    return { sprinting: input.sprinting };
  },
};

const crouchPlayerInput = z.object({
  entity: z.string(),
  crouching: z.boolean().default(true).describe("Toggle crouch on/off."),
  meta: MetaField,
});

const crouchPlayer: SkillDefinition<z.infer<typeof crouchPlayerInput>, { crouching: boolean }> = {
  name: "player.crouch",
  version: "1.0.0",
  description: "Toggle crouch mode for a player entity. Reduces character controller height and slows movement.",
  category: "player",
  permissions: ["player.write"],
  input: crouchPlayerInput,
  output: z.object({ crouching: z.boolean() }),
  handler: (input, ctx) => {
    const registry = (ctx.world as unknown as { controllers?: CharacterControllerRegistry }).controllers;
    const state = registry?.get(input.entity);
    if (state === undefined) return { crouching: false };
    (state as unknown as { isCrouching: boolean }).isCrouching = input.crouching;
    ctx.emit("player.crouch.toggled", { entity: input.entity, crouching: input.crouching, ...input.meta });
    return { crouching: input.crouching };
  },
};

export function registerPlayerSkills(
  registry: SkillRegistry,
  opts?: {
    inputRegistry?: InputRegistry;
    characterControllers?: CharacterControllerRegistry;
  },
): { input: InputRegistry; controllers: CharacterControllerRegistry } {
  const input = opts?.inputRegistry ?? new InputRegistry();
  const controllers = opts?.characterControllers ?? new DefaultCharacterController();

  registry.register(actionInput);
  registry.register(queryAction);
  registry.register(queryAxis);
  registry.register(movePlayer);
  registry.register(jumpPlayer);
  registry.register(sprintPlayer);
  registry.register(crouchPlayer);

  return { input, controllers };
}
