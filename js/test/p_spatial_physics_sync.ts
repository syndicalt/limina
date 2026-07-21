import type { EngineOps } from "../src/engine.ts";
import { createTransformStorage } from "../src/ecs/facade.ts";
import { Position, Rotation } from "../src/ecs/world.ts";
import { UniformGridSpatialIndex, querySpatialEntities } from "../src/spatial/index.ts";
import { syncAllBodies } from "../src/worldlog/log.ts";

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(`p_spatial_physics_sync FAIL: ${message}`);
}

const eid = 37;
Position.x[eid] = 0; Position.y[eid] = 0; Position.z[eid] = 0;
Rotation.x[eid] = 0; Rotation.y[eid] = 0; Rotation.z[eid] = 0; Rotation.w[eid] = 1;

const transforms = createTransformStorage(null);
const entities = {
  version: 1,
  ids: (): string[] => ["body/entity"],
  resolve: (id: string) => id === "body/entity" ? { eid, bodyId: 9 } : undefined,
};
const spatial = new UniformGridSpatialIndex({ cellSize: 4 });
const ops = {
  op_physics_body_transform(_bodyId: number, out: Float32Array): void {
    out[0] = 20; out[1] = 3; out[2] = -8;
    out[3] = 0; out[4] = 0.5; out[5] = 0; out[6] = Math.sqrt(0.75);
  },
} as unknown as EngineOps;
const world = { entities, transforms, spatial, ops, tags: new Map<number, Set<string>>() };

assert(spatial.ensureFresh(world), "initial spatial build did not occur");
assert(!spatial.ensureFresh(world), "unchanged world spuriously rebuilt");
const versionBefore = transforms.version;
syncAllBodies(world);
assert(transforms.version === versionBefore + 2, "physics sync bypassed versioned position/rotation writers");
assert(spatial.ensureFresh(world), "physics sync did not invalidate transform-derived spatial data");

const result = querySpatialEntities(world, { near: [20, 3, -8], radius: 0.01, sortBy: "entity" });
assert(result.entities.length === 1 && result.entities[0]?.entity === "body/entity",
  "fresh spatial query did not observe the physics-synchronized position");
assert(Position.x[eid] === 20 && Position.y[eid] === 3 && Position.z[eid] === -8,
  "versioned physics sync did not update canonical position SoA");

console.log("p_spatial_physics_sync OK: body sync advances TransformStorage version and spatial queries rebuild to the authoritative pose");
