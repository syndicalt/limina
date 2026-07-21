// p104 — SNAPSHOT PARTICIPANT REGISTRY + COLLIDER OWNERSHIP (adversarial-review
// fixes H2 + M18, PRs B3+B4).
//
// THE BUG THIS GATE PINS (H2): snapshot v3 declares itself SELF-SUFFICIENT but
// captured only physics/transforms/identity/RNG/per-entity state (+ the two
// bespoke `characters`/`events` params). Every other stateful CoreSkills manager
// — inventories, quest progress, interactable state (`def.state.open`), game
// flags, triggers, stats — rebuilt EMPTY on restore, and because pre-snapshot
// commands are excluded from the delta, that state was simply gone. No gate saw
// it: compareWorldState compares entities, not managers.
//
// THE FIX UNDER TEST (B3): every manager owning runtime-mutated sim state is a
// SnapshotParticipant (key + schema + deterministic sorted capture + wholesale
// restore), assembled by registerCoreSkills as `core.snapshotParticipants` — the
// ONE object hosts pass. `WorldSnapshot.managers` is additive-optional within
// v3: old snapshots restore exactly the pre-H2 behavior; a managers entry whose
// key has NO registered participant fails LOUDLY.
//
// AND (B4 / M18): asset.place's standalone building collider is owned by a
// runtime closure the snapshot could not carry — destroying a RESTORED placed
// asset leaked an invisible wall. `EntityEntry.runtimeBodyIds` persists the
// ownership; restore re-arms the remove-body dispose from the ids.
//
// PROOF SHAPE:
//   1. Author manager state THROUGH SKILLS (inventory add/equip, quest
//      define/offer/accept/update, game state/flag/counter/timer/condition,
//      trigger + listener, door opened via interaction, stats/status/defend,
//      ability cooldown, progression, world time/weather, cutscene mid-playback,
//      director running, event.define, a placed asset with a standalone
//      collider, a navmesh portal, a MID-TREE behavior assignment with an
//      active tick-stamped goal, an IN-PROGRESS dialogue session mid-tree).
//      captureWorldSnapshot → recoverWorld (EMPTY
//      delta) → every participant's capture() is bit-exact (JSON) vs
//      pre-snapshot, and the recovered entity state matches bit-identically.
//   2. Double-capture determinism: two captures of the unchanged world are
//      byte-identical (sorted/canonical participant captures).
//   3. B4: scene.destroyEntity on the RESTORED placed asset removes its
//      standalone collider from the native world (overlap probe → 0).
//   4. FALSIFIABILITY (a): restoring with one participant unregistered THROWS
//      naming the key (and stripping that manager's entry instead yields a
//      capture that DIVERGES from pre-snapshot — the bit-exact check detects
//      the original bug).
//   5. FALSIFIABILITY (b): with `runtimeBodyIds` stripped from the snapshot,
//      the destroy leaks the collider (probe → 1) — the part-3 assert fails
//      without the B4 restore.
//   6. COMPAT: an old-format snapshot (no `managers` field) still restores — a
//      valid world, participants empty. An UNKNOWN managers key fails loudly.
//      The hot-path exemption (includeManagers:false) captures managers = {}.
//
// Run: LIMINA_AUDIO=null ./target/release/limina js/test/p104_snapshot_participants.ts

import { EntityTable, ops, type EngineOps } from "../src/engine.ts";
import { createEcsWorld } from "../src/ecs/world.ts";
import { createTransformStorage } from "../src/ecs/facade.ts";
import { UniformGridSpatialIndex } from "../src/spatial/index.ts";
import { LiminaTracer } from "../src/observability/event.ts";
import { SkillRegistry, type InvokeBase, type WorldContext } from "../src/skills/registry.ts";
import { registerCoreSkills, type CoreSkills } from "../src/skills/index.ts";
import type { AssetRegistry } from "../src/asset-registry.ts";
import { WorldRecorder } from "../src/worldlog/recorder.ts";
import { captureWorldState, compareWorldState, getInstalledSkillRng, syncAllBodies } from "../src/worldlog/log.ts";
import {
  captureWorldSnapshot,
  parseSnapshot,
  recoverWorld,
  serializeSnapshot,
  SnapshotParticipantRegistry,
} from "../src/worldlog/snapshot.ts";

function assert(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new Error("p104_snapshot_participants FAIL: " + msg);
}

const SEED = 0x0104ca7;
const SESSION = "ses_p104";

// A raw .gltf JSON document carrying ONLY what gltfLocalAabb needs (accessor
// min/max): asset.place derives a real standalone box collider from it while the
// mesh parse fails tolerated (meshless entity) — identical in live, restore, and
// every headless context (the p103 fixture).
const FIXTURE_GLTF = new TextEncoder().encode(JSON.stringify({
  asset: { version: "2.0" },
  scene: 0,
  scenes: [{ nodes: [0] }],
  nodes: [{ mesh: 0 }],
  meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
  accessors: [{ min: [-0.5, 0, -0.5], max: [0.5, 1, 0.5] }],
}));
const stubAssets = {
  resolve: (id: string) => {
    if (id !== "p104-box.gltf") throw new Error(`p104 stub assets: unknown id '${id}'`);
    return { assetId: id, bytes: FIXTURE_GLTF, hash: "sha256:p104-box" };
  },
} as unknown as AssetRegistry;

function makeWorld(worldOps: EngineOps): WorldContext {
  const ecs = createEcsWorld();
  const scene = { add() {}, remove() {}, position: { set() {}, x: 0, y: 0, z: 0 }, background: null as unknown };
  const camera = { position: { set() {} }, aspect: 1, lookAt() {}, updateProjectionMatrix() {} };
  return {
    ecs, transforms: createTransformStorage(ecs), spatial: new UniformGridSpatialIndex(),
    entities: new EntityTable(), tags: new Map(), scene: scene as WorldContext["scene"],
    camera: camera as WorldContext["camera"], ops: worldOps, mode: "headless",
    rng: getInstalledSkillRng(),
  };
}

function makeCore(tracer: LiminaTracer): { registry: SkillRegistry; core: CoreSkills } {
  const registry = new SkillRegistry(tracer);
  const core = registerCoreSkills(registry, { assets: stubAssets });
  return { registry, core };
}

/** Union of the exact permissions the invoked skills declare (least surprise:
 *  no profile guessing — the registry's own definitions are the source). */
function permsFor(registry: SkillRegistry, names: readonly string[]): ReadonlySet<string> {
  const perms = new Set<string>();
  for (const n of names) {
    const def = registry.describe(n);
    assert(def !== undefined, `skill '${n}' must be registered`);
    for (const p of def.permissions) perms.add(p);
  }
  return perms;
}

const SKILLS_USED = [
  "asset.place", "scene.destroyEntity",
  "item.define", "inventory.create", "inventory.add", "item.equip",
  "interaction.register", "interaction.open",
  "game.state", "game.flag", "game.counter", "game.timer", "game.condition",
  "trigger.create", "trigger.onEnter", "event.listen", "event.define",
  "quest.define", "quest.offer", "quest.accept", "quest.update",
  "stats.create", "status.apply", "combat.defend",
  "ability.define", "ability.cast",
  "progression.xp", "progression.onLevelUp",
  "world.setTime", "world.setWeather",
  "cutscene.define", "cutscene.play",
  "director.configure", "director.start",
  "behavior.define", "behavior.assign", "behavior.setGoal", "behavior.onEvent",
  "npc.setRoutine", "npc.memorize", "npc.setAttitude",
  "dialogue.define", "dialogue.start", "dialogue.choose",
] as const;

/** Bodies intersecting a small box floated above ground at (x,z) — counts exactly
 *  the placed asset's standalone collider. Broad phase refreshes on a step; callers
 *  step + sync first. */
function bodiesAt(world: WorldContext, x: number, z: number): number {
  const out = new Uint32Array(64);
  return world.ops.op_physics_overlap_box(x, 0.6, z, 0.4, 0.25, 0.4, 0, 0, 0, 1, -1, out);
}

/** JSON of every participant's capture(), keyed by participant key. */
function captureAll(participants: SnapshotParticipantRegistry): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of participants.keys()) out[key] = JSON.stringify(participants.get(key)!.capture());
  return out;
}

// ═════════ Part 1 — author manager state through skills, then snapshot ═════════

const tracer = new LiminaTracer(SESSION);
const { registry, core } = makeCore(tracer);
const recorder = new WorldRecorder(SESSION);
recorder.attach(registry);
recorder.seed(SEED, { forceInstall: true });
const recOps = recorder.wrapOps(ops);
const world = makeWorld(recOps);
recOps.op_physics_create_world(-9.81);

const PERMS = permsFor(registry, SKILLS_USED);
let tick = 0;
const base = (w: WorldContext): InvokeBase =>
  ({ agentId: "agt_p104", sessionId: SESSION, permissions: PERMS, tick: ++tick, world: w });

async function invokeOk(reg: SkillRegistry, w: WorldContext, name: string, input: unknown): Promise<Record<string, unknown>> {
  const res = await reg.invoke(name, input, base(w));
  assert(res.success === true, `${name} failed: ${JSON.stringify(res.error)}`);
  return res.result as Record<string, unknown>;
}

// The placed asset: a meshless entity owning a STANDALONE collider (B4's subject)
// that doubles as the door interactable (opened via interaction — H2's subject).
const placed = await invokeOk(registry, world, "asset.place", { assetId: "p104-box.gltf", position: [10, 0, 10] });
const doorEntity = placed.entity as string;

await invokeOk(registry, world, "item.define", { id: "apple", name: "Apple", stackable: true, maxStack: 5, weight: 0.2, category: "food" });
await invokeOk(registry, world, "item.define", { id: "sword", name: "Sword", stackable: false, maxStack: 1, weight: 3, category: "weapon" });
await invokeOk(registry, world, "inventory.create", { entity: "hero", capacity: 8 });
await invokeOk(registry, world, "inventory.add", { entity: "hero", itemId: "apple", quantity: 3 });
await invokeOk(registry, world, "inventory.add", { entity: "hero", itemId: "sword", quantity: 1 });
const equipped = await invokeOk(registry, world, "item.equip", { entity: "hero", itemId: "sword", equipmentSlot: "mainhand" });
assert(equipped.ok === true, "item.equip must succeed");

await invokeOk(registry, world, "interaction.register", { entity: doorEntity, prompt: "Open the crate", maxRange: 3, type: "open" });
const opened = await invokeOk(registry, world, "interaction.open", { entity: doorEntity });
assert(opened.ok === true, "interaction.open must succeed");
assert(core.interaction.interactionManager.get(doorEntity)?.state.open === true, "door state.open must be set pre-snapshot");

await invokeOk(registry, world, "game.state", { action: "set", name: "chapter", value: "two" });
await invokeOk(registry, world, "game.flag", { name: "met_elder", value: true });
await invokeOk(registry, world, "game.counter", { name: "coins", action: "set", value: 12 });
await invokeOk(registry, world, "game.timer", { name: "round", action: "start", duration: 30 });
await invokeOk(registry, world, "game.condition", { name: "rich", action: "define", expression: "counter('coins') >= 10", onTrue: "gotRich" });

const trig = await invokeOk(registry, world, "trigger.create", { shape: "box", center: [0, 0, 0], size: [2, 2, 2] });
await invokeOk(registry, world, "trigger.onEnter", { triggerId: trig.triggerId, action: { type: "emit", data: { event: "entered" } } });
await invokeOk(registry, world, "event.listen", { eventName: "door.opened", action: { type: "audio", data: { sfx: "creak" } } });
await invokeOk(registry, world, "event.define", { event: { version: 1, trigger: { type: "onTick", every: 5 }, action: { type: "emit", event: "pulse", payload: {} } } });

await invokeOk(registry, world, "quest.define", {
  id: "q_apples", name: "Apple Run", description: "Fetch apples.",
  objectives: [{ id: "collect", type: "collect", description: "Collect 5 apples", required: 5 }],
});
await invokeOk(registry, world, "quest.offer", { entity: "hero", questId: "q_apples" });
await invokeOk(registry, world, "quest.accept", { entity: "hero", questId: "q_apples" });
await invokeOk(registry, world, "quest.update", { entity: "hero", questId: "q_apples", objectiveId: "collect", progress: 3 });

await invokeOk(registry, world, "stats.create", { entity: "hero", stats: [{ name: "hp", value: 20 }, { name: "mana", value: 10 }] });
await invokeOk(registry, world, "status.apply", { targetEntity: "hero", type: "poison", duration: 8, magnitude: 2 });
await invokeOk(registry, world, "combat.defend", { entity: "hero", duration: 5, damageReduction: 0.4 });
await invokeOk(registry, world, "ability.define", { id: "fireball", cooldownTicks: 100, resourceStat: "mana", cost: 5 });
const castRes = await invokeOk(registry, world, "ability.cast", { entity: "hero", id: "fireball" });
assert(castRes.ok === true, "ability.cast must succeed (stamps cooldown, spends mana)");

await invokeOk(registry, world, "progression.onLevelUp", { entity: "hero", action: { type: "emit", data: { event: "levelup" } } });
await invokeOk(registry, world, "progression.xp", { entity: "hero", amount: 150 });
await invokeOk(registry, world, "world.setTime", { time: 18.5 });
await invokeOk(registry, world, "world.setWeather", { weather: "rain", intensity: 0.7 });
await invokeOk(registry, world, "cutscene.define", { id: "intro", keyframes: [{ atTick: 0, action: { type: "camera.cut" } }, { atTick: 600, action: { type: "vfx.play" } }] });
await invokeOk(registry, world, "cutscene.play", { id: "intro" });
assert(core.cutscene.cutsceneManager.isPlaying(), "cutscene must be MID-PLAYBACK at capture");
await invokeOk(registry, world, "director.configure", { buildRate: 0.05 });
await invokeOk(registry, world, "director.start", {});

// Behavior manager (the enrolled F row): a MID-TREE configuration — profile defined
// AND assigned, an active goal (stamps the manager's goal-id seq), an attached
// reaction, a routine, memories with tick-stamped facts, and a non-default attitude.
await invokeOk(registry, world, "behavior.define", {
  id: "prof_guard", name: "Guard",
  routines: [{ id: "rt_day", name: "Day watch", schedule: [{ hour: 8, action: "patrol", position: [1, 0, 2] }, { hour: 20, action: "sleep", target: "barracks" }] }],
  reactions: [{ trigger: "alarm", action: { type: "emit", data: { event: "toArms" } }, priority: 2 }],
  goals: [{ id: "g_hold", type: "guard", target: "gate", priority: 1 }],
});
await invokeOk(registry, world, "behavior.assign", { entity: "npc_guard", profileId: "prof_guard" });
const liveGoal = await invokeOk(registry, world, "behavior.setGoal", { entity: "npc_guard", type: "patrol", position: [3, 0, 4], priority: 2 });
assert(typeof liveGoal.goalId === "string" && (liveGoal.goalId as string).length > 0, "behavior.setGoal must mint a goal id");
await invokeOk(registry, world, "behavior.onEvent", { entity: "npc_guard", trigger: "playerNearby", action: { type: "custom", data: { move: "approach" } }, priority: 1, cooldown: 30 });
await invokeOk(registry, world, "npc.setRoutine", { entity: "npc_guard", routineId: "rt_day" });
await invokeOk(registry, world, "npc.memorize", { entity: "npc_guard", key: "sawPlayer", value: { at: [10, 0, 10] }, source: "hero" });
await invokeOk(registry, world, "npc.setAttitude", { entity: "npc_guard", towardEntity: "hero", attitude: "hostile" });

// Dialogue manager (the enrolled F row): a tree AND an IN-PROGRESS session — started,
// then advanced one choice, so the capture must carry a mid-tree cursor + history.
await invokeOk(registry, world, "dialogue.define", {
  id: "dlg_gate", name: "At the gate", startNode: "n0",
  nodes: [
    { id: "n0", text: "Halt! Who goes there?", speaker: "npc_guard", choices: [{ text: "A friend.", nextNodeId: "n1" }, { text: "None of your business.", nextNodeId: "n2" }] },
    { id: "n1", text: "Pass, friend.", speaker: "npc_guard", choices: [] },
    { id: "n2", text: "Then you shall not pass.", speaker: "npc_guard", choices: [] },
  ],
});
await invokeOk(registry, world, "dialogue.start", { treeId: "dlg_gate", speaker: "npc_guard", listener: "hero" });
const chose = await invokeOk(registry, world, "dialogue.choose", { speaker: "npc_guard", listener: "hero", choiceIndex: 1 });
assert(chose.ok === true, "dialogue.choose must advance the session");
assert(core.behavior.dialogueManager.getCurrentSession("npc_guard", "hero")?.currentNodeId === "n2", "dialogue session must be MID-TREE at capture");

// Navmesh portal state: registered the way functional doors do (directly on the
// manager) — precisely the state that only the snapshot, never the log, carries.
core.nav.navmeshManager.registerPortal("p104_door", { minX: 9, minZ: 9, maxX: 11, maxZ: 11 }, false);

// One recorded step so the broad phase sees the standalone collider.
recOps.op_physics_step();
syncAllBodies(world);
assert(bodiesAt(world, 10, 10) === 1, "the placed asset's standalone collider must be present pre-snapshot");

// ═════════ Part 2 — capture (+ double-capture determinism + hot-path exemption) ═════════

const preCaptures = captureAll(core.snapshotParticipants);
assert(Object.keys(preCaptures).length >= 18, `expected >= 18 registered participants (16 + behavior + dialogue), got ${Object.keys(preCaptures).length}`);
const liveState = captureWorldState(world);
const snapshotSeq = recorder.flushableCount();
const snap = captureWorldSnapshot(world, { sessionId: SESSION, tick, snapshotSeq, participants: core.snapshotParticipants });
const snapAgain = captureWorldSnapshot(world, { sessionId: SESSION, tick, snapshotSeq, participants: core.snapshotParticipants });
assert(JSON.stringify(snap.managers) === JSON.stringify(snapAgain.managers), "double-capture: participant captures must be byte-identical (sorted/canonical)");
assert(JSON.stringify(snap.events) === JSON.stringify(snapAgain.events), "double-capture: events capture must be byte-identical");
assert(snap.events.length === 1, "the defined EventSpec must ride the snapshot's top-level events field via the reserved participant");
const doorSnapEntity = snap.entities.find((e) => e.id === doorEntity);
assert(doorSnapEntity !== undefined && (doorSnapEntity.runtimeBodyIds?.length ?? 0) === 1, "the placed asset must carry its standalone collider id (runtimeBodyIds)");
const hotPath = captureWorldSnapshot(world, { sessionId: SESSION, tick, snapshotSeq, participants: core.snapshotParticipants, includeManagers: false });
assert(Object.keys(hotPath.managers).length === 0, "includeManagers:false (per-join hot path) must skip every manager capture");
assert(Object.keys(snap.managers).length >= 17, "the durable capture must carry every non-reserved participant (incl. behavior + dialogue)");

const json = serializeSnapshot(snap);

// ═════════ Part 3 — recoverWorld (empty delta): bit-exact participant state + B4 destroy ═════════

let freshCore: CoreSkills | undefined;
let freshRegistry: SkillRegistry | undefined;
const makeRecoveryRegistry = (tr: unknown): SkillRegistry => {
  const r = new SkillRegistry(tr as LiminaTracer);
  freshCore = registerCoreSkills(r, { assets: stubAssets });
  freshRegistry = r;
  return r;
};

const recovery = await recoverWorld(parseSnapshot(json), [], {
  makeWorld: () => makeWorld(ops),
  makeRegistry: makeRecoveryRegistry,
  tracer: new LiminaTracer(SESSION + "_recover"),
}, undefined, undefined, () => freshCore?.snapshotParticipants);

assert(freshCore !== undefined && freshRegistry !== undefined, "recovery must have built a fresh core");
const postCaptures = captureAll(freshCore.snapshotParticipants);
for (const key of Object.keys(preCaptures)) {
  assert(postCaptures[key] !== undefined, `participant '${key}' missing after recovery`);
  assert(postCaptures[key] === preCaptures[key], `participant '${key}' state diverged after snapshot -> recoverWorld:\n  pre:  ${preCaptures[key]}\n  post: ${postCaptures[key]}`);
}
const cmpEntities = compareWorldState(liveState, recovery.state);
assert(cmpEntities.identical, `recovered entity state diverged: ${cmpEntities.detail}`);
// Spot checks (belt to the JSON braces): the exact authored facts survive.
assert(freshCore.interaction.interactionManager.get(doorEntity)?.state.open === true, "restored door must still be OPEN");
assert(freshCore.inventory.inventoryManager.countItem("hero", "apple") === 3, "restored inventory must hold 3 apples");
assert(freshCore.quest.questManager.getInstance("hero", "q_apples")?.objectives[0].progress === 3, "restored quest progress must be 3");
assert(freshCore.gamestate.gameStateManager.getFlag("met_elder") === true, "restored game flag must be set");
assert(freshCore.nav.navmeshManager.isPortalOpen("p104_door") === false, "restored portal must still be CLOSED");
assert(freshCore.cutscene.cutsceneManager.isPlaying(), "restored cutscene must still be mid-playback");
assert(freshCore.director.directorManager.isRunning(), "restored director must still be running");
assert(freshCore.behavior.behaviorManager.getAssignedProfile("npc_guard")?.id === "prof_guard", "restored NPC must keep its assigned behavior profile");
assert(freshCore.behavior.behaviorManager.getGoal("npc_guard")?.id === liveGoal.goalId, "restored active goal must keep the live-minted goal id");
assert(freshCore.behavior.behaviorManager.recall("npc_guard", "sawPlayer").length === 1, "restored NPC must keep its memory facts");
assert(freshCore.behavior.behaviorManager.getAttitude("npc_guard", "hero") === "hostile", "restored NPC must keep its attitude");
assert(freshCore.behavior.behaviorManager.getRoutine("npc_guard") === "rt_day", "restored NPC must keep its routine");
assert(freshCore.behavior.behaviorManager.getReactions("npc_guard", "playerNearby").length === 1, "restored NPC must keep its attached reactions");
{
  const restoredSession = freshCore.behavior.dialogueManager.getCurrentSession("npc_guard", "hero");
  assert(restoredSession?.currentNodeId === "n2", "restored dialogue session must still sit MID-TREE on n2");
  assert(restoredSession?.history.length === 1 && restoredSession.history[0].nodeId === "n0" && restoredSession.history[0].choiceIndex === 1,
    "restored dialogue session must keep its choice history");
}
// Goal-id sequence RESUME: an identical post-restore behavior.setGoal (same tick) must
// mint the SAME id in the restored world as in the continuing live world — the seq
// rides the participant; without it the two worlds fork on the very next goal.
{
  const gTick = ++tick;
  const sameBase = (w: WorldContext): InvokeBase =>
    ({ agentId: "agt_p104", sessionId: SESSION, permissions: PERMS, tick: gTick, world: w });
  const liveNext = await registry.invoke("behavior.setGoal", { entity: "npc_guard", type: "follow", target: "hero", priority: 3 }, sameBase(world));
  const restoredNext = await freshRegistry.invoke("behavior.setGoal", { entity: "npc_guard", type: "follow", target: "hero", priority: 3 }, sameBase(recovery.world));
  assert(liveNext.success === true && restoredNext.success === true, "post-restore setGoal pair must succeed");
  const liveId = (liveNext.result as { goalId: string }).goalId;
  const restoredId = (restoredNext.result as { goalId: string }).goalId;
  assert(liveId === restoredId, `goal-id seq must RESUME after restore: live '${liveId}' vs restored '${restoredId}'`);
}

// B4: destroying the RESTORED placed asset must remove its standalone collider.
ops.op_physics_step();
syncAllBodies(recovery.world);
assert(bodiesAt(recovery.world, 10, 10) === 1, "restored world must contain the standalone collider (rode the physics blob)");
{
  const res = await freshRegistry.invoke("scene.destroyEntity", { entity: doorEntity }, base(recovery.world));
  assert(res.success === true, "scene.destroyEntity on the restored asset failed: " + JSON.stringify(res.error));
}
ops.op_physics_step();
syncAllBodies(recovery.world);
assert(bodiesAt(recovery.world, 10, 10) === 0, "destroying the RESTORED placed asset must remove its collider — invisible wall leaked (M18)");

// ═════════ Part 4 — FALSIFIABILITY (a): one participant unregistered ⇒ loud failure ═════════

{
  let core4: CoreSkills | undefined;
  const partial = new SnapshotParticipantRegistry();
  let threw: Error | undefined;
  try {
    await recoverWorld(parseSnapshot(json), [], {
      makeWorld: () => makeWorld(ops),
      makeRegistry: (tr) => {
        const r = new SkillRegistry(tr as LiminaTracer);
        core4 = registerCoreSkills(r, { assets: stubAssets });
        // Re-register every participant EXCEPT inventory — the "next manager
        // forgot to enroll / key renamed" configuration.
        for (const key of core4.snapshotParticipants.keys()) {
          if (key === "inventory") continue;
          partial.register(core4.snapshotParticipants.get(key)!);
        }
        return r;
      },
      tracer: new LiminaTracer(SESSION + "_missing"),
    }, undefined, undefined, () => partial);
  } catch (err) {
    threw = err as Error;
  }
  assert(threw !== undefined, "FALSIFIABILITY DEAD: restoring with the inventory participant unregistered did not throw");
  assert(threw.message.includes("inventory"), `the loud failure must name the orphaned key, got: ${threw.message}`);
}

// And the bit-exact comparison itself detects silent loss: a snapshot whose
// inventory entry was stripped restores an EMPTY manager whose capture diverges.
{
  const strippedRaw = JSON.parse(json) as { managers: Record<string, unknown> };
  delete strippedRaw.managers.inventory;
  let core5: CoreSkills | undefined;
  await recoverWorld(parseSnapshot(JSON.stringify(strippedRaw)), [], {
    makeWorld: () => makeWorld(ops),
    makeRegistry: (tr) => {
      const r = new SkillRegistry(tr as LiminaTracer);
      core5 = registerCoreSkills(r, { assets: stubAssets });
      return r;
    },
    tracer: new LiminaTracer(SESSION + "_stripped"),
  }, undefined, undefined, () => core5?.snapshotParticipants);
  const post = JSON.stringify(core5!.snapshotParticipants.get("inventory")!.capture());
  assert(post !== preCaptures.inventory, "FALSIFIABILITY DEAD: the bit-exact check cannot see a dropped inventory entry");
}

// Same for the NEWLY ENROLLED participants: a snapshot missing the behavior (or
// dialogue) entry restores an EMPTY manager whose capture diverges from
// pre-snapshot — the exact silent-loss failure their F rows used to be.
for (const newKey of ["behavior", "dialogue"] as const) {
  const strippedRaw = JSON.parse(json) as { managers: Record<string, unknown> };
  assert(Object.hasOwn(strippedRaw.managers, newKey), `the snapshot must carry a '${newKey}' managers entry`);
  delete strippedRaw.managers[newKey];
  let coreN: CoreSkills | undefined;
  await recoverWorld(parseSnapshot(JSON.stringify(strippedRaw)), [], {
    makeWorld: () => makeWorld(ops),
    makeRegistry: (tr) => {
      const r = new SkillRegistry(tr as LiminaTracer);
      coreN = registerCoreSkills(r, { assets: stubAssets });
      return r;
    },
    tracer: new LiminaTracer(SESSION + "_stripped_" + newKey),
  }, undefined, undefined, () => coreN?.snapshotParticipants);
  const post = JSON.stringify(coreN!.snapshotParticipants.get(newKey)!.capture());
  assert(post !== preCaptures[newKey], `FALSIFIABILITY DEAD: the bit-exact check cannot see a dropped ${newKey} entry`);
}

// ═════════ Part 5 — FALSIFIABILITY (b): runtimeBodyIds restore skipped ⇒ the leak ═════════

{
  const raw = JSON.parse(json) as { entities: Array<{ runtimeBodyIds?: number[] }> };
  for (const e of raw.entities) delete e.runtimeBodyIds;
  let core6: CoreSkills | undefined;
  let reg6: SkillRegistry | undefined;
  const rec6 = await recoverWorld(parseSnapshot(JSON.stringify(raw)), [], {
    makeWorld: () => makeWorld(ops),
    makeRegistry: (tr) => {
      const r = new SkillRegistry(tr as LiminaTracer);
      core6 = registerCoreSkills(r, { assets: stubAssets });
      reg6 = r;
      return r;
    },
    tracer: new LiminaTracer(SESSION + "_leak"),
  }, undefined, undefined, () => core6?.snapshotParticipants);
  const res = await reg6!.invoke("scene.destroyEntity", { entity: doorEntity }, base(rec6.world));
  assert(res.success === true, "leak-case scene.destroyEntity failed: " + JSON.stringify(res.error));
  ops.op_physics_step();
  syncAllBodies(rec6.world);
  assert(bodiesAt(rec6.world, 10, 10) === 1,
    "FALSIFIABILITY DEAD: without runtimeBodyIds the destroy should LEAK the collider (the part-3 assert would not fail)");
}

// ═════════ Part 6 — compat: old-format snapshot; unknown key fails loudly ═════════

{
  // Old format: managers field absent entirely (pre-B3 writer).
  const legacyRaw = JSON.parse(json) as Record<string, unknown>;
  delete legacyRaw.managers;
  let core7: CoreSkills | undefined;
  const rec7 = await recoverWorld(parseSnapshot(JSON.stringify(legacyRaw)), [], {
    makeWorld: () => makeWorld(ops),
    makeRegistry: (tr) => {
      const r = new SkillRegistry(tr as LiminaTracer);
      core7 = registerCoreSkills(r, { assets: stubAssets });
      return r;
    },
    tracer: new LiminaTracer(SESSION + "_legacy"),
  }, undefined, undefined, () => core7?.snapshotParticipants);
  const cmp = compareWorldState(liveState, rec7.state);
  assert(cmp.identical, `old-format snapshot must still restore a valid world: ${cmp.detail}`);
  const emptyInventory = JSON.stringify(makeCore(new LiminaTracer("ses_p104_blank")).core.snapshotParticipants.get("inventory")!.capture());
  assert(JSON.stringify(core7!.snapshotParticipants.get("inventory")!.capture()) === emptyInventory,
    "old-format snapshot must restore EMPTY participants (exactly the pre-H2 behavior)");
  // Events still restore on the legacy path: they ride the top-level field, not managers.
  assert(core7!.behaviorSpec.events.size() === 1, "legacy-format restore must still reload top-level events");
}
{
  // Unknown managers key: fails loudly, names the key.
  const bogusRaw = JSON.parse(json) as { managers: Record<string, unknown> };
  bogusRaw.managers.bogusManager = { anything: 1 };
  let core8: CoreSkills | undefined;
  let threw: Error | undefined;
  try {
    await recoverWorld(parseSnapshot(JSON.stringify(bogusRaw)), [], {
      makeWorld: () => makeWorld(ops),
      makeRegistry: (tr) => {
        const r = new SkillRegistry(tr as LiminaTracer);
        core8 = registerCoreSkills(r, { assets: stubAssets });
        return r;
      },
      tracer: new LiminaTracer(SESSION + "_bogus"),
    }, undefined, undefined, () => core8?.snapshotParticipants);
  } catch (err) {
    threw = err as Error;
  }
  assert(threw !== undefined && threw.message.includes("bogusManager"), `unknown managers key must fail loudly naming the key, got: ${threw?.message}`);
}

ops.op_log(
  "p104_snapshot_participants OK: " +
    `${Object.keys(preCaptures).length} participants captured deterministically, recovered bit-exact (empty delta), ` +
    "restored placed-asset collider removed on destroy (M18); unregistered participant + unknown key fail loudly; " +
    "runtimeBodyIds-stripped snapshot demonstrably leaks; old-format snapshots restore empty-but-valid.",
);
