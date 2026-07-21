import * as THREE from "../build/three.bundle.mjs";
import { buildGrassFieldComputeBatch } from "../src/render/grass-field-compute.ts";
import { prepareGrassFieldTerrainPages } from "../src/render/grass-field-terrain.ts";
import { GrassFieldStreamManager } from "../src/render/grass-field-render.ts";
import { INTERACTIVE_TEMPERATE_MEADOW_PACKAGE } from "../src/content/grass/interactive-temperate-meadow.ts";
import type { TerrainTile } from "../src/terrain/types.ts";

function assert(value: boolean, message: string): asserts value {
  if (!value) throw new Error(`p_grass_field_stream_manager FAIL: ${message}`);
}

const n = 33;
const tile: TerrainTile = {
  nrows: n, ncols: n,
  origin: [1_000_012.25, 0, -2_000_011.75], scale: [24, 1, 24],
  heights: new Float32Array(n * n), paintMat: new Uint8Array(n * n).fill(2), paintW: new Float32Array(n * n).fill(1),
};
let dispatches = 0, builds = 0, disposals = 0, densitySamples = 0;
const renderer = {
  backend: { isWebGPUBackend: true, isWebGLBackend: false },
  hasInitialized: () => true,
  async computeAsync() { dispatches++; },
};
const scene = new THREE.Scene();
const manager = new GrassFieldStreamManager(scene, {
  tileSize: 24, radius: 0, renderer,
  visualPackage: INTERACTIVE_TEMPERATE_MEADOW_PACKAGE,
  source: () => ({
    seed: -91,
    spacing: 0.75,
    elevationMin: -1,
    densityAt: () => { densitySamples++; return 0.25; },
    paintPolicy: "ignore",
  }),
  buildComputeBatch: (input) => {
    builds++;
    const resource = buildGrassFieldComputeBatch(input), dispose = resource.dispose;
    return { ...resource, dispose: () => { disposals++; dispose(); } };
  },
});
manager.noteTile("large", { tx: 0, tz: 0 }, tile);
const launched = manager.update(1, 1);
assert(launched.grown === 1 && launched.pending === 1 && manager.grassKeys().size === 0,
  "native build was not launched unpublished with one pending reservation");
await manager.settle();
const expectedPages = prepareGrassFieldTerrainPages(tile, {
  seed: -91,
  // The authored 0.75 m pitch is deliberately too sparse. Stream reservation and construction
  // must both clamp it to the visual package's published density floor.
  spacing: Math.sqrt(INTERACTIVE_TEMPERATE_MEADOW_PACKAGE.profile("balanced").bladesPerInstance[0]
    / INTERACTIVE_TEMPERATE_MEADOW_PACKAGE.profile("balanced").bladesPerSquareMeter[0])
    * INTERACTIVE_TEMPERATE_MEADOW_PACKAGE.profile("balanced").spacingMultipliers[0],
  elevationMin: -1,
  densityAt: () => 0.25,
  paintPolicy: "ignore",
});
assert(manager.grassKeys().has("large") && dispatches === 1 && builds === 1,
  "native manager did not batch and atomically publish canonical pages through one tile dispatch");
assert(scene.children.length === 1 && scene.children[0].name === "limina:streamed-grass-field"
  && scene.children[0].children.length === 1 && scene.children[0].userData.liminaGrassFieldPages === expectedPages.length,
"native manager did not batch canonical compute pages into one tile draw");
const meshes: THREE.InstancedMesh[] = [];
scene.traverse((object) => { if ((object as THREE.InstancedMesh).isInstancedMesh) meshes.push(object as THREE.InstancedMesh); });
const expectedSlots = expectedPages.reduce((sum, page) => sum + page.plan.slots, 0);
assert(densitySamples === expectedSlots,
  `native reservation sampled density or native build sampled it more than once (${densitySamples} samples for ${expectedSlots} slots)`);
assert(meshes.length === 1 && meshes[0].count === expectedSlots && meshes[0].frustumCulled,
  "native page batch violated fixed-slot accounting or terrain-tile frustum culling");
const programKeys = new Set(meshes.map((mesh) => (mesh.material as THREE.Material).customProgramCacheKey()));
assert(programKeys.size === 1, `structurally identical native pages produced ${programKeys.size} shader program keys`);
const matrix = new THREE.Matrix4(), identity = new THREE.Matrix4();
for (const mesh of meshes) {
  mesh.getMatrixAt(0, matrix);
  assert(matrix.equals(identity) && Math.abs(mesh.position.x) > 900_000 && Math.abs(mesh.position.z) > 1_900_000,
    "native streamed page lost identity matrices or its large-world feature origin");
}
const expectedBlades = expectedPages.reduce((sum, page) => sum + [...page.plan.accepted].reduce((count, value) => count + value, 0), 0)
  * INTERACTIVE_TEMPERATE_MEADOW_PACKAGE.profile("balanced").bladesPerInstance[0];
assert(manager.bladeCount() === expectedBlades && manager.takeErrors().length === 0,
  "native manager lost package-authoritative density, accepted-count metrics, or reported an operational error");
manager.dropTile("large");
assert(scene.children.length === 0 && manager.grassKeys().size === 0 && disposals === builds,
  "dropTile did not remove and dispose every native page exactly once");
await manager.clear();
assert(disposals === builds, "terminal clear double-disposed native pages");

console.log("p_grass_field_stream_manager OK: native async residency builds unpublished, dispatches canonical pages, publishes atomically, preserves large-world local storage, and disposes exactly");
