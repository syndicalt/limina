// p_design_vault -- DESIGN SPACE: the vault translator. Readable, linked markdown
// documents (the design space's source of truth) parse into the canonical design.*
// artifacts and compile into a runnable world. This locks the "documents ARE the spec,
// translated to limina instructions" contract end to end:
//   parse frontmatter -> map readable vocab to schema enums -> validate artifacts ->
//   compile -> world placements at the authored positions -> resolve a build link.
//
// The docs below mirror the real eastern-watch vault frontmatter (the readable field
// names: note/at/home/region, and the readable enums: meadow/civic) so the gate proves
// the TRANSLATION, not a pre-canonicalized shortcut.

import { ops } from "../src/engine.ts";
import { vaultToStore, parseFrontmatter, vaultGraph, diffDocEntities, serializeFrontmatter, replaceFrontmatter } from "../src/game/design-vault.ts";
import { compileDesignToGds } from "../src/game/design-compile.ts";

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error("p_design_vault: " + message);
}

const CONCEPT = `---
kind: concept
id: eastern-watch
title: Eastern Watch
logline: A lone Warden keeps the last manned watch-hamlet on the frontier.
loop: Arrive, walk the hamlet, climb the watchtower, reach the signal fire, look east.
pillars:
  - id: held-line
    name: The Held Line
    note: The whole place is defined by the Blight at its edge.
scope:
  in: [one zone, the hamlet, the blight edge]
  out: [combat, quests]
---
# Concept`;

const WORLD = `---
kind: world-bible
setting:
  name: The Eastern Watch
  era: The late Marches.
  premise: The last manned waypost holds the line.
zone:
  size_m: 200
regions:
  - id: the-hamlet
    name: The Hamlet
    biome: meadow
    note: The settled clearing.
  - id: the-blight-edge
    name: The Blight Edge
    biome: blighted
    note: East of the perimeter.
locations:
  - id: longhall
    name: Longhall
    kind: civic
    region: the-hamlet
    position: [0, 0]
    note: The muster hall.
  - id: watchtower
    name: Watchtower
    kind: military
    region: the-hamlet
    position: [30, 12]
    note: Overlooks the frontier.
  - id: signal-fire
    name: Signal Fire
    kind: marker
    region: the-blight-edge
    position: [55, 5]
    note: The last beacon.
---
# World Bible`;

const CAST = `---
kind: cast
player:
  id: warden
  name: The Warden
  asset: characters/player/warden/warden-1
npcs:
  - id: grundir
    name: Grundir the Veteran
    asset: characters/npc/grundir-veteran
    home: longhall
    note: Keeps the longhall.
creatures:
  - id: shambler
    name: Blighted Shambler
    asset: creatures/blighted/shambler
    home: the-blight-edge
    note: Ambient menace beyond the line.
---
# Cast`;

const STORY = `---
kind: storyboard
beats:
  - id: arrival
    name: Arrival
    at: longhall
    note: West entrance at dusk.
  - id: the-overlook
    name: The Overlook
    at: watchtower
    note: The frontier lays out east.
---
# Storyboard`;

// 1. Frontmatter parser handles the subset (nested map, list-of-maps, inline [array]).
const fm = parseFrontmatter(WORLD);
assert(Array.isArray(fm.locations) && (fm.locations as unknown[]).length === 3, "parser: 3 locations");
const loc0 = (fm.locations as Record<string, unknown>[])[1];
assert(Array.isArray(loc0.position) && (loc0.position as number[])[0] === 30, "parser: inline [array] position");
assert((fm.setting as Record<string, unknown>).name === "The Eastern Watch", "parser: nested map");

// 2. Translate the vault into a validated design store.
const { store, links, kinds } = vaultToStore([
  { name: "concept.md", content: CONCEPT },
  { name: "world-bible.md", content: WORLD },
  { name: "cast.md", content: CAST },
  { name: "storyboard.md", content: STORY },
]);
assert(kinds.includes("gds") && kinds.includes("worldBible") && kinds.includes("cast") && kinds.includes("storyboard"),
  "all four artifacts translated + validated");

// 3. Compile the store into a GDS-driven world.
const { gds, issues } = compileDesignToGds(store);
assert(gds !== undefined, `compile must succeed; issues: ${JSON.stringify(issues)}`);
const placements = gds!.world?.placements ?? [];

// 4. The 3 locations became placements at the AUTHORED positions ([x,0,z]).
const byId = new Map(placements.map((p) => [p.id, p]));
const tower = byId.get("location-watchtower");
assert(tower !== undefined, "watchtower compiled to a placement");
assert(tower!.transform.position[0] === 30 && tower!.transform.position[2] === 12,
  `watchtower at authored position [30,_,12], got ${JSON.stringify(tower!.transform.position)}`);
assert(byId.has("location-longhall") && byId.has("location-signal-fire"), "longhall + signal-fire placed");

// 5. Cast projected: the Warden is the player entity; Grundir + Shambler are npcs.
assert(gds!.entities.some((e) => e.id === "warden" && e.role === "player"), "Warden is the player entity");
assert(gds!.entities.some((e) => e.id === "grundir") && gds!.entities.some((e) => e.id === "shambler"),
  "Grundir + Shambler projected as entities");

// 6. Storyboard beats drove DoD assertions into the GDS.
assert(gds!.dod.length >= 1, "at least the synthesized explore DoD");

// 7. Build-link resolution: the world-bible 'watchtower' doc entity resolves to the
//    placement it produced -> this is the doc <-> build link, over the compiled id.
const link = links.find((l) => l.entity === "watchtower");
assert(link !== undefined, "watchtower has a build-link stub");
const resolved = placements.find((p) => p.id === `location-${link!.entity}`);
assert(resolved !== undefined, "watchtower build link resolves to its placement (doc -> build)");

// 8. Mind-map graph is generated FROM the docs' own links (nodes + typed edges).
const graph = vaultGraph([
  { name: "world-bible.md", content: WORLD },
  { name: "cast.md", content: CAST },
  { name: "storyboard.md", content: STORY },
]);
assert(graph.nodes.some((n) => n.id === "watchtower" && n.type === "location"), "graph: watchtower location node");
assert(graph.nodes.some((n) => n.id === "grundir" && n.type === "npc"), "graph: grundir npc node");
assert(graph.edges.some((e) => e.from === "watchtower" && e.to === "the-hamlet" && e.label === "in"), "graph: location-in-region edge");
assert(graph.edges.some((e) => e.from === "grundir" && e.to === "longhall" && e.label === "lives-in"), "graph: npc-lives-in-location edge");
assert(graph.edges.some((e) => e.from === "the-overlook" && e.to === "watchtower" && e.label === "occurs-at"), "graph: beat-occurs-at-location edge");
assert(graph.edges.every((e) => graph.nodes.some((n) => n.id === e.from) && graph.nodes.some((n) => n.id === e.to)), "graph: no dangling edges");

// 9. diffDocEntities detects what changed on save (drives the cascade).
const before = WORLD;
const moved = WORLD.replace("position: [30, 12]", "position: [42, 20]");
const dMoved = diffDocEntities(before, moved);
assert(dMoved.length === 1 && dMoved[0].entityId === "watchtower" && dMoved[0].op === "modified", "diff: a moved location is 'modified'");
const dSame = diffDocEntities(before, before);
assert(dSame.length === 0, "diff: identical content yields no changes");
const removed = WORLD.replace(/  - id: signal-fire[\s\S]*?note: The last beacon\.\n/, "");
assert(diffDocEntities(before, removed).some((c) => c.entityId === "signal-fire" && c.op === "removed"), "diff: a deleted location is 'removed'");
// Cartography-only fields (map assignment / child-map link) must NOT cascade.
const withMap = WORLD.replace("kind: military", "kind: military\n    map: marches\n    mapLink: hamlet");
assert(diffDocEntities(before, withMap).length === 0, "diff: assigning map/mapLink to a marker does NOT cascade");

// 10. serializeFrontmatter round-trips (the foundation for structured authoring/editing).
const fmW = parseFrontmatter(WORLD);
const round = parseFrontmatter("---\n" + serializeFrontmatter(fmW) + "\n---\n# body");
assert(JSON.stringify(round) === JSON.stringify(fmW), "serializeFrontmatter round-trips parse->serialize->parse");
// replaceFrontmatter keeps the prose body and lets a structured edit (add a location) persist.
const withNew = replaceFrontmatter(WORLD, { ...fmW, locations: [...(fmW.locations as unknown[]), { id: "new-mill", name: "The Mill", kind: "landmark", region: "the-hamlet", position: [12, -8], tags: ["work", "water"] }] });
const reparsed = parseFrontmatter(withNew);
assert((reparsed.locations as unknown[]).length === (fmW.locations as unknown[]).length + 1, "replaceFrontmatter adds a location");
assert(withNew.includes("# World"), "replaceFrontmatter preserves the prose body");
const mill = (reparsed.locations as Record<string, unknown>[]).find((l) => l.id === "new-mill")!;
assert(Array.isArray(mill.tags) && (mill.tags as string[]).includes("water"), "a placed marker keeps its tags");

ops.op_log(
  "[js] p_design_vault OK: readable vault docs parse (nested maps, list-of-maps, inline arrays), " +
    "translate readable vocab (meadow->grassland, civic->settlement, note->description, home->locationId) " +
    "into validated design.* artifacts, compile to a world with 3 locations at their authored positions, " +
    "project the Warden/Grundir/Shambler cast, and resolve a doc->build link (DESIGN SPACE translator).",
);
