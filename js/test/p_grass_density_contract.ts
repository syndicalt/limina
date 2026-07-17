import * as THREE from "../build/three.bundle.mjs";
import { INTERACTIVE_TEMPERATE_MEADOW_PACKAGE } from "../src/content/grass/interactive-temperate-meadow.ts";
import { grassFieldInstanceSpacing } from "../src/render/grass-field-package.ts";
import { GrassFieldTileMount } from "../src/render/grass-field-render.ts";
import type { TerrainTile } from "../src/terrain/types.ts";

function assert(value: boolean, message: string): asserts value {
  if (!value) throw new Error(`p_grass_density_contract FAIL: ${message}`);
}

const scene = { children: new Set<unknown>(), add(value: unknown) { this.children.add(value); },
  remove(value: unknown) { this.children.delete(value); } };
const n = 33;
const tile: TerrainTile = {
  nrows: n, ncols: n, origin: [24, 0, 24], scale: [48, 1, 48],
  heights: new Float32Array(n * n), paintMat: new Uint8Array(n * n).fill(2),
  paintW: new Float32Array(n * n).fill(1),
};
const profile = INTERACTIVE_TEMPERATE_MEADOW_PACKAGE.profile("cinematic");
assert(Math.abs(grassFieldInstanceSpacing(INTERACTIVE_TEMPERATE_MEADOW_PACKAGE, "cinematic", 0)
  - Math.sqrt(1 / 260)) < 1e-12, "instance pitch does not preserve actual-blade density");
assert(profile.bladesPerInstance[0] === 1,
  "near grass groups blades into repeated tuft instances instead of independently instancing them");

// Deliberately request the old sparse 0.75 m pitch. The mount must clamp it to the package density
// and bound contiguous area at the fixed-slot ceiling instead of thinning the whole 48 m tile.
const mount = new GrassFieldTileMount(scene, tile, () => ({ seed: 42, spacing: 0.75, elevationMin: -1 }),
  INTERACTIVE_TEMPERATE_MEADOW_PACKAGE, "cinematic", 0);
assert(mount.bladeCount() <= profile.maxResidentBlades && mount.bladeCount() > 220_000,
  `mount did not spend its bounded dense-area budget (${mount.bladeCount()})`);
const mesh = mount.chunkMeshes()[0];
assert(mesh !== undefined && mesh.count * profile.bladesPerInstance[0] === mount.bladeCount(),
  "instance count and actual modeled-blade count diverged");
assert(mesh.geometry.userData.liminaGroundCoverStrategy === "individually-instanced-curved-blade/v3",
  "grass geometry does not identify the independently-instanced blade strategy");
assert(mesh.count === mount.bladeCount(), "cinematic near blade budget is not an honest instance count");
const matrix = new THREE.Matrix4(), position = new THREE.Vector3();
let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
for (let index = 0; index < mesh.count; index++) {
  mesh.getMatrixAt(index, matrix); position.setFromMatrixPosition(matrix);
  minX = Math.min(minX, position.x); maxX = Math.max(maxX, position.x);
  minZ = Math.min(minZ, position.z); maxZ = Math.max(maxZ, position.z);
}
const occupiedBoxArea = (maxX - minX) * (maxZ - minZ);
const conservativeLocalDensity = mount.bladeCount() / occupiedBoxArea;
assert(conservativeLocalDensity > 150,
  `bounded near field was globally diluted (${conservativeLocalDensity.toFixed(2)} blades/m2)`);
assert(minX > -23.5 && maxX < 23.5 && minZ > -23.5 && maxZ < 23.5,
  "budgeting filled sparse whole-tile corners instead of a contiguous dense area");
mount.dispose();
assert(scene.children.size === 0, "dense-area mount leaked its scene resource");

console.log(`p_grass_density_contract OK: ${mount.bladeCount()} retired blades; pre-disposal local density ${conservativeLocalDensity.toFixed(2)} blades/m2`);
