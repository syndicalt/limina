// Snapshot-participant assembly for the core skill set (H2: snapshot restore
// completeness). Every CoreSkills manager that owns runtime-mutated SIM state
// declares itself here as a SnapshotParticipant (key + schema + deterministic
// sorted capture + wholesale restore); registerCoreSkills assembles the registry
// and exposes it as `core.snapshotParticipants`, the ONE object hosts pass to
// captureWorldSnapshot / restoreSnapshot / recoverWorld.
//
// ─── THE CLASSIFICATION TABLE ────────────────────────────────────────────────
// Every manager on the CoreSkills surface MUST have a row here. Adding a manager
// without picking a bucket is the H2 bug being re-introduced: its state silently
// evaporates on snapshot restore. Buckets:
//   P  = PARTICIPANT (runtime-mutated sim state; captured into snapshot.managers)
//   R  = RECONCILED-FROM-ORIGIN (pure function of entity origins; a registered
//        world reconciler rebuilds it — capturing it would duplicate authority)
//   X  = EXCLUDED (render/host/presentation-only, or a consumer of state; holds
//        nothing the sim needs back after a restore)
//   F  = FOLLOW-UP (holds sim state but is NOT yet enrolled — a documented gap,
//        not a silent one; enrolling it is the required next slice)
//
// | CoreSkills manager                          | Bucket | Why |
// |---------------------------------------------|--------|-----|
// | inventory.inventoryManager                   | P "inventory"        | items/defs/equipment are pure runtime sim state |
// | interaction.interactionManager               | P "interaction"      | registered interactables incl. mutable def.state (open/lastInteractTick); handlers are closures, reconciled from origins |
// | gamestate.gameStateManager                   | P "gameState"        | vars/flags/counters/timers/conditions + won/lost |
// | triggers.triggerManager                      | P "triggers"         | zones, phase actions, occupancy sets, id seq |
// | triggers.eventManager                        | P "eventListeners"   | listener registrations + id seq |
// | quest.questManager                           | P "quests"           | definitions + per-entity instances/progress |
// | combat.statsManager                          | P "stats"            | stat values, status effects, id seq |
// | combat.combatManager                         | P "combat"           | live defend stances (tick-scoped sim state) |
// | ability.abilityManager                       | P "abilities"        | defs + per-(entity,ability) cooldown stamps |
// | nav.navmeshManager (portal layer)            | P "navmeshPortals"   | portal open-state gates pathfinding; base grid is rebuilt (see F row) |
// | progression.progressionManager               | P "progression"      | xp/levels/unlocks/skill trees/level-up hooks |
// | worldstate.worldStateManager                 | P "worldState"       | time/weather/timeScale/spawn |
// | navigation.gazetteerManager                  | P "gazetteer"        | loaded named-place index npc.goToPlace resolves against |
// | cutscene.cutsceneManager                     | P "cutscenes"        | VERIFIED sim-affecting: mid-playback cursor (startTick/firedThrough) drives future world mutations |
// | director.directorManager                     | P "director"         | VERIFIED sim-affecting: tension state machine decides future directives |
// | behaviorSpec.events (EventSpecRegistry)      | P "events" (reserved)| migrated from the bespoke `events?:` param; serializes into the snapshot's existing top-level field |
// | (host character controllers)                 | P "characters" (reserved) | host registers charactersParticipant(...); legacy `characters?:` param delegates |
// | functionalBuildings.topologyManager          | R | functional-building.ts registers a world reconciler: topology/doors/portals rebuild from entry.origin, and origins ride the snapshot |
// | behavior.behaviorManager / dialogueManager   | F | NPC memories/goals/assignments + dialogue sessions ARE sim state; enrollment deferred (plan scope) — snapshot restore currently rebuilds them empty |
// | functionalSettlements.placementManager       | F | settlement handles are sim ownership state; JSON-shaped, but enrollment deferred (plan scope) |
// | terrain (source/cache/regions/layers)        | F | editable-layer heights/paint are sim state; heightfield COLLIDERS ride the physics blob but the JS tile arrays do not — known pre-existing gap |
// | nav.navmeshManager (base grid + agents)      | F | grid rebuilds via navmesh.build replay only; not yet snapshot-carried |
// | assets / materials (registries)              | X | content-addressed stores rebuilt from packages/imports; bytes never live in a snapshot |
// | packages (PackageRegistry)                   | X | package loads are recorded commands; the registry is rebuilt by replay, not restore |
// | player (input/controllers registries)        | X | host-bound device/controller wiring; controller RESUME state is the "characters" participant |
// | camera.cameraManager                         | X | render/host-only view state |
// | animation.animationManager                   | X | pose is derived per-frame from clips + sim state |
// | clips.clipAuthor                             | X | authored clip data rebuilds from recorded clip_author commands |
// | ui (UiManager)                               | X | presentation containers, host-ticked |
// | audio / worldstate.bgmManager / reverbManager| X | audible presentation; nothing sim reads back |
// | vfx.vfxManager                               | X | render-only particles/effects |
// | save.saveManager                             | X | a CONSUMER of snapshots, not world state |
// | social / locomotion                          | X | speech bubbles + host-driven move targets; re-issued by live agents, never restored |
// | water (render state + contact runtime)       | X | render-only surface; contact state re-derives from terrain/water fields |
// ─────────────────────────────────────────────────────────────────────────────

import { z } from "../../build/zod.bundle.mjs";
import {
  SnapshotParticipantRegistry,
  eventsParticipant,
  type SnapshotParticipant,
} from "../worldlog/snapshot.ts";
import type { InventoryManager, InventoryManagerSnapshot } from "./inventory.ts";
import type { InteractionManager, InteractableDef } from "./interaction.ts";
import type { GameStateManager, GameStateManagerSnapshot } from "./gamestate.ts";
import type { TriggerManager, EventManager, TriggerManagerSnapshot, EventManagerSnapshot } from "./triggers.ts";
import type { QuestManager, QuestManagerSnapshot } from "./quest.ts";
import type { StatsManager, CombatManager, StatsManagerSnapshot, CombatManagerSnapshot } from "./combat.ts";
import type { AbilityManager, AbilityManagerSnapshot } from "./ability.ts";
import type { NavmeshManager, NavmeshPortalSnapshot } from "./navmesh.ts";
import type { ProgressionManager, ProgressionManagerSnapshot } from "./progression.ts";
import type { WorldStateManager, WorldState } from "./worldstate.ts";
import type { GazetteerManager, GazetteerRecord } from "./navigation.ts";
import type { CutsceneManager, CutsceneManagerSnapshot } from "./cutscene.ts";
import type { DirectorManager, DirectorManagerSnapshot } from "./director.ts";
import type { EventSpecRegistry } from "./behavior-spec.ts";

// ---- participant schemas (validate a snapshot's managers entries at restore) ----
// Typed against each manager module's exported snapshot interface, so schema and
// capture shape cannot drift apart without tsc noticing.

const meta = z.record(z.string(), z.unknown());

const inventorySlotSchema = z.object({
  itemId: z.string(),
  quantity: z.number(),
  slot: z.number(),
  equipped: z.boolean(),
  data: meta.optional(),
});
const inventorySchema: z.ZodType<InventoryManagerSnapshot> = z.object({
  itemDefs: z.array(z.object({
    id: z.string(),
    name: z.string(),
    description: z.string(),
    icon: z.string().optional(),
    stackable: z.boolean(),
    maxStack: z.number(),
    weight: z.number(),
    category: z.string(),
    config: meta,
    usageBehavior: z.string().optional(),
    onUse: z.string().optional(),
    onEquip: z.string().optional(),
  })),
  inventories: z.array(z.object({
    entity: z.string(),
    capacity: z.number(),
    typeRestrictions: z.array(z.string()).optional(),
    slots: z.array(inventorySlotSchema),
    equipment: z.array(z.object({ equipmentSlot: z.string(), item: inventorySlotSchema })),
  })),
});

const interactionSchema: z.ZodType<InteractableDef[]> = z.array(z.object({
  entity: z.string(),
  prompt: z.string(),
  maxRange: z.number(),
  type: z.enum(["pickup", "use", "talk", "open", "toggle", "custom"]),
  action: z.string().optional(),
  config: meta.optional(),
  state: meta,
}));

const gameStateSchema: z.ZodType<GameStateManagerSnapshot> = z.object({
  variables: z.array(z.object({ name: z.string(), value: z.union([z.string(), z.number(), z.boolean(), meta]) })),
  flags: z.array(z.object({ name: z.string(), value: z.boolean() })),
  counters: z.array(z.object({ name: z.string(), value: z.number() })),
  timers: z.array(z.object({
    name: z.string(),
    remaining: z.number(),
    duration: z.number(),
    paused: z.boolean(),
    direction: z.enum(["countdown", "countup"]),
    onComplete: z.string(),
    done: z.boolean(),
  })),
  conditions: z.array(z.object({ name: z.string(), expression: z.string(), lastValue: z.boolean(), onTrue: z.string().optional() })),
  state: z.enum(["running", "won", "lost", "paused"]),
  endedAtTick: z.number().optional(),
});

const triggerActionSchema = z.object({
  type: z.enum(["emit", "setState", "spawn", "destroy", "audio", "animation", "custom"]),
  target: z.string().optional(),
  data: meta,
});
const triggersSchema: z.ZodType<TriggerManagerSnapshot> = z.object({
  seq: z.number(),
  triggers: z.array(z.object({
    id: z.string(),
    shape: z.string(),
    center: z.array(z.number()),
    size: z.array(z.number()),
    actions: z.object({ onEnter: z.array(triggerActionSchema), onExit: z.array(triggerActionSchema), onStay: z.array(triggerActionSchema) }),
    entitiesInside: z.array(z.string()),
    config: meta.optional(),
  })),
});
const eventListenersSchema: z.ZodType<EventManagerSnapshot> = z.object({
  seq: z.number(),
  listeners: z.array(z.object({ id: z.string(), eventName: z.string(), action: triggerActionSchema })),
});

const questObjectiveStateSchema = z.object({ id: z.string(), progress: z.number(), completed: z.boolean() });
const questsSchema: z.ZodType<QuestManagerSnapshot> = z.object({
  definitions: z.array(z.object({
    id: z.string(),
    name: z.string(),
    description: z.string(),
    prerequisites: z.array(z.string()),
    objectives: z.array(z.object({
      id: z.string(),
      type: z.enum(["kill", "collect", "reach", "talk", "custom"]),
      description: z.string(),
      target: z.string().optional(),
      required: z.number(),
      progress: z.number(),
      completed: z.boolean(),
      config: meta.optional(),
    })),
    rewards: meta,
    followUpQuests: z.array(z.string()),
    config: meta.optional(),
  })),
  instances: z.array(z.object({
    entity: z.string(),
    quests: z.array(z.object({
      questId: z.string(),
      entity: z.string(),
      status: z.enum(["available", "active", "completed", "failed"]),
      objectives: z.array(questObjectiveStateSchema),
      tracked: z.boolean(),
      offeredTick: z.number().optional(),
      acceptedTick: z.number().optional(),
      completedTick: z.number().optional(),
      failedTick: z.number().optional(),
    })),
  })),
});

const onZeroActionSchema = z.object({
  type: z.enum(["emit", "setState", "spawn", "destroy", "audio", "animation", "custom"]),
  target: z.string().optional(),
  data: meta,
});
const statsSchema: z.ZodType<StatsManagerSnapshot> = z.object({
  seq: z.number(),
  entities: z.array(z.object({
    entity: z.string(),
    stats: z.array(z.object({
      name: z.string(),
      value: z.number(),
      maxValue: z.number(),
      minValue: z.number(),
      config: meta.optional(),
      onZero: onZeroActionSchema.optional(),
    })),
    statusEffects: z.array(z.object({
      id: z.string(),
      type: z.string(),
      duration: z.number(),
      elapsed: z.number(),
      magnitude: z.number(),
      tickInterval: z.number().optional(),
      onApply: z.string().optional(),
      onRemove: z.string().optional(),
      onTick: z.string().optional(),
      config: meta.optional(),
    })),
  })),
});
const combatSchema: z.ZodType<CombatManagerSnapshot> = z.object({
  stances: z.array(z.object({ entity: z.string(), damageReduction: z.number(), reflectChance: z.number(), expiresTick: z.number() })),
});

const abilitiesSchema: z.ZodType<AbilityManagerSnapshot> = z.object({
  defs: z.array(z.object({ id: z.string(), cooldownTicks: z.number(), resourceStat: z.string().optional(), cost: z.number().optional() })),
  lastCast: z.array(z.object({ key: z.string(), tick: z.number() })),
});

const navmeshPortalsSchema: z.ZodType<NavmeshPortalSnapshot> = z.object({
  portals: z.array(z.object({
    id: z.string(),
    bounds: z.object({ minX: z.number(), minZ: z.number(), maxX: z.number(), maxZ: z.number() }),
    open: z.boolean(),
  })),
});

const levelUpActionSchema = z.object({ type: z.string(), data: meta });
const progressionSchema: z.ZodType<ProgressionManagerSnapshot> = z.object({
  progression: z.array(z.object({
    entity: z.string(),
    xp: z.number(),
    level: z.number(),
    xpToNext: z.number(),
    skillPoints: z.number(),
    unlocked: z.array(z.string()),
    allocated: z.array(z.object({ nodeId: z.string(), points: z.number() })),
  })),
  levelUpActions: z.array(z.object({ entity: z.string(), actions: z.array(levelUpActionSchema) })),
  skillTrees: z.array(z.object({
    id: z.string(),
    name: z.string(),
    nodes: z.array(z.object({
      id: z.string(),
      name: z.string(),
      description: z.string(),
      prerequisites: z.array(z.string()),
      cost: z.number(),
      maxLevel: z.number(),
      effects: meta,
      config: meta.optional(),
    })),
    config: meta.optional(),
  })),
});

const worldStateSchema: z.ZodType<WorldState> = z.object({
  timeOfDay: z.number(),
  weather: z.string(),
  weatherIntensity: z.number(),
  timeScale: z.number(),
  spawnPosition: z.tuple([z.number(), z.number(), z.number()]),
  config: meta.optional(),
});

const gazetteerSchema: z.ZodType<GazetteerRecord[]> = z.array(z.object({
  placeId: z.string(),
  name: z.string(),
  kind: z.string(),
  parentId: z.string().nullable(),
  position: z.tuple([z.number(), z.number()]),
  radiusM: z.number().optional(),
}));

const cutsceneActionSchema = z.object({ type: z.string(), data: meta.optional() });
const cutscenesSchema: z.ZodType<CutsceneManagerSnapshot> = z.object({
  cutscenes: z.array(z.object({
    id: z.string(),
    keyframes: z.array(z.object({ atTick: z.number(), action: cutsceneActionSchema })),
    durationTicks: z.number(),
    loop: z.boolean(),
  })),
  active: z.object({ id: z.string(), startTick: z.number(), firedThrough: z.number() }).optional(),
});

const directorSchema: z.ZodType<DirectorManagerSnapshot> = z.object({
  cfg: z.object({
    buildRate: z.number(),
    fadeRate: z.number(),
    sustainTicks: z.number(),
    restTicks: z.number(),
    peakLevel: z.number(),
    restLevel: z.number(),
    pressureDamping: z.number(),
  }),
  running: z.boolean(),
  phase: z.enum(["build_up", "sustain", "fade", "rest"]),
  tension: z.number(),
  phaseTicksLeft: z.number(),
});

// ---- assembly ---------------------------------------------------------------

/** The managers registerCoreSkills built (the P rows of the table above). */
export interface CoreParticipantManagers {
  inventoryManager: InventoryManager;
  interactionManager: InteractionManager;
  gameStateManager: GameStateManager;
  triggerManager: TriggerManager;
  eventManager: EventManager;
  questManager: QuestManager;
  statsManager: StatsManager;
  combatManager: CombatManager;
  abilityManager: AbilityManager;
  navmeshManager: NavmeshManager;
  progressionManager: ProgressionManager;
  worldStateManager: WorldStateManager;
  gazetteerManager: GazetteerManager;
  cutsceneManager: CutsceneManager;
  directorManager: DirectorManager;
  /** The world-level EventSpecRegistry — the reserved "events" participant. */
  eventSpecs: EventSpecRegistry;
}

function participant<T>(key: string, schema: z.ZodType<T>, capture: () => T, restore: (state: T) => void): SnapshotParticipant {
  return { key, schema, capture, restore: (state) => restore(state as T) };
}

/** Assemble the core snapshot-participant registry (exposed as
 *  `core.snapshotParticipants`). Hosts pass this ONE object to
 *  captureWorldSnapshot / restoreSnapshot / recoverWorld; a host owning character
 *  controllers additionally registers charactersParticipant(controllers) on it. */
export function buildCoreSnapshotParticipants(m: CoreParticipantManagers): SnapshotParticipantRegistry {
  const registry = new SnapshotParticipantRegistry();
  registry.register(participant("inventory", inventorySchema, () => m.inventoryManager.captureSnapshot(), (s) => m.inventoryManager.restoreSnapshot(s)));
  registry.register(participant("interaction", interactionSchema, () => m.interactionManager.captureSnapshot(), (s) => m.interactionManager.restoreSnapshot(s)));
  registry.register(participant("gameState", gameStateSchema, () => m.gameStateManager.captureSnapshot(), (s) => m.gameStateManager.restoreSnapshot(s)));
  registry.register(participant("triggers", triggersSchema, () => m.triggerManager.snapshot(), (s) => m.triggerManager.restoreSnapshot(s)));
  registry.register(participant("eventListeners", eventListenersSchema, () => m.eventManager.snapshot(), (s) => m.eventManager.restoreSnapshot(s)));
  registry.register(participant("quests", questsSchema, () => m.questManager.captureSnapshot(), (s) => m.questManager.restoreSnapshot(s)));
  registry.register(participant("stats", statsSchema, () => m.statsManager.captureSnapshot(), (s) => m.statsManager.restoreSnapshot(s)));
  registry.register(participant("combat", combatSchema, () => m.combatManager.captureSnapshot(), (s) => m.combatManager.restoreSnapshot(s)));
  registry.register(participant("abilities", abilitiesSchema, () => m.abilityManager.captureSnapshot(), (s) => m.abilityManager.restoreSnapshot(s)));
  registry.register(participant("navmeshPortals", navmeshPortalsSchema, () => m.navmeshManager.capturePortalSnapshot(), (s) => m.navmeshManager.restorePortalSnapshot(s)));
  registry.register(participant("progression", progressionSchema, () => m.progressionManager.captureSnapshot(), (s) => m.progressionManager.restoreSnapshot(s)));
  registry.register(participant("worldState", worldStateSchema, () => m.worldStateManager.captureSnapshot(), (s) => m.worldStateManager.restoreSnapshot(s)));
  registry.register(participant("gazetteer", gazetteerSchema, () => m.gazetteerManager.captureSnapshot(), (s) => m.gazetteerManager.restoreSnapshot(s)));
  registry.register(participant("cutscenes", cutscenesSchema, () => m.cutsceneManager.captureSnapshot(), (s) => m.cutsceneManager.restoreSnapshot(s)));
  registry.register(participant("director", directorSchema, () => m.directorManager.captureSnapshot(), (s) => m.directorManager.restoreSnapshot(s)));
  // Migrated from the bespoke `events?:` plumbing: rides the snapshot's existing
  // top-level `events` field via the reserved key (wire format unchanged).
  registry.register(eventsParticipant(m.eventSpecs));
  return registry;
}
