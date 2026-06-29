// p8_sim_worker — Phase 8 Mode B, M3: the authoritative fixed-step SIM-WORKER.
//
// Drives the Worker-API-AGNOSTIC `SimWorkerController` DIRECTLY (no Worker), so
// the whole composition is headless-testable:
//   1. AUTHOR + STEP — a ground + a dynamic box dropped from y=5 + a character;
//      pump 60 ticks; assert the box FELL and its pose is SYNCED into the
//      transform SAB SoA (read back from `.Position`) — proves physics -> SAB.
//   2. INPUT RING — write an input frame, assert the controller consumes it at the
//      next tick (1-frame latency); a newer frame supersedes it.
//   3. TICK COUNTER — advances via Atomics and is readable cross-instance.
//   4. DETERMINISM — two fresh controllers + an identical input script produce
//      BYTE-IDENTICAL SAB transforms after 60 ticks (Object.is on every float).
//
// Real wasm Rapier is required (the worker IS the live solver). If rapier-compat
// cannot instantiate in this binary we STOP and report (the controller is
// inseparable from the physics it drives) — mirrors p8_wasm_physics's honesty gate.
//
// Run: ./target/release/limina js/test/p8_sim_worker.ts   (exit 0 on pass)

import { SimWorkerController, type AuthorCommand } from "../src/browser/sim-worker.ts";
import { InputRingBuffer, type InputFrame } from "../src/browser/sab-ringbuffer.ts";
import type { RapierModule } from "../src/browser/wasm-rapier-physics.ts";

function assert(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new Error("p8_sim_worker FAIL: " + msg);
}

// ── bring up REAL rapier-compat (injected; the native loader can't resolve the
//    bare specifier — import its rapier.mjs by relative file path) ──────────────
let RAPIER: RapierModule | null = null;
let initError: string | null = null;
try {
  // @ts-ignore — relative file:// import into node_modules.
  RAPIER = (await import("../node_modules/@dimforge/rapier3d-compat/rapier.mjs")) as unknown as RapierModule;
} catch (e) {
  initError = "import failed: " + String(e);
}
assert(RAPIER !== null, "rapier-compat could not be imported in this binary — cannot run the sim worker. " + (initError ?? ""));

// The authoring script: create world, ground, a dynamic box from y=5 (a real ECS
// entity via scene.createEntity, so it syncs into the SAB), and a player character.
function authoringScript(): AuthorCommand[] {
  return [
    { kind: "physics", op: "op_physics_create_world", args: [-9.81] },
    { kind: "physics", op: "op_physics_add_ground", args: [0] },
    { kind: "skill", tool: "scene.createEntity", input: { shape: "box", size: 1, position: [0, 5, 0], dynamic: true, collider: "box" } },
    { kind: "skill", tool: "player.spawn", input: { position: [2, 1, 2] } },
  ];
}

async function buildController(inputBuffer?: SharedArrayBuffer | ArrayBuffer): Promise<SimWorkerController> {
  const ctrl = await SimWorkerController.create({ rapier: RAPIER as RapierModule, inputBuffer });
  return ctrl;
}

// ===========================================================================
// 1. AUTHOR + STEP — the box falls and its pose lands in the SAB SoA.
// ===========================================================================
const ctrl = await buildController();
const results = await ctrl.loadWorld(authoringScript());

// scene.createEntity result -> the box entity id; resolve its eid for SAB reads.
const boxEntity = (results[2] as { entity: string }).entity;
const boxEid = ctrl.entities.resolve(boxEntity)?.eid;
assert(boxEid !== undefined, "box entity must resolve to an eid");
const playerEntity = (results[3] as { entity: string }).entity;
const playerEid = ctrl.entities.resolve(playerEntity)?.eid;
assert(playerEid !== undefined, "player entity must resolve to an eid");

// After authoring (before any tick) the box pose is synced at its spawn height ~5.
const startY = ctrl.transforms.Position.y[boxEid];
assert(startY > 4.5 && startY <= 5.0001, `authored box should be synced near y=5 (got ${startY})`);
assert(ctrl.ticks === 0, "tick counter starts at 0");

for (let i = 0; i < 60; i++) ctrl.tick();

const restY = ctrl.transforms.Position.y[boxEid];
assert(restY < 4, `box should have FALLEN well below its y=5 start after 60 ticks (got ${restY})`);
assert(restY > 0 && restY < 1.5, `box should rest near the ground (center ~0.5; got ${restY})`);
// The pose really came from the solver via the SAB (not left at 0): the quaternion
// is a real unit quaternion synced from the body.
const qw = ctrl.transforms.Rotation.w[boxEid];
assert(Math.abs(Math.hypot(
  ctrl.transforms.Rotation.x[boxEid], ctrl.transforms.Rotation.y[boxEid],
  ctrl.transforms.Rotation.z[boxEid], qw,
) - 1) < 1e-3, "box rotation in the SAB must be a unit quaternion (real synced pose)");
assert(ctrl.ticks === 60, `tick counter should read 60 after 60 ticks (got ${ctrl.ticks})`);

// ===========================================================================
// 2. INPUT RING — the controller consumes the latest published frame at the next
// tick (1-frame latency); a newer frame supersedes it.
// ===========================================================================
{
  const c = await buildController();
  await c.loadWorld(authoringScript());
  // The "render-main thread" side: a SEPARATE ring joined to the controller's SAB.
  const main = new InputRingBuffer({ buffer: c.buffers.input });
  assert(c.lastInput === null, "no input consumed before the first input tick");

  const frameA: InputFrame = { move: [1, 0, 0.5], look: [0.25, 0], buttons: [1, 0], tick: 41 };
  main.writeInput(frameA);
  c.tick();
  const gotA = c.lastInput;
  assert(gotA !== null, "controller must consume the published frame at the next tick");
  assert(gotA.tick === 41, `consumed frame stamp should be 41 (got ${gotA?.tick})`);
  assert(gotA.move[0] === 1 && gotA.buttons[0] === 1, "consumed frame body must match the published frame");

  // A newer frame supersedes the older one on the following tick.
  main.writeInput({ move: [-1, 0, -1], look: [0, 0], buttons: [0, 1], tick: 42 });
  c.tick();
  const gotB = c.lastInput;
  assert(gotB !== null && gotB.tick === 42, `newer frame must supersede (expected stamp 42, got ${gotB?.tick})`);
  assert(gotB.buttons[1] === 1 && gotB.move[0] === -1, "superseding frame body must match the newest publish");
}

// ===========================================================================
// 3. TICK COUNTER — readable cross-instance via Atomics over the status SAB.
// (When SAB is available this proves the render thread can poll progress.)
// ===========================================================================
{
  const c = await buildController();
  await c.loadWorld(authoringScript());
  const statusView = new Int32Array(c.buffers.status, 0, 1);
  for (let i = 0; i < 10; i++) c.tick();
  const viaAtomics = typeof Atomics !== "undefined" && c.buffers.status instanceof SharedArrayBuffer
    ? Atomics.load(statusView, 0)
    : statusView[0];
  assert(viaAtomics === 10, `tick counter in the status buffer should read 10 (got ${viaAtomics})`);
  assert(c.ticks === 10, "getter and status buffer must agree");
}

// ===========================================================================
// 4. DETERMINISM — two fresh controllers + identical input script => byte-identical
// SAB transforms after 60 ticks. Real wasm physics is deterministic, and each
// controller writes its OWN transform SAB, so the two buffers must match exactly.
// ===========================================================================
async function runScripted(): Promise<Float32Array> {
  const c = await buildController();
  await c.loadWorld(authoringScript());
  const main = new InputRingBuffer({ buffer: c.buffers.input });
  for (let i = 0; i < 60; i++) {
    // Deterministic, tick-indexed input: walk forward + an occasional jump.
    main.writeInput({
      move: [0, 0, 1],
      look: [0, 0],
      buttons: [i % 20 === 0 ? 1 : 0, 0],
      tick: i,
    });
    c.tick();
  }
  // Snapshot the whole transform SAB as a comparable Float32 view.
  return new Float32Array(c.transforms.buffer.slice(0));
}

const d1 = await runScripted();
const d2 = await runScripted();
assert(d1.length === d2.length, "determinism: snapshot lengths differ");
let firstDiff = -1;
for (let i = 0; i < d1.length; i++) {
  if (!Object.is(d1[i], d2[i])) { firstDiff = i; break; }
}
assert(firstDiff === -1, `determinism: SAB float ${firstDiff} differs across runs (${d1[firstDiff]} vs ${d2[firstDiff]})`);

// ── report ─────────────────────────────────────────────────────────────────────
const backing = typeof SharedArrayBuffer === "function" && typeof Atomics !== "undefined"
  ? "SharedArrayBuffer + Atomics"
  : "ArrayBuffer fallback (cross-thread SAB/Atomics is browser-UAT)";
console.log(
  `p8_sim_worker OK: REAL wasm-Rapier sim worker (core ${RAPIER.version?.() ?? "?"}); ` +
  `authored ground+box+character via loadWorld; box fell y=${startY.toFixed(3)} -> ${restY.toFixed(3)} ` +
  `and synced into the transform SAB (eid ${boxEid}); input ring read at next tick (1-frame latency) ` +
  `+ newer supersedes; Atomics tick counter advances (=${ctrl.ticks}); ` +
  `DETERMINISM: two controllers byte-identical over ${d1.length} SAB floats after 60 ticks. ` +
  `backing=${backing}. The thin Worker shell (self.onmessage) is browser-UAT.`,
);
