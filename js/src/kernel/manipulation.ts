// Human -> command bridge (kernel). A direct-manipulation edit in the World Designer
// (drag a gizmo, retexture a mesh, drop an asset) is translated here into the SAME
// AuthorCommand a proposing agent emits, so both producers write ONE authoring stream and
// replay/undo treat a human edit exactly like an agent edit. Pure + synchronous: no engine,
// no I/O — so it is unit-testable headless, which is where the "does a human edit round-trip
// through the real registry" contract is pinned (js/test/p31_manipulation_bridge.ts).
//
// AuthorCommand currently lives in browser/sim-worker.ts (its first consumer, runLive). This
// is a TYPE-only import — erased at build, no runtime coupling — so the kernel does not pull in
// the browser layer. The later authoring-stream wiring step migrates the canonical type here
// and re-exports it from the browser layer; until then this is the single definition.

import type { SkillRegistry, WorldContext } from "../skills/registry.ts";
import type { MCPResponse } from "../mcp/protocol.ts";
import { applyAuthorCommands, type ApplyOptions, type AuthorCommand } from "./authoring.ts";

export type { AuthorCommand };

/** The agent id a human's edits are attributed to. Matches the editor client handshake
 *  (editor/src/app.js `initialize("human_editor", ...)`), so the trace shows uniform
 *  provenance: a human edit is an authored command by `human_editor`. */
export const EDITOR_AGENT_ID = "human_editor";

/** A direct-manipulation intent from the viewport. Closed set: each case maps to ONE existing
 *  authoring skill, so the bridge adds no new engine surface — it only re-expresses a human
 *  gesture as the command an agent would have issued. */
export type Manipulation =
  | { kind: "move"; entity: string; position: [number, number, number] }
  | { kind: "rotate"; entity: string; quaternion: [number, number, number, number] }
  | { kind: "scale"; entity: string; scale: [number, number, number] }
  | { kind: "material"; entity: string; color?: number; roughness?: number; metalness?: number; material?: string }
  | { kind: "placeAsset"; assetId: string; position: [number, number, number]; rotation?: [number, number, number]; scale?: [number, number, number] };

// Least privilege: each command carries exactly the permission its target skill declares, so a
// human edit is admitted by the registry's permission check without needing a broad grant.
const PERM_ECS_MODIFY: readonly string[] = ["ecs.modify"];   // ecs.updateComponent
const PERM_SCENE_WRITE: readonly string[] = ["scene.write"]; // three.setMaterial, asset.place

function skill(tool: string, input: unknown, perms: readonly string[]): AuthorCommand {
  return { kind: "skill", tool, input, agentId: EDITOR_AGENT_ID, perms };
}

/** Translate a human manipulation into the AuthorCommand(s) that reproduce it. Note the two
 *  rotation encodings the engine already uses: `ecs.updateComponent` takes a QUATERNION
 *  [x,y,z,w] (a live gizmo produces one), while `asset.place` takes EULER radians [x,y,z]. The
 *  bridge keeps each intent in the encoding its target skill expects; euler<->quaternion
 *  conversion for GDS-world-slice persistence is a separate concern at that boundary. */
export function translateManipulation(m: Manipulation): AuthorCommand[] {
  switch (m.kind) {
    case "move":
      return [skill("ecs.updateComponent", { entity: m.entity, component: "position", value: m.position }, PERM_ECS_MODIFY)];
    case "rotate":
      return [skill("ecs.updateComponent", { entity: m.entity, component: "rotation", value: m.quaternion }, PERM_ECS_MODIFY)];
    case "scale":
      return [skill("ecs.updateComponent", { entity: m.entity, component: "scale", value: m.scale }, PERM_ECS_MODIFY)];
    case "material": {
      // Forward only the fields the human set; three.setMaterial treats each as optional and an
      // absent field means "leave the asset default", so unset knobs must not appear.
      const input: Record<string, unknown> = { entity: m.entity };
      if (m.material !== undefined) input.material = m.material;
      if (m.color !== undefined) input.color = m.color;
      if (m.roughness !== undefined) input.roughness = m.roughness;
      if (m.metalness !== undefined) input.metalness = m.metalness;
      return [skill("three.setMaterial", input, PERM_SCENE_WRITE)];
    }
    case "placeAsset": {
      const input: Record<string, unknown> = { assetId: m.assetId, position: m.position };
      if (m.rotation !== undefined) input.rotation = m.rotation;
      if (m.scale !== undefined) input.scale = m.scale;
      return [skill("asset.place", input, PERM_SCENE_WRITE)];
    }
  }
}

/** Translate a manipulation AND apply it to the world through the shared authoring applier, using
 *  each command's own least-privilege perms + `human_editor` provenance. Convenience for the editor:
 *  one human gesture -> the recorded, registry-admitted edit(s). Stops at the first failure (per
 *  applyAuthorCommands) and returns each command's response. */
export async function applyManipulation(
  registry: SkillRegistry,
  world: WorldContext,
  m: Manipulation,
  opts: ApplyOptions,
): Promise<MCPResponse[]> {
  return applyAuthorCommands(registry, world, translateManipulation(m), opts);
}
