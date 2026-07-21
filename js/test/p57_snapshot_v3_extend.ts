// P57 — WorldSnapshot v3 is self-sufficient for a rebuild WITHOUT replaying the
// pre-snapshot authoring commands. This is step s1 of the editor snapshot+bounded-tail
// refactor: the snapshot now carries each entity's TAGS and RESOURCE metadata, so a
// bounded-tail viewer (which no longer has the create/tag commands) can restore them.
//
// compareWorldState only checks transforms + physics bodies, so this test asserts the
// tags/resource round-trip EXPLICITLY, through capture → JSON → parse → recoverWorld
// (the real mid-stream recovery path, with an empty delta so it is a pure restore).

import { ops, EntityTable, type LoadedResourceMetadata, type WorldContext } from "../src/engine.ts";
import { createEcsWorld } from "../src/ecs/world.ts";
import { createTransformStorage } from "../src/ecs/facade.ts";
import { UniformGridSpatialIndex } from "../src/spatial/index.ts";
import { SkillRegistry } from "../src/skills/registry.ts";
import { registerCoreSkills } from "../src/skills/index.ts";
import { resolveProfile } from "../src/skills/permissions.ts";
import { LiminaTracer } from "../src/observability/event.ts";
import { captureWorldState, compareWorldState, installSeededRandom } from "../src/worldlog/log.ts";
import {
  captureWorldSnapshot,
  parseSnapshot,
  recoverWorld,
  serializeSnapshot,
  SNAPSHOT_VERSION,
} from "../src/worldlog/snapshot.ts";

function assert(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new Error("p57_snapshot_v3_extend: " + msg);
}

function makeHeadlessWorld(): WorldContext {
  const ecs = createEcsWorld();
  const scene = { add() {}, remove() {}, position: { set() {}, x: 0, y: 0, z: 0 }, background: null as unknown };
  const camera = { position: { set() {} }, aspect: 1, lookAt() {}, updateProjectionMatrix() {} };
  return {
    ecs,
    transforms: createTransformStorage(ecs),
    spatial: new UniformGridSpatialIndex(),
    entities: new EntityTable(),
    tags: new Map(),
    scene,
    camera,
    ops,
    mode: "headless",
  };
}
function makeRegistry(tracer: LiminaTracer): SkillRegistry {
  const registry = new SkillRegistry(tracer);
  registerCoreSkills(registry);
  return registry;
}

const perms = resolveProfile("builder.readWrite");
// A seeded RNG must be installed for captureRandomState/restore to round-trip.
installSeededRandom(0x9057);
ops.op_physics_create_world(-9.81);

// ---- Author a small world: a tagged entity + an asset-backed (resource) entity ----
const world = makeHeadlessWorld();
const registry = makeRegistry(new LiminaTracer("ses_p57"));
const at = (tick: number) => ({ agentId: "agt_p57", sessionId: "ses_p57", permissions: perms, tick, world });

const rA = await registry.invoke("scene.createEntity", { position: [1, 2, 3] }, at(1));
const rB = await registry.invoke("scene.createEntity", { position: [4, 5, 6] }, at(2));
// C: a distinctly-shaped primitive — its shape/size/color live ONLY in the create command,
// so the origin is the only way a bounded-tail viewer can rebuild its mesh.
const rC = await registry.invoke("scene.createEntity", { shape: "sphere", size: 2, color: 0xff0000, position: [7, 8, 9] }, at(3));
const idA = (rA.result as { entity: string }).entity;
const idB = (rB.result as { entity: string }).entity;
const idC = (rC.result as { entity: string }).entity;
const eidA = world.entities.resolve(idA)!.eid;

// Tag A; give B a resource binding (as an asset-place skill would).
world.tags.set(eidA, new Set(["hostile", "tower"]));
const resourceB: LoadedResourceMetadata = {
  kind: "gltf", assetId: "watchtower-1", source: "poly.pizza", hash: "sha256:deadbeef",
  bytes: 20480, rootName: "Watchtower", objectCount: 3, meshCount: 5, materialCount: 2, textureCount: 1,
};
world.entities.bindResource(idB, resourceB);

const recordedState = captureWorldState(world);

// ---- Capture v3 snapshot, round-trip through JSON, then RESTORE (empty delta) ----
const snap = captureWorldSnapshot(world, { sessionId: "ses_p57", tick: 10, snapshotSeq: registry.tracer.inspect().eventCount + 999 });
assert(snap.snapshotVersion === SNAPSHOT_VERSION && SNAPSHOT_VERSION === 3, "snapshot must be v3");

const entA = snap.entities.find((e) => e.id === idA)!;
const entB = snap.entities.find((e) => e.id === idB)!;
assert(entA.tags.join(",") === "hostile,tower", "capture must record tags (sorted) on the tagged entity");
assert(entB.tags.length === 0, "untagged entity must capture empty tags");
assert(entB.resource?.assetId === "watchtower-1", "capture must record resource metadata on the asset entity");
assert(entA.resource === undefined, "non-asset entity must have no resource");

// Round-trip through the wire/persistence format (JSON + zod parse).
const parsed = parseSnapshot(serializeSnapshot(snap));
assert(parsed.entities.find((e) => e.id === idB)?.resource?.hash === "sha256:deadbeef", "resource must survive JSON round-trip");
assert(parsed.entities.find((e) => e.id === idA)?.tags.join(",") === "hostile,tower", "tags must survive JSON round-trip");

// Origin: the structural params for rebuilding the mesh must survive capture + JSON round-trip.
const entC = snap.entities.find((e) => e.id === idC)!;
assert(entC.origin?.tool === "scene.createEntity", "capture must record the create command as origin");
assert(entC.origin?.input.shape === "sphere" && entC.origin?.input.size === 2 && entC.origin?.input.color === 0xff0000, "origin must carry the structural params (shape/size/color)");
const parsedC = parsed.entities.find((e) => e.id === idC)!;
assert(parsedC.origin?.input.shape === "sphere" && parsedC.origin?.input.size === 2, "origin structural params must survive JSON round-trip");

const recovered = await recoverWorld(parsed, [], { makeWorld: makeHeadlessWorld, makeRegistry, tracer: new LiminaTracer("ses_p57_recover") });

// 1. Transforms/physics identical (the pre-existing contract).
assert(compareWorldState(recordedState, recovered.state).identical, "recovered transforms diverged from the original");

// 2. Tags restored onto the SAME eid (the new v3 contract).
const restoredTags = recovered.world.tags.get(eidA);
assert(restoredTags !== undefined && [...restoredTags].sort().join(",") === "hostile,tower", "tags were not restored from the snapshot");
assert(recovered.world.tags.get(world.entities.resolve(idB)!.eid) === undefined, "untagged entity must have no tags after restore");

// 3. Resource metadata rebound onto the live entry (the new v3 contract).
const restoredRes = recovered.world.entities.resolve(idB)?.resource;
assert(restoredRes !== undefined, "resource was not restored from the snapshot");
assert(restoredRes.assetId === "watchtower-1" && restoredRes.hash === "sha256:deadbeef" && restoredRes.meshCount === 5, "restored resource metadata is wrong");
assert(recovered.world.entities.resolve(idA)?.resource === undefined, "non-asset entity must have no resource after restore");

// 4. Origin (create command) rebound so a restored world can also rebuild structure.
const restoredOrigin = recovered.world.entities.resolve(idC)?.origin;
assert(restoredOrigin?.tool === "scene.createEntity" && restoredOrigin?.input.shape === "sphere" && restoredOrigin?.input.size === 2, "origin was not restored from the snapshot");

ops.op_log("[js] p57_snapshot_v3_extend OK: WorldSnapshot v3 captures + restores tags and resource metadata (JSON round-trip + recoverWorld), so the snapshot alone rebuilds the world without replaying pre-snapshot authoring commands");
