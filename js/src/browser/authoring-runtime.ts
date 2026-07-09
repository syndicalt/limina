import { StaticAuthoringAdapterAllowlist } from "../authoring/adapter.ts";
import { createWorldProjectStateAuthoring } from "../authoring/adapters/project-state.ts";
import { SceneAuthoringAdapter } from "../authoring/adapters/scene.ts";
import { registerAuthoringSkills, type AuthoringSkillRuntime } from "../authoring/skills.ts";
import type { SkillRegistry, WorldContext } from "../skills/registry.ts";
import { sha256 } from "../world/sha256.mjs";

/** Register the exact browser replay allowlist for one authoritative project. */
export function registerBrowserAuthoringRuntime(
  registry: SkillRegistry,
  world: WorldContext,
  projectId: string,
): AuthoringSkillRuntime {
  const projectStateAuthoring = createWorldProjectStateAuthoring(projectId, sha256);
  return registerAuthoringSkills(registry, {
    projectId,
    sha256,
    adapters: new StaticAuthoringAdapterAllowlist([
      new SceneAuthoringAdapter({ world }),
      projectStateAuthoring.adapter,
    ]),
    projectState: projectStateAuthoring.projectState,
  });
}
