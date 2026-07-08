// P64 — vegetation.scatter is a REAL, deterministic, replay-safe skill: it scatters a forest of
// tree archetypes across an EDITABLE terrain layer, gated by slope + elevation (tree line), and
// records the config (not the transforms) so replay recomputes byte-identical placements. It reads
// the same live terrain-layer map terrain.create/deform own, so trees land on the sculpted ground.

import { ops, EntityTable, type WorldContext } from "../src/engine.ts";
import { createEcsWorld } from "../src/ecs/world.ts";
import { createTransformStorage } from "../src/ecs/facade.ts";
import { UniformGridSpatialIndex } from "../src/spatial/index.ts";
import { SkillRegistry } from "../src/skills/registry.ts";
import { resolveProfile } from "../src/skills/permissions.ts";
import { LiminaTracer } from "../src/observability/event.ts";
import { registerTerrainEditSkills, type EditableTerrain } from "../src/skills/terrain-edit.ts";
import { registerVegetationSkills } from "../src/skills/vegetation.ts";

function assert(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new Error("p64_vegetation_scatter: " + msg);
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

// Stub asset registry — the scatter LOGIC (placements) never loads GLB bytes; only hash pinning
// touches the registry, and in headless mode no mesh is mounted. So a deterministic stub hash keeps
// the gate independent of the (gitignored, regenerable) archetype GLBs.
const stubAssets = { resolve: (id: string) => ({ assetId: id, bytes: new Uint8Array(), hash: "sha256:stub-" + id }) } as never;

const perms = resolveProfile("builder.readWrite");
const N = 65;

async function buildForest(session: string): Promise<{ placements: Array<{ assetId: string; x: number; y: number; z: number; scale: number }>; count: number }> {
  const world = makeHeadlessWorld();
  const layers = new Map<string, EditableTerrain>();
  const registry = new SkillRegistry(new LiminaTracer(session));
  registerTerrainEditSkills(registry, layers);
  registerVegetationSkills(registry, layers, stubAssets);
  const at = (t: number) => ({ agentId: "agt_p64", sessionId: session, permissions: perms, tick: t, world });

  const rc = await registry.invoke("terrain.create", { size: 200, resolution: N, baseHeight: 0 }, at(1));
  const terrain = (rc.result as { entity: string }).entity;
  // Sculpt a hill so there's real relief + slope for the gates to bite on.
  await registry.invoke("terrain.deform", { entity: terrain, center: [0, 0], radius: 70, delta: 30, mode: "raise" }, at(2));

  // Archetype ids now come from the caller/project, not a baked engine constant — the gate supplies
  // an explicit `assets` palette (the engine ships no tree-pack.json). Ordered to match the historical
  // species flatten so placements stay byte-identical to the recorded expectation.
  const rv = await registry.invoke("vegetation.scatter", {
    terrain, species: ["spruce", "pine", "birch"], density: 24, seed: 4242,
    assets: [
      { id: "trees/spruce-1.glb" }, { id: "trees/spruce-2.glb" },
      { id: "trees/pine-1.glb" }, { id: "trees/pine-2.glb" },
      { id: "trees/birch-1.glb" }, { id: "trees/birch-2.glb" },
    ],
    elevationMax: 20, slopeMax: 0.6, coverage: 0.9,
  }, at(3));
  assert(rv.success, `vegetation.scatter must succeed: ${JSON.stringify(rv.error)}`);
  const res = rv.result as { instances: number; placements: Array<{ assetId: string; x: number; y: number; z: number; scale: number }> };
  return { placements: res.placements, count: res.instances };
}

const PALETTE = new Set(["trees/spruce-1.glb", "trees/spruce-2.glb", "trees/pine-1.glb", "trees/pine-2.glb", "trees/birch-1.glb", "trees/birch-2.glb"]);

// 1. Scatter produces a real forest.
const a = await buildForest("ses_p64_a");
assert(a.count > 50, `expected a populated forest, got ${a.count} instances`);
assert(a.placements.length === a.count, "instances count must match placements");

// 2. Every placement is a palette archetype, above the water floor, and BELOW the tree line (elevationMax=20).
for (const p of a.placements) {
  assert(PALETTE.has(p.assetId), `placement uses an unknown archetype: ${p.assetId}`);
  assert(p.y <= 20 + 1e-3, `placement above the tree line (y=${p.y.toFixed(2)} > 20)`);
  assert(p.scale > 0, "placement scale must be positive");
}

// 3. Determinism / replay: same terrain ops + same scatter config → byte-identical placements.
const b = await buildForest("ses_p64_b");
assert(a.count === b.count, `replay instance count diverged (${a.count} vs ${b.count})`);
let identical = true, firstDiff = -1;
for (let i = 0; i < a.placements.length; i++) {
  const pa = a.placements[i], pb = b.placements[i];
  if (pa.assetId !== pb.assetId || pa.x !== pb.x || pa.y !== pb.y || pa.z !== pb.z || pa.scale !== pb.scale) { identical = false; firstDiff = i; break; }
}
assert(identical, `scatter must be deterministic — placement ${firstDiff} diverged on replay`);

ops.op_log(`[js] p64_vegetation_scatter OK: vegetation.scatter placed ${a.count} trees on the sculpted terrain (palette-only, under the tree line, gated by slope), deterministic + replay-identical — real, agent-callable forest scatter on editable terrain.`);
