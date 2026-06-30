// asset.place GROUNDING + NORMALIZE gate (the guard that makes "half-sunk asset" impossible to ship).
//
// Verifies BY MEASUREMENT — independently of asset.place's own returned bounds — that a placed asset's
// BASE lands at position.y (not its centred glTF origin), at any height; that ground:false leaves it
// ungrounded (falsifiable: proves grounding does something); that normalizeHeight scales to a target;
// and that the returned meta.bounds matches the measured world size.
//
// Run: ./target/release/limina js/test/p18_place_grounding.ts   (exit 0 = pass)

import * as THREE from "../build/three.bundle.mjs";
import { EntityTable, ops, type EngineOps } from "../src/engine.ts";
import { createEcsWorld, renderSyncSystem } from "../src/ecs/world.ts";
import { createTransformStorage } from "../src/ecs/facade.ts";
import { UniformGridSpatialIndex } from "../src/spatial/index.ts";
import { LiminaTracer } from "../src/observability/event.ts";
import { SkillRegistry, type WorldContext } from "../src/skills/registry.ts";
import { registerCoreSkills } from "../src/skills/index.ts";
import { resolveProfile } from "../src/skills/permissions.ts";

function assert(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new Error("p18_place_grounding FAIL: " + msg);
}
function makeWorld(worldOps: EngineOps): WorldContext {
  const scene = { add() {}, remove() {}, position: { set() {}, x: 0, y: 0, z: 0 }, background: null as unknown };
  const camera = { position: { set() {} }, aspect: 1, lookAt() {}, updateProjectionMatrix() {} };
  const ecs = createEcsWorld();
  return { ecs, transforms: createTransformStorage(ecs), spatial: new UniformGridSpatialIndex(), entities: new EntityTable(), tags: new Map(), scene, camera, ops: worldOps, mode: "headless" } as WorldContext;
}

ops.op_physics_create_world(0);
// A CENTRED-origin asset (origin at its middle, not its base) — so grounding genuinely moves it and the
// guard can FALSIFY a broken grounding. This is the very Poly Pizza barrel that exposed the half-sunk
// bug. Fixture license: CC-BY-3.0, "Barrel" by Thomas de Rivaz (https://poly.pizza/m/1ifoWzoNxLF).
const ASSET = "test-barrel-centered.glb";
const PERMS = resolveProfile("builder.readWrite");
const EPS = 0.05;

/** Place ASSET and return both the skill's reported bounds and the INDEPENDENTLY measured world AABB. */
async function placeAndMeasure(input: Record<string, unknown>): Promise<{ bounds: number[]; box: THREE.Box3 }> {
  const world = makeWorld(ops);
  const reg = new SkillRegistry(new LiminaTracer("p18"));
  registerCoreSkills(reg);
  const res = await reg.invoke("asset.place", { assetId: ASSET, ...input }, { agentId: "a", sessionId: "p18", permissions: PERMS, tick: 0, world });
  if (!res.success) throw new Error("asset.place failed: " + JSON.stringify(res.error));
  const out = res.result as { entity: string; bounds: number[] };
  const rec = (world.entities as unknown as { resolve(id: string): { mesh: THREE.Object3D } }).resolve(out.entity);
  renderSyncSystem(world.ecs);
  rec.mesh.updateMatrixWorld(true);
  return { bounds: out.bounds, box: new THREE.Box3().setFromObject(rec.mesh) };
}

// ── 1. Grounded (default): base sits at position.y, at any height. ───────────────────────────────
for (const y of [0, 5, 12.5]) {
  const { bounds, box } = await placeAndMeasure({ position: [0, y, 0] });
  ops.op_log(`GROUND y=${y}: measured baseY=${box.min.y.toFixed(3)} (want ${y}) bounds=[${bounds.map((v) => v.toFixed(2)).join(",")}]`);
  assert(Math.abs(box.min.y - y) < EPS, `base must sit at position.y=${y} (got ${box.min.y.toFixed(3)})`);
  // the skill's reported bounds must match the independently measured size
  const measured = [box.max.x - box.min.x, box.max.y - box.min.y, box.max.z - box.min.z];
  for (let k = 0; k < 3; k++) assert(Math.abs(bounds[k] - measured[k]) < EPS, `reported bounds[${k}] ${bounds[k].toFixed(3)} != measured ${measured[k].toFixed(3)}`);
}

// ── 2. ground:false leaves it UNGROUNDED (falsifiable — proves grounding is doing the work). ─────
{
  const grounded = await placeAndMeasure({ position: [0, 5, 0] });
  const raw = await placeAndMeasure({ position: [0, 5, 0], ground: false });
  assert(Math.abs(grounded.box.min.y - 5) < EPS, "grounded base should be at 5");
  assert(Math.abs(raw.box.min.y - 5) > EPS, `ground:false must NOT land the base at position.y (got ${raw.box.min.y.toFixed(3)} — is the origin already at the base? pick a centred asset)`);
}

// ── 3. normalizeHeight scales the asset to the target world height (then still grounds). ─────────
{
  const target = 3;
  const { box } = await placeAndMeasure({ position: [0, 0, 0], normalizeHeight: target });
  const h = box.max.y - box.min.y;
  ops.op_log(`NORMALIZE: height=${h.toFixed(3)} (want ${target}) baseY=${box.min.y.toFixed(3)}`);
  assert(Math.abs(h - target) < EPS, `normalizeHeight must scale to ${target} m (got ${h.toFixed(3)})`);
  assert(Math.abs(box.min.y - 0) < EPS, "normalized asset must still be grounded at position.y=0");
}

ops.op_log("p18_place_grounding OK: asset.place lands the BASE at position.y at any height (measured independently), reports matching bounds, ground:false leaves it ungrounded, and normalizeHeight scales to a target world size + re-grounds.");
