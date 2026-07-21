// Blight (caesura) mist — a low-lying, GRAVITY-AWARE putrid miasma that pools in the hollows of a
// painted blight region. RENDER-ONLY, exactly like water.ts / the paint-driven grass: built from the
// terrain tile's blight mask + heights, added to the scene, and recomputed on replay from the recorded
// map (never sim state). Deterministic: a pure function of the tile, so the same map re-mounts an
// identical miasma. The "gravity-aware" part is baked density — mist is thick where the blighted ground
// is LOW (settled into hollows) and thins toward the blight's high ground.

import * as THREE from "../build/three.bundle.mjs";
import type { TerrainTile } from "./terrain/types.ts";

/** Build the blight-mist mesh for a tile, or `undefined` when the tile carries no blight. The caller
 *  adds it to the scene and disposes it when the terrain layer is removed. */
export function buildBlightMist(tile: TerrainTile): THREE.Mesh | undefined {
  const blight = tile.blight;
  if (blight === undefined) return undefined;
  const { nrows, ncols, origin, scale, heights } = tile;

  // Blight extent + the terrain-height range WITHIN the blight (for the gravity normalisation).
  let any = false, loH = Infinity, hiH = -Infinity;
  for (let i = 0; i < blight.length; i++) {
    if (blight[i] > 0) { any = true; const h = heights[i]; if (h < loH) loH = h; if (h > hiH) hiH = h; }
  }
  if (!any) return undefined;
  const reliefIn = Math.max(1e-3, hiH - loH);

  // DENSITY grid = blight × gravity-pool. pool = 1 at the blight's LOWEST ground → 0 at its highest, so
  // the miasma is thickest in the hollows and thins on the rises. A 0.35 floor keeps a veil even on
  // mid-height blight so the whole caesura reads corrupted, not just its lowest pools. Bake to R8.
  const data = new Uint8Array(nrows * ncols);
  for (let i = 0; i < blight.length; i++) {
    const b = Math.min(1, Math.max(0, blight[i]));
    const pool = 1 - Math.min(1, Math.max(0, (heights[i] - loH) / reliefIn));
    data[i] = Math.round(b * (0.35 + 0.65 * pool) * 255);
  }
  const tex = new THREE.DataTexture(data, ncols, nrows, THREE.RedFormat, THREE.UnsignedByteType);
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.needsUpdate = true;

  const [ox, oy, oz] = origin;
  const [sx, , sz] = scale;
  const geometry = new THREE.PlaneGeometry(sx, sz, 1, 1);
  // The baked R8 texture already contains the gravity-aware density. A conventional basic material
  // keeps the effect portable across WebGPU and WebGL2; the former node-material implementation
  // stalled WebGL2 shader compilation on the first rendered frame for real map-sized masks.
  const material = new THREE.MeshBasicMaterial({
    color: 0x526335,
    alphaMap: tex,
    alphaTest: 0.015,
    opacity: 0.68,
    transparent: true,
    depthWrite: false,
  });
  material.side = THREE.DoubleSide;
  material.toneMapped = false;

  const mesh = new THREE.Mesh(geometry, material);
  mesh.rotation.x = -Math.PI / 2;
  // Low-lying: ~2.2 m over the blight's LOWEST ground. Where the terrain rises above this, the plane is
  // occluded AND its density is ~0 (pool→0), so no mist floats over the high ground — it hugs hollows.
  mesh.position.set(ox, oy + loH + 2.2, oz);
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  mesh.name = "limina:blight-mist";
  mesh.renderOrder = 10;
  return mesh;
}
