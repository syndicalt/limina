// Phase 16 (Track D — Studio) — THE EDITOR HISTORY-CONTROLLER GATE.
//
// EditorHistoryController is the stateful control layer the editor UI binds to: checked-out branch,
// time-travel playhead, and the command prefix the viewport replays. This gate proves the wiring
// logic the UI drives: the initial view, scrubbing the playhead time-travels the RENDERED world
// (commandsAtPlayhead replays to the right state), branching/checkout/commit/diff/merge behave,
// committing is refused while scrubbed (so history can't silently fork), and "branch from here"
// forks at the playhead. The DOM/canvas binding is the browser app's job; THIS logic is tested.
//
// Run: ./target/release/limina js/test/p16_editor_controller.ts   (exit 0 = pass)

import { EntityTable, ops, type EngineOps } from "../src/engine.ts";
import { createEcsWorld } from "../src/ecs/world.ts";
import { createTransformStorage } from "../src/ecs/facade.ts";
import { UniformGridSpatialIndex } from "../src/spatial/index.ts";
import { LiminaTracer } from "../src/observability/event.ts";
import { SkillRegistry, type InvokeBase, type WorldContext } from "../src/skills/registry.ts";
import { registerCoreSkills } from "../src/skills/index.ts";
import { resolveProfile } from "../src/skills/permissions.ts";
import { WorldRecorder } from "../src/worldlog/recorder.ts";
import { replayCommands } from "../src/worldlog/replay.ts";
import { worldStateDigest } from "../src/worldlog/verify.ts";
import { EditorHistoryController } from "../src/editor/history_controller.ts";
import type { WorldCommand } from "../src/worldlog/log.ts";

function assert(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new Error("p16_editor_controller FAIL: " + msg);
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

async function authorEdits(session: string, positions: [number, number, number][]): Promise<WorldCommand[]> {
  ops.op_physics_create_world(-9.81);
  const reg = new SkillRegistry(new LiminaTracer(session));
  registerCoreSkills(reg);
  const rec = new WorldRecorder(session);
  rec.attach(reg);
  const world = makeWorld(ops);
  const base: InvokeBase = { agentId: session, sessionId: session, permissions: PERMS, tick: 0, world };
  for (const p of positions) await reg.invoke("scene.createEntity", { shape: "box", position: p }, base);
  return rec.commands.filter((c) => c.kind === "skill").map((c) => ({ ...c }) as WorldCommand);
}
async function replayEntityCount(commands: WorldCommand[]): Promise<number> {
  let world: WorldContext | undefined;
  await replayCommands(commands, {
    makeWorld: () => { ops.op_physics_create_world(-9.81); world = makeWorld(ops); return world; },
    makeRegistry: (tr) => { const r = new SkillRegistry(tr as LiminaTracer); registerCoreSkills(r); return r; },
    tracer: new LiminaTracer("ses_p16_editor_replay"),
  });
  assert(world !== undefined, "replay built a world");
  return Number(worldStateDigest(world).split("|")[0]);
}

const base = await authorEdits("ses_base", [[0, 0, 0], [4, 0, 0], [8, 0, 0]]); // 3 boxes
const oneMore = await authorEdits("ses_more", [[12, 0, 0]]); // a 4th box command to commit

// ── 1. Initial view + time-travel scrub drives the rendered world. ────────────────────────────
{
  const ctrl = new EditorHistoryController(base);
  const v = ctrl.view();
  assert(v.current === "main" && v.tip === 3 && v.live && v.playhead === 3, `initial view: main, tip 3, live (got ${JSON.stringify(v)})`);
  assert(ctrl.branches().length === 1, "one branch to start");

  // Scrub the playhead back; the viewport's commands must replay to the EARLIER world.
  ctrl.scrub(1);
  assert(!ctrl.isLive() && ctrl.playheadAt() === 1, "scrubbed to playhead 1 (not live)");
  assert((await replayEntityCount(ctrl.commandsAtPlayhead())) === 1, "the time-travel viewport shows 1 entity at playhead 1");
  ctrl.scrub(2);
  assert((await replayEntityCount(ctrl.commandsAtPlayhead())) === 2, "scrubbing forward to 2 shows 2 entities");
  assert(ctrl.scrub(99) === 3, "scrub clamps to the tip");
  ctrl.toLive();
  assert(ctrl.isLive() && (await replayEntityCount(ctrl.commandsAtPlayhead())) === 3, "snapping live shows all 3 entities");
}

// ── 2. Branch → checkout → commit → diff. ─────────────────────────────────────────────────────
{
  const ctrl = new EditorHistoryController(base);
  assert(ctrl.createBranch("experiment"), "created 'experiment' from main");
  assert(ctrl.branches().some((b) => b.name === "experiment"), "the branch list shows 'experiment'");
  assert(ctrl.checkout("experiment") && ctrl.currentBranch() === "experiment", "checked out 'experiment'");
  assert(ctrl.commit(oneMore) === 4, "committed a 4th edit to the branch (tip 4)");
  assert((await replayEntityCount(ctrl.commandsAtPlayhead())) === 4, "the branch viewport shows 4 entities");
  const d = ctrl.diff("main", "experiment");
  assert(d.commonPrefix === 3 && d.bOnly.length === 1, `diff main↔experiment: common 3, +1 on the branch (got ${d.commonPrefix}/${d.bOnly.length})`);
}

// ── 3. Commit is refused while scrubbed; "branch from here" forks at the playhead. ────────────
{
  const ctrl = new EditorHistoryController(base);
  ctrl.scrub(1); // viewing the past
  assert(ctrl.commit(oneMore) === -1, "committing while scrubbed is refused (history can't silently fork)");
  assert(ctrl.createBranch("from-here"), "branch-from-here forks at the playhead");
  assert(ctrl.checkout("from-here") && ctrl.tip() === 1, "the new branch holds only the scrubbed prefix (tip 1)");
}

// ── 4. Merge brings a branch's work back and snaps the current branch live. ──────────────────
{
  const ctrl = new EditorHistoryController(base);
  ctrl.createBranch("feature");
  ctrl.checkout("feature");
  ctrl.commit(oneMore);             // feature = main + 1
  ctrl.checkout("main");
  ctrl.scrub(1);                    // scrub main into the past first
  const m = ctrl.merge("main", "feature");
  assert(m.kind === "fast-forward" && m.added === 1, `merging feature fast-forwards main (+1), got ${m.kind} +${m.added}`);
  assert(ctrl.isLive() && ctrl.tip() === 4, "merge into the current branch snaps it live at the new tip (4)");
  assert((await replayEntityCount(ctrl.commandsAtPlayhead())) === 4, "the merged world shows all 4 entities");
}

ops.op_log(
  "p16_editor_controller OK: the editor's history-control layer — initial view, time-travel scrub that drives the " +
  "rendered world (commandsAtPlayhead replays to 1→2→3 entities), branch/checkout/commit/diff, commit refused while " +
  "scrubbed (no silent history fork) with branch-from-here, and merge that snaps the current branch live. The wiring " +
  "seam the editor UI binds to, tested headlessly.",
);
