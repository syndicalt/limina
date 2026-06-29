// Phase 15 (Track C — Complete) — THE ANIMATION-AUTHORING GATE.
//
// animation.authorClip / sampleClip let an agent CREATE animation data (not just play imported
// clips). This gate proves deterministic keyframe sampling: linear and step interpolation, scalar
// AND vector tracks, looping (wrap) vs non-looping (clamp), author-order independence (keys sorted),
// the unknown-clip case, and that two samples of the same (clip,t) are identical.
//
// Run: ./target/release/limina js/test/p15_clip_author.ts   (exit 0 = pass)

import { EntityTable, ops, type EngineOps } from "../src/engine.ts";
import { createEcsWorld } from "../src/ecs/world.ts";
import { createTransformStorage } from "../src/ecs/facade.ts";
import { UniformGridSpatialIndex } from "../src/spatial/index.ts";
import { LiminaTracer } from "../src/observability/event.ts";
import { SkillRegistry, type InvokeBase, type WorldContext } from "../src/skills/registry.ts";
import { registerCoreSkills } from "../src/skills/index.ts";
import { resolveProfile } from "../src/skills/permissions.ts";
import type { MCPResponse } from "../src/mcp/protocol.ts";

function assert(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new Error("p15_clip_author FAIL: " + msg);
}
function r(label: string, res: MCPResponse | undefined): Record<string, unknown> {
  if (res === undefined || !res.success) throw new Error(`p15_clip_author: ${label} failed: ${JSON.stringify(res?.error ?? "no response")}`);
  return (res.result ?? {}) as Record<string, unknown>;
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
const PERMS = resolveProfile("builder.readWrite");
const approx = (a: number, b: number) => Math.abs(a - b) < 1e-9;

ops.op_physics_create_world(-9.81);
const reg = new SkillRegistry(new LiminaTracer("ses_p15_clip"));
registerCoreSkills(reg);
const base: InvokeBase = { agentId: "agt", sessionId: "ses_p15_clip", permissions: PERMS, tick: 0, world: makeWorld(ops) };
const sampleAt = async (id: string, t: number) => r(`sample ${id}@${t}`, await reg.invoke("animation.sampleClip", { id, t }, base)) as { found: boolean; values?: Record<string, number | number[]> };

// ── 1. Linear scalar track (a door swinging 0→90 over 1s). ────────────────────────────────────
{
  const a = r("authorClip(door)", await reg.invoke("animation.authorClip", {
    id: "door", duration: 1, tracks: [{ property: "angle", interp: "linear", keys: [{ t: 0, value: 0 }, { t: 1, value: 90 }] }],
  }, base));
  assert(a.tracks === 1 && a.keys === 2, `door clip authored (1 track, 2 keys) — got ${a.tracks}/${a.keys}`);
  assert(approx((await sampleAt("door", 0)).values!.angle as number, 0), "angle 0 at t=0");
  assert(approx((await sampleAt("door", 0.5)).values!.angle as number, 45), "angle 45 at t=0.5 (linear)");
  assert(approx((await sampleAt("door", 1)).values!.angle as number, 90), "angle 90 at t=1");
  assert(approx((await sampleAt("door", 2)).values!.angle as number, 90), "non-looping clamps past the end (90 at t=2)");
  assert(approx((await sampleAt("door", -1)).values!.angle as number, 0), "non-looping clamps before the start (0 at t=-1)");
}

// ── 2. Step interpolation holds the previous key. ─────────────────────────────────────────────
{
  await reg.invoke("animation.authorClip", { id: "blink", duration: 1, tracks: [
    { property: "frame", interp: "step", keys: [{ t: 0, value: 0 }, { t: 0.5, value: 1 }, { t: 1, value: 2 }] },
  ] }, base);
  assert((await sampleAt("blink", 0.4)).values!.frame === 0, "step holds frame 0 before the 0.5 key");
  assert((await sampleAt("blink", 0.6)).values!.frame === 1, "step jumps to frame 1 after 0.5");
  assert((await sampleAt("blink", 0.99)).values!.frame === 1, "step holds frame 1 until the next key");
}

// ── 3. Vector track (a lift moving along a path), component-wise linear. ──────────────────────
{
  await reg.invoke("animation.authorClip", { id: "lift", duration: 1, tracks: [
    { property: "position", interp: "linear", keys: [{ t: 0, value: [0, 0, 0] }, { t: 1, value: [10, 4, -2] }] },
  ] }, base);
  const v = (await sampleAt("lift", 0.5)).values!.position as number[];
  assert(approx(v[0], 5) && approx(v[1], 2) && approx(v[2], -1), `vector lerp at t=0.5 → [5,2,-1] (got ${v})`);
}

// ── 4. Looping wraps time; author order doesn't matter (keys get sorted). ─────────────────────
{
  // Author the keys OUT OF ORDER on purpose; the sampler must sort them.
  await reg.invoke("animation.authorClip", { id: "pulse", duration: 1, loop: true, tracks: [
    { property: "level", interp: "linear", keys: [{ t: 1, value: 100 }, { t: 0, value: 0 }] },
  ] }, base);
  assert(approx((await sampleAt("pulse", 0.5)).values!.level as number, 50), "loop sample at 0.5 → 50");
  assert(approx((await sampleAt("pulse", 1.5)).values!.level as number, 50), "loop wraps: t=1.5 → effective 0.5 → 50");
  assert(approx((await sampleAt("pulse", 2.0)).values!.level as number, 0), "loop wraps: t=2.0 → effective 0 → 0");
}

// ── 5. Unknown clip + determinism. ────────────────────────────────────────────────────────────
{
  const u = await sampleAt("ghost", 0);
  assert(u.found === false, "sampling an unknown clip reports found:false");
  const x = (await sampleAt("door", 0.37)).values!.angle as number;
  const y = (await sampleAt("door", 0.37)).values!.angle as number;
  assert(Object.is(x, y), "same (clip,t) samples to the same value (deterministic)");
}

ops.op_log(
  "p15_clip_author OK: procedural animation authoring — author keyframe tracks and sample them deterministically; " +
  "linear + step interpolation; scalar AND vector tracks (component-wise); looping wraps time, non-looping clamps; " +
  "author key order doesn't matter (sorted); unknown clips report found:false; sampling is deterministic.",
);
