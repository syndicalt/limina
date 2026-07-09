// P84 — headless COLLISION gate for the BROWSER (WASM Rapier / sim-worker) walk path.
//
// This is the gate p83 could NOT be: p83 drives the NATIVE FFI physics ops directly, and it
// authors the building box BY HAND (ops.op_physics_add_static_box) rather than through the
// asset.place skill. So p83 stayed green on the native host while the REAL browser runtime — the
// M3 sim-worker driving `@dimforge/rapier3d-compat` (wasm Rapier) — had NO collision (the player
// walked through terrain AND buildings).
//
// p84 reproduces the ACTUAL browser physics path: a real `SimWorkerController` (the same
// Worker-API-agnostic unit the dedicated Worker wraps), bringing up `WasmRapierPhysics`, then
// `loadWorldIsolated` on a command stream (terrain.create + asset.place building + player.spawn) and
// driving forward input through the SAME tick()/controller.step path the worker uses.
//
// Asserts, on the WASM/worker path:
//   (a) GROUNDED — a player spawned above the terrain.create heightfield DROPS and RESTS on it
//       (does not fall through).
//   (b) BLOCKED — a player walking into a placed building (asset.place) is STOPPED before the box,
//       while a NO-BUILDING control walks straight through the same spot (so the collider, not the
//       step budget, is what blocks).
//
// Run: ./target/release/limina js/test/p84_wasm_walk_collision.ts   (exit 0 = pass)

import { SimWorkerController, type AuthorCommand } from "../src/browser/sim-worker.ts";
import { InputRingBuffer, type InputFrame } from "../src/browser/sab-ringbuffer.ts";
import type { RapierModule } from "../src/browser/wasm-rapier-physics.ts";
import { ops as nativeOps } from "../src/engine.ts";

function assert(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new Error("p84_wasm_walk_collision FAIL: " + msg);
}

// ── bring up REAL rapier-compat (injected; the native loader can't resolve the bare specifier) ──
let RAPIER: RapierModule | null = null;
let initError: string | null = null;
try {
  // @ts-ignore — relative file:// import into node_modules.
  RAPIER = (await import("../node_modules/@dimforge/rapier3d-compat/rapier.mjs")) as unknown as RapierModule;
} catch (e) {
  initError = "import failed: " + String(e);
}
assert(RAPIER !== null, "rapier-compat could not be imported in this binary — cannot run the browser walk gate. " + (initError ?? ""));

// A real GLB the assets route serves (used by the fidelity renders / village.build). The WORKER must
// author a collider for it even though it never parses the mesh.
const BUILDING_ASSET = "cottage.glb";

// Flat terrain so the resting height is exact (baseHeight 0 ⇒ surface y=0). Player radius 0.3 +
// halfHeight 0.6 ⇒ ground offset 0.9 (see Task-2 human capsule).
const GROUND_OFFSET = 0.9;

// The building is placed in the forward (-Z) path. player.spawn is at origin; walking -Z reaches it.
const BUILDING_POS: [number, number, number] = [0, 0, -6];

function scene(withBuilding: boolean): AuthorCommand[] {
  const cmds: AuthorCommand[] = [
    { kind: "physics", op: "op_physics_create_world", args: [-9.81] },
    { kind: "skill", tool: "terrain.create", input: { size: 100, resolution: 33, baseHeight: 0 } },
    { kind: "skill", tool: "player.spawn", input: { position: [0, 5, 0] } },
  ];
  if (withBuilding) {
    cmds.push({ kind: "skill", tool: "asset.place", input: { assetId: BUILDING_ASSET, position: BUILDING_POS, ground: true } });
  }
  return cmds;
}

interface Run { grounded: boolean; groundedY: number; finalZ: number; results: unknown[] }

async function run(withBuilding: boolean, settle: number, walk: number): Promise<Run> {
  const ctrl = await SimWorkerController.create({ rapier: RAPIER as RapierModule });
  // Inject a WORKING asset reader (mirrors the browser worker's sync-XHR reader): natively we have a
  // real op_read_asset, so asset.place can resolve the GLB bytes + compute the building AABB. The
  // production browser worker path is fixed to sync-XHR /assets/<id> (composeWorkerOps).
  (ctrl.world.ops as unknown as { op_read_asset: (id: string) => Uint8Array }).op_read_asset =
    (id: string): Uint8Array => nativeOps.op_read_asset(id);

  const load = await ctrl.loadWorldIsolated(scene(withBuilding));
  for (const f of load.failures) {
    throw new Error(`authoring command #${f.index} ${f.command} failed: ${f.message}`);
  }

  const playerEntity = (load.results[2] as { entity: string }).entity;
  const playerEid = ctrl.entities.resolve(playerEntity)?.eid;
  assert(playerEid !== undefined, "player entity must resolve to an eid");

  const input = new InputRingBuffer({ buffer: ctrl.buffers.input });
  const frame: InputFrame = { move: [0, 0, 0], look: [0, 0], buttons: [0, 0], tick: 0 };

  // Settle: zero input, let gravity drop the capsule onto the terrain heightfield.
  for (let i = 0; i < settle; i++) ctrl.tick();

  const groundedY = ctrl.transforms.Position.y[playerEid];

  // Walk forward (-Z at yaw 0): move = [strafe, vertical, forward]; forward = +1.
  frame.move[0] = 0; frame.move[2] = 1; frame.look[0] = 0;
  for (let i = 0; i < walk; i++) {
    frame.tick = i;
    input.writeInput(frame);
    ctrl.tick();
  }

  const finalZ = ctrl.transforms.Position.z[playerEid];
  // grounded flag: re-read via one more settle tick's controller state is not exposed on the SAB, so
  // infer grounding from the resting Y being at the surface.
  const grounded = Math.abs(groundedY - GROUND_OFFSET) < 0.15;
  ctrl.dispose();
  return { grounded, groundedY, finalZ, results: load.results };
}

const SETTLE = 90; // drop from y=5 + settle
const WALK = 200;  // 4.5 m/s * 1/60 ≈ 0.075 m/step ⇒ ~15 m unobstructed (well past the building at z=-6)

const withB = await run(true, SETTLE, WALK);
const noB = await run(false, SETTLE, WALK);

// ── (a) GROUNDED on the terrain heightfield (did NOT fall through). ──
assert(Number.isFinite(withB.groundedY), `player Y not finite after settling: ${withB.groundedY}`);
assert(
  Math.abs(withB.groundedY - GROUND_OFFSET) < 0.15,
  `player did not rest on the terrain heightfield (WASM path): Y=${withB.groundedY.toFixed(3)}, expected ~${GROUND_OFFSET} (fell through ⇒ no ground collision in the worker)`,
);

// ── (b) BLOCKED by the placed building; the no-building control walks straight through. ──
// The building box front face is near z ≈ BUILDING_POS.z + halfDepth. The player is stopped in front
// of it; the control (no building) passes that plane by a wide margin.
assert(
  noB.finalZ < BUILDING_POS[2] - 1.0,
  `NO-BUILDING control did not walk past the building plane (script too short to prove blocking): ctrlZ=${noB.finalZ.toFixed(3)}`,
);
assert(
  withB.finalZ > noB.finalZ + 1.0,
  `the placed building did NOT stop the player on the WASM/worker path: withBuildingZ=${withB.finalZ.toFixed(3)} vs controlZ=${noB.finalZ.toFixed(3)} (walked through the building ⇒ no building collider in the worker)`,
);
// And the player never crossed deep into the building footprint (stopped in front of it).
assert(
  withB.finalZ > BUILDING_POS[2],
  `player entered the building footprint: finalZ=${withB.finalZ.toFixed(3)} (building center z=${BUILDING_POS[2]})`,
);

nativeOps.op_log(
  `[js] p84_wasm_walk_collision OK (BROWSER wasm-Rapier / sim-worker path): player RESTS on the ` +
  `terrain.create heightfield at Y=${withB.groundedY.toFixed(2)} (grounded), and a placed asset.place ` +
  `building STOPS the walk at z=${withB.finalZ.toFixed(2)} while the no-building control reaches ` +
  `z=${noB.finalZ.toFixed(2)} — collision is live on the authoritative worker, not just the native FFI.`,
);
