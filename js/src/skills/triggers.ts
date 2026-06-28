// trigger.* and event.* skills — trigger zones and a game event system.
//
// THE WHEN vs THE WHAT. This file is the deterministic WHEN: trigger zones detect
// entities entering/leaving/staying inside a volume, and the event bus dispatches a
// named signal to its registered listeners. It is NOT the WHAT — a listener (and a
// trigger phase) stores an AGENT-AUTHORED action DESCRIPTOR (data), never a hardcoded
// behaviour; the agent's other skills (spawn/setState/audio/…) are the WHAT the host
// drives off the descriptors this file returns. So emit/tick return the matched
// descriptors + a fired count; they do not perform side effects themselves.
//
// CLOSURE PATTERN (matches terrain.ts): the SkillDefinitions are built INSIDE
// registerTriggerEventSkills, closing over the ONE TriggerManager/EventManager the
// function owns and returns. (The previous cut defined them at module scope and read
// `(ctx.world as …).triggerManager`, which the engine never sets — so every handler
// silently no-op'd. Fixed: handlers use the closed-over managers directly.)
//
// DETERMINISM / REPLAY: no Date.now()/Math.random()/performance — ids come from a
// per-manager `seq++`, time comes from `ctx.tick`. A fresh manager replays the recorded
// skill stream (create/attach/listen/emit) in the same order, allocating the same ids
// and reaching bit-identical state. The trigger `tick(entities)` pump is pure over the
// previous-vs-current occupancy, so the same entity positions yield the same enter/
// exit/stay set every run.

import { z } from "../../build/zod.bundle.mjs";
import type { SkillDefinition, SkillRegistry } from "./registry.ts";

const Vec3 = z.tuple([z.number(), z.number(), z.number()]);
const MetaField = z.record(z.string(), z.unknown()).optional().describe("Agent-supplied extension data (custom action definitions, parameters, etc.).");

// Trigger zone definition
export interface TriggerZone {
  id: string;
  shape: "box" | "sphere";
  center: [number, number, number];
  size: [number, number, number]; // half-extents for box, radius (size[0]) for sphere
  actions: {
    onEnter: TriggerAction[];
    onExit: TriggerAction[];
    onStay: TriggerAction[];
  };
  entitiesInside: Set<string>;
  config?: Record<string, unknown>;
}

// Trigger action definition (data-driven: the agent-authored WHAT)
export interface TriggerAction {
  type: "emit" | "setState" | "spawn" | "destroy" | "audio" | "animation" | "custom";
  target?: string;
  data: Record<string, unknown>;
}

// Event listener
export interface EventListener {
  id: string;
  eventName: string;
  action: TriggerAction;
}

type TriggerPhase = "onEnter" | "onExit" | "onStay";

/** One action the `tick` pump resolved as fired (the host drives it via its other skills). */
export interface FiredAction {
  triggerId: string;
  entityId: string;
  phase: TriggerPhase;
  action: TriggerAction;
}

/** Result of one deterministic `tick` of the trigger pump. */
export interface TickResult {
  /** (triggerId, entityId) pairs that crossed INTO a zone this tick. */
  entered: { triggerId: string; entityId: string }[];
  /** (triggerId, entityId) pairs that crossed OUT of a zone this tick. */
  exited: { triggerId: string; entityId: string }[];
  /** (triggerId, entityId) pairs still inside a zone they were already inside. */
  stayed: { triggerId: string; entityId: string }[];
  /** The action descriptors the enter/exit/stay transitions fired (in deterministic order). */
  fired: FiredAction[];
}

/** One listener the event bus dispatched a signal to (the host drives the action). */
export interface DispatchedAction {
  listenerId: string;
  eventName: string;
  action: TriggerAction;
}

/** Result of dispatching one named event to its registered listeners. */
export interface EmitResult {
  /** Number of listeners that fired. */
  fired: number;
  /** The matched listeners' action descriptors (the agent-authored WHAT), in registration order. */
  dispatched: DispatchedAction[];
}

export class TriggerManager {
  private readonly triggers = new Map<string, TriggerZone>();
  private seq = 0;

  create(zone: Omit<TriggerZone, "id" | "entitiesInside">): string {
    const id = `trigger_${this.seq++}`;
    this.triggers.set(id, { ...zone, id, entitiesInside: new Set() });
    return id;
  }

  get(id: string): TriggerZone | undefined {
    return this.triggers.get(id);
  }

  remove(id: string): boolean {
    return this.triggers.delete(id);
  }

  list(): { id: string; shape: string; center: [number, number, number] }[] {
    return [...this.triggers.values()].map((t) => ({ id: t.id, shape: t.shape, center: t.center }));
  }

  addAction(id: string, phase: TriggerPhase, action: TriggerAction): boolean {
    const trigger = this.triggers.get(id);
    if (trigger === undefined) return false;
    trigger.actions[phase].push(action);
    return true;
  }

  /** Deterministic occupancy pump. Computes, per trigger, which entities ENTERED
   *  (inside now, not before), EXITED (was inside, not now), or STAYED (inside both),
   *  mutates `entitiesInside` to the current set, and collects the action descriptors
   *  each transition fires. Pure over (previous occupancy, current positions): the
   *  same inputs yield the same result every run (triggers iterate in insertion order,
   *  entities in array order — no Map/Set ordering hazards leak out). */
  tick(entities: { id: string; position: [number, number, number] }[]): TickResult {
    const entered: { triggerId: string; entityId: string }[] = [];
    const exited: { triggerId: string; entityId: string }[] = [];
    const stayed: { triggerId: string; entityId: string }[] = [];
    const fired: FiredAction[] = [];
    for (const trigger of this.triggers.values()) {
      // Snapshot which previously-inside entities we re-confirm this tick, so the rest
      // are EXITS — computed deterministically from the entity array, not Set order.
      const stillInside = new Set<string>();
      for (const entity of entities) {
        const inside = this.isInside(trigger, entity.position);
        const wasInside = trigger.entitiesInside.has(entity.id);
        if (inside) {
          stillInside.add(entity.id);
          if (wasInside) {
            stayed.push({ triggerId: trigger.id, entityId: entity.id });
            for (const a of trigger.actions.onStay) fired.push({ triggerId: trigger.id, entityId: entity.id, phase: "onStay", action: a });
          } else {
            entered.push({ triggerId: trigger.id, entityId: entity.id });
            for (const a of trigger.actions.onEnter) fired.push({ triggerId: trigger.id, entityId: entity.id, phase: "onEnter", action: a });
          }
        }
      }
      // Anyone previously inside but not re-confirmed this tick has EXITED (deterministic:
      // iterate the previous set in insertion order).
      for (const prevId of trigger.entitiesInside) {
        if (!stillInside.has(prevId)) {
          exited.push({ triggerId: trigger.id, entityId: prevId });
          for (const a of trigger.actions.onExit) fired.push({ triggerId: trigger.id, entityId: prevId, phase: "onExit", action: a });
        }
      }
      // Commit the current occupancy (rebuilt fresh so departed entities are dropped).
      trigger.entitiesInside.clear();
      for (const id of stillInside) trigger.entitiesInside.add(id);
    }
    return { entered, exited, stayed, fired };
  }

  private isInside(trigger: TriggerZone, pos: [number, number, number]): boolean {
    const dx = pos[0] - trigger.center[0];
    const dy = pos[1] - trigger.center[1];
    const dz = pos[2] - trigger.center[2];
    if (trigger.shape === "sphere") {
      const r = trigger.size[0];
      return dx * dx + dy * dy + dz * dz <= r * r;
    }
    return (
      Math.abs(dx) <= trigger.size[0] &&
      Math.abs(dy) <= trigger.size[1] &&
      Math.abs(dz) <= trigger.size[2]
    );
  }

  /** Deterministic, JSON-able snapshot (insertion order; Sets → sorted arrays) for
   *  replay-equivalence checks + host inspection. */
  snapshot(): {
    seq: number;
    triggers: { id: string; shape: string; center: number[]; size: number[]; actions: { onEnter: TriggerAction[]; onExit: TriggerAction[]; onStay: TriggerAction[] }; entitiesInside: string[]; config?: Record<string, unknown> }[];
  } {
    return {
      seq: this.seq,
      triggers: [...this.triggers.values()].map((t) => ({
        id: t.id,
        shape: t.shape,
        center: [...t.center],
        size: [...t.size],
        actions: { onEnter: [...t.actions.onEnter], onExit: [...t.actions.onExit], onStay: [...t.actions.onStay] },
        entitiesInside: [...t.entitiesInside].sort(),
        config: t.config,
      })),
    };
  }
}

export class EventManager {
  private readonly listeners = new Map<string, EventListener>();
  private seq = 0;

  register(eventName: string, action: TriggerAction): string {
    const id = `listener_${this.seq++}`;
    this.listeners.set(id, { id, eventName, action });
    return id;
  }

  remove(id: string): boolean {
    return this.listeners.delete(id);
  }

  /** DISPATCH the named event to every registered listener for it. The bus is the
   *  WHEN: it returns the matched listeners' agent-authored action descriptors (the
   *  WHAT) + a fired count; it never performs the actions itself. Deterministic:
   *  listeners are matched in registration (Map insertion) order, with no time/random.
   *  `payload` is forwarded verbatim for the host to merge into each action. */
  emit(eventName: string, _payload: Record<string, unknown>): EmitResult {
    const dispatched: DispatchedAction[] = [];
    for (const l of this.listeners.values()) {
      if (l.eventName === eventName) dispatched.push({ listenerId: l.id, eventName: l.eventName, action: l.action });
    }
    return { fired: dispatched.length, dispatched };
  }

  list(): { id: string; eventName: string; type: string }[] {
    return [...this.listeners.values()].map((l) => ({ id: l.id, eventName: l.eventName, type: l.action.type }));
  }

  /** Deterministic, JSON-able snapshot (registration order) for replay-equivalence. */
  snapshot(): { seq: number; listeners: { id: string; eventName: string; action: TriggerAction }[] } {
    return {
      seq: this.seq,
      listeners: [...this.listeners.values()].map((l) => ({ id: l.id, eventName: l.eventName, action: l.action })),
    };
  }
}

// ---- Schemas (pure; shared by the handlers built in registerTriggerEventSkills) ----

const triggerActionSchema = z.object({
  type: z.enum(["emit", "setState", "spawn", "destroy", "audio", "animation", "custom"]).describe("Action type."),
  target: z.string().optional().describe("Target entity or reference."),
  data: z.record(z.string(), z.unknown()).default({}).describe("Action-specific data (event name, spawn params, audio params, etc.)."),
});

const createTriggerInput = z.object({
  shape: z.enum(["box", "sphere"]).default("box"),
  center: Vec3.describe("Trigger center position."),
  size: Vec3.describe("Box half-extents or sphere radius (radius = size[0] for sphere)."),
  config: z.record(z.string(), z.unknown()).optional().describe("Custom trigger configuration data."),
  meta: MetaField,
});

const attachTriggerInput = z.object({
  triggerId: z.string(),
  action: triggerActionSchema.describe("Data-driven action descriptor (the agent-authored WHAT) fired by the trigger pump on this phase."),
  meta: MetaField,
});

const removeTriggerInput = z.object({
  triggerId: z.string(),
  meta: MetaField,
});

const listenInput = z.object({
  eventName: z.string().min(1).describe("Event name to listen for."),
  action: triggerActionSchema.describe("Action descriptor to dispatch when the event fires."),
  meta: MetaField,
});

const emitEventInput = z.object({
  eventName: z.string().min(1).describe("Event name to emit."),
  payload: z.record(z.string(), z.unknown()).default({}).describe("Event payload data forwarded to each listener."),
  meta: MetaField,
});

const removeListenerInput = z.object({
  listenerId: z.string(),
  meta: MetaField,
});

const dispatchedSchema = z.object({ listenerId: z.string(), eventName: z.string(), action: triggerActionSchema });

/** Register the trigger.* / event.* skills bound to a single TriggerManager +
 *  EventManager (the closed-over WHEN). The default core wiring creates fresh
 *  managers; a runtime can pass its own. RETURNS the managers so CoreSkills exposes
 *  them (`core.triggers.triggerManager/.eventManager`) and a host can drive the
 *  `tick` pump / inspect dispatch. */
export function registerTriggerEventSkills(
  registry: SkillRegistry,
  opts?: { triggerManager?: TriggerManager; eventManager?: EventManager },
): { triggerManager: TriggerManager; eventManager: EventManager } {
  const triggerManager = opts?.triggerManager ?? new TriggerManager();
  const eventManager = opts?.eventManager ?? new EventManager();

  // ---- Trigger skills ----

  const createTrigger: SkillDefinition<z.infer<typeof createTriggerInput>, { triggerId: string }> = {
    name: "trigger.create",
    version: "1.0.0",
    description: "Create a trigger zone (box or sphere) at a position with configurable size. Returns the trigger id for attaching phase actions (onEnter/onExit/onStay).",
    category: "trigger",
    permissions: ["trigger.configure"],
    input: createTriggerInput,
    output: z.object({ triggerId: z.string() }),
    handler: (input, ctx) => {
      const id = triggerManager.create({
        shape: input.shape,
        center: input.center,
        size: input.size,
        actions: { onEnter: [], onExit: [], onStay: [] },
        config: input.config,
      });
      ctx.emit("trigger.created", { triggerId: id, shape: input.shape, center: input.center, ...input.meta });
      return { triggerId: id };
    },
  };

  /** Build one phase-attach skill (onEnter/onExit/onStay) — they differ only in phase. */
  function makeAttach(name: string, phase: TriggerPhase, description: string): SkillDefinition<z.infer<typeof attachTriggerInput>, { ok: boolean }> {
    return {
      name,
      version: "1.0.0",
      description,
      category: "trigger",
      permissions: ["trigger.configure"],
      input: attachTriggerInput,
      output: z.object({ ok: z.boolean() }),
      handler: (input, ctx) => {
        const ok = triggerManager.addAction(input.triggerId, phase, input.action);
        ctx.emit("trigger.actionAttached", { triggerId: input.triggerId, phase, actionType: input.action.type, ...input.meta });
        return { ok };
      },
    };
  }

  const attachEnter = makeAttach(
    "trigger.onEnter",
    "onEnter",
    "Attach a data-driven action descriptor to fire when an entity ENTERS a trigger zone. The descriptor (emit/setState/spawn/destroy/audio/animation/custom) is the agent-authored WHAT; the trigger pump returns it for the host to drive — it is not executed here.",
  );
  const attachExit = makeAttach(
    "trigger.onExit",
    "onExit",
    "Attach an action descriptor to fire when an entity EXITS a trigger zone (returned by the trigger pump for the host to drive).",
  );
  const attachStay = makeAttach(
    "trigger.onStay",
    "onStay",
    "Attach an action descriptor to fire each tick an entity STAYS inside a trigger zone (returned by the trigger pump for the host to drive).",
  );

  const removeTrigger: SkillDefinition<z.infer<typeof removeTriggerInput>, { ok: boolean }> = {
    name: "trigger.remove",
    version: "1.0.0",
    description: "Remove a trigger zone and all its attached phase actions.",
    category: "trigger",
    permissions: ["trigger.configure"],
    input: removeTriggerInput,
    output: z.object({ ok: z.boolean() }),
    handler: (input, ctx) => {
      const ok = triggerManager.remove(input.triggerId);
      ctx.emit("trigger.removed", { triggerId: input.triggerId, ...input.meta });
      return { ok };
    },
  };

  // ---- Event skills ----

  const eventListen: SkillDefinition<z.infer<typeof listenInput>, { listenerId: string }> = {
    name: "event.listen",
    version: "1.0.0",
    description: "Register a listener for a named game event, storing an action descriptor to dispatch when it fires. Returns a listener handle; use event.remove to unregister.",
    category: "event",
    permissions: ["event.read"],
    input: listenInput,
    output: z.object({ listenerId: z.string() }),
    handler: (input, ctx) => {
      const id = eventManager.register(input.eventName, input.action);
      ctx.emit("event.listened", { eventName: input.eventName, listenerId: id, actionType: input.action.type, ...input.meta });
      return { listenerId: id };
    },
  };

  const emitEvent: SkillDefinition<z.infer<typeof emitEventInput>, { ok: boolean; fired: number; dispatched: z.infer<typeof dispatchedSchema>[] }> = {
    name: "event.emit",
    version: "1.0.0",
    description: "Emit a named game event with arbitrary payload. DISPATCHES to every registered listener for that event, returning the matched listeners' action descriptors + a fired count. The bus is the WHEN; the host drives the returned descriptors via the agent's other skills (the WHAT).",
    category: "event",
    permissions: ["event.write"],
    input: emitEventInput,
    output: z.object({ ok: z.boolean(), fired: z.number().int(), dispatched: z.array(dispatchedSchema) }),
    handler: (input, ctx) => {
      const res = eventManager.emit(input.eventName, input.payload);
      ctx.emit("game.event", { eventName: input.eventName, payload: input.payload, fired: res.fired, ...input.meta });
      return { ok: true, fired: res.fired, dispatched: res.dispatched };
    },
  };

  const removeListener: SkillDefinition<z.infer<typeof removeListenerInput>, { ok: boolean }> = {
    name: "event.remove",
    version: "1.0.0",
    description: "Remove a previously registered event listener.",
    category: "event",
    permissions: ["event.read"],
    input: removeListenerInput,
    output: z.object({ ok: z.boolean() }),
    handler: (input, ctx) => {
      const ok = eventManager.remove(input.listenerId);
      ctx.emit("event.listenerRemoved", { listenerId: input.listenerId, ...input.meta });
      return { ok };
    },
  };

  registry.register(createTrigger);
  registry.register(attachEnter);
  registry.register(attachExit);
  registry.register(attachStay);
  registry.register(removeTrigger);
  registry.register(eventListen);
  registry.register(emitEvent);
  registry.register(removeListener);

  return { triggerManager, eventManager };
}
