// limina world SNAPSHOT (Phase 4 M2) -- a full capture of world state at a tick
// T so recovery can START at T instead of replaying every command from genesis.
//
// ===========================================================================
// What a snapshot must capture so a delta replay from T is bit-identical to the
// original run (every source of state the delta depends on):
//
//   1. NATIVE PHYSICS  -- the real Rapier dynamics state (bodies+velocities+
//      sleep, colliders, joints, the warm-started contact graph, broad/narrow
//      phase, islands, and the id->handle slotmap incl. tombstones). Captured by
//      `op_physics_snapshot()` (bincode, f32 bit-exact) and restored by
//      `op_physics_restore()`. This is NOT reconstructable from transforms alone
//      (velocities + warmstart impulses are not in the ECS SoA).
//   2. ECS TRANSFORMS  -- every live entity's Position/Rotation/Scale (JS-owned
//      SoA). Body-bound entities are refreshed by the first delta `step`, but
//      body-less entities (e.g. scatter markers) are only mutated by recorded
//      skill commands, so their T-state must be restored.
//   3. ENTITY IDENTITY -- the entity table (id -> eid/bodyId, creation order) and
//      its `ent_` allocation counter, so a delta `scene.createEntity` issues the
//      SAME next id; AND the bitECS entity-index allocator, so a delta
//      `addEntity` issues the SAME next eid (incl. recycled slots after removal).
//      The native handle counter rides inside the physics blob (handles Vec).
//   4. RNG STATE       -- the internal 32-bit state of BOTH seeded streams at T:
//      the global `Math.random` slot (legacy/three consumers) and the world-owned
//      skill stream (`world.rng`, what delta skill handlers draw), so randomness
//      continues the SAME streams (NOT re-seeded from genesis).
//
// Recovery (see `recoverWorld`) restores 1-4 into a FRESH world, then replays
// ONLY the delta commands (seq >= snapshotSeq) -- the same command-application
// semantics as M1 replay, but starting mid-stream. The recorded delta carries
// agent/skill tool calls + physics ops; recovery NEVER re-runs decision
// providers, perception, or any from-genesis bootstrap.

import { Position, Rotation, Scale } from "../ecs/world.ts";
import { $internal } from "../../build/bitecs.bundle.mjs";
import type { EntityTableSnapshot, EntityOrigin, LoadedResourceMetadata, MaterialState, TransformOffset } from "../engine.ts";
import type { WorldContext } from "../skills/registry.ts";
import { BehaviorSpecSchema, EventSpecSchema, type BehaviorSpec, type EventSpec } from "../behavior/behavior-spec.ts";
import {
  captureRandomState,
  captureSkillRandomState,
  captureWorldState,
  installRandomState,
  installSkillRandomState,
  PHYSICS_OP_FN,
  PHYSICS_OP_OUT_BUFFER,
  syncAllBodies,
  type WorldCommand,
  type WorldStateSnapshot,
} from "./log.ts";
import type { ReplayDeps } from "./replay.ts";
import { LiminaTracer } from "../observability/event.ts";
import { z } from "../../build/zod.bundle.mjs";

// v3 (M2 → editor snapshot+bounded-tail): the snapshot is now SELF-SUFFICIENT for a
// browser rebuild — it carries each live entity's tags and resource/asset metadata in
// addition to physics + transforms + identity + RNG. Earlier versions relied on replaying
// the pre-snapshot authoring commands to reproduce tags/resources; a bounded-tail viewer
// no longer has those commands, so they must ride in the snapshot itself.
export const SNAPSHOT_VERSION = 3;

/** A character controller's body-LESS resume state at the snapshot tick. The
 *  kinematic body's TRANSFORM rides in the native physics blob, but a controller's
 *  vertical velocity / grounded flag / facing / swim hysteresis state are JS-owned (not reconstructable
 *  from the transform) and must be captured for an exact mid-stream resume. */
export interface CharacterSnapshotEntry {
  bodyId: number;
  vy: number;
  grounded: boolean;
  heading: number;
  swimming: boolean;
}

/** Structural shape a snapshot reads/writes for a character controller. The
 *  concrete `CharacterController` (js/src/world/character.ts) satisfies this; the
 *  interface keeps the worldlog layer free of a dependency on the world layer. */
export interface SnapshotableCharacter {
  readonly bodyId: number;
  serializeState(): { vy: number; grounded: boolean; heading: number; swimming?: boolean };
  restoreState(state: { vy: number; grounded: boolean; heading: number; swimming?: boolean }): void;
}

/** The bitECS entity-index allocator state (see createEntityIndex). Capturing it
 *  verbatim lets a restored world allocate the SAME next eids, including reuse of
 *  recycled slots after entity removal. */
export interface EntityIndexSnapshot {
  aliveCount: number;
  maxId: number;
  versioning: boolean;
  versionBits: number;
  entityMask: number;
  versionShift: number;
  versionMask: number;
  dense: number[];
  sparse: number[];
}

/** One live entity's identity + transform + authoring state at the snapshot tick. */
export interface SnapshotEntity {
  id: string;
  eid: number;
  bodyId?: number;
  generation: number;
  pos: [number, number, number];
  rot: [number, number, number, number];
  scale: [number, number, number];
  /** The entity's tag set (ecs.addComponent/removeComponent). Empty when untagged.
   *  Not reconstructable from transforms — carried so a bounded-tail viewer that
   *  never saw the tag commands still restores them. */
  tags: string[];
  /** Placed-asset metadata (v3), when this entity is asset-backed. The browser
   *  needs it to rebuild the mesh without replaying the original create command. */
  resource?: LoadedResourceMetadata;
  /** The create command ({tool, input}) that authored this entity (v3). Carries the
   *  structural params (primitive shape/size/material) that live ONLY in the create
   *  command, so a bounded-tail viewer rebuilds the mesh without the original command. */
  origin?: EntityOrigin;
  /** Scene-hierarchy parent (an ent_ id), when this entity is parented. */
  parent?: string;
  /** This entity's transform relative to `parent`, captured at parent-set time. */
  localOffset?: TransformOffset;
  /** First-class surface material (MaterialState), so a bounded-tail viewer restores the entity's
   *  color/roughness/metalness (or palette/imported name) without replaying setMaterial commands. */
  material?: MaterialState;
  /** First-class DECLARATIVE behaviour (BehaviorSpec: idle/patrol/wander/script), so a scene saved
   *  with behaviour reloads with it — carried WITHOUT replaying the behavior.set commands. */
  behavior?: BehaviorSpec;
  /** Standalone physics bodies OWNED by this entity but deliberately not bound to its `bodyId`
   *  (asset.place/placeLod building colliders). The bodies themselves ride the physics blob with
   *  stable handles; carrying the ids lets restore RE-ARM the remove-body dispose closure, so
   *  destroying a restored placed asset removes its collider instead of leaking an invisible
   *  wall (M18). Additive within v3: absent on pre-M18 snapshots. */
  runtimeBodyIds?: number[];
}

/** One world-level event definition (EventSpec {trigger, action}) + its stable id. Events are NOT
 *  per-entity, so they ride the snapshot as a top-level list (like `characters`), captured from and
 *  restored into a world-level event registry. */
export interface EventSpecSnapshotEntry {
  id: string;
  spec: EventSpec;
}

/** The structural surface the snapshot reads/writes for the world-level event registry. A concrete
 *  registry (js/src/skills/behavior-spec.ts) satisfies this; the interface keeps the worldlog layer
 *  free of a dependency on the concrete skill module (mirrors SnapshotableCharacter). */
export interface SnapshotableEventRegistry {
  /** Every defined event (id + canonical spec), in definition order. */
  listEventSpecs(): EventSpecSnapshotEntry[];
  /** Replace the registry's contents with these entries (a self-sufficient restore). */
  restoreEventSpecs(entries: readonly EventSpecSnapshotEntry[]): void;
}

// ---- snapshot participants (H2) --------------------------------------------
// The generalization of the bespoke `characters?:` / `events?:` plumbing: every
// owner of runtime-mutated sim state (the CoreSkills managers) DECLARES itself to
// the snapshot machinery instead of the machinery hard-coding the owners it
// knows about. Hosts pass ONE SnapshotParticipantRegistry (assembled by
// registerCoreSkills as `core.snapshotParticipants`); the legacy optional
// `characters`/`events` params remain for one release, delegating to reserved
// participant keys.

/** One owner of runtime-mutated world state, enrolled in snapshot capture/restore. */
export interface SnapshotParticipant {
  /** Stable snapshot key (e.g. "inventory"). Renaming it orphans every snapshot
   *  that carried state under the old key — the restore fails loudly. */
  key: string;
  /** Validates this participant's captured state at restore time (parse cannot
   *  know the registry, so validation happens when the participant is matched). */
  schema: z.ZodType<unknown>;
  /** Deterministic, canonically-sorted, JSON-serializable capture of the WHOLE
   *  manager state. Two consecutive captures of an unchanged world MUST be
   *  JSON-identical (the p104 gate double-captures and compares). */
  capture(): unknown;
  /** Wholesale replace the manager's state with a schema-validated capture. */
  restore(state: unknown): void;
}

/** Reserved participant keys that serialize into the snapshot's EXISTING
 *  top-level fields (`characters` / `events`) rather than `managers`, so the
 *  wire format of pre-participant snapshots is unchanged in both directions. */
export const CHARACTERS_PARTICIPANT_KEY = "characters";
export const EVENTS_PARTICIPANT_KEY = "events";

/** The one object a host hands to capture/restore. Duplicate keys throw: two
 *  owners claiming one key would silently clobber each other's state. */
export class SnapshotParticipantRegistry {
  private readonly participants = new Map<string, SnapshotParticipant>();

  register(participant: SnapshotParticipant): void {
    if (this.participants.has(participant.key)) {
      throw new Error(`snapshot participants: duplicate key '${participant.key}'`);
    }
    this.participants.set(participant.key, participant);
  }

  get(key: string): SnapshotParticipant | undefined {
    return this.participants.get(key);
  }

  has(key: string): boolean {
    return this.participants.has(key);
  }

  /** Registered keys, sorted (the canonical capture order). */
  keys(): string[] {
    return [...this.participants.keys()].sort();
  }

  /** Capture every non-reserved participant into the snapshot's `managers`
   *  record, keys sorted so the serialized snapshot is byte-deterministic. */
  captureManagers(): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const key of this.keys()) {
      if (key === CHARACTERS_PARTICIPANT_KEY || key === EVENTS_PARTICIPANT_KEY) continue;
      out[key] = this.participants.get(key)!.capture();
    }
    return out;
  }
}

/** Wrap live character controllers as the reserved "characters" participant, so a
 *  host that owns controllers registers ONE object instead of threading a second
 *  optional param. Capture is sorted by bodyId (canonical); restore matches live
 *  controllers by bodyId, exactly as the legacy param path always has. */
export function charactersParticipant(characters: readonly SnapshotableCharacter[]): SnapshotParticipant {
  return {
    key: CHARACTERS_PARTICIPANT_KEY,
    schema: z.array(characterSnapshotSchema),
    capture: (): CharacterSnapshotEntry[] =>
      characters
        .map((c) => {
          const s = c.serializeState();
          return { bodyId: c.bodyId, vy: s.vy, grounded: s.grounded, heading: s.heading, swimming: s.swimming ?? false };
        })
        .sort((a, b) => a.bodyId - b.bodyId),
    restore: (state): void => {
      const entries = state as CharacterSnapshotEntry[];
      const byId = new Map(characters.map((c) => [c.bodyId, c]));
      for (const entry of entries) {
        byId.get(entry.bodyId)?.restoreState({ vy: entry.vy, grounded: entry.grounded, heading: entry.heading, swimming: entry.swimming });
      }
    },
  };
}

/** Wrap the world-level event registry as the reserved "events" participant. */
export function eventsParticipant(events: SnapshotableEventRegistry): SnapshotParticipant {
  return {
    key: EVENTS_PARTICIPANT_KEY,
    schema: z.array(z.object({ id: z.string(), spec: EventSpecSchema })),
    capture: (): EventSpecSnapshotEntry[] => events.listEventSpecs(),
    restore: (state): void => events.restoreEventSpecs(state as EventSpecSnapshotEntry[]),
  };
}

/** A complete, self-contained world snapshot at a tick boundary. */
export interface WorldSnapshot {
  snapshotVersion: number;
  sessionId: string;
  /** Simulation tick the snapshot was taken at (after that tick's step+sync). */
  tick: number;
  /** Commands [0, snapshotSeq) are baked into this snapshot; [snapshotSeq, end)
   *  are the delta a recovery replays. */
  snapshotSeq: number;
  /** mulberry32 internal state of the installed seeded Math.random at T. */
  rngState: number;
  /** mulberry32 internal state of the world-owned SKILL stream (`world.rng`) at T.
   *  Additive within schema v3 (the characters[].swimming precedent): absent in a
   *  pre-skill-stream snapshot, and restore then seeds the skill stream from the
   *  legacy `rngState` -- exact, not approximate, because no skill draw predates
   *  the skill stream. */
  skillRngState?: number;
  /** EntityTable `ent_` allocation counter + version at T. */
  entitySeq: number;
  entityVersion: number;
  entityIndex: EntityIndexSnapshot;
  entities: SnapshotEntity[];
  /** Character-controller resume state (vy/grounded/heading) per controller body.
   *  Empty when the session has no character controllers. */
  characters: CharacterSnapshotEntry[];
  /** World-level declarative event definitions (EventSpec {trigger, action}) defined via
   *  event.define. Carried so a self-sufficient snapshot reloads the world's events without
   *  replaying the pre-snapshot event.define commands. Empty when no events were defined. */
  events: EventSpecSnapshotEntry[];
  /** Per-manager runtime sim state (inventories, quests, triggers, game state, …), keyed by
   *  SnapshotParticipant key. Additive-optional within v3 (the characters[].swimming precedent):
   *  absent/{} on old snapshots → every participant restores empty, exactly the pre-H2 behavior.
   *  Each entry is validated by its participant's schema at restore; an entry whose key has NO
   *  registered participant FAILS LOUDLY — a snapshot claiming state the runtime cannot restore
   *  must never be silently dropped. */
  managers: Record<string, unknown>;
  /** base64 of the native Rapier physics blob (op_physics_snapshot). */
  physics: string;
}

// ---- base64 (no btoa/atob in the embedded runtime) ------------------------
const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const B64_INV: number[] = (() => {
  const inv = new Array<number>(128).fill(-1);
  for (let i = 0; i < B64.length; i++) inv[B64.charCodeAt(i)] = i;
  return inv;
})();

export function bytesToBase64(bytes: Uint8Array): string {
  let out = "";
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + B64[(n >> 6) & 63] + B64[n & 63];
  }
  const rem = bytes.length - i;
  if (rem === 1) {
    const n = bytes[i] << 16;
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + "==";
  } else if (rem === 2) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8);
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + B64[(n >> 6) & 63] + "=";
  }
  return out;
}

export function base64ToBytes(b64: string): Uint8Array {
  if (b64.length % 4 !== 0) throw new Error("world snapshot: invalid base64 length");
  const firstPad = b64.indexOf("=");
  if (firstPad !== -1 && !/^=+$/.test(b64.slice(firstPad))) {
    throw new Error("world snapshot: invalid base64 padding");
  }
  let len = b64.length;
  while (len > 0 && b64[len - 1] === "=") len--;
  const outLen = (len * 3) >> 2;
  const out = new Uint8Array(outLen);
  let o = 0;
  let acc = 0;
  let bits = 0;
  for (let i = 0; i < len; i++) {
    const code = b64.charCodeAt(i);
    const v = code < B64_INV.length ? B64_INV[code] : -1;
    if (v === undefined || v < 0) throw new Error("world snapshot: invalid base64 character");
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[o++] = (acc >> bits) & 0xff;
    }
  }
  return out;
}

// ---- bitECS entity-index access (the documented `$internal` seam) ---------
interface MutableEntityIndex extends EntityIndexSnapshot {}
interface BitEcsInternal {
  entityIndex: MutableEntityIndex;
}
function ecsInternal(ecs: unknown): BitEcsInternal {
  const internal = (ecs as Record<symbol, BitEcsInternal>)[$internal as unknown as symbol];
  if (internal === undefined || internal.entityIndex === undefined) {
    throw new Error("world snapshot: bitECS world has no $internal entity index");
  }
  return internal;
}

/** Exported for the registry's per-chain undo ledger (H1): a failed chain must
 *  rewind the bitECS allocator so replay (which never runs the failed chain)
 *  allocates the SAME eids for every subsequent command. */
export function captureEntityIndex(ecs: unknown): EntityIndexSnapshot {
  const idx = ecsInternal(ecs).entityIndex;
  return {
    aliveCount: idx.aliveCount,
    maxId: idx.maxId,
    versioning: idx.versioning,
    versionBits: idx.versionBits,
    entityMask: idx.entityMask,
    versionShift: idx.versionShift,
    versionMask: idx.versionMask,
    dense: idx.dense.slice(),
    sparse: idx.sparse.slice(),
  };
}

/** Swap a world's entity index for a restored one. Safe for a fresh world (no
 *  entities yet) AND for the registry's chain unwind (every entity the chain
 *  created has been torn down first), so future addEntity calls continue the
 *  captured allocation sequence exactly. */
export function restoreEntityIndex(ecs: unknown, snap: EntityIndexSnapshot): void {
  ecsInternal(ecs).entityIndex = {
    aliveCount: snap.aliveCount,
    maxId: snap.maxId,
    versioning: snap.versioning,
    versionBits: snap.versionBits,
    entityMask: snap.entityMask,
    versionShift: snap.versionShift,
    versionMask: snap.versionMask,
    dense: snap.dense.slice(),
    sparse: snap.sparse.slice(),
  };
}

// ---- capture --------------------------------------------------------------

export interface CaptureSnapshotOptions {
  sessionId: string;
  tick: number;
  /** The delta boundary: commands with seq < this are baked into the snapshot;
   *  seq >= this form the delta. Callers MUST derive this from the recorder's
   *  COMMITTED count (recorder.flushableCount()), never commandCount: an in-flight
   *  command counted by commandCount can still fail, be discarded, and renumber
   *  every later seq — a boundary past it then silently drops a delta command. */
  snapshotSeq: number;
  /** Live character controllers whose JS-owned resume state must be captured.
   *  Their kinematic bodies are already in the native blob; this captures the
   *  vy/grounded/heading the blob cannot reconstruct.
   *  LEGACY (one release): delegates to the reserved "characters" participant —
   *  new hosts register charactersParticipant(...) on `participants` instead. */
  characters?: readonly SnapshotableCharacter[];
  /** The world-level event registry whose definitions must be baked into the snapshot so a
   *  self-sufficient restore reloads them without replaying the event.define commands.
   *  LEGACY (one release): delegates to the reserved "events" participant — new hosts get it
   *  from `core.snapshotParticipants` instead. */
  events?: SnapshotableEventRegistry;
  /** Every registered owner of runtime-mutated sim state (H2) — the ONE object a host passes
   *  (registerCoreSkills assembles it as `core.snapshotParticipants`). Non-reserved participants
   *  capture into `managers`; the reserved "characters"/"events" keys feed the existing
   *  top-level fields. */
  participants?: SnapshotParticipantRegistry;
  /** Set false on hot paths that only need the entity projection (net/server.ts snapshotLine,
   *  the per-join AoI view): skips every participant capture so the join stays O(relevant).
   *  Such a snapshot is NOT self-sufficient for manager state — never persist it as a save. */
  includeManagers?: boolean;
}

/** Capture a complete world snapshot at the current tick boundary. MUST be called
 *  after the tick's step+syncAllBodies (so SoA reflects the post-step state) and
 *  with the seeded RNG installed. */
export function captureWorldSnapshot(world: WorldContext, opts: CaptureSnapshotOptions): WorldSnapshot {
  const table = world.entities.snapshot();
  const entities: SnapshotEntity[] = [];
  for (const entry of table.entries) {
    const eid = entry.eid;
    // Tags (world.tags is keyed by eid) and resource (a runtime binding on the live
    // entry) are the two authoring-state pieces the identity slice drops — capture
    // them so the snapshot alone reproduces the entity, no pre-snapshot replay needed.
    const tagSet = world.tags.get(eid);
    const live = world.entities.resolve(entry.id);
    entities.push({
      id: entry.id,
      eid,
      bodyId: entry.bodyId,
      generation: entry.generation,
      pos: [Position.x[eid], Position.y[eid], Position.z[eid]],
      rot: [Rotation.x[eid], Rotation.y[eid], Rotation.z[eid], Rotation.w[eid]],
      scale: [Scale.x[eid], Scale.y[eid], Scale.z[eid]],
      tags: tagSet === undefined ? [] : [...tagSet].sort(),
      resource: live?.resource,
      origin: live?.origin,
      parent: live?.parent,
      localOffset: live?.localOffset,
      material: live?.material,
      behavior: live?.behavior,
      runtimeBodyIds: live?.runtimeBodyIds !== undefined && live.runtimeBodyIds.length > 0 ? [...live.runtimeBodyIds] : undefined,
    });
  }
  // Legacy params delegate to the reserved participant keys (one-release compat);
  // a host passing BOTH keeps the explicit param authoritative.
  const characters: CharacterSnapshotEntry[] = opts.characters !== undefined
    ? charactersParticipant(opts.characters).capture() as CharacterSnapshotEntry[]
    : (opts.participants?.get(CHARACTERS_PARTICIPANT_KEY)?.capture() as CharacterSnapshotEntry[] | undefined) ?? [];
  const events: EventSpecSnapshotEntry[] = opts.events !== undefined
    ? opts.events.listEventSpecs()
    : (opts.participants?.get(EVENTS_PARTICIPANT_KEY)?.capture() as EventSpecSnapshotEntry[] | undefined) ?? [];
  const physics = world.ops.op_physics_snapshot();
  return {
    snapshotVersion: SNAPSHOT_VERSION,
    sessionId: opts.sessionId,
    tick: opts.tick,
    snapshotSeq: opts.snapshotSeq,
    rngState: captureRandomState(),
    skillRngState: world.rng?.getState() ?? captureSkillRandomState(),
    entitySeq: table.seq,
    entityVersion: table.version,
    entityIndex: captureEntityIndex(world.ecs),
    entities,
    characters,
    events,
    managers: opts.includeManagers === false ? {} : opts.participants?.captureManagers() ?? {},
    physics: bytesToBase64(physics),
  };
}

export function serializeSnapshot(snapshot: WorldSnapshot): string {
  return JSON.stringify(snapshot);
}

const finite = z.number().refine(Number.isFinite, "expected finite number");
const int = finite.refine(Number.isInteger, "expected integer");
// bitECS index arrays are SPARSE number[] (unset slots are holes). JSON turns a
// hole into `null` on the wire, so parsing accepts null per slot but converts it
// BACK into a hole — the parsed value then actually satisfies the declared
// EntityIndexSnapshot number[] type, and the capture -> serialize -> parse ->
// restore round-trip reproduces the original hole layout exactly.
const sparseNumberArray = z.array(z.union([int, z.null()])).transform((slots: (number | null)[]): number[] => {
  const out = new Array<number>(slots.length);
  for (let i = 0; i < slots.length; i++) {
    const v = slots[i];
    if (v !== null) out[i] = v;
  }
  return out;
});
const vec3 = z.tuple([finite, finite, finite]);
const vec4 = z.tuple([finite, finite, finite, finite]);
const entityIndexSchema = z.object({
  aliveCount: int,
  maxId: int,
  versioning: z.boolean(),
  versionBits: int,
  entityMask: int,
  versionShift: int,
  versionMask: int,
  dense: sparseNumberArray,
  sparse: sparseNumberArray,
});
// Placed-asset metadata (LoadedResourceMetadata). passthrough() so a future field
// survives a snapshot round-trip instead of being silently stripped on parse.
const resourceMetaSchema = z.object({
  kind: z.literal("gltf"),
  assetId: z.string(),
  source: z.string(),
  hash: z.string(),
  bytes: int,
  rootName: z.string().optional(),
  objectCount: int,
  meshCount: int,
  materialCount: int,
  textureCount: int,
}).passthrough();
const snapshotEntitySchema = z.object({
  id: z.string(),
  eid: int,
  bodyId: int.optional(),
  generation: int,
  pos: vec3,
  rot: vec4,
  scale: vec3,
  // Optional/defaulted so a pre-v3 or minimal snapshot literal still parses.
  tags: z.array(z.string()).optional().default([]),
  resource: resourceMetaSchema.optional(),
  // The create command; input is arbitrary skill params (passthrough — do not strip).
  origin: z.object({ tool: z.string(), input: z.record(z.string(), z.unknown()) }).optional(),
  // Scene hierarchy: parent id + this entity's transform relative to it.
  parent: z.string().optional(),
  localOffset: z.object({ pos: vec3, rot: vec4, scale: vec3 }).optional(),
  // First-class surface material (color/roughness/metalness, or palette/imported name + pbr).
  material: z.object({
    color: z.number().optional(),
    roughness: z.number().optional(),
    metalness: z.number().optional(),
    name: z.string().optional(),
    pbr: z.boolean().optional(),
  }).optional(),
  // First-class declarative behaviour — validated by the real BehaviorSpec schema (a torn/forged
  // snapshot behaviour is rejected on parse, never trusted). Optional so a pre-behaviour snapshot
  // (or a behaviour-less entity) still parses.
  behavior: BehaviorSpecSchema.optional(),
  // Standalone collider bodies owned by this entity (M18). Optional: pre-M18 snapshots lack it.
  runtimeBodyIds: z.array(int).optional(),
});
const characterSnapshotSchema = z.object({
  bodyId: int,
  vy: finite,
  grounded: z.boolean(),
  heading: finite,
  // Additive within schema v3: old v3 snapshots default to the legacy dry state.
  swimming: z.boolean().optional().default(false),
});
const worldSnapshotSchema = z.object({
  snapshotVersion: z.literal(SNAPSHOT_VERSION),
  sessionId: z.string(),
  tick: int,
  snapshotSeq: int,
  rngState: int,
  // Additive within v3: absent -> restore seeds the skill stream from rngState.
  skillRngState: int.optional(),
  entitySeq: int,
  entityVersion: int,
  entityIndex: entityIndexSchema,
  entities: z.array(snapshotEntitySchema),
  characters: z.array(characterSnapshotSchema).optional().default([]),
  // World-level event definitions — each spec validated by the real EventSpec schema. Optional +
  // defaulted so a pre-events snapshot still parses (additive, back-compatible with v3).
  events: z.array(z.object({ id: z.string(), spec: EventSpecSchema })).optional().default([]),
  // Per-participant manager state (H2). Optional + defaulted so a pre-participant snapshot still
  // parses; each entry is validated by its participant's OWN schema at restore time (parse cannot
  // know the registry).
  managers: z.record(z.string(), z.unknown()).optional().default({}),
  physics: z.string(),
});

export function parseSnapshot(json: string): WorldSnapshot {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (err) {
    throw new Error(`world snapshot: invalid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  const snap = worldSnapshotSchema.safeParse(parsed);
  if (!snap.success) {
    const record = typeof parsed === "object" && parsed !== null ? parsed as { snapshotVersion?: unknown } : {};
    if (record.snapshotVersion !== undefined && record.snapshotVersion !== SNAPSHOT_VERSION) {
      throw new Error(`world snapshot: version ${record.snapshotVersion} != ${SNAPSHOT_VERSION}`);
    }
    throw new Error(`world snapshot: malformed snapshot: ${snap.error.message}`);
  }
  return snap.data as WorldSnapshot;
}

// ---- recovery -------------------------------------------------------------

export interface RecoveryResult {
  state: WorldStateSnapshot;
  world: WorldContext;
  /** Number of delta commands replayed (excludes the baked-in [0, snapshotSeq)). */
  deltaCommands: number;
  deltaSkillInvokes: number;
  deltaPhysicsOps: number;
  deltaSteps: number;
}

/** Apply a snapshot to a fresh world: restore RNG, native physics, the bitECS
 *  allocator, the entity table, and every live entity's SoA transform. Leaves the
 *  world primed to replay the delta from tick T. Rapier's serialized dynamics
 *  state is exact, but its intentionally transient pipeline workspace is rebuilt,
 *  so long active continuations are compared with an explicit numeric tolerance. */
export function restoreSnapshot(
  world: WorldContext,
  snapshot: WorldSnapshot,
  characters?: readonly SnapshotableCharacter[],
  events?: SnapshotableEventRegistry,
  participants?: SnapshotParticipantRegistry,
): void {
  // 1. RNG: resume BOTH seeded generators mid-stream -- the global Math.random
  //    slot and the world-owned skill stream delta skills draw via ctx.world.rng.
  //    A pre-skillRngState snapshot seeds the skill stream from the legacy global
  //    state (exact: no skill draw predates the skill stream).
  installRandomState(snapshot.rngState);
  world.rng = installSkillRandomState(snapshot.skillRngState ?? snapshot.rngState);
  // 2. Native physics: deserialize the real Rapier state (body ids stay stable).
  world.ops.op_physics_restore(base64ToBytes(snapshot.physics));
  // 3. bitECS allocator: future addEntity continues the original eid sequence.
  restoreEntityIndex(world.ecs, snapshot.entityIndex);
  // 4. Entity table: same live entries (creation order) + `ent_` counter.
  const tableSnap: EntityTableSnapshot = {
    seq: snapshot.entitySeq,
    version: snapshot.entityVersion,
    entries: snapshot.entities.map((e) => ({
      id: e.id,
      eid: e.eid,
      generation: e.generation,
      bodyId: e.bodyId,
    })),
  };
  world.entities.restore(tableSnap);
  // 5. ECS transforms + authoring state (tags/resource): every live entity at T.
  //    The snapshot is authoritative, so tags are replaced wholesale (a fresh
  //    recovery world starts empty; a reused world must not keep stale tags).
  world.tags.clear();
  for (const e of snapshot.entities) {
    Position.x[e.eid] = e.pos[0]; Position.y[e.eid] = e.pos[1]; Position.z[e.eid] = e.pos[2];
    Rotation.x[e.eid] = e.rot[0]; Rotation.y[e.eid] = e.rot[1]; Rotation.z[e.eid] = e.rot[2]; Rotation.w[e.eid] = e.rot[3];
    Scale.x[e.eid] = e.scale[0]; Scale.y[e.eid] = e.scale[1]; Scale.z[e.eid] = e.scale[2];
    if (e.tags.length > 0) world.tags.set(e.eid, new Set(e.tags));
    if (e.resource !== undefined) world.entities.bindResource(e.id, e.resource);
    if (e.origin !== undefined) world.entities.bindOrigin(e.id, e.origin);
    if (e.parent !== undefined) world.entities.setParent(e.id, e.parent, e.localOffset);
    if (e.material !== undefined) world.entities.bindMaterial(e.id, e.material);
    if (e.behavior !== undefined) world.entities.bindBehavior(e.id, e.behavior);
    // Standalone owned colliders (M18): the bodies came back inside the physics blob (step 2,
    // handles stable), but the remove-body dispose closure is runtime-only — RE-ARM it, so
    // destroying this restored entity removes its collider instead of leaking an invisible wall.
    if (e.runtimeBodyIds !== undefined && e.runtimeBodyIds.length > 0) {
      const ids = [...e.runtimeBodyIds];
      world.entities.bindRuntimeBodies(e.id, ids);
      world.entities.chainRuntimeDispose(e.id, "snapshot-restored colliders", () => {
        const errors: unknown[] = [];
        for (const bodyId of ids) {
          try { world.ops.op_physics_remove_body(bodyId); } catch (error) { errors.push(error); }
        }
        if (errors.length > 0) throw new AggregateError(errors, `restored collider removal failed for '${e.id}'`);
      });
    }
  }
  // World-level events: replace the registry's contents with the snapshot's baked definitions, so
  // a self-sufficient restore reloads them without replaying the pre-snapshot event.define stream.
  // Legacy `events` param wins for one release; otherwise the reserved participant restores.
  if (events !== undefined) events.restoreEventSpecs(snapshot.events);
  else participants?.get(EVENTS_PARTICIPANT_KEY)?.restore(snapshot.events);
  // 6. Character controllers: reinstall the JS-owned vy/grounded/heading/swim mode the
  //    native blob cannot carry (matched to live controllers by body id). The
  //    body transform itself was restored in step 2. Legacy `characters` param wins
  //    for one release; otherwise the reserved participant restores.
  if (characters !== undefined && snapshot.characters.length > 0) {
    charactersParticipant(characters).restore(snapshot.characters);
  } else if (characters === undefined && snapshot.characters.length > 0) {
    participants?.get(CHARACTERS_PARTICIPANT_KEY)?.restore(snapshot.characters);
  }
  // 7. Manager state (H2): every `managers` entry restores through its registered
  //    participant, validated by that participant's own schema. An entry with NO
  //    registered participant fails loudly — the snapshot claims state this runtime
  //    cannot restore, and silently dropping it would be an incomplete world lying
  //    about being complete. Absent/{} (pre-participant snapshots) restores nothing:
  //    exactly the pre-H2 behavior.
  const managerKeys = Object.keys(snapshot.managers ?? {}).sort();
  for (const key of managerKeys) {
    const participant = participants?.get(key);
    if (participant === undefined) {
      throw new Error(`world snapshot: managers entry '${key}' has no registered snapshot participant — cannot restore state the runtime does not own`);
    }
    const parsed = participant.schema.safeParse(snapshot.managers[key]);
    if (!parsed.success) {
      throw new Error(`world snapshot: managers entry '${key}' failed its participant schema: ${parsed.error.message}`);
    }
    participant.restore(parsed.data);
  }
}

/** Recover a world from a snapshot + the delta command stream. Builds a FRESH
 *  world via `deps.makeWorld`, restores the snapshot, then replays ONLY the delta
 *  commands (the same command-application semantics as M1 replay, started
 *  mid-stream). The caller chooses exact or explicitly tolerant transform
 *  comparison based on whether the captured physics world was active.
 *
 *  `deltaCommands` MUST be exactly the commands with seq >= snapshot.snapshotSeq
 *  (in seq order). They carry recorded tool calls + physics ops; NO decision
 *  provider, perception, or genesis bootstrap is re-run. */
export async function recoverWorld(
  snapshot: WorldSnapshot,
  deltaCommands: WorldCommand[],
  deps: ReplayDeps,
  characters?: readonly SnapshotableCharacter[],
  events?: SnapshotableEventRegistry,
  /** The FRESH world's participant registry (H2). A thunk is accepted because the
   *  registry only exists after deps.makeRegistry runs (the caller's makeRegistry
   *  closure stashes its CoreSkills and the thunk reads it). */
  participants?: SnapshotParticipantRegistry | (() => SnapshotParticipantRegistry | undefined),
): Promise<RecoveryResult> {
  const tracer = deps.tracer ?? new LiminaTracer("ses_worldlog_recover");
  const registry = deps.makeRegistry(tracer);
  const world = deps.makeWorld();
  const resolvedParticipants = typeof participants === "function" ? participants() : participants;

  // Fresh transform storage: zero the global SoA so any entity the snapshot does
  // not restore reads back as 0 (and is caught by the bit-identical check), then
  // overwrite the live entities from the snapshot.
  Position.x.fill(0); Position.y.fill(0); Position.z.fill(0);
  Rotation.x.fill(0); Rotation.y.fill(0); Rotation.z.fill(0); Rotation.w.fill(0);
  Scale.x.fill(0); Scale.y.fill(0); Scale.z.fill(0);
  restoreSnapshot(world, snapshot, characters, events, resolvedParticipants);

  let deltaSkillInvokes = 0;
  let deltaPhysicsOps = 0;
  let deltaSteps = 0;

  for (const cmd of deltaCommands) {
    if (cmd.kind === "seed") {
      // A delta must never contain the seed (seq 0, always pre-snapshot); the RNG
      // is resumed from captured state. A stray seed would reset the stream.
      throw new Error("world recovery: delta unexpectedly contains a seed command");
    }
    if (cmd.kind === "physics") {
      const op = world.ops[PHYSICS_OP_FN[cmd.op]] as (...a: unknown[]) => unknown;
      const outLen = PHYSICS_OP_OUT_BUFFER[cmd.op];
      if (outLen === undefined) op(...cmd.args);
      else op(...cmd.args, new Float32Array(outLen));
      deltaPhysicsOps++;
      if (cmd.op === "step") {
        deltaSteps++;
        syncAllBodies(world);
      }
      continue;
    }
    const response = await registry.invoke(cmd.tool, cmd.input, {
      agentId: cmd.actorId,
      sessionId: cmd.sessionId,
      permissions: new Set(cmd.perms),
      profile: cmd.profile,
      tick: cmd.tick,
      world,
      causedBy: [],
    });
    if (!response.success) {
      const code = response.error?.code ?? "unknown";
      const message = response.error?.message ?? "skill invocation failed";
      throw new Error(`world recovery: delta command seq ${cmd.seq} tool ${cmd.tool} failed (${code}): ${message}`);
    }
    deltaSkillInvokes++;
  }

  return {
    state: captureWorldState(world),
    world,
    deltaCommands: deltaCommands.length,
    deltaSkillInvokes,
    deltaPhysicsOps,
    deltaSteps,
  };
}

/** Convenience: split a full command stream into the delta a recovery needs. */
export function deltaCommandsAfter(commands: WorldCommand[], snapshotSeq: number): WorldCommand[] {
  return commands.filter((c) => c.seq >= snapshotSeq);
}
