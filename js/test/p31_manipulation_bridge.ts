// P31 -- human->command bridge (headless, deterministic).
//
// The World Designer lets a human directly manipulate the world: drag a gizmo to move/rotate/scale
// a mesh, retexture it, drop an asset. Every such edit must become the SAME AuthorCommand a
// proposing agent emits, so ONE authoring stream carries both producers and replay/undo treat a
// human edit exactly like an agent edit. This is the novel seam of the kernel refactor, so it is
// pinned headless before any gizmo UI exists.
//
// What this pins:
//   A. UNIT -- each manipulation translates to the correct skill command, with least-privilege
//      permissions and `human_editor` provenance, and unset material knobs are omitted.
//   B. ROUND-TRIP -- the produced commands are ADMITTED by the REAL registry using each command's
//      OWN minimal perms, and REPRODUCE the intended edit in live ECS transform state.
//
// Run: limina js/test/p31_manipulation_bridge.ts   (exit 0 = pass)

import { EntityTable, ops, type EngineOps } from "../src/engine.ts";
import { createEcsWorld } from "../src/ecs/world.ts";
import { createTransformStorage } from "../src/ecs/facade.ts";
import { UniformGridSpatialIndex } from "../src/spatial/index.ts";
import { LiminaTracer } from "../src/observability/event.ts";
import { SkillRegistry, type WorldContext } from "../src/skills/registry.ts";
import { registerCoreSkills } from "../src/skills/index.ts";
import { resolveProfile } from "../src/skills/permissions.ts";
import { captureWorldState } from "../src/worldlog/log.ts";
import type { MCPResponse } from "../src/mcp/protocol.ts";
import { translateManipulation, EDITOR_AGENT_ID, type Manipulation, type AuthorCommand } from "../src/kernel/manipulation.ts";

const SESSION = "ses_p31";
let pass = 0;
function assert(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new Error("p31_manipulation_bridge: " + msg);
  pass++;
}
function ok(res: MCPResponse): Record<string, unknown> {
  if (!res.success) throw new Error("call failed: " + JSON.stringify(res.error));
  return res.result as Record<string, unknown>;
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- test reaches into command inputs
const inp = (c: AuthorCommand): any => (c as { input: unknown }).input;

function makeWorld(worldOps: EngineOps): WorldContext {
  const ecs = createEcsWorld();
  const scene = { add() {}, remove() {}, position: { set() {}, x: 0, y: 0, z: 0 }, background: null as unknown };
  const camera = { position: { set() {} }, aspect: 1, lookAt() {}, updateProjectionMatrix() {} };
  return {
    ecs, transforms: createTransformStorage(ecs), spatial: new UniformGridSpatialIndex(),
    entities: new EntityTable(), tags: new Map(), scene: scene as WorldContext["scene"],
    camera: camera as WorldContext["camera"], ops: worldOps, mode: "headless",
  };
}

// ---- A. UNIT: each manipulation -> right command + least-privilege perms + provenance ----------
{
  const [mv] = translateManipulation({ kind: "move", entity: "ent_0", position: [1, 2, 3] });
  assert(mv.kind === "skill" && mv.tool === "ecs.updateComponent", "A: move -> ecs.updateComponent");
  assert(inp(mv).component === "position" && JSON.stringify(inp(mv).value) === "[1,2,3]", "A: move carries the position value");
  assert(mv.kind === "skill" && mv.agentId === EDITOR_AGENT_ID, "A: move is attributed to human_editor");
  assert(mv.kind === "skill" && [...(mv.perms ?? [])].join(",") === "ecs.modify", "A: move carries least-privilege ecs.modify");

  const [rot] = translateManipulation({ kind: "rotate", entity: "ent_0", quaternion: [0, 0, 0, 1] });
  assert(inp(rot).component === "rotation" && inp(rot).value.length === 4, "A: rotate -> quaternion [x,y,z,w] (length 4)");

  const [sc] = translateManipulation({ kind: "scale", entity: "ent_0", scale: [2, 2, 2] });
  assert(inp(sc).component === "scale" && JSON.stringify(inp(sc).value) === "[2,2,2]", "A: scale -> ecs.updateComponent scale");

  const [mat] = translateManipulation({ kind: "material", entity: "ent_0", color: 0x44aaff, roughness: 0.8 });
  assert(mat.kind === "skill" && mat.tool === "three.setMaterial", "A: material -> three.setMaterial");
  assert(inp(mat).color === 0x44aaff && inp(mat).roughness === 0.8, "A: material carries color + roughness");
  assert(inp(mat).metalness === undefined && !("material" in inp(mat)), "A: material OMITS the knobs the human did not set");
  assert(mat.kind === "skill" && [...(mat.perms ?? [])].join(",") === "scene.write", "A: material carries least-privilege scene.write");

  const [pa] = translateManipulation({ kind: "placeAsset", assetId: "fixtures/mesh.glb", position: [5, 0, 5], rotation: [0, 1.57, 0] });
  assert(pa.kind === "skill" && pa.tool === "asset.place" && inp(pa).assetId === "fixtures/mesh.glb", "A: placeAsset -> asset.place by id");
  assert(JSON.stringify(inp(pa).rotation) === "[0,1.57,0]", "A: placeAsset rotation stays EULER (asset.place's encoding)");
}

// ---- B. ROUND-TRIP: bridge commands admitted by the real registry + reproduce the edit ---------
{
  const reg = new SkillRegistry(new LiminaTracer(SESSION));
  registerCoreSkills(reg);
  const world = makeWorld(ops);

  // Seed one body-less entity with the stock builder profile (exactly p30's create path).
  const seed = { agentId: "agt_seed", sessionId: SESSION, permissions: resolveProfile("builder.readWrite"), tick: 1, world };
  const entity = ok(await reg.invoke("scene.createEntity", { shape: "box", position: [0, 0, 0] }, seed)).entity as string;

  // The human moves then scales it, driving each command through the registry with its OWN
  // minimal perms + human provenance -- proving least privilege is sufficient end to end.
  const edits: Manipulation[] = [
    { kind: "move", entity, position: [7, 8, 9] },
    { kind: "scale", entity, scale: [2, 3, 4] },
  ];
  for (const m of edits) {
    for (const cmd of translateManipulation(m)) {
      assert(cmd.kind === "skill", "B: the bridge must only emit skill commands");
      const res = await reg.invoke(cmd.tool, cmd.input, {
        agentId: cmd.agentId ?? "?", sessionId: SESSION,
        permissions: new Set<string>(cmd.perms ?? []), tick: 1, world,
      });
      assert(res.success, `B: bridge command ${cmd.tool} must be admitted with its own least-privilege perms (${JSON.stringify(res.error)})`);
    }
  }

  // Read the authoritative ECS state back and assert the human edits landed.
  const state = captureWorldState(world).entities.find((e) => e.id === entity);
  assert(state !== undefined, "B: the manipulated entity must exist in captured state");
  assert(JSON.stringify(state!.pos) === "[7,8,9]", `B: move reproduced in ECS state (got ${JSON.stringify(state!.pos)})`);
  assert(JSON.stringify(state!.scale) === "[2,3,4]", `B: scale reproduced in ECS state (got ${JSON.stringify(state!.scale)})`);
}

ops.op_log(
  `p31_manipulation_bridge OK: ${pass} assertions -- human manipulations translate to least-privilege ` +
    `AuthorCommands (human_editor provenance), are admitted by the REAL registry with their own minimal ` +
    `perms, and reproduce the edit in live ECS transform state.`,
);
