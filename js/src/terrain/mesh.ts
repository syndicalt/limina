// Phase 9 / workstream D — tile heightfield -> render mesh GEOMETRY.
//
// PURE math, no THREE, no DOM: `terrainTileGeometry` turns a `TerrainTile` into
// flat typed arrays (positions / indices / normals). It is the visual twin of the
// native `op_physics_add_heightfield` collider — the vertices sit on the SAME world
// surface the collider reads (heights*scaleY at the tile origin, rows->z cols->x),
// so the rendered ground and the thing an agent stands on are the same surface
// (drop-test parity, asserted headlessly in js/test/p9_terrain_mesh.ts).
//
// The THREE BufferGeometry wrapper lives in src/terrain/render.ts so this module
// stays importable in the headless runtime (which has no THREE/DOM).

import type { TerrainTile } from "./types.ts";

/** Flat geometry buffers for a tile, ready to drop onto a THREE BufferGeometry. */
export interface TerrainGeometry {
  /** xyz per vertex, length = nrows*ncols*3 (vertex v = r*ncols + c). */
  positions: Float32Array;
  /** Triangle indices, length = (nrows-1)*(ncols-1)*2*3, CCW so normals face +y. */
  indices: Uint32Array;
  /** Per-vertex unit normals, length = nrows*ncols*3. */
  normals: Float32Array;
}

/**
 * Build the render-mesh geometry for a terrain tile.
 *
 * Vertex (r, c) lands at the world position the collider agrees on:
 *   x = origin.x - scaleX/2 + c/(ncols-1) * scaleX
 *   y = origin.y + heights[r*ncols + c] * scaleY
 *   z = origin.z - scaleZ/2 + r/(nrows-1) * scaleZ
 * matching the heightfield's rows->z, cols->x convention. Normals are area-weighted
 * face normals accumulated per vertex then normalized (smooth shading).
 *
 * Pure: identical tiles produce byte-identical buffers (replay/cache friendly).
 */
export function terrainTileGeometry(tile: TerrainTile): TerrainGeometry {
  const { nrows, ncols, heights } = tile;
  if (!Number.isInteger(nrows) || !Number.isInteger(ncols) || nrows < 2 || ncols < 2) {
    throw new Error(`terrainTileGeometry: need nrows,ncols >= 2 (got ${nrows}x${ncols})`);
  }
  const expected = nrows * ncols;
  if (heights.length !== expected) {
    throw new Error(`terrainTileGeometry: heights length ${heights.length} != nrows*ncols ${expected}`);
  }
  const [ox, oy, oz] = tile.origin;
  const [scaleX, scaleY, scaleZ] = tile.scale;

  const x0 = ox - scaleX / 2;
  const z0 = oz - scaleZ / 2;
  // Divisors are the span between samples; nrows/ncols >= 2 so these are non-zero.
  const dxStep = scaleX / (ncols - 1);
  const dzStep = scaleZ / (nrows - 1);

  const vertCount = nrows * ncols;
  const positions = new Float32Array(vertCount * 3);
  const normals = new Float32Array(vertCount * 3);

  for (let r = 0; r < nrows; r++) {
    for (let c = 0; c < ncols; c++) {
      const v = r * ncols + c;
      const o = v * 3;
      positions[o] = x0 + c * dxStep;
      positions[o + 1] = oy + heights[v] * scaleY;
      positions[o + 2] = z0 + r * dzStep;
    }
  }

  // Triangulate each quad with a winding that yields +y-facing normals (see the
  // derivation in js/test/p9_terrain_mesh.ts): [v00, v10, v01] and [v10, v11, v01].
  const quadCount = (nrows - 1) * (ncols - 1);
  const indices = new Uint32Array(quadCount * 6);
  let i = 0;
  for (let r = 0; r < nrows - 1; r++) {
    for (let c = 0; c < ncols - 1; c++) {
      const v00 = r * ncols + c;
      const v01 = v00 + 1;
      const v10 = v00 + ncols;
      const v11 = v10 + 1;
      indices[i++] = v00; indices[i++] = v10; indices[i++] = v01;
      indices[i++] = v10; indices[i++] = v11; indices[i++] = v01;
    }
  }

  // Accumulate (un-normalized = area-weighted) face normals onto each vertex.
  for (let t = 0; t < indices.length; t += 3) {
    const ia = indices[t] * 3, ib = indices[t + 1] * 3, ic = indices[t + 2] * 3;
    const ax = positions[ia], ay = positions[ia + 1], az = positions[ia + 2];
    const e1x = positions[ib] - ax, e1y = positions[ib + 1] - ay, e1z = positions[ib + 2] - az;
    const e2x = positions[ic] - ax, e2y = positions[ic + 1] - ay, e2z = positions[ic + 2] - az;
    const nx = e1y * e2z - e1z * e2y;
    const ny = e1z * e2x - e1x * e2z;
    const nz = e1x * e2y - e1y * e2x;
    normals[ia] += nx; normals[ia + 1] += ny; normals[ia + 2] += nz;
    normals[ib] += nx; normals[ib + 1] += ny; normals[ib + 2] += nz;
    normals[ic] += nx; normals[ic + 1] += ny; normals[ic + 2] += nz;
  }
  for (let v = 0; v < vertCount; v++) {
    const o = v * 3;
    const nx = normals[o], ny = normals[o + 1], nz = normals[o + 2];
    const len = Math.sqrt(nx * nx + ny * ny + nz * nz); // sqrt is IEEE-754 correctly-rounded -> bit-stable (Math.hypot is not)
    if (len > 0) {
      normals[o] = nx / len;
      normals[o + 1] = ny / len;
      normals[o + 2] = nz / len;
    } else {
      // Degenerate (all-collinear) fan — fall back to up so shading is defined.
      normals[o] = 0; normals[o + 1] = 1; normals[o + 2] = 0;
    }
  }

  return { positions, indices, normals };
}
