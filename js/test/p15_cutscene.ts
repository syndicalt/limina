// Phase 15 (Track C — Complete) — THE CUTSCENE/TIMELINE GATE.
//
// cutscene.* is the scripted-set-piece primitive (intros, scripted reveals, the Half-Life beat).
// This gate proves the sequencer is a DETERMINISTIC, tick-driven pump: keyframes fire at the right
// relative ticks in authored order, authoring order doesn't matter (sorted), play anchors the
// timeline, stop/loop behave, a bad play returns a structured reason, and two identical runs fire
// byte-identical sequences (replay-safe).
//
// Run: ./target/release/limina js/test/p15_cutscene.ts   (exit 0 = pass)

import { ops } from "../src/engine.ts";
import { LiminaTracer } from "../src/observability/event.ts";
import { SkillRegistry, type InvokeBase, type WorldContext } from "../src/skills/registry.ts";
import { registerCoreSkills, type CoreSkills } from "../src/skills/index.ts";
import { resolveProfile } from "../src/skills/permissions.ts";
import type { MCPResponse } from "../src/mcp/protocol.ts";
import { EntityTable } from "../src/engine.ts";
import { createEcsWorld } from "../src/ecs/world.ts";
import { createTransformStorage } from "../src/ecs/facade.ts";
import { UniformGridSpatialIndex } from "../src/spatial/index.ts";

function assert(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new Error("p15_cutscene FAIL: " + msg);
}
function unwrap(label: string, res: MCPResponse | undefined): Record<string, unknown> {
  if (res === undefined || !res.success) throw new Error(`p15_cutscene: ${label} failed: ${JSON.stringify(res?.error ?? "no response")}`);
  return (res.result ?? {}) as Record<string, unknown>;
}
function makeWorld(): WorldContext {
  const scene = { add() {}, remove() {}, position: { set() {}, x: 0, y: 0, z: 0 }, background: null as unknown };
  const camera = { position: { set() {} }, aspect: 1, lookAt() {}, updateProjectionMatrix() {} };
  const ecs = createEcsWorld();
  return {
    ecs, transforms: createTransformStorage(ecs), spatial: new UniformGridSpatialIndex(),
    entities: new EntityTable(), tags: new Map(), scene: scene as WorldContext["scene"],
    camera: camera as WorldContext["camera"], ops, mode: "headless",
  };
}
const PERMS = resolveProfile("builder.readWrite");
function freshCore(session: string): { reg: SkillRegistry; core: CoreSkills; base: InvokeBase } {
  const reg = new SkillRegistry(new LiminaTracer(session));
  const core = registerCoreSkills(reg);
  const base: InvokeBase = { agentId: "agt", sessionId: session, permissions: PERMS, tick: 0, world: makeWorld() };
  return { reg, core, base };
}

// Drive the timeline from start tick T and collect (atTick,type) for each fired action.
function pumpFrom(mgr: CoreSkills["cutscene"]["cutsceneManager"], startTick: number, ticks: number[]): string[] {
  const seq: string[] = [];
  for (const t of ticks) {
    for (const f of mgr.tick(startTick + t)) seq.push(`${f.atTick}:${f.action.type}`);
  }
  return seq;
}

// ── 1. Define (out of order ⇒ sorted) + play + deterministic pump timing/order. ───────────────
{
  const { reg, core, base } = freshCore("ses_p15_cut_a");
  const mgr = core.cutscene.cutsceneManager;
  const d = unwrap("define", await reg.invoke("cutscene.define", {
    id: "intro",
    keyframes: [
      { atTick: 5, action: { type: "bloom" } },
      { atTick: 0, action: { type: "fadeIn" } },   // authored out of order on purpose
      { atTick: 10, action: { type: "reveal", data: { who: "boss" } } },
    ],
  }, base));
  assert(d.keyframes === 3 && d.durationTicks === 10, `define reports 3 keyframes, duration 10 (got ${d.keyframes}, ${d.durationTicks})`);

  unwrap("play", await reg.invoke("cutscene.play", { id: "intro", startTick: 100 }, base));
  assert(mgr.isPlaying(), "cutscene is playing after play");

  // Pump across a window of sim ticks; assert each keyframe fires at its relative tick, in order.
  const seq: string[] = [];
  const collect = (t: number) => { for (const f of mgr.tick(t)) seq.push(`${t - 100}=${f.atTick}:${f.action.type}`); };
  collect(100); // elapsed 0 → fadeIn
  collect(102); // elapsed 2 → nothing
  collect(105); // elapsed 5 → bloom
  collect(109); // elapsed 9 → nothing
  collect(110); // elapsed 10 → reveal → playback ends
  assert(seq.join("|") === "0=0:fadeIn|5=5:bloom|10=10:reveal",
    "keyframes fire at their authored relative ticks, in order: " + seq.join("|"));
  assert(!mgr.isPlaying(), "non-looping cutscene ends after the last keyframe");
  assert((mgr.tick(120)).length === 0, "no further actions fire once ended");
}

// ── 2. Catch-up: a pump that skips past several keyframes fires all overdue ones in order. ─────
{
  const { reg, core, base } = freshCore("ses_p15_cut_catchup");
  const mgr = core.cutscene.cutsceneManager;
  await reg.invoke("cutscene.define", { id: "c", keyframes: [
    { atTick: 0, action: { type: "a" } }, { atTick: 1, action: { type: "b" } }, { atTick: 2, action: { type: "c" } },
  ] }, base);
  unwrap("play", await reg.invoke("cutscene.play", { id: "c", startTick: 0 }, base));
  const fired = mgr.tick(5).map((f) => f.action.type); // jump straight to elapsed 5
  assert(fired.join(",") === "a,b,c", "a single late pump fires all overdue keyframes in order: " + fired.join(","));
}

// ── 3. Structured failure: playing an undefined cutscene returns ok:false WITH a reason. ──────
{
  const { reg, base } = freshCore("ses_p15_cut_fail");
  const res = await reg.invoke("cutscene.play", { id: "ghost" }, base);
  assert(res.success === true, "play invoke completed at the transport level");
  const r = res.result as { ok: boolean; reason?: string };
  assert(r.ok === false && typeof r.reason === "string" && r.reason.length > 0, "playing an unknown cutscene fails with a reason");
}

// ── 4. Stop halts an in-progress timeline. ────────────────────────────────────────────────────
{
  const { reg, core, base } = freshCore("ses_p15_cut_stop");
  const mgr = core.cutscene.cutsceneManager;
  await reg.invoke("cutscene.define", { id: "s", keyframes: [{ atTick: 0, action: { type: "x" } }, { atTick: 100, action: { type: "y" } }] }, base);
  unwrap("play", await reg.invoke("cutscene.play", { id: "s", startTick: 0 }, base));
  mgr.tick(0); // fires x; y is far away
  const stop = unwrap("stop", await reg.invoke("cutscene.stop", {}, base));
  assert(stop.wasPlaying === true, "stop reports it halted a playback");
  assert(!mgr.isPlaying(), "nothing plays after stop");
  assert(mgr.tick(100).length === 0, "the far keyframe never fires after stop");
}

// ── 5. Loop re-anchors and repeats. ───────────────────────────────────────────────────────────
{
  const { reg, core, base } = freshCore("ses_p15_cut_loop");
  const mgr = core.cutscene.cutsceneManager;
  await reg.invoke("cutscene.define", { id: "l", keyframes: [{ atTick: 0, action: { type: "a" } }, { atTick: 3, action: { type: "b" } }], loop: true }, base);
  unwrap("play", await reg.invoke("cutscene.play", { id: "l", startTick: 0 }, base));
  const c0 = mgr.tick(0).map((f) => f.action.type); // a
  const c3 = mgr.tick(3).map((f) => f.action.type); // b, then re-anchor to tick 3
  const c3b = mgr.tick(3).map((f) => f.action.type); // elapsed 0 of the new cycle → a again
  assert(c0.join() === "a" && c3.join() === "b" && c3b.join() === "a", `loop repeats (got ${c0}/${c3}/${c3b})`);
  assert(mgr.isPlaying(), "a looping cutscene keeps playing");
}

// ── 6. Replay-determinism: two independent runs fire byte-identical sequences. ────────────────
{
  const A = freshCore("ses_p15_cut_detA");
  const B = freshCore("ses_p15_cut_detB");
  const kf = [{ atTick: 0, action: { type: "a" } }, { atTick: 4, action: { type: "b" } }, { atTick: 4, action: { type: "c" } }, { atTick: 9, action: { type: "d" } }];
  for (const ctx of [A, B]) {
    await ctx.reg.invoke("cutscene.define", { id: "det", keyframes: kf }, ctx.base);
    await ctx.reg.invoke("cutscene.play", { id: "det", startTick: 50 }, ctx.base);
  }
  const seqA = pumpFrom(A.core.cutscene.cutsceneManager, 50, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  const seqB = pumpFrom(B.core.cutscene.cutsceneManager, 50, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert(seqA.join("|") === seqB.join("|"), "two runs fire identical sequences");
  // Same-tick keyframes (4:b, 4:c) keep their sorted authoring order, deterministically.
  assert(seqA.join("|") === "0:a|4:b|4:c|9:d", "exact deterministic sequence incl. stable same-tick order: " + seqA.join("|"));
}

ops.op_log(
  "p15_cutscene OK: deterministic timeline sequencer — keyframes fire at authored relative ticks in order; " +
  "out-of-order authoring is sorted; a late pump catches up all overdue keyframes; play anchors / stop halts / loop re-anchors; " +
  "unknown play returns a structured reason; two runs fire byte-identical sequences (replay-safe).",
);
