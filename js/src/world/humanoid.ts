// Procedural humanoid (A-world). A small rig assembled from THREE primitives —
// capsule torso, sphere head, cylinder arm/leg segments hung from shoulder/hip
// pivots — with a phase-driven walk animation (opposite arm/leg swing + a slight
// two-beats-per-stride vertical bob). No external assets: the whole agent body is
// generated from a single `color` param so the conversation forest can place a
// crowd of distinct humanoids cheaply and deterministically.
//
//   createHumanoid({ color, height }) -> { group, height, update(dtMs, moving) }
//   spawnHumanoid(world, opts)        -> entity in the ECS/scene + the rig
//
// The rig orientation/position is the ROOT group's transform: the locomotion
// system writes the entity's ECS Position/Rotation, and renderSyncSystem drives
// the root each frame (windowed). The visual scale + walk bob live on an INNER
// `body` group so renderSync (which resets the root's scale to the ECS Scale of
// 1) never flattens the rig.

import * as THREE from "../../build/three.bundle.mjs";
import {
  MAX_ENTITIES,
  despawnRenderable,
  spawnRenderable,
} from "../ecs/world.ts";
import type { SceneObject } from "../engine.ts";
import type { WorldContext } from "../skills/registry.ts";

/** Nominal head-top height of the un-scaled rig (used to derive the scale that
 *  makes a requested `height` land at the top of the head). */
const NOMINAL_HEIGHT = 1.79;
const DEFAULT_HEIGHT = 1.75;
const DEFAULT_COLOR = 0x8aa0c0;

/** Walk-cycle tuning (radians / per-second). Cosmetic but deterministic. */
const PHASE_SPEED = 8.5; // stride angular frequency while moving
const GAIT_EASE = 7; // how fast the gait blends in/out between walk <-> idle
const LEG_SWING = 0.55;
const ARM_SWING = 0.45;
const BOB_AMP = 0.045;

/** A procedural humanoid: a scene-addable group + a per-frame walk update. */
export interface Humanoid {
  /** Scene-addable root; its transform is the entity transform (ECS-driven). */
  readonly group: SceneObject;
  /** Overall height (head top), for anchoring labels / speech bubbles overhead. */
  readonly height: number;
  /** Current walk-cycle phase (radians) — advances only while moving. */
  readonly walkPhase: number;
  /** Advance the walk animation by `dtMs`. `moving` swings the limbs + bobs; when
   *  false the gait eases back to a still idle pose. */
  update(dtMs: number, moving: boolean): void;
}

export interface CreateHumanoidOptions {
  /** Packed 0xRRGGBB clothing color (torso + limbs). */
  color?: number;
  /** Overall height in world units (default 1.75). */
  height?: number;
}

class HumanoidRig implements Humanoid {
  readonly group: SceneObject;
  readonly height: number;
  private phase = 0;
  private gait = 0; // eased 0 (idle) .. 1 (walking)
  private readonly body: { position: { y: number } };
  private readonly leftArm: { rotation: { x: number } };
  private readonly rightArm: { rotation: { x: number } };
  private readonly leftLeg: { rotation: { x: number } };
  private readonly rightLeg: { rotation: { x: number } };

  constructor(opts: CreateHumanoidOptions) {
    const height = opts.height ?? DEFAULT_HEIGHT;
    const color = opts.color ?? DEFAULT_COLOR;
    const scale = height / NOMINAL_HEIGHT;

    const root = new THREE.Group();
    const body = new THREE.Group();
    body.scale.set(scale, scale, scale);
    root.add(body);

    const cloth = new THREE.MeshStandardNodeMaterial({ color, roughness: 0.78, metalness: 0.04 });
    const skin = new THREE.MeshStandardNodeMaterial({ color: 0xf1c9a5, roughness: 0.62, metalness: 0 });
    const dark = new THREE.MeshStandardNodeMaterial({ color: 0x2b2f3a, roughness: 0.82, metalness: 0.02 });

    const torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.18, 0.5, 6, 12), cloth);
    torso.position.y = 1.18;
    torso.castShadow = true;
    body.add(torso);

    const head = new THREE.Mesh(new THREE.SphereGeometry(0.17, 20, 16), skin);
    head.position.y = 1.62;
    head.castShadow = true;
    body.add(head);

    // A limb is a pivot group at the joint with the segment hung downward from it,
    // so rotating the pivot about X swings the limb naturally.
    const limb = (x: number, y: number, len: number, radius: number, mat: unknown): { rotation: { x: number } } => {
      const pivot = new THREE.Group();
      pivot.position.set(x, y, 0);
      const seg = new THREE.Mesh(new THREE.CylinderGeometry(radius * 0.85, radius, len, 10), mat);
      seg.position.y = -len / 2;
      seg.castShadow = true;
      pivot.add(seg);
      body.add(pivot);
      return pivot;
    };

    this.leftArm = limb(-0.26, 1.42, 0.52, 0.06, cloth);
    this.rightArm = limb(0.26, 1.42, 0.52, 0.06, cloth);
    this.leftLeg = limb(-0.1, 0.84, 0.8, 0.09, dark);
    this.rightLeg = limb(0.1, 0.84, 0.8, 0.09, dark);

    this.body = body;
    this.group = root as unknown as SceneObject;
    this.height = height;
    // Settle to the idle pose immediately (gait 0).
    this.applyPose();
  }

  get walkPhase(): number {
    return this.phase;
  }

  update(dtMs: number, moving: boolean): void {
    const dt = dtMs / 1000;
    // Blend the gait toward walking/idle so transitions don't snap.
    const target = moving ? 1 : 0;
    this.gait += (target - this.gait) * Math.min(1, dt * GAIT_EASE);
    if (this.gait < 1e-4) this.gait = 0;
    if (moving) this.phase += PHASE_SPEED * dt;
    this.applyPose();
  }

  private applyPose(): void {
    const s = Math.sin(this.phase) * this.gait;
    // Opposite swing: left arm forward with right leg.
    this.leftLeg.rotation.x = s * LEG_SWING;
    this.rightLeg.rotation.x = -s * LEG_SWING;
    this.leftArm.rotation.x = -s * ARM_SWING;
    this.rightArm.rotation.x = s * ARM_SWING;
    // Two bobs per stride; only while the gait is engaged.
    this.body.position.y = Math.abs(Math.sin(this.phase)) * this.gait * BOB_AMP;
  }
}

/** Build a procedural humanoid rig (not yet in any world). */
export function createHumanoid(opts: CreateHumanoidOptions = {}): Humanoid {
  return new HumanoidRig(opts);
}

export interface SpawnHumanoidOptions extends CreateHumanoidOptions {
  /** Ground position [x, y, z] (feet); default origin. */
  position?: [number, number, number];
}

export interface SpawnedHumanoid {
  /** Opaque `ent_` id (ECS Position-bound, resolvable for anchors/locomotion). */
  entityId: string;
  /** bitECS entity id (SoA Position index). */
  eid: number;
  humanoid: Humanoid;
  group: SceneObject;
}

/** Create a humanoid, add it to the scene, bind it to a Position-tracked ECS
 *  entity, and register it in the entity table. Returns the ids + rig so a host
 *  can drive locomotion and anchor UI to the live SoA position. */
export function spawnHumanoid(world: WorldContext, opts: SpawnHumanoidOptions = {}): SpawnedHumanoid {
  const [x, y, z] = opts.position ?? [0, 0, 0];
  const humanoid = createHumanoid(opts);
  const group = humanoid.group;
  group.position.set(x, y, z);
  world.scene.add(group);
  const eid = spawnRenderable(world.ecs, group, x, y, z);
  if (eid >= MAX_ENTITIES) {
    despawnRenderable(world.ecs, eid);
    world.scene.remove(group);
    throw new Error("humanoid spawn: entity capacity exceeded (MAX_ENTITIES)");
  }
  // Identity transform faces +Z; locomotion writes Position/Rotation thereafter.
  const entityId = world.entities.create({ eid, mesh: group });
  return { entityId, eid, humanoid, group };
}
