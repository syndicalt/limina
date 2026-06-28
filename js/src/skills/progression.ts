// progression.* skills — XP, leveling, unlocks, skill trees, and meta-progression.
// All inputs accept optional `meta` for agent-supplied extension data.
//
// CLOSURE PATTERN (like terrain.ts): the SkillDefinitions are defined INSIDE
// registerProgressionSkills so their handlers close over the ONE ProgressionManager
// the registry owns. (The earlier cut read a never-set `world.progressionManager`,
// so every handler no-oped.) DETERMINISM: the manager is pure — level is computed
// from XP via an injected `xpCurve` (Math.pow only, no clock/RNG), so a replay that
// reconstructs the manager with the SAME default curve recomputes bit-identically.

import { z } from "../../build/zod.bundle.mjs";
import type { SkillDefinition, SkillRegistry } from "./registry.ts";

const MetaField = z.record(z.string(), z.unknown()).optional().describe("Agent-supplied extension metadata.");

export interface ProgressionData {
  xp: number;
  level: number;
  xpToNext: number;
  unlocked: Set<string>;
  skillPoints: number;
  allocated: Map<string, number>;
}

/** A data-driven action attached via progression.onLevelUp and FIRED (emitted) each
 *  time the entity gains a level in the progression.xp grant path. */
export interface LevelUpAction {
  type: string;
  data: Record<string, unknown>;
}

/** One level newly reached during an addXP grant, with the actions that fired for it. */
export interface LevelUpEvent {
  level: number;
  actions: LevelUpAction[];
}

export interface SkillTreeNode {
  id: string;
  name: string;
  description: string;
  prerequisites: string[];
  cost: number;
  maxLevel: number;
  effects: Record<string, unknown>;
  config?: Record<string, unknown>;
}

export interface SkillTree {
  id: string;
  name: string;
  nodes: Map<string, SkillTreeNode>;
  config?: Record<string, unknown>;
}

export class ProgressionManager {
  private readonly progression = new Map<string, ProgressionData>();
  private readonly skillTrees = new Map<string, SkillTree>();
  /** Per-entity level-up action hooks, registered by progression.onLevelUp and fired
   *  (returned to the xp skill to emit) on each level gained. Deterministic: the hook
   *  list is rebuilt by re-invoking the recorded onLevelUp skill calls on replay. */
  private readonly levelUpActions = new Map<string, LevelUpAction[]>();
  private readonly xpCurve: (level: number) => number;

  constructor(opts?: { xpCurve?: (level: number) => number }) {
    this.xpCurve = opts?.xpCurve ?? ((level: number) => 100 * Math.pow(1.5, level - 1));
  }

  getOrCreate(entity: string): ProgressionData {
    if (!this.progression.has(entity)) {
      this.progression.set(entity, { xp: 0, level: 1, xpToNext: this.xpCurve(1), unlocked: new Set(), skillPoints: 0, allocated: new Map() });
    }
    return this.progression.get(entity)!;
  }

  /** Attach a data-driven action to fire when `entity` levels up. */
  registerLevelUpAction(entity: string, action: LevelUpAction): void {
    if (!this.levelUpActions.has(entity)) this.levelUpActions.set(entity, []);
    this.levelUpActions.get(entity)!.push(action);
  }

  /** The actions currently registered for `entity` (defensive copy). */
  levelUpActionsOf(entity: string): LevelUpAction[] {
    return [...(this.levelUpActions.get(entity) ?? [])];
  }

  /** Grant XP and auto-level via the curve. Returns the new state AND the level-up
   *  events (one per level crossed, each carrying the registered actions to fire) so
   *  the xp skill can EMIT them — the manager stays free of the tracer/clock. */
  addXP(entity: string, amount: number): { leveledUp: boolean; newLevel: number; xp: number; xpToNext: number; levelUps: LevelUpEvent[] } {
    const data = this.getOrCreate(entity);
    data.xp += amount;
    const levelUps: LevelUpEvent[] = [];
    while (data.xp >= data.xpToNext) {
      data.xp -= data.xpToNext;
      data.level++;
      data.xpToNext = this.xpCurve(data.level);
      data.skillPoints++;
      levelUps.push({ level: data.level, actions: this.levelUpActionsOf(entity) });
    }
    return { leveledUp: levelUps.length > 0, newLevel: data.level, xp: data.xp, xpToNext: data.xpToNext, levelUps };
  }

  getLevel(entity: string): number {
    return this.getOrCreate(entity).level;
  }

  unlock(entity: string, id: string): boolean {
    const data = this.getOrCreate(entity);
    if (data.unlocked.has(id)) return false;
    data.unlocked.add(id);
    return true;
  }

  isUnlocked(entity: string, id: string): boolean {
    return this.getOrCreate(entity).unlocked.has(id);
  }

  defineSkillTree(tree: SkillTree): void {
    this.skillTrees.set(tree.id, tree);
  }

  getSkillTree(id: string): SkillTree | undefined {
    return this.skillTrees.get(id);
  }

  allocatePoint(entity: string, treeId: string, nodeId: string): boolean {
    const tree = this.skillTrees.get(treeId);
    if (tree === undefined) return false;
    const node = tree.nodes.get(nodeId);
    if (node === undefined) return false;
    const data = this.getOrCreate(entity);
    if (data.skillPoints < node.cost) return false;

    // Prerequisites: each named prereq node must be fully allocated (at its maxLevel)
    // before this node can be allocated. No fake success — a missing/under-invested
    // prereq blocks the allocation.
    for (const prereq of node.prerequisites) {
      const allocated = data.allocated.get(prereq) ?? 0;
      const prereqNode = tree.nodes.get(prereq);
      if (prereqNode !== undefined && allocated < prereqNode.maxLevel) return false;
    }

    const currentAllocated = data.allocated.get(nodeId) ?? 0;
    if (currentAllocated >= node.maxLevel) return false;

    data.skillPoints -= node.cost;
    data.allocated.set(nodeId, currentAllocated + 1);
    return true;
  }

  /** Deterministic, serialized snapshot of ALL manager state (sorted keys/entries),
   *  so a replay's manager can be compared bit-identically to the authoring run. */
  snapshot(): string {
    const entities = [...this.progression.keys()].sort();
    const prog = entities.map((entity) => {
      const d = this.progression.get(entity)!;
      return {
        entity,
        xp: d.xp,
        level: d.level,
        xpToNext: d.xpToNext,
        skillPoints: d.skillPoints,
        unlocked: [...d.unlocked].sort(),
        allocated: [...d.allocated.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)),
      };
    });
    const hooks = [...this.levelUpActions.keys()].sort().map((entity) => ({ entity, actions: this.levelUpActions.get(entity)! }));
    return JSON.stringify({ prog, hooks });
  }
}

const addXPInput = z.object({
  entity: z.string(),
  amount: z.number().int().min(1).describe("XP amount to grant."),
  meta: MetaField,
});
const levelUpEventSchema = z.object({ level: z.number().int(), actions: z.array(z.object({ type: z.string(), data: z.record(z.string(), z.unknown()) })) });
const addXPOutput = z.object({ leveledUp: z.boolean(), newLevel: z.number(), xp: z.number(), xpToNext: z.number(), levelUps: z.array(levelUpEventSchema) });

const getLevelInput = z.object({ entity: z.string(), meta: MetaField });

const onLevelUpInput = z.object({
  entity: z.string(),
  action: z.object({ type: z.string(), data: z.record(z.string(), z.unknown()) }).describe("Action to execute on level up (grant stat points, unlock abilities, etc.)."),
  meta: MetaField,
});

const unlockInput = z.object({
  entity: z.string(),
  id: z.string().min(1).describe("Ability, area, item, or skill id to unlock."),
  meta: MetaField,
});

const isUnlockedInput = z.object({ entity: z.string(), id: z.string().min(1), meta: MetaField });

const defineSkillTreeInput = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  nodes: z.array(z.object({
    id: z.string(),
    name: z.string(),
    description: z.string().default(""),
    prerequisites: z.array(z.string()).default([]).describe("Node ids that must be unlocked before this node."),
    cost: z.number().int().min(1).default(1).describe("Skill point cost."),
    maxLevel: z.number().int().min(1).default(1).describe("Maximum allocation level for this node."),
    effects: z.record(z.string(), z.unknown()).describe("Effects granted when this node is allocated (stat bonuses, abilities, etc.)."),
    config: z.record(z.string(), z.unknown()).optional(),
  })).min(1).describe("Nodes in the skill tree."),
  config: z.record(z.string(), z.unknown()).optional(),
  meta: MetaField,
});

const allocateInput = z.object({
  entity: z.string(),
  treeId: z.string(),
  nodeId: z.string(),
  meta: MetaField,
});

export function registerProgressionSkills(registry: SkillRegistry, opts?: { progressionManager?: ProgressionManager }): { progressionManager: ProgressionManager } {
  const mgr = opts?.progressionManager ?? new ProgressionManager();

  const addXP: SkillDefinition<z.infer<typeof addXPInput>, z.infer<typeof addXPOutput>> = {
    name: "progression.xp",
    version: "1.0.0",
    description: "Grant XP to an entity. Auto-levels up when the XP threshold is reached and FIRES any attached onLevelUp actions (one progression.levelUp event per level gained).",
    category: "progression",
    permissions: ["progression.write"],
    input: addXPInput,
    output: addXPOutput,
    handler: (input, ctx) => {
      const result = mgr.addXP(input.entity, input.amount);
      ctx.emit("progression.xp", { entity: input.entity, amount: input.amount, ...input.meta, leveledUp: result.leveledUp, newLevel: result.newLevel, xp: result.xp, xpToNext: result.xpToNext });
      // FIRE the stored level-up actions: one event per level crossed, carrying the
      // descriptors attached via progression.onLevelUp.
      for (const ev of result.levelUps) {
        ctx.emit("progression.levelUp", { entity: input.entity, level: ev.level, actions: ev.actions });
      }
      return result;
    },
  };

  const getLevel: SkillDefinition<z.infer<typeof getLevelInput>, { level: number; xp: number; xpToNext: number }> = {
    name: "progression.level",
    version: "1.0.0",
    description: "Get an entity's current level and XP progress (computed from the XP curve). Pure read — does not emit.",
    category: "progression",
    permissions: ["progression.read"],
    input: getLevelInput,
    output: z.object({ level: z.number(), xp: z.number(), xpToNext: z.number() }),
    handler: (input) => {
      const data = mgr.getOrCreate(input.entity);
      return { level: data.level, xp: data.xp, xpToNext: data.xpToNext };
    },
  };

  const onLevelUp: SkillDefinition<z.infer<typeof onLevelUpInput>, { ok: boolean }> = {
    name: "progression.onLevelUp",
    version: "1.0.0",
    description: "Attach a data-driven action to execute when an entity levels up. The action is STORED and re-fired by progression.xp on every subsequent level gain.",
    category: "progression",
    permissions: ["progression.configure"],
    input: onLevelUpInput,
    output: z.object({ ok: z.boolean() }),
    handler: (input, ctx) => {
      mgr.registerLevelUpAction(input.entity, { type: input.action.type, data: input.action.data });
      ctx.emit("progression.onLevelUp.attached", { entity: input.entity, actionType: input.action.type, ...input.meta });
      return { ok: true };
    },
  };

  const unlock: SkillDefinition<z.infer<typeof unlockInput>, { ok: boolean; newlyUnlocked: boolean }> = {
    name: "progression.unlock",
    version: "1.0.0",
    description: "Unlock an ability, area, item, or skill for an entity.",
    category: "progression",
    permissions: ["progression.write"],
    input: unlockInput,
    output: z.object({ ok: z.boolean(), newlyUnlocked: z.boolean() }),
    handler: (input, ctx) => {
      const newlyUnlocked = mgr.unlock(input.entity, input.id);
      ctx.emit("progression.unlocked", { entity: input.entity, id: input.id, newlyUnlocked, ...input.meta });
      return { ok: true, newlyUnlocked };
    },
  };

  const isUnlocked: SkillDefinition<z.infer<typeof isUnlockedInput>, { unlocked: boolean }> = {
    name: "progression.isUnlocked",
    version: "1.0.0",
    description: "Check if an ability, area, item, or skill is unlocked for an entity. Pure read — does not emit.",
    category: "progression",
    permissions: ["progression.read"],
    input: isUnlockedInput,
    output: z.object({ unlocked: z.boolean() }),
    handler: (input) => ({ unlocked: mgr.isUnlocked(input.entity, input.id) }),
  };

  const defineSkillTree: SkillDefinition<z.infer<typeof defineSkillTreeInput>, { ok: boolean }> = {
    name: "progression.skillTree",
    version: "1.0.0",
    description: "Define a skill/ability tree with prerequisites, costs, max levels, and effects. Fully data-driven.",
    category: "progression",
    permissions: ["progression.configure"],
    input: defineSkillTreeInput,
    output: z.object({ ok: z.boolean() }),
    handler: (input, ctx) => {
      const nodes = new Map(input.nodes.map((n) => [n.id, { id: n.id, name: n.name, description: n.description, prerequisites: n.prerequisites, cost: n.cost, maxLevel: n.maxLevel, effects: n.effects, config: n.config }]));
      mgr.defineSkillTree({ id: input.id, name: input.name, nodes, config: input.config });
      ctx.emit("progression.skillTree.defined", { id: input.id, name: input.name, nodes: input.nodes.length, ...input.meta });
      return { ok: true };
    },
  };

  const allocate: SkillDefinition<z.infer<typeof allocateInput>, { ok: boolean }> = {
    name: "progression.allocate",
    version: "1.0.0",
    description: "Allocate a progression point to a node in a skill tree. Enforces prerequisites and skill-point cost — a blocked allocation returns ok:false (no fake success).",
    category: "progression",
    permissions: ["progression.write"],
    input: allocateInput,
    output: z.object({ ok: z.boolean() }),
    handler: (input, ctx) => {
      const ok = mgr.allocatePoint(input.entity, input.treeId, input.nodeId);
      ctx.emit("progression.allocated", { entity: input.entity, treeId: input.treeId, nodeId: input.nodeId, ok, ...input.meta });
      return { ok };
    },
  };

  registry.register(addXP);
  registry.register(getLevel);
  registry.register(onLevelUp);
  registry.register(unlock);
  registry.register(isUnlocked);
  registry.register(defineSkillTree);
  registry.register(allocate);

  return { progressionManager: mgr };
}
