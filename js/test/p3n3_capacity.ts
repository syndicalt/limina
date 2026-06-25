// P3N-3: MAX_ENTITIES raised 4096 -> 16384. Proves every coupled structure moved
// — entities spawn past the OLD 4096 cap (bitECS world + the eid>=MAX_ENTITIES
// guard), and transform write/read (SoA), spatial query, and render-sync are all
// correct at eid > 4096 (not just an array-length assert).
//
// Run: limina js/test/p3n3_capacity.ts

import { EntityTable, ops } from "../src/engine.ts";
import { createEcsWorld, MAX_ENTITIES, Position, renderSyncSystem, spawnRenderable } from "../src/ecs/world.ts";
import { createTransformStorage } from "../src/ecs/facade.ts";
import { LiminaTracer } from "../src/observability/event.ts";
import { SkillRegistry, type WorldContext } from "../src/skills/registry.ts";
import { registerCoreSkills } from "../src/skills/index.ts";
import { resolveProfile } from "../src/skills/permissions.ts";
import { UniformGridSpatialIndex, querySpatialEntities } from "../src/spatial/index.ts";
import type { MCPResponse } from "../src/mcp/protocol.ts";

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
function ok(res: MCPResponse): unknown {
  if (!res.success) throw new Error("call failed: " + JSON.stringify(res.error));
  return res.result;
}
function field(v: unknown, k: string): unknown {
  return typeof v === "object" && v !== null && k in v ? (v as Record<string, unknown>)[k] : undefined;
}

const OLD_CAP = 4096;
assert(MAX_ENTITIES === 16384, `MAX_ENTITIES expected 16384, got ${MAX_ENTITIES}`);

const scene = { add() {}, remove() {}, position: { set() {}, x: 0, y: 0, z: 0 }, background: null as unknown };
const camera = { position: { set() {} }, aspect: 1, lookAt() {}, updateProjectionMatrix() {} };
const ecs = createEcsWorld();
const world: WorldContext = {
  ecs,
  transforms: createTransformStorage(ecs),
  spatial: new UniformGridSpatialIndex({ cellSize: 10 }),
  entities: new EntityTable(),
  tags: new Map(),
  scene,
  camera,
  ops,
};
ops.op_physics_create_world(0);
const tracer = new LiminaTracer("ses_p3n3");
const registry = new SkillRegistry(tracer);
registerCoreSkills(registry);
const builder = { agentId: "agt_cap", sessionId: "ses_p3n3", permissions: resolveProfile("builder.readWrite"), tick: 0, world };

// Spawn well past the OLD 4096 cap via the skill path (would throw at 4097 before).
const N = 5000;
let maxEid = 0;
let highEntity = "";
for (let i = 0; i < N; i++) {
  const e = field(ok(await registry.invoke("scene.createEntity", { position: [i * 0.3 - 750, 0, (i % 50) * 0.4] }, builder)), "entity");
  assert(typeof e === "string", `createEntity ${i} failed`);
  const eid = world.entities.resolve(e)?.eid ?? -1;
  if (eid > maxEid) maxEid = eid;
  if (eid > OLD_CAP && highEntity === "") highEntity = e;
}
assert(maxEid > OLD_CAP, `expected an eid > ${OLD_CAP}, max was ${maxEid}`);
assert(highEntity !== "", `no entity landed at eid > ${OLD_CAP}`);
const highEid = world.entities.resolve(highEntity)!.eid;

// Transform write/read at high eid (SoA correct beyond the old cap).
ok(await registry.invoke("three.setTransform", { entity: highEntity, position: [123.5, 4.0, -67.25] }, builder));
assert(
  Position.x[highEid] === 123.5 && Position.y[highEid] === 4.0 && Position.z[highEid] === -67.25,
  `SoA transform wrong at eid ${highEid}: ${Position.x[highEid]},${Position.y[highEid]},${Position.z[highEid]}`,
);

// Spatial query finds the high-eid entity.
const res = querySpatialEntities(world, { near: [123.5, 4.0, -67.25], radius: 2, sortBy: "distance" });
assert(res.entities.some((r) => r.eid === highEid), `spatial query did not find high-eid entity ${highEid}`);

// Render-sync writes to an object bound at eid > 4096 (capture via a stub object).
const captured = {
  pos: [0, 0, 0] as number[],
  position: { set: (x: number, y: number, z: number) => { captured.pos = [x, y, z]; } },
  quaternion: { set() {} },
  scale: { set() {} },
};
const stubEid = spawnRenderable(world.ecs, captured, 7, 8, 9);
assert(stubEid > OLD_CAP, `stub eid ${stubEid} not > ${OLD_CAP}`);
renderSyncSystem(world.ecs);
assert(captured.pos[0] === 7 && captured.pos[1] === 8 && captured.pos[2] === 9, `render-sync did not write object at eid ${stubEid}: ${captured.pos.join(",")}`);

ops.op_log(`P3N-3 OK: ${N} entities spawned past the old ${OLD_CAP} cap (max eid ${maxEid}); transform/query/render-sync correct at eid>${OLD_CAP} (MAX_ENTITIES=${MAX_ENTITIES})`);
