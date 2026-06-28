// Phase 12 — THE CAPSTONE. Prove an AGENT can author AND play a tiny COMPLETE game
// end-to-end using ONLY the Phase-12 game skills, driven purely through
// registry.invoke(...) — never by poking the managers directly (an agent has only the
// skill surface). This is the verifiable deliverable for the whole phase.
//
// THE TINY GAME (a "collect the orb to win" loop), authored + played via skills:
//   1. world.generateRegion  — the ground/colliders (a small plains region).
//   2. player.spawn          — a real kinematic character on that surface.
//   3. scene.createEntity     — the orb pickup; interaction.register makes it interactable;
//      inventory.create        — gives the player a pack.
//   4. game.condition         — the WIN rule: counter('orbs') >= 1 → game.win.
//   5. PLAY: player.move toward the orb (fixed-step), interaction.query confirms it is in
//      range, interaction.pickup folds it into the inventory, which trips the counter →
//      the condition evaluates true → game.win. State becomes "won".
//
// ASSERTS (falsifiable, real — nothing faked):
//   • the player spawned and ACTUALLY moved (start Z != end Z, on the commanded -Z axis);
//   • the orb landed in the inventory (inventory.has) and the world orb entity is gone;
//   • the win condition evaluated TRUE and the game state == "won";
//   • DETERMINISM: the SAME scripted skill sequence run twice (fresh registry/world each)
//     yields a BYTE-IDENTICAL trajectory, identical pickup step, and identical final state
//     (incl. the deterministic endedAtTick stamped from ctx.tick — a wall-clock would
//     diverge here).
//
// Run: ./target/release/limina js/test/p12_capstone.ts   (exit 0 = pass)

import { EntityTable, ops, type EngineOps } from "../src/engine.ts";
import { createEcsWorld } from "../src/ecs/world.ts";
import { createTransformStorage } from "../src/ecs/facade.ts";
import { UniformGridSpatialIndex } from "../src/spatial/index.ts";
import { LiminaTracer } from "../src/observability/event.ts";
import { SkillRegistry, type WorldContext } from "../src/skills/registry.ts";
import { registerCoreSkills, type CoreSkills } from "../src/skills/index.ts";
import { resolveProfile } from "../src/skills/permissions.ts";
import { TILE_SIZE } from "../src/terrain/procedural.ts";
import { terrainTypeHints } from "../src/terrain/terrain-types.ts";
import type { MCPResponse } from "../src/mcp/protocol.ts";

function assert(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new Error("p12_capstone FAIL: " + msg);
}
function ok(res: MCPResponse | undefined): Record<string, unknown> {
  if (res === undefined || !res.success) throw new Error("call failed: " + JSON.stringify(res?.error));
  return (res.result ?? {}) as Record<string, unknown>;
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

// ── Game authoring constants (the agent's seeds) ───────────────────────────────
const SEED = 4242;
const TYPE = "plains" as const;
const BOUNDS = { minTx: 0, minTz: 0, maxTx: 1, maxTz: 1 }; // a small 2x2-tile region (~96m)
const HINTS = terrainTypeHints(TYPE, BOUNDS);

// Region center (spawn) and the orb 6m "forward" (yaw=0 walk drives world -Z).
const CENTER_X = ((BOUNDS.minTx + BOUNDS.maxTx + 1) / 2) * TILE_SIZE;
const CENTER_Z = ((BOUNDS.minTz + BOUNDS.maxTz + 1) / 2) * TILE_SIZE;
const ORB_X = CENTER_X;
const ORB_Z = CENTER_Z - 6;

const SETTLE = 20;       // steps to let the capsule settle onto the surface
const MAX_WALK = 400;    // safety cap on the walk-to-orb loop
const ARRIVE = 2.5;      // pickup when the orb is within this distance of the player
const ORB_RANGE = 4;     // the orb's interaction max range

interface GameResult {
  entity: string;
  trajectory: number[];        // flattened [x,y,z] per recorded step
  startZ: number;
  endZ: number;
  pickedUpAtStep: number;
  hasOrb: boolean;
  orbDestroyed: boolean;
  conditionValue: boolean;
  finalState: string;
  endedAtTick: number | undefined;
}

/** Author AND play the whole tiny game with skills only. Returns the observable outcome
 *  (trajectory + final game state) for the determinism comparison. */
async function runGame(session: string): Promise<GameResult> {
  // Fresh physics world (the native world is global, so each run RESETS it — that, plus
  // the fresh registry/world/cache, is what makes a re-run reproducible).
  ops.op_physics_create_world(-9.81);

  const reg = new SkillRegistry(new LiminaTracer(session));
  const core: CoreSkills = registerCoreSkills(reg);
  const world = makeWorld(ops);
  let tick = 0; // deterministic sim tick (drives interaction/win stamps); no wall-clock
  const at = () => ({ agentId: "agt_capstone", sessionId: session, permissions: resolveProfile("builder.readWrite"), tick, world });

  // 1. GROUND — colliders for a small plains region (headless: data/colliders only).
  const gen = ok(await reg.invoke("world.generateRegion", {
    seed: SEED, bounds: BOUNDS, lod: 0, type: TYPE, render: false,
  }, at()));
  assert((gen.tiles as number) === 4, `expected 4 tiles, got ${gen.tiles}`);
  ops.op_physics_step(); // build the broad-phase BVH so the first move grounds the capsule

  // 2. PLAYER — spawn a real character resting on the generated surface.
  const surfaceY = core.terrain.source.sampleHeight(SEED, CENTER_X, CENTER_Z, 0, HINTS);
  const player = ok(await reg.invoke("player.spawn", { position: [CENTER_X, surfaceY + 0.9, CENTER_Z] }, at())).entity as string;

  // 3. THE ORB + the player's pack. The orb is a real world entity made interactable.
  const orbSurfaceY = core.terrain.source.sampleHeight(SEED, ORB_X, ORB_Z, 0, HINTS);
  const orb = ok(await reg.invoke("scene.createEntity", { shape: "sphere", size: 0.6, color: 0xffd000, position: [ORB_X, orbSurfaceY + 0.9, ORB_Z] }, at())).entity as string;
  ok(await reg.invoke("interaction.register", { entity: orb, prompt: "Collect the orb", maxRange: ORB_RANGE, type: "pickup" }, at()));
  ok(await reg.invoke("inventory.create", { entity: player, capacity: 8 }, at()));

  // 4. THE WIN RULE — a condition over a counter; when it rises, the game is won.
  ok(await reg.invoke("game.condition", { name: "collected", expression: "counter('orbs') >= 1", onTrue: "game.objectiveComplete" }, at()));

  // ── PLAY ──────────────────────────────────────────────────────────────────
  const trajectory: number[] = [];
  const record = (p: [number, number, number]): void => { trajectory.push(p[0], p[1], p[2]); };

  // Settle on the ground.
  let pos: [number, number, number] = [CENTER_X, surfaceY + 0.9, CENTER_Z];
  for (let i = 0; i < SETTLE; i++) {
    tick++;
    pos = ok(await reg.invoke("player.move", { entity: player, forward: 0 }, at())).newPosition as [number, number, number];
    record(pos);
  }
  const startZ = pos[2];

  // Walk forward (yaw=0 → world -Z) toward the orb, polling proximity each fixed step.
  // The proximity query uses the player's LIVE capsule center (player.move's newPosition)
  // — the headless ECS transform is inert, so we feed the real position explicitly.
  let pickedUpAtStep = -1;
  for (let step = 0; step < MAX_WALK; step++) {
    tick++;
    pos = ok(await reg.invoke("player.move", { entity: player, forward: 1, yaw: 0 }, at())).newPosition as [number, number, number];
    record(pos);
    const q = ok(await reg.invoke("interaction.query", { position: pos, maxRange: ORB_RANGE }, at()));
    const near = (q.interactables as { entity: string; distance: number }[]).find((e) => e.entity === orb);
    if (near !== undefined && near.distance <= ARRIVE) {
      // interaction.pickup → inventory → bump the counter → re-evaluate the win condition.
      const pk = ok(await reg.invoke("interaction.pickup", { itemEntity: orb, actorEntity: player }, at()));
      assert(pk.ok === true, "interaction.pickup failed at the orb");
      ok(await reg.invoke("game.counter", { name: "orbs", action: "increment", value: 1 }, at()));
      pickedUpAtStep = step;
      break;
    }
  }
  assert(pickedUpAtStep >= 0, "player never reached the orb within the walk cap");
  const endZ = pos[2];

  // 5. WIN — evaluate the condition; on its rising edge, declare victory.
  const cond = ok(await reg.invoke("game.condition", { name: "collected", action: "evaluate" }, at()));
  const conditionValue = cond.value as boolean;
  if (conditionValue) ok(await reg.invoke("game.win", {}, at()));

  // Observe outcomes (reads, for the assertions — the FLOW above was 100% skill-driven).
  const hasOrb = (ok(await reg.invoke("inventory.has", { entity: player, itemId: orb }, at())).has) as boolean;
  const orbDestroyed = world.entities.resolve(orb) === undefined;
  const gs = core.gamestate.gameStateManager.getState();

  return {
    entity: player, trajectory, startZ, endZ, pickedUpAtStep,
    hasOrb, orbDestroyed, conditionValue,
    finalState: gs.state, endedAtTick: gs.endedAtTick,
  };
}

// ── RUN A — author + play, then assert the whole loop really happened ──────────
const A = await runGame("ses_p12_capstone_A");

assert(typeof A.entity === "string" && A.entity.length > 0, "player.spawn returned no entity");
assert(A.endZ < A.startZ - 3, `player did not move forward toward the orb: startZ=${A.startZ.toFixed(2)} endZ=${A.endZ.toFixed(2)}`);
assert(A.hasOrb === true, "orb did not land in the player inventory after pickup");
assert(A.orbDestroyed === true, "pickup did not destroy the world orb entity");
assert(A.conditionValue === true, "the win condition did not evaluate true after collecting the orb");
assert(A.finalState === "won", `game state is '${A.finalState}', expected 'won'`);
assert(A.endedAtTick !== undefined, "game.win did not stamp a deterministic endedAtTick");

// ── RUN B — DETERMINISM: same scripted skills, fresh registry/world, identical outcome ──
const B = await runGame("ses_p12_capstone_B");

assert(A.trajectory.length === B.trajectory.length, `trajectory length differs across runs (${A.trajectory.length} vs ${B.trajectory.length})`);
for (let i = 0; i < A.trajectory.length; i++) {
  assert(Object.is(A.trajectory[i], B.trajectory[i]), `non-deterministic trajectory at index ${i}: ${A.trajectory[i]} vs ${B.trajectory[i]}`);
}
assert(A.pickedUpAtStep === B.pickedUpAtStep, `pickup step differs across runs (${A.pickedUpAtStep} vs ${B.pickedUpAtStep})`);
assert(A.finalState === B.finalState, `final state differs across runs (${A.finalState} vs ${B.finalState})`);
assert(A.endedAtTick === B.endedAtTick, `endedAtTick differs across runs (${A.endedAtTick} vs ${B.endedAtTick}) — a wall-clock leaked into the win`);

const steps = A.trajectory.length / 3;
ops.op_log(
  `p12_capstone OK: authored + PLAYED a tiny complete game through skills only — ` +
  `world.generateRegion (4 tiles) → player.spawn → scene.createEntity orb + interaction.register + inventory.create → ` +
  `game.condition win rule; PLAY: walked -Z ${(A.startZ - A.endZ).toFixed(1)}m, interaction.query found the orb, interaction.pickup at step ${A.pickedUpAtStep} → inventory.has=true (orb entity destroyed), counter trips the condition → game.win (state="won", endedAtTick=${A.endedAtTick}); ` +
  `DETERMINISM: ${steps} steps x2 byte-identical trajectory + identical pickup step + identical final state/endedAtTick.`,
);
