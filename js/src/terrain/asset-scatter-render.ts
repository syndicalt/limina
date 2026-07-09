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
 * multi-part asset places all parts) — or, with `opts.chunkSize` set, one per renderable
 * mesh PER SPATIAL CELL (see the chunkSize doc below); an empty list when there are no
 * instances or the asset has no meshes. The caller adds the meshes to the scene + disposes them.
 */
export function buildAssetInstancedMeshes(
  root: SceneObject,
  instances: AssetInstance[],
  opts?: {
    /** Scale the WHOLE asset so its height (Y extent) equals this many metres, about its base.
     *  Used for small set-dressing (lawn flowers/tufts) whose curated GLBs have inconsistent
     *  authored scales — a 1.8 km "grass tuft" would otherwise swamp the scene. Assets whose
     *  height is degenerate (≈0) are skipped (empty list). Omit to keep the asset's own size
     *  (trees/rocks, where the intrinsic metre scale is meaningful). */
    normalizeHeight?: number;
    /** Spatial CHUNKING (metres) for a scatter that can span a large area (a forest laid across a
     *  whole map): bucket instances into a fixed XZ grid of this cell size and mount ONE InstancedMesh
     *  per (mesh node × cell) instead of one per node for the whole flat list. Each chunk gets its own
     *  tight bounding sphere (see below), so a far chunk can be frustum-culled independently of a near
     *  one — without chunking, a map-spanning scatter's single bounding sphere would cover the entire
     *  span and the frustum would almost always intersect it, i.e. no culling GRANULARITY even once the
     *  sphere is correct. Omit (the default) for scatters that are already spatially bounded (per-region
     *  props, per-building dressing) — one bucket, byte-identical mesh count/order to no chunking. */
    chunkSize?: number;
    /** DEAD (blighted) variant: render a bare, colour-drained tree — drop the leaf-card nodes
     *  (alphaTest MASK foliage) entirely and grey the surviving bark. Used by vegetation.scatter for
     *  instances that fall inside a painted caesura, so the canopy dies with the ground. */
    dead?: boolean;
  },
): THREE.InstancedMesh[] {
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

  // SIZE NORMALIZATION (opt-in): scale the whole asset about its base so its height matches the
  // requested metre size — robustness for curated set-dressing GLBs authored at wild scales (a
  // 1.8 km grass tuft) or degenerately (0-size). Composed AFTER `offset` (which bases the asset at
  // Y=0), so the scale is about the base. A degenerate asset (height ≈ 0) can't be normalized → skip.
  if (opts?.normalizeHeight !== undefined) {
    const assetH = ymax - ymin;
    if (!(assetH > 1e-3)) return []; // degenerate/empty asset — nothing sane to place
    const s = opts.normalizeHeight / assetH;
    offset.premultiply(new THREE.Matrix4().makeScale(s, s, s));
  }

  // Bucket instances into fixed-size spatial cells (opt-in via opts.chunkSize) so a map-spanning
  // scatter gets one InstancedMesh PER AREA per mesh node, instead of one covering the whole span —
  // see the chunkSize doc comment above for why. Chunking off (the default): one "bucket" holding every
  // instance, in original order — byte-identical to the pre-chunking single-mesh-per-node behaviour.
  const cellSize = opts?.chunkSize;
  const buckets: AssetInstance[][] = [];
  if (cellSize === undefined || !(cellSize > 0)) {
    buckets.push(instances);
  } else {
    const cells = new Map<string, AssetInstance[]>();
    for (const inst of instances) {
      const key = `${Math.floor(inst.x / cellSize)}:${Math.floor(inst.z / cellSize)}`;
      let list = cells.get(key);
      if (list === undefined) { list = []; cells.set(key, list); }
      list.push(inst);
    }
    buckets.push(...cells.values());
  }

  // One InstancedMesh per (mesh node × cell bucket), all sharing the asset-level corrective offset
  // (applied in asset-root space via premultiply → vertex path: instance × offset × local × vertex).
  const meshes: THREE.InstancedMesh[] = [];
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const pos = new THREE.Vector3();
  const scl = new THREE.Vector3();
  for (const { geometry, material, local } of nodes) {
    const placed = new THREE.Matrix4().copy(local).premultiply(offset);
    if (geometry.boundingSphere === null) geometry.computeBoundingSphere();
    // ALPHA-CUTOUT FOLIAGE AT DISTANCE: leaf-card materials bake alphaMode MASK (cutoff ~0.3).
    // Mip-averaged alpha falls below that cutoff a few hundred metres out, so a whole canopy
    // erodes to bare trunks — a forest reads DEAD from any aerial/orbit view. Lower the test on
    // a CLONE (render-side only; never mutates the shared/loaded asset material) so distant
    // foliage survives mipping. 0.08 keeps edges acceptable at eye level.
    const isFoliage = ((material as unknown as { alphaTest?: number }).alphaTest ?? 0) > 0.1;
    // DEAD variant: the caesura kills the canopy. Drop the leaf-card nodes entirely (a bare tree) and
    // drain the surviving bark to a desaturated ash-grey — matching the ground's blight drain.
    if (opts?.dead === true && isFoliage) continue;
    let instMaterial: THREE.Material;
    if (opts?.dead === true) {
      const c = (material as unknown as { clone(): THREE.Material }).clone() as unknown as { color?: THREE.Color; emissive?: THREE.Color; roughness?: number };
      c.color?.setRGB(0.33, 0.30, 0.26);
      c.emissive?.setRGB(0, 0, 0);
      if (c.roughness !== undefined) c.roughness = 1;
      instMaterial = c as unknown as THREE.Material;
    } else if (isFoliage) {
      // ALPHA-CUTOUT FOLIAGE AT DISTANCE: leaf-card materials bake alphaMode MASK (cutoff ~0.3).
      // Mip-averaged alpha falls below that cutoff a few hundred metres out, so a whole canopy
      // erodes to bare trunks — a forest reads DEAD from any aerial/orbit view. Lower the test on
      // a CLONE (render-side only; never mutates the shared/loaded asset material) so distant
      // foliage survives mipping. 0.08 keeps edges acceptable at eye level.
      const c = (material as unknown as { clone(): THREE.Material }).clone();
      (c as unknown as { alphaTest: number }).alphaTest = 0.08;
      instMaterial = c;
    } else {
      instMaterial = material;
    }
    for (const bucket of buckets) {
      const inst = new THREE.InstancedMesh(geometry, instMaterial, bucket.length);
      for (let i = 0; i < bucket.length; i++) {
        const p = bucket[i];
        pos.set(p.x, p.y, p.z);
        q.setFromAxisAngle(Y_AXIS, p.yaw);
        scl.set(p.scale, p.scale, p.scale);
        m.compose(pos, q, scl).multiply(placed);
        inst.setMatrixAt(i, m);
      }
      inst.instanceMatrix.needsUpdate = true;
      inst.castShadow = false;
      inst.receiveShadow = true;
      // A REAL bounding sphere: THREE's InstancedMesh.computeBoundingSphere() (three ^0.184) unions the
      // per-instance-matrix-transformed geometry bounding sphere across every instance — it already
      // accounts for instance transforms, unlike a Mesh's plain (origin-only) bounding sphere. Compute
      // it eagerly (rather than leaving the renderer to lazily compute it on first frustum test) so the
      // cost is paid once at mount time. frustumCulled stays at THREE's default `true`: combined with
      // the per-cell bucketing above, a chunk whose sphere sits outside the frustum is skipped whole —
      // real culling, instead of every scatter submitting every frame regardless of camera.
      inst.computeBoundingSphere();
      meshes.push(inst);
    }
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
