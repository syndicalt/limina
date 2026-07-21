// Phase A2 — PREFABS / RECIPES GATE.
//
// A prefab lets one "townhouse" recipe become a 20-house block: name a set of entities, stamp it many
// times with per-instance variation, and duplicate. This gate proves, against the REAL skills run
// through the REAL invoke pipeline + WorldRecorder (never a reimplementation):
//
//   1. A multi-part "townhouse" (a box body ROOT + a seed-bearing createMesh roof + a plane door, both
//      parented to the body) is CAPTURED by scene.group into a NAMED recipe.
//   2. scene.instantiateGroup stamps it at 3 different positions/yaws: each instance creates the right
//      number of entities, correctly parented, at the right WORLD transforms, and is RECORDED as a
//      SINGLE command (the nested creates are folded, not re-recorded).
//   3. Variation: two instances with DIFFERENT seeds produce genuinely different geometry (the roof's
//      vertex buffer differs); the SAME seed → identical.
//   4. Determinism: the same recipe+transform+seed twice → byte-identical entity structure/transforms.
//   5. Graceful: instantiating an UNKNOWN recipe name → {success:false}, no uncaught throw.
//   6. Instantiated entities carry their `origin` (self-sufficient snapshot).
//   7. scene.duplicate copies an entity's subtree at an offset.
//   8. The recipe wire format (scene/entity-recipe.ts) round-trips byte-stable + rejects malformed.
//
// Run: ./target/release/limina js/test/p72_prefabs.ts   (exit 0 = pass)

import { EntityTable, ops, type EngineOps } from "../src/engine.ts";
import { createEcsWorld, Position, Rotation, Scale } from "../src/ecs/world.ts";
import { createTransformStorage } from "../src/ecs/facade.ts";
import { UniformGridSpatialIndex } from "../src/spatial/index.ts";
import { LiminaTracer } from "../src/observability/event.ts";
import { SkillRegistry, type InvokeBase, type WorldContext } from "../src/skills/registry.ts";
import { registerCoreSkills } from "../src/skills/index.ts";
import { resolveProfile } from "../src/skills/permissions.ts";
import { WorldRecorder } from "../src/worldlog/recorder.ts";
import {
  EntityRecipeSchema,
  parseEntityRecipe,
  serializeEntityRecipe,
  canonicalizeEntityRecipe,
  type EntityRecipe,
} from "../src/scene/entity-recipe.ts";
import type { MCPResponse } from "../src/mcp/protocol.ts";

function assert(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new Error("p72_prefabs FAIL: " + msg);
}
function ok(label: string, res: MCPResponse): Record<string, unknown> {
  if (!res.success) throw new Error(`p72_prefabs: ${label} failed: ${JSON.stringify(res.error)}`);
  return (res.result ?? {}) as Record<string, unknown>;
}
function assertThrows(fn: () => unknown, msg: string): void {
  let threw = false;
  try { fn(); } catch { threw = true; }
  assert(threw, msg);
}

const PERMS = resolveProfile("builder.readWrite");
const EPS = 1e-4;

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

function session(name: string): { reg: SkillRegistry; recorder: WorldRecorder; base: InvokeBase; world: WorldContext } {
  ops.op_physics_create_world(-9.81);
  const reg = new SkillRegistry(new LiminaTracer(name));
  registerCoreSkills(reg);
  const recorder = new WorldRecorder(name);
  recorder.attach(reg);
  recorder.seed(0x72a2);
  const world = makeWorld(recorder.wrapOps(ops));
  const base: InvokeBase = { agentId: "agt", sessionId: name, permissions: PERMS, tick: 1, world };
  return { reg, recorder, base, world };
}

function worldPos(world: WorldContext, entity: string): [number, number, number] {
  const eid = world.entities.resolve(entity)?.eid as number;
  return [Position.x[eid], Position.y[eid], Position.z[eid]];
}
function vertexArray(world: WorldContext, entity: string): ArrayLike<number> {
  const mesh = world.entities.resolve(entity)?.mesh as { geometry: { getAttribute(n: string): { array: ArrayLike<number> } } };
  return mesh.geometry.getAttribute("position").array;
}
function recordedCount(recorder: WorldRecorder, tool: string): number {
  return recorder.commands.filter((c) => c.kind === "skill" && c.tool === tool).length;
}
function approx(a: [number, number, number], b: [number, number, number], eps = EPS): boolean {
  return Math.abs(a[0] - b[0]) < eps && Math.abs(a[1] - b[1]) < eps && Math.abs(a[2] - b[2]) < eps;
}
/** Rotate an offset about +Y (THREE convention: x'=x·c+z·s, z'=-x·s+z·c) — the INDEPENDENT check of
 *  where a child should land in a yawed instance (verifies the skill's transform math, not a copy of it). */
function rotY(o: [number, number, number], yaw: number): [number, number, number] {
  const c = Math.cos(yaw), s = Math.sin(yaw);
  return [o[0] * c + o[2] * s, o[1], -o[0] * s + o[2] * c];
}

/** Build the townhouse subtree in the given session. Returns the part ids. The roof is a seed-bearing
 *  createMesh (so the reseed test is genuine); roof is created BEFORE the door so the recipe's BFS
 *  order is [body, roof, door]. */
async function buildTownhouse(reg: SkillRegistry, base: InvokeBase, roofSeed: number): Promise<{ body: string; roof: string; door: string }> {
  const body = ok("body", await reg.invoke("scene.createEntity", { shape: "box", size: 2, position: [0, 1, 0], static: true, tags: ["townhouse", "body"] }, base)).entity as string;
  const roof = ok("roof", await reg.invoke("scene.createMesh", {
    geometry: { version: 1, kind: "cone", radius: 1.6, height: 1.2, radialSegments: 12 },
    position: [0, 2.5, 0], parent: body, seed: roofSeed, tags: ["roof"],
  }, base)).entity as string;
  const door = ok("door", await reg.invoke("scene.createEntity", { shape: "plane", size: 1, position: [0, 0.5, 1.01], parent: body, tags: ["door"] }, base)).entity as string;
  return { body, roof, door };
}

// ── 1 + 2. Capture, then stamp 3 instances at different transforms — parented, placed, recorded. ──
{
  const { reg, recorder, base, world } = session("ses_p72_stamp");
  const { body } = await buildTownhouse(reg, base, 111);
  const createEntityBefore = recordedCount(recorder, "scene.createEntity");
  const createMeshBefore = recordedCount(recorder, "scene.createMesh");

  const grp = ok("group", await reg.invoke("scene.group", { root: body, name: "townhouse" }, base));
  assert(grp.nodeCount === 3, `recipe must capture 3 nodes (body+roof+door); got ${grp.nodeCount}`);
  const recipe = grp.recipe as EntityRecipe;
  assert(recipe.nodes[0].parent === null, "node 0 (body) must be the root (parent null)");
  assert(recipe.nodes[1].parent === 0 && recipe.nodes[2].parent === 0, "roof + door must be children of node 0");
  assert(EntityRecipeSchema.safeParse(recipe).success, "returned recipe must satisfy the wire schema");
  const roofOffset = recipe.nodes[1].offset.pos;   // [0, 1.5, 0]
  const doorOffset = recipe.nodes[2].offset.pos;   // [0, -0.5, 1.01]

  const stamps: { pos: [number, number, number]; yaw: number }[] = [
    { pos: [10, 0, 0], yaw: 0 },
    { pos: [20, 0, 0], yaw: Math.PI / 2 },
    { pos: [30, 0, 0], yaw: Math.PI },
  ];
  for (const st of stamps) {
    const r = ok(`instantiate @${st.pos}`, await reg.invoke("scene.instantiateGroup", { name: "townhouse", position: st.pos, yaw: st.yaw, seed: 5 }, base));
    const ents = r.entities as string[];
    assert(ents.length === 3, `each instance must create 3 entities; got ${ents.length}`);
    assert(r.root === ents[0], "root is the first created entity");
    // Correctly parented: roof + door are children of the fresh root.
    assert(world.entities.resolve(ents[1])?.parent === ents[0], "instance roof must be parented to the instance root");
    assert(world.entities.resolve(ents[2])?.parent === ents[0], "instance door must be parented to the instance root");
    // Correct WORLD transforms: root AT target; children at target + (yaw-rotated) recipe offset.
    assert(approx(worldPos(world, ents[0]), st.pos), `root must be at the target ${st.pos}; got ${worldPos(world, ents[0])}`);
    const roofExp = rotY(roofOffset, st.yaw).map((v, i) => v + st.pos[i]) as [number, number, number];
    const doorExp = rotY(doorOffset, st.yaw).map((v, i) => v + st.pos[i]) as [number, number, number];
    assert(approx(worldPos(world, ents[1]), roofExp), `roof placement wrong: expected ${roofExp}, got ${worldPos(world, ents[1])}`);
    assert(approx(worldPos(world, ents[2]), doorExp), `door placement wrong: expected ${doorExp}, got ${worldPos(world, ents[2])}`);
  }
  // RECORDED as single commands: 3 instantiateGroup commands, and NO extra create commands (the nested
  // creates are folded into the instantiate command via ctx.chainId — they must not be re-recorded).
  assert(recordedCount(recorder, "scene.instantiateGroup") === 3, "each instantiate must be recorded once");
  assert(recordedCount(recorder, "scene.createEntity") === createEntityBefore, "instantiate must NOT re-record nested createEntity (folded by chainId)");
  assert(recordedCount(recorder, "scene.createMesh") === createMeshBefore, "instantiate must NOT re-record nested createMesh (folded by chainId)");
  assert(recordedCount(recorder, "scene.group") === 1, "scene.group must be recorded (so replay repopulates the recipe registry)");
}

// ── 3. Variation — different seeds → genuinely different geometry; same seed → identical. ──────────
{
  const { reg, base, world } = session("ses_p72_variation");
  const { body } = await buildTownhouse(reg, base, 111);
  ok("group", await reg.invoke("scene.group", { root: body, name: "townhouse" }, base));

  const a = ok("inst seed 1", await reg.invoke("scene.instantiateGroup", { name: "townhouse", position: [0, 0, 0], seed: 1 }, base)).entities as string[];
  const b = ok("inst seed 2", await reg.invoke("scene.instantiateGroup", { name: "townhouse", position: [50, 0, 0], seed: 2 }, base)).entities as string[];
  const c = ok("inst seed 1 again", await reg.invoke("scene.instantiateGroup", { name: "townhouse", position: [100, 0, 0], seed: 1 }, base)).entities as string[];

  const roofA = vertexArray(world, a[1]), roofB = vertexArray(world, b[1]), roofC = vertexArray(world, c[1]);
  assert(roofA.length > 0 && roofA.length === roofB.length && roofA.length === roofC.length, "roofs share vertex count");
  // Different seed → at least one vertex differs (genuine reseed of the seed-bearing roof create).
  let differ = false;
  for (let i = 0; i < roofA.length; i++) if (!Object.is(roofA[i], roofB[i])) { differ = true; break; }
  assert(differ, "instances stamped with DIFFERENT seeds must produce different roof geometry (genuine reseed)");
  // Same seed → byte-identical.
  for (let i = 0; i < roofA.length; i++) {
    assert(Object.is(roofA[i], roofC[i]), `same seed must reproduce identical roof geometry (vertex ${i}: ${roofA[i]} vs ${roofC[i]})`);
  }
}

// ── 4. Determinism — same recipe+transform+seed twice → identical structure/transforms. ───────────
{
  const { reg, base, world } = session("ses_p72_determinism");
  const { body } = await buildTownhouse(reg, base, 111);
  ok("group", await reg.invoke("scene.group", { root: body, name: "townhouse" }, base));
  const args = { name: "townhouse", position: [7, 0, -3] as [number, number, number], yaw: 0.9, seed: 42 };
  const a = ok("det A", await reg.invoke("scene.instantiateGroup", args, base)).entities as string[];
  const b = ok("det B", await reg.invoke("scene.instantiateGroup", args, base)).entities as string[];
  assert(a.length === b.length, "same structure");
  for (let i = 0; i < a.length; i++) {
    assert(approx(worldPos(world, a[i]), worldPos(world, b[i])), `node ${i} transform must be identical across identical stamps`);
  }
  // Geometry identical too (roof).
  const ra = vertexArray(world, a[1]), rb = vertexArray(world, b[1]);
  for (let i = 0; i < ra.length; i++) assert(Object.is(ra[i], rb[i]), `roof vertex ${i} identical across identical stamps`);
}

// ── 5. Graceful — unknown recipe name → {success:false}, no uncaught throw. ───────────────────────
{
  const { reg, base } = session("ses_p72_graceful");
  const bad = await reg.invoke("scene.instantiateGroup", { name: "does-not-exist", position: [0, 0, 0] }, base);
  assert(bad.success === false, "instantiating an unknown recipe must return {success:false}");
  // scene.group on a non-existent root is likewise a clean failure.
  const badGrp = await reg.invoke("scene.group", { root: "ent_99999", name: "x" }, base);
  assert(badGrp.success === false, "grouping an unknown root must return {success:false}");
}

// ── 6. Self-sufficiency — instantiated entities carry their origin create-command. ────────────────
{
  const { reg, base, world } = session("ses_p72_origin");
  const { body } = await buildTownhouse(reg, base, 111);
  ok("group", await reg.invoke("scene.group", { root: body, name: "townhouse" }, base));
  const ents = ok("inst", await reg.invoke("scene.instantiateGroup", { name: "townhouse", position: [3, 0, 0] }, base)).entities as string[];
  for (const e of ents) {
    const origin = world.entities.resolve(e)?.origin as { tool?: string } | undefined;
    assert(origin?.tool === "scene.createEntity" || origin?.tool === "scene.createMesh",
      `instantiated entity ${e} must carry an origin create-command; got ${JSON.stringify(origin)}`);
  }
}

// ── 7. scene.duplicate — copy an entity's subtree at an offset. ───────────────────────────────────
{
  const { reg, base, world } = session("ses_p72_duplicate");
  const { body, door } = await buildTownhouse(reg, base, 111);
  const doorWorld = worldPos(world, door);
  const dup = ok("duplicate", await reg.invoke("scene.duplicate", { entity: body, offset: [40, 0, 0] }, base));
  const ents = dup.entities as string[];
  assert(ents.length === 3, `duplicate must copy all 3 subtree entities; got ${ents.length}`);
  assert(world.entities.resolve(ents[1])?.parent === ents[0] && world.entities.resolve(ents[2])?.parent === ents[0],
    "duplicated children must be parented to the duplicated root");
  // Root copy sits at source root + offset; the door copy preserves its offset (source door + [40,0,0]).
  assert(approx(worldPos(world, ents[0]), [40, 1, 0]), `dup root must be source root + offset; got ${worldPos(world, ents[0])}`);
  assert(approx(worldPos(world, ents[2]), [doorWorld[0] + 40, doorWorld[1], doorWorld[2]]),
    `dup door must preserve its subtree offset shifted by [40,0,0]; got ${worldPos(world, ents[2])}`);
}

// ── 8. Wire format — byte-stable canonical round-trip + malformed rejected (.strict). ─────────────
{
  const recipe: EntityRecipe = {
    version: 1,
    name: "twohouse",
    nodes: [
      { parent: null, origin: { tool: "scene.createEntity", input: { shape: "box", size: 2, position: [0, 1, 0] } }, offset: { pos: [0, 0, 0], rot: [0, 0, 0, 1], scale: [1, 1, 1] } },
      { parent: 0, origin: { tool: "scene.createMesh", input: { geometry: { version: 1, kind: "cone", radius: 1, height: 1 }, seed: 9 } }, offset: { pos: [0, 1.5, 0], rot: [0, 0, 0, 1], scale: [1, 1, 1] } },
    ],
  };
  const x = serializeEntityRecipe(recipe);
  assert(serializeEntityRecipe(parseEntityRecipe(x)) === x, "serialize(parse(x)) must be byte-stable");
  assert(serializeEntityRecipe(canonicalizeEntityRecipe(recipe)) === x, "canonicalize is a fixed point");
  // Key order in origin.input must NOT change the canonical form (deep key-sort).
  const shuffled = JSON.parse(x);
  shuffled.nodes[0].origin.input = { position: [0, 1, 0], size: 2, shape: "box" };
  assert(serializeEntityRecipe(parseEntityRecipe(JSON.stringify(shuffled))) === x, "canonical form is independent of input key order");

  // Malformed — the REAL schema must REJECT each.
  assertThrows(() => parseEntityRecipe(JSON.stringify({ version: 2, name: "x", nodes: recipe.nodes })), "reject wrong version literal");
  assertThrows(() => parseEntityRecipe(JSON.stringify({ version: 1, name: "x", nodes: [] })), "reject empty node list");
  assertThrows(() => parseEntityRecipe(JSON.stringify({ version: 1, name: "x", nodes: recipe.nodes, bogus: true })), "reject extra/unknown key (.strict)");
}

ops.op_log(
  "p72_prefabs OK: prefabs/recipes — scene.group captures a townhouse subtree (box body + seed-bearing " +
  "createMesh roof + plane door) as a named recipe; scene.instantiateGroup stamps it at 3 positions/yaws " +
  "with correct parenting + WORLD transforms, recorded as SINGLE commands (nested creates folded); a " +
  "per-instance seed genuinely varies the roof (same seed → identical); identical stamps are byte-identical; " +
  "an unknown recipe fails cleanly ({success:false}); instantiated entities carry their origin; " +
  "scene.duplicate copies a subtree at an offset; the EntityRecipe wire format round-trips byte-stable and " +
  "rejects malformed input (.strict).",
);
