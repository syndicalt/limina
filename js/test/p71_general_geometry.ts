// Phase A1 — THE GENERAL BUILDING HAND GATE.
//
// The agent can build arbitrary blockout + custom geometry through skills, not just box/sphere — so
// it can build (say) a "television" with NO television-specific skill. This gate proves, against the
// REAL skills run through the REAL invoke pipeline + WorldRecorder (never a reimplementation):
//
//   1. scene.createEntity builds EACH widened primitive (cylinder/cone/plane/capsule/torus) as a real
//      entity: non-empty mesh geometry + a bound collider, and the call is RECORDED.
//   2. scene.createMesh builds from a DECLARATIVE GeometrySpec — a cylinder param spec AND a small
//      extrude profile — each producing a real entity with non-empty BufferGeometry, RECORDED.
//   3. Wire format (geometry/geometry-spec.ts): serialize(parse(x)) is byte-stable, and a malformed
//      spec (bad kind / missing required param / extra key) is REJECTED — by the schema directly AND
//      by scene.createMesh's input validation ({success:false}, never a crash).
//   4. Determinism: the same spec twice → identical geometry vertex buffers.
//   5. A "television" BLOCKOUT built from primitives only (box body + thin-box screen + cylinder
//      stand), positioned and logically parented via scene.createEntity({parent}) — all parts exist
//      and are RECORDED, with NO television-specific skill in the catalog.
//   6. skills.search discovers scene.createMesh (progressive discovery of the general hand).
//
// Run: ./target/release/limina js/test/p71_general_geometry.ts   (exit 0 = pass)

import { EntityTable, ops, type EngineOps } from "../src/engine.ts";
import { createEcsWorld } from "../src/ecs/world.ts";
import { createTransformStorage } from "../src/ecs/facade.ts";
import { UniformGridSpatialIndex } from "../src/spatial/index.ts";
import { LiminaTracer } from "../src/observability/event.ts";
import { SkillRegistry, type InvokeBase, type WorldContext } from "../src/skills/registry.ts";
import { registerCoreSkills } from "../src/skills/index.ts";
import { resolveProfile } from "../src/skills/permissions.ts";
import { WorldRecorder } from "../src/worldlog/recorder.ts";
import {
  GeometrySpecSchema,
  parseGeometrySpec,
  serializeGeometrySpec,
  canonicalizeGeometrySpec,
  type GeometrySpec,
} from "../src/geometry/geometry-spec.ts";
import type { MCPResponse } from "../src/mcp/protocol.ts";

function assert(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new Error("p71_general_geometry FAIL: " + msg);
}
function ok(label: string, res: MCPResponse): Record<string, unknown> {
  if (!res.success) throw new Error(`p71_general_geometry: ${label} failed: ${JSON.stringify(res.error)}`);
  return (res.result ?? {}) as Record<string, unknown>;
}
function assertThrows(fn: () => unknown, msg: string): void {
  let threw = false;
  try { fn(); } catch { threw = true; }
  assert(threw, msg);
}

const PERMS = resolveProfile("builder.readWrite");

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

/** A fresh recorded session over the REAL core skills. */
function session(name: string): { reg: SkillRegistry; recorder: WorldRecorder; base: InvokeBase; world: WorldContext } {
  ops.op_physics_create_world(-9.81);
  const reg = new SkillRegistry(new LiminaTracer(name));
  registerCoreSkills(reg);
  const recorder = new WorldRecorder(name);
  recorder.attach(reg);
  recorder.seed(0x71a1);
  const world = makeWorld(recorder.wrapOps(ops));
  const base: InvokeBase = { agentId: "agt", sessionId: name, permissions: PERMS, tick: 1, world };
  return { reg, recorder, base, world };
}

/** Number of position vertices on a live entity's mesh geometry (0 == empty/missing). */
function vertexCount(world: WorldContext, entity: string): number {
  const mesh = world.entities.resolve(entity)?.mesh as { geometry?: { getAttribute(n: string): { count: number } | undefined } } | undefined;
  const attr = mesh?.geometry?.getAttribute("position");
  return attr?.count ?? 0;
}
/** The raw position buffer of a live entity's mesh geometry (for byte-level determinism checks). */
function vertexArray(world: WorldContext, entity: string): ArrayLike<number> {
  const mesh = world.entities.resolve(entity)?.mesh as { geometry: { getAttribute(n: string): { array: ArrayLike<number> } } };
  return mesh.geometry.getAttribute("position").array;
}
function colliderBound(world: WorldContext, entity: string): boolean {
  return world.entities.resolve(entity)?.bodyId !== undefined;
}
function recorded(recorder: WorldRecorder, tool: string, match?: (input: unknown) => boolean): boolean {
  return recorder.commands.some((c) => c.kind === "skill" && c.tool === tool && (match === undefined || match(c.input)));
}

// ── 1. scene.createEntity — every widened primitive is a real, collidable, recorded entity. ───────
{
  const { reg, recorder, base, world } = session("ses_p71_prims");
  // Byte-identical back-compat: box builds its original 24-vert geometry — also our "is it a real,
  // shape-specific geometry, or did a branch fall back to a box?" baseline.
  const box = ok("createEntity box", await reg.invoke("scene.createEntity", { shape: "box", size: 2, static: true }, base)).entity as string;
  const BOX_VERTS = vertexCount(world, box);
  assert(BOX_VERTS === 24, `box geometry unchanged (BoxGeometry has 24 position verts; got ${BOX_VERTS})`);

  const NEW_SHAPES = ["cylinder", "cone", "plane", "capsule", "torus"] as const;
  for (const shape of NEW_SHAPES) {
    const r = ok(`createEntity ${shape}`, await reg.invoke("scene.createEntity", { shape, size: 2, static: true, position: [0, 0, 0] }, base));
    const entity = r.entity as string;
    const verts = vertexCount(world, entity);
    assert(verts > 0, `${shape}: mesh geometry must be non-empty (got ${verts} verts)`);
    // Shape-SENSITIVE: each widened primitive must build its OWN geometry, not silently fall back to
    // a box. (This is what the falsification trips when a branch is broken to build a box.)
    assert(verts !== BOX_VERTS, `${shape}: must build a distinct ${shape} geometry, not a box (got the box's ${BOX_VERTS} verts)`);
    assert(colliderBound(world, entity), `${shape}: a physics collider must be bound (bodyId set)`);
    assert(recorded(recorder, "scene.createEntity", (i) => (i as { shape?: string }).shape === shape),
      `${shape}: the scene.createEntity call must be RECORDED`);
  }
}

// ── 2. scene.createMesh — declarative primitive (cylinder) AND extrude produce real geometry. ─────
{
  const { reg, recorder, base, world } = session("ses_p71_mesh");
  const cyl: GeometrySpec = { version: 1, kind: "cylinder", radiusTop: 0.5, radiusBottom: 0.5, height: 3, radialSegments: 20 };
  const rc = ok("createMesh cylinder", await reg.invoke("scene.createMesh", { geometry: cyl, position: [1, 0, 1] }, base));
  const cylEnt = rc.entity as string;
  assert(vertexCount(world, cylEnt) > 0, `createMesh cylinder: non-empty BufferGeometry (got ${vertexCount(world, cylEnt)})`);
  assert(colliderBound(world, cylEnt), "createMesh cylinder: a collider must be bound");
  assert(recorded(recorder, "scene.createMesh", (i) => (i as { geometry?: { kind?: string } }).geometry?.kind === "cylinder"),
    "createMesh cylinder: must be RECORDED");
  // Self-sufficient snapshot: the entity must carry its create command as `origin` (parity with
  // scene.createEntity) so a bounded-tail snapshot can rebuild the mesh after the create is compacted.
  {
    const origin = world.entities.resolve(cylEnt)?.origin as { tool?: string; input?: { geometry?: { kind?: string } } } | undefined;
    assert(origin?.tool === "scene.createMesh" && origin.input?.geometry?.kind === "cylinder",
      `createMesh: entity must carry a self-sufficient origin (tool=scene.createMesh + geometry spec); got ${JSON.stringify(origin)}`);
  }

  // A small custom EXTRUDE profile (an L-shape) — genuinely custom geometry with no shape-specific skill.
  const ell: GeometrySpec = {
    version: 1, kind: "extrude", depth: 0.5, steps: 1,
    profile: [[0, 0], [2, 0], [2, 0.6], [0.6, 0.6], [0.6, 2], [0, 2]],
  };
  const re = ok("createMesh extrude", await reg.invoke("scene.createMesh", { geometry: ell, position: [5, 0, 0], material: "wood" }, base));
  const ellEnt = re.entity as string;
  assert(vertexCount(world, ellEnt) > 0, `createMesh extrude: non-empty BufferGeometry (got ${vertexCount(world, ellEnt)})`);
  assert(colliderBound(world, ellEnt), "createMesh extrude: a collider must be bound");
  assert(world.entities.resolve(ellEnt)?.material?.name === "wood", "createMesh extrude: first-class material state carries the palette name");
  assert(recorded(recorder, "scene.createMesh", (i) => (i as { geometry?: { kind?: string } }).geometry?.kind === "extrude"),
    "createMesh extrude: must be RECORDED");
}

// ── 3. Wire format — byte-stable round-trip + malformed specs rejected (schema AND skill). ────────
{
  const specs: GeometrySpec[] = [
    { version: 1, kind: "box", width: 1, height: 2, depth: 3 },
    { version: 1, kind: "sphere", radius: 1, widthSegments: 24, heightSegments: 16 },
    { version: 1, kind: "cylinder", radiusTop: 0.5, radiusBottom: 1, height: 2, radialSegments: 24 },
    { version: 1, kind: "cone", radius: 1, height: 2, radialSegments: 24 },
    { version: 1, kind: "plane", width: 2, height: 3, widthSegments: 1, heightSegments: 1 },
    { version: 1, kind: "capsule", radius: 0.5, length: 2, capSegments: 8, radialSegments: 16 },
    { version: 1, kind: "torus", radius: 1, tube: 0.3, radialSegments: 12, tubularSegments: 24 },
    { version: 1, kind: "extrude", depth: 1, steps: 1, profile: [[0, 0], [1, 0], [1, 1]] },
  ];
  for (const spec of specs) {
    const x = serializeGeometrySpec(spec);
    assert(serializeGeometrySpec(parseGeometrySpec(x)) === x, `${spec.kind}: serialize(parse(x)) must be byte-stable`);
    // Canonical is a fixed point.
    assert(serializeGeometrySpec(canonicalizeGeometrySpec(spec)) === x, `${spec.kind}: canonicalize is a fixed point`);
  }
  // Defaults fill in when segments are omitted, and the result is still byte-stable.
  const omitted = { version: 1, kind: "sphere", radius: 1 };
  const filled = parseGeometrySpec(JSON.stringify(omitted));
  assert(filled.kind === "sphere" && (filled as { widthSegments: number }).widthSegments === 24, "omitted segment defaults are applied on parse");

  // Malformed — the REAL schema must REJECT each (never a made-up default to pass).
  assertThrows(() => parseGeometrySpec(JSON.stringify({ version: 1, kind: "pyramid", size: 1 })), "reject unknown kind 'pyramid'");
  assertThrows(() => parseGeometrySpec(JSON.stringify({ version: 1, kind: "cylinder", radiusTop: 0.5, radiusBottom: 0.5 })), "reject cylinder missing required 'height'");
  assertThrows(() => parseGeometrySpec(JSON.stringify({ version: 1, kind: "box", width: 1, height: 1, depth: 1, bogus: true })), "reject extra/unknown key (.strict)");
  assertThrows(() => parseGeometrySpec(JSON.stringify({ version: 2, kind: "box", width: 1, height: 1, depth: 1 })), "reject wrong version literal");
  assertThrows(() => parseGeometrySpec(JSON.stringify({ version: 1, kind: "extrude", depth: 1, profile: [[0, 0], [1, 0]] })), "reject extrude profile with < 3 points");
  // And the SKILL rejects a malformed geometry gracefully — {success:false}, not a thrown crash.
  {
    const { reg, base } = session("ses_p71_bad");
    const bad = await reg.invoke("scene.createMesh", { geometry: { version: 1, kind: "pyramid", size: 1 }, position: [0, 0, 0] }, base);
    assert(bad.success === false, "scene.createMesh must REJECT a malformed geometry spec ({success:false}), not crash");
    assert(bad.error?.code === "invalid_input", `rejection is an input-validation error (got ${bad.error?.code})`);
  }
}

// ── 4. Determinism — the same spec twice yields byte-identical vertex buffers. ────────────────────
{
  const { reg, base, world } = session("ses_p71_det");
  const spec: GeometrySpec = { version: 1, kind: "cylinder", radiusTop: 0.7, radiusBottom: 0.7, height: 2.5, radialSegments: 18 };
  const a = ok("det A", await reg.invoke("scene.createMesh", { geometry: spec, position: [0, 0, 0] }, base)).entity as string;
  const b = ok("det B", await reg.invoke("scene.createMesh", { geometry: spec, position: [0, 0, 0] }, base)).entity as string;
  const va = vertexArray(world, a), vb = vertexArray(world, b);
  assert(va.length > 0 && va.length === vb.length, `same spec → same vertex count (${va.length} vs ${vb.length})`);
  for (let i = 0; i < va.length; i++) {
    assert(Object.is(va[i], vb[i]), `vertex buffer element ${i} must be byte-identical across runs (${va[i]} vs ${vb[i]})`);
  }
}

// ── 5. A "television" BLOCKOUT from primitives only — no TV-specific skill. ────────────────────────
{
  const { reg, recorder, base, world } = session("ses_p71_tv");
  // Prove there is NO television skill anywhere in the catalog.
  assert(!reg.has("scene.createTelevision") && !reg.has("architecture.television"),
    "there must be NO television-specific skill — the TV is built from general primitives");
  const catalogHasTV = reg.list(PERMS).some((t) => /television/i.test(t.name));
  assert(!catalogHasTV, "no 'television' skill may exist in the catalog");

  // Body: a box. Screen: a thin box on its front face, parented to the body. Stand: a cylinder below.
  const body = ok("tv body", await reg.invoke("scene.createEntity", { shape: "box", size: 1.6, position: [0, 1.2, 0], static: true, tags: ["television", "tv_body"] }, base)).entity as string;
  const screen = ok("tv screen", await reg.invoke("scene.createEntity", { shape: "plane", size: 1.4, position: [0, 1.2, 0.81], parent: body, tags: ["tv_screen"] }, base)).entity as string;
  const stand = ok("tv stand", await reg.invoke("scene.createMesh", { geometry: { version: 1, kind: "cylinder", radiusTop: 0.25, radiusBottom: 0.4, height: 0.4 }, position: [0, 0.2, 0], parent: body, tags: ["tv_stand"] }, base)).entity as string;

  for (const [label, ent] of [["body", body], ["screen", screen], ["stand", stand]] as const) {
    assert(vertexCount(world, ent) > 0, `tv ${label}: real non-empty geometry`);
  }
  // Logical parenting: screen + stand are children of the body.
  assert(world.entities.resolve(screen)?.parent === body, "the screen is logically parented to the body");
  assert(world.entities.resolve(stand)?.parent === body, "the stand is logically parented to the body");
  // All three parts are RECORDED (so the whole TV replays).
  assert(recorded(recorder, "scene.createEntity", (i) => Array.isArray((i as { tags?: string[] }).tags) && (i as { tags: string[] }).tags.includes("tv_body")), "tv body recorded");
  assert(recorded(recorder, "scene.createEntity", (i) => Array.isArray((i as { tags?: string[] }).tags) && (i as { tags: string[] }).tags.includes("tv_screen")), "tv screen recorded");
  assert(recorded(recorder, "scene.createMesh", (i) => Array.isArray((i as { tags?: string[] }).tags) && (i as { tags: string[] }).tags.includes("tv_stand")), "tv stand recorded");
}

// ── 6. Discoverability — skills.search finds the general custom-geometry hand. ────────────────────
{
  const { reg, base } = session("ses_p71_search");
  const res = ok("skills.search", await reg.invoke("skills.search", { query: "custom mesh geometry extrude profile" }, base));
  const names = (res.matches as { name: string }[]).map((m) => m.name);
  assert(names.includes("scene.createMesh"), `skills.search must discover scene.createMesh (got: ${names.join(", ")})`);
}

// Sanity: the schema is the single source — the union covers exactly the 8 kinds we exercised.
assert(GeometrySpecSchema.options.length === 8, `GeometrySpec union must have 8 kinds (got ${GeometrySpecSchema.options.length})`);

ops.op_log(
  "p71_general_geometry OK: the general building hand — scene.createEntity builds all widened primitives " +
  "(cylinder/cone/plane/capsule/torus) as real collidable RECORDED entities; scene.createMesh builds from a " +
  "versioned declarative GeometrySpec (params + extrude) with byte-stable round-trip, deterministic vertex " +
  "buffers, and graceful rejection of malformed specs; a 'television' blockout is built + logically parented " +
  "from primitives ALONE with NO television-specific skill; scene.createMesh is discoverable via skills.search.",
);
