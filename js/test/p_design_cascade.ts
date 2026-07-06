// p_design_cascade -- the cascade impact engine. A change to one design entity must surface
// everything it affects, over the vault's own graph, routed to the right experts. This locks
// the blast-radius computation so a change can be surfaced for review, never silently drift.

import { ops } from "../src/engine.ts";
import { computeImpact } from "../src/game/design-cascade.ts";

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error("p_design_cascade: " + message);
}

const WORLD = `---
kind: world-bible
setting:
  name: The Eastern Watch
  era: Late Marches
  premise: The last waypost holds the line.
regions:
  - id: the-hamlet
    name: The Hamlet
    biome: meadow
    note: The settled clearing.
locations:
  - id: watchtower
    name: Watchtower
    kind: military
    region: the-hamlet
    position: [30, 12]
    note: Overlooks the frontier.
  - id: longhall
    name: Longhall
    kind: civic
    region: the-hamlet
    position: [0, 0]
    note: The hall.
---
# World`;
const CAST = `---
kind: cast
player:
  id: warden
  name: The Warden
npcs:
  - id: grundir
    name: Grundir
    home: watchtower
    note: Keeps watch.
---
# Cast`;
const STORY = `---
kind: storyboard
beats:
  - id: overlook
    name: The Overlook
    at: watchtower
    note: The frontier east.
---
# Storyboard`;
const docs = [
  { name: "world-bible.md", content: WORLD },
  { name: "cast.md", content: CAST },
  { name: "storyboard.md", content: STORY },
];

// Move the Watchtower — an entity-level change to a world-bible location.
const impact = computeImpact(docs, { entityId: "watchtower", op: "modified", note: "moved east" });

// Source resolved to the world-bible location.
assert(impact.source?.id === "watchtower" && impact.source?.type === "location" && impact.source?.artifact === "worldBible",
  "source is the watchtower location owned by worldBible");

// Affected = the NPC who lives there + the beat that happens there (the graph referrers).
const affIds = impact.affected.map((a) => a.id).sort();
assert(JSON.stringify(affIds) === JSON.stringify(["grundir", "overlook"]),
  `affected = grundir + overlook, got ${JSON.stringify(affIds)}`);
const grundir = impact.affected.find((a) => a.id === "grundir")!;
assert(grundir.relation === "lives-in" && grundir.artifact === "cast" && grundir.expertRole === "Casting Director",
  "grundir affected via lives-in, owned by cast / Casting Director");
const overlook = impact.affected.find((a) => a.id === "overlook")!;
assert(overlook.relation === "occurs-at" && overlook.artifact === "storyboard" && overlook.expertRole === "Narrative Designer",
  "overlook affected via occurs-at, owned by storyboard / Narrative Designer");

// The un-referenced longhall is NOT dragged in.
assert(!impact.affected.some((a) => a.id === "longhall"), "unreferenced longhall is not affected");

// Downstream artifacts + experts to route the review to.
assert(impact.downstreamArtifacts.includes("cast") && impact.downstreamArtifacts.includes("storyboard"),
  "downstream artifacts include cast + storyboard");
const roles = impact.experts.map((e) => e.role).sort();
assert(roles.includes("Casting Director") && roles.includes("Narrative Designer"),
  "experts routed = Casting Director + Narrative Designer");

// Build placements that move: the watchtower + the NPC placed there.
assert(impact.buildPlacements.includes("location-watchtower") && impact.buildPlacements.includes("entity-grundir"),
  `build placements move, got ${JSON.stringify(impact.buildPlacements)}`);

// Summary is human-surfaceable.
assert(/Watchtower/.test(impact.summary) && /Casting Director/.test(impact.summary), "summary names the change + experts");

// Removal is harsher wording but same graph.
const removed = computeImpact(docs, { entityId: "watchtower", op: "removed" });
assert(removed.affected.length === 2 && /loses its target/.test(removed.affected[0].reason), "removal reasons reflect a lost target");

ops.op_log(
  "[js] p_design_cascade OK: moving the Watchtower surfaces its blast radius over the design graph — " +
    "Grundir (lives-in) + The Overlook (occurs-at) affected, routed to the Casting Director + Narrative " +
    "Designer, with the build placements that move; the unreferenced Longhall is left out.",
);
