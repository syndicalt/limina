// behavior.set + event.define — the AUTHORING seam for the declarative behaviour/event RECORD
// FORMAT (Track-B keystone, Phase B1).
//
// These two skills WRITE the format defined in js/src/behavior/behavior-spec.ts into world state:
//   • behavior.set  — attach a BehaviorSpec to an entity as FIRST-CLASS entity state (mirrors
//                     three.setMaterial → bindMaterial): it lands on EntityEntry.behavior, so it
//                     survives on a mesh-less / asset-backed entity and rides a self-sufficient
//                     snapshot. Behaviour is a whole discriminated-union value, so it REPLACES the
//                     prior one (a swap, not a per-field merge).
//   • event.define  — register a world-level EventSpec {trigger, action} in an EventSpecRegistry
//                     this module owns and returns (the closure pattern of triggers.ts). Events are
//                     NOT per-entity, so they live in a world-level registry the snapshot carries.
//
// EVENTS-IN-LOG CHOICE — a RECORDED SKILL, not a new WorldCommand variant. Every world mutation
// already flows through SkillRegistry.invoke (the recorder patches it), so event.define is recorded
// and replayed by the EXISTING machinery with zero new command plumbing: replay re-invokes
// event.define into a fresh registry (rebuilding it exactly), and a snapshot bakes the registry's
// contents so a bounded-tail restore reloads events without the pre-snapshot commands. A new
// WorldCommand variant would instead force new code in log.ts (schema), recorder.ts (emit) AND
// snapshot.ts (bake) — more surface for the same effect. The recorded-skill path fits the grain.
//
// DETERMINISM / REPLAY: no Date/Math.random. Event ids come from a per-registry `seq++`; a fresh
// replay re-invokes the recorded event.define stream in order, allocating identical ids. The spec
// stored is the CANONICAL form, so record→replay and capture→restore reach byte-identical state.

import { z } from "../../build/zod.bundle.mjs";
import type { SkillDefinition, SkillRegistry } from "./registry.ts";
import {
  BehaviorSpecSchema,
  EventSpecSchema,
  canonicalizeBehaviorSpec,
  canonicalizeEventSpec,
  type EventSpec,
} from "../behavior/behavior-spec.ts";
import type { EventSpecSnapshotEntry, SnapshotableEventRegistry } from "../worldlog/snapshot.ts";

/** World-level store of declarative EventSpec definitions. One per world; owned by
 *  registerBehaviorSpecSkills and returned so a host can hand it to the snapshot capture/restore.
 *  Satisfies SnapshotableEventRegistry so the worldlog layer bakes/reloads it (mirrors how a
 *  CharacterController satisfies SnapshotableCharacter). Ids are `evt_N`, monotonic, never reused. */
export class EventSpecRegistry implements SnapshotableEventRegistry {
  private readonly map = new Map<string, EventSpec>();
  private seq = 0;

  /** Register a (canonical) event spec, returning its stable id. */
  define(spec: EventSpec): string {
    const id = `evt_${this.seq++}`;
    this.map.set(id, spec);
    return id;
  }
  get(id: string): EventSpec | undefined {
    return this.map.get(id);
  }
  ids(): string[] {
    return [...this.map.keys()];
  }
  size(): number {
    return this.map.size;
  }

  // ---- SnapshotableEventRegistry ----
  listEventSpecs(): EventSpecSnapshotEntry[] {
    return [...this.map.entries()].map(([id, spec]) => ({ id, spec }));
  }
  /** Replace all contents with the snapshot's baked definitions and resume the id counter past
   *  them, so a post-restore event.define allocates the SAME next id it would have live. Ids are
   *  dense + never reused in B1 (no event-removal skill), so `size` is the exact next-seq. */
  restoreEventSpecs(entries: readonly EventSpecSnapshotEntry[]): void {
    this.map.clear();
    for (const e of entries) this.map.set(e.id, canonicalizeEventSpec(e.spec));
    this.seq = entries.length;
  }
}

const setBehaviorInput = z.object({
  /** The entity (ent_ id) to attach the behaviour to. */
  entity: z.string().min(1),
  /** The declarative behaviour — validated by the REAL BehaviorSpec schema at the boundary, so a
   *  malformed spec (bad kind, out-of-range, unknown key) is rejected as invalid_input, never a
   *  thrown handler error. */
  behavior: BehaviorSpecSchema,
});
const setBehaviorOutput = z.object({
  entity: z.string(),
  ok: z.boolean(),
  kind: z.string(),
});

const defineEventInput = z.object({
  /** The declarative event ({trigger, action}) — validated by the REAL EventSpec schema. */
  event: EventSpecSchema,
});
const defineEventOutput = z.object({
  id: z.string(),
});

/** Register behavior.set + event.define, returning the world-level EventSpecRegistry the snapshot
 *  layer captures/restores. */
export function registerBehaviorSpecSkills(registry: SkillRegistry): { events: EventSpecRegistry } {
  const events = new EventSpecRegistry();

  const setBehavior: SkillDefinition<z.infer<typeof setBehaviorInput>, z.infer<typeof setBehaviorOutput>> = {
    name: "behavior.set",
    version: "1.0.0",
    description: "Attach a declarative BehaviorSpec (idle / patrol / wander / script) to an entity as first-class world state. It lands on the entity (like three.setMaterial), so it survives on a mesh-less / asset-backed entity and rides a self-sufficient snapshot. Behaviour is a whole value — this REPLACES any prior behaviour. Runtime execution (the NPC actually moving) is a later phase; this records the intent.",
    category: "ecs",
    permissions: ["scene.write"],
    input: setBehaviorInput,
    output: setBehaviorOutput,
    handler: (input, ctx) => {
      const entry = ctx.world.entities.resolve(input.entity);
      if (entry === undefined) {
        throw new Error(`behavior.set: unknown entity '${input.entity}'`);
      }
      // Store the CANONICAL spec so record→replay and capture→restore reach byte-identical state.
      const spec = canonicalizeBehaviorSpec(input.behavior);
      ctx.world.entities.bindBehavior(input.entity, spec);
      ctx.emit("behavior.set", { entity: input.entity, kind: spec.kind });
      return { entity: input.entity, ok: true, kind: spec.kind };
    },
  };

  const defineEvent: SkillDefinition<z.infer<typeof defineEventInput>, z.infer<typeof defineEventOutput>> = {
    name: "event.define",
    version: "1.0.0",
    description: "Register a world-level declarative EventSpec {trigger, action} (e.g. onTick/onEnterRegion/onInteract → emit/setBehavior/spawn). Stored in the world's event registry and carried by a self-sufficient snapshot; recorded through invoke so a replay rebuilds the same events. This is the FORMAT + registration; firing the events at runtime is a later phase.",
    category: "ecs",
    permissions: ["scene.write"],
    input: defineEventInput,
    output: defineEventOutput,
    handler: (input, ctx) => {
      const spec = canonicalizeEventSpec(input.event);
      const id = events.define(spec);
      ctx.emit("event.defined", { id, trigger: spec.trigger.type, action: spec.action.type });
      return { id };
    },
  };

  registry.register(setBehavior);
  registry.register(defineEvent);
  return { events };
}
