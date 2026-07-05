// Scaffold the CHARACTER reference leaves during planning — one card.md stub per CharacterBrief archetype,
// keyed to the SAME dotted ids the briefs carry (js/src/game/character-brief.ts), so a user or agent can
// drop grounded-stylized medieval reference images in each folder + refine the card, then review. The build
// agent then RAGs those references (resolveReference) to source/author a matching rigged body.
//
//   node tools/reference/scaffold-characters.mjs        # scaffold + print review manifest
//
// Idempotent: never overwrites a card that already has content/images (re-running only fills gaps).

import { scaffoldReference, resolveReference, listLeaves } from "./reference-library.mjs";

const COMMON_TAGS = ["role:npc", "era:medieval", "scale:human", "style:grounded-stylized", "condition:pristine"];
const GAPS = ["rigged-body-source", "outfit-variation"];
const REF_HINT = (role) =>
  `Drop 2–3 reference images of a ${role} in the grounded-stylized medieval look (match the house style in ` +
  `characters/npc/grundir-veteran and characters/player/warden — not sci-fi).`;
const BUILD = "Rigged humanoid from the Character AssetSource (world/character-body.ts) + outfitPalette tint + " +
  "skinTone; shared walk/idle clips. GAP: a medieval-appropriate rigged body asset (curated or generated).";

// Derived from the shipped CharacterBrief archetypes (same ids), so resolveReference(brief.id) hits these.
const CHARACTERS = [
  { id: "characters.medieval.villager.commoner", title: "Villager", role: "common villager", what: "A plain-spoken villager in a homespun tunic; unhurried, comfortable stopping to talk." },
  { id: "characters.medieval.guard.gate", title: "Gate guard", role: "town gate guard", what: "A watchful guard in mail + tabard; stands square, quick to challenge a stranger." },
  { id: "characters.medieval.vendor.market", title: "Market vendor", role: "market trader", what: "A cheerful trader in brighter dyed cloth; animated, stays near the stall." },
  { id: "characters.medieval.elder.reeve", title: "Village elder", role: "village reeve/elder", what: "The reeve — plain grey robe, leans on a staff; stationary, others come to them." },
  { id: "characters.medieval.laborer.hand", title: "Laborer", role: "field hand/labourer", what: "A weathered field hand in rough undyed cloth; heavy tread." },
  { id: "characters.medieval.child.villager", title: "Village child", role: "village child", what: "A village child, smaller scale, quick darting movement." },
  { id: "characters.medieval.priest.parish", title: "Parish priest", role: "parish priest", what: "The priest — long dark robe; unhurried, lingers near the church door." },
];

let created = 0;
for (const c of CHARACTERS) {
  const r = scaffoldReference({
    id: c.id, title: c.title, tags: [...COMMON_TAGS, `archetype:${c.id.split(".")[2]}`],
    engineGaps: GAPS, whatItIs: c.what, references: REF_HINT(c.role), buildPath: BUILD,
  });
  if (r.created) created++;
  console.log(`${r.created ? "＋ scaffolded" : "· exists   "}  ${c.id}  (${r.images} img)`);
}

console.log(`\n${created} card(s) scaffolded. RAG retrieval check:`);
const grundir = resolveReference("characters.npc.grundir-veteran");
console.log(`  resolveReference("characters.npc.grundir-veteran") → ${grundir ? `"${grundir.card.title}", ${grundir.images.length} ref image(s), tags [${grundir.card.tags.join(", ")}]` : "MISS"}`);
const villager = resolveReference("characters.medieval.villager.commoner");
console.log(`  resolveReference("characters.medieval.villager.commoner") → ${villager ? `"${villager.card.title}", ${villager.images.length} ref image(s) (awaiting drop)` : "MISS"}`);

console.log("\nReview manifest — reference leaves needing images:");
for (const l of listLeaves().filter((l) => l.needsImages)) console.log(`  ☐ ${l.id.padEnd(44)} ${l.title} [${l.status}]`);
const ready = listLeaves().filter((l) => !l.needsImages);
console.log(`\n${ready.length} leaf/leaves already have reference images: ${ready.map((l) => l.id).join(", ") || "(none)"}`);
