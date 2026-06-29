// Phase 8 Mode-B / M1 — the wasm-Rapier `PhysicsOps` adapter.
//
// Mirrors p8_export.ts's rigor for the LIVE physics backend
// (src/browser/wasm-rapier-physics.ts). Two tiers:
//
//   ALWAYS (deterministic spine, verifiable regardless of whether rapier-compat
//   can instantiate in this binary):
//     • body-id allocation contract — add_ground consumes no id; first dynamic
//       body = 0, then 1,2,3 monotonic; remove(1) then add => 3 (never reused);
//       create_world resets to 0.
//
//   IF rapier-compat instantiates in this binary (REAL wasm physics):
//     • determinism — drop a box from y=5, step 30 => it fell and landed; the
//       same scene built+stepped twice is bit-identical.
//     • character move resolves against a ground collider (slides/grounds).
//     • snapshot round-trip — build, snapshot, mutate, restore => transforms and
//       ids match the snapshot exactly.
//
// rapier-compat is injected (the native loader can't resolve its bare specifier):
// we import its `rapier.mjs` by relative file path and hand the namespace to
// `WasmRapierPhysics.create()`, which inits the wasm (synchronous-compile shim in
// this non-browser host) and returns the adapter.

import { ops } from "../src/engine.ts";
import { WasmRapierPhysics, type RapierModule } from "../src/browser/wasm-rapier-physics.ts";

function assert(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new Error("p8_wasm_physics FAIL: " + msg);
}

// ── Try to bring up REAL rapier-compat in this binary ──────────────────────────
// Honesty gate: if instantiation fails, we still verify the body-id contract
// (the adapter's deterministic spine) and report REAL physics as browser-UAT.
let RAPIER: RapierModule | null = null;
let initError: string | null = null;
try {
  // @ts-ignore — relative file:// import into node_modules; the native loader
  // resolves file URLs (bare specifiers it cannot).
  RAPIER = (await import("../node_modules/@dimforge/rapier3d-compat/rapier.mjs")) as unknown as RapierModule;
} catch (e) {
  initError = "import failed: " + String(e);
}

let realPhysics = false;
let phys: WasmRapierPhysics | null = null;
if (RAPIER !== null) {
  try {
    phys = await WasmRapierPhysics.create(RAPIER);
    // Smoke-prove the wasm actually steps (not just constructs).
    phys.op_physics_create_world(-9.81);
    phys.op_physics_add_ground(0);
    const probeId = phys.op_physics_add_box(0, 5, 0, 0.5);
    const before = new Float32Array(7); phys.op_physics_body_transform(probeId, before);
    for (let i = 0; i < 10; i++) phys.op_physics_step();
    const after = new Float32Array(7); phys.op_physics_body_transform(probeId, after);
    assert(after[1] < before[1], "smoke: box should fall after stepping (wasm not integrating)");
    realPhysics = true;
  } catch (e) {
    initError = "create/step failed: " + String(e);
    phys = null;
  }
}

// ── 1. BODY-ID ALLOCATION CONTRACT (always; against the REAL adapter) ──────────
// Needs a constructed adapter. If rapier wouldn't even instantiate, we cannot
// build the real adapter — STOP and report (the contract is inseparable from the
// adapter that implements it).
assert(phys !== null, "rapier-compat could not be instantiated in this binary — " +
  "cannot exercise the adapter at all. " + (initError ?? ""));

{
  const p = phys;
  p.op_physics_create_world(-9.81);
  p.op_physics_add_ground(0); // collider only — must NOT consume a body id
  assert(p.op_physics_add_box(0, 1, 0, 0.5) === 0, "first dynamic body should be id 0 (ground must not consume an id)");
  assert(p.op_physics_add_sphere(0, 2, 0, 0.5, 0.5, 0) === 1, "second body should be id 1");
  assert(p.op_physics_add_static_box(0, 0, 0, 1, 1, 1, 0.5, 0) === 2, "third body should be id 2");
  p.op_physics_remove_body(1); // tombstone id 1
  assert(p.op_physics_add_capsule(0, 3, 0, 0.5, 0.3, 0.5, 0) === 3, "after remove, next id must be 3 (ids never reused)");
  // Ops on the removed id are clean no-ops (not crashes).
  const removed = new Float32Array(7);
  p.op_physics_apply_impulse(1, 1, 1, 1);            // no-op
  p.op_physics_body_transform(1, removed.fill(9));   // unknown => zero-fill
  assert(removed.every((v) => v === 0), "transform of a removed id should zero-fill (clean no-op)");
  p.op_physics_remove_body(1);                         // double-remove => no-op
  // create_world resets the monotonic counter to 0.
  p.op_physics_create_world(-9.81);
  assert(p.op_physics_add_box(0, 1, 0, 0.5) === 0, "create_world should reset the id counter to 0");
  // heightfield + character also consume ids monotonically.
  assert(p.op_physics_add_heightfield(0, 0, 0, 2, 2, 4, 1, 4, new Float32Array([0, 0, 0, 0])) === 1, "heightfield should consume id 1");
  assert(p.op_physics_add_character(0, 2, 0, 0.5, 0.3) === 2, "character should consume id 2");
}

// ── 2. REAL PHYSICS (only when rapier instantiated) ────────────────────────────
if (realPhysics) {
  const p = phys;

  // 2a. Drop determinism — a box from y=5 falls (checked after 30 steps) and lands
  //     on the ground (let it settle); the same scene built+stepped twice is
  //     bit-identical. From y=5 free-fall covers only ~1.2m in 30 steps (0.5s), so
  //     we step on to a rest before asserting "landed".
  const dropRun = (): Float32Array => {
    p.op_physics_create_world(-9.81);
    p.op_physics_add_ground(0);
    const id = p.op_physics_add_box(0, 5, 0, 0.5);
    const at30 = new Float32Array(7);
    for (let i = 0; i < 30; i++) p.op_physics_step();
    p.op_physics_body_transform(id, at30);
    assert(at30[1] < 5 && at30[1] > 1, `box should be mid-fall after 30 steps (got y=${at30[1]})`);
    for (let i = 30; i < 150; i++) p.op_physics_step(); // settle onto the ground
    const t = new Float32Array(7); p.op_physics_body_transform(id, t);
    return t;
  };
  const r1 = dropRun();
  const r2 = dropRun();
  assert(r1[1] < 5, `box should have fallen below its y=5 start (got y=${r1[1]})`);
  assert(r1[1] > 0 && r1[1] < 1.5, `box should rest near the ground (center ~0.5; got y=${r1[1]})`);
  for (let i = 0; i < 7; i++) {
    assert(Object.is(r1[i], r2[i]), `determinism: component ${i} differs across runs (${r1[i]} vs ${r2[i]})`);
  }

  // 2b. Character move resolves against the ground — pushing down + forward yields
  //     a grounded capsule that does not sink through the floor.
  p.op_physics_create_world(-9.81);
  p.op_physics_add_ground(0);
  const charId = p.op_physics_add_character(0, 1.0, 0, 0.5, 0.3); // capsule resting above y=0
  const mv = new Float32Array(4);
  let grounded = false;
  for (let i = 0; i < 20; i++) {
    p.op_physics_move_character(charId, 0.1, -0.5, 0, mv); // walk forward while gravity pulls down
    p.op_physics_step();
    if (mv[3] === 1) grounded = true;
  }
  assert(grounded, "character should ground against the floor collider at least once");
  const cpos = new Float32Array(3); p.op_physics_body_pos(charId, cpos);
  // capsule half-height 0.5 + radius 0.3 => its center cannot fall below ~0.8 atop y=0.
  assert(cpos[1] > 0.4, `character should not sink through the ground (center y=${cpos[1]})`);
  assert(cpos[0] > 0, `character should have advanced forward (x=${cpos[0]})`);

  // 2c. Snapshot round-trip — build, snapshot, mutate (step), restore => the
  //     restored transforms AND id->body mapping match the snapshot exactly.
  p.op_physics_create_world(-9.81);
  p.op_physics_add_ground(0);
  const a = p.op_physics_add_box(-1, 4, 0, 0.5);
  const b = p.op_physics_add_box(1, 6, 0, 0.5);
  for (let i = 0; i < 15; i++) p.op_physics_step();
  const snap = p.op_physics_snapshot();
  const aSnap = new Float32Array(7); p.op_physics_body_transform(a, aSnap);
  const bSnap = new Float32Array(7); p.op_physics_body_transform(b, bSnap);
  // Mutate: step further so live state diverges from the snapshot.
  for (let i = 0; i < 30; i++) p.op_physics_step();
  const aMut = new Float32Array(7); p.op_physics_body_transform(a, aMut);
  assert(!Object.is(aMut[1], aSnap[1]), "sanity: stepping after snapshot should change state");
  // Restore and verify exact recovery, by the SAME ids.
  p.op_physics_restore(snap);
  const aBack = new Float32Array(7); p.op_physics_body_transform(a, aBack);
  const bBack = new Float32Array(7); p.op_physics_body_transform(b, bBack);
  for (let i = 0; i < 7; i++) {
    assert(Object.is(aBack[i], aSnap[i]), `restore: body ${a} component ${i} mismatch (${aBack[i]} vs ${aSnap[i]})`);
    assert(Object.is(bBack[i], bSnap[i]), `restore: body ${b} component ${i} mismatch (${bBack[i]} vs ${bSnap[i]})`);
  }
  // The id->handle mapping survived: post-restore add continues the monotonic
  // counter (next id = 2, never colliding with a or b).
  assert(p.op_physics_add_box(0, 8, 0, 0.5) === 2, "restore must preserve the monotonic id counter (next id = 2)");
  // And the restored bodies are still individually addressable.
  const aStill = new Float32Array(7); p.op_physics_body_transform(a, aStill);
  assert(Object.is(aStill[1], aSnap[1]), "restored body a should remain addressable by its original id after a further add");
}

// ── report ─────────────────────────────────────────────────────────────────────
const tail = realPhysics
  ? `REAL wasm-Rapier (core ${RAPIER?.version?.() ?? "?"}) — drop determinism (twice bit-identical), character grounds on floor, snapshot/restore exact by id`
  : `REAL physics is browser-UAT (rapier-compat did not instantiate in this binary: ${initError ?? "unknown"}); contract path verified`;
ops.op_log(
  `p8_wasm_physics OK: body-id contract verified against the REAL adapter ` +
  `(ground=no id, monotonic 0,1,2; remove tombstones, next=3; create_world resets to 0; ` +
  `heightfield+character consume ids; ops on removed ids are clean no-ops). ${tail}.`,
);
