// P67 — skills.search is DISCOVERABLE for real agent queries. A naive whole-query substring match
// made the build agent miss vegetation.scatter ("skills.search returned no matches for vegetation
// tools") and fall back to planting 89 trees one at a time. Tokenized + lightly-stemmed matching
// must surface the right skill for the phrasings agents actually type.

import { ops, EntityTable, type WorldContext } from "../src/engine.ts";
import { createEcsWorld } from "../src/ecs/world.ts";
import { createTransformStorage } from "../src/ecs/facade.ts";
import { UniformGridSpatialIndex } from "../src/spatial/index.ts";
import { SkillRegistry } from "../src/skills/registry.ts";
import { registerCoreSkills } from "../src/skills/index.ts";
import { resolveProfile } from "../src/skills/permissions.ts";
import { LiminaTracer } from "../src/observability/event.ts";

function assert(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new Error("p67_skills_search: " + msg);
}

const ecs = createEcsWorld();
const world: WorldContext = {
  ecs, transforms: createTransformStorage(ecs), spatial: new UniformGridSpatialIndex(),
  entities: new EntityTable(), tags: new Map(),
  scene: { add() {}, remove() {} }, camera: { position: { set() {} }, lookAt() {} },
  ops, mode: "headless",
};
const registry = new SkillRegistry(new LiminaTracer("ses_p67"));
registerCoreSkills(registry);
const perms = resolveProfile("builder.readWrite");
const at = { agentId: "agt_p67", sessionId: "ses_p67", permissions: perms, tick: 0, world };

async function search(query: string): Promise<string[]> {
  const r = await registry.invoke("skills.search", { query, limit: 25 }, at);
  assert(r.success, `skills.search('${query}') failed: ${JSON.stringify(r.error)}`);
  return (r.result as { matches: { name: string }[] }).matches.map((m) => m.name);
}

// The exact classes of phrasing that used to return nothing:
const cases: Array<[string, string]> = [
  ["scatter trees", "vegetation.scatter"],        // plural "trees" vs "tree archetypes"
  ["vegetation scatter", "vegetation.scatter"],   // space vs the "." in the tool name
  ["plant trees", "vegetation.plant"],            // "trees" vs "tree"
  ["scattering a forest of trees", "vegetation.scatter"], // "scattering" stems to "scatter"
  ["forest", "vegetation.scatter"],               // matches the description
  ["move an entity", "scene.moveEntity"],         // recently-added skill, natural phrasing
];
for (const [query, expect] of cases) {
  const names = await search(query);
  assert(names.includes(expect), `search('${query}') must include ${expect}; got [${names.slice(0, 6).join(", ")}]`);
}

// Ranking: the most on-topic skill leads for a pointed query.
const scatterFirst = await search("scatter a forest of trees");
assert(scatterFirst[0] === "vegetation.scatter", `'scatter a forest of trees' should rank vegetation.scatter first; got ${scatterFirst[0]}`);

// A gibberish query returns nothing (no false positives).
assert((await search("zzzqqq nonsense xyzzy")).length === 0, "a nonsense query must return no matches");

// The category filter still works.
const terrain = await registry.invoke("skills.search", { query: "", category: "terrain" }, at);
const tnames = (terrain.result as { matches: { name: string }[] }).matches.map((m) => m.name);
assert(tnames.includes("vegetation.scatter") && tnames.includes("terrain.create"), "category:terrain must list the terrain skills");

ops.op_log(`[js] p67_skills_search OK: tokenized + stemmed search surfaces the right skill for real agent phrasings ('scatter trees', 'vegetation scatter', 'plant trees', 'scattering a forest', 'forest', 'move an entity'), ranks the best first, rejects gibberish, and keeps the category filter — the discovery miss that made the agent plant 89 trees one-by-one is fixed.`);
