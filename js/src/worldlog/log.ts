// limina world log (Phase 4 M1 / P4.0a) -- the AUTHORITATIVE, replay-complete
// command stream for a deterministic world session.
//
// ===========================================================================
// CONTRACT (load-bearing; M2 snapshots, M3 durable sink, M4 state-sync, M5 AoI
// consume this -- do NOT change the shape without bumping `LOG_VERSION`).
// ===========================================================================
//
// The world log is DISTINCT from the observability trace (observability/event.ts):
//   - The trace records WHAT HAPPENED (EventLoom-shaped, sha256-chained) for
//     audit/causality. It is NOT sufficient to rebuild state on its own.
//   - The world log records the minimal AUTHORITATIVE INPUTS needed to rebuild
//     the final world state by RE-EXECUTION into a FRESH engine. It is the
//     source of truth for replay/recovery.
//
// Replay-complete command set -- every source of world mutation / nondeterminism
// the engine has (audited across Phase 0-3):
//
//   1. "seed"    -- the deterministic PRNG seed (uint32). Installed AS
//                   `Math.random` (see installSeededRandom) so any randomness in
//                   any skill handler is reproducible. Recorded ONCE, first.
//   2. "physics" -- a native Rapier op issued OUTSIDE a skill (scenario/loop
//                   bootstrap + the per-tick step): create_world (gravity),
//                   add_ground, add_* (spawns), apply_impulse, remove_body, and
//                   step. `step` is the tick-advancing op and frames ticks.
//                   Physics ops issued INSIDE a skill are NOT logged here -- the
//                   skill command reproduces them on re-invoke (no double-apply).
//   3. "skill"   -- a SkillRegistry.invoke (the single choke point ALL world
//                   mutations flow through: scene.createEntity, ecs.*, three.*,
//                   physics.applyImpulse, ...). Carries {tick, tool, input,
//                   actorId, sessionId, perms}. AGENT ACTIONS are captured here
//                   too (actionSystem invokes through the same registry): replay
//                   RE-APPLIES the recorded tool call and NEVER re-runs the LLM /
//                   scripted decision provider.
//
// Determinism foundation (Phase 0-3, proven): the fixed-step native Rapier sim
// is bit-identical for identical inputs/build (p0_5_physics, billiards_physics).
// Body ids and `ent_` ids are allocated monotonically from a fresh world, so
// re-issuing the SAME ordered command stream yields identical ids and state.
//
// Ordering: commands form ONE total order (the `seq` field). Replay applies them
// in `seq` order. The interleaving of skill commands (incl. agent actions) and
// `step`s is exactly what reproduces timing-dependent behaviour deterministically.
//
// Serialization: JSONL, ASCII-only. Line 1 is a `meta` header; each subsequent
// line is one command.
//
// INVARIANT (Seam 3 -- COMMANDS, NOT BYTES): a persisted world log is human-
// readable TEXT (JSONL), and it records ONLY the deterministic INPUTS -- the
// `seed` plus the ordered command stream (skills as {tool,input}, raw physics as
// {op,args}, in total `seq` order). It NEVER stores raw runtime bytes: there is
// no serialized native Rapier world, no ECS SoA dump, no opaque blob field on any
// line. Final world state is REBUILT by re-executing these commands into a fresh
// engine (see replay.ts), so the command stream is the single source of truth;
// M2 snapshots are a replay-acceleration CACHE, never authoritative. (Content
// hashing / sha256 chaining lives in the companion observability trace, above.)

import type { EngineOps } from "../engine.ts";
import { Position, Rotation, Scale, syncPhysicsBodyTransform } from "../ecs/world.ts";
import { resolveProfile } from "../skills/permissions.ts";
import { z } from "../../build/zod.bundle.mjs";

/** The per-entity fields the world log can capture beyond eid/bodyId. All optional:
 *  the real EntityTable's EntityEntry satisfies this structurally, and a minimal
 *  stub table (tests, keyframe worlds) that resolves only {eid, bodyId} still
 *  type-checks — absent fields are simply not captured. */
export interface ResolvedEntityLike {
  eid: number;
  bodyId?: number;
  generation?: number;
  parent?: string;
  material?: unknown;
  resource?: unknown;
  behavior?: unknown;
}

/** Minimal entity-table handle a recorder/replay reads from. The Engine and the
 *  skill-layer WorldContext both satisfy this structurally. */
export interface EntityTableLike {
  ids(): string[];
  resolve(id: string): ResolvedEntityLike | undefined;
}

/** The minimal world surface the world log reads (state capture + body sync). */
export interface WorldLike {
  entities: EntityTableLike;
  ops: EngineOps;
  /** Gameplay tag map (eid -> tag set). Real WorldContexts carry it; a stub world
   *  without it simply captures no tags. */
  tags?: ReadonlyMap<number, ReadonlySet<string>>;
}

// v2: a skill line may carry the caller's permission PROFILE NAME (`profile`)
// instead of the full permission array (`perms`) — the profile is resolved back to
// the array on parse via skills/permissions.ts. v1 lines (full `perms` array, no
// `profile`) parse forever; the change is additive, so parseWorldLog accepts any
// logVersion in [1, LOG_VERSION].
export const LOG_VERSION = 2;

/** Native Rapier ops recorded as raw `physics` commands (mutating only). */
export type PhysicsOpName =
  | "create_world"
  | "add_ground"
  | "add_box"
  | "add_box_material"
  | "add_sphere"
  | "add_capsule"
  | "add_static_box"
  | "add_static_sphere"
  | "add_static_capsule"
  | "add_character"
  | "move_character"
  | "remove_body"
  | "apply_impulse"
  | "step";

/** Maps a recorded physics op name to its EngineOps method (used by replay). */
export const PHYSICS_OP_FN: Record<PhysicsOpName, keyof EngineOps> = {
  create_world: "op_physics_create_world",
  add_ground: "op_physics_add_ground",
  add_box: "op_physics_add_box",
  add_box_material: "op_physics_add_box_material",
  add_sphere: "op_physics_add_sphere",
  add_capsule: "op_physics_add_capsule",
  add_static_box: "op_physics_add_static_box",
  add_static_sphere: "op_physics_add_static_sphere",
  add_static_capsule: "op_physics_add_static_capsule",
  add_character: "op_physics_add_character",
  move_character: "op_physics_move_character",
  remove_body: "op_physics_remove_body",
  apply_impulse: "op_physics_apply_impulse",
  step: "op_physics_step",
};

/** Recorded physics ops that take a TRAILING zero-copy out-buffer arg. The buffer
 *  carries no input (it is filled by the op), so the recorder strips it from the
 *  logged args and replay re-supplies a fresh scratch buffer of this length. The
 *  recorded SCALAR inputs (e.g. move_character's id + desired dx,dy,dz) are what
 *  make the op reproducible; `move_shape` re-resolves the correction
 *  deterministically from the world state on replay. */
export const PHYSICS_OP_OUT_BUFFER: Partial<Record<PhysicsOpName, number>> = {
  move_character: 4,
};

/** The set of EngineOps method names whose call mutates the native world and is
 *  therefore recorded when issued outside a skill. Reads/host services are not. */
export const RECORDED_PHYSICS_METHODS: Record<string, PhysicsOpName> = {
  op_physics_create_world: "create_world",
  op_physics_add_ground: "add_ground",
  op_physics_add_box: "add_box",
  op_physics_add_box_material: "add_box_material",
  op_physics_add_sphere: "add_sphere",
  op_physics_add_capsule: "add_capsule",
  op_physics_add_static_box: "add_static_box",
  op_physics_add_static_sphere: "add_static_sphere",
  op_physics_add_static_capsule: "add_static_capsule",
  op_physics_add_character: "add_character",
  op_physics_move_character: "move_character",
  op_physics_remove_body: "remove_body",
  op_physics_apply_impulse: "apply_impulse",
  op_physics_step: "step",
};

export interface SeedCommand {
  kind: "seed";
  seq: number;
  seed: number;
}

export interface PhysicsCommand {
  kind: "physics";
  seq: number;
  tick: number;
  op: PhysicsOpName;
  args: number[];
}

export interface SkillCommand {
  kind: "skill";
  seq: number;
  tick: number;
  tool: string;
  input: unknown;
  actorId: string;
  sessionId: string;
  /** The caller's full permission set (sorted). ALWAYS populated in memory — a
   *  line persisted with only `profile` has it materialized on parse — so every
   *  in-process consumer (replay, worldlogTail, the kernel bridge) keeps working
   *  on both formats. */
  perms: string[];
  /** The caller's permission PROFILE NAME (skills/permissions.ts), recorded only
   *  when `perms` is exactly that profile's set. When present, serialization
   *  writes `profile` INSTEAD of the ~70-string `perms` array (v2 log format). */
  profile?: string;
}

export type WorldCommand = SeedCommand | PhysicsCommand | SkillCommand;

export interface WorldLogMeta {
  kind: "meta";
  logVersion: number;
  sessionId: string;
  /** Deterministic session marker ("tick:<maxTick>"), NOT a wall-clock time despite
   *  the legacy name: the meta line rides byte-compared artifacts (durable-log
   *  trailers, deterministic save/export headers — see skills/save.ts), so a real
   *  timestamp here would break their byte-identity. Renaming is a coordinated
   *  format change across save/publish/export consumers. */
  createdAt: string;
  commands: number;
  ticks: number;
}

export interface ParsedWorldLog {
  meta?: WorldLogMeta;
  commands: WorldCommand[];
}

export interface ParseWorldLogOptions {
  /** Ignore one malformed, unterminated final line. This is the only corruption
   *  pattern an interrupted append can safely explain; malformed complete or
   *  interior lines always fail closed. */
  recoverPartialFinalLine?: boolean;
  onRecoverableError?: (message: string) => void;
}

// Sorted-joined permission string per profile, cached: profiles are static data,
// and the serializer/recorder compare against them once per skill command.
const profilePermsKeyCache = new Map<string, string>();
function profilePermsKey(profile: string): string {
  let key = profilePermsKeyCache.get(profile);
  if (key === undefined) {
    key = [...resolveProfile(profile)].sort().join("\n");
    profilePermsKeyCache.set(profile, key);
  }
  return key;
}

/** The profile name to pin into a recorded skill command: `profile` itself when the
 *  caller's (sorted) permission set is EXACTLY that profile's set, else undefined
 *  (a narrowed/custom set must keep recording the full array — resolving the
 *  profile on replay would silently grant permissions the caller did not hold). */
export function permissionProfileFor(profile: string | undefined, sortedPerms: readonly string[]): string | undefined {
  if (profile === undefined) return undefined;
  return profilePermsKey(profile) === sortedPerms.join("\n") ? profile : undefined;
}

/** One command as a JSONL line. A skill command whose `perms` is exactly its
 *  pinned `profile`'s set persists the profile name INSTEAD of the array (v2);
 *  parseWorldLog materializes `perms` back from the profile. Every other command
 *  serializes unchanged (v1-identical bytes). */
export function serializeWorldCommand(cmd: WorldCommand): string {
  if (cmd.kind === "skill" && cmd.profile !== undefined && permissionProfileFor(cmd.profile, cmd.perms) === cmd.profile) {
    const { perms: _perms, ...rest } = cmd;
    return JSON.stringify(rest);
  }
  return JSON.stringify(cmd);
}

/** JSONL: meta header line, then one command per line (seq order preserved). */
export function serializeWorldLog(meta: WorldLogMeta, commands: WorldCommand[]): string {
  const lines: string[] = [JSON.stringify(meta)];
  for (const cmd of commands) lines.push(serializeWorldCommand(cmd));
  return lines.join("\n") + "\n";
}

// Boundary schemas: a persisted log is external data, so each JSONL line is
// validated before it is trusted (a torn/corrupt line fails loudly + typed).
const physicsOpEnum = z.enum([
  "create_world", "add_ground", "add_box", "add_box_material", "add_sphere",
  "add_capsule", "add_static_box", "add_static_sphere", "add_static_capsule",
  "add_character", "move_character",
  "remove_body", "apply_impulse", "step",
]);
const metaSchema = z.object({
  kind: z.literal("meta"),
  logVersion: z.number(),
  sessionId: z.string(),
  createdAt: z.string(),
  commands: z.number(),
  ticks: z.number(),
});
const lineSchema = z.discriminatedUnion("kind", [
  metaSchema,
  z.object({ kind: z.literal("seed"), seq: z.number(), seed: z.number() }),
  z.object({ kind: z.literal("physics"), seq: z.number(), tick: z.number(), op: physicsOpEnum, args: z.array(z.number()) }),
  // v1 lines carry `perms` (full array); v2 lines may carry `profile` instead.
  // Both optional here — parseWorldLog enforces that at least one is present and
  // materializes `perms` from `profile`, so a parsed SkillCommand always has perms.
  z.object({
    kind: z.literal("skill"), seq: z.number(), tick: z.number(), tool: z.string(),
    input: z.unknown(), actorId: z.string(), sessionId: z.string(),
    perms: z.array(z.string()).optional(), profile: z.string().optional(),
  }),
]);

/** Parse a persisted world log. Tolerates a trailing newline; by default rejects
 *  malformed lines loudly. Boot recovery may ignore only an unterminated final
 *  fragment left by an interrupted append. */
export function parseWorldLog(jsonl: string, opts: ParseWorldLogOptions = {}): ParsedWorldLog {
  const out: WorldCommand[] = [];
  let meta: WorldLogMeta | undefined;
  const rawLines = jsonl.split("\n");
  const canRecover = (lineIndex: number): boolean =>
    opts.recoverPartialFinalLine === true && !jsonl.endsWith("\n") && lineIndex === rawLines.length - 1;
  for (let i = 0; i < rawLines.length; i++) {
    const line = rawLines[i];
    if (line.length === 0) continue; // trailing newline / blank separators
    let json: unknown;
    try {
      json = JSON.parse(line);
    } catch (err) {
      const message = `world log: invalid JSON on line ${i + 1}: ${err instanceof Error ? err.message : String(err)}`;
      if (canRecover(i)) {
        opts.onRecoverableError?.(message);
        continue;
      }
      throw new Error(message);
    }
    const result = lineSchema.safeParse(json);
    if (!result.success) {
      const message = `world log: malformed command on line ${i + 1}: ${result.error.message}`;
      if (canRecover(i)) {
        opts.onRecoverableError?.(message);
        continue;
      }
      throw new Error(message);
    }
    if (result.data.kind === "meta") {
      meta = result.data;
      continue;
    }
    if (result.data.kind === "skill" && result.data.perms === undefined) {
      // v2 profile-pinned line: materialize the full permission array so every
      // consumer of a parsed SkillCommand sees `perms` populated (replay invokes
      // with it; the kernel/editor bridges forward it). An unknown profile fails
      // CLOSED here — replaying with silently-empty permissions would fail
      // partway through the stream with a far less diagnosable permission error.
      const profile = result.data.profile;
      if (profile === undefined) {
        throw new Error(`world log: skill command on line ${i + 1} carries neither perms nor profile`);
      }
      const resolved = resolveProfile(profile);
      if (resolved.size === 0) {
        throw new Error(`world log: skill command on line ${i + 1} names unknown permission profile '${profile}'`);
      }
      result.data.perms = [...resolved].sort();
    }
    out.push(result.data as WorldCommand);
  }
  out.sort((a, b) => a.seq - b.seq);
  return { meta, commands: out };
}

// ---- Deterministic PRNG ---------------------------------------------------

/** A seeded generator whose internal 32-bit state can be read and restored, so
 *  a world snapshot can resume the RNG mid-stream (M2) instead of replaying
 *  every draw from genesis. */
export interface SeededRng {
  next: () => number;
  /** The current internal 32-bit state (the value the next draw advances). */
  getState: () => number;
  /** Resume the generator at a previously captured state. */
  setState: (state: number) => void;
}

/** Build a mulberry32 generator with externally observable/restorable state.
 *  The numeric stream is byte-identical to {@link mulberry32}. */
function statefulMulberry32(seed: number): SeededRng {
  let a = seed >>> 0;
  const next = (): number => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return { next, getState: () => a >>> 0, setState: (state) => { a = state >>> 0; } };
}

/** mulberry32 -- a small, fast, well-distributed 32-bit PRNG. Deterministic
 *  given the seed; identical stream on any build. */
export function mulberry32(seed: number): () => number {
  return statefulMulberry32(seed).next;
}

// The generator currently installed as Math.random, kept so a snapshot can read
// its live internal state and a restore can resume it (see installRandomState).
let installedRng: SeededRng | undefined;

/** Install a seeded PRNG AS the global `Math.random`, so ALL randomness in any
 *  skill handler (and any library it calls) becomes deterministic and replayable
 *  from the recorded seed. Returns the generator (also reachable via Math.random).
 *  Replay re-installs the SAME seed before re-applying commands.
 *
 *  SINGLE-WORLD-PER-PROCESS INVARIANT: `Math.random` and `installedRng` are a
 *  MODULE SINGLETON, so exactly ONE seeded world may drive randomness in a process
 *  at a time. Standing up a second live world in the same process would clobber the
 *  first world's RNG stream. Re-installing is legitimate ONLY when the previous
 *  world is being torn down and replaced (e.g. a fresh replay/recovery run): pass
 *  `force: true` to declare that intent. An UNFORCED re-install (a generator is
 *  already installed) is a probable multi-world bug and is warned about rather than
 *  silently clobbering. (A full multi-world refactor -- an RNG owned by the world,
 *  not the module -- is intentionally out of scope here.) The FIRST install in a
 *  process is unaffected (identical to before). */
export function installSeededRandom(seed: number, force = false): () => number {
  if (installedRng !== undefined && !force && typeof console !== "undefined" && typeof console.warn === "function") {
    console.warn(
      "installSeededRandom: a seeded Math.random is already installed; re-installing WITHOUT force clobbers it. " +
        "The seeded RNG is a module singleton (single world per process) -- pass force=true for an intentional re-seed (replay/recovery).",
    );
  }
  const gen = statefulMulberry32(seed >>> 0);
  installedRng = gen;
  // Math.random is a writable method slot in V8; replace it with the seeded gen.
  Math.random = gen.next;
  return gen.next;
}

/** Read the installed seeded RNG's internal state (for a world snapshot). Throws
 *  if no seeded RNG is installed -- a snapshot without a known RNG state could
 *  not resume deterministically. */
export function captureRandomState(): number {
  if (installedRng === undefined) {
    throw new Error("worldlog: captureRandomState called with no seeded RNG installed");
  }
  return installedRng.getState();
}

/** The seeded RNG currently installed as `Math.random` (undefined before any
 *  install). Multi-world callers capture a world's generator after seeding it and
 *  re-install it on activation (see setInstalledRng) so interleaved worlds each
 *  advance their OWN RNG stream instead of sharing one global generator. */
export function getInstalledRng(): SeededRng | undefined {
  return installedRng;
}

/** Make `rng` the installed seeded generator AND the global `Math.random`, WITHOUT
 *  reseeding it (unlike installSeededRandom, which starts a fresh stream). This is
 *  the per-world activation swap: on entering a world's execution, install that
 *  world's live generator so its randomness continues where it left off. Single-
 *  world code never calls this; the module singleton stays as installSeededRandom
 *  left it, so single-world determinism is unchanged. */
export function setInstalledRng(rng: SeededRng): void {
  installedRng = rng;
  Math.random = rng.next;
}

/** Install a seeded PRNG resumed at a captured internal state (M2 recovery).
 *  The next draw continues the SAME stream the original run produced after the
 *  snapshot point -- the mid-stream RNG resume the delta replay depends on. */
export function installRandomState(state: number): () => number {
  const gen = statefulMulberry32(0);
  gen.setState(state);
  installedRng = gen;
  Math.random = gen.next;
  return gen.next;
}

// ---- World-state snapshot + bit-identical comparison ----------------------

export interface EntityState {
  id: string;
  eid: number;
  pos: [number, number, number];
  rot: [number, number, number, number];
  scale: [number, number, number];
  /** Native Rapier body transform [px,py,pz, rx,ry,rz,rw] when body-bound. */
  body?: [number, number, number, number, number, number, number];
  // The per-entity GAMEPLAY component set — the same per-entity state view
  // inspector.snapshot exposes (generation/parent/tags/material/resource), so the
  // replay-equivalence comparator and the observability surface agree on ONE
  // canonical notion of "the entity's state". `behavior` rides along because it is
  // first-class entry state carried by v3 world snapshots. Captured by REFERENCE
  // (these objects are replaced, not mutated, by the writing skills); compare two
  // captures, not a capture against a world that kept authoring.
  generation?: number;
  parent?: string;
  /** Sorted tag list (ecs.addComponent/removeComponent), omitted when untagged. */
  tags?: string[];
  material?: unknown;
  resource?: unknown;
  behavior?: unknown;
}

export interface WorldStateSnapshot {
  entities: EntityState[];
}

/** Read the authoritative comparable state of every LIVE entity: its ECS
 *  Position/Rotation/Scale (JS-owned SoA) plus its native Rapier body transform
 *  (read fresh from the native world) when it has a body, plus (by default) the
 *  per-entity gameplay component set (generation/parent/tags/material/resource/
 *  behavior — the inspector.snapshot per-entity view). Entities are returned
 *  sorted by their stable `ent_` id so two snapshots line up by identity. */
export function captureWorldState(world: WorldLike, sorted = true, includeGameplay = true): WorldStateSnapshot {
  const scratch = new Float32Array(7);
  // Determinism/snapshot callers need a stable id order (default). The net server
  // builds a Map keyed by id and doesn't care about order, so it passes sorted=false
  // to drop the per-tick O(n log n) sort + sorted-array allocation on the hot path.
  // It also passes includeGameplay=false: its per-tick delta diff compares
  // transforms only, and EntityState objects go on the wire verbatim, so gameplay
  // capture there would be pure cost + a wire-format change.
  const ids = sorted ? [...world.entities.ids()].sort() : world.entities.ids();
  const entities: EntityState[] = [];
  for (const id of ids) {
    const entry = world.entities.resolve(id);
    if (entry === undefined) continue;
    const eid = entry.eid;
    const state: EntityState = {
      id,
      eid,
      pos: [Position.x[eid], Position.y[eid], Position.z[eid]],
      rot: [Rotation.x[eid], Rotation.y[eid], Rotation.z[eid], Rotation.w[eid]],
      scale: [Scale.x[eid], Scale.y[eid], Scale.z[eid]],
    };
    if (entry.bodyId !== undefined) {
      world.ops.op_physics_body_transform(entry.bodyId, scratch);
      state.body = [scratch[0], scratch[1], scratch[2], scratch[3], scratch[4], scratch[5], scratch[6]];
    }
    if (includeGameplay) captureEntityGameplay(state, entry, world.tags?.get(eid));
    entities.push(state);
  }
  return { entities };
}

/** Copy the per-entity gameplay component set onto a captured EntityState. THE
 *  single write site for that set: capture and comparison stay in lockstep with
 *  the field list below (GAMEPLAY_FIELDS). */
function captureEntityGameplay(state: EntityState, entry: ResolvedEntityLike, tagSet: ReadonlySet<string> | undefined): void {
  if (entry.generation !== undefined) state.generation = entry.generation;
  if (entry.parent !== undefined) state.parent = entry.parent;
  if (tagSet !== undefined && tagSet.size > 0) state.tags = [...tagSet].sort();
  if (entry.material !== undefined) state.material = entry.material;
  if (entry.resource !== undefined) state.resource = entry.resource;
  if (entry.behavior !== undefined) state.behavior = entry.behavior;
}

export interface DivergenceReport {
  identical: boolean;
  comparisons: number;
  detail?: string;
}

/** Mirror the per-tick engine rule the live loop runs: copy EVERY body-bound
 *  entity's native Rapier transform into ECS SoA storage. Replay calls this
 *  after each recorded `step`, exactly as the windowed loop syncs after a step. */
export function syncAllBodies(world: WorldLike): void {
  const scratch = new Float32Array(7);
  for (const id of world.entities.ids()) {
    const entry = world.entities.resolve(id);
    if (entry === undefined || entry.bodyId === undefined) continue;
    syncPhysicsBodyTransform(entry.eid, entry.bodyId, world.ops, scratch);
  }
}

function vecDiff(label: string, id: string, a: number[], b: number[]): string | undefined {
  for (let i = 0; i < a.length; i++) {
    // Object.is is the strict bit-identical check (distinguishes +0/-0, NaN===NaN).
    if (!Object.is(a[i], b[i])) {
      return `entity ${id} ${label}[${i}] diverged: ${a[i]} vs ${b[i]}`;
    }
  }
  return undefined;
}

/** The captured gameplay component set compareWorldState covers, in comparison
 *  order. Must stay in lockstep with captureEntityGameplay above. */
const GAMEPLAY_FIELDS = ["generation", "parent", "tags", "material", "resource", "behavior"] as const;

/** Structural equality with the SAME bit-identical number semantics as vecDiff:
 *  every leaf number compares via Object.is (+0/-0 distinct, NaN equals itself),
 *  so extending the comparator to nested gameplay values cannot loosen it. A key
 *  present with value `undefined` is distinct from an absent key. */
function deepBitEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  const aArr = Array.isArray(a);
  if (aArr !== Array.isArray(b)) return false;
  if (aArr) {
    const av = a as unknown[];
    const bv = b as unknown[];
    if (av.length !== bv.length) return false;
    for (let i = 0; i < av.length; i++) if (!deepBitEqual(av[i], bv[i])) return false;
    return true;
  }
  const ar = a as Record<string, unknown>;
  const br = b as Record<string, unknown>;
  const ak = Object.keys(ar);
  const bk = Object.keys(br);
  if (ak.length !== bk.length) return false;
  for (const k of ak) {
    if (!Object.prototype.hasOwnProperty.call(br, k)) return false;
    if (!deepBitEqual(ar[k], br[k])) return false;
  }
  return true;
}

/** Bit-identical comparison of two world-state snapshots. The acceptance check:
 *  every live entity's ECS Position/Rotation/Scale, every Rapier body transform,
 *  AND the per-entity gameplay component set (generation/parent/tags/material/
 *  resource/behavior — the inspector.snapshot per-entity view) must match
 *  exactly. Returns the FIRST divergence found. */
export function compareWorldState(a: WorldStateSnapshot, b: WorldStateSnapshot): DivergenceReport {
  let comparisons = 0;
  if (a.entities.length !== b.entities.length) {
    return {
      identical: false,
      comparisons,
      detail: `entity count diverged: ${a.entities.length} vs ${b.entities.length}`,
    };
  }
  for (let i = 0; i < a.entities.length; i++) {
    const ea = a.entities[i];
    const eb = b.entities[i];
    if (ea.id !== eb.id) {
      return { identical: false, comparisons, detail: `entity identity diverged at index ${i}: ${ea.id} vs ${eb.id}` };
    }
    const checks: (string | undefined)[] = [
      vecDiff("pos", ea.id, ea.pos, eb.pos),
      vecDiff("rot", ea.id, ea.rot, eb.rot),
      vecDiff("scale", ea.id, ea.scale, eb.scale),
    ];
    comparisons += 3;
    if (ea.body !== undefined || eb.body !== undefined) {
      if (ea.body === undefined || eb.body === undefined) {
        return { identical: false, comparisons, detail: `entity ${ea.id} body presence diverged` };
      }
      checks.push(vecDiff("body", ea.id, ea.body, eb.body));
      comparisons += 1;
    }
    for (const detail of checks) {
      if (detail !== undefined) return { identical: false, comparisons, detail };
    }
    for (const field of GAMEPLAY_FIELDS) {
      comparisons += 1;
      if (!deepBitEqual(ea[field], eb[field])) {
        return { identical: false, comparisons, detail: `entity ${ea.id} ${field} diverged` };
      }
    }
  }
  return { identical: true, comparisons };
}
