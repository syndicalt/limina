// P89 — a kit-composed building is a FIRST-CLASS, recorded, deterministic, snapshot-safe unit (Slice 3).
//
// Proves, through the REAL skill + worldlog machinery:
//   (A) RECORDED — building.assemble is a registered skill; invoking it writes the building-root with a
//       SELF-SUFFICIENT origin ({tool:"building.assemble", input: recipe+position}) and parents every
//       part under that root (one selectable/exportable unit).
//   (B) SNAPSHOT-SAFE — capture → JSON → parse preserves the root's origin AND each part's parent +
//       localOffset, so a bounded-tail viewer can rebuild the whole building by re-invoking the origin.
//   (C) RECOVERABLE + DETERMINISTIC — recoverWorld (restore snapshot, empty delta) reproduces the world
//       BIT-IDENTICALLY (transforms + physics bodies), the engine's real mid-stream recovery path.
//   (D) STAMPABLE — re-invoking building.assemble at a new position yields the SAME building translated
//       exactly (identical part count; bounds shifted by the offset) — the prefab-stamp property.
//
// Run: ./target/release/limina js/test/p89_building_recorded.ts   (exit 0 = pass)

import { ops, EntityTable, type WorldContext } from "../src/engine.ts";
import { createEcsWorld } from "../src/ecs/world.ts";
import { createTransformStorage } from "../src/ecs/facade.ts";
import { UniformGridSpatialIndex } from "../src/spatial/index.ts";
import { SkillRegistry } from "../src/skills/registry.ts";
import { registerCoreSkills } from "../src/skills/index.ts";
import { resolveProfile } from "../src/skills/permissions.ts";
import { LiminaTracer } from "../src/observability/event.ts";
import { captureWorldState, compareWorldState, installSeededRandom } from "../src/worldlog/log.ts";
import { captureWorldSnapshot, parseSnapshot, recoverWorld, serializeSnapshot } from "../src/worldlog/snapshot.ts";

function assert(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new Error("p89_building_recorded FAIL: " + msg);
}
function makeHeadlessWorld(): WorldContext {
  const ecs = createEcsWorld();
  const scene = { add() {}, remove() {}, position: { set() {}, x: 0, y: 0, z: 0 }, background: null as unknown };
  const camera = { position: { set() {} }, aspect: 1, lookAt() {}, updateProjectionMatrix() {} };
  return { ecs, transforms: createTransformStorage(ecs), spatial: new UniformGridSpatialIndex(), entities: new EntityTable(), tags: new Map(), scene, camera, ops, mode: "headless" } as WorldContext;
}
function makeRegistry(tracer: LiminaTracer): SkillRegistry {
  const registry = new SkillRegistry(tracer);
  registerCoreSkills(registry);
  return registry;
}

const perms = resolveProfile("builder.readWrite");
installSeededRandom(0xB01D);
ops.op_physics_create_world(-9.81);

const RECIPE = {
  position: [3, 0, -2] as [number, number, number],
  width: 8, depth: 6, height: 3.2,
  openings: [
    { wall: "south", kind: "door", width: 1.4, height: 2.2, sill: 0 },
    { wall: "east", kind: "window", width: 1.3, height: 1.1, sill: 1.0 },
    { wall: "north", kind: "window", width: 1.6, height: 1.1, sill: 1.0 },
  ],
  roof: { type: "gable", pitch: 2.6, overhang: 0.5 },
  seed: 11,
};

const world = makeHeadlessWorld();
const registry = makeRegistry(new LiminaTracer("ses_p89"));
const at = (tick: number) => ({ agentId: "agt_p89", sessionId: "ses_p89", permissions: perms, tick, world });

// ── (A) RECORDED — invoke the skill; root origin + parenting. ─────────────────────────────────────
const res = await registry.invoke("building.assemble", RECIPE, at(1));
assert(res.success === true, "building.assemble must succeed: " + JSON.stringify(res.error));
const out = res.result as { root: string; entities: string[]; entityCount: number; bounds: { min: number[]; max: number[] } };
assert(out.entityCount >= 12, `expected a full building, got ${out.entityCount} parts`);
const rootEntry = world.entities.resolve(out.root);
assert(rootEntry?.origin?.tool === "building.assemble", "root origin must be the building.assemble skill");
assert((rootEntry?.origin?.input as { width?: number }).width === 8, "root origin must carry the self-sufficient recipe (width)");
const children = (world.entities as unknown as { childrenOf(id: string): string[] }).childrenOf(out.root);
assert(children.length === out.entities.length, `every part must be parented under the root (${children.length} vs ${out.entities.length})`);
for (const p of out.entities) assert(world.entities.resolve(p)?.parent === out.root, `part ${p} must have the building-root as parent`);
ops.op_log(`(A) RECORDED OK — building.assemble → root ${out.root} + ${out.entityCount} parts, all parented; origin self-sufficient`);

const recordedState = captureWorldState(world);

// ── (B) SNAPSHOT-SAFE — origin + parent + localOffset survive capture → JSON → parse. ─────────────
const snap = captureWorldSnapshot(world, { sessionId: "ses_p89", tick: 10, snapshotSeq: registry.tracer.inspect().eventCount + 999 });
const parsed = parseSnapshot(serializeSnapshot(snap));
const pRoot = parsed.entities.find((e) => e.id === out.root)!;
assert(pRoot.origin?.tool === "building.assemble", "snapshot must preserve the root's building.assemble origin");
assert((pRoot.origin?.input as { height?: number }).height === 3.2, "snapshot origin must keep the recipe params (height)");
const pPart = parsed.entities.find((e) => e.id === out.entities[0])!;
assert(pPart.parent === out.root, "snapshot must preserve a part's parent");
assert(pPart.localOffset !== undefined && pPart.localOffset.pos.length === 3, "snapshot must preserve a part's localOffset");
ops.op_log(`(B) SNAPSHOT-SAFE OK — root origin + part parent/localOffset survive the JSON round-trip`);

// ── (C) RECOVERABLE + DETERMINISTIC — restore (empty delta) reproduces the world bit-identically. ──
const recovered = await recoverWorld(parsed, [], { makeWorld: makeHeadlessWorld, makeRegistry, tracer: new LiminaTracer("ses_p89_recover") });
const cmp = compareWorldState(recordedState, recovered.state);
assert(cmp.identical, "recovered world diverged from the original: " + JSON.stringify(cmp).slice(0, 240));
const rRoot = recovered.world.entities.resolve(out.root)?.origin;
assert(rRoot?.tool === "building.assemble", "recovered root must keep its building.assemble origin");
ops.op_log(`(C) RECOVERABLE OK — snapshot→recover is bit-identical (transforms + physics), origin restored`);

// ── (D) STAMPABLE — re-invoke at an offset → same building, translated exactly. ───────────────────
ops.op_physics_create_world(-9.81);
const w2 = makeHeadlessWorld();
const reg2 = makeRegistry(new LiminaTracer("ses_p89_stamp"));
const at2 = (tick: number) => ({ agentId: "agt_p89b", sessionId: "ses_p89b", permissions: perms, tick, world: w2 });
const OFF: [number, number, number] = [30, 0, 7];
const a = (await reg2.invoke("building.assemble", { ...RECIPE, position: [0, 0, 0] }, at2(1))).result as typeof out;
const b = (await reg2.invoke("building.assemble", { ...RECIPE, position: OFF }, at2(2))).result as typeof out;
assert(a.entityCount === b.entityCount, `stamp must have the same part count (${a.entityCount} vs ${b.entityCount})`);
for (let i = 0; i < 3; i++) {
  assert(Math.abs((b.bounds.min[i] - a.bounds.min[i]) - OFF[i]) < 1e-4, `stamp bounds.min[${i}] must shift by ${OFF[i]}`);
  assert(Math.abs((b.bounds.max[i] - a.bounds.max[i]) - OFF[i]) < 1e-4, `stamp bounds.max[${i}] must shift by ${OFF[i]}`);
}
ops.op_log(`(D) STAMPABLE OK — re-invoked at +${JSON.stringify(OFF)}: identical ${b.entityCount}-part building, bounds shifted exactly`);

ops.op_log("p89_building_recorded OK: building.assemble is a recorded, snapshot-safe, bit-identically recoverable, stampable first-class unit.");
