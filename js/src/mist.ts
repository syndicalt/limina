// Blight (caesura) mist — a low-lying, GRAVITY-AWARE putrid miasma that pools in the hollows of a
// painted blight region. RENDER-ONLY, exactly like water.ts / the paint-driven grass: built from the
// terrain tile's blight mask + heights, added to the scene, and recomputed on replay from the recorded
// map (never sim state). Deterministic: a pure function of the tile, so the same map re-mounts an
// identical miasma. The "gravity-aware" part is baked density — mist is thick where the blighted ground
// is LOW (settled into hollows) and thins toward the blight's high ground.

import * as THREE from "../build/three.bundle.mjs";
import type { TerrainTile } from "./terrain/types.ts";

// deno-lint-ignore no-explicit-any
const T = (THREE as any).TSL;

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
  // SELF-LIT miasma: a black albedo (no lit response — the intense scene sun would otherwise blow a
  // lit surface out to white) carrying the putrid colour on the EMISSIVE channel, with tone mapping
  // off so it keeps that authored colour (same reason UI panels opt out). colorNode + emissiveNode are
  // the proven node properties (water.ts / grass.ts); MeshBasicNodeMaterial.colorNode reads as white.
  const material = new THREE.MeshStandardNodeMaterial({ transparent: true, depthWrite: false, roughness: 1, metalness: 0 });
  material.side = THREE.DoubleSide;
  material.toneMapped = false;
  material.colorNode = T.vec3(0, 0, 0);

  // World (x,z) → tile uv (0..1); DataTexture flipY defaults false, so (u,v) → (col,row).
  const x0 = ox - sx / 2, z0 = oz - sz / 2;
  const u = T.positionWorld.x.sub(x0).div(sx);
  const v = T.positionWorld.z.sub(z0).div(sz);
  const density = T.texture(tex, T.vec2(u, v)).r;
  // Slow creeping drift so the miasma breathes rather than sitting as a flat decal.
  const drift = T.positionWorld.x.mul(0.03).add(T.positionWorld.z.mul(0.027)).add(T.time.mul(0.25)).sin().mul(0.5).add(0.5);
  material.opacityNode = T.clamp(density.mul(0.7).mul(T.float(0.6).add(drift.mul(0.4))), 0, 0.82);
  // Putrid: a murky, sickly yellow-green on the EMISSIVE channel (self-lit, tone-mapping off, so this IS
  // the on-screen colour). Denser hollows read a touch darker/greener (concentrated miasma).
  material.emissiveNode = T.mix(T.vec3(0.34, 0.40, 0.24), T.vec3(0.20, 0.28, 0.12), T.clamp(density, 0, 1));

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
