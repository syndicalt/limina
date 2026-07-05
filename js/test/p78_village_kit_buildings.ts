// P78 — village.build raises KIT half-timber buildings (via architecture.building) for cottage/house
// roles THROUGH its existing layout + terracing pipeline, alongside GLB landmarks. This gate proves the
// kit path is a first-class, deterministic, terrain-grounded citizen of the same planner:
//
//   1. COMPOSITION — a kit steering (focal + 6 kit cottages) lays out + places every building; each kit
//      building exists as a real building-root entity (origin.tool === "building.assemble").
//   2. GROUNDED — every kit root sits on its terraced pad: its entity Y ≈ the terrain surface height at
//      its (x,z) (within ~0.3 m), so nothing floats or buries. Checked against an INDEPENDENT sampler
//      regenerated from the same deterministic heightfield config.
//   3. SPACED — no two building roots are closer than (r_i + r_j) (the footprint radii planVillage laid
//      them out with — kit radius = half the XZ diagonal of width×depth).
//   4. DETERMINISTIC — two independent runs (fresh worlds/terrain) yield byte-identical placements, so
//      the kit path is a pure function of (terrain, steering, seed) exactly like the GLB path.
//
// Run: ./target/release/limina js/test/p78_village_kit_buildings.ts   (exit 0 = pass)

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
import { generateHeightfield } from "../src/world/pipeline/terrain-heightfield.mjs";

function assert(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new Error("p78_village_kit_buildings FAIL: " + msg);
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

// Kit buildings never touch the AssetRegistry (no GLB), so a stub keeps this gate independent of the
// (gitignored, regenerable) library GLBs — the same discipline p64 uses.
const stubAssets = { resolve: (id: string) => ({ assetId: id, bytes: new Uint8Array(), hash: "sha256:stub-" + id }) } as never;

const perms = resolveProfile("builder.readWrite");
const SIZE = 120, RES = 128, SEED = 6;
const GEN = { seed: SEED, amplitude: 16, seaCoverage: 0.2, erosion: { rain: 1.5, thermal: 6 } };

// A kit-ONLY steering: a focal hall + 6 kit cottages. Focal wording is deliberately NOT "high/knoll" so
// the focal seats on central flat ground (its terrace target is never snow-capped), keeping the grounded
// check exact for every building.
const HALL: [number, number, number] = [10, 8, 4];
const COTTAGE: [number, number, number] = [7.5, 6, 3.6];
const steering = {
  buildings: [
    { role: "hall", style: "half-timber", kit: true, sizeM: HALL, count: 1 },
    { role: "cottage", style: "half-timber", kit: true, sizeM: COTTAGE, count: 6 },
  ],
  layout: { focal: "hall at the settlement heart", density: "loose" },
};
const direction = { setting: "medieval", mood: "weathered, lived-in" };
const kitRadius = (s: [number, number, number]): number => 0.5 * Math.hypot(s[0], s[1]);
const radiusOfRole = (role: string): number => (role === "hall" ? kitRadius(HALL) : kitRadius(COTTAGE));

type Placement = { assetId: string; role: string; style: string; x: number; y: number; z: number; yaw: number };
interface RunResult { placements: Placement[]; roots: string[]; world: WorldContext; }

async function buildVillage(session: string): Promise<RunResult> {
  const world = makeHeadlessWorld();
  const layers = new Map<string, EditableTerrain>();
  const registry = new SkillRegistry(new LiminaTracer(session));
  registerTerrainEditSkills(registry, layers);
  registerBuildingSkills(registry);          // architecture.building — the kit backer
  registerVillageSkills(registry, layers, stubAssets);
  const at = (t: number) => ({ agentId: "agt_p78", sessionId: session, permissions: perms, tick: t, world });

  const rc = await registry.invoke("terrain.create", { size: SIZE, resolution: RES, color: 5926970, generate: GEN }, at(1));
  assert(rc.success, `terrain.create must succeed: ${JSON.stringify(rc.error)}`);
  const terrain = (rc.result as { entity: string }).entity;

  const rv = await registry.invoke("village.build", { direction, steering, seed: SEED, terrainEntity: terrain }, at(2));
  assert(rv.success, `village.build must succeed: ${JSON.stringify(rv.error)}`);
  const res = rv.result as { entities: string[]; placements: Placement[]; placed: number };
  // village.build appends the ground-geometry entities to `entities`; the building roots are the first
  // `placed` entries (one per placement, in placement order).
  const roots = res.entities.slice(0, res.placed);
  return { placements: res.placements, roots, world };
}

// ── An INDEPENDENT terrain height sampler over the SAME deterministic heightfield config terrain.create
//    used (pre-terrace surface). Mapping matches village.build / terrain-edit exactly (origin [0,0,0],
//    scale [SIZE,1,SIZE], RES×RES grid). ──────────────────────────────────────────────────────────────
function makeSurfaceSampler(): (x: number, z: number) => number {
  const gh = generateHeightfield({ ...GEN, sizeM: SIZE, gridN: RES - 1 }) as { heights: Float32Array };
  const heights = gh.heights;
  const n = RES, nr = RES;
  const x0 = -SIZE / 2, z0 = -SIZE / 2;
  const dxStep = SIZE / (n - 1), dzStep = SIZE / (nr - 1);
  const clamp = (v: number, a: number, b: number): number => Math.min(b, Math.max(a, v));
  return (x: number, z: number): number => {
    const fc = clamp((x - x0) / dxStep, 0, n - 1);
    const fr = clamp((z - z0) / dzStep, 0, nr - 1);
    const c0 = Math.floor(fc), r0 = Math.floor(fr);
    const c1 = Math.min(n - 1, c0 + 1), r1 = Math.min(nr - 1, r0 + 1);
    const tx = fc - c0, tz = fr - r0;
    const h = (r: number, c: number): number => heights[r * n + c];
    const a = h(r0, c0) + (h(r0, c1) - h(r0, c0)) * tx;
    const b = h(r1, c0) + (h(r1, c1) - h(r1, c0)) * tx;
    return a + (b - a) * tz;
  };
}

// ════════════════════════════════════════════════════════════════════════════════════════════════
// RUN 1 — composition + grounded + spaced.
// ════════════════════════════════════════════════════════════════════════════════════════════════
const run1 = await buildVillage("ses_p78_a");
assert(run1.placements.length === 7, `expected 7 placed buildings (1 hall + 6 cottages), got ${run1.placements.length}`);
assert(run1.roots.length === 7, `expected 7 building roots, got ${run1.roots.length}`);
assert(run1.placements[0].role === "hall", `focal (placements[0]) must be the hall, got ${run1.placements[0].role}`);

// 1. Every kit building exists as a real building-root entity assembled by the kit assembler.
for (const root of run1.roots) {
  const entry = run1.world.entities.resolve(root);
  assert(entry !== undefined, `kit building root ${root} must resolve to a live entity`);
  const tool = (entry!.origin as { tool?: string } | undefined)?.tool;
  assert(tool === "building.assemble", `kit building root must be assembled by the kit (origin.tool=building.assemble), got ${tool}`);
}

// 2. Grounded: every kit root's ECS Y ≈ the terrain surface height at its (x,z), within ~0.3 m.
const surface = makeSurfaceSampler();
let maxGroundErr = 0;
for (let k = 0; k < run1.roots.length; k++) {
  const p = run1.placements[k];
  const eid = run1.world.entities.resolve(run1.roots[k])!.eid;
  const rootY = Position.y[eid];
  assert(Number.isFinite(rootY), `kit root Y must be finite, got ${rootY}`);
  const err = Math.abs(rootY - surface(p.x, p.z));
  maxGroundErr = Math.max(maxGroundErr, err);
  assert(err < 0.3, `kit building '${p.role}' at (${p.x.toFixed(1)},${p.z.toFixed(1)}) is not grounded: rootY=${rootY.toFixed(2)} vs surface=${surface(p.x, p.z).toFixed(2)} (Δ${err.toFixed(2)} m)`);
  // And the entity Y must equal the placement Y village.build reported (spawn honored position.y).
  assert(Math.abs(rootY - p.y) < 1e-6, `kit root Y (${rootY}) must equal the reported placement Y (${p.y})`);
}

// 3. Spaced: no two building roots are closer than (r_i + r_j).
let minSpaceMargin = Infinity;
for (let i = 0; i < run1.placements.length; i++) {
  for (let j = i + 1; j < run1.placements.length; j++) {
    const a = run1.placements[i], b = run1.placements[j];
    const d = Math.hypot(a.x - b.x, a.z - b.z);
    const margin = d - (radiusOfRole(a.role) + radiusOfRole(b.role));
    minSpaceMargin = Math.min(minSpaceMargin, margin);
    assert(margin > 0, `buildings ${i}(${a.role}) & ${j}(${b.role}) overlap: gap ${d.toFixed(2)} < r_i+r_j ${(radiusOfRole(a.role) + radiusOfRole(b.role)).toFixed(2)}`);
  }
}

// ════════════════════════════════════════════════════════════════════════════════════════════════
// RUN 2 — determinism: an independent run yields byte-identical placements.
// ════════════════════════════════════════════════════════════════════════════════════════════════
const run2 = await buildVillage("ses_p78_b");
assert(run2.placements.length === run1.placements.length, "replay placement count diverged");
for (let k = 0; k < run1.placements.length; k++) {
  const a = run1.placements[k], b = run2.placements[k];
  assert(
    a.role === b.role && a.style === b.style && a.assetId === b.assetId && a.x === b.x && a.y === b.y && a.z === b.z && a.yaw === b.yaw,
    `kit village.build must be deterministic — placement ${k} diverged (${JSON.stringify(a)} vs ${JSON.stringify(b)})`,
  );
}

ops.op_log(`[js] p78_village_kit_buildings OK: village.build raised 7 KIT half-timber buildings (1 hall + 6 cottages) through its layout+terracing pipeline — every building is a real building-root, grounded on its terraced pad (max Δ${maxGroundErr.toFixed(3)} m), spaced (min margin ${minSpaceMargin.toFixed(1)} m > 0), and byte-identical across two independent runs.`);
