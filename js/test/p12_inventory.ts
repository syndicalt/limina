// Phase 12 — INVENTORY + ITEMS skill seam (closure-bound manager) and its replay parity.
//
// Proves the inventory.* / item.* skills are wired to REAL state (the pre-fix skills read
// a `ctx.world.inventoryManager` field nobody ever set, so every skill was a silent no-op),
// and that the seam's invariants hold:
//
//   • create -> item.define -> add (deterministic lowest-free slot) -> list/count/has
//   • stacking respects maxStack; non-stackable items take separate slots
//   • typeRestrictions ENFORCED on add (and transfer): a disallowed category is rejected
//     with reason 'type-restricted' and nothing mutates
//   • item.equip/unequip REALLY move a unit between the inventory slots and an equipment slot
//   • transfer between two inventories, with rollback when the destination refuses
//   • REPLAY-EQUIVALENCE: record the whole sequence, snapshot the live manager, replay the
//     command stream into a FRESH core, and assert the rebuilt manager is BIT-IDENTICAL.
//
// Run: ./target/release/limina js/test/p12_inventory.ts   (exit 0 = pass)

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
  if (!cond) throw new Error("p12_inventory FAIL: " + msg);
}
function ok(res: MCPResponse): Record<string, unknown> {
  if (!res.success) throw new Error("call failed: " + JSON.stringify(res.error));
  assert(typeof res.result === "object" && res.result !== null, "expected result object");
  return res.result as Record<string, unknown>;
}

ops.op_physics_create_world(0);
const BUILDER = resolveProfile("builder.readWrite");

function makeWorld(worldOps: EngineOps): WorldContext {
  const scene = { add() {}, remove() {}, position: { set() {}, x: 0, y: 0, z: 0 }, background: null as unknown };
  const camera = { position: { set() {} }, aspect: 1, lookAt() {}, updateProjectionMatrix() {} };
  const ecs = createEcsWorld();
  return {
    ecs, transforms: createTransformStorage(ecs), spatial: new UniformGridSpatialIndex(),
    entities: new EntityTable(), tags: new Map(),
    scene: scene as WorldContext["scene"], camera: camera as WorldContext["camera"],
    ops: worldOps, mode: "headless",
  };
}

// ── AUTHORING (recorded) ────────────────────────────────────────────────────
const recorder = new WorldRecorder("ses_p12_inv_author");
const recReg = new SkillRegistry(new LiminaTracer("ses_p12_inv_author"));
const core: CoreSkills = registerCoreSkills(recReg);
recorder.attach(recReg);
const world = makeWorld(ops);
const base = { agentId: "agt_builder", sessionId: "ses_p12_inv_author", permissions: BUILDER, tick: 0, world };

// The manager is reached via the core return shape — NOT via ctx.world (the closure binding).
const mgr = core.inventory.inventoryManager;
assert(mgr !== undefined && typeof mgr.snapshot === "function", "core.inventory.inventoryManager missing or not a real manager");

const PLAYER = "player";
const CHEST = "chest"; // weapons-only chest (typeRestrictions)

// (1) Create inventories — chest is restricted to the 'weapon' category.
ok(await recReg.invoke("inventory.create", { entity: PLAYER, capacity: 10 }, base));
ok(await recReg.invoke("inventory.create", { entity: CHEST, capacity: 10, typeRestrictions: ["weapon"] }, base));

// (2) Define items across categories.
ok(await recReg.invoke("item.define", { id: "sword", name: "Sword", category: "weapon", stackable: false, maxStack: 1 }, base));
ok(await recReg.invoke("item.define", { id: "potion", name: "Potion", category: "consumable", stackable: true, maxStack: 10 }, base));
ok(await recReg.invoke("item.define", { id: "gem", name: "Gem", category: "misc", stackable: true }, base));

// (3) Add items — deterministic lowest-free-slot assignment.
const a0 = ok(await recReg.invoke("inventory.add", { entity: PLAYER, itemId: "sword", quantity: 1 }, base));
assert(a0.ok === true && a0.slot === 0, `first add must take slot 0, got ${JSON.stringify(a0)}`);
const a1 = ok(await recReg.invoke("inventory.add", { entity: PLAYER, itemId: "potion", quantity: 3 }, base));
assert(a1.ok === true && a1.slot === 1, `potion must take slot 1, got ${JSON.stringify(a1)}`);
// Stacking: another +2 potions folds into the SAME slot (qty 5), not a new slot.
const a2 = ok(await recReg.invoke("inventory.add", { entity: PLAYER, itemId: "potion", quantity: 2 }, base));
assert(a2.ok === true && a2.slot === 1, `potion +2 must stack into slot 1, got ${JSON.stringify(a2)}`);
const a3 = ok(await recReg.invoke("inventory.add", { entity: PLAYER, itemId: "gem", quantity: 1 }, base));
assert(a3.ok === true && a3.slot === 2, `gem must take slot 2, got ${JSON.stringify(a3)}`);
// Non-stackable sword #2 takes a NEW slot, never stacks.
const a4 = ok(await recReg.invoke("inventory.add", { entity: PLAYER, itemId: "sword", quantity: 1 }, base));
assert(a4.ok === true && a4.slot === 3, `non-stackable sword must take a fresh slot 3, got ${JSON.stringify(a4)}`);

// (4) list / count / has.
const list1 = ok(await recReg.invoke("inventory.list", { entity: PLAYER }, base));
const items1 = list1.items as { itemId: string; quantity: number; slot: number }[];
assert(items1.length === 4, `expected 4 occupied slots, got ${items1.length}`);
assert(items1[1].itemId === "potion" && items1[1].quantity === 5, `slot 1 must be potion x5, got ${JSON.stringify(items1[1])}`);
const cnt1 = ok(await recReg.invoke("inventory.count", { entity: PLAYER, itemId: "potion" }, base));
assert(cnt1.count === 5, `potion count must be 5, got ${cnt1.count}`);
const has1 = ok(await recReg.invoke("inventory.has", { entity: PLAYER, itemId: "sword" }, base));
assert(has1.has === true, "player must have a sword");

// (5) typeRestriction ENFORCEMENT: a gem (misc) is rejected by the weapons-only chest.
const badAdd = ok(await recReg.invoke("inventory.add", { entity: CHEST, itemId: "gem", quantity: 1 }, base));
assert(badAdd.ok === false && badAdd.reason === "type-restricted", `gem must be rejected by weapons-only chest, got ${JSON.stringify(badAdd)}`);
assert(mgr.countItem(CHEST, "gem") === 0, "rejected gem must NOT be in the chest (no fake success)");
// A weapon IS allowed.
const goodAdd = ok(await recReg.invoke("inventory.add", { entity: CHEST, itemId: "sword", quantity: 1 }, base));
assert(goodAdd.ok === true && goodAdd.slot === 0, `sword must be accepted by the chest into slot 0, got ${JSON.stringify(goodAdd)}`);

// (6) EQUIP: move one sword (lowest inventory slot) into the 'mainhand' equipment slot.
const eq = ok(await recReg.invoke("item.equip", { entity: PLAYER, itemId: "sword", equipmentSlot: "mainhand" }, base));
assert(eq.ok === true, "equip must succeed");
// Slot 0 (the lowest sword) is now vacated; the equipment carries it.
const list2 = ok(await recReg.invoke("inventory.list", { entity: PLAYER }, base));
const eqList = list2.equipment as { equipmentSlot: string; itemId: string; quantity: number }[];
assert(eqList.length === 1 && eqList[0].equipmentSlot === "mainhand" && eqList[0].itemId === "sword", `mainhand must hold the sword, got ${JSON.stringify(eqList)}`);
assert((list2.items as { slot: number }[]).find((s) => s.slot === 0) === undefined, "slot 0 must be free after equipping its sword");
// countItem counts slots only — one sword remains in the inventory (slot 3).
assert(mgr.countItem(PLAYER, "sword") === 1, `one sword must remain in player slots after equip, got ${mgr.countItem(PLAYER, "sword")}`);

// (7) TRANSFER: the remaining inventory sword moves player -> chest (chest allows weapons).
const t1 = ok(await recReg.invoke("inventory.transfer", { fromEntity: PLAYER, toEntity: CHEST, itemId: "sword", quantity: 1 }, base));
assert(t1.ok === true, "weapon transfer to the chest must succeed");
assert(mgr.countItem(PLAYER, "sword") === 0 && mgr.countItem(CHEST, "sword") === 2, `after transfer player=0 chest=2 swords, got player=${mgr.countItem(PLAYER, "sword")} chest=${mgr.countItem(CHEST, "sword")}`);
// Transfer that VIOLATES the destination restriction must be a true no-op (rollback).
const t2 = ok(await recReg.invoke("inventory.transfer", { fromEntity: PLAYER, toEntity: CHEST, itemId: "potion", quantity: 2 }, base));
assert(t2.ok === false, "potion transfer to weapons-only chest must be rejected");
assert(mgr.countItem(PLAYER, "potion") === 5, `rejected transfer must leave player potions untouched (rollback), got ${mgr.countItem(PLAYER, "potion")}`);

// (8) REMOVE: drop 2 potions from the stack (5 -> 3).
const r1 = ok(await recReg.invoke("inventory.remove", { entity: PLAYER, itemId: "potion", slot: 1, quantity: 2 }, base));
assert(r1.ok === true, "remove must succeed");
assert(mgr.countItem(PLAYER, "potion") === 3, `potions must be 3 after removing 2, got ${mgr.countItem(PLAYER, "potion")}`);

// (9) UNEQUIP: the mainhand sword returns to the inventory (lowest free slot = 0).
const uq = ok(await recReg.invoke("item.unequip", { entity: PLAYER, equipmentSlot: "mainhand" }, base));
assert(uq.ok === true, "unequip must succeed");
assert(mgr.listEquipment(PLAYER).length === 0, "mainhand must be empty after unequip");
assert(mgr.countItem(PLAYER, "sword") === 1, `the unequipped sword must be back in the player slots, got ${mgr.countItem(PLAYER, "sword")}`);
const list3 = ok(await recReg.invoke("inventory.list", { entity: PLAYER }, base));
assert((list3.items as { slot: number; itemId: string }[]).some((s) => s.slot === 0 && s.itemId === "sword"), "unequipped sword must land in the lowest free slot (0)");

// The closure binding actually fired: skills mutated REAL state (a no-op build would
// have left every inventory empty).
const liveSnapshot = mgr.snapshot();
assert(liveSnapshot.length === 2, `expected 2 inventories in the snapshot, got ${liveSnapshot.length}`);

// ── REPLAY-EQUIVALENCE: rebuild from the command stream into a FRESH core ─────
const tools = recorder.commands.filter((c): c is { kind: "skill"; tool: string } => c.kind === "skill").map((c) => c.tool);
assert(tools.includes("inventory.create") && tools.includes("item.define") && tools.includes("inventory.add"), "inventory skills were not recorded");

let replayCore: CoreSkills | undefined;
await replayCommands(recorder.commands, {
  makeWorld: () => makeWorld(ops),
  makeRegistry: (tr) => {
    const r = new SkillRegistry(tr as LiminaTracer);
    replayCore = registerCoreSkills(r);
    return r;
  },
  tracer: new LiminaTracer("ses_p12_inv_replay"),
});
assert(replayCore !== undefined, "replay did not construct a core");
const replaySnapshot = replayCore.inventory.inventoryManager.snapshot();

const liveJson = JSON.stringify(liveSnapshot);
const replayJson = JSON.stringify(replaySnapshot);
assert(liveJson === replayJson, `replay snapshot DIVERGED from authoring:\n  live=  ${liveJson}\n  replay=${replayJson}`);

// FALSIFIABLE GUARD: replaying WITHOUT the create commands must NOT rebuild the inventories
// (proves the recorded inventory skills are load-bearing, not incidental).
let brokenCore: CoreSkills | undefined;
await replayCommands(recorder.commands.filter((c) => !(c.kind === "skill" && c.tool === "inventory.create")), {
  makeWorld: () => makeWorld(ops),
  makeRegistry: (tr) => { const r = new SkillRegistry(tr as LiminaTracer); brokenCore = registerCoreSkills(r); return r; },
  tracer: new LiminaTracer("ses_p12_inv_broken"),
});
assert(brokenCore !== undefined && brokenCore.inventory.inventoryManager.snapshot().length === 0,
  "dropping inventory.create must yield empty inventories (replay is not load-bearing otherwise)");

ops.op_log(
  `p12_inventory OK: closure-bound manager (reached via core.inventory.inventoryManager) — ` +
  `create/define/add with deterministic lowest-free slots + stacking; typeRestrictions ENFORCED on add (gem rejected: ${badAdd.reason}) and transfer (potion->weapons-chest rolled back); ` +
  `item.equip/unequip move a real unit between slots and the mainhand equipment slot; transfer player->chest with rollback; ` +
  `replay rebuilt ${replaySnapshot.length} inventories BIT-IDENTICAL to authoring (${liveJson.length} snapshot chars); dropping inventory.create yields empty (revert-proof).`,
);
