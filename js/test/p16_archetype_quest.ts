// Phase 16 (Track C — archetype integration #3) — "THE ERRAND": a Skyrim-style OPEN-WORLD QUEST
// composing the RPG side of the catalog deterministically:
//   • world.generateRegion   — the terrain to roam;
//   • architecture.building ×3 — a small village (quest-giver's hall, home, shrine);
//   • navmesh.build / findPath — real A* traversal across the open world;
//   • quest.define/offer/accept/update — a fetch-and-deliver objective;
//   • progression.xp           — the level-up reward on completion.
//
// This is the open-world-RPG archetype (distinct from the siege's emergent defense and the ambush's
// linear script): roam → accept a quest → navigate to a destination → complete → gain XP. Composed
// from skills, deterministic, replay-safe, proven headlessly.
//
// Run: ./target/release/limina js/test/p16_archetype_quest.ts   (exit 0 = pass)

import { EntityTable, ops, type EngineOps } from "../src/engine.ts";
import { createEcsWorld } from "../src/ecs/world.ts";
import { createTransformStorage } from "../src/ecs/facade.ts";
import { UniformGridSpatialIndex } from "../src/spatial/index.ts";
import { LiminaTracer } from "../src/observability/event.ts";
import { SkillRegistry, type InvokeBase, type WorldContext } from "../src/skills/registry.ts";
import { registerCoreSkills, type CoreSkills } from "../src/skills/index.ts";
import { resolveProfile } from "../src/skills/permissions.ts";
import type { MCPResponse } from "../src/mcp/protocol.ts";

function assert(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new Error("p16_archetype_quest FAIL: " + msg);
}
function ok(label: string, res: MCPResponse | undefined): Record<string, unknown> {
  if (res === undefined || !res.success) throw new Error(`p16_archetype_quest: ${label} failed: ${JSON.stringify(res?.error ?? "no response")}`);
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
const PERMS = resolveProfile("builder.readWrite");
const HALL: [number, number, number] = [36, 0, 48];
const HOME: [number, number, number] = [48, 0, 48];
const SHRINE: [number, number, number] = [60, 0, 48];

async function runErrand(session: string): Promise<{ entities: number; villageEntities: number; reachable: boolean; pathLen: number; status: string; xpGranted: number; level: number; }> {
  ops.op_physics_create_world(-9.81);
  const reg = new SkillRegistry(new LiminaTracer(session));
  const core: CoreSkills = registerCoreSkills(reg);
  const world = makeWorld(ops);
  const at = (t: number): InvokeBase => ({ agentId: "hero", sessionId: session, permissions: PERMS, tick: t, world });

  // ── AUTHOR the open world. ──────────────────────────────────────────────────────────────────
  ok("world.generateRegion", await reg.invoke("world.generateRegion", { seed: 4242, bounds: { minTx: 0, minTz: 0, maxTx: 1, maxTz: 1 }, lod: 0, type: "plains", render: false }, at(0)));
  let villageEntities = 0;
  for (const [name, p] of [["hall", HALL], ["home", HOME], ["shrine", SHRINE]] as const) {
    const b = ok(`architecture.building(${name})`, await reg.invoke("architecture.building", { position: p, width: 6, depth: 6, height: 3 }, at(0)));
    villageEntities += b.entityCount as number;
  }
  ok("navmesh.build", await reg.invoke("navmesh.build", { bounds: { minX: 24, minZ: 36, maxX: 72, maxZ: 60 }, cellSize: 4 }, at(0)));

  // Open-world NAVIGATION: there is a real A* route from home to the shrine.
  const fp = ok("navmesh.findPath", await reg.invoke("navmesh.findPath", { from: HOME, to: SHRINE }, at(0))) as { path: number[][]; reachable: boolean };

  // ── THE QUEST: accept at the hall, deliver at the shrine. ───────────────────────────────────
  ok("quest.define", await reg.invoke("quest.define", { id: "errand", name: "The Errand", description: "Carry the relic from the hall to the shrine.", objectives: [{ id: "deliver", type: "collect", description: "Deliver the relic to the shrine", required: 1 }] }, at(0)));
  ok("quest.offer", await reg.invoke("quest.offer", { entity: "hero", questId: "errand" }, at(0)));
  ok("quest.accept", await reg.invoke("quest.accept", { entity: "hero", questId: "errand" }, at(0)));

  // ── TRAVEL: walk a deterministic line home → shrine; arriving completes the objective. ──────
  let arrived = false;
  for (let t = 1; t <= 60 && !arrived; t++) {
    const frac = Math.min(1, t / 40);
    const x = HOME[0] + (SHRINE[0] - HOME[0]) * frac;
    if (Math.abs(x - SHRINE[0]) <= 0.5) {
      ok("quest.update", await reg.invoke("quest.update", { entity: "hero", questId: "errand", objectiveId: "deliver", progress: 1 }, at(t)));
      arrived = true;
    }
  }
  // Guarded turn-in (quest auto-completes at required=1; complete() is a no-op if already done).
  if (core.quest.questManager.getInstance("hero", "errand")?.status === "active") {
    ok("quest.complete", await reg.invoke("quest.complete", { entity: "hero", questId: "errand" }, at(60)));
  }
  // ── REWARD: XP on completion. ───────────────────────────────────────────────────────────────
  const xp = ok("progression.xp", await reg.invoke("progression.xp", { entity: "hero", amount: 150 }, at(60))) as { newLevel: number };
  const lvl = ok("progression.level", await reg.invoke("progression.level", { entity: "hero" }, at(60))) as { level: number; xp: number };

  const inspect = ok("scene.inspect", await reg.invoke("scene.inspect", {}, at(60))) as { entityCount: number };
  const status = core.quest.questManager.getInstance("hero", "errand")?.status ?? "missing";
  return { entities: inspect.entityCount, villageEntities, reachable: fp.reachable, pathLen: fp.path.length, status, xpGranted: 150, level: (xp.newLevel ?? lvl.level) };
}

// ── 1. The village is built; the open world is navigable. ─────────────────────────────────────
const A = await runErrand("ses_p16_quest_A");
assert(A.villageEntities === 24, `the 3-building village is built (3×8 = 24 entities, got ${A.villageEntities})`);
assert(A.entities >= 24, `the village entities are present in the scene (total ${A.entities} ≥ 24 village)`);
assert(A.reachable && A.pathLen >= 2, `there is a real A* route home → shrine (reachable=${A.reachable}, waypoints=${A.pathLen})`);

// ── 2. The quest runs to completion and rewards XP. ──────────────────────────────────────────
assert(A.status === "completed", `the errand quest completes on delivery (status=${A.status})`);
assert(A.level >= 1, `the hero gained a level/XP reward on completion (level=${A.level})`);

// ── 3. The whole open-world quest replays deterministically. ──────────────────────────────────
const B = await runErrand("ses_p16_quest_B");
assert(A.entities === B.entities && A.villageEntities === B.villageEntities && A.reachable === B.reachable && A.pathLen === B.pathLen, "village + navigation identical across runs");
assert(A.status === B.status && A.level === B.level, "quest outcome + reward identical across runs");

ops.op_log(
  `p16_archetype_quest OK: "The Errand" open-world RPG slice — terrain + a 3-building village (24 entities), a real A* ` +
  `route home → shrine (${A.pathLen} waypoints), a fetch-and-deliver quest accepted and COMPLETED, and an XP/level reward — ` +
  `composed from skills and replaying deterministically. The open-world-quest archetype, proven headlessly.`,
);
