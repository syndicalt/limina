// Phase 8 PARITY GATE (headless) — proves the browser EXPORT-PLAYBACK path
// reproduces the native run. Records a real native physics session (ground +
// dynamic spheres stirred by recorded impulses) WITH periodic transform
// keyframes, assembles the portable export, round-trips it through the serialized
// files (as a browser would read from disk/IndexedDB), then REPLAYS the command
// log into a fresh world whose PhysicsOps are KEYFRAME-DRIVEN (no simulation) —
// and asserts the final world state is BIT-IDENTICAL to the native run
// (compareWorldState). Falsifiable: corrupting one keyframe MUST diverge (proves
// playback genuinely serves transforms from the keyframes, not by re-simulating).

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
import { replayCommands } from "../src/worldlog/replay.ts";
import { captureWorldState, compareWorldState, syncAllBodies } from "../src/worldlog/log.ts";
import { KeyframeRecorder } from "../src/worldlog/keyframes.ts";
import { assembleExport, loadExport } from "../src/export/package.ts";
import { KeyframePhysics, playbackOps } from "../src/browser/keyframe-physics.ts";
import { ReplayPlayer } from "../src/browser/player.ts";

function assert(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new Error("p8_playback_parity FAIL: " + msg);
}

const SEED = 0x0bada55;
const TICKS = 240;
const INTERVAL = 20;
const STIR = 3;
// A deliberately NON-keyframe tick, sitting exactly halfway between two keyframes
// (f=0.5, the worst case for straight-line interpolation error), used by the
// inter-keyframe parity check below. MID_TICK % INTERVAL !== 0 so playback MUST
// interpolate here (it can't serve a stored transform verbatim).
const MID_TICK = 130;

function makeHeadlessWorld(worldOps: typeof ops): WorldContext {
  const ecs = createEcsWorld();
  const scene = { add() {}, remove() {}, position: { set() {}, x: 0, y: 0, z: 0 }, background: null as unknown };
  const camera = { position: { set() {} }, aspect: 1, lookAt() {}, updateProjectionMatrix() {} };
  return { ecs, transforms: createTransformStorage(ecs), spatial: new UniformGridSpatialIndex(), entities: new EntityTable(), tags: new Map(), scene, camera, ops: worldOps, mode: "headless" };
}

// Warm THREE's lazy init on the DEFAULT rng before the seeded rng is installed
// (mirrors p4_worldlog_replay) so record + replay draw the same seeded stream.
void new THREE.Mesh(new THREE.SphereGeometry(0.5, 24, 16), new THREE.MeshStandardNodeMaterial({ color: 0x808080 }));
void new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardNodeMaterial({ color: 0x808080 }));

// ---- RECORD a native session + capture keyframes ---------------------------
const recTracer = new LiminaTracer("ses_p8_record");
const registry = new SkillRegistry(recTracer);
registerCoreSkills(registry);
const recorder = new WorldRecorder("ses_p8_record");
recorder.attach(registry);
recorder.seed(SEED);
const recOps = recorder.wrapOps(ops);
const world = makeHeadlessWorld(recOps);
const keyframeRec = new KeyframeRecorder(INTERVAL);

const base = { agentId: "limina:builder", sessionId: "ses_p8_record", permissions: resolveProfile("builder.readWrite"), tick: 0, world };

recOps.op_physics_create_world(-9.81);
recOps.op_physics_add_ground(0);

const balls: { id: string; eid: number }[] = [];
let colorSeq = 0x3366cc;
for (let gz = -1; gz <= 1; gz++) {
  for (let gx = -1; gx <= 0; gx++) {
    const res = await registry.invoke("scene.createEntity", {
      shape: "sphere", collider: "sphere", size: 1.0,
      color: (colorSeq = (colorSeq + 0x1111) & 0xffffff),
      position: [gx * 2.2, 0.5, gz * 2.0], dynamic: true, friction: 0.3, restitution: 0.5,
    }, base);
    assert(res.success, "bootstrap createEntity failed");
    const id = (res.result as { entity: string }).entity;
    const entry = world.entities.resolve(id);
    assert(entry !== undefined, "created entity not resolvable");
    balls.push({ id, eid: entry.eid });
  }
}
assert(balls.length >= STIR, "not enough balls");

assert(MID_TICK % INTERVAL !== 0 && MID_TICK < TICKS, "MID_TICK must be a non-keyframe tick inside the run");
keyframeRec.maybeCapture(world, 0); // initial keyframe (tick 0)
const stir = balls.slice(0, STIR);
const GAIN = 0.05, SWIRL = 0.02;
const Position = (await import("../src/ecs/world.ts")).Position;
// The native (real-physics) state at an interpolated, NON-keyframe tick — captured so
// playback's nlerp between the bracketing keyframes can be checked against real physics.
let nativeMid: ReturnType<typeof captureWorldState> | undefined;
for (let tick = 1; tick <= TICKS; tick++) {
  recorder.tick = tick;
  for (const ball of stir) {
    const px = Position.x[ball.eid], pz = Position.z[ball.eid];
    await registry.invoke("physics.applyImpulse", { entity: ball.id, impulse: [-GAIN * px - SWIRL * pz, 0, -GAIN * pz + SWIRL * px] }, base);
  }
  recOps.op_physics_step();
  syncAllBodies(world);
  keyframeRec.maybeCapture(world, tick);
  if (tick === MID_TICK) nativeMid = captureWorldState(world);
}
assert(nativeMid !== undefined, "native mid-tick state was never captured");
keyframeRec.capture(world, TICKS); // force the final keyframe so end state is exact

const nativeFinal = captureWorldState(world);

// sanity: the recorded run actually moved bodies.
let moved = 0;
for (const b of balls) {
  const st = nativeFinal.entities.find((e) => e.id === b.id);
  assert(st !== undefined && st.body !== undefined, "ball missing body in snapshot");
  if (Math.abs(st.body[0]) + Math.abs(st.body[2]) > 0.01 || Math.abs(st.body[1] - 0.5) > 1e-6) moved++;
}
assert(moved >= 1, "no ball moved during the recorded run");

// ---- ASSEMBLE the export + round-trip through the serialized files ----------
const exportFiles = assembleExport({
  worldId: "p8-demo", meta: recorder.meta(), commands: recorder.commands,
  keyframes: keyframeRec.keyframes, keyframeInterval: INTERVAL, createdAt: "2026-01-01T00:00:00Z",
});
const pkg = loadExport(exportFiles); // parses exactly what a browser reads back
assert(pkg.keyframes.length >= TICKS / INTERVAL, `too few keyframes: ${pkg.keyframes.length}`);
assert(pkg.keyframes[pkg.keyframes.length - 1].tick === TICKS, "final keyframe not at the last tick");

// ---- PLAYBACK: replay the log with KEYFRAME-DRIVEN physics ------------------
function makeKeyframeWorld(keyframes: typeof pkg.keyframes): WorldContext {
  const physics = new KeyframePhysics(keyframes);
  return makeHeadlessWorld(playbackOps(physics) as typeof ops);
}
const playback = await replayCommands(pkg.commands, {
  makeWorld: () => makeKeyframeWorld(pkg.keyframes),
  makeRegistry: (tracer) => { const r = new SkillRegistry(tracer); registerCoreSkills(r); return r; },
  tracer: new LiminaTracer("ses_p8_playback"),
});

const cmp = compareWorldState(nativeFinal, playback.state);
assert(cmp.identical, `playback diverged from native (${cmp.comparisons} fields): ${cmp.detail ?? "?"}`);
assert(playback.state.entities.length === nativeFinal.entities.length, "entity count differs");

// ---- TICK-BY-TICK player (the form the browser rAF loop drives) -------------
const player = new ReplayPlayer(pkg, {
  makeWorld: (o) => makeHeadlessWorld(o as typeof ops),
  makeRegistry: (tracer) => { const r = new SkillRegistry(tracer); registerCoreSkills(r); return r; },
  tracer: new LiminaTracer("ses_p8_player"),
});
await player.init();
let guard = 0;
// Snapshot the player at the NON-keyframe MID_TICK too — the tick the inter-keyframe
// parity check compares against real native physics (playback interpolates here).
let playerMid: ReturnType<typeof captureWorldState> | undefined;
while (!player.done && guard++ < TICKS + 10) {
  await player.stepTick();
  if (player.tick === MID_TICK) playerMid = player.state();
}
assert(player.tick === TICKS, `player ended at tick ${player.tick}, expected ${TICKS}`);
const playerState = player.state();
const playerCmp = compareWorldState(nativeFinal, playerState);
assert(playerCmp.identical, `tick-by-tick player diverged from native (${playerCmp.comparisons} fields): ${playerCmp.detail ?? "?"}`);

// ---- INTER-KEYFRAME PARITY (interpolated tick, bounded tolerance) -----------
// The equality checks above all land on the FORCED final keyframe (tick TICKS), where
// KeyframePhysics serves the stored transform VERBATIM — so they prove keyframe fidelity
// but make final-tick equality near-tautological and never exercise the BETWEEN-keyframe
// path. Here we compare MID_TICK, a non-keyframe tick: native holds the real integrated
// physics state, while playback nlerps between the two bracketing keyframes (kf 120↔140,
// f=0.5). That is APPROXIMATE by construction — a straight chord vs a curved trajectory —
// so this is a BOUNDED CLOSENESS check, NOT bit-identical. MID_TOL is the interpolation
// "sagitta" the chord may miss the true path by over one INTERVAL of this stirred motion.
// Measured on this build: the interpolated pose sits ~0.12 m from native here, whereas
// serving the PREVIOUS keyframe verbatim would be ~0.43 m off and the keyframes are ~0.78 m
// apart — so MID_TOL=0.20 m passes a genuinely-tracking interpolation yet is comfortably
// BELOW the stale-keyframe/travel error, meaning a playback that stopped interpolating (or
// served a wrong keyframe) would blow past it. Verbatim final-tick equality remains exact.
function maxBodyPosDelta(a: ReturnType<typeof captureWorldState>, b: ReturnType<typeof captureWorldState>): { delta: number; where: string } {
  let delta = 0, where = "none";
  for (const ea of a.entities) {
    const eb = b.entities.find((e) => e.id === ea.id);
    if (ea.body === undefined || eb === undefined || eb.body === undefined) continue;
    for (let i = 0; i < 3; i++) {
      const d = Math.abs(ea.body[i] - eb.body[i]);
      if (d > delta) { delta = d; where = `${ea.id} body[${i}]`; }
    }
  }
  return { delta, where };
}
assert(playerMid !== undefined, `player never observed the inter-keyframe tick ${MID_TICK}`);
const MID_TOL = 0.20; // meters — interpolation sagitta budget (see comment above)
const midDelta = maxBodyPosDelta(nativeMid, playerMid);
assert(midDelta.delta <= MID_TOL, `inter-keyframe playback drifted from native by ${midDelta.delta.toFixed(4)} m at ${midDelta.where} (tol ${MID_TOL} m)`);

// ---- FALSIFIABILITY: corrupt one keyframe transform -> MUST diverge ---------
const corrupted = pkg.keyframes.map((k) => ({ tick: k.tick, bodies: k.bodies.map((b) => ({ id: b.id, t: [...b.t] as typeof b.t })) }));
const lastKf = corrupted[corrupted.length - 1];
assert(lastKf.bodies.length > 0, "final keyframe has no bodies to corrupt");
lastKf.bodies[0].t[0] += 5.0; // shove one body 5 units in x
const badPlayback = await replayCommands(pkg.commands, {
  makeWorld: () => makeKeyframeWorld(corrupted),
  makeRegistry: (tracer) => { const r = new SkillRegistry(tracer); registerCoreSkills(r); return r; },
  tracer: new LiminaTracer("ses_p8_bad"),
});
const badCmp = compareWorldState(nativeFinal, badPlayback.state);
assert(!badCmp.identical, "corrupting a keyframe did NOT diverge — playback isn't actually using the keyframes");

ops.op_log(`p8_playback_parity OK: native ${TICKS}t/${recorder.commands.length}cmd/${pkg.keyframes.length}kf -> keyframe-driven playback BIT-IDENTICAL on keyframe ticks (${cmp.comparisons} fields, ${playback.state.entities.length} entities); inter-keyframe tick ${MID_TICK} tracks native to ${midDelta.delta.toFixed(4)} m (tol ${MID_TOL} m); corrupting a keyframe falsifies divergence [${badCmp.detail ?? "?"}].`);
