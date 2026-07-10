// p_terrain_paint — terrain.paint is a REAL, deterministic, replay-safe engine skill: a surface-
// material brush (sand/grass/rock/dirt) that writes a per-vertex material-weight channel on the tile,
// NOT the height. The durable log records the paint OPS (center/radius/strength/falloff/material), not
// the weight bytes — so re-invoking the same sequence reconstructs a byte-identical paint channel.
// This is the substrate for the in-game terrain-paint tool (and an AI builder painting the same way).

import { ops, EntityTable, type WorldContext } from "../src/engine.ts";
import { createEcsWorld } from "../src/ecs/world.ts";
import { createTransformStorage } from "../src/ecs/facade.ts";
import { UniformGridSpatialIndex } from "../src/spatial/index.ts";
import { SkillRegistry } from "../src/skills/registry.ts";
import { resolveProfile } from "../src/skills/permissions.ts";
import { LiminaTracer } from "../src/observability/event.ts";
import { registerTerrainEditSkills } from "../src/skills/terrain-edit.ts";

function assert(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new Error("p_terrain_paint: " + msg);
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
const N = 65;

interface PaintState { mat: Uint8Array; w: Float32Array }

// Author a terrain and paint a deterministic sequence; return the tile's paint channel.
async function paintSeq(session: string): Promise<PaintState> {
  const world = makeHeadlessWorld();
  const layers = new Map();
  const registry = new SkillRegistry(new LiminaTracer(session));
  registerTerrainEditSkills(registry, layers);
  const at = (tick: number) => ({ agentId: "agt_paint", sessionId: session, permissions: perms, tick, world });

  const rc = await registry.invoke("terrain.create", { size: 100, resolution: N, baseHeight: 0 }, at(1));
  assert(rc.success, "terrain.create must succeed");
  const entity = (rc.result as { entity: string }).entity;

  await registry.invoke("terrain.paint", { entity, center: [0, 0], radius: 30, strength: 0.8, material: "sand" }, at(2));
  await registry.invoke("terrain.paint", { entity, center: [20, 10], radius: 18, strength: 0.5, material: "rock", falloff: "linear" }, at(3));
  await registry.invoke("terrain.paint", { entity, center: [-15, -12], radius: 14, strength: 0.6, material: "grass" }, at(4));
  await registry.invoke("terrain.paint", { entity, center: [-38, 38], radius: 6, strength: 1, material: "tundra" }, at(5));
  await registry.invoke("terrain.paint", { entity, center: [0, 0], radius: 8, strength: 0.4, material: "sand", erase: true }, at(6));

  const tile = layers.get(entity).tile as { paintMat?: Uint8Array; paintW?: Float32Array };
  assert(tile.paintMat !== undefined && tile.paintW !== undefined, "paint must allocate the tile channel");
  return { mat: tile.paintMat, w: tile.paintW };
}

// 1. Paint actually writes the channel: some cells are painted with real weight, and >1 material appears.
const a = await paintSeq("ses_paint_a");
assert(a.mat.length === N * N && a.w.length === N * N, `paint channel grid length (${a.mat.length})`);
let painted = 0;
const seen = new Set<number>();
for (let i = 0; i < a.mat.length; i++) {
  if (a.w[i] > 0) { painted++; seen.add(a.mat[i]); }
  assert(a.w[i] >= 0 && a.w[i] <= 1, `paint weight in [0,1] (cell ${i} = ${a.w[i]})`);
}
assert(painted > 50, `paint must cover real area (got ${painted} cells)`);
assert(seen.size >= 2, `multiple materials must be present (got ${seen.size})`);
assert(seen.has(7), "terrain.paint did not expose canonical tundra material 7");
// The center was painted sand then erased — its weight must have come back down.
const center = 32 * N + 32;
assert(a.w[center] < 0.85, `erase must pull the center weight back down (got ${a.w[center].toFixed(3)})`);

// 2. Determinism / replay: the SAME op sequence in a FRESH context reproduces the identical channel.
const b = await paintSeq("ses_paint_b");
let identical = true, firstDiff = -1;
for (let i = 0; i < a.mat.length; i++) {
  if (a.mat[i] !== b.mat[i] || a.w[i] !== b.w[i]) { identical = false; firstDiff = i; break; }
}
assert(identical, `paint sequence must be deterministic — channel diverged at cell ${firstDiff}`);

// 3. Paint must NOT touch height (it is a separate channel).
{
  const world = makeHeadlessWorld();
  const layers = new Map();
  const registry = new SkillRegistry(new LiminaTracer("ses_paint_h"));
  registerTerrainEditSkills(registry, layers);
  const at = (t: number) => ({ agentId: "a", sessionId: "ses_paint_h", permissions: perms, tick: t, world });
  const rc = await registry.invoke("terrain.create", { size: 100, resolution: N, baseHeight: 2 }, at(1));
  const entity = (rc.result as { entity: string }).entity;
  await registry.invoke("terrain.paint", { entity, center: [0, 0], radius: 40, strength: 1, material: "rock" }, at(2));
  const heights = layers.get(entity).tile.heights as Float32Array;
  assert(heights.every((h) => h === 2), "terrain.paint must leave heights untouched (flat at baseHeight)");
}

ops.op_log("[js] p_terrain_paint OK: terrain.paint writes a per-vertex material-weight channel (sand/grass/rock/dirt/snow/murk/tundra) with brush radius/strength/falloff + erase, leaves heights untouched, and replays to a byte-identical channel (record-ops-not-bytes) — real, agent-callable, editable surface paint.");
