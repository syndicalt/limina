// Phase 12 — vfx.* skills: a REAL CPU particle system in the scene.
//
// The old vfx.ts was a config-only stub: the module-level skills read a
// `ctx.world.vfxManager` that was NEVER set, so every call no-op'd and nothing was
// ever simulated or drawn. This test is the teeth for the rewrite:
//
//   1. create + play builds a THREE.Points on the scene and SIMULATES particles —
//      update(dt) advances positions per explicit Euler (pos += vel·dt; vel += g·dt).
//   2. AGING / RECYCLING: a capacity-bounded emitter caps at maxParticles (slots are
//      recycled as particles die); stop() lets them age out to zero (a fade).
//   3. atPosition spawns a REAL burst immediately and self-frees once drained.
//   4. attach re-bases the emitter on a MOVED entity's transform each update.
//   5. destroy removes the Points from the scene.
//   6. DETERMINISM: two identical create+update sequences produce byte-identical
//      position buffers (proves seeded jitter, NO Math.random).
//
// Run: limina js/test/p12_vfx.ts   (exit 0 = pass)

import { ops } from "../src/engine.ts";
import { spawnRenderable, type Transformable } from "../src/ecs/world.ts";
import { createHeadlessContext } from "../src/game/index.ts";
import { type WorldContext } from "../src/skills/registry.ts";
import { VFXManager } from "../src/skills/vfx.ts";
import type { MCPResponse } from "../src/mcp/protocol.ts";

function assert(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new Error("p12_vfx FAIL: " + msg);
}
function approx(a: number, b: number, eps = 1e-3): boolean {
  return Math.abs(a - b) <= eps;
}
function ok(res: MCPResponse | undefined): Record<string, unknown> {
  if (res === undefined || !res.success) throw new Error("call failed: " + JSON.stringify(res?.error));
  return res.result as Record<string, unknown>;
}

/** A scene stub that records the live child objects (like a real scene.add/remove). */
function makeScene(): { add(o: unknown): void; remove(o: unknown): void; children: Set<unknown>; background: unknown } {
  const children = new Set<unknown>();
  return {
    add(o: unknown) { children.add(o); },
    remove(o: unknown) { children.delete(o); },
    children,
    background: null,
  };
}

function inert(): Transformable {
  return { position: { set() {} }, quaternion: { set() {} }, scale: { set() {} } };
}

const DT = 0.1;

// ── Setup: core skills + the closure-owned manager via core.vfx.vfxManager ───────
const scene = makeScene();
const ctx = createHeadlessContext({ scene: scene as unknown as WorldContext["scene"], session: "ses_p12_vfx", agentId: "agt_vfx" });
const reg = ctx.registry;
const core = ctx.core;
const mgr = core.vfx.vfxManager;
assert(mgr instanceof VFXManager, "core.vfx.vfxManager is not a VFXManager");
const world = ctx.world;
const base = ctx.base;

// ── 1. create + play → REAL particles that advance per the integration ───────────
// shape "point" + spread 0 ⇒ every particle launches straight up (0, speed, 0):
// the integration is exactly predictable, so this is the teeth vs. the old no-op stub.
const SPEED = 5;
const GRAV = -10;
const created = ok(await reg.invoke("vfx.create", {
  config: {
    maxParticles: 64, lifetime: 2, emissionRate: 10, // 10/s · 0.1s ⇒ 1 spawn/frame
    startColor: [1, 0.6, 0.1, 1], endColor: [1, 0.6, 0.1, 0],
    startSize: 0.2, endSize: 0.05, startSpeed: SPEED, gravity: GRAV,
    spread: 0, shape: "point", blendMode: "additive",
  },
}, base));
const vfxId = created.vfxId as string;
assert(typeof vfxId === "string" && vfxId.length > 0, "vfx.create returned no id");
assert(scene.children.size === 1, "vfx.create did not add a Points object to the scene");
assert(mgr.particleCount(vfxId) === 0, "no particles should exist before play/update");

ok(await reg.invoke("vfx.play", { vfxId }, base));

// Frame 1: spawn (slot 0 at emitter origin) then integrate same frame.
mgr.update(DT);
assert(mgr.particleCount(vfxId) === 1, `expected 1 live particle after frame 1, got ${mgr.particleCount(vfxId)}`);
let pos = mgr.positionsOf(vfxId);
assert(pos !== undefined, "positionsOf returned undefined");
// Explicit Euler frame 1: p.y = 0 + SPEED·dt.
assert(approx(pos![1], SPEED * DT), `particle y after frame 1 = ${pos![1]}, expected ${SPEED * DT}`);
assert(pos![0] === 0 && pos![2] === 0, "spread-0 point particle drifted off the +Y axis");

// Frames 2 & 3: closed-form explicit Euler for slot 0 (spawned frame 1).
// f2: p=0.5+ (5-1)·0.1 = 0.9 ; f3: p=0.9 + (4-1)·0.1 = 1.2
mgr.update(DT);
mgr.update(DT);
pos = mgr.positionsOf(vfxId)!;
assert(approx(pos[1], 1.2, 2e-3), `particle y after 3 frames = ${pos[1]}, expected 1.2`);
assert(mgr.particleCount(vfxId) === 3, `expected 3 live particles after 3 frames, got ${mgr.particleCount(vfxId)}`);
ok(await reg.invoke("vfx.destroy", { vfxId }, base));
assert(scene.children.size === 0, "vfx.destroy did not remove the Points from the scene");

// ── 2. AGING / RECYCLING: capacity cap, then fade-out to zero on stop ─────────────
// Staggered emission (1 particle/frame, lifetime 0.5s) so deaths are staggered: the
// emitter fills to capacity, then RECYCLES freed slots indefinitely (sustained > 0).
const capId = ok(await reg.invoke("vfx.create", {
  config: {
    maxParticles: 4, lifetime: 0.5, emissionRate: 10, // 1 spawn/frame
    startColor: [1, 1, 1, 1], endColor: [1, 1, 1, 0],
    startSize: 0.1, endSize: 0.05, startSpeed: 1, gravity: 0,
    spread: 0, shape: "point", blendMode: "additive",
  },
}, base)).vfxId as string;
ok(await reg.invoke("vfx.play", { vfxId: capId }, base));
let maxLive = 0;
for (let i = 0; i < 12; i++) {
  mgr.update(DT);
  const live = mgr.particleCount(capId);
  assert(live <= 4, `live count exceeded maxParticles: ${live}`);
  if (live > maxLive) maxLive = live;
}
// The cap was reached (capacity honored) AND particles are still alive after 12 frames,
// far past the 0.5s lifetime — only possible if freed slots are RECYCLED.
assert(maxLive === 4, `emitter never reached its capacity of 4 (max live ${maxLive})`);
assert(mgr.particleCount(capId) > 0, "emission did not sustain — slots were not recycled");
// stop() ⇒ no new emission; existing particles age out (fade) to zero.
ok(await reg.invoke("vfx.stop", { vfxId: capId }, base));
for (let i = 0; i < 6; i++) mgr.update(DT); // > lifetime/dt frames
assert(mgr.particleCount(capId) === 0, `particles did not age out after stop, ${mgr.particleCount(capId)} remain`);
ok(await reg.invoke("vfx.destroy", { vfxId: capId }, base));

// ── 3. atPosition: a REAL one-shot burst that self-frees once drained ─────────────
const burst = ok(await reg.invoke("vfx.atPosition", {
  position: [10, 5, -3], color: [0.2, 0.8, 1, 1], size: 0.3, lifetime: 0.25, count: 12, speed: 4,
}, base));
const burstId = burst.vfxId as string;
assert(mgr.particleCount(burstId) === 12, `atPosition spawned ${mgr.particleCount(burstId)} particles, expected 12`);
const beforeBuf = mgr.positionsOf(burstId)!;
// All particles START at the burst origin.
assert(approx(beforeBuf[0], 10) && approx(beforeBuf[1], 5) && approx(beforeBuf[2], -3), "burst did not spawn at the requested position");
mgr.update(DT);
const afterBuf = mgr.positionsOf(burstId)!;
let moved = false;
for (let i = 0; i < beforeBuf.length; i++) if (!Object.is(beforeBuf[i], afterBuf[i])) { moved = true; break; }
assert(moved, "burst particles did not move after update");
// Drain it: after > lifetime the one-shot self-destroys.
for (let i = 0; i < 4; i++) mgr.update(DT);
assert(mgr.get(burstId) === undefined, "drained one-shot did not self-free");

// ── 4. attach: emitter follows a MOVED entity's transform ─────────────────────────
const eid = spawnRenderable(world.ecs, inert(), 1, 2, 3);
const ent = world.entities.create({ eid });
const trailId = ok(await reg.invoke("vfx.create", {
  config: {
    maxParticles: 16, lifetime: 2, emissionRate: 10,
    startColor: [1, 1, 1, 1], endColor: [1, 1, 1, 0],
    startSize: 0.1, endSize: 0.05, startSpeed: 0, gravity: 0, // speed 0 ⇒ spawns sit on the emitter
    spread: 0, shape: "point", blendMode: "additive",
  },
}, base)).vfxId as string;
ok(await reg.invoke("vfx.attach", { vfxId: trailId, entity: ent, offset: [0, 1, 0] }, base));
ok(await reg.invoke("vfx.play", { vfxId: trailId }, base));
mgr.update(DT);
let view = mgr.get(trailId)!;
assert(view.attached && view.entity === ent, "system did not record the attachment");
assert(approx(view.emitter[0], 1) && approx(view.emitter[1], 3) && approx(view.emitter[2], 3), `emitter ${view.emitter} != entity+offset (1,3,3)`);
// Move the entity; the emitter must track it on the next update.
world.transforms!.writePosition(eid, 20, 7, -5);
mgr.update(DT);
view = mgr.get(trailId)!;
assert(approx(view.emitter[0], 20) && approx(view.emitter[1], 8) && approx(view.emitter[2], -5), `emitter ${view.emitter} did not follow moved entity (expected 20,8,-5)`);
// A particle spawned this frame originates at the new (moved) emitter — proves the follow
// affects real spawns, not just bookkeeping (speed 0 ⇒ it stays at the emitter origin).
const trailBuf = mgr.positionsOf(trailId)!;
let nearMoved = false;
for (let i = 0; i < trailBuf.length / 3; i++) {
  if (approx(trailBuf[i * 3], 20) && approx(trailBuf[i * 3 + 1], 8) && approx(trailBuf[i * 3 + 2], -5)) { nearMoved = true; break; }
}
assert(nearMoved, "no particle was spawned at the moved emitter position");
ok(await reg.invoke("vfx.destroy", { vfxId: trailId }, base));

// ── 6. DETERMINISM: two identical create+update runs ⇒ byte-identical buffers ──────
function run(): Float32Array {
  const m = new VFXManager();
  const cfg = {
    maxParticles: 32, lifetime: 2, emissionRate: 30,
    startColor: [1, 0.5, 0.2, 1] as [number, number, number, number], endColor: [1, 0.5, 0.2, 0] as [number, number, number, number],
    startSize: 0.2, endSize: 0.05, startSpeed: 6, gravity: -9.8,
    spread: 45, shape: "cone" as const, blendMode: "additive" as const,
  };
  const id = m.create(cfg); // no scene needed for the pure-sim determinism check
  m.play(id);
  for (let i = 0; i < 12; i++) m.update(DT);
  return m.positionsOf(id)!;
}
const runA = run();
const runB = run();
assert(runA.length === runB.length, "determinism: buffer lengths differ");
let identical = true;
let liveA = 0;
for (let i = 0; i < runA.length; i++) {
  if (!Object.is(runA[i], runB[i])) { identical = false; break; }
  if (i % 3 === 1 && runA[i] > -1e8) liveA++; // count non-parked particles (sanity)
}
assert(identical, "determinism: two identical runs produced DIFFERENT particle buffers (RNG leak?)");
assert(liveA > 0, "determinism: the deterministic run simulated no live particles");

ops.op_log(
  `p12_vfx OK: vfx.create+play builds a THREE.Points and SIMULATES particles ` +
  `(explicit Euler — y=${(SPEED * DT).toFixed(2)} after frame 1, 1.2 after 3 frames); ` +
  `emitter caps at maxParticles with slot RECYCLING and fades to 0 on stop; ` +
  `vfx.atPosition spawns a real 12-particle burst that self-frees when drained; ` +
  `vfx.attach follows a moved entity (emitter 1,3,3 → 20,8,-5); vfx.destroy clears the scene; ` +
  `two identical runs are byte-identical (seeded jitter, no Math.random).`,
);
