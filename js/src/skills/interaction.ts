// interaction.* skills — entity interaction, pickup, drop, use, open/close/toggle.
// All inputs accept optional `meta` for agent-supplied extension data.
//
// CLOSURE WIRING (mirrors social ← ui/locomotion): the skill definitions are built
// INSIDE registerInteractionSkills so they close over the local InteractionManager
// AND the inventory manager passed in via opts (interaction.pickup/drop/use reach
// into inventory). This replaces the old module-level skills that read a never-set
// `(ctx.world as ...).interactionManager` and silently no-op'd.
//
// DETERMINISM: interaction.interact stamps `lastInteractTick` from `ctx.tick` (the
// recorded sim tick), NEVER Date.now() — so replay recomputes the interaction state
// bit-identically. No Date.now()/new Date()/Math.random()/performance.now() here.

import { z } from "../../build/zod.bundle.mjs";
import { MAX_ENTITIES, Position, despawnRenderable, spawnRenderable } from "../ecs/world.ts";
import type { Transformable } from "../ecs/world.ts";
import { teardownEntity } from "./entity-teardown.ts";
import { querySpatialEntities } from "../spatial/index.ts";
import type { SkillDefinition, SkillRegistry, WorldContext } from "./registry.ts";
import type { InventoryManager } from "./inventory.ts";

const Vec3 = z.tuple([z.number(), z.number(), z.number()]);
const MetaField = z.record(z.string(), z.unknown()).optional().describe("Agent-supplied extension metadata.");

// Interactable entity definition
export interface InteractableDef {
  entity: string;
  prompt: string;
  maxRange: number;
  type: "pickup" | "use" | "talk" | "open" | "toggle" | "custom";
  action?: string;
  config?: Record<string, unknown>;
  state: Record<string, unknown>;
}

export class InteractionManager {
  private readonly interactables = new Map<string, InteractableDef>();

  register(def: InteractableDef): void {
    this.interactables.set(def.entity, def);
  }

  unregister(entity: string): boolean {
    return this.interactables.delete(entity);
  }

  get(entity: string): InteractableDef | undefined {
    return this.interactables.get(entity);
  }

  /** True iff `entity` is a registered interactable. */
  has(entity: string): boolean {
    return this.interactables.has(entity);
  }

  /** DETERMINISTIC interact: `tick` is `ctx.tick` (NEVER Date.now()) so the stored +
   *  returned `lastInteractTick` recomputes bit-identically on replay. */
  interact(entity: string, actorEntity: string, tick: number): { ok: boolean; result?: Record<string, unknown> } {
    const def = this.interactables.get(entity);
    if (def === undefined) return { ok: false };
    def.state.lastInteractedBy = actorEntity;
    def.state.lastInteractTick = tick;
    return { ok: true, result: { type: def.type, prompt: def.prompt, ...def.state } };
  }
}

/** Inert transform binding for a dropped world item (the render mesh, if any, is
 *  attached by the host's render path; the ECS entity exists headless so the item is
 *  a first-class, snapshot/replay-comparable entity). Mirrors terrain.ts. */
function inertTransform(): Transformable {
  return { position: { set() {} }, quaternion: { set() {} }, scale: { set() {} } };
}

/** Resolve a live entity's world position from the ECS transform SoA. Undefined when
 *  the entity is not in the table (so proximity/drop fall back honestly). */
function entityPosition(world: WorldContext, entity: string): [number, number, number] | undefined {
  const entry = world.entities.resolve(entity);
  if (entry === undefined) return undefined;
  return [Position.x[entry.eid], Position.y[entry.eid], Position.z[entry.eid]];
}

export function registerInteractionSkills(
  registry: SkillRegistry,
  opts?: { inventoryManager?: InventoryManager },
): { interactionManager: InteractionManager } {
  const mgr = new InteractionManager();
  const inv = opts?.inventoryManager;

  // ---- interaction.register ------------------------------------------------
  const registerInput = z.object({
    entity: z.string().describe("Entity to make interactable."),
    prompt: z.string().min(1).max(100).describe("Interaction prompt text (e.g. 'Press E to pick up')."),
    maxRange: z.number().positive().default(3).describe("Maximum interaction distance."),
    type: z.enum(["pickup", "use", "talk", "open", "toggle", "custom"]).default("custom").describe("Interaction type."),
    action: z.string().optional().describe("Custom action name or event to trigger on interaction."),
    config: z.record(z.string(), z.unknown()).optional().describe("Custom interaction configuration (agent-defined behavior data)."),
    meta: MetaField,
  });
  const registerInteraction: SkillDefinition<z.infer<typeof registerInput>, { ok: boolean }> = {
    name: "interaction.register",
    version: "1.0.0",
    description: "Register an entity as interactable with a prompt, max range, and type. Interactions trigger the entity's handler.",
    category: "interaction",
    permissions: ["interaction.configure"],
    input: registerInput,
    output: z.object({ ok: z.boolean() }),
    handler: (input, ctx) => {
      mgr.register({ entity: input.entity, prompt: input.prompt, maxRange: input.maxRange, type: input.type, action: input.action, config: input.config, state: {} });
      ctx.emit("interaction.registered", { entity: input.entity, prompt: input.prompt, type: input.type, ...input.meta });
      return { ok: true };
    },
  };

  // ---- interaction.query (pure read; REAL proximity) -----------------------
  const queryInput = z.object({
    position: Vec3.optional().describe("Query position. If omitted, uses the actor entity's position (actorEntity)."),
    actorEntity: z.string().optional().describe("Actor entity whose position to query from (used when position is omitted)."),
    maxRange: z.number().positive().default(5).describe("Maximum search radius."),
    meta: MetaField,
  });
  const queryInteraction: SkillDefinition<
    z.infer<typeof queryInput>,
    { interactables: { entity: string; prompt: string; type: string; distance: number }[] }
  > = {
    name: "interaction.query",
    version: "1.0.0",
    description: "Query interactable entities within range of a position (or the actor entity), sorted by distance. Uses the world spatial index over real entity transforms. Pure read — emits nothing.",
    category: "interaction",
    permissions: ["interaction.read"],
    input: queryInput,
    output: z.object({ interactables: z.array(z.object({ entity: z.string(), prompt: z.string(), type: z.string(), distance: z.number() })) }),
    handler: (input, ctx) => {
      const pos = input.position
        ?? (input.actorEntity !== undefined ? entityPosition(ctx.world, input.actorEntity) : undefined)
        ?? [0, 0, 0];
      // REAL proximity: ask the spatial index for entities within range, sorted by
      // distance, then keep only the registered interactables (in that order).
      const near = querySpatialEntities(ctx.world, {
        near: pos,
        radius: input.maxRange,
        excludeEntity: input.actorEntity,
        sortBy: "distance",
      });
      const interactables: { entity: string; prompt: string; type: string; distance: number }[] = [];
      for (const e of near.entities) {
        const def = mgr.get(e.entity);
        if (def === undefined) continue;
        interactables.push({ entity: e.entity, prompt: def.prompt, type: def.type, distance: e.distance });
      }
      return { interactables };
    },
  };

  // ---- interaction.interact ------------------------------------------------
  const interactInput = z.object({
    entity: z.string().describe("Target interactable entity."),
    actorEntity: z.string().optional().describe("Actor entity (defaults to calling agent's entity)."),
    data: z.record(z.string(), z.unknown()).optional().describe("Custom interaction data (e.g. which item to use, which dialogue option)."),
    meta: MetaField,
  });
  const interact: SkillDefinition<z.infer<typeof interactInput>, { ok: boolean; result?: Record<string, unknown> }> = {
    name: "interaction.interact",
    version: "1.0.0",
    description: "Perform an interaction with a target entity. Triggers the entity's registered interaction handler. Stamps the interaction tick from the sim tick (replay-deterministic).",
    category: "interaction",
    permissions: ["interaction.write"],
    input: interactInput,
    output: z.object({ ok: z.boolean(), result: z.unknown().optional() }),
    handler: (input, ctx) => {
      const result = mgr.interact(input.entity, input.actorEntity ?? ctx.agentId, ctx.tick);
      ctx.emit("interaction.performed", { entity: input.entity, actor: input.actorEntity ?? ctx.agentId, data: input.data, ...input.meta });
      return result;
    },
  };

  // ---- interaction.pickup --------------------------------------------------
  const pickupInput = z.object({
    itemEntity: z.string().describe("Item entity to pick up."),
    actorEntity: z.string().describe("Actor picking up the item."),
    slot: z.number().int().min(0).optional().describe("Target inventory slot index. If omitted, auto-assign."),
    meta: MetaField,
  });
  const pickup: SkillDefinition<z.infer<typeof pickupInput>, { ok: boolean; slot?: number; reason?: string }> = {
    name: "interaction.pickup",
    version: "1.0.0",
    description: "Pick up an item entity into an inventory slot. Destroys the world item entity. Requires an inventory on the actor. On failure returns ok:false with a `reason` the caller can act on.",
    category: "interaction",
    permissions: ["interaction.write"],
    input: pickupInput,
    output: z.object({ ok: z.boolean(), slot: z.number().optional(), reason: z.string().optional() }),
    handler: (input, ctx) => {
      // Structured failure: never a bare {ok:false}. The caller (often an autonomous
      // agent) gets a machine-readable reason instead of having to guess.
      if (inv === undefined) return { ok: false, reason: "no inventory system on this world" };
      const result = inv.addItem(input.actorEntity, { itemId: input.itemEntity, quantity: 1, slot: input.slot });
      if (!result.ok) return { ok: false, reason: `actor "${input.actorEntity}" inventory rejected the item (full or invalid slot)` };
      // Full teardown so the picked-up item's MESH leaves the scene (not just its ECS
      // slot) — the shared path that also frees any physics body + tags.
      teardownEntity(ctx.world, input.itemEntity);
      ctx.emit("interaction.pickedUp", { itemEntity: input.itemEntity, actorEntity: input.actorEntity, slot: result.slot, ...input.meta });
      return { ok: true, slot: result.slot };
    },
  };

  // ---- interaction.drop ----------------------------------------------------
  const dropInput = z.object({
    actorEntity: z.string(),
    itemId: z.string().describe("Item id to drop."),
    slot: z.number().int().min(0).optional().describe("Inventory slot. If omitted, drops first matching item."),
    position: Vec3.optional().describe("Drop position. If omitted, uses actor's position."),
    quantity: z.number().int().min(1).default(1),
    meta: MetaField,
  });
  const drop: SkillDefinition<z.infer<typeof dropInput>, { ok: boolean; itemEntity?: string; reason?: string }> = {
    name: "interaction.drop",
    version: "1.0.0",
    description: "Drop an item from inventory into the world at the actor's position (or a specified position). Removes it from inventory and spawns a real world item entity, returning its id. On failure returns ok:false with a `reason`.",
    category: "interaction",
    permissions: ["interaction.write"],
    input: dropInput,
    output: z.object({ ok: z.boolean(), itemEntity: z.string().optional(), reason: z.string().optional() }),
    handler: (input, ctx) => {
      if (inv === undefined) return { ok: false, reason: "no inventory system on this world" };
      const removed = inv.removeItem(input.actorEntity, input.itemId, input.slot, input.quantity);
      if (!removed) return { ok: false, reason: `actor "${input.actorEntity}" does not hold "${input.itemId}"` };
      // Spawn a REAL world item entity (the ECS path terrain/scene use): a renderable
      // bound to an inert transform at the drop position, registered in the entity table.
      const pos = input.position ?? entityPosition(ctx.world, input.actorEntity) ?? [0, 0, 0];
      const [x, y, z] = pos;
      const eid = spawnRenderable(ctx.world.ecs, inertTransform(), x, y, z);
      if (eid >= MAX_ENTITIES) {
        despawnRenderable(ctx.world.ecs, eid);
        return { ok: false };
      }
      const itemEntity = ctx.world.entities.create({ eid });
      ctx.emit("interaction.dropped", { actorEntity: input.actorEntity, itemId: input.itemId, quantity: input.quantity, itemEntity, position: pos, ...input.meta });
      return { ok: true, itemEntity };
    },
  };

  // ---- interaction.use -----------------------------------------------------
  const useInput = z.object({
    actorEntity: z.string(),
    itemId: z.string().describe("Item to use."),
    targetEntity: z.string().optional().describe("Target entity for the use action (e.g. use key on door)."),
    quantity: z.number().int().min(1).default(1).describe("How many to consume."),
    data: z.record(z.string(), z.unknown()).optional().describe("Custom use data (agent-defined context)."),
    meta: MetaField,
  });
  const useItem: SkillDefinition<z.infer<typeof useInput>, { ok: boolean; result?: Record<string, unknown> }> = {
    name: "interaction.use",
    version: "1.0.0",
    description: "Use/consume an item from inventory (eat food, drink potion, use key on door). Consumes the item from the actor's inventory; fails honestly if the actor lacks it.",
    category: "interaction",
    permissions: ["interaction.write"],
    input: useInput,
    output: z.object({ ok: z.boolean(), result: z.unknown().optional(), reason: z.string().optional() }),
    handler: (input, ctx) => {
      if (inv === undefined) return { ok: false, reason: "no inventory system on this world" };
      const consumed = inv.removeItem(input.actorEntity, input.itemId, undefined, input.quantity);
      if (!consumed) return { ok: false, reason: `actor "${input.actorEntity}" has no "${input.itemId}" to use` };
      ctx.emit("interaction.used", { actorEntity: input.actorEntity, itemId: input.itemId, quantity: input.quantity, targetEntity: input.targetEntity, data: input.data, ...input.meta });
      return { ok: true, result: { itemId: input.itemId, used: true, quantity: input.quantity } };
    },
  };

  // ---- interaction.open ----------------------------------------------------
  const openInput = z.object({
    entity: z.string().describe("Container entity to open (chest, door, cabinet)."),
    meta: MetaField,
  });
  const openEntity: SkillDefinition<z.infer<typeof openInput>, { ok: boolean }> = {
    name: "interaction.open",
    version: "1.0.0",
    description: "Open a container entity. Plays open animation/state, enables container interaction.",
    category: "interaction",
    permissions: ["interaction.write"],
    input: openInput,
    output: z.object({ ok: z.boolean() }),
    handler: (input, ctx) => {
      const def = mgr.get(input.entity);
      if (def === undefined) return { ok: false };
      def.state.open = true;
      ctx.emit("interaction.opened", { entity: input.entity, ...input.meta });
      return { ok: true };
    },
  };

  // ---- interaction.close ---------------------------------------------------
  const closeInput = z.object({
    entity: z.string().describe("Container entity to close."),
    meta: MetaField,
  });
  const closeEntity: SkillDefinition<z.infer<typeof closeInput>, { ok: boolean }> = {
    name: "interaction.close",
    version: "1.0.0",
    description: "Close an open container entity.",
    category: "interaction",
    permissions: ["interaction.write"],
    input: closeInput,
    output: z.object({ ok: z.boolean() }),
    handler: (input, ctx) => {
      const def = mgr.get(input.entity);
      if (def === undefined) return { ok: false };
      def.state.open = false;
      ctx.emit("interaction.closed", { entity: input.entity, ...input.meta });
      return { ok: true };
    },
  };

  // ---- interaction.toggle --------------------------------------------------
  const toggleInput = z.object({
    entity: z.string().describe("Interactable entity to toggle."),
    meta: MetaField,
  });
  const toggleEntity: SkillDefinition<z.infer<typeof toggleInput>, { ok: boolean; state: Record<string, unknown> }> = {
    name: "interaction.toggle",
    version: "1.0.0",
    description: "Toggle an interactable entity between two states (on/off, open/closed, locked/unlocked).",
    category: "interaction",
    permissions: ["interaction.write"],
    input: toggleInput,
    output: z.object({ ok: z.boolean(), state: z.record(z.string(), z.unknown()) }),
    handler: (input, ctx) => {
      const def = mgr.get(input.entity);
      if (def === undefined) return { ok: false, state: {} };
      def.state.active = !def.state.active;
      ctx.emit("interaction.toggled", { entity: input.entity, active: def.state.active, ...input.meta });
      return { ok: true, state: def.state };
    },
  };

  registry.register(registerInteraction);
  registry.register(queryInteraction);
  registry.register(interact);
  registry.register(pickup);
  registry.register(drop);
  registry.register(useItem);
  registry.register(openEntity);
  registry.register(closeEntity);
  registry.register(toggleEntity);

  return { interactionManager: mgr };
}
