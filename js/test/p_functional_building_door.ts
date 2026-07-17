import { EntityTable, ops, type EngineOps } from "../src/engine.ts";
import { createEcsWorld } from "../src/ecs/world.ts";
import { createTransformStorage } from "../src/ecs/facade.ts";
import { UniformGridSpatialIndex } from "../src/spatial/index.ts";
import { LiminaTracer } from "../src/observability/event.ts";
import { SkillRegistry, type WorldContext } from "../src/skills/registry.ts";
import { registerCoreSkills } from "../src/skills/index.ts";
import { resolveProfile } from "../src/skills/permissions.ts";
import type { MCPResponse } from "../src/mcp/protocol.ts";

function assert(value: unknown, message: string): asserts value { if (!value) throw new Error(`p_functional_building_door FAIL: ${message}`); }
function ok(response: MCPResponse): Record<string, unknown> { if (!response.success) throw new Error(JSON.stringify(response.error)); return response.result as Record<string, unknown>; }
function world(worldOps: EngineOps): WorldContext {
  const ecs = createEcsWorld();
  return { ecs, transforms: createTransformStorage(ecs), spatial: new UniformGridSpatialIndex(), entities: new EntityTable(), tags: new Map(),
    scene: { add() {}, remove() {}, position: { set() {}, x: 0, y: 0, z: 0 }, background: null },
    camera: { position: { set() {} }, aspect: 1, lookAt() {}, updateProjectionMatrix() {} }, ops: worldOps, mode: "headless", simWorker: true } as WorldContext;
}
const perms = resolveProfile("builder.readWrite");
const ASSET = "buildings/functional-cottage-gorgon-v2.glb";

async function traversal(open: boolean, yaw = 0): Promise<{ final: [number, number, number]; entities: number; removed: number }> {
  ops.op_physics_create_world(0); ops.op_physics_add_ground(0); ops.op_physics_step();
  const w = world(ops), registry = new SkillRegistry(new LiminaTracer(`functional-${open}-${yaw}`)); registerCoreSkills(registry);
  const at = (tick: number) => ({ agentId: "builder", sessionId: "functional", permissions: perms, tick, world: w });
  const placed = ok(await registry.invoke("building.placeFunctional", { assetId: ASSET, position: [0, 0, 0], yaw }, at(1)));
  const door = (placed.doors as string[])[0];
  assert(typeof door === "string" && (placed.parts as string[]).length === 8, "placement did not emit one door and eight decomposed shell bodies");
  if (open) {
    ok(await registry.invoke("door.setOpen", { door, open: true }, at(2)));
    ok(await registry.invoke("door.setOpen", { door, open: true }, at(3))); // absolute/idempotent
  }
  const startLocal: [number, number, number] = [0, 0.85, -4.2];
  const c = Math.cos(yaw), s = Math.sin(yaw);
  const start: [number, number, number] = [startLocal[0] * c + startLocal[2] * s, startLocal[1], -startLocal[0] * s + startLocal[2] * c];
  const player = ok(await registry.invoke("player.spawn", { position: start }, at(4))).entity as string;
  let final = start;
  for (let i = 0; i < 65; i++) {
    const moved = ok(await registry.invoke("player.move", { entity: player, forward: 1, yaw: Math.PI - yaw }, at(5 + i)));
    final = moved.newPosition as [number, number, number];
  }
  const beforeDestroy = w.entities.ids().length;
  // Player is not owned by the building. Destroy removes root + 8 shell parts + authored door + its collider.
  const removed = ok(await registry.invoke("building.destroyFunctional", { root: placed.root }, at(100))).removed as number;
  assert(removed === 11 && w.entities.ids().length === beforeDestroy - 11, `lifecycle leaked building entities (${removed})`);
  assert((ok(await registry.invoke("building.destroyFunctional", { root: placed.root }, at(101))).removed as number) === 0, "destroy is not idempotent");
  return { final, entities: beforeDestroy, removed };
}

const closed = await traversal(false);
const opened = await traversal(true);
// At yaw zero, moving inward is +Z. Closed leaf stops the capsule south of its plane; opened clears it.
assert(closed.final[2] < -3.30, `closed door did not block the capsule: z=${closed.final[2]}`);
assert(opened.final[2] > -1.5, `open door did not permit entry: z=${opened.final[2]}`);
// Full placement transform gate: the same proof at a 90-degree building yaw.
const rotated = await traversal(true, Math.PI / 2);
assert(rotated.final[0] > -1.5, `rotated open doorway did not permit entry: x=${rotated.final[0]}`);
console.log(`p_functional_building_door OK: closed z=${closed.final[2].toFixed(3)}, open z=${opened.final[2].toFixed(3)}, rotated x=${rotated.final[0].toFixed(3)}, teardown=${opened.removed}`);
