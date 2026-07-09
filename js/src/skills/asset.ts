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

import * as THREE from "../../build/three.bundle.mjs";
import { z } from "../../build/zod.bundle.mjs";
import { AssetRegistry } from "../asset-registry.ts";
import { Position, Scale, renderSyncSystem } from "../ecs/world.ts";
import { gltfResourceSchema, loadGltfIntoScene, loadLodIntoScene, parseGltfScene } from "./three.ts";
import { gltfLocalAabb, type LocalAabb } from "../assets/gltf-bounds.ts";
import { scatterAssets, type AssetInstance, type ScatterConfig } from "../terrain/asset-scatter.ts";
import { buildAssetInstancedMeshes, disposeAssetInstancedMesh } from "../terrain/asset-scatter-render.ts";
import type { TerrainSource, TileRequest } from "../terrain/types.ts";
import { TileCache } from "../terrain/tilecache.ts";
import type { RegionState } from "./terrain.ts";
import type { EditableTerrain } from "./terrain-edit.ts";
import type { SkillDefinition, SkillRegistry } from "./registry.ts";

const Vec3 = z.tuple([z.number(), z.number(), z.number()]);

/** Transform an asset's LOCAL AABB (gltfLocalAabb) by a placement — scale → rotation → position — then
 *  apply the SAME normalizeHeight (a uniform scale about the entity origin) + ground lift asset.place
 *  applies to the visible mesh, yielding the placed WORLD AABB the building collider spans. Pure +
 *  deterministic (no THREE mesh, no wall-clock): identical in the sim-worker, render-main, and gates. */
function placedWorldAabb(
  local: LocalAabb,
  position: readonly [number, number, number],
  rotationEuler?: readonly [number, number, number],
  scale?: readonly [number, number, number],
  normalizeHeight?: number,
  ground?: boolean,
): { min: [number, number, number]; max: [number, number, number] } {
  const m = new THREE.Matrix4().compose(
    new THREE.Vector3(position[0], position[1], position[2]),
    new THREE.Quaternion().setFromEuler(
      new THREE.Euler(rotationEuler?.[0] ?? 0, rotationEuler?.[1] ?? 0, rotationEuler?.[2] ?? 0),
    ),
    new THREE.Vector3(scale?.[0] ?? 1, scale?.[1] ?? 1, scale?.[2] ?? 1),
  );
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  const v = new THREE.Vector3();
  for (let cx = 0; cx < 2; cx++) {
    for (let cy = 0; cy < 2; cy++) {
      for (let cz = 0; cz < 2; cz++) {
        v.set(cx ? local.max[0] : local.min[0], cy ? local.max[1] : local.min[1], cz ? local.max[2] : local.min[2]).applyMatrix4(m);
        if (v.x < min[0]) min[0] = v.x;
        if (v.y < min[1]) min[1] = v.y;
        if (v.z < min[2]) min[2] = v.z;
        if (v.x > max[0]) max[0] = v.x;
        if (v.y > max[1]) max[1] = v.y;
        if (v.z > max[2]) max[2] = v.z;
      }
    }
  }
  // normalizeHeight: uniform scale about the entity origin (position), so the box height becomes
  // normalizeHeight — mirrors the mesh's `Scale *= normalizeHeight / meshHeight`.
  if (normalizeHeight !== undefined) {
    const h = max[1] - min[1];
    if (h > 1e-6) {
      const f = normalizeHeight / h;
      for (const b of [min, max]) {
        b[0] = position[0] + (b[0] - position[0]) * f;
        b[1] = position[1] + (b[1] - position[1]) * f;
        b[2] = position[2] + (b[2] - position[2]) * f;
      }
    }
  }
  // ground: lift so the base sits at position.y (mirrors the mesh's `Position.y += position.y - min.y`).
  if (ground) {
    const dy = position[1] - min[1];
    min[1] += dy;
    max[1] += dy;
  }
  return { min, max };
}

const placeInput = z.object({
  assetId: z.string(),
  position: Vec3.default([0, 0, 0]),
  /** Euler radians (x,y,z). */
  rotation: Vec3.optional(),
  scale: Vec3.optional(),
  /** Sit the asset's BASE at position.y (not its glTF origin, usually centred → half-sunk). Measured
   *  from the loaded bytes, so it is deterministic + replay-safe. Default on; pass false to keep the
   *  raw origin. */
  ground: z.boolean().default(true),
  /** Uniformly scale the asset so its world height equals this many meters (e.g. a ~0.9 m barrel),
   *  before grounding. Assets arrive at arbitrary scales; this normalizes them. */
  normalizeHeight: z.number().positive().max(500).optional(),
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
  /** REVIEW METADATA (not load-bearing — never touches the placed entity). When this placement is
   *  PROPOSED under a review profile (builder.review) and HELD in the approval queue, these ride the
   *  proposal so the reviewer approves what they can SEE. `qcRender` is an /assets-relative path to the
   *  asset's GPU QC render (e.g. "qc/cottage-authored.png"); `qcChecks` flags the automated pre-checks
   *  (textured/scale/integrity — theme stays the human's call). The editor's approval card renders them. */
  qcRender: z.string().optional(),
  qcChecks: z.record(z.string(), z.union([z.boolean(), z.null()])).optional(),
});

/** asset.placeLod — the same placement as asset.place, but the visible mesh is a screen-distance
 *  THREE.LOD composed from ordered levels (level 0 = nearest / highest detail). Draw-call control:
 *  the renderer swaps to a cheaper mesh as the entity shrinks on screen. Collider + authored identity
 *  come from LEVEL 0 (pure from its bytes, so worker/render/gate agree). */
const lodLevel = z.object({
  assetId: z.string(),
  /** Camera distance (world units) at/after which this level takes over. Level 0 is usually 0. */
  distance: z.number().nonnegative(),
});
const placeLodInput = z.object({
  lods: z.array(lodLevel).min(1),
  position: Vec3.default([0, 0, 0]),
  rotation: Vec3.optional(),
  scale: Vec3.optional(),
  ground: z.boolean().default(true),
  normalizeHeight: z.number().positive().max(500).optional(),
  /** COMMITTED content address of LEVEL 0 (pins the base identity across replay). */
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
  cluster: z.number().min(0).max(1).optional(),
  clusterFreq: z.number().positive().optional(),
  biomes: z.array(z.number().int()).optional(),
  tempMin: z.number().optional(),
  tempMax: z.number().optional(),
  /** Footprint-exclusion discs (world XZ) — a candidate inside any is skipped (settlement clearings). */
  exclusions: z.array(z.object({ x: z.number(), z: z.number(), r: z.number().nonnegative() })).optional(),
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
/** Bilinear terrain-surface height at world (x,z) over the most-recently-created editable layer (the
 *  same "last layer wins" default terrain.deform/village.build use). Returns undefined when no editable
 *  terrain exists — callers then keep the raw position.y. Mirrors village.build's sampler exactly. */
function terrainSurfaceHeight(layers: Map<string, EditableTerrain>, x: number, z: number): number | undefined {
  let layer: EditableTerrain | undefined;
  for (const l of layers.values()) layer = l; // most-recent
  if (layer === undefined) return undefined;
  const tile = layer.tile;
  const n = tile.ncols, nr = tile.nrows;
  const [ox, oy, oz] = tile.origin;
  const sizeX = tile.scale[0], sizeZ = tile.scale[2], sy = tile.scale[1] ?? 1;
  const x0 = ox - sizeX / 2, z0 = oz - sizeZ / 2;
  const dx = sizeX / (n - 1), dz = sizeZ / (nr - 1);
  const heights = tile.heights;
  const clamp = (v: number, a: number, b: number): number => Math.min(b, Math.max(a, v));
  const fc = clamp((x - x0) / dx, 0, n - 1), fr = clamp((z - z0) / dz, 0, nr - 1);
  const c0 = Math.floor(fc), r0 = Math.floor(fr);
  const c1 = Math.min(n - 1, c0 + 1), r1 = Math.min(nr - 1, r0 + 1);
  const tx = fc - c0, tz = fr - r0;
  const h = (r: number, c: number): number => oy + heights[r * n + c] * sy;
  const a = h(r0, c0) + (h(r0, c1) - h(r0, c0)) * tx;
  const b = h(r1, c0) + (h(r1, c1) - h(r1, c0)) * tx;
  return a + (b - a) * tz;
}

export function registerAssetSkills(registry: SkillRegistry, assets: AssetRegistry, terrain?: ScatterTerrain, layers?: Map<string, EditableTerrain>): void {
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
    output: z.object({ entity: z.string(), hash: z.string(), resource: gltfResourceSchema, bounds: Vec3 }),
    handler: async (input, ctx) => {
      // Content-addressed resolve: id -> bytes + stable hash (the asset's portable
      // identity). Same id -> same content address on every resolve/replay.
      const resolved = assets.resolve(input.assetId);
      // Content-hash pin: WARN (never THROW) on a mismatch — same rule as village.build. The committed
      // hash may have been produced on a DIFFERENT HOST (Rust op_sha256 vs the browser's), so a
      // cross-host replay of a perfectly healthy placement can mismatch. Throwing here quarantined the
      // command in the live viewport: the entity existed server-side but its mesh never mounted
      // ("placed but invisible"). Surface a genuinely swapped asset as a visible warning instead.
      if (input.hash !== undefined && input.hash !== resolved.hash) {
        ctx.emit("asset.hash_mismatch", { assetId: input.assetId, committed: input.hash, resolved: resolved.hash });
      }
      // GROUND-CONFORM: `ground: true` means "sit on the ground", so when there is an editable terrain
      // we snap the base to the TERRAIN SURFACE at (x,z), not to the passed position.y — otherwise an
      // asset placed with y=0 on a raised island sinks into the hillside. Deterministic + replay-safe:
      // the height is a pure bilinear sample of the recorded terrain, recomputed identically on replay.
      // (No terrain, or ground:false → keep the raw position.y.) village.build already passes the terrain
      // height, so this is a no-op there; it fixes direct asset.place onto generated ground.
      const terrainY = (input.ground && layers !== undefined) ? terrainSurfaceHeight(layers, input.position[0], input.position[2]) : undefined;
      const groundPos: z.infer<typeof Vec3> = terrainY !== undefined ? [input.position[0], terrainY, input.position[2]] : input.position;
      const { entity, resource } = await loadGltfIntoScene(ctx, input.assetId, resolved.bytes, resolved.hash, {
        position: groundPos,
        rotationEuler: input.rotation,
        scale: input.scale,
      });
      // MEASURE → (normalize) → GROUND, then BUILDING COLLIDER. A glTF origin is usually centred, so
      // without grounding the asset's base sinks below position.y.
      //
      // The placed world AABB is computed DETERMINISTICALLY FROM THE BYTES (gltfLocalAabb + the
      // placement transform), NOT from the parsed THREE mesh. That is load-bearing: the AUTHORITATIVE
      // browser physics runs in the sim-worker, which never parses the mesh (`skipMesh` — GLTFLoader's
      // texture decode hangs a Worker), so a mesh-measured collider was silently skipped there and the
      // player walked straight through every building (the p84 bug). Deriving the AABB from the bytes
      // makes asset.place author the collider IDENTICALLY in the worker, the render-main thread, and
      // headless gates — pure function of (bytes, placement), so a replay re-adds an identical box.
      const localAabb = gltfLocalAabb(resolved.bytes);
      const placed = localAabb === null
        ? null
        : placedWorldAabb(localAabb, groundPos, input.rotation, input.scale, input.normalizeHeight, input.ground);
      let bounds: [number, number, number] = placed === null
        ? [0, 0, 0]
        : [placed.max[0] - placed.min[0], placed.max[1] - placed.min[1], placed.max[2] - placed.min[2]];

      // Adjust the VISIBLE mesh (render-main / gate contexts only — the worker has no mesh). Uses the
      // same normalize/ground the deterministic AABB above applied, so the collider aligns with what
      // renders. Skipped in the worker (rec.mesh undefined), which keeps only the collider — correct,
      // since the worker owns physics, not the render pose.
      const rec = ctx.world.entities.resolve(entity) as { eid: number; mesh?: THREE.Object3D } | undefined;
      if (rec?.mesh !== undefined && rec.eid !== undefined) {
        const measure = (): THREE.Box3 => {
          renderSyncSystem(ctx.world.ecs);
          rec.mesh!.updateMatrixWorld(true);
          return new THREE.Box3().setFromObject(rec.mesh!);
        };
        let box = measure();
        if (input.normalizeHeight !== undefined) {
          const h = box.max.y - box.min.y;
          if (h > 1e-6) {
            const f = input.normalizeHeight / h;
            Scale.x[rec.eid] *= f; Scale.y[rec.eid] *= f; Scale.z[rec.eid] *= f;
            box = measure();
          }
        }
        if (input.ground) {
          Position.y[rec.eid] += groundPos[1] - box.min.y; // base → the terrain-conformed ground height
          box = measure();
        }
        // The mesh is authoritative for the RETURNED bounds when it parsed (exact geometry), keeping the
        // recorded meta identical to the historical mesh-measured value on the render/gate path.
        bounds = [box.max.x - box.min.x, box.max.y - box.min.y, box.max.z - box.min.z];
      }

      // BUILDING COLLIDER — a Rapier static box over the placed asset's FINAL world AABB. NOT bound to
      // the entity's bodyId: the entity keeps its authored (grounded) render pose while the collider
      // centers on the AABB center (mid-height); binding would teleport the mesh onto the box center.
      // village.build inherits this per nested building.
      if (placed !== null) {
        const hx = (placed.max[0] - placed.min[0]) / 2;
        const hy = (placed.max[1] - placed.min[1]) / 2;
        const hz = (placed.max[2] - placed.min[2]) / 2;
        if (hx > 1e-4 && hy > 1e-4 && hz > 1e-4) {
          const cx = (placed.min[0] + placed.max[0]) / 2;
          const cy = (placed.min[1] + placed.max[1]) / 2;
          const cz = (placed.min[2] + placed.max[2]) / 2;
          ctx.world.ops.op_physics_add_static_box(cx, cy, cz, hx, hy, hz, 0.85, 0);
        }
      }
      // Optional material override (reuses three.setMaterial's apply, by id). Scoped
      // to asset.place's OWN declared permission, NOT the caller's full grant set.
      // Pass `ctx.chainId` so the WorldRecorder folds this nested invoke into the
      // already-recorded `asset.place` command (it is reproduced on replay by
      // re-invoking asset.place) rather than recording it as a separate top-level.
      if (input.material !== undefined) {
        const res = await registry.invoke("three.setMaterial", { entity, ...input.material }, {
          agentId: ctx.agentId, sessionId: ctx.sessionId, permissions: new Set<string>(PLACE_PERMS), tick: ctx.tick, world: ctx.world, chainId: ctx.chainId,
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
        grounded: input.ground,
        bounds,
        entity,
      });
      return { entity, hash: resolved.hash, resource, bounds };
    },
  };

  registry.register(place);

  // ---- asset.placeLod ------------------------------------------------------
  const placeLod: SkillDefinition<z.infer<typeof placeLodInput>, { entity: string; hash: string; levels: number; resource: z.infer<typeof gltfResourceSchema>; bounds: z.infer<typeof Vec3> }> = {
    name: "asset.placeLod",
    version: "1.0.0",
    description: "Place a curated glTF asset as a screen-distance LOD: multiple resolution levels that the renderer swaps by camera distance for draw-call control. Level 0 is the nearest/highest-detail mesh and defines the collider + committed identity. Same transform/ground/normalize semantics as asset.place; records the REQUEST (ordered level ids + distances + level-0 hash).",
    category: "three",
    permissions: [...PLACE_PERMS],
    commitFields: ["hash"],
    input: placeLodInput,
    output: z.object({ entity: z.string(), hash: z.string(), levels: z.number().int(), resource: gltfResourceSchema, bounds: Vec3 }),
    handler: async (input, ctx) => {
      // Order by distance ascending: level 0 = nearest/highest-detail = the collider + identity base.
      const ordered = [...input.lods].sort((a, b) => a.distance - b.distance);
      const resolved = ordered.map((l) => { const r = assets.resolve(l.assetId); return { assetId: l.assetId, distance: l.distance, bytes: r.bytes, hash: r.hash }; });
      const base = resolved[0];
      // Content-hash pin on LEVEL 0: WARN (never THROW) on a cross-host mismatch — same rule as asset.place.
      if (input.hash !== undefined && input.hash !== base.hash) {
        ctx.emit("asset.hash_mismatch", { assetId: base.assetId, committed: input.hash, resolved: base.hash });
      }
      const terrainY = (input.ground && layers !== undefined) ? terrainSurfaceHeight(layers, input.position[0], input.position[2]) : undefined;
      const groundPos: z.infer<typeof Vec3> = terrainY !== undefined ? [input.position[0], terrainY, input.position[2]] : input.position;
      const { entity, resource, lod } = await loadLodIntoScene(ctx, resolved, {
        position: groundPos, rotationEuler: input.rotation, scale: input.scale,
      });
      // Register the LOD for the per-frame lod.update(camera) pass (render-only; rebuilt from the log
      // on replay by re-invoking this skill — never sim/log state, like world.post).
      if (lod !== undefined) {
        const w = ctx.world as unknown as { lods?: unknown[] };
        (w.lods ??= []).push(lod);
      }
      // Collider + placed AABB from LEVEL 0 bytes — identical in worker/render/gate (pure), as asset.place.
      const localAabb = gltfLocalAabb(base.bytes);
      const placed = localAabb === null ? null : placedWorldAabb(localAabb, groundPos, input.rotation, input.scale, input.normalizeHeight, input.ground);
      // Mesh-side normalize + ground on the LOD root (render/gate only; the worker has no mesh).
      const rec = ctx.world.entities.resolve(entity) as { eid: number; mesh?: THREE.Object3D } | undefined;
      if (rec?.mesh !== undefined && rec.eid !== undefined) {
        const measure = (): THREE.Box3 => { renderSyncSystem(ctx.world.ecs); rec.mesh!.updateMatrixWorld(true); return new THREE.Box3().setFromObject(rec.mesh!); };
        let box = measure();
        if (input.normalizeHeight !== undefined) {
          const h = box.max.y - box.min.y;
          if (h > 1e-6) { const f = input.normalizeHeight / h; Scale.x[rec.eid] *= f; Scale.y[rec.eid] *= f; Scale.z[rec.eid] *= f; box = measure(); }
        }
        if (input.ground) { Position.y[rec.eid] += groundPos[1] - box.min.y; measure(); }
      }
      let bounds: [number, number, number] = placed === null ? [0, 0, 0] : [placed.max[0] - placed.min[0], placed.max[1] - placed.min[1], placed.max[2] - placed.min[2]];
      if (placed !== null) {
        const hx = (placed.max[0] - placed.min[0]) / 2, hy = (placed.max[1] - placed.min[1]) / 2, hz = (placed.max[2] - placed.min[2]) / 2;
        if (hx > 1e-4 && hy > 1e-4 && hz > 1e-4) {
          const cx = (placed.min[0] + placed.max[0]) / 2, cy = (placed.min[1] + placed.max[1]) / 2, cz = (placed.min[2] + placed.max[2]) / 2;
          ctx.world.ops.op_physics_add_static_box(cx, cy, cz, hx, hy, hz, 0.85, 0);
        }
        bounds = [placed.max[0] - placed.min[0], placed.max[1] - placed.min[1], placed.max[2] - placed.min[2]];
      }
      const levelCount = lod !== undefined ? (lod as unknown as { levels: unknown[] }).levels.length : 0;
      ctx.emit("asset.lodPlaced", { levels: resolved.map((r) => ({ assetId: r.assetId, distance: r.distance, hash: r.hash })), position: input.position, grounded: input.ground, entity, mounted: levelCount });
      return { entity, hash: base.hash, levels: levelCount, resource, bounds };
    },
  };
  registry.register(placeLod);

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
      const scene = ctx.world.scene as { add?: (o: unknown) => void; remove?: (o: unknown) => void } | undefined;
      if (scene !== undefined && typeof scene.add === "function") {
        const byId = new Map<string, AssetInstance[]>();
        for (const inst of placements) {
          let list = byId.get(inst.assetId);
          if (list === undefined) { list = []; byId.set(inst.assetId, list); }
          list.push(inst);
        }
        const mountedMeshes: THREE.InstancedMesh[] = [];
        for (const [id, list] of byId) {
          const root = await parseGltfScene(id, assets.resolve(id).bytes);
          for (const mesh of buildAssetInstancedMeshes(root, list)) {
            scene.add(mesh);
            mountedMeshes.push(mesh);
            mounted++;
          }
        }
        if (mountedMeshes.length > 0) {
          (region.renderDisposables ??= []).push(() => {
            for (const mesh of mountedMeshes) {
              if (typeof scene.remove === "function") scene.remove(mesh);
              disposeAssetInstancedMesh(mesh);
            }
          });
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
