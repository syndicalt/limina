// Phase 9.1 — deterministic prop scatter (headless). Props are a pure function of
// (seed, tile); they sit ON the terrain surface (verified against the heightfield
// COLLIDER, not the same code that placed them); and placement reads the terrain
// SHAPE (steep -> rocks, flat -> trees/grass).

import { ops } from "../src/engine.ts";
import { ProceduralTerrainSource } from "../src/terrain/procedural.ts";
import { PropKind, scatterProps, type PropInstance } from "../src/terrain/scatter.ts";
import type { TerrainTile } from "../src/terrain/types.ts";

function assert(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new Error("p9_scatter FAIL: " + msg);
}

const src = new ProceduralTerrainSource();
const SEED = 7;
const tile = src.generateTile({ seed: SEED, tx: 2, tz: -1, lod: 0 });

// 1. Determinism: identical (tile, seed) -> byte-identical props; a different seed differs.
const a = scatterProps(tile, SEED);
const b = scatterProps(tile, SEED);
assert(a.length > 0 && a.length === b.length, `expected deterministic non-empty props (${a.length} vs ${b.length})`);
for (let i = 0; i < a.length; i++) {
  for (const k of ["kind", "x", "y", "z", "yaw", "scale"] as (keyof PropInstance)[]) {
    assert(Object.is(a[i][k], b[i][k]), `non-deterministic prop ${i}.${String(k)}`);
  }
}
const c = scatterProps(tile, SEED + 1);
let differs = c.length !== a.length;
if (!differs) for (let i = 0; i < a.length; i++) { if (!Object.is(a[i].x, c[i].x) || !Object.is(a[i].y, c[i].y)) { differs = true; break; } }
assert(differs, "a different seed produced identical props");

// 2. On-surface (drop parity): build the tile's heightfield COLLIDER and raycast down
// at a sample of props -> prop.y matches the collider surface (a prop stands where a
// body would rest). Tolerance covers bilinear-vs-triangulation, not floating/sinking.
ops.op_physics_create_world(-9.81);
const hId = ops.op_physics_add_heightfield(
  tile.origin[0], tile.origin[1], tile.origin[2],
  tile.nrows, tile.ncols, tile.scale[0], tile.scale[1], tile.scale[2], tile.heights,
);
ops.op_physics_step(); // build the broad-phase so the query ray can hit
const ray = new Float32Array(6);
let checked = 0;
const stride = Math.max(1, Math.floor(a.length / 14));
for (let i = 0; i < a.length && checked < 14; i += stride) {
  const p = a[i];
  ops.op_physics_raycast(p.x, p.y + 60, p.z, 0, -1, 0, 120, ray);
  if (ray[0] === 1 && ray[5] === hId) {
    assert(Math.abs(ray[3] - p.y) < 0.2, `prop ${i} off-surface: prop.y=${p.y.toFixed(3)} collider=${ray[3].toFixed(3)}`);
    checked++;
  }
}
assert(checked >= 6, `expected to surface-check several props against the collider, only ${checked}`);

// 3. Slope response: a steep tile yields rocks; a flat tile yields trees/grass.
function synthTile(fn: (r: number, col: number) => number): TerrainTile {
  const N = 33;
  const heights = new Float32Array(N * N);
  for (let r = 0; r < N; r++) for (let col = 0; col < N; col++) heights[r * N + col] = fn(r, col);
  return { nrows: N, ncols: N, origin: [0, 0, 0], scale: [48, 12, 48], heights };
}
const flat = scatterProps(synthTile(() => 0.5), 3);
const steep = scatterProps(synthTile((_r, col) => col * 0.2), 3); // steep ramp
const rocks = (ps: PropInstance[]): number => ps.filter((p) => p.kind === PropKind.Rock).length;
const greens = (ps: PropInstance[]): number => ps.filter((p) => p.kind === PropKind.Tree || p.kind === PropKind.Grass).length;
assert(rocks(flat) === 0, `flat terrain should grow no rocks, got ${rocks(flat)}`);
assert(rocks(steep) >= 8, `steep terrain should be rocky, only ${rocks(steep)} rocks`);
assert(greens(flat) > greens(steep), `flat terrain should be greener (${greens(flat)}) than steep (${greens(steep)})`);

ops.op_log(`p9_scatter OK: ${a.length} props deterministic + seed-sensitive; ${checked} surface-checked against the heightfield collider (on-surface); slope reads shape (steep ${rocks(steep)} rocks / flat ${greens(flat)} green).`);
