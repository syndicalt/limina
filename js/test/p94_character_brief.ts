// P94 — CHARACTER BRIEF. The per-NPC-type direction that comes OUT OF the GDD planning session and drives
// the build agent + briefToNpcSpec (game/character-brief.ts). The character parallel to p92_building_brief:
// proves the schema is deterministic + falsifiable (house style of p73/p92), that validation enforces
// referential integrity against the active DesignDirection palette, that the shipped archetype library +
// universal craft-principle discipline are present, and that the seven archetypes are GENUINELY DISTINCT
// direction (a child is not a priest) rather than one template relabelled.
//
// briefToNpcSpec divergence (a villager NpcSpec ≠ a guard NpcSpec) is proven in the Slice-2 gate; this
// Slice-1 gate falsifies the BRIEF layer itself.
//
// Run: ./target/release/limina js/test/p94_character_brief.ts   (exit 0 = pass)

import { ops } from "../src/engine.ts";
import {
  CharacterBriefSchema,
  parseCharacterBrief,
  serializeCharacterBrief,
  validateCharacterBrief,
  archetypeCharacterBrief,
  CHARACTER_ARCHETYPES,
  CHARACTER_CRAFT_PRINCIPLES,
  ARCHETYPE_NAMES,
  REASONING_TIER,
  VILLAGER_BRIEF,
  GUARD_BRIEF,
  VENDOR_BRIEF,
  ELDER_BRIEF,
  LABORER_BRIEF,
  CHILD_BRIEF,
  PRIEST_BRIEF,
  type CharacterBrief,
} from "../src/game/character-brief.ts";
import { PALETTE_ROLE_NAMES } from "../src/game/design-direction.ts";

function assert(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new Error("p94_character_brief: " + msg);
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

const ALL: CharacterBrief[] = [VILLAGER_BRIEF, GUARD_BRIEF, VENDOR_BRIEF, ELDER_BRIEF, LABORER_BRIEF, CHILD_BRIEF, PRIEST_BRIEF];

// ── 1. Round-trip determinism for every shipped archetype ───────────────────────────────────
for (const b of ALL) {
  const j1 = serializeCharacterBrief(b);
  const j2 = serializeCharacterBrief(b);
  assert(j1 === j2, `serializeCharacterBrief must be byte-identical across calls (${b.id})`);
  assert(deepEqual(parseCharacterBrief(j1), b), `${b.id} must parse/serialize round-trip (deepEqual)`);
  assert(serializeCharacterBrief(parseCharacterBrief(j1)) === j1, `serialize(parse(serialize)) stable (${b.id})`);
}

// ── 2. Reject invalid ────────────────────────────────────────────────────────────────────────
assertThrows(() => CharacterBriefSchema.parse({ ...VILLAGER_BRIEF, archetype: "wizard" }), "unknown archetype must reject");
assertThrows(() => CharacterBriefSchema.parse({ ...VILLAGER_BRIEF, tier: "genius" }), "unknown tier must reject");
assertThrows(() => CharacterBriefSchema.parse({ ...VILLAGER_BRIEF, bogusKey: 1 }), "extra key must reject (strict)");
assertThrows(() => CharacterBriefSchema.parse({ ...ELDER_BRIEF, appearance: { skinTone01: 1.4 } }), "skinTone01 > 1 must reject");

// ── 3. Referential integrity against the active DesignDirection palette ─────────────────────
// Every shipped brief tints only with roles the default palette defines.
for (const b of ALL) {
  const v = validateCharacterBrief(b, PALETTE_ROLE_NAMES);
  assert(v.ok, `${b.id} must tint with palette roles only; issues=${JSON.stringify(v.issues)}`);
}
// An outfit tinting with a role the palette lacks MUST fail referential integrity.
const offPalette = validateCharacterBrief({ ...VILLAGER_BRIEF, appearance: { outfitPalette: "gold" } }, ["wood", "metal", "stone", "accent"]);
assert(!offPalette.ok && offPalette.issues.some((i) => i.path === "appearance.outfitPalette"), "off-palette outfit role must be flagged");

// reasoning-LOD discipline: an ambient NPC carrying goals is flagged (the scripted brain ignores them).
const ambientWithGoals = validateCharacterBrief({ ...CHILD_BRIEF, tier: "ambient", persona: { ...CHILD_BRIEF.persona, goals: ["scheme"] } });
assert(!ambientWithGoals.ok && ambientWithGoals.issues.some((i) => i.path === "persona.goals"), "ambient tier + goals must be flagged");

// ── 4. FALSIFIABILITY: the seven archetypes are genuinely DIFFERENT direction, not one template ─
// distinct kinds
assert(new Set(ALL.map((b) => b.archetype)).size === ALL.length, "every shipped brief is a distinct archetype");
// the reasoning-LOD tiers actually span the range (ambient crowd .. named characters)
const tiers = new Set(ALL.map((b) => b.tier));
for (const t of REASONING_TIER) assert(tiers.has(t), `the library exercises the "${t}" reasoning tier`);
// a child (ambient, no goals, small) is NOT a priest (named, goal-driven)
assert(CHILD_BRIEF.tier === "ambient" && CHILD_BRIEF.persona.goals.length === 0, "child is an ambient crowd NPC with no goals");
assert(PRIEST_BRIEF.tier === "named" && PRIEST_BRIEF.persona.goals.length > 0, "priest is a named, goal-driven character");
// dispositions + routines diverge across the set (not one voice relabelled)
assert(new Set(ALL.map((b) => b.persona.disposition)).size >= 3, "dispositions diverge across the library");
assert(new Set(ALL.map((b) => b.routine)).size >= 3, "routines diverge across the library");

// ── 5. The archetype library + craft-principle discipline are present + well-formed ─────────────
assert(archetypeCharacterBrief("characters.medieval.villager.commoner") === VILLAGER_BRIEF, "archetypeCharacterBrief resolves the shipped villager");
assert(archetypeCharacterBrief("characters.nonexistent") === undefined, "archetypeCharacterBrief returns undefined for an unknown id");
assert(Object.keys(CHARACTER_ARCHETYPES).length >= 7, "the shipped archetype library has at least 7 briefs");
assert(new Set(ALL.map((b) => b.archetype)).size === ARCHETYPE_NAMES.length, "the library covers every archetype name (incl. priest)");
assert(ALL.some((b) => b.archetype === "priest"), "the priest archetype ships");

const pids = new Set(CHARACTER_CRAFT_PRINCIPLES.map((p) => p.id));
for (const id of ["perception-bounded", "least-privilege-action", "action-determinism", "in-character-voice", "reasoning-lod"]) {
  assert(pids.has(id), `universal craft principle "${id}" is present in the NPC discipline`);
}
for (const p of CHARACTER_CRAFT_PRINCIPLES) {
  assert(p.statement.length > 0 && p.realizedBy.length > 0 && p.gatedBy.length > 0, `principle ${p.id} carries statement/realizedBy/gatedBy`);
}

console.log(`[js] p94_character_brief OK: ${ALL.length} archetype briefs round-trip + validate; tiers span {${[...tiers].join(", ")}}; child(ambient) ≠ priest(named); ${CHARACTER_CRAFT_PRINCIPLES.length} universal craft principles enforced.`);
