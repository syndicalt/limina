// Phase 10 chunk A+B — least-privilege EXPOSURE + dynamic bundles (headless).
// An agent/session only SEES the skills it could invoke; the meta-skills filter by
// the caller's grants; bundles override profiles; and the no-arg path is unchanged
// (the back-compat regression guard).

import { EntityTable, ops } from "../src/engine.ts";
import { createEcsWorld } from "../src/ecs/world.ts";
import { LiminaTracer } from "../src/observability/event.ts";
import { SkillRegistry, type WorldContext } from "../src/skills/registry.ts";
import { registerCoreSkills } from "../src/skills/index.ts";
import { resolveProfile } from "../src/skills/permissions.ts";
import { agentGrants } from "../src/agents/agent.ts";

function assert(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new Error("p10_exposure FAIL: " + msg);
}

const scene = { add() {}, remove() {}, position: { set() {}, x: 0, y: 0, z: 0 }, background: null as unknown };
const camera = { position: { set() {} }, aspect: 1, lookAt() {}, updateProjectionMatrix() {} };
const world: WorldContext = { ecs: createEcsWorld(), entities: new EntityTable(), tags: new Map(), scene, camera, ops };

const tracer = new LiminaTracer("ses_p10");
const registry = new SkillRegistry(tracer);
registerCoreSkills(registry);

const full = registry.list();
const fullNames = new Set(full.map((t) => t.name));
assert(fullNames.has("scene.createEntity") && fullNames.has("scene.queryEntities") && fullNames.has("skills.list"), "core skills registered");

// 1. Back-compat: no-arg list() is the FULL catalog (inspection surface / legacy).
assert(registry.list().length === full.length, "no-arg list must remain the full catalog");

// 2. Least-privilege filtering — player.limited sees reads + universal introspection,
//    NOT writes / generate / privileged skills.
const player = resolveProfile("player.limited");
const pNames = new Set(registry.list(player).map((t) => t.name));
assert(pNames.has("scene.queryEntities"), "player should see scene.queryEntities (scene.read)");
assert(pNames.has("skills.list"), "player should see skills.list (no required perms)");
assert(!pNames.has("scene.createEntity"), "player must NOT see scene.createEntity (scene.write)");
assert(!pNames.has("world.generateRegion"), "player must NOT see world.generateRegion (terrain.generate)");
assert(pNames.size < fullNames.size, "player's advertised set must be a strict subset of the catalog");
// EVERY advertised skill is actually invocable by the caller (exposure == invocation boundary).
for (const t of registry.list(player)) {
  const def = registry.describe(t.name);
  assert(def !== undefined && def.permissions.every((p) => player.has(p)), `advertised ${t.name} is not invocable by player`);
}

// 3. builder.readWrite sees the build skills.
assert(new Set(registry.list(resolveProfile("builder.readWrite")).map((t) => t.name)).has("scene.createEntity"), "builder should see scene.createEntity");

// 4. Dynamic bundle: a custom least-privilege set, independent of any profile.
const bundle = new Set(["scene.read"]);
const bNames = new Set(registry.list(bundle).map((t) => t.name));
assert(bNames.has("scene.queryEntities") && bNames.has("skills.list"), "a scene.read bundle sees reads + no-perm skills");
assert(!bNames.has("scene.createEntity"), "a scene.read-only bundle must not see scene.write skills");

// 5. agentGrants: bundle overrides profile; absent -> profile grants.
assert(agentGrants({ profile: "player.limited", bundle }) === bundle, "agentGrants must use the bundle when present");
const viaProfile = agentGrants({ profile: "player.limited" });
assert(viaProfile.has("scene.read") && !viaProfile.has("scene.write"), "agentGrants must fall back to the profile when no bundle");

// 6. Meta-skills filter by the CALLER's grants (invoke as a player.limited session).
const inv = (tool: string, input: unknown) => registry.invoke(tool, input, { agentId: "agt", sessionId: "ses_p10", permissions: player, profile: "player.limited", tick: 0, world });
const listed = await inv("skills.list", {});
assert(listed.success, "skills.list invoke failed");
const listedNames = new Set((listed.result as { tools: { name: string }[] }).tools.map((t) => t.name));
assert(listedNames.has("scene.queryEntities") && !listedNames.has("scene.createEntity"), "skills.list must reflect the caller's grants");

const descLeak = await inv("skills.describe", { name: "scene.createEntity" });
assert(!descLeak.success, "skills.describe of an UNauthorized skill must fail (no catalog leak)");
const descOk = await inv("skills.describe", { name: "scene.queryEntities" });
assert(descOk.success, "skills.describe of an authorized skill must work");

const searched = await inv("skills.search", { query: "scene" });
assert(searched.success, "skills.search invoke failed");
const matches = (searched.result as { matches: { name: string }[] }).matches.map((m) => m.name);
assert(matches.includes("scene.queryEntities") && !matches.includes("scene.createEntity"), "skills.search must return only authorized matches");

ops.op_log(`p10_exposure OK: full catalog ${fullNames.size}; player sees ${pNames.size} (reads+introspection, no writes/generate); bundle scoping + agentGrants override; skills.list/describe/search filter by caller; no-arg list unchanged.`);
