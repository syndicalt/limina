// Phase 15 (Track B — Eyes) — THE PERCEPTION GATE for scene.inspect.
//
// scene.inspect is the perception substrate of the self-correction loop: a structured,
// whole-scene summary an agent reads to reason about WHAT IT BUILT before rendering a pixel.
// This gate proves it reports the truth: entity count, world AABB (min/max/center/size), a
// global tag census, a position sample, tag filtering, and the empty-scene case.
//
// Run: ./target/release/limina js/test/p15_perception.ts   (exit 0 = pass)

import { EntityTable, ops, type EngineOps } from "../src/engine.ts";
import { createEcsWorld } from "../src/ecs/world.ts";
import { createTransformStorage } from "../src/ecs/facade.ts";
import { UniformGridSpatialIndex } from "../src/spatial/index.ts";
import { LiminaTracer } from "../src/observability/event.ts";
import { SkillRegistry, type InvokeBase, type WorldContext } from "../src/skills/registry.ts";
import { registerCoreSkills } from "../src/skills/index.ts";
import { resolveProfile } from "../src/skills/permissions.ts";
import type { MCPResponse } from "../src/mcp/protocol.ts";

function assert(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new Error("p15_perception FAIL: " + msg);
}
function unwrap(label: string, res: MCPResponse | undefined): Record<string, unknown> {
  if (res === undefined || !res.success) throw new Error(`p15_perception: ${label} failed: ${JSON.stringify(res?.error ?? "no response")}`);
  return (res.result ?? {}) as Record<string, unknown>;
}
function makeWorld(worldOps: EngineOps): WorldContext {
  const scene = { add() {}, remove() {}, position: { set() {}, x: 0, y: 0, z: 0 }, background: null as unknown };
  const camera = { position: { set() {} }, aspect: 1, lookAt() {}, updateProjectionMatrix() {} };
  const ecs = createEcsWorld();
  return {
    ecs, transforms: createTransformStorage(ecs), spatial: new UniformGridSpatialIndex(),
    entities: new EntityTable(), tags: new Map(), scene: scene as WorldContext["scene"],
    camera: camera as WorldContext["camera"], ops: worldOps, mode: "headless",
  };
}

const PERMS = resolveProfile("builder.readWrite");
ops.op_physics_create_world(-9.81);
const reg = new SkillRegistry(new LiminaTracer("ses_p15_perception"));
registerCoreSkills(reg);
const world = makeWorld(ops);
const base: InvokeBase = { agentId: "agt_p15", sessionId: "ses_p15", permissions: PERMS, tick: 0, world };

// ── Empty scene: honest nulls, not a crash or a fake AABB. ───────────────────────────────────
{
  const r = unwrap("inspect(empty)", await reg.invoke("scene.inspect", {}, base));
  assert(r.entityCount === 0, `empty scene reports 0 entities (got ${r.entityCount})`);
  assert(r.bounds === null, "empty scene reports null bounds");
  assert(r.center === null && r.size === null, "empty scene reports null center/size");
  assert(JSON.stringify(r.tagCounts) === "{}", "empty scene has no tags");
  assert(Array.isArray(r.sample) && (r.sample as unknown[]).length === 0, "empty scene sample is empty");
}

// ── Three entities at known positions; tag two of them. ───────────────────────────────────────
const a = unwrap("createEntity(a)", await reg.invoke("scene.createEntity", { shape: "box", position: [0, 0, 0] }, base)).entity as string;
const b = unwrap("createEntity(b)", await reg.invoke("scene.createEntity", { shape: "box", position: [10, 2, -4] }, base)).entity as string;
const c = unwrap("createEntity(c)", await reg.invoke("scene.createEntity", { shape: "sphere", position: [-6, 1, 8] }, base)).entity as string;
const eidA = world.entities.resolve(a)?.eid;
const eidB = world.entities.resolve(b)?.eid;
assert(eidA !== undefined && eidB !== undefined, "created entities resolve to eids");
world.tags.set(eidA, new Set(["relic"]));
world.tags.set(eidB, new Set(["relic", "key"]));
void c;

{
  const r = unwrap("inspect(populated)", await reg.invoke("scene.inspect", {}, base));
  assert(r.entityCount === 3, `inspect reports 3 entities (got ${r.entityCount})`);
  const bounds = r.bounds as { min: number[]; max: number[] };
  assert(bounds.min[0] === -6 && bounds.max[0] === 10, `X AABB spans -6..10 (got ${bounds.min[0]}..${bounds.max[0]})`);
  assert(bounds.min[1] === 0 && bounds.max[1] === 2, `Y AABB spans 0..2 (got ${bounds.min[1]}..${bounds.max[1]})`);
  assert(bounds.min[2] === -4 && bounds.max[2] === 8, `Z AABB spans -4..8 (got ${bounds.min[2]}..${bounds.max[2]})`);
  const center = r.center as number[];
  const size = r.size as number[];
  assert(center[0] === 2, `center X = (−6+10)/2 = 2 (got ${center[0]})`);
  assert(size[0] === 16, `size X = 16 (got ${size[0]})`);
  const tags = r.tagCounts as Record<string, number>;
  assert(tags.relic === 2 && tags.key === 1, `tag census relic=2 key=1 (got relic=${tags.relic} key=${tags.key})`);
  const sample = r.sample as { entity: string }[];
  assert(sample.length === 3, `sample includes all 3 entities under the default sampleSize (got ${sample.length})`);
}

// ── Tag filter narrows the AABB/sample to the matching set (census stays global). ─────────────
{
  const r = unwrap("inspect(tag=relic)", await reg.invoke("scene.inspect", { tag: "relic" }, base));
  assert(r.entityCount === 2, `tag filter 'relic' reports 2 entities (got ${r.entityCount})`);
  const tags = r.tagCounts as Record<string, number>;
  assert(tags.relic === 2 && tags.key === 1, "tag census remains global under a filter");
}

// ── sampleSize bounds the sample without changing the count. ──────────────────────────────────
{
  const r = unwrap("inspect(sampleSize=1)", await reg.invoke("scene.inspect", { sampleSize: 1 }, base));
  assert(r.entityCount === 3, "count unaffected by sampleSize");
  assert((r.sample as unknown[]).length === 1, "sampleSize caps the sample length");
}

ops.op_log(
  "p15_perception OK: scene.inspect reports truthful perception — empty scene → null bounds; " +
  "3 entities → exact world AABB/center/size; global tag census (relic=2, key=1); tag filter narrows the set; " +
  "sampleSize bounds the sample. The agent's 'eyes' for self-checking an authored world (no GPU needed).",
);
