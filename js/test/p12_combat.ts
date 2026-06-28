// Phase 12 — the stats/damage/status/combat skill seam (combat.ts).
//
// Proves the closure-wired combat skills actually MUTATE the StatsManager/CombatManager that
// core.combat exposes (not a never-set ctx.world.statsManager no-op), AND that the whole
// subsystem is DETERMINISTIC: recording a combat sequence and replaying it into a FRESH core
// recomputes BIT-IDENTICAL skill outputs + stat state — even with the (deterministic, hash-
// derived) crit on combat.melee/combat.ranged.
//
//   - stats.create + defense → damage.apply respects defense reduction + remaining HP.
//   - stats.onZero stores an agent action descriptor; damage to zero FIRES it (stats.onZero.fired).
//   - damage.heal returns the ACTUAL clamped delta (not the requested amount).
//   - status.apply / status.list / status.remove round-trip.
//   - combat.defend stores a tick-expiring stance; damage.apply applies its reduction while
//     active and stops once expired.
//   - combat.melee with no target honestly returns hit:false; combat.ranged is an honest
//     immediate hit (hit:false into empty space when only a direction is given).
//   - REPLAY-EQUIVALENCE: replay the recorded stream → identical outputs + identical stat state.
//
// Run: limina js/test/p12_combat.ts   (exit 0 = pass)

import { EntityTable, ops, type EngineOps } from "../src/engine.ts";
import { createEcsWorld } from "../src/ecs/world.ts";
import { createTransformStorage } from "../src/ecs/facade.ts";
import { UniformGridSpatialIndex } from "../src/spatial/index.ts";
import { LiminaTracer } from "../src/observability/event.ts";
import { SkillRegistry, type WorldContext } from "../src/skills/registry.ts";
import { registerCoreSkills, type CoreSkills } from "../src/skills/index.ts";
import { resolveProfile } from "../src/skills/permissions.ts";
import { WorldRecorder } from "../src/worldlog/recorder.ts";
import { replayCommands } from "../src/worldlog/replay.ts";
import type { StatsManager } from "../src/skills/combat.ts";
import type { MCPResponse } from "../src/mcp/protocol.ts";

function assert(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new Error("p12_combat FAIL: " + msg);
}
function ok(res: MCPResponse | undefined): Record<string, unknown> {
  if (res === undefined || !res.success) throw new Error("call failed: " + JSON.stringify(res?.error));
  return res.result as Record<string, unknown>;
}

ops.op_physics_create_world(0);
const PROFILE = resolveProfile("builder.readWrite");

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

const ENTITIES = ["goblin", "hero", "knight", "dummy"] as const;

/** Snapshot the stat blocks of the test entities (the replay-comparable manager state). */
function snapshotStats(mgr: StatsManager): string {
  const out: Record<string, unknown> = {};
  for (const e of ENTITIES) {
    const es = mgr.get(e);
    if (es === undefined) { out[e] = null; continue; }
    const stats: Record<string, unknown> = {};
    for (const [name, s] of es.stats) stats[name] = { value: s.value, maxValue: s.maxValue, minValue: s.minValue };
    out[e] = { stats, status: es.statusEffects.map((x) => ({ id: x.id, type: x.type, duration: x.duration, magnitude: x.magnitude })) };
  }
  return JSON.stringify(out);
}

/** Wrap a registry's invoke to capture EVERY call's ordered output (the replay-equivalence
 *  evidence). Installed AFTER the recorder so recording still happens underneath. */
function captureOutputs(registry: SkillRegistry): string[] {
  const log: string[] = [];
  const inner = registry.invoke.bind(registry);
  registry.invoke = (n, i, b) => inner(n, i, b).then((rr) => {
    log.push(JSON.stringify({ tool: n, success: rr.success, result: rr.result }));
    return rr;
  });
  return log;
}

// ── AUTHORING (recorded) ──────────────────────────────────────────────────────
const SESSION = "ses_p12_combat_rec";
const AGENT = "agt_combat";
const recTracer = new LiminaTracer(SESSION);
const recReg = new SkillRegistry(recTracer);
const recCore: CoreSkills = registerCoreSkills(recReg);
const recorder = new WorldRecorder(SESSION);
recorder.attach(recReg);
const authOutputs = captureOutputs(recReg);
const world = makeWorld(ops);

// Managers come from core.combat — the closure-owned instances the skills mutate.
const statsMgr = recCore.combat.statsManager;
const combatMgr = recCore.combat.combatManager;
assert(statsMgr !== undefined && combatMgr !== undefined, "core.combat must expose statsManager + combatManager");

const baseAt = (tick: number) => ({ agentId: AGENT, sessionId: SESSION, permissions: PROFILE, tick, world });
const call = (tool: string, input: unknown, tick: number) => recReg.invoke(tool, input, baseAt(tick));

// (1) stats.create + defense → damage.apply respects defense reduction.
ok(await call("stats.create", { entity: "goblin", stats: [{ name: "hp", value: 30 }, { name: "defense", value: 4 }] }, 0));
ok(await call("stats.onZero", { entity: "goblin", statName: "hp", action: { type: "emit", data: { event: "goblin.died" } } }, 0));

const d1 = ok(await call("damage.apply", { targetEntity: "goblin", amount: 10 }, 1));
// defense 4 → effective = max(1, 10 - 4*0.5) = 8; remaining 30 - 8 = 22.
assert(d1.damage === 8, `defense reduction wrong: expected 8, got ${d1.damage}`);
assert(d1.remaining === 22, `remaining wrong: expected 22, got ${d1.remaining}`);
assert(d1.killed === false, "goblin should not be dead after first hit");

// (2) killing blow → killed + onZero action FIRES.
const d2 = ok(await call("damage.apply", { targetEntity: "goblin", amount: 100 }, 2));
assert(d2.remaining === 0 && d2.killed === true, `goblin should be dead at 0: ${JSON.stringify(d2)}`);
const fired = recTracer.trace(AGENT).filter((e) => e.type === "stats.onZero.fired");
assert(fired.length === 1, `expected exactly one stats.onZero.fired, got ${fired.length}`);
const firedPayload = fired[0].payload as { entity: string; action: { data: Record<string, unknown> } };
assert(firedPayload.entity === "goblin" && firedPayload.action.data.event === "goblin.died",
  `onZero fired the wrong descriptor: ${JSON.stringify(firedPayload)}`);

// (3) damage.heal returns the ACTUAL clamped delta.
ok(await call("stats.create", { entity: "hero", stats: [{ name: "hp", value: 50, maxValue: 100 }] }, 3));
const h1 = ok(await call("damage.heal", { targetEntity: "hero", amount: 30 }, 3));
assert(h1.healed === 30 && h1.remaining === 80, `heal within range wrong: ${JSON.stringify(h1)}`);
const h2 = ok(await call("damage.heal", { targetEntity: "hero", amount: 50 }, 3));
assert(h2.healed === 20 && h2.remaining === 100, `heal must clamp delta to 20 (50→cap), got ${JSON.stringify(h2)}`);

// (4) status.apply / list / remove round-trip.
const st = ok(await call("status.apply", { targetEntity: "hero", type: "poison", duration: 5, magnitude: 3 }, 4));
const effectId = st.effectId as string;
assert(typeof effectId === "string" && effectId.length > 0, "status.apply returned no effectId");
const list1 = ok(await call("status.list", { targetEntity: "hero" }, 4));
assert((list1.effects as unknown[]).length === 1, "status.list should report 1 active effect");
ok(await call("status.remove", { targetEntity: "hero", effectId }, 4));
const list2 = ok(await call("status.list", { targetEntity: "hero" }, 4));
assert((list2.effects as unknown[]).length === 0, "status.remove did not remove the effect");

// (5) combat.defend stores a tick-expiring stance; reduction applies while active, stops at expiry.
ok(await call("stats.create", { entity: "knight", stats: [{ name: "hp", value: 100 }] }, 10));
const k0 = ok(await call("damage.apply", { targetEntity: "knight", amount: 20 }, 10)); // no stance yet
assert(k0.damage === 20 && k0.remaining === 80, `pre-defend damage wrong: ${JSON.stringify(k0)}`);
const def = ok(await call("combat.defend", { entity: "knight", duration: 1, damageReduction: 0.5 }, 10));
assert((def.expiresTick as number) === 70, `defend expiry should be tick 70 (10 + 1*60), got ${def.expiresTick}`);
const k1 = ok(await call("damage.apply", { targetEntity: "knight", amount: 20 }, 11)); // active stance
assert(k1.damage === 10 && k1.remaining === 70, `defend reduction not applied: ${JSON.stringify(k1)}`);
const k2 = ok(await call("damage.apply", { targetEntity: "knight", amount: 20 }, 100)); // stance expired
assert(k2.damage === 20 && k2.remaining === 50, `stance should be expired at tick 100: ${JSON.stringify(k2)}`);

// (6) combat.melee honesty + deterministic crit; combat.ranged immediate hit.
ok(await call("stats.create", { entity: "dummy", stats: [{ name: "hp", value: 1000 }] }, 7));
const noTarget = ok(await call("combat.melee", { attackerEntity: "hero", damage: 10 }, 7));
assert(noTarget.hit === false, "combat.melee with no target must honestly return hit:false");
const m1 = ok(await call("combat.melee", { attackerEntity: "hero", targetEntity: "dummy", damage: 10, config: { critChance: 0.5, critMultiplier: 3 } }, 7));
assert(m1.hit === true && typeof m1.crit === "boolean", `melee hit/crit malformed: ${JSON.stringify(m1)}`);
const afterMelee = statsMgr.getStat("dummy", "hp")?.value ?? 0;
assert(afterMelee < 1000, "melee dealt no damage");
const r1 = ok(await call("combat.ranged", { attackerEntity: "hero", targetEntity: "dummy", damage: 15 }, 8));
assert(r1.fired === true && r1.hit === true, `ranged should be an immediate hit: ${JSON.stringify(r1)}`);
assert((statsMgr.getStat("dummy", "hp")?.value ?? 0) < afterMelee, "ranged dealt no damage");
const rMiss = ok(await call("combat.ranged", { attackerEntity: "hero", direction: [0, 0, 1], damage: 15 }, 8));
assert(rMiss.fired === true && rMiss.hit === false, "direction-only ranged must be honest: fired:true, hit:false");

const authState = snapshotStats(statsMgr);

// ── REPLAY-EQUIVALENCE: replay the recorded stream into a FRESH core ───────────
let replayOutputs: string[] = [];
let replayStats: StatsManager | undefined;
await replayCommands(recorder.commands, {
  makeWorld: () => makeWorld(ops),
  makeRegistry: (tr) => {
    const r = new SkillRegistry(tr as LiminaTracer);
    const core = registerCoreSkills(r);
    replayStats = core.combat.statsManager;
    replayOutputs = captureOutputs(r);
    return r;
  },
  tracer: new LiminaTracer("ses_p12_combat_replay"),
});
assert(replayStats !== undefined, "replay did not construct a core");

// Outputs must be bit-identical (proves the crit + defend + onZero paths carry NO nondeterminism).
assert(replayOutputs.length === authOutputs.length,
  `replay ran ${replayOutputs.length} calls, authoring ran ${authOutputs.length}`);
for (let i = 0; i < authOutputs.length; i++) {
  assert(replayOutputs[i] === authOutputs[i],
    `replay output #${i} diverged:\n  author=${authOutputs[i]}\n  replay=${replayOutputs[i]}`);
}
// Final stat state must be bit-identical.
const replayState = snapshotStats(replayStats);
assert(replayState === authState, `replay stat state diverged:\n  author=${authState}\n  replay=${replayState}`);

ops.op_log(
  `p12_combat OK: closure-wired stats/damage/status/combat mutate core.combat managers; ` +
  `defense reduction (10→8) + remaining; onZero descriptor stored + FIRED at 0 (goblin.died); ` +
  `heal returns clamped delta (50 req → 20 actual); status apply/list/remove round-trip; ` +
  `defend stance reduces damage while active (20→10) and expires by tick; melee no-target honest hit:false; ` +
  `ranged immediate-hit (direction-only → hit:false). REPLAY recomputed ${replayOutputs.length} outputs + stat state BIT-IDENTICAL (deterministic crit, no RNG).`,
);
