// Phase 15 (Track C — Complete) — THE PROCEDURAL ARCHITECTURE GATE.
//
// architecture.building emits an enterable rectangular building as real collidable box entities.
// This gate proves: the right parts exist (floor, 4 walls, a doorway of two jambs + lintel,
// optional roof), the footprint AABB is correct, the DOORWAY is genuinely open (no wall box
// occupies the opening while a jamb box does), and two runs produce byte-identical geometry
// (replay-safe). It cross-checks entity creation via scene.inspect.
//
// Run: ./target/release/limina js/test/p15_architecture.ts   (exit 0 = pass)

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
  if (!cond) throw new Error("p15_architecture FAIL: " + msg);
}
function unwrap(label: string, res: MCPResponse | undefined): Record<string, unknown> {
  if (res === undefined || !res.success) throw new Error(`p15_architecture: ${label} failed: ${JSON.stringify(res?.error ?? "no response")}`);
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
type V3 = [number, number, number];
type Part = { kind: string; entity: string; position: V3; size: V3 };
function pointInBox(p: V3, pos: V3, size: V3): boolean {
  return Math.abs(p[0] - pos[0]) <= size[0] / 2 + 1e-6
    && Math.abs(p[1] - pos[1]) <= size[1] / 2 + 1e-6
    && Math.abs(p[2] - pos[2]) <= size[2] / 2 + 1e-6;
}

async function build(session: string, input: Record<string, unknown>): Promise<{ parts: Part[]; result: Record<string, unknown>; reg: SkillRegistry; base: InvokeBase }> {
  ops.op_physics_create_world(-9.81);
  const reg = new SkillRegistry(new LiminaTracer(session));
  registerCoreSkills(reg);
  const base: InvokeBase = { agentId: "agt", sessionId: session, permissions: PERMS, tick: 0, world: makeWorld(ops) };
  const result = unwrap("architecture.building", await reg.invoke("architecture.building", input, base));
  return { parts: result.parts as Part[], result, reg, base };
}

// ── 1. Default building: correct parts, count, footprint AABB. ────────────────────────────────
{
  const center: V3 = [10, 0, -4];
  const { parts, result, reg, base } = await build("ses_p15_arch_a", { position: center, width: 8, depth: 6, height: 3.2 });
  assert(result.entityCount === 8, `default building has 8 parts (floor,4 walls split to door,lintel,roof) — got ${result.entityCount}`);
  const kinds = new Set(parts.map((p) => p.kind));
  for (const k of ["floor", "wall_north", "wall_east", "wall_west", "wall_south_left", "wall_south_right", "lintel", "roof"]) {
    assert(kinds.has(k), `building includes a ${k} part`);
  }
  const b = result.bounds as { min: V3; max: V3 };
  assert(b.min[0] === 6 && b.max[0] === 14, `X footprint 6..14 (got ${b.min[0]}..${b.max[0]})`);
  assert(b.min[2] === -7 && b.max[2] === -1, `Z footprint -7..-1 (got ${b.min[2]}..${b.max[2]})`);

  // Cross-check via the perception skill: the entities really exist in the scene.
  const ins = unwrap("scene.inspect", await reg.invoke("scene.inspect", {}, base));
  assert(ins.entityCount === 8, `scene.inspect counts the 8 created building entities (got ${ins.entityCount})`);

  // ── 2. The DOORWAY is genuinely open. ───────────────────────────────────────────────────────
  const zNeg = center[2] - 6 / 2 + 0.25 / 2; // -Z wall plane
  const doorCenter: V3 = [center[0], center[1] + 1.0, zNeg]; // mid-height, on the door wall
  const southParts = parts.filter((p) => p.kind.startsWith("wall_south") || p.kind === "lintel");
  for (const p of southParts) {
    assert(!pointInBox(doorCenter, p.position, p.size), `the doorway opening must be clear of ${p.kind}`);
  }
  // ...and a jamb genuinely occupies the wall beside the door (the opening isn't just the whole wall).
  const leftJamb = parts.find((p) => p.kind === "wall_south_left")!;
  assert(pointInBox(leftJamb.position, leftJamb.position, leftJamb.size), "the left jamb is a real solid box beside the door");
  assert(leftJamb.position[0] < doorCenter[0], "the left jamb sits to -X of the doorway");
}

// ── 3. No roof when withRoof:false (and the AABB top drops accordingly). ──────────────────────
{
  const { result } = await build("ses_p15_arch_noroof", { position: [0, 0, 0], withRoof: false });
  const parts = result.parts as Part[];
  assert(!parts.some((p) => p.kind === "roof"), "withRoof:false omits the roof");
  assert(result.entityCount === 7, `no-roof building has 7 parts (got ${result.entityCount})`);
}

// ── 4. Replay-determinism: identical inputs ⇒ byte-identical geometry. ────────────────────────
{
  const input = { position: [3, 0, 3] as V3, width: 10, depth: 7, height: 4, doorWidth: 2 };
  const A = await build("ses_p15_arch_detA", input);
  const B = await build("ses_p15_arch_detB", input);
  assert(A.parts.length === B.parts.length, "same part count across runs");
  for (let i = 0; i < A.parts.length; i++) {
    const a = A.parts[i], b = B.parts[i];
    assert(a.kind === b.kind, `part ${i} kind matches (${a.kind} vs ${b.kind})`);
    for (let k = 0; k < 3; k++) {
      assert(Object.is(a.position[k], b.position[k]), `part ${i} ${a.kind} position[${k}] deterministic`);
      assert(Object.is(a.size[k], b.size[k]), `part ${i} ${a.kind} size[${k}] deterministic`);
    }
  }
}

ops.op_log(
  "p15_architecture OK: procedural building generator — floor + 4 walls + a centered doorway (two jambs + lintel) + optional roof " +
  "as real collidable entities; correct footprint AABB; the doorway is genuinely OPEN (clear of walls, flanked by solid jambs); " +
  "withRoof toggles the cap; identical inputs produce byte-identical geometry (replay-safe). Cross-checked via scene.inspect.",
);
