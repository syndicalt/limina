// behavior.*, npc.*, and dialogue.* skills — NPC behavior, memory, attitude, and dialogue.
// All inputs accept optional `meta` for agent-supplied extension data.
//
// PLUGGABLE BRAIN: these skills are the BODY/STRUCTURE seam, never the brain. They store
// agent-authored profiles/goals/reactions/routines/memories/attitudes and replay them
// deterministically; the actual NPC decisions come from an external decision provider that
// reads this state (npc.recall, dialogue.get, getReactions, …). No AI / decision logic lives
// here — it is pure data storage + traversal.
//
// DETERMINISM: nothing here reads wall-clock or randomness. Memory facts and goal ids are
// stamped from `ctx.tick` (the recorded skill tick), so a record→replay re-invoke recomputes
// bit-identical manager state. The skill definitions are built INSIDE
// registerBehaviorDialogueSkills, closing over the managers that the same call returns — so a
// fresh replay registry rebuilds its state by re-invoking the recorded skills.

import { z } from "../../build/zod.bundle.mjs";
import type { SkillDefinition, SkillRegistry } from "./registry.ts";

const Vec3 = z.tuple([z.number(), z.number(), z.number()]);
const MetaField = z.record(z.string(), z.unknown()).optional().describe("Agent-supplied extension metadata.");

// ---- NPC Behavior ----

export interface BehaviorProfile {
  id: string;
  name: string;
  routines: BehaviorRoutine[];
  reactions: BehaviorReaction[];
  goals: BehaviorGoal[];
  config?: Record<string, unknown>;
}

export interface BehaviorRoutine {
  id: string;
  name: string;
  schedule: { hour: number; action: string; target?: string; position?: [number, number, number] }[];
  config?: Record<string, unknown>;
}

export interface BehaviorReaction {
  trigger: string; // event name or condition
  action: { type: string; data: Record<string, unknown> };
  priority: number;
  cooldown?: number;
  config?: Record<string, unknown>;
}

export interface BehaviorGoal {
  id: string;
  type: "patrol" | "follow" | "flee" | "guard" | "interact" | "custom";
  target?: string;
  position?: [number, number, number];
  priority: number;
  config?: Record<string, unknown>;
}

export interface NPCMemory {
  id: string;
  entity: string;
  facts: { key: string; value: unknown; tick: number; source?: string }[];
  relationships: Map<string, "friendly" | "neutral" | "hostile">;
}

export interface DialogueNode {
  id: string;
  text: string;
  speaker: string;
  mood?: string;
  choices: { text: string; nextNodeId: string; condition?: string; effects?: Record<string, unknown> }[];
  effects?: Record<string, unknown>;
  config?: Record<string, unknown>;
}

export interface DialogueTree {
  id: string;
  name: string;
  nodes: Map<string, DialogueNode>;
  startNode: string;
  config?: Record<string, unknown>;
}

export interface DialogueSession {
  treeId: string;
  speaker: string;
  listener: string;
  currentNodeId: string;
  history: { nodeId: string; choiceIndex?: number }[];
}

export class BehaviorManager {
  private readonly profiles = new Map<string, BehaviorProfile>();
  private readonly npcMemories = new Map<string, NPCMemory>();
  private readonly assignedBehaviors = new Map<string, string>(); // entity -> profile id
  private readonly activeGoals = new Map<string, BehaviorGoal>();
  private readonly assignedRoutines = new Map<string, string>(); // entity -> routine id
  private readonly reactions = new Map<string, BehaviorReaction[]>(); // entity -> attached reactions

  defineProfile(profile: BehaviorProfile): void {
    this.profiles.set(profile.id, profile);
  }

  getProfile(id: string): BehaviorProfile | undefined {
    return this.profiles.get(id);
  }

  assignBehavior(entity: string, profileId: string): boolean {
    if (!this.profiles.has(profileId)) return false;
    this.assignedBehaviors.set(entity, profileId);
    return true;
  }

  getAssignedProfile(entity: string): BehaviorProfile | undefined {
    const profileId = this.assignedBehaviors.get(entity);
    return profileId !== undefined ? this.profiles.get(profileId) : undefined;
  }

  setGoal(entity: string, goal: BehaviorGoal): void {
    this.activeGoals.set(entity, goal);
  }

  getGoal(entity: string): BehaviorGoal | undefined {
    return this.activeGoals.get(entity);
  }

  /** Store the active routine id (from a behavior profile) for an entity. */
  setRoutine(entity: string, routineId: string): void {
    this.assignedRoutines.set(entity, routineId);
  }

  getRoutine(entity: string): string | undefined {
    return this.assignedRoutines.get(entity);
  }

  /** Attach a reaction descriptor to an entity so it can be queried/fired later. */
  addReaction(entity: string, reaction: BehaviorReaction): void {
    let list = this.reactions.get(entity);
    if (list === undefined) {
      list = [];
      this.reactions.set(entity, list);
    }
    list.push(reaction);
  }

  /** Attached reactions for an entity (insertion order); optionally filtered by trigger. */
  getReactions(entity: string, trigger?: string): BehaviorReaction[] {
    const list = this.reactions.get(entity) ?? [];
    return trigger !== undefined ? list.filter((r) => r.trigger === trigger) : list;
  }

  getMemory(entity: string): NPCMemory {
    if (!this.npcMemories.has(entity)) {
      this.npcMemories.set(entity, { id: `mem_${entity}`, entity, facts: [], relationships: new Map() });
    }
    return this.npcMemories.get(entity)!;
  }

  /** Record a fact. `tick` is the deterministic sim tick (ctx.tick), NOT wall-clock. */
  memorize(entity: string, key: string, value: unknown, tick: number, source?: string): void {
    const mem = this.getMemory(entity);
    mem.facts.push({ key, value, tick, source });
  }

  recall(entity: string, key?: string): { key: string; value: unknown; tick: number; source?: string }[] {
    const mem = this.npcMemories.get(entity);
    if (mem === undefined) return [];
    if (key !== undefined) return mem.facts.filter((f) => f.key === key);
    return mem.facts;
  }

  setAttitude(entity: string, towardEntity: string, attitude: "friendly" | "neutral" | "hostile"): void {
    const mem = this.getMemory(entity);
    mem.relationships.set(towardEntity, attitude);
  }

  getAttitude(entity: string, towardEntity: string): "friendly" | "neutral" | "hostile" {
    return this.npcMemories.get(entity)?.relationships.get(towardEntity) ?? "neutral";
  }
}

export class DialogueManager {
  private readonly trees = new Map<string, DialogueTree>();
  private readonly sessions = new Map<string, DialogueSession>();

  defineTree(tree: DialogueTree): void {
    this.trees.set(tree.id, tree);
  }

  getTree(id: string): DialogueTree | undefined {
    return this.trees.get(id);
  }

  startSession(treeId: string, speaker: string, listener: string): DialogueSession | undefined {
    const tree = this.trees.get(treeId);
    if (tree === undefined) return undefined;
    const session: DialogueSession = { treeId, speaker, listener, currentNodeId: tree.startNode, history: [] };
    this.sessions.set(`${speaker}:${listener}`, session);
    return session;
  }

  getCurrentSession(speaker: string, listener: string): DialogueSession | undefined {
    return this.sessions.get(`${speaker}:${listener}`);
  }

  choose(sessionKey: string, choiceIndex: number): { nextNodeId: string; node: DialogueNode | undefined } {
    const session = this.sessions.get(sessionKey);
    if (session === undefined) return { nextNodeId: "", node: undefined };
    const tree = this.trees.get(session.treeId);
    if (tree === undefined) return { nextNodeId: "", node: undefined };
    const currentNode = tree.nodes.get(session.currentNodeId);
    if (currentNode === undefined) return { nextNodeId: "", node: undefined };
    const choice = currentNode.choices[choiceIndex];
    if (choice === undefined) return { nextNodeId: "", node: undefined };
    session.history.push({ nodeId: session.currentNodeId, choiceIndex });
    session.currentNodeId = choice.nextNodeId;
    return { nextNodeId: choice.nextNodeId, node: tree.nodes.get(choice.nextNodeId) };
  }

  endSession(speaker: string, listener: string): boolean {
    return this.sessions.delete(`${speaker}:${listener}`);
  }
}

// ---- Input/output schemas (module-level: pure data, no manager binding) ----

const defineBehaviorInput = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  routines: z.array(z.object({
    id: z.string(),
    name: z.string(),
    schedule: z.array(z.object({
      hour: z.number().min(0).max(23),
      action: z.string().describe("Action name (patrol, work, sleep, socialize, etc.)."),
      target: z.string().optional(),
      position: Vec3.optional(),
    })),
    config: z.record(z.string(), z.unknown()).optional(),
  })).default([]),
  reactions: z.array(z.object({
    trigger: z.string().describe("Event name or condition that triggers this reaction."),
    action: z.object({ type: z.string(), data: z.record(z.string(), z.unknown()) }),
    priority: z.number().int().default(0),
    cooldown: z.number().positive().optional(),
    config: z.record(z.string(), z.unknown()).optional(),
  })).default([]),
  goals: z.array(z.object({
    id: z.string(),
    type: z.enum(["patrol", "follow", "flee", "guard", "interact", "custom"]),
    target: z.string().optional(),
    position: Vec3.optional(),
    priority: z.number().int().default(0),
    config: z.record(z.string(), z.unknown()).optional(),
  })).default([]),
  config: z.record(z.string(), z.unknown()).optional(),
  meta: MetaField,
});

const assignBehaviorInput = z.object({
  entity: z.string(),
  profileId: z.string(),
  meta: MetaField,
});

const setGoalInput = z.object({
  entity: z.string(),
  type: z.enum(["patrol", "follow", "flee", "guard", "interact", "custom"]),
  target: z.string().optional(),
  position: Vec3.optional(),
  priority: z.number().int().default(0),
  config: z.record(z.string(), z.unknown()).optional(),
  meta: MetaField,
});

const onEventBehaviorInput = z.object({
  entity: z.string(),
  trigger: z.string().describe("Event name or condition."),
  action: z.object({ type: z.string(), data: z.record(z.string(), z.unknown()) }),
  priority: z.number().int().default(0),
  cooldown: z.number().positive().optional(),
  meta: MetaField,
});

const setRoutineInput = z.object({
  entity: z.string(),
  routineId: z.string().describe("Routine id from a behavior profile."),
  meta: MetaField,
});

const memorizeInput = z.object({
  entity: z.string(),
  key: z.string().min(1).describe("Memory key (e.g. 'sawPlayer', 'heardSound', 'likedGift')."),
  value: z.unknown().describe("Memory value (any JSON-serializable data)."),
  source: z.string().optional().describe("Source of the memory (entity id, event name, etc.)."),
  meta: MetaField,
});

const recallInput = z.object({
  entity: z.string(),
  key: z.string().optional().describe("Memory key to filter by. If omitted, returns all memories."),
  meta: MetaField,
});

const setAttitudeInput = z.object({
  entity: z.string(),
  towardEntity: z.string(),
  attitude: z.enum(["friendly", "neutral", "hostile"]),
  meta: MetaField,
});

const defineDialogueInput = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  startNode: z.string().describe("Starting node id."),
  nodes: z.array(z.object({
    id: z.string(),
    text: z.string().min(1),
    speaker: z.string(),
    mood: z.string().optional().describe("Dialogue mood (affects voice, animation, bubble styling)."),
    choices: z.array(z.object({
      text: z.string(),
      nextNodeId: z.string(),
      condition: z.string().optional().describe("Condition expression for showing this choice."),
      effects: z.record(z.string(), z.unknown()).optional().describe("Effects to apply when this choice is selected."),
    })).default([]),
    effects: z.record(z.string(), z.unknown()).optional(),
    config: z.record(z.string(), z.unknown()).optional(),
  })).min(1).describe("Dialogue nodes with text, speaker, choices, and effects."),
  config: z.record(z.string(), z.unknown()).optional(),
  meta: MetaField,
});

const startDialogueInput = z.object({
  treeId: z.string(),
  speaker: z.string(),
  listener: z.string(),
  meta: MetaField,
});

const chooseDialogueInput = z.object({
  speaker: z.string(),
  listener: z.string(),
  choiceIndex: z.number().int().min(0),
  meta: MetaField,
});

const endDialogueInput = z.object({
  speaker: z.string(),
  listener: z.string(),
  meta: MetaField,
});

const getDialogueInput = z.object({
  speaker: z.string(),
  listener: z.string(),
  meta: MetaField,
});

const npcSayInput = z.object({
  speaker: z.string(),
  text: z.string().min(1).max(280),
  mood: z.string().optional().describe("Mood/tone (affects voice, animation, bubble styling)."),
  dialogueContext: z.string().optional().describe("Related dialogue tree or node id."),
  meta: MetaField,
});

const setMoodInput = z.object({
  speaker: z.string(),
  mood: z.string().describe("Mood/tone (happy, angry, sad, nervous, excited, etc.)."),
  meta: MetaField,
});

// Shared node-view shape used by the dialogue skills' outputs.
const nodeView = z.object({ id: z.string(), text: z.string(), choices: z.array(z.object({ text: z.string() })) });
type NodeView = { id: string; text: string; choices: { text: string }[] };
function viewNode(node: DialogueNode | undefined): NodeView | undefined {
  return node ? { id: node.id, text: node.text, choices: node.choices.map((c) => ({ text: c.text })) } : undefined;
}

export function registerBehaviorDialogueSkills(registry: SkillRegistry, opts?: { behaviorManager?: BehaviorManager; dialogueManager?: DialogueManager }): { behaviorManager: BehaviorManager; dialogueManager: DialogueManager } {
  const behaviorMgr = opts?.behaviorManager ?? new BehaviorManager();
  const dialogueMgr = opts?.dialogueManager ?? new DialogueManager();
  // Deterministic per-registry goal-id counter: with ctx.tick this yields stable ids that a
  // fresh replay registry (seq reset to 0, same invoke order) recomputes bit-identically.
  let goalSeq = 0;

  // ---- Behavior skills ----

  const defineBehavior: SkillDefinition<z.infer<typeof defineBehaviorInput>, { ok: boolean }> = {
    name: "behavior.define",
    version: "1.0.0",
    description: "Define a behavior profile: routines, reactions to events/triggers, and goals for an NPC type. Fully data-driven — agents define arbitrary behavior structures.",
    category: "behavior",
    permissions: ["behavior.configure"],
    input: defineBehaviorInput,
    output: z.object({ ok: z.boolean() }),
    handler: (input, ctx) => {
      behaviorMgr.defineProfile({
        id: input.id,
        name: input.name,
        routines: input.routines,
        reactions: input.reactions,
        goals: input.goals,
        config: input.config,
      });
      ctx.emit("behavior.defined", { id: input.id, name: input.name, ...input.meta });
      return { ok: true };
    },
  };

  const assignBehavior: SkillDefinition<z.infer<typeof assignBehaviorInput>, { ok: boolean }> = {
    name: "behavior.assign",
    version: "1.0.0",
    description: "Assign a behavior profile to an NPC entity.",
    category: "behavior",
    permissions: ["behavior.write"],
    input: assignBehaviorInput,
    output: z.object({ ok: z.boolean() }),
    handler: (input, ctx) => {
      const ok = behaviorMgr.assignBehavior(input.entity, input.profileId);
      ctx.emit("behavior.assigned", { entity: input.entity, profileId: input.profileId, ok, ...input.meta });
      return { ok };
    },
  };

  const setGoal: SkillDefinition<z.infer<typeof setGoalInput>, { ok: boolean; goalId: string }> = {
    name: "behavior.setGoal",
    version: "1.0.0",
    description: "Set an active goal for an NPC (patrol, follow, flee, guard, interact).",
    category: "behavior",
    permissions: ["behavior.write"],
    input: setGoalInput,
    output: z.object({ ok: z.boolean(), goalId: z.string() }),
    handler: (input, ctx) => {
      // Deterministic id: the sim tick + a per-registry sequence (NOT Date.now()), so replay
      // re-invoking this skill in the same order recomputes the identical goal id.
      const goalId = `goal_${ctx.tick}_${goalSeq++}`;
      behaviorMgr.setGoal(input.entity, { id: goalId, type: input.type, target: input.target, position: input.position, priority: input.priority, config: input.config });
      ctx.emit("behavior.goalSet", { entity: input.entity, type: input.type, goalId, ...input.meta });
      return { ok: true, goalId };
    },
  };

  const onEventBehavior: SkillDefinition<z.infer<typeof onEventBehaviorInput>, { ok: boolean }> = {
    name: "behavior.onEvent",
    version: "1.0.0",
    description: "Attach a behavior reaction to a game event or trigger (on player nearby → approach, on damage → flee). The reaction descriptor is stored on the entity so the decision provider can query and fire it.",
    category: "behavior",
    permissions: ["behavior.configure"],
    input: onEventBehaviorInput,
    output: z.object({ ok: z.boolean() }),
    handler: (input, ctx) => {
      // STORE the reaction descriptor (not emit-only) so it can be queried/fired later.
      behaviorMgr.addReaction(input.entity, { trigger: input.trigger, action: input.action, priority: input.priority, cooldown: input.cooldown });
      ctx.emit("behavior.reactionAttached", { entity: input.entity, trigger: input.trigger, actionType: input.action.type, ...input.meta });
      return { ok: true };
    },
  };

  // ---- NPC skills ----

  const setRoutine: SkillDefinition<z.infer<typeof setRoutineInput>, { ok: boolean }> = {
    name: "npc.setRoutine",
    version: "1.0.0",
    description: "Set a daily/hourly routine for an NPC (time-based position and activity schedule).",
    category: "behavior",
    permissions: ["behavior.write"],
    input: setRoutineInput,
    output: z.object({ ok: z.boolean() }),
    handler: (input, ctx) => {
      // STORE the active routine id so it can be queried by the decision provider.
      behaviorMgr.setRoutine(input.entity, input.routineId);
      ctx.emit("npc.routineSet", { entity: input.entity, routineId: input.routineId, ...input.meta });
      return { ok: true };
    },
  };

  const memorize: SkillDefinition<z.infer<typeof memorizeInput>, { ok: boolean }> = {
    name: "npc.memorize",
    version: "1.0.0",
    description: "Record a memory/fact for an NPC (saw player at X, heard sound at Y, likes/dislikes Z).",
    category: "behavior",
    permissions: ["behavior.write"],
    input: memorizeInput,
    output: z.object({ ok: z.boolean() }),
    handler: (input, ctx) => {
      // Fact tick is the deterministic sim tick (NOT wall-clock) so replay recomputes it.
      behaviorMgr.memorize(input.entity, input.key, input.value, ctx.tick, input.source);
      ctx.emit("npc.memorized", { entity: input.entity, key: input.key, source: input.source, ...input.meta });
      return { ok: true };
    },
  };

  const recall: SkillDefinition<z.infer<typeof recallInput>, { memories: { key: string; value: unknown; tick: number; source?: string }[] }> = {
    name: "npc.recall",
    version: "1.0.0",
    description: "Query an NPC's memories (for dialogue or behavior decisions).",
    category: "behavior",
    permissions: ["behavior.read"],
    input: recallInput,
    output: z.object({ memories: z.array(z.object({ key: z.string(), value: z.unknown(), tick: z.number(), source: z.string().optional() })) }),
    // Pure read: no emit.
    handler: (input) => ({ memories: behaviorMgr.recall(input.entity, input.key) }),
  };

  const setAttitude: SkillDefinition<z.infer<typeof setAttitudeInput>, { ok: boolean }> = {
    name: "npc.setAttitude",
    version: "1.0.0",
    description: "Set an NPC's attitude toward another entity (friendly, neutral, hostile). Affects dialogue and behavior.",
    category: "behavior",
    permissions: ["behavior.write"],
    input: setAttitudeInput,
    output: z.object({ ok: z.boolean() }),
    handler: (input, ctx) => {
      behaviorMgr.setAttitude(input.entity, input.towardEntity, input.attitude);
      ctx.emit("npc.attitudeSet", { entity: input.entity, toward: input.towardEntity, attitude: input.attitude, ...input.meta });
      return { ok: true };
    },
  };

  // ---- Dialogue skills ----

  const defineDialogue: SkillDefinition<z.infer<typeof defineDialogueInput>, { ok: boolean }> = {
    name: "dialogue.define",
    version: "1.0.0",
    description: "Define a dialogue tree: nodes with text, choices, conditions, and effects. Fully data-driven — agents author arbitrary dialogue structures.",
    category: "dialogue",
    permissions: ["dialogue.configure"],
    input: defineDialogueInput,
    output: z.object({ ok: z.boolean() }),
    handler: (input, ctx) => {
      const nodes = new Map(input.nodes.map((n) => [n.id, { id: n.id, text: n.text, speaker: n.speaker, mood: n.mood, choices: n.choices, effects: n.effects, config: n.config }]));
      dialogueMgr.defineTree({ id: input.id, name: input.name, nodes, startNode: input.startNode, config: input.config });
      ctx.emit("dialogue.defined", { id: input.id, name: input.name, nodes: input.nodes.length, ...input.meta });
      return { ok: true };
    },
  };

  const startDialogue: SkillDefinition<z.infer<typeof startDialogueInput>, { ok: boolean; currentNode?: NodeView }> = {
    name: "dialogue.start",
    version: "1.0.0",
    description: "Start a dialogue between two entities using a defined dialogue tree. Shows dialogue UI.",
    category: "dialogue",
    permissions: ["dialogue.write"],
    input: startDialogueInput,
    output: z.object({ ok: z.boolean(), currentNode: nodeView.optional() }),
    handler: (input, ctx) => {
      const session = dialogueMgr.startSession(input.treeId, input.speaker, input.listener);
      if (session === undefined) return { ok: false };
      const tree = dialogueMgr.getTree(input.treeId);
      const node = tree?.nodes.get(session.currentNodeId);
      ctx.emit("dialogue.started", { treeId: input.treeId, speaker: input.speaker, listener: input.listener, ...input.meta });
      return { ok: true, currentNode: viewNode(node) };
    },
  };

  const chooseDialogue: SkillDefinition<z.infer<typeof chooseDialogueInput>, { ok: boolean; node?: NodeView }> = {
    name: "dialogue.choose",
    version: "1.0.0",
    description: "Make a choice in an active dialogue. Advances the tree to the next node.",
    category: "dialogue",
    permissions: ["dialogue.write"],
    input: chooseDialogueInput,
    output: z.object({ ok: z.boolean(), node: nodeView.optional() }),
    handler: (input, ctx) => {
      const { nextNodeId, node } = dialogueMgr.choose(`${input.speaker}:${input.listener}`, input.choiceIndex);
      ctx.emit("dialogue.chosen", { speaker: input.speaker, listener: input.listener, choiceIndex: input.choiceIndex, nextNodeId, ...input.meta });
      return { ok: node !== undefined, node: viewNode(node) };
    },
  };

  const endDialogue: SkillDefinition<z.infer<typeof endDialogueInput>, { ok: boolean }> = {
    name: "dialogue.end",
    version: "1.0.0",
    description: "End an active dialogue between two entities.",
    category: "dialogue",
    permissions: ["dialogue.write"],
    input: endDialogueInput,
    output: z.object({ ok: z.boolean() }),
    handler: (input, ctx) => {
      const ok = dialogueMgr.endSession(input.speaker, input.listener);
      ctx.emit("dialogue.ended", { speaker: input.speaker, listener: input.listener, ok, ...input.meta });
      return { ok };
    },
  };

  const getDialogue: SkillDefinition<z.infer<typeof getDialogueInput>, { currentNode?: NodeView; history: { nodeId: string; choiceIndex?: number }[] }> = {
    name: "dialogue.get",
    version: "1.0.0",
    description: "Get the current state of an active dialogue (current node, available choices, history).",
    category: "dialogue",
    permissions: ["dialogue.read"],
    input: getDialogueInput,
    output: z.object({ currentNode: nodeView.optional(), history: z.array(z.object({ nodeId: z.string(), choiceIndex: z.number().optional() })) }),
    // Pure read: no emit.
    handler: (input) => {
      const session = dialogueMgr.getCurrentSession(input.speaker, input.listener);
      if (session === undefined) return { currentNode: undefined, history: [] };
      const tree = dialogueMgr.getTree(session.treeId);
      const node = tree?.nodes.get(session.currentNodeId);
      return { currentNode: viewNode(node), history: session.history };
    },
  };

  const npcSay: SkillDefinition<z.infer<typeof npcSayInput>, { ok: boolean }> = {
    name: "dialogue.npcSay",
    version: "1.0.0",
    description: "Have an NPC speak a line. Extends social.say with optional dialogue context and mood.",
    category: "dialogue",
    permissions: ["social.act"],
    input: npcSayInput,
    output: z.object({ ok: z.boolean() }),
    handler: (input, ctx) => {
      ctx.emit("dialogue.npcSay", { speaker: input.speaker, text: input.text, mood: input.mood, dialogueContext: input.dialogueContext, ...input.meta });
      return { ok: true };
    },
  };

  const setMood: SkillDefinition<z.infer<typeof setMoodInput>, { ok: boolean }> = {
    name: "dialogue.setMood",
    version: "1.0.0",
    description: "Set the mood/tone for an NPC's dialogue. Affects voice, animation, and bubble styling.",
    category: "dialogue",
    permissions: ["dialogue.write"],
    input: setMoodInput,
    output: z.object({ ok: z.boolean() }),
    handler: (input, ctx) => {
      ctx.emit("dialogue.moodSet", { speaker: input.speaker, mood: input.mood, ...input.meta });
      return { ok: true };
    },
  };

  registry.register(defineBehavior);
  registry.register(assignBehavior);
  registry.register(setGoal);
  registry.register(onEventBehavior);
  registry.register(setRoutine);
  registry.register(memorize);
  registry.register(recall);
  registry.register(setAttitude);
  registry.register(defineDialogue);
  registry.register(startDialogue);
  registry.register(chooseDialogue);
  registry.register(endDialogue);
  registry.register(getDialogue);
  registry.register(npcSay);
  registry.register(setMood);

  return { behaviorManager: behaviorMgr, dialogueManager: dialogueMgr };
}
