import * as THREE from "../build/three.bundle.mjs";
import { createTransformStorage } from "../src/ecs/facade.ts";
import { Position, createEcsWorld } from "../src/ecs/world.ts";
import { EntityTable, ops } from "../src/engine.ts";
import { mountBuildingProductionPackage } from "../src/render/building-production-package.ts";
import type { WorldContext } from "../src/skills/registry.ts";
import { GltfSceneCache, prewarmGltfScene } from "../src/skills/three.ts";
import { UniformGridSpatialIndex } from "../src/spatial/index.ts";
import { portableAssetContentHash } from "../src/world/asset-content-hash.mjs";
import { sha256 } from "../src/world/sha256.mjs";
import { installSeededRandom } from "../src/worldlog/log.ts";
import { captureWorldSnapshot } from "../src/worldlog/snapshot.ts";

function assert(value: unknown, message: string): asserts value { if (!value) throw new Error(`p_building_production_package FAIL: ${message}`); }
function errorDetail(error: unknown): string { return error instanceof AggregateError ? [String(error), ...error.errors.map(errorDetail)].join(" | ") : String(error); }
type V3 = readonly [number, number, number];
const [packageArg, candidateArg, evidenceArg] = typeof process === "undefined" ? [] : process.argv.slice(2);
const packagePath = packageArg ?? "assets/buildings/authoring/functional-hall-house-v4/production-r1-candidate-9ba6f653/package-manifest-preliminary.json";
const candidatePath = candidateArg ?? "assets/buildings/authoring/functional-hall-house-v4/production-r1-candidate-9ba6f653/package-artifact-preliminary.json";
const evidenceOutput = evidenceArg ?? "building-production-mount-cpu-9ba6f653aa2e8954-76eb0e9cbd511880-residual-v1.json";
const packageBytes = ops.op_read_asset(packagePath), candidateBytes = ops.op_read_asset(candidatePath);
const packageValue = JSON.parse(new TextDecoder().decode(packageBytes)), candidateValue = JSON.parse(new TextDecoder().decode(candidateBytes));
const raw = (bytes: Uint8Array) => `sha256:${sha256(bytes)}`;
const transform = Object.freeze({ position: [11.25, 0.4, -7.75] as V3, yaw: 0.37 });

function near(actual: number, expected: number): boolean { return Math.abs(actual - expected) <= 1e-5; }

const cycleEvidence: any[] = [], deterministicSignatures: string[] = [];
installSeededRandom(0xC1F1A4E, true);
ops.op_physics_create_world(0);
for (let cycle = 0; cycle < 3; cycle++) {
  const scene = new THREE.Scene(), ecs = createEcsWorld(), parseCounts = new Map<string, number>();
  const realCache = new GltfSceneCache({ ktx2TranscoderPath: "/runtime/basis/", ktx2TranscoderBytes: {
    js: ops.op_read_asset("runtime/basis/basis_transcoder.js"), wasm: ops.op_read_asset("runtime/basis/basis_transcoder.wasm") } });
  realCache.configureKtx2({ isWebGPURenderer: true, hasFeature: (feature: string) => feature === "texture-compression-astc"
    || feature === "texture-compression-etc2" || feature === "texture-compression-bc" });
  const productionAssetId = "buildings/functional-hall-house-v4-production.glb", fuelAssetId = packageValue.runtimeFacets.fire.fuel.runtimeGlb.path.replace(/^assets\//, "");
  await prewarmGltfScene(productionAssetId, ops.op_read_asset(packageValue.runtime.productionGlb.path), realCache);
  await prewarmGltfScene(fuelAssetId, ops.op_read_asset(packageValue.runtimeFacets.fire.fuel.runtimeGlb.path), realCache);
  const prewarmStats = realCache.stats(); assert(prewarmStats.entries === 2 && prewarmStats.parses === 2, "real GLTF/KTX2 CPU prewarm did not parse both exact assets");
  realCache.beginWorld();
  const gltfCache = { parse: async (assetId: string, bytes: Uint8Array) => {
    parseCounts.set(assetId, (parseCounts.get(assetId) ?? 0) + 1);
    return realCache.parse(assetId, bytes);
  } };
  const world = { ecs, transforms: createTransformStorage(ecs), spatial: new UniformGridSpatialIndex(), entities: new EntityTable(), tags: new Map(),
    scene, camera: new THREE.PerspectiveCamera(), ops, mode: "headless", simWorker: false, gltfCache } as unknown as WorldContext;
  const mount = await mountBuildingProductionPackage(world, packageValue, candidateValue, transform);
  assert(mount.inventory.colliders === 123 && mount.inventory.shellColliders === 37 && mount.inventory.furnitureColliders === 86
    && mount.inventory.sockets === 12 && mount.inventory.instances === 7, "integrated semantic inventory drifted");
  assert(mount.doorEntities.length === 1 && mount.trace.buildingPlaceFunctionalCalls === 1 && mount.trace.semanticFurniturePlacements === 7
    && mount.trace.visualFurniturePlacements === 0 && !mount.trace.reviewCompositionMounted && mount.trace.timestampQueriesEnabled === false,
  "production trace permits duplicate/review visuals or timestamp queries");
  assert(parseCounts.get(productionAssetId) === 1, "production building visual was not mounted exactly once");
  assert(parseCounts.size === 2 && [...parseCounts.values()].every((count) => count === 1), "visual cache observed furniture duplication or multiple fuel/building parses");
  assert(scene.children.length === 4, `scene must contain production building, its detached articulated door, fuel, and procedural fire roots; got ${scene.children.map((entry) => entry.name).join(",")}`);
  assert(mount.fire.binding.root.position.toArray().every((value, index) => near(value, transform.position[index]))
    && near(mount.fire.binding.root.rotation.y, transform.yaw), "procedural fire did not inherit arbitrary building transform");
  const fuel = world.entities.resolve(mount.fire.fuelEntity)!;
  assert([Position.x[fuel.eid], Position.y[fuel.eid], Position.z[fuel.eid]].every((value, index) => near(value, transform.position[index]))
    && fuel.parent === mount.buildingRoot, "fuel did not inherit transform/ownership");
  assert(mount.furniture.every((placed) => {
    const entry = world.entities.resolve(placed.root); return entry?.mesh === undefined && entry.parent === mount.buildingRoot
      && world.tags.get(entry.eid)?.has("functional-furniture-semantic-only");
  }), "semantic furniture mounted a duplicate visual or lost building ownership");

  const socketPositions = mount.furniture.flatMap((entry) => entry.sockets.map((socket: any) => socket.position));
  assert(socketPositions.length === 12 && socketPositions.every((position: number[]) => position.every(Number.isFinite)), "transformed socket inventory is incomplete");
  const worldSnapshot = captureWorldSnapshot(world, { sessionId: `production-package-cycle-${cycle}`, tick: cycle + 1, snapshotSeq: 0 });
  const semanticSnapshotRoots = worldSnapshot.entities.filter((entry) => entry.origin?.tool === "furniture.placeFunctional");
  assert(semanticSnapshotRoots.length === 7 && semanticSnapshotRoots.every((entry) => (entry.origin!.input as any).visual === false)
    && semanticSnapshotRoots.reduce((sum, entry) => sum + ((entry.origin!.input as any).sockets?.length ?? 0), 0) === 12,
  "snapshot lost semantic-only furniture replay authority");
  const initialFire = mount.fire.snapshot(); assert(mount.fire.start(), "fire start failed");
  const burning = mount.fire.advanceTicks(120); assert(burning.phase === "burning" && burning.envelope === 1, "fire did not reach deterministic burning state");
  mount.fire.restore(initialFire); assert(mount.fire.snapshot().state.phase === "off", "fire snapshot restore failed");

  const signature = JSON.stringify({ inventory: mount.inventory, sockets: socketPositions, root: transform, fire: mount.fire.snapshot() });
  deterministicSignatures.push(`sha256:${sha256(signature)}`);
  cycleEvidence.push({ cycle, entities: world.entities.ids().length, sceneVisualRoots: scene.children.length,
    parseCounts: Object.fromEntries(parseCounts), sceneRoots: scene.children.length, snapshotEntities: worldSnapshot.entities.length, semanticSnapshotRoots: semanticSnapshotRoots.length,
    socketCount: socketPositions.length, deterministicSignature: deterministicSignatures.at(-1) });
  let retrySafeFailureInjected = false;
  if (cycle === 0) {
    const fuelMesh = world.entities.resolve(mount.fire.fuelEntity)?.mesh, remove = scene.remove.bind(scene); let failOnce = true;
    scene.remove = ((...objects: THREE.Object3D[]) => { if (failOnce && fuelMesh !== undefined && objects.includes(fuelMesh as THREE.Object3D)) {
      failOnce = false; retrySafeFailureInjected = true; throw new Error("injected one-shot fuel teardown failure");
    } return remove(...objects); }) as typeof scene.remove;
    let rejected = false; try { await mount.dispose(); } catch (error) { rejected = true;
      assert(errorDetail(error).includes("production package disposal failed"), "injected teardown did not surface through package disposal"); }
    assert(rejected && retrySafeFailureInjected && !mount.disposed && !mount.fire.disposed
      && fuelMesh !== undefined && scene.children.includes(fuelMesh as THREE.Object3D), `one-shot teardown failure was not retained as retryable residual state: ${JSON.stringify({ rejected, retrySafeFailureInjected, mountDisposed: mount.disposed, fireDisposed: mount.fire.disposed, fuelMesh: fuelMesh !== undefined, fuelStillInScene: fuelMesh !== undefined && scene.children.includes(fuelMesh as THREE.Object3D) })}`);
  }
  await mount.dispose(); await mount.dispose();
  assert(mount.disposed && mount.fire.disposed && world.entities.ids().length === 0 && scene.children.length === 0, "idempotent disposal leaked entities or render roots");
  let disposedRejected = false; try { mount.fire.start(); } catch { disposedRejected = true; }
  assert(disposedRejected, "disposed production fire accepted a lifecycle command");
  realCache.endWorld(); await realCache.dispose();
}
assert(new Set(deterministicSignatures).size === 1, "three-cycle package reconstruction was nondeterministic");

const sourceRefs = packageValue.runtimeFacets.fire.proceduralSources as { path: string; sha256: string }[];
const sourceHashes = Object.fromEntries(sourceRefs.map((entry) => [entry.path, raw(ops.op_read_asset(entry.path))]));
assert(sourceRefs.every((entry) => sourceHashes[entry.path] === entry.sha256), "pinned fire source hashes changed");
const mountSources = ["js/src/render/building-production-package.ts", "js/src/render/building-fire-production-facet.ts"].map((path) => ({ path, sha256: raw(ops.op_read_asset(path)) }));
const semanticFurnitureReplayProof = { verifierSource: { path: "js/test/p_functional_furniture_semantic_only.ts",
  sha256: raw(ops.op_read_asset("js/test/p_functional_furniture_semantic_only.ts")) }, actualSkillReplay: true, snapshotRestore: true,
  scope: "seven semantic-only C1 furniture instances; package reconstruction is tested separately" };
const evidence = { schema: "limina.building-production-mount-cpu-evidence/v1", packageId: packageValue.packageId,
  verifierSource: { path: "js/test/p_building_production_package.ts", sha256: raw(ops.op_read_asset("js/test/p_building_production_package.ts")) },
  candidate: { contractHash: candidateValue.contractHash, contentHash: candidateValue.contentHash }, productionGlb: { ...packageValue.runtime.productionGlb,
    rawSha256: raw(ops.op_read_asset(packageValue.runtime.productionGlb.path)), engineHash: portableAssetContentHash(ops.op_read_asset(packageValue.runtime.productionGlb.path)) },
  manifests: { lod: { ...packageValue.runtime.lodManifest, rawSha256: raw(ops.op_read_asset(packageValue.runtime.lodManifest.path)) },
    ktx2: { ...packageValue.runtime.ktx2Manifest, rawSha256: raw(ops.op_read_asset(packageValue.runtime.ktx2Manifest.path)) } }, mountSources,
  approvals: { compositionArtifact: packageValue.composition.approvedArtifact, compositionDecision: packageValue.composition.approvalDecision,
    fireArtifact: packageValue.runtimeFacets.fire.approvedArtifact, fireDecision: packageValue.runtimeFacets.fire.approvalDecision }, transform,
  inventories: { semantics: 654, colliders: 123, shellColliders: 37, furnitureColliders: 86, sockets: 12, instances: 7, doors: 1 },
  visualMounts: { productionBuilding: 1, articulatedDoorFromProductionBuilding: 1, fuel: 1, proceduralFire: 1, semanticFurniture: 0, reviewComposition: 0 }, lifecycle: { cycles: 3, idempotentDispose: true,
    disposedCommandsRejected: true, retryAfterInjectedOneShotTeardownFailure: true, reconstructionDeterministic: true, snapshotSemanticRoots: 7, snapshotSockets: 12, fireSnapshotRestore: true },
  semanticFurnitureReplayProof,
  pinnedFireSources: sourceHashes, cycles: cycleEvidence, cpuOnly: true, rendered: false, gpuUsed: false, timestampQueriesEnabled: false };
const evidenceText = `${JSON.stringify(evidence, null, 2)}\n`;
const resolvedEvidenceOutput = evidenceOutput ?? `building-production-mount-cpu-${mountSources.map((entry) => entry.sha256.slice(7, 19)).join("-")}.json`;
let existing = ""; try { existing = ops.op_read_trace(resolvedEvidenceOutput); } catch {}
if (existing.length === 0) ops.op_write_trace(resolvedEvidenceOutput, evidenceText);
else if (existing !== evidenceText) throw new Error(`exclusive evidence output already exists with different bytes: ${resolvedEvidenceOutput}`);
console.log("p_building_production_package OK: exact single production scene + semantic furniture + separate approved fire; arbitrary transform, 123 colliders, 12 sockets, door, snapshots, deterministic three-cycle reconstruction, and CPU-only lifecycle proven");
