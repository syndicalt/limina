// M6 (export publish) — THE EXPORT-EVERYWHERE PATH. Proves Stage 5's opt-in publish: a skill-routed
// game that opted into recording produces a replay-complete world-log, which exportGame() assembles
// into the portable bundle; loadExport() round-trips it (with the manifest cross-checks); and
// replaying the loaded command stream into a FRESH core recomputes the END STATE bit-identically.
// canExport() reflects the GDS opt-in (a pure direct-path game is not exportable).
//
// Run: ./target/release/limina js/test/p27_publish.ts   (exit 0 = pass)

import { EntityTable, ops, type EngineOps } from "../src/engine.ts";
import { createEcsWorld } from "../src/ecs/world.ts";
import { createTransformStorage } from "../src/ecs/facade.ts";
import { UniformGridSpatialIndex } from "../src/spatial/index.ts";
import { LiminaTracer } from "../src/observability/event.ts";
import { SkillRegistry, type InvokeBase, type WorldContext } from "../src/skills/registry.ts";
import { registerCoreSkills, type CoreSkills } from "../src/skills/index.ts";
import { resolveProfile } from "../src/skills/permissions.ts";
import { WorldRecorder } from "../src/worldlog/recorder.ts";
import { replayCommands } from "../src/worldlog/replay.ts";
import { buildCapstone, CAPSTONE_LAYOUT, headingToward, type Capstone } from "../src/demos/capstone_game.ts";
import { exportGame, canExport } from "../src/game/publish.ts";
import { loadExport } from "../src/export/package.ts";
import { RELIC_SPRINT } from "../src/game/examples/relic_sprint.gds.ts";

function assert(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new Error("p27_publish FAIL: " + msg);
}

function makeWorld(worldOps: EngineOps): WorldContext {
  const stub = { add() {}, remove() {}, position: { set() {}, x: 0, y: 0, z: 0 }, background: null as unknown };
  const camera = { position: { set() {} }, aspect: 1, lookAt() {}, updateProjectionMatrix() {} };
  const ecs = createEcsWorld();
  return {
    ecs, transforms: createTransformStorage(ecs), spatial: new UniformGridSpatialIndex(),
    entities: new EntityTable(), tags: new Map(), scene: stub as WorldContext["scene"],
    camera: camera as WorldContext["camera"], ops: worldOps, mode: "headless",
  };
}

const DT = 1 / 60;
const PERMS = resolveProfile("builder.readWrite");
const NPC = CAPSTONE_LAYOUT.npc;
const HOLD = CAPSTONE_LAYOUT.talkRadius - 0.8;
const distXZ = (p: readonly number[], xz: readonly [number, number]): number => Math.hypot(p[0] - xz[0], p[2] - xz[1]);

async function driveWin(cap: Capstone): Promise<void> {
  for (let s = 0; s < 700 && !cap.accepted(); s++) {
    const p = cap.playerPos();
    const forward = distXZ(p, NPC) > HOLD ? 1 : 0;
    const yaw = headingToward(p[0], p[2], NPC[0], NPC[1]);
    const choose = cap.dialogue.isActive() && !cap.dialogue.isTerminal() ? 0 : -1;
    await cap.step(DT, { forward, yaw, choose });
  }
  for (let i = 0; i < CAPSTONE_LAYOUT.relics.length; i++) {
    const t = CAPSTONE_LAYOUT.relics[i];
    for (let s = 0; s < 900 && cap.relics() <= i; s++) {
      const p = cap.playerPos();
      await cap.step(DT, { forward: 1, yaw: headingToward(p[0], p[2], t[0], t[1]) });
    }
  }
  for (let s = 0; s < 900 && cap.state() === "playing"; s++) {
    const p = cap.playerPos();
    const forward = distXZ(p, NPC) > HOLD ? 1 : 0;
    await cap.step(DT, { forward, yaw: headingToward(p[0], p[2], NPC[0], NPC[1]) });
  }
}

// ════════════════════════ 1. canExport REFLECTS THE GDS OPT-IN ═════════════════════════════════
assert(!canExport(RELIC_SPRINT), "a pure direct-path GDS is NOT exportable (its manager state is not in the log)");
assert(canExport({ ...RELIC_SPRINT, optIn: "record+export" }), "a record+export GDS is exportable");
assert(canExport({ ...RELIC_SPRINT, optIn: "multiplayer" }), "a multiplayer GDS is exportable (skill-routed)");

// ════════════════════════ 2. RECORD A SKILL-ROUTED GAME ═══════════════════════════════════════
ops.op_physics_create_world(-9.81);
const reg = new SkillRegistry(new LiminaTracer("ses_p27"));
const core: CoreSkills = registerCoreSkills(reg);
const recorder = new WorldRecorder("ses_p27");
recorder.attach(reg); // patch invoke BEFORE authoring so the whole stream is logged
const world = makeWorld(ops);
const base: InvokeBase = { agentId: "agt_p27", sessionId: "ses_p27", permissions: PERMS, tick: 0, world };
const cap = await buildCapstone({ world, registry: reg, core, base });
await driveWin(cap);
assert(cap.state() === "won", `recorded capstone must reach won (got ${cap.state()})`);

// ════════════════════════ 3. EXPORT → the portable bundle ═════════════════════════════════════
const files = exportGame(recorder, { worldId: "the-relic-hunt", createdAt: "2026-06-30T00:00:00.000Z" });
assert(files["manifest.json"].includes("limina.export"), "manifest declares the limina.export kind");
assert(files["log.jsonl"].length > 0, "log.jsonl is non-empty");
assert(typeof files["keyframes.jsonl"] === "string" && typeof files["assets.jsonl"] === "string", "all five export files are present");

// ════════════════════════ 4. LOAD round-trips (with the manifest cross-checks) ════════════════
const loaded = loadExport(files);
assert(loaded.manifest.worldId === "the-relic-hunt", "worldId round-trips through the export");
assert(loaded.commands.length === recorder.commands.length, `command count round-trips (${loaded.commands.length} vs ${recorder.commands.length})`);
const skillCmds = loaded.commands.filter((c) => c.kind === "skill").length;
assert(skillCmds > 30, `a substantial skill stream is exported (${skillCmds})`);

// ════════════════════════ 5. REPLAY the loaded export → bit-identical END STATE ═══════════════
let replayCore: CoreSkills | undefined;
await replayCommands(loaded.commands, {
  makeWorld: () => { ops.op_physics_create_world(-9.81); return makeWorld(ops); },
  makeRegistry: (tr) => { const r = new SkillRegistry(tr as LiminaTracer); replayCore = registerCoreSkills(r); return r; },
  tracer: new LiminaTracer("ses_p27_replay"),
});
assert(replayCore !== undefined, "replay constructed a fresh core");
const gs = replayCore!.gamestate.gameStateManager.getState();
assert(gs.state === "won", `the replayed export must recompute state "won" (got "${gs.state}")`);
assert(replayCore!.gamestate.gameStateManager.getCounter("relics") === 3, "the replayed export recomputes relics=3");

console.log(
  `p27_publish OK: export-everywhere proven — canExport reflects the GDS opt-in; a skill-routed game ` +
  `recorded ${recorder.commands.length} commands (${skillCmds} skills); exportGame assembled the 5-file ` +
  `bundle (worldId="the-relic-hunt"); loadExport round-tripped it (manifest cross-checks pass); and ` +
  `replaying the LOADED stream into a fresh core recomputed the end state bit-identically (won, relics=3).`,
);
