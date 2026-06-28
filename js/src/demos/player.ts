// M10 — Player demo (windowed): an autonomous player agent runs perception ->
// decision -> action in the fixed-timestep loop, pursuing the nearest target via
// physics impulses. Decisions are off-loop so frame rate is unaffected.
//
// Run: limina --window --frames 600 js/src/demos/player.ts

import * as THREE from "../../build/three.bundle.mjs";
import { createEngine, ops } from "../engine.ts";
import { Position, renderSyncSystem, syncPhysicsBodyTransform } from "../ecs/world.ts";
import { LiminaTracer } from "../observability/event.ts";
import { SkillRegistry, type WorldContext } from "../skills/registry.ts";
import { registerCoreSkills } from "../skills/index.ts";
import { resolveProfile } from "../skills/permissions.ts";
import { AgentRegistry } from "../agents/agent.ts";
import { ScriptedProvider, type DecideRequest } from "../agents/llm.ts";
import { actionSystem, decisionSystem, perceptionSystem, type ProviderMap } from "../agents/systems.ts";
import type { MCPRequest, MCPResponse } from "../mcp/protocol.ts";
import { createMaterial } from "../materials/palette.ts";

function entityId(res: MCPResponse): string {
  if (!res.success) throw new Error("call failed: " + JSON.stringify(res.error));
  const r = res.result;
  if (typeof r === "object" && r !== null && "entity" in r) {
    const rec = r as Record<string, unknown>;
    if (typeof rec.entity === "string") return rec.entity;
  }
  throw new Error("no entity id");
}

const engine = await createEngine({ width: 960, height: 640 });
const agents = new AgentRegistry();
const tracer = new LiminaTracer("ses_player");
const registry = new SkillRegistry(tracer);
registerCoreSkills(registry);

const world: WorldContext = {
  ecs: engine.world, entities: engine.entities, tags: engine.tags,
  transforms: engine.transforms, spatial: engine.spatial,
  scene: engine.scene, camera: engine.camera, ops: engine.ops, agents,
};
const setup = { agentId: "engine", sessionId: "ses_player", permissions: resolveProfile("builder.readWrite"), tick: 0, world };

// Large static playfield → procedural-PBR stone grain.
const ground = new THREE.Mesh(new THREE.BoxGeometry(40, 0.2, 40), createMaterial("stone", { pbr: true }));
ground.position.y = -0.1;
engine.scene.add(ground);
if (!(await registry.invoke("three.setLighting", { directionalIntensity: 4 }, setup)).success) throw new Error("lighting failed");

ops.op_physics_create_world(0); // no gravity: pure pursuit on the plane
ops.op_physics_add_ground(-5);

// Pursuing dynamic sphere: palette material, NO pbr (it moves; world-space noise would swim).
const player = entityId(await registry.invoke("scene.createEntity", { shape: "sphere", material: "plank", position: [0, 0.5, 0], dynamic: true }, setup));
for (const spot of [[6, 0.5, 4], [-5, 0.5, -3], [3, 0.5, -6]]) {
  // Static targets → procedural-PBR greenery.
  await registry.invoke("scene.createEntity", { shape: "box", material: "leaf", pbr: true, position: spot, dynamic: false }, setup);
}

const scripted = new ScriptedProvider((req: DecideRequest): MCPRequest[] => {
  const target = req.perception.nearby[0];
  if (target === undefined || req.perception.position === undefined || req.perception.selfEntity === undefined) return [];
  const s = req.perception.position;
  const d = [target.position[0] - s[0], 0, target.position[2] - s[2]];
  const len = Math.hypot(d[0], d[1], d[2]) || 1;
  return [{ tool: "physics.applyImpulse", input: { entity: req.perception.selfEntity, impulse: [d[0] / len * 1.2, 0, d[2] / len * 1.2] } }];
});
const providers: ProviderMap = { scripted };

agents.add({
  id: "agt_player", type: "player", entityId: player,
  perceptionRadius: 100, decisionIntervalTicks: 20, profile: "player.limited", sessionId: "ses_player",
  llm: { provider: "scripted", model: "", systemPrompt: "pursue the nearest entity" },
});

const playerBody = world.entities.resolve(player)?.bodyId ?? -1;
const playerEid = world.entities.resolve(player)?.eid ?? -1;
const transformScratch = new Float32Array(7);
let tick = 0;

function fixedStep(_dt: number): void {
  tick += 1;
  perceptionSystem(agents, world, tracer, tick);
  decisionSystem(agents, registry, providers, tracer, tick);
  void actionSystem(agents, registry, world, tick);
  ops.op_physics_step();
  syncPhysicsBodyTransform(playerEid, playerBody, ops, transformScratch);
  engine.spatial.invalidate();
  if (tick % 120 === 0) {
    const acts = tracer.trace("agt_player").filter((e) => e.type === "skill.executed").length;
    ops.op_log(`player tick ${tick}: pos=(${Position.x[playerEid].toFixed(1)}, ${Position.z[playerEid].toFixed(1)}) actions=${acts}`);
  }
}

let angle = 0;
function render(_alpha: number): void {
  angle += 0.005;
  engine.camera.position.set(Math.cos(angle) * 22, 16, Math.sin(angle) * 22);
  engine.camera.lookAt(0, 0, 0);
  renderSyncSystem(engine.world);
  engine.renderer.render(engine.scene, engine.camera);
  ops.op_surface_present(engine.context);
}

// Warm-up render: issue one frame now so the host's post-eval event-loop pump
// compiles all WebGPU pipelines while the loop is uncontended. Three compiles
// pipelines asynchronously; deferring to the first in-loop render lets the agent
// systems' per-tick promises starve that completion, leaving the surface blank.
renderSyncSystem(engine.world);
engine.renderer.render(engine.scene, engine.camera);
ops.op_surface_present(engine.context);

ops.op_set_fixed_step_callback(fixedStep);
ops.op_set_frame_callback(render);
ops.op_log("player demo ready (scripted); the agent pursues the nearest target");
