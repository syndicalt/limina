// quest.* skills — quest and objective system.
// All inputs accept optional `meta` for agent-supplied extension data.
//
// DETERMINISM: every lifecycle tick stamped onto quest state (offeredTick /
// acceptedTick / completedTick / failedTick) comes from ctx.tick — never wall
// clock — so a recorded session replays bit-identically (replay re-invokes each
// skill with the same recorded tick). The skill definitions close over the
// QuestManager built in registerQuestSkills (no `ctx.world` cast), so a fresh
// replay registry gets its own manager and rebuilds state from the command log.

import { z } from "../../build/zod.bundle.mjs";
import type { SkillDefinition, SkillRegistry } from "./registry.ts";

const MetaField = z.record(z.string(), z.unknown()).optional().describe("Agent-supplied extension metadata.");

export interface QuestObjective {
  id: string;
  type: "kill" | "collect" | "reach" | "talk" | "custom";
  description: string;
  target?: string;
  required: number;
  progress: number;
  completed: boolean;
  config?: Record<string, unknown>;
}

export interface QuestDef {
  id: string;
  name: string;
  description: string;
  prerequisites: string[];
  objectives: QuestObjective[];
  rewards: Record<string, unknown>;
  followUpQuests: string[];
  config?: Record<string, unknown>;
}

export interface QuestInstance {
  questId: string;
  entity: string;
  status: "available" | "active" | "completed" | "failed";
  objectives: { id: string; progress: number; completed: boolean }[];
  tracked: boolean;
  offeredTick?: number;
  acceptedTick?: number;
  completedTick?: number;
  failedTick?: number;
}

export class QuestManager {
  private readonly definitions = new Map<string, QuestDef>();
  private readonly instances = new Map<string, QuestInstance[]>(); // entity -> quests

  define(def: QuestDef): void {
    this.definitions.set(def.id, def);
  }

  getDefinition(id: string): QuestDef | undefined {
    return this.definitions.get(id);
  }

  getInstance(entity: string, questId: string): QuestInstance | undefined {
    return this.instances.get(entity)?.find((q) => q.questId === questId);
  }

  /** Offer a quest to an entity (status "available"). `tick` stamps offeredTick. */
  offer(entity: string, questId: string, tick: number): boolean {
    const def = this.definitions.get(questId);
    if (def === undefined) return false;
    if (!this.instances.has(entity)) this.instances.set(entity, []);
    const list = this.instances.get(entity)!;
    if (list.some((q) => q.questId === questId)) return false;
    list.push({
      questId,
      entity,
      status: "available",
      objectives: def.objectives.map((o) => ({ id: o.id, progress: 0, completed: false })),
      tracked: false,
      offeredTick: tick,
    });
    return true;
  }

  /** Accept an offered quest (available -> active). `tick` stamps acceptedTick. */
  accept(entity: string, questId: string, tick: number): boolean {
    const q = this.instances.get(entity)?.find((q) => q.questId === questId && q.status === "available");
    if (q === undefined) return false;
    q.status = "active";
    q.acceptedTick = tick;
    return true;
  }

  decline(entity: string, questId: string): boolean {
    const quests = this.instances.get(entity);
    if (quests === undefined) return false;
    const idx = quests.findIndex((q) => q.questId === questId && q.status === "available");
    if (idx === -1) return false;
    quests.splice(idx, 1);
    return true;
  }

  /** Advance an objective's progress; mark it complete at/above its required count.
   *  When ALL objectives are complete the quest auto-completes — completedTick is
   *  stamped from `tick` (ctx.tick), never wall clock. Returns the objective + quest
   *  completion flags so the skill can surface rewards on the auto-complete path. */
  updateProgress(
    entity: string,
    questId: string,
    objectiveId: string,
    progress: number,
    tick: number,
  ): { ok: boolean; objectiveCompleted: boolean; questCompleted: boolean } {
    const q = this.instances.get(entity)?.find((q) => q.questId === questId && q.status === "active");
    if (q === undefined) return { ok: false, objectiveCompleted: false, questCompleted: false };
    const obj = q.objectives.find((o) => o.id === objectiveId);
    if (obj === undefined) return { ok: false, objectiveCompleted: false, questCompleted: false };
    obj.progress = progress;
    const defObj = this.definitions.get(questId)?.objectives.find((o) => o.id === objectiveId);
    if (defObj !== undefined && obj.progress >= defObj.required) obj.completed = true;
    let questCompleted = false;
    if (q.objectives.every((o) => o.completed)) {
      q.status = "completed";
      q.completedTick = tick;
      questCompleted = true;
    }
    return { ok: true, objectiveCompleted: obj.completed, questCompleted };
  }

  /** Explicitly complete an ACTIVE quest. Only succeeds when every objective is
   *  satisfied, unless `force` is set (which also marks the objectives complete).
   *  completedTick is stamped from `tick` (ctx.tick). A quest already completed via
   *  updateProgress is no longer active, so this returns { ok:false } (no double
   *  completion). */
  complete(entity: string, questId: string, tick: number, force: boolean): { ok: boolean; completed: boolean } {
    const q = this.instances.get(entity)?.find((q) => q.questId === questId && q.status === "active");
    if (q === undefined) return { ok: false, completed: false };
    const satisfied = q.objectives.every((o) => o.completed);
    if (!satisfied && !force) return { ok: false, completed: false };
    if (force) for (const o of q.objectives) o.completed = true;
    q.status = "completed";
    q.completedTick = tick;
    return { ok: true, completed: true };
  }

  /** Fail an offered/active quest. `tick` stamps failedTick. */
  fail(entity: string, questId: string, tick: number): boolean {
    const q = this.instances.get(entity)?.find((q) => q.questId === questId && (q.status === "active" || q.status === "available"));
    if (q === undefined) return false;
    q.status = "failed";
    q.failedTick = tick;
    return true;
  }

  list(entity: string, status?: "available" | "active" | "completed" | "failed"): QuestInstance[] {
    const quests = this.instances.get(entity) ?? [];
    return status !== undefined ? quests.filter((q) => q.status === status) : quests;
  }

  track(entity: string, questId: string): boolean {
    const quests = this.instances.get(entity);
    if (quests === undefined) return false;
    const q = quests.find((q) => q.questId === questId);
    if (q === undefined) return false;
    // Untrack all others only once we know the target exists.
    for (const other of quests) other.tracked = false;
    q.tracked = true;
    return true;
  }
}

// ───────────────────────────── input schemas (pure) ─────────────────────────────

const defineQuestInput = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().default(""),
  prerequisites: z.array(z.string()).default([]).describe("Quest ids that must be completed before this quest is offered."),
  objectives: z.array(z.object({
    id: z.string(),
    type: z.enum(["kill", "collect", "reach", "talk", "custom"]).describe("Objective type."),
    description: z.string(),
    target: z.string().optional().describe("Target entity id, item id, location name, etc."),
    required: z.number().int().min(1).default(1).describe("Required count or threshold."),
    config: z.record(z.string(), z.unknown()).optional().describe("Custom objective data (agent-defined behavior parameters)."),
  })).min(1).describe("Quest objectives."),
  rewards: z.record(z.string(), z.unknown()).default({}).describe("Quest rewards (items, xp, currency, flags, etc.)."),
  followUpQuests: z.array(z.string()).default([]).describe("Quest ids to offer upon completion."),
  config: z.record(z.string(), z.unknown()).optional().describe("Custom quest configuration data."),
  meta: MetaField,
});

const offerQuestInput = z.object({
  entity: z.string(),
  questId: z.string(),
  meta: MetaField,
});

const updateQuestInput = z.object({
  entity: z.string(),
  questId: z.string(),
  objectiveId: z.string(),
  progress: z.number().int().min(0).describe("New progress value."),
  meta: MetaField,
});

const completeQuestInput = z.object({
  entity: z.string(),
  questId: z.string(),
  force: z.boolean().default(false).describe("Complete even if objectives are unsatisfied (marks them complete)."),
  meta: MetaField,
});

const failQuestInput = z.object({
  entity: z.string(),
  questId: z.string(),
  meta: MetaField,
});

const listQuestsInput = z.object({
  entity: z.string(),
  status: z.enum(["available", "active", "completed", "failed"]).optional().describe("Filter by status. If omitted, returns all."),
  meta: MetaField,
});

const trackQuestInput = z.object({
  entity: z.string(),
  questId: z.string(),
  meta: MetaField,
});

// Reusable reward/follow-up shapes (recorded/emitted on completion — never silently dropped).
const rewardsField = z.record(z.string(), z.unknown());
const followUpField = z.array(z.string());

export function registerQuestSkills(registry: SkillRegistry, opts?: { questManager?: QuestManager }): { questManager: QuestManager } {
  // The skills close over THIS manager — no `(ctx.world as ...).questManager` cast,
  // so the manager is always present and a fresh replay registry rebuilds its own.
  const mgr = opts?.questManager ?? new QuestManager();

  const defineQuest: SkillDefinition<z.infer<typeof defineQuestInput>, { ok: boolean }> = {
    name: "quest.define",
    version: "1.0.0",
    description: "Define a quest with name, description, objectives, prerequisites, rewards, and follow-up quests. Objectives support custom types via config.",
    category: "quest",
    permissions: ["quest.configure"],
    input: defineQuestInput,
    output: z.object({ ok: z.boolean() }),
    handler: (input, ctx) => {
      mgr.define({
        id: input.id,
        name: input.name,
        description: input.description,
        prerequisites: input.prerequisites,
        objectives: input.objectives.map((o) => ({ id: o.id, type: o.type, description: o.description, target: o.target, required: o.required, progress: 0, completed: false, config: o.config })),
        rewards: input.rewards,
        followUpQuests: input.followUpQuests,
        config: input.config,
      });
      ctx.emit("quest.defined", { id: input.id, name: input.name, objectives: input.objectives.length, ...input.meta });
      return { ok: true };
    },
  };

  const offerQuest: SkillDefinition<z.infer<typeof offerQuestInput>, { ok: boolean }> = {
    name: "quest.offer",
    version: "1.0.0",
    description: "Offer a quest to a player entity. Quest appears in their quest log as available.",
    category: "quest",
    permissions: ["quest.write"],
    input: offerQuestInput,
    output: z.object({ ok: z.boolean() }),
    handler: (input, ctx) => {
      const ok = mgr.offer(input.entity, input.questId, ctx.tick);
      ctx.emit("quest.offered", { entity: input.entity, questId: input.questId, ok, offeredTick: ok ? ctx.tick : undefined, ...input.meta });
      return { ok };
    },
  };

  const acceptQuest: SkillDefinition<z.infer<typeof offerQuestInput>, { ok: boolean }> = {
    name: "quest.accept",
    version: "1.0.0",
    description: "Accept an offered quest (moves it from available to active).",
    category: "quest",
    permissions: ["quest.write"],
    input: offerQuestInput,
    output: z.object({ ok: z.boolean() }),
    handler: (input, ctx) => {
      const ok = mgr.accept(input.entity, input.questId, ctx.tick);
      ctx.emit("quest.accepted", { entity: input.entity, questId: input.questId, ok, acceptedTick: ok ? ctx.tick : undefined, ...input.meta });
      return { ok };
    },
  };

  const declineQuest: SkillDefinition<z.infer<typeof offerQuestInput>, { ok: boolean }> = {
    name: "quest.decline",
    version: "1.0.0",
    description: "Decline an offered quest (removes it from the quest log).",
    category: "quest",
    permissions: ["quest.write"],
    input: offerQuestInput,
    output: z.object({ ok: z.boolean() }),
    handler: (input, ctx) => {
      const ok = mgr.decline(input.entity, input.questId);
      ctx.emit("quest.declined", { entity: input.entity, questId: input.questId, ok, ...input.meta });
      return { ok };
    },
  };

  const updateQuest: SkillDefinition<
    z.infer<typeof updateQuestInput>,
    { ok: boolean; completed: boolean; questCompleted: boolean; rewards: Record<string, unknown>; followUpQuests: string[] }
  > = {
    name: "quest.update",
    version: "1.0.0",
    description: "Update progress on a quest objective. Marks the objective complete at its required count and auto-completes the quest when all objectives are satisfied (stamping completedTick from the current tick). Surfaces rewards/follow-up quests when the quest completes.",
    category: "quest",
    permissions: ["quest.write"],
    input: updateQuestInput,
    output: z.object({ ok: z.boolean(), completed: z.boolean(), questCompleted: z.boolean(), rewards: rewardsField, followUpQuests: followUpField }),
    handler: (input, ctx) => {
      const res = mgr.updateProgress(input.entity, input.questId, input.objectiveId, input.progress, ctx.tick);
      const def = mgr.getDefinition(input.questId);
      const rewards = res.questCompleted ? (def?.rewards ?? {}) : {};
      const followUpQuests = res.questCompleted ? (def?.followUpQuests ?? []) : [];
      ctx.emit("quest.updated", {
        entity: input.entity, questId: input.questId, objectiveId: input.objectiveId,
        progress: input.progress, completed: res.objectiveCompleted, questCompleted: res.questCompleted, ...input.meta,
      });
      // Auto-complete path: record/emit rewards + follow-ups so they are never silently dropped.
      if (res.questCompleted) {
        ctx.emit("quest.completed", { entity: input.entity, questId: input.questId, rewards, followUpQuests, completedTick: ctx.tick, ...input.meta });
      }
      return { ok: res.ok, completed: res.objectiveCompleted, questCompleted: res.questCompleted, rewards, followUpQuests };
    },
  };

  const completeQuest: SkillDefinition<
    z.infer<typeof completeQuestInput>,
    { ok: boolean; rewards: Record<string, unknown>; followUpQuests: string[] }
  > = {
    name: "quest.complete",
    version: "1.0.0",
    description: "Mark an active quest complete (only when its objectives are satisfied, or with force). Stamps completedTick from the current tick and records/emits its rewards and follow-up quests.",
    category: "quest",
    permissions: ["quest.write"],
    input: completeQuestInput,
    output: z.object({ ok: z.boolean(), rewards: rewardsField, followUpQuests: followUpField }),
    handler: (input, ctx) => {
      const res = mgr.complete(input.entity, input.questId, ctx.tick, input.force);
      const def = mgr.getDefinition(input.questId);
      const rewards = res.ok ? (def?.rewards ?? {}) : {};
      const followUpQuests = res.ok ? (def?.followUpQuests ?? []) : [];
      ctx.emit("quest.completed", {
        entity: input.entity, questId: input.questId, ok: res.ok,
        rewards, followUpQuests, completedTick: res.ok ? ctx.tick : undefined, ...input.meta,
      });
      return { ok: res.ok, rewards, followUpQuests };
    },
  };

  const failQuest: SkillDefinition<z.infer<typeof failQuestInput>, { ok: boolean }> = {
    name: "quest.fail",
    version: "1.0.0",
    description: "Mark a quest as failed.",
    category: "quest",
    permissions: ["quest.write"],
    input: failQuestInput,
    output: z.object({ ok: z.boolean() }),
    handler: (input, ctx) => {
      const ok = mgr.fail(input.entity, input.questId, ctx.tick);
      ctx.emit("quest.failed", { entity: input.entity, questId: input.questId, ok, failedTick: ok ? ctx.tick : undefined, ...input.meta });
      return { ok };
    },
  };

  const listQuests: SkillDefinition<
    z.infer<typeof listQuestsInput>,
    { quests: { questId: string; status: string; objectives: { id: string; progress: number; completed: boolean }[]; tracked: boolean; offeredTick?: number; acceptedTick?: number; completedTick?: number; failedTick?: number }[] }
  > = {
    name: "quest.list",
    version: "1.0.0",
    description: "List quests for an entity (active, completed, failed, available), optionally filtered by status.",
    category: "quest",
    permissions: ["quest.read"],
    input: listQuestsInput,
    output: z.object({
      quests: z.array(z.object({
        questId: z.string(), status: z.string(),
        objectives: z.array(z.object({ id: z.string(), progress: z.number(), completed: z.boolean() })),
        tracked: z.boolean(),
        offeredTick: z.number().optional(), acceptedTick: z.number().optional(),
        completedTick: z.number().optional(), failedTick: z.number().optional(),
      })),
    }),
    // Pure read — no ctx.emit.
    handler: (input) => ({
      quests: mgr.list(input.entity, input.status).map((q) => ({
        questId: q.questId, status: q.status, objectives: q.objectives, tracked: q.tracked,
        offeredTick: q.offeredTick, acceptedTick: q.acceptedTick, completedTick: q.completedTick, failedTick: q.failedTick,
      })),
    }),
  };

  const trackQuest: SkillDefinition<z.infer<typeof trackQuestInput>, { ok: boolean }> = {
    name: "quest.track",
    version: "1.0.0",
    description: "Set a quest as tracked — shows its objectives on the HUD. Untracks all other quests for the entity.",
    category: "quest",
    permissions: ["quest.write"],
    input: trackQuestInput,
    output: z.object({ ok: z.boolean() }),
    handler: (input, ctx) => {
      const ok = mgr.track(input.entity, input.questId);
      ctx.emit("quest.tracked", { entity: input.entity, questId: input.questId, ok, ...input.meta });
      return { ok };
    },
  };

  registry.register(defineQuest);
  registry.register(offerQuest);
  registry.register(acceptQuest);
  registry.register(declineQuest);
  registry.register(updateQuest);
  registry.register(completeQuest);
  registry.register(failQuest);
  registry.register(listQuests);
  registry.register(trackQuest);

  return { questManager: mgr };
}
