// vegetation.scatter — scatter a forest of tree archetypes across an EDITABLE terrain layer.
// Reuses the deterministic, slope/elevation-gated scatterAssets over the layer's heightfield
// (the same machinery asset.scatter uses over generated regions), and mounts instanced trees
// from the TEXTURED ez-tree GLB archetypes (tools/bake-trees-browser.mjs). Deterministic +
// recorded: the log carries the config + pinned asset hashes, NEVER the instance transforms —
// replay recomputes identical placements over the same (recorded) terrain ops.

import { z } from "../../build/zod.bundle.mjs";
import { MAX_ENTITIES, despawnRenderable, spawnRenderable } from "../ecs/world.ts";
import type { Transformable } from "../ecs/world.ts";
import { scatterAssets, type AssetInstance, type ScatterConfig, type ScatterExclusion } from "../terrain/asset-scatter.ts";
import { buildAssetInstancedMeshes, disposeAssetInstancedMesh } from "../terrain/asset-scatter-render.ts";
import { loadGltfIntoScene, parseGltfScene } from "./three.ts";
import { tagEntity } from "./ecs.ts";
import type { AssetRegistry } from "../asset-registry.ts";
import type { SkillDefinition, SkillRegistry } from "./registry.ts";
import type { EditableTerrain } from "./terrain-edit.ts";

const inertTransform = (): Transformable => ({ position: { set() {} }, quaternion: { set() {} }, scale: { set() {} } });

/** Yield one animation frame so a heavy mount (GLB parse + GPU upload) doesn't block the main
 *  thread in one burst — spreads six archetype uploads across six frames instead of a single
 *  multi-second stall that can trip the browser's unresponsive-page watchdog / lose the WebGPU
 *  device. Falls back to a macrotask where rAF is absent. */
const nextFrame = (): Promise<void> =>
  new Promise((resolve) => {
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(() => resolve());
    else setTimeout(resolve, 0);
  });

/** Pick one archetype id for a species deterministically from `seed`. */
export function pickArchetype(species: string, seed: number): string {
  const palette = SPECIES_ARCHETYPES[species] ?? [];
  if (palette.length === 0) throw new Error(`vegetation.plant: no archetypes for species '${species}'`);
  const i = ((seed % palette.length) + palette.length) % palette.length;
  return palette[i];
}

/** Default boreal archetype palette — the textured GLBs from tools/bake-trees-browser.mjs. */
export const SPECIES_ARCHETYPES: Record<string, string[]> = {
  spruce: ["trees/spruce-1.glb", "trees/spruce-2.glb"],
  pine: ["trees/pine-1.glb", "trees/pine-2.glb"],
  birch: ["trees/birch-1.glb", "trees/birch-2.glb"],
};

/** Every tree archetype id (all species) — the set the live viewport pre-warms before init so a
 *  plant/scatter mounts from a cached clone (no macrotask) and renders on the WebGL2 backend. */
export const TREE_ARCHETYPE_IDS: string[] = [...new Set(Object.values(SPECIES_ARCHETYPES).flat())];

const scatterInput = z.object({
  /** Terrain layer to scatter on. Defaults to the most recently created one. */
  terrain: z.string().optional(),
  /** Species to include (weighted equally). Defaults to all. */
  species: z.array(z.enum(["spruce", "pine", "birch"])).optional(),
  /** Candidate samples per grid axis (placement density). */
  density: z.number().int().min(1).max(64).default(16),
  /** Scatter salt — same seed reproduces the same forest; a new seed reshuffles it. */
  seed: z.number().int().default(1337),
  /** World-Y floor: no trees below this (e.g. above water). */
  elevationMin: z.number().optional(),
  /** World-Y ceiling — the TREE LINE: no trees above this (thin out near a peak). */
  elevationMax: z.number().optional(),
  /** Max local slope (rise/run) — steeper faces stay bare rock. */
  slopeMax: z.number().min(0).default(0.85),
  /** Per-instance uniform scale range. */
  sizeRange: z.tuple([z.number().positive(), z.number().positive()]).default([0.7, 1.35]),
  /** Fraction of passing candidates actually placed. */
  coverage: z.number().min(0).max(1).default(0.9),
  /** Clumping strength [0,1] — >0 gathers trees into natural stands. */
  cluster: z.number().min(0).max(1).default(0.45),
  /** Explicit keep-out discs (world XZ) — no tree spawns inside any. UNIONED with the
   *  settlement footprints village.build auto-registers for this terrain, so "scatter a
   *  forest and it avoids the village" just works with no manual data-flow. */
  exclusions: z.array(z.object({ x: z.number(), z: z.number(), r: z.number().nonnegative() })).optional(),
  /** Extra tags for the forest entity (it is always tagged "forest" + "vegetation"). */
  tags: z.array(z.string()).optional(),
});

type SceneLike = { add?: (o: unknown) => void; remove?: (o: unknown) => void };
type InstMesh = { castShadow: boolean; receiveShadow: boolean };

export function registerVegetationSkills(
  registry: SkillRegistry,
  layers: Map<string, EditableTerrain>,
  assets: AssetRegistry,
  /** Shared settlement-footprint registry (keyed by terrain id) that village.build fills.
   *  vegetation.scatter AUTO-includes the footprints for the terrain it scatters on, unioned
   *  with any explicit `exclusions`, so trees avoid the village with no manual wiring. */
  footprints: Map<string, ScatterExclusion[]> = new Map(),
  mounted: Map<string, () => void> = new Map(),
): void {
  const scatter: SkillDefinition<z.infer<typeof scatterInput>, { entity: string; instances: number; assetHashes: Record<string, string>; placements: unknown[] }> = {
    name: "vegetation.scatter",
    version: "1.0.0",
    description: "Scatter a forest of tree archetypes across an editable terrain layer, gated by slope + elevation (tree line), deterministic + recorded. Instanced trees sit on the sculpted ground. Returns the forest entity + instance count.",
    category: "terrain",
    permissions: ["scene.write"],
    // The recorder copies resolved per-asset hashes into the recorded command so replay pins identity.
    commitFields: ["assetHashes"],
    input: scatterInput,
    output: z.object({ entity: z.string(), instances: z.number().int(), assetHashes: z.record(z.string(), z.string()), placements: z.array(z.unknown()) }),
    handler: async (input, ctx) => {
      // Resolve the terrain layer (default: most recently created).
      let terrainId = input.terrain;
      if (terrainId === undefined) { let last: string | undefined; for (const k of layers.keys()) last = k; terrainId = last; }
      const layer = terrainId !== undefined ? layers.get(terrainId) : undefined;
      if (layer === undefined) throw new Error("vegetation.scatter: no terrain layer — create one with terrain.create first");

      // Build the palette from the selected species.
      const species = input.species ?? ["spruce", "pine", "birch"];
      const paletteIds = [...new Set(species.flatMap((s) => SPECIES_ARCHETYPES[s] ?? []))];
      if (paletteIds.length === 0) throw new Error("vegetation.scatter: no archetypes for the requested species");

      // Content-address (pin) every palette asset — a swapped archetype is rejected on replay.
      const assetHashes: Record<string, string> = {};
      for (const id of paletteIds) assetHashes[id] = assets.resolve(id).hash;

      // Auto-include the settlement footprints registered for THIS terrain (village.build
      // fills the registry when it builds), unioned with any explicit exclusions. Replay-safe:
      // the registry is deterministically rebuilt by re-running village.build before this scatter,
      // so the union is identical on replay without logging the derived discs.
      const registered = footprints.get(terrainId) ?? [];
      const allExclusions: ScatterExclusion[] = [...registered, ...(input.exclusions ?? [])];

      const config: ScatterConfig = {
        seed: input.seed,
        density: input.density,
        assets: paletteIds.map((id) => ({ id })),
        slopeMax: input.slopeMax,
        sizeRange: input.sizeRange,
        coverage: input.coverage,
        cluster: input.cluster,
        ...(input.elevationMin !== undefined ? { elevationMin: input.elevationMin } : {}),
        ...(input.elevationMax !== undefined ? { elevationMax: input.elevationMax } : {}),
        ...(allExclusions.length > 0 ? { exclusions: allExclusions } : {}),
      };

      // Deterministic placements over the editable heightfield (Y = surface, slope/elevation gated).
      const placements: AssetInstance[] = scatterAssets(layer.tile, input.seed, config);

      // Mount instanced trees from the textured archetypes — browser render context only (the
      // headless authoritative context has a stub scene; it records + replays without meshes).
      const scene = ctx.world.scene as SceneLike | undefined;
      let mountedCount = 0;
      const meshes: unknown[] = [];
      if (ctx.world.mode !== "headless" && scene !== undefined && typeof scene.add === "function") {
        // CRASH-PROOF: a GLB parse / GPU upload failure must NOT kill the viewport's apply loop.
        // The placements are already recorded (the authoritative contract); if the render mount
        // fails, log it and leave the forest un-mounted rather than throwing into the viewport.
        const byId = new Map<string, AssetInstance[]>();
        for (const inst of placements) {
          let list = byId.get(inst.assetId);
          if (list === undefined) { list = []; byId.set(inst.assetId, list); }
          list.push(inst);
        }
        // Mount ONE archetype per frame: parsing a dense GLB + uploading its InstancedMesh to the
        // GPU is heavy; doing all six back-to-back blocks the main thread long enough to trip the
        // browser's unresponsive-page watchdog / lose the WebGPU device (the reported "crash").
        // Yielding a frame between archetypes spreads the cost and keeps the viewport responsive.
        // Per-archetype try/catch so one bad asset can't kill the rest OR the apply loop.
        let idx = 0;
        const totalArchetypes = byId.size;
        for (const [id, list] of byId) {
          idx++;
          ctx.emit("vegetation.mounting", { archetype: id, index: idx, total: totalArchetypes, instances: list.length });
          try {
            const root = await parseGltfScene(id, assets.resolve(id).bytes);
            for (const mesh of buildAssetInstancedMeshes(root, list)) {
              (mesh as unknown as InstMesh).castShadow = true;
              (mesh as unknown as InstMesh).receiveShadow = true;
              scene.add(mesh);
              meshes.push(mesh);
              mountedCount++;
            }
          } catch (err) {
            ctx.emit("vegetation.mount_failed", { archetype: id, message: err instanceof Error ? err.message : String(err) });
          }
          await nextFrame();
        }
      }

      // A forest handle entity (world-integrated + removable), anchored at the terrain origin.
      const [ox, oy, oz] = layer.tile.origin;
      const eid = spawnRenderable(ctx.world.ecs, inertTransform(), ox, oy, oz);
      if (eid >= MAX_ENTITIES) { despawnRenderable(ctx.world.ecs, eid); throw new Error("vegetation.scatter: entity capacity exceeded"); }
      const origin = { tool: "vegetation.scatter", input: { ...input } };
      const entity = ctx.world.entities.create({ eid, origin });
      tagEntity(ctx as never, entity, ["forest", "vegetation", ...(input.tags ?? [])]);
      if (meshes.length > 0) {
        mounted.set(entity, () => {
          for (const m of meshes) { if (typeof scene?.remove === "function") scene.remove(m); disposeAssetInstancedMesh(m as never); }
        });
      }

      ctx.emit("vegetation.scattered", { entity, terrain: terrainId, instances: placements.length, mounted: mountedCount, exclusions: allExclusions.length });
      return { entity, instances: placements.length, assetHashes, placements };
    },
  };

  registry.register(scatter as unknown as Parameters<SkillRegistry["register"]>[0]);

  // vegetation.plant — place ONE tree of a species at a point (the per-tree counterpart to the bulk
  // scatter). A single normal entity via the proven single-GLB path (loadGltfIntoScene, same as
  // asset.place) — light on the GPU, so it works where a full scatter is heavy, and lets the agent
  // compose a scene tree-by-tree. Deterministic + recorded: the archetype is chosen from `seed` and
  // its content hash is pinned.
  const plantInput = z.object({
    /** Which tree to plant. */
    species: z.enum(["spruce", "pine", "birch"]).default("spruce"),
    /** World position [x,y,z]. Defaults to the current terrain layer's origin (its flat surface). */
    position: z.tuple([z.number(), z.number(), z.number()]).optional(),
    /** Terrain layer whose origin is the default position. Defaults to the most recently created. */
    terrain: z.string().optional(),
    /** Selects the archetype variant + is recorded; same seed => same tree. */
    seed: z.number().int().default(1),
    /** Uniform scale multiplier on the (already real-world-height) archetype. */
    scale: z.number().positive().default(1),
    /** Heading in radians about +Y. */
    yaw: z.number().default(0),
    /** Extra tags for the tree entity (it is always tagged "tree" + its species). */
    tags: z.array(z.string()).optional(),
  });

  const plant: SkillDefinition<z.infer<typeof plantInput>, { entity: string; assetId: string; assetHash: string }> = {
    name: "vegetation.plant",
    version: "1.0.0",
    description: "Plant a SINGLE tree of a species (spruce/pine/birch) at a point — the per-tree counterpart to vegetation.scatter. A light single entity (works where a full forest is too heavy), for composing a scene tree by tree. Deterministic + recorded.",
    category: "terrain",
    permissions: ["scene.write"],
    commitFields: ["assetHash"],
    input: plantInput,
    output: z.object({ entity: z.string(), assetId: z.string(), assetHash: z.string() }),
    handler: async (input, ctx) => {
      const assetId = pickArchetype(input.species, input.seed);
      const resolved = assets.resolve(assetId);

      // Default the position to the CENTRE of the active terrain layer, on its surface (terrain is
      // centred on its origin; surface Y = origin.y + centre height × scale.y — the same formula the
      // scatter/mesh/collider use, so the tree sits ON the ground, not floating or buried).
      let position = input.position;
      if (position === undefined) {
        let terrainId = input.terrain;
        if (terrainId === undefined) { let last: string | undefined; for (const k of layers.keys()) last = k; terrainId = last; }
        const layer = terrainId !== undefined ? layers.get(terrainId) : undefined;
        if (layer !== undefined) {
          const t = layer.tile;
          const centre = Math.floor((t.nrows - 1) / 2) * t.ncols + Math.floor((t.ncols - 1) / 2);
          position = [t.origin[0], t.origin[1] + (t.heights[centre] ?? 0) * t.scale[1], t.origin[2]];
        } else {
          position = [0, 0, 0];
        }
      }

      const { entity } = await loadGltfIntoScene(ctx as never, assetId, resolved.bytes, resolved.hash, {
        position,
        rotationEuler: [0, input.yaw, 0],
        scale: [input.scale, input.scale, input.scale],
      });

      tagEntity(ctx as never, entity, ["tree", input.species, ...(input.tags ?? [])]);
      ctx.emit("vegetation.planted", { entity, species: input.species, assetId, position });
      return { entity, assetId, assetHash: resolved.hash };
    },
  };

  registry.register(plant as unknown as Parameters<SkillRegistry["register"]>[0]);
}
