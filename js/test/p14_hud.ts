// Phase 14 — the game HUD helper (world/game_hud.ts).
//
// Proves the screen-anchored HUD overlay mirrors LIVE player + quest state onto the
// A4 UI surface, reading the closure-owned managers core exposes (the SAME instances
// the skills mutate) and writing only to the UiManager:
//
//   - stats (hp) + a tracked quest with an objective on a player entity → GameHud.init()
//     + update() composes the vitals + quest tracker lines (HP value, quest name, "p / r").
//   - TEETH: modifying HP (stats.modify) + advancing the objective (quest.update) and
//     calling update() again CHANGES the HUD lines to the new values — a static HUD fails.
//   - graceful: an entity with no stats/quest → "HP  --" + the no-quest line, never a throw.
//   - dispose() removes the panels (the UiManager holds no hud handles afterwards), and the
//     scene stub records the panel meshes being added on init and removed on dispose.
//   - RENDER-ONLY: the helper reads managers + writes UI; it never records sim/log state.
//
// Run: limina js/test/p14_hud.ts   (exit 0 = pass)

import { EntityTable, ops, type EngineOps } from "../src/engine.ts";
import { createEcsWorld } from "../src/ecs/world.ts";
import { createTransformStorage } from "../src/ecs/facade.ts";
import { UniformGridSpatialIndex } from "../src/spatial/index.ts";
import { LiminaTracer } from "../src/observability/event.ts";
import { SkillRegistry, type InvokeBase, type WorldContext } from "../src/skills/registry.ts";
import { registerCoreSkills, type CoreSkills } from "../src/skills/index.ts";
import { resolveProfile } from "../src/skills/permissions.ts";
import { GameHud } from "../src/world/game_hud.ts";
import type { MCPResponse } from "../src/mcp/protocol.ts";

function assert(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new Error("p14_hud FAIL: " + msg);
}
function ok(res: MCPResponse): Record<string, unknown> {
  if (!res.success) throw new Error("p14_hud call failed: " + JSON.stringify(res.error));
  return (res.result ?? {}) as Record<string, unknown>;
}

ops.op_physics_create_world(0);
const PROFILE = resolveProfile("builder.readWrite");
const PLAYER = "hero";

/** A scene stub that RECORDS the objects added/removed (the panel meshes ride through
 *  UiManager.create → scene.add and remove → scene.remove). */
function makeScene() {
  const objects = new Set<unknown>();
  return {
    objects,
    add(o: unknown) { objects.add(o); },
    remove(o: unknown) { objects.delete(o); },
    position: { set() {}, x: 0, y: 0, z: 0 },
    background: null as unknown,
  };
}
type RecordingScene = ReturnType<typeof makeScene>;

function makeWorld(scene: RecordingScene, worldOps: EngineOps): WorldContext {
  const camera = { position: { set() {} }, aspect: 1, lookAt() {}, updateProjectionMatrix() {} };
  const ecs = createEcsWorld();
  return {
    ecs, transforms: createTransformStorage(ecs), spatial: new UniformGridSpatialIndex(),
    entities: new EntityTable(), tags: new Map(), scene: scene as unknown as WorldContext["scene"],
    camera: camera as WorldContext["camera"], ops: worldOps, mode: "headless",
  };
}

// ── core wiring: the managers GameHud reads come straight from core ───────────────
const registry = new SkillRegistry(new LiminaTracer("ses_p14_hud"));
const core: CoreSkills = registerCoreSkills(registry);
const scene = makeScene();
const world = makeWorld(scene, ops);
const at = (tick: number): InvokeBase => ({ agentId: "agt_hud", sessionId: "ses_p14_hud", permissions: PROFILE, tick, world });
const call = (tool: string, input: unknown, tick = 0) => registry.invoke(tool, input, at(tick));

// (1) Author player vitals (hp 80/100) and a tracked quest with one objective.
ok(await call("stats.create", { entity: PLAYER, stats: [{ name: "hp", value: 80, maxValue: 100 }] }));
ok(await call("quest.define", {
  id: "q_relics", name: "Gather Relics",
  objectives: [{ id: "relics", type: "collect", description: "Collect relics", required: 3 }],
}));
assert(ok(await call("quest.offer", { entity: PLAYER, questId: "q_relics" }, 5)).ok === true, "offer failed");
assert(ok(await call("quest.accept", { entity: PLAYER, questId: "q_relics" }, 10)).ok === true, "accept failed");
assert(ok(await call("quest.track", { entity: PLAYER, questId: "q_relics" }, 11)).ok === true, "track failed");

// ── build the HUD over the core managers ─────────────────────────────────────────
const baselinePanels = core.ui.size; // fresh core → 0
const hud = new GameHud({
  uiManager: core.ui,
  world,
  managers: {
    stats: core.combat.statsManager,
    quest: core.quest.questManager,
    inventory: core.inventory.inventoryManager,
    gamestate: core.gamestate.gameStateManager,
  },
});
hud.init();
hud.update(PLAYER);

// (2) The panels exist, the scene recorded both meshes, and the lines reflect state.
assert(core.ui.size === baselinePanels + 2, `init should create 2 panels, ui.size=${core.ui.size}`);
assert(scene.objects.size === 2, `scene should have recorded 2 panel meshes, got ${scene.objects.size}`);
const handles = hud.handles();
assert(handles.vitals !== undefined && handles.quest !== undefined, "init must store both panel handles");
assert(core.ui.has(handles.vitals) && core.ui.has(handles.quest), "both handles must be live in the UiManager");

const vitals0 = hud.lines("vitals");
const quest0 = hud.lines("quest");
assert(vitals0.includes("HP  80 / 100"), `vitals should show HP 80/100: ${JSON.stringify(vitals0)}`);
assert(hud.questTitle() === "Gather Relics", `quest title should be the quest name: ${hud.questTitle()}`);
assert(quest0.includes("Collect relics"), `quest should show the objective description: ${JSON.stringify(quest0)}`);
assert(quest0.includes("  0 / 3"), `quest should show 0/3 progress: ${JSON.stringify(quest0)}`);

// (3) TEETH — mutate HP + advance the objective, update() again, lines CHANGE.
ok(await call("stats.modify", { entity: PLAYER, statName: "hp", delta: -30 }, 20)); // 80 → 50
ok(await call("quest.update", { entity: PLAYER, questId: "q_relics", objectiveId: "relics", progress: 2 }, 20));
hud.update(PLAYER);

const vitals1 = hud.lines("vitals");
const quest1 = hud.lines("quest");
assert(vitals1.includes("HP  50 / 100"), `vitals should update to HP 50/100: ${JSON.stringify(vitals1)}`);
assert(quest1.includes("  2 / 3"), `quest should update to 2/3: ${JSON.stringify(quest1)}`);
assert(JSON.stringify(vitals1) !== JSON.stringify(vitals0), "vitals lines must CHANGE (a static HUD would fail)");
assert(JSON.stringify(quest1) !== JSON.stringify(quest0), "quest lines must CHANGE (a static HUD would fail)");

// (4) setQuest pins explicitly; auto-track resumes when cleared.
hud.setQuest("q_relics");
hud.update(PLAYER);
assert(hud.questTitle() === "Gather Relics", "explicit setQuest should still show the relics quest");
hud.setQuest(null); // back to auto-tracking
hud.update(PLAYER);
assert(hud.questTitle() === "Gather Relics", "auto-track should still resolve the tracked quest");

// (5) GRACEFUL — an entity with no stats and no quest renders sensible defaults, no throw.
const ghostScene = makeScene();
const ghostWorld = makeWorld(ghostScene, ops);
const ghostHud = new GameHud({
  uiManager: core.ui,
  world: ghostWorld,
  managers: { stats: core.combat.statsManager, quest: core.quest.questManager },
});
ghostHud.init();
ghostHud.update("ghost"); // never authored — must not throw
const gVit = ghostHud.lines("vitals");
const gQuest = ghostHud.lines("quest");
assert(gVit.includes("HP  --"), `missing stat should render "HP  --": ${JSON.stringify(gVit)}`);
assert(gQuest.includes("No active quest"), `missing quest should render the no-quest line: ${JSON.stringify(gQuest)}`);
ghostHud.dispose();
assert(core.ui.size === baselinePanels + 2, "disposing the ghost HUD should leave only the main HUD's panels");

// (6) dispose() removes the panels — the UiManager holds no hud handles afterwards.
const vitalsHandle = handles.vitals;
const questHandle = handles.quest;
hud.dispose();
assert(core.ui.size === baselinePanels, `dispose must remove both panels, ui.size=${core.ui.size}`);
assert(!core.ui.has(vitalsHandle) && !core.ui.has(questHandle), "disposed handles must no longer be live");
assert(scene.objects.size === 0, `dispose must remove the panel meshes from the scene, got ${scene.objects.size}`);
assert(hud.handles().vitals === undefined && hud.handles().quest === undefined, "dispose must forget the handles");
hud.dispose(); // idempotent — must not throw

ops.op_log(
  `p14_hud OK: GameHud.init() creates a top-left vitals + top-right quest panel on the UiManager ` +
  `(scene recorded 2 meshes); update(hero) reads core.combat.statsManager (HP 80/100) + core.quest.questManager ` +
  `(title "Gather Relics", objective "Collect relics" 0/3); after stats.modify (-30) + quest.update (progress 2), ` +
  `update() CHANGES the lines to HP 50/100 and 2/3 (static HUD fails); setQuest pin + auto-track resolve the tracked quest; ` +
  `missing stat/quest render "HP  --" + "No active quest" without throwing; dispose() removes both panels ` +
  `(ui.size back to ${baselinePanels}, scene cleared) and is idempotent.`,
);
