// p12_surface — MCP progressive-disclosure surface management (Phase 12 Part A).
// Proves the BOOTSTRAP mode caps an agent's starting tool surface to the small core
// tier (so a 90+ skill catalog never floods the model's tool-reasoning window), while
// the full authorized catalog stays available on demand — and that grant-filtering
// narrows the core set to each profile's relevant verbs.

import { LiminaTracer } from "../src/observability/event.ts";
import { SkillRegistry } from "../src/skills/registry.ts";
import { registerCoreSkills } from "../src/skills/index.ts";
import { resolveProfile } from "../src/skills/permissions.ts";

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error("p12_surface FAIL: " + msg);
}

const registry = new SkillRegistry(new LiminaTracer("ses_surface"));
registerCoreSkills(registry);

const builder = resolveProfile("builder.readWrite");
const player = resolveProfile("player.limited");

const builderFull = registry.list(builder);
const builderBoot = registry.list(builder, { mode: "bootstrap" });
const playerBoot = registry.list(player, { mode: "bootstrap" });
const playerFull = registry.list(player);

const names = (ts: { name: string }[]) => new Set(ts.map((t) => t.name));
const bFull = names(builderFull), bBoot = names(builderBoot), pBoot = names(playerBoot), pFull = names(playerFull);

// (1) The full catalog is large (the whole Phase-12 surface), the bootstrap is small.
assert(builderFull.length >= 60, `builder full catalog should be large, got ${builderFull.length}`);
assert(builderBoot.length > 0 && builderBoot.length <= 15, `builder bootstrap must be small (<=15), got ${builderBoot.length}`);
assert(builderBoot.length < builderFull.length / 3, `bootstrap (${builderBoot.length}) must be a small fraction of full (${builderFull.length})`);

// (2) Bootstrap is a strict subset of the full authorized list, and every entry is core-tier.
for (const t of builderBoot) {
  assert(bFull.has(t.name), `bootstrap tool ${t.name} not in full list`);
  assert(t.priority === "core", `bootstrap tool ${t.name} must be priority=core, got ${t.priority}`);
}

// (3) Bootstrap contains the universal build verbs + discovery, and EXCLUDES deep/advanced ones.
for (const n of ["scene.createEntity", "world.generateRegion", "skills.search", "skills.browse"]) {
  assert(bBoot.has(n), `builder bootstrap missing core verb ${n}`);
}
for (const n of ["quest.define", "combat.melee", "progression.skillTree", "save.export"]) {
  assert(!bBoot.has(n) && bFull.has(n), `${n} should be discoverable-but-not-bootstrap for builder`);
}

// (4) Grant-filtering narrows the core set per profile: a player (no scene.write / no
//     terrain.generate) does NOT get the build-only core verbs, but DOES get the play ones.
assert(!pBoot.has("scene.createEntity"), "player bootstrap must not include scene.createEntity (no scene.write)");
assert(!pBoot.has("world.generateRegion"), "player bootstrap must not include world.generateRegion (no terrain.generate)");
for (const n of ["player.move", "interaction.interact", "skills.search"]) {
  assert(pBoot.has(n), `player bootstrap missing play verb ${n}`);
}
for (const t of playerBoot) {
  assert(pFull.has(t.name) && t.priority === "core", `player bootstrap ${t.name} invalid`);
}

// (5) Back-compat: no-arg list() and list(grants) (no opts) behave exactly as before.
assert(registry.list().length >= builderFull.length, "no-arg list() must return the full catalog");
assert(registry.list(builder).length === builderFull.length, "list(grants) without opts must be unchanged");

console.log(
  `p12_surface OK: bootstrap caps the surface — builder ${builderBoot.length} core vs ${builderFull.length} full; ` +
  `player ${playerBoot.length} core vs ${playerFull.length} full; bootstrap ⊆ full, all core-tier; ` +
  `grant-filtering drops build-only verbs for the player (no scene.createEntity/generateRegion), keeps play verbs; ` +
  `deep verbs (quest.define/combat.melee/save.export) discoverable but not in bootstrap.`,
);
