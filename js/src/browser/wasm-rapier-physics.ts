// Phase 8 Mode-B / M1 — the LIVE in-browser physics backend.
//
// `WasmRapierPhysics` implements the engine's `PhysicsOps` surface (engine.ts)
// directly over `@dimforge/rapier3d-compat` (wasm Rapier), in contrast to Mode-A
// (`keyframe-physics.ts`), which replays a recorded transform stream. This adapter
// *simulates*: it owns a real `RAPIER.World`, integrates it at a fixed 1/60 step,
// and answers every physics op against the live solver.
//
// ── Host injection (no bare import) ────────────────────────────────────────────
// The native limina module loader resolves only `file://` specifiers — it cannot
// resolve the bare specifier `@dimforge/rapier3d-compat`. So this module must NOT
// statically import the rapier *value*; it imports rapier only as a TYPE (erased
// at transpile) and the host injects the actual module:
//
//   import RAPIER from "@dimforge/rapier3d-compat";   // browser host / bundler
//   const physics = await WasmRapierPhysics.create(RAPIER);
//   engine.useOps({ ...physics });                    // wire into EngineOps
//
// `create()` awaits `RAPIER.init()` (rapier-compat instantiates its wasm lazily),
// so construction is async — the host must await it before stepping.
//
// ── The async-wasm-init gotcha ─────────────────────────────────────────────────
// rapier-compat's `init()` decodes its inlined wasm and calls the *async*
// `WebAssembly.instantiate(bytes)`. That promise is fulfilled by a V8 background
// compile thread whose completion task a browser's event loop pumps — but the
// native (deno_core) host's loop does not, so `init()` would hang forever there.
// `create()` therefore swaps `WebAssembly.instantiate` for the *synchronous*
// `new Module()` + `new Instance()` path for the duration of `init()` whenever no
// `document` is present (native host, or a Web Worker where sync compile is also
// valid), restoring it afterward. In a real browser main thread (`document`
// present) the native async path is used unchanged.
//
// ── Body-id contract (must match native `limina-physics`) ──────────────────────
//   • a monotonic counter assigns ids 0,1,2,… as bodies are inserted;
//   • `add_ground` is a parent-less collider and consumes NO id;
//   • every `add_*` that creates a rigid body (dynamic, static, heightfield,
//     character) consumes exactly one id;
//   • `remove_body` tombstones the id (frees the slot) — ids are NEVER reused;
//   • `create_world` resets the counter to 0 and clears the slotmap.
// A per-id slotmap (`idToHandle`) maps each stable id to its rapier RigidBodyHandle;
// `handleToId` is the reverse, used to resolve raycast hits and collision pairs.

import type { CollisionEventRecord } from "../engine.ts";

// Type-only import: erased at transpile, so the native loader never tries to
// resolve the bare specifier. `RapierModule` is the rapier-compat namespace shape.
import type * as RAPIER_NS from "@dimforge/rapier3d-compat";
export type RapierModule = typeof RAPIER_NS;
type World = RAPIER_NS.World;
type RigidBody = RAPIER_NS.RigidBody;
type EventQueue = RAPIER_NS.EventQueue;
type KinematicCharacterController = RAPIER_NS.KinematicCharacterController;

type Vec3 = { x: number; y: number; z: number };
const DEG = Math.PI / 180;
const MAX_COLLISION_EVENTS = 4096;

/** Init rapier-compat's wasm, working around the native host's non-pumped async
 *  `WebAssembly.instantiate` (see file header). Browser main thread keeps the
 *  async path; everywhere else uses synchronous compile for the init window. */
async function initRapier(RAPIER: RapierModule): Promise<void> {
  const hasDocument = typeof document !== "undefined";
  if (hasDocument) {
    await RAPIER.init();
    return;
  }
  type WA = {
    instantiate: (src: BufferSource | WebAssembly.Module, imports?: WebAssembly.Imports) => Promise<unknown>;
    Module: new (b: BufferSource) => WebAssembly.Module;
    Instance: new (m: WebAssembly.Module, i?: WebAssembly.Imports) => WebAssembly.Instance;
  };
  const wa = WebAssembly as unknown as WA;
  const original = wa.instantiate;
  wa.instantiate = (src, imports) => {
    if (src instanceof WebAssembly.Module) {
      return Promise.resolve(new wa.Instance(src, imports));
    }
    const mod = new wa.Module(src as BufferSource);
    return Promise.resolve({ instance: new wa.Instance(mod, imports), module: mod });
  };
  try {
    await RAPIER.init();
  } finally {
    wa.instantiate = original;
  }
}

export class WasmRapierPhysics {
  private readonly R: RapierModule;
  private world: World | null = null;
  private events: EventQueue | null = null;
  private controller: KinematicCharacterController | null = null;
  private gravityY = -9.81;
  private disposed = false;

  private nextBodyId = 0;
  /** Stable body id -> rapier RigidBodyHandle. Removed ids are deleted (never reissued). */
  private idToHandle = new Map<number, number>();
  /** rapier RigidBodyHandle -> stable body id (reverse of idToHandle). */
  private handleToId = new Map<number, number>();
  /** Browser/native parity: collisions survive until polled, bounded exactly like
   * the native host instead of Rapier auto-draining them before the next step. */
  private readonly collisionEvents: CollisionEventRecord[] = [];
  private collisionOverflow = 0;

  private constructor(RAPIER: RapierModule) {
    this.R = RAPIER;
  }

  /** Initialize rapier-compat's wasm and build the adapter. The host MUST await
   *  this before issuing any physics op. Pass `gravityY` to create the world
   *  eagerly, or call `op_physics_create_world` later. */
  static async create(RAPIER: RapierModule, opts?: { gravityY?: number }): Promise<WasmRapierPhysics> {
    await initRapier(RAPIER);
    const phys = new WasmRapierPhysics(RAPIER);
    if (opts?.gravityY !== undefined) phys.op_physics_create_world(opts.gravityY);
    return phys;
  }

  // ── internals ────────────────────────────────────────────────────────────────

  private requireWorld(): World {
    if (this.disposed) throw new Error("WasmRapierPhysics: disposed");
    if (this.world === null) throw new Error("WasmRapierPhysics: op before op_physics_create_world");
    return this.world;
  }

  private freeMaybe(value: unknown): void {
    const free = (value as { free?: () => void } | null)?.free;
    if (typeof free === "function") free.call(value);
  }

  private releaseWorldResources(): void {
    this.freeMaybe(this.controller);
    this.freeMaybe(this.events);
    this.freeMaybe(this.world);
    this.controller = null;
    this.events = null;
    this.world = null;
    this.nextBodyId = 0;
    this.idToHandle.clear();
    this.handleToId.clear();
    this.collisionEvents.length = 0;
    this.collisionOverflow = 0;
  }

  /** Resolve a stable id to its live RigidBody, or null for unknown/removed ids. */
  private bodyFor(id: number): RigidBody | null {
    const handle = this.idToHandle.get(id);
    if (handle === undefined || this.world === null) return null;
    return this.world.getRigidBody(handle) ?? null;
  }

  /** Resolve a collider handle to the stable body id of its parent, or undefined
   *  when the collider has no parent body (e.g. the ground). */
  private idForCollider(colliderHandle: number): number | undefined {
    const collider = this.world?.getCollider(colliderHandle);
    const parent = collider?.parent();
    if (!parent) return undefined;
    return this.handleToId.get(parent.handle);
  }

  private collisionRecord(h1: number, h2: number, started: boolean): CollisionEventRecord | null {
    const w = this.world;
    if (w === null) return null;
    const idA = this.idForCollider(h1);
    const idB = this.idForCollider(h2);
    // Parent-less ground contacts are intentionally omitted to match native.
    if (idA === undefined || idB === undefined) return null;
    const a = Math.min(idA, idB);
    const b = Math.max(idA, idB);
    if (!started) return { kind: 0, a, b, point: null, normal: null };
    const swapped = idA > idB;
    let point: [number, number, number] | null = null;
    let normal: [number, number, number] | null = null;
    const c1 = w.getCollider(h1);
    const c2 = w.getCollider(h2);
    if (c1 && c2) {
      w.contactPair(c1, c2, (manifold) => {
        const n = manifold.normal();
        normal = swapped ? [-n.x, -n.y, -n.z] : [n.x, n.y, n.z];
        if (manifold.numSolverContacts() > 0) {
          const p = manifold.solverContactPoint(0);
          point = [p.x, p.y, p.z];
        }
      });
    }
    return { kind: 1, a, b, point, normal };
  }

  private retainStepCollisionEvents(): void {
    const q = this.events;
    if (q === null) return;
    q.drainCollisionEvents((h1, h2, started) => {
      const record = this.collisionRecord(h1, h2, started);
      if (record === null) return;
      if (this.collisionEvents.length < MAX_COLLISION_EVENTS) this.collisionEvents.push(record);
      else this.collisionOverflow = Math.min(0x7fffffff, this.collisionOverflow + 1);
    });
  }

  /** Insert a rigid body + its collider, allocate the next monotonic id, record
   *  the id<->handle mapping, and return the id. */
  private insertBody(rbDesc: RAPIER_NS.RigidBodyDesc, colliderDesc: RAPIER_NS.ColliderDesc): number {
    const w = this.requireWorld();
    const body = w.createRigidBody(rbDesc);
    w.createCollider(colliderDesc, body);
    const id = this.nextBodyId++;
    this.idToHandle.set(id, body.handle);
    this.handleToId.set(body.handle, id);
    return id;
  }

  private makeController(): KinematicCharacterController {
    const w = this.requireWorld();
    const c = w.createCharacterController(0.01);
    c.setSlideEnabled(true);
    c.setMaxSlopeClimbAngle(45 * DEG);
    c.setMinSlopeSlideAngle(30 * DEG);
    c.enableAutostep(0.5, 0.2, true);
    c.enableSnapToGround(0.5);
    c.setApplyImpulsesToDynamicBodies(true);
    return c;
  }

  /** Apply the fixed integration config (1/60 step + native-matching solver
   *  iteration counts) to the current world. */
  private configureWorld(): void {
    const w = this.requireWorld();
    w.timestep = 1 / 60;
    const ip = w.integrationParameters;
    ip.numSolverIterations = 4;
    ip.numInternalPgsIterations = 1;
  }

  // ── PhysicsOps surface ───────────────────────────────────────────────────────

  op_physics_create_world(gravityY: number): void {
    if (this.disposed) throw new Error("WasmRapierPhysics: disposed");
    this.releaseWorldResources();
    this.gravityY = gravityY;
    this.world = new this.R.World({ x: 0, y: gravityY, z: 0 });
    this.configureWorld();
    this.events = new this.R.EventQueue(false);
    this.controller = this.makeController();
    this.nextBodyId = 0;
    this.idToHandle.clear();
    this.handleToId.clear();
  }

  op_physics_add_ground(y: number): void {
    // A parent-less fixed collider — top surface at `y`, so center at y - 0.5.
    // Consumes NO body id (matches native add_ground).
    const w = this.requireWorld();
    w.createCollider(this.R.ColliderDesc.cuboid(1000, 0.5, 1000).setTranslation(0, y - 0.5, 0));
  }

  op_physics_add_box(x: number, y: number, z: number, half: number): number {
    return this.insertBody(
      this.R.RigidBodyDesc.dynamic().setTranslation(x, y, z),
      this.R.ColliderDesc.cuboid(half, half, half).setActiveEvents(this.R.ActiveEvents.COLLISION_EVENTS),
    );
  }

  op_physics_add_box_material(x: number, y: number, z: number, half: number, friction: number, restitution: number): number {
    return this.insertBody(
      this.R.RigidBodyDesc.dynamic().setTranslation(x, y, z),
      this.R.ColliderDesc.cuboid(half, half, half)
        .setFriction(friction).setRestitution(restitution)
        .setActiveEvents(this.R.ActiveEvents.COLLISION_EVENTS),
    );
  }

  op_physics_add_sphere(x: number, y: number, z: number, radius: number, friction: number, restitution: number): number {
    return this.insertBody(
      this.R.RigidBodyDesc.dynamic().setTranslation(x, y, z),
      this.R.ColliderDesc.ball(radius)
        .setFriction(friction).setRestitution(restitution)
        .setActiveEvents(this.R.ActiveEvents.COLLISION_EVENTS),
    );
  }

  op_physics_add_capsule(x: number, y: number, z: number, halfHeight: number, radius: number, friction: number, restitution: number): number {
    return this.insertBody(
      this.R.RigidBodyDesc.dynamic().setTranslation(x, y, z),
      this.R.ColliderDesc.capsule(halfHeight, radius)
        .setFriction(friction).setRestitution(restitution)
        .setActiveEvents(this.R.ActiveEvents.COLLISION_EVENTS),
    );
  }

  op_physics_add_static_box(x: number, y: number, z: number, hx: number, hy: number, hz: number, friction: number, restitution: number): number {
    return this.insertBody(
      this.R.RigidBodyDesc.fixed().setTranslation(x, y, z),
      this.R.ColliderDesc.cuboid(hx, hy, hz)
        .setFriction(friction).setRestitution(restitution)
        .setActiveEvents(this.R.ActiveEvents.COLLISION_EVENTS),
    );
  }

  op_physics_add_static_sphere(x: number, y: number, z: number, radius: number, friction: number, restitution: number): number {
    return this.insertBody(
      this.R.RigidBodyDesc.fixed().setTranslation(x, y, z),
      this.R.ColliderDesc.ball(radius)
        .setFriction(friction).setRestitution(restitution)
        .setActiveEvents(this.R.ActiveEvents.COLLISION_EVENTS),
    );
  }

  op_physics_add_static_capsule(x: number, y: number, z: number, halfHeight: number, radius: number, friction: number, restitution: number): number {
    return this.insertBody(
      this.R.RigidBodyDesc.fixed().setTranslation(x, y, z),
      this.R.ColliderDesc.capsule(halfHeight, radius)
        .setFriction(friction).setRestitution(restitution)
        .setActiveEvents(this.R.ActiveEvents.COLLISION_EVENTS),
    );
  }

  op_physics_add_heightfield(x: number, y: number, z: number, nrows: number, ncols: number, scaleX: number, scaleY: number, scaleZ: number, heights: Float32Array): number {
    // Contract (engine.ts / native): `heights` is an nrows×ncols VERTEX grid in
    // ROW-major order (index = row*ncols + col). rapier-compat's `heightfield`
    // instead takes the CELL counts (it needs (n+1)×(m+1) vertices) as a
    // COLUMN-major matrix — so translate: cells = (nrows-1)×(ncols-1) and
    // transpose row-major → column-major (colMajor[c*nrows + r] = heights[r*ncols + c]).
    const nr = nrows, nc = ncols;
    const colMajor = new Float32Array(nr * nc);
    for (let r = 0; r < nr; r++) {
      for (let c = 0; c < nc; c++) colMajor[c * nr + r] = heights[r * nc + c];
    }
    return this.insertBody(
      this.R.RigidBodyDesc.fixed().setTranslation(x, y, z),
      this.R.ColliderDesc.heightfield(nr - 1, nc - 1, colMajor, { x: scaleX, y: scaleY, z: scaleZ })
        .setActiveEvents(this.R.ActiveEvents.COLLISION_EVENTS),
    );
  }

  op_physics_add_character(x: number, y: number, z: number, halfHeight: number, radius: number): number {
    return this.insertBody(
      this.R.RigidBodyDesc.kinematicPositionBased().setTranslation(x, y, z),
      this.R.ColliderDesc.capsule(halfHeight, radius)
        .setActiveEvents(this.R.ActiveEvents.COLLISION_EVENTS),
    );
  }

  op_physics_move_character(id: number, dx: number, dy: number, dz: number, out: Float32Array): void {
    const body = this.bodyFor(id);
    if (body === null || this.controller === null) {
      // Unknown/removed id: clean no-op. Report what we can (origin, not grounded).
      if (out.length >= 4) { out[0] = 0; out[1] = 0; out[2] = 0; out[3] = 0; }
      return;
    }
    const collider = body.collider(0);
    this.controller.computeColliderMovement(collider, { x: dx, y: dy, z: dz });
    const mv = this.controller.computedMovement();
    const t = body.translation();
    const nx = t.x + mv.x, ny = t.y + mv.y, nz = t.z + mv.z;
    // Queue the corrected position as the body's next kinematic translation —
    // applied on the next op_physics_step.
    body.setNextKinematicTranslation({ x: nx, y: ny, z: nz });
    if (out.length >= 4) {
      out[0] = nx; out[1] = ny; out[2] = nz;
      out[3] = this.controller.computedGrounded() ? 1 : 0;
    }
  }

  op_physics_remove_body(id: number): void {
    const handle = this.idToHandle.get(id);
    if (handle === undefined) return; // unknown/already-removed: clean no-op
    const body = this.world?.getRigidBody(handle);
    if (body) this.world?.removeRigidBody(body); // also removes its colliders
    this.idToHandle.delete(id);
    this.handleToId.delete(handle);
    // nextBodyId is NOT decremented — the id is tombstoned and never reused.
  }

  op_physics_apply_impulse(id: number, ix: number, iy: number, iz: number): void {
    const body = this.bodyFor(id);
    if (body === null) return; // unknown/removed: clean no-op
    body.applyImpulse({ x: ix, y: iy, z: iz }, true);
  }

  setBodyTranslation(id: number, x: number, y: number, z: number): void {
    const body = this.bodyFor(id);
    if (body === null) return;
    body.setTranslation({ x, y, z }, true);
  }

  setBodyRotation(id: number, x: number, y: number, z: number, w: number): void {
    const body = this.bodyFor(id);
    if (body === null) return;
    body.setRotation({ x, y, z, w }, true);
  }

  op_physics_step(): void {
    const w = this.requireWorld();
    w.step(this.events ?? undefined);
    this.retainStepCollisionEvents();
  }

  op_physics_body_transform(id: number, out: Float32Array): void {
    const body = this.bodyFor(id);
    if (body === null) { out.fill(0); return; }
    const t = body.translation();
    const r = body.rotation();
    out[0] = t.x; out[1] = t.y; out[2] = t.z;
    out[3] = r.x; out[4] = r.y; out[5] = r.z; out[6] = r.w;
  }

  op_physics_body_pos(id: number, out: Float32Array): void {
    const body = this.bodyFor(id);
    if (body === null) { out.fill(0); return; }
    const t = body.translation();
    out[0] = t.x; out[1] = t.y; out[2] = t.z;
  }

  /** Re-pose a body's world transform (translation + rotation) by stable id — mirrors the native
   *  host op (crates/limina-physics op_physics_set_body_transform). Used by writeTransformComponent
   *  (ecs.updateComponent / scene.moveEntity / a stamped createMesh's rotation) so the collider
   *  follows and the per-tick body→SoA sync does not snap the entity back. No-op on a non-finite
   *  input or an unknown/removed id; wakes the body so a re-posed fixed/static body takes effect. */
  op_physics_set_body_transform(id: number, x: number, y: number, z: number, qx: number, qy: number, qz: number, qw: number): void {
    if (!(Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z) &&
          Number.isFinite(qx) && Number.isFinite(qy) && Number.isFinite(qz) && Number.isFinite(qw))) return;
    const body = this.bodyFor(id);
    if (body === null) return;
    body.setTranslation({ x, y, z }, true);
    body.setRotation({ x: qx, y: qy, z: qz, w: qw }, true);
  }

  op_physics_drain_collisions(): CollisionEventRecord[] {
    const records = this.collisionEvents.splice(0);
    return records;
  }

  op_physics_take_collision_overflow_count(): number {
    const count = this.collisionOverflow;
    this.collisionOverflow = 0;
    return count;
  }

  op_physics_raycast(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, maxToi: number, out: Float32Array): void {
    // Contract (matches native): out = [hit(1/0), toi, hitX, hitY, hitZ, bodyId(-1)].
    if (out.length < 6) return;
    const w = this.world;
    if (w === null) { out[0] = 0; return; }
    const ray = new this.R.Ray({ x: ox, y: oy, z: oz } as Vec3, { x: dx, y: dy, z: dz } as Vec3);
    const hit = w.castRayAndGetNormal(ray, maxToi, true);
    if (hit === null) { out[0] = 0; return; }
    const toi = hit.timeOfImpact;
    out[0] = 1; out[1] = toi;
    // Hit point: origin + dir * toi (dir NOT normalized — matches native).
    out[2] = ox + dx * toi; out[3] = oy + dy * toi; out[4] = oz + dz * toi;
    const parent = hit.collider.parent();
    const id = parent ? this.handleToId.get(parent.handle) : undefined;
    out[5] = id === undefined ? -1 : id;
  }

  op_physics_overlap_box(x: number, y: number, z: number, hx: number, hy: number, hz: number,
    qx: number, qy: number, qz: number, qw: number, ignoreBodyId: number, out: Uint32Array): number {
    if (![x, y, z, qx, qy, qz, qw].every(Number.isFinite)) throw new Error("box overlap pose values must be finite");
    if (![hx, hy, hz].every((value) => Number.isFinite(value) && value > 0)) throw new Error("box overlap half extents values must be positive");
    const quaternionNormSquared = qx * qx + qy * qy + qz * qz + qw * qw;
    if (!Number.isFinite(quaternionNormSquared) || quaternionNormSquared <= Number.EPSILON * Number.EPSILON) {
      throw new Error("box overlap rotation quaternion must be non-zero");
    }
    const w = this.world;
    if (w === null || out.length === 0) return 0;
    const capacity = Math.min(out.length, 4096);
    const hits = new Set<number>();
    const shape = new this.R.Cuboid(hx, hy, hz);
    w.intersectionsWithShape({ x, y, z }, { x: qx, y: qy, z: qz, w: qw }, shape, (collider) => {
      const parent = collider.parent();
      const id = parent ? this.handleToId.get(parent.handle) : undefined;
      if (id === undefined || id === ignoreBodyId || hits.has(id)) return true;
      if (hits.size < capacity) hits.add(id);
      else {
        let currentMax = -1;
        for (const hit of hits) currentMax = Math.max(currentMax, hit);
        if (id < currentMax) { hits.delete(currentMax); hits.add(id); }
      }
      return true;
    });
    const sorted = [...hits].sort((a, b) => a - b);
    for (let i = 0; i < sorted.length; i++) out[i] = sorted[i]!;
    return sorted.length;
  }

  op_physics_snapshot(): Uint8Array {
    const w = this.requireWorld();
    const rapierBytes = w.takeSnapshot();
    // Wrap the rapier blob with our slotmap so restore() recovers the EXACT
    // id<->handle mapping and the monotonic counter:
    //   [u32 LE metaLen][meta JSON bytes][rapier snapshot bytes]
    const meta = JSON.stringify({
      nextBodyId: this.nextBodyId,
      gravityY: this.gravityY,
      entries: [...this.idToHandle.entries()],
    });
    const metaBytes = new TextEncoder().encode(meta);
    const blob = new Uint8Array(4 + metaBytes.length + rapierBytes.length);
    new DataView(blob.buffer).setUint32(0, metaBytes.length, true);
    blob.set(metaBytes, 4);
    blob.set(rapierBytes, 4 + metaBytes.length);
    return blob;
  }

  op_physics_restore(bytes: Uint8Array): void {
    if (this.disposed) throw new Error("WasmRapierPhysics: disposed");
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const metaLen = dv.getUint32(0, true);
    const metaBytes = bytes.subarray(4, 4 + metaLen);
    const meta = JSON.parse(new TextDecoder().decode(metaBytes)) as {
      nextBodyId: number;
      gravityY: number;
      entries: [number, number][];
    };
    // restoreSnapshot needs a standalone view of just the rapier bytes.
    const rapierBytes = bytes.slice(4 + metaLen);
    const restoredWorld = this.R.World.restoreSnapshot(rapierBytes);
    this.releaseWorldResources();
    this.world = restoredWorld;
    this.gravityY = meta.gravityY;
    this.configureWorld();
    this.events = new this.R.EventQueue(false);
    this.controller = this.makeController();
    this.nextBodyId = meta.nextBodyId;
    this.idToHandle = new Map(meta.entries);
    this.handleToId = new Map(meta.entries.map(([id, handle]) => [handle, id]));
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.releaseWorldResources();
  }
}
