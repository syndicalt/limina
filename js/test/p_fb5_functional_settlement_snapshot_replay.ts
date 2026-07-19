import { z } from "../build/zod.bundle.mjs";
import { AssetRegistry } from "../src/asset-registry.ts";
import { loadApprovedFunctionalSettlementRelease } from "../src/assets/functional-settlement-release.mjs";
import { createTransformStorage } from "../src/ecs/facade.ts";
import { createEcsWorld } from "../src/ecs/world.ts";
import { EntityTable, ops, type EngineOps } from "../src/engine.ts";
import { LiminaTracer } from "../src/observability/event.ts";
import { registerCoreSkills } from "../src/skills/index.ts";
import { resolveProfile } from "../src/skills/permissions.ts";
import { SkillRegistry, type WorldContext } from "../src/skills/registry.ts";
import { UniformGridSpatialIndex } from "../src/spatial/index.ts";
import { canonicalCompilerJson } from "../src/world/compiler/canonical.mjs";
import { captureWorldSnapshot, restoreSnapshot } from "../src/worldlog/snapshot.ts";
import { installSeededRandom } from "../src/worldlog/log.ts";

const assert = (value: unknown, message: string): asserts value => { if (!value) throw new Error(`p_fb5_functional_settlement_snapshot_replay FAIL: ${message}`); };
const rejects = (fn: () => void, pattern: RegExp, message: string): void => { let error: unknown; try { fn(); } catch (caught) { error = caught; }
  if (!(error instanceof Error) || !pattern.test(error.message)) throw new Error(`p_fb5_functional_settlement_snapshot_replay FAIL: ${message}: ${error instanceof Error ? error.message : "no error"}`); };
const read = (path: string): Uint8Array => ops.op_read_asset(path);
const release = loadApprovedFunctionalSettlementRelease(read("assets/settlements/functional-hall-r1/release.json"), read) as any;
const terrain = release.release.terrain, c = Math.cos(terrain.yaw), s = Math.sin(terrain.yaw);
const sampleHeight = (x: number, z: number): number => terrain.baseHeight + terrain.localZSlope * ((x - terrain.origin[0]) * s + (z - terrain.origin[1]) * c);
const namespace = "release/functional-hall-r1/snapshot";
const permissions = resolveProfile("builder.readWrite");

function makeWorld(worldOps: EngineOps): WorldContext {
  const ecs = createEcsWorld();
  return { ecs, transforms: createTransformStorage(ecs), spatial: new UniformGridSpatialIndex(), entities: new EntityTable(), tags: new Map(),
    scene: { add() {}, remove() {}, position: { set() {}, x: 0, y: 0, z: 0 }, background: null },
    camera: { position: { set() {} }, aspect: 1, lookAt() {}, updateProjectionMatrix() {} },
    ops: worldOps, mode: "headless", simWorker: true } as WorldContext;
}

function runtime(label: string) {
  const assets = new AssetRegistry(ops);
  const world = makeWorld(ops), registry = new SkillRegistry(new LiminaTracer(label));
  const core = registerCoreSkills(registry, { assets, functionalSettlementSiteSampler: sampleHeight });
  let genericCalls = 0;
  registry.replace("asset.place", { name: "asset.place", version: "trap", description: "snapshot replay trap", category: "scene",
    permissions: ["scene.write"], input: z.unknown(), output: z.unknown(), handler() { genericCalls++; throw new Error("generic asset.place forbidden"); } } as any);
  let tick = 1;
  const invokeBase = () => ({ agentId: "release-replay", sessionId: label, permissions, tick: tick++, world });
  const residency = core.functionalSettlements.releaseHost.load({
    releasePath: "assets/settlements/functional-hall-r1/release.json", read, namespace, invokeBase,
  });
  const participantKey = core.snapshotParticipants.keys().find((key) => key.startsWith("functionalSettlements.residency."));
  const participant = participantKey === undefined ? undefined : core.snapshotParticipants.get(participantKey);
  assert(participant, "normal releaseHost.load did not enroll released residency snapshot ownership");
  return { world, registry, core, residency, participant, invokeBase, genericCalls: () => genericCalls };
}

ops.op_physics_create_world(0);
installSeededRandom(0xFB55, true);
const live = runtime("fb5-snapshot-live"), allUnits = release.plan.placements.map((placement: any) => placement.residency.unitId).sort();
const center = release.plan.placements.find((placement: any) => placement.residency.unitId === "residency/functional-hall/b")!.position;
live.residency.setExplicitInterest(allUnits);
const before = await live.residency.update(center);
assert(before.residentUnitIds.length === release.runtime.maxActiveUnits && live.core.functionalSettlements.placementManager.size() === release.runtime.maxActiveUnits,
  "current release did not establish the bounded whole-building snapshot fixture");
const managerKeys = live.core.snapshotParticipants.keys();
assert(managerKeys.indexOf("functionalSettlements.placements") < managerKeys.indexOf(live.participant.key),
  "residency participant does not restore after placement ownership");
const releasedCapture = live.participant.capture() as any;
assert(releasedCapture.release.releaseId === release.release.releaseId && releasedCapture.release.closureHash === release.release.closureHash &&
  canonicalCompilerJson(releasedCapture.runtime) === canonicalCompilerJson(release.runtime) && releasedCapture.ownership.length === before.residentUnitIds.length,
  "release identity, budgets, or ownership were omitted from the durable participant");
const durable = captureWorldSnapshot(live.world, { sessionId: "fb5-release-snapshot", tick: 11, snapshotSeq: 0,
  participants: live.core.snapshotParticipants });
assert(durable.managers["functionalSettlements.placements"] !== undefined && durable.managers[live.participant.key] !== undefined,
  "durable world snapshot omitted placement or released-residency authority");

live.residency.setExplicitInterest([]);
const liveTerminal = await live.residency.update([900000, 0, -900000]);
assert(liveTerminal.residentUnitIds.length === 0 && live.core.functionalSettlements.placementManager.size() === 0,
  "live continuation did not unload the released whole-building set");
rejects(() => live.core.snapshotParticipants.unregister(live.participant.key, { ...live.participant }), /different participant/,
  "stale session could unregister a participant it does not own");
assert(live.core.snapshotParticipants.has(live.participant.key), "ownership-safe unregister removed the live participant after rejection");
await live.residency.close();
assert(live.core.functionalSettlements.releaseHost.size === 0 && !live.core.snapshotParticipants.has(live.participant.key),
  "normal releaseHost close did not retire its dynamic snapshot participant");

ops.op_physics_create_world(0);
const replay = runtime("fb5-snapshot-replay");
restoreSnapshot(replay.world, durable, undefined, undefined, replay.core.snapshotParticipants);
assert(canonicalCompilerJson(replay.residency.snapshot()) === canonicalCompilerJson(before) &&
  replay.core.functionalSettlements.placementManager.size() === before.residentUnitIds.length,
  "snapshot restore did not recover exact interest, revision, byte budget, and placement ownership");
const restoredCapture = replay.participant.capture() as any;
assert(canonicalCompilerJson(restoredCapture) === canonicalCompilerJson(releasedCapture),
  "released participant was not byte-canonical after restore");

const beforeHostile = canonicalCompilerJson(replay.residency.snapshot()), clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const wrongBudget = clone(releasedCapture); wrongBudget.runtime.maxActiveUnits++;
rejects(() => replay.participant.restore(wrongBudget), /budget authority drifted/, "drifted release budget restored");
const wrongRelease = clone(releasedCapture); wrongRelease.release.closureHash = `sha256:${"0".repeat(64)}`;
rejects(() => replay.participant.restore(wrongRelease), /release authority drifted/, "drifted release identity restored");
const wrongOwnership = clone(releasedCapture); wrongOwnership.ownership[0].buildingHash = `sha256:${"1".repeat(64)}`;
rejects(() => replay.participant.restore(wrongOwnership), /building ownership/, "drifted building ownership restored");
const wrongBytes = clone(releasedCapture); wrongBytes.residency.residentBytes++;
rejects(() => replay.participant.restore(wrongBytes), /resident-byte accounting drifted/, "drifted resident-byte accounting restored");
assert(canonicalCompilerJson(replay.residency.snapshot()) === beforeHostile,
  "failed hostile restore mutated released residency state");

// Any skill invocation performs the normal origin-driven functional-building reconciliation. The
// restored settlement handles then drive the same deterministic unload continuation as the live branch.
const probe = await replay.registry.invoke("inventory.has", { entity: "snapshot/probe", itemId: "none" }, replay.invokeBase());
assert(probe.success && replay.core.functionalBuildings.topologyManager.size() === before.residentUnitIds.length,
  "restored building origins did not reconcile their complete topology ownership");
replay.residency.setExplicitInterest([]);
const replayTerminal = await replay.residency.update([900000, 0, -900000]);
assert(canonicalCompilerJson(replayTerminal) === canonicalCompilerJson(liveTerminal) &&
  replay.core.functionalSettlements.placementManager.size() === 0 && replay.core.functionalBuildings.topologyManager.size() === 0 &&
  [...replay.world.entities.ids()].length === 0 && live.genericCalls() === 0 && replay.genericCalls() === 0,
  "restored continuation diverged or leaked whole-building ownership/entities");
await replay.residency.close();
assert(replay.core.functionalSettlements.releaseHost.size === 0 && !replay.core.snapshotParticipants.has(replay.participant.key),
  "restored normal-host session did not retire its snapshot participant");

console.log("p_fb5_functional_settlement_snapshot_replay OK: exact released authority, interest, budgets, whole-building ownership, participant ordering, hostile fail-closed restore, and deterministic native continuation replay are closed");
