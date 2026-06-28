// player.* + input.* skills — input bindings and an input-driven CHARACTER
// CONTROLLER. Every input accepts optional `meta` for agent-supplied extension data.
//
// CLOSURE WIRING (mirrors terrain.ts / combat.ts): the SkillDefinitions are built
// INSIDE registerPlayerSkills, closing over the local InputRegistry +
// CharacterControllerRegistry. There is NO `ctx.world.input` / `ctx.world.controllers`
// — the registries live in this function's closure (a fresh replay registry starts
// empty and rebuilds state by re-invoking the recorded skills). The old module-level
// handlers read `(ctx.world as ...).input` / `.controllers`, which were NEVER set, so
// every input/sprint/crouch call silently no-op'd; closing over real state fixes that.
//
// THE REAL ENGINE, NOT A STUB: player.* DRIVES the genuine CharacterController from
// js/src/world/character.ts (the same one the playable demos use) — Rapier kinematic
// capsule with grounded detection, slope limit, autostep, snap-to-ground, plus the
// controller-integrated gravity + jump. player.spawn constructs one real body per
// character; player.move advances it ONE fixed step (controller.step + op_physics_step),
// so a chained move sequence is deterministic and replay-faithful.
//
// JUMP FIX: the previous player.jump applied op_physics_apply_impulse to a KINEMATIC
// body, which Rapier ignores entirely (position-based bodies are not force-driven), so
// it never jumped. The real mechanism is the controller's vertical velocity: a step with
// jump=true sets vy=jumpSpeed while grounded, then gravity is integrated through
// move_character each subsequent step. player.jump now drives THAT.
//
// DETERMINISM: NO Date.now / Math.random / performance.now. Movement integrates a FIXED
// step (FIXED_DT), not wall-clock, so the trajectory depends only on the command
// sequence. The native correction is itself deterministic given world state — replaying
// the same player.spawn/move/jump stream reproduces identical positions, bit-for-bit.

import { z } from "../../build/zod.bundle.mjs";
import type { SkillDefinition, SkillRegistry } from "./registry.ts";
import { MAX_ENTITIES, despawnRenderable, spawnRenderable, type Transformable } from "../ecs/world.ts";
import { CharacterController } from "../world/character.ts";
import type { PhysicsOps } from "../engine.ts";

const Vec3 = z.tuple([z.number(), z.number(), z.number()]);
const MetaField = z.record(z.string(), z.unknown()).optional().describe("Agent-supplied extension metadata.");

/** The fixed sim step (seconds) every player.move / player.jump advances. A CONSTANT
 *  (not wall-clock) so a command sequence is deterministic + replay-faithful. */
const FIXED_DT = 1 / 60;

/** Inert transform binding for the headless character entity (the visible capsule mesh
 *  is mounted by the host/demo render path; the ECS entity exists so the character is a
 *  first-class, snapshot/replay-comparable entity even headless). */
function inertTransform(): Transformable {
  return { position: { set() {} }, quaternion: { set() {} }, scale: { set() {} } };
}

// ---- Input binding system -------------------------------------------------

export interface InputBinding {
  name: string;
  sources: string[]; // e.g. ["key:w", "key:arrowup", "gamepad:dpad:up"]
  type: "action" | "axis";
}

/** A real input registry: action/axis names bound to input sources, with live state
 *  fed either from the native input ops (`poll`) or injected by an agent/scripted
 *  controller (`setState`). `input.action` / `input.axis` read this state back. */
export class InputRegistry {
  private readonly bindings = new Map<string, InputBinding>();
  private readonly states = new Map<string, boolean | number>();

  register(binding: InputBinding): void {
    this.bindings.set(binding.name, binding);
    if (!this.states.has(binding.name)) {
      this.states.set(binding.name, binding.type === "axis" ? 0 : false);
    }
  }

  unregister(name: string): boolean {
    this.bindings.delete(name);
    return this.states.delete(name);
  }

  has(name: string): boolean {
    return this.bindings.has(name);
  }

  binding(name: string): InputBinding | undefined {
    return this.bindings.get(name);
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

  /** Poll discrete buttons (jump/run) and axes (move/look) from the native input ops
   *  and update the standard binding states. A windowed host calls this each frame so
   *  the keyboard/gamepad drives the same action/axis names an agent would set. */
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

// ---- Character controller registry ----------------------------------------

/** Per-entity controller record: the REAL kinematic CharacterController plus the
 *  sprint/crouch toggles + crouch tunables the player.* skills layer on top. */
export interface ControllerEntry {
  controller: CharacterController;
  /** When true, player.move runs the controller at RUN speed (sprint). */
  sprint: boolean;
  /** When true, player.move scales the move input by `crouchSpeedScale` (slower). */
  crouch: boolean;
  /** Standing capsule height (2·(halfHeight+radius)); reported by player.crouch. */
  normalHeight: number;
  /** Reported crouch height. */
  crouchHeight: number;
  /** Forward/strafe scale applied while crouching (a real, slower move). */
  crouchSpeedScale: number;
}

/** Stores the live CharacterController + sprint/crouch state per entity. Unlike the
 *  old DefaultCharacterController (whose `create` never inserted into its map and never
 *  spawned a body), this OWNS real kinematic capsules and is the single resolver the
 *  player.* skills look an entity's controller up through. */
export class CharacterControllerRegistry {
  private readonly entries = new Map<string, ControllerEntry>();

  has(entity: string): boolean {
    return this.entries.has(entity);
  }

  get(entity: string): ControllerEntry | undefined {
    return this.entries.get(entity);
  }

  /** Store a (already-constructed) controller for `entity`, with its sprint/crouch
   *  state. The skill constructs the body so it can wire the ECS/entity-table entry
   *  to the same bodyId; this just records it. */
  attach(
    entity: string,
    controller: CharacterController,
    opts?: { crouchHeight?: number; crouchSpeedScale?: number },
  ): ControllerEntry {
    const normalHeight = 2 * (controller.halfHeight + controller.radius);
    const entry: ControllerEntry = {
      controller,
      sprint: false,
      crouch: false,
      normalHeight,
      crouchHeight: opts?.crouchHeight ?? normalHeight * 0.55,
      crouchSpeedScale: opts?.crouchSpeedScale ?? 0.5,
    };
    this.entries.set(entity, entry);
    return entry;
  }

  /** Remove + dispose an entity's controller body. Returns whether one existed. */
  remove(entity: string): boolean {
    const entry = this.entries.get(entity);
    if (entry === undefined) return false;
    entry.controller.dispose();
    return this.entries.delete(entity);
  }

  /** Entity ids with a live controller (registration order). */
  ids(): string[] {
    return [...this.entries.keys()];
  }
}

// ---- Schemas (closure-free; the SkillDefinitions live in registerPlayerSkills) ----

const bindInput = z.object({
  name: z.string().min(1).describe("Binding name (e.g. 'moveForward', 'jump', 'interact')."),
  sources: z.array(z.string().min(1)).describe("Input sources (e.g. 'key:w', 'key:space', 'gamepad:a', 'mouse:left')."),
  type: z.enum(["action", "axis"]).default("action").describe("Whether this binding is discrete (action) or continuous (axis)."),
  meta: MetaField,
});

const setInput = z.object({
  name: z.string().min(1).describe("Bound action/axis name to set."),
  value: z.union([z.boolean(), z.number()]).describe("State to inject: boolean for an action, number for an axis."),
  meta: MetaField,
});

const queryActionInput = z.object({
  name: z.string().min(1),
  meta: MetaField,
});

const queryAxisInput = z.object({
  name: z.string().min(1),
  meta: MetaField,
});

const spawnPlayerInput = z.object({
  position: Vec3.describe("Spawn position — the capsule CENTER. Rest height = surfaceY + halfHeight + radius."),
  halfHeight: z.number().positive().default(0.5).describe("Capsule cylindrical half-height (excludes the radius caps)."),
  radius: z.number().positive().default(0.35).describe("Capsule radius."),
  walkSpeed: z.number().positive().default(4.5).describe("Ground walk speed (m/s)."),
  runSpeed: z.number().positive().default(8.0).describe("Run/sprint speed (m/s)."),
  gravity: z.number().positive().default(22).describe("Downward gravity acceleration magnitude (m/s^2)."),
  jumpSpeed: z.number().positive().default(8).describe("Initial upward jump velocity (m/s)."),
  crouchSpeedScale: z.number().positive().max(1).default(0.5).describe("Move-speed scale while crouching."),
  meta: MetaField,
});

const movePlayerInput = z.object({
  entity: z.string().describe("Player entity (returned by player.spawn)."),
  forward: z.number().min(-1).max(1).default(0).describe("Forward axis in [-1,1] (+ = forward)."),
  strafe: z.number().min(-1).max(1).default(0).describe("Strafe axis in [-1,1] (+ = right)."),
  yaw: z.number().default(0).describe("Movement heading (radians); rotates forward/strafe into world space."),
  run: z.boolean().default(false).describe("Run this step (also implied while sprint is toggled on)."),
  jump: z.boolean().default(false).describe("Trigger a jump this step (on the rising edge while grounded)."),
  meta: MetaField,
});

const jumpPlayerInput = z.object({
  entity: z.string(),
  meta: MetaField,
});

const sprintPlayerInput = z.object({
  entity: z.string(),
  sprinting: z.boolean().default(true).describe("Toggle sprint on/off."),
  meta: MetaField,
});

const crouchPlayerInput = z.object({
  entity: z.string(),
  crouching: z.boolean().default(true).describe("Toggle crouch on/off."),
  meta: MetaField,
});

/**
 * Register the input.* + player.* skills bound to an InputRegistry + a
 * CharacterControllerRegistry. The skill handlers CLOSE OVER these registries (there is
 * no ctx.world.input / ctx.world.controllers). Returns them so the core wiring can expose
 * the player surface (CoreSkills.player = { input, controllers }).
 */
export function registerPlayerSkills(
  registry: SkillRegistry,
  opts?: {
    inputRegistry?: InputRegistry;
    characterControllers?: CharacterControllerRegistry;
  },
): { input: InputRegistry; controllers: CharacterControllerRegistry } {
  const input = opts?.inputRegistry ?? new InputRegistry();
  const controllers = opts?.characterControllers ?? new CharacterControllerRegistry();

  // ---- Input skills ----

  const bindAction: SkillDefinition<z.infer<typeof bindInput>, { ok: boolean }> = {
    name: "input.bind",
    version: "1.0.0",
    description: "Bind an action or axis name to input sources (keyboard keys, mouse buttons, gamepad axes). Query its state with input.action / input.axis; drive it from the native device (host poll) or inject it with input.set.",
    category: "player",
    permissions: ["player.configure"],
    input: bindInput,
    output: z.object({ ok: z.boolean() }),
    handler: (i, ctx) => {
      input.register({ name: i.name, sources: i.sources, type: i.type });
      ctx.emit("input.bound", { name: i.name, sources: i.sources, type: i.type, ...i.meta });
      return { ok: true };
    },
  };

  const setInputState: SkillDefinition<z.infer<typeof setInput>, { ok: boolean }> = {
    name: "input.set",
    version: "1.0.0",
    description: "Inject the current state of a bound action (boolean) or axis (number) — scripted/agent-driven input. The host's per-frame native poll sets the same names from a real device.",
    category: "player",
    permissions: ["player.configure"],
    input: setInput,
    output: z.object({ ok: z.boolean() }),
    handler: (i, ctx) => {
      if (!input.has(i.name)) return { ok: false };
      input.setState(i.name, i.value);
      ctx.emit("input.set", { name: i.name, value: i.value, ...i.meta });
      return { ok: true };
    },
  };

  const queryAction: SkillDefinition<z.infer<typeof queryActionInput>, { active: boolean }> = {
    name: "input.action",
    version: "1.0.0",
    description: "Query whether a bound action is currently active (pressed/held). Reflects the latest native poll or input.set injection.",
    category: "player",
    permissions: ["player.read"],
    input: queryActionInput,
    output: z.object({ active: z.boolean() }),
    handler: (i) => {
      const state = input.getState(i.name);
      return { active: state === true || (typeof state === "number" && state > 0.5) };
    },
  };

  const queryAxis: SkillDefinition<z.infer<typeof queryAxisInput>, { value: number }> = {
    name: "input.axis",
    version: "1.0.0",
    description: "Query a continuous axis value (e.g. moveX, moveY, lookX, lookY). Range is typically -1 to 1.",
    category: "player",
    permissions: ["player.read"],
    input: queryAxisInput,
    output: z.object({ value: z.number() }),
    handler: (i) => {
      const state = input.getState(i.name);
      return { value: typeof state === "number" ? state : (state === true ? 1 : 0) };
    },
  };

  // ---- Player skills (drive the REAL CharacterController) ----

  const spawnPlayer: SkillDefinition<z.infer<typeof spawnPlayerInput>, { entity: string; bodyId: number; position: [number, number, number]; grounded: boolean }> = {
    name: "player.spawn",
    version: "1.0.0",
    description: "Spawn a kinematic character-controller capsule (Rapier: grounded detection, slope limit, autostep, snap-to-ground, plus controller-integrated gravity + jump) at a position, register it as an entity, and return its entity id + body id. Drive it with player.move / player.jump.",
    category: "player",
    permissions: ["player.write"],
    input: spawnPlayerInput,
    output: z.object({ entity: z.string(), bodyId: z.number(), position: Vec3, grounded: z.boolean() }),
    handler: (i, ctx) => {
      const physics = ctx.world.ops as unknown as PhysicsOps;
      const controller = new CharacterController(physics, i.position, {
        halfHeight: i.halfHeight,
        radius: i.radius,
        walkSpeed: i.walkSpeed,
        runSpeed: i.runSpeed,
        gravity: i.gravity,
        jumpSpeed: i.jumpSpeed,
      });
      const eid = spawnRenderable(ctx.world.ecs, inertTransform(), i.position[0], i.position[1], i.position[2]);
      if (eid >= MAX_ENTITIES) {
        despawnRenderable(ctx.world.ecs, eid);
        controller.dispose();
        throw new Error("player.spawn: entity capacity exceeded (MAX_ENTITIES)");
      }
      const entity = ctx.world.entities.create({ eid, bodyId: controller.bodyId });
      controllers.attach(entity, controller, { crouchSpeedScale: i.crouchSpeedScale });
      const p = controller.position;
      const position: [number, number, number] = [p[0], p[1], p[2]];
      ctx.emit("player.spawned", { entity, bodyId: controller.bodyId, position, ...i.meta });
      return { entity, bodyId: controller.bodyId, position, grounded: controller.isGrounded };
    },
  };

  const movePlayer: SkillDefinition<z.infer<typeof movePlayerInput>, { moved: boolean; grounded: boolean; newPosition: [number, number, number] }> = {
    name: "player.move",
    version: "1.0.0",
    description: "Advance a player's character controller ONE fixed step from an input command (forward/strafe axes rotated by yaw), resolving collisions, slopes, autostep, snap-to-ground, and gravity. Sprint (player.sprint) raises the speed; crouch (player.crouch) lowers it. Returns the corrected position + grounded.",
    category: "player",
    permissions: ["player.write"],
    input: movePlayerInput,
    output: z.object({ moved: z.boolean(), grounded: z.boolean(), newPosition: Vec3 }),
    handler: (i, ctx) => {
      const entry = controllers.get(i.entity);
      if (entry === undefined) throw new Error(`player.move: no character controller for '${i.entity}' (spawn one with player.spawn)`);
      const scale = entry.crouch ? entry.crouchSpeedScale : 1;
      entry.controller.step(
        { forward: i.forward * scale, strafe: i.strafe * scale, yaw: i.yaw, run: i.run || entry.sprint, jump: i.jump },
        FIXED_DT,
      );
      ctx.world.ops.op_physics_step(); // commit the queued kinematic translation so the next move chains from the new position
      const p = entry.controller.position;
      const newPosition: [number, number, number] = [p[0], p[1], p[2]];
      const grounded = entry.controller.isGrounded;
      ctx.emit("player.moved", { entity: i.entity, newPosition, grounded, ...i.meta });
      return { moved: true, grounded, newPosition };
    },
  };

  const jumpPlayer: SkillDefinition<z.infer<typeof jumpPlayerInput>, { jumped: boolean; grounded: boolean; newPosition: [number, number, number] }> = {
    name: "player.jump",
    version: "1.0.0",
    description: "Trigger a jump on the player's character controller — only takes effect when grounded. Sets the controller's upward velocity (fed through move_character + gravity), NOT a force impulse (a kinematic body ignores impulses). Advances one fixed step; returns whether it jumped + the new position.",
    category: "player",
    permissions: ["player.write"],
    input: jumpPlayerInput,
    output: z.object({ jumped: z.boolean(), grounded: z.boolean(), newPosition: Vec3 }),
    handler: (i, ctx) => {
      const entry = controllers.get(i.entity);
      if (entry === undefined) throw new Error(`player.jump: no character controller for '${i.entity}' (spawn one with player.spawn)`);
      const wasGrounded = entry.controller.isGrounded;
      entry.controller.step(
        { forward: 0, strafe: 0, yaw: entry.controller.facing, run: false, jump: true },
        FIXED_DT,
      );
      ctx.world.ops.op_physics_step();
      const p = entry.controller.position;
      const newPosition: [number, number, number] = [p[0], p[1], p[2]];
      ctx.emit("player.jumped", { entity: i.entity, jumped: wasGrounded, grounded: entry.controller.isGrounded, newPosition, ...i.meta });
      return { jumped: wasGrounded, grounded: entry.controller.isGrounded, newPosition };
    },
  };

  const sprintPlayer: SkillDefinition<z.infer<typeof sprintPlayerInput>, { sprinting: boolean }> = {
    name: "player.sprint",
    version: "1.0.0",
    description: "Toggle sprint for a player entity. While on, player.move runs the controller at run speed (a real, faster move) instead of walk speed.",
    category: "player",
    permissions: ["player.write"],
    input: sprintPlayerInput,
    output: z.object({ sprinting: z.boolean() }),
    handler: (i, ctx) => {
      const entry = controllers.get(i.entity);
      if (entry === undefined) throw new Error(`player.sprint: no character controller for '${i.entity}'`);
      entry.sprint = i.sprinting;
      ctx.emit("player.sprint.toggled", { entity: i.entity, sprinting: i.sprinting, ...i.meta });
      return { sprinting: i.sprinting };
    },
  };

  const crouchPlayer: SkillDefinition<z.infer<typeof crouchPlayerInput>, { crouching: boolean; height: number }> = {
    name: "player.crouch",
    version: "1.0.0",
    description: "Toggle crouch for a player entity. While on, player.move scales the move input down (a real, slower move) and the reported character height drops to the crouch height.",
    category: "player",
    permissions: ["player.write"],
    input: crouchPlayerInput,
    output: z.object({ crouching: z.boolean(), height: z.number() }),
    handler: (i, ctx) => {
      const entry = controllers.get(i.entity);
      if (entry === undefined) throw new Error(`player.crouch: no character controller for '${i.entity}'`);
      entry.crouch = i.crouching;
      const height = i.crouching ? entry.crouchHeight : entry.normalHeight;
      ctx.emit("player.crouch.toggled", { entity: i.entity, crouching: i.crouching, height, ...i.meta });
      return { crouching: i.crouching, height };
    },
  };

  registry.register(bindAction);
  registry.register(setInputState);
  registry.register(queryAction);
  registry.register(queryAxis);
  registry.register(spawnPlayer);
  registry.register(movePlayer);
  registry.register(jumpPlayer);
  registry.register(sprintPlayer);
  registry.register(crouchPlayer);

  return { input, controllers };
}
