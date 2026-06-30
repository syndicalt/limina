// Phase 14 — THE PLAYABILITY GATE. The complement to p14_capstone.ts.
//
// p14_capstone proves the sim is DETERMINISTIC and REPLAYS byte-identically. It cannot
// prove the game is PLAYABLE: it scripts the typed CapstoneInput directly, so it bypasses
// the real keyboard→heading mapping (never exercises the A/D sign), it only ever drives
// ACCEPT (never decline), and it asserts inventory/counter state but never that a picked-up
// item's MESH actually leaves the scene. Every one of those blind spots was a real shipped
// bug. This gate closes them: it asserts the things a determinism gate structurally can't.
//
//   1. INPUT SIGN  — applyTurn(): pressing D (+axis) turns RIGHT (+heading); A turns left.
//   2. PICKUP DESPAWN — interaction.pickup AND scene.destroyEntity remove the item's mesh
//      from the scene graph (not just its ECS slot) — the "ghost item" bug.
//   3. DECLINE — declining the quest sticks (the greeting does NOT auto-reopen every tick),
//      and re-approaching after a decline can still accept.
//   4. MOUSE-STEER — the movement yaw reaches the sim (steers the player) and is
//      deterministic for a given value (so folding mouse look-yaw in is replay-safe).
//   5. NPC DISTINCTNESS — tintModel recolors a loaded model's materials.
//   6. TURN-IN LEGIBILITY — the HUD surfaces a turn-in hint once every objective is done
//      but the quest is still active.
//
// Run: ./target/release/limina js/test/p14_playability.ts   (exit 0 = pass)

import { ops, type SceneObject } from "../src/engine.ts";
import { createHeadlessContext } from "../src/game/index.ts";
import { SkillRegistry, type WorldContext } from "../src/skills/registry.ts";
import { type CoreSkills } from "../src/skills/index.ts";
import type { MCPResponse } from "../src/mcp/protocol.ts";
import { applyTurn } from "../src/world/heading.ts";
import { tintModel } from "../src/world/character_model.ts";
import { GameHud } from "../src/world/game_hud.ts";
import type { UiManager } from "../src/ui/manager.ts";
import type { QuestManager, QuestInstance, QuestDef } from "../src/skills/quest.ts";
import {
  buildCapstone, CAPSTONE_LAYOUT, headingToward, type Capstone,
} from "../src/demos/capstone_game.ts";

function assert(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new Error("p14_playability FAIL: " + msg);
}

const DT = 1 / 60;
const distXZ = (p: readonly number[], xz: readonly [number, number]): number =>
  Math.hypot(p[0] - xz[0], p[2] - xz[1]);

/** A headless WorldContext whose scene RECORDS the objects added/removed, so a test can
 *  assert a mesh actually left the scene graph (the real scene's add/remove are otherwise
 *  invisible to an assertion). */
function makeRecordingScene(): { scene: WorldContext["scene"]; added: Set<unknown>; removed: Set<unknown> } {
  const added = new Set<unknown>();
  const removed = new Set<unknown>();
  const scene = {
    add(o: unknown) { added.add(o); },
    remove(o: unknown) { removed.add(o); },
    position: { set() {}, x: 0, y: 0, z: 0 }, background: null as unknown,
  };
  return { scene: scene as WorldContext["scene"], added, removed };
}

function unwrap(label: string, res: MCPResponse | undefined): Record<string, unknown> {
  if (res === undefined || !res.success) {
    throw new Error(`p14_playability: ${label} failed: ${JSON.stringify(res?.error ?? "no response")}`);
  }
  return (res.result ?? {}) as Record<string, unknown>;
}

async function freshCapstone(session: string): Promise<{ cap: Capstone; core: CoreSkills; registry: SkillRegistry }> {
  ops.op_physics_create_world(-9.81);
  const ctx = createHeadlessContext({ session, agentId: "agt_play" });
  const cap = await buildCapstone({ world: ctx.world, registry: ctx.registry, core: ctx.core, base: ctx.base });
  return { cap, core: ctx.core, registry: ctx.registry };
}

// ════════════════════════ 1. INPUT SIGN (A/D) ════════════════════════════════════════════════
// Controller basis: yaw 0 ⇒ -Z, +yaw turns RIGHT. op_input_axes[0] = +1 for D. So D must
// INCREASE heading. A hand-rolled `heading -= axes[0]` inverts it — applyTurn is the one sign.
{
  const right = applyTurn(0, +1, 2.6, DT); // pressing D
  const left = applyTurn(0, -1, 2.6, DT);  // pressing A
  assert(right > 0, `D (+axis) must turn right / +heading, got ${right}`);
  assert(left < 0, `A (-axis) must turn left / -heading, got ${left}`);
  assert(Object.is(applyTurn(1.0, 0, 2.6, DT), 1.0), "no turn axis ⇒ heading unchanged");
  // Symmetric magnitude, exact integration.
  assert(Math.abs(right) === Math.abs(left), "A and D turn by equal magnitude");
}

// ════════════════════════ 2. PICKUP DESPAWN (ghost-mesh) ══════════════════════════════════════
// interaction.pickup AND scene.destroyEntity must remove the item's three.js mesh from the
// scene — not only free its ECS slot. We assert against a recording scene.
{
  ops.op_physics_create_world(-9.81);
  const { scene, removed } = makeRecordingScene();
  const ctx = createHeadlessContext({ scene, session: "ses_play_pickup", agentId: "agt_play" });
  const reg = ctx.registry;
  const world = ctx.world;
  const base = ctx.base;

  unwrap("inventory.create", await reg.invoke("inventory.create", { entity: "actor1", capacity: 8 }, base));

  // pickup path
  const item = unwrap("scene.createEntity(item)", await reg.invoke("scene.createEntity", { shape: "sphere", size: 0.6, position: [1, 0, 1] }, base)).entity as string;
  const itemMesh = world.entities.resolve(item)?.mesh;
  assert(itemMesh !== undefined, "created item has a scene mesh");
  const pk = await reg.invoke("interaction.pickup", { itemEntity: item, actorEntity: "actor1" }, base);
  assert((unwrap("interaction.pickup", pk).ok) === true, "pickup succeeded");
  assert(world.entities.resolve(item) === undefined, "pickup destroyed the item entity");
  assert(removed.has(itemMesh), "PICKUP must remove the item MESH from the scene (the ghost-item bug)");

  // scene.destroyEntity path (the canonical teardown both share)
  const box = unwrap("scene.createEntity(box)", await reg.invoke("scene.createEntity", { shape: "box", size: 1, position: [2, 0, 2] }, base)).entity as string;
  const boxMesh = world.entities.resolve(box)?.mesh;
  assert(boxMesh !== undefined, "created box has a scene mesh");
  unwrap("scene.destroyEntity", await reg.invoke("scene.destroyEntity", { entity: box }, base));
  assert(removed.has(boxMesh), "scene.destroyEntity must remove the mesh from the scene");

  // STRUCTURED FEEDBACK (no bare {ok:false}): a handler-level failure carries a reason the
  // agent can act on — the discipline that turns a "silent" failure into an actionable one.
  const dr = await reg.invoke("interaction.drop", { actorEntity: "actor1", itemId: "does-not-exist" }, base);
  assert(dr.success === true, "drop invoke completed at the transport level");
  const drRes = dr.result as { ok: boolean; reason?: string };
  assert(drRes.ok === false, "dropping an item the actor lacks fails");
  assert(typeof drRes.reason === "string" && drRes.reason.length > 0, "a failed call returns a machine-readable reason, never a bare ok:false");
}

// ════════════════════════ 3. DECLINE STICKS + RE-APPROACH ACCEPTS ═════════════════════════════
{
  const { cap } = await freshCapstone("ses_play_decline");
  const NPC = CAPSTONE_LAYOUT.npc;
  const HOLD = CAPSTONE_LAYOUT.talkRadius - 0.8;
  const aim = (): [number, number, number] => cap.playerPos();

  // (a) Approach until the greeting opens.
  for (let s = 0; s < 600 && !cap.dialogue.isActive(); s++) {
    const p = aim();
    const fwd = distXZ(p, NPC) > HOLD ? 1 : 0;
    await cap.step(DT, { forward: fwd, yaw: headingToward(p[0], p[2], NPC[0], NPC[1]) });
  }
  assert(cap.dialogue.isActive(), "the quest-giver greeting opened on approach");
  assert(!cap.accepted(), "quest not accepted before any choice");

  // (b) Decline (choice 1) and let the dialogue close.
  for (let s = 0; s < 30 && cap.dialogue.isActive(); s++) {
    const choose = !cap.dialogue.isTerminal() ? 1 : -1;
    const p = aim();
    await cap.step(DT, { forward: 0, yaw: headingToward(p[0], p[2], NPC[0], NPC[1]), choose });
  }
  assert(!cap.dialogue.isActive(), "dialogue closed after declining");
  assert(!cap.accepted(), "DECLINE must not accept the quest");

  // (c) Hold in range — the greeting must NOT auto-reopen every tick (the infinite-reopen bug).
  let reopened = false;
  for (let s = 0; s < 90; s++) {
    const p = aim();
    await cap.step(DT, { forward: 0, yaw: headingToward(p[0], p[2], NPC[0], NPC[1]) });
    if (cap.dialogue.isActive()) reopened = true;
  }
  assert(!reopened, "after a decline the greeting must NOT auto-reopen while still in range");
  assert(!cap.accepted(), "still not accepted while holding in range after decline");

  // (d) Walk out of talk range so a fresh approach re-arms the greeting.
  const away: [number, number] = [NPC[0], NPC[1] - (CAPSTONE_LAYOUT.talkRadius + 8)];
  for (let s = 0; s < 600 && distXZ(aim(), NPC) <= CAPSTONE_LAYOUT.talkRadius + 1.5; s++) {
    const p = aim();
    await cap.step(DT, { forward: 1, yaw: headingToward(p[0], p[2], away[0], away[1]) });
  }
  assert(distXZ(aim(), NPC) > CAPSTONE_LAYOUT.talkRadius, "walked out of talk range to re-arm the greeting");

  // (e) Re-approach and accept — a declined quest is recoverable.
  for (let s = 0; s < 700 && !cap.accepted(); s++) {
    const p = aim();
    const fwd = distXZ(p, NPC) > HOLD ? 1 : 0;
    const choose = cap.dialogue.isActive() && !cap.dialogue.isTerminal() ? 0 : -1;
    await cap.step(DT, { forward: fwd, yaw: headingToward(p[0], p[2], NPC[0], NPC[1]), choose });
  }
  assert(cap.accepted(), "re-approaching after a decline can accept the quest");
}

// ════════════════════════ 4. MOUSE-STEER REACHES THE SIM, DETERMINISTICALLY ═══════════════════
// The window folds mouse look-yaw into CapstoneInput.yaw. Assert the movement yaw actually
// steers the player (different yaw ⇒ different facing) and is deterministic (same yaw ⇒ same
// facing) so the recorded-input replay stays byte-identical.
{
  const a = await freshCapstone("ses_play_yaw_a"); await a.cap.step(DT, { forward: 1, yaw: 0.0 });
  const b = await freshCapstone("ses_play_yaw_b"); await b.cap.step(DT, { forward: 1, yaw: 1.2 });
  const c = await freshCapstone("ses_play_yaw_c"); await c.cap.step(DT, { forward: 1, yaw: 1.2 });
  const fa = a.cap.playerController.facing;
  const fb = b.cap.playerController.facing;
  const fc = c.cap.playerController.facing;
  assert(fa !== fb, `movement yaw must steer the player (facing ${fa} vs ${fb} for yaw 0.0 vs 1.2)`);
  assert(Object.is(fb, fc), `same yaw must give the same facing (deterministic): ${fb} vs ${fc}`);
}

// ════════════════════════ 5. NPC DISTINCTNESS (tint) ══════════════════════════════════════════
// tintModel copies the tint into every material albedo under a model root (single + array).
{
  const copied: { getHex(): number }[] = [];
  const mkColor = () => ({ copy(col: { getHex(): number }) { copied.push(col); } });
  const single = { material: { color: mkColor() } };
  const multi = { material: [{ color: mkColor() }, { color: mkColor() }] };
  const noColor = { material: {} }; // a material without a .color is skipped, not a crash
  const fakeRoot = {
    traverse(fn: (o: unknown) => void) { fn(single); fn(multi); fn(noColor); },
  } as unknown as SceneObject;
  tintModel(fakeRoot, 0xC8A24B);
  assert(copied.length === 3, `tint applied to every color-bearing material (got ${copied.length}, want 3)`);
  for (const col of copied) assert(col.getHex() === 0xC8A24B, `tint color is 0xC8A24B, got ${col.getHex().toString(16)}`);
}

// ════════════════════════ 6. TURN-IN LEGIBILITY (HUD hint) ════════════════════════════════════
// Once every objective is satisfied but the quest is still active, the HUD must surface the
// turn-in hint so the win is not an invisible proximity event.
{
  const QID = "relic_hunt";
  const def: QuestDef = {
    id: QID, name: "The Relic Hunt", description: "",
    objectives: [{ id: "gather", description: "Collect 3 relics", type: "collect", required: 3 }],
  } as unknown as QuestDef;
  const makeInstance = (progress: number, status: "active" | "completed"): QuestInstance => ({
    questId: QID, status, tracked: true,
    objectives: [{ id: "gather", progress, completed: progress >= 3 }],
  } as unknown as QuestInstance);

  let instance = makeInstance(3, "active");
  const mockQuest = {
    getDefinition: (id: string) => (id === QID ? def : undefined),
    getInstance: (_e: string, id: string) => (id === QID ? instance : undefined),
    list: (_e: string, status?: string) => (status === "active" && instance.status === "active" ? [instance] : []),
  } as unknown as QuestManager;

  const uiCalls: { lines: string[] }[] = [];
  const mockUi = {
    create: () => ({ handle: "h" + uiCalls.length }),
    update: (_h: string, patch: { lines?: string[] }) => { if (patch.lines) uiCalls.push({ lines: patch.lines }); return true; },
    remove: () => true,
  } as unknown as UiManager;
  const stubWorld = { scene: { add() {}, remove() {} } } as unknown as WorldContext;

  const hud = new GameHud({
    uiManager: mockUi, world: stubWorld,
    managers: { quest: mockQuest },
    options: { questTitle: "QUEST", turnInHint: "Return to the keeper" },
  });
  hud.init();
  hud.setQuest(QID);

  // Objectives complete + quest active ⇒ hint present.
  hud.update("player1");
  assert(hud.lines("quest").includes("Return to the keeper"), "turn-in hint shows when objectives complete on an active quest");

  // Objectives incomplete ⇒ no hint.
  instance = makeInstance(1, "active");
  hud.update("player1");
  assert(!hud.lines("quest").includes("Return to the keeper"), "turn-in hint hidden while objectives are incomplete");
}

ops.op_log(
  "p14_playability OK: closed the gate's blind spots — " +
  "INPUT SIGN (D turns right via applyTurn); PICKUP DESPAWN (interaction.pickup + scene.destroyEntity remove the mesh, not just the eid); " +
  "DECLINE sticks + re-approach accepts; MOUSE-STEER reaches the sim and is deterministic; " +
  "NPC tint recolors every material; TURN-IN HINT surfaces on the HUD when objectives complete on an active quest.",
);
