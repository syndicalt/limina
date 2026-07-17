// Editor session FAST-BOOT — the browser-realm half of worldlog.snapshotBoot
// (js/src/skills/worldlog.ts). A long recorded session boots from a v3
// self-sufficient WorldSnapshot + a bounded command tail instead of re-authoring
// every recorded command.
//
// ── The realm contract ────────────────────────────────────────────────────────
// BOTH realms (render main + sim worker) boot by the SAME deterministic
// procedure, so entity/eid/body-id allocation stays byte-identical between them
// — exactly the invariant the full-replay path's realm-divergence guard
// protects:
//   1. AUTHOR the boot program (`snapshotBootProgram`): the verbatim
//      create_world/add_ground bootstrap ops, then each live entity's ORIGIN
//      create command in creation order, then a three.setMaterial per entity
//      carrying first-class material (so the render realm's meshes LOOK right;
//      the worker's stub meshes no-op). Ordinary AuthorCommands — the existing
//      prewarm/isolation/apply machinery consumes them unchanged.
//   2. FINALIZE (`finalizeSnapshotBoot`): VERIFY the replay allocated the exact
//      snapshot identity (ids/eids/bodyIds/runtimeBodyIds — fail loudly, never
//      render a half-restored world), install BOTH RNG streams mid-stream,
//      overwrite SoA transforms + tags, re-pose every physics body from the
//      snapshot, rebind first-class entity state, and restore manager state
//      through the snapshot-participant registry.
//
// ── Why not op_physics_restore? ───────────────────────────────────────────────
// The native blob is bincode of the Rust PhysicsSnapshot struct
// (crates/limina-physics); the wasm adapter's restore expects its OWN
// [metaLen][meta JSON][rapier.js takeSnapshot] format. They are NOT compatible,
// so the browser realms rebuild bodies via origin replay and re-pose them.
// Poses are exact (f32 from the snapshot); transient velocities/warm-start are
// NOT restored — dynamics re-settle, the same fidelity the full-replay viewport
// has always had (it never replays recorded `step` ops either). The NATIVE
// recovery path (worldlog/snapshot.ts restoreSnapshot) keeps the exact blob.
//
// PORTABILITY: no DOM, no THREE, no Deno — runs identically in the render
// realm, the sim worker, and headless gates.

import { Position, Rotation, Scale } from "../ecs/world.ts";
import { installRandomState, installSkillRandomState } from "../worldlog/log.ts";
import {
  CHARACTERS_PARTICIPANT_KEY,
  EVENTS_PARTICIPANT_KEY,
  parseSnapshot,
  type SnapshotParticipantRegistry,
  type WorldSnapshot,
} from "../worldlog/snapshot.ts";
import type { WorldContext } from "../skills/registry.ts";
import type { AuthorCommand } from "../kernel/authoring.ts";

/** The wire payload worldlog.snapshotBoot answers with (eligible form). */
export interface SnapshotBootPayload {
  snapshotSeq: number;
  /** serializeSnapshot output — parsed (and validated) with parseSnapshot. */
  snapshot: string;
  bootstrapCommands: AuthorCommand[];
}

/** Parse + validate a snapshotBoot wire payload into the parsed snapshot. */
export function parseSnapshotBootPayload(payload: SnapshotBootPayload): WorldSnapshot {
  const snap = parseSnapshot(payload.snapshot);
  if (snap.snapshotSeq !== payload.snapshotSeq) {
    throw new Error(`snapshot boot: payload snapshotSeq ${payload.snapshotSeq} != snapshot's ${snap.snapshotSeq}`);
  }
  return snap;
}

/** Build the deterministic boot AUTHORING PROGRAM for a parsed snapshot: the
 *  bootstrap physics ops, every live entity's origin command in creation order,
 *  then a three.setMaterial per entity with first-class material state. Both
 *  realms author this identical program, so both allocate identical identity. */
export function snapshotBootProgram(snapshot: WorldSnapshot, bootstrapCommands: readonly AuthorCommand[]): AuthorCommand[] {
  const out: AuthorCommand[] = [...bootstrapCommands];
  for (const e of snapshot.entities) {
    if (e.origin === undefined) {
      throw new Error(`snapshot boot: entity '${e.id}' carries no origin command -- the host must not have marked this session eligible`);
    }
    out.push({ kind: "skill", tool: e.origin.tool, input: e.origin.input });
  }
  for (const e of snapshot.entities) {
    const m = e.material;
    if (m === undefined) continue;
    out.push({
      kind: "skill",
      tool: "three.setMaterial",
      input: {
        entity: e.id,
        ...(m.name !== undefined ? { material: m.name } : {}),
        ...(m.pbr !== undefined ? { pbr: m.pbr } : {}),
        ...(m.color !== undefined ? { color: m.color } : {}),
        ...(m.roughness !== undefined ? { roughness: m.roughness } : {}),
        ...(m.metalness !== undefined ? { metalness: m.metalness } : {}),
      },
    });
  }
  return out;
}

function sameNumberArray(a: readonly number[] | undefined, b: readonly number[] | undefined): boolean {
  const av = a ?? [];
  const bv = b ?? [];
  if (av.length !== bv.length) return false;
  for (let i = 0; i < av.length; i++) if (av[i] !== bv[i]) return false;
  return true;
}

/** Finalize a realm after it authored the boot program: verify allocation
 *  parity against the snapshot, install BOTH RNG streams, overwrite transforms/
 *  tags/first-class entity state, re-pose physics bodies, and restore manager
 *  state. THROWS on any mismatch — the caller must abandon the snapshot path
 *  (fall back to full replay), never present a half-restored world. */
export function finalizeSnapshotBoot(
  world: WorldContext,
  snapshot: WorldSnapshot,
  participants: SnapshotParticipantRegistry | undefined,
): { entities: number } {
  // 1. VERIFY identity parity: the origin replay must have allocated the exact
  //    snapshot ids/eids/bodyIds (both realms run this same check, so a failure
  //    in either realm is a failure in both — deterministic program).
  const table = world.entities.snapshot();
  if (table.entries.length !== snapshot.entities.length) {
    throw new Error(`snapshot boot: replay produced ${table.entries.length} entities, snapshot carries ${snapshot.entities.length}`);
  }
  if (table.seq !== snapshot.entitySeq) {
    throw new Error(`snapshot boot: entity seq ${table.seq} != snapshot entitySeq ${snapshot.entitySeq}`);
  }
  for (let i = 0; i < snapshot.entities.length; i++) {
    const want = snapshot.entities[i];
    const got = table.entries[i];
    if (got.id !== want.id || got.eid !== want.eid || got.bodyId !== want.bodyId) {
      throw new Error(
        `snapshot boot: allocation diverged at slot ${i}: replay {id:'${got.id}', eid:${got.eid}, bodyId:${got.bodyId}} ` +
          `vs snapshot {id:'${want.id}', eid:${want.eid}, bodyId:${want.bodyId}}`,
      );
    }
    const live = world.entities.resolve(want.id);
    if (live === undefined) throw new Error(`snapshot boot: entity '${want.id}' not live after replay`);
    if (!sameNumberArray(live.runtimeBodyIds, want.runtimeBodyIds)) {
      throw new Error(`snapshot boot: entity '${want.id}' runtime body ids diverged ([${live.runtimeBodyIds ?? []}] vs [${want.runtimeBodyIds ?? []}])`);
    }
  }
  // 2. RNG: resume BOTH seeded streams mid-stream (global Math.random slot +
  //    the world-owned skill stream) in THIS realm, so tail-replayed skill
  //    draws continue the authoritative sequences.
  installRandomState(snapshot.rngState);
  world.rng = installSkillRandomState(snapshot.skillRngState ?? snapshot.rngState);
  // 3. Transforms + tags + first-class entity state: the snapshot is
  //    authoritative — overwrite wholesale (mirrors restoreSnapshot).
  world.tags.clear();
  for (const e of snapshot.entities) {
    Position.x[e.eid] = e.pos[0]; Position.y[e.eid] = e.pos[1]; Position.z[e.eid] = e.pos[2];
    Rotation.x[e.eid] = e.rot[0]; Rotation.y[e.eid] = e.rot[1]; Rotation.z[e.eid] = e.rot[2]; Rotation.w[e.eid] = e.rot[3];
    Scale.x[e.eid] = e.scale[0]; Scale.y[e.eid] = e.scale[1]; Scale.z[e.eid] = e.scale[2];
    if (e.tags.length > 0) world.tags.set(e.eid, new Set(e.tags));
    if (e.resource !== undefined) world.entities.bindResource(e.id, e.resource);
    if (e.origin !== undefined) world.entities.bindOrigin(e.id, e.origin);
    if (e.material !== undefined) world.entities.bindMaterial(e.id, e.material);
    if (e.behavior !== undefined) world.entities.bindBehavior(e.id, e.behavior);
    // Re-pose the entity's body (and nothing else): collider shapes/ownership
    // were rebuilt by the origin replay; the pose is the snapshot's truth.
    if (e.bodyId !== undefined) {
      world.ops.op_physics_set_body_transform(
        e.bodyId,
        e.pos[0], e.pos[1], e.pos[2],
        e.rot[0], e.rot[1], e.rot[2], e.rot[3],
      );
    }
  }
  // 4. Character resume state: eligible sessions never spawn controllers, so a
  //    snapshot carrying controller state is a contract breach — fail loudly.
  if (snapshot.characters.length > 0) {
    const characters = participants?.get(CHARACTERS_PARTICIPANT_KEY);
    if (characters === undefined) {
      throw new Error("snapshot boot: snapshot carries character-controller state but this realm registered no characters participant");
    }
    characters.restore(snapshot.characters);
  }
  // 5. World-level events + per-manager state, through the participant registry
  //    with the SAME loud-failure semantics as restoreSnapshot: state the realm
  //    cannot restore must never be silently dropped.
  if (snapshot.events.length > 0 || participants?.has(EVENTS_PARTICIPANT_KEY) === true) {
    participants?.get(EVENTS_PARTICIPANT_KEY)?.restore(snapshot.events);
  }
  const managerKeys = Object.keys(snapshot.managers ?? {}).sort();
  for (const key of managerKeys) {
    const participant = participants?.get(key);
    if (participant === undefined) {
      throw new Error(`snapshot boot: managers entry '${key}' has no registered snapshot participant -- cannot restore state this realm does not own`);
    }
    const parsed = participant.schema.safeParse(snapshot.managers[key]);
    if (!parsed.success) {
      throw new Error(`snapshot boot: managers entry '${key}' failed its participant schema: ${parsed.error.message}`);
    }
    participant.restore(parsed.data);
  }
  return { entities: snapshot.entities.length };
}
