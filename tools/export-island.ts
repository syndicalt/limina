// EXPORT GENERATOR — bakes the flagship "textured island" demo (the SAME world as
// js/src/demos/default_world_window.ts: SEED=1234, mountains, 4×4 island) into a
// portable, browser-loadable EXPORT BUNDLE for the marketing site's live /examples
// playback. Headless + RECORDED: it replays nothing, it RECORDS the three skill
// calls (world.generateRegion auto-surface + world.addWater + world.populateBiome)
// plus the baked terrain TILES and the scatter ASSET bytes (pine/broadleaf/rock GLBs)
// so the browser rebuilds the island from the package alone — no host asset root.
//
// The island has no dynamic bodies, so keyframes are EMPTY (playback is camera-driven).
//
// RUN (regenerate the bundle on disk):
//   ./target/release/limina tools/export-island.ts | node tools/write-island-bundle.mjs
// The limina script emits the bundle JSON between markers; the node writer persists
// the files to site/public/examples/island/. Verified headlessly: loadExport round-trips.

import * as THREE from "../js/build/three.bundle.mjs";
import { EntityTable, ops, type EngineOps } from "../js/src/engine.ts";
import { createEcsWorld } from "../js/src/ecs/world.ts";
import { createTransformStorage } from "../js/src/ecs/facade.ts";
import { UniformGridSpatialIndex } from "../js/src/spatial/index.ts";
import { LiminaTracer } from "../js/src/observability/event.ts";
import { SkillRegistry, type WorldContext } from "../js/src/skills/registry.ts";
import { registerCoreSkills } from "../js/src/skills/index.ts";
import { resolveProfile } from "../js/src/skills/permissions.ts";
import { WorldRecorder } from "../js/src/worldlog/recorder.ts";
import { assembleExport, loadExport } from "../js/src/export/package.ts";
import { TILE_SIZE } from "../js/src/terrain/procedural.ts";
import { terrainTypeHints, type TerrainTypeName } from "../js/src/terrain/terrain-types.ts";
import { MATERIALS } from "../js/src/materials/palette.ts";
import { scatterAssets } from "../js/src/terrain/asset-scatter.ts";
import { biomeScatterConfigs } from "../js/src/terrain/biome-content.ts";
import type { TerrainTile } from "../js/src/terrain/types.ts";

function assert(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new Error("export-island FAIL: " + msg);
}

// ── THE WORLD — identical to default_world_window.ts ────────────────────────────
const SEED = 1234;
const TYPE: TerrainTypeName = "mountains";
const BOUNDS = { minTx: 0, minTz: 0, maxTx: 3, maxTz: 3 } as const;
const HALF_EXTENT = (Math.min(BOUNDS.maxTx - BOUNDS.minTx, BOUNDS.maxTz - BOUNDS.minTz) + 1) * TILE_SIZE / 2;
const HINTS = {
  ...terrainTypeHints(TYPE, BOUNDS),
  amp: 4.5,
  erode: 1,
  islandCx: ((BOUNDS.minTx + BOUNDS.maxTx + 1) / 2) * TILE_SIZE,
  islandCz: ((BOUNDS.minTz + BOUNDS.maxTz + 1) / 2) * TILE_SIZE,
  islandRadius: HALF_EXTENT * 0.40,
  islandFalloff: HALF_EXTENT * 0.62,
};

// Warm THREE's lazy init on the DEFAULT rng before the seeded rng is installed, so
// the recorded run and any later replay draw the same seeded stream (mirrors p8).
void new THREE.Mesh(new THREE.SphereGeometry(0.5, 24, 16), new THREE.MeshStandardNodeMaterial({ color: 0x808080 }));
void new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardNodeMaterial({ color: 0x808080 }));

function makeWorld(worldOps: EngineOps, scene: unknown): WorldContext {
  const camera = { position: { set() {} }, aspect: 1, lookAt() {}, updateProjectionMatrix() {} };
  const ecs = createEcsWorld();
  return {
    ecs, transforms: createTransformStorage(ecs), spatial: new UniformGridSpatialIndex(),
    entities: new EntityTable(), tags: new Map(), scene: scene as WorldContext["scene"],
    camera: camera as WorldContext["camera"], ops: worldOps, mode: "headless",
  };
}

const scene = new THREE.Scene();
const tracer = new LiminaTracer("ses_export_island");
const registry = new SkillRegistry(tracer);
const core = registerCoreSkills(registry);
const recorder = new WorldRecorder("ses_export_island");
recorder.attach(registry);
recorder.seed(SEED); // deterministic PRNG seed -> recorded so replay reinstalls it
const recOps = recorder.wrapOps(ops);
const world = makeWorld(recOps, scene);
const base = { agentId: "agt_export_island", sessionId: "ses_export_island", permissions: resolveProfile("builder.readWrite"), tick: 0, world };

// Recorded so a replay recreates the physics world before re-applying the tiles.
recOps.op_physics_create_world(-9.81);

// 1. GROUND + SURFACE (auto-surface): colliders + the visible procedural-PBR mesh.
const gen = await registry.invoke("world.generateRegion", {
  seed: SEED, bounds: BOUNDS, lod: 0, type: TYPE, hints: HINTS,
  surface: { mode: "pbr", seaFraction: 0.18, waterline: { wetBand: 1.4, foam: 0.5 } },
}, base);
assert(gen.success, "world.generateRegion failed: " + JSON.stringify(gen.error));
const { regionId, seaLevel, relief } = gen.result as { regionId: string; seaLevel: number; relief: { minY: number; maxY: number } };

// 2. SEA: a depth-aware water plane at the resolved sea level.
const span = (BOUNDS.maxTx - BOUNDS.minTx + 1) * TILE_SIZE;
const water = await registry.invoke("world.addWater", {
  level: seaLevel, color: MATERIALS.water.color, size: span * 3,
  region: { seed: SEED, type: TYPE, bounds: BOUNDS, hints: HINTS },
}, base);
assert(water.success, "world.addWater failed: " + JSON.stringify(water.error));

// 3. CONTENT: biome-correct scatter (pines + boulders, gated to the dry slopes).
const pop = await registry.invoke("world.populateBiome", {
  regionId, type: TYPE, waterLevel: seaLevel, waterMargin: 2.5,
}, base);
assert(pop.success, "world.populateBiome failed: " + JSON.stringify(pop.error));
const props = (pop.result as { instances: number }).instances;

// ── ASSEMBLE the portable export (no keyframes — the island is static) ───────────
const tileEntries = core.terrain.cache.entries();
const assetBundle = core.assets.bundle();
const files = assembleExport({
  worldId: "limina-island",
  meta: recorder.meta(),
  commands: recorder.commands,
  keyframes: [],
  keyframeInterval: 20,
  createdAt: "2026-01-01T00:00:00Z",
  tiles: tileEntries,
  assets: assetBundle,
});
assert(files["tiles.jsonl"].length > 0, "region tiles did not ride the export");
assert(files["assets.jsonl"].length > 0, "scatter asset bytes did not ride the export");

// ── VERIFY: loadExport round-trips (the exact files a browser reads back) ────────
const loaded = loadExport(files, ops);
assert(loaded.manifest.kind === "limina.export", "manifest kind wrong");
assert(loaded.manifest.exportVersion === 1, "manifest exportVersion wrong");
assert(loaded.commands.length === recorder.commands.length, "command count lost on round-trip");
assert(loaded.keyframes.length === 0, "expected zero keyframes (static island)");
assert(loaded.tiles.length === tileEntries.length, "tile count lost on round-trip");
assert(loaded.assets.length === assetBundle.length, "asset count lost on round-trip");

// ── PARITY ASSERTION: the user-visible contract — no tree floats more than X m above ground ─
// Re-runs the SAME biome-content scatter the live demo replays over the bundle's BAKED tiles.
// For every placed instance, measures the user-visible float (foliage base ABOVE the lowest mesh
// vertex in the footprint disc) — the exact symptom the curvature-aware + GLB-normalization
// fixes target. After both fixes the avg is ~0.25 m, max ~1.0 m (measured). The threshold of
// 1.5 m admits the inherent Y-only residual on steep slopes (r·slope/2 skirt float) while
// catching any regression that brings back the multi-metre float the demo exhibited before
// (1.4–1.8 m avg, 4 m+ max). Hard-fails the export if violated.
//
// Note: the GLB-normalization fix (asset-scatter-render.ts) recentres each asset so base_Y=0
// and XZ=(0,0); this assertion reads the placement Y (inst.y) directly, which after the fix is
// where the foliage base actually renders. If a future GLB edit re-introduces an asset offset,
// inst.y no longer reflects the rendered base Y and this assertion will catch it via the
// resulting large float.
const PARITY_MAX_FLOAT = 1.5; // m; regression gate (current max ≈ 1.0 m, budget for terrain variance)
const PARITY_AVG_FLOAT = 0.6; // m; avg gate (current avg ≈ 0.25 m)
const survey = { minY: relief.minY, maxY: relief.maxY };
const parityConfigs = biomeScatterConfigs(TYPE, survey, seaLevel, 2.5);
// Independent bilinear height query (mirrors scatterAssets.sampleRaw in WORLD space — a
// falsifiable re-sample, not the same call the placement used).
const bilinear = (tile: TerrainTile, x: number, z: number): number => {
  const { nrows, ncols, heights, origin, scale } = tile;
  const [ox, oy, oz] = origin, [sx, sy, sz] = scale;
  const u = (x - (ox - sx / 2)) / sx;
  const v = (z - (oz - sz / 2)) / sz;
  const fc = Math.min(ncols - 1, Math.max(0, u * (ncols - 1)));
  const fr = Math.min(nrows - 1, Math.max(0, v * (nrows - 1)));
  const r0 = Math.min(nrows - 1, Math.floor(fr)), c0 = Math.min(ncols - 1, Math.floor(fc));
  const r1 = Math.min(nrows - 1, r0 + 1), c1 = Math.min(ncols - 1, c0 + 1);
  const tr = fr - r0, tc = fc - c0;
  const h = (r: number, c: number): number => heights[r * ncols + c];
  const top = h(r0, c0) * (1 - tc) + h(r0, c1) * tc;
  const bot = h(r1, c0) * (1 - tc) + h(r1, c1) * tc;
  return oy + (top * (1 - tr) + bot * tr) * sy;
};
// Min height over a dense k×k grid sampled across a disc of radius `disc` around (x, z).
const discMin = (tile: TerrainTile, x: number, z: number, disc: number, k = 5): number => {
  let yMin = Infinity;
  for (let i = 0; i < k; i++) {
    for (let j = 0; j < k; j++) {
      const dx = -disc + (2 * disc) * (i + 0.5) / k;
      const dz = -disc + (2 * disc) * (j + 0.5) / k;
      if (dx * dx + dz * dz > disc * disc) continue;
      const y = bilinear(tile, x + dx, z + dz);
      if (y < yMin) yMin = y;
    }
  }
  return yMin;
};
let parityChecked = 0;
let maxFloat = 0, sumFloat = 0;
let maxBury = 0, sumBury = 0;
for (const { tile } of loaded.tiles) {
  for (const cfg of parityConfigs) {
    const layerHasEmbed = (cfg.embedRadius ?? 0) > 0 || cfg.assets.some((a) => (a.embedRadius ?? 0) > 0);
    if (!layerHasEmbed) continue;
    const placements = scatterAssets(tile, SEED, cfg);
    for (const inst of placements) {
      const picked = cfg.assets.find((a) => a.id === inst.assetId);
      const r = ((picked?.embedRadius ?? cfg.embedRadius) ?? 0) * inst.scale;
      if (r === 0) continue;
      // Post-fix #1 the rendered position equals the nominal (GLB normalized to base_Y=0,
      // XZ=0), so the user-visible float/bury is what we measure here against the nominal
      // footprint disc.
      const dmin = discMin(tile, inst.x, inst.z, r, 5);
      const dmax = (() => { let y = -Infinity; for (let i = 0; i < 5; i++) for (let j = 0; j < 5; j++) { const dx = -r + (2*r)*(i+0.5)/5, dz = -r + (2*r)*(j+0.5)/5; if (dx*dx + dz*dz > r*r) continue; const yy = bilinear(tile, inst.x+dx, inst.z+dz); if (yy > y) y = yy; } return y; })();
      const float = inst.y - dmin;
      const bury = dmax - inst.y;
      if (float > maxFloat) maxFloat = float;
      if (bury > maxBury) maxBury = bury;
      sumFloat += Math.max(0, float);
      sumBury += Math.max(0, bury);
      parityChecked++;
    }
  }
}
assert(parityChecked > 0, "island parity assertion is vacuous — no embedded placements re-sampled");
const avgFloat = sumFloat / parityChecked;
const avgBury = sumBury / parityChecked;
assert(maxFloat <= PARITY_MAX_FLOAT, `island scatter FLOAT: max ${maxFloat.toFixed(3)} m > ${PARITY_MAX_FLOAT} m threshold (regression — pre-fix demo exhibited 4 m+ max float)`);
assert(avgFloat <= PARITY_AVG_FLOAT, `island scatter FLOAT: avg ${avgFloat.toFixed(3)} m > ${PARITY_AVG_FLOAT} m threshold (regression — pre-fix demo exhibited 1.4–1.8 m avg float)`);
console.log(`EXPORT PARITY: ${parityChecked} placements, float avg ${avgFloat.toFixed(3)} m / max ${maxFloat.toFixed(3)} m, bury avg ${avgBury.toFixed(3)} m / max ${maxBury.toFixed(3)} m`);

// Camera framing for the live page (deterministic from the world geometry). The
// island is centered at (islandCx, _, islandCz); frame it like the windowed demo.
const cx = HINTS.islandCx;
const cz = HINTS.islandCz;
const cy = seaLevel + (relief.maxY - seaLevel) * 0.45;
const view = {
  center: [cx, cy, cz],
  radius: Math.round(span * 0.85),
  height: Math.round((relief.maxY - seaLevel) * 0.9 + 6),
  maxRadius: Math.round(span * 1.6),
  maxHeight: Math.round(relief.maxY - seaLevel + span * 0.4),
  far: Math.round(span * 6),
  seaLevel, relief,
};

console.log(`EXPORT OK: ${loaded.commands.length} commands, ${loaded.keyframes.length} keyframes, ${loaded.tiles.length} tiles, ${loaded.assets.length} assets (${props} props, sea ${seaLevel.toFixed(1)}m, relief ${relief.minY.toFixed(1)}..${relief.maxY.toFixed(1)}m)`);

// Emit the bundle (+ the recommended camera view) for the node writer to persist.
console.log("===LIMINA_BUNDLE_BEGIN===");
console.log(JSON.stringify({ files, view }));
console.log("===LIMINA_BUNDLE_END===");
