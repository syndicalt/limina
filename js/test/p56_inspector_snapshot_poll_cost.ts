// P56 — inspector.snapshot per-poll cost controls. A high-frequency observer (the live
// editor) can opt OUT of the two blocks that don't scale with poll rate: the O(all-entities)
// resource scan and the static skill catalog. The flags DEFAULT to true, so the observability
// contract is byte-for-byte unchanged for every existing caller; only an explicit opt-out
// trims the payload. Entities (the page) are ALWAYS returned so the World panel still renders.

import { ops } from "../src/engine.ts";
import { resolveProfile } from "../src/skills/permissions.ts";
import type { MCPResponse } from "../src/mcp/protocol.ts";
import { createHeadlessContext } from "../src/game/index.ts";

function assert(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new Error("p56_inspector_snapshot_poll_cost: " + msg);
}

const ctx = createHeadlessContext({ session: "ses_p56" });
const registry = ctx.registry;
const world = ctx.world;
ops.op_physics_create_world(-9.81);
const perms = resolveProfile("builder.readWrite");
const at = (tick: number) => ({ agentId: "agt_p56", sessionId: "ses_p56", permissions: perms, tick, world });

// A couple of entities so the page + resource scan have something to report.
await registry.invoke("scene.createEntity", { position: [0, 1, 0] }, at(1));
await registry.invoke("scene.createEntity", { position: [2, 0, 2] }, at(2));

type Snap = {
  page: { totalEntities: number };
  entities: unknown[];
  skills: unknown[];
  resources: { loaded: unknown[]; counts: Record<string, number> };
};
const snapOf = (r: MCPResponse): Snap => r.result as Snap;

// DEFAULT (no flags) — full observability contract: skills catalog present, resources block scanned.
const full = snapOf(await registry.invoke("inspector.snapshot", {}, at(3)));
assert(full.skills.length > 0, "default snapshot must include the full skill catalog");
assert(Array.isArray(full.resources.loaded), "default snapshot must include the resources.loaded array");
assert(full.entities.length === 2, "default snapshot must page the entities");
assert(full.page.totalEntities === 2, "default snapshot totalEntities");

// OPT-OUT — the routine editor poll: skills catalog and resource scan both dropped, but the
// entity page (what the World panel renders) is untouched.
const lean = snapOf(await registry.invoke("inspector.snapshot", { includeResources: false, includeSkills: false }, at(4)));
assert(lean.skills.length === 0, "includeSkills:false must drop the skill catalog");
assert(lean.resources.loaded.length === 0, "includeResources:false must drop the O(N) resource scan");
assert((lean.resources.counts.total ?? 0) === 0, "includeResources:false must report zero scanned resources");
assert(lean.entities.length === 2, "lean snapshot must STILL return the entity page");
assert(lean.page.totalEntities === 2, "lean snapshot still reports totalEntities");

// Mixed: skip resources only (keep the catalog) — the flags are independent.
const mixed = snapOf(await registry.invoke("inspector.snapshot", { includeResources: false }, at(5)));
assert(mixed.skills.length > 0, "includeSkills defaults true when only includeResources is set");
assert(mixed.resources.loaded.length === 0, "includeResources:false honored independently");

ops.op_log("[js] p56_inspector_snapshot_poll_cost OK: opt-out flags trim skills+resources while entities always page; defaults preserve the full contract");
