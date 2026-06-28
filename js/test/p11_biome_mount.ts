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

import { ProceduralTerrainSource } from "../src/terrain/procedural.ts";
import { terrainTypeHints, type RegionBounds } from "../src/terrain/terrain-types.ts";
import {
  scatterBiomeContent, surveyRegionRelief,
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

// The EXACT landscape demo config (js/src/demos/landscape_window.ts).
const SEED = 1234;
const TYPE = "mountains" as const;
const BOUNDS: RegionBounds = { minTx: 0, minTz: 0, maxTx: 3, maxTz: 3 };
const AMP = 4.5;
const SEA_FRACTION = 0.18;
const WATER_MARGIN = 1.0;
const HINTS = { ...terrainTypeHints(TYPE, BOUNDS), amp: AMP, erode: 1 };

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
  const gen = ok(await registry.invoke("world.generateRegion", { seed: SEED, bounds: BOUNDS, lod: 0, type: TYPE, hints: { amp: AMP, erode: 1 } }, base));
  const regionId = gen.regionId as string;
  const relief = surveyRegionRelief(core.terrain.source, SEED, BOUNDS, HINTS);
  const seaLevel = relief.minY + SEA_FRACTION * (relief.maxY - relief.minY);
  const scattered = await scatterBiomeContent({
    registry, source: core.terrain.source, regions: passRegions ? core.terrain.regions : undefined,
    regionId, type: TYPE, bounds: BOUNDS, seed: SEED, base, waterLevel: seaLevel, waterMargin: WATER_MARGIN,
  });
  return { scattered, added };
}

// ── 1 + 2 + 3. The real mount path over the demo's amp-4.5 eroded mountains config ──────
const { scattered, added } = await runDemoScatter(true);
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
  `Root cause pinned: bare type-hint survey collapses pines to ${bad.layers[0].instances} (region-hints survey is load-bearing). ` +
  `[${PINE_ASSET}/${BROADLEAF_ASSET}/${ROCK_ASSET}]`,
);
