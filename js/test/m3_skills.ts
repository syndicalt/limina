// M3/M4/M5 — scene/ecs/three/physics skills over the registry + MCP, with
// permission profiles. Headless (stub scene; real bitECS + Rapier + materials).

import { EntityTable, ops } from "../src/engine.ts";
import { createEcsWorld, Position } from "../src/ecs/world.ts";
import { LiminaTracer } from "../src/observability/event.ts";
import { SkillRegistry, type WorldContext } from "../src/skills/registry.ts";
import { registerCoreSkills } from "../src/skills/index.ts";
import { resolveProfile } from "../src/skills/permissions.ts";
import type { MCPResponse } from "../src/mcp/protocol.ts";

const sceneChildren: unknown[] = [];
const scene = {
  add(c: unknown) { sceneChildren.push(c); },
  remove(c: unknown) { const i = sceneChildren.indexOf(c); if (i >= 0) sceneChildren.splice(i, 1); },
  position: { set() {}, x: 0, y: 0, z: 0 },
  background: null as unknown,
};
const camera = { position: { set() {} }, aspect: 1, lookAt() {}, updateProjectionMatrix() {} };
const world: WorldContext = { ecs: createEcsWorld(), entities: new EntityTable(), tags: new Map(), scene, camera, ops };

ops.op_physics_create_world(-9.81);
ops.op_physics_add_ground(0);

const registry = new SkillRegistry(new LiminaTracer("ses_m3"));
registerCoreSkills(registry);

const base = { agentId: "agt_builder", sessionId: "ses_m3", permissions: resolveProfile("builder.readWrite"), tick: 0, world };

function ok(res: MCPResponse): unknown {
  if (!res.success) throw new Error("call failed: " + JSON.stringify(res.error));
  return res.result;
}
function field(value: unknown, key: string): unknown {
  if (typeof value === "object" && value !== null && key in value) {
    const rec = value as Record<string, unknown>; // narrowed object -> record for field read
    return rec[key];
  }
  return undefined;
}

// scene.createEntity (dynamic box) + query.
const created = ok(await registry.invoke("scene.createEntity", { shape: "box", size: 1, color: 0xff0000, position: [0, 5, 0], dynamic: true }, base));
const entity = field(created, "entity");
if (typeof entity !== "string") throw new Error("createEntity returned no id");

const queried = ok(await registry.invoke("scene.queryEntities", {}, base));
const listed = field(queried, "entities");
if (!Array.isArray(listed) || listed.length !== 1) throw new Error("queryEntities count");

// ecs.updateComponent writes the SoA position.
ok(await registry.invoke("ecs.updateComponent", { entity, component: "position", value: [3, 5, 0] }, base));
const eid = world.entities.resolve(entity)?.eid ?? -1;
if (Position.x[eid] !== 3) throw new Error("updateComponent did not write Position");

// three.setMaterial mutates the live material.
ok(await registry.invoke("three.setMaterial", { entity, roughness: 0.2 }, base));
const mat = world.entities.resolve(entity)?.mesh?.material;
if (mat === undefined || mat.roughness !== 0.2) throw new Error("setMaterial did not apply");

// three.setTransform + three.setLighting.
ok(await registry.invoke("three.setTransform", { entity, rotationEuler: [0, Math.PI / 2, 0] }, base));
ok(await registry.invoke("three.setLighting", {}, base));
if (sceneChildren.length < 3) throw new Error("setLighting did not add lights"); // mesh + ambient + directional

// physics.applyImpulse moves a resting dynamic body.
for (let i = 0; i < 90; i++) ops.op_physics_step();
const bodyId = world.entities.resolve(entity)?.bodyId ?? -1;
const before = new Float32Array(3);
ops.op_physics_body_pos(bodyId, before);
ok(await registry.invoke("physics.applyImpulse", { entity, impulse: [15, 0, 0] }, base));
for (let i = 0; i < 30; i++) ops.op_physics_step();
const after = new Float32Array(3);
ops.op_physics_body_pos(bodyId, after);
if (after[0] <= before[0] + 0.05) throw new Error("applyImpulse had no effect");

// physics.raycast hits below.
const rc = ok(await registry.invoke("physics.raycast", { origin: [after[0], 10, 0], direction: [0, -1, 0], maxDistance: 100 }, base));
if (field(rc, "hit") !== true) throw new Error("raycast missed");

// skills.list / describe.
const tools = field(ok(await registry.invoke("skills.list", {}, base)), "tools");
if (!Array.isArray(tools) || tools.length < 14) throw new Error("skills.list returned too few");
const desc = ok(await registry.invoke("skills.describe", { name: "scene.createEntity" }, base));
if (field(desc, "input_schema") === undefined) throw new Error("skills.describe missing input_schema");

// M6: player.limited cannot scene.write.
const denied = await registry.invoke("scene.createEntity", { position: [0, 0, 0] }, { ...base, permissions: resolveProfile("player.limited") });
if (denied.success || denied.error?.code !== "forbidden") throw new Error("createEntity not denied for player.limited");

ops.op_log(`M3/M4/M5 OK: ${Array.isArray(tools) ? tools.length : 0} skills, scene/ecs/three/physics + MCP + permission profiles`);
