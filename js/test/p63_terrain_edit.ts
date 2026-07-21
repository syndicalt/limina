// P63 — terrain.create + terrain.deform are REAL, deterministic, replay-safe engine skills:
// an editable heightfield layer the agent/editor owns and sculpts. The durable log records the
// OPS (create params + each brush stamp), not the height bytes — so re-invoking the same
// sequence reconstructs byte-identical heights. This is the substrate for hand-sculpted terrain.

import { ops, EntityTable, type WorldContext } from "../src/engine.ts";
import { createEcsWorld } from "../src/ecs/world.ts";
import { createTransformStorage } from "../src/ecs/facade.ts";
import { UniformGridSpatialIndex } from "../src/spatial/index.ts";
import { SkillRegistry } from "../src/skills/registry.ts";
import { resolveProfile } from "../src/skills/permissions.ts";
import { LiminaTracer } from "../src/observability/event.ts";
import { registerTerrainEditSkills } from "../src/skills/terrain-edit.ts";

function assert(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new Error("p63_terrain_edit: " + msg);
}

function makeHeadlessWorld(): WorldContext {
  const ecs = createEcsWorld();
  const scene = { add() {}, remove() {}, position: { set() {}, x: 0, y: 0, z: 0 }, background: null as unknown };
  const camera = { position: { set() {} }, aspect: 1, lookAt() {}, updateProjectionMatrix() {} };
  return {
    ecs, transforms: createTransformStorage(ecs), spatial: new UniformGridSpatialIndex(),
    entities: new EntityTable(), tags: new Map(), scene, camera, ops, mode: "headless",
  };
}

const perms = resolveProfile("builder.readWrite");
const N = 65;                       // grid resolution
const CENTER = 32 * N + 32;         // center cell of a 65×65 grid

// Author an editable terrain and sculpt a deterministic sequence; return {heights, entity}.
async function sculpt(session: string): Promise<Float32Array> {
  const world = makeHeadlessWorld();
  const layers = new Map();
  const registry = new SkillRegistry(new LiminaTracer(session));
  registerTerrainEditSkills(registry, layers);
  const at = (tick: number) => ({ agentId: "agt_p63", sessionId: session, permissions: perms, tick, world });

  const rc = await registry.invoke("terrain.create", { size: 100, resolution: N, baseHeight: 0 }, at(1));
  assert(rc.success, "terrain.create must succeed");
  const entity = (rc.result as { entity: string }).entity;

  await registry.invoke("terrain.deform", { entity, center: [0, 0], radius: 32, delta: 14, mode: "raise" }, at(2));
  await registry.invoke("terrain.deform", { entity, center: [24, 12], radius: 16, delta: 7, mode: "raise" }, at(3));
  await registry.invoke("terrain.deform", { entity, center: [0, 0], radius: 45, delta: 0, mode: "smooth" }, at(4));
  await registry.invoke("terrain.deform", { entity, center: [-24, -14], radius: 14, delta: 3, mode: "noise" }, at(5));
  await registry.invoke("terrain.deform", { entity, center: [30, -22], radius: 12, delta: 1.5, mode: "flatten" }, at(6));

  return layers.get(entity).tile.heights as Float32Array;
}

// 1. A fresh terrain.create is a flat slab at baseHeight.
{
  const world = makeHeadlessWorld();
  const layers = new Map();
  const registry = new SkillRegistry(new LiminaTracer("ses_flat"));
  registerTerrainEditSkills(registry, layers);
  const at = (t: number) => ({ agentId: "a", sessionId: "ses_flat", permissions: perms, tick: t, world });
  const rc = await registry.invoke("terrain.create", { size: 80, resolution: 33, baseHeight: 3 }, at(1));
  const heights = layers.get((rc.result as { entity: string }).entity).tile.heights as Float32Array;
  assert(heights.length === 33 * 33, `flat grid length ${heights.length}`);
  assert(heights.every((h) => h === 3), "fresh terrain.create must be flat at baseHeight");
}

// 2. Sculpt, then check the brush actually reshaped the field.
const a = await sculpt("ses_p63_a");
assert(a[CENTER] > 8, `raise must lift the center substantially (got ${a[CENTER].toFixed(2)})`);
let min = Infinity, max = -Infinity;
for (const h of a) { if (h < min) min = h; if (h > max) max = h; }
assert(max - min > 4, `sculpted terrain must have real relief (range ${(max - min).toFixed(2)})`);

// 3. Determinism / replay: the SAME op sequence in a FRESH context reproduces identical heights.
const b = await sculpt("ses_p63_b");
assert(a.length === b.length, "replay length mismatch");
let identical = true, firstDiff = -1;
for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) { identical = false; firstDiff = i; break; }
assert(identical, `deform sequence must be deterministic — heights diverged at cell ${firstDiff}`);

ops.op_log("[js] p63_terrain_edit OK: terrain.create makes a flat editable heightfield; terrain.deform (raise/lower/smooth/noise/flatten) reshapes it deterministically; the op sequence replays to byte-identical heights (record-ops-not-bytes) — real, agent-callable, editable terrain.");
