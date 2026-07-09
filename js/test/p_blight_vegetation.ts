// p_blight_vegetation — the DEAD-VEGETATION half of the blight (caesura) render: a tree whose base
// sits inside a painted blight region renders DEAD (a bare, colour-drained trunk) instead of living.
// This gate exercises the render primitive directly — buildAssetInstancedMeshes({ dead: true }) — on a
// SYNTHETIC two-node tree archetype (a solid trunk node + an alpha-cutout leaf-card node, the same
// shape ez-tree bakes), so it needs no GLB parse or GPU. Falsifiable both ways: dead mode must DROP the
// foliage node (bare tree) and DRAIN the surviving bark; living mode must mount both nodes untouched.

import * as THREE from "../build/three.bundle.mjs";
import { ops } from "../src/engine.ts";
import { buildAssetInstancedMeshes } from "../src/terrain/asset-scatter-render.ts";
import { buildBlightMist } from "../src/mist.ts";
import type { TerrainTile } from "../src/terrain/types.ts";

function assert(cond: boolean, msg: string): asserts cond {
  if (!cond) { ops.op_log(`[js] p_blight_vegetation FAIL: ${msg}`); throw new Error(msg); }
}

// A tree archetype the way the bakes ship it: a SOLID trunk/branch node + a leaf-card FOLIAGE node
// whose material is an alpha-cutout MASK (alphaTest > 0.1 — the same signal the render path keys on).
const root = new THREE.Group();
const trunk = new THREE.Mesh(new THREE.BoxGeometry(0.3, 4, 0.3), new THREE.MeshStandardMaterial({ color: 0x5a3a1a }));
const leafMat = new THREE.MeshStandardMaterial({ color: 0x2a7a2a });
(leafMat as unknown as { alphaTest: number }).alphaTest = 0.3;
const foliage = new THREE.Mesh(new THREE.BoxGeometry(3, 3, 3), leafMat);
root.add(trunk);
root.add(foliage);
(root as unknown as { updateMatrixWorld(f?: boolean): void }).updateMatrixWorld(true);

const instances = [{ x: 0, y: 0, z: 0, yaw: 0, scale: 1, assetId: "synthetic-tree" }];

// Snapshot the shared trunk material colour (THREE linearises the sRGB hex, so compare against the
// captured value, not the raw 0x5a3a1a) to prove the dead build never mutates the loaded asset.
const origTrunkColor = (trunk.material as unknown as { color: THREE.Color }).color.clone();

// LIVING: both nodes mount (trunk + foliage), materials untouched.
const living = buildAssetInstancedMeshes(root as never, instances as never);
assert(living.length === 2, `a living tree must mount BOTH nodes (trunk + foliage) — got ${living.length}`);

// DEAD: the foliage node is dropped (bare tree) → trunk only.
const dead = buildAssetInstancedMeshes(root as never, instances as never, { dead: true });
assert(dead.length === 1, `a dead tree must DROP the foliage node (bare trunk only) — got ${dead.length}`);

// The surviving bark is colour-drained toward ash-grey (setRGB writes linear components directly).
const deadMat = (dead[0] as unknown as { material: { color?: THREE.Color } }).material;
assert(deadMat.color !== undefined, "dead trunk material must have a color");
assert(Math.abs(deadMat.color.r - 0.33) < 0.02 && Math.abs(deadMat.color.g - 0.30) < 0.02,
  `dead bark must be drained to ash-grey (~0.33,0.30,0.26) — got (${deadMat.color.r.toFixed(2)},${deadMat.color.g.toFixed(2)},${deadMat.color.b.toFixed(2)})`);

// The shared trunk material is NOT mutated by the dead build (it clones before draining).
assert((trunk.material as unknown as { color: THREE.Color }).color.equals(origTrunkColor),
  "the dead build must clone before draining — the shared/loaded trunk material must be unchanged");

// BLIGHT MIST: buildBlightMist returns a low-lying miasma mesh for a tile carrying blight, and nothing
// for a clean tile (falsifiable both ways). A 4×4 tile with a low hollow → a mesh named limina:blight-mist.
{
  const clean: TerrainTile = { nrows: 4, ncols: 4, origin: [0, 0, 0], scale: [40, 1, 40], heights: new Float32Array(16) };
  assert(buildBlightMist(clean) === undefined, "a tile with no blight must produce NO mist");

  const blighted: TerrainTile = { ...clean, blight: new Float32Array(16) };
  // Two blighted cells, one in a hollow (lower height) so the gravity-pool has a gradient to bake.
  blighted.heights[5] = 3; // a rise
  blighted.blight![5] = 1;
  blighted.blight![9] = 1; // the hollow (height 0)
  const mist = buildBlightMist(blighted);
  assert(mist !== undefined, "a blighted tile must produce a mist mesh");
  assert((mist as unknown as { name: string }).name === "limina:blight-mist", "the mist mesh must be named limina:blight-mist");
  assert((mist as unknown as { position: { y: number } }).position.y > 0, "the mist must sit ABOVE the ground (low-lying, not buried)");
  ops.op_log("[js] p_blight_vegetation: buildBlightMist → mesh for a blighted tile, undefined for a clean one");
}

ops.op_log("[js] p_blight_vegetation OK: buildAssetInstancedMeshes({dead:true}) drops the leaf-card foliage node " +
  "(living=2 nodes → dead=1 node) and drains the surviving bark to ash-grey, without mutating the shared living material — " +
  "so a tree inside a painted caesura renders as a bare, drained snag while the living forest around it is untouched.");
