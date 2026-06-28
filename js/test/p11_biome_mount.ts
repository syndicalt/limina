// Phase 11 GATE — the REAL MOUNT path of biome content (the gap that let "only rocks,
// no pines" through). p11_biome_content §7 checks the PURE scatter count; this test
// exercises the ACTUAL render-mount path the landscape demo runs:
//
//   world.generateRegion(mountains, amp 4.5, erode) → scatterBiomeContent(regions, …)
//     → asset.scatter → buildAssetInstancedMeshes → scene.add(InstancedMesh)
//
// Falsifiable, headless:
//   1. EVERY expected asset MOUNTS with instances > 0 — pine AND rock both reach the
//      scene as InstancedMeshes carrying real instance counts (not just placements).
//   2. A MULTI-MESH asset mounts ALL its renderable sub-meshes — pine.glb is 2 meshes
//      (foliage + trunk), so the pine layer mounts 2 InstancedMeshes; broadleaf.glb is
//      also 2 meshes (forest type). A dropped sub-mesh fails here.
//   3. PINES DOMINATE boulders on the landscape config (a forested lower mountain), not
//      the reverse — the demo's whole point.
//   4. THE ROOT CAUSE IS PINNED: surveying with the region's ACTUAL generated hints
//      (amp/erode) is load-bearing. Re-running WITHOUT the region table (bare type-default
//      hints) collapses the pine count — the exact divergence that produced the bug.
//   5. NO PROPS IN WATER: over the demo's real config (island falloff + sea + a 2.5 m dry
//      margin) ZERO mounted prop instances (pine AND rock, all layers) sit at/below waterLevel +
//      margin — inland lakes included. Via the real mount path. Falsifiable: the ungated palette
//      DOES place below water. The test config == the demo's SHAPE (no test/demo divergence).

import { TILE_SIZE } from "../src/terrain/procedural.ts";
import { terrainTypeHints, type RegionBounds } from "../src/terrain/terrain-types.ts";
import {
  scatterBiomeContent, biomeScatterConfigs, surveyRegionRelief,
  PINE_ASSET, BROADLEAF_ASSET, ROCK_ASSET, BIOME_CONTENT,
} from "../src/terrain/biome-content.ts";
import * as THREE from "../build/three.bundle.mjs";
import { EntityTable, ops } from "../src/engine.ts";
import { createEcsWorld } from "../src/ecs/world.ts";
import { createTransformStorage } from "../src/ecs/facade.ts";
import { UniformGridSpatialIndex } from "../src/spatial/index.ts";
import { SkillRegistry, type WorldContext } from "../src/skills/registry.ts";
import { registerCoreSkills } from "../src/skills/index.ts";
import { resolveProfile } from "../src/skills/permissions.ts";
import { LiminaTracer } from "../src/observability/event.ts";
import type { MCPResponse } from "../src/mcp/protocol.ts";

function assert(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new Error("p11_biome_mount FAIL: " + msg);
}
function ok(res: MCPResponse | undefined): Record<string, unknown> {
  if (res === undefined || !res.success) throw new Error("call failed: " + JSON.stringify(res?.error));
  return res.result as Record<string, unknown>;
}

// The EXACT landscape demo config (js/src/demos/landscape_window.ts): mountains, amp 4.5, erosion,
// a coastal ISLAND falloff (tapers the region boundary below sea level so the grid-termination wall
// is hidden underwater + the coast reads clean), sea at 18% of relief, and a 2.5 m dry shoreline
// margin. This MUST mirror the demo's SHAPE — the test/demo divergence is the meta-bug, so the two
// configs are kept identical (same falloff knobs, same margin), routed through the region-hints path.
const SEED = 1234;
const TYPE = "mountains" as const;
const BOUNDS: RegionBounds = { minTx: 0, minTz: 0, maxTx: 3, maxTz: 3 };
const AMP = 4.5;
const SEA_FRACTION = 0.18;
const WATER_MARGIN = 2.5;
const HALF_EXTENT = (Math.min(BOUNDS.maxTx - BOUNDS.minTx, BOUNDS.maxTz - BOUNDS.minTz) + 1) * TILE_SIZE / 2;
const ISLAND = {
  islandCx: ((BOUNDS.minTx + BOUNDS.maxTx + 1) / 2) * TILE_SIZE,
  islandCz: ((BOUNDS.minTz + BOUNDS.maxTz + 1) / 2) * TILE_SIZE,
  islandRadius: HALF_EXTENT * 0.40,
  islandFalloff: HALF_EXTENT * 0.62,
};
const SHAPE = { amp: AMP, erode: 1, ...ISLAND };
const HINTS = { ...terrainTypeHints(TYPE, BOUNDS), ...SHAPE };

// A headless world whose scene.add CAPTURES the mounted objects so we can inspect the
// real InstancedMeshes (geometry + per-mesh instance count), not just the skill's tallies.
function makeCapturingWorld(): { world: WorldContext; added: unknown[] } {
  const ecs = createEcsWorld();
  const added: unknown[] = [];
  const scene = { add(o: unknown) { added.push(o); }, remove() {}, position: { set() {}, x: 0, y: 0, z: 0 }, background: null as unknown };
  const camera = { position: { set() {} }, aspect: 1, lookAt() {}, updateProjectionMatrix() {} };
  return {
    world: { ecs, transforms: createTransformStorage(ecs), spatial: new UniformGridSpatialIndex(), entities: new EntityTable(), tags: new Map(), scene, camera, ops, mode: "headless" },
    added,
  };
}

async function runDemoScatter(passRegions: boolean) {
  ops.op_physics_create_world(-9.81);
  const registry = new SkillRegistry(new LiminaTracer("ses_p11_mount"));
  const core = registerCoreSkills(registry);
  const { world, added } = makeCapturingWorld();
  const base = { agentId: "agt_mount", sessionId: "ses_p11_mount", permissions: resolveProfile("builder.readWrite"), tick: 0, world };
  const gen = ok(await registry.invoke("world.generateRegion", { seed: SEED, bounds: BOUNDS, lod: 0, type: TYPE, hints: SHAPE }, base));
  const regionId = gen.regionId as string;
  const relief = surveyRegionRelief(core.terrain.source, SEED, BOUNDS, HINTS);
  const seaLevel = relief.minY + SEA_FRACTION * (relief.maxY - relief.minY);
  const scattered = await scatterBiomeContent({
    registry, source: core.terrain.source, regions: passRegions ? core.terrain.regions : undefined,
    regionId, type: TYPE, bounds: BOUNDS, seed: SEED, base, waterLevel: seaLevel, waterMargin: WATER_MARGIN,
  });
  return { scattered, added, seaLevel, registry, core, base, regionId, relief };
}

// ── 1 + 2 + 3. The real mount path over the demo's amp-4.5 eroded mountains config ──────
const { scattered, added, seaLevel, registry: reg, base: base0, regionId: rid, relief } = await runDemoScatter(true);
assert(scattered.layers.length === BIOME_CONTENT.mountains.length, "mountains layer count mismatch");
const [pineLayer, rockLayer] = scattered.layers;

// PINE (layer 0): instances > 0 AND both sub-meshes mount (pine.glb = foliage + trunk).
assert(pineLayer.instances > 0, `pine layer mounted NO instances (the "only rocks" bug): instances=${pineLayer.instances}`);
assert(pineLayer.mounted === 2, `pine is a 2-mesh asset (foliage+trunk) but mounted ${pineLayer.mounted} InstancedMesh(es) — a sub-mesh was dropped`);
// ROCK (layer 1): instances > 0, single mesh.
assert(rockLayer.instances > 0, `rock layer mounted no instances: ${rockLayer.instances}`);
assert(rockLayer.mounted === 1, `rock is a 1-mesh asset but mounted ${rockLayer.mounted} InstancedMesh(es)`);
// PINES DOMINATE the boulders (a forested lower mountain, not a rock pile).
assert(pineLayer.instances >= rockLayer.instances, `pines (${pineLayer.instances}) must not be outnumbered by boulders (${rockLayer.instances})`);

// The captured InstancedMeshes themselves carry real, written instance counts (> 0). Every
// pine sub-mesh InstancedMesh has the SAME count as the pine layer's placement total.
const instMeshes = added.filter((o): o is THREE.InstancedMesh => o instanceof THREE.InstancedMesh);
assert(instMeshes.length === pineLayer.mounted + rockLayer.mounted, `scene.add count ${instMeshes.length} != total mounted ${pineLayer.mounted + rockLayer.mounted}`);
assert(instMeshes.every((m) => m.count > 0), "a mounted InstancedMesh has count 0 (no instances written to the buffer)");
const pineMeshes = instMeshes.filter((m) => m.count === pineLayer.instances);
assert(pineMeshes.length === 2, `expected 2 pine sub-mesh InstancedMeshes of count ${pineLayer.instances}, found ${pineMeshes.length}`);
// Each pine sub-mesh instances DISTINCT geometry (foliage canopy vs trunk), so both authored
// parts actually reach the GPU — not the same mesh twice.
assert(pineMeshes[0].geometry !== pineMeshes[1].geometry, "pine's two InstancedMeshes share one geometry (a sub-mesh is missing)");

// ── 4. ROOT-CAUSE PIN: the region's actual (amp/erode) hints are load-bearing ───────────
// Re-run the SAME demo scatter but WITHOUT the region table, so scatterBiomeContent falls
// back to bare type-default hints (amp 2.4, no erode). The pine tree-line then resolves
// against the wrong surface and crops the pines away — the exact bug. Non-vacuous: it must
// produce strictly FEWER pines than the correctly-surveyed run (here it collapses to 0).
const { scattered: bad } = await runDemoScatter(false);
assert(bad.layers[0].instances < pineLayer.instances,
  `bare type-hint survey did not change the pine count (${bad.layers[0].instances} vs ${pineLayer.instances}) — the region-hints fix is not load-bearing / the test is vacuous`);

// ── 4b. NO PROPS IN / BELOW WATER: the spawn mask keeps every layer above the shoreline ─
// Over the demo's ACTUAL config (island-falloff eroded mountains flooded to 18% of relief + a
// 2.5 m dry margin — the config the user A/B'd), assert ZERO mounted prop instances — pine AND
// rock, across ALL layers, inland lakes + the island coast included — sit at or below
// waterLevel + margin. The placements come from the REAL mount path (scatterBiomeContent →
// asset.scatter output), not a re-derived pure scatter.
const dryFloor = seaLevel + WATER_MARGIN;
const allPlacements = scattered.layers.flatMap((l) => l.placements);
assert(allPlacements.length === scattered.instances, `placements (${allPlacements.length}) != total instances (${scattered.instances}) — mount path did not return every placement`);
const inWater = allPlacements.filter((p) => p.y <= dryFloor);
assert(inWater.length === 0, `${inWater.length} mounted props sit at/below the waterline+margin (dryFloor ${dryFloor.toFixed(2)}; lowest ${Math.min(...allPlacements.map((p) => p.y)).toFixed(2)}) — props standing in water`);
// Non-vacuous: the region genuinely HAS surface below the dry floor (the flooded valleys are
// submerged), so the empty result above is the gate doing work, not an empty candidate set.
assert(relief.minY < dryFloor - 0.5, `relief floor ${relief.minY.toFixed(2)} is not below the dry floor ${dryFloor.toFixed(2)} — the no-props-in-water check would be vacuous`);

// FALSIFIABLE CONTROL: scatter the SAME pine palette through the SAME mount path (asset.scatter)
// but with the water gate REMOVED (no waterLevel → no elevationMin floor). Pines then DO land
// at/below the waterline — proving the clean result above is the gate, and the test is non-vacuous.
const looseCfg = biomeScatterConfigs(TYPE, relief)[0]; // pine layer, no water gate
assert(looseCfg.elevationMin === undefined, "control setup: ungated pine config still has an elevationMin floor");
const loose = ok(await reg.invoke("asset.scatter", { regionId: rid, config: looseCfg }, base0));
const loosePlacements = loose.placements as { y: number }[];
const looseBelow = loosePlacements.filter((p) => p.y <= dryFloor);
assert(looseBelow.length > 0, `ungated pine scatter placed nothing at/below the waterline (${loosePlacements.length} total) — the water gate is not load-bearing / the check is vacuous`);

// ── 5. FOREST: the OTHER 2-mesh asset (broadleaf) mounts all its sub-meshes too ─────────
// Forest layer 0 is a broadleaf(2-mesh)+pine(2-mesh) mix, so it mounts 4 InstancedMeshes
// (both authored parts of BOTH species reach the GPU — the forest's "only trunks / no
// canopy" analogue of the mountains bug).
ops.op_physics_create_world(-9.81);
{
  const registry = new SkillRegistry(new LiminaTracer("ses_p11_mount_forest"));
  const core = registerCoreSkills(registry);
  const { world } = makeCapturingWorld();
  const fbounds: RegionBounds = { minTx: 0, minTz: 0, maxTx: 1, maxTz: 1 };
  const fbase = { agentId: "agt_mountf", sessionId: "ses_p11_mount_forest", permissions: resolveProfile("builder.readWrite"), tick: 0, world };
  const fgen = ok(await registry.invoke("world.generateRegion", { seed: SEED, bounds: fbounds, lod: 0, type: "forest" }, fbase));
  const forest = await scatterBiomeContent({
    registry, source: core.terrain.source, regions: core.terrain.regions,
    regionId: fgen.regionId as string, type: "forest", bounds: fbounds, seed: SEED, base: fbase,
  });
  const canopy = forest.layers[0]; // broadleaf(2) + pine(2)
  assert(canopy.instances > 0, "forest canopy layer placed nothing");
  assert(canopy.mounted === 4, `forest canopy (broadleaf 2-mesh + pine 2-mesh) should mount 4 InstancedMeshes, mounted ${canopy.mounted}`);
  assert(canopy.assetHashes[BROADLEAF_ASSET] !== undefined && canopy.assetHashes[PINE_ASSET] !== undefined, "forest canopy missing a species hash");
}

ops.op_log(
  `p11_biome_mount OK: demo config (mountains amp ${AMP} erode, 4×4, sea ${(SEA_FRACTION * 100) | 0}%, margin ${WATER_MARGIN}) ` +
  `mounts pine ${pineLayer.instances}× across ${pineLayer.mounted} sub-meshes (foliage+trunk) + rock ${rockLayer.instances}× across ${rockLayer.mounted} mesh ` +
  `(pines ≥ boulders); every InstancedMesh count > 0; pine sub-meshes instance distinct geometry. ` +
  `Water spawn-mask (${WATER_MARGIN} m margin): 0/${scattered.instances} mounted props at/below dryFloor ${dryFloor.toFixed(1)} ` +
  `(relief ${relief.minY.toFixed(1)}..${relief.maxY.toFixed(1)}, sea ${seaLevel.toFixed(1)}); ungated control placed ${looseBelow.length} below (gate non-vacuous). ` +
  `Root cause pinned: bare type-hint survey collapses pines to ${bad.layers[0].instances} (region-hints survey is load-bearing). ` +
  `[${PINE_ASSET}/${BROADLEAF_ASSET}/${ROCK_ASSET}]`,
);
