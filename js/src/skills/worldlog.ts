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

/** A recorded command is replayable authoring iff it mutates the world. */
function isAuthoringCommand(cmd: WorldCommand, registry: SkillRegistry): boolean {
  if (cmd.kind === "physics") return true;
  if (cmd.kind !== "skill") return false; // seed marker, etc.
  const def = registry.describe(cmd.tool);
  if (def === undefined) return false;     // a tool the replaying registry won't have
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

export function registerWorldlogSkills(registry: SkillRegistry, opts: { recorder: WorldRecorder }): void {
  const recorder = opts.recorder;
  const tail: SkillDefinition<{ since: number }, { commands: WorldCommand[]; next: number; reset: boolean }> = {
    name: "worldlog.tail",
    version: "1.0.0",
    description: "Read-only: the AUTHORING command stream (mutating skills + physics; seed + read-only introspection excluded) recorded AFTER a cursor index, so a live editor viewport can re-author the world an agent is building. Returns the authoring tail slice, the next cursor, and `reset` (true when the caller's cursor fell behind a compacted prefix and it must resync from scratch).",
    category: "system",
    permissions: [],
    input: z.object({ since: z.number().int().min(0).default(0) }),
    output: z.object({ commands: z.array(z.any()), next: z.number().int(), reset: z.boolean() }),
    handler: (input) => {
      const total = recorder.commandCount;
      const compacted = recorder.compactedCommandCount;
      const reset = input.since < compacted;
      const start = reset ? compacted : input.since;
      const commands: WorldCommand[] = [];
      for (let i = start; i < total; i++) {
        const cmd = recorder.commandAt(i);
        if (cmd !== undefined && isAuthoringCommand(cmd, registry)) commands.push(cmd);
      }
      return { commands, next: total, reset };
    },
  };
  registry.register(tail);
}
