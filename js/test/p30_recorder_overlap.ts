// P30 -- WorldRecorder fire-and-forget OVERLAP contract (headless, deterministic).
// Locks in the wave-2 fix in recorder.ts: a skill that issues back-to-back
// FIRE-AND-FORGET nested invokes -- `void invoke(a); void invoke(b)` (character_model's
// `void invoke("animation.stop"); void invoke("animation.play")`) -- issues the second
// while the first's chain is still in flight, so it enters at depth > 0 even though it
// is NOT nested inside the first. Recording is classified by the `topInFlight` FLAG,
// not the raw depth counter, so the pair collapses to EXACTLY ONE recorded top-level
// command; and the `.finally()` depth-drop never throws, so neither fire-and-forget
// promise rejects (the regression produced an unhandled rejection / a spurious reject).
//
// What this pins:
//   A. SERIAL-AWAITED top-level invokes each record one command (the flag is clear on
//      entry for each, so the ordinary path is unchanged).
//   B. A FIRE-AND-FORGET pair (issued synchronously, unawaited) records EXACTLY ONE
//      top-level command -- the second is folded into the first's live chain.
//   C. NO unhandled rejection AND neither pair-promise rejects: both settle FULFILLED
//      with a successful skill result (the `.finally` never throws).
//   D. After the pair drains, the flag is clear again, so a further serial top-level
//      invoke records normally (the chain-liveness window closed correctly).
//   E. REPLAY of the recorded stream rebuilds the world BIT-IDENTICALLY (compareWorldState):
//      the collapsed fire-and-forget siblings touch no captured transform, so the
//      transform world replays exactly from the recorded top-level commands.
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
const recReg = new SkillRegistry(new LiminaTracer(SESSION));
registerCoreSkills(recReg);
const recorder = new WorldRecorder(SESSION);
recorder.attach(recReg);          // patch invoke -> record top-level commands
recorder.seed(SEED);
const recOps = recorder.wrapOps(ops);
const world = makeWorld(recOps);
const base = { agentId: "agt_p30", sessionId: SESSION, permissions: BUILDER, tick: 1, world };

const topCount = () => recorder.commands.filter((c) => c.kind === "skill").length;

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

// B + C. FIRE-AND-FORGET pair: issue two DIFFERENT invokes synchronously, unawaited.
//   The second enters while the first's chain is live -> folded in -> ONE command.
const beforePair = topCount();
const pa = recReg.invoke("game.flag", { name: "doorOpen", value: true }, base);
const pb = recReg.invoke("game.counter", { name: "coins", action: "increment", value: 1 }, base);
// The collapse is observable synchronously, at issue time (the command is pushed
// synchronously inside the patched invoke, before either promise settles).
assert(topCount() === beforePair + 1,
  `B: a fire-and-forget invoke pair must record EXACTLY ONE top-level command, recorded ${topCount() - beforePair}`);

// Let any (mis)handled rejection surface as a macrotask before we settle the pair.
await ops.op_sleep_ms(1);
const settled = await Promise.allSettled([pa, pb]);
assert(settled.every((s) => s.status === "fulfilled"),
  "C: a fire-and-forget pair-promise REJECTED -- the recorder's `.finally` depth-drop must never throw");
for (const s of settled) {
  assert(s.status === "fulfilled" && (s.value as MCPResponse).success === true, "C: both fire-and-forget invokes must succeed");
}
assert(unhandled === 0, "C: a fire-and-forget invoke produced an UNHANDLED REJECTION (the wave-2 regression)");

// D. After the pair drained, the flag cleared -> a further serial top-level records.
const beforeD = topCount();
ok(await recReg.invoke("game.state", { action: "set", name: "level", value: "cave" }, base));
assert(topCount() === beforeD + 1, "D: after the pair drains, a serial top-level invoke must record again (flag reset)");

// ---- E. REPLAY bit-identical ----------------------------------------------
const recordedState = captureWorldState(world);
assert(recordedState.entities.length === 2, "setup: two entities must be captured in the recorded world");

const replay = await replayCommands(recorder.commands, {
  makeWorld: () => makeWorld(ops),
  makeRegistry: (tr) => {
    const r = new SkillRegistry(tr as LiminaTracer);
    registerCoreSkills(r);
    return r;
  },
  tracer: new LiminaTracer(SESSION + "_replay"),
});
const cmp = compareWorldState(recordedState, replay.state);
assert(cmp.identical, `E: replay diverged from the recorded world (${cmp.comparisons} fields): ${cmp.detail ?? "?"}`);

ops.op_log(
  `p30_recorder_overlap OK: serial top-level invokes each record (${before1 + 4 - before1} commands); ` +
    `a fire-and-forget pair collapses to EXACTLY ONE recorded command with NO unhandled rejection and both promises FULFILLED; ` +
    `the flag resets so a later serial invoke records again; replay of ${recorder.commands.length} commands is BIT-IDENTICAL ` +
    `(${cmp.comparisons} fields, ${replay.state.entities.length} entities).`,
);
