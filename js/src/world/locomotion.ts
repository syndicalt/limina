// Walk-to-target locomotion (A-world). A deterministic, fixed-dt system: each
// registered actor (an ECS Position-bound humanoid) walks toward a move target —
// a world point or another entity — at a walk speed, faces its movement/target
// direction (yaw, written to the entity's ECS Rotation), advances its humanoid
// walk phase while moving, and reports ARRIVAL once it is within `talkDistance`.
//
// The system is the single writer of an actor's planar Position + yaw while it
// has a target. Everything is a pure function of (positions, dt), so the same
// inputs always produce the same walk — the CI test asserts exact arrival.

import { Position, Rotation } from "../ecs/world.ts";
import type { WorldContext } from "../skills/registry.ts";
import type { Humanoid } from "./humanoid.ts";

export type Vec3 = [number, number, number];

/** Where an actor is walking: a fixed world point, or a live entity to meet. */
export type MoveTarget =
  | { kind: "point"; point: Vec3 }
  | { kind: "entity"; entity: string };

export interface LocomotionActorSpec {
  /** Agent id the social skills key off (host-bound speaker -> entity). */
  agentId: string;
  /** The `ent_` id of this actor's Position-bound humanoid. */
  entityId: string;
  /** bitECS Position index of `entityId`. */
  eid: number;
  humanoid: Humanoid;
  /** Walk speed (world units / second); default 1.6. */
  speed?: number;
  /** Stop / "arrived" distance to the target (planar); default 1.4. */
  talkDistance?: number;
}

const DEFAULT_SPEED = 1.6;
const DEFAULT_TALK = 1.4;
const EPS = 1e-6;

interface LocoActor {
  agentId: string;
  entityId: string;
  eid: number;
  humanoid: Humanoid;
  speed: number;
  talkDistance: number;
  target: MoveTarget | undefined;
  arrived: boolean;
  yaw: number;
}

/** The live registry of walking actors. Add actors, give them targets, and call
 *  step(world, dtMs) each fixed step; query arrival/facing/distance for tests +
 *  conversation gating. Also doubles as the host-bound speaker -> entity map the
 *  social skills resolve through. */
export class Locomotion {
  private readonly actors = new Map<string, LocoActor>();

  add(spec: LocomotionActorSpec): void {
    this.actors.set(spec.agentId, {
      agentId: spec.agentId,
      entityId: spec.entityId,
      eid: spec.eid,
      humanoid: spec.humanoid,
      speed: spec.speed ?? DEFAULT_SPEED,
      talkDistance: spec.talkDistance ?? DEFAULT_TALK,
      target: undefined,
      arrived: false,
      yaw: 0,
    });
  }

  has(agentId: string): boolean {
    return this.actors.has(agentId);
  }

  /** The `ent_` id bound to an agent — the host-bound speaker resolver. */
  entityIdOf(agentId: string): string | undefined {
    return this.actors.get(agentId)?.entityId;
  }

  /** The bound humanoid's overhead height — where a speaker's bubble anchors. */
  heightOf(agentId: string): number | undefined {
    return this.actors.get(agentId)?.humanoid.height;
  }

  /** Set (or replace) an actor's move target; resets arrival. Optionally override
   *  the talk distance for this approach. Returns false for an unknown actor. */
  setTarget(agentId: string, target: MoveTarget, talkDistance?: number): boolean {
    const actor = this.actors.get(agentId);
    if (actor === undefined) return false;
    actor.target = target;
    actor.arrived = false;
    if (talkDistance !== undefined) actor.talkDistance = talkDistance;
    return true;
  }

  clearTarget(agentId: string): void {
    const actor = this.actors.get(agentId);
    if (actor !== undefined) {
      actor.target = undefined;
      actor.arrived = false;
    }
  }

  hasArrived(agentId: string): boolean {
    return this.actors.get(agentId)?.arrived ?? false;
  }

  /** Current planar distance from an actor to its target, or undefined when it
   *  has no (resolvable) target. */
  distanceToTarget(world: WorldContext, agentId: string): number | undefined {
    const actor = this.actors.get(agentId);
    if (actor === undefined || actor.target === undefined) return undefined;
    const tgt = this.resolveTarget(world, actor.target);
    if (tgt === undefined) return undefined;
    const dx = tgt[0] - Position.x[actor.eid];
    const dz = tgt[2] - Position.z[actor.eid];
    return Math.hypot(dx, dz);
  }

  /** The actor's current facing (unit forward on the XZ plane), from its yaw. */
  facing(agentId: string): Vec3 | undefined {
    const actor = this.actors.get(agentId);
    if (actor === undefined) return undefined;
    return [Math.sin(actor.yaw), 0, Math.cos(actor.yaw)];
  }

  /** Advance every actor one fixed step: face the target, translate up to
   *  speed*dt toward it (clamped at talkDistance so it stops cleanly), set
   *  arrival, and tick the humanoid walk animation. */
  step(world: WorldContext, dtMs: number): void {
    const dt = dtMs / 1000;
    for (const actor of this.actors.values()) {
      if (actor.target === undefined) {
        actor.humanoid.update(dtMs, false);
        continue;
      }
      const tgt = this.resolveTarget(world, actor.target);
      if (tgt === undefined) {
        actor.humanoid.update(dtMs, false);
        continue;
      }
      const px = Position.x[actor.eid];
      const pz = Position.z[actor.eid];
      const dx = tgt[0] - px;
      const dz = tgt[2] - pz;
      const dist = Math.hypot(dx, dz);

      // Face the target even when standing still, so conversation partners turn
      // toward each other on arrival.
      if (dist > EPS) {
        actor.yaw = Math.atan2(dx, dz);
        this.writeYaw(actor.eid, actor.yaw);
      }

      let moving = false;
      if (dist <= actor.talkDistance) {
        actor.arrived = true;
      } else {
        const advance = Math.min(actor.speed * dt, dist - actor.talkDistance);
        const inv = 1 / dist;
        Position.x[actor.eid] = px + dx * inv * advance;
        Position.z[actor.eid] = pz + dz * inv * advance;
        moving = advance > EPS;
        const ndx = tgt[0] - Position.x[actor.eid];
        const ndz = tgt[2] - Position.z[actor.eid];
        actor.arrived = Math.hypot(ndx, ndz) <= actor.talkDistance + EPS;
      }
      actor.humanoid.update(dtMs, moving);
    }
  }

  private resolveTarget(world: WorldContext, target: MoveTarget): Vec3 | undefined {
    if (target.kind === "point") return target.point;
    const entry = world.entities.resolve(target.entity);
    if (entry === undefined) return undefined;
    return [Position.x[entry.eid], Position.y[entry.eid], Position.z[entry.eid]];
  }

  private writeYaw(eid: number, yaw: number): void {
    // Quaternion about +Y: local +Z maps to (sin yaw, 0, cos yaw) = the facing dir.
    Rotation.x[eid] = 0;
    Rotation.y[eid] = Math.sin(yaw / 2);
    Rotation.z[eid] = 0;
    Rotation.w[eid] = Math.cos(yaw / 2);
  }
}
