// Task #78 — PLACED-ENTITY residency streaming for the LIVE viewport (runLive).
//
// THE VIEW/RECORD SPLIT (same determinism contract as terrain/stream-client.ts):
//   • RECORDED entity state = the asset.place / scene.createEntity commands in the
//     world log. Those allocate EntityTable ids ("ent_N", sequential), bitECS eids
//     and physics body ids on EVERY host that authors the log — the counters are
//     the id-determinism spine, and this module NEVER touches them. At boot/reboot
//     runLive applies ALL commands exactly as before, so every id is canonical.
//   • THIS module is pure VIEW/RESIDENCY state: which placed entities the LOCAL
//     camera is close enough to that their meshes should be IN the scene graph.
//     De-materializing an entity DETACHES its (retained) three.js object from its
//     parent; the EntityTable entry, the ECS slot + SoA transform, the renderables
//     binding, the SAB/interpolation slot and every collider stay EXACTLY as
//     authored. Re-materializing re-attaches the SAME object — same entity id,
//     same eid, same mesh identity, byte-identical transform. Nothing is recorded,
//     nothing replays differently, two clients can look at different windows over
//     the same world.
//
// WHAT THIS BOUNDS (and what it does NOT):
//   • BOUNDS the per-frame RENDER cost of placed content: scene-graph traversal,
//     frustum/material/draw work and the editor's scene-children raycasts scale
//     with the RESIDENT set (the distance window), not the world's total.
//   • Does NOT free the 16384 MAX_ENTITIES slots: the table slot / eid / SAB lane
//     stay occupied so ids stay deterministic. True slot recycling needs an
//     id-remapping design (future work — see the task notes); the practical wall
//     is render cost long before 16k static props.
//   • Does NOT touch physics: placed props are BODILESS entities (their static box
//     collider is unbound, asset.ts) — they cost no per-tick physics sync anywhere
//     (worldlog syncAllBodies skips bodyId===undefined; the render thread never
//     steps physics; the sim worker is the authoritative side and stays fully
//     resident, like the server).
//
// PROTECTED entities are never de-materialized (and a protected dormant entity is
// pulled back in): the injected predicate covers body-bound/behavior-driven
// entities and the editor's current selection (the gizmo must not lose its
// target). BUDGETED: at most `maxOpsPerUpdate` de/re-materializations per update
// (default 4) so a teleport amortizes across frames instead of hitching; loads
// drain NEAREST-first, unloads FARTHEST-first, ties broken by registration order
// (entity creation order) so the same anchor path always produces the same
// sequence. Gated headlessly in js/test/p_entity_stream.ts.

import type { EntityTable } from "../engine.ts";
import { Position } from "../ecs/world.ts";

export interface EntityStreamOptions {
  /** Re-materialize when the anchor is within this many METERS (XZ). */
  radiusM: number;
  /** De-materialize only beyond radiusM + hysteresisM (anti-thrash band). Default 50. */
  hysteresisM?: number;
  /** Max de/re-materializations per update() call. Default 4. */
  maxOpsPerUpdate?: number;
  /** World position of a registered entity — undefined drops it from tracking
   *  (the entity was destroyed). */
  getPosition(id: string): readonly [number, number, number] | undefined;
  /** Never de-materialize (and re-materialize if dormant): the player/body-bound/
   *  behavior-driven entities + the editor selection. */
  isProtected?(id: string): boolean;
  /** Detach the entity's retained scene object. Return false when the entity
   *  cannot be streamed (no mesh / no parent) — it is dropped from tracking. */
  dematerialize(id: string): boolean;
  /** Re-attach the retained scene object (same Object3D, same parent). */
  rematerialize(id: string): void;
}

export interface EntityStreamUpdate {
  /** Entities de-materialized THIS update. */
  dematerialized: number;
  /** Entities re-materialized THIS update. */
  rematerialized: number;
  /** Tracked entities currently materialized (in the scene graph). */
  resident: number;
  /** Tracked entities currently dormant (retained, detached). */
  dormant: number;
}

interface Record_ {
  seq: number;
  dormant: boolean;
}

export class EntityResidencyStream {
  private readonly opts: EntityStreamOptions;
  private readonly budget: number;
  private readonly hysteresis: number;
  private readonly records = new Map<string, Record_>();
  private seq = 0;
  private dormantN = 0;

  constructor(opts: EntityStreamOptions) {
    if (!(opts.radiusM > 0)) throw new Error(`EntityResidencyStream: radiusM must be > 0 (got ${opts.radiusM})`);
    this.opts = opts;
    this.hysteresis = opts.hysteresisM ?? 50;
    if (!(this.hysteresis >= 0)) throw new Error(`EntityResidencyStream: hysteresisM must be >= 0 (got ${this.hysteresis})`);
    this.budget = Math.max(1, Math.floor(opts.maxOpsPerUpdate ?? 4));
  }

  /** Track an entity. It is assumed MATERIALIZED right now (authoring just mounted it). */
  register(id: string): void {
    if (this.records.has(id)) return;
    this.records.set(id, { seq: this.seq++, dormant: false });
  }

  /** Stop tracking. A dormant entity is re-materialized FIRST so the caller's normal
   *  teardown (scene.destroyEntity → teardownEntity → scene.remove) stays byte-identical
   *  to the never-streamed path. */
  unregister(id: string): void {
    const rec = this.records.get(id);
    if (rec === undefined) return;
    if (rec.dormant) {
      this.opts.rematerialize(id);
      this.dormantN--;
    }
    this.records.delete(id);
  }

  has(id: string): boolean {
    return this.records.has(id);
  }

  isDormant(id: string): boolean {
    return this.records.get(id)?.dormant === true;
  }

  /** Immediate, budget-exempt re-materialization (the editor-selection hook: the
   *  selection guard would deselect a still-dormant mesh before the next update). */
  forceMaterialize(id: string): void {
    const rec = this.records.get(id);
    if (rec === undefined || !rec.dormant) return;
    this.opts.rematerialize(id);
    rec.dormant = false;
    this.dormantN--;
  }

  residentCount(): number {
    return this.records.size - this.dormantN;
  }

  dormantCount(): number {
    return this.dormantN;
  }

  size(): number {
    return this.records.size;
  }

  /** Restore every dormant object before world teardown, then release tracking. */
  clear(): void {
    const errors: unknown[] = [];
    for (const [id, record] of this.records) {
      if (!record.dormant) continue;
      try { this.opts.rematerialize(id); }
      catch (error) { errors.push(error); }
    }
    this.records.clear();
    this.dormantN = 0;
    if (errors.length > 0) throw new AggregateError(errors, `failed to rematerialize ${errors.length} dormant entities during teardown`);
  }

  /** Advance to a new anchor WORLD position (the camera), applying the residency
   *  diff within the per-update budget. Pure math + the injected callbacks. */
  update(anchorX: number, anchorZ: number): EntityStreamUpdate {
    const r2 = this.opts.radiusM * this.opts.radiusM;
    const keep = this.opts.radiusM + this.hysteresis;
    const keep2 = keep * keep;
    const prot = this.opts.isProtected;
    // Forced loads (protected while dormant) are drained ahead of everything.
    const forced: string[] = [];
    const loads: { id: string; d2: number; seq: number }[] = [];
    const unloads: { id: string; d2: number; seq: number }[] = [];
    const dead: string[] = [];
    for (const [id, rec] of this.records) {
      const pos = this.opts.getPosition(id);
      if (pos === undefined) {
        dead.push(id);
        continue;
      }
      const isProt = prot !== undefined && prot(id);
      const dx = pos[0] - anchorX;
      const dz = pos[2] - anchorZ;
      const d2 = dx * dx + dz * dz;
      if (rec.dormant) {
        if (isProt) forced.push(id);
        else if (d2 <= r2) loads.push({ id, d2, seq: rec.seq });
      } else if (!isProt && d2 > keep2) {
        unloads.push({ id, d2, seq: rec.seq });
      }
    }
    for (const id of dead) {
      const rec = this.records.get(id);
      if (rec !== undefined && rec.dormant) this.dormantN--;
      this.records.delete(id);
    }
    // Deterministic drain order: nearest-first loads (content under the camera
    // first), farthest-first unloads, registration order as the tie-break.
    loads.sort((a, b) => (a.d2 - b.d2) || (a.seq - b.seq));
    unloads.sort((a, b) => (b.d2 - a.d2) || (a.seq - b.seq));
    let ops = 0;
    let rematerialized = 0;
    let dematerialized = 0;
    for (const id of forced) {
      if (ops >= this.budget) break;
      this.opts.rematerialize(id);
      this.records.get(id)!.dormant = false;
      this.dormantN--;
      rematerialized++;
      ops++;
    }
    for (const { id } of loads) {
      if (ops >= this.budget) break;
      this.opts.rematerialize(id);
      this.records.get(id)!.dormant = false;
      this.dormantN--;
      rematerialized++;
      ops++;
    }
    for (const { id } of unloads) {
      if (ops >= this.budget) break;
      if (this.opts.dematerialize(id)) {
        this.records.get(id)!.dormant = true;
        this.dormantN++;
        dematerialized++;
        ops++;
      } else {
        // Unstreamable (no mesh/parent) — stop tracking rather than retrying forever.
        this.records.delete(id);
      }
    }
    return {
      dematerialized,
      rematerialized,
      resident: this.records.size - this.dormantN,
      dormant: this.dormantN,
    };
  }
}

// ── The SHARED wiring (browser-entry AND the headless gate use this — no forked policy) ──────

/** Minimal EntityEntry surface the wiring reads (matches engine.ts EntityEntry). */
interface EntryLike {
  eid: number;
  mesh?: unknown;
  bodyId?: number;
  behavior?: unknown;
}
interface SceneParentLike {
  add(o: unknown): void;
  remove(o: unknown): void;
}

/** ELIGIBILITY: only bodiless, behavior-free entities WITH a mesh are streamed —
 *  exactly the asset.place/asset.scatter placed-prop class. Body-bound entities
 *  (player capsule, NPCs, scene.createEntity primitives) are worker-pose-synced
 *  and stay resident; behavior-driven entities may act off-screen. */
export function entityStreamEligible(entry: EntryLike | undefined): boolean {
  return entry !== undefined && entry.mesh !== undefined && entry.bodyId === undefined && entry.behavior === undefined;
}

export interface EntityResidencyWiring {
  eligible(id: string): boolean;
  getPosition(id: string): readonly [number, number, number] | undefined;
  isProtected(id: string): boolean;
  dematerialize(id: string): boolean;
  rematerialize(id: string): void;
}

/** Build the standard callbacks over an EntityTable + the live Position SoA.
 *  De-materialize detaches the RETAINED mesh from its current three parent
 *  (recorded per entity, so nested/parented meshes go back where they came from);
 *  re-materialize re-attaches the SAME object. Because the Object3D, the
 *  renderables[eid] binding and the SoA slot are all retained, DORMANT EDITS need
 *  no special path: three.setMaterial mutates entry.mesh's materials directly and
 *  scene.moveEntity/ecs.updateComponent write the SoA that renderSyncSystem keeps
 *  copying onto the (detached) object every frame — on re-attach the mesh is
 *  already current. `protectedIds` is the live extra-protection set (selection). */
export function createEntityResidencyWiring(entities: EntityTable, protectedIds: ReadonlySet<string>): EntityResidencyWiring {
  const dormantParents = new Map<string, SceneParentLike>();
  return {
    eligible: (id) => entityStreamEligible(entities.resolve(id)),
    getPosition: (id) => {
      const entry = entities.resolve(id);
      if (entry === undefined || entry.mesh === undefined) return undefined;
      return [Position.x[entry.eid], Position.y[entry.eid], Position.z[entry.eid]];
    },
    isProtected: (id) => {
      if (protectedIds.has(id)) return true;
      const entry = entities.resolve(id);
      // An entry that grew a body or behavior since registration is protected too.
      return entry === undefined || entry.bodyId !== undefined || entry.behavior !== undefined;
    },
    dematerialize: (id) => {
      const mesh = entities.resolve(id)?.mesh as { parent?: SceneParentLike | null } | undefined;
      const parent = mesh?.parent;
      if (mesh === undefined || parent === undefined || parent === null) return false;
      parent.remove(mesh);
      dormantParents.set(id, parent);
      return true;
    },
    rematerialize: (id) => {
      const mesh = entities.resolve(id)?.mesh;
      const parent = dormantParents.get(id);
      dormantParents.delete(id);
      if (mesh !== undefined && parent !== undefined) parent.add(mesh);
    },
  };
}
