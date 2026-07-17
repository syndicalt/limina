// limina world-log IDLE-STEP FILTER (kernel K-compaction, Map Phase 3.1).
//
// THE MEASURED PROBLEM: a long-lived authoritative session (the editor host) records one
// {"op":"step"} physics command per tick, forever. A real dev session's durable world log grew to
// 32,767 step records out of 32,772 lines (99.98%) -- and boot rehydrate RE-APPLIES the entire
// history, so boot cost grows with session TIME, not world size (measured ~25s at 1.29M lines).
//
// THE CUT: a `step` is PURE SIM OUTPUT -- it carries no authored input (args are empty; dt is
// fixed native-side). Its only replay value is INTEGRATING MOTION: replaying a step moves dynamic
// bodies exactly as the live run did (native Rapier is bit-deterministic for identical inputs).
// A step during which NO tracked dynamic body's transform changed AT ALL (bit-exact compare, the
// same strictness compareWorldState gates on) integrates nothing: every body is either static or
// asleep, and stepping an asleep world is a state no-op. Dropping that record from the log leaves
// replay bit-identical -- the world the replayed stream reconstructs cannot tell whether 1 or
// 100,000 asleep ticks elapsed. Steps that DID move something are still recorded, so genuine
// motion (falling crates, impulses, character movement) replays exactly as before.
//
// WHY NOT DROP ALL STEPS: boot rehydrate (net/server.ts), batch replay (worldlog/replay.ts) and
// snapshot delta recovery (worldlog/snapshot.ts) run against the REAL engine ops -- for them a
// recorded step genuinely integrates physics, so steps that move bodies are load-bearing. (Export
// playback is different: there motion comes from keyframes and op_physics_step only bumps a tick
// counter -- see browser/keyframe-physics.ts -- but the durable-boot paths have no keyframes.)
//
// GRACE WINDOW: "transform bit-stable" is not quite "hidden native state settled" -- a body can
// sit bit-still for a few ticks while its sleep timer / solver warm-start caches still evolve
// (Rapier sleeps a body after ~0.4s below the velocity threshold). To keep that window out of the
// cut, the filter keeps recording steps for IDLE_STEP_GRACE ticks after the last observed change
// or activity signal; by then genuinely-still bodies are asleep and the state is a true fixed
// point. Activity signals (a dynamic-body spawn/removal, an impulse, a character move, a nested
// in-skill step that advanced the sim behind our cache) also arm the window, so a step is never
// silently dropped right when something was just set in motion.
//
// KNOWN LIMITATION (documented, accepted): a body that stays AWAKE indefinitely with a persistent
// velocity whose per-step transform delta rounds to zero bits (possible only at extreme
// coordinates, ~1e4+ with f32 ULPs) would idle-filter while hidden velocity state still matters.
// No such regime exists in limina worlds (~1e2..1e3 m), and detecting it would need a native
// velocity/sleep-state op the engine does not expose. The filter's change test is otherwise
// EXACTLY the definition of state the acceptance gates compare (bit-exact body transforms).
//
// TRACKING: the recorder feeds `observe()` for EVERY wrapped physics op at ANY chain depth --
// top-level ops via the recording proxy, in-skill ops via the non-recording chainOps facade
// skills execute against -- so the filter sees every dynamic-body
// creation/removal regardless of whether the op itself was recorded. This covers RAW bodies that
// never enter the entity table (bootstrap `add_box` etc.) -- an entity-table walk would miss
// those, and a raw body mid-flight must keep its steps recorded. Ops the proxy does not wrap
// (e.g. op_physics_set_body_transform) simply leave the cache stale, which reads as a CHANGE on
// the next poll -- the failure bias is always "record one step too many", never "drop one that
// mattered".

import type { EngineOps } from "../engine.ts";
import type { PhysicsOpName } from "./log.ts";

/** Ticks to keep recording steps after the last observed change/activity. Comfortably past
 *  Rapier's ~0.4s (~25-tick) sleep threshold so settling bodies are asleep before the cut. */
export const IDLE_STEP_GRACE = 64;

/** Recorded ops that create a body a `step` can move (dynamic or kinematic-character). Static
 *  adds (add_ground / add_static_*) are excluded: a step never moves them. */
const DYNAMIC_BODY_OPS: ReadonlySet<PhysicsOpName> = new Set([
  "add_box",
  "add_box_material",
  "add_sphere",
  "add_capsule",
  "add_character",
]);

export class IdleStepFilter {
  /** Live dynamic body id -> last polled [px,py,pz, qx,qy,qz,qw]; null = not yet polled
   *  (a fresh body always counts as changed once, so its first post-spawn step records). */
  private readonly bodies = new Map<number, Float32Array | null>();
  private readonly scratch = new Float32Array(7);
  /** Monotonic top-level step counter. Deliberately NOT the world tick: the server's tick counter
   *  restarts at 0 after a rehydrated boot while replayed commands carry large historical ticks,
   *  so a tick-based grace window would mis-arm across the boot seam. Polls only move forward. */
  private polls = 0;
  private lastActivityPoll = Number.MIN_SAFE_INTEGER;
  /** Set by observe() between polls; consumed (arms the grace window) at the next poll. */
  private activity = false;

  /** Feed every wrapped physics op (any chain depth) so body tracking + activity stay complete. */
  observe(op: PhysicsOpName, args: number[], result: unknown): void {
    if (DYNAMIC_BODY_OPS.has(op)) {
      if (typeof result === "number") {
        this.bodies.set(result, null);
        this.activity = true;
      }
      return;
    }
    switch (op) {
      case "create_world":
        // A fresh/reset native world has no bodies; do NOT arm activity -- an empty world's idle
        // steps are precisely the classic bloat this filter exists to cut.
        this.bodies.clear();
        return;
      case "remove_body":
        this.bodies.delete(args[0]);
        // Removal can un-support neighbours (a stack loses its base), so keep recording briefly.
        this.activity = true;
        return;
      case "apply_impulse":
      case "move_character":
        // These change VELOCITY/pending-motion, not transforms; the resulting transform change
        // lands on a later step. Arm the window so those steps record even if the very first
        // post-impulse transform delta rounds to the same bits.
        this.activity = true;
        return;
      case "step":
        // A NESTED (inside-a-skill) step advanced the sim behind our cache. The skill
        // command replays it, so it is not recorded here -- but the next top-level step must
        // re-poll from a "something happened" stance.
        this.activity = true;
        return;
      default:
        return;
    }
  }

  /** Called AFTER a top-level `op_physics_step` was applied. Returns true iff the step should be
   *  recorded: any tracked body's transform changed bit-wise this tick, or the grace window since
   *  the last change/activity has not yet elapsed. Also refreshes the per-body transform cache. */
  shouldRecordStep(ops: EngineOps): boolean {
    this.polls++;
    let changed = this.activity;
    this.activity = false;
    const cur = this.scratch;
    for (const [id, prev] of this.bodies) {
      ops.op_physics_body_transform(id, cur);
      if (prev === null) {
        this.bodies.set(id, cur.slice());
        changed = true;
        continue;
      }
      let moved = false;
      for (let i = 0; i < 7; i++) {
        // Strict bit-level inequality (the gates' compareWorldState strictness). A NaN component
        // reads as perpetually "moved" -- over-recording, the safe direction.
        if (prev[i] !== cur[i]) {
          moved = true;
          break;
        }
      }
      if (moved) {
        prev.set(cur);
        changed = true;
      }
    }
    if (changed) this.lastActivityPoll = this.polls;
    return this.polls - this.lastActivityPoll <= IDLE_STEP_GRACE;
  }
}
