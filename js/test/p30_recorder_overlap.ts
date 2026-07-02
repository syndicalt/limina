// P30 -- WorldRecorder concurrent-invoke RECORDING contract (headless, deterministic).
//
// A coordinated agent team drives MULTIPLE top-level invokes that INTERLEAVE on the
// engine's single thread (one agent's invoke awaits inside its handler while another
// agent's invoke is entered). Recording must classify each invoke correctly:
//   * a TOP-LEVEL invoke (agent action loop / MCP callTool / scenario code) passes NO
//     chainId and is RECORDED as its own command;
//   * a NESTED invoke (a skill handler re-invoking the registry with the inherited
//     `ctx.chainId`) is FOLDED into the already-recorded parent -- never re-recorded --
//     because re-invoking the parent reproduces it on replay.
//
// The old classifier used a global `topInFlight` flag, which could not tell an
// INDEPENDENT concurrent top-level chain from a genuine child: while chain A was
// suspended at an await, chain B entered, saw the flag set, and was silently folded
// into A -- DROPPING B's command from the world log. That broke replay for any
// multi-agent driver. The fix classifies by an explicit chain id carried in the data
// (the embedded host exposes no AsyncLocalStorage), so it is immune to interleaving.
//
// What this pins:
//   A. SERIAL-AWAITED top-level invokes each record one command.
//   B. CONCURRENT (fire-and-forget, unawaited) INDEPENDENT top-level invokes each
//      record their OWN command -- the second agent's mutation is NOT dropped.
//   C. NO unhandled rejection and every pair-promise settles FULFILLED (the recorder's
//      `.finally` never throws).
//   D. After the pair drains, a further serial top-level invoke records normally.
//   E. REPLAY of the recorded stream rebuilds the world BIT-IDENTICALLY.
//   F. A TRUE nested invoke (a handler re-invoking with `ctx.chainId`) FOLDS into its
//      parent: invoking the parent records exactly ONE command, and the nested call is
//      NOT recorded separately -- while still EXECUTING (so replay reproduces it).
//
// Run: limina js/test/p30_recorder_overlap.ts   (exit 0 = pass)

import { EntityTable, ops, type EngineOps } from "../src/engine.ts";
import { createEcsWorld } from "../src/ecs/world.ts";
import { createTransformStorage } from "../src/ecs/facade.ts";
import { UniformGridSpatialIndex } from "../src/spatial/index.ts";
import { LiminaTracer } from "../src/observability/event.ts";
import { SkillRegistry, type WorldContext } from "../src/skills/registry.ts";
import { registerCoreSkills } from "../src/skills/index.ts";
import { resolveProfile } from "../src/skills/permissions.ts";
import { WorldRecorder } from "../src/worldlog/recorder.ts";
import { replayCommands } from "../src/worldlog/replay.ts";
import { captureWorldState, compareWorldState } from "../src/worldlog/log.ts";
import { z } from "../build/zod.bundle.mjs";
import type { MCPResponse } from "../src/mcp/protocol.ts";

function assert(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new Error("p30_recorder_overlap: " + msg);
}
function ok(res: MCPResponse): Record<string, unknown> {
  if (!res.success) throw new Error("call failed: " + JSON.stringify(res.error));
  return res.result as Record<string, unknown>;
}

const SESSION = "ses_p30";
const SEED = 0x30ada;
const BUILDER = resolveProfile("builder.readWrite");

function makeWorld(worldOps: EngineOps): WorldContext {
  const ecs = createEcsWorld();
  const scene = { add() {}, remove() {}, position: { set() {}, x: 0, y: 0, z: 0 }, background: null as unknown };
  const camera = { position: { set() {} }, aspect: 1, lookAt() {}, updateProjectionMatrix() {} };
  return {
    ecs, transforms: createTransformStorage(ecs), spatial: new UniformGridSpatialIndex(),
    entities: new EntityTable(), tags: new Map(), scene: scene as WorldContext["scene"],
    camera: camera as WorldContext["camera"], ops: worldOps, mode: "headless",
  };
}

// A guarded unhandled-rejection sentinel: if the runtime surfaces the event, a
// fire-and-forget reject would trip it. On runtimes that do not, assertion C's
// FULFILLED check below still catches a `.finally` that rejects the pair.
let unhandled = 0;
const g = globalThis as unknown as { addEventListener?: (t: string, cb: () => void) => void };
if (typeof g.addEventListener === "function") {
  g.addEventListener("unhandledrejection", () => { unhandled++; });
}

// ---- record a session through the choke point ------------------------------
// A skill that genuinely NESTS: its handler re-invokes the registry, threading the
// inherited chainId so the nested call folds into the parent's recorded command.
function registerParentSkill(registry: SkillRegistry): void {
  registry.register({
    name: "p30.parent",
    version: "1.0.0",
    description: "test: re-invokes a nested skill (must fold into one recorded command)",
    category: "system",
    permissions: [],
    input: z.object({ flagName: z.string() }),
    output: z.object({ ok: z.boolean() }),
    async handler(input, ctx) {
      const res = await registry.invoke("game.flag", { name: input.flagName, value: true }, {
        agentId: ctx.agentId, sessionId: ctx.sessionId, permissions: ctx.permissions,
        tick: ctx.tick, world: ctx.world, chainId: ctx.chainId,
      });
      return { ok: res.success };
    },
  });
}

const recReg = new SkillRegistry(new LiminaTracer(SESSION));
registerCoreSkills(recReg);
registerParentSkill(recReg);
const recorder = new WorldRecorder(SESSION);
recorder.attach(recReg);          // patch invoke -> record top-level commands
recorder.seed(SEED);
const recOps = recorder.wrapOps(ops);
const world = makeWorld(recOps);
const base = { agentId: "agt_p30", sessionId: SESSION, permissions: BUILDER, tick: 1, world };

const topCount = () => recorder.commands.filter((c) => c.kind === "skill").length;
const hasSkillCmd = (tool: string, match?: (input: unknown) => boolean): boolean =>
  recorder.commands.some((c) => c.kind === "skill" && c.tool === tool && (match === undefined || match(c.input)));

// A. SERIAL-AWAITED top-level invokes: each records exactly one command. These
//    also build REAL captured world state (body-less entities + transform writes).
const before1 = topCount();
const e1 = ok(await recReg.invoke("scene.createEntity", { shape: "box", position: [1, 2, 3] }, base)).entity as string;
assert(topCount() === before1 + 1, "A: serial scene.createEntity #1 must record exactly one top-level command");
const e2 = ok(await recReg.invoke("scene.createEntity", { shape: "sphere", position: [4, 5, 6] }, base)).entity as string;
assert(topCount() === before1 + 2, "A: serial scene.createEntity #2 must record exactly one top-level command");
ok(await recReg.invoke("ecs.updateComponent", { entity: e1, component: "position", value: [10, 11, 12] }, base));
ok(await recReg.invoke("ecs.updateComponent", { entity: e2, component: "scale", value: [2, 3, 4] }, base));
assert(topCount() === before1 + 4, "A: two serial ecs.updateComponent must record two more top-level commands");

// B + C. CONCURRENT INDEPENDENT fire-and-forget top-level invokes: the second is
//   issued while the first's chain is live, but it is NOT nested inside it -- it is
//   an independent agent's action. Each MUST record its own command (the old flag
//   classifier folded them, dropping the second mutation from the world log).
const beforePair = topCount();
const pa = recReg.invoke("game.flag", { name: "doorOpen", value: true }, base);
const pb = recReg.invoke("game.counter", { name: "coins", action: "increment", value: 1 }, base);
assert(topCount() === beforePair + 2,
  `B: two concurrent INDEPENDENT top-level invokes must each record (expected +2, recorded ${topCount() - beforePair})`);
assert(hasSkillCmd("game.flag", (i) => (i as { name?: string }).name === "doorOpen"),
  "B: the independent game.flag invoke must be present as its own recorded command");
assert(hasSkillCmd("game.counter", (i) => (i as { name?: string }).name === "coins"),
  "B: the independent game.counter invoke must be present as its own recorded command");

// Let any (mis)handled rejection surface as a macrotask before we settle the pair.
await ops.op_sleep_ms(1);
const settled = await Promise.allSettled([pa, pb]);
assert(settled.every((s) => s.status === "fulfilled"),
  "C: a fire-and-forget pair-promise REJECTED -- the recorder's `.finally` must never throw");
for (const s of settled) {
  assert(s.status === "fulfilled" && (s.value as MCPResponse).success === true, "C: both fire-and-forget invokes must succeed");
}
assert(unhandled === 0, "C: a fire-and-forget invoke produced an UNHANDLED REJECTION");

// D. After the pair drained, a further serial top-level records.
const beforeD = topCount();
ok(await recReg.invoke("game.state", { action: "set", name: "level", value: "cave" }, base));
assert(topCount() === beforeD + 1, "D: after the pair drains, a serial top-level invoke must record again");

// F. TRUE NESTING folds: invoking p30.parent records exactly ONE top-level command
//    (the parent); the nested game.flag it drives is NOT recorded separately, because
//    re-invoking p30.parent on replay reproduces it. The nested call still EXECUTED
//    (the parent returns ok === true), so replay reproduces its effect.
const beforeF = topCount();
const parentRes = ok(await recReg.invoke("p30.parent", { flagName: "nestedFlag" }, base));
assert(parentRes.ok === true, "F: the nested game.flag must EXECUTE (parent reports success)");
assert(topCount() === beforeF + 1, "F: a TRUE nested invoke must fold -- the parent records exactly ONE command");
assert(hasSkillCmd("p30.parent"), "F: the parent command must be recorded");
assert(!hasSkillCmd("game.flag", (i) => (i as { name?: string }).name === "nestedFlag"),
  "F: the nested game.flag must NOT be recorded as a separate top-level command");

// ---- E. REPLAY bit-identical ----------------------------------------------
const recordedState = captureWorldState(world);
assert(recordedState.entities.length === 2, "setup: two entities must be captured in the recorded world");

const replay = await replayCommands(recorder.commands, {
  makeWorld: () => makeWorld(ops),
  makeRegistry: (tr) => {
    const r = new SkillRegistry(tr as LiminaTracer);
    registerCoreSkills(r);
    registerParentSkill(r);
    return r;
  },
  tracer: new LiminaTracer(SESSION + "_replay"),
});
const cmp = compareWorldState(recordedState, replay.state);
assert(cmp.identical, `E: replay diverged from the recorded world (${cmp.comparisons} fields): ${cmp.detail ?? "?"}`);

ops.op_log(
  `p30_recorder_overlap OK: serial top-level invokes each record; concurrent INDEPENDENT top-level invokes ` +
    `each record (no dropped mutation); a TRUE nested invoke folds into its parent; NO unhandled rejection; ` +
    `replay of ${recorder.commands.length} commands is BIT-IDENTICAL (${cmp.comparisons} fields, ${replay.state.entities.length} entities).`,
);
