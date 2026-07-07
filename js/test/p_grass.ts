// p_grass — PAINT-DRIVEN GRASS gate (headless, pure math + THREE bookkeeping, no GPU).
//
// The terrain's paint channel (paintMat/paintW — terrain.paint strokes, map-rasterized biomes)
// now grows REAL instanced blades (render/grass-source.ts + terrain/grass-render.ts). This gate
// pins the contract:
//   1. DETERMINISM: placements are a pure function of (tile content, world lattice, seed) —
//      two computes are byte-identical, per-chunk recomputes equal the whole-tile compute
//      (the live brush-refresh correctness condition), and a different seed reshuffles.
//   2. DENSITY ∝ paintW: full-weight grass is ~2.5× denser than weight-0.4 grass; sand,
//      unpainted ground, underwater ground and steep faces get ZERO blades; exclusion discs
//      (the settlement-footprint seam) carve blades as a strict subset.
//   3. RENDER DISCIPLINE: chunked InstancedMeshes with REAL bounding spheres that contain
//      every instance (frustumCulled stays true — the p_scatter_culling rule, not the old
//      frustumCulled=false carpet). FALSIFIABLE: a deliberately shrunken sphere fails the
//      same containment check.
//   4. LIFECYCLE: the live paint brush refresh adds/removes exactly the stroked chunks; the
//      streamed manager grows ≤ budget tile-grasses per update, drops past radius+1, and
//      clear() returns the scene to zero grass meshes.
//   5. ZERO ENTITY GROWTH: authoring painted terrain through the skills adds exactly ONE
//      entity (the layer) — blades are scene-direct render state, never entities.

import { ops, EntityTable, type WorldContext } from "../src/engine.ts";
import { createEcsWorld } from "../src/ecs/world.ts";
import { createTransformStorage } from "../src/ecs/facade.ts";
import { UniformGridSpatialIndex } from "../src/spatial/index.ts";
import { SkillRegistry } from "../src/skills/registry.ts";
import { resolveProfile } from "../src/skills/permissions.ts";
import { LiminaTracer } from "../src/observability/event.ts";
import { registerTerrainEditSkills } from "../src/skills/terrain-edit.ts";
import {
  GRASS_PAINT_ID,
  grassChunkCoordsForTile,
  grassChunkKey,
  grassChunkPlacements,
  grassChunksForTile,
  type GrassSourceOptions,
} from "../src/render/grass-source.ts";
import { StreamedGrassManager, TileGrass } from "../src/terrain/grass-render.ts";
import type { TerrainTile } from "../src/terrain/types.ts";
import * as THREE from "../build/three.bundle.mjs";

function assert(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new Error("p_grass FAIL: " + msg);
}

// ── A synthetic painted tile: 120 m square, 65×65 nodes, centred on the origin. World-X bands:
//   x <  -20  FULL grass (w=1.0)
//   -20..20   HALF grass (w=0.4)
//   20..40    SAND (mat 1, w=1) — must stay bladeless
//   x >= 40   UNPAINTED — must stay bladeless
// World-Z relief (both grass bands cross it identically, so the X-band density ratio is clean):
//   z < -30   a CONTINUOUS steep ramp (rise/run = 2, wider than the slope probe — no one-row
//             cliff aliasing) → painted grass there must stay bladeless under slopeMax 0.9;
//             asserted on the band interior z < -31 (the rim row mixes ramp/flat legitimately).
//   z >= 40   a basin at −5 m, below elevationMin −1 → grass paint grows nothing; asserted on
//             the interior z ≥ 43 (the one transition row is a legitimate shoreline crest). ──
const N = 65;
function makeTile(): TerrainTile {
  const heights = new Float32Array(N * N);
  const paintMat = new Uint8Array(N * N);
  const paintW = new Float32Array(N * N);
  for (let r = 0; r < N; r++) {
    for (let c = 0; c < N; c++) {
      const x = -60 + (c / (N - 1)) * 120;
      const z = -60 + (r / (N - 1)) * 120;
      const i = r * N + c;
      let h = 0;
      if (z < -30) h = (z + 30) * -2; // steep ramp: slope 2 across the whole band
      else if (z >= 40) h = -5;       // basin below the waterline
      heights[i] = h;
      if (x < -20) { paintMat[i] = GRASS_PAINT_ID; paintW[i] = 1.0; }
      else if (x < 20) { paintMat[i] = GRASS_PAINT_ID; paintW[i] = 0.4; }
      else if (x < 40) { paintMat[i] = 1; paintW[i] = 1.0; }
      // else unpainted (0)
    }
  }
  return { nrows: N, ncols: N, origin: [0, 0, 0], scale: [120, 1, 120], heights, paintMat, paintW };
}

const OPTS: GrassSourceOptions = { seed: 42, elevationMin: -1, slopeMax: 0.9 };
const tile = makeTile();

// ── 1. Determinism ───────────────────────────────────────────────────────────────────────────
const runA = grassChunksForTile(tile, OPTS);
const runB = grassChunksForTile(tile, OPTS);
assert(runA.size > 0, "the painted tile must grow at least one grass chunk");
assert(JSON.stringify([...runA]) === JSON.stringify([...runB]), "same (tile, seed) must be byte-identical");
// Per-chunk recompute (the live brush path) must equal the whole-tile compute chunk-for-chunk.
for (const { cx, cz } of grassChunkCoordsForTile(tile, OPTS.chunkSize)) {
  const solo = grassChunkPlacements(tile, cx, cz, OPTS);
  const fromMap = runA.get(grassChunkKey(cx, cz)) ?? [];
  assert(JSON.stringify(solo) === JSON.stringify(fromMap), `chunk (${cx},${cz}) recompute must equal the whole-tile compute`);
}
const runSeed2 = grassChunksForTile(tile, { ...OPTS, seed: 43 });
assert(JSON.stringify([...runA]) !== JSON.stringify([...runSeed2]), "a different seed must reshuffle placements");

// ── 2. Density ∝ paintW + hard zeros ─────────────────────────────────────────────────────────
let full = 0, half = 0, sand = 0, bare = 0, wet = 0, steep = 0;
for (const placements of runA.values()) {
  for (const p of placements) {
    assert(p.y > -1, `blade below the waterline at (${p.x.toFixed(1)}, ${p.z.toFixed(1)})`);
    if (p.z >= 43) wet++;
    else if (p.z < -31) steep++;
    else if (p.x < -21) full++;      // 1 m margin off the paint borders (bilinear feather)
    else if (p.x >= -19 && p.x < 19) half++;
    else if (p.x >= 21 && p.x < 39) sand++;
    else if (p.x >= 41 && p.z < 39) bare++;
  }
}
assert(wet === 0, `underwater grass paint must grow nothing (got ${wet})`);
assert(steep === 0, `steep painted faces must grow nothing (got ${steep})`);
assert(sand === 0, `sand paint must grow nothing (got ${sand})`);
assert(bare === 0, `unpainted ground must grow nothing (got ${bare})`);
assert(full > 500, `full-weight band too sparse (${full})`);
// Bands have different areas; compare per-area density. full band ≈ 40 m × 120 m minus the
// steep/wet rows; half band ≈ 40 m × 120 m the same — the z-carveouts hit both equally, so the
// raw count ratio tracks paintW directly.
const ratio = half / full;
assert(Math.abs(ratio - 0.4) < 0.08, `density must track paintW (want ≈0.4, got ${ratio.toFixed(3)})`);

// Exclusion discs carve a strict subset.
const excl = { x: -40, z: 20, r: 10 };
const carved = grassChunksForTile(tile, { ...OPTS, exclusions: [excl] });
let carvedCount = 0, keptOutside = 0;
const allCarved = new Set<string>();
for (const placements of carved.values()) {
  for (const p of placements) {
    const dx = p.x - excl.x, dz = p.z - excl.z;
    assert(dx * dx + dz * dz > excl.r * excl.r, "no blade may survive inside an exclusion disc");
    allCarved.add(`${p.x},${p.z}`);
    carvedCount++;
  }
}
for (const placements of runA.values()) {
  for (const p of placements) {
    const dx = p.x - excl.x, dz = p.z - excl.z;
    if (dx * dx + dz * dz > excl.r * excl.r) {
      keptOutside++;
      assert(allCarved.has(`${p.x},${p.z}`), "exclusion must be a pure filter (survivors byte-identical)");
    }
  }
}
assert(carvedCount === keptOutside, "exclusion must remove exactly the in-disc blades");
assert(carvedCount < full + half, "the exclusion disc must actually remove blades");

// ── 3. Render discipline: chunks, real bounding spheres, frustumCulled true ─────────────────
type SceneStub = { added: Set<unknown>; add(o: unknown): void; remove(o: unknown): void };
const makeScene = (): SceneStub => ({
  added: new Set<unknown>(),
  add(o: unknown) { this.added.add(o); },
  remove(o: unknown) { this.added.delete(o); },
});
const scene = makeScene();
let totalA = 0;
for (const placements of runA.values()) totalA += placements.length;
const grass = new TileGrass(scene, tile, () => OPTS);
assert(grass.chunkCount() > 4, `expected several chunks over the painted bands (got ${grass.chunkCount()})`);
assert(grass.bladeCount() === totalA, `mounted blades (${grass.bladeCount()}) must equal the pure compute (${totalA})`);
assert(scene.added.size === grass.chunkCount(), "every chunk mesh must be scene-mounted");
const m4 = new THREE.Matrix4();
const v = new THREE.Vector3();
let containViolationsWhenShrunk = 0;
for (const mesh of grass.chunkMeshes()) {
  assert(mesh.frustumCulled === true, "grass chunks must stay frustum-culled (no frustumCulled=false carpet)");
  const bs = mesh.boundingSphere;
  assert(bs !== null, "chunk must carry a computed bounding sphere");
  for (let i = 0; i < mesh.count; i++) {
    mesh.getMatrixAt(i, m4);
    v.setFromMatrixPosition(m4);
    const d = v.distanceTo(bs.center);
    assert(d <= bs.radius, `instance ${i} outside its chunk bounding sphere (d=${d.toFixed(2)} r=${bs.radius.toFixed(2)})`);
    if (d > bs.radius / 8) containViolationsWhenShrunk++;
  }
}
// FALSIFIABILITY: the containment check has teeth — an origin-only/shrunken sphere would fail.
assert(containViolationsWhenShrunk > 0, "shrunken-sphere probe found no violation — the containment check is vacuous");

// ── 4a. Live brush refresh: paint grass onto the UNPAINTED band, refresh, blades appear; erase,
//        refresh, blades gone. Mirrors terrain.paint's applyBrushPaint footprint. ─────────────
const beforeChunks = grass.chunkCount();
{
  const f = { x0: -60, z0: -60, d: 120 / (N - 1) };
  const stamp = (mat: number, w: number): void => {
    for (let r = 0; r < N; r++) {
      for (let c = 0; c < N; c++) {
        const x = f.x0 + c * f.d, z = f.z0 + r * f.d;
        const dx = x - 50, dz = z - 10;
        if (dx * dx + dz * dz <= 8 * 8) { tile.paintMat![r * N + c] = mat; tile.paintW![r * N + c] = w; }
      }
    }
  };
  stamp(GRASS_PAINT_ID, 1.0);
  grass.refreshCircle(50, 10, 8 + 3);
  assert(grass.chunkCount() > beforeChunks, "painting grass on bare ground + refresh must mount new chunks");
  const afterPaint = grass.bladeCount();
  assert(afterPaint > totalA, "the painted disc must add blades");
  stamp(0, 0);
  grass.refreshCircle(50, 10, 8 + 3);
  assert(grass.chunkCount() === beforeChunks, "erasing the disc + refresh must unmount its chunks");
  assert(grass.bladeCount() === totalA, "erase must restore the pre-stamp blade count exactly");
}
grass.dispose();
assert(scene.added.size === 0, "dispose must remove every chunk mesh from the scene");

// ── 4b. Streamed manager: budgeted grow, radius drop, clean teardown ─────────────────────────
{
  const s = makeScene();
  const TILE = 48, TN = 33;
  const makeStreamTile = (tx: number, tz: number): TerrainTile => {
    const heights = new Float32Array(TN * TN);
    const paintMat = new Uint8Array(TN * TN).fill(GRASS_PAINT_ID);
    const paintW = new Float32Array(TN * TN).fill(0.8);
    return { nrows: TN, ncols: TN, origin: [tx * TILE + TILE / 2, 0, tz * TILE + TILE / 2], scale: [TILE, 1, TILE], heights, paintMat, paintW };
  };
  const mgr = new StreamedGrassManager(s, { tileSize: TILE, radius: 1, budget: 1, source: () => ({ seed: 7, spacing: 2 }) });
  for (let tz = -2; tz <= 2; tz++) for (let tx = -2; tx <= 2; tx++) mgr.noteTile(`${tx}:${tz}`, { tx, tz }, makeStreamTile(tx, tz));
  const u1 = mgr.update(TILE / 2, TILE / 2); // camera in tile (0,0)
  assert(u1.grown === 1, `budget 1 must grow exactly one tile-grass per update (got ${u1.grown})`);
  assert(mgr.grassKeys().has("0:0"), "nearest tile (the camera tile) must grow first");
  for (let i = 0; i < 20; i++) mgr.update(TILE / 2, TILE / 2);
  assert(mgr.grassKeys().size === 9, `radius 1 must cap growth at the 3×3 window (got ${mgr.grassKeys().size})`);
  assert(mgr.bladeCount() > 0, "streamed grass must actually place blades");
  // Teleport far: everything past radius+1 drops (immediately, unbudgeted).
  const u2 = mgr.update(TILE * 10, TILE * 10);
  assert(u2.dropped === 9, `teleport must drop all 9 grown tile-grasses (got ${u2.dropped})`);
  // Tiles the stream unmounts lose their grass instantly.
  for (let i = 0; i < 20; i++) mgr.update(TILE / 2, TILE / 2);
  mgr.dropTile("0:0");
  assert(!mgr.grassKeys().has("0:0"), "dropTile must dispose that tile's grass");
  mgr.clear();
  assert(s.added.size === 0, "clear() must return the scene to zero grass meshes");
}

// ── 5. Zero entity growth through the SKILL path (headless authoring context) ────────────────
{
  const ecs = createEcsWorld();
  const stub = { add() {}, remove() {}, position: { set() {}, x: 0, y: 0, z: 0 }, background: null as unknown };
  const camera = { position: { set() {} }, aspect: 1, lookAt() {}, updateProjectionMatrix() {} };
  const world: WorldContext = {
    ecs, transforms: createTransformStorage(ecs), spatial: new UniformGridSpatialIndex(),
    entities: new EntityTable(), tags: new Map(), scene: stub, camera, ops, mode: "headless",
  };
  const registry = new SkillRegistry(new LiminaTracer("ses_p_grass"));
  registerTerrainEditSkills(registry, new Map());
  const perms = resolveProfile("builder.readWrite");
  const at = (t: number) => ({ agentId: "a", sessionId: "ses_p_grass", permissions: perms, tick: t, world });
  await registry.invoke("terrain.create", { size: 100, resolution: 33 }, at(1));
  await registry.invoke("terrain.paint", { center: [0, 0], radius: 30, strength: 1, material: "grass" }, at(2));
  await registry.invoke("terrain.paint", { center: [10, 10], radius: 20, strength: 1, material: "grass" }, at(3));
  assert([...world.entities.ids()].length === 1, "painted grass must add ZERO entities beyond the terrain layer");
}

ops.op_log(
  "[js] p_grass OK: paint-driven grass placements are deterministic + chunk-stable (brush-refresh == whole-tile), density tracks paintW with hard zeros on sand/unpainted/underwater/steep + exclusion-disc subsets; chunked InstancedMeshes keep REAL bounding spheres (falsifiably containing every blade) with frustumCulled true; the live brush refresh and the budgeted streamed manager mount/unmount cleanly; zero entity growth.",
);
