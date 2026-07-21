// p_village_anchors — village.build HONORS authored placement anchors (map-driven-worlds Phase 1.2).
//
// THE RULE (locked): an anchor PINS WHERE a building goes; the shared layout solver (planVillage)
// still decides HOW (facing, terrace order, cluster spread). A steering.anchors entry binds to a
// buildingSpec by `assetId` (exact) else `role` (first UNCLAIMED occurrence, in steering.buildings
// order); `count > 1` on an anchor clusters that many instances tightly around it (6-14 m spread,
// mutually non-overlapping via footprint radii, <=16 m search radius). A lone pin searches <=8 m for
// the nearest buildable spot. No buildable site within that radius -> the build FAILS LOUDLY, naming
// the anchor id (never a silent relocation).
//
// This gate proves, over a REAL procedurally-generated terrain (terrain.create + generate, the same
// eroded heightfield the live pipeline uses — NOT a map-compiled source, which is another agent's
// scope):
//   1. ANCHORED — a civic building and a watchtower, each pinned by role, land within 8 m of their
//      authored anchor positions, and carry that anchor's id on their returned placement.
//   2. UNANCHORED-STILL-FLOWS + CLUSTER — a 4-cottage spec with a 3-member cluster anchor: all 4
//      cottages are placed (count preserved), the 3 anchored ones cluster near the anchor and the 1
//      remaining cottage is sited by the ordinary map-wide solver; nothing overlaps (anchored or not).
//   3. DETERMINISTIC — the same steering run twice yields byte-identical placements (roles, positions,
//      yaws, anchor bindings all agree).
//   4. FAILS LOUDLY — an anchor pinned into deep water (no buildable land within its search radius, at
//      this seed/coverage) makes village.build fail, naming the offending anchor id.
//
// Run: ./target/release/limina js/test/p_village_anchors.ts   (exit 0 = pass)

import { ops, EntityTable, type WorldContext } from "../src/engine.ts";
import { createEcsWorld } from "../src/ecs/world.ts";
import { createTransformStorage } from "../src/ecs/facade.ts";
import { UniformGridSpatialIndex } from "../src/spatial/index.ts";
import { SkillRegistry } from "../src/skills/registry.ts";
import { resolveProfile } from "../src/skills/permissions.ts";
import { LiminaTracer } from "../src/observability/event.ts";
import { registerTerrainEditSkills, type EditableTerrain } from "../src/skills/terrain-edit.ts";
import { registerBuildingSkills } from "../src/skills/building/skill.ts";
import { registerVillageSkills } from "../src/skills/village.ts";

function assert(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new Error("p_village_anchors FAIL: " + msg);
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
// (gitignored, regenerable) curated GLB library — the same discipline p78/p93 use.
const stubAssets = { resolve: (id: string) => ({ assetId: id, bytes: new Uint8Array(), hash: "sha256:stub-" + id }) } as never;

const perms = resolveProfile("builder.readWrite");
// A REAL eroded procedural heightfield (terrain.create + generate), NOT a compiled map source —
// map-raster / the map compiler are another agent's scope; this gate only proves village.build's
// anchor-honoring against ordinary generated terrain.
const SIZE = 200, RES = 129, SEED = 11;
const GEN = { seed: SEED, amplitude: 12, seaCoverage: 0.06 };

const CIVIC: [number, number, number] = [9, 8, 4];
const TOWER: [number, number, number] = [5, 5, 9];
const COTTAGE: [number, number, number] = [7, 6, 3.4];
const kitRadius = (s: [number, number, number]): number => 0.5 * Math.hypot(s[0], s[1]);
const radiusOfRole = (role: string): number =>
  role === "civic" ? kitRadius(CIVIC) : role === "watchtower" ? kitRadius(TOWER) : kitRadius(COTTAGE);

// Anchor positions: a civic hall + a watchtower each pinned individually, and a 3-member cottage
// cluster — leaving the cottage spec's 4th instance to flow through the ordinary map-wide solver.
const ANCHOR_CIVIC: [number, number] = [-9, 3];
const ANCHOR_TOWER: [number, number] = [30, 12];
const ANCHOR_COTTAGE_ROW: [number, number] = [50, -20];

const steering = {
  buildings: [
    { role: "civic", style: "half-timber", kit: true, sizeM: CIVIC, count: 1 },
    { role: "watchtower", style: "cut-stone", kit: true, sizeM: TOWER, count: 1 },
    { role: "cottage", style: "half-timber", kit: true, sizeM: COTTAGE, count: 4 },
  ],
  layout: { focal: "civic hall at the settlement heart", density: "loose" },
  anchors: [
    { id: "anchor-civic-hall", position: ANCHOR_CIVIC, role: "civic" },
    { id: "anchor-watchtower", position: ANCHOR_TOWER, role: "watchtower" },
    { id: "anchor-cottage-row", position: ANCHOR_COTTAGE_ROW, role: "cottage", count: 3 },
  ],
};
const direction = { setting: "medieval", mood: "weathered, lived-in" };

type Placement = { assetId: string; role: string; style: string; x: number; y: number; z: number; yaw: number; anchorId?: string };
interface RunResult { placements: Placement[]; roots: string[]; placed: number; }

async function buildVillage(session: string): Promise<RunResult> {
  const world = makeHeadlessWorld();
  const layers = new Map<string, EditableTerrain>();
  const registry = new SkillRegistry(new LiminaTracer(session));
  registerTerrainEditSkills(registry, layers);
  registerBuildingSkills(registry);           // architecture.building — the kit backer
  registerVillageSkills(registry, layers, stubAssets);
  const at = (t: number) => ({ agentId: "agt_pva", sessionId: session, permissions: perms, tick: t, world });

  const rc = await registry.invoke("terrain.create", { size: SIZE, resolution: RES, generate: GEN }, at(1));
  assert(rc.success, `terrain.create must succeed: ${JSON.stringify(rc.error)}`);
  const terrain = (rc.result as { entity: string }).entity;

  const rv = await registry.invoke("village.build", { direction, steering, seed: SEED, terrainEntity: terrain }, at(2));
  assert(rv.success, `village.build must succeed: ${JSON.stringify(rv.error)}`);
  const res = rv.result as { entities: string[]; placements: Placement[]; placed: number };
  return { placements: res.placements, roots: res.entities.slice(0, res.placed), placed: res.placed };
}

// ════════════════════════════════════════════════════════════════════════════════════════════════
// RUN 1 — composition + anchored + cluster + unanchored-still-flows + no overlap.
// ════════════════════════════════════════════════════════════════════════════════════════════════
const run1 = await buildVillage("ses_pva_a");
assert(run1.placements.length === 6, `expected 6 placed buildings (civic+watchtower+4 cottages), got ${run1.placements.length}`);
assert(run1.placements[0].role === "civic", `focal (placements[0]) must be the civic hall, got ${run1.placements[0].role}`);

// 1a. ANCHORED singles: the civic hall + the watchtower each land within 8 m of their anchor, and
//     carry that anchor's id on the returned placement.
const civic = run1.placements.find((p) => p.role === "civic")!;
assert(civic !== undefined, "civic placement must exist");
const civicDist = Math.hypot(civic.x - ANCHOR_CIVIC[0], civic.z - ANCHOR_CIVIC[1]);
assert(civicDist <= 8 + 1e-6, `civic hall must land within 8 m of its anchor (got ${civicDist.toFixed(2)} m)`);
assert(civic.anchorId === "anchor-civic-hall", `civic placement must carry its anchor id, got ${civic.anchorId}`);

const tower = run1.placements.find((p) => p.role === "watchtower")!;
assert(tower !== undefined, "watchtower placement must exist");
const towerDist = Math.hypot(tower.x - ANCHOR_TOWER[0], tower.z - ANCHOR_TOWER[1]);
assert(towerDist <= 8 + 1e-6, `watchtower must land within 8 m of its anchor (got ${towerDist.toFixed(2)} m)`);
assert(tower.anchorId === "anchor-watchtower", `watchtower placement must carry its anchor id, got ${tower.anchorId}`);

// 1b. UNANCHORED-STILL-FLOWS + CLUSTER: all 4 cottages placed; exactly 3 carry the cluster anchor id
//     (each within 16 m of it, biased 6-14 m out) and exactly 1 has no anchorId (the ordinary solver
//     sited it, exactly as an unanchored steering would).
const cottages = run1.placements.filter((p) => p.role === "cottage");
assert(cottages.length === 4, `expected all 4 cottages placed (count preserved), got ${cottages.length}`);
const anchoredCottages = cottages.filter((p) => p.anchorId === "anchor-cottage-row");
const freeCottages = cottages.filter((p) => p.anchorId === undefined);
assert(anchoredCottages.length === 3, `expected 3 cottages clustered at the anchor, got ${anchoredCottages.length}`);
assert(freeCottages.length === 1, `expected 1 cottage left to the ordinary solver, got ${freeCottages.length}`);
for (const c of anchoredCottages) {
  const d = Math.hypot(c.x - ANCHOR_COTTAGE_ROW[0], c.z - ANCHOR_COTTAGE_ROW[1]);
  assert(d <= 16 + 1e-6, `clustered cottage must land within 16 m of its anchor (got ${d.toFixed(2)} m)`);
}

// 1c. NO OVERLAP: every pair of placements (anchored or not) clears the sum of their footprint radii —
//     the map-wide solver was fed the anchored footprints as occupied, and cluster members are
//     mutually spaced by the same discipline.
let minMargin = Infinity;
for (let i = 0; i < run1.placements.length; i++) {
  for (let j = i + 1; j < run1.placements.length; j++) {
    const a = run1.placements[i], b = run1.placements[j];
    const d = Math.hypot(a.x - b.x, a.z - b.z);
    const need = radiusOfRole(a.role) + radiusOfRole(b.role);
    minMargin = Math.min(minMargin, d - need);
    assert(d > need, `placements ${i}(${a.role}${a.anchorId ? "@" + a.anchorId : ""}) & ${j}(${b.role}${b.anchorId ? "@" + b.anchorId : ""}) overlap: gap ${d.toFixed(2)} < ${need.toFixed(2)}`);
  }
}

// ════════════════════════════════════════════════════════════════════════════════════════════════
// RUN 2 — determinism: an independent run yields byte-identical placements.
// ════════════════════════════════════════════════════════════════════════════════════════════════
const run2 = await buildVillage("ses_pva_b");
assert(run2.placements.length === run1.placements.length, "replay placement count diverged");
for (let k = 0; k < run1.placements.length; k++) {
  const a = run1.placements[k], b = run2.placements[k];
  assert(
    a.role === b.role && a.style === b.style && a.assetId === b.assetId &&
    a.x === b.x && a.y === b.y && a.z === b.z && a.yaw === b.yaw && a.anchorId === b.anchorId,
    `village.build with anchors must be deterministic — placement ${k} diverged (${JSON.stringify(a)} vs ${JSON.stringify(b)})`,
  );
}

// ════════════════════════════════════════════════════════════════════════════════════════════════
// RUN 3 — an anchor pinned into deep water FAILS LOUDLY, naming the anchor id (never silently
// relocated onto different ground). [5, 95] is genuinely underwater at this seed/coverage, with no
// buildable land anywhere inside a 16 m radius (verified against the same generated heightfield).
// ════════════════════════════════════════════════════════════════════════════════════════════════
{
  const world = makeHeadlessWorld();
  const layers = new Map<string, EditableTerrain>();
  const registry = new SkillRegistry(new LiminaTracer("ses_pva_fail"));
  registerTerrainEditSkills(registry, layers);
  registerBuildingSkills(registry);
  registerVillageSkills(registry, layers, stubAssets);
  const at = (t: number) => ({ agentId: "agt_pva_fail", sessionId: "ses_pva_fail", permissions: perms, tick: t, world });

  const rc = await registry.invoke("terrain.create", { size: SIZE, resolution: RES, generate: GEN }, at(1));
  assert(rc.success, `terrain.create must succeed: ${JSON.stringify(rc.error)}`);
  const terrain = (rc.result as { entity: string }).entity;

  const DROWNED_ANCHOR_ID = "anchor-drowned-outpost";
  const failSteering = {
    buildings: [{ role: "outpost", style: "cut-stone", kit: true, sizeM: [5, 5, 6] as [number, number, number], count: 1 }],
    layout: { focal: "outpost", density: "loose" },
    anchors: [{ id: DROWNED_ANCHOR_ID, position: [5, 95] as [number, number], role: "outpost" }],
  };
  const rv = await registry.invoke("village.build", { direction, steering: failSteering, seed: SEED, terrainEntity: terrain }, at(2));
  assert(rv.success === false, "village.build must FAIL when an anchor has no buildable site nearby (deep water)");
  const message = rv.error?.message ?? "";
  assert(message.includes(DROWNED_ANCHOR_ID), `failure must NAME the offending anchor id, got: ${message}`);
}

ops.op_log(
  `[js] p_village_anchors OK: village.build honors authored placement anchors — civic hall (Δ${civicDist.toFixed(1)}m) ` +
  `+ watchtower (Δ${towerDist.toFixed(1)}m) pinned within 8m, a 3-cottage cluster sited around its anchor (<=16m) while ` +
  `the 4th cottage still flowed through the ordinary solver, nothing overlapping (min margin ${minMargin.toFixed(1)}m), ` +
  `byte-identical across two runs, and an anchor dropped in deep water FAILS LOUDLY naming its id — never silently relocated.`,
);
