// Dump the QUEST archetype's real village geometry (hall + home + shrine — three architecture.building
// structures) as a renderable box spec, for the Track C flagship render. Same authoring as
// p16_archetype_quest. Prints "QUEST_SCENE_JSON:{...}".
//
// Run: ./target/release/limina js/test/_dump_quest_scene.ts

import { EntityTable, ops, type EngineOps } from "../src/engine.ts";
import { createEcsWorld } from "../src/ecs/world.ts";
import { createTransformStorage } from "../src/ecs/facade.ts";
import { UniformGridSpatialIndex } from "../src/spatial/index.ts";
import { LiminaTracer } from "../src/observability/event.ts";
import { SkillRegistry, type InvokeBase, type WorldContext } from "../src/skills/registry.ts";
import { registerCoreSkills } from "../src/skills/index.ts";
import { resolveProfile } from "../src/skills/permissions.ts";
import type { MCPResponse } from "../src/mcp/protocol.ts";

function ok(label: string, res: MCPResponse | undefined): Record<string, unknown> {
  if (res === undefined || !res.success) throw new Error(`${label} failed: ${JSON.stringify(res?.error ?? "no response")}`);
  return (res.result ?? {}) as Record<string, unknown>;
}
function makeWorld(worldOps: EngineOps): WorldContext {
  const scene = { add() {}, remove() {}, position: { set() {}, x: 0, y: 0, z: 0 }, background: null as unknown };
  const camera = { position: { set() {} }, aspect: 1, lookAt() {}, updateProjectionMatrix() {} };
  const ecs = createEcsWorld();
  return {
    ecs, transforms: createTransformStorage(ecs), spatial: new UniformGridSpatialIndex(),
    entities: new EntityTable(), tags: new Map(), scene: scene as WorldContext["scene"],
    camera: camera as WorldContext["camera"], ops: worldOps, mode: "headless",
  };
}

ops.op_physics_create_world(-9.81);
const reg = new SkillRegistry(new LiminaTracer("dump_quest"));
registerCoreSkills(reg);
const world = makeWorld(ops);
const PERMS = resolveProfile("builder.readWrite");
const at = (t: number): InvokeBase => ({ agentId: "agt", sessionId: "dump_quest", permissions: PERMS, tick: t, world });

ok("generateRegion", await reg.invoke("world.generateRegion", { seed: 4242, bounds: { minTx: 0, minTz: 0, maxTx: 1, maxTz: 1 }, lod: 0, type: "plains", render: false }, at(0)));

const HALL: [number, number, number] = [36, 0, 48];
const HOME: [number, number, number] = [48, 0, 48];
const SHRINE: [number, number, number] = [60, 0, 48];
const tint: Record<string, number> = { hall: 0x8d7b63, home: 0x9a6b4a, shrine: 0xc8b89a };
const C: [number, number, number] = [48, 0, 48];
const recenter = (p: [number, number, number]): [number, number, number] => [p[0] - C[0], p[1], p[2] - C[2]];

const boxes: Array<{ position: [number, number, number]; size: [number, number, number]; color: number; kind: string }> = [];
for (const [name, p] of [["hall", HALL], ["home", HOME], ["shrine", SHRINE]] as const) {
  const b = ok(`architecture.building(${name})`, await reg.invoke("architecture.building", { position: p, width: 6, depth: 6, height: 3 }, at(0)));
  const parts = (b.parts ?? []) as Array<{ kind: string; position: [number, number, number]; size: [number, number, number] }>;
  for (const pt of parts) boxes.push({ position: recenter(pt.position), size: pt.size, color: tint[name], kind: `${name}:${pt.kind}` });
}

ops.op_log("QUEST_SCENE_JSON:" + JSON.stringify({ boxes, partCount: boxes.length, attackerCount: 0, buildings: 3 }));
