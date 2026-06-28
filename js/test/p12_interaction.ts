// Phase 12 — interaction.* skills: REAL proximity query, deterministic interact
// tick (ctx.tick, NOT Date.now()), honest pickup/drop/use against inventory, and
// REPLAY EQUIVALENCE (the regression teeth for the Date.now() determinism bug).
//
// Proves:
//   1. CLOSURE WIRING: the managers are reachable via core.interaction/inventory and
//      the skills actually mutate them (no never-set ctx.world.* no-op).
//   2. REAL PROXIMITY: interaction.query returns only interactables within range of a
//      position, sorted by distance, over real entity transforms (the no-op sort and
//      hardcoded distance:0 are gone).
//   3. DETERMINISTIC interact: lastInteractTick == the sim tick the call ran at.
//   4. PICKUP into inventory; USE consumes; DROP spawns a real world item entity.
//   5. REPLAY-EQUIVALENCE: replaying the recorded stream into a FRESH core recomputes
//      BIT-IDENTICAL world state AND the same lastInteractTick (a Date.now() stamp
//      would diverge here).
//
// Run: limina js/test/p12_interaction.ts   (exit 0 = pass)

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
import { captureWorldState, compareWorldState } from "../src/worldlog/log.ts";
import type { MCPResponse } from "../src/mcp/protocol.ts";

function assert(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new Error("p12_interaction FAIL: " + msg);
}
function ok(res: MCPResponse): Record<string, unknown> {
  if (!res.success) throw new Error("call failed: " + JSON.stringify(res.error));
  return (res.result ?? {}) as Record<string, unknown>;
}
function approx(a: number, b: number, eps = 1e-6): boolean {
  return Math.abs(a - b) <= eps;
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

const TICK = 7; // a non-zero sim tick: lastInteractTick must equal THIS, not Date.now()

// ── AUTHORING (recorded) ──────────────────────────────────────────────────
const recReg = new SkillRegistry(new LiminaTracer("ses_p12_rec"));
const core: CoreSkills = registerCoreSkills(recReg);
const recorder = new WorldRecorder("ses_p12_rec");
recorder.attach(recReg);
const world = makeWorld(ops);
const base = { agentId: "agt_rec", sessionId: "ses_p12_rec", permissions: resolveProfile("builder.readWrite"), tick: TICK, world };
const call = (tool: string, input: unknown) => recReg.invoke(tool, input, base);

// (1) CLOSURE WIRING: managers are reachable on the core.
const mgr = core.interaction.interactionManager;
const invMgr = core.inventory.inventoryManager;
assert(mgr !== undefined && invMgr !== undefined, "core.interaction / core.inventory managers missing");

// Build real entities with positions (the proximity query reads their transforms).
const actor = ok(await call("scene.createEntity", { shape: "box", position: [0, 0, 0] })).entity as string;
const chest = ok(await call("scene.createEntity", { shape: "box", position: [2, 0, 0] })).entity as string; // dist 2
const lever = ok(await call("scene.createEntity", { shape: "box", position: [4, 0, 0] })).entity as string; // dist 4
const farRock = ok(await call("scene.createEntity", { shape: "box", position: [10, 0, 0] })).entity as string; // dist 10 (out)
const apple = ok(await call("scene.createEntity", { shape: "sphere", position: [1, 0, 0] })).entity as string; // pickup item

// Register interactables (incl. the far one, to prove range filtering).
ok(await call("interaction.register", { entity: chest, prompt: "Open chest", maxRange: 3, type: "open" }));
ok(await call("interaction.register", { entity: lever, prompt: "Pull lever", maxRange: 5, type: "toggle" }));
ok(await call("interaction.register", { entity: farRock, prompt: "Mine rock", maxRange: 3, type: "pickup" }));
ok(await call("interaction.register", { entity: apple, prompt: "Take apple", maxRange: 3, type: "pickup" }));

// (2) REAL PROXIMITY: query from the actor, range 5. Expect apple(1), chest(2), lever(4)
// — sorted by distance — and the far rock (dist 10) EXCLUDED.
const q = ok(await call("interaction.query", { actorEntity: actor, maxRange: 5 }));
const found = q.interactables as { entity: string; prompt: string; type: string; distance: number }[];
assert(found.length === 3, `query returned ${found.length} interactables, expected 3 (apple/chest/lever in range, rock out)`);
assert(!found.some((f) => f.entity === farRock), "far rock (dist 10) leaked into a range-5 query");
assert(found[0].entity === apple && found[1].entity === chest && found[2].entity === lever,
  `query not sorted by distance: ${found.map((f) => `${f.entity}@${f.distance}`).join(", ")}`);
assert(approx(found[0].distance, 1) && approx(found[1].distance, 2) && approx(found[2].distance, 4),
  `query distances wrong (hardcoded 0 not removed?): ${found.map((f) => f.distance).join(", ")}`);
assert(found[0].prompt === "Take apple" && found[0].type === "pickup", "query lost the registered prompt/type");

// (3) DETERMINISTIC interact: lastInteractTick must equal the sim tick (TICK), not Date.now().
const ir = ok(await call("interaction.interact", { entity: chest, actorEntity: actor }));
const interactResult = ir.result as Record<string, unknown>;
assert(interactResult.lastInteractTick === TICK, `lastInteractTick=${interactResult.lastInteractTick}, expected ctx.tick=${TICK} (Date.now regression?)`);
assert(interactResult.lastInteractedBy === actor, "interact did not record the actor");
// The manager state agrees with the returned result (closure-bound, not a no-op).
assert(mgr.get(chest)?.state.lastInteractTick === TICK, "manager state lastInteractTick not stamped from ctx.tick");

// (4a) PICKUP: create an inventory, pick the apple into it, confirm it landed + the
// world item entity is destroyed.
ok(await call("inventory.create", { entity: actor, capacity: 20 }));
const pk = ok(await call("interaction.pickup", { itemEntity: apple, actorEntity: actor }));
assert(pk.ok === true, "pickup failed");
assert(invMgr.countItem(actor, apple) === 1, "picked-up item did not land in the actor inventory");
assert(world.entities.resolve(apple) === undefined, "pickup did not destroy the world item entity");

// (4b) USE consumes from inventory.
ok(await call("inventory.add", { entity: actor, itemId: "potion", quantity: 2 }));
const us = ok(await call("interaction.use", { actorEntity: actor, itemId: "potion" }));
assert(us.ok === true, "use failed");
assert(invMgr.countItem(actor, "potion") === 1, "use did not consume one potion from inventory");
// Honest failure when the actor lacks the item.
const useMiss = await call("interaction.use", { actorEntity: actor, itemId: "missing" });
assert(useMiss.success && (useMiss.result as { ok: boolean }).ok === false, "use of a missing item must fail cleanly (ok:false)");

// (4c) DROP spawns a REAL world item entity at the actor position, returning its id.
const dr = ok(await call("interaction.drop", { actorEntity: actor, itemId: apple }));
assert(dr.ok === true, "drop failed");
const dropped = dr.itemEntity as string;
assert(typeof dropped === "string" && dropped.length > 0, "drop did not return a spawned entity id");
assert(world.entities.resolve(dropped) !== undefined, "drop did not create a real world item entity");
assert(invMgr.countItem(actor, apple) === 0, "drop did not remove the item from inventory");

const authState = captureWorldState(world);
const authTick = mgr.get(chest)?.state.lastInteractTick;

// ── (5) REPLAY-EQUIVALENCE: replay the recorded stream into a FRESH core ───────
let replayCore: CoreSkills | undefined;
const replay = await replayCommands(recorder.commands, {
  makeWorld: () => makeWorld(ops),
  makeRegistry: (tr) => {
    const r = new SkillRegistry(tr as LiminaTracer);
    replayCore = registerCoreSkills(r);
    return r;
  },
  tracer: new LiminaTracer("ses_p12_replay"),
});
assert(replayCore !== undefined, "replay did not construct a core");

// World state must be bit-identical (pickup/drop entity churn reproduced exactly).
const cmp = compareWorldState(authState, replay.state);
assert(cmp.identical, `replay world state diverged: ${cmp.detail}`);

// The deterministic interaction tick must be reproduced bit-identically (the Date.now
// regression would make this diverge from the authoring run).
const replayTick = replayCore.interaction.interactionManager.get(chest)?.state.lastInteractTick;
assert(replayTick === authTick && replayTick === TICK,
  `replay lastInteractTick=${replayTick} != authoring ${authTick} (== ${TICK}) — interact is NOT deterministic`);
// And the replayed inventory matches (closure-bound managers rebuilt from the log).
assert(replayCore.inventory.inventoryManager.countItem(actor, "potion") === 1, "replay inventory diverged (potion count)");

// NO DOUBLE-RECORD sanity: pickup/drop/use are top-level skill commands, not nested ops.
const tools = recorder.commands.filter((c): c is { kind: "skill"; tool: string } => c.kind === "skill").map((c) => c.tool);
assert(tools.includes("interaction.query") && tools.includes("interaction.interact") && tools.includes("interaction.drop"),
  "interaction skills were not recorded as top-level commands");

ops.op_log(
  `p12_interaction OK: closure-wired managers (core.interaction/inventory); REAL proximity query ` +
  `(apple@1, chest@2, lever@4 sorted; rock@10 excluded); interact stamps lastInteractTick=${TICK} from ctx.tick; ` +
  `pickup→inventory, use consumes, drop spawns a real world item entity; ` +
  `replay recomputes BIT-IDENTICAL world state (${cmp.comparisons} comparisons) + the same lastInteractTick (Date.now regression caught).`,
);
