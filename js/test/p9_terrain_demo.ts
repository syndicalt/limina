// Phase 9 terrain DEMO data path (headless): the exact getTile->mesh path the
// browser demo runs — ProceduralTerrainSource.generateTile -> terrainTileGeometry —
// produces valid, finite, deterministic geometry. (The in-tab WebGPU render is UAT;
// this proves the data feeding it is sound.)

import { ops } from "../src/engine.ts";
import { ProceduralTerrainSource } from "../src/terrain/procedural.ts";
import { terrainTileGeometry } from "../src/terrain/mesh.ts";

function assert(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new Error("p9_terrain_demo FAIL: " + msg);
}

const src = new ProceduralTerrainSource();
const SEED = 1337;
let totalVerts = 0;
for (const [tx, tz] of [[0, 0], [1, 0], [0, 1], [-1, -2], [3, -3]]) {
  const tile = src.generateTile({ seed: SEED, tx, tz, lod: 0 });
  const g = terrainTileGeometry(tile);
  const vcount = tile.nrows * tile.ncols;
  assert(g.positions.length === vcount * 3, `tile ${tx},${tz}: vertex count ${g.positions.length} != ${vcount * 3}`);
  assert(g.indices.length === (tile.nrows - 1) * (tile.ncols - 1) * 6, `tile ${tx},${tz}: index count wrong`);
  assert(g.positions.every(Number.isFinite), `tile ${tx},${tz}: non-finite vertex`);
  assert(g.normals.every(Number.isFinite), `tile ${tx},${tz}: non-finite normal`);
  // Determinism: the same request regenerates byte-identical geometry (a streamed
  // tile that loads, unloads, and reloads must look identical).
  const g2 = terrainTileGeometry(src.generateTile({ seed: SEED, tx, tz, lod: 0 }));
  for (let i = 0; i < g.positions.length; i++) {
    assert(Object.is(g.positions[i], g2.positions[i]), `tile ${tx},${tz}: non-deterministic geometry at ${i}`);
  }
  totalVerts += vcount;
}

ops.op_log(`p9_terrain_demo OK: ProceduralTerrainSource -> terrainTileGeometry over 5 tiles (${totalVerts} verts) — finite + deterministic; the demo's getTile->mesh path is sound (render is UAT).`);
