// Determinism: -0 must not diverge between MEMORY replay and DISK replay.
//
// A skill input carrying -0 (e.g. Math.round(-0.2) from a gizmo drag) is a
// determinism trap: cloneReplayValue preserves -0 in memory, but JSON has no -0
// (JSON.stringify(-0) === "0"), so the SERIALIZED command replays +0. Left
// unfixed, replaying the recorder's in-memory commands and replaying the same log
// re-read from disk build DIFFERENT worlds — and compareWorldState (Object.is)
// reports the divergence as the baffling "pos[0] diverged: 0 vs 0".
//
// The registry canonicalizes -0 -> +0 at its normalized-input choke point (the ONE
// value that feeds both the handler and the recorded command), so live == memory ==
// disk. This gate proves it end-to-end AND proves the check is real:
//   (1) canonicalizeNegativeZero maps -0 -> +0 (and leaves other values);
//   (2) a record -> memory-replay vs record -> JSONL -> parse -> disk-replay of a
//       -0-bearing input yields BIT-IDENTICAL worlds;
//   (3) FALSIFIABILITY: two worlds differing ONLY by -0 vs +0 on one coordinate
//       ARE flagged by compareWorldState — so (2)'s equality is not vacuous.

import * as THREE from "../build/three.bundle.mjs";
import { EntityTable, ops } from "../src/engine.ts";
import { createEcsWorld } from "../src/ecs/world.ts";
import { createTransformStorage } from "../src/ecs/facade.ts";
import { UniformGridSpatialIndex } from "../src/spatial/index.ts";
import { SkillRegistry, type WorldContext } from "../src/skills/registry.ts";
import { registerCoreSkills } from "../src/skills/index.ts";
import { resolveProfile } from "../src/skills/permissions.ts";
import { LiminaTracer } from "../src/observability/event.ts";
import { WorldRecorder } from "../src/worldlog/recorder.ts";
import { replayCommands, replayWorldLog } from "../src/worldlog/replay.ts";
import { captureWorldState, compareWorldState, syncAllBodies } from "../src/worldlog/log.ts";
import { canonicalizeNegativeZero } from "../src/worldlog/replay-value.ts";

function assert(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new Error("p_worldlog_negzero FAIL: " + msg);
}

const SEED = 0x0badbeef;

function makeHeadlessWorld(worldOps: typeof ops): WorldContext {
  const ecs = createEcsWorld();
  const scene = { add() {}, remove() {}, position: { set() {}, x: 0, y: 0, z: 0 }, background: null as unknown };
  const camera = { position: { set() {} }, aspect: 1, lookAt() {}, updateProjectionMatrix() {} };
  return { ecs, transforms: createTransformStorage(ecs), spatial: new UniformGridSpatialIndex(), entities: new EntityTable(), tags: new Map(), scene, camera, ops: worldOps, mode: "headless" };
}

// ---- (1) unit: canonicalization maps -0 -> +0, preserves everything else ----
assert(Object.is(canonicalizeNegativeZero(-0), 0), "-0 must canonicalize to +0");
assert(Object.is(canonicalizeNegativeZero(0), 0), "+0 must stay +0");
assert(canonicalizeNegativeZero(5) === 5, "positive numbers unchanged");
assert(canonicalizeNegativeZero(-3.5) === -3.5, "negative numbers unchanged");
const nested = canonicalizeNegativeZero({ position: [Math.round(-0.2), 1, -0], name: "x" }) as { position: number[]; name: string };
assert(Object.is(nested.position[0], 0) && Object.is(nested.position[2], 0), "nested -0 in array canonicalized");
assert(nested.name === "x" && nested.position[1] === 1, "non-negative-zero fields untouched");
assert(Object.is(Math.round(-0.2), -0), "precondition: Math.round(-0.2) really is -0");
// Cycle-safe: a self-referential input must not stack-overflow the walker (skill
// inputs can be circular; cloneReplayValue rejects them cleanly downstream, at commit).
const cyclic: Record<string, unknown> = { v: Math.round(-0.2) };
cyclic.self = cyclic;
let cyclicThrew = false;
try { canonicalizeNegativeZero(cyclic); } catch { cyclicThrew = true; }
assert(!cyclicThrew, "canonicalizeNegativeZero must not crash on a circular input (cycle guard)");

// Warm THREE lazy init on the DEFAULT rng before the seeded rng is installed.
void new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardNodeMaterial({ color: 0x808080 }));

// ---- (2) record a session whose input carries -0, then compare replays -------
const tracer = new LiminaTracer("ses_negzero");
const registry = new SkillRegistry(tracer);
registerCoreSkills(registry);
const recorder = new WorldRecorder("ses_negzero");
recorder.attach(registry);
recorder.seed(SEED);
const recOps = recorder.wrapOps(ops);
const world = makeHeadlessWorld(recOps);
const base = { agentId: "limina:builder", sessionId: "ses_negzero", permissions: resolveProfile("builder.readWrite"), tick: 0, world };

recOps.op_physics_create_world(-9.81);
recOps.op_physics_add_ground(0);

// A gizmo-style position snap that lands x on -0. If the registry did NOT
// canonicalize, memory replay would store -0 here and disk replay +0.
const negZeroX = Math.round(-0.2); // -0
const created = await registry.invoke("scene.createEntity", {
  shape: "box", collider: "box", size: 1.0, color: 0x3366cc,
  position: [negZeroX, 2.0, negZeroX], dynamic: false, friction: 0.3, restitution: 0.2,
}, base);
assert(created.success, "createEntity with -0 position must succeed");

// Move it again to a -0 component via ecs.updateComponent (a distinct code path).
const entId = (created.result as { entity: string }).entity;
const moved = await registry.invoke("ecs.updateComponent", {
  entity: entId, component: "position", value: [negZeroX, 1.0, 5.0],
}, base);
assert(moved.success, "updateComponent with -0 position must succeed");

for (let tick = 1; tick <= 30; tick++) {
  recorder.tick = tick;
  recOps.op_physics_step();
  syncAllBodies(world);
}
const nativeFinal = captureWorldState(world);

// Replay deps: a FRESH headless world on raw ops (the recorded create_world resets
// native physics state), with the same core skills registered as the recording.
const replayDeps = {
  makeWorld: () => makeHeadlessWorld(ops),
  makeRegistry: (t: LiminaTracer) => { const r = new SkillRegistry(t); registerCoreSkills(r); return r; },
};

// Memory replay: the recorder's in-memory command stream.
const memReplay = await replayCommands(recorder.commands, { ...replayDeps, tracer: new LiminaTracer("ses_negzero_mem") });
const memCmp = compareWorldState(nativeFinal, memReplay.state);
assert(memCmp.identical, "memory replay must match the live run: " + (memCmp.detail ?? ""));

// Disk replay: serialize to JSONL, parse it back, replay the bytes.
const jsonl = recorder.toJsonl();
const diskReplay = await replayWorldLog(jsonl, { ...replayDeps, tracer: new LiminaTracer("ses_negzero_disk") });
const diskCmp = compareWorldState(nativeFinal, diskReplay.state);
assert(diskCmp.identical, "DISK replay must match the live run (the -0 divergence): " + (diskCmp.detail ?? ""));

// And the two replays must agree with each other bit-for-bit.
const crossCmp = compareWorldState(memReplay.state, diskReplay.state);
assert(crossCmp.identical, "memory replay and disk replay must be bit-identical: " + (crossCmp.detail ?? ""));

// ---- (3) falsifiability: compareWorldState DOES flag -0 vs +0 ----------------
// Two snapshots identical except one coordinate is -0 in the first, +0 in the
// second. If compareWorldState did not distinguish them, assertion (2) would be
// vacuous — so prove the detector fires.
const a = captureWorldState(world);
assert(a.entities.length > 0, "need at least one entity for the falsifiability probe");
const b: typeof a = { ...a, entities: a.entities.map((e) => ({ ...e, pos: [e.pos[0], e.pos[1], e.pos[2]] })) };
a.entities[0].pos[0] = -0;
b.entities[0].pos[0] = 0;
const probe = compareWorldState(a, b);
assert(!probe.identical, "compareWorldState MUST flag -0 vs +0 (else the equality checks above are vacuous)");

ops.op_log("p_worldlog_negzero OK: -0 canonicalized; memory==disk==live replay bit-identical; divergence detector proven on -0 vs +0.");
