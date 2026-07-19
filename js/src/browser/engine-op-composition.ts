import type { EngineOps } from "../engine.ts";

/** The portable physics authority shared by worker authoring, render-side authoring, and
 * keyframe playback. Keeping this mapping in one module prevents a host from silently acquiring
 * a callable no-op for a newly added mutating physics op. */
export type PhysicsEngineOpName =
  | "op_physics_create_world"
  | "op_physics_add_ground"
  | "op_physics_add_box"
  | "op_physics_add_box_material"
  | "op_physics_add_sphere"
  | "op_physics_add_capsule"
  | "op_physics_add_static_box"
  | "op_physics_add_static_sphere"
  | "op_physics_add_static_capsule"
  | "op_physics_add_heightfield"
  | "op_physics_add_character"
  | "op_physics_move_character"
  | "op_physics_remove_body"
  | "op_physics_apply_impulse"
  | "op_physics_step"
  | "op_physics_snapshot"
  | "op_physics_restore"
  | "op_physics_body_pos"
  | "op_physics_body_transform"
  | "op_physics_set_body_transform"
  | "op_physics_drain_collisions"
  | "op_physics_take_collision_overflow_count"
  | "op_physics_raycast"
  | "op_physics_overlap_box";

export type PhysicsEngineOps = Pick<EngineOps, PhysicsEngineOpName>;
export type NonPhysicsEngineOps = Omit<EngineOps, PhysicsEngineOpName>;

export interface InertEngineOpsOptions {
  readonly readAsset?: (id: string) => Uint8Array;
}

export function bindPhysicsEngineOps(provider: PhysicsEngineOps): PhysicsEngineOps {
  const bound: PhysicsEngineOps = {
    op_physics_create_world: provider.op_physics_create_world.bind(provider),
    op_physics_add_ground: provider.op_physics_add_ground.bind(provider),
    op_physics_add_box: provider.op_physics_add_box.bind(provider),
    op_physics_add_box_material: provider.op_physics_add_box_material.bind(provider),
    op_physics_add_sphere: provider.op_physics_add_sphere.bind(provider),
    op_physics_add_capsule: provider.op_physics_add_capsule.bind(provider),
    op_physics_add_static_box: provider.op_physics_add_static_box.bind(provider),
    op_physics_add_static_sphere: provider.op_physics_add_static_sphere.bind(provider),
    op_physics_add_static_capsule: provider.op_physics_add_static_capsule.bind(provider),
    op_physics_add_heightfield: provider.op_physics_add_heightfield.bind(provider),
    op_physics_add_character: provider.op_physics_add_character.bind(provider),
    op_physics_move_character: provider.op_physics_move_character.bind(provider),
    op_physics_remove_body: provider.op_physics_remove_body.bind(provider),
    op_physics_apply_impulse: provider.op_physics_apply_impulse.bind(provider),
    op_physics_step: provider.op_physics_step.bind(provider),
    op_physics_snapshot: provider.op_physics_snapshot.bind(provider),
    op_physics_restore: provider.op_physics_restore.bind(provider),
    op_physics_body_pos: provider.op_physics_body_pos.bind(provider),
    op_physics_body_transform: provider.op_physics_body_transform.bind(provider),
    op_physics_set_body_transform: provider.op_physics_set_body_transform.bind(provider),
    op_physics_drain_collisions: provider.op_physics_drain_collisions.bind(provider),
    op_physics_raycast: provider.op_physics_raycast.bind(provider),
    op_physics_overlap_box: provider.op_physics_overlap_box.bind(provider),
  };
  if (provider.op_physics_take_collision_overflow_count !== undefined) {
    bound.op_physics_take_collision_overflow_count =
      provider.op_physics_take_collision_overflow_count.bind(provider);
  }
  return bound;
}

export function inertNonPhysicsEngineOps(options: InertEngineOpsOptions = {}): NonPhysicsEngineOps {
  const noop = (): void => {};
  return {
    op_create_window_context: () => ({}),
    op_surface_present: noop,
    op_surface_resize: noop,
    op_set_frame_callback: noop,
    op_set_fixed_step_callback: noop,
    op_set_resize_callback: noop,
    op_input_axes: noop,
    op_input_look: noop,
    op_input_buttons: noop,
    op_log: noop,
    op_http_post: () => Promise.resolve(""),
    op_http_post_headers: () => Promise.resolve(""),
    op_sleep_ms: () => Promise.resolve(),
    op_read_asset: options.readAsset ?? (() => new Uint8Array(0)),
    op_sha256: () => "",
    op_read_env: () => "",
    op_write_trace: noop,
    op_append_trace: noop,
    op_read_trace: () => "",
    op_sandbox_create: () => 0,
    op_sandbox_eval: () => "",
    op_sandbox_destroy: () => false,
    op_sandbox_count: () => 0,
    op_ecs_spatial_query_batch: noop,
    op_audio_init: () => 0,
    op_audio_play: () => 0,
    op_audio_ambient: () => 0,
    op_audio_stop: noop,
    op_audio_stop_all: noop,
    op_audio_set_bus_volume: noop,
    op_audio_play_spatial: () => 0,
    op_audio_set_emitter: noop,
    op_audio_set_listener: noop,
    op_audio_set_volume: noop,
    op_audio_speak: () => 0,
    op_audio_play_buffer: () => 0,
  };
}

export function composePortableEngineOps(
  physics: PhysicsEngineOps,
  options: InertEngineOpsOptions = {},
  overrides: Partial<EngineOps> = {},
): EngineOps {
  return { ...inertNonPhysicsEngineOps(options), ...bindPhysicsEngineOps(physics), ...overrides };
}
