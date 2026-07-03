// vegetation.scatter — scatter a forest of tree archetypes across an EDITABLE terrain layer.
// Reuses the deterministic, slope/elevation-gated scatterAssets over the layer's heightfield
// (the same machinery asset.scatter uses over generated regions), and mounts instanced trees
// from the TEXTURED ez-tree GLB archetypes (tools/bake-trees-browser.mjs). Deterministic +
// recorded: the log carries the config + pinned asset hashes, NEVER the instance transforms —
// replay recomputes identical placements over the same (recorded) terrain ops.

import { z } from "../../build/zod.bundle.mjs";
import { MAX_ENTITIES, despawnRenderable, spawnRenderable } from "../ecs/world.ts";
import type { Transformable } from "../ecs/world.ts";
import { scatterAssets, type AssetInstance, type ScatterConfig } from "../terrain/asset-scatter.ts";
import { buildAssetInstancedMeshes, disposeAssetInstancedMesh } from "../terrain/asset-scatter-render.ts";
import { parseGltfScene } from "./three.ts";
import type { AssetRegistry } from "../asset-registry.ts";
import type { SkillDefinition, SkillRegistry } from "./registry.ts";
import type { EditableTerrain } from "./terrain-edit.ts";

const inertTransform = (): Transformable => ({ position: { set() {} }, quaternion: { set() {} }, scale: { set() {} } });

/** Default boreal archetype palette — the textured GLBs from tools/bake-trees-browser.mjs. */
const SPECIES_ARCHETYPES: Record<string, string[]> = {
  spruce: ["trees/spruce-1.glb", "trees/spruce-2.glb"],
  pine: ["trees/pine-1.glb", "trees/pine-2.glb"],
  birch: ["trees/birch-1.glb", "trees/birch-2.glb"],
};

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
});

type SceneLike = { add?: (o: unknown) => void; remove?: (o: unknown) => void };
type InstMesh = { castShadow: boolean; receiveShadow: boolean };

export function registerVegetationSkills(
  registry: SkillRegistry,
  layers: Map<string, EditableTerrain>,
  assets: AssetRegistry,
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
      };

      // Deterministic placements over the editable heightfield (Y = surface, slope/elevation gated).
      const placements: AssetInstance[] = scatterAssets(layer.tile, input.seed, config);

      // Mount instanced trees from the textured archetypes — browser render context only (the
      // headless authoritative context has a stub scene; it records + replays without meshes).
      const scene = ctx.world.scene as SceneLike | undefined;
      let mountedCount = 0;
      const meshes: unknown[] = [];
      if (ctx.world.mode !== "headless" && scene !== undefined && typeof scene.add === "function") {
        const byId = new Map<string, AssetInstance[]>();
        for (const inst of placements) {
          let list = byId.get(inst.assetId);
          if (list === undefined) { list = []; byId.set(inst.assetId, list); }
          list.push(inst);
        }
        for (const [id, list] of byId) {
          const root = await parseGltfScene(id, assets.resolve(id).bytes);
          for (const mesh of buildAssetInstancedMeshes(root, list)) {
            (mesh as unknown as InstMesh).castShadow = true;
            (mesh as unknown as InstMesh).receiveShadow = true;
            scene.add(mesh);
            meshes.push(mesh);
            mountedCount++;
          }
        }
      }

      // A forest handle entity (world-integrated + removable), anchored at the terrain origin.
      const [ox, oy, oz] = layer.tile.origin;
      const eid = spawnRenderable(ctx.world.ecs, inertTransform(), ox, oy, oz);
      if (eid >= MAX_ENTITIES) { despawnRenderable(ctx.world.ecs, eid); throw new Error("vegetation.scatter: entity capacity exceeded"); }
      const origin = { tool: "vegetation.scatter", input: { ...input } };
      const entity = ctx.world.entities.create({ eid, origin });
      if (meshes.length > 0) {
        mounted.set(entity, () => {
          for (const m of meshes) { if (typeof scene?.remove === "function") scene.remove(m); disposeAssetInstancedMesh(m as never); }
        });
      }

      ctx.emit("vegetation.scattered", { entity, terrain: terrainId, instances: placements.length, mounted: mountedCount });
      return { entity, instances: placements.length, assetHashes, placements };
    },
  };

  registry.register(scatter as unknown as Parameters<SkillRegistry["register"]>[0]);
}
