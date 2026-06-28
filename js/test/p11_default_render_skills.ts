// Phase 11 — THE DEFAULT-SKILL FIDELITY GATE. The whole point of this cut: an agent
// building with ONLY the core skill library (registerCoreSkills) gets a gorgeous,
// TEXTURED world — not "lit sky over invisible ground". This test is the falsifiable
// proof that the three render-fidelity skills are reachable through the default library:
//
//   (a) world.generateRegion ALONE adds a VISIBLE procedural-PBR terrain mesh to the
//       scene (the closed gap) — a mesh whose material carries the PBR colorNode +
//       normalNode (the banded-triplanar surface), NOT the flat-colour default. And
//       render:false adds NONE (the opt-out).
//   (b) world.populateBiome scatters biome-correct content over a generated region
//       (instances > 0), GATED — flooding the region to the peaks places ZERO (no
//       props in water). Falsifiable: the un-flooded run places many.
//   (c) render.enablePost builds the post pipeline on the live renderer (GTAO + bloom +
//       real depth/normal pre-pass nodes present) and stows it on world.post.
//
// Run: limina js/test/p11_default_render_skills.ts   (exit 0 = pass)

import * as THREE from "../build/three.bundle.mjs";
import { EntityTable, ops } from "../src/engine.ts";
import { createEcsWorld } from "../src/ecs/world.ts";
import { createTransformStorage } from "../src/ecs/facade.ts";
import { UniformGridSpatialIndex } from "../src/spatial/index.ts";
import { SkillRegistry, type WorldContext } from "../src/skills/registry.ts";
import { registerCoreSkills } from "../src/skills/index.ts";
import { resolveProfile } from "../src/skills/permissions.ts";
import { LiminaTracer } from "../src/observability/event.ts";
import { TILE_SIZE } from "../src/terrain/procedural.ts";
import type { MCPResponse } from "../src/mcp/protocol.ts";

function assert(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new Error("p11_default_render_skills FAIL: " + msg);
}
function ok(res: MCPResponse | undefined): Record<string, unknown> {
  if (res === undefined || !res.success) throw new Error("call failed: " + JSON.stringify(res?.error));
  return res.result as Record<string, unknown>;
}

/** A headless world whose scene.add/remove CAPTURES added objects so we can inspect the
 *  real meshes (material nodes, types) the skills mount — not just the skill tallies. */
function makeCapturingWorld(scene?: unknown, renderer?: unknown): { world: WorldContext; added: unknown[] } {
  const ecs = createEcsWorld();
  const added: unknown[] = [];
  const stub = {
    add(o: unknown) { added.push(o); },
    remove() {},
    position: { set() {}, x: 0, y: 0, z: 0 },
    background: null as unknown,
  };
  const camera = scene !== undefined
    ? new THREE.PerspectiveCamera(60, 16 / 9, 0.1, 200)
    : { position: { set() {} }, aspect: 1, lookAt() {}, updateProjectionMatrix() {} };
  return {
    world: {
      ecs, transforms: createTransformStorage(ecs), spatial: new UniformGridSpatialIndex(),
      entities: new EntityTable(), tags: new Map(), scene: (scene ?? stub) as never, camera: camera as never,
      renderer, ops, mode: "headless",
    },
    added,
  };
}

const SEED = 1234;
// The landscape-demo island recipe (mountains, amp 4.5, erosion, coastal island falloff).
const BOUNDS = { minTx: 0, minTz: 0, maxTx: 1, maxTz: 1 } as const;
const HALF_EXTENT = (Math.min(BOUNDS.maxTx - BOUNDS.minTx, BOUNDS.maxTz - BOUNDS.minTz) + 1) * TILE_SIZE / 2;
const ISLAND = {
  islandCx: ((BOUNDS.minTx + BOUNDS.maxTx + 1) / 2) * TILE_SIZE,
  islandCz: ((BOUNDS.minTz + BOUNDS.maxTz + 1) / 2) * TILE_SIZE,
  islandRadius: HALF_EXTENT * 0.40,
  islandFalloff: HALF_EXTENT * 0.62,
};
const SHAPE = { amp: 4.5, erode: 1, ...ISLAND };
const TILES = (BOUNDS.maxTx - BOUNDS.minTx + 1) * (BOUNDS.maxTz - BOUNDS.minTz + 1);

// ===========================================================================
// (a) world.generateRegion ALONE adds a VISIBLE PBR terrain mesh (the gap closed).
// ===========================================================================
{
  ops.op_physics_create_world(-9.81);
  const registry = new SkillRegistry(new LiminaTracer("ses_p11_default_a"));
  registerCoreSkills(registry);
  // A live renderer (stub) — the auto-surface allocates the visible mesh only on a render-
  // capable world (a headless/replay world keeps the band but allocates no discardable mesh).
  const { world, added } = makeCapturingWorld(undefined, {});
  const base = { agentId: "agt_a", sessionId: "ses_p11_default_a", permissions: resolveProfile("builder.readWrite"), tick: 0, world };

  const gen = ok(await registry.invoke("world.generateRegion", { seed: SEED, bounds: BOUNDS, lod: 0, type: "mountains", hints: SHAPE }, base));
  // The skill reports the meshes it mounted.
  assert(gen.meshes === TILES, `generateRegion mounted ${gen.meshes} meshes, expected ${TILES} (one per tile)`);
  assert(gen.relief !== undefined && typeof gen.seaLevel === "number", "generateRegion did not return the surveyed relief + seaLevel");

  // The captured scene objects include a real THREE.Mesh per tile whose material carries
  // the PBR colorNode + normalNode (the banded-triplanar surface) — NOT the flat default.
  const meshes = added.filter((o): o is THREE.Mesh => o instanceof THREE.Mesh);
  assert(meshes.length === TILES, `scene received ${meshes.length} terrain meshes, expected ${TILES}`);
  const pbr = meshes.filter((m) => {
    const mat = m.material as { colorNode?: unknown; normalNode?: unknown };
    return mat.colorNode !== undefined && mat.colorNode !== null && mat.normalNode !== undefined && mat.normalNode !== null;
  });
  assert(pbr.length === TILES, `${pbr.length}/${TILES} terrain meshes are PBR-shaded (colorNode + normalNode) — the rest are the flat-colour void`);
  // Each terrain mesh has real geometry coinciding with the collider surface.
  assert(meshes.every((m) => (m.geometry?.getAttribute?.("position")?.count ?? 0) > 0), "a terrain mesh has empty geometry");
}

// ── render:false opts OUT — colliders/data only, NO visible mesh ──────────────────────
{
  ops.op_physics_create_world(-9.81);
  const registry = new SkillRegistry(new LiminaTracer("ses_p11_default_a2"));
  registerCoreSkills(registry);
  // A live renderer stub, so the ONLY reason for zero meshes is render:false (not the headless
  // no-renderer skip) — a clean opt-out proof.
  const { world, added } = makeCapturingWorld(undefined, {});
  const base = { agentId: "agt_a2", sessionId: "ses_p11_default_a2", permissions: resolveProfile("builder.readWrite"), tick: 0, world };
  const gen = ok(await registry.invoke("world.generateRegion", { seed: SEED, bounds: BOUNDS, lod: 0, type: "mountains", hints: SHAPE, render: false }, base));
  assert(gen.meshes === 0, `render:false still mounted ${gen.meshes} meshes`);
  const meshes = added.filter((o): o is THREE.Mesh => o instanceof THREE.Mesh);
  assert(meshes.length === 0, `render:false added ${meshes.length} terrain meshes (must add none)`);
  // Colliders/entities still built (the data path is unchanged).
  assert((gen.bodies as number[]).length === TILES, "render:false did not build the heightfield colliders");
}

// ===========================================================================
// (a3) FINDING-1 REVERT-PROOF — a SECOND generateRegion of the SAME region (all tiles
//      already cached, no fresh scan) must PRESERVE the original surface band, not overwrite
//      region.meshOpts with a degenerate 0..0 relief (which would mis-colour a later
//      streamFollow tile banding against it). Falsifiable: the degenerate fallback → fail.
// ===========================================================================
{
  ops.op_physics_create_world(-9.81);
  const registry = new SkillRegistry(new LiminaTracer("ses_p11_default_regen"));
  const core = registerCoreSkills(registry);
  const { world } = makeCapturingWorld(undefined, {});
  const base = { agentId: "agt_regen", sessionId: "ses_p11_default_regen", permissions: resolveProfile("builder.readWrite"), tick: 0, world };

  const g1 = ok(await registry.invoke("world.generateRegion", { seed: SEED, bounds: BOUNDS, lod: 0, type: "mountains", hints: SHAPE }, base));
  const regionId = g1.regionId as string;
  type Band = { seaLevel: number; minY: number; maxY: number };
  const bandOf = (): Band | undefined => (core.terrain.regions.get(regionId)?.meshOpts as { pbr?: Band } | undefined)?.pbr;
  const b1 = bandOf();
  assert(b1 !== undefined, "first gen did not store a PBR surface band on the region");
  const r1 = g1.relief as { minY: number; maxY: number };
  assert(r1.maxY > r1.minY, `first gen relief is degenerate (${r1.minY}..${r1.maxY})`);

  // Re-generate the SAME region — every tile is already cached (no fresh tiles scanned).
  const g2 = ok(await registry.invoke("world.generateRegion", { seed: SEED, bounds: BOUNDS, lod: 0, type: "mountains", hints: SHAPE }, base));
  const b2 = bandOf();
  assert(b2 !== undefined, "re-gen dropped the surface band");
  assert(b1.seaLevel === b2.seaLevel && b1.minY === b2.minY && b1.maxY === b2.maxY,
    `re-gen OVERWROTE the surface band with a degenerate relief: was {sea ${b1.seaLevel}, ${b1.minY}..${b1.maxY}}, now {sea ${b2.seaLevel}, ${b2.minY}..${b2.maxY}}`);
  const r2 = g2.relief as { minY: number; maxY: number };
  assert(r2.minY === r1.minY && r2.maxY === r1.maxY && g2.seaLevel === g1.seaLevel,
    "re-gen returned a different relief/seaLevel (degenerate re-survey)");
}

// ===========================================================================
// (b) world.populateBiome scatters biome-correct, GATED content over a region.
// ===========================================================================
{
  ops.op_physics_create_world(-9.81);
  const registry = new SkillRegistry(new LiminaTracer("ses_p11_default_b"));
  registerCoreSkills(registry);
  const { world } = makeCapturingWorld();
  const base = { agentId: "agt_b", sessionId: "ses_p11_default_b", permissions: resolveProfile("builder.readWrite"), tick: 0, world };

  const gen = ok(await registry.invoke("world.generateRegion", { seed: SEED, bounds: BOUNDS, lod: 0, type: "mountains", hints: SHAPE }, base));
  const regionId = gen.regionId as string;
  const relief = gen.relief as { minY: number; maxY: number };
  const seaLevel = relief.minY + 0.18 * (relief.maxY - relief.minY);

  // Populate via the SKILL (type resolved from the region). Props place, gated to dry land.
  const pop = ok(await registry.invoke("world.populateBiome", { regionId, waterLevel: seaLevel, waterMargin: 2.5 }, base));
  assert(pop.type === "mountains", `populateBiome resolved type '${pop.type}', expected the region's 'mountains'`);
  assert((pop.instances as number) > 0, `world.populateBiome placed NO props (instances=${pop.instances}) — the populate path is broken`);
  const layers = pop.layers as { instances: number; mounted: number }[];
  assert(layers.length > 0 && layers.some((l) => l.mounted > 0), "populateBiome mounted no InstancedMeshes");

  // GATED — 0 in water: flood the region OVER its peak so EVERY candidate is in water; the
  // waterGated mountains layers must then place ZERO. Falsifiable against the run above.
  const flooded = ok(await registry.invoke("world.populateBiome", { regionId, waterLevel: relief.maxY + 50, waterMargin: 2.5 }, base));
  assert((flooded.instances as number) === 0, `flooding the region to its peak still placed ${flooded.instances} props (props in water — the water gate is not load-bearing)`);
  assert((flooded.instances as number) < (pop.instances as number), "flooded run did not place strictly fewer than the dry run (gate vacuous)");

  // Biome-correctness: a DESERT region scatters its (biome-gated) cacti content too.
  const dgen = ok(await registry.invoke("world.generateRegion", { seed: SEED, bounds: { minTx: 8, minTz: 0, maxTx: 9, maxTz: 1 }, lod: 0, type: "desert" }, base));
  const dpop = ok(await registry.invoke("world.populateBiome", { regionId: dgen.regionId as string }, base));
  assert(dpop.type === "desert" && (dpop.instances as number) > 0, `desert populate placed nothing (instances=${dpop.instances})`);
}

// ===========================================================================
// (c) render.enablePost builds the post pipeline on the live renderer.
// ===========================================================================
{
  const registry = new SkillRegistry(new LiminaTracer("ses_p11_default_c"));
  registerCoreSkills(registry);
  // Real scene + camera (the scene pass reads them at build); a stub renderer (PostProcessing
  // only STORES it — no GPU call until render()).
  const { world } = makeCapturingWorld(new THREE.Scene(), {} as unknown);
  const base = { agentId: "agt_c", sessionId: "ses_p11_default_c", permissions: resolveProfile("builder.readWrite"), tick: 0, world };

  const res = ok(await registry.invoke("render.enablePost", {}, base));
  assert(res.enabled === true, "render.enablePost did not report enabled");
  assert(res.ao === true && res.bloom === true && res.grade === true, "default post stages not all wired");
  assert(res.depth === true && res.normal === true, "post pipeline missing the real depth+normal pre-pass nodes");

  // The live pipeline is stowed on world.post for the render loop to drive.
  const pipe = world.post as { aoNode?: unknown; bloomNode?: unknown; depthNode?: unknown; normalNode?: unknown; render?: unknown } | undefined;
  assert(pipe !== undefined, "render.enablePost did not stow the pipeline on world.post");
  assert(pipe.aoNode != null && pipe.bloomNode != null, "world.post missing the GTAO/bloom nodes");
  assert(pipe.depthNode != null && pipe.normalNode != null, "world.post missing depth/normal pre-pass nodes");
  assert(typeof pipe.render === "function", "world.post has no render() driver");

  // Falsifiable: disabling stages drops their nodes.
  const off = ok(await registry.invoke("render.enablePost", { ao: { enabled: false }, bloom: { enabled: false } }, base));
  assert(off.ao === false && off.bloom === false, "disabling AO/bloom did not drop the stages");
}

ops.op_log(
  "p11_default_render_skills OK: (a) world.generateRegion ALONE mounts a VISIBLE PBR terrain mesh " +
  `per tile (colorNode + normalNode present) — the gap is closed; render:false adds none. ` +
  "(b) world.populateBiome scatters gated biome content (>0 dry, 0 when flooded to the peak; desert cacti place). " +
  "(c) render.enablePost builds the GTAO+bloom+depth/normal pipeline on the live renderer and stows it on world.post. " +
  "DEFAULT SKILL LIBRARY now reaches high-fidelity render — a textured world out of the box.",
);
