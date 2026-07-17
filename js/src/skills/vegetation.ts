// vegetation.scatter — scatter a forest of tree archetypes across an EDITABLE terrain layer.
// Reuses the deterministic, slope/elevation-gated scatterAssets over the layer's heightfield
// (the same machinery asset.scatter uses over generated regions), and mounts instanced trees
// from the TEXTURED ez-tree GLB archetypes (tools/bake-trees-browser.mjs). Deterministic +
// recorded: the log carries the config + pinned asset hashes, NEVER the instance transforms —
// replay recomputes identical placements over the same (recorded) terrain ops.

import { z } from "../../build/zod.bundle.mjs";
import { MAX_ENTITIES, despawnRenderable, spawnRenderable } from "../ecs/world.ts";
import type { Transformable } from "../ecs/world.ts";
import { scatterAssets, type AssetInstance, type ScatterConfig, type ScatterExclusion, type ScatterTreeLod } from "../terrain/asset-scatter.ts";
import { buildAssetInstancedMeshes, disposeAssetInstancedMesh } from "../terrain/asset-scatter-render.ts";
import { TreePopulationRuntime } from "../render/tree-population-runtime.ts";
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

// ───────────────────────── THE ENGINE NEVER NAMES A TREE GLB ─────────────────────────
// A species (spruce/pine/birch) is a semantic ROLE; a PROJECT supplies a VEGETATION PACK
// (tree-pack.json) binding each species to concrete archetype asset ids. The engine ships NO pack
// and bakes NO tree ids — an absent/invalid pack is GRACEFUL (empty), so an engine with no project
// vegetation content plants nothing rather than naming a baked GLB. A caller may also pass an inline
// `assets` palette per call, which wins over the pack.

/** One weighted archetype binding in a project's VEGETATION PACK: a concrete tree asset id. */
export interface VegetationPackEntry { id: string; weight?: number; treeLod?: ScatterTreeLod; }

/** A project's binding of species → archetype asset ids. Read from tree-pack.json (the SAME sandboxed
 *  host op asset-catalog.ts / the biome pack use). Partial: an unmapped species → empty palette. */
export type VegetationPack = Record<string, VegetationPackEntry[]>;

/** The empty pack — the default when a project supplies none. Every species unmapped → nothing plants. */
export const EMPTY_VEGETATION_PACK: VegetationPack = {};

const treeLodSchema = z.object({
  reducedId: z.string().min(1),
  reducedDistance: z.number().positive(),
  impostorId: z.string().min(1),
  impostorDistance: z.number().positive(),
  cullDistance: z.number().positive(),
  hysteresis: z.number().nonnegative().optional(),
}).refine((value) => value.reducedDistance < value.impostorDistance && value.impostorDistance < value.cullDistance,
  { message: "treeLod distances must be strictly increasing" });
const vegetationPackEntrySchema = z.object({ id: z.string().min(1), weight: z.number().positive().optional(), treeLod: treeLodSchema.optional() });
const vegetationPackSchema = z.record(z.string(), z.array(vegetationPackEntrySchema));

/** Read + parse the project VEGETATION PACK (tree-pack.json) via the sandboxed host asset op.
 *  Tolerates a missing/unreadable/unparsable file (→ empty pack), exactly like asset-catalog's seed
 *  loader and the biome pack — an engine with no project pack degrades to "no species ids", never a
 *  throw. Sync host op (no async I/O in a handler), static project content → deterministic on replay. */
export function loadVegetationPack(ops: { op_read_asset(id: string): Uint8Array }): VegetationPack {
  try {
    const bytes = ops.op_read_asset("tree-pack.json");
    const parsed = vegetationPackSchema.safeParse(JSON.parse(new TextDecoder().decode(bytes)));
    if (parsed.success) return parsed.data;
  } catch {
    // Missing/unreadable/unparsable pack — fall back to an empty pack.
  }
  return {};
}

/** Resolve a species selection (or an explicit inline palette) to a concrete, de-duplicated list of
 *  archetype ids. An inline `assets` palette wins; otherwise each species is looked up in the pack;
 *  an unmapped species contributes nothing (graceful). Order-preserving so the seed→variant pick and
 *  the scatter placement stay deterministic. */
export function speciesPaletteEntries(species: string[], explicit: VegetationPackEntry[] | undefined, pack: VegetationPack): VegetationPackEntry[] {
  const entries = explicit !== undefined && explicit.length > 0 ? explicit : species.flatMap((s) => pack[s] ?? []);
  const byId = new Map<string, VegetationPackEntry>();
  for (const entry of entries) {
    const previous = byId.get(entry.id);
    if (previous !== undefined && (previous.treeLod !== undefined || entry.treeLod !== undefined)) {
      throw new RangeError(`vegetation: treeLod-enabled archetype '${entry.id}' must be unique`);
    }
    if (previous === undefined) byId.set(entry.id, entry);
  }
  return [...byId.values()];
}

export function speciesPaletteIds(species: string[], explicit: VegetationPackEntry[] | undefined, pack: VegetationPack): string[] {
  return speciesPaletteEntries(species, explicit, pack).map((entry) => entry.id);
}

/** Pick one archetype id from a resolved palette deterministically from `seed`. */
export function pickArchetype(palette: string[], seed: number): string {
  if (palette.length === 0) throw new Error("vegetation: empty archetype palette");
  const i = ((seed % palette.length) + palette.length) % palette.length;
  return palette[i];
}

/** Inline per-call archetype palette — a caller-supplied binding that wins over the project pack. */
const paletteAssetSchema = vegetationPackEntrySchema;

const scatterInput = z.object({
  /** Terrain layer to scatter on. Defaults to the most recently created one. */
  terrain: z.string().optional(),
  /** Species to include (weighted equally). Resolved to concrete archetype ids via the project
   *  VEGETATION PACK (tree-pack.json). Defaults to all. Ignored when `assets` is supplied. */
  species: z.array(z.enum(["spruce", "pine", "birch", "oak", "ash", "dead-oak"])).optional(),
  /** Explicit archetype palette — a caller/project binding that WINS over the pack. When set, the
   *  forest is scattered from these ids directly (the engine bakes no tree ids of its own). */
  assets: z.array(paletteAssetSchema).optional(),
  /** Candidate samples per grid axis (placement density). The ceiling matters on LARGE tiles:
   *  at 64 a 1.4km tile gets ~24m candidate spacing — a painted forest region can never reach
   *  canopy density. 192 allows ~7m spacing there; placements are instanced, thousands are cheap. */
  density: z.number().int().min(1).max(192).default(16),
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
  /** Keep-IN discs (world XZ) — when set, a tree spawns ONLY inside at least one disc (the same
   *  scatter region gate the lawn/grass skills use). Confines a forest to authored regions (e.g.
   *  a map's painted forest polygons, disc-covered by the caller) instead of the whole tile. */
  inclusions: z.array(z.object({ x: z.number(), z: z.number(), r: z.number().nonnegative() })).optional(),
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
  /** Shared VEGETATION-CLEAR registry (keyed by terrain id). This scatter registers a re-mount
   *  closure that recomputes its placements against the terrain's CURRENT footprints and swaps its
   *  instanced meshes. village.build invokes it after computing footprints, so a forest scattered
   *  on the natural terrain FIRST is subtractively cleared where the settlement then builds. */
  vegetationClears: Map<string, Array<() => void | Promise<void>>> = new Map(),
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
      const terrainKey = terrainId as string;

      // Per-instance BLIGHT lookup over the layer's caesura mask (nearest cell). A tree whose base sits
      // inside painted blight renders DEAD (bare + colour-drained) — the canopy dies with the ground.
      // 0 everywhere when the layer carries no blight, so a clean map scatters an all-living forest.
      // Deterministic: the mask is a pure function of the recorded map, so replay re-splits identically.
      const bt = layer.tile;
      const blightGrid = bt.blight;
      const blightAtWorld = (x: number, z: number): number => {
        if (blightGrid === undefined) return 0;
        const bx0 = bt.origin[0] - bt.scale[0] / 2, bz0 = bt.origin[2] - bt.scale[2] / 2;
        const col = Math.max(0, Math.min(bt.ncols - 1, Math.round((x - bx0) / (bt.scale[0] / (bt.ncols - 1)))));
        const row = Math.max(0, Math.min(bt.nrows - 1, Math.round((z - bz0) / (bt.scale[2] / (bt.nrows - 1)))));
        return blightGrid[row * bt.ncols + col];
      };

      // Resolve the archetype palette: an inline `assets` palette wins; otherwise the requested
      // species are looked up in the project VEGETATION PACK (tree-pack.json). The engine bakes NO
      // tree ids — with neither an inline palette nor a pack binding, the skill errors (no silent
      // empty forest). The pack read is a sync host op over static content → deterministic on replay.
      const species = input.species ?? ["spruce", "pine", "birch"];
      const pack = input.assets !== undefined && input.assets.length > 0 ? EMPTY_VEGETATION_PACK : loadVegetationPack(ctx.world.ops);
      const paletteEntries = speciesPaletteEntries(species, input.assets, pack);
      const paletteIds = paletteEntries.map((entry) => entry.id);
      const paletteById = new Map(paletteEntries.map((entry) => [entry.id, entry]));
      if (paletteIds.length === 0) throw new Error("vegetation.scatter: no archetypes — pass assets:[...] or install a tree-pack.json binding the requested species");
      const treeEntries = paletteEntries.filter((entry) => entry.treeLod !== undefined);
      if (treeEntries.length > 12) throw new RangeError("vegetation.scatter: treeLod palette exceeds the 12-species runtime cap");

      // Content-address (pin) every palette asset — a swapped archetype is rejected on replay.
      const assetHashes: Record<string, string> = {};
      for (const entry of paletteEntries) {
        assetHashes[entry.id] = assets.resolve(entry.id).hash;
        if (entry.treeLod !== undefined) {
          assetHashes[entry.treeLod.reducedId] = assets.resolve(entry.treeLod.reducedId).hash;
          assetHashes[entry.treeLod.impostorId] = assets.resolve(entry.treeLod.impostorId).hash;
        }
      }

      // Default the elevation FLOOR to the layer's sea level (exactly like grass, grass.ts) so a
      // forest never wades into water — the low basins are lakebeds, not planting ground. An
      // explicit `elevationMin` overrides. seaLevel = the generated waterline (elevationColors),
      // or the terrain's lowest point for a plain slab with no generated sea. A pure function of
      // the layer's heights, so replay recomputes the identical floor.
      let loH = Infinity;
      for (let i = 0; i < layer.tile.heights.length; i++) { const v = layer.tile.heights[i]; if (v < loH) loH = v; }
      const seaLevel = layer.elevationColors?.seaLevel ?? (layer.tile.origin[1] + loH);
      // Large conifers (spruce/pine/birch) must fully CLEAR the water — a whole-tree margin above the
      // waterline, not just the trunk base, so no big trunk stands in a lake. (A future shallow-water
      // species tier — reeds/mangrove/shrub — will floor LOWER, at ~seaLevel, so small growth can wade
      // into the shallows; large-tree species keep this clearance.) Explicit elevationMin still overrides.
      const elevationMinDefault = seaLevel + 1.5;

      // Placements are a PURE function of the terrain + the terrain's CURRENT footprints (unioned
      // with any explicit exclusions). Computing them fresh on each (re)mount means the SAME closure
      // grows the full forest when no village exists yet AND re-grows the CLEARED forest once
      // village.build has registered its footprints — the causal "veg first, then civilization
      // clears" order. Deterministic + replay-safe: footprints + scatter are pure over the log.
      const computePlacements = (): AssetInstance[] => {
        const registered = footprints.get(terrainKey) ?? [];
        const allExclusions: ScatterExclusion[] = [...registered, ...(input.exclusions ?? [])];
        const config: ScatterConfig = {
          seed: input.seed,
          density: input.density,
          assets: paletteIds.map((id) => ({ id })),
          slopeMax: input.slopeMax,
          sizeRange: input.sizeRange,
          coverage: input.coverage,
          cluster: input.cluster,
          elevationMin: input.elevationMin ?? elevationMinDefault,
          ...(input.elevationMax !== undefined ? { elevationMax: input.elevationMax } : {}),
          ...(allExclusions.length > 0 ? { exclusions: allExclusions } : {}),
          ...(input.inclusions !== undefined && input.inclusions.length > 0 ? { inclusions: input.inclusions } : {}),
        };
        return scatterAssets(layer.tile, input.seed, config);
      };

      const scene = ctx.world.scene as SceneLike | undefined;
      // Gated on NON-headless mode: the forest's per-archetype mount awaits nextFrame() (to avoid
      // blocking the main thread / tripping the browser watchdog), which never fires on the headless
      // authoritative server — so the server must NOT enter the mount path (it would hang). The browser
      // re-authors from the RETURNED placements, so the carve must be baked into computePlacements at
      // author time (scatter reads the terrain's already-registered settlement footprints), NOT deferred
      // to the post-village subtractive remount. See build order: register footprints before scattering.
      const canRender = ctx.world.mode !== "headless" && scene !== undefined && typeof scene.add === "function";
      // Live set of this forest's instanced meshes — mutated in place by (re)mount so the removal
      // closure + the clear closure both see the current set.
      let meshes: unknown[] = [];
      let treePopulations: TreePopulationRuntime[] = [];
      const worldLods = (ctx.world.lods ??= []);
      let mountedDraws = 0;
      let placements: AssetInstance[] = computePlacements();
      let active = true;
      let entity = "";
      let clear: (() => Promise<void>) | undefined;

      const disposeMeshes = (): void => {
        const errors: unknown[] = [];
        const owned = meshes;
        const ownedTrees = treePopulations;
        meshes = [];
        treePopulations = [];
        mountedDraws = 0;
        for (const population of ownedTrees) {
          const index = worldLods.indexOf(population);
          if (index >= 0) worldLods.splice(index, 1);
          try { population.dispose(); } catch (error) { errors.push(error); }
        }
        for (const m of owned) {
          try { if (typeof scene?.remove === "function") scene.remove(m); } catch (error) { errors.push(error); }
          try { disposeAssetInstancedMesh(m as never); } catch (error) { errors.push(error); }
        }
        if (errors.length > 0) throw new AggregateError(errors, `vegetation forest disposal failed in ${errors.length} operation(s)`);
      };

      // (Re)mount the forest from freshly-computed placements. Drops any previously-mounted meshes
      // first (the subtractive clear: after village.build registers footprints, the recompute yields
      // the forest MINUS the instances on the settlement — a strict subset — and the old full set is
      // disposed). CRASH-PROOF per archetype (a bad GLB never kills the apply loop).
      const remount = async (): Promise<void> => {
        if (!active) return;
        placements = computePlacements();
        if (!canRender) return;
        const byId = new Map<string, AssetInstance[]>();
        for (const inst of placements) {
          let list = byId.get(inst.assetId);
          if (list === undefined) { list = []; byId.set(inst.assetId, list); }
          list.push(inst);
        }
        let treePlacementCount = 0;
        for (const [id, list] of byId) if (paletteById.get(id)?.treeLod !== undefined) treePlacementCount += list.length;
        if (treePlacementCount > 24_576) throw new RangeError("vegetation.scatter: treeLod placements exceed the 24,576 active-tree cap");
        // Validate the complete replacement before retiring the live forest. Capacity rejection
        // therefore preserves the prior publication instead of leaving a cleared viewport.
        disposeMeshes();
        // Mount ONE archetype per frame: parsing a dense GLB + uploading its InstancedMesh to the
        // GPU is heavy; doing all six back-to-back blocks the main thread long enough to trip the
        // browser's unresponsive-page watchdog / lose the WebGPU device (the reported "crash").
        let idx = 0;
        const totalArchetypes = byId.size;
        for (const [id, list] of byId) {
          if (!active) return;
          idx++;
          ctx.emit("vegetation.mounting", { archetype: id, index: idx, total: totalArchetypes, instances: list.length });
          try {
            const entry = paletteById.get(id);
            if (entry === undefined) throw new Error(`vegetation.scatter: placement references unknown archetype '${id}'`);
            if (entry.treeLod !== undefined) {
              const [baseRoot, reducedRoot, impostorRoot] = await Promise.all([
                parseGltfScene(id, assets.resolve(id).bytes, ctx.world.gltfCache),
                parseGltfScene(entry.treeLod.reducedId, assets.resolve(entry.treeLod.reducedId).bytes, ctx.world.gltfCache),
                parseGltfScene(entry.treeLod.impostorId, assets.resolve(entry.treeLod.impostorId).bytes, ctx.world.gltfCache),
              ]);
              const population = new TreePopulationRuntime({ speciesId: id, placements: list, treeLod: entry.treeLod,
                sourceHash: assetHashes[id]!, reducedHash: assetHashes[entry.treeLod.reducedId]!,
                baseRoot, reducedRoot, impostorRoot, scene: scene!,
                onError: (error) => ctx.emit("vegetation.tree_population_error", { archetype: id, message: error instanceof Error ? error.message : String(error) }) });
              if (!active) { population.dispose(); return; }
              treePopulations.push(population);
              worldLods.push(population);
              population.update(ctx.world.camera);
              mountedDraws += population.draws;
              await nextFrame();
              continue;
            }
            const root = await parseGltfScene(id, assets.resolve(id).bytes, ctx.world.gltfCache);
            // Chunk this archetype's instances into 96 m cells — a forest can span an entire terrain
            // layer/map, and without chunking one whole-scatter bounding sphere would (almost) always
            // intersect the frustum, defeating culling even once the sphere itself is correct (see
            // asset-scatter-render.ts's chunkSize doc). Other buildAssetInstancedMeshes callers
            // (asset.scatter props, village dressing) are already spatially bounded and don't opt in.
            // Split this archetype's instances by the caesura mask: living trees mount whole, blighted
            // ones mount DEAD (bare + drained). A clean map has no blight → the `dead` list is empty and
            // the mount is byte-identical to before.
            const living: AssetInstance[] = [];
            const dead: AssetInstance[] = [];
            for (const inst of list) (blightAtWorld(inst.x, inst.z) > 0.5 ? dead : living).push(inst);
            for (const variant of [{ set: living, dead: false }, { set: dead, dead: true }]) {
              if (variant.set.length === 0) continue;
              for (const mesh of buildAssetInstancedMeshes(root, variant.set, { chunkSize: 96, ...(variant.dead ? { dead: true } : {}) })) {
                (mesh as unknown as InstMesh).castShadow = true;
                (mesh as unknown as InstMesh).receiveShadow = true;
                if (!active) { disposeAssetInstancedMesh(mesh); continue; }
                scene?.add?.(mesh);
                meshes.push(mesh);
                mountedDraws++;
              }
            }
          } catch (err) {
            ctx.emit("vegetation.mount_failed", { archetype: id, message: err instanceof Error ? err.message : String(err) });
          }
          await nextFrame();
        }
      };

      await remount();

      // A forest handle entity (world-integrated + removable), anchored at the terrain origin.
      const [ox, oy, oz] = layer.tile.origin;
      const eid = spawnRenderable(ctx.world.ecs, inertTransform(), ox, oy, oz);
      if (eid >= MAX_ENTITIES) {
        active = false;
        const cleanup: unknown[] = [];
        try { disposeMeshes(); } catch (error) { cleanup.push(error); }
        try { despawnRenderable(ctx.world.ecs, eid); } catch (error) { cleanup.push(error); }
        const primary = new Error("vegetation.scatter: entity capacity exceeded");
        if (cleanup.length > 0) throw new AggregateError([primary, ...cleanup], `vegetation.scatter capacity rejection and ${cleanup.length} cleanup operation(s) failed`);
        throw primary;
      }
      const origin = { tool: "vegetation.scatter", input: { ...input } };
      const runtimeDispose = (): void => {
        if (!active) return;
        active = false;
        mounted.delete(entity);
        if (clear !== undefined) {
          const registered = vegetationClears.get(terrainKey);
          const index = registered?.indexOf(clear) ?? -1;
          if (index >= 0) registered!.splice(index, 1);
          if (registered?.length === 0) vegetationClears.delete(terrainKey);
        }
        disposeMeshes();
      };
      try {
        entity = ctx.world.entities.create({ eid, origin, runtimeDispose });
        tagEntity(ctx as never, entity, ["forest", "vegetation", ...(input.tags ?? [])]);
        // Keep the removal closure pointed at the LIVE mesh set (mutated by remount).
        mounted.set(entity, runtimeDispose);
        // Register the subtractive-clear closure: village.build calls it after registering footprints,
        // so a forest scattered before the village is re-grown with the settlement footprints carved out.
        const clears = vegetationClears.get(terrainKey) ?? [];
        clear = async () => { await remount(); };
        clears.push(clear);
        vegetationClears.set(terrainKey, clears);
      } catch (error) {
        const cleanup: unknown[] = [];
        try { runtimeDispose(); } catch (cleanupError) { cleanup.push(cleanupError); }
        if (entity !== "") {
          try { ctx.world.entities.destroy(entity); } catch (cleanupError) { cleanup.push(cleanupError); }
        }
        try { despawnRenderable(ctx.world.ecs, eid); } catch (cleanupError) { cleanup.push(cleanupError); }
        if (cleanup.length > 0) throw new AggregateError([error, ...cleanup], `vegetation.scatter publication and ${cleanup.length} rollback operation(s) failed`);
        throw error;
      }

      ctx.emit("vegetation.scattered", { entity, terrain: terrainKey, instances: placements.length, mounted: mountedDraws });
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
    /** Which tree to plant. Resolved to a concrete archetype via the project VEGETATION PACK
     *  (tree-pack.json) unless an explicit `assets` palette is supplied. */
    species: z.enum(["spruce", "pine", "birch", "oak", "ash", "dead-oak"]).default("spruce"),
    /** Explicit archetype palette — a caller/project binding that WINS over the pack. When set, the
     *  archetype is chosen from these ids (the engine bakes no tree ids of its own). */
    assets: z.array(paletteAssetSchema).optional(),
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
      // Resolve the archetype palette: an inline `assets` palette wins; otherwise the species is
      // looked up in the project VEGETATION PACK (tree-pack.json). The engine bakes NO tree ids —
      // with neither, the skill errors (no silent success). Pack read is a sync host op → replay-safe.
      const pack = input.assets !== undefined && input.assets.length > 0 ? EMPTY_VEGETATION_PACK : loadVegetationPack(ctx.world.ops);
      const paletteIds = speciesPaletteIds([input.species], input.assets, pack);
      if (paletteIds.length === 0) throw new Error(`vegetation.plant: no archetypes for species '${input.species}' — pass assets:[...] or install a tree-pack.json binding it`);
      const assetId = pickArchetype(paletteIds, input.seed);
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
