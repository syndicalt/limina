// Settlement NPCs (windowed) — the reasoning-NPC FIRST CUT, rendered. Three
// procedural humanoids are spawned at a real planVillage settlement and run on
// Engine A (perception -> decision -> action under the AgentScheduler). Here the
// brain is the deterministic ambient-social policy (a ScriptedProvider) so the demo
// is self-contained and reproducible; swap `provider` for an OllamaProvider to drive
// the same NPCs with a live local model (see js/test/m13_npc_ollama.ts).
//
// Buildings are drawn as simple massing boxes at their placements so the settlement
// reads at a glance; the NPCs walk the lane between them, greet, and remember who
// they met — the exact perception->decision->action loop, just with pixels.
//
// Run: ./target/release/limina --window --frames 1200 js/src/demos/settlement_npcs.ts

import * as THREE from "../../build/three.bundle.mjs";
import { ops } from "../engine.ts";
import { createWindowedContext } from "../game/index.ts";
import { Position, renderSyncSystem } from "../ecs/world.ts";
import { AgentRegistry } from "../agents/agent.ts";
import { ScriptedProvider } from "../agents/llm.ts";
import type { ProviderMap } from "../agents/systems.ts";
import { AgentScheduler } from "../agents/scheduler.ts";
import { createMaterial } from "../materials/palette.ts";
import { planVillage } from "../world/pipeline/village-layout.mjs";
import {
  driveNpcTick,
  makeAmbientSocialPolicy,
  spawnNpcsFromSettlement,
  type NpcSpec,
  type SettlementSpawnContext,
} from "../agents/npc.ts";

const SESSION = "ses_settlement_npcs";
const DT = 1000 / 30;

// ── Settlement layout (deterministic knoll, as in the p81 gate) ───────────────
function makeSampler() {
  const amp = 10, sigma = 40, half = 60;
  const heightAt = (x: number, z: number): number => amp * Math.exp(-(x * x + z * z) / (2 * sigma * sigma));
  const e = 1;
  const slopeAt = (x: number, z: number): number => Math.hypot(heightAt(x + e, z) - heightAt(x - e, z), heightAt(x, z + e) - heightAt(x, z - e)) / (2 * e);
  return { heightAt, slopeAt, halfSize: half, seaLevel: -2, amplitude: amp };
}
const sampler = makeSampler();
const steering = {
  buildings: [{ role: "longhall", style: "nordic", count: 1 }, { role: "cottage", style: "wattle", count: 3 }, { role: "watchtower", style: "timber", count: 1 }],
  layout: { focal: "longhall on the knoll", density: "tight" },
};
const radii = [8.5, 5.1, 5.1, 5.1, 7.0];
// deno-lint-ignore no-explicit-any
const village = (planVillage as any)(sampler, { palette: {}, mood: "weathered" }, steering, radii) as { placements: SettlementSpawnContext["placements"]; center: { x: number; z: number } };
const settlement: SettlementSpawnContext = { placements: village.placements, center: village.center };

const ctx = await createWindowedContext({
  width: 1100, height: 700, renderBaseline: { ground: { enabled: false } }, session: SESSION, agentId: "agt_settlement",
});
const engine = ctx.engine!;
engine.scene.background = new THREE.Color(0x8fb2d4);

// Ground.
const ground = new THREE.Mesh(new THREE.CircleGeometry(70, 64), createMaterial("grass", { pbr: true }));
ground.rotation.x = -Math.PI / 2;
ground.receiveShadow = true;
engine.scene.add(ground);

// Buildings as massing boxes at their placements (radius -> footprint, role -> height).
const wall = createMaterial("stone", { pbr: true });
const roof = createMaterial("wood", { pbr: true });
for (const p of village.placements) {
  const r = radii[p.index] ?? 5;
  const h = 3 + r * 0.6;
  const g = new THREE.Group();
  const box = new THREE.Mesh(new THREE.BoxGeometry(r * 1.2, h, r * 1.2), wall);
  box.position.y = h / 2;
  box.castShadow = true;
  box.receiveShadow = true;
  g.add(box);
  const top = new THREE.Mesh(new THREE.ConeGeometry(r * 0.95, h * 0.55, 4), roof);
  top.position.y = h + h * 0.27;
  top.rotation.y = Math.PI / 4;
  top.castShadow = true;
  g.add(top);
  g.position.set(p.x, sampler.heightAt(p.x, p.z), p.z);
  g.rotation.y = p.yaw;
  engine.scene.add(g);
}

// Lighting.
const sun = new THREE.DirectionalLight(0xfff0d6, 3.0);
sun.position.set(20, 34, 16);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.camera.near = 0.5; sun.shadow.camera.far = 140;
sun.shadow.camera.left = -55; sun.shadow.camera.right = 55; sun.shadow.camera.top = 55; sun.shadow.camera.bottom = -55;
engine.scene.add(sun);
engine.scene.add(new THREE.HemisphereLight(0xcfe2f5, 0x40502f, 1.1));

// ── NPCs (spawned at plots; brought onto flat ground for clean planar meetings) ─
const specs: NpcSpec[] = [
  { id: "agt_birch", persona: { name: "Birch", voice: "A gruff old warden." }, spawn: { plot: 1 }, perceptionRadius: 60, actionProfile: "npc.bundle", model: { provider: "scripted", model: "" }, cadence: 4, speed: 2.6, color: 0xd9b47a },
  { id: "agt_willow", persona: { name: "Willow", voice: "A gentle herbalist." }, spawn: { plot: 2 }, perceptionRadius: 60, actionProfile: "npc.bundle", model: { provider: "scripted", model: "" }, cadence: 4, speed: 2.6, color: 0x8fd6c0 },
  { id: "agt_rowan", persona: { name: "Rowan", voice: "A restless young lookout." }, spawn: { plot: 4 }, perceptionRadius: 60, actionProfile: "npc.bundle", model: { provider: "scripted", model: "" }, cadence: 4, speed: 2.6, color: 0xe88f8f },
];
const agents = new AgentRegistry();
const spawned = spawnNpcsFromSettlement(ctx, agents, specs, settlement);
const nameByAgentId = Object.fromEntries(specs.map((s) => [s.id, s.persona.name]));
const provider = new ScriptedProvider(makeAmbientSocialPolicy({ talkDistance: 2.2, nameByAgentId }));
const providers: ProviderMap = { scripted: provider };
const scheduler = new AgentScheduler({
  defaultAgentBudget: { weight: 1, maxQueueDepth: 8, maxToolCallsPerDecision: 4, maxActionsPerTick: 2, decisionTimeoutMs: Number.POSITIVE_INFINITY },
});

// Camera: an elevated three-quarter view framing the settlement center.
const c = village.center;
engine.camera.position.set(c.x + 26, 26, c.z + 34);
engine.camera.lookAt(c.x, 2, c.z);
engine.camera.updateMatrixWorld(true);

let tick = 0;
function fixedStep(_dt: number): void {
  tick += 1;
  void driveNpcTick({ ctx, agents, providers, scheduler, tracer: ctx.tracer, tick, dtMs: DT });
}

let a = 0;
function render(_alpha: number): void {
  a += 0.0016;
  engine.camera.position.set(c.x + Math.cos(a) * 30, 24, c.z + Math.sin(a) * 38);
  engine.camera.lookAt(c.x, 2.5, c.z);
  renderSyncSystem(engine.world);
  ctx.core.ui.update(engine.camera, engine.width, engine.height, DT);
  engine.renderer.render(engine.scene, engine.camera);
  ops.op_surface_present(engine.context);
}

// Warm-up frame (compile pipelines before the loop; avoids the blank first frame).
renderSyncSystem(engine.world);
engine.renderer.render(engine.scene, engine.camera);
ops.op_surface_present(engine.context);

ops.op_set_fixed_step_callback(fixedStep);
ops.op_set_frame_callback(render);
ops.op_log(`settlement_npcs ready: ${spawned.length} reasoning NPCs on Engine A in a ${village.placements.length}-building settlement (scripted ambient policy; swap to OllamaProvider for live model).`);
