// P95 — briefToNpcSpec. The realizer that turns a CharacterBrief into the durable NpcSpec (agents/brief-to-
// npc-spec.ts). The character parallel to p92's briefToRecipe divergence proof: DIFFERENT briefs must yield
// GENUINELY DIFFERENT specs (a child crowd NPC is not a named priest), from ONE deterministic mapping, and
// every produced spec must be a VALID NpcSpec.
//
// Run: ./target/release/limina js/test/p95_brief_to_npc_spec.ts   (exit 0 = pass)

import { ops } from "../src/engine.ts";
import { npcSpecSchema, buildNpcSystemPrompt } from "../src/agents/npc.ts";
import { briefToNpcSpec, composeVoice } from "../src/agents/brief-to-npc-spec.ts";
import {
  VILLAGER_BRIEF, GUARD_BRIEF, VENDOR_BRIEF, ELDER_BRIEF, LABORER_BRIEF, CHILD_BRIEF, PRIEST_BRIEF,
  type CharacterBrief,
} from "../src/game/character-brief.ts";

function assert(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new Error("p95_brief_to_npc_spec: " + msg);
}

ops.op_physics_create_world(-9.81);

const ALL: CharacterBrief[] = [VILLAGER_BRIEF, GUARD_BRIEF, VENDOR_BRIEF, ELDER_BRIEF, LABORER_BRIEF, CHILD_BRIEF, PRIEST_BRIEF];

// ── 1. Every brief realizes to a VALID NpcSpec, deterministically ──────────────────────────────
for (const b of ALL) {
  const s1 = briefToNpcSpec(b);
  const s2 = briefToNpcSpec(b);
  assert(JSON.stringify(s1) === JSON.stringify(s2), `briefToNpcSpec must be deterministic (${b.id})`);
  npcSpecSchema.parse(s1); // throws if the mapping produced an invalid spec
  assert(s1.persona.name === b.name, `${b.id} spec carries the brief name`);
  assert(s1.goals !== undefined && JSON.stringify(s1.goals) === JSON.stringify(b.persona.goals), `${b.id} goals ride through`);
  // the composed voice carries the brief voice + a disposition cue
  assert(s1.persona.voice.startsWith(b.persona.voice), `${b.id} voice begins with the brief voice`);
  assert(s1.persona.voice.length > b.persona.voice.length, `${b.id} voice is enriched with a disposition cue`);
}

// index disambiguates instances
assert(briefToNpcSpec(VILLAGER_BRIEF, 0).id !== briefToNpcSpec(VILLAGER_BRIEF, 1).id, "index disambiguates agent ids");

// ── 2. Reasoning-LOD: tier → brain + cadence ───────────────────────────────────────────────────
const child = briefToNpcSpec(CHILD_BRIEF);     // ambient
const villager = briefToNpcSpec(VILLAGER_BRIEF); // functional
const priest = briefToNpcSpec(PRIEST_BRIEF);   // named
assert(child.model.provider === "scripted" && child.cadence === 120, "ambient tier → scripted brain, slow cadence");
assert(villager.model.provider === "ollama" && villager.cadence === 30, "functional tier → local model, mid cadence");
assert(priest.model.provider === "ollama" && priest.cadence === 15, "named tier → local model, fast cadence");

// ── 3. FALSIFIABILITY: different briefs → genuinely different specs ─────────────────────────────
assert(child.model.provider !== priest.model.provider, "a child crowd NPC is not a named priest (different brain)");
assert(child.cadence !== priest.cadence, "child and priest reason at different cadences");
assert(child.persona.voice !== priest.persona.voice, "child and priest have different voices");
// Per-ZONE outfit maps through: a guard's mail-tinted tunic ≠ a villager's grey wool tunic, and the
// villager carries a multi-zone outfit (tunic + hose + boots …), not one flat colour.
const gv = briefToNpcSpec(GUARD_BRIEF), vv = briefToNpcSpec(VILLAGER_BRIEF);
assert(gv.color !== undefined && vv.color !== undefined && gv.color !== vv.color, "guard primary tint ≠ villager primary tint");
assert(vv.appearance?.outfit !== undefined && Object.keys(vv.appearance.outfit).length >= 3, "villager carries a multi-zone outfit map");
assert(gv.appearance?.outfit?.tunic !== vv.appearance?.outfit?.tunic, "guard tunic zone ≠ villager tunic zone");

// ── 4. Spawn resolves from role by default ─────────────────────────────────────────────────────
const spawn = briefToNpcSpec(VILLAGER_BRIEF).spawn;
assert("role" in spawn && spawn.role === VILLAGER_BRIEF.role, "spawn defaults to the brief role");

// ── 5. The composed prompt is well-formed (voice + goals + action space) ───────────────────────
const prompt = buildNpcSystemPrompt(priest);
assert(prompt.includes(PRIEST_BRIEF.name) && prompt.includes("social.approach"), "system prompt carries persona + action space");
for (const g of PRIEST_BRIEF.persona.goals) assert(prompt.includes(g), `system prompt carries goal "${g}"`);
assert(composeVoice(GUARD_BRIEF).includes("guardedly") || composeVoice(GUARD_BRIEF).includes("duty"), "guard voice carries its disposition cue");

console.log(`[js] p95_brief_to_npc_spec OK: ${ALL.length} briefs → valid NpcSpecs, deterministic; tiers map child(scripted/120) ≠ villager(ollama/30) ≠ priest(ollama/15); voices + goals + tints diverge.`);
