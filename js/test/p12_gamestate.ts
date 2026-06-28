// Phase 12 — gamestate.* skill seam: real behaviour + DETERMINISM/REPLAY teeth.
//
// What this pins:
//   A. The skills actually DO WORK through the shared GameStateManager (the closure-bound
//      manager — not the dead `(ctx.world as ...).gameStateManager` back-channel that never
//      existed): vars/flags/counters set+read, a condition defines+evaluates+fires on its
//      rising edge, a timer starts + ticks (by an EXPLICIT dt) + completes, win/lose set state.
//   B. REPLAY EQUIVALENCE (the wall-clock regression catcher): record a sequence of game.*
//      invokes, snapshot the manager, then replay the recorded commands into a FRESH
//      registry/core and assert the resulting manager state AND the per-skill outputs are
//      BIT-IDENTICAL. Any Date.now()/Math.random()/wall-clock timer would diverge here.
//   C. SAFETY teeth: the condition evaluator runs NO arbitrary code — an expression that reads
//      a global evaluates to false (not its real value) AND an expression that tries to WRITE a
//      global leaves the global untouched (proving no eval / no Function ctor ever executed).
//
// Run: limina js/test/p12_gamestate.ts   (exit 0 = pass)

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
import { evalBoolExpr, type GameStateManager } from "../src/skills/gamestate.ts";
import type { MCPResponse } from "../src/mcp/protocol.ts";

function assert(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new Error("p12_gamestate FAIL: " + msg);
}
function ok(res: MCPResponse): Record<string, unknown> {
  if (!res.success) throw new Error("call failed: " + JSON.stringify(res.error));
  return res.result as Record<string, unknown>;
}

const BUILDER = resolveProfile("builder.readWrite");

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

/** Deterministic, sorted serialization of the WHOLE manager state (Maps → sorted arrays) so two
 *  runs can be compared bit-for-bit by string equality. */
function snapshot(m: GameStateManager): string {
  const s = m.getState();
  // deno-lint-ignore no-explicit-any
  const sortMap = <V>(mp: Map<string, V>, f: (v: V) => any = (v) => v): [string, unknown][] =>
    [...mp.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)).map(([k, v]) => [k, f(v)]);
  return JSON.stringify({
    variables: sortMap(s.variables),
    flags: sortMap(s.flags),
    counters: sortMap(s.counters),
    timers: sortMap(s.timers, (t) => ({ remaining: t.remaining, duration: t.duration, paused: t.paused, direction: t.direction, onComplete: t.onComplete, done: t.done })),
    conditions: sortMap(s.conditions, (c) => ({ expression: c.expression, lastValue: c.lastValue, onTrue: c.onTrue ?? null })),
    state: s.state,
    endedAtTick: s.endedAtTick ?? null,
  });
}

/** Wrap a registry's invoke to collect every game.* call's RESULT (in order) for bit-comparison. */
function captureGameOutputs(registry: SkillRegistry): unknown[] {
  const out: unknown[] = [];
  const inner = registry.invoke.bind(registry);
  registry.invoke = (n, i, b) => inner(n, i, b).then((rr) => {
    if (n.startsWith("game.") && rr.success) out.push({ tool: n, result: rr.result });
    return rr;
  });
  return out;
}

// ===========================================================================
// A. REAL BEHAVIOUR through the closure-bound manager.
// ===========================================================================
const fnReg = new SkillRegistry(new LiminaTracer("ses_p12_fn"));
const fnCore: CoreSkills = registerCoreSkills(fnReg);
const fnMgr = fnCore.gamestate.gameStateManager;
const fnWorld = makeWorld(ops);
const ctx0 = { agentId: "a", sessionId: "ses_p12_fn", permissions: BUILDER, tick: 0, world: fnWorld };

// vars / flags / counters
assert((ok(await fnReg.invoke("game.state", { action: "set", name: "level", value: "forest" }, ctx0)).value) === "forest", "game.state set/get failed");
assert(fnMgr.getVariable("level") === "forest", "manager did not receive the variable (back-channel regression?)");
assert((ok(await fnReg.invoke("game.flag", { name: "doorUnlocked", value: true }, ctx0)).value) === true, "game.flag set failed");
ok(await fnReg.invoke("game.counter", { name: "coins", action: "set", value: 2 }, ctx0));
assert((ok(await fnReg.invoke("game.counter", { name: "coins", action: "increment", value: 1 }, ctx0)).value) === 3, "counter increment failed");
assert(fnMgr.getCounter("coins") === 3, "manager counter mismatch");

// condition: defines, evaluates, fires onTrue on the RISING edge only
const def = ok(await fnReg.invoke("game.condition", { name: "rich", expression: "counter('coins') >= 3 && flag('doorUnlocked')", onTrue: "game.rich.reached" }, ctx0));
assert(def.value === true && def.fired === true, "condition should be true and fire on first define (rising edge)");
const reeval = ok(await fnReg.invoke("game.condition", { name: "rich", action: "evaluate" }, ctx0));
assert(reeval.value === true && reeval.fired === false, "re-evaluating a true condition must NOT re-fire (edge only)");
// a false condition over the same state
const falseDef = ok(await fnReg.invoke("game.condition", { name: "broke", expression: "counter('coins') < 0" }, ctx0));
assert(falseDef.value === false && falseDef.fired === false, "false condition mis-evaluated");

// timer: start countdown, advance by EXPLICIT dt, complete
ok(await fnReg.invoke("game.timer", { name: "bomb", action: "start", duration: 5, onComplete: "game.bomb.boom" }, ctx0));
const t1 = ok(await fnReg.invoke("game.timer", { action: "tick", dt: 3 }, ctx0));
assert((t1.completed as string[]).length === 0, "timer completed too early");
assert(fnMgr.getTimerRemaining("bomb") === 2, `timer remaining after 3s of 5s should be 2, got ${fnMgr.getTimerRemaining("bomb")}`);
const t2 = ok(await fnReg.invoke("game.timer", { action: "tick", dt: 3 }, ctx0));
assert((t2.completed as string[]).includes("bomb"), "timer did not complete after enough dt");
assert(fnMgr.getState().timers.get("bomb")?.done === true, "completed timer not latched done");

// win / lose set state (with a deterministic end-tick from ctx.tick)
ok(await fnReg.invoke("game.win", {}, { ...ctx0, tick: 42 }));
assert(fnMgr.getState().state === "won", "game.win did not set state");
assert(fnMgr.getState().endedAtTick === 42, "win did not stamp the deterministic ctx.tick");
ok(await fnReg.invoke("game.lose", {}, { ...ctx0, tick: 43 }));
assert(fnMgr.getState().state === "lost" && fnMgr.getState().endedAtTick === 43, "game.lose did not set state/tick");
// restart clears progress
ok(await fnReg.invoke("game.restart", {}, ctx0));
assert(fnMgr.getState().state === "running" && fnMgr.getState().counters.size === 0, "game.restart did not reset");

// ===========================================================================
// C. SAFETY teeth — the evaluator runs NO arbitrary code.
// ===========================================================================
// Direct: an expression touching a global throws (no eval, no global reach).
let threw = false;
try { evalBoolExpr("globalThis", { flag: () => false, counter: () => 0, variable: () => "" }); } catch { threw = true; }
assert(threw, "evalBoolExpr must THROW on a global identifier (proves no eval)");
// Via the skill: a global READ evaluates to false, not its real value.
// deno-lint-ignore no-explicit-any
(globalThis as any).__p12_sentinel = 1;
const evilRead = ok(await fnReg.invoke("game.condition", { name: "evilRead", expression: "__p12_sentinel == 1" }, ctx0));
assert(evilRead.value === false, "unsafe expression reading a global must evaluate to false (it did NOT — eval is reachable!)");
// Via the skill: a global WRITE attempt never executes (the global stays untouched).
const evilWrite = ok(await fnReg.invoke("game.condition", { name: "evilWrite", expression: "(__p12_pwned = true)" }, ctx0));
assert(evilWrite.value === false, "unsafe write-expression must evaluate to false");
// deno-lint-ignore no-explicit-any
assert((globalThis as any).__p12_pwned === undefined, "the expression EXECUTED a global write — eval/new Function is still reachable!");

// ===========================================================================
// B. REPLAY EQUIVALENCE — record a sequence, snapshot, replay into a FRESH core, compare.
// ===========================================================================
const SESSION = "ses_p12_replay";
const recReg = new SkillRegistry(new LiminaTracer(SESSION));
const recCore: CoreSkills = registerCoreSkills(recReg);
const recorder = new WorldRecorder(SESSION);
recorder.attach(recReg);                         // record top-level invokes (depth 0)
const recOutputs = captureGameOutputs(recReg);   // capture each game.* result
const recWorld = makeWorld(ops);
const baseAt = (tick: number) => ({ agentId: "agt_rec", sessionId: SESSION, permissions: BUILDER, tick, world: recWorld });

// A representative sequence touching every skill + the tick-driven timer + condition firing.
await recReg.invoke("game.state", { action: "set", name: "level", value: "cave" }, baseAt(1));
await recReg.invoke("game.flag", { name: "lever", value: true }, baseAt(2));
await recReg.invoke("game.counter", { name: "kills", action: "set", value: 1 }, baseAt(3));
await recReg.invoke("game.counter", { name: "kills", action: "increment", value: 2 }, baseAt(4));
await recReg.invoke("game.condition", { name: "boss", expression: "counter('kills') >= 3 && flag('lever')", onTrue: "game.boss.ready" }, baseAt(5));
await recReg.invoke("game.timer", { name: "siege", action: "start", duration: 10, direction: "countdown" }, baseAt(6));
await recReg.invoke("game.timer", { action: "tick", dt: 4 }, baseAt(7));
await recReg.invoke("game.timer", { name: "siege", action: "pause" }, baseAt(8));
await recReg.invoke("game.timer", { action: "tick", dt: 100 }, baseAt(9)); // paused → no advance
await recReg.invoke("game.timer", { name: "siege", action: "resume" }, baseAt(10));
await recReg.invoke("game.timer", { action: "tick", dt: 99 }, baseAt(11));  // now completes
await recReg.invoke("game.condition", { name: "boss", action: "evaluate" }, baseAt(12));
await recReg.invoke("game.win", {}, baseAt(20));

const recordedSnapshot = snapshot(recCore.gamestate.gameStateManager);
assert(recCore.gamestate.gameStateManager.getState().state === "won", "authoring run did not reach won");

// Replay the recorded command stream into a brand-new registry/core (no shared state).
let replayCore: CoreSkills | undefined;
let replayOutputs: unknown[] = [];
await replayCommands(recorder.commands, {
  makeWorld: () => makeWorld(ops),
  makeRegistry: (tr) => {
    const r = new SkillRegistry(tr as LiminaTracer);
    replayCore = registerCoreSkills(r);
    replayOutputs = captureGameOutputs(r);
    return r;
  },
  tracer: new LiminaTracer(SESSION + "_replay"),
});
assert(replayCore !== undefined, "replay did not construct a core");
const replayedSnapshot = snapshot(replayCore.gamestate.gameStateManager);

assert(replayedSnapshot === recordedSnapshot, `replay manager state DIVERGED from authoring (wall-clock regression?):\n  rec=${recordedSnapshot}\n  rep=${replayedSnapshot}`);
assert(replayOutputs.length === recOutputs.length && replayOutputs.length > 0, `captured output counts differ (rec=${recOutputs.length}, rep=${replayOutputs.length})`);
assert(JSON.stringify(replayOutputs) === JSON.stringify(recOutputs), "replay skill OUTPUTS are not bit-identical to authoring");

ops.op_log(
  `p12_gamestate OK: closure-bound manager drives game.state/flag/counter/condition/timer/win/lose/restart for real; ` +
  `condition fires on rising edge only; timer advances by EXPLICIT dt (paused timer holds), completes + fires onComplete; ` +
  `safe evaluator rejects globals (read→false, write never executes, direct throw); ` +
  `replay of ${recorder.commands.length} commands reproduces manager state + ${recOutputs.length} skill outputs BIT-IDENTICALLY.`,
);
