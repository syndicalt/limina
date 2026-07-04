// village.build — ONE engine skill that lays a terrain-aware settlement onto an
// editable terrain layer by placing curated library GLBs. The agent hands a design
// `direction` + `steering` (which buildings, by assetId + count, and a focal/density
// layout hint); the skill reads the live terrain, runs the SHARED, pure layout planner
// (js/src/world/pipeline/village-layout.mjs — the same brain the preview uses, so there
// is no drift), and invokes asset.place for each planned transform.
//
// THE RECORD/REPLAY SPINE (same discipline as asset.scatter): the durable log records
// the REQUEST — the direction + steering + seed + the PINNED per-asset content hashes —
// via ctx.emit, NEVER the individual building transforms. The transforms are a PURE,
// deterministic function of (terrain, steering, footprint radii), so replay re-invokes
// village.build and recomputes byte-identical placements. Each nested asset.place is
// folded into this command (ctx.chainId), reproduced by re-running the plan on replay.
//
// Deterministic: seeded/RNG-free layout, no Math.random / Date. Footprint radii come
// from each GLB's baked card boundsM (measured from the SAME pinned bytes at bake time),
// resolved through the content-addressed registry so they ride the export for replay.

import { z } from "../../build/zod.bundle.mjs";
import { AssetRegistry } from "../asset-registry.ts";
import type { EditableTerrain } from "./terrain-edit.ts";
import type { SkillDefinition, SkillRegistry } from "./registry.ts";
// The shared, pure layout brain (dependency-free JS; imported as `any`). planVillage is
// a deterministic function of (sampler, direction, steering, radii); hashStr derives a
// stable seed for the recorded request.
import { planVillage, hashStr } from "../world/pipeline/village-layout.mjs";

/** Permission scope for village.build — the SAME scope asset.place declares (village.build's
 *  only side effect is invoking asset.place, under least-privilege, not the caller's full grant). */
const PLACE_PERMS = ["scene.write"] as const;

const clamp = (v: number, a: number, b: number): number => Math.min(b, Math.max(a, v));

/** A building spec: what to place (assetId), how the agent describes it (role/style for the
 *  layout's focal-role + facing bookkeeping), and how many. */
const buildingSpec = z.object({
  role: z.string(),
  style: z.string(),
  assetId: z.string(),
  count: z.number().int().min(1).default(1),
});

const buildInput = z.object({
  /** Art direction — flavors the placed assets' identity upstream; layout ignores it. */
  direction: z.object({
    palette: z.record(z.string(), z.string()).optional(),
    mood: z.string().optional(),
    setting: z.string().optional(),
    artStyle: z.string().optional(),
  }).passthrough().default({}),
  steering: z.object({
    buildings: z.array(buildingSpec).min(1),
    layout: z.object({
      focal: z.string().optional(),
      density: z.string().optional(),
    }).default({}),
  }),
  /** Recorded for provenance; the layout is a pure function of terrain+steering, so the
   *  seed does not perturb placements (determinism holds for any seed). */
  seed: z.number().int().optional(),
  /** Terrain layer to build on; defaults to the most recently created one (like terrain.deform). */
  terrainEntity: z.string().optional(),
  /** The COMMITTED content addresses of the building GLBs (id -> "sha256:..."), pinning
   *  authored identity. Absent at authoring (resolved + returned, committed back by the
   *  recorder); present on REPLAY where each resolved asset is verified (mirrors asset.scatter). */
  assetHashes: z.record(z.string(), z.string()).optional(),
});

const buildOutput = z.object({
  terrainEntity: z.string(),
  placed: z.number().int(),
  assetHashes: z.record(z.string(), z.string()),
  entities: z.array(z.string()),
  /** The computed placements (render/inspection). NOT the durable contract — recomputed on replay. */
  placements: z.array(z.object({
    assetId: z.string(), role: z.string(), style: z.string(),
    x: z.number(), y: z.number(), z: z.number(), yaw: z.number(),
  })),
});

/** Deterministic footprint radius for an asset: half the horizontal (XZ) diagonal of its baked
 *  card boundsM (measured from the SAME GLB at bake time). Resolving the card through the registry
 *  caches + bundles it, so a replay reads the identical bounds. Falls back to a neutral radius. */
function footprintRadius(assets: AssetRegistry, assetId: string): number {
  const cardId = assetId.replace(/\.glb$/i, ".card.json");
  try {
    const bytes = assets.resolve(cardId).bytes;
    const card = JSON.parse(new TextDecoder().decode(bytes)) as { boundsM?: number[] };
    const b = card.boundsM;
    if (Array.isArray(b) && b.length >= 3) return 0.5 * Math.hypot(b[0], b[2]);
  } catch { /* fall through to the neutral default */ }
  return 6;
}

/** Register village.build, bound to the editable terrain `layers` map (shared with
 *  terrain.create/deform) + the content-addressed AssetRegistry. */
export function registerVillageSkills(
  registry: SkillRegistry,
  layers: Map<string, EditableTerrain>,
  assets: AssetRegistry,
): void {
  const build: SkillDefinition<z.infer<typeof buildInput>, z.infer<typeof buildOutput>> = {
    name: "village.build",
    version: "1.0.0",
    description: "Lay a terrain-aware settlement onto an editable terrain layer by placing curated library GLB assets. Reads the live heightfield, runs the shared deterministic layout planner (focal on the chosen ground, cluster terraced below, edge building beyond), and invokes asset.place per building. Deterministic + replay-safe: the world log records the direction + steering + seed + PINNED asset hashes, NEVER the transforms, which replay recomputes. Returns the placed entities + computed placements.",
    category: "three",
    permissions: [...PLACE_PERMS],
    // The recorder copies the resolved per-asset hashes back into the recorded command, so
    // the replay log PINS authored identity for every building asset (mirrors asset.scatter).
    commitFields: ["assetHashes"],
    input: buildInput,
    output: buildOutput,
    handler: async (input, ctx) => {
      // -- Resolve the terrain layer (explicit, else the most recently created — like terrain.deform).
      let id = input.terrainEntity;
      if (id === undefined) {
        let last: string | undefined;
        for (const k of layers.keys()) last = k;
        id = last;
      }
      const layer = id !== undefined ? layers.get(id) : undefined;
      if (layer === undefined || id === undefined) {
        throw new Error("village.build: no terrain layer to build on — create one with terrain.create first");
      }
      const tile = layer.tile;

      // -- Build the sampler over the live heightfield. World<->grid mapping matches
      //    terrain/mesh.ts exactly: x = ox - sizeX/2 + col*(sizeX/(ncols-1)), rows->z,
      //    y = origin.y + heights[row*ncols+col] (scaleY === 1). heightAt bilinear-interpolates.
      const n = tile.ncols, nr = tile.nrows;
      const [ox, oy, oz] = tile.origin;
      const sizeX = tile.scale[0], sizeZ = tile.scale[2];
      const x0 = ox - sizeX / 2, z0 = oz - sizeZ / 2;
      const dxStep = sizeX / (n - 1), dzStep = sizeZ / (nr - 1);
      const heights = tile.heights;
      const heightAt = (x: number, z: number): number => {
        const fc = clamp((x - x0) / dxStep, 0, n - 1);
        const fr = clamp((z - z0) / dzStep, 0, nr - 1);
        const c0 = Math.floor(fc), r0 = Math.floor(fr);
        const c1 = Math.min(n - 1, c0 + 1), r1 = Math.min(nr - 1, r0 + 1);
        const tx = fc - c0, tz = fr - r0;
        const h = (r: number, c: number): number => oy + heights[r * n + c];
        const a = h(r0, c0) + (h(r0, c1) - h(r0, c0)) * tx;
        const b = h(r1, c0) + (h(r1, c1) - h(r1, c0)) * tx;
        return a + (b - a) * tz;
      };
      const step = Math.max(1e-3, dxStep);
      const slopeAt = (x: number, z: number): number => {
        const hx = heightAt(x + step, z) - heightAt(x - step, z);
        const hz = heightAt(x, z + step) - heightAt(x, z - step);
        return Math.hypot(hx, hz) / (2 * step);
      };
      // Observed relief; an editable layer carries no water, so seat sea-level just below the
      // lowest point — the whole surface above it is buildable (surveySites excludes h<=sea+1.5).
      let lo = Infinity, hi = -Infinity;
      for (let i = 0; i < heights.length; i++) { const v = heights[i]; if (v < lo) lo = v; if (v > hi) hi = v; }
      const sampler = {
        heightAt, slopeAt,
        halfSize: sizeX / 2,
        seaLevel: oy + lo - 2,
        amplitude: Math.max(1, hi - lo),
      };

      // -- Expand buildings into instances (spec-by-spec, count times — the order planVillage
      //    expands), resolving each instance's footprint radius + pinning each GLB's content hash.
      const radii: number[] = [];
      const assetOf: string[] = []; // instance index -> assetId
      const assetHashes: Record<string, string> = {};
      const radiusCache = new Map<string, number>();
      for (const spec of input.steering.buildings) {
        const resolved = assets.resolve(spec.assetId);
        const committed = input.assetHashes?.[spec.assetId];
        if (committed !== undefined && committed !== resolved.hash) {
          throw new Error(`village.build: '${spec.assetId}' content hash mismatch (committed ${committed}, resolved ${resolved.hash}) — authored asset identity changed`);
        }
        assetHashes[spec.assetId] = resolved.hash;
        let r = radiusCache.get(spec.assetId);
        if (r === undefined) { r = footprintRadius(assets, spec.assetId); radiusCache.set(spec.assetId, r); }
        const count = Math.max(1, spec.count ?? 1);
        for (let i = 0; i < count; i++) { radii.push(r); assetOf.push(spec.assetId); }
      }

      // -- Run the SHARED, pure layout.
      const { placements } = planVillage(sampler, input.direction, input.steering, radii) as {
        placements: Array<{ role: string; style: string; index: number; x: number; z: number; yaw: number }>;
      };

      // -- Place each building via asset.place (grounded to the sampled height). The nested
      //    invoke is folded into this command (ctx.chainId) and runs under village.build's OWN
      //    least-privilege scope, reproduced on replay by re-running the plan.
      const entities: string[] = [];
      const outPlacements: Array<{ assetId: string; role: string; style: string; x: number; y: number; z: number; yaw: number }> = [];
      for (const p of placements) {
        const assetId = assetOf[p.index];
        const y = heightAt(p.x, p.z);
        const res = await registry.invoke("asset.place", {
          assetId,
          position: [p.x, y, p.z],
          rotation: [0, p.yaw, 0],
          ground: true,
          hash: assetHashes[assetId],
        }, {
          agentId: ctx.agentId, sessionId: ctx.sessionId, permissions: new Set<string>(PLACE_PERMS),
          tick: ctx.tick, world: ctx.world, chainId: ctx.chainId,
        });
        if (!res.success) throw new Error(`village.build: asset.place failed for '${assetId}': ${JSON.stringify(res.error)}`);
        entities.push((res.result as { entity: string }).entity);
        outPlacements.push({ assetId, role: p.role, style: p.style, x: p.x, y, z: p.z, yaw: p.yaw });
      }

      // -- Record the REQUEST on the trace: direction + steering + seed + pinned hashes + count,
      //    NEVER the individual transforms (recomputed on replay).
      const seed: number = input.seed ?? (hashStr(JSON.stringify({ d: input.direction, s: input.steering })) as number);
      ctx.emit("village.built", {
        terrainEntity: id, seed, direction: input.direction, steering: input.steering,
        assetHashes, placements: placements.length,
      });
      return { terrainEntity: id, placed: placements.length, assetHashes, entities, placements: outPlacements };
    },
  };

  registry.register(build as unknown as Parameters<SkillRegistry["register"]>[0]);
}
