// Authoring stream (kernel) — the ONE place an AuthorCommand is applied to a world, so a human
// edit, an agent edit, and a replayed command all take exactly the same application path. This
// mirrors sim-worker.loadWorld's per-command semantics (a `physics` command calls the named engine
// op directly; a `skill` command re-invokes the tool through the registry using the command's own
// agentId/perms when present — the exact rule worldlog replay uses). The browser loadWorld adopts
// this shared applier in the viewport-wiring step; today it is the headless World-Designer path.
//
// AuthorCommand currently lives in browser/sim-worker.ts (its first consumer, runLive). It is
// re-exported here so kernel code imports it from the kernel, and it migrates to this file when the
// browser path adopts the shared applier. Type-only re-export: no runtime coupling to the browser.

import type { SkillRegistry, WorldContext } from "../skills/registry.ts";
import type { MCPResponse } from "../mcp/protocol.ts";
import type { AuthorCommand } from "../browser/sim-worker.ts";
import type { PhysicsOps } from "../engine.ts";
import { PHYSICS_OP_FN, PHYSICS_OP_OUT_BUFFER } from "../worldlog/log.ts";

export type { AuthorCommand };

/** The EngineOps methods a `physics` AuthorCommand may name — exactly `keyof PhysicsOps`
 *  (the `satisfies` keeps this set in compile-time lockstep with engine.ts). Without this
 *  allowlist the dynamic dispatch below would reach ANY ops method (op_read_asset,
 *  op_http_post, ...) from an author stream. */
const PHYSICS_METHODS = new Set<string>(Object.keys({
  op_physics_create_world: true, op_physics_add_ground: true, op_physics_add_box: true,
  op_physics_add_box_material: true, op_physics_add_sphere: true, op_physics_add_capsule: true,
  op_physics_add_static_box: true, op_physics_add_static_sphere: true, op_physics_add_static_capsule: true,
  op_physics_add_heightfield: true, op_physics_add_character: true, op_physics_move_character: true,
  op_physics_remove_body: true, op_physics_apply_impulse: true, op_physics_step: true,
  op_physics_snapshot: true, op_physics_restore: true, op_physics_body_pos: true,
  op_physics_body_transform: true, op_physics_set_body_transform: true, op_physics_drain_collisions: true,
  op_physics_raycast: true, op_physics_overlap_box: true,
} satisfies Record<keyof PhysicsOps, true>));

/** Ops whose TRAILING out-buffer arg is re-supplied when absent — the same contract the
 *  worldlog replayers use (the recorder strips the buffer from logged args). Derived from
 *  the worldlog maps so the two appliers cannot drift. */
const OUT_BUFFER_LEN: ReadonlyMap<string, number> = new Map(
  (Object.keys(PHYSICS_OP_OUT_BUFFER) as (keyof typeof PHYSICS_OP_OUT_BUFFER)[])
    .map((short) => [PHYSICS_OP_FN[short] as string, PHYSICS_OP_OUT_BUFFER[short]!]),
);

export interface ApplyOptions {
  sessionId: string;
  /** Tick the command is applied at (recorded in the trace). Default 0. */
  tick?: number;
  /** Fallback agent id for a skill command that carries none. Default "author". */
  defaultAgentId?: string;
  /** Fallback permission set for a skill command that carries none. Default empty. */
  defaultPerms?: ReadonlySet<string>;
}

/** Apply ONE AuthorCommand to a world. A `physics` command calls the named engine op directly (no
 *  entity, e.g. `op_physics_create_world`); a `skill` command re-invokes the tool through the
 *  registry using the command's OWN agentId/perms when present, else the supplied fallbacks.
 *  Returns the skill's MCPResponse; a physics op returns a synthetic success carrying its return.
 *  Throws only on a genuinely malformed command (an unknown physics op name — a programming error,
 *  not a user/skill failure). */
export async function applyAuthorCommand(
  registry: SkillRegistry,
  world: WorldContext,
  cmd: AuthorCommand,
  opts: ApplyOptions,
): Promise<MCPResponse> {
  if (cmd.kind === "physics") {
    const opName = String(cmd.op);
    const fn = (world.ops as unknown as Record<string, ((...a: unknown[]) => unknown) | undefined>)[opName];
    if (!PHYSICS_METHODS.has(opName) || typeof fn !== "function") {
      throw new Error(`applyAuthorCommand: unknown physics op '${opName}'`);
    }
    // Author streams are hand-written (engine-live harnesses, WS clients), so validate args
    // BEFORE the native call — the same discipline the sim worker applies to streamed data:
    // scalars must be finite numbers; the only legitimate non-scalar args are typed-array
    // views (heightfield heights, snapshot bytes, an explicitly supplied out-buffer).
    for (const arg of cmd.args) {
      if (typeof arg === "number" ? Number.isFinite(arg) : ArrayBuffer.isView(arg)) continue;
      throw new Error(`applyAuthorCommand: physics op '${opName}' takes finite numbers / typed arrays (got ${typeof arg})`);
    }
    // Trailing out-buffer contract (mirrors the worldlog replayers): an authored/recorded
    // command carries the scalar inputs only; append a fresh scratch buffer when the
    // caller supplied none, so ops like op_physics_move_character apply instead of throwing.
    const outLen = OUT_BUFFER_LEN.get(opName);
    const args = (outLen !== undefined && !(cmd.args[cmd.args.length - 1] instanceof Float32Array))
      ? [...cmd.args, new Float32Array(outLen)]
      : cmd.args;
    return { success: true, result: fn(...args) };
  }
  return registry.invoke(cmd.tool, cmd.input, {
    agentId: cmd.agentId ?? opts.defaultAgentId ?? "author",
    sessionId: opts.sessionId,
    permissions: cmd.perms !== undefined ? new Set<string>(cmd.perms) : new Set<string>(opts.defaultPerms ?? []),
    tick: opts.tick ?? 0,
    world,
  });
}

/** Apply a batch in order, STOPPING at the first failure (its response is the last in the returned
 *  array). Ordering matters: an authoring stream is a sequence, and a later command may depend on an
 *  earlier one's effect (e.g. set a material on an entity a prior command created). */
export async function applyAuthorCommands(
  registry: SkillRegistry,
  world: WorldContext,
  cmds: readonly AuthorCommand[],
  opts: ApplyOptions,
): Promise<MCPResponse[]> {
  const out: MCPResponse[] = [];
  for (const cmd of cmds) {
    const res = await applyAuthorCommand(registry, world, cmd, opts);
    out.push(res);
    if (!res.success) break;
  }
  return out;
}
