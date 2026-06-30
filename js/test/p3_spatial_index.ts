// Phase 3 spatial index foundation: indexed scene/perception queries must match
// brute-force semantics while visiting fewer candidate entities in sparse worlds.

import { ops } from "../src/engine.ts";
import { AgentRegistry } from "../src/agents/agent.ts";
import { perceptionSystem } from "../src/agents/systems.ts";
import { createHeadlessContext } from "../src/game/context.ts";
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

const agents = new AgentRegistry();
const ctx = createHeadlessContext({ session: "ses_p3_spatial", agentId: "agt_builder", agents, spatial: new UniformGridSpatialIndex({ cellSize: 10 }) });
const world = ctx.world;
const registry = ctx.registry;
const tracer = ctx.tracer;

ops.op_physics_create_world(0);
const builder = ctx.base;

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
