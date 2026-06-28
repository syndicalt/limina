// inventory.* and item.* skills — inventory management and item definitions.
// All inputs accept optional `meta` for agent-supplied extension data.
//
// CLOSURE PATTERN (matches terrain.ts / interaction.ts): every SkillDefinition is
// built INSIDE registerInventorySkills, closing over the one local InventoryManager.
// There is no `ctx.world.inventoryManager` channel — the handlers reference `mgr`
// directly, so the skills are wired to real state (the pre-closure cast read a field
// nobody ever set, making every skill a silent no-op).
//
// DETERMINISM: this file is RNG-free and time-free (no Date.now / Math.random). Slot
// assignment is the lowest free index, so a recorded sequence of inventory skills
// replays bit-identically into a fresh manager.

import { z } from "../../build/zod.bundle.mjs";
import type { SkillDefinition, SkillRegistry } from "./registry.ts";

const MetaField = z.record(z.string(), z.unknown()).optional().describe("Agent-supplied extension metadata.");

// Item definition
export interface ItemDef {
  id: string;
  name: string;
  description: string;
  icon?: string;
  stackable: boolean;
  maxStack: number;
  weight: number;
  category: string;
  config: Record<string, unknown>;
  usageBehavior?: string;
  onUse?: string;
  onEquip?: string;
}

// Inventory slot
export interface InventorySlot {
  itemId: string;
  quantity: number;
  slot: number;
  equipped: boolean;
  data?: Record<string, unknown>;
}

// Inventory per entity
export interface Inventory {
  entity: string;
  capacity: number;
  slots: Map<number, InventorySlot>;
  equipment: Map<string, InventorySlot>; // slot name -> item
  typeRestrictions?: string[];
}

/** Outcome of an addItem attempt. `reason` is populated only on failure so a caller
 *  (and the inventory.add skill) can surface WHY (no-inventory / type-restricted /
 *  no-space) instead of an opaque false. */
export interface AddResult {
  ok: boolean;
  slot?: number;
  reason?: "no-inventory" | "type-restricted" | "no-space";
}

/** A deterministic, JSON-serializable snapshot of one inventory (for replay-parity
 *  comparison + UI readers). Slots are sorted by index; equipment by slot name. */
export interface InventorySnapshot {
  entity: string;
  capacity: number;
  typeRestrictions?: string[];
  slots: { slot: number; itemId: string; quantity: number; equipped: boolean }[];
  equipment: { equipmentSlot: string; itemId: string; quantity: number }[];
}

export class InventoryManager {
  private readonly inventories = new Map<string, Inventory>();
  private readonly itemDefs = new Map<string, ItemDef>();

  createInventory(entity: string, capacity: number, typeRestrictions?: string[]): Inventory {
    const inv: Inventory = { entity, capacity, slots: new Map(), equipment: new Map(), typeRestrictions };
    this.inventories.set(entity, inv);
    return inv;
  }

  getInventory(entity: string): Inventory | undefined {
    return this.inventories.get(entity);
  }

  defineItem(def: ItemDef): void {
    this.itemDefs.set(def.id, def);
  }

  getItemDef(id: string): ItemDef | undefined {
    return this.itemDefs.get(id);
  }

  /** Whether an inventory may hold `itemId` under its type restrictions. No
   *  restrictions -> anything is allowed; otherwise the item must be DEFINED and its
   *  category must be in the allowlist (an unknown item has no category to admit). */
  private accepts(inv: Inventory, itemId: string): boolean {
    if (inv.typeRestrictions === undefined || inv.typeRestrictions.length === 0) return true;
    const def = this.itemDefs.get(itemId);
    return def !== undefined && inv.typeRestrictions.includes(def.category);
  }

  addItem(entity: string, item: { itemId: string; quantity?: number; slot?: number }): AddResult {
    const inv = this.inventories.get(entity);
    if (inv === undefined) return { ok: false, reason: "no-inventory" };
    // ENFORCE type restrictions before any mutation (reject disallowed categories).
    if (!this.accepts(inv, item.itemId)) return { ok: false, reason: "type-restricted" };
    const qty = item.quantity ?? 1;
    const itemDef = this.itemDefs.get(item.itemId);
    const stackable = itemDef?.stackable ?? true;
    const maxStack = itemDef?.maxStack ?? 99;

    // Try to stack with existing
    if (stackable) {
      for (const [slotNum, slot] of inv.slots) {
        if (slot.itemId === item.itemId && slot.quantity < maxStack) {
          const canAdd = Math.min(qty, maxStack - slot.quantity);
          slot.quantity += canAdd;
          return { ok: true, slot: slotNum };
        }
      }
    }

    // Find empty slot (deterministic: lowest free index)
    const targetSlot = item.slot ?? this.findEmptySlot(inv);
    if (targetSlot === undefined || targetSlot >= inv.capacity) return { ok: false, reason: "no-space" };

    inv.slots.set(targetSlot, { itemId: item.itemId, quantity: qty, slot: targetSlot, equipped: false });
    return { ok: true, slot: targetSlot };
  }

  removeItem(entity: string, itemId: string, slot?: number, quantity?: number): boolean {
    const inv = this.inventories.get(entity);
    if (inv === undefined) return false;
    const qty = quantity ?? 1;

    if (slot !== undefined) {
      const s = inv.slots.get(slot);
      if (s === undefined || s.itemId !== itemId) return false;
      if (s.quantity <= qty) {
        inv.slots.delete(slot);
      } else {
        s.quantity -= qty;
      }
      return true;
    }

    // Find first matching slot (deterministic: lowest slot index first)
    for (const slotNum of [...inv.slots.keys()].sort((a, b) => a - b)) {
      const s = inv.slots.get(slotNum)!;
      if (s.itemId === itemId) {
        if (s.quantity <= qty) {
          inv.slots.delete(slotNum);
        } else {
          s.quantity -= qty;
        }
        return true;
      }
    }
    return false;
  }

  listItems(entity: string): InventorySlot[] {
    const inv = this.inventories.get(entity);
    if (inv === undefined) return [];
    return [...inv.slots.values()].sort((a, b) => a.slot - b.slot);
  }

  countItem(entity: string, itemId: string): number {
    const inv = this.inventories.get(entity);
    if (inv === undefined) return 0;
    let total = 0;
    for (const s of inv.slots.values()) {
      if (s.itemId === itemId) total += s.quantity;
    }
    return total;
  }

  hasItem(entity: string, itemId: string): boolean {
    return this.countItem(entity, itemId) > 0;
  }

  transferItem(fromEntity: string, toEntity: string, itemId: string, quantity: number): boolean {
    // Probe the destination FIRST so a type-restricted/full target never strands the
    // item: only remove from the source once we know the add will land.
    const dest = this.inventories.get(toEntity);
    if (dest === undefined || !this.accepts(dest, itemId)) return false;
    const removed = this.removeItem(fromEntity, itemId, undefined, quantity);
    if (!removed) return false;
    const added = this.addItem(toEntity, { itemId, quantity });
    if (!added.ok) {
      // Roll back: the destination could not take it (e.g. no free slot) — return the
      // items to the source so a failed transfer is a true no-op.
      this.addItem(fromEntity, { itemId, quantity });
      return false;
    }
    return true;
  }

  equipItem(entity: string, itemId: string, equipmentSlot: string): boolean {
    const inv = this.inventories.get(entity);
    if (inv === undefined) return false;
    // Already-equipped slot must be vacated first (deterministic, no silent overwrite).
    if (inv.equipment.has(equipmentSlot)) return false;
    // Lowest-slot-first so equip is deterministic when the item stacks across slots.
    for (const slotNum of [...inv.slots.keys()].sort((a, b) => a - b)) {
      const slot = inv.slots.get(slotNum)!;
      if (slot.itemId === itemId) {
        if (slot.quantity <= 1) {
          inv.slots.delete(slotNum);
        } else {
          slot.quantity -= 1;
        }
        inv.equipment.set(equipmentSlot, { itemId, quantity: 1, slot: slotNum, equipped: true });
        return true;
      }
    }
    return false;
  }

  unequipItem(entity: string, equipmentSlot: string): boolean {
    const inv = this.inventories.get(entity);
    if (inv === undefined) return false;
    const equipped = inv.equipment.get(equipmentSlot);
    if (equipped === undefined) return false;
    // Stack back onto an existing stack if possible; else take the lowest free slot.
    inv.equipment.delete(equipmentSlot);
    const added = this.addItem(entity, { itemId: equipped.itemId, quantity: equipped.quantity });
    if (!added.ok) {
      // No room to unequip — restore the equipped state (true no-op on failure).
      inv.equipment.set(equipmentSlot, equipped);
      return false;
    }
    return true;
  }

  /** Equipment entries (sorted by slot name) for an entity — a public reader for
   *  UI/snapshot (the equipment map is otherwise private). */
  listEquipment(entity: string): { equipmentSlot: string; itemId: string; quantity: number }[] {
    const inv = this.inventories.get(entity);
    if (inv === undefined) return [];
    return [...inv.equipment.entries()]
      .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
      .map(([equipmentSlot, s]) => ({ equipmentSlot, itemId: s.itemId, quantity: s.quantity }));
  }

  /** Deterministic snapshot of one inventory (slots + equipment), for replay parity. */
  snapshotInventory(entity: string): InventorySnapshot | undefined {
    const inv = this.inventories.get(entity);
    if (inv === undefined) return undefined;
    return {
      entity: inv.entity,
      capacity: inv.capacity,
      typeRestrictions: inv.typeRestrictions === undefined ? undefined : [...inv.typeRestrictions],
      slots: this.listItems(entity).map((s) => ({ slot: s.slot, itemId: s.itemId, quantity: s.quantity, equipped: s.equipped })),
      equipment: this.listEquipment(entity),
    };
  }

  /** Deterministic snapshot of ALL inventories (entities sorted), for replay parity. */
  snapshot(): InventorySnapshot[] {
    return [...this.inventories.keys()]
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
      .map((e) => this.snapshotInventory(e)!);
  }

  private findEmptySlot(inv: Inventory): number | undefined {
    for (let i = 0; i < inv.capacity; i++) {
      if (!inv.slots.has(i)) return i;
    }
    return undefined;
  }
}

// ---- Input schemas (module-level; the SkillDefinitions close over the manager) ----

const createInvInput = z.object({
  entity: z.string(),
  capacity: z.number().int().min(1).max(200).default(20).describe("Number of inventory slots."),
  typeRestrictions: z.array(z.string()).optional().describe("Optional item type restrictions (only allow items of these categories)."),
  meta: MetaField,
});

const addItemInput = z.object({
  entity: z.string(),
  itemId: z.string().describe("Item definition id to add."),
  quantity: z.number().int().min(1).default(1),
  slot: z.number().int().min(0).optional().describe("Target slot index. If omitted, auto-assign."),
  meta: MetaField,
});

const removeItemInput = z.object({
  entity: z.string(),
  itemId: z.string(),
  slot: z.number().int().min(0).optional(),
  quantity: z.number().int().min(1).default(1),
  meta: MetaField,
});

const listInvInput = z.object({
  entity: z.string(),
  meta: MetaField,
});

const countItemInput = z.object({
  entity: z.string(),
  itemId: z.string(),
  meta: MetaField,
});

const hasItemInput = z.object({
  entity: z.string(),
  itemId: z.string(),
  meta: MetaField,
});

const transferInput = z.object({
  fromEntity: z.string(),
  toEntity: z.string(),
  itemId: z.string(),
  quantity: z.number().int().min(1).default(1),
  meta: MetaField,
});

const equipInput = z.object({
  entity: z.string(),
  itemId: z.string().describe("Item id (in the inventory) to equip."),
  equipmentSlot: z.string().min(1).describe("Equipment slot name (e.g. 'mainhand', 'head')."),
  meta: MetaField,
});

const unequipInput = z.object({
  entity: z.string(),
  equipmentSlot: z.string().min(1).describe("Equipment slot name to unequip back into the inventory."),
  meta: MetaField,
});

const defineItemInput = z.object({
  id: z.string().min(1).describe("Unique item definition id."),
  name: z.string().min(1).describe("Display name."),
  description: z.string().default("").describe("Item description text."),
  icon: z.string().optional().describe("Icon asset id or texture reference."),
  stackable: z.boolean().default(true),
  maxStack: z.number().int().min(1).default(99).describe("Max stack size (if stackable)."),
  weight: z.number().min(0).default(1),
  category: z.string().default("general").describe("Item category for type restrictions."),
  usageBehavior: z.string().optional().describe("Behavior to trigger on use (e.g. 'heal', 'damage', 'quest')."),
  config: z.record(z.string(), z.unknown()).optional().describe("Custom item data (agent-defined: heal amount, damage value, quest trigger, etc.)."),
  meta: MetaField,
});

export function registerInventorySkills(registry: SkillRegistry, opts?: { inventoryManager?: InventoryManager }): { inventoryManager: InventoryManager } {
  const mgr = opts?.inventoryManager ?? new InventoryManager();

  // ---- Inventory skills (close over `mgr`) ----

  const createInventory: SkillDefinition<z.infer<typeof createInvInput>, { ok: boolean }> = {
    name: "inventory.create",
    version: "1.0.0",
    description: "Create an inventory on an entity with a slot capacity and optional type restrictions.",
    category: "inventory",
    permissions: ["inventory.configure"],
    input: createInvInput,
    output: z.object({ ok: z.boolean() }),
    handler: (input, ctx) => {
      mgr.createInventory(input.entity, input.capacity, input.typeRestrictions);
      ctx.emit("inventory.created", { entity: input.entity, capacity: input.capacity, typeRestrictions: input.typeRestrictions, ...input.meta });
      return { ok: true };
    },
  };

  const addItem: SkillDefinition<z.infer<typeof addItemInput>, { ok: boolean; slot?: number; reason?: string }> = {
    name: "inventory.add",
    version: "1.0.0",
    description: "Add an item to an inventory by definition id. Stacks with existing items if stackable; rejects items whose category is not allowed by the inventory's type restrictions (reason: 'type-restricted').",
    category: "inventory",
    permissions: ["inventory.write"],
    input: addItemInput,
    output: z.object({ ok: z.boolean(), slot: z.number().optional(), reason: z.string().optional() }),
    handler: (input, ctx) => {
      const result = mgr.addItem(input.entity, { itemId: input.itemId, quantity: input.quantity, slot: input.slot });
      if (result.ok) {
        ctx.emit("inventory.added", { entity: input.entity, itemId: input.itemId, quantity: input.quantity, slot: result.slot, ...input.meta });
      } else {
        ctx.emit("inventory.add.rejected", { entity: input.entity, itemId: input.itemId, reason: result.reason, ...input.meta });
      }
      return result;
    },
  };

  const removeItem: SkillDefinition<z.infer<typeof removeItemInput>, { ok: boolean }> = {
    name: "inventory.remove",
    version: "1.0.0",
    description: "Remove an item from an inventory by slot index or item id.",
    category: "inventory",
    permissions: ["inventory.write"],
    input: removeItemInput,
    output: z.object({ ok: z.boolean() }),
    handler: (input, ctx) => {
      const ok = mgr.removeItem(input.entity, input.itemId, input.slot, input.quantity);
      if (ok) ctx.emit("inventory.removed", { entity: input.entity, itemId: input.itemId, quantity: input.quantity, ...input.meta });
      return { ok };
    },
  };

  const listInventory: SkillDefinition<z.infer<typeof listInvInput>, { items: { itemId: string; quantity: number; slot: number; equipped: boolean }[]; equipment: { equipmentSlot: string; itemId: string; quantity: number }[] }> = {
    name: "inventory.list",
    version: "1.0.0",
    description: "List all items in an inventory with slot positions and quantities, plus the equipped items by equipment slot. Pure read.",
    category: "inventory",
    permissions: ["inventory.read"],
    input: listInvInput,
    output: z.object({
      items: z.array(z.object({ itemId: z.string(), quantity: z.number(), slot: z.number(), equipped: z.boolean() })),
      equipment: z.array(z.object({ equipmentSlot: z.string(), itemId: z.string(), quantity: z.number() })),
    }),
    handler: (input) => ({
      items: mgr.listItems(input.entity).map((s) => ({ itemId: s.itemId, quantity: s.quantity, slot: s.slot, equipped: s.equipped })),
      equipment: mgr.listEquipment(input.entity),
    }),
  };

  const countItem: SkillDefinition<z.infer<typeof countItemInput>, { count: number }> = {
    name: "inventory.count",
    version: "1.0.0",
    description: "Count how many of a specific item are in an inventory (sums across all slots). Pure read.",
    category: "inventory",
    permissions: ["inventory.read"],
    input: countItemInput,
    output: z.object({ count: z.number() }),
    handler: (input) => ({ count: mgr.countItem(input.entity, input.itemId) }),
  };

  const hasItem: SkillDefinition<z.infer<typeof hasItemInput>, { has: boolean }> = {
    name: "inventory.has",
    version: "1.0.0",
    description: "Check if an inventory contains a specific item (returns boolean). Pure read.",
    category: "inventory",
    permissions: ["inventory.read"],
    input: hasItemInput,
    output: z.object({ has: z.boolean() }),
    handler: (input) => ({ has: mgr.hasItem(input.entity, input.itemId) }),
  };

  const transferItem: SkillDefinition<z.infer<typeof transferInput>, { ok: boolean }> = {
    name: "inventory.transfer",
    version: "1.0.0",
    description: "Transfer items between two inventories (entity-to-entity). Honours the destination's type restrictions and rolls back if the destination cannot take the items (true no-op on failure).",
    category: "inventory",
    permissions: ["inventory.write"],
    input: transferInput,
    output: z.object({ ok: z.boolean() }),
    handler: (input, ctx) => {
      const ok = mgr.transferItem(input.fromEntity, input.toEntity, input.itemId, input.quantity);
      if (ok) ctx.emit("inventory.transferred", { from: input.fromEntity, to: input.toEntity, itemId: input.itemId, quantity: input.quantity, ...input.meta });
      return { ok };
    },
  };

  const equipItem: SkillDefinition<z.infer<typeof equipInput>, { ok: boolean }> = {
    name: "item.equip",
    version: "1.0.0",
    description: "Equip an item from the inventory into a named equipment slot (moves one unit out of the inventory slots into the equipment slot).",
    category: "inventory",
    permissions: ["inventory.write"],
    input: equipInput,
    output: z.object({ ok: z.boolean() }),
    handler: (input, ctx) => {
      const ok = mgr.equipItem(input.entity, input.itemId, input.equipmentSlot);
      if (ok) ctx.emit("item.equipped", { entity: input.entity, itemId: input.itemId, equipmentSlot: input.equipmentSlot, ...input.meta });
      return { ok };
    },
  };

  const unequipItem: SkillDefinition<z.infer<typeof unequipInput>, { ok: boolean }> = {
    name: "item.unequip",
    version: "1.0.0",
    description: "Unequip the item in a named equipment slot back into the inventory (rolls back if there is no free inventory slot).",
    category: "inventory",
    permissions: ["inventory.write"],
    input: unequipInput,
    output: z.object({ ok: z.boolean() }),
    handler: (input, ctx) => {
      const ok = mgr.unequipItem(input.entity, input.equipmentSlot);
      if (ok) ctx.emit("item.unequipped", { entity: input.entity, equipmentSlot: input.equipmentSlot, ...input.meta });
      return { ok };
    },
  };

  // ---- Item skills (close over `mgr`) ----

  const defineItem: SkillDefinition<z.infer<typeof defineItemInput>, { ok: boolean }> = {
    name: "item.define",
    version: "1.0.0",
    description: "Define an item type with name, description, stackability, weight, category, usage behavior, and custom config data.",
    category: "inventory",
    permissions: ["item.configure"],
    input: defineItemInput,
    output: z.object({ ok: z.boolean() }),
    handler: (input, ctx) => {
      mgr.defineItem({
        id: input.id,
        name: input.name,
        description: input.description,
        icon: input.icon,
        stackable: input.stackable,
        maxStack: input.maxStack,
        weight: input.weight,
        category: input.category,
        config: input.config ?? {},
        usageBehavior: input.usageBehavior,
      });
      ctx.emit("item.defined", { id: input.id, name: input.name, category: input.category, ...input.meta });
      return { ok: true };
    },
  };

  registry.register(createInventory);
  registry.register(addItem);
  registry.register(removeItem);
  registry.register(listInventory);
  registry.register(countItem);
  registry.register(hasItem);
  registry.register(transferItem);
  registry.register(equipItem);
  registry.register(unequipItem);
  registry.register(defineItem);

  return { inventoryManager: mgr };
}
