// Phase 3 showcase (windowed): textured glTF, bound MCP builder sessions,
// in-world Agent Players, scheduler budgets, physics sync, and trace/devtools
// evidence in one graphical scene.
//
// Run: limina --window --frames 900 js/src/demos/phase3_showcase.ts

import * as THREE from "../../build/three.bundle.mjs";
import { ops } from "../engine.ts";
import { createWindowedContext } from "../game/index.ts";
import { Position, renderSyncSystem, Rotation, syncPhysicsBodyTransform } from "../ecs/world.ts";
import { AgentRegistry } from "../agents/agent.ts";
import { actionSystem, decisionSystem, perceptionSystem, type ProviderMap } from "../agents/systems.ts";
import { Mcp, StdioMcpTransport } from "../mcp/mcp.ts";
import type { JsonRpcResponse, MCPResponse } from "../mcp/protocol.ts";
import { resolveProfile } from "../skills/permissions.ts";
import { type WorldContext } from "../skills/registry.ts";
import { createMaterial } from "../materials/palette.ts";
import {
  arenaReturnImpulse,
  createShowcaseScheduler,
  percentile,
  ShowcaseProvider,
  sumQueues,
} from "./phase3_showcase_core.ts";

interface BodyBinding {
  entity: string;
  eid: number;
  bodyId: number;
}

interface Trail {
  eid: number;
  inst: THREE.InstancedMesh;
  scales: number[];
  cursor: number;
}

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function asRecord(value: unknown): Record<string, unknown> {
  assert(typeof value === "object" && value !== null, "expected object");
  return value as Record<string, unknown>;
}

function ok(res: MCPResponse): unknown {
  if (!res.success) throw new Error("skill call failed: " + JSON.stringify(res.error));
  return res.result;
}

function entityId(res: MCPResponse): string {
  const result = asRecord(ok(res));
  assert(typeof result.entity === "string", "missing entity id");
  return result.entity;
}

function bindBody(world: WorldContext, entity: string): BodyBinding {
  const entry = world.entities.resolve(entity);
  assert(entry !== undefined, `missing entity ${entity}`);
  assert(entry.bodyId !== undefined, `entity ${entity} has no physics body`);
  return { entity, eid: entry.eid, bodyId: entry.bodyId };
}

const agents = new AgentRegistry();
const ctx = await createWindowedContext({
  width: 1120,
  height: 720,
  renderBaseline: { ground: { enabled: false } },
  session: "ses_p3_showcase",
  agentId: "engine_showcase",
  agents,
});
const engine = ctx.engine!;
const registry = ctx.registry;
const tracer = ctx.tracer;
const world = ctx.world;
const setup = ctx.base;
const readonly = { agentId: "inspector_showcase", sessionId: "ses_p3_showcase", permissions: resolveProfile("system.readonly"), tick: 0, world: ctx.world };

ops.op_physics_create_world(-9.81);
ops.op_physics_add_ground(0);

engine.scene.background = new THREE.Color(0x081018);
// Large static arena floor → procedural-PBR stone grain.
const ground = new THREE.Mesh(
  new THREE.BoxGeometry(42, 0.12, 42),
  createMaterial("stone", { pbr: true }),
);
ground.position.y = -0.06;
engine.scene.add(ground);
engine.scene.add(new THREE.GridHelper(42, 28, 0x2dd4bf, 0x1f2937));

const centerpieceRing = new THREE.Mesh(
  new THREE.TorusGeometry(2.6, 0.035, 8, 96),
  new THREE.MeshStandardNodeMaterial({ color: 0x67e8f9, roughness: 0.25, metalness: 0.4 }),
);
centerpieceRing.position.set(0, 0.08, 0);
centerpieceRing.rotation.x = Math.PI / 2;
engine.scene.add(centerpieceRing);

await registry.invoke("three.setLighting", {
  ambientColor: 0x8fd3ff,
  ambientIntensity: 1.6,
  directionalColor: 0xffffff,
  directionalIntensity: 4.2,
  direction: [7, 12, 5],
}, setup);

const gltf = asRecord(ok(await registry.invoke("three.loadGLTF", {
  assetId: "textured-triangle.gltf",
  position: [-1.4, 1.2, 0],
}, setup)));
const gltfEntity = gltf.entity;
assert(typeof gltfEntity === "string", "showcase glTF did not return entity");
await registry.invoke("three.setTransform", {
  entity: gltfEntity,
  scale: [3, 3, 3],
  rotationEuler: [0, 0.25, 0],
}, setup);

const bodyBindings: BodyBinding[] = [];
const targetPositions: [number, number, number][] = [
  [7, 0.42, 5],
  [-7, 0.42, 5],
  [7, 0.42, -5],
  [-7, 0.42, -5],
  [0, 0.42, 8],
  [0, 0.42, -8],
];
const targetEntities: string[] = [];

for (let i = 0; i < targetPositions.length; i++) {
  const entity = entityId(await registry.invoke("scene.createEntity", {
    shape: "box",
    size: 0.8,
    // Static targets → procedural-PBR palette (alternating greenery / water).
    material: i % 2 === 0 ? "grass" : "water",
    pbr: true,
    position: targetPositions[i],
    static: true,
    collider: "box",
    friction: 0.8,
  }, setup));
  const entry = world.entities.resolve(entity);
  if (entry !== undefined) world.tags.set(entry.eid, new Set(["showcase.target"]));
  targetEntities.push(entity);

  const beacon = new THREE.Mesh(
    new THREE.CylinderGeometry(0.08, 0.16, 3.2, 16),
    new THREE.MeshStandardNodeMaterial({ color: i % 2 === 0 ? 0x2dd4bf : 0x60a5fa, roughness: 0.2, metalness: 0.2 }),
  );
  beacon.position.set(targetPositions[i][0], 1.85, targetPositions[i][2]);
  engine.scene.add(beacon);
  const ring = new THREE.Mesh(
    new THREE.TorusGeometry(0.9, 0.035, 8, 48),
    new THREE.MeshStandardNodeMaterial({ color: i % 2 === 0 ? 0xa7f3d0 : 0xbfdbfe, roughness: 0.25, metalness: 0.3 }),
  );
  ring.position.set(targetPositions[i][0], 0.12, targetPositions[i][2]);
  ring.rotation.x = Math.PI / 2;
  engine.scene.add(ring);
}

for (const wall of [
  { position: [0, 1.2, 12] as [number, number, number], scale: [24, 2.4, 0.35] as [number, number, number] },
  { position: [0, 1.2, -12] as [number, number, number], scale: [24, 2.4, 0.35] as [number, number, number] },
  { position: [12, 1.2, 0] as [number, number, number], scale: [0.35, 2.4, 24] as [number, number, number] },
  { position: [-12, 1.2, 0] as [number, number, number], scale: [0.35, 2.4, 24] as [number, number, number] },
]) {
  // Large static perimeter walls → procedural-PBR stone grain.
  const barrier = new THREE.Mesh(
    new THREE.BoxGeometry(wall.scale[0], wall.scale[1], wall.scale[2]),
    createMaterial("stone", { pbr: true }),
  );
  barrier.position.set(wall.position[0], wall.position[1], wall.position[2]);
  engine.scene.add(barrier);
  ops.op_physics_add_static_box(
    wall.position[0],
    wall.position[1],
    wall.position[2],
    wall.scale[0] / 2,
    wall.scale[1] / 2,
    wall.scale[2] / 2,
    0.9,
    0.05,
  );
}

const mcp = new Mcp(registry, world);
const builderWrites: string[][] = [];
const builders = Array.from({ length: 3 }, (_unused, index) => {
  const writes: string[] = [];
  builderWrites.push(writes);
  return new StdioMcpTransport(mcp, (line) => writes.push(line));
});

async function builderRequest(builderIndex: number, id: number, method: string, params: Record<string, unknown>): Promise<JsonRpcResponse> {
  const writes = builderWrites[builderIndex];
  const before = writes.length;
  await builders[builderIndex].handleLine(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
  assert(writes.length === before + 1, `builder ${builderIndex} emitted unexpected response count`);
  return JSON.parse(writes[writes.length - 1]) as JsonRpcResponse;
}

const mcpBoundaryMs: number[] = [];
for (let i = 0; i < builders.length; i++) {
  const init = await builderRequest(i, 1, "initialize", {
    agentId: `agt_showcase_builder_${i}`,
    sessionId: `ses_showcase_builder_${i}`,
    profile: "builder.readWrite",
  });
  assert(init.result !== undefined, `builder ${i} initialize failed`);
}

for (let round = 0; round < 3; round++) {
  await Promise.all(builders.map(async (_builder, i) => {
    const start = Date.now();
    const response = await builderRequest(i, 10 + round, "tools/call", {
      name: "scene.createEntity",
      arguments: {
        shape: round % 2 === 0 ? "box" : "sphere",
        size: 0.65,
        color: 0xf59e0b + i * 0x1900 + round * 0x33,
        position: [i * 2.8 - 2.8, 0.7, round * 2.2 - 2.2],
        dynamic: round === 2,
        collider: round === 1 ? "sphere" : "box",
        friction: 0.5,
        restitution: 0.1,
      },
      context: { agentId: "agt_spoofed_showcase", sessionId: "ses_spoofed_showcase" },
    });
    mcpBoundaryMs.push(Date.now() - start);
    const result = asRecord(response.result);
    assert(result.success === true, `builder ${i} createEntity failed`);
    const created = asRecord(result.result).entity;
    assert(typeof created === "string", "builder entity id missing");
    const entry = world.entities.resolve(created);
    if (entry !== undefined) world.tags.set(entry.eid, new Set(["showcase.builder"]));
    if (entry?.bodyId !== undefined) bodyBindings.push(bindBody(world, created));
  }));
}
assert(tracer.trace("agt_spoofed_showcase").length === 0, "showcase MCP context spoof reached tracer");

const playerColors = [0xff8c1a, 0xf43f5e, 0xa855f7, 0x06b6d4, 0xeab308, 0x84cc16, 0xfb7185, 0x60a5fa, 0xf97316, 0x14b8a6, 0xc084fc, 0xfacc15];
const trails: Trail[] = [];
// Shared unit-sphere geometry for all 120 trail markers; per-instance scale
// reproduces the original taper, per-player material the original color. One
// InstancedMesh per player collapses 120 trail draw calls to 12.
const trailGeo = new THREE.SphereGeometry(1, 12, 8);
const trailScales = Array.from({ length: 10 }, (_unused, dotIndex) => 0.08 - dotIndex * 0.004);
const trailMatrix = new THREE.Matrix4();
for (let i = 0; i < playerColors.length; i++) {
  const angle = i / playerColors.length * Math.PI * 2;
  const entity = entityId(await registry.invoke("scene.createEntity", {
    shape: "sphere",
    size: 0.55,
    color: playerColors[i],
    position: [Math.cos(angle) * 4, 0.55, Math.sin(angle) * 4],
    dynamic: true,
    collider: "sphere",
    friction: 1.2,
    restitution: 0.05,
  }, setup));
  const binding = bindBody(world, entity);
  bodyBindings.push(binding);
  const inst = new THREE.InstancedMesh(
    trailGeo,
    new THREE.MeshStandardNodeMaterial({ color: playerColors[i], roughness: 0.35, metalness: 0.15 }),
    trailScales.length,
  );
  for (let dotIndex = 0; dotIndex < trailScales.length; dotIndex++) {
    const r = trailScales[dotIndex];
    trailMatrix.makeScale(r, r, r);
    trailMatrix.setPosition(Math.cos(angle) * 4, 0.12, Math.sin(angle) * 4);
    inst.setMatrixAt(dotIndex, trailMatrix);
  }
  inst.instanceMatrix.needsUpdate = true;
  engine.scene.add(inst);
  trails.push({ eid: binding.eid, inst, scales: trailScales, cursor: 0 });
  agents.add({
    id: `agt_showcase_player_${String(i).padStart(2, "0")}`,
    type: "player",
    entityId: entity,
    perceptionRadius: 18,
    decisionIntervalTicks: 6 + (i % 3) * 3,
    profile: "player.limited",
    sessionId: "ses_p3_showcase",
    llm: { provider: "showcase", model: "scripted", systemPrompt: "move toward visible anchors while respecting scheduler budgets" },
  });
}

const provider = new ShowcaseProvider({
  latencyEvery: 4,
  targetEntityIds: targetEntities,
  impulseStrength: 0.14,
  arrivalRadius: 1.2,
});
const providers: ProviderMap = { showcase: provider };
const scheduler = createShowcaseScheduler();
const frameStepMs: number[] = [];
const frameWallMs: number[] = [];
const renderMs: number[] = [];
let lastFrameAt = 0;
const queueDepthSamples: number[] = [];
const scratch = new Float32Array(7);
let tick = 0;
let cameraAngle = 0;
let lastLogTick = 0;
let gltfSpin = 0;
const gltfQuat = new THREE.Quaternion();
const gltfEuler = new THREE.Euler();

function maxPlayerRadius(): number {
  let max = 0;
  for (const agent of agents.all()) {
    if (agent.entityId === undefined) continue;
    const entry = world.entities.resolve(agent.entityId);
    if (entry === undefined) continue;
    max = Math.max(max, Math.hypot(Position.x[entry.eid], Position.z[entry.eid]));
  }
  return max;
}

function updateTrails(): void {
  if (tick % 8 !== 0) return;
  for (const trail of trails) {
    const r = trail.scales[trail.cursor];
    trailMatrix.makeScale(r, r, r);
    trailMatrix.setPosition(Position.x[trail.eid], 0.16, Position.z[trail.eid]);
    trail.inst.setMatrixAt(trail.cursor, trailMatrix);
    trail.inst.instanceMatrix.needsUpdate = true;
    trail.cursor = (trail.cursor + 1) % trail.scales.length;
  }
}

async function logShowcaseMetrics(label: string): Promise<void> {
  const snapshot = asRecord(ok(await registry.invoke("inspector.snapshot", { limit: 16 }, readonly)));
  const page = asRecord(snapshot.page);
  const resources = asRecord(snapshot.resources);
  const counts = asRecord(resources.counts);
  const actionTail = asRecord(ok(await registry.invoke("trace.tail", { type: "agent.action.executed", limit: 500 }, readonly)));
  const backpressureTail = asRecord(ok(await registry.invoke("trace.tail", { type: "agent.backpressure.applied", limit: 500 }, readonly)));
  const metrics = {
    label,
    tick,
    entities: page.totalEntities,
    players: agents.all().length,
    builderSessions: builders.length,
    resources: counts,
    p95: {
      frameStepMs: percentile(frameStepMs, 95),
      frameWallMs: percentile(frameWallMs, 95),
      renderMs: percentile(renderMs, 95),
      decisionMs: percentile(provider.decisionLatenciesMs, 95),
      queueDepth: percentile(queueDepthSamples, 95),
      mcpBoundaryMs: percentile(mcpBoundaryMs, 95),
    },
    frame: {
      meanWallMs: Number((frameWallMs.reduce((a, b) => a + b, 0) / Math.max(1, frameWallMs.length)).toFixed(2)),
      meanRenderMs: Number((renderMs.reduce((a, b) => a + b, 0) / Math.max(1, renderMs.length)).toFixed(2)),
      p99WallMs: percentile(frameWallMs, 99),
      samples: frameWallMs.length,
      over16: frameWallMs.filter((ms) => ms > 16).length,
      over20: frameWallMs.filter((ms) => ms > 20).length,
      pctOver16: Number((100 * frameWallMs.filter((ms) => ms > 16).length / Math.max(1, frameWallMs.length)).toFixed(1)),
    },
    trace: {
      actions: (actionTail.events as unknown[]).length,
      backpressure: (backpressureTail.events as unknown[]).length,
    },
    queueDepth: sumQueues(agents),
    maxPlayerRadius: Number(maxPlayerRadius().toFixed(2)),
  };
  ops.op_log("P3 showcase metrics " + JSON.stringify(metrics));
}

function fixedStep(_dt: number): void {
  tick += 1;
  mcp.setTick(tick);
  readonly.tick = tick;
  const start = Date.now();
  perceptionSystem(agents, world, tracer, tick);
  decisionSystem(agents, registry, providers, tracer, tick, scheduler);
  void actionSystem(agents, registry, world, tick, scheduler);
  ops.op_physics_step();
  for (const binding of bodyBindings) {
    syncPhysicsBodyTransform(binding.eid, binding.bodyId, ops, scratch);
    const correction = arenaReturnImpulse(Position.x[binding.eid], Position.z[binding.eid]);
    if (correction !== undefined) {
      ops.op_physics_apply_impulse(binding.bodyId, correction[0], correction[1], correction[2]);
    }
  }
  updateTrails();
  engine.spatial.invalidate();
  queueDepthSamples.push(sumQueues(agents));
  frameStepMs.push(Date.now() - start);

  if (tick - lastLogTick >= 120) {
    lastLogTick = tick;
    void logShowcaseMetrics("live");
  }
}

function render(_alpha: number): void {
  const frameNow = Date.now();
  if (lastFrameAt !== 0) frameWallMs.push(frameNow - lastFrameAt);
  lastFrameAt = frameNow;
  cameraAngle += 0.004;
  gltfSpin += 0.012;
  gltfEuler.set(0, gltfSpin, Math.sin(gltfSpin * 0.5) * 0.18);
  gltfQuat.setFromEuler(gltfEuler);
  const gltfEntry = world.entities.resolve(gltfEntity);
  if (gltfEntry !== undefined) {
    Rotation.x[gltfEntry.eid] = gltfQuat.x;
    Rotation.y[gltfEntry.eid] = gltfQuat.y;
    Rotation.z[gltfEntry.eid] = gltfQuat.z;
    Rotation.w[gltfEntry.eid] = gltfQuat.w;
  }
  centerpieceRing.rotation.z += 0.006;
  engine.camera.position.set(Math.cos(cameraAngle) * 18, 10 + Math.sin(cameraAngle * 1.7) * 2, Math.sin(cameraAngle) * 18);
  engine.camera.lookAt(0, 0.8, 0);
  const renderStart = Date.now();
  renderSyncSystem(engine.world);
  engine.renderer.render(engine.scene, engine.camera);
  ops.op_surface_present(engine.context);
  renderMs.push(Date.now() - renderStart);
}

function onResize(w: number, h: number): void {
  ops.op_surface_resize(w, h);
  engine.renderer.setSize(w, h, false);
  engine.camera.aspect = w / h;
  engine.camera.updateProjectionMatrix();
}

renderSyncSystem(engine.world);
engine.camera.position.set(18, 12, 18);
engine.camera.lookAt(0, 0.8, 0);
engine.renderer.render(engine.scene, engine.camera);
ops.op_surface_present(engine.context);
await logShowcaseMetrics("initial");

ops.op_set_fixed_step_callback(fixedStep);
ops.op_set_frame_callback(render);
ops.op_set_resize_callback(onResize);
ops.op_log("P3 showcase ready: textured glTF, MCP builders, Agent Players, scheduler budgets, physics sync, trace/devtools");
