// Phase 15 (Track C — Complete) — THE ABILITY/COOLDOWN GATE (combat depth).
//
// ability.* adds "abilities you can't spam" over the melee/stats combat: a cast is gated by a
// per-(entity,ability) COOLDOWN (in sim ticks) and an optional RESOURCE COST spent from a stat.
// This gate proves: a cast spends the resource and starts the cooldown; recasting during cooldown
// fails with a reason + remaining ticks; the cooldown counts down deterministically; a cast off
// cooldown but short on resource fails with a reason; unknown abilities fail; and two identical
// runs produce identical outcomes (replay-safe).
//
// Run: ./target/release/limina js/test/p15_ability.ts   (exit 0 = pass)

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
  if (!cond) throw new Error("p15_ability FAIL: " + msg);
}
function res(label: string, r: MCPResponse | undefined): Record<string, unknown> {
  if (r === undefined || !r.success) throw new Error(`p15_ability: ${label} invoke failed: ${JSON.stringify(r?.error ?? "no response")}`);
  return (r.result ?? {}) as Record<string, unknown>;
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
function freshCore(session: string): { reg: SkillRegistry; core: CoreSkills; world: WorldContext } {
  ops.op_physics_create_world(-9.81);
  const reg = new SkillRegistry(new LiminaTracer(session));
  const core = registerCoreSkills(reg);
  const world = makeWorld(ops);
  return { reg, core, world };
}
function baseAt(world: WorldContext, session: string, tick: number): InvokeBase {
  return { agentId: "agt", sessionId: session, permissions: PERMS, tick, world };
}

// ── Setup: a hero with 50 energy and a fireball (cooldown 30, costs 20 energy). ───────────────
const { reg, core, world } = freshCore("ses_p15_ability");
const B = (t: number) => baseAt(world, "ses_p15_ability", t);
const energy = () => core.combat.statsManager.getStat("hero", "energy")?.value;

res("stats.create", await reg.invoke("stats.create", { entity: "hero", stats: [{ name: "energy", value: 50, maxValue: 50, minValue: 0 }] }, B(0)));
res("ability.define", await reg.invoke("ability.define", { id: "fireball", cooldownTicks: 30, resourceStat: "energy", cost: 20 }, B(0)));

// ── 1. First cast: spends energy, starts the cooldown. ────────────────────────────────────────
{
  const c = res("cast@0", await reg.invoke("ability.cast", { entity: "hero", id: "fireball" }, B(0)));
  assert(c.ok === true && c.spent === 20, `cast spends 20 energy (got ok=${c.ok}, spent=${c.spent})`);
  assert(energy() === 30, `energy 50 → 30 after cast (got ${energy()})`);
  const s = res("status@0", await reg.invoke("ability.status", { entity: "hero", id: "fireball" }, B(0)));
  assert(s.defined === true && s.ready === false && s.cooldownRemaining === 30, `on cooldown 30 right after cast (got ${JSON.stringify(s)})`);
}

// ── 2. Recast during cooldown fails with a reason + remaining ticks; no energy spent. ─────────
{
  const c = res("cast@10", await reg.invoke("ability.cast", { entity: "hero", id: "fireball" }, B(10)));
  assert(c.ok === false && typeof c.reason === "string" && c.cooldownRemaining === 20, `recast at tick 10 blocked, 20 left (got ${JSON.stringify(c)})`);
  assert(energy() === 30, `no energy spent on a blocked cast (got ${energy()})`);
}

// ── 3. Cooldown counts down deterministically with the sim tick. ──────────────────────────────
{
  assert(res("status@10", await reg.invoke("ability.status", { entity: "hero", id: "fireball" }, B(10))).cooldownRemaining === 20, "20 left at tick 10");
  assert(res("status@29", await reg.invoke("ability.status", { entity: "hero", id: "fireball" }, B(29))).cooldownRemaining === 1, "1 left at tick 29");
  const s30 = res("status@30", await reg.invoke("ability.status", { entity: "hero", id: "fireball" }, B(30)));
  assert(s30.cooldownRemaining === 0 && s30.ready === true, "ready again at tick 30");
}

// ── 4. Cast off cooldown spends again; then short on energy fails (cooldown-clear but broke). ──
{
  const c = res("cast@30", await reg.invoke("ability.cast", { entity: "hero", id: "fireball" }, B(30)));
  assert(c.ok === true && energy() === 10, `second cast at 30 spends to 10 energy (got ok=${c.ok}, energy=${energy()})`);
  // tick 60: cooldown is clear (60-30=30) but only 10 energy remains (<20) → resource failure.
  const c2 = res("cast@60", await reg.invoke("ability.cast", { entity: "hero", id: "fireball" }, B(60)));
  assert(c2.ok === false && /insufficient/.test(String(c2.reason)), `cast fails on insufficient energy, not cooldown (got ${JSON.stringify(c2)})`);
  assert(res("status@60", await reg.invoke("ability.status", { entity: "hero", id: "fireball" }, B(60))).ready === true, "cooldown itself is ready at 60 (the block was the resource)");
  assert(energy() === 10, "a resource-failed cast spends nothing");
}

// ── 5. Unknown ability ⇒ structured failure. ──────────────────────────────────────────────────
{
  const c = res("cast(unknown)", await reg.invoke("ability.cast", { entity: "hero", id: "nope" }, B(0)));
  assert(c.ok === false && /unknown/.test(String(c.reason)), `unknown ability fails with a reason (got ${JSON.stringify(c)})`);
}

// ── 6. Replay-determinism: same setup + same cast ticks ⇒ identical outcomes. ─────────────────
{
  const run = async (session: string): Promise<string> => {
    const f = freshCore(session);
    const b = (t: number) => baseAt(f.world, session, t);
    await f.reg.invoke("stats.create", { entity: "h", stats: [{ name: "mana", value: 40, maxValue: 40, minValue: 0 }] }, b(0));
    await f.reg.invoke("ability.define", { id: "blink", cooldownTicks: 12, resourceStat: "mana", cost: 15 }, b(0));
    const out: string[] = [];
    for (const t of [0, 5, 12, 13, 24, 36]) {
      const c = (await f.reg.invoke("ability.cast", { entity: "h", id: "blink" }, b(t))).result as { ok: boolean; cooldownRemaining?: number };
      out.push(`${t}:${c.ok ? "ok" : "no" + (c.cooldownRemaining ?? "")}/${f.core.combat.statsManager.getStat("h", "mana")?.value}`);
    }
    return out.join("|");
  };
  const a = await run("ses_p15_ability_detA");
  const b = await run("ses_p15_ability_detB");
  assert(a === b, `two runs identical (A=${a} B=${b})`);
}

ops.op_log(
  "p15_ability OK: ability cooldowns + resource costs — a cast spends the resource and starts the cooldown; " +
  "recast during cooldown fails with remaining ticks and spends nothing; the cooldown counts down deterministically; " +
  "an off-cooldown cast short on resource fails for the right reason; unknown abilities fail with a reason; two runs are identical (replay-safe).",
);
