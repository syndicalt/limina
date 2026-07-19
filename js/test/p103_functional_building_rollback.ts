// Focused H1 regression: a functional building or door mutation may succeed as
// a nested step and then be followed by a failure in the outer head skill. The
// discarded head must leave entities, physics, origins/tags, topology,
// interaction affordances, nav portals/revisions, allocators, and the log exactly
// as they were before the head began.

import { z } from "../build/zod.bundle.mjs";
import { AssetRegistry } from "../src/asset-registry.ts";
import { createTransformStorage } from "../src/ecs/facade.ts";
import { createEcsWorld, Position, Rotation } from "../src/ecs/world.ts";
import { EntityTable, ops, type EngineOps } from "../src/engine.ts";
import type { MCPResponse } from "../src/mcp/protocol.ts";
import { LiminaTracer } from "../src/observability/event.ts";
import { registerCoreSkills, type CoreSkills } from "../src/skills/index.ts";
import { resolveProfile } from "../src/skills/permissions.ts";
import { SkillRegistry, type ExecutionContext, type InvokeBase, type SkillDefinition, type WorldContext } from "../src/skills/registry.ts";
import { UniformGridSpatialIndex } from "../src/spatial/index.ts";
import { captureWorldState, compareWorldState, installSeededRandom } from "../src/worldlog/log.ts";
import { WorldRecorder } from "../src/worldlog/recorder.ts";

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(`p103_functional_building_rollback FAIL: ${message}`);
}
function ok(response: MCPResponse, label: string): Record<string, unknown> {
  if (!response.success) throw new Error(`${label}: ${JSON.stringify(response.error)}`);
  return response.result as Record<string, unknown>;
}
function makeWorld(worldOps: EngineOps): WorldContext {
  const ecs = createEcsWorld();
  return { ecs, transforms: createTransformStorage(ecs), spatial: new UniformGridSpatialIndex(), entities: new EntityTable(), tags: new Map(),
    scene: { add() {}, remove() {}, position: { set() {}, x: 0, y: 0, z: 0 }, background: null },
    camera: { position: { set() {} }, aspect: 1, lookAt() {}, updateProjectionMatrix() {} },
    ops: worldOps, mode: "headless", simWorker: true } as WorldContext;
}
function bodiesAt(x: number, z: number): number {
  const out = new Uint32Array(128);
  return wrapped.op_physics_overlap_box(x, 1, z, 5, 3, 5, 0, 0, 0, 1, -1, out);
}
const node = (id: string, role: string, data: Record<string, unknown> = {}) => ({ extras: { limina: { id, role, ...data } } });
function rooted(authority: Record<string, unknown>, nodes: any[]): Uint8Array {
  nodes[0] = { ...nodes[0], children: nodes.slice(1).map((_, index) => index + 1) };
  return new TextEncoder().encode(JSON.stringify({ ...authority, scene: 0, scenes: [{ nodes: [0] }], nodes,
    animations: [{ name: "door/main/open", channels: [{ target: { node: nodes.length - 1, path: "rotation" } }], samplers: [] }] }));
}
const v1Bytes = rooted({ asset: { version: "2.0", extras: { liminaFunctionalBuilding: {
  schema: "limina.functional-building/v1", units: "meter", up: "Y", buildingId: "fixture/rollback-v1",
  rootNodeId: "building/root", roomIds: ["room/main"], portalIds: ["portal/main"], entryAnchor: [0, 0, -2],
} } } }, [
  node("building/root", "root"), node("room/main", "room"), node("portal/main", "portal"),
  ...Array.from({ length: 5 }, (_, index) => node(`collider/${index}`, "collider", { shape: "box", center: [index - 2, 1, 0], halfExtents: [.1, 1, 1] })),
  node("door/main", "door", { roomId: "room/main", portalId: "portal/main", hinge: [0, 1, 0], center: [.5, 0, 0],
    halfExtents: [.5, 1, .08], closedYaw: 0, openYaw: -Math.PI / 2 }),
]);
const rooms = [
  { id: "room/main", bounds: { center: [-1, 1.5, 0], halfExtents: [1, 1.5, 2] }, finishedFloorY: 0, ceilingY: 3, storey: 0,
    visibilityCellId: "cell/main", acoustics: { absorption: .2, reverb: .3 } },
  { id: "room/side", bounds: { center: [1, 1.5, 0], halfExtents: [1, 1.5, 2] }, finishedFloorY: 0, ceilingY: 3, storey: 0,
    visibilityCellId: "cell/side", acoustics: { absorption: .3, reverb: .2 } },
];
const v2Bytes = rooted({ asset: { version: "2.0", extras: { liminaFunctionalBuilding: {
  schema: "limina.functional-building/v2", units: "meter", up: "Y", buildingId: "fixture/rollback-v2",
  rootNodeId: "building/root", roomIds: ["room/main", "room/side"], portalIds: ["portal/exterior", "portal/main"], entryAnchor: [-2, 0, 0],
  rooms,
  portals: [
    { id: "portal/exterior", kind: "passage", exterior: true, roomIds: [null, "room/main"], center: [-2, 1, 0], halfExtents: [.1, 1, .6], acousticTransmission: .8 },
    { id: "portal/main", kind: "door", exterior: false, roomIds: ["room/main", "room/side"], center: [0, 1, 0], halfExtents: [.1, 1, .6], acousticTransmission: .4, doorId: "door/main" },
  ], verticalLinks: [],
  spawnAnchors: [
    { id: "spawn/main", roomId: "room/main", kind: "player", position: [-1, 0, 0], direction: [1, 0, 0], clearanceRadius: .35, clearanceHeight: 1.8 },
    { id: "spawn/side", roomId: "room/side", kind: "npc", position: [1, 0, 0], direction: [-1, 0, 0], clearanceRadius: .35, clearanceHeight: 1.8 },
  ], visibilityCells: [
    { id: "cell/main", roomIds: ["room/main"], nodeIds: ["room/main"] },
    { id: "cell/side", roomIds: ["room/side"], nodeIds: ["room/side"] },
  ],
} } } }, [
  node("building/root", "root"), node("room/main", "room"), node("room/side", "room"), node("portal/exterior", "portal"), node("portal/main", "portal"),
  ...Array.from({ length: 5 }, (_, index) => node(`collider/${index}`, "collider", { shape: "box", center: [index - 2, 1, index % 2 ? 2 : -2], halfExtents: [.1, 1, 1] })),
  node("door/main", "door", { roomId: "room/main", portalId: "portal/main", hinge: [0, 1, 0], center: [.5, 0, 0],
    halfExtents: [.5, 1, .08], closedYaw: 0, openYaw: -Math.PI / 2 }),
]);

const assets = new AssetRegistry(ops), V1 = "buildings/p103-functional-v1.gltf", V2 = "buildings/p103-functional-v2.gltf";
assets.seed(V1, v1Bytes); assets.seed(V2, v2Bytes);
installSeededRandom(0xFB4103, true);
const tracer = new LiminaTracer("ses_p103_functional"), recorder = new WorldRecorder("ses_p103_functional"), registry = new SkillRegistry(tracer);
const core: CoreSkills = registerCoreSkills(registry, { assets }), wrapped = recorder.wrapOps(ops), world = makeWorld(wrapped);
recorder.attach(registry); recorder.seed(0xFB4103, { forceInstall: true }); wrapped.op_physics_create_world(0);
const permissions = resolveProfile("builder.readWrite");
const base = (tick: number): InvokeBase => ({ agentId: "builder", sessionId: "ses_p103_functional", permissions, tick, world });
const nested = (ctx: ExecutionContext): InvokeBase => ({ agentId: ctx.agentId, sessionId: ctx.sessionId, permissions: ctx.permissions, tick: ctx.tick, world: ctx.world, chainId: ctx.chainId, chainToken: ctx.chainToken });

let placedDuringFailure: Array<{ root: string; door: string; portalRuntimeId: string }> = [];
registry.register({
  name: "test.functionalPlacementThenFail", version: "1.0.0", description: "p103 functional placement rollback probe", category: "system",
  permissions: ["scene.write"], input: z.object({}), output: z.object({ ok: z.boolean() }),
  handler: async (_input, ctx) => {
    placedDuringFailure = [];
    for (const [assetId, position] of [[V1, [20, 0, 20]], [V2, [-20, 0, -20]]] as const) {
      const result = ok(await registry.invoke("building.placeFunctional", { assetId, position, yaw: .21 }, nested(ctx)), assetId);
      const door = (result.doors as string[])[0]!;
      placedDuringFailure.push({ root: result.root as string, door,
        portalRuntimeId: (ctx.world.entities.resolve(door)!.origin!.input as { portalRuntimeId: string }).portalRuntimeId });
    }
    throw new Error("p103 injected post-placement failure");
  },
} as SkillDefinition);

const emptyState = captureWorldState(world), emptySeq = world.entities.nextSeq, emptyVersion = world.entities.version,
  emptyInteractions = JSON.stringify(core.interaction.interactionManager.captureSnapshot()),
  emptyPortals = JSON.stringify(core.nav.navmeshManager.capturePortalSnapshot()), emptyNavRevision = core.nav.navmeshManager.getRevision(),
  emptyTopologyRevision = core.functionalBuildings.topologyManager.getRevision(), emptyCommands = recorder.commandCount;
const failedPlacement = await registry.invoke("test.functionalPlacementThenFail", {}, base(1));
assert(!failedPlacement.success && failedPlacement.error?.code === "handler_error", "outer placement probe did not fail");
assert(compareWorldState(emptyState, captureWorldState(world)).identical, "failed placement changed world state");
assert(world.entities.nextSeq === emptySeq && world.entities.version === emptyVersion, "failed placement moved entity allocator/version");
assert(world.tags.size === 0, "failed placement leaked tags");
assert(JSON.stringify(core.interaction.interactionManager.captureSnapshot()) === emptyInteractions, "failed placement leaked an interaction affordance");
assert(JSON.stringify(core.nav.navmeshManager.capturePortalSnapshot()) === emptyPortals && core.nav.navmeshManager.getRevision() === emptyNavRevision,
  "failed placement leaked a nav portal or revision");
assert(core.functionalBuildings.topologyManager.size() === 0 && core.functionalBuildings.topologyManager.getRevision() === emptyTopologyRevision,
  "failed placement leaked topology or its revision");
assert(recorder.commandCount === emptyCommands, "failed placement escaped into the world log");
wrapped.op_physics_step();
assert(bodiesAt(20, 20) === 0 && bodiesAt(-20, -20) === 0, "failed placement leaked a native physics body");
for (const item of placedDuringFailure) {
  assert(world.entities.resolve(item.root) === undefined && world.entities.resolve(item.door) === undefined, "failed placement left a live entity");
  assert(core.nav.navmeshManager.isPortalOpen(item.portalRuntimeId) === undefined, "failed placement left a queryable nav portal");
}

const p1 = ok(await registry.invoke("building.placeFunctional", { assetId: V1, position: [20, 0, 20], yaw: .21 }, base(2)), "committed v1"),
  p2 = ok(await registry.invoke("building.placeFunctional", { assetId: V2, position: [-20, 0, -20], yaw: .21 }, base(3)), "committed v2"),
  doors = [(p1.doors as string[])[0]!, (p2.doors as string[])[0]!];
const stableWorld = captureWorldState(world), stableSeq = world.entities.nextSeq, stableVersion = world.entities.version,
  stableInteractions = JSON.stringify(core.interaction.interactionManager.captureSnapshot()),
  stablePortals = JSON.stringify(core.nav.navmeshManager.capturePortalSnapshot()), stableNavRevision = core.nav.navmeshManager.getRevision(),
  stableTopologyRevision = core.functionalBuildings.topologyManager.getRevision(), stableCommands = recorder.commandCount,
  stableOrigins = doors.map((door) => JSON.stringify(world.entities.resolve(door)!.origin)),
  stableTags = doors.map((door) => [...world.tags.get(world.entities.resolve(door)!.eid)!].sort().join(",")),
  stableTransforms = doors.map((door) => { const entry = world.entities.resolve(door)!; return [Position.x[entry.eid],Position.y[entry.eid],Position.z[entry.eid],Rotation.x[entry.eid],Rotation.y[entry.eid],Rotation.z[entry.eid],Rotation.w[entry.eid]]; });
registry.register({
  name: "test.functionalDoorsThenFail", version: "1.0.0", description: "p103 functional door rollback probe", category: "system",
  permissions: ["scene.write"], input: z.object({}), output: z.object({ ok: z.boolean() }),
  handler: async (_input, ctx) => {
    for (const door of doors) {
      ok(await registry.invoke("door.setOpen", { door, open: true }, nested(ctx)), `open ${door}`);
      ok(await registry.invoke("door.setLocked", { door, locked: true, keyId: "key/p103" }, nested(ctx)), `lock ${door}`);
    }
    throw new Error("p103 injected post-door failure");
  },
} as SkillDefinition);
const failedDoors = await registry.invoke("test.functionalDoorsThenFail", {}, base(4));
assert(!failedDoors.success && failedDoors.error?.code === "handler_error", "outer door probe did not fail");
assert(compareWorldState(stableWorld, captureWorldState(world)).identical, "failed door chain changed world state");
assert(world.entities.nextSeq === stableSeq && world.entities.version === stableVersion, "failed door chain moved entity allocator/version");
assert(JSON.stringify(core.interaction.interactionManager.captureSnapshot()) === stableInteractions, "failed door chain changed interaction state");
assert(JSON.stringify(core.nav.navmeshManager.capturePortalSnapshot()) === stablePortals && core.nav.navmeshManager.getRevision() === stableNavRevision,
  "failed door chain changed nav portal state/revision");
assert(core.functionalBuildings.topologyManager.getRevision() === stableTopologyRevision, "failed door chain changed topology revision");
assert(recorder.commandCount === stableCommands, "failed door chain escaped into the world log");
for (let index = 0; index < doors.length; index++) {
  const entry = world.entities.resolve(doors[index]!)!;
  assert(JSON.stringify(entry.origin) === stableOrigins[index], `failed door chain changed origin ${index}`);
  assert([...world.tags.get(entry.eid)!].sort().join(",") === stableTags[index], `failed door chain changed tags ${index}`);
  assert(JSON.stringify([Position.x[entry.eid],Position.y[entry.eid],Position.z[entry.eid],Rotation.x[entry.eid],Rotation.y[entry.eid],Rotation.z[entry.eid],Rotation.w[entry.eid]]) === JSON.stringify(stableTransforms[index]),
    `failed door chain changed transform ${index}`);
}
assert(core.nav.navmeshManager.isPortalOpen((world.entities.resolve(doors[0])!.origin!.input as { portalRuntimeId: string }).portalRuntimeId) === false,
  "v1 nav portal did not return closed");
assert(core.functionalBuildings.topologyManager.isPortalOpen(p2.root as string, "portal/main") === false, "v2 topology portal did not return closed");

ops.op_log("p103_functional_building_rollback OK: post-placement and post-door outer failures leave entity/physics projection, allocator, origin/tags/transforms, topology, interaction, nav revisions, and log unchanged");
