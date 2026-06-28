// Phase 12 — REAL grid navmesh + deterministic A* (navmesh.* skills).
//
// navmesh.ts was a stub: build() made an empty mesh, findPath() returned a STRAIGHT
// LINE [from,to], isReachable() was always-true, and the skills read a never-set
// ctx.world.navmeshManager (no-op). This test pins the honest behaviour:
//
//   1. PATHFINDING WITH TEETH: build a grid with a known WALL obstacle (a gap at one
//      end), then findPath from one side to the other. The old straight-line stub would
//      cut THROUGH the wall; a real A* must route AROUND it. We assert every waypoint is
//      a walkable cell AND lies outside the obstacle AABB, and the path reaches the goal.
//   2. REACHABILITY: isReachable is real A* existence — true across an open gap, FALSE
//      across a solid wall (and findPath returns []), true on the same side.
//   3. MOVEMENT: navmesh.moveTo steps an entity along the path; remaining path distance
//      strictly decreases each step and the entity reaches the target. moveTo drives
//      op_physics_move_character for a character-body entity (sim-truth movement).
//   4. DETERMINISM: the same findPath call returns an IDENTICAL waypoint list across
//      runs; a record→replay of a moveTo sequence yields the IDENTICAL final position.
//
// Run: limina js/test/p12_navmesh.ts   (exit 0 = pass)

import { EntityTable, ops, type EngineOps } from "../src/engine.ts";
import { createEcsWorld, spawnRenderable, type Transformable } from "../src/ecs/world.ts";
import { createTransformStorage } from "../src/ecs/facade.ts";
import { UniformGridSpatialIndex } from "../src/spatial/index.ts";
import { LiminaTracer } from "../src/observability/event.ts";
import { SkillRegistry, type WorldContext } from "../src/skills/registry.ts";
import { registerCoreSkills } from "../src/skills/index.ts";
import { resolveProfile } from "../src/skills/permissions.ts";
import { WorldRecorder } from "../src/worldlog/recorder.ts";
import { replayCommands } from "../src/worldlog/replay.ts";
import type { NavmeshManager } from "../src/skills/navmesh.ts";
import type { MCPResponse } from "../src/mcp/protocol.ts";

function assert(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new Error("p12_navmesh FAIL: " + msg);
}
function ok(res: MCPResponse | undefined): Record<string, unknown> {
  if (res === undefined || !res.success) throw new Error("call failed: " + JSON.stringify(res?.error));
  return res.result as Record<string, unknown>;
}
function inert(): Transformable {
  return { position: { set() {} }, quaternion: { set() {} }, scale: { set() {} } };
}
function makeWorld(worldOps: EngineOps): WorldContext {
  const stub = { add() {}, remove() {}, position: { set() {}, x: 0, y: 0, z: 0 }, background: null as unknown };
  const camera = { position: { set() {} }, aspect: 1, lookAt() {}, updateProjectionMatrix() {} };
  const ecs = createEcsWorld();
  return {
    ecs, transforms: createTransformStorage(ecs), spatial: new UniformGridSpatialIndex(),
    entities: new EntityTable(), tags: new Map(), scene: stub as WorldContext["scene"],
    camera: camera as WorldContext["camera"], ops: worldOps, mode: "headless",
  };
}
type V3 = [number, number, number];
const closeV = (a: V3, b: V3, eps = 1e-6): boolean => Math.abs(a[0] - b[0]) < eps && Math.abs(a[1] - b[1]) < eps && Math.abs(a[2] - b[2]) < eps;
const samePathExact = (a: V3[], b: V3[]): boolean => a.length === b.length && a.every((w, i) => Object.is(w[0], b[i][0]) && Object.is(w[1], b[i][1]) && Object.is(w[2], b[i][2]));

// Grid: 10×10 world units, cellSize 1, origin (0,0). A vertical WALL in column x∈[4,5]
// from z=0 to z=8 — blocking grid col 4 for rows 0..7, leaving a GAP at rows 8,9.
const REGION = { minX: 0, minZ: 0, maxX: 10, maxZ: 10 } as const;
const GAPPED_WALL = { minX: 4, minZ: 0, maxX: 5, maxZ: 8 } as const; // gap at z>8
const SOLID_WALL = { minX: 4, minZ: 0, maxX: 5, maxZ: 10 } as const; // no gap — separates sides
const START: V3 = [0.5, 0, 0.5]; // col 0, row 0
const GOAL: V3 = [9.5, 0, 0.5];  // col 9, row 0 (other side of the wall)
const SAME_SIDE: V3 = [3.5, 0, 0.5];
const inObstacle = (w: V3, ob: typeof GAPPED_WALL): boolean => w[0] > ob.minX && w[0] < ob.maxX && w[2] > ob.minZ && w[2] < ob.maxZ;
function cellWalkable(mgr: NavmeshManager, w: V3): boolean {
  const g = mgr.getGrid()!;
  let col = Math.floor((w[0] - g.originX) / g.cellSize);
  let row = Math.floor((w[2] - g.originZ) / g.cellSize);
  if (col < 0) col = 0; else if (col >= g.cols) col = g.cols - 1;
  if (row < 0) row = 0; else if (row >= g.rows) row = g.rows - 1;
  return g.walkable[row * g.cols + col] === 1;
}

const PERMS = resolveProfile("builder.readWrite");

// ─────────────────────────── 1. PATHFINDING WITH TEETH ───────────────────────────
const reg = new SkillRegistry(new LiminaTracer("ses_p12_nav"));
const core = registerCoreSkills(reg);
const mgr = core.nav.navmeshManager;
const world = makeWorld(ops);
ops.op_physics_create_world(-9.81);
const base = { agentId: "agt_nav", sessionId: "ses_p12_nav", permissions: PERMS, tick: 0, world };

const built = ok(await reg.invoke("navmesh.build", { bounds: REGION, cellSize: 1, obstacles: [GAPPED_WALL] }, base));
assert(built.ok === true, "navmesh.build failed");
assert((built.blocked as number) > 0, "build marked no cells blocked (obstacle ignored)");
assert((built.cols as number) === 10 && (built.rows as number) === 10, `unexpected grid dims ${built.cols}×${built.rows}`);

const fp = ok(await reg.invoke("navmesh.findPath", { from: START, to: GOAL }, base));
const path = fp.path as V3[];
assert(fp.reachable === true && path.length > 1, "no path found around the gapped wall");
// The straight-line stub would cut through col 4 (the wall). A real A* must avoid it:
for (const w of path) {
  assert(!inObstacle(w, GAPPED_WALL), `waypoint [${w}] lies INSIDE the wall obstacle (straight-line cut)`);
  assert(cellWalkable(mgr, w), `waypoint [${w}] lies in a BLOCKED grid cell`);
}
// A straight line would be exactly 2 waypoints; routing around the wall needs more.
assert(path.length > 2, `path has only ${path.length} waypoints — looks like a straight-line cut, not a detour`);
assert(closeV(path[0], START), "path does not start at `from`");
assert(closeV(path[path.length - 1], GOAL), "path does not reach the goal");

// ─────────────────────────── 2. REACHABILITY ───────────────────────────
const rOpen = ok(await reg.invoke("navmesh.isReachable", { from: START, to: GOAL }, base));
assert(rOpen.reachable === true, "open (gapped) goal should be reachable");

ok(await reg.invoke("navmesh.build", { bounds: REGION, cellSize: 1, obstacles: [SOLID_WALL] }, base));
const rWalled = ok(await reg.invoke("navmesh.isReachable", { from: START, to: GOAL }, base));
assert(rWalled.reachable === false, "solid-wall goal should be UNREACHABLE (isReachable still always-true?)");
const rSame = ok(await reg.invoke("navmesh.isReachable", { from: START, to: SAME_SIDE }, base));
assert(rSame.reachable === true, "same-side goal should be reachable");
const fpWalled = ok(await reg.invoke("navmesh.findPath", { from: START, to: GOAL }, base));
assert((fpWalled.path as V3[]).length === 0 && fpWalled.reachable === false, "walled-off findPath should return an empty path");

// ─────────────────────────── 3. MOVEMENT (transform entity) ───────────────────────────
// Rebuild the gapped wall and walk a transform-driven entity to the goal.
ok(await reg.invoke("navmesh.build", { bounds: REGION, cellSize: 1, obstacles: [GAPPED_WALL] }, base));
const eid = spawnRenderable(world.ecs, inert(), START[0], START[1], START[2]);
const ent = world.entities.create({ eid });
ok(await reg.invoke("navmesh.setSpeed", { entity: ent, speed: 4 }, base));

let prevRemaining = Infinity;
let mv: Record<string, unknown> | undefined;
let steps = 0;
do {
  mv = ok(await reg.invoke("navmesh.moveTo", { entity: ent, target: GOAL, dt: 0.5, from: START }, base));
  assert(mv.ok === true, "moveTo returned ok:false on a valid route");
  const remaining = mv.remaining as number;
  if (!(mv.arrived as boolean)) {
    assert(remaining < prevRemaining - 1e-9, `remaining path distance did not decrease (progress stalled): ${remaining} >= ${prevRemaining}`);
  }
  prevRemaining = remaining;
  steps++;
} while (!(mv!.arrived as boolean) && steps < 5000);
assert(mv!.arrived as boolean, "moveTo never reached the target");
assert(closeV(mv!.position as V3, GOAL), `final position ${JSON.stringify(mv!.position)} != goal`);
assert(steps > 1, "arrived in a single step — not actually walking a path");

// ─────────────────────────── 3b. MOVEMENT drives op_physics_move_character ───────────────────────────
// A character-body entity must move via the kinematic CCT op, not the transform path.
ops.op_physics_add_ground(0);
const bodyId = ops.op_physics_add_character(0.5, 1, 0.5, 0.5, 0.3);
const bodyEnt = world.entities.create({ eid: spawnRenderable(world.ecs, inert(), 0.5, 1, 0.5), bodyId });
ok(await reg.invoke("navmesh.build", { bounds: REGION, cellSize: 1 }, base)); // open grid, no obstacles
const bmv = ok(await reg.invoke("navmesh.moveTo", { entity: bodyEnt, target: [5, 1, 0.5], speed: 4, dt: 0.5 }, base));
assert(bmv.ok === true, "body moveTo returned ok:false");
const bpos = bmv.position as V3;
assert(bpos[0] > 0.6, `character body did not move toward target via op_physics_move_character (x=${bpos[0]})`);

// ─────────────────────────── 4a. DETERMINISM — identical findPath ───────────────────────────
const fpA = ok(await reg.invoke("navmesh.findPath", { from: START, to: GOAL }, base)).path as V3[];
const fpB = ok(await reg.invoke("navmesh.findPath", { from: START, to: GOAL }, base)).path as V3[];
assert(samePathExact(fpA, fpB), "two findPath calls returned DIFFERENT waypoint lists (non-deterministic A*)");

// ─────────────────────────── 4b. DETERMINISM — record→replay of a moveTo sequence ───────────────────────────
// Author: record build + setSpeed + a fixed moveTo sequence into the world log. Replay it
// into a FRESH world/registry and assert the final position is bit-identical. The replay
// world creates the SAME single entity (ent_0) so the recorded moveTo resolves it.
const STEP_COUNT = 30;
const recorder = new WorldRecorder("ses_p12_nav_rec");
const recReg = new SkillRegistry(new LiminaTracer("ses_p12_nav_rec"));
const recCore = registerCoreSkills(recReg);
const recMgr = recCore.nav.navmeshManager;
recorder.attach(recReg);
const recOps = recorder.wrapOps(ops);
const recWorld = makeWorld(recOps);
const recBase = { agentId: "agt_rec", sessionId: "ses_p12_nav_rec", permissions: PERMS, tick: 0, world: recWorld };
recOps.op_physics_create_world(-9.81);
const recEid = spawnRenderable(recWorld.ecs, inert(), START[0], START[1], START[2]);
const recEnt = recWorld.entities.create({ eid: recEid }); // ent_0
assert(recEnt === "ent_0", `expected first entity id ent_0, got ${recEnt}`);

ok(await recReg.invoke("navmesh.build", { bounds: REGION, cellSize: 1, obstacles: [GAPPED_WALL] }, recBase));
ok(await recReg.invoke("navmesh.setSpeed", { entity: recEnt, speed: 4 }, recBase));
for (let i = 0; i < STEP_COUNT; i++) {
  ok(await recReg.invoke("navmesh.moveTo", { entity: recEnt, target: GOAL, dt: 0.5, from: START }, recBase));
}
const authFinal = recMgr.getAgent(recEnt)!.pos as V3;

let replayMgr: NavmeshManager | undefined;
await replayCommands(recorder.commands, {
  makeWorld: () => {
    const w = makeWorld(ops);
    const e = spawnRenderable(w.ecs, inert(), START[0], START[1], START[2]);
    w.entities.create({ eid: e }); // ent_0, matching the recorded entity
    return w;
  },
  makeRegistry: (tr) => {
    const r = new SkillRegistry(tr as LiminaTracer);
    replayMgr = registerCoreSkills(r).nav.navmeshManager;
    return r;
  },
  tracer: new LiminaTracer("ses_p12_nav_replay"),
});
const replayFinal = replayMgr!.getAgent("ent_0")!.pos as V3;
assert(samePathExact([authFinal], [replayFinal]), `replay final position ${JSON.stringify(replayFinal)} != authoring ${JSON.stringify(authFinal)} (non-deterministic moveTo)`);

ops.op_log(
  `p12_navmesh OK: grid navmesh (${built.cols}×${built.rows}, ${built.blocked} blocked) + deterministic A*; ` +
  `findPath routes AROUND the wall in ${path.length} waypoints (all walkable, none in the obstacle) and reaches the goal; ` +
  `isReachable true across the gap / FALSE across a solid wall / true same-side; ` +
  `moveTo walked the transform entity to the goal in ${steps} steps (remaining strictly decreasing) and drives op_physics_move_character for a character body; ` +
  `findPath is bit-identical across runs; record→replay of ${STEP_COUNT} moveTo steps reproduces the identical final position ${JSON.stringify(replayFinal)}.`,
);
