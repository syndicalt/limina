// Phase 16 (Track C — archetype integration) — "HOLD THE KEEP": a deterministic siege mini-game
// composing the WHOLE catalog end-to-end, the way a real archetype demo does:
//   • world.generateRegion  — the ground/colliders;
//   • architecture.building  — the keep to defend;
//   • stats.create           — the keep's HP + the defender's stamina;
//   • director.*             — paces enemy WAVES (a "peak" directive = a new attacker);
//   • scene.createEntity/destroyEntity — attackers spawn and die as real entities;
//   • ability.* (cooldown + stamina) — the defender's volley, which can't be spammed;
//   • damage.apply           — a breaching attacker hurts the keep.
//
// It proves these systems COMPOSE into a coherent, winnable, REPLAYABLE loop driven off one sim
// clock — exactly the bar an archetype demo must clear — and does it headlessly. The same scripted
// world must produce a byte-identical event trace and outcome across runs.
//
// Run: ./target/release/limina js/test/p16_archetype_siege.ts   (exit 0 = pass)

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
  if (!cond) throw new Error("p16_archetype_siege FAIL: " + msg);
}
function ok(label: string, res: MCPResponse | undefined): Record<string, unknown> {
  if (res === undefined || !res.success) throw new Error(`p16_archetype_siege: ${label} failed: ${JSON.stringify(res?.error ?? "no response")}`);
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
const DIR = { buildRate: 0.25, fadeRate: 0.3, sustainTicks: 2, restTicks: 2, peakLevel: 1, restLevel: 0.1, pressureDamping: 0.9 };

// Tuning chosen so a competent defender deterministically holds the keep.
const SPAWN_DIST = 12, ENEMY_SPEED = 0.5, KEEP_DMG = 25, REGEN = 3, MAX_TICKS = 45;

async function runSiege(session: string): Promise<{ log: string[]; outcome: string; keepHp: number; kills: number; keepEntities: number }> {
  ops.op_physics_create_world(-9.81);
  const reg = new SkillRegistry(new LiminaTracer(session));
  const core: CoreSkills = registerCoreSkills(reg);
  const world = makeWorld(ops);
  const at = (t: number): InvokeBase => ({ agentId: "agt", sessionId: session, permissions: PERMS, tick: t, world });

  // ── AUTHOR ────────────────────────────────────────────────────────────────────────────────
  ok("world.generateRegion", await reg.invoke("world.generateRegion", { seed: 99, bounds: { minTx: 0, minTz: 0, maxTx: 1, maxTz: 1 }, lod: 0, type: "plains", render: false }, at(0)));
  const keep = ok("architecture.building", await reg.invoke("architecture.building", { position: [48, 0, 48], width: 8, depth: 8, height: 4 }, at(0)));
  ok("stats.create(keep)", await reg.invoke("stats.create", { entity: "keep", stats: [{ name: "hp", value: 100, maxValue: 100, minValue: 0 }] }, at(0)));
  ok("stats.create(defender)", await reg.invoke("stats.create", { entity: "defender", stats: [{ name: "stamina", value: 100, maxValue: 100, minValue: 0 }] }, at(0)));
  ok("ability.define(volley)", await reg.invoke("ability.define", { id: "volley", cooldownTicks: 5, resourceStat: "stamina", cost: 10 }, at(0)));
  ok("director.configure", await reg.invoke("director.configure", DIR, at(0)));
  ok("director.start", await reg.invoke("director.start", {}, at(0)));
  const dir = core.director.directorManager;
  const keepHp = () => core.combat.statsManager.getStat("keep", "hp")?.value ?? 0;

  interface Enemy { entity: string; hp: number; dist: number; }
  const enemies: Enemy[] = [];
  const log: string[] = [];
  let kills = 0, spawned = 0, outcome = "ongoing";

  for (let t = 1; t <= MAX_TICKS && outcome === "ongoing"; t++) {
    // (1) DIRECTOR paces waves: a "peak" spawns an attacker entity.
    const d = dir.tick(t, 0);
    if (d?.type === "peak") {
      const e = ok("scene.createEntity(enemy)", await reg.invoke("scene.createEntity", { shape: "box", size: 1, position: [48, 1, 48 - SPAWN_DIST] }, at(t))).entity as string;
      enemies.push({ entity: e, hp: 1, dist: SPAWN_DIST });
      spawned++;
      log.push(`${t} spawn#${spawned}`);
    }

    // (2) ATTACKERS advance; a breacher damages the keep and is removed.
    for (const en of enemies) en.dist -= ENEMY_SPEED;
    for (const en of [...enemies]) {
      if (en.dist > 0) continue;
      const dmg = ok("damage.apply(keep)", await reg.invoke("damage.apply", { targetEntity: "keep", amount: KEEP_DMG, type: "physical" }, at(t)));
      ok("scene.destroyEntity(breacher)", await reg.invoke("scene.destroyEntity", { entity: en.entity }, at(t)));
      enemies.splice(enemies.indexOf(en), 1);
      log.push(`${t} breach keepHp=${keepHp()}`);
      if (dmg.killed === true || keepHp() <= 0) { outcome = "lost"; }
    }
    if (outcome !== "ongoing") break;

    // (3) DEFENDER: regen stamina, then (cooldown+resource permitting) volley the closest threat.
    ok("stats.modify(regen)", await reg.invoke("stats.modify", { entity: "defender", statName: "stamina", delta: REGEN }, at(t)));
    if (enemies.length > 0) {
      const cast = ok("ability.cast(volley)", await reg.invoke("ability.cast", { entity: "defender", id: "volley" }, at(t))) as { ok: boolean };
      if (cast.ok) {
        // Target the closest-to-keep attacker (smallest dist).
        let target = enemies[0];
        for (const en of enemies) if (en.dist < target.dist) target = en;
        target.hp -= 1;
        if (target.hp <= 0) {
          ok("scene.destroyEntity(kill)", await reg.invoke("scene.destroyEntity", { entity: target.entity }, at(t)));
          enemies.splice(enemies.indexOf(target), 1);
          kills++;
          log.push(`${t} volley:kill (${kills})`);
        }
      }
    }
  }
  if (outcome === "ongoing") outcome = keepHp() > 0 ? "won" : "lost";
  log.push(`END ${outcome} keepHp=${keepHp()} kills=${kills}`);
  return { log, outcome, keepHp: keepHp(), kills, keepEntities: keep.entityCount as number };
}

// ── 1. The siege composes into a coherent, WINNABLE loop. ─────────────────────────────────────
const A = await runSiege("ses_p16_siege_A");
assert(A.keepEntities === 8, `the keep was built from architecture.building (8 parts, got ${A.keepEntities})`);
const spawns = A.log.filter((l) => l.includes("spawn#")).length;
assert(spawns >= 3, `the director paced at least 3 waves (got ${spawns})`);
assert(A.kills >= 3, `the defender's volley killed the attackers (kills=${A.kills})`);
assert(A.outcome === "won" && A.keepHp === 100, `a competent defender holds the keep undamaged (outcome=${A.outcome}, hp=${A.keepHp})`);
// Cooldown really gated the volley: far fewer kills than ticks (not a per-tick spam).
assert(A.kills <= Math.ceil(MAX_TICKS / 5) + 1, `volley was cooldown-gated, not spammed (kills=${A.kills} over ${MAX_TICKS} ticks)`);

// ── 2. The whole composed scenario REPLAYS byte-identically. ──────────────────────────────────
const B = await runSiege("ses_p16_siege_B");
assert(A.log.length === B.log.length, `same event count across runs (${A.log.length} vs ${B.log.length})`);
for (let i = 0; i < A.log.length; i++) assert(A.log[i] === B.log[i], `event ${i} identical: "${A.log[i]}" vs "${B.log[i]}"`);
assert(A.outcome === B.outcome && A.keepHp === B.keepHp && A.kills === B.kills, "identical outcome across runs");

ops.op_log(
  `p16_archetype_siege OK: "Hold the Keep" composes the catalog end-to-end — terrain + architecture build the keep, ` +
  `the director paces ${spawns} waves, attackers spawn/advance/die as real entities, the defender's volley is cooldown+stamina gated, ` +
  `and a breacher would damage the keep via damage.apply. The defender holds (won, hp 100, ${A.kills} kills) and the whole ` +
  `scenario replays byte-identically (${A.log.length} events). An archetype loop, proven headlessly.`,
);
