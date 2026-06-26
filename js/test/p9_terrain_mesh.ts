// Phase 9 / workstream D (headless) — proves the terrain render-mesh GEOMETRY and
// the LOD/stream bookkeeping as PURE logic. No GPU, no THREE: the in-tab WebGPU
// render of the mesh is UAT, but the mesh MATH (and that it coincides with the
// `op_physics_add_heightfield` collider surface — drop-test parity) and the stream
// set diff (no thrash, no gaps) are fully provable here.

import { ops } from "../src/engine.ts";
import { terrainTileGeometry } from "../src/terrain/mesh.ts";
import type { TerrainTile } from "../src/terrain/types.ts";
import { StreamFollower, desiredTiles, tileKey, worldToTile } from "../src/terrain/stream.ts";

function assert(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new Error("p9_terrain_mesh FAIL: " + msg);
}
const close = (a: number, b: number, eps = 1e-4): boolean => Math.abs(a - b) <= eps;

// ---------------------------------------------------------------------------
// A sample tile: an off-origin tile with a non-trivial (per-cell varying) height
// field so a flat-plane bug would be caught. heights*scaleY must be applied.
const NROWS = 17, NCOLS = 23; // non-square + odd, to catch row/col swaps.
const ORIGIN: [number, number, number] = [40, 5, -30];
const SCALE: [number, number, number] = [64, 8, 48]; // width(x), heightScale(y), depth(z)
const heights = new Float32Array(NROWS * NCOLS);
for (let r = 0; r < NROWS; r++) {
  for (let c = 0; c < NCOLS; c++) {
    // Distinct per (r,c), and asymmetric in r vs c so a transpose is detectable.
    heights[r * NCOLS + c] = 0.25 * Math.sin(r * 0.6) + 0.15 * Math.cos(c * 0.4) + 0.5;
  }
}
const tile: TerrainTile = { nrows: NROWS, ncols: NCOLS, origin: ORIGIN, scale: SCALE, heights };

const g = terrainTileGeometry(tile);

// 1. Vertex count = nrows*ncols.
assert(g.positions.length === NROWS * NCOLS * 3, `positions length ${g.positions.length} != ${NROWS * NCOLS * 3}`);
assert(g.normals.length === NROWS * NCOLS * 3, `normals length ${g.normals.length} != ${NROWS * NCOLS * 3}`);

// 2. Index count = (nrows-1)*(ncols-1)*2 triangles.
const tris = (NROWS - 1) * (NCOLS - 1) * 2;
assert(g.indices.length === tris * 3, `index count ${g.indices.length} != ${tris * 3} (${tris} tris)`);
let maxIdx = 0;
for (const v of g.indices) maxIdx = Math.max(maxIdx, v);
assert(maxIdx === NROWS * NCOLS - 1, `max index ${maxIdx} != last vertex ${NROWS * NCOLS - 1}`);

// 3. Sampled vertices match the CONTRACT formula exactly — including Y =
//    origin.y + heights[idx]*scaleY (the surface the collider reads).
function expectVertex(r: number, c: number): [number, number, number] {
  return [
    ORIGIN[0] - SCALE[0] / 2 + (c / (NCOLS - 1)) * SCALE[0],
    ORIGIN[1] + heights[r * NCOLS + c] * SCALE[1],
    ORIGIN[2] - SCALE[2] / 2 + (r / (NROWS - 1)) * SCALE[2],
  ];
}
for (const [r, c] of [[0, 0], [5, 11], [NROWS - 1, NCOLS - 1], [9, 0], [0, NCOLS - 1]] as const) {
  const v = r * NCOLS + c;
  const [ex, ey, ez] = expectVertex(r, c);
  assert(close(g.positions[v * 3], ex), `vertex (${r},${c}) x=${g.positions[v * 3]} != ${ex}`);
  assert(close(g.positions[v * 3 + 1], ey), `vertex (${r},${c}) Y=${g.positions[v * 3 + 1]} != ${ey} (heights*scaleY)`);
  assert(close(g.positions[v * 3 + 2], ez), `vertex (${r},${c}) z=${g.positions[v * 3 + 2]} != ${ez}`);
}

// 4. Corner XZ spans the tile extent: width along x = scaleX, depth along z = scaleZ.
const v00 = 0;
const vTR = (NROWS - 1) * NCOLS + (NCOLS - 1);
const spanX = g.positions[vTR * 3] - g.positions[v00 * 3];
const spanZ = g.positions[vTR * 3 + 2] - g.positions[v00 * 3 + 2];
assert(close(spanX, SCALE[0]), `x span ${spanX} != width ${SCALE[0]}`);
assert(close(spanZ, SCALE[2]), `z span ${spanZ} != depth ${SCALE[2]}`);
// Min/max x are the tile edges centered on origin.x.
let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
for (let v = 0; v < NROWS * NCOLS; v++) {
  minX = Math.min(minX, g.positions[v * 3]); maxX = Math.max(maxX, g.positions[v * 3]);
  minZ = Math.min(minZ, g.positions[v * 3 + 2]); maxZ = Math.max(maxZ, g.positions[v * 3 + 2]);
}
assert(close(minX, ORIGIN[0] - SCALE[0] / 2) && close(maxX, ORIGIN[0] + SCALE[0] / 2), `x extent [${minX},${maxX}] not centered on origin.x`);
assert(close(minZ, ORIGIN[2] - SCALE[2] / 2) && close(maxZ, ORIGIN[2] + SCALE[2] / 2), `z extent [${minZ},${maxZ}] not centered on origin.z`);

// 5. Normals are unit-length and point generally up (+y) for a heightfield.
let upward = 0;
for (let v = 0; v < NROWS * NCOLS; v++) {
  const nx = g.normals[v * 3], ny = g.normals[v * 3 + 1], nz = g.normals[v * 3 + 2];
  assert(close(Math.hypot(nx, ny, nz), 1, 1e-5), `normal at v=${v} not unit length: |n|=${Math.hypot(nx, ny, nz)}`);
  if (ny > 0) upward++;
}
assert(upward === NROWS * NCOLS, `expected all ${NROWS * NCOLS} normals to face +y, got ${upward}`);

// 6. DROP-TEST PARITY: the mesh surface coincides with the native heightfield
//    collider. Build the SAME tile as a Rapier heightfield, raycast straight down
//    at a sample column, and assert the hit Y equals the mesh vertex Y there.
//    (The collider centers the field on its origin the same way the mesh does.)
ops.op_physics_create_world(-9.81);
const bodyId = ops.op_physics_add_heightfield(
  ORIGIN[0], ORIGIN[1], ORIGIN[2], NROWS, NCOLS, SCALE[0], SCALE[1], SCALE[2], heights,
);
ops.op_physics_step();
// Probe at an interior vertex's XZ; the collider interpolates between samples but at
// a vertex it equals that sample's height — compare to the mesh vertex Y exactly.
const pr = 8, pc = 11;
const probe = expectVertex(pr, pc);
const ray = new Float32Array(6);
ops.op_physics_raycast(probe[0], ORIGIN[1] + SCALE[1] + 10, probe[2], 0, -1, 0, 60, ray);
assert(ray[0] === 1, "drop-ray did not hit the heightfield collider");
assert(ray[5] === bodyId, `drop-ray hit body ${ray[5]}, expected the heightfield ${bodyId}`);
const meshY = g.positions[(pr * NCOLS + pc) * 3 + 1];
assert(close(ray[3], meshY, 0.02), `collider surface Y=${ray[3]} != mesh vertex Y=${meshY} (render/collider disagree)`);

// 7. PURITY: identical tile -> byte-identical buffers (cache/replay friendly).
const g2 = terrainTileGeometry(tile);
for (let i = 0; i < g.positions.length; i++) assert(Object.is(g.positions[i], g2.positions[i]), `positions not deterministic at ${i}`);
for (let i = 0; i < g.normals.length; i++) assert(Object.is(g.normals[i], g2.normals[i]), `normals not deterministic at ${i}`);

// ===========================================================================
// STREAM / LOD bookkeeping.
const TILE = 16;
// worldToTile is the inverse of the mesh's tile placement.
assert(JSON.stringify(worldToTile(0, 0, TILE)) === JSON.stringify({ tx: 0, tz: 0 }), "worldToTile(0,0) wrong");
assert(JSON.stringify(worldToTile(17, -1, TILE)) === JSON.stringify({ tx: 1, tz: -1 }), "worldToTile boundary wrong");

// A radius-2 square window is a 5x5 = 25-tile block.
const R = 2;
const f = new StreamFollower({ tileSize: TILE, radius: R, shape: "square" });
const d0 = f.update(0.5 * TILE, 0.5 * TILE); // anchor in tile (0,0)
assert(JSON.stringify(d0.anchor) === JSON.stringify({ tx: 0, tz: 0 }), "initial anchor tile wrong");
const expectCount = (2 * R + 1) * (2 * R + 1);
assert(d0.load.length === expectCount, `first update should load ${expectCount} tiles, got ${d0.load.length}`);
assert(d0.unload.length === 0, `first update should unload nothing, got ${d0.unload.length}`);
assert(d0.resident.length === expectCount, `resident should be ${expectCount}, got ${d0.resident.length}`);
// desiredTiles agrees with the follower's resident set.
const want0 = new Set(desiredTiles({ tx: 0, tz: 0 }, R).map((t) => tileKey(t.tx, t.tz)));
assert(want0.size === expectCount && [...f.residentKeys()].every((k) => want0.has(k)), "resident set != desiredTiles");

// Move the anchor ONE tile in +x: a 5x5 window shifts by one column. Exactly the new
// leading column loads (tx=+3, all 5 tz) and the trailing column unloads (tx=-2).
const d1 = f.update(1.5 * TILE, 0.5 * TILE); // now tile (1,0)
assert(JSON.stringify(d1.anchor) === JSON.stringify({ tx: 1, tz: 0 }), "anchor after +x move wrong");
assert(d1.load.length === 2 * R + 1, `+x move should load one column (${2 * R + 1}), got ${d1.load.length}`);
assert(d1.unload.length === 2 * R + 1, `+x move should unload one column (${2 * R + 1}), got ${d1.unload.length}`);
assert(d1.load.every((t) => t.tx === 3), `loaded tiles should all be the new leading column tx=3, got ${JSON.stringify(d1.load)}`);
assert(d1.unload.every((t) => t.tx === -2), `unloaded tiles should all be the trailing column tx=-2, got ${JSON.stringify(d1.unload)}`);
assert(d1.resident.length === expectCount, `resident should stay ${expectCount} after a shift, got ${d1.resident.length}`);
// No gaps: resident set == desiredTiles centered on the new anchor.
const want1 = new Set(desiredTiles({ tx: 1, tz: 0 }, R).map((t) => tileKey(t.tx, t.tz)));
assert(want1.size === f.residentKeys().size && [...f.residentKeys()].every((k) => want1.has(k)), "post-shift resident set has gaps/extras");
// No thrash: the loaded and unloaded sets are disjoint.
const loadedKeys = new Set(d1.load.map((t) => tileKey(t.tx, t.tz)));
assert(d1.unload.every((t) => !loadedKeys.has(tileKey(t.tx, t.tz))), "a tile was both loaded and unloaded (thrash)");

// Staying in the same tile is a no-op (no thrash on jitter within a tile).
const d2 = f.update(1.9 * TILE, 0.1 * TILE); // still tile (1,0)
assert(!d2.changed && d2.load.length === 0 && d2.unload.length === 0, `same-tile jitter should be a no-op, got load=${d2.load.length} unload=${d2.unload.length}`);

// Diagonal move by one tile: a 5x5 block shifts by (1,1). New L-shaped frontier loads
// (a column + a row, minus the shared corner) and the opposite L unloads. Count check.
const d3 = f.update(2.5 * TILE, 1.5 * TILE); // tile (2,1) from (1,0)
const frontier = (2 * R + 1) + (2 * R + 1) - 1; // column + row - shared corner
assert(d3.load.length === frontier, `diagonal move should load an L of ${frontier}, got ${d3.load.length}`);
assert(d3.unload.length === frontier, `diagonal move should unload an L of ${frontier}, got ${d3.unload.length}`);
assert(d3.resident.length === expectCount, `resident should stay ${expectCount}, got ${d3.resident.length}`);

// Disc shape: a radius-2 disc (Euclidean tile-index, dtx^2+dtz^2 <= 4) keeps the
// center + 4 axials at dist 1 + 4 diagonals at dist 2 (<=4) + 4 axials at dist 2
// (==4) = 13 tiles; it drops the corners (dist^2=8) AND the corner-adjacent edges
// (dist^2=5). Proves the shape switch is a true circle, not a square.
const fd = new StreamFollower({ tileSize: TILE, radius: 2, shape: "disc" });
const dd = fd.update(0, 0);
assert(dd.resident.length === 13, `disc r=2 should be 13 tiles, got ${dd.resident.length}`);

ops.op_log(
  `p9_terrain_mesh OK: geometry ${NROWS}x${NCOLS} -> ${g.positions.length / 3} verts / ${tris} tris, ` +
  `vertex Y == origin.y+h*scaleY, corner XZ spans ${spanX}x${spanZ}, unit +y normals; ` +
  `DROP-TEST PARITY collider Y=${ray[3].toFixed(3)} == mesh Y=${meshY.toFixed(3)}; ` +
  `stream: 5x5 window, +x move loads/unloads one ${2 * R + 1}-tile column (no thrash/gaps), disc r=2=${dd.resident.length}.`,
);
