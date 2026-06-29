// Phase 15 (Track C — Complete) — THE AI DIRECTOR GATE.
//
// director.* is the deterministic pacing/orchestration primitive. This gate proves the tension
// state machine cycles build_up → sustain → fade → rest correctly, emits the right DIRECTIVE on
// each transition in order, that the `pressure` signal damps build_up (the director eases off when
// the world is already hot), and that two runs with identical inputs emit a byte-identical
// directive stream (replay-safe).
//
// Run: ./target/release/limina js/test/p15_director.ts   (exit 0 = pass)

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
  if (!cond) throw new Error("p15_director FAIL: " + msg);
}
function unwrap(label: string, res: MCPResponse | undefined): Record<string, unknown> {
  if (res === undefined || !res.success) throw new Error(`p15_director: ${label} failed: ${JSON.stringify(res?.error ?? "no response")}`);
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
// A fast-cycling config: 4 ticks to peak, 2-tick sustain, 3 fade ticks to rest, 2-tick rest.
const CFG = { buildRate: 0.25, fadeRate: 0.3, sustainTicks: 2, restTicks: 2, peakLevel: 1, restLevel: 0.1, pressureDamping: 0.9 };

// ── 1. One full cycle: correct phase transitions + directive order at the right ticks. ────────
{
  const { reg, core, base } = freshCore("ses_p15_dir_a");
  const mgr = core.director.directorManager;
  unwrap("configure", await reg.invoke("director.configure", CFG, base));
  unwrap("start", await reg.invoke("director.start", {}, base));
  const st0 = unwrap("status", await reg.invoke("director.status", {}, base));
  assert(st0.running === true && st0.phase === "build_up", "director starts running in build_up");

  const fired: string[] = [];
  for (let t = 1; t <= 11; t++) {
    const d = mgr.tick(t, 0);
    if (d !== null) fired.push(`${d.tick}:${d.type}->${d.phase}`);
  }
  assert(
    fired.join("|") === "4:peak->sustain|6:sustain_end->fade|9:lull->rest|11:build->build_up",
    "directives fire on the right transitions, in order: " + fired.join("|"),
  );
  assert(mgr.isRunning(), "director keeps running across the cycle");
}

// ── 2. Pressure damps build_up: under full pressure the peak does NOT arrive on schedule. ─────
{
  const { reg, core, base } = freshCore("ses_p15_dir_pressure");
  const mgr = core.director.directorManager;
  unwrap("configure", await reg.invoke("director.configure", CFG, base));
  unwrap("start", await reg.invoke("director.start", {}, base));
  let peaked = false;
  for (let t = 1; t <= 11; t++) { if (mgr.tick(t, 1.0)?.type === "peak") peaked = true; } // full pressure
  assert(!peaked, "under full pressure the director slows build_up — no premature peak");
  const st = mgr.status();
  assert(st.phase === "build_up" && (st.tension ?? 0) < CFG.peakLevel, "still building tension under pressure");
}

// ── 3. Stop halts the director. ───────────────────────────────────────────────────────────────
{
  const { reg, core, base } = freshCore("ses_p15_dir_stop");
  const mgr = core.director.directorManager;
  unwrap("configure", await reg.invoke("director.configure", CFG, base));
  unwrap("start", await reg.invoke("director.start", {}, base));
  const stop = unwrap("stop", await reg.invoke("director.stop", {}, base));
  assert(stop.wasRunning === true, "stop reports it halted a running director");
  assert(mgr.tick(1, 0) === null && !mgr.isRunning(), "a stopped director emits nothing");
}

// ── 4. Replay-determinism: identical inputs ⇒ identical directive stream. ─────────────────────
{
  const A = freshCore("ses_p15_dir_detA");
  const B = freshCore("ses_p15_dir_detB");
  for (const ctx of [A, B]) {
    await ctx.reg.invoke("director.configure", CFG, ctx.base);
    await ctx.reg.invoke("director.start", {}, ctx.base);
  }
  // A varying but identical pressure trace across both runs.
  const pressure = [0, 0, 0.2, 0.5, 0, 0, 0, 0.1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
  const run = (mgr: CoreSkills["director"]["directorManager"]): string[] => {
    const out: string[] = [];
    for (let t = 1; t <= 24; t++) { const d = mgr.tick(t, pressure[t - 1]); if (d) out.push(`${d.tick}:${d.type}`); }
    return out;
  };
  const sa = run(A.core.director.directorManager);
  const sb = run(B.core.director.directorManager);
  assert(sa.length > 0, "the director emitted directives over 24 ticks");
  assert(sa.join("|") === sb.join("|"), "two runs with the same inputs emit identical directive streams: " + sa.join("|") + " vs " + sb.join("|"));
}

ops.op_log(
  "p15_director OK: deterministic AI director — tension cycles build_up→sustain→fade→rest with directives " +
  "(peak/sustain_end/lull/build) on each transition in order; the pressure signal damps build_up (no premature peak under load); " +
  "stop halts it; two runs with identical inputs emit byte-identical directive streams (replay-safe).",
);
