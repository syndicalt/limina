// Rigged glTF CHARACTER MODEL — a render-only visual + animation wrapper that stands
// in for a sim-owned CharacterController's capsule. A sibling of humanoid.ts (the
// procedural rig) and third_person_camera.ts (the follow camera): same world/ helper
// style, same RENDER-ONLY contract.
//
//   attachCharacterModel({ world, registry, base, engine, ... }) -> CharacterModel
//
// It loads a rigged, animated glTF (default assets/robot.glb — 4 SkinnedMeshes with
// Idle/Walking/Running clips) through the three.loadGLTF SKILL (so the model becomes a
// real ECS renderable with an entity the animation.* skills can resolve), then exposes:
//   • setPose(footPos, yaw) — place the model's FEET at footPos and face yaw. The
//     CharacterController's position is the capsule CENTER, so the host passes
//     footPos = [cx, cy - (halfHeight + radius), cz].
//   • setLocomotion(state, dt) — crossfade the locomotion clip (idle/walk/run) on
//     change AND pump the shared AnimationMixer by dt (when an AnimationManager is
//     supplied; otherwise the host must pump core.animation.animationManager.update).
//
// DETERMINISM: this NEVER touches sim/physics/log state. The clip cycle is cosmetic and
// dt-driven; the sim's recorded move_character stream is unaffected. Transforms are
// written into the entity's ECS SoA (Position/Rotation/Scale) and applied by the host's
// existing renderSyncSystem() call — the same path every other renderable rides.

import * as THREE from "../../build/three.bundle.mjs";
import { Position, Rotation, Scale } from "../ecs/world.ts";
import type { SceneObject } from "../engine.ts";
import type { AnimationManager } from "../skills/animation.ts";
import type { InvokeBase, SkillRegistry, WorldContext } from "../skills/registry.ts";

/** Locomotion gait the model plays. Maps to the idle/walk/run clip ids. */
export type LocomotionState = "idle" | "walk" | "run";

/** Named locomotion clips carried by the rigged glTF (defaults match robot.glb). */
export interface LocomotionClips {
  idle: string;
  walk: string;
  run: string;
}

const DEFAULT_ASSET = "robot.glb";
const DEFAULT_CLIPS: LocomotionClips = { idle: "Idle", walk: "Walking", run: "Running" };
const DEFAULT_TARGET_HEIGHT = 1.8; // meters — auto-fit the model to a human height
const DEFAULT_CROSSFADE_MS = 180; // locomotion clip crossfade

export interface AttachCharacterModelOptions {
  world: WorldContext;
  registry: SkillRegistry;
  /** The caller's invoke base (agent/session/permissions/world). */
  base: InvokeBase;
  /** The shared AnimationManager (core.animation.animationManager). When supplied,
   *  setLocomotion(dt) pumps the mixer itself; otherwise the host must pump it. */
  animationManager?: AnimationManager;
  /** Asset id of the rigged glTF. Default "robot.glb". */
  assetId?: string;
  /** Explicit uniform scale. When omitted the model is auto-fit so its height ≈
   *  targetHeight (robust to unknown model units). */
  scale?: number;
  /** Auto-fit target height in meters (used only when `scale` is omitted). Default 1.8. */
  targetHeight?: number;
  /** Extra yaw (radians) added so the model's own forward axis faces the move dir.
   *  The engine convention here is local +Z = forward; robot.glb already faces +Z, so
   *  the default 0 is correct. Use Math.PI if a model faces backward. */
  forwardOffset?: number;
  /** Additional vertical nudge (world meters) after foot-fit. Default 0. */
  footOffset?: number;
  /** Initial foot position [x,y,z] for the first frame (before setPose runs). */
  position?: [number, number, number];
  /** Locomotion clip names. Default { idle:"Idle", walk:"Walking", run:"Running" }. */
  clips?: Partial<LocomotionClips>;
  /** Crossfade duration between locomotion clips (ms). Default 180. */
  crossfadeMs?: number;
}

/** A loaded, rigged glTF character standing in for a capsule. Render-only. */
export interface CharacterModel {
  /** The animation entity id (resolves to the glTF root via world.entities). */
  readonly entity: string;
  /** The glTF scene root (the AnimationMixer root + ECS renderable). */
  readonly root: SceneObject;
  /** Uniform scale applied to the model. */
  readonly scale: number;
  /** World-space vertical offset baked so the model's FEET land on footPos.y. */
  readonly footY: number;
  /** Place the model's feet at `footPos` and face `yaw` (radians, +Z forward). */
  setPose(footPos: readonly [number, number, number], yaw: number): void;
  /** Switch the locomotion clip (crossfading on change) and pump the mixer by `dt`
   *  seconds (when an AnimationManager was supplied). Idempotent per state. */
  setLocomotion(state: LocomotionState, dt: number): void;
  /** Refresh the skinning AFTER the host applies the ECS transform (renderSyncSystem)
   *  and BEFORE renderer.render(). Recomputes the model's world matrices + the shared
   *  skeleton's bone matrices. REQUIRED when the model is driven by an external
   *  transform: three's WebGPU backend does not re-upload the bone matrices for the
   *  rig's shared-skeleton sub-meshes on its own, so the arms/limbs would lag the body
   *  and visibly DETACH as the character translates. Call once per render frame. */
  syncSkinning(): void;
  /** The currently-selected locomotion state. */
  readonly state: LocomotionState;
}

/** Y-only quaternion components for a yaw rotation (matches the engine convention
 *  Rotation.y = sin(yaw/2), w = cos(yaw/2)). */
function yawQuat(yaw: number): [number, number, number, number] {
  return [0, Math.sin(yaw / 2), 0, Math.cos(yaw / 2)];
}

/** Measure the model's LOCAL-space bounding box (root reset to identity first). */
function localBounds(root: SceneObject): { minY: number; height: number } {
  const obj = root as unknown as THREE.Object3D;
  obj.position.set(0, 0, 0);
  obj.quaternion.set(0, 0, 0, 1);
  obj.scale.set(1, 1, 1);
  obj.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(obj);
  const minY = Number.isFinite(box.min.y) ? box.min.y : 0;
  const maxY = Number.isFinite(box.max.y) ? box.max.y : 1;
  return { minY, height: Math.max(1e-3, maxY - minY) };
}

class RiggedCharacterModel implements CharacterModel {
  readonly entity: string;
  readonly root: SceneObject;
  readonly scale: number;
  readonly footY: number;

  private readonly eid: number;
  private readonly registry: SkillRegistry;
  private readonly base: InvokeBase;
  private readonly mgr?: AnimationManager;
  private readonly clips: LocomotionClips;
  private readonly forwardOffset: number;
  private readonly crossfadeMs: number;
  private cur: LocomotionState | undefined;
  private curClip: string | undefined;

  constructor(opts: {
    entity: string;
    eid: number;
    root: SceneObject;
    scale: number;
    footYOffset: number;
    registry: SkillRegistry;
    base: InvokeBase;
    mgr?: AnimationManager;
    clips: LocomotionClips;
    forwardOffset: number;
    crossfadeMs: number;
  }) {
    this.entity = opts.entity;
    this.eid = opts.eid;
    this.root = opts.root;
    this.scale = opts.scale;
    this.footY = opts.footYOffset;
    this.registry = opts.registry;
    this.base = opts.base;
    this.mgr = opts.mgr;
    this.clips = opts.clips;
    this.forwardOffset = opts.forwardOffset;
    this.crossfadeMs = opts.crossfadeMs;
    // Bake the constant scale into the ECS SoA (renderSyncSystem applies it each frame).
    Scale.x[this.eid] = this.scale;
    Scale.y[this.eid] = this.scale;
    Scale.z[this.eid] = this.scale;
  }

  get state(): LocomotionState {
    return this.cur ?? "idle";
  }

  setPose(footPos: readonly [number, number, number], yaw: number): void {
    Position.x[this.eid] = footPos[0];
    // foot-fit: root origin + footY (= -minY*scale + footOffset) lands the model's
    // lowest point exactly on footPos.y.
    Position.y[this.eid] = footPos[1] + this.footY;
    Position.z[this.eid] = footPos[2];
    const q = yawQuat(yaw + this.forwardOffset);
    Rotation.x[this.eid] = q[0];
    Rotation.y[this.eid] = q[1];
    Rotation.z[this.eid] = q[2];
    Rotation.w[this.eid] = q[3];
  }

  setLocomotion(state: LocomotionState, dt: number): void {
    if (state !== this.cur) {
      this.cur = state;
      const next = this.clips[state];
      // Crossfade: fade the previous layer-0 clip out, fade the new one in. (Only the
      // previous locomotion clip is live on layer 0, so the layer-wide stop is safe.)
      if (this.curClip !== undefined && this.curClip !== next) {
        void this.registry.invoke("animation.stop", { entity: this.entity, layer: 0, fadeOutMs: this.crossfadeMs }, this.base);
      }
      void this.registry.invoke("animation.play", { entity: this.entity, clipId: next, loop: true, fadeDuration: this.crossfadeMs }, this.base);
      this.curClip = next;
    }
    // Pump the shared mixer (render-only, dt-driven). Host pumps if no mgr supplied.
    this.mgr?.update(dt);
  }

  syncSkinning(): void {
    const obj = this.root as unknown as THREE.Object3D;
    // The host already wrote position/rotation/scale into the ECS SoA and
    // renderSyncSystem applied them to the root's LOCAL transform; propagate to
    // world matrices now so the bones' matrixWorld is current...
    obj.updateMatrixWorld(true);
    // ...then recompute each shared-skeleton bone-matrix texture. three's WebGPU
    // backend skips this for the rig's secondary skinned meshes when the root is
    // externally driven, which is what makes the arms detach under translation.
    obj.traverse((o) => {
      const sm = o as unknown as { isSkinnedMesh?: boolean; skeleton?: { update(): void } };
      if (sm.isSkinnedMesh === true && sm.skeleton !== undefined) sm.skeleton.update();
    });
  }
}

/** Load a rigged glTF character and wrap it as a render-only stand-in for a capsule.
 *  Adds the model to the scene (via three.loadGLTF), auto-fits its scale/foot height,
 *  and starts it in the idle clip. The host drives it each render frame with
 *  setPose(footPos, yaw) + setLocomotion(state, dt). */
export async function attachCharacterModel(opts: AttachCharacterModelOptions): Promise<CharacterModel> {
  const assetId = opts.assetId ?? DEFAULT_ASSET;
  const clips: LocomotionClips = { ...DEFAULT_CLIPS, ...opts.clips };
  const forwardOffset = opts.forwardOffset ?? 0;
  const crossfadeMs = opts.crossfadeMs ?? DEFAULT_CROSSFADE_MS;
  const initial = opts.position ?? [0, 0, 0];

  // Load through the SKILL so the model becomes a real ECS renderable + entity the
  // animation.* skills can resolve (entity.mesh = the glTF root carrying .animations).
  const res = await opts.registry.invoke("three.loadGLTF", { assetId, position: [initial[0], initial[1], initial[2]] }, opts.base);
  if (!res.success) throw new Error("attachCharacterModel: three.loadGLTF failed: " + JSON.stringify(res.error));
  const { entity } = res.result as { entity: string };
  const entry = opts.world.entities.resolve(entity);
  if (entry === undefined || entry.mesh === undefined) throw new Error("attachCharacterModel: loaded entity has no mesh");
  const root = entry.mesh as SceneObject;
  const eid = entry.eid;

  // A SkinnedMesh's bind-pose bounding sphere is wrong once it animates/moves, so leave
  // frustum culling off for the rig (it can otherwise vanish when partly off-screen).
  (root as unknown as THREE.Object3D).traverse((o) => {
    const sm = o as unknown as { isSkinnedMesh?: boolean; frustumCulled?: boolean };
    if (sm.isSkinnedMesh === true) sm.frustumCulled = false;
  });

  // Auto-fit scale + foot height from the model's local bounds.
  const { minY, height } = localBounds(root);
  const scale = opts.scale ?? (DEFAULT_TARGET_HEIGHT / height);
  // After scaling, the model's lowest point sits at (root.y + minY*scale); place the
  // root so that lands on footPos.y, plus an optional manual nudge.
  const footYOffset = -minY * scale + (opts.footOffset ?? 0);

  const model = new RiggedCharacterModel({
    entity, eid, root, scale, footYOffset,
    registry: opts.registry, base: opts.base, mgr: opts.animationManager,
    clips, forwardOffset, crossfadeMs,
  });

  // Place + start idle immediately so frame 0 already shows a posed, animating model.
  model.setPose(initial, 0);
  model.setLocomotion("idle", 0);
  return model;
}
