// Phase 3 spatial index foundation: indexed scene/perception queries must match
// brute-force semantics while visiting fewer candidate entities in sparse worlds.

import { EntityTable, ops } from "../src/engine.ts";
import { createEcsWorld } from "../src/ecs/world.ts";
import { createTransformStorage } from "../src/ecs/facade.ts";
import { LiminaTracer } from "../src/observability/event.ts";
import { SkillRegistry, type WorldContext } from "../src/skills/registry.ts";
import { registerCoreSkills } from "../src/skills/index.ts";
import { resolveProfile } from "../src/skills/permissions.ts";
import { AgentRegistry } from "../src/agents/agent.ts";
import { perceptionSystem } from "../src/agents/systems.ts";
import {
  UniformGridSpatialIndex,
  querySpatialEntities,
  querySpatialEntitiesBruteForce,
  type SpatialQueryEntity,
} from "../src/spatial/index.ts";
import type { MCPResponse } from "../src/mcp/protocol.ts";

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function ok(res: MCPResponse): unknown {
  if (!res.success) throw new Error("call failed: " + JSON.stringify(res.error));
  return res.result;
}

function field(value: unknown, key: string): unknown {
  if (typeof value === "object" && value !== null && key in value) {
    return (value as Record<string, unknown>)[key];
  }
  return undefined;
}

function entityIds(rows: readonly SpatialQueryEntity[]): string {
  return rows.map((row) => row.entity).join(",");
}

const scene = { add() {}, remove() {}, position: { set() {}, x: 0, y: 0, z: 0 }, background: null as unknown };
const camera = { position: { set() {} }, aspect: 1, lookAt() {}, updateProjectionMatrix() {} };
const agents = new AgentRegistry();
const ecs = createEcsWorld();
const world: WorldContext = {
  ecs,
  transforms: createTransformStorage(ecs),
  spatial: new UniformGridSpatialIndex({ cellSize: 10 }),
  entities: new EntityTable(),
  tags: new Map(),
  scene,
  camera,
  ops,
  agents,
};

ops.op_physics_create_world(0);
const tracer = new LiminaTracer("ses_p3_spatial");
const registry = new SkillRegistry(tracer);
registerCoreSkills(registry);
const builder = { agentId: "agt_builder", sessionId: "ses_p3_spatial", permissions: resolveProfile("builder.readWrite"), tick: 0, world };

const created: string[] = [];
for (let i = 0; i < 160; i++) {
  const x = i * 25;
  const z = (i % 7) * 17;
  const entity = field(ok(await registry.invoke("scene.createEntity", { position: [x, 0, z] }, builder)), "entity");
  assert(typeof entity === "string", "createEntity returned no id");
  created.push(entity);
  if (i % 11 === 0) ok(await registry.invoke("ecs.addComponent", { entity, component: "target" }, builder));
}

const near: [number, number, number] = [50, 0, 34];
const radius = 45;
const brute = querySpatialEntitiesBruteForce(world, { near, radius, sortBy: "entity" });
const indexed = querySpatialEntities(world, { near, radius, sortBy: "entity" });
assert(entityIds(indexed.entities) === entityIds(brute.entities), "indexed scene query differs from brute-force query");
assert(indexed.stats.indexed === true, "world spatial index was not used");
assert(indexed.stats.candidateEntities < brute.stats.candidateEntities, `indexed query visited ${indexed.stats.candidateEntities}, brute visited ${brute.stats.candidateEntities}`);

const taggedBrute = querySpatialEntitiesBruteForce(world, { near, radius: 400, tag: "target", sortBy: "entity" });
const taggedIndexed = querySpatialEntities(world, { near, radius: 400, tag: "target", sortBy: "entity" });
assert(entityIds(taggedIndexed.entities) === entityIds(taggedBrute.entities), "indexed tagged query differs from brute force");

const taggedNearBrute = querySpatialEntitiesBruteForce(world, { near, radius, tag: "target", sortBy: "entity" });
const skillResult = ok(await registry.invoke("scene.queryEntities", { near, radius, tag: "target" }, builder));
const skillEntities = field(skillResult, "entities");
assert(Array.isArray(skillEntities), "scene.queryEntities did not return entities");
assert(
  skillEntities.map((row) => field(row, "entity")).join(",") === taggedNearBrute.entities.map((row) => row.entity).join(","),
  "scene.queryEntities did not preserve brute-force entity order",
);

agents.add({
  id: "agt_spatial",
  type: "player",
  entityId: created[2],
  perceptionRadius: 70,
  decisionIntervalTicks: 1,
  profile: "player.limited",
  sessionId: "ses_p3_spatial",
  llm: { provider: "scripted", model: "", systemPrompt: "observe" },
});
perceptionSystem(agents, world, tracer, 1);
const perception = agents.get("agt_spatial")?.perception;
assert(perception !== undefined, "perception was not populated");
const expectedPerception = querySpatialEntitiesBruteForce(world, {
  near: perception.position,
  radius: 70,
  excludeEntity: created[2],
  sortBy: "distance",
}).entities;
assert(
  perception.nearby.map((row) => row.id).join(",") === expectedPerception.map((row) => row.entity).join(","),
  "perception indexed query differs from brute-force distance order",
);

const moved = created[120];
ok(await registry.invoke("three.setTransform", { entity: moved, position: [near[0] + 1, near[1], near[2]] }, builder));
const afterMove = querySpatialEntities(world, { near, radius: 3, sortBy: "entity" });
assert(afterMove.entities.some((row) => row.entity === moved), "spatial index did not observe direct transform write");

ops.op_log(
  `P3 spatial index OK: exact query/perception semantics, indexed candidates ${indexed.stats.candidateEntities}/${brute.stats.candidateEntities}`,
);
