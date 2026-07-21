// P65 — vegetation.plant places a SINGLE tree of a species at a point (the per-tree counterpart to
// vegetation.scatter). A real, agent-callable entity via the shared single-GLB path: it picks an
// archetype from the species palette deterministically from `seed`, pins the asset's content hash,
// spawns the entity at an explicit position (or the active terrain layer's origin by default), and
// is replay-identical. Byte-independent: it feeds the committed triangle.glb through a stub for any
// archetype id, so the gate never depends on the (gitignored, regenerable) tree bakes.

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
  if (!cond) throw new Error("p65_vegetation_plant: " + msg);
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

// Real committed GLB bytes for ANY archetype id — plant parses the mesh even headless (unlike
// scatter), so it needs parseable bytes, but the gate must stay independent of the regenerable tree
// GLBs. triangle.glb (committed) parses in the host and stands in for every archetype.
const triBytes = ops.op_read_asset("triangle.glb");
assert(triBytes.byteLength > 0, "triangle.glb must be readable");
const stubAssets = { resolve: (id: string) => ({ assetId: id, bytes: triBytes, hash: "sha256:stub-" + id }) } as never;

const perms = resolveProfile("builder.readWrite");
// Archetype ids now come from the caller/project, not a baked engine constant — the gate supplies an
// explicit `assets` palette per plant (the engine ships no tree-pack.json). Order fixes the seed→variant
// pick (seed 0 → first id, seed 1 → second), so the determinism/variant assertions are unchanged.
const SPRUCE_PALETTE = [{ id: "trees/spruce-1.glb" }, { id: "trees/spruce-2.glb" }];
const PINE_PALETTE = [{ id: "trees/pine-1.glb" }, { id: "trees/pine-2.glb" }];
const BIRCH_PALETTE = [{ id: "trees/birch-1.glb" }, { id: "trees/birch-2.glb" }];
const SPRUCE = new Set(SPRUCE_PALETTE.map((e) => e.id));
const PINE = new Set(PINE_PALETTE.map((e) => e.id));

async function session(name: string, opts: { noProjectPack?: boolean } = {}): Promise<{ registry: SkillRegistry; world: WorldContext; layers: Map<string, EditableTerrain>; tracer: LiminaTracer }> {
  const world = makeHeadlessWorld();
  if (opts.noProjectPack) {
    world.ops = new Proxy(ops, {
      get(target, property, receiver) {
        if (property === "op_read_asset") return () => { throw new Error("asset not found"); };
        const value = Reflect.get(target, property, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  }
  const layers = new Map<string, EditableTerrain>();
  const tracer = new LiminaTracer(name);
  const registry = new SkillRegistry(tracer);
  registerTerrainEditSkills(registry, layers);
  registerVegetationSkills(registry, layers, stubAssets);
  return { registry, world, layers, tracer };
}

const at = (world: WorldContext, name: string, t: number) => ({ agentId: "agt_p65", sessionId: name, permissions: perms, tick: t, world });

// 1. Plant a single spruce at an explicit position — a real entity, palette archetype, pinned hash.
{
  const { registry, world } = await session("ses_p65_a");
  const r = await registry.invoke("vegetation.plant", { species: "spruce", assets: SPRUCE_PALETTE, position: [5, 0, -7], seed: 1 }, at(world, "ses_p65_a", 1));
  assert(r.success, `vegetation.plant must succeed: ${JSON.stringify(r.error)}`);
  const res = r.result as { entity: string; assetId: string; assetHash: string };
  assert(typeof res.entity === "string" && res.entity.length > 0, "must return an entity handle");
  assert(SPRUCE.has(res.assetId), `spruce must pick a spruce archetype, got ${res.assetId}`);
  assert(res.assetHash === "sha256:stub-" + res.assetId, "must pin the resolved content hash");
  // A planted tree is auto-tagged "tree" + its species (agent-made entities aren't left untagged).
  const tags = world.tags.get(world.entities.resolve(res.entity)!.eid);
  assert(tags !== undefined && tags.has("tree") && tags.has("spruce"), `planted tree must be auto-tagged tree+species; got ${tags ? [...tags].join(",") : "none"}`);
}

// 1b. Custom tags merge with the auto tags.
{
  const { registry, world } = await session("ses_p65_tags");
  const r = await registry.invoke("vegetation.plant", { species: "pine", assets: PINE_PALETTE, position: [0, 0, 0], seed: 0, tags: ["landmark", "old-growth"] }, at(world, "ses_p65_tags", 1));
  assert(r.success, "plant with custom tags must succeed");
  const tags = world.tags.get(world.entities.resolve((r.result as { entity: string }).entity)!.eid);
  assert(tags !== undefined && tags.has("tree") && tags.has("pine") && tags.has("landmark") && tags.has("old-growth"), `custom tags must merge with tree+species; got ${tags ? [...tags].join(",") : "none"}`);
}

// 2. Species selects the right palette; seed selects the variant deterministically.
{
  const { registry, world } = await session("ses_p65_b");
  const pine = await registry.invoke("vegetation.plant", { species: "pine", assets: PINE_PALETTE, seed: 0 }, at(world, "ses_p65_b", 1));
  assert(pine.success && PINE.has((pine.result as { assetId: string }).assetId), "pine species must pick a pine archetype");
  const s0 = await registry.invoke("vegetation.plant", { species: "spruce", assets: SPRUCE_PALETTE, seed: 0 }, at(world, "ses_p65_b", 2));
  const s1 = await registry.invoke("vegetation.plant", { species: "spruce", assets: SPRUCE_PALETTE, seed: 1 }, at(world, "ses_p65_b", 3));
  const a0 = (s0.result as { assetId: string }).assetId, a1 = (s1.result as { assetId: string }).assetId;
  assert(a0 === "trees/spruce-1.glb" && a1 === "trees/spruce-2.glb", `seed must select variant (got ${a0}, ${a1})`);
}

// 3. Position defaults to the active terrain layer's origin when omitted.
{
  const { registry, world, tracer } = await session("ses_p65_c");
  const rc = await registry.invoke("terrain.create", { size: 100, resolution: 33, baseHeight: 12 }, at(world, "ses_p65_c", 1));
  assert(rc.success, "terrain.create must succeed");
  const rp = await registry.invoke("vegetation.plant", { species: "birch", assets: BIRCH_PALETTE, seed: 3 }, at(world, "ses_p65_c", 2));
  assert(rp.success, `plant on terrain must succeed: ${JSON.stringify(rp.error)}`);
  const planted = tracer.trace("agt_p65").filter((ev) => ev.type === "vegetation.planted");
  assert(planted.length === 1, `must emit exactly one vegetation.planted, got ${planted.length}`);
  const pos = (planted[0].payload as { position: [number, number, number] }).position;
  assert(pos[1] === 12, `default Y must be the terrain origin height (12), got ${pos[1]}`);
}

// 4. Determinism: same species + seed → same archetype across sessions.
{
  const s1 = await session("ses_p65_d1"); const s2 = await session("ses_p65_d2");
  const r1 = await s1.registry.invoke("vegetation.plant", { species: "spruce", assets: SPRUCE_PALETTE, seed: 7, position: [0, 0, 0] }, at(s1.world, "ses_p65_d1", 1));
  const r2 = await s2.registry.invoke("vegetation.plant", { species: "spruce", assets: SPRUCE_PALETTE, seed: 7, position: [0, 0, 0] }, at(s2.world, "ses_p65_d2", 1));
  assert((r1.result as { assetId: string }).assetId === (r2.result as { assetId: string }).assetId, "same seed must pick the same archetype");
}

// 5. Decoupling: with NO inline palette AND no project tree-pack.json (the engine ships none), the
// skill fails cleanly — it names no baked GLB and never silently succeeds.
{
  const { registry, world } = await session("ses_p65_e", { noProjectPack: true });
  const r = await registry.invoke("vegetation.plant", { species: "spruce", position: [0, 0, 0], seed: 1 }, at(world, "ses_p65_e", 1));
  assert(!r.success, "plant with no palette and no pack must fail (engine bakes no tree ids)");
}

ops.op_log("[js] p65_vegetation_plant OK: vegetation.plant places a single species tree (palette archetype chosen deterministically from seed, content hash pinned), at an explicit point or the active terrain layer's origin by default, replay-identical — the per-tree counterpart to vegetation.scatter.");
