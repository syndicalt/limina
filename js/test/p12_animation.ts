// Phase 12 — REAL animation. animation.ts now drives three's AnimationMixer (CPU keyframe
// sampling — runs headless). This test is the TEETH: the old stub never advanced time and
// never sampled anything; here we prove the mixer truly runs.
//
// APPROACH (per the task note): a fully headless host has no rigged GLTF handy, so we build
// tiny THREE.AnimationClips programmatically (NumberKeyframeTracks targeting `.position[*]`)
// on plain Object3Ds and register them with the SAME manager the skills close over
// (core.animation.animationManager). We assert:
//   1. PLAY ADVANCES: getClipInfo time rises and the sampled object property actually
//      changes after manager.update(dt) — i.e. the mixer ran (old stub: time stuck at 0).
//   2. BLEND NORMALIZES: blended action weights sum to ~1 and keep their proportions.
//   3. STATE MACHINE: a setParam-driven transition switches the active clip (idle -> walk),
//      and a forced animation.transition does too.
//   4. DETERMINISM: two identical update(dt) sequences sample identical values, bit-for-bit.
//   5. SKILL WIRING: the animation.play SKILL resolves an entity's glTF object and drives
//      the returned manager end-to-end (clip time advances through the skill path).
//   6. CLEAN FAILURE: animation.play on an entity with no glTF object returns ok:false.
//
// Run: limina js/test/p12_animation.ts   (exit 0 = pass)

import * as THREE from "../build/three.bundle.mjs";
import { EntityTable, ops, type EngineOps } from "../src/engine.ts";
import { createEcsWorld } from "../src/ecs/world.ts";
import { createTransformStorage } from "../src/ecs/facade.ts";
import { UniformGridSpatialIndex } from "../src/spatial/index.ts";
import { LiminaTracer } from "../src/observability/event.ts";
import { SkillRegistry, type WorldContext } from "../src/skills/registry.ts";
import { registerCoreSkills } from "../src/skills/index.ts";
import { resolveProfile } from "../src/skills/permissions.ts";
import { AnimationManager } from "../src/skills/animation.ts";
import type { SceneObject } from "../src/engine.ts";
import type { MCPResponse } from "../src/mcp/protocol.ts";

function assert(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new Error("p12_animation FAIL: " + msg);
}
function ok(res: MCPResponse | undefined): Record<string, unknown> {
  if (res === undefined || !res.success) throw new Error("call failed: " + JSON.stringify(res?.error));
  return res.result as Record<string, unknown>;
}
const approx = (a: number, b: number, eps = 1e-6): boolean => Math.abs(a - b) <= eps;

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

/** A tiny programmatic clip: animate one position axis 0 -> `to` over `dur` seconds. */
function slideClip(name: string, axis: "x" | "y" | "z", to: number, dur = 1): THREE.AnimationClip {
  const track = new THREE.NumberKeyframeTrack(`.position[${axis}]`, [0, dur], [0, to]);
  return new THREE.AnimationClip(name, dur, [track]);
}

// ── Build the core skill set and grab THE manager the skills close over ──
const reg = new SkillRegistry(new LiminaTracer("ses_p12_anim"));
const core = registerCoreSkills(reg);
const mgr = core.animation.animationManager;
assert(mgr instanceof AnimationManager, "core.animation.animationManager is not an AnimationManager");

// ════ 1. PLAY ADVANCES (the teeth: time + sampled property both move) ════
{
  const obj = new THREE.Object3D();
  mgr.registerClip("slide", slideClip("slide", "x", 10, 1));
  mgr.play("hero", "slide", { loop: true }, obj);

  assert(obj.position.x === 0, "position should start at 0");
  let info = mgr.getClipInfo("hero");
  assert(info.length === 1 && info[0].time === 0, "clip should be at time 0 before any update");

  mgr.update(0.25);
  info = mgr.getClipInfo("hero");
  assert(approx(info[0].time, 0.25, 1e-4), `time did not advance to 0.25 (got ${info[0].time}) — mixer never ran`);
  assert(approx(obj.position.x, 2.5, 1e-4), `sampled position.x wrong after 0.25s (got ${obj.position.x})`);

  mgr.update(0.25);
  info = mgr.getClipInfo("hero");
  assert(approx(info[0].time, 0.5, 1e-4), `time did not advance to 0.5 (got ${info[0].time})`);
  assert(approx(obj.position.x, 5, 1e-4), `sampled position.x wrong after 0.5s (got ${obj.position.x})`);
  assert(approx(info[0].duration, 1, 1e-9), "reported duration should be the clip duration (1s)");
}

// ════ 2. BLEND NORMALIZES (weights sum to 1, proportions preserved) ════
{
  const obj = new THREE.Object3D();
  mgr.registerClip("b_idle", slideClip("b_idle", "y", 1, 1));
  mgr.registerClip("b_walk", slideClip("b_walk", "x", 1, 1));
  mgr.registerClip("b_run", slideClip("b_run", "z", 1, 1));
  // Raw weights 2:1:1 -> normalized 0.5:0.25:0.25.
  mgr.blend("runner", [
    { clipId: "b_idle", weight: 2 },
    { clipId: "b_walk", weight: 1 },
    { clipId: "b_run", weight: 1 },
  ], obj);
  const info = mgr.getClipInfo("runner");
  assert(info.length === 3, `blend should run 3 actions (got ${info.length})`);
  const sum = info.reduce((s, c) => s + c.weight, 0);
  assert(approx(sum, 1, 1e-6), `blend weights did not normalize to 1 (sum ${sum})`);
  const idle = info.find((c) => c.clipId === "b_idle")!;
  const walk = info.find((c) => c.clipId === "b_walk")!;
  assert(approx(idle.weight, 0.5, 1e-6), `idle weight should be 0.5 (got ${idle.weight})`);
  assert(approx(walk.weight, 0.25, 1e-6), `walk weight should be 0.25 (got ${walk.weight})`);
}

// ════ 3. STATE MACHINE: param-driven transition switches the active clip ════
{
  const obj = new THREE.Object3D();
  mgr.registerClip("sm_idle", slideClip("sm_idle", "y", 4, 1));
  mgr.registerClip("sm_walk", slideClip("sm_walk", "x", 8, 1));
  mgr.createStateMachine("npc", {
    name: "locomotion",
    defaultState: "idle",
    states: [
      { name: "idle", clipId: "sm_idle" },
      { name: "walk", clipId: "sm_walk" },
    ],
    transitions: [
      { from: "idle", to: "walk", conditions: [{ param: "speed", op: "greater", value: 0.1 }], duration: 0.2 },
      { from: "walk", to: "idle", conditions: [{ param: "speed", op: "less", value: 0.1 }], duration: 0.2 },
    ],
    parameters: [{ name: "speed", type: "float", defaultValue: 0 }],
  }, obj);

  assert(mgr.getState("npc") === "idle", "state machine should start in 'idle'");
  let info = mgr.getClipInfo("npc");
  assert(info.some((c) => c.clipId === "sm_idle"), "idle clip should be running at start");
  assert(!info.some((c) => c.clipId === "sm_walk" && c.weight > 0), "walk clip should not be active at start");

  // Raise speed; on the next update the idle->walk transition fires and crossfades.
  mgr.setParam("npc", "speed", 1);
  mgr.update(0.05); // transition fires here; walk action enters at weight 0, crossfading in
  assert(mgr.getState("npc") === "walk", "speed>0.1 did not switch the state to 'walk'");
  // Drive the crossfade to completion.
  for (let i = 0; i < 10; i++) mgr.update(0.05);
  info = mgr.getClipInfo("npc");
  const walk = info.find((c) => c.clipId === "sm_walk");
  const idle = info.find((c) => c.clipId === "sm_idle");
  assert(walk !== undefined && walk.weight > 0.9, `walk clip should have crossfaded in (weight ${walk?.weight})`);
  assert(idle === undefined || idle.weight < 0.1, `idle clip should have crossfaded out (weight ${idle?.weight})`);
  assert(obj.position.x > 0, "walk clip should have sampled position.x (mixer ran the new active clip)");

  // Forced transition back via the manager API.
  assert(mgr.transition("npc", "idle") === true, "forced transition to 'idle' failed");
  assert(mgr.getState("npc") === "idle", "forced transition did not set state to 'idle'");
  assert(mgr.transition("npc", "nope") === false, "transition to an unknown state should return false");
}

// ════ 4. DETERMINISM: identical dt sequences sample identical values ════
function deterministicRun(): number[] {
  const m = new AnimationManager();
  const obj = new THREE.Object3D();
  m.registerClip("d_slide", slideClip("d_slide", "x", 7, 1));
  m.play("e", "d_slide", { loop: true, speed: 1.3 }, obj);
  const samples: number[] = [];
  for (const dt of [0.016, 0.033, 0.05, 0.1, 0.25, 0.4]) {
    m.update(dt);
    samples.push(obj.position.x);
  }
  return samples;
}
{
  const a = deterministicRun();
  const b = deterministicRun();
  assert(a.length === b.length && a.length === 6, "determinism run produced wrong sample count");
  for (let i = 0; i < a.length; i++) {
    assert(Object.is(a[i], b[i]), `non-deterministic sample at step ${i}: ${a[i]} != ${b[i]}`);
  }
  assert(a[a.length - 1] > 0, "determinism run never sampled a non-zero value (mixer did not run)");
}

// ════ 5. SKILL WIRING: animation.play SKILL drives the returned manager end-to-end ════
{
  const world = makeWorld(ops);
  const skinObj = new THREE.Object3D();
  const entId = world.entities.create({ eid: 0, mesh: skinObj as unknown as SceneObject });
  mgr.registerClip("wave", slideClip("wave", "x", 6, 1));
  const base = { agentId: "agt_p12", sessionId: "ses_p12_anim", permissions: resolveProfile("builder.readWrite"), tick: 0, world };

  // animation.load registers via the SAME closure manager.
  ok(await reg.invoke("animation.load", { id: "loaded_clip", name: "Loaded", duration: 2 }, base));
  assert(mgr.hasClip("loaded_clip"), "animation.load SKILL did not register on the returned manager (closure mis-wired)");

  const played = ok(await reg.invoke("animation.play", { entity: entId, clipId: "wave" }, base));
  assert(played.ok === true, "animation.play SKILL did not succeed for an entity with a glTF object");
  mgr.update(0.5);
  const info = mgr.getClipInfo(entId);
  assert(info.length === 1 && approx(info[0].time, 0.5, 1e-4), `skill-played clip did not advance (time ${info[0]?.time})`);
  assert(approx(skinObj.position.x, 3, 1e-4), `skill-played clip did not sample (position.x ${skinObj.position.x})`);

  // ════ 6. CLEAN FAILURE: no glTF object -> ok:false, not faked success ════
  const missing = ok(await reg.invoke("animation.play", { entity: "ent_does_not_exist", clipId: "wave" }, base));
  assert(missing.ok === false, "animation.play on an entity with no glTF object should return ok:false");
}

ops.op_log(
  "p12_animation OK: animation.ts drives three's REAL AnimationMixer (CPU keyframe sampling, headless). " +
  "play advances clip time AND samples the bound property (mixer truly runs — old stub stayed at 0); " +
  "blend weights normalize to 1; a setParam-driven state-machine transition (idle->walk) crossfades the " +
  "active clip and the forced animation.transition switches it; two identical update(dt) sequences sample " +
  "identical values (deterministic, dt-driven); and the animation.play SKILL resolves an entity's glTF " +
  "object and drives the returned core.animation.animationManager end-to-end (no glTF -> clean ok:false).",
);
