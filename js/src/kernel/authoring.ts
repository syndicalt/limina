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

export type { AuthorCommand };

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
    const fn = (world.ops as unknown as Record<string, ((...a: unknown[]) => unknown) | undefined>)[cmd.op];
    if (typeof fn !== "function") {
      throw new Error(`applyAuthorCommand: unknown physics op '${String(cmd.op)}'`);
    }
    return { success: true, result: fn(...cmd.args) };
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
