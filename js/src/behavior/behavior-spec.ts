// BehaviorSpec + EventSpec — the DECLARATIVE, recorded wire format for entity BEHAVIOUR and
// world EVENTS (Track-B keystone, Phase B1).
//
// This is the FORMAT, not the runtime. An agent describes what an NPC DOES (a BehaviorSpec
// attached to an entity) and what the world REACTS to (an EventSpec: a {trigger, action}) as
// DATA — never code. B1 makes the format exist, set-able via a recorded skill, and carried by a
// self-sufficient snapshot so a saved scene reloads with its behaviour + events intact. Runtime
// EXECUTION (NPCs moving, events firing at tick) is B2/B3 and lives elsewhere — nothing here
// simulates anything.
//
// It follows js/src/geometry/geometry-spec.ts and js/src/world/world-config.ts EXACTLY:
//   • a `version` literal on every spec (migration hook — bump when the wire format changes),
//   • a discriminated union on `kind` (behaviour) / `type` (trigger + action),
//   • `.strict()` objects (an unknown key is REJECTED, never silently dropped),
//   • parse* / canonical* / serialize* with a byte-stable canonical JSON round-trip,
//   • NO Date / Math.random anywhere — a spec is pure data, so the same spec always serializes to
//     byte-identical JSON (deterministic + replay-safe + headless).
//
// The record shape is EXPENSIVE to change once scenes are saved/exported, so it is designed once,
// here, as a clean versioned schema. Each union starts SMALL but real and EXTENSIBLE — a couple of
// genuine variants that establish the shape, not a rich AI library.

import { z } from "../../build/zod.bundle.mjs";

/** Bump when either wire format changes. Every spec carries it so a replayer can route by version. */
export const BEHAVIOR_SPEC_VERSION = 1;

const Ver = z.literal(BEHAVIOR_SPEC_VERSION);
const Positive = z.number().positive();
const Finite = z.number().refine(Number.isFinite, "expected finite number");
const Vec3 = z.tuple([Finite, Finite, Finite]);
// Agent-supplied extension params/payload — arbitrary JSON. Deep key-sorted on canonicalization
// (see canonicalJsonValue) so the bytes are stable regardless of the author's key order.
const JsonRecord = z.record(z.string(), z.unknown());

/** Recursively key-sort plain objects (arrays preserved in order, scalars untouched) so an
 *  agent-supplied params/payload record serializes to byte-identical JSON no matter what order
 *  its keys arrived in. The one piece of canonicalization the fixed-slot specs cannot do
 *  structurally, because these records are open-ended. */
function canonicalJsonValue(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonicalJsonValue);
  if (v !== null && typeof v === "object") {
    const src = v as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(src).sort()) out[k] = canonicalJsonValue(src[k]);
    return out;
  }
  return v;
}

// ============================================================================
// BehaviorSpec — declarative behaviour attached to ONE entity (data, not code).
// ============================================================================

// idle — the do-nothing default (a placed NPC that just stands). No params.
const IdleBehavior = z.object({
  version: Ver,
  kind: z.literal("idle"),
}).strict();

// patrol — walk an ordered list of waypoints at `speed`; `loop` returns to the first after the
// last (else stop at the end). Waypoints are world-space points (>=2, a real path).
const PatrolBehavior = z.object({
  version: Ver,
  kind: z.literal("patrol"),
  waypoints: z.array(Vec3).min(2),
  speed: Positive,
  loop: z.boolean().default(true),
}).strict();

// wander — drift randomly within `radius` of the entity's anchor at `speed` (the RNG that drives
// it at runtime is the seeded, replayable Math.random — B2 concern; here it is pure params).
const WanderBehavior = z.object({
  version: Ver,
  kind: z.literal("wander"),
  radius: Positive,
  speed: Positive,
}).strict();

// script — the escape hatch: a NAMED script the host resolves (a registered behaviour routine),
// plus opaque params. Keeps the union extensible without baking every future behaviour into the
// schema — a genuine variant, not a stub, because the ref+params ARE the recorded contract.
const ScriptBehavior = z.object({
  version: Ver,
  kind: z.literal("script"),
  ref: z.string().min(1),
  params: JsonRecord.default({}),
}).strict();

export const BehaviorSpecSchema = z.discriminatedUnion("kind", [
  IdleBehavior, PatrolBehavior, WanderBehavior, ScriptBehavior,
]);

export type BehaviorSpec = z.infer<typeof BehaviorSpecSchema>;

/** The do-nothing default — a freshly placed entity's behaviour until an agent sets one. */
export const DEFAULT_BEHAVIOR: BehaviorSpec = { version: BEHAVIOR_SPEC_VERSION, kind: "idle" };

export function parseBehaviorSpec(json: string): BehaviorSpec {
  return BehaviorSpecSchema.parse(JSON.parse(json));
}

/** Stable, key-ordered clone — every field (incl. defaulted `loop`/`params`) in a fixed slot so
 *  serialize() is byte-identical for equal values (matches geometry-spec/world-config). */
export function canonicalizeBehaviorSpec(s: BehaviorSpec): BehaviorSpec {
  switch (s.kind) {
    case "idle":
      return { version: s.version, kind: "idle" };
    case "patrol":
      return {
        version: s.version, kind: "patrol",
        waypoints: s.waypoints.map(([x, y, z]) => [x, y, z] as [number, number, number]),
        speed: s.speed, loop: s.loop,
      };
    case "wander":
      return { version: s.version, kind: "wander", radius: s.radius, speed: s.speed };
    case "script":
      return {
        version: s.version, kind: "script", ref: s.ref,
        params: canonicalJsonValue(s.params) as Record<string, unknown>,
      };
  }
}

export function serializeBehaviorSpec(s: BehaviorSpec): string {
  return JSON.stringify(canonicalizeBehaviorSpec(s));
}

// ============================================================================
// EventSpec — a declarative {trigger, action}: WHEN something happens, WHAT the world does.
// World-level (not per-entity). Small, real, extensible, versioned.
// ============================================================================

// ── triggers (WHEN) — discriminated on `type` ───────────────────────────────
// onTick — fire every `every` ticks (a deterministic clock; every>=1).
const OnTickTrigger = z.object({
  type: z.literal("onTick"),
  every: z.number().int().min(1).default(1),
}).strict();
// onEnterRegion — fire when an entity enters a sphere (center + radius) — spatial gate.
const OnEnterRegionTrigger = z.object({
  type: z.literal("onEnterRegion"),
  center: Vec3,
  radius: Positive,
}).strict();
// onInteract — fire when the player interacts with a specific entity (an ent_ id).
const OnInteractTrigger = z.object({
  type: z.literal("onInteract"),
  entity: z.string().min(1),
}).strict();

const TriggerSchema = z.discriminatedUnion("type", [
  OnTickTrigger, OnEnterRegionTrigger, OnInteractTrigger,
]);
export type EventTrigger = z.infer<typeof TriggerSchema>;

// ── actions (WHAT) — discriminated on `type` ────────────────────────────────
// emit — raise a named signal with an opaque payload (the host's other skills consume it).
const EmitAction = z.object({
  type: z.literal("emit"),
  event: z.string().min(1),
  payload: JsonRecord.default({}),
}).strict();
// setBehavior — retarget an entity's declarative behaviour (nests a BehaviorSpec — the two
// formats compose: an event can rewrite an NPC's behaviour).
const SetBehaviorAction = z.object({
  type: z.literal("setBehavior"),
  entity: z.string().min(1),
  behavior: BehaviorSpecSchema,
}).strict();
// spawn — instantiate a named recipe at a world-space origin.
const SpawnAction = z.object({
  type: z.literal("spawn"),
  recipe: z.string().min(1),
  origin: Vec3,
}).strict();

const ActionSchema = z.discriminatedUnion("type", [
  EmitAction, SetBehaviorAction, SpawnAction,
]);
export type EventAction = z.infer<typeof ActionSchema>;

export const EventSpecSchema = z.object({
  version: Ver,
  trigger: TriggerSchema,
  action: ActionSchema,
}).strict();

export type EventSpec = z.infer<typeof EventSpecSchema>;

/** A minimal, valid sample: every tick, emit a named signal with an empty payload. */
export const DEFAULT_EVENT: EventSpec = {
  version: BEHAVIOR_SPEC_VERSION,
  trigger: { type: "onTick", every: 1 },
  action: { type: "emit", event: "tick", payload: {} },
};

export function parseEventSpec(json: string): EventSpec {
  return EventSpecSchema.parse(JSON.parse(json));
}

function canonicalTrigger(t: EventTrigger): EventTrigger {
  switch (t.type) {
    case "onTick":
      return { type: "onTick", every: t.every };
    case "onEnterRegion":
      return { type: "onEnterRegion", center: [t.center[0], t.center[1], t.center[2]], radius: t.radius };
    case "onInteract":
      return { type: "onInteract", entity: t.entity };
  }
}

function canonicalAction(a: EventAction): EventAction {
  switch (a.type) {
    case "emit":
      return { type: "emit", event: a.event, payload: canonicalJsonValue(a.payload) as Record<string, unknown> };
    case "setBehavior":
      return { type: "setBehavior", entity: a.entity, behavior: canonicalizeBehaviorSpec(a.behavior) };
    case "spawn":
      return { type: "spawn", recipe: a.recipe, origin: [a.origin[0], a.origin[1], a.origin[2]] };
  }
}

export function canonicalizeEventSpec(s: EventSpec): EventSpec {
  return { version: s.version, trigger: canonicalTrigger(s.trigger), action: canonicalAction(s.action) };
}

export function serializeEventSpec(s: EventSpec): string {
  return JSON.stringify(canonicalizeEventSpec(s));
}
