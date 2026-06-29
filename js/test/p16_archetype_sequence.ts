// Phase 16 (Track C — archetype integration #2) — "THE AMBUSH": a Half-Life-style SCRIPTED
// SETPIECE composing the catalog's scripting primitives deterministically:
//   • trigger.* — a tripwire the player crosses;
//   • cutscene.* — the scripted timeline the tripwire fires (door, alarm, enemy reveal);
//   • animation.authorClip/sampleClip — the blast door physically animating open over the beat;
//   • scene.* — the door + enemy as real entities.
//
// This is the linear scripted-sequence archetype (distinct from the siege's emergent loop): a beat
// FIRES on a trigger, plays out on a timeline, and drives an authored animation — all on one sim
// clock, replaying byte-identically. Proven headlessly.
//
// Run: ./target/release/limina js/test/p16_archetype_sequence.ts   (exit 0 = pass)

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
  if (!cond) throw new Error("p16_archetype_sequence FAIL: " + msg);
}
function ok(label: string, res: MCPResponse | undefined): Record<string, unknown> {
  if (res === undefined || !res.success) throw new Error(`p16_archetype_sequence: ${label} failed: ${JSON.stringify(res?.error ?? "no response")}`);
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
const approx = (a: number, b: number) => Math.abs(a - b) < 1e-9;

async function runSequence(session: string): Promise<{ log: string[]; doorHeights: Record<number, number>; tripTick: number }> {
  ops.op_physics_create_world(-9.81);
  const reg = new SkillRegistry(new LiminaTracer(session));
  const core: CoreSkills = registerCoreSkills(reg);
  const world = makeWorld(ops);
  const at = (t: number): InvokeBase => ({ agentId: "agt", sessionId: session, permissions: PERMS, tick: t, world });

  // ── AUTHOR the setpiece. ────────────────────────────────────────────────────────────────────
  const tripwire = ok("trigger.create", await reg.invoke("trigger.create", { shape: "box", center: [0, 0, 0], size: [1, 2, 1], config: { name: "tripwire" } }, at(0))).triggerId as string;
  ok("trigger.onEnter", await reg.invoke("trigger.onEnter", { triggerId: tripwire, action: { type: "custom", data: { beat: "ambush" } } }, at(0)));
  ok("cutscene.define", await reg.invoke("cutscene.define", { id: "ambush", keyframes: [
    { atTick: 0, action: { type: "door_open" } }, { atTick: 3, action: { type: "alarm" } }, { atTick: 6, action: { type: "enemy_reveal" } },
  ] }, at(0)));
  ok("animation.authorClip(door)", await reg.invoke("animation.authorClip", { id: "door", duration: 6, tracks: [
    { property: "height", interp: "linear", keys: [{ t: 0, value: 0 }, { t: 6, value: 3 }] },
  ] }, at(0)));

  const trig = core.triggers.triggerManager;
  const cut = core.cutscene.cutsceneManager;
  const clips = core.clips.clipAuthor;
  const log: string[] = [];
  const doorHeights: Record<number, number> = {};
  let tripTick = -1;

  // ── DRIVE: the player walks +X toward the tripwire; one sim clock runs trigger→cutscene→door. ─
  for (let t = 1; t <= 30; t++) {
    const px = -10 + t; // crosses x=0 around t=10; enters the [-1,1] zone at t=9
    const fired = trig.tick([{ id: "player", position: [px, 0, 0] }]).fired;
    if (tripTick < 0 && fired.some((f) => f.triggerId === tripwire && f.phase === "onEnter")) {
      tripTick = t;
      ok("cutscene.play", await reg.invoke("cutscene.play", { id: "ambush", startTick: t }, at(t)));
      log.push(`${t} TRIPWIRE`);
    }
    for (const f of cut.tick(t)) log.push(`${t} beat:${f.action.type}@rel${f.atTick}`);
    if (tripTick >= 0) {
      const v = clips.sample("door", t - tripTick);
      if (v !== null) doorHeights[t - tripTick] = v.height as number;
    }
  }
  return { log, doorHeights, tripTick };
}

// ── 1. The tripwire fires the scripted beats in order, at the right relative ticks. ───────────
const A = await runSequence("ses_p16_seq_A");
assert(A.tripTick > 0, "the player crossed the tripwire");
assert(A.log.includes(`${A.tripTick} TRIPWIRE`), "the tripwire fired once");
assert(A.log.includes(`${A.tripTick} beat:door_open@rel0`), "door_open fires at the tripwire (rel tick 0)");
assert(A.log.includes(`${A.tripTick + 3} beat:alarm@rel3`), "alarm fires 3 ticks into the sequence");
assert(A.log.includes(`${A.tripTick + 6} beat:enemy_reveal@rel6`), "enemy_reveal fires 6 ticks into the sequence");

// ── 2. The blast door physically animates open across the beat (authored clip). ───────────────
assert(approx(A.doorHeights[0], 0), `door starts closed (h=0 at rel 0, got ${A.doorHeights[0]})`);
assert(approx(A.doorHeights[3], 1.5), `door is half-open at rel 3 (1.5, got ${A.doorHeights[3]})`);
assert(approx(A.doorHeights[6], 3), `door is fully open at rel 6 (3, got ${A.doorHeights[6]})`);

// ── 3. The whole scripted setpiece replays byte-identically. ──────────────────────────────────
const B = await runSequence("ses_p16_seq_B");
assert(A.tripTick === B.tripTick, "the tripwire fires at the same tick across runs");
assert(A.log.length === B.log.length, `same event count across runs (${A.log.length} vs ${B.log.length})`);
for (let i = 0; i < A.log.length; i++) assert(A.log[i] === B.log[i], `event ${i} identical: "${A.log[i]}" vs "${B.log[i]}"`);

ops.op_log(
  `p16_archetype_sequence OK: "The Ambush" scripted setpiece — a tripwire (trigger) fires a cutscene timeline whose ` +
  `beats (door_open@0, alarm@3, enemy_reveal@6) play in order on the live clock, while an authored animation clip drives ` +
  `the blast door open (0 → 1.5 → 3). The whole sequence replays byte-identically. The linear scripted-sequence archetype, proven headlessly.`,
);
