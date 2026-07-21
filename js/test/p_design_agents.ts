// p_design_agents -- the expert agent team, wired with FULL role context. Each of the 6
// agents (5 domain experts + the Architect) must, before any live turn, know: WHO it is
// (persona), WHAT it owns + depends on (document-aware), WHERE the maker is looking
// (screen-aware), and what a change RIPPLES into (cascade-aware). This gate locks that the
// assembled context actually carries all four, over a real vault-derived design store.

import { ops } from "../src/engine.ts";
import { vaultToStore } from "../src/game/design-vault.ts";
import { DESIGN_AGENTS, assembleAgentContext, getDesignAgent } from "../src/game/design-agents.ts";

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error("p_design_agents: " + message);
}

const CONCEPT = `---
kind: concept
id: eastern-watch
title: Eastern Watch
logline: A lone Warden keeps the last watch-hamlet on the frontier.
loop: Walk the hamlet and reach the watchtower.
---
# Concept`;
const WORLD = `---
kind: world-bible
setting:
  name: The Eastern Watch
  era: Late Marches
  premise: The last waypost holds the line.
zone:
  size_m: 200
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
---
# World`;
const CAST = `---
kind: cast
player:
  id: warden
  name: The Warden
  asset: warden-1
npcs:
  - id: grundir
    name: Grundir
    asset: grundir-veteran
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

const { store } = vaultToStore([
  { name: "concept.md", content: CONCEPT },
  { name: "world-bible.md", content: WORLD },
  { name: "cast.md", content: CAST },
  { name: "storyboard.md", content: STORY },
]);

// 1. The team is 5 domain experts + the Architect.
assert(DESIGN_AGENTS.length === 6, "6 agents (5 studios + architect)");
assert(DESIGN_AGENTS.some((a) => a.id === "architect" && a.scope === "global"), "the Architect is a global-scope agent");
for (const id of ["concept", "artDirection", "world", "cast", "storyboard"]) {
  assert(DESIGN_AGENTS.some((a) => a.id === id && a.scope === "domain"), `domain expert ${id} exists`);
}

// 2. The Worldbuilder gets FULL context for its role.
const world = assembleAgentContext("world", store, { openDoc: "world-bible.md", selectionText: "Watchtower" });
assert(world.role === "Worldbuilder" && world.systemPrompt.includes("Worldbuilder"), "world: persona/role present");
assert(world.systemPrompt.includes("Watchtower"), "world: OWN document content is in context (document-aware)");
assert(world.systemPrompt.includes("gds") && world.systemPrompt.includes("artDirection"),
  "world: UPSTREAM documents (gds, artDirection) are in context");
assert(world.systemPrompt.includes("world-bible.md"), "world: screen-aware (open doc named)");
assert(world.systemPrompt.includes('selected: "Watchtower"'), "world: screen-aware (selection threaded)");
assert(/CASCADE/.test(world.systemPrompt) && world.systemPrompt.includes("cast") && world.systemPrompt.includes("storyboard"),
  "world: cascade names its downstream (cast, storyboard)");
assert(world.tools.includes("design.get") && world.tools.includes("design.set"), "world: has design read + propose tools");
assert(JSON.stringify([...world.contextKinds].sort()) === JSON.stringify(["artDirection", "gds", "worldBible"]),
  `world contextKinds = own + upstream, got ${JSON.stringify(world.contextKinds)}`);

// 3. The Concept expert (root) cascades into EVERYTHING downstream.
const concept = assembleAgentContext("concept", store);
for (const d of ["artDirection", "worldBible", "cast", "storyboard"]) {
  assert(concept.systemPrompt.includes(d), `concept cascade names downstream ${d}`);
}

// 4. The Architect sees EVERY document.
const arch = assembleAgentContext("architect", store, {});
assert(arch.role === "Architect", "architect role");
assert(arch.contextKinds.length === 5, "architect context spans all 5 artifact kinds");
assert(arch.systemPrompt.includes("Watchtower") && arch.systemPrompt.includes("Warden") && arch.systemPrompt.includes("Overlook"),
  "architect context folds in world + cast + storyboard content (global awareness)");

// 5. Screen focus is optional but honoured when absent.
const noScreen = assembleAgentContext("cast", store);
assert(noScreen.systemPrompt.includes("has not indicated a specific focus"), "cast: graceful when no screen focus");

// 6. Unknown agent id fails loudly.
let threw = false;
try { getDesignAgent("nobody"); } catch { threw = true; }
assert(threw, "unknown agent id must throw");

ops.op_log(
  "[js] p_design_agents OK: the 6-agent team (5 domain experts + Architect) assembles FULL role context — " +
    "persona + owned document + upstream documents (document-aware) + the maker's open doc/selection " +
    "(screen-aware) + named downstream cascade + read/propose tools; the Architect sees every document.",
);
