// Phase 3 visual/devtools foundation: inspector snapshots expose bounded world
// state and loaded-resource metadata, reload requests are traceable, and trace
// query skills can explain an agent decision that led to a denied action.

import { EntityTable, ops } from "../src/engine.ts";
import { createEcsWorld } from "../src/ecs/world.ts";
import { AgentRegistry } from "../src/agents/agent.ts";
import { ScriptedProvider } from "../src/agents/llm.ts";
import { runBoundedMultiTurn } from "../src/agents/systems.ts";
import { LiminaTracer } from "../src/observability/event.ts";
import { registerCoreSkills } from "../src/skills/index.ts";
import { resolveProfile } from "../src/skills/permissions.ts";
import { SkillRegistry, type WorldContext } from "../src/skills/registry.ts";
import type { MCPResponse } from "../src/mcp/protocol.ts";

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function ok(res: MCPResponse): unknown {
  if (!res.success) throw new Error("call failed: " + JSON.stringify(res.error));
  return res.result;
}

function field(value: unknown, key: string): unknown {
  if (typeof value === "object" && value !== null && key in value) return (value as Record<string, unknown>)[key];
  return undefined;
}

function asRecord(value: unknown): Record<string, unknown> {
  assert(typeof value === "object" && value !== null, "expected object");
  return value as Record<string, unknown>;
}

const scene = { add() {}, remove() {}, position: { set() {}, x: 0, y: 0, z: 0 }, background: null as unknown };
const camera = { position: { set() {} }, aspect: 1, lookAt() {}, updateProjectionMatrix() {} };
const agents = new AgentRegistry();
const world: WorldContext = {
  ecs: createEcsWorld(),
  entities: new EntityTable(),
  tags: new Map(),
  scene,
  camera,
  ops,
  agents,
  mode: "headless",
};

ops.op_physics_create_world(0);

const tracer = new LiminaTracer("ses_p3_visual");
const registry = new SkillRegistry(tracer);
registerCoreSkills(registry);

// Register a real scene builder so dev.reload(target:"scene") re-runs it (and we
// can assert it actually ran) instead of emitting a no-op "requested" event.
let sceneBuilds = 0;
registry.registerSceneBuilder("main", (ctx) => {
  sceneBuilds += 1;
  return { scene: "main", entities: ctx.world.entities.ids().length, builds: sceneBuilds };
});

const builder = { agentId: "agt_builder", sessionId: "ses_p3_visual", permissions: resolveProfile("builder.readWrite"), tick: 0, world };
const debuggerCtx = { agentId: "agt_debugger", sessionId: "ses_p3_visual", permissions: resolveProfile("system.readonly"), tick: 0, world };

const firstEntity = field(ok(await registry.invoke("scene.createEntity", {
  position: [0, 1, 0],
  dynamic: true,
  collider: "sphere",
  color: 0x77ccff,
}, builder)), "entity");
const secondEntity = field(ok(await registry.invoke("scene.createEntity", {
  position: [3, 1, 0],
  static: true,
  size: 2,
}, builder)), "entity");
assert(typeof firstEntity === "string" && typeof secondEntity === "string", "entity setup failed");
ok(await registry.invoke("ecs.addComponent", { entity: firstEntity, component: "player" }, builder));

const gltf = asRecord(ok(await registry.invoke("three.loadGLTF", { assetId: "triangle.glb", position: [0, 0, 2] }, builder)));
const gltfEntity = field(gltf, "entity");
const gltfResource = asRecord(field(gltf, "resource"));
assert(typeof gltfEntity === "string", "three.loadGLTF did not return an entity");
assert(gltfResource.assetId === "triangle.glb", "GLTF resource asset id missing");
assert(typeof gltfResource.bytes === "number" && gltfResource.bytes > 0, "GLTF resource bytes missing");
assert(typeof gltfResource.objectCount === "number" && gltfResource.objectCount > 0, "GLTF object count missing");

agents.add({
  id: "agt_denied",
  type: "player",
  entityId: firstEntity,
  perceptionRadius: 20,
  decisionIntervalTicks: 1,
  profile: "player.limited",
  sessionId: "ses_p3_visual",
  llm: { provider: "scripted", model: "", systemPrompt: "try to build despite limited permissions" },
});

const provider = new ScriptedProvider(() => [{
  tool: "scene.createEntity",
  input: { position: [9, 9, 9] },
}]);
const multiTurn = await runBoundedMultiTurn(
  agents.get("agt_denied")!,
  registry,
  { scripted: provider },
  world,
  tracer,
  { startTick: 10, maxSteps: 1, maxToolCalls: 1, timeoutMs: 250 },
);
assert(multiTurn.toolCalls === 1, "denied action should still count as an attempted tool call");

const snapshotResult = asRecord(ok(await registry.invoke("inspector.snapshot", { limit: 2 }, debuggerCtx)));
const page = asRecord(snapshotResult.page);
assert(page.totalEntities === 3, "snapshot should count all entities");
assert(typeof page.nextAfterEntity === "string", "snapshot should paginate entities");
const entities = snapshotResult.entities as unknown[];
assert(entities.length === 2, "snapshot page should respect limit");
const firstSnap = asRecord(entities[0]);
const transform = asRecord(firstSnap.transform);
assert(Array.isArray(transform.position) && transform.position[1] === 1, "snapshot transform missing");
assert(Array.isArray(firstSnap.tags) && firstSnap.tags.includes("player"), "snapshot tags missing");
assert(typeof asRecord(firstSnap.physics).bodyId === "number", "snapshot physics body id missing");
const resources = asRecord(snapshotResult.resources);
const counts = asRecord(resources.counts);
assert(counts.total === 1 && counts.gltf === 1, "snapshot resource counts wrong");
assert((resources.loaded as unknown[]).some((r) => asRecord(r).assetId === "triangle.glb"), "snapshot resource metadata missing");
const skills = snapshotResult.skills as unknown[];
assert(skills.some((s) => asRecord(s).name === "inspector.snapshot"), "snapshot should include skill metadata");
const snapAgents = snapshotResult.agents as unknown[];
assert(snapAgents.some((a) => asRecord(a).id === "agt_denied" && asRecord(a).profile === "player.limited"), "snapshot agents missing");
assert(asRecord(snapshotResult.world).mode === "headless", "snapshot world mode should be honest in tests");

const nextSnapshot = asRecord(ok(await registry.invoke("inspector.snapshot", { afterEntity: page.nextAfterEntity, limit: 10 }, debuggerCtx)));
assert((nextSnapshot.entities as unknown[]).length === 1, "snapshot second page wrong");

const sceneReload = asRecord(ok(await registry.invoke("dev.reload", { target: "scene", reason: "test scene asset refresh" }, debuggerCtx)));
assert(sceneReload.ok === true, "scene reload should succeed when a builder is registered");
assert(sceneBuilds === 1, "dev.reload(scene) must actually re-run the registered scene builder");
assert(tracer.trace("agt_debugger").some((e) => e.type === "dev.scene.reload.completed"), "dev scene reload completed event missing");

const deniedEvent = tracer.trace("agt_denied").find((e) => e.type === "security.permission.denied");
const toolResult = tracer.trace("agt_denied").find((e) => e.type === "agent.tool_result");
assert(deniedEvent !== undefined && toolResult !== undefined, "denied action trace missing");
const tail = asRecord(ok(await registry.invoke("trace.tail", { actorId: "agt_denied", limit: 10 }, debuggerCtx)));
assert((tail.events as unknown[]).length >= 4, "trace.tail did not return denied-agent events");
const explain = asRecord(ok(await registry.invoke("trace.explainEvent", { eventId: toolResult.id }, debuggerCtx)));
const parents = explain.parents as unknown[];
assert(parents.some((p) => asRecord(p).type === "agent.decision.made"), "tool result should explain decision parent");
assert(parents.some((p) => asRecord(p).type === "security.permission.denied"), "tool result should explain denial parent");

ok(await registry.invoke("scene.destroyEntity", { entity: gltfEntity }, builder));
assert(tracer.trace("agt_builder").some((e) => e.type === "resource.unloaded"), "resource unload event missing");

ops.op_log("P3 visual/devtools OK: inspector snapshot, GLTF metadata, reload events, trace tail/explain denied action");
