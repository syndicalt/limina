// Phase 11 — the asset.* skill seam: place a curated GLTF asset BY ID at a
// transform. The id resolves through the content-addressed AssetRegistry
// (js/src/asset-registry.ts) to its bytes + content hash, then loads through THE
// SAME glTF pipeline as three.loadGLTF (loadGltfIntoScene — one loader, one
// WebGPU texture-rehome, no duplication).
//
// THE RECORD/REPLAY SPINE (same as terrain's world.generateRegion): asset.place is
// a SKILL, so the world log records its REQUEST — { assetId, position, rotation,
// scale, hash } — as a single command. NEVER the instance bytes. The recorder
// COMMITS the resolved content hash into the recorded command (via commitFields),
// so the log PINS the authored asset identity: on replay the resolved bytes are
// verified against that committed hash and a swapped asset fails loudly. The bytes
// ride the registry/export package (content-addressed assets.jsonl), never the log.

import { z } from "../../build/zod.bundle.mjs";
import { AssetRegistry } from "../asset-registry.ts";
import { gltfResourceSchema, loadGltfIntoScene, parseGltfScene } from "./three.ts";
import { scatterAssets, type AssetInstance, type ScatterConfig } from "../terrain/asset-scatter.ts";
import { buildAssetInstancedMeshes } from "../terrain/asset-scatter-render.ts";
import type { TerrainSource, TileRequest } from "../terrain/types.ts";
import { TileCache } from "../terrain/tilecache.ts";
import type { RegionState } from "./terrain.ts";
import type { SkillDefinition, SkillRegistry } from "./registry.ts";

const Vec3 = z.tuple([z.number(), z.number(), z.number()]);

const placeInput = z.object({
  assetId: z.string(),
  position: Vec3.default([0, 0, 0]),
  /** Euler radians (x,y,z). */
  rotation: Vec3.optional(),
  scale: Vec3.optional(),
  /** Optional PBR overrides applied across the placed glTF's meshes. */
  material: z.object({
    color: z.number().int().min(0).max(0xffffff).optional(),
    roughness: z.number().min(0).max(1).optional(),
    metalness: z.number().min(0).max(1).optional(),
  }).optional(),
  /** The COMMITTED content address ("sha256:...") of the asset. Absent at
   *  authoring (resolved + returned), then committed into the recorded command by
   *  the recorder. Present on REPLAY: the resolved bytes are verified against it so
   *  the authored asset identity is pinned (a swapped/updated asset is rejected). */
  hash: z.string().optional(),
});

/** Permission scope for asset.place — also the scope handed to its nested
 *  three.setMaterial invoke (least-privilege: the override runs under asset.place's
 *  OWN declared capability, not the caller's full grant set). */
const PLACE_PERMS = ["scene.write"] as const;

/** The agent-set ScatterConfig (Zod) — a curated asset palette + the elevation/
 *  slope/climate rules. Recorded VERBATIM in the world log as the scatter request. */
const scatterConfigSchema = z.object({
  seed: z.number().int(),
  density: z.number().int().min(1).max(64).optional(),
  assets: z.array(z.object({ id: z.string(), weight: z.number().positive().optional() })).min(1),
  elevationMin: z.number().optional(),
  elevationMax: z.number().optional(),
  slopeMax: z.number().nonnegative().optional(),
  sizeRange: z.tuple([z.number().positive(), z.number().positive()]).optional(),
  coverage: z.number().min(0).max(1).optional(),
  biomes: z.array(z.number().int()).optional(),
  tempMin: z.number().optional(),
  tempMax: z.number().optional(),
});

const scatterInput = z.object({
  /** The handle of an ALREADY-GENERATED region (from world.generateRegion). The
   *  scatter is BOUND to that region — its seed/lod + the tiles it applied — so
   *  placements provably sit on the visible, exported surface (no free-floating
   *  scatter seed that could silently miss onto a different world). */
  regionId: z.string(),
  config: scatterConfigSchema,
  /** The COMMITTED content addresses of the palette assets (id -> "sha256:..."),
   *  pinning authored identity. Absent at authoring (resolved + returned, then
   *  committed back by the recorder); present on REPLAY where each resolved asset is
   *  verified against it so a swapped asset is rejected (mirrors asset.place.hash). */
  assetHashes: z.record(z.string(), z.string()).optional(),
});

/** Terrain wiring for asset.scatter — the SAME deterministic source + cache + region
 *  table the terrain.* skills use, so a scatter binds to the generated region's
 *  applied tiles (a replay re-resolves identical tiles from the same shared cache). */
export interface ScatterTerrain {
  source: TerrainSource;
  cache?: TileCache;
  regions: Map<string, RegionState>;
}

/** Register the asset.* skills bound to a content-addressed AssetRegistry. The
 *  default core wiring constructs a registry over the host ops; a runtime may pass
 *  its own (e.g. a package-backed AssetRegistry.fromBundle for replay/browser).
 *  `terrain` wires asset.scatter to the deterministic terrain source/cache. */
export function registerAssetSkills(registry: SkillRegistry, assets: AssetRegistry, terrain?: ScatterTerrain): void {
  const place: SkillDefinition<z.infer<typeof placeInput>, { entity: string; hash: string; resource: z.infer<typeof gltfResourceSchema> }> = {
    name: "asset.place",
    version: "1.0.0",
    description: "Place a curated glTF asset BY ID at a transform. Resolves the id through the content-addressed asset registry, loads it via the shared glTF pipeline, and spawns an entity. The world log records the REQUEST (assetId + transform + committed content hash); the bytes ride the registry/export package. Returns the entity id + content hash.",
    category: "three",
    permissions: [...PLACE_PERMS],
    // The recorder copies these OUTPUT fields into the recorded command's input so
    // the replay log COMMITS to the resolved content hash (pins authored identity).
    commitFields: ["hash"],
    input: placeInput,
    output: z.object({ entity: z.string(), hash: z.string(), resource: gltfResourceSchema }),
    handler: async (input, ctx) => {
      // Content-addressed resolve: id -> bytes + stable hash (the asset's portable
      // identity). Same id -> same content address on every resolve/replay.
      const resolved = assets.resolve(input.assetId);
      // Replay/pinned path: a committed hash MUST match the resolved bytes, else the
      // authored asset was swapped/updated out from under the log — fail loudly.
      if (input.hash !== undefined && input.hash !== resolved.hash) {
        throw new Error(`asset.place: '${input.assetId}' content hash mismatch (committed ${input.hash}, resolved ${resolved.hash}) — authored asset identity changed`);
      }
      const { entity, resource } = await loadGltfIntoScene(ctx, input.assetId, resolved.bytes, resolved.hash, {
        position: input.position,
        rotationEuler: input.rotation,
        scale: input.scale,
      });
      // Optional material override (reuses three.setMaterial's apply, by id). Scoped
      // to asset.place's OWN declared permission, NOT the caller's full grant set.
      if (input.material !== undefined) {
        const res = await registry.invoke("three.setMaterial", { entity, ...input.material }, {
          agentId: ctx.agentId, sessionId: ctx.sessionId, permissions: new Set<string>(PLACE_PERMS), tick: ctx.tick, world: ctx.world,
        });
        if (!res.success) throw new Error(`asset.place: material override failed: ${JSON.stringify(res.error)}`);
      }
      // Record the REQUEST on the trace/log: assetId + transform + content hash,
      // never bytes. This is the durable, replayable, exportable place command.
      ctx.emit("asset.placed", {
        assetId: input.assetId,
        hash: resolved.hash,
        position: input.position,
        rotation: input.rotation ?? null,
        scale: input.scale ?? null,
        entity,
      });
      return { entity, hash: resolved.hash, resource };
    },
  };

  registry.register(place);

  // ---- asset.scatter -------------------------------------------------------
  // Scatter curated assets BY ID across a tile-grid region under an agent-set
  // ScatterConfig. The placements are a PURE function of (seed, bounds, lod, config)
  // over deterministic tiles, so the log records only the CONFIG (the request) — the
  // instance transforms are recomputed on replay. The palette assets ride the same
  // content-addressed registry/export as asset.place, with their hashes pinned.
  const scatterOutput = z.object({
    regionId: z.string(),
    instances: z.number().int(),
    mounted: z.number().int(),
    assetHashes: z.record(z.string(), z.string()),
    /** The computed placements (render/inspection). NOT logged — recomputed on replay. */
    placements: z.array(z.object({
      assetId: z.string(), x: z.number(), y: z.number(), z: z.number(), yaw: z.number(), scale: z.number(),
    })),
  });
  const scatter: SkillDefinition<z.infer<typeof scatterInput>, z.infer<typeof scatterOutput>> = {
    name: "asset.scatter",
    version: "1.0.0",
    description: "Scatter curated glTF assets BY ID across an ALREADY-GENERATED region (by regionId) under an agent-set ScatterConfig (palette + density + elevation/slope/climate rules). Bound to the region's seed/lod + applied tiles, so placements sit on the visible, exported surface. Deterministic + replay-safe: the world log records the regionId + ScatterConfig REQUEST (+ pinned asset hashes), NEVER the instance transforms, which replay recomputes over the SAME baked/cached tiles. Mounts one InstancedMesh per asset mesh. Returns the placement count + pinned hashes.",
    category: "three",
    permissions: [...PLACE_PERMS],
    // The recorder copies the resolved per-asset content hashes back into the recorded
    // command's input, so the replay log PINS authored identity for every palette asset.
    commitFields: ["assetHashes"],
    input: scatterInput,
    output: scatterOutput,
    handler: async (input, ctx) => {
      if (terrain === undefined) throw new Error("asset.scatter: no terrain bound (register with a ScatterTerrain)");
      const source = terrain.source;
      const cache = terrain.cache ?? new TileCache();
      const config = input.config as ScatterConfig;

      // BIND to the generated region: its seed/lod + the tiles it actually applied.
      // A scatter can never float onto a different surface from a stray seed — an
      // unknown region (not generated, or generateRegion not yet replayed) fails loudly.
      const region = terrain.regions.get(input.regionId);
      if (region === undefined) {
        throw new Error(`asset.scatter: unknown region '${input.regionId}' — generate it with world.generateRegion first`);
      }

      // Resolve + PIN every palette asset (content-addressed). A committed hash must
      // match the resolved bytes, else a swapped asset is rejected (mirrors asset.place).
      const assetHashes: Record<string, string> = {};
      for (const id of new Set(config.assets.map((a) => a.id))) {
        const resolved = assets.resolve(id);
        const committed = input.assetHashes?.[id];
        if (committed !== undefined && committed !== resolved.hash) {
          throw new Error(`asset.scatter: '${id}' content hash mismatch (committed ${committed}, resolved ${resolved.hash}) — authored asset identity changed`);
        }
        assetHashes[id] = resolved.hash;
      }

      // Scatter over the region's APPLIED tiles, in a fixed (tz,tx) order so the
      // instance sequence is reproducible. Each tile is resolved from the SHARED cache
      // world.generateRegion populated — the same tiles that ride the export's
      // tiles.jsonl — so a replay over baked tiles (model source absent) is identical.
      const tiles = [...region.tiles.values()].sort((a, b) => (a.tz - b.tz) || (a.tx - b.tx));
      const placements: AssetInstance[] = [];
      for (const t of tiles) {
        const req: TileRequest = { seed: region.seed, tx: t.tx, tz: t.tz, lod: region.lod, hints: region.hints };
        const tile = await cache.resolve(req, source);
        for (const inst of scatterAssets(tile, region.seed, config)) placements.push(inst);
      }

      // Mount per-asset InstancedMeshes (UAT render): group by asset id, parse each
      // asset's glTF ONCE through the shared loader, and instance its meshes. Best-
      // effort — the deterministic placements + the logged config are the contract.
      let mounted = 0;
      const scene = ctx.world.scene as { add?: (o: unknown) => void } | undefined;
      if (scene !== undefined && typeof scene.add === "function") {
        const byId = new Map<string, AssetInstance[]>();
        for (const inst of placements) {
          let list = byId.get(inst.assetId);
          if (list === undefined) { list = []; byId.set(inst.assetId, list); }
          list.push(inst);
        }
        for (const [id, list] of byId) {
          const root = await parseGltfScene(id, assets.resolve(id).bytes);
          for (const mesh of buildAssetInstancedMeshes(root, list)) { scene.add(mesh); mounted++; }
        }
      }

      // Record the REQUEST on the trace: the regionId + ScatterConfig + pinned hashes +
      // counts, NEVER the instance transforms (recomputed on replay).
      ctx.emit("asset.scattered", {
        regionId: input.regionId, seed: region.seed, lod: region.lod,
        config, assetHashes, instances: placements.length, mounted,
      });
      return { regionId: input.regionId, instances: placements.length, mounted, assetHashes, placements };
    },
  };

  registry.register(scatter);
}
