// Phase 12 — PROGRESSION skill seam: XP/leveling, onLevelUp firing, skill-tree
// prerequisite/cost enforcement, unlocks, and REPLAY-EQUIVALENCE.
//
// Pins the contract the progression.* skills MUST honour:
//   1. CLOSURE-BOUND MANAGER: the skills reach the ONE ProgressionManager the core
//      owns (core.progression.progressionManager) — not a never-set world field.
//   2. LEVEL FROM XP: granting XP across the curve's thresholds increments the level
//      deterministically (xpCurve(1)=100, xpCurve(2)=150).
//   3. onLevelUp FIRES: an attached action is STORED and re-fired (emitted as
//      progression.levelUp) once per level gained in the progression.xp grant path.
//   4. SKILL TREE: allocate enforces prerequisites AND skill-point cost — a blocked
//      allocate returns ok:false; an unblocked one succeeds (no fake success).
//   5. REPLAY-EQUIVALENCE: recording the sequence and replaying it into a FRESH core
//      recomputes a BIT-IDENTICAL progression snapshot (deterministic; same default
//      xpCurve on both sides).
//
// Run: ./target/release/limina js/test/p12_progression.ts   (exit 0 = pass)

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
import type { MCPResponse } from "../src/mcp/protocol.ts";

function assert(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new Error("p12_progression FAIL: " + msg);
}
function ok(res: MCPResponse | undefined): Record<string, unknown> {
  if (res === undefined || !res.success) throw new Error("call failed: " + JSON.stringify(res?.error));
  return res.result as Record<string, unknown>;
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

const HERO = "hero";
const TREE = "combat";
const LEVELUP_ACTION = { type: "grantStat", data: { stat: "strength", amount: 1 } };
const BUILDER = resolveProfile("builder.readWrite");

// ── AUTHORING (recorded) ────────────────────────────────────────────────────
const tracer = new LiminaTracer("ses_p12_prog_author");
// Capture progression.levelUp EMITS to prove onLevelUp actually FIRES (not just that
// the skill returns the data). Falsifiable: a stub onLevelUp emits nothing here.
const levelUpEmits: { entity: string; level: number; actions: { type: string }[] }[] = [];
const origEmit = tracer.emit.bind(tracer);
// deno-lint-ignore no-explicit-any
(tracer as any).emit = (e: any) => {
  if (e.type === "progression.levelUp") levelUpEmits.push(e.payload);
  return origEmit(e);
};

const recReg = new SkillRegistry(tracer);
const core: CoreSkills = registerCoreSkills(recReg);
const recorder = new WorldRecorder("ses_p12_prog_author");
recorder.attach(recReg);
const mgr = core.progression.progressionManager;
assert(mgr !== undefined, "core.progression.progressionManager missing");

const world = makeWorld(ops);
const base = { agentId: "agt_builder", sessionId: "ses_p12_prog_author", permissions: BUILDER, tick: 0, world };

// (1) Define a skill tree: `root` (no prereq) then `power` (requires `root`).
ok(await recReg.invoke("progression.skillTree", {
  id: TREE, name: "Combat",
  nodes: [
    { id: "root", name: "Root", cost: 1, maxLevel: 1, effects: { dmg: 1 } },
    { id: "power", name: "Power Strike", prerequisites: ["root"], cost: 1, maxLevel: 1, effects: { dmg: 5 } },
  ],
}, base));

// (2) Attach an onLevelUp action BEFORE granting XP, so it is stored + fires on level-up.
ok(await recReg.invoke("progression.onLevelUp", { entity: HERO, action: LEVELUP_ACTION }, base));

// (3) Grant XP across TWO level boundaries: xpCurve(1)=100, xpCurve(2)=150 -> 250 reaches L3.
const grant = ok(await recReg.invoke("progression.xp", { entity: HERO, amount: 250 }, base));
assert(grant.leveledUp === true, "250 XP should level up");
assert(grant.newLevel === 3, `expected level 3 after 250 XP, got ${grant.newLevel}`);
const levelUps = grant.levelUps as { level: number; actions: { type: string }[] }[];
assert(levelUps.length === 2, `expected 2 level-up events (L2,L3), got ${levelUps.length}`);
assert(levelUps[0].level === 2 && levelUps[1].level === 3, "level-up events out of order");
assert(levelUps.every((e) => e.actions.some((a) => a.type === LEVELUP_ACTION.type)), "onLevelUp action not carried in the level-up events");
// The action actually FIRED (emitted) once per level gained.
assert(levelUpEmits.length === 2, `expected 2 progression.levelUp emits, got ${levelUpEmits.length}`);
assert(levelUpEmits.every((e) => e.actions.some((a) => a.type === LEVELUP_ACTION.type)), "fired level-up event missing the attached action");

// (2b) Level read is computed from XP via the curve.
const lvl = ok(await recReg.invoke("progression.level", { entity: HERO }, base));
assert(lvl.level === 3, `progression.level should report 3, got ${lvl.level}`);

// (4) Skill-tree allocation enforces prerequisites AND cost. Hero has 2 skill points.
const blocked = ok(await recReg.invoke("progression.allocate", { entity: HERO, treeId: TREE, nodeId: "power" }, base));
assert(blocked.ok === false, "allocating `power` before `root` must be BLOCKED (prereq)");
const allocRoot = ok(await recReg.invoke("progression.allocate", { entity: HERO, treeId: TREE, nodeId: "root" }, base));
assert(allocRoot.ok === true, "allocating `root` (no prereq, enough points) must succeed");
const allocPower = ok(await recReg.invoke("progression.allocate", { entity: HERO, treeId: TREE, nodeId: "power" }, base));
assert(allocPower.ok === true, "allocating `power` after `root` (prereq met, points left) must succeed");
const overflow = ok(await recReg.invoke("progression.allocate", { entity: HERO, treeId: TREE, nodeId: "power" }, base));
assert(overflow.ok === false, "re-allocating `power` past its maxLevel must be BLOCKED");

// (5) Unlock / isUnlocked.
const u1 = ok(await recReg.invoke("progression.unlock", { entity: HERO, id: "dash" }, base));
assert(u1.newlyUnlocked === true, "first unlock of `dash` should be newly unlocked");
const u2 = ok(await recReg.invoke("progression.unlock", { entity: HERO, id: "dash" }, base));
assert(u2.newlyUnlocked === false, "re-unlock of `dash` should not be newly unlocked");
assert((ok(await recReg.invoke("progression.isUnlocked", { entity: HERO, id: "dash" }, base)).unlocked) === true, "dash should be unlocked");
assert((ok(await recReg.invoke("progression.isUnlocked", { entity: HERO, id: "fly" }, base)).unlocked) === false, "fly should NOT be unlocked");

// Snapshot authoring progression state.
const authSnap = mgr.snapshot();

// The recorded stream carries the progression skills (sanity / falsifiability).
const tools = recorder.commands.filter((c): c is { kind: "skill"; tool: string } => c.kind === "skill").map((c) => c.tool);
assert(tools.includes("progression.xp") && tools.includes("progression.allocate") && tools.includes("progression.onLevelUp"),
  "progression skills were not recorded");

// ── REPLAY-EQUIVALENCE: replay the stream into a FRESH core, snapshot, compare ──
let replayCore: CoreSkills | undefined;
await replayCommands(recorder.commands, {
  makeWorld: () => makeWorld(ops),
  makeRegistry: (tr) => {
    const r = new SkillRegistry(tr as LiminaTracer);
    replayCore = registerCoreSkills(r);
    return r;
  },
  tracer: new LiminaTracer("ses_p12_prog_replay"),
});
assert(replayCore !== undefined, "replay did not construct a core");
const replaySnap = replayCore.progression.progressionManager.snapshot();
assert(replaySnap === authSnap, `replay progression snapshot diverged:\n  auth=${authSnap}\n  replay=${replaySnap}`);

ops.op_log(
  `p12_progression OK: closure-bound manager; 250 XP -> L3 (curve 100/150) firing ${levelUpEmits.length} progression.levelUp events ` +
  `(onLevelUp action stored + fired); skill-tree allocate enforces prereq + cost (power-before-root blocked, root then power succeed, overflow blocked); ` +
  `unlock/isUnlocked correct; replay into a fresh core recomputes a BIT-IDENTICAL snapshot.`,
);
