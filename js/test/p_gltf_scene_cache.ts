import { ops } from "../src/engine.ts";
import { AssetRegistry } from "../src/asset-registry.ts";
import type { SceneObject } from "../src/engine.ts";
import {
  GltfSceneCache,
  GltfSceneCacheMissError,
  estimateGltfSceneResidentBytes,
  gltfSceneContentKey,
} from "../src/skills/three.ts";
import { disposeEntitySceneResources } from "../src/render/entity-scene-resources.ts";
import { buildAssetInstancedMeshes, disposeAssetInstancedMesh } from "../src/terrain/asset-scatter-render.ts";

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(`p_gltf_scene_cache FAIL: ${message}`);
}

function firstMesh(root: SceneObject): {
  geometry: { dispose(): void };
  material: { dispose(): void } | Array<{ dispose(): void }>;
} {
  let mesh: { geometry: { dispose(): void }; material: { dispose(): void } | Array<{ dispose(): void }> } | undefined;
  root.traverse?.((node: unknown) => {
    const candidate = node as typeof mesh & { isMesh?: boolean };
    if (mesh === undefined && candidate?.isMesh === true) mesh = candidate;
  });
  assert(mesh !== undefined, "parsed fixture has no mesh");
  return mesh;
}

ops.op_physics_create_world(0);
const assets = new AssetRegistry();
const meshBytes = assets.resolve("fixtures/mesh.glb").bytes;
const triangleBytes = assets.resolve("triangle.glb").bytes;

// Content identity includes bytes and parse context, not the mutable asset-id alias.
assert(
  gltfSceneContentKey("same.glb", meshBytes) !== gltfSceneContentKey("same.glb", triangleBytes),
  "different bytes produced the same content key",
);
assert(
  gltfSceneContentKey("a/model.glb", meshBytes) !== gltfSceneContentKey("b/model.glb", meshBytes),
  "different relative-resource bases produced the same parse-context key",
);

const rotation = new GltfSceneCache({ maxEntries: 4, maxSourceBytes: 16 * 1024 * 1024 });
await rotation.prewarm("same.glb", meshBytes);
assert(rotation.has("same.glb", meshBytes), "first alias was not published");
await rotation.prewarm("same.glb", triangleBytes);
assert(rotation.has("same.glb", triangleBytes), "same-id alias did not rotate to new bytes");
assert(!rotation.has("same.glb", meshBytes), "same-id alias still claims stale bytes");
assert(rotation.stats().entries === 2, "content entries were incorrectly keyed only by asset id");
await rotation.dispose();

// Concurrent calls for one content key parse once, including the different-alias pending branch.
const dedupe = new GltfSceneCache();
await Promise.all([
  dedupe.prewarm("first.glb", meshBytes),
  dedupe.prewarm("second.glb", meshBytes),
]);
assert(dedupe.stats().parses === 1, `concurrent content parsed ${dedupe.stats().parses} times`);
assert(dedupe.has("first.glb", meshBytes) && dedupe.has("second.glb", meshBytes), "in-flight dedupe dropped an alias");
const [cloneA, cloneB] = await Promise.all([
  dedupe.parse("first.glb", meshBytes),
  dedupe.parse("first.glb", meshBytes),
]);
assert(firstMesh(cloneA).geometry === firstMesh(cloneB).geometry, "cache clones stopped sharing immutable geometry");
assert(firstMesh(cloneA).material !== firstMesh(cloneB).material, "cache clones share mutable material state");
assert(estimateGltfSceneResidentBytes(cloneA) > 0 && dedupe.stats().residentBytes > 0, "decoded residency was not measured or surfaced");
const cloneAMesh = firstMesh(cloneA);
const cloneAMaterial = Array.isArray(cloneAMesh.material) ? cloneAMesh.material[0] : cloneAMesh.material;
let cloneMaterialDisposals = 0;
let cloneGeometryDisposals = 0;
cloneAMaterial.dispose = () => { cloneMaterialDisposals += 1; };
cloneAMesh.geometry.dispose = () => { cloneGeometryDisposals += 1; };
disposeEntitySceneResources(cloneA);
assert(cloneMaterialDisposals === 1, "placement-cloned material was not disposed with its entity subtree");
assert(cloneGeometryDisposals === 0, "placement teardown disposed cache-owned glTF geometry");

dedupe.beginWorld();
let duplicateWorld: unknown;
try { dedupe.beginWorld(); } catch (error) { duplicateWorld = error; }
assert(duplicateWorld instanceof Error && /already has an active world/.test(duplicateWorld.message), "cache accepted a second active world");
await dedupe.parse("first.glb", meshBytes);
let activeMiss: unknown;
try { await dedupe.parse("missing.glb", triangleBytes); } catch (error) { activeMiss = error; }
assert(activeMiss instanceof GltfSceneCacheMissError, "active-world miss was not rejected with the cache policy error");
assert(dedupe.stats().parses === 1, "active-world miss started an asynchronous parser");
await dedupe.prewarmActiveWorld([{ assetId: "derived.glb", bytes: triangleBytes }]);
assert(dedupe.has("derived.glb", triangleBytes), "render-suspended active-world prewarm did not publish its exact content");
const derivedClone = await dedupe.parse("derived.glb", triangleBytes);
assert(firstMesh(derivedClone).geometry !== undefined, "active-world prewarmed content did not clone synchronously");
dedupe.endWorld();
await dedupe.dispose();
assert(cloneGeometryDisposals === 1, "cache-owned glTF geometry did not survive until host-cache teardown");

// Entry/source bounds evict between sessions, and template geometry is disposed exactly once.
const bounded = new GltfSceneCache({ maxEntries: 1, maxSourceBytes: 16 * 1024 * 1024 });
await bounded.prewarm("old.glb", meshBytes);
const oldRoot = await bounded.parse("old.glb", meshBytes);
const oldGeometry = firstMesh(oldRoot).geometry;
let oldGeometryDisposals = 0;
oldGeometry.dispose = () => { oldGeometryDisposals += 1; };
await bounded.prewarm("new.glb", triangleBytes);
assert(bounded.stats().entries === 1 && bounded.stats().evictions === 1, "entry bound did not evict LRU content");
assert(oldGeometryDisposals === 1, `evicted geometry disposed ${oldGeometryDisposals} times`);
const newRoot = await bounded.parse("new.glb", triangleBytes);
const newGeometry = firstMesh(newRoot).geometry;
let newGeometryDisposals = 0;
newGeometry.dispose = () => { newGeometryDisposals += 1; };
await bounded.dispose();

// Active-world fills fail instead of evicting geometry that active clones may still share.
const liveBounded = new GltfSceneCache({ maxEntries: 1, maxSourceBytes: 16 * 1024 * 1024 });
await liveBounded.prewarm("live.glb", meshBytes);
const liveRoot = await liveBounded.parse("live.glb", meshBytes);
const liveGeometry = firstMesh(liveRoot).geometry;
let liveGeometryDisposals = 0;
liveGeometry.dispose = () => { liveGeometryDisposals += 1; };
liveBounded.beginWorld();
let liveBudgetError: unknown;
try { await liveBounded.prewarmActiveWorld([{ assetId: "cannot-evict.glb", bytes: triangleBytes }]); }
catch (error) { liveBudgetError = error; }
assert(liveBudgetError instanceof RangeError && /without evicting/.test(liveBudgetError.message),
  "active-world prewarm evicted or accepted beyond its live resource budget");
assert(liveGeometryDisposals === 0 && liveBounded.has("live.glb", meshBytes),
  "active-world prewarm disposed or unbound a live shared geometry");
liveBounded.endWorld();
await liveBounded.dispose();
assert(liveGeometryDisposals === 1, "live cache geometry was not retained until host disposal");
assert(oldGeometryDisposals === 1 && newGeometryDisposals === 1, "host disposal did not dispose each retained template once");

const tooSmall = new GltfSceneCache({ maxEntries: 1, maxSourceBytes: meshBytes.byteLength - 1 });
let budgetError: unknown;
try { await tooSmall.prewarm("oversize.glb", meshBytes); } catch (error) { budgetError = error; }
assert(budgetError instanceof RangeError && tooSmall.stats().parses === 0, "oversize source parsed before budget rejection");
await tooSmall.dispose();

// Compressed source bytes cannot bypass the decoded CPU/GPU residency budget.
const decodedTooSmall = new GltfSceneCache({ maxEntries: 1, maxSourceBytes: 16 * 1024 * 1024, maxResidentBytes: 1 });
let decodedBudgetError: unknown;
try { await decodedTooSmall.prewarm("decoded-oversize.glb", meshBytes); } catch (error) { decodedBudgetError = error; }
assert(decodedBudgetError instanceof RangeError && /resident bytes/.test(decodedBudgetError.message), "decoded oversize asset did not fail at the resident budget");
assert(decodedTooSmall.stats().entries === 0 && decodedTooSmall.stats().residentBytes === 0, "decoded oversize asset leaked into cache accounting");
await decodedTooSmall.dispose();

// Two owners never share templates or active-session state.
const hostA = new GltfSceneCache();
const hostB = new GltfSceneCache();
await hostA.prewarm("isolated.glb", meshBytes);
assert(!hostB.has("isolated.glb", meshBytes), "cache content leaked into a second host");
const hostARoot = await hostA.parse("isolated.glb", meshBytes);
await hostB.prewarm("isolated.glb", meshBytes);
const hostBRoot = await hostB.parse("isolated.glb", meshBytes);
assert(firstMesh(hostARoot).geometry !== firstMesh(hostBRoot).geometry, "two hosts share parsed template geometry");
await hostA.dispose();
await hostB.dispose();

// Scatter teardown releases per-world materials once, but never cache-owned geometry.
const scatterCache = new GltfSceneCache();
await scatterCache.prewarm("scatter.glb", meshBytes);
const scatterRoot = await scatterCache.parse("scatter.glb", meshBytes);
const scatterSource = firstMesh(scatterRoot);
let scatterGeometryDisposals = 0;
let scatterMaterialDisposals = 0;
scatterSource.geometry.dispose = () => { scatterGeometryDisposals += 1; };
const scatterMaterial = Array.isArray(scatterSource.material) ? scatterSource.material[0] : scatterSource.material;
scatterMaterial.dispose = () => { scatterMaterialDisposals += 1; };
const scatterMeshes = buildAssetInstancedMeshes(scatterRoot, [
  { assetId: "scatter.glb", x: 0, y: 0, z: 0, yaw: 0, scale: 1 },
  { assetId: "scatter.glb", x: 20, y: 0, z: 0, yaw: 0, scale: 1 },
], { chunkSize: 10 });
assert(scatterMeshes.length >= 2, "scatter fixture did not produce multiple material-sharing chunks");
for (const mesh of scatterMeshes) disposeAssetInstancedMesh(mesh);
assert(scatterGeometryDisposals === 0, "scatter teardown disposed cache-owned geometry");
assert(scatterMaterialDisposals === 1, `shared per-world scatter material disposed ${scatterMaterialDisposals} times`);
await scatterCache.dispose();
assert(scatterGeometryDisposals === 1, "cache-owned scatter geometry did not survive until cache disposal");

// Host disposal attempts every template resource even when individual disposers fail.
const faulty = new GltfSceneCache();
const texturedBytes = assets.resolve("fixtures/textured-cube.glb").bytes;
await faulty.prewarm("faulty.glb", texturedBytes);
const faultyRoot = await faulty.parse("faulty.glb", texturedBytes);
const faultyMesh = firstMesh(faultyRoot);
const faultyMaterial = (Array.isArray(faultyMesh.material) ? faultyMesh.material[0] : faultyMesh.material) as {
  map?: { dispose(): void };
};
let faultyGeometryDisposals = 0;
let faultyTextureDisposals = 0;
faultyMesh.geometry.dispose = () => { faultyGeometryDisposals += 1; throw new Error("injected geometry disposal failure"); };
assert(faultyMaterial.map !== undefined, "fault-injection fixture has no shared texture");
faultyMaterial.map.dispose = () => { faultyTextureDisposals += 1; throw new Error("injected texture disposal failure"); };
let disposalFailure: unknown;
try { await faulty.dispose(); } catch (error) { disposalFailure = error; }
assert(disposalFailure instanceof AggregateError, "cache disposal did not aggregate resource failures");
assert(faultyGeometryDisposals === 1 && faultyTextureDisposals === 1, "one disposal failure aborted remaining template cleanup");

console.log("p_gltf_scene_cache OK: content aliases, in-flight dedupe, bounds, active-session policy, host isolation, and ownership disposal hold");
