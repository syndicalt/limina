// Dump the SIEGE archetype's real renderable geometry as a scene spec (boxes), for the Track C
// flagship render. Runs the actual world.generateRegion + architecture.building + attacker spawns
// (the same authoring the p16_archetype_siege integration test drives), then prints the keep's real
// part transforms + attacker boxes as JSON. Captured by the flagship render test.
//
// Run: ./target/release/limina js/test/_dump_siege_scene.ts  → prints "SIEGE_SCENE_JSON:{...}"

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
const reg = new SkillRegistry(new LiminaTracer("dump_siege"));
registerCoreSkills(reg);
const world = makeWorld(ops);
const PERMS = resolveProfile("builder.readWrite");
const at = (t: number): InvokeBase => ({ agentId: "agt", sessionId: "dump_siege", permissions: PERMS, tick: t, world });

// The keep — the real architecture.building output (8×8×4 at [48,0,48]).
ok("generateRegion", await reg.invoke("world.generateRegion", { seed: 99, bounds: { minTx: 0, minTz: 0, maxTx: 1, maxTz: 1 }, lod: 0, type: "plains", render: false }, at(0)));
const keep = ok("architecture.building", await reg.invoke("architecture.building", { position: [48, 0, 48], width: 8, depth: 8, height: 4 }, at(0)));
const parts = (keep.parts ?? []) as Array<{ kind: string; position: [number, number, number]; size: [number, number, number] }>;

// A few attackers closing on the keep (boxes), as the siege spawns them around the -Z approach.
const attackers: Array<{ position: [number, number, number]; size: [number, number, number]; color: number }> = [];
for (let i = 0; i < 5; i++) {
  attackers.push({ position: [48 - 3 + i * 1.5, 0.5, 48 - 6 + (i % 2) * 1.2], size: [1, 1, 1], color: 0xcc3a2e });
}

// Re-center on the keep so a single framed camera sees it; emit boxes as {position,size,color}.
const C: [number, number, number] = [48, 0, 48];
const recenter = (p: [number, number, number]): [number, number, number] => [p[0] - C[0], p[1], p[2] - C[2]];
const boxes = [
  ...parts.map((pt) => ({ position: recenter(pt.position), size: pt.size, color: 0x9a8c7a, kind: pt.kind })),
  ...attackers.map((a) => ({ position: recenter(a.position), size: a.size, color: a.color, kind: "attacker" })),
];

ops.op_log("SIEGE_SCENE_JSON:" + JSON.stringify({ boxes, partCount: parts.length, attackerCount: attackers.length }));
