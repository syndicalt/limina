// Phase 15 (Track D — Studio) — THE "GIT FOR WORLDS" GATE.
//
// WorldHistory is version control over a world's deterministic command log. This gate proves the
// load-bearing claim — that TIME-TRAVEL is real: replaying a command PREFIX reconstructs the world
// exactly as it was at that point (fewer entities for a shorter prefix) — and that BRANCH / DIFF /
// MERGE behave like git over the log: a fork shares history, a diff finds the common prefix + the
// divergent commands, and a merge fast-forwards a prefix or appends a divergence.
//
// Run: ./target/release/limina js/test/p15_history.ts   (exit 0 = pass)

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
import { WorldHistory } from "../src/worldlog/history.ts";
import type { WorldCommand } from "../src/worldlog/log.ts";

function assert(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new Error("p15_history FAIL: " + msg);
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

// ── Record a base session: author three boxes through skills, capturing the command log. ──────
ops.op_physics_create_world(-9.81);
const recReg = new SkillRegistry(new LiminaTracer("ses_p15_history"));
registerCoreSkills(recReg);
const recorder = new WorldRecorder("ses_p15_history");
recorder.attach(recReg); // patch the invoke choke point BEFORE authoring
const recWorld = makeWorld(ops);
const recBase: InvokeBase = { agentId: "agt", sessionId: "ses_p15_history", permissions: PERMS, tick: 0, world: recWorld };
for (const x of [0, 5, 10]) {
  await recReg.invoke("scene.createEntity", { shape: "box", position: [x, 0, 0] }, recBase);
}
const baseCommands: WorldCommand[] = recorder.commands.map((c) => ({ ...c }) as WorldCommand);
const skillCount = baseCommands.filter((c) => c.kind === "skill").length;
assert(skillCount === 3, `recorded 3 createEntity skill commands (got ${skillCount})`);

/** Replay a command list into a FRESH core and return the reconstructed world's entity count. */
async function entitiesAfter(commands: WorldCommand[]): Promise<number> {
  let world: WorldContext | undefined;
  let reg: SkillRegistry | undefined;
  await replayCommands(commands, {
    makeWorld: () => { ops.op_physics_create_world(-9.81); world = makeWorld(ops); return world; },
    makeRegistry: (tr) => { reg = new SkillRegistry(tr as LiminaTracer); registerCoreSkills(reg); return reg; },
    tracer: new LiminaTracer("ses_p15_history_replay"),
  });
  assert(reg !== undefined && world !== undefined, "replay constructed a core");
  const r = (await reg.invoke("scene.inspect", {}, { agentId: "a", sessionId: "s", permissions: PERMS, tick: 0, world })).result as { entityCount: number };
  return r.entityCount;
}

const hist = new WorldHistory(baseCommands);
const len = hist.tip("main");

// ── 1. TIME-TRAVEL: a shorter prefix reconstructs an EARLIER world (fewer entities). ──────────
{
  const full = await entitiesAfter(hist.at("main", len));
  const drop1 = await entitiesAfter(hist.at("main", len - 1));
  const drop2 = await entitiesAfter(hist.at("main", len - 2));
  assert(full === 3, `the full log reconstructs all 3 entities (got ${full})`);
  assert(drop1 === 2, `dropping the last command time-travels to 2 entities (got ${drop1})`);
  assert(drop2 === 1, `dropping the last two commands time-travels to 1 entity (got ${drop2})`);
}

// ── 2. BRANCH + DIFF: a fork at the tip shares all history; extending it diverges by one. ─────
{
  assert(hist.fork("experiment", "main"), "forked 'experiment' from 'main'");
  assert(hist.diff("main", "experiment").identical, "a fresh fork is identical to its source");
  // Extend the branch with one more authored command (reuse the last command's shape).
  const oneMore = baseCommands.filter((c) => c.kind === "skill").slice(-1);
  hist.extend("experiment", oneMore);
  const d = hist.diff("main", "experiment");
  assert(d.commonPrefix === len && d.aOnly.length === 0 && d.bOnly.length === 1 && !d.identical,
    `diff: common prefix ${len}, main-only 0, exp-only 1 (got ${d.commonPrefix}/${d.aOnly.length}/${d.bOnly.length})`);
  assert((await entitiesAfter(hist.commands("experiment"))) === 4, "the branch reconstructs 4 entities (it really diverged)");
  assert((await entitiesAfter(hist.commands("main"))) === 3, "main is untouched by the branch (still 3)");
}

// ── 3. BRANCH AT AN EARLIER POINT: fork shares only the prefix, then both diverge. ────────────
{
  assert(hist.fork("alt", "main", len - 1), "forked 'alt' from main at an earlier point");
  assert(hist.tip("alt") === len - 1, `'alt' holds only the shared prefix (${len - 1})`);
  hist.extend("alt", baseCommands.filter((c) => c.kind === "skill").slice(0, 1)); // a different last command
  const d = hist.diff("main", "alt");
  assert(d.commonPrefix === len - 1 && d.aOnly.length === 1 && d.bOnly.length === 1,
    `early fork diverges: common ${len - 1}, each side 1 (got ${d.commonPrefix}/${d.aOnly.length}/${d.bOnly.length})`);
}

// ── 4. MERGE: fast-forward when the target is a prefix; append when divergent. ────────────────
{
  const h2 = new WorldHistory(baseCommands);
  h2.fork("feature", "main");
  h2.extend("feature", baseCommands.filter((c) => c.kind === "skill").slice(-1)); // feature = main + 1
  const ff = h2.merge("main", "feature");
  assert(ff.kind === "fast-forward" && ff.added === 1, `prefix target fast-forwards (got ${ff.kind}, +${ff.added})`);
  assert(h2.diff("main", "feature").identical, "after fast-forward, main == feature");

  // Now a divergent merge: 'side' branched earlier, with its own commit.
  h2.fork("side", "main", h2.tip("main") - 1);
  h2.extend("side", baseCommands.filter((c) => c.kind === "skill").slice(0, 1));
  const before = h2.tip("main");
  const m = h2.merge("main", "side");
  assert(m.kind === "appended" && m.added === 1, `divergent merge appends (got ${m.kind}, +${m.added})`);
  assert(h2.tip("main") === before + 1, "main grew by the merged commit");
}

// ── 5. DETERMINISM: replaying the same log twice reconstructs the same state. ─────────────────
{
  const a = await entitiesAfter(hist.commands("main"));
  const b = await entitiesAfter(hist.commands("main"));
  assert(a === b, `replay is deterministic (${a} vs ${b})`);
}

ops.op_log(
  "p15_history OK: git-for-worlds over the deterministic log — TIME-TRAVEL (a shorter prefix replays to an earlier " +
  "world: 3→2→1 entities); BRANCH shares history and diverges independently; DIFF finds the common prefix + each side's " +
  "unique commands; MERGE fast-forwards a prefix target and appends a divergence; replay is deterministic.",
);
