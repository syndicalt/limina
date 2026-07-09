// worldlog.* skills — expose the recorded AUTHORING command stream to a live editor viewport so it
// can re-author the SAME commands locally and render the world an agent is building. Read-only;
// bound to a WorldRecorder via closure (the AuthoritativeServer's `recorder`), mirroring
// registerSaveSkills' recorder-binding pattern.
//
// Only AUTHORING commands are exposed: every physics op (world setup) and every skill whose DECLARED
// permissions include a non-`.read` grant (the same mutation test approval.ts uses). The seed marker
// and read-only introspection the editor itself polls (inspector.snapshot / trace.tail / worldlog.tail)
// are excluded — feeding them to a viewport's loadWorld would replay reads or an unknown tool.

import { z } from "../../build/zod.bundle.mjs";
import type { SkillRegistry, SkillDefinition } from "./registry.ts";
import type { WorldRecorder } from "../worldlog/recorder.ts";
import { PHYSICS_OP_FN, type WorldCommand } from "../worldlog/log.ts";
import type { AuthorCommand } from "../kernel/authoring.ts";

/** A recorded command is replayable authoring iff it CONSTRUCTS the world. Physics ops count EXCEPT
 *  `step` (the per-tick sim advance): the authoritative server records a step every tick, but the
 *  viewport's own runLive sim steps locally — re-authoring the server's steps would flood the stream
 *  (a reboot per poll → visible flicker) and double-simulate. `move_character`/`apply_impulse` are
 *  per-tick DYNAMICS the local sim also reproduces, so they are excluded too; construction ops
 *  (create_world, add-body, remove_body) are kept. */
const PER_TICK_PHYSICS = new Set(["step", "move_character", "apply_impulse"]);
// Read-only introspection the editor + viewport poll EVERY tick. These must be excluded by NAME, not
// just by the permission test below: some are read-only in effect yet declare a non-`.read`
// permission (e.g. approval.list needs `approval.review` to LIST but mutates nothing). Left in, they
// enter the authoring stream once per poll and reboot the live viewport every second (flicker).
const INTROSPECTION = new Set([
  "worldlog.tail", "inspector.snapshot", "trace.tail", "approval.list", "approval.grant", "approval.deny",
  "skills.list", "skills.search", "skills.browse", "skills.describe",
]);
function isAuthoringCommand(cmd: WorldCommand, registry: SkillRegistry): boolean {
  if (cmd.kind === "physics") return !PER_TICK_PHYSICS.has(cmd.op);
  if (cmd.kind !== "skill") return false;   // seed marker, etc.
  if (INTROSPECTION.has(cmd.tool)) return false;
  const def = registry.describe(cmd.tool);
  if (def === undefined) return false;      // a tool the replaying registry won't have
  return def.permissions.some((p) => !p.endsWith(".read"));
}

/** Translate a recorded WorldCommand stream into the AuthorCommand[] a live viewport's loadWorld
 *  consumes: drop the seed marker (loadWorld has no seed branch); remap a physics op's SHORT recorded
 *  name (e.g. "add_box") to its full EngineOps key ("op_physics_add_box") via the SAME PHYSICS_OP_FN
 *  table replayCommands uses; pass skill commands through (tool/input, actorId -> agentId, perms).
 *  Pure + deterministic — the headless-testable half of the viewport wire. */
export function worldCommandsToAuthor(commands: readonly WorldCommand[]): AuthorCommand[] {
  const out: AuthorCommand[] = [];
  for (const cmd of commands) {
    if (cmd.kind === "physics") {
      out.push({ kind: "physics", op: PHYSICS_OP_FN[cmd.op], args: cmd.args } as AuthorCommand);
    } else if (cmd.kind === "skill") {
      out.push({ kind: "skill", tool: cmd.tool, input: cmd.input, agentId: cmd.actorId, perms: cmd.perms });
    }
    // seed: dropped — no AuthorCommand analogue.
  }
  return out;
}

/** The authoring tail: every recorded command AFTER `since` that is authoring (per
 *  isAuthoringCommand above), plus the next cursor and whether the caller's cursor had already
 *  fallen behind a compacted prefix (a full resync is required). THE single implementation behind
 *  both worldlog.tail (polled) and AuthoritativeServer's worldlog/subscribe push (net/server.ts) --
 *  shared so the two delivery paths can never diverge on what "authoring since X" means; a client
 *  mixing poll + push gets byte-identical batches for the same cursor either way. */
export function worldlogTail(
  recorder: WorldRecorder,
  registry: SkillRegistry,
  since: number,
): { commands: WorldCommand[]; next: number; reset: boolean } {
  const total = recorder.commandCount;
  const compacted = recorder.compactedCommandCount;
  const reset = since < compacted;
  const start = reset ? compacted : since;
  const commands: WorldCommand[] = [];
  for (let i = start; i < total; i++) {
    const cmd = recorder.commandAt(i);
    if (cmd !== undefined && isAuthoringCommand(cmd, registry)) commands.push(cmd);
  }
  return { commands, next: total, reset };
}

export function registerWorldlogSkills(registry: SkillRegistry, opts: { recorder: WorldRecorder }): void {
  const recorder = opts.recorder;
  const tail: SkillDefinition<{ since: number }, { commands: WorldCommand[]; next: number; reset: boolean }> = {
    name: "worldlog.tail",
    version: "1.0.0",
    description: "Read-only: the AUTHORING command stream (mutating skills + physics; seed + read-only introspection excluded) recorded AFTER a cursor index, so a live editor viewport can re-author the world an agent is building. Returns the authoring tail slice, the next cursor, and `reset` (true when the caller's cursor fell behind a compacted prefix and it must resync from scratch).",
    category: "system",
    permissions: [],
    effect: "read",
    input: z.object({ since: z.number().int().min(0).default(0) }),
    output: z.object({ commands: z.array(z.any()), next: z.number().int(), reset: z.boolean() }),
    handler: (input) => worldlogTail(recorder, registry, input.since),
  };
  registry.register(tail);
}
