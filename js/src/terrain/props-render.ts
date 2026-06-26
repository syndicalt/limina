// Phase 9.1 / workstream B — THREE InstancedMesh for a tile's props.
//
// The browser/UAT side of the props: wraps the PURE `propGeometry` (props.ts) in a
// real THREE BufferGeometry, then builds one `InstancedMesh` per present `PropKind`
// and writes each instance's matrix from its `PropInstance` (translate (x,y,z);
// rotate `yaw` about +Y; uniform `scale`). Per-tile instancing — a tile owns one
// InstancedMesh per kind so its props mount/unmount + dispose together with its mesh.
//
// This module imports THREE. The instance-transform MATH (render matches scatter) is
// proven headlessly in js/test/p9_props.ts (matrices are CPU data); the in-tab WebGPU
// DRAW of trees/rocks/grass is UAT.

import * as THREE from "../../build/three.bundle.mjs";
import { propGeometry } from "./props.ts";
import { PropKind, type PropInstance } from "./scatter.ts";

// Per-part COLOR lives in the geometry's vertex-color attribute (brown trunk + green
// canopy, grey rock, green grass), so each kind needs only a roughness + whether it's
// double-sided (grass blades are thin planes -> render both faces).
interface PropMaterialSpec {
  roughness: number;
  metalness: number;
  doubleSide: boolean;
}
const MATERIALS: Record<number, PropMaterialSpec> = {
  [PropKind.Tree]: { roughness: 0.9, metalness: 0.0, doubleSide: false },
  [PropKind.Rock]: { roughness: 0.95, metalness: 0.0, doubleSide: false },
  [PropKind.Grass]: { roughness: 0.85, metalness: 0.0, doubleSide: true },
};

/** Build a THREE BufferGeometry from a prop kind's pure geometry (incl. vertex colors). */
export function propBufferGeometry(kind: number): THREE.BufferGeometry {
  const { positions, indices, normals, colors } = propGeometry(kind);
  const geom = new THREE.BufferGeometry();
  geom.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geom.setAttribute("normal", new THREE.BufferAttribute(normals, 3));
  geom.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  geom.setIndex(new THREE.BufferAttribute(indices, 1));
  geom.computeBoundingSphere();
  geom.computeBoundingBox();
  return geom;
}

const Y_AXIS = new THREE.Vector3(0, 1, 0);

/**
 * Build one InstancedMesh for `instances` (all the SAME kind). Each instance's matrix
 * is composed from its PropInstance: translate (x,y,z), rotate `yaw` about +Y, uniform
 * `scale`. Returns null for an empty list (nothing to draw).
 */
export function buildPropInstancedMesh(kind: number, instances: PropInstance[]): THREE.InstancedMesh | null {
  if (instances.length === 0) return null;
  const spec = MATERIALS[kind] ?? MATERIALS[PropKind.Rock];
  const geom = propBufferGeometry(kind);
  // Per-part color comes from the geometry's vertex-color attribute (vertexColors on).
  const material = new THREE.MeshStandardNodeMaterial({
    vertexColors: true,
    roughness: spec.roughness,
    metalness: spec.metalness,
  });
  if (spec.doubleSide) material.side = THREE.DoubleSide;

  const mesh = new THREE.InstancedMesh(geom, material, instances.length);
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const pos = new THREE.Vector3();
  const scl = new THREE.Vector3();
  for (let i = 0; i < instances.length; i++) {
    const p = instances[i];
    pos.set(p.x, p.y, p.z);
    q.setFromAxisAngle(Y_AXIS, p.yaw);
    scl.set(p.scale, p.scale, p.scale);
    m.compose(pos, q, scl);
    mesh.setMatrixAt(i, m);
  }
  mesh.instanceMatrix.needsUpdate = true;
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  return mesh;
}

/**
 * Group a tile's props by kind and build one InstancedMesh per present kind. The
 * caller adds these to the scene and disposes them (disposePropMesh) when the tile
 * streams out.
 */
export function buildTilePropMeshes(props: PropInstance[]): THREE.InstancedMesh[] {
  const byKind = new Map<number, PropInstance[]>();
  for (const p of props) {
    let list = byKind.get(p.kind);
    if (list === undefined) { list = []; byKind.set(p.kind, list); }
    list.push(p);
  }
  const meshes: THREE.InstancedMesh[] = [];
  for (const [kind, list] of byKind) {
    const mesh = buildPropInstancedMesh(kind, list);
    if (mesh !== null) meshes.push(mesh);
  }
  return meshes;
}

/** Dispose a prop InstancedMesh's GPU resources after it's removed from the scene. */
export function disposePropMesh(mesh: THREE.InstancedMesh): void {
  mesh.geometry?.dispose?.();
  const mat = mesh.material as { dispose?: () => void } | undefined;
  mat?.dispose?.();
  (mesh as unknown as { dispose?: () => void }).dispose?.();
}
