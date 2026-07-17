import * as THREE from "../build/three.bundle.mjs";
import { INTERACTIVE_TEMPERATE_MEADOW_PACKAGE } from "../src/content/grass/interactive-temperate-meadow.ts";
import { ContinuousBiomeGrassRuntime } from "../src/render/continuous-biome-grass-runtime.ts";
import type { TerrainTile } from "../src/terrain/types.ts";

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(`p_continuous_biome_grass_runtime FAIL: ${message}`);
}

const n = 33;
const tile: TerrainTile = {
  nrows: n, ncols: n, origin: [24, 0, 24], scale: [48, 1, 48],
  heights: new Float32Array(n * n),
};
const scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera();
camera.position.set(24, 2, 24); camera.updateMatrixWorld(true);
const runtime = await ContinuousBiomeGrassRuntime.create({
  role: "flora/forest-grass",
  tiles: [{ key: "0:0", tx: 0, tz: 0, tile }],
  densityAt: () => 1,
  visualPackage: INTERACTIVE_TEMPERATE_MEADOW_PACKAGE,
  quality: "performance",
  variant: "summer",
  bladeScale: [0.8, 1.2],
  scene,
  camera,
});
const profile = INTERACTIVE_TEMPERATE_MEADOW_PACKAGE.profile("performance");
assert(profile.bladesPerInstance[0] === 1 && profile.bladesPerInstance[1] === 8
  && profile.bladesPerSquareMeter[0] === 90 && profile.bladesPerSquareMeter[1] === 5.5,
  "package stopped declaring honest independent-near/clustered-far field density");
assert(runtime.draws === 18,
  `performance grass did not combine its nine available primary cells with nine available 16m mid cells: ${runtime.draws}`);
assert(runtime.bladeCount > 20_000 && runtime.bladeCount <= runtime.maxResidentBlades,
  `continuous field did not spend its bounded near-camera blade budget: ${runtime.bladeCount}`);
const meshes: THREE.InstancedMesh[] = [];
scene.traverse((object) => { if ((object as THREE.InstancedMesh).isInstancedMesh) meshes.push(object as THREE.InstancedMesh); });
const modeledBlades = meshes.reduce((sum, mesh) => sum
  + mesh.count * Number(mesh.geometry.userData.liminaTemperateMeadowBlades), 0);
assert(meshes.length === runtime.draws
  && meshes.every((mesh) => [1, 8, 16].includes(Number(mesh.geometry.userData.liminaTemperateMeadowBlades)))
  && modeledBlades === runtime.bladeCount,
  "continuous runtime stopped accounting every independently instanced blade");
const mountedBlades = runtime.bladeCount;
runtime.dispose(); runtime.dispose();
assert(scene.children.length === 0, "continuous runtime retained scene mounts after disposal");

const packageDensityBlades = async (painted: boolean): Promise<number> => {
  const densityScene = new THREE.Scene();
  const densityTile: TerrainTile = {
    ...tile,
    heights: tile.heights.slice(),
    ...(painted ? { paintMat: new Uint8Array(n * n).fill(2), paintW: new Float32Array(n * n).fill(1) } : {}),
  };
  const densityRuntime = await ContinuousBiomeGrassRuntime.create({
    role: "flora/forest-grass", tiles: [{ key: "0:0", tx: 0, tz: 0, tile: densityTile }], densityAt: () => 0.25,
    visualPackage: INTERACTIVE_TEMPERATE_MEADOW_PACKAGE, quality: "performance", variant: "summer",
    bladeScale: [0.8, 1.2], scene: densityScene, camera,
  });
  const blades = densityRuntime.bladeCount;
  densityRuntime.dispose();
  return blades;
};
assert(await packageDensityBlades(true) === await packageDensityBlades(false),
  "legacy grass paint overrode the published continuous package's authenticated density");

// The cinematic runtime combines a 5x5 near window of 8 m cells with a 5x5 physical mid window of
// 16 m cells. This proves neither band silently clips to the terrain-tile partition.
const cinematicScene = new THREE.Scene(), cinematicCamera = new THREE.PerspectiveCamera();
cinematicCamera.position.set(24, 2, 24); cinematicCamera.updateMatrixWorld(true);
const cinematicTiles = [];
for (let tz = -1; tz <= 1; tz++) for (let tx = -1; tx <= 1; tx++) {
  cinematicTiles.push({ key: `${tx}:${tz}`, tx, tz, tile: {
    nrows: n, ncols: n, origin: [24 + tx * 48, 0, 24 + tz * 48] as [number, number, number],
    scale: [48, 1, 48] as [number, number, number], heights: new Float32Array(n * n),
  } });
}
const cinematic = await ContinuousBiomeGrassRuntime.create({
  role: "flora/meadow-grass", tiles: cinematicTiles, densityAt: () => 1,
  visualPackage: INTERACTIVE_TEMPERATE_MEADOW_PACKAGE, quality: "cinematic", variant: "summer",
  bladeScale: [0.7, 1.25], scene: cinematicScene, camera: cinematicCamera,
});
assert(cinematic.draws === 50, `cinematic grass did not mount 25 near cells plus 25 mid cells (${cinematic.draws}/50 cells)`);
assert(cinematic.bladeCount > 380_000 && cinematic.bladeCount <= cinematic.maxResidentBlades,
  `cinematic full-window LOD violated its honest blade budget (${cinematic.bladeCount}/${cinematic.maxResidentBlades})`);
const cinematicBlades = cinematic.bladeCount;
cinematic.dispose();
assert(cinematicScene.children.length === 0, "cinematic full-window grass retained scene mounts after disposal");

console.log(`p_continuous_biome_grass_runtime OK: ${mountedBlades} performance blades and ${cinematicBlades} cinematic blades cover their complete available windows within honest budgets; visual acceptance remains human-reviewed`);
