// P92 — BUILDING BRIEF. The per-building-type art direction that comes OUT OF the GDD planning session
// and drives the build agent (game/building-brief.ts). Proves the schema is deterministic + falsifiable
// (house style of p73_design_direction), that validation enforces referential integrity against the
// active DesignDirection palette, and — the load-bearing claim of the pivot — that briefToRecipe turns
// DIFFERENT briefs into GENUINELY DIFFERENT structural recipes (a cottage is not a monastery), from ONE
// mapping and ONE toolkit. It is the falsifiable twin of the live GPU-eyes divergence proof.
//
// Run: ./target/release/limina js/test/p92_building_brief.ts   (exit 0 = pass)

import { ops } from "../src/engine.ts";
import {
  BuildingBriefSchema,
  parseBuildingBrief,
  serializeBuildingBrief,
  validateBuildingBrief,
  archetypeBrief,
  BUILDING_ARCHETYPES,
  BUILDING_CRAFT_PRINCIPLES,
  COTTAGE_BRIEF,
  MONASTERY_BRIEF,
  KEEP_BRIEF,
  LONGHALL_BRIEF,
  type BuildingBrief,
} from "../src/game/building-brief.ts";
import { PALETTE_ROLE_NAMES } from "../src/game/design-direction.ts";
import { briefToRecipe } from "../src/skills/building-recipe.ts";

function assert(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new Error("p92_building_brief: " + msg);
}
function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
function assertThrows(fn: () => unknown, msg: string): void {
  let threw = false;
  try { fn(); } catch { threw = true; }
  assert(threw, msg);
}

ops.op_physics_create_world(-9.81);

const ALL: BuildingBrief[] = [COTTAGE_BRIEF, MONASTERY_BRIEF, KEEP_BRIEF, LONGHALL_BRIEF];

// ── 1. Round-trip determinism for every shipped archetype ───────────────────────────────────
for (const b of ALL) {
  const j1 = serializeBuildingBrief(b);
  const j2 = serializeBuildingBrief(b);
  assert(j1 === j2, `serializeBuildingBrief must be byte-identical across calls (${b.id})`);
  assert(deepEqual(parseBuildingBrief(j1), b), `${b.id} must parse/serialize round-trip (deepEqual)`);
  assert(serializeBuildingBrief(parseBuildingBrief(j1)) === j1, `serialize(parse(serialize)) stable (${b.id})`);
}

// ── 2. Reject invalid ────────────────────────────────────────────────────────────────────────
assertThrows(() => BuildingBriefSchema.parse({ ...COTTAGE_BRIEF, construction: "adobe" }), "unknown construction must reject");
assertThrows(() => BuildingBriefSchema.parse({ ...COTTAGE_BRIEF, storeys: 9 }), "storeys > 4 must reject");
assertThrows(() => BuildingBriefSchema.parse({ ...COTTAGE_BRIEF, bogusKey: 1 }), "extra key must reject (strict)");

// ── 3. Referential integrity against the active DesignDirection palette ─────────────────────
// Every shipped brief clads only with roles the default palette defines.
for (const b of ALL) {
  const v = validateBuildingBrief(b, PALETTE_ROLE_NAMES);
  assert(v.ok, `${b.id} must clad with palette roles only; issues=${JSON.stringify(v.issues)}`);
}
// A brief cladding an element with a role the palette lacks MUST fail referential integrity.
const offPalette = validateBuildingBrief({ ...COTTAGE_BRIEF, material: { ...COTTAGE_BRIEF.material, wall: "water" } }, ["stone", "wood", "slate", "trim"]);
assert(!offPalette.ok && offPalette.issues.some((i) => i.path === "material.wall"), "off-palette wall role must be flagged");

// ── 4. briefToRecipe is deterministic + PURE ──────────────────────────────────────────────────
for (const b of ALL) {
  const r1 = JSON.stringify(briefToRecipe(b));
  const r2 = JSON.stringify(briefToRecipe(b));
  assert(r1 === r2, `briefToRecipe must be deterministic (${b.id})`);
}

// ── 5. FALSIFIABILITY: different briefs → genuinely different recipes (the pivot's core claim) ─
const rc = briefToRecipe(COTTAGE_BRIEF);
const rm = briefToRecipe(MONASTERY_BRIEF);
const rl = briefToRecipe(LONGHALL_BRIEF);

// A cottage is NOT a monastery: construction, base course, and footprint all differ.
assert(rc.construction === "timber-frame-daub", "cottage recipe carries timber-frame construction");
assert(rm.construction === "cut-stone", "monastery recipe carries cut-stone construction");
assert((rc.baseCourse ?? 0) > 0, "cottage has a stone base course (low footing under the timber frame)");
assert((rm.baseCourse ?? 0) === 0, "monastery has NO base course (the whole wall is already stone)");
assert(rc.width !== rm.width || rc.depth !== rm.depth, "cottage + monastery have different footprints");
assert(rc.height < rm.height, "the monastery nave is taller than the cottage");

// construction-material-logic: a stone-base-timber-upper carries a FULL ground storey of stone.
assert(rl.construction === "stone-base-timber-upper", "longhall recipe carries stone-base-timber-upper");
assert(Math.abs((rl.baseCourse ?? 0) - LONGHALL_BRIEF.storeyHeightM) < 1e-9, "longhall base course = one full stone ground storey");

// texture-orientation: the roof cover role flows from the brief onto the recipe roof.
assert(rc.roof !== null && rc.roof !== undefined && (rc.roof as { cover?: string }).cover === COTTAGE_BRIEF.material.roofCover, "roof cover role flows brief → recipe");

// ── 6. The archetype library + craft-principle discipline are present + well-formed ─────────────
assert(archetypeBrief("buildings.medieval.dwelling.cottage") === COTTAGE_BRIEF, "archetypeBrief resolves the shipped cottage");
assert(archetypeBrief("buildings.nonexistent") === undefined, "archetypeBrief returns undefined for an unknown id");
assert(Object.keys(BUILDING_ARCHETYPES).length >= 4, "the shipped archetype library has at least 4 briefs");
const pids = new Set(BUILDING_CRAFT_PRINCIPLES.map((p) => p.id));
for (const id of ["structural-honesty", "construction-material-logic", "texture-orientation", "weathering-realism"]) {
  assert(pids.has(id), `universal craft principle "${id}" is present in the build-agent discipline`);
}
for (const p of BUILDING_CRAFT_PRINCIPLES) {
  assert(p.statement.length > 0 && p.realizedBy.length > 0 && p.gatedBy.length > 0, `principle ${p.id} carries statement/realizedBy/gatedBy`);
}

console.log(`[js] p92_building_brief OK: ${ALL.length} archetype briefs round-trip + validate; briefToRecipe is deterministic; cottage(${rc.construction}, base ${rc.baseCourse}) ≠ monastery(${rm.construction}, base ${rm.baseCourse}) ≠ longhall(${rl.construction}, base ${rl.baseCourse}); ${BUILDING_CRAFT_PRINCIPLES.length} universal craft principles enforced.`);
