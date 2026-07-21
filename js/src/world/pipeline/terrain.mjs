// PIPELINE STAGE 2 — TERRAIN (eroded). Base fBm heightfield → limina's hydraulic + thermal EROSION
// (erosion.mjs, ported from js/src/terrain) which carves drainage valleys/channels — so the WATER
// stage has interesting geography to pool + flow through. Grid-based: the eroded heightfield IS the
// mesh vertices, and heightAt/flowAt/slopeAt bilinear-sample that same grid, so every downstream
// stage (water form, river routing, vegetation + structure seating) agrees on the surface.
// Deterministic: same config+seed → byte-identical terrain (no Date/Math.random).
import * as THREE from "three";
import { generateHeightfield, DEFAULT_TERRAIN } from "./terrain-heightfield.mjs";

// The eroded-heightfield generation (fBm → erosion → renormalize → flow → sea level) lives in
// the PURE, THREE-free terrain-heightfield.mjs so the engine's terrain.create skill can generate
// the SAME field headlessly. This module keeps the THREE mesh authoring (elevation coloring, the
// samplers, the render Mesh). Re-exported for back-compat with prior importers.
export { DEFAULT_TERRAIN };

const COL = { sand: new THREE.Color(0xc4b68e), grass: new THREE.Color(0x5f7f3c), grassDark: new THREE.Color(0x44602a), rock: new THREE.Color(0x736b60), snow: new THREE.Color(0xe2e7ec) };

export function generateTerrain(overrides = {}) {
  // 1-3. base fBm → erosion → renormalize → flow → sea level (the PURE heightfield).
  const { heights, flow, maxFlow, cols, rows, step, half, cfg } = generateHeightfield(overrides);

  // bilinear samplers over the grid (world x,z → grid).
  const sample = (grid, x, z) => {
    let gx = (x + half) / step, gz = (z + half) / step;
    gx = Math.max(0, Math.min(cols - 1.0001, gx)); gz = Math.max(0, Math.min(rows - 1.0001, gz));
    const ix = Math.floor(gx), iz = Math.floor(gz), fx = gx - ix, fz = gz - iz, i = iz * cols + ix;
    return grid[i] * (1 - fx) * (1 - fz) + grid[i + 1] * fx * (1 - fz) + grid[i + cols] * (1 - fx) * fz + grid[i + cols + 1] * fx * fz;
  };
  const heightAt = (x, z) => sample(heights, x, z);
  const slopeAt = (x, z) => { const hx = heightAt(x + step, z) - heightAt(x - step, z), hz = heightAt(x, z + step) - heightAt(x, z - step); return Math.hypot(hx, hz) / (2 * step); };
  const flowAt = (x, z) => sample(flow, x, z) / maxFlow; // 0..1 river-ness

  // 4. mesh from the grid.
  const verts = new Float32Array(rows * cols * 3), colors = new Float32Array(rows * cols * 3), c = new THREE.Color();
  for (let gz = 0; gz < rows; gz++) for (let gx = 0; gx < cols; gx++) {
    const idx = gz * cols + gx, x = -half + gx * step, z = -half + gz * step, y = heights[idx];
    verts[idx * 3] = x; verts[idx * 3 + 1] = y; verts[idx * 3 + 2] = z;
    const slope = Math.min(1, slopeAt(x, z) * 1.2);
    if (y < cfg.seaLevelM + 0.6) c.copy(COL.sand);
    else if (y > cfg.amplitude * 0.82) c.copy(COL.snow);
    else c.copy(COL.grass).lerp(COL.grassDark, (Math.sin((x + z) * 0.2) * 0.5 + 0.5) * 0.3);
    if (slope > 0.4 && y >= cfg.seaLevelM) c.lerp(COL.rock, Math.min(1, (slope - 0.4) / 0.4));
    colors[idx * 3] = c.r; colors[idx * 3 + 1] = c.g; colors[idx * 3 + 2] = c.b;
  }
  const indices = new Uint32Array((rows - 1) * (cols - 1) * 6); let t = 0;
  for (let gz = 0; gz < rows - 1; gz++) for (let gx = 0; gx < cols - 1; gx++) {
    const a = gz * cols + gx, b = a + 1, d = a + cols, e = d + 1;
    indices[t++] = a; indices[t++] = d; indices[t++] = b; indices[t++] = b; indices[t++] = d; indices[t++] = e;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(verts, 3));
  geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  geo.setIndex(new THREE.BufferAttribute(indices, 1));
  geo.computeVertexNormals();
  const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, metalness: 0.0 }));
  mesh.receiveShadow = true; mesh.name = "terrain";

  return { object3d: mesh, heightAt, slopeAt, flowAt, config: cfg, halfSize: half, grid: { heights, flow, cols, rows, step, maxFlow } };
}
