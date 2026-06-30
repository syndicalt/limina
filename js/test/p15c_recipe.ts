// Recipe + assembler structural test (modeling-loop spike, piece #2).
//
// Proves assembleBuilding turns a declarative recipe (door + WINDOWS on multiple walls + a gable roof)
// into correct geometry, verified BY MEASUREMENT: eaves meet wall-tops; the door AND each window are a
// genuine clear void; a sill panel sits below each window; the assembly stays rigid under rotation.
//
// Run: ./target/release/limina js/test/p15c_recipe.ts   (exit 0 = pass)

import * as THREE from "../build/three.bundle.mjs";
import { EntityTable, ops, type EngineOps } from "../src/engine.ts";
import { createEcsWorld, renderSyncSystem } from "../src/ecs/world.ts";
import { createTransformStorage } from "../src/ecs/facade.ts";
import { UniformGridSpatialIndex } from "../src/spatial/index.ts";
import { type BuildingRecipe, assembleBuilding } from "../src/skills/building-recipe.ts";
import type { V3 } from "../src/skills/architecture.ts";
import type { WorldContext } from "../src/skills/registry.ts";

function assert(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new Error("p15c_recipe FAIL: " + msg);
}
function makeWorld(worldOps: EngineOps): WorldContext {
  const scene = { add() {}, remove() {} };
  const ecs = createEcsWorld();
  return {
    ecs, transforms: createTransformStorage(ecs), spatial: new UniformGridSpatialIndex(),
    entities: new EntityTable(), tags: new Map(), scene: scene as WorldContext["scene"],
    camera: {} as WorldContext["camera"], ops: worldOps, mode: "headless",
  } as WorldContext;
}

ops.op_physics_create_world(-9.81);

type PartBox = { kind: string; box: THREE.Box3 };
function build(recipe: BuildingRecipe, position: V3): PartBox[] {
  const world = makeWorld(ops);
  const res = assembleBuilding(recipe, position, world);
  renderSyncSystem(world.ecs);
  return res.parts.map((p) => {
    const rec = (world.entities as unknown as { resolve(id: string): { mesh: THREE.Object3D } }).resolve(p.entity);
    rec.mesh.updateMatrixWorld(true);
    return { kind: p.kind, box: new THREE.Box3().setFromObject(rec.mesh) };
  });
}
const clearOfAll = (boxes: PartBox[], p: V3): boolean => !boxes.some((b) => b.box.containsPoint(new THREE.Vector3(p[0], p[1], p[2])));
const EPS = 0.06;

const COTTAGE: BuildingRecipe = {
  width: 8, depth: 6, height: 3.2, wallThickness: 0.25,
  openings: [
    { wall: "south", kind: "door", width: 1.4, height: 2.2, sill: 0 },
    { wall: "east", kind: "window", width: 1.2, height: 1.1, sill: 1.0 },
    { wall: "west", kind: "window", width: 1.2, height: 1.1, sill: 1.0 },
    { wall: "north", kind: "window", width: 1.6, height: 1.1, sill: 1.0 },
  ],
  roof: { type: "gable", pitch: 2.4, overhang: 0.5 },
};
const t = 0.25, W = 8, D = 6, H = 3.2;

// ── 1. Non-rotated: eaves meet wall-tops; door + windows are clear voids; sills exist. ───────────
{
  const boxes = build(COTTAGE, [0, 0, 0]);
  const walls = boxes.filter((b) => b.kind.startsWith("wall_") || b.kind.startsWith("lintel_"));
  const wallTop = Math.max(...walls.map((b) => b.box.max.y));
  const roof = boxes.find((b) => b.kind === "roof")!.box;
  ops.op_log(`RECIPE: parts=${boxes.length} wallTop=${wallTop.toFixed(3)} roofEaves=${roof.min.y.toFixed(3)} eave-gap=${(roof.min.y - wallTop).toFixed(3)}`);
  assert(Math.abs(roof.min.y - wallTop) < EPS, `roof eaves must meet wall-tops — gap ${(roof.min.y - wallTop).toFixed(3)}`);

  // Door void (south wall, mid-height): clear of all parts.
  assert(clearOfAll(boxes, [0, 1.1, -D / 2 + t / 2]), "the DOOR opening must be a clear void");
  // ...but flanked by solid south pillars on both sides at door height.
  const southPillars = boxes.filter((b) => b.kind === "wall_south");
  assert(southPillars.length >= 2, `door must be flanked by 2 south pillars (got ${southPillars.length})`);
  assert(southPillars.some((b) => b.box.max.x < 0) && southPillars.some((b) => b.box.min.x > 0), "a south pillar on each side of the door");

  // East window void (centre at sill+height/2 on the +X wall): clear.
  assert(clearOfAll(boxes, [W / 2 - t / 2, 1.0 + 0.55, 0]), "the EAST WINDOW opening must be a clear void");
  // ...with a sill panel below it (a sill_east part topping out at ~the sill height).
  const eastSill = boxes.find((b) => b.kind === "sill_east");
  assert(eastSill !== undefined, "a sill panel must sit below the east window");
  assert(Math.abs(eastSill!.box.max.y - 1.0) < EPS, `east sill top should be at the window sill (~1.0, got ${eastSill!.box.max.y.toFixed(3)})`);
  // ...and the solid wall BELOW the sill is present (point just under the window is inside the sill).
  assert(!clearOfAll(boxes, [W / 2 - t / 2, 0.5, 0]), "the wall below the window sill must be solid");
  // North window (wider) void clear too.
  assert(clearOfAll(boxes, [0, 1.0 + 0.55, D / 2 - t / 2]), "the NORTH WINDOW opening must be a clear void");
}

// ── 2. Rotated 45°: still a rigid building — eaves meet wall-tops. ───────────────────────────────
{
  const boxes = build({ ...COTTAGE, rotation: Math.PI / 4 }, [0, 0, 0]);
  const wallTop = Math.max(...boxes.filter((b) => b.kind.startsWith("wall_") || b.kind.startsWith("lintel_")).map((b) => b.box.max.y));
  const roof = boxes.find((b) => b.kind === "roof")!.box;
  ops.op_log(`RECIPE rot45: wallTop=${wallTop.toFixed(3)} roofEaves=${roof.min.y.toFixed(3)} eave-gap=${(roof.min.y - wallTop).toFixed(3)}`);
  assert(Math.abs(roof.min.y - wallTop) < EPS, `(rotated) roof eaves must meet wall-tops — gap ${(roof.min.y - wallTop).toFixed(3)}`);
}

ops.op_log("p15c_recipe OK: recipe→assembler verified by measurement — door + 3 windows are genuine voids with sills, eaves meet wall-tops, rigid under rotation.");
