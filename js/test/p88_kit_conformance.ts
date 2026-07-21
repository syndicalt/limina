// P88 — the kit-composed building is ON-BRIEF (Slice 2). Assembles a cottage through the reworked
// assembleBuilding, harvests every part material (colour + roughness + metalness), and holds them
// against the active DesignDirection via the SAME style-conformance gate the design pipeline uses.
// A build whose surfaces stray outside the DD palette/envelope HARD-FAILS — so this proves the kit
// honours the declared art direction, not just that it renders.
//
// Run: ./target/release/limina js/test/p88_kit_conformance.ts   (exit 0 = pass)

import { EntityTable, ops, type EngineOps } from "../src/engine.ts";
import { createEcsWorld } from "../src/ecs/world.ts";
import { createTransformStorage } from "../src/ecs/facade.ts";
import { UniformGridSpatialIndex } from "../src/spatial/index.ts";
import { type BuildingRecipe, assembleBuilding } from "../src/skills/building-recipe.ts";
import { DEFAULT_DESIGN_DIRECTION, serializeDesignDirection } from "../src/game/design-direction.ts";
import type { WorldContext } from "../src/skills/registry.ts";
import { runStyleConformanceGate } from "../../gates/design/style-conformance-gate.mjs";

function assert(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new Error("p88_kit_conformance FAIL: " + msg);
}
function makeWorld(worldOps: EngineOps): WorldContext {
  const ecs = createEcsWorld();
  return {
    ecs, transforms: createTransformStorage(ecs), spatial: new UniformGridSpatialIndex(),
    entities: new EntityTable(), tags: new Map(), scene: { add() {}, remove() {} } as WorldContext["scene"],
    camera: {} as WorldContext["camera"], ops: worldOps, mode: "headless",
  } as WorldContext;
}

ops.op_physics_create_world(-9.81);

const COTTAGE: BuildingRecipe = {
  width: 8, depth: 6, height: 3.2, wallThickness: 0.25,
  openings: [
    { wall: "south", kind: "door", width: 1.4, height: 2.2, sill: 0 },
    { wall: "east", kind: "window", width: 1.3, height: 1.1, sill: 1.0 },
    { wall: "west", kind: "window", width: 1.3, height: 1.1, sill: 1.0 },
    { wall: "north", kind: "window", width: 1.6, height: 1.1, sill: 1.0 },
  ],
  roof: { type: "gable", pitch: 2.6, overhang: 0.5 },
  plinth: true,
};

const world = makeWorld(ops);
const built = assembleBuilding(COTTAGE, [0, 0, 0], world, { dd: DEFAULT_DESIGN_DIRECTION });
assert(built.parts.length > 10, `expected a full building, got ${built.parts.length} parts`);
assert(built.root !== undefined && built.root.length > 0, "building must have a root entity");

// Harvest every material (wall-panels carry a 2-material array: plaster + timber).
type Mat = { color: { getHex(): number }; roughness: number; metalness: number };
const samples: { label: string; colorHex: string; roughness01: number; metalness01: number }[] = [];
const hex = (n: number): string => "#" + n.toString(16).padStart(6, "0");
for (const p of built.parts) {
  const rec = (world.entities as unknown as { resolve(id: string): { mesh?: { material: Mat | Mat[] } } }).resolve(p.entity);
  const mesh = rec?.mesh;
  if (mesh === undefined) continue;
  const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
  for (const m of mats) {
    samples.push({ label: p.kind, colorHex: hex(m.color.getHex()), roughness01: m.roughness, metalness01: m.metalness });
  }
}
assert(samples.length >= built.parts.length, `harvested too few materials (${samples.length} for ${built.parts.length} parts)`);

const dd = JSON.parse(serializeDesignDirection(DEFAULT_DESIGN_DIRECTION));
const verdict = runStyleConformanceGate(dd, samples, {});
ops.op_log(`CONFORMANCE: ${samples.length} materials, pass=${verdict.pass} score=${verdict.score?.toFixed?.(3) ?? verdict.score} failures=${verdict.failures.length}`);
if (!verdict.pass) {
  for (const f of verdict.failures.slice(0, 8)) ops.op_log(`  FAIL ${f.gate}: ${f.detail}`);
}
assert(verdict.pass === true, `kit-composed building is OFF-BRIEF: ${verdict.failures.map((f: { detail: string }) => f.detail).join("; ")}`);

ops.op_log(`p88_kit_conformance OK: ${samples.length} kit materials across ${built.parts.length} parts all conform to "${DEFAULT_DESIGN_DIRECTION.id}" (palette + surface envelope).`);
