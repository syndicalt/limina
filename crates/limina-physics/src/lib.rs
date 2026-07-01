//! limina-physics - native Rapier integration exposed to JS via `#[op2]` ops.
//!
//! The `PhysicsWorld` (pipeline + sets) lives in `OpState`; JS drives it through
//! ops. Body handles cross the boundary as raw `u32` ids indexing a per-world
//! `Vec<Option<RigidBodyHandle>>` (engine-internal ids; opaque agent ids come
//! at the Phase 1 registry). Ids are stable: removing a body tombstones its slot
//! (`None`) rather than shifting later ids. Scene queries (raycast) build a
//! transient `QueryPipeline` from the broad-phase BVH on demand.

use deno_core::{extension, op2, OpState};
use deno_error::JsErrorBox;
use rapier3d::control::{CharacterAutostep, CharacterLength, KinematicCharacterController};
use rapier3d::geometry::Array2;
use rapier3d::prelude::*;
use std::collections::HashMap;
use std::sync::mpsc::{channel, Receiver, Sender};

struct PhysicsWorld {
    gravity: Vector,
    integration_parameters: IntegrationParameters,
    pipeline: PhysicsPipeline,
    islands: IslandManager,
    broad_phase: BroadPhaseBvh,
    narrow_phase: NarrowPhase,
    bodies: RigidBodySet,
    colliders: ColliderSet,
    impulse_joints: ImpulseJointSet,
    multibody_joints: MultibodyJointSet,
    ccd_solver: CCDSolver,
    collision_send: Sender<CollisionEvent>,
    collision_recv: Receiver<CollisionEvent>,
    /// `bodyId` -> handle; `None` is a tombstone for a removed body (ids never shift).
    handles: Vec<Option<RigidBodyHandle>>,
}

/// Narrow-phase contact geometry for a `Started` event, resolved against the real
/// Rapier manifold. `normal` points from `b1`'s body toward `b2`.
struct StartedContact {
    b1: u32,
    b2: u32,
    point: Option<[f32; 3]>,
    normal: Option<[f32; 3]>,
}

impl PhysicsWorld {
    fn new(gravity_y: f32) -> Self {
        let (collision_send, collision_recv) = channel();
        Self {
            gravity: Vector::new(0.0, gravity_y, 0.0),
            integration_parameters: IntegrationParameters::default(),
            pipeline: PhysicsPipeline::new(),
            islands: IslandManager::new(),
            broad_phase: BroadPhaseBvh::new(),
            narrow_phase: NarrowPhase::new(),
            bodies: RigidBodySet::new(),
            colliders: ColliderSet::new(),
            impulse_joints: ImpulseJointSet::new(),
            multibody_joints: MultibodyJointSet::new(),
            ccd_solver: CCDSolver::new(),
            collision_send,
            collision_recv,
            handles: Vec::new(),
        }
    }

    fn step(&mut self) {
        let (contact_force_send, _contact_force_recv) = channel();
        let events = ChannelEventCollector::new(self.collision_send.clone(), contact_force_send);
        self.pipeline.step(
            self.gravity,
            &self.integration_parameters,
            &mut self.islands,
            &mut self.broad_phase,
            &mut self.narrow_phase,
            &mut self.bodies,
            &mut self.colliders,
            &mut self.impulse_joints,
            &mut self.multibody_joints,
            &mut self.ccd_solver,
            &(),
            &events,
        );
    }

    fn handle(&self, id: u32) -> Option<RigidBodyHandle> {
        self.handles.get(id as usize).copied().flatten()
    }

    fn insert_body(&mut self, body: RigidBody, collider: Collider) -> u32 {
        let handle = self.bodies.insert(body);
        self.colliders
            .insert_with_parent(collider, handle, &mut self.bodies);
        let id = self.handles.len() as u32;
        self.handles.push(Some(handle));
        id
    }

    fn body_id_for_handle(&self, handle: RigidBodyHandle) -> Option<u32> {
        self.handles
            .iter()
            .position(|slot| *slot == Some(handle))
            .map(|id| id as u32)
    }

    fn body_id_for_collider(&self, handle: ColliderHandle) -> Option<u32> {
        self.colliders
            .get(handle)
            .and_then(|collider| collider.parent())
            .and_then(|body| self.body_id_for_handle(body))
    }

    /// Resolve the real narrow-phase contact geometry for a `Started` event between
    /// two colliders. Returns the bodies plus the world-space contact point and
    /// normal taken from the deepest manifold contact. Geometry is `None` only when
    /// no live manifold exists this step (the contact already separated); it is
    /// never fabricated. The returned `normal` points from `b1`'s body toward `b2`.
    fn started_contact(&self, c1: ColliderHandle, c2: ColliderHandle) -> Option<StartedContact> {
        if let Some(pair) = self.narrow_phase.contact_pair(c1, c2) {
            if let Some((manifold, contact)) = pair.find_deepest_contact() {
                let b1 = self.body_id_for_collider(pair.collider1)?;
                let b2 = self.body_id_for_collider(pair.collider2)?;
                let n = manifold.data.normal;
                let point = match (
                    self.colliders.get(pair.collider1),
                    self.colliders.get(pair.collider2),
                ) {
                    (Some(col1), Some(col2)) => {
                        // `local_p1`/`local_p2` live in each collider's local frame; lift
                        // both to world space and average to get the contact interface.
                        let w1 = col1.position().transform_point(contact.local_p1);
                        let w2 = col2.position().transform_point(contact.local_p2);
                        let mid = (w1 + w2) * 0.5;
                        Some([mid.x, mid.y, mid.z])
                    }
                    _ => None,
                };
                return Some(StartedContact {
                    b1,
                    b2,
                    point,
                    normal: Some([n.x, n.y, n.z]),
                });
            }
        }
        // No live manifold this step: still report the bodies, omit geometry.
        let b1 = self.body_id_for_collider(c1)?;
        let b2 = self.body_id_for_collider(c2)?;
        Some(StartedContact {
            b1,
            b2,
            point: None,
            normal: None,
        })
    }
}

fn material(builder: ColliderBuilder, friction: f32, restitution: f32) -> ColliderBuilder {
    builder
        .friction(friction)
        .restitution(restitution)
        .active_events(ActiveEvents::COLLISION_EVENTS)
}

/// Serializable, replay-complete capture of the dynamics state. Bundles every
/// rapier set whose contents affect a future step (bodies w/ velocities + sleep,
/// colliders, joints, the warm-started narrow-phase contact graph, the
/// broad-phase BVH, and island membership) PLUS the id->handle slotmap so body
/// ids stay stable across a restore. The pipeline, CCD solver, and event channel
/// are transient scratch -- they are reconstructed on restore, never serialized.
/// f32 round-trips bit-exact through bincode, so a restored world steps
/// identically to one that never stopped (the M2 mid-stream resume guarantee).
#[derive(serde::Serialize, serde::Deserialize)]
struct PhysicsSnapshot {
    gravity: [f32; 3],
    integration_parameters: IntegrationParameters,
    islands: IslandManager,
    broad_phase: BroadPhaseBvh,
    narrow_phase: NarrowPhase,
    bodies: RigidBodySet,
    colliders: ColliderSet,
    impulse_joints: ImpulseJointSet,
    multibody_joints: MultibodyJointSet,
    handles: Vec<Option<RigidBodyHandle>>,
}

/// (Re)create the physics world with the given gravity (replaces any existing).
#[op2(fast)]
pub fn op_physics_create_world(state: &mut OpState, gravity_y: f32) {
    state.put(PhysicsWorld::new(gravity_y));
}

/// Add a large static ground whose top surface sits at `y`.
#[op2(fast)]
pub fn op_physics_add_ground(state: &mut OpState, y: f32) {
    let world = state.borrow_mut::<PhysicsWorld>();
    let collider = ColliderBuilder::cuboid(100.0, 0.5, 100.0)
        .translation(Vector::new(0.0, y - 0.5, 0.0))
        .build();
    world.colliders.insert(collider);
}

/// Add a dynamic cube of the given half-extent at (x, y, z). Returns its id.
#[op2(fast)]
pub fn op_physics_add_box(state: &mut OpState, x: f32, y: f32, z: f32, half: f32) -> u32 {
    let world = state.borrow_mut::<PhysicsWorld>();
    let body = RigidBodyBuilder::dynamic()
        .translation(Vector::new(x, y, z))
        .build();
    let collider = ColliderBuilder::cuboid(half, half, half)
        .active_events(ActiveEvents::COLLISION_EVENTS)
        .build();
    world.insert_body(body, collider)
}

/// Add a dynamic cube with material parameters. Keeps `op_physics_add_box` arity stable.
#[op2(fast)]
#[allow(clippy::too_many_arguments)]
pub fn op_physics_add_box_material(
    state: &mut OpState,
    x: f32,
    y: f32,
    z: f32,
    half: f32,
    friction: f32,
    restitution: f32,
) -> u32 {
    let world = state.borrow_mut::<PhysicsWorld>();
    let body = RigidBodyBuilder::dynamic()
        .translation(Vector::new(x, y, z))
        .build();
    let collider = material(
        ColliderBuilder::cuboid(half, half, half),
        friction,
        restitution,
    )
    .build();
    world.insert_body(body, collider)
}

/// Add a dynamic sphere with material parameters. Returns its stable body id.
#[op2(fast)]
pub fn op_physics_add_sphere(
    state: &mut OpState,
    x: f32,
    y: f32,
    z: f32,
    radius: f32,
    friction: f32,
    restitution: f32,
) -> u32 {
    let world = state.borrow_mut::<PhysicsWorld>();
    let body = RigidBodyBuilder::dynamic()
        .translation(Vector::new(x, y, z))
        .build();
    let collider = material(ColliderBuilder::ball(radius), friction, restitution).build();
    world.insert_body(body, collider)
}

/// Add a dynamic Y-axis capsule. `half_height` is the cylindrical half-height.
#[op2(fast)]
#[allow(clippy::too_many_arguments)]
pub fn op_physics_add_capsule(
    state: &mut OpState,
    x: f32,
    y: f32,
    z: f32,
    half_height: f32,
    radius: f32,
    friction: f32,
    restitution: f32,
) -> u32 {
    let world = state.borrow_mut::<PhysicsWorld>();
    let body = RigidBodyBuilder::dynamic()
        .translation(Vector::new(x, y, z))
        .build();
    let collider = material(
        ColliderBuilder::capsule_y(half_height, radius),
        friction,
        restitution,
    )
    .build();
    world.insert_body(body, collider)
}

/// Add a fixed cuboid rigid body with material parameters. Returns its stable body id.
#[op2(fast)]
#[allow(clippy::too_many_arguments)]
pub fn op_physics_add_static_box(
    state: &mut OpState,
    x: f32,
    y: f32,
    z: f32,
    hx: f32,
    hy: f32,
    hz: f32,
    friction: f32,
    restitution: f32,
) -> u32 {
    let world = state.borrow_mut::<PhysicsWorld>();
    let body = RigidBodyBuilder::fixed()
        .translation(Vector::new(x, y, z))
        .build();
    let collider = material(ColliderBuilder::cuboid(hx, hy, hz), friction, restitution).build();
    world.insert_body(body, collider)
}

/// Add a fixed sphere rigid body with material parameters. Returns its stable body id.
#[op2(fast)]
pub fn op_physics_add_static_sphere(
    state: &mut OpState,
    x: f32,
    y: f32,
    z: f32,
    radius: f32,
    friction: f32,
    restitution: f32,
) -> u32 {
    let world = state.borrow_mut::<PhysicsWorld>();
    let body = RigidBodyBuilder::fixed()
        .translation(Vector::new(x, y, z))
        .build();
    let collider = material(ColliderBuilder::ball(radius), friction, restitution).build();
    world.insert_body(body, collider)
}

/// Add a fixed Y-axis capsule rigid body. `half_height` is the cylindrical half-height.
#[op2(fast)]
#[allow(clippy::too_many_arguments)]
pub fn op_physics_add_static_capsule(
    state: &mut OpState,
    x: f32,
    y: f32,
    z: f32,
    half_height: f32,
    radius: f32,
    friction: f32,
    restitution: f32,
) -> u32 {
    let world = state.borrow_mut::<PhysicsWorld>();
    let body = RigidBodyBuilder::fixed()
        .translation(Vector::new(x, y, z))
        .build();
    let collider = material(
        ColliderBuilder::capsule_y(half_height, radius),
        friction,
        restitution,
    )
    .build();
    world.insert_body(body, collider)
}

/// Add a fixed HEIGHTFIELD collider (Phase 9 terrain). `heights` is an
/// `nrows`×`ncols` grid of elevation samples in ROW-MAJOR order from JS
/// (`index = row*ncols + col`); the field spans `scale_x` × `scale_z` world units
/// centered at (x, y, z), with sample heights multiplied by `scale_y`. Returns its
/// stable body id (removable for streaming). Deterministic: identical `heights`
/// build a bit-identical collider, so a body resting on it replays exactly — the
/// terrain tile is reproduced from the cache on replay, never re-generated.
#[op2(fast)]
#[allow(clippy::too_many_arguments)]
pub fn op_physics_add_heightfield(
    state: &mut OpState,
    x: f32,
    y: f32,
    z: f32,
    nrows: u32,
    ncols: u32,
    scale_x: f32,
    scale_y: f32,
    scale_z: f32,
    #[buffer] heights: &[f32],
) -> u32 {
    let world = state.borrow_mut::<PhysicsWorld>();
    let nr = nrows as usize;
    let nc = ncols as usize;
    // Rapier's heightfield matrix is `heights_zx` (rows -> local z, cols -> local x);
    // JS sends row-major `index = row*ncols + col` (out-of-range samples read 0).
    let mat = Array2::from_fn(nr, nc, |r, c| heights.get(r * nc + c).copied().unwrap_or(0.0));
    let body = RigidBodyBuilder::fixed()
        .translation(Vector::new(x, y, z))
        .build();
    let collider = ColliderBuilder::heightfield(mat, Vector::new(scale_x, scale_y, scale_z)).build();
    world.insert_body(body, collider)
}

/// Add a KINEMATIC position-based Y-axis capsule for use as a character controller
/// body (Phase 12). `half_height` is the cylindrical half-height (excludes the
/// radius caps). The body is driven exclusively by `op_physics_move_character`
/// (it is unaffected by gravity/forces and acts as an obstacle to dynamic bodies).
/// Returns its stable body id.
#[op2(fast)]
pub fn op_physics_add_character(
    state: &mut OpState,
    x: f32,
    y: f32,
    z: f32,
    half_height: f32,
    radius: f32,
) -> u32 {
    let world = state.borrow_mut::<PhysicsWorld>();
    let body = RigidBodyBuilder::kinematic_position_based()
        .translation(Vector::new(x, y, z))
        .build();
    let collider = ColliderBuilder::capsule_y(half_height, radius)
        .active_events(ActiveEvents::COLLISION_EVENTS)
        .build();
    world.insert_body(body, collider)
}

/// Move a character body (created by `op_physics_add_character`) by a desired
/// translation, resolving it against the world via Rapier's
/// `KinematicCharacterController` (slide, slope limit, autostep, snap-to-ground).
/// This computes the collision-free movement and queues it as the body's next
/// kinematic translation; the motion is applied on the following `op_physics_step`.
/// Writes `out = [newX, newY, newZ, grounded(1/0)]`. Deterministic: identical
/// world state + desired translation produce a bit-identical correction. The
/// world log records the SCALAR inputs (id, dx, dy, dz) of each call (the out
/// buffer carries no input); on replay `move_shape` re-resolves the same
/// correction from the reconstructed world, so a recorded character session
/// replays bit-identically (see js/src/worldlog/log.ts).
#[op2(fast)]
#[allow(clippy::too_many_arguments)]
pub fn op_physics_move_character(
    state: &mut OpState,
    id: u32,
    dx: f32,
    dy: f32,
    dz: f32,
    #[buffer] out: &mut [f32],
) {
    if out.len() < 4 {
        return;
    }
    let world = state.borrow_mut::<PhysicsWorld>();
    let handle = match world.handle(id) {
        Some(h) => h,
        None => return,
    };
    // Phase 1: immutable scene query to compute the collision-free correction.
    let computed = {
        let body = match world.bodies.get(handle) {
            Some(b) => b,
            None => return,
        };
        let collider_handle = match body.colliders().first() {
            Some(c) => *c,
            None => return,
        };
        let collider = match world.colliders.get(collider_handle) {
            Some(c) => c,
            None => return,
        };
        let shape = collider.shape();
        let char_pos = *collider.position();
        let base = body.translation();
        // Query pipeline excludes the character's own body so it doesn't
        // shape-cast against itself.
        let query = world.broad_phase.as_query_pipeline(
            world.narrow_phase.query_dispatcher(),
            &world.bodies,
            &world.colliders,
            QueryFilter::default().exclude_rigid_body(handle),
        );
        let controller = KinematicCharacterController {
            offset: CharacterLength::Absolute(0.02),
            max_slope_climb_angle: 50.0_f32.to_radians(),
            min_slope_slide_angle: 45.0_f32.to_radians(),
            autostep: Some(CharacterAutostep {
                max_height: CharacterLength::Absolute(0.4),
                min_width: CharacterLength::Absolute(0.3),
                include_dynamic_bodies: true,
            }),
            snap_to_ground: Some(CharacterLength::Absolute(0.5)),
            ..Default::default()
        };
        let movement = controller.move_shape(
            world.integration_parameters.dt,
            &query,
            shape,
            &char_pos,
            Vector::new(dx, dy, dz),
            |_| {},
        );
        let t = movement.translation;
        (
            Vector::new(base.x + t.x, base.y + t.y, base.z + t.z),
            movement.grounded,
        )
    };
    // Phase 2: queue the corrected position; applied on the next step.
    if let Some(body) = world.bodies.get_mut(handle) {
        body.set_next_kinematic_translation(computed.0);
    }
    out[0] = computed.0.x;
    out[1] = computed.0.y;
    out[2] = computed.0.z;
    out[3] = if computed.1 { 1.0 } else { 0.0 };
}

/// Remove a body (and its colliders), tombstoning its id slot.
#[op2(fast)]
pub fn op_physics_remove_body(state: &mut OpState, id: u32) {
    let world = state.borrow_mut::<PhysicsWorld>();
    if let Some(handle) = world.handle(id) {
        world.bodies.remove(
            handle,
            &mut world.islands,
            &mut world.colliders,
            &mut world.impulse_joints,
            &mut world.multibody_joints,
            true,
        );
        world.handles[id as usize] = None;
    }
}

/// Apply an impulse to a body, waking it (resting bodies sleep, so wake is required).
#[op2(fast)]
pub fn op_physics_apply_impulse(state: &mut OpState, id: u32, ix: f32, iy: f32, iz: f32) {
    let world = state.borrow_mut::<PhysicsWorld>();
    if let Some(handle) = world.handle(id) {
        if let Some(body) = world.bodies.get_mut(handle) {
            body.apply_impulse(Vector::new(ix, iy, iz), true);
        }
    }
}

/// Advance the simulation by one fixed step (dt = 1/60 by default).
#[op2(fast)]
pub fn op_physics_step(state: &mut OpState) {
    state.borrow_mut::<PhysicsWorld>().step();
}

/// Serialize the full physics world to a bincode blob (a REAL native snapshot:
/// bodies+velocities+sleep, colliders, joints, the warm-started contact graph,
/// the broad-phase BVH, islands, gravity, integration params, and the stable
/// id->handle slotmap). Returned to JS as a `Uint8Array`. Pipeline/CCD/event
/// channel are transient and rebuilt by `op_physics_restore`, never serialized.
#[op2]
#[buffer]
pub fn op_physics_snapshot(state: &mut OpState) -> Result<Vec<u8>, JsErrorBox> {
    let world = state.borrow::<PhysicsWorld>();
    let snapshot = PhysicsSnapshot {
        gravity: [world.gravity.x, world.gravity.y, world.gravity.z],
        integration_parameters: world.integration_parameters,
        islands: world.islands.clone(),
        broad_phase: world.broad_phase.clone(),
        narrow_phase: world.narrow_phase.clone(),
        bodies: world.bodies.clone(),
        colliders: world.colliders.clone(),
        impulse_joints: world.impulse_joints.clone(),
        multibody_joints: world.multibody_joints.clone(),
        handles: world.handles.clone(),
    };
    bincode::serialize(&snapshot).map_err(|e| JsErrorBox::generic(format!("physics snapshot: {e}")))
}

/// Replace the live physics world with one deserialized from an
/// `op_physics_snapshot` blob. Body ids resolve exactly as before the snapshot
/// (the slotmap, including tombstones, is restored). The pipeline, CCD solver,
/// and collision-event channel are reconstructed fresh -- they hold no state
/// that survives a step boundary. Stepping the restored world is bit-identical
/// to having never stopped.
#[op2(fast)]
pub fn op_physics_restore(state: &mut OpState, #[buffer] bytes: &[u8]) -> Result<(), JsErrorBox> {
    let snapshot: PhysicsSnapshot = bincode::deserialize(bytes)
        .map_err(|e| JsErrorBox::generic(format!("physics restore: {e}")))?;
    let (collision_send, collision_recv) = channel();
    state.put(PhysicsWorld {
        gravity: Vector::new(
            snapshot.gravity[0],
            snapshot.gravity[1],
            snapshot.gravity[2],
        ),
        integration_parameters: snapshot.integration_parameters,
        pipeline: PhysicsPipeline::new(),
        islands: snapshot.islands,
        broad_phase: snapshot.broad_phase,
        narrow_phase: snapshot.narrow_phase,
        bodies: snapshot.bodies,
        colliders: snapshot.colliders,
        impulse_joints: snapshot.impulse_joints,
        multibody_joints: snapshot.multibody_joints,
        ccd_solver: CCDSolver::new(),
        collision_send,
        collision_recv,
        handles: snapshot.handles,
    });
    Ok(())
}

/// Write a body's world position into `out[0..3]` (zero-copy).
#[op2(fast)]
pub fn op_physics_body_pos(state: &mut OpState, id: u32, #[buffer] out: &mut [f32]) {
    if out.len() < 3 {
        return;
    }
    let world = state.borrow::<PhysicsWorld>();
    if let Some(handle) = world.handle(id) {
        if let Some(body) = world.bodies.get(handle) {
            let t = body.translation();
            out[0] = t.x;
            out[1] = t.y;
            out[2] = t.z;
        }
    }
}

/// Write `out = [pos.x, pos.y, pos.z, quat.x, quat.y, quat.z, quat.w]`.
#[op2(fast)]
pub fn op_physics_body_transform(state: &mut OpState, id: u32, #[buffer] out: &mut [f32]) {
    if out.len() < 7 {
        return;
    }
    let world = state.borrow::<PhysicsWorld>();
    if let Some(handle) = world.handle(id) {
        if let Some(body) = world.bodies.get(handle) {
            let t = body.translation();
            let r = body.rotation();
            out[0] = t.x;
            out[1] = t.y;
            out[2] = t.z;
            out[3] = r.x;
            out[4] = r.y;
            out[5] = r.z;
            out[6] = r.w;
        }
    }
}

/// A drained collision event. `kind` is 1 for `Started`, 0 for `Stopped`. `point`
/// and `normal` are the world-space contact geometry from the Rapier manifold for
/// `Started` events (and `None` for `Stopped`, or when the contact already
/// separated before draining). `normal` points from body `a` toward body `b`.
#[derive(deno_core::serde::Serialize)]
#[serde(crate = "deno_core::serde")]
pub struct CollisionRecord {
    kind: u32,
    a: u32,
    b: u32,
    point: Option<[f32; 3]>,
    normal: Option<[f32; 3]>,
}

/// Drain collision events, carrying real narrow-phase contact point + normal on
/// `Started` events. `kind` 1=started, 0=stopped; ids are ordered `a <= b`.
#[op2]
#[serde]
pub fn op_physics_drain_collisions(state: &mut OpState) -> Vec<CollisionRecord> {
    let world = state.borrow_mut::<PhysicsWorld>();
    // Drain the channel first so the immutable manifold queries below don't race
    // the receiver borrow.
    let mut raw = Vec::new();
    while let Ok(event) = world.collision_recv.try_recv() {
        raw.push(event);
    }
    let mut events = Vec::with_capacity(raw.len());
    for event in raw {
        match event {
            CollisionEvent::Started(c1, c2, _) => {
                if let Some(sc) = world.started_contact(c1, c2) {
                    // Order ids deterministically (a <= b) and keep `normal` pointing
                    // from `a` toward `b` by flipping it when the ids swap.
                    let (a, b, normal) = if sc.b1 <= sc.b2 {
                        (sc.b1, sc.b2, sc.normal)
                    } else {
                        (sc.b2, sc.b1, sc.normal.map(|n| [-n[0], -n[1], -n[2]]))
                    };
                    events.push(CollisionRecord {
                        kind: 1,
                        a,
                        b,
                        point: sc.point,
                        normal,
                    });
                }
            }
            CollisionEvent::Stopped(c1, c2, _) => {
                if let (Some(body_a), Some(body_b)) = (
                    world.body_id_for_collider(c1),
                    world.body_id_for_collider(c2),
                ) {
                    events.push(CollisionRecord {
                        kind: 0,
                        a: body_a.min(body_b),
                        b: body_a.max(body_b),
                        point: None,
                        normal: None,
                    });
                }
            }
        }
    }
    events
}

/// Cast a ray from (ox,oy,oz) along (dx,dy,dz). Writes
/// `out = [hit(1/0), toi, hitX, hitY, hitZ, bodyId(-1 if none)]`.
#[op2(fast)]
#[allow(clippy::too_many_arguments)]
pub fn op_physics_raycast(
    state: &mut OpState,
    ox: f32,
    oy: f32,
    oz: f32,
    dx: f32,
    dy: f32,
    dz: f32,
    max_toi: f32,
    #[buffer] out: &mut [f32],
) {
    if out.len() < 6 {
        return;
    }
    let world = state.borrow::<PhysicsWorld>();
    let query = world.broad_phase.as_query_pipeline(
        world.narrow_phase.query_dispatcher(),
        &world.bodies,
        &world.colliders,
        QueryFilter::default(),
    );
    let origin = Vector::new(ox, oy, oz);
    let dir = Vector::new(dx, dy, dz);
    let ray = Ray::new(origin, dir);
    match query.cast_ray(&ray, max_toi, true) {
        Some((collider_handle, toi)) => {
            let hit = origin + dir * toi;
            out[0] = 1.0;
            out[1] = toi;
            out[2] = hit.x;
            out[3] = hit.y;
            out[4] = hit.z;
            let body_id = world
                .colliders
                .get(collider_handle)
                .and_then(|c| c.parent())
                .and_then(|bh| world.body_id_for_handle(bh));
            out[5] = body_id.map(|i| i as f32).unwrap_or(-1.0);
        }
        None => {
            out[0] = 0.0;
        }
    }
}

/// Gravity for the default world installed at extension load, before JS calls
/// `op_physics_create_world`. Immaterial to behavior: this world holds no bodies,
/// and `op_physics_create_world`/`op_physics_restore` replace it wholesale.
const DEFAULT_GRAVITY_Y: f32 = -9.81;

/// Registry of INACTIVE physics worlds. The ACTIVE world lives directly in `OpState`
/// as `PhysicsWorld`, so every one of the 22 physics ops keeps operating on it
/// unchanged; activation SWAPS the active world out into this map and the requested
/// one in (an O(1) move, no world data copied). Single-world use keeps `inactive`
/// empty and `active_id` 0, so behavior is byte-identical to before — the native
/// half of the per-world model (mirrors the JS per-world transform store). NOTE: the
/// active binding is process-global; at most one world is ACTIVE at a time, so a
/// multi-world caller activates a world before driving it.
struct PhysicsRegistry {
    inactive: HashMap<u32, PhysicsWorld>,
    active_id: u32,
    next_id: u32,
}

impl PhysicsRegistry {
    fn new() -> Self {
        Self { inactive: HashMap::new(), active_id: 0, next_id: 1 }
    }
}

/// Create a new world (not activated) and return its id. Plain helper so the op and
/// the tests share one implementation.
fn registry_new_world(state: &mut OpState, gravity_y: f32) -> u32 {
    let reg = state.borrow_mut::<PhysicsRegistry>();
    let id = reg.next_id;
    reg.next_id += 1;
    reg.inactive.insert(id, PhysicsWorld::new(gravity_y));
    id
}

/// Swap world `id` in as the ACTIVE world (the target of every other physics op).
/// Returns false if `id` is unknown; already-active returns true. The current active
/// world is moved back into the registry under its id — no state is lost.
fn registry_activate(state: &mut OpState, id: u32) -> bool {
    {
        let reg = state.borrow::<PhysicsRegistry>();
        if reg.active_id == id {
            return true;
        }
        if !reg.inactive.contains_key(&id) {
            return false;
        }
    }
    let incoming = match state.borrow_mut::<PhysicsRegistry>().inactive.remove(&id) {
        Some(world) => world,
        None => return false,
    };
    let outgoing = state.take::<PhysicsWorld>();
    {
        let reg = state.borrow_mut::<PhysicsRegistry>();
        let prev = reg.active_id;
        reg.inactive.insert(prev, outgoing);
        reg.active_id = id;
    }
    state.put(incoming);
    true
}

/// Drop an INACTIVE world (frees its bodies/colliders). Returns false if `id` is the
/// active world (activate another first) or is unknown.
fn registry_drop(state: &mut OpState, id: u32) -> bool {
    let reg = state.borrow_mut::<PhysicsRegistry>();
    if reg.active_id == id {
        return false;
    }
    reg.inactive.remove(&id).is_some()
}

/// Create a NEW physics world with gravity `gravity_y` WITHOUT activating it; returns
/// its id. Pair with `op_physics_activate_world` to drive it. This is what lets more
/// than one independent physics world exist in a single process.
#[op2(fast)]
pub fn op_physics_new_world(state: &mut OpState, gravity_y: f32) -> u32 {
    registry_new_world(state, gravity_y)
}

/// Make world `id` the ACTIVE world every other physics op operates on. Returns false
/// if `id` is unknown (already active returns true).
#[op2(fast)]
pub fn op_physics_activate_world(state: &mut OpState, id: u32) -> bool {
    registry_activate(state, id)
}

/// The currently active world id (0 is the default world installed at load).
#[op2(fast)]
pub fn op_physics_active_world(state: &mut OpState) -> u32 {
    state.borrow::<PhysicsRegistry>().active_id
}

/// Drop an inactive world. Returns false if `id` is active or unknown.
#[op2(fast)]
pub fn op_physics_drop_world(state: &mut OpState, id: u32) -> bool {
    registry_drop(state, id)
}

/// Install a default `PhysicsWorld` in `OpState` at extension load so every
/// physics op finds one even when invoked before `op_physics_create_world`.
/// deno_core panics on `borrow_mut::<T>()` of an absent type, so without this a
/// stray physics op would take down the whole engine (audio/sandbox guard the
/// same hazard with `try_borrow`). Replaced wholesale once JS creates/restores a
/// world, so live behavior is unchanged and determinism is unaffected. Also installs
/// the (initially empty) multi-world registry.
fn init_physics_state(state: &mut OpState) {
    state.put(PhysicsWorld::new(DEFAULT_GRAVITY_Y));
    state.put(PhysicsRegistry::new());
}

extension!(
    limina_physics,
    ops = [
        op_physics_create_world,
        op_physics_add_ground,
        op_physics_add_box,
        op_physics_add_box_material,
        op_physics_add_sphere,
        op_physics_add_capsule,
        op_physics_add_static_box,
        op_physics_add_static_sphere,
        op_physics_add_static_capsule,
        op_physics_add_heightfield,
        op_physics_add_character,
        op_physics_move_character,
        op_physics_remove_body,
        op_physics_apply_impulse,
        op_physics_step,
        op_physics_snapshot,
        op_physics_restore,
        op_physics_body_pos,
        op_physics_body_transform,
        op_physics_drain_collisions,
        op_physics_raycast,
        op_physics_new_world,
        op_physics_activate_world,
        op_physics_active_world,
        op_physics_drop_world,
    ],
    state = |state| {
        init_physics_state(state);
    },
);

#[cfg(test)]
mod tests {
    use super::{
        init_physics_state, registry_activate, registry_drop, registry_new_world, PhysicsRegistry,
        PhysicsWorld, DEFAULT_GRAVITY_Y,
    };
    use deno_core::OpState;
    use rapier3d::prelude::*;

    /// Drop a dynamic unit box from y=10 into the active world and step it `n` times,
    /// returning the resulting y. Mirrors add_box → step → read on whatever world is
    /// currently in `OpState`.
    fn drop_box_steps(state: &mut OpState, n: usize) -> f32 {
        let world = state.borrow_mut::<PhysicsWorld>();
        let body = world.bodies.insert(
            RigidBodyBuilder::dynamic()
                .translation(Vector::new(0.0, 10.0, 0.0))
                .build(),
        );
        let collider = ColliderBuilder::cuboid(0.5, 0.5, 0.5).build();
        world.colliders.insert_with_parent(collider, body, &mut world.bodies);
        for _ in 0..n {
            world.step();
        }
        world.bodies[body].translation().y
    }

    /// Two worlds stepped via activation are INDEPENDENT and each is preserved across
    /// being swapped out and back — the native half of finding #8. Swapping to world 1,
    /// running it, and swapping back must leave world 0 exactly where it was.
    #[test]
    fn worlds_are_independent_across_activation() {
        let mut state = OpState::new(None);
        init_physics_state(&mut state);
        assert_eq!(state.borrow::<PhysicsRegistry>().active_id, 0);

        // World 0: 30 steps of free fall.
        let y0_after30 = drop_box_steps(&mut state, 30);

        // A second, independent world; activate it and step it 5 times only.
        let id1 = registry_new_world(&mut state, DEFAULT_GRAVITY_Y);
        assert!(registry_activate(&mut state, id1));
        assert_eq!(state.borrow::<PhysicsRegistry>().active_id, id1);
        let y1_after5 = drop_box_steps(&mut state, 5);
        assert!(y1_after5 > y0_after30, "world 1 (5 steps) should have fallen less than world 0 (30 steps)");

        // Swap back to world 0: its body must be exactly where 30 steps left it — the
        // registry preserved it untouched while world 1 ran.
        assert!(registry_activate(&mut state, 0));
        let y0_reread = state
            .borrow::<PhysicsWorld>()
            .bodies
            .iter()
            .next()
            .expect("world 0 kept its body")
            .1
            .translation()
            .y;
        assert_eq!(y0_reread, y0_after30, "world 0 changed while world 1 was active — worlds not isolated");

        // Cannot drop the active world; can drop an inactive one.
        assert!(!registry_drop(&mut state, 0), "must refuse to drop the active world");
        assert!(registry_activate(&mut state, id1));
        assert!(registry_drop(&mut state, 0), "world 0 is now inactive and droppable");
        assert!(!registry_activate(&mut state, 0), "dropped world is gone");
    }

    /// Every physics op begins with `state.borrow_mut::<PhysicsWorld>()`. Because
    /// the extension installs a default world at load (`init_physics_state`), that
    /// borrow succeeds — and stepping it — even before `op_physics_create_world`.
    /// Before the fix the borrow of an absent type panicked the engine.
    #[test]
    fn ops_do_not_panic_before_create_world() {
        let mut state = OpState::new(None);
        init_physics_state(&mut state);
        // Mirror `op_physics_step`: borrow the world and step it. Must not panic.
        state.borrow_mut::<PhysicsWorld>().step();
        assert!(state.try_borrow::<PhysicsWorld>().is_some());
    }

    /// create_world -> add_body -> step -> read-transform, exercised through the
    /// same `OpState` + `PhysicsWorld` internals the ops drive. A dynamic box with
    /// no support falls under gravity, so its y strictly decreases.
    #[test]
    fn create_add_step_read_transform() {
        let mut state = OpState::new(None);
        // == op_physics_create_world
        state.put(PhysicsWorld::new(DEFAULT_GRAVITY_Y));

        let world = state.borrow_mut::<PhysicsWorld>();
        // == op_physics_add_box at (0, 10, 0), half-extent 0.5.
        let body = RigidBodyBuilder::dynamic()
            .translation(Vector::new(0.0, 10.0, 0.0))
            .build();
        let collider = ColliderBuilder::cuboid(0.5, 0.5, 0.5).build();
        let id = world.insert_body(body, collider);

        for _ in 0..30 {
            world.step();
        }

        // == op_physics_body_transform: resolve id -> handle -> translation.
        let handle = world.handle(id).expect("body id resolves to a handle");
        let t = world.bodies.get(handle).expect("handle resolves").translation();
        assert!(t.y < 10.0, "box should fall under gravity (y = {})", t.y);
    }
}
