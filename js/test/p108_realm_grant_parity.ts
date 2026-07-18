// p108 — REALM DEFAULT-GRANT PARITY (Chunk C, editor-engine-foundation).
//
// THE BUG THIS GATE PINS: the two execution realms replay the SAME command log
// with default grant sets from TWO hand-maintained sources — the render realm
// resolved `builder.readWrite` while the sim worker kept a private DEFAULT_GRANTS
// copy that had drifted: it granted permission strings that DO NOT EXIST in the
// skill catalog ("terrain.write", "ecs.write", "three.write", "three.read",
// "asset.write", "material.write", "audio.write") and MISSED real ones — above
// all "terrain.generate", so the worker DENIED terrain.generate skills the
// render realm allowed, forking the realms on replay.
//
// THE FIX UNDER TEST: both realms derive from ONE source
// (`REALM_DEFAULT_PROFILE` in skills/permissions.ts): browser-entry.ts resolves
// it, sim-worker.ts's exported DEFAULT_GRANTS is `realmDefaultGrants()`. Any
// DECIDED asymmetry must be listed in `REALM_GRANT_ALLOWED_ASYMMETRY` (empty
// today); anything else is drift and FAILS here.
//
// PROOF SHAPE:
//   1. PARITY — symmetric difference between the worker's DEFAULT_GRANTS and
//      the render realm's default (resolveProfile(REALM_DEFAULT_PROFILE)) is a
//      subset of the documented allowlist.
//   2. SKILL-LEVEL PARITY — every registered core skill is invokable (grants
//      cover its required permissions) in BOTH realms or NEITHER; failure output
//      names the forked skills.
//   3. REGRESSION PIN — "terrain.generate" + "ecs.modify" are granted; the
//      seven drifted nonexistent names are NOT.
//   4. KNOWN-UNIVERSE — every granted permission string is REQUIRED by at least
//      one registered skill (core catalog + the authoring-runtime pair), so a
//      hand-typed grant naming a permission no skill checks can never ride along
//      silently again.
//   5. FALSIFIABILITY — a synthetic extra grant on either side fails leg 1's
//      comparator; a synthetic removal fails it; a bogus permission name fails
//      leg 4's comparator.
//
// Run: LIMINA_AUDIO=null ./target/release/limina js/test/p108_realm_grant_parity.ts

import { DEFAULT_GRANTS } from "../src/browser/sim-worker.ts";
import { REALM_DEFAULT_PROFILE, REALM_GRANT_ALLOWED_ASYMMETRY, resolveProfile } from "../src/skills/permissions.ts";
import { SkillRegistry } from "../src/skills/registry.ts";
import { registerCoreSkills } from "../src/skills/index.ts";
import { LiminaTracer } from "../src/observability/event.ts";
import { ops } from "../src/engine.ts";
import type { AssetRegistry } from "../src/asset-registry.ts";

function assert(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new Error("p108_realm_grant_parity FAIL: " + msg);
}

// ── the comparators under test (pure, so the falsifiability legs can drive them
//    with synthetic inputs — the REAL legs and the falsification run the SAME code)

/** Undocumented asymmetries between two grant sets (symmetric difference minus
 *  the documented allowlist). Empty ⇔ the realms agree. */
function undocumentedAsymmetries(a: ReadonlySet<string>, b: ReadonlySet<string>, allowed: ReadonlySet<string>): string[] {
  const out: string[] = [];
  for (const g of a) if (!b.has(g) && !allowed.has(g)) out.push(`only-in-first: ${g}`);
  for (const g of b) if (!a.has(g) && !allowed.has(g)) out.push(`only-in-second: ${g}`);
  return out.sort();
}

/** Granted permission strings NO skill in the universe requires (drift toward
 *  nonexistent names — how "terrain.write" shipped). */
function unknownGrants(grants: ReadonlySet<string>, universe: ReadonlySet<string>): string[] {
  return [...grants].filter((g) => !universe.has(g)).sort();
}

// ═════════ Leg 1 — realm parity ═════════

const workerGrants = DEFAULT_GRANTS;
const renderGrants = resolveProfile(REALM_DEFAULT_PROFILE);
assert(renderGrants.size > 0, `REALM_DEFAULT_PROFILE '${REALM_DEFAULT_PROFILE}' must resolve to a non-empty profile`);

const drift = undocumentedAsymmetries(workerGrants, renderGrants, REALM_GRANT_ALLOWED_ASYMMETRY);
assert(drift.length === 0,
  `worker/render default grants have UNDOCUMENTED asymmetries (first=worker, second=render):\n  ${drift.join("\n  ")}\n` +
  "Either re-derive both sides from REALM_DEFAULT_PROFILE or document the decision in REALM_GRANT_ALLOWED_ASYMMETRY.");

// ═════════ Leg 2 — skill-level invokability parity ═════════

const stubAssets = { resolve: (id: string): never => { throw new Error(`p108 stub assets: ${id}`); } } as unknown as AssetRegistry;
const registry = new SkillRegistry(LiminaTracer.ephemeral("ses_p108"));
registerCoreSkills(registry, { assets: stubAssets });

const skillNames = registry.list().map((t) => t.name);
assert(skillNames.length > 100, `expected the full core catalog, got ${skillNames.length} skills`);
const forked: string[] = [];
for (const name of skillNames) {
  const def = registry.describe(name);
  assert(def !== undefined, `describe('${name}') must exist`);
  const inWorker = [...def.permissions].every((p) => workerGrants.has(p));
  const inRender = [...def.permissions].every((p) => renderGrants.has(p));
  if (inWorker !== inRender) forked.push(`${name} (worker=${inWorker} render=${inRender})`);
}
assert(forked.length === 0, `skills invokable in exactly ONE realm under default grants:\n  ${forked.join("\n  ")}`);

// ═════════ Leg 3 — regression pin (the exact drift that shipped) ═════════

for (const real of ["terrain.generate", "ecs.modify", "scene.write", "audio.play"]) {
  assert(workerGrants.has(real), `worker default grants must include '${real}' (the drifted list denied it)`);
}
for (const bogus of ["terrain.write", "ecs.write", "three.write", "three.read", "asset.write", "material.write", "audio.write"]) {
  assert(!workerGrants.has(bogus), `'${bogus}' is not a permission any skill requires — the drifted hand-kept list granted it`);
}

// ═════════ Leg 4 — known-universe: every grant is a permission some skill requires ═════════

const universe = new Set<string>();
for (const name of skillNames) for (const p of registry.describe(name)!.permissions) universe.add(p);
// Permissions required by skills registered OUTSIDE registerCoreSkills but still
// part of this profile's reach — each entry names its registration site, so a
// grant can only join this list with a real skill behind it:
//   authoring.read/write — authoring/skills.ts registerAuthoringSkills, installed
//     per-project in BOTH realms via AuthoringProjectBinding;
//   catalog.read — skills/asset-catalog.ts registerAssetCatalogSkills, installed
//     server-side by editor_host.ts (the catalog is not render/sim state).
universe.add("authoring.read");
universe.add("authoring.write");
universe.add("catalog.read");

const unknownWorker = unknownGrants(workerGrants, universe);
assert(unknownWorker.length === 0, `worker default grants name permissions NO skill requires: ${unknownWorker.join(", ")}`);
const unknownRender = unknownGrants(renderGrants, universe);
assert(unknownRender.length === 0, `render default grants name permissions NO skill requires: ${unknownRender.join(", ")}`);

// ═════════ Leg 5 — FALSIFIABILITY: synthetic drift must FAIL the comparators ═════════

{
  // (a) an extra grant on one side (the "someone adds a grant to one realm" edit).
  const extra = new Set(workerGrants);
  extra.add("synthetic.extraGrant");
  assert(undocumentedAsymmetries(extra, renderGrants, REALM_GRANT_ALLOWED_ASYMMETRY).length === 1,
    "FALSIFIABILITY DEAD: a synthetic extra grant on the worker side must register as an asymmetry");
  // (b) a removal on one side (the "someone deletes a grant from one realm" edit).
  const missing = new Set(workerGrants);
  missing.delete("terrain.generate");
  assert(undocumentedAsymmetries(missing, renderGrants, REALM_GRANT_ALLOWED_ASYMMETRY).length === 1,
    "FALSIFIABILITY DEAD: removing terrain.generate from the worker side must register as an asymmetry");
  // (c) the allowlist genuinely excuses a DOCUMENTED difference (the escape hatch works,
  //     so documented decisions don't fail the gate).
  assert(undocumentedAsymmetries(extra, renderGrants, new Set([...REALM_GRANT_ALLOWED_ASYMMETRY, "synthetic.extraGrant"])).length === 0,
    "the documented-asymmetry allowlist must excuse exactly the listed grant");
  // (d) a bogus permission name must fail the known-universe comparator.
  const bogus = new Set(workerGrants);
  bogus.add("terrain.write");
  assert(unknownGrants(bogus, universe).length === 1,
    "FALSIFIABILITY DEAD: a grant naming a permission no skill requires must fail the known-universe check");
}

ops.op_log(
  "p108_realm_grant_parity OK: " +
    `worker DEFAULT_GRANTS ≡ render resolveProfile('${REALM_DEFAULT_PROFILE}') (${workerGrants.size} grants, ` +
    `${REALM_GRANT_ALLOWED_ASYMMETRY.size} documented asymmetries), ${skillNames.length} skills invokability-parity clean, ` +
    "regression pins hold, every grant maps to a required permission; synthetic drift demonstrably fails.",
);
