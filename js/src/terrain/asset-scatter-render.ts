// Phase 11 / render side — THREE InstancedMesh for a curated asset's scatter set.
//
// The sibling of props-render.ts, but the instanced geometry/material come from a
// LOADED glTF asset (resolved by id through the content-addressed registry) instead
// of a fixed prop kind. For each renderable mesh in the asset's glTF, ONE
// InstancedMesh replicates it at every AssetInstance transform (translate (x,y,z),
// yaw about +Y, uniform scale), pre-multiplied by that mesh's transform RELATIVE to
// the glTF root so multi-part assets keep their authored shape + offsets.
//
// WebGPU-safe instancing: geometry/material are shared across instances (one draw
// call per asset mesh). The instance-transform MATH (render reproduces the scatter)
// is proven headlessly in js/test/p11_asset_scatter.ts; the in-tab WebGPU draw is UAT.

import * as THREE from "../../build/three.bundle.mjs";
import type { SceneObject } from "../engine.ts";
import type { AssetInstance } from "./asset-scatter.ts";

const Y_AXIS = new THREE.Vector3(0, 1, 0);

/**
 * Build the InstancedMesh(es) that render `instances` of ONE asset, given its loaded
 * glTF `root`. Returns one InstancedMesh per renderable mesh in the asset (so a
 * multi-part asset places all parts); an empty list when there are no instances or
 * the asset has no meshes. The caller adds the meshes to the scene + disposes them.
 */
export function buildAssetInstancedMeshes(root: SceneObject, instances: AssetInstance[]): THREE.InstancedMesh[] {
  if (instances.length === 0) return [];
  const r = root as unknown as { updateMatrixWorld?: (force?: boolean) => void; matrixWorld?: THREE.Matrix4; traverse?: (cb: (o: unknown) => void) => void };
  r.updateMatrixWorld?.(true);
  const rootInv = new THREE.Matrix4();
  if (r.matrixWorld !== undefined) rootInv.copy(r.matrixWorld).invert();

  // Collect every mesh node + its asset-root-local transform (local = root^-1 * mesh.matrixWorld).
  const nodes: { geometry: THREE.BufferGeometry; material: THREE.Material; local: THREE.Matrix4 }[] = [];
  const collect = (node: unknown): void => {
    const n = node as { isMesh?: boolean; geometry?: THREE.BufferGeometry; material?: THREE.Material; matrixWorld?: THREE.Matrix4 };
    if (n.isMesh !== true || n.geometry === undefined || n.material === undefined) return;
    const local = new THREE.Matrix4().identity();
    if (n.matrixWorld !== undefined) local.multiplyMatrices(rootInv, n.matrixWorld);
    nodes.push({ geometry: n.geometry, material: n.material, local });
  };
  if (typeof r.traverse === "function") r.traverse(collect);
  else { const walk = (node: unknown): void => { collect(node); const c = (node as { children?: unknown[] }).children; if (Array.isArray(c)) for (const ch of c) walk(ch); }; walk(root); }
  if (nodes.length === 0) return [];

  // ── GLB ORIGIN NORMALIZATION (WHOLE ASSET) ──────────────────────────────────
  // Curated GLBs are not consistently based at Y=0 or centred at XZ=(0,0). Compute ONE combined
  // bbox across ALL of the asset's meshes (in asset-root space) and ONE corrective translation, so
  // a MULTI-mesh asset (a tree's separate branches + leaves meshes) stays intact — normalizing each
  // mesh independently would slam the leaf-canopy mesh down to Y=0 and recentre it, tearing the tree
  // apart. Single-mesh assets (rock/bush) get the identical result. Bases the asset at Y=0 + centres
  // its XZ footprint. Runs once per asset load; never touches the asset bytes (replay pinning safe).
  let xmin = Infinity, ymin = Infinity, zmin = Infinity, xmax = -Infinity, ymax = -Infinity, zmax = -Infinity;
  const corner = new THREE.Vector3();
  for (const { geometry, local } of nodes) {
    if (geometry.boundingBox === null) geometry.computeBoundingBox();
    const bb = geometry.boundingBox!;
    for (const cx of [bb.min.x, bb.max.x]) for (const cy of [bb.min.y, bb.max.y]) for (const cz of [bb.min.z, bb.max.z]) {
      corner.set(cx, cy, cz).applyMatrix4(local);
      if (corner.x < xmin) xmin = corner.x; if (corner.x > xmax) xmax = corner.x;
      if (corner.y < ymin) ymin = corner.y; if (corner.y > ymax) ymax = corner.y;
      if (corner.z < zmin) zmin = corner.z; if (corner.z > zmax) zmax = corner.z;
    }
  }
  const offset = new THREE.Matrix4().makeTranslation(-(xmin + xmax) / 2, -ymin, -(zmin + zmax) / 2);

  // One InstancedMesh per mesh, all sharing the asset-level corrective offset (applied in asset-root
  // space via premultiply → vertex path: instance × offset × local × vertex).
  const meshes: THREE.InstancedMesh[] = [];
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const pos = new THREE.Vector3();
  const scl = new THREE.Vector3();
  for (const { geometry, material, local } of nodes) {
    const placed = new THREE.Matrix4().copy(local).premultiply(offset);
    const inst = new THREE.InstancedMesh(geometry, material, instances.length);
    for (let i = 0; i < instances.length; i++) {
      const p = instances[i];
      pos.set(p.x, p.y, p.z);
      q.setFromAxisAngle(Y_AXIS, p.yaw);
      scl.set(p.scale, p.scale, p.scale);
      m.compose(pos, q, scl).multiply(placed);
      inst.setMatrixAt(i, m);
    }
    inst.instanceMatrix.needsUpdate = true;
    inst.castShadow = false;
    inst.receiveShadow = true;
    // Instances spread far from the asset origin, but InstancedMesh frustum-culls against the base
    // geometry's bounding sphere AT THE ORIGIN — so a scatter whose origin sits off-screen gets the
    // WHOLE mesh culled (the forest vanishes). Disable per-mesh culling; the scatter is bounded.
    inst.frustumCulled = false;
    meshes.push(inst);
  }
  return meshes;
}

/** Dispose an asset InstancedMesh's GPU resources after it's removed from the scene.
 *  asset.scatter parses a fresh glTF root per mount, so the instanced mesh owns the
 *  source geometry/material references for that mount and must release them too. */
export function disposeAssetInstancedMesh(mesh: THREE.InstancedMesh): void {
  (mesh as unknown as { dispose?: () => void }).dispose?.();
  mesh.geometry.dispose();
  const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
  for (const material of new Set(materials)) material.dispose();
}
