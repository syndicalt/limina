import type { AuthorCommand } from "../kernel/authoring.ts";

const VIEWPORT_DATA_ONLY_SKILLS = new Set(["asset.request", "catalog.publish"]);

/** Commands retained in the world log that intentionally have no render or simulation effect. */
export function isViewportDataOnlyCommand(command: AuthorCommand): boolean {
  return command.kind === "skill" && VIEWPORT_DATA_ONLY_SKILLS.has(command.tool);
}

/** Remove data-only commands while retaining stable indices into the authoritative command log. */
export function partitionViewportCommands(commands: readonly AuthorCommand[]): {
  commands: AuthorCommand[];
  originalIndices: number[];
} {
  const viewportCommands: AuthorCommand[] = [];
  const originalIndices: number[] = [];
  for (let index = 0; index < commands.length; index++) {
    if (isViewportDataOnlyCommand(commands[index])) continue;
    viewportCommands.push(commands[index]);
    originalIndices.push(index);
  }
  return { commands: viewportCommands, originalIndices };
}
