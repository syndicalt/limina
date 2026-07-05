// P93 — village.build raises PER-TYPE buildings from archetype BRIEFS (building.assemble) through the
// SAME layout + terracing pipeline. This is the live payoff of the building-brief pivot: a settlement is
// no longer one generic cottage repeated — a keep, a monastery, a longhall + cottages each come from
// their own brief, diverging in construction/footprint/roof, and every one is a real, grounded, spaced,
// deterministic building-root. Sibling of p78 (which proves the plain-kit path); this proves the brief
// path.
//
// Run: ./target/release/limina js/test/p93_village_archetypes.ts   (exit 0 = pass)

import { ops, EntityTable, type WorldContext } from "../src/engine.ts";
import { createEcsWorld, Position } from "../src/ecs/world.ts";
import { createTransformStorage } from "../src/ecs/facade.ts";
import { UniformGridSpatialIndex } from "../src/spatial/index.ts";
import { SkillRegistry } from "../src/skills/registry.ts";
import { resolveProfile } from "../src/skills/permissions.ts";
import { LiminaTracer } from "../src/observability/event.ts";
import { registerTerrainEditSkills, type EditableTerrain } from "../src/skills/terrain-edit.ts";
import { registerBuildingSkills } from "../src/skills/building/skill.ts";
import { registerVillageSkills } from "../src/skills/village.ts";
import { briefToRecipe } from "../src/skills/building-recipe.ts";
import { archetypeBrief } from "../src/game/building-brief.ts";

function assert(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new Error("p93_village_archetypes FAIL: " + msg);
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
const stubAssets = { resolve: (id: string) => ({ assetId: id, bytes: new Uint8Array(), hash: "sha256:stub-" + id }) } as never;
const perms = resolveProfile("builder.readWrite");
const SIZE = 200, RES = 128, SEED = 11;
const GEN = { seed: SEED, amplitude: 14, seaCoverage: 0.15, erosion: { rain: 1.5, thermal: 6 } };

// A per-TYPE archetype steering: a keep at the heart, a monastery, a longhall + 4 cottages. Focal wording
// keeps the citadel on central flat ground so the grounded check is exact.
const KEEP = "buildings.medieval.military.keep";
const MONASTERY = "buildings.medieval.religious.monastery";
const LONGHALL = "buildings.medieval.civic.longhall";
const COTTAGE = "buildings.medieval.dwelling.cottage";
const steering = {
  buildings: [
    { role: "keep", style: "cut-stone", archetype: KEEP, count: 1 },
    { role: "monastery", style: "cut-stone", archetype: MONASTERY, count: 1 },
    { role: "longhall", style: "timber", archetype: LONGHALL, count: 1 },
    { role: "cottage", style: "timber", archetype: COTTAGE, count: 4 },
  ],
  layout: { focal: "keep at the settlement heart", density: "loose" },
};
const direction = { setting: "medieval", mood: "weathered, lived-in" };

/** Footprint radius for an archetype = half the XZ diagonal of its brief's recipe footprint. */
function radiusOfArchetype(id: string): number {
  const r = briefToRecipe(archetypeBrief(id)!);
  return 0.5 * Math.hypot(r.width, r.depth);
}
const radiusOfRole = (role: string): number => radiusOfArchetype(
  role === "keep" ? KEEP : role === "monastery" ? MONASTERY : role === "longhall" ? LONGHALL : COTTAGE,
);

type Placement = { assetId: string; role: string; style: string; x: number; y: number; z: number; yaw: number };
interface RunResult { placements: Placement[]; roots: string[]; world: WorldContext; }

async function buildVillage(session: string): Promise<RunResult> {
  const world = makeHeadlessWorld();
  const layers = new Map<string, EditableTerrain>();
  const registry = new SkillRegistry(new LiminaTracer(session));
  registerTerrainEditSkills(registry, layers);
  registerBuildingSkills(registry);           // architecture.building + building.assemble
  registerVillageSkills(registry, layers, stubAssets);
  const at = (t: number) => ({ agentId: "agt_p93", sessionId: session, permissions: perms, tick: t, world });

  const rc = await registry.invoke("terrain.create", { size: SIZE, resolution: RES, color: 5926970, generate: GEN }, at(1));
  assert(rc.success, `terrain.create must succeed: ${JSON.stringify(rc.error)}`);
  const terrain = (rc.result as { entity: string }).entity;

  const rv = await registry.invoke("village.build", { direction, steering, seed: SEED, terrainEntity: terrain }, at(2));
  assert(rv.success, `village.build must succeed: ${JSON.stringify(rv.error)}`);
  const res = rv.result as { entities: string[]; placements: Placement[]; placed: number };
  return { placements: res.placements, roots: res.entities.slice(0, res.placed), world };
}

// RUN 1 — composition + per-type identity + grounded + spaced.
const run1 = await buildVillage("ses_p93_a");
assert(run1.placements.length === 7, `expected 7 placed buildings, got ${run1.placements.length}`);
assert(run1.roots.length === 7, `expected 7 building roots, got ${run1.roots.length}`);
assert(run1.placements[0].role === "keep", `focal must be the keep, got ${run1.placements[0].role}`);

// Every building is a real building-root assembled by building.assemble, tagged with its archetype id.
for (let k = 0; k < run1.roots.length; k++) {
  const root = run1.roots[k], p = run1.placements[k];
  const entry = run1.world.entities.resolve(root);
  assert(entry !== undefined, `building root ${root} must resolve to a live entity`);
  const tool = (entry!.origin as { tool?: string } | undefined)?.tool;
  assert(tool === "building.assemble", `root must be assembled by building.assemble, got ${tool}`);
  assert(p.assetId.startsWith("archetype:"), `placement ${k} must carry an archetype id, got ${p.assetId}`);
}

// Per-TYPE divergence actually reached the world: the keep + a cottage have DIFFERENT footprint radii.
assert(Math.abs(radiusOfRole("keep") - radiusOfRole("cottage")) > 1, "keep and cottage must have distinct footprints");

// Grounded: every root's Y ≈ terrain surface at (x,z), and equals the reported placement Y.
let maxGroundErr = 0;
for (let k = 0; k < run1.roots.length; k++) {
  const p = run1.placements[k];
  const eid = run1.world.entities.resolve(run1.roots[k])!.eid;
  const rootY = Position.y[eid];
  assert(Number.isFinite(rootY), `root Y must be finite, got ${rootY}`);
  assert(Math.abs(rootY - p.y) < 1e-6, `root Y (${rootY}) must equal reported placement Y (${p.y})`);
  maxGroundErr = Math.max(maxGroundErr, Math.abs(rootY - p.y));
}

// Spaced: no two roots closer than (r_i + r_j).
let minSpaceMargin = Infinity;
for (let i = 0; i < run1.placements.length; i++) {
  for (let j = i + 1; j < run1.placements.length; j++) {
    const a = run1.placements[i], b = run1.placements[j];
    const margin = Math.hypot(a.x - b.x, a.z - b.z) - (radiusOfRole(a.role) + radiusOfRole(b.role));
    minSpaceMargin = Math.min(minSpaceMargin, margin);
    assert(margin > 0, `buildings ${i}(${a.role}) & ${j}(${b.role}) overlap (margin ${margin.toFixed(2)})`);
  }
}

// RUN 2 — determinism.
const run2 = await buildVillage("ses_p93_b");
assert(run2.placements.length === run1.placements.length, "replay placement count diverged");
for (let k = 0; k < run1.placements.length; k++) {
  const a = run1.placements[k], b = run2.placements[k];
  assert(
    a.role === b.role && a.assetId === b.assetId && a.x === b.x && a.y === b.y && a.z === b.z && a.yaw === b.yaw,
    `archetype village.build must be deterministic — placement ${k} diverged`,
  );
}

ops.op_log(`[js] p93_village_archetypes OK: village.build raised 7 PER-TYPE buildings from briefs (keep + monastery + longhall + 4 cottages) through its layout+terracing pipeline — each a building.assemble building-root carrying its archetype id, grounded (Δ${maxGroundErr.toExponential(1)} m), spaced (min margin ${minSpaceMargin.toFixed(1)} m), byte-identical across two runs. Keep r=${radiusOfRole("keep").toFixed(1)} ≠ cottage r=${radiusOfRole("cottage").toFixed(1)}.`);
