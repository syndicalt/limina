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

  const meshes: THREE.InstancedMesh[] = [];
  const local = new THREE.Matrix4();
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const pos = new THREE.Vector3();
  const scl = new THREE.Vector3();

  // Instance ONE mesh node (no recursion — traverse / the manual walk supplies nodes).
  const processMesh = (node: unknown): void => {
    const n = node as { isMesh?: boolean; geometry?: THREE.BufferGeometry; material?: THREE.Material; matrixWorld?: THREE.Matrix4 };
    if (n.isMesh !== true || n.geometry === undefined || n.material === undefined) return;
    // The mesh's transform relative to the asset root (identity for a single mesh at
    // the origin): local = root.matrixWorld^-1 * mesh.matrixWorld.
    local.identity();
    if (n.matrixWorld !== undefined) local.multiplyMatrices(rootInv, n.matrixWorld);
    const inst = new THREE.InstancedMesh(n.geometry, n.material, instances.length);
    for (let i = 0; i < instances.length; i++) {
      const p = instances[i];
      pos.set(p.x, p.y, p.z);
      q.setFromAxisAngle(Y_AXIS, p.yaw);
      scl.set(p.scale, p.scale, p.scale);
      m.compose(pos, q, scl).multiply(local);
      inst.setMatrixAt(i, m);
    }
    inst.instanceMatrix.needsUpdate = true;
    inst.castShadow = false;
    inst.receiveShadow = true;
    meshes.push(inst);
  };

  // Prefer THREE.traverse (covers nested groups); fall back to a manual children walk.
  if (typeof r.traverse === "function") {
    r.traverse(processMesh);
  } else {
    const walk = (node: unknown): void => {
      processMesh(node);
      const children = (node as { children?: unknown[] }).children;
      if (Array.isArray(children)) for (const child of children) walk(child);
    };
    walk(root);
  }
  return meshes;
}

/** Dispose an asset InstancedMesh's GPU resources after it's removed from the scene.
 *  Geometry/material are owned by the source glTF; only the instance buffer is freed. */
export function disposeAssetInstancedMesh(mesh: THREE.InstancedMesh): void {
  (mesh as unknown as { dispose?: () => void }).dispose?.();
}
