// worldlog.* skills — expose the recorded AUTHORING command stream to a live editor viewport so it
// can re-author the SAME commands locally and render the world an agent is building. Read-only;
// bound to a WorldRecorder via closure (the AuthoritativeServer's `recorder`), mirroring
// registerSaveSkills' recorder-binding pattern.
//
// Only AUTHORING commands are exposed: every physics op (world setup) and every skill whose DECLARED
// permissions include a non-`.read` grant (the same mutation test approval.ts uses). The seed marker
// and read-only introspection the editor itself polls (inspector.snapshot / trace.tail / worldlog.tail)
// are excluded — feeding them to a viewport's loadWorld would replay reads or an unknown tool.

import { z } from "../../build/zod.bundle.mjs";
import type { SkillRegistry, SkillDefinition, WorldContext } from "./registry.ts";
import type { WorldRecorder } from "../worldlog/recorder.ts";
import { PHYSICS_OP_FN, type WorldCommand } from "../worldlog/log.ts";
import type { AuthorCommand } from "../kernel/authoring.ts";
import {
  captureEntityIndex,
  captureWorldSnapshot,
  serializeSnapshot,
  type SnapshotParticipantRegistry,
} from "../worldlog/snapshot.ts";

/** A recorded command is replayable authoring iff it CONSTRUCTS the world. Physics ops count EXCEPT
 *  `step` (the per-tick sim advance): the authoritative server records a step every tick, but the
 *  viewport's own runLive sim steps locally — re-authoring the server's steps would flood the stream
 *  (a reboot per poll → visible flicker) and double-simulate. `move_character`/`apply_impulse` are
 *  per-tick DYNAMICS the local sim also reproduces, so they are excluded too; construction ops
 *  (create_world, add-body, remove_body) are kept. */
const PER_TICK_PHYSICS = new Set(["step", "move_character", "apply_impulse"]);
// Read-only introspection the editor + viewport poll EVERY tick. These must be excluded by NAME, not
// just by the permission test below: some are read-only in effect yet declare a non-`.read`
// permission (e.g. approval.list needs `approval.review` to LIST but mutates nothing). Left in, they
// enter the authoring stream once per poll and reboot the live viewport every second (flicker).
const INTROSPECTION = new Set([
  "worldlog.tail", "inspector.snapshot", "trace.tail", "approval.list", "approval.grant", "approval.deny",
  "skills.list", "skills.search", "skills.browse", "skills.describe",
]);
function isAuthoringCommand(cmd: WorldCommand, registry: SkillRegistry): boolean {
  if (cmd.kind === "physics") return !PER_TICK_PHYSICS.has(cmd.op);
  if (cmd.kind !== "skill") return false;   // seed marker, etc.
  if (INTROSPECTION.has(cmd.tool)) return false;
  const def = registry.describe(cmd.tool);
  if (def === undefined) return false;      // a tool the replaying registry won't have
  return def.permissions.some((p) => !p.endsWith(".read"));
}

/** Translate a recorded WorldCommand stream into the AuthorCommand[] a live viewport's loadWorld
 *  consumes: drop the seed marker (loadWorld has no seed branch); remap a physics op's SHORT recorded
 *  name (e.g. "add_box") to its full EngineOps key ("op_physics_add_box") via the SAME PHYSICS_OP_FN
 *  table replayCommands uses; pass skill commands through (tool/input, actorId -> agentId, perms).
 *  Pure + deterministic — the headless-testable half of the viewport wire. */
export function worldCommandsToAuthor(commands: readonly WorldCommand[]): AuthorCommand[] {
  const out: AuthorCommand[] = [];
  for (const cmd of commands) {
    if (cmd.kind === "physics") {
      out.push({ kind: "physics", op: PHYSICS_OP_FN[cmd.op], args: cmd.args } as AuthorCommand);
    } else if (cmd.kind === "skill") {
      out.push({ kind: "skill", tool: cmd.tool, input: cmd.input, agentId: cmd.actorId, perms: cmd.perms });
    }
    // seed: dropped — no AuthorCommand analogue.
  }
  return out;
}

/** The authoring tail: every recorded command AFTER `since` that is authoring (per
 *  isAuthoringCommand above), plus the next cursor and whether the caller's cursor had already
 *  fallen behind a compacted prefix (a full resync is required). THE single implementation behind
 *  both worldlog.tail (polled) and AuthoritativeServer's worldlog/subscribe push (net/server.ts) --
 *  shared so the two delivery paths can never diverge on what "authoring since X" means; a client
 *  mixing poll + push gets byte-identical batches for the same cursor either way. */
export function worldlogTail(
  recorder: WorldRecorder,
  registry: SkillRegistry,
  since: number,
  visibleCount?: number,
): { commands: WorldCommand[]; next: number; reset: boolean } {
  // commandCount includes in-flight async calls. Exposing it would let a client
  // advance past a provisional command that can still fail and be removed.
  const finalized = recorder.flushableCount();
  const total = visibleCount === undefined
    ? finalized
    : Math.min(finalized, Number.isSafeInteger(visibleCount) && visibleCount >= 0 ? visibleCount : 0);
  const compacted = recorder.compactedCommandCount;
  // A cursor ahead of the finalized prefix can come from an older buggy server
  // that exposed a provisional command which was later discarded. It cannot be
  // continued safely because that absolute position may now name different data.
  const reset = since < compacted || since > total;
  const start = reset ? compacted : since;
  const commands: WorldCommand[] = [];
  for (let i = start; i < total; i++) {
    const cmd = recorder.commandAt(i);
    if (cmd !== undefined && isAuthoringCommand(cmd, registry)) commands.push(cmd);
  }
  return { commands, next: total, reset };
}

// ---- editor session FAST-BOOT (snapshot + bounded tail) ---------------------
// worldlog.snapshotBoot serves a v3 self-sufficient WorldSnapshot + the cursor a
// viewer resumes the authoring stream from, so a long session boots by SNAPSHOT
// RESTORE + tail replay instead of re-authoring every recorded command. The
// snapshot path is HONESTLY BOUNDED: v3 snapshots do not carry every world state
// (editable-terrain tile arrays, vegetation/scatter instancing, lights, navmesh
// grids are all rebuilt only by command replay — the F/X rows of
// skills/snapshot-participants.ts), and the browser realms cannot restore the
// NATIVE Rapier blob (bincode PhysicsSnapshot ≠ wasm rapier.js takeSnapshot
// format), so they rebuild physics by replaying each live entity's ORIGIN create
// command and re-posing bodies from snapshot transforms. A session is therefore
// ELIGIBLE only when everything it authored is provably carried by
// {snapshot ∪ origin replay}; anything else answers eligible:false and the
// viewer keeps the full-replay path. Never weaken these checks to widen the fast
// path — an ineligible session that boots from a snapshot is a silently
// incomplete world.

/** Skill tools whose ENTIRE recorded effect is carried by a v3 snapshot plus an
 *  origin-command replay: entity identity/origin/resource, SoA transforms + body
 *  poses, tags, first-class material/behavior, and P-row manager state. Tools
 *  NOT in this set (terrain.*, vegetation.*, lights, village.build, …) leave
 *  state a snapshot boot would silently drop — their presence in the recorded
 *  prefix makes the session ineligible. */
export const SNAPSHOT_BOOT_CARRIED_TOOLS: ReadonlySet<string> = new Set([
  // Entity authoring: origin rides the snapshot; poses/material/tags overwritten from it.
  "scene.createEntity", "scene.createMesh", "scene.moveEntity", "asset.place",
  "three.setMaterial", "three.setTransform",
  "ecs.updateComponent", "ecs.addComponent", "ecs.removeComponent",
  "behavior.set", "event.define", "authoring.commit",
  // Pose-affecting dynamics: the resulting pose is snapshot-carried. (Transient
  // velocities ride only the NATIVE blob; the browser realms re-settle — the same
  // fidelity the full-replay viewport path has always had, since it never replays
  // recorded `step` ops either.)
  "physics.applyImpulse",
  // P-row manager state (snapshot-participants.ts): restored wholesale by the
  // participant registry.
  "inventory.create", "inventory.add", "inventory.remove", "inventory.transfer",
  "item.define", "item.equip", "item.unequip",
  "quest.define", "quest.offer", "quest.accept", "quest.decline", "quest.update",
  "quest.complete", "quest.fail", "quest.track",
  "interaction.register", "interaction.interact", "interaction.open", "interaction.close",
  "interaction.toggle", "interaction.use", "interaction.pickup", "interaction.drop",
  "game.state", "game.flag", "game.counter", "game.timer", "game.condition",
  "game.win", "game.lose", "game.restart",
  "trigger.create", "trigger.onEnter", "trigger.onExit", "trigger.onStay", "event.listen",
  "stats.create", "status.apply", "combat.defend",
  "ability.define", "ability.cast",
  "progression.xp", "progression.onLevelUp",
  "world.setTime", "world.setWeather",
  "cutscene.define", "cutscene.play",
  "director.configure", "director.start",
  // Behavior + dialogue managers (enrolled P rows): profiles/assignments/goals/
  // memories/attitudes/routines/reactions and trees/in-progress sessions restore
  // wholesale via the "behavior" / "dialogue" participants. (dialogue.npcSay /
  // dialogue.setMood stay OUT: emit-only presentation, not carried state.)
  "behavior.define", "behavior.assign", "behavior.setGoal", "behavior.onEvent",
  "npc.setRoutine", "npc.memorize", "npc.setAttitude",
  "dialogue.define", "dialogue.start", "dialogue.choose", "dialogue.end",
]);

/** Raw physics ops a fast-booting viewer replays VERBATIM before the origin
 *  program (they allocate no body id / reset the world). Any OTHER raw
 *  construction op creates a body outside the entity table — unreproducible from
 *  the snapshot — so it makes the session ineligible. */
const SNAPSHOT_BOOT_BOOTSTRAP_OPS = new Set(["create_world", "add_ground"]);
/** Per-tick dynamics ops: their effects are snapshot poses; never replayed. */
const SNAPSHOT_BOOT_PER_TICK_OPS = new Set(["step", "move_character", "apply_impulse"]);

export interface SnapshotBootEligibility {
  eligible: boolean;
  /** Human-readable reason when ineligible (names the first offender). */
  reason?: string;
  /** The verbatim create_world/add_ground bootstrap prefix (AuthorCommand form). */
  bootstrapCommands: AuthorCommand[];
}

/** Decide whether the recorded AUTHORING prefix + the live world are fully
 *  carried by {v3 snapshot ∪ origin replay}. Two layers:
 *  1. COMMAND SCAN — every authoring command must be a carried tool or an
 *     allowed bootstrap physics op (bootstrap ops must precede all skill
 *     commands, since replay reorders them to the front).
 *  2. STRUCTURAL CHECK — the live world must show gap-free allocation
 *     (ent_ ids 0..N-1 in creation order, no recycled eids, contiguous body
 *     ids, an origin on every entity, no parenting), so a fresh origin replay
 *     provably allocates the SAME ids/eids/bodyIds in both browser realms.
 *  Falsifiable by construction: a destroyed entity, a raw add_box, or a
 *  terrain.create in the prefix each flips a specific check. */
export function snapshotBootEligibility(
  commands: readonly WorldCommand[],
  world: WorldContext,
): SnapshotBootEligibility {
  const bootstrapCommands: AuthorCommand[] = [];
  let sawSkill = false;
  for (const cmd of commands) {
    if (cmd.kind === "seed") continue;
    if (cmd.kind === "physics") {
      if (SNAPSHOT_BOOT_PER_TICK_OPS.has(cmd.op)) continue;
      if (!SNAPSHOT_BOOT_BOOTSTRAP_OPS.has(cmd.op)) {
        return { eligible: false, reason: `raw physics op '${cmd.op}' allocates outside the entity table`, bootstrapCommands: [] };
      }
      if (sawSkill) {
        return { eligible: false, reason: `bootstrap physics op '${cmd.op}' recorded after skill commands (replay would reorder it)`, bootstrapCommands: [] };
      }
      bootstrapCommands.push({ kind: "physics", op: PHYSICS_OP_FN[cmd.op], args: cmd.args } as AuthorCommand);
      continue;
    }
    if (cmd.kind !== "skill") continue;
    sawSkill = true;
    if (!SNAPSHOT_BOOT_CARRIED_TOOLS.has(cmd.tool)) {
      return { eligible: false, reason: `tool '${cmd.tool}' authors state a v3 snapshot does not carry`, bootstrapCommands: [] };
    }
  }
  // Structural allocation checks over the LIVE world (catch anything the tool
  // scan cannot see — e.g. a trigger action that destroyed an entity).
  const table = world.entities.snapshot();
  if (table.seq !== table.entries.length) {
    return { eligible: false, reason: `entity allocation has gaps (seq ${table.seq} != ${table.entries.length} live)`, bootstrapCommands: [] };
  }
  const bodyIds: number[] = [];
  for (let i = 0; i < table.entries.length; i++) {
    const entry = table.entries[i];
    if (entry.id !== `ent_${i}`) {
      return { eligible: false, reason: `entity creation order has gaps ('${entry.id}' at slot ${i})`, bootstrapCommands: [] };
    }
    const live = world.entities.resolve(entry.id);
    if (live?.origin === undefined) {
      return { eligible: false, reason: `entity '${entry.id}' carries no origin command`, bootstrapCommands: [] };
    }
    if (live.parent !== undefined) {
      return { eligible: false, reason: `entity '${entry.id}' is parented (snapshot boot does not rebuild hierarchies yet)`, bootstrapCommands: [] };
    }
    if (entry.bodyId !== undefined) bodyIds.push(entry.bodyId);
    for (const id of live.runtimeBodyIds ?? []) bodyIds.push(id);
  }
  bodyIds.sort((a, b) => a - b);
  for (let i = 0; i < bodyIds.length; i++) {
    if (bodyIds[i] !== i) {
      return { eligible: false, reason: `physics body ids are not contiguous (found ${bodyIds[i]} at slot ${i})`, bootstrapCommands: [] };
    }
  }
  try {
    const index = captureEntityIndex(world.ecs);
    if (index.aliveCount !== index.maxId) {
      return { eligible: false, reason: `bitECS eids were recycled (${index.aliveCount} alive != maxId ${index.maxId})`, bootstrapCommands: [] };
    }
  } catch {
    return { eligible: false, reason: "world has no bitECS entity index", bootstrapCommands: [] };
  }
  return { eligible: true, bootstrapCommands };
}

export function registerWorldlogSkills(
  registry: SkillRegistry,
  opts: {
    recorder: WorldRecorder;
    visibleCount?: () => number;
    /** When present, additionally registers worldlog.snapshotBoot (the editor
     *  fast-boot endpoint). The host passes its ONE snapshot-participant
     *  registry (AuthoritativeServer: `server.core.snapshotParticipants`). */
    snapshotBoot?: { participants: SnapshotParticipantRegistry };
  },
): void {
  const recorder = opts.recorder;
  const tail: SkillDefinition<{ since: number }, { commands: WorldCommand[]; next: number; reset: boolean }> = {
    name: "worldlog.tail",
    version: "1.0.0",
    description: "Read-only: the AUTHORING command stream (mutating skills + physics; seed + read-only introspection excluded) recorded AFTER a cursor index, so a live editor viewport can re-author the world an agent is building. Returns the finalized authoring tail, the next cursor, and `reset` (true when the cursor is outside the retained finalized range and the caller must resync from scratch).",
    category: "system",
    permissions: [],
    effect: "read",
    input: z.object({ since: z.number().int().min(0).default(0) }),
    output: z.object({ commands: z.array(z.any()), next: z.number().int(), reset: z.boolean() }),
    handler: (input) => worldlogTail(recorder, registry, input.since, opts.visibleCount?.()),
  };
  registry.register(tail);

  if (opts.snapshotBoot === undefined) return;
  const participants = opts.snapshotBoot.participants;
  interface SnapshotBootResult {
    eligible: boolean;
    reason?: string;
    /** Cursor a fast-booting viewer resumes worldlog.tail / worldlog/subscribe from. */
    next: number;
    snapshotSeq?: number;
    /** serializeSnapshot(v3 snapshot) — parse with worldlog/snapshot.ts parseSnapshot. */
    snapshot?: string;
    bootstrapCommands?: AuthorCommand[];
  }
  const snapshotBoot: SkillDefinition<{ minCommands: number }, SnapshotBootResult> = {
    name: "worldlog.snapshotBoot",
    version: "1.0.0",
    description: "Read-only editor FAST-BOOT: a v3 self-sufficient world snapshot (entities+managers+physics) plus the cursor to resume the authoring stream from, so a long session boots by snapshot restore + bounded tail replay instead of re-authoring every recorded command. Answers eligible:false (with the reason) when the session authored state a snapshot boot cannot carry -- the caller must then keep the full-replay path. `minCommands` skips the capture below a session-size threshold.",
    category: "system",
    permissions: [],
    effect: "read",
    input: z.object({ minCommands: z.number().int().min(0).default(0) }),
    output: z.object({
      eligible: z.boolean(),
      reason: z.string().optional(),
      next: z.number().int(),
      snapshotSeq: z.number().int().optional(),
      snapshot: z.string().optional(),
      bootstrapCommands: z.array(z.any()).optional(),
    }),
    handler: (input, ctx) => {
      // The delta boundary MUST come from the COMMITTED count (flushableCount) —
      // the same rule worldlogTail and net/server.ts snapshotLine follow. And a
      // viewer may only resume from a cursor it is allowed to OBSERVE, so a
      // durable server whose sink lags the committed count cannot fast-boot yet.
      const total = recorder.flushableCount();
      const visible = opts.visibleCount?.() ?? total;
      if (visible < total) {
        return { eligible: false, reason: `durable log lagging (${visible} published < ${total} committed)`, next: visible };
      }
      if (total < input.minCommands) {
        return { eligible: false, reason: `session below fast-boot threshold (${total} < ${input.minCommands})`, next: 0 };
      }
      if (recorder.compactedCommandCount > 0) {
        // A compacted prefix cannot be scanned for eligibility — commands the
        // recorder dropped from memory might have authored non-carried state.
        return { eligible: false, reason: "recorder compacted its flushed prefix (cannot verify eligibility)", next: 0 };
      }
      const prefix = worldlogTail(recorder, registry, 0, visible);
      const verdict = snapshotBootEligibility(prefix.commands, ctx.world);
      if (!verdict.eligible) {
        return { eligible: false, reason: verdict.reason, next: 0 };
      }
      const snap = captureWorldSnapshot(ctx.world, {
        sessionId: ctx.sessionId,
        tick: ctx.tick,
        snapshotSeq: total,
        participants,
        includeManagers: true,
        includePhysics: true,
      });
      return {
        eligible: true,
        next: total,
        snapshotSeq: total,
        snapshot: serializeSnapshot(snap),
        bootstrapCommands: verdict.bootstrapCommands,
      };
    },
  };
  registry.register(snapshotBoot);
}
