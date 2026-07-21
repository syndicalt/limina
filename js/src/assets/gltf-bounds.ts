// Deterministic glTF/GLB LOCAL AABB — WITHOUT instantiating a THREE scene or decoding any texture.
//
// WHY THIS EXISTS: the building collider asset.place emits (op_physics_add_static_box over the placed
// asset's world AABB) used to be measured off the parsed THREE mesh (Box3.setFromObject). But the
// AUTHORITATIVE browser physics runs in the SIM-WORKER, which DELIBERATELY does NOT parse the mesh
// (GLTFLoader's texture decode has no DOM and hangs a Worker — see loadGltfIntoScene `skipMesh`). So
// in the worker `rec.mesh` was undefined and the collider was silently skipped — the player walked
// straight through every placed building in a real browser (the p84 bug).
//
// This computes the asset's LOCAL-space AABB straight from the GLB container: the glTF JSON chunk +
// each mesh primitive's POSITION accessor min/max (already carried in the JSON), transformed by that
// node's world matrix. No geometry buffers are read, no textures touched — a fast, allocation-light,
// fully deterministic pass that runs identically in the worker, the render-main thread, and headless
// gates. asset.place then applies the placement (scale/rotation/ground/position) to get the world
// AABB and authors the collider in EVERY context.
//
// DETERMINISM: pure function of the bytes. Same GLB ⇒ same AABB, so a replay re-derives an identical
// collider. No Math.random / Date / wall-clock.

import * as THREE from "../../build/three.bundle.mjs";

/** An axis-aligned box in the asset's local space. */
export interface LocalAabb {
  min: [number, number, number];
  max: [number, number, number];
}

const GLB_MAGIC = 0x46546c67; // "glTF"
const CHUNK_JSON = 0x4e4f534a; // "JSON"

interface GltfNode {
  mesh?: number;
  children?: number[];
  matrix?: number[];
  translation?: [number, number, number];
  rotation?: [number, number, number, number];
  scale?: [number, number, number];
}
interface GltfPrimitive { attributes?: Record<string, number> }
interface GltfMesh { primitives?: GltfPrimitive[] }
interface GltfAccessor { min?: number[]; max?: number[] }
interface GltfScene { nodes?: number[] }
interface GltfJson {
  scene?: number;
  scenes?: GltfScene[];
  nodes?: GltfNode[];
  meshes?: GltfMesh[];
  accessors?: GltfAccessor[];
}

/** Parse the JSON chunk out of a binary GLB, or a raw .gltf JSON document. Returns null when the
 *  bytes are empty / not a recognizable glTF (a missing asset ⇒ no collider, handled by the caller). */
function parseGltfJson(bytes: Uint8Array): GltfJson | null {
  if (bytes.byteLength < 12) return null;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (dv.getUint32(0, true) === GLB_MAGIC) {
    // Binary GLB: 12-byte header, then length-prefixed chunks; the first is JSON.
    let offset = 12;
    while (offset + 8 <= bytes.byteLength) {
      const chunkLen = dv.getUint32(offset, true);
      const chunkType = dv.getUint32(offset + 4, true);
      const dataStart = offset + 8;
      if (chunkType === CHUNK_JSON) {
        const jsonBytes = bytes.subarray(dataStart, dataStart + chunkLen);
        try {
          return JSON.parse(new TextDecoder().decode(jsonBytes)) as GltfJson;
        } catch {
          return null;
        }
      }
      offset = dataStart + chunkLen;
    }
    return null;
  }
  // Fall back to a raw .gltf JSON document.
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as GltfJson;
  } catch {
    return null;
  }
}

/** Compose a node's LOCAL matrix from either its explicit `matrix` or its TRS. */
function nodeLocalMatrix(node: GltfNode, out: THREE.Matrix4): THREE.Matrix4 {
  if (node.matrix !== undefined && node.matrix.length === 16) {
    // glTF matrices are column-major, which is exactly THREE's Matrix4.fromArray layout.
    return out.fromArray(node.matrix);
  }
  const t = node.translation ?? [0, 0, 0];
  const r = node.rotation ?? [0, 0, 0, 1];
  const s = node.scale ?? [1, 1, 1];
  return out.compose(
    new THREE.Vector3(t[0], t[1], t[2]),
    new THREE.Quaternion(r[0], r[1], r[2], r[3]),
    new THREE.Vector3(s[0], s[1], s[2]),
  );
}

/**
 * Compute the LOCAL-space AABB of a glTF/GLB asset from its bytes — the union of every mesh
 * primitive's POSITION min/max transformed by that primitive's node world matrix. Returns null when
 * the bytes carry no positioned geometry (empty/corrupt asset, or accessors without min/max), so the
 * caller can skip the collider rather than author a degenerate box.
 */
export function gltfLocalAabb(bytes: Uint8Array): LocalAabb | null {
  const json = parseGltfJson(bytes);
  if (json === null) return null;
  const nodes = json.nodes ?? [];
  const meshes = json.meshes ?? [];
  const accessors = json.accessors ?? [];

  const minOut: [number, number, number] = [Infinity, Infinity, Infinity];
  const maxOut: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  let found = false;

  const corner = new THREE.Vector3();
  const local = new THREE.Matrix4();
  const child = new THREE.Matrix4();

  // Depth-first over the default scene's node hierarchy, accumulating world matrices.
  const rootNodeIds =
    json.scenes?.[json.scene ?? 0]?.nodes ??
    // No scene declared: fall back to every node as a root (matches THREE's tolerant load).
    nodes.map((_, i) => i);

  const stack: Array<{ id: number; world: THREE.Matrix4 }> = [];
  for (const id of rootNodeIds) stack.push({ id, world: new THREE.Matrix4() });

  while (stack.length > 0) {
    const { id, world } = stack.pop()!;
    const node = nodes[id];
    if (node === undefined) continue;
    nodeLocalMatrix(node, local);
    const nodeWorld = new THREE.Matrix4().multiplyMatrices(world, local);

    if (node.mesh !== undefined) {
      const mesh = meshes[node.mesh];
      for (const prim of mesh?.primitives ?? []) {
        const posIdx = prim.attributes?.POSITION;
        if (posIdx === undefined) continue;
        const acc = accessors[posIdx];
        if (acc?.min === undefined || acc.max === undefined || acc.min.length < 3 || acc.max.length < 3) continue;
        const [mnx, mny, mnz] = acc.min;
        const [mxx, mxy, mxz] = acc.max;
        // Transform all 8 corners of the accessor AABB and union them (a rotated box's world AABB is
        // the AABB of its transformed corners).
        for (let cx = 0; cx < 2; cx++) {
          for (let cy = 0; cy < 2; cy++) {
            for (let cz = 0; cz < 2; cz++) {
              corner.set(cx ? mxx : mnx, cy ? mxy : mny, cz ? mxz : mnz).applyMatrix4(nodeWorld);
              if (corner.x < minOut[0]) minOut[0] = corner.x;
              if (corner.y < minOut[1]) minOut[1] = corner.y;
              if (corner.z < minOut[2]) minOut[2] = corner.z;
              if (corner.x > maxOut[0]) maxOut[0] = corner.x;
              if (corner.y > maxOut[1]) maxOut[1] = corner.y;
              if (corner.z > maxOut[2]) maxOut[2] = corner.z;
              found = true;
            }
          }
        }
      }
    }

    for (const c of node.children ?? []) stack.push({ id: c, world: nodeWorld.clone() });
  }

  if (!found) return null;
  return { min: minOut, max: maxOut };
}
