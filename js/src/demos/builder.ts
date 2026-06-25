// M9 — Builder demo: an in-process agent discovers tools and constructs a scene
// over MCP (createEntity, setTransform, setMaterial, setLighting, loadGLTF), one
// call is permission-denied, and the whole sequence is permission-checked +
// traced. Headless (stub scene; real bitECS + materials + glTF parse).
//
// Run: limina js/src/demos/builder.ts

import { EntityTable, ops } from "../engine.ts";
import { createEcsWorld } from "../ecs/world.ts";
import { LiminaTracer } from "../observability/event.ts";
import { SkillRegistry, type WorldContext } from "../skills/registry.ts";
import { registerCoreSkills } from "../skills/index.ts";
import { resolveProfile } from "../skills/permissions.ts";
import { Mcp } from "../mcp/mcp.ts";
import type { MCPResponse } from "../mcp/protocol.ts";

function ok(res: MCPResponse): unknown {
  if (!res.success) throw new Error("call failed: " + JSON.stringify(res.error));
  return res.result;
}
function field(value: unknown, key: string): unknown {
  if (typeof value === "object" && value !== null && key in value) {
    const rec = value as Record<string, unknown>;
    return rec[key];
  }
  return undefined;
}

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

const tracer = new LiminaTracer("ses_builder");
const registry = new SkillRegistry(tracer);
registerCoreSkills(registry);

const builder = new Mcp(registry, world, { agentId: "agt_builder", sessionId: "ses_builder", permissions: resolveProfile("builder.readWrite") });
const player = new Mcp(registry, world, { agentId: "agt_player", sessionId: "ses_builder", permissions: resolveProfile("player.limited") });

// 1. Discover tools.
const tools = builder.listTools();
if (tools.length < 14) throw new Error(`listTools returned ${tools.length}`);
ops.op_log(`builder: discovered ${tools.length} tools`);

// 2. Construct a scene.
const a = field(ok(await builder.callTool({ tool: "scene.createEntity", input: { shape: "box", color: 0xff8c1a, position: [-1.5, 1, 0], dynamic: false } })), "entity");
const b = field(ok(await builder.callTool({ tool: "scene.createEntity", input: { shape: "sphere", color: 0x4ade80, position: [1.5, 1, 0], dynamic: true } })), "entity");
if (typeof a !== "string" || typeof b !== "string") throw new Error("createEntity failed");

ok(await builder.callTool({ tool: "three.setTransform", input: { entity: a, position: [-1.5, 2, 0], scale: [1.5, 1.5, 1.5] } }));
ok(await builder.callTool({ tool: "three.setMaterial", input: { entity: b, color: 0x60a5fa, roughness: 0.2, metalness: 0.8 } }));
ok(await builder.callTool({ tool: "three.setLighting", input: { directionalIntensity: 4 } }));

const model = field(ok(await builder.callTool({ tool: "three.loadGLTF", input: { assetId: "triangle.glb", position: [0, 0, 2] } })), "entity");
if (typeof model !== "string") throw new Error("loadGLTF did not return an entity");
ops.op_log(`builder: loaded glTF model as ${model}`);

// 3. A permission-denied call (player cannot scene.write).
const denied = await player.callTool({ tool: "scene.createEntity", input: { position: [0, 0, 0] } });
if (denied.success || denied.error?.code !== "forbidden") throw new Error("expected forbidden for player");

// 4. Query the constructed scene.
const queried = ok(await builder.callTool({ tool: "scene.queryEntities", input: {} }));
const entities = field(queried, "entities");
if (!Array.isArray(entities) || entities.length !== 3) throw new Error(`expected 3 entities, got ${Array.isArray(entities) ? entities.length : "n/a"}`);

// 5. Verify the trace: executions + the denial, all causally attributed.
const builderTrace = tracer.trace("agt_builder");
const executed = builderTrace.filter((e) => e.type === "skill.executed").length;
if (executed < 6) throw new Error(`expected >=6 skill.executed, got ${executed}`);
if (!tracer.trace("agt_player").some((e) => e.type === "security.permission.denied")) throw new Error("no denial event");

ops.op_log(`M9 OK: builder built a ${entities.length}-entity scene over MCP (${executed} skills), glTF loaded, permission enforced, all traced`);
