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
//   4. RNG STATE       -- the seeded `Math.random` generator's internal 32-bit
//      state at T, so any randomness a delta skill draws continues the SAME
//      stream (NOT re-seeded from genesis).
//
// Recovery (see `recoverWorld`) restores 1-4 into a FRESH world, then replays
// ONLY the delta commands (seq >= snapshotSeq) -- the same command-application
// semantics as M1 replay, but starting mid-stream. The recorded delta carries
// agent/skill tool calls + physics ops; recovery NEVER re-runs decision
// providers, perception, or any from-genesis bootstrap.

import { Position, Rotation, Scale } from "../ecs/world.ts";
import { $internal } from "../../build/bitecs.bundle.mjs";
import type { EntityTableSnapshot } from "../engine.ts";
import type { WorldContext } from "../skills/registry.ts";
import {
  captureRandomState,
  captureWorldState,
  installRandomState,
  PHYSICS_OP_FN,
  syncAllBodies,
  type WorldCommand,
  type WorldStateSnapshot,
} from "./log.ts";
import type { ReplayDeps } from "./replay.ts";
import { LiminaTracer } from "../observability/event.ts";

export const SNAPSHOT_VERSION = 1;

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

/** One live entity's identity + transform at the snapshot tick. */
export interface SnapshotEntity {
  id: string;
  eid: number;
  bodyId?: number;
  generation: number;
  pos: [number, number, number];
  rot: [number, number, number, number];
  scale: [number, number, number];
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
  /** EntityTable `ent_` allocation counter + version at T. */
  entitySeq: number;
  entityVersion: number;
  entityIndex: EntityIndexSnapshot;
  entities: SnapshotEntity[];
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
  let len = b64.length;
  while (len > 0 && b64[len - 1] === "=") len--;
  const outLen = (len * 3) >> 2;
  const out = new Uint8Array(outLen);
  let o = 0;
  let acc = 0;
  let bits = 0;
  for (let i = 0; i < len; i++) {
    const v = B64_INV[b64.charCodeAt(i)];
    if (v < 0) throw new Error("world snapshot: invalid base64 character");
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

function captureEntityIndex(ecs: unknown): EntityIndexSnapshot {
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

/** Swap a fresh world's (empty) entity index for a restored one. Safe because the
 *  world is created with no entities before this runs, so future addEntity calls
 *  continue the original allocation sequence exactly. */
function restoreEntityIndex(ecs: unknown, snap: EntityIndexSnapshot): void {
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
  /** The recorder's next seq value (== commands recorded so far). Commands with
   *  seq < this are baked into the snapshot; seq >= this form the delta. */
  snapshotSeq: number;
}

/** Capture a complete world snapshot at the current tick boundary. MUST be called
 *  after the tick's step+syncAllBodies (so SoA reflects the post-step state) and
 *  with the seeded RNG installed. */
export function captureWorldSnapshot(world: WorldContext, opts: CaptureSnapshotOptions): WorldSnapshot {
  const table = world.entities.snapshot();
  const entities: SnapshotEntity[] = [];
  for (const entry of table.entries) {
    const eid = entry.eid;
    entities.push({
      id: entry.id,
      eid,
      bodyId: entry.bodyId,
      generation: entry.generation,
      pos: [Position.x[eid], Position.y[eid], Position.z[eid]],
      rot: [Rotation.x[eid], Rotation.y[eid], Rotation.z[eid], Rotation.w[eid]],
      scale: [Scale.x[eid], Scale.y[eid], Scale.z[eid]],
    });
  }
  const physics = world.ops.op_physics_snapshot();
  return {
    snapshotVersion: SNAPSHOT_VERSION,
    sessionId: opts.sessionId,
    tick: opts.tick,
    snapshotSeq: opts.snapshotSeq,
    rngState: captureRandomState(),
    entitySeq: table.seq,
    entityVersion: table.version,
    entityIndex: captureEntityIndex(world.ecs),
    entities,
    physics: bytesToBase64(physics),
  };
}

export function serializeSnapshot(snapshot: WorldSnapshot): string {
  return JSON.stringify(snapshot);
}

export function parseSnapshot(json: string): WorldSnapshot {
  const snap = JSON.parse(json) as WorldSnapshot;
  if (snap.snapshotVersion !== SNAPSHOT_VERSION) {
    throw new Error(`world snapshot: version ${snap.snapshotVersion} != ${SNAPSHOT_VERSION}`);
  }
  if (!Array.isArray(snap.entities) || typeof snap.physics !== "string" || snap.entityIndex === undefined) {
    throw new Error("world snapshot: malformed snapshot");
  }
  return snap;
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
 *  world primed to replay the delta from tick T. */
export function restoreSnapshot(world: WorldContext, snapshot: WorldSnapshot): void {
  // 1. RNG: resume the seeded generator mid-stream.
  installRandomState(snapshot.rngState);
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
  // 5. ECS transforms: every live entity's Position/Rotation/Scale at T.
  for (const e of snapshot.entities) {
    Position.x[e.eid] = e.pos[0]; Position.y[e.eid] = e.pos[1]; Position.z[e.eid] = e.pos[2];
    Rotation.x[e.eid] = e.rot[0]; Rotation.y[e.eid] = e.rot[1]; Rotation.z[e.eid] = e.rot[2]; Rotation.w[e.eid] = e.rot[3];
    Scale.x[e.eid] = e.scale[0]; Scale.y[e.eid] = e.scale[1]; Scale.z[e.eid] = e.scale[2];
  }
}

/** Recover a world from a snapshot + the delta command stream. Builds a FRESH
 *  world via `deps.makeWorld`, restores the snapshot, then replays ONLY the delta
 *  commands (the same command-application semantics as M1 replay, started
 *  mid-stream). The result's final state must be bit-identical to the original
 *  run's final state -- proven by the caller via compareWorldState.
 *
 *  `deltaCommands` MUST be exactly the commands with seq >= snapshot.snapshotSeq
 *  (in seq order). They carry recorded tool calls + physics ops; NO decision
 *  provider, perception, or genesis bootstrap is re-run. */
export async function recoverWorld(
  snapshot: WorldSnapshot,
  deltaCommands: WorldCommand[],
  deps: ReplayDeps,
): Promise<RecoveryResult> {
  const tracer = deps.tracer ?? new LiminaTracer("ses_worldlog_recover");
  const registry = deps.makeRegistry(tracer);
  const world = deps.makeWorld();

  // Fresh transform storage: zero the global SoA so any entity the snapshot does
  // not restore reads back as 0 (and is caught by the bit-identical check), then
  // overwrite the live entities from the snapshot.
  Position.x.fill(0); Position.y.fill(0); Position.z.fill(0);
  Rotation.x.fill(0); Rotation.y.fill(0); Rotation.z.fill(0); Rotation.w.fill(0);
  Scale.x.fill(0); Scale.y.fill(0); Scale.z.fill(0);
  restoreSnapshot(world, snapshot);

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
      const op = world.ops[PHYSICS_OP_FN[cmd.op]] as (...a: number[]) => unknown;
      op(...cmd.args);
      deltaPhysicsOps++;
      if (cmd.op === "step") {
        deltaSteps++;
        syncAllBodies(world);
      }
      continue;
    }
    await registry.invoke(cmd.tool, cmd.input, {
      agentId: cmd.actorId,
      sessionId: cmd.sessionId,
      permissions: new Set(cmd.perms),
      tick: cmd.tick,
      world,
      causedBy: [],
    });
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
