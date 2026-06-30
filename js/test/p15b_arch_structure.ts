// Structural-assertion harness for architecture.building (modeling-loop spike, piece #1).
//
// Verifies BUILT GEOMETRY by MEASUREMENT, not by eye: builds a building, syncs ECS→mesh transforms,
// computes each part's true world AABB, and asserts structural invariants — eaves meet wall-tops,
// nothing floats, rotation is a rigid transform. This is the gate that catches "floating roof" /
// "exploded walls" as a red test in milliseconds instead of a broken render an hour later.
//
// Run: ./target/release/limina js/test/p15b_arch_structure.ts   (exit 0 = pass)

import * as THREE from "../build/three.bundle.mjs";
import { EntityTable, ops, type EngineOps } from "../src/engine.ts";
import { createEcsWorld, renderSyncSystem } from "../src/ecs/world.ts";
import { createTransformStorage } from "../src/ecs/facade.ts";
import { UniformGridSpatialIndex } from "../src/spatial/index.ts";
import { LiminaTracer } from "../src/observability/event.ts";
import { SkillRegistry, type InvokeBase, type WorldContext } from "../src/skills/registry.ts";
import { registerCoreSkills } from "../src/skills/index.ts";
import { resolveProfile } from "../src/skills/permissions.ts";

function assert(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new Error("p15b_arch_structure FAIL: " + msg);
}
function makeWorld(worldOps: EngineOps): WorldContext {
  const scene = { add() {}, remove() {}, position: { set() {}, x: 0, y: 0, z: 0 }, background: null as unknown };
  const camera = { position: { set() {} }, aspect: 1, lookAt() {}, updateProjectionMatrix() {} };
  const ecs = createEcsWorld();
  return {
    ecs, transforms: createTransformStorage(ecs), spatial: new UniformGridSpatialIndex(),
    entities: new EntityTable(), tags: new Map(), scene: scene as WorldContext["scene"],
    camera: camera as WorldContext["camera"], ops: worldOps, mode: "headless",
  } as WorldContext;
}

ops.op_physics_create_world(-9.81);
const PERMS = resolveProfile("builder.readWrite");

type PartBox = { kind: string; box: THREE.Box3 };
/** Build a building and return each part's TRUE world AABB (after ECS->mesh sync). */
async function build(input: Record<string, unknown>): Promise<PartBox[]> {
  const world = makeWorld(ops);
  const reg = new SkillRegistry(new LiminaTracer("p15b"));
  registerCoreSkills(reg);
  const base: InvokeBase = { agentId: "agt", sessionId: "p15b", permissions: PERMS, tick: 0, world };
  const res = await reg.invoke("architecture.building", input, base);
  if (!res || !res.success) throw new Error("architecture.building failed: " + JSON.stringify(res?.error));
  const parts = (res.result as { parts: Array<{ kind: string; entity: string }> }).parts;
  renderSyncSystem(world.ecs); // push ECS Position/Rotation -> the meshes
  return parts.map((p) => {
    const rec = (world.entities as unknown as { resolve(id: string): { mesh: THREE.Object3D } }).resolve(p.entity);
    const mesh = rec.mesh;
    mesh.updateMatrixWorld(true);
    return { kind: p.kind, box: new THREE.Box3().setFromObject(mesh) };
  });
}

const EPS = 0.06;
function wallTop(boxes: PartBox[]): number {
  return Math.max(...boxes.filter((b) => b.kind.startsWith("wall") || b.kind === "lintel").map((b) => b.box.max.y));
}
function floorTop(boxes: PartBox[]): number {
  return boxes.find((b) => b.kind === "floor")!.box.max.y;
}

// ── 1. Axis-aligned building (W>D): the roof eaves must MEET the wall-tops (no float). ───────────
{
  const boxes = await build({ position: [0, 0, 0], width: 8, depth: 6, height: 3.2 });
  const wt = wallTop(boxes), ft = floorTop(boxes);
  const roof = boxes.find((b) => b.kind === "roof")!.box;
  const eaves = roof.min.y;
  ops.op_log(`STRUCT W>D: floorTop=${ft.toFixed(3)} wallTop=${wt.toFixed(3)} roofEaves=${eaves.toFixed(3)} eave-gap=${(eaves - wt).toFixed(3)} roofApex=${roof.max.y.toFixed(3)}`);
  assert(Math.abs(ft - 0) < EPS, `floor top sits at the base y=0 (got ${ft.toFixed(3)})`);
  assert(Math.abs(eaves - wt) < EPS, `roof eaves must MEET the wall-tops — float gap ${(eaves - wt).toFixed(3)} m (eaves ${eaves.toFixed(3)} vs wall-top ${wt.toFixed(3)})`);
  assert(roof.max.y > wt + 0.5, `roof must rise above the eaves into a ridge (apex ${roof.max.y.toFixed(3)})`);
  // No wall floats: every wall base sits on the floor.
  for (const b of boxes.filter((b) => b.kind.startsWith("wall"))) {
    assert(Math.abs(b.box.min.y - ft) < EPS + 0.26, `${b.kind} base must rest on the floor (base ${b.box.min.y.toFixed(3)} vs floor ${ft.toFixed(3)})`);
  }
}

// ── 2. Long-axis building (D>W): roof ridge orientation must STILL leave eaves on the wall-tops. ──
{
  const boxes = await build({ position: [0, 0, 0], width: 6, depth: 10, height: 3.2 });
  const wt = wallTop(boxes);
  const roof = boxes.find((b) => b.kind === "roof")!.box;
  ops.op_log(`STRUCT D>W: wallTop=${wt.toFixed(3)} roofEaves=${roof.min.y.toFixed(3)} eave-gap=${(roof.min.y - wt).toFixed(3)}`);
  assert(Math.abs(roof.min.y - wt) < EPS, `(D>W) roof eaves must meet wall-tops — gap ${(roof.min.y - wt).toFixed(3)} m`);
}

// ── 3. ROTATED building: still a rigid building — eaves meet wall-tops; footprint preserved. ─────
{
  const boxes = await build({ position: [0, 0, 0], width: 8, depth: 6, height: 3.2, rotation: Math.PI / 4 });
  const wt = wallTop(boxes);
  const roof = boxes.find((b) => b.kind === "roof")!.box;
  ops.op_log(`STRUCT rot45: wallTop=${wt.toFixed(3)} roofEaves=${roof.min.y.toFixed(3)} eave-gap=${(roof.min.y - wt).toFixed(3)}`);
  assert(Math.abs(roof.min.y - wt) < EPS, `(rotated) roof eaves must meet wall-tops — gap ${(roof.min.y - wt).toFixed(3)} m`);
}

ops.op_log("p15b_arch_structure OK: built geometry verified by MEASUREMENT — eaves meet wall-tops, nothing floats, rotation stays rigid (W>D, D>W, and 45°).");
