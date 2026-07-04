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
import * as THREE from "../../build/three.bundle.mjs";
import { AssetRegistry } from "../asset-registry.ts";
import { MAX_ENTITIES, despawnRenderable, spawnRenderable } from "../ecs/world.ts";
import type { Transformable } from "../ecs/world.ts";
import type { EditableTerrain } from "./terrain-edit.ts";
import type { SkillDefinition, SkillRegistry } from "./registry.ts";
// The shared, pure layout brain (dependency-free JS; imported as `any`). planVillage is
// a deterministic function of (sampler, direction, steering, radii); hashStr derives a
// stable seed for the recorded request.
import { hashStr, mulberry32, planVillage } from "../world/pipeline/village-layout.mjs";
// The shared, pure GROUND geometry (the SAME lane ribbon + terrain-conforming pads the preview
// authors) — returns flat {positions,uvs,indices}; we wrap them into meshes + spawn them as
// recorded entities. A pure function of (terrain, placements, radii) — recomputed on replay.
import { buildLaneGeometry, buildGroundPadGeometry, laneCenterline } from "../world/pipeline/village-geometry.mjs";
import type { ScatterExclusion } from "../terrain/asset-scatter.ts";
// The SHARED procedural material factory (identical earth/cobble the preview paints) — THREE is
// injected so the engine's three/webgpu build is used. Same no-drift discipline as the layout.
import { makeMaterials } from "../world/pipeline/village-materials.mjs";

/** An inert transform for a ground mesh entity's ECS slot (the mesh is world-fixed). */
const inertTransform = (): Transformable => ({ position: { set() {} }, quaternion: { set() {} }, scale: { set() {} } });
interface MeshLike { geometry: { dispose?: () => void }; }

/** Wrap a pure {positions,uvs,indices} buffer set into a shadow-receiving ground mesh. */
function meshFromBuffers(buf: { positions: ArrayLike<number>; uvs: ArrayLike<number>; indices: number[] }, mat: THREE.Material): THREE.Mesh {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(buf.positions as never, 3));
  geo.setAttribute("uv", new THREE.Float32BufferAttribute(buf.uvs as never, 2));
  geo.setIndex(buf.indices);
  geo.computeVertexNormals();
  const mesh = new THREE.Mesh(geo, mat);
  mesh.receiveShadow = true; // flat ground: receives shadow; casting would only z-fight
  return mesh;
}

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
/** Extra world-XZ margin (meters) added to every registered footprint disc, beyond the
 *  ground-pad/courtyard/lane extent, so a tree's CANOPY (not just its trunk center) stays
 *  off the built ground — a candidate is placed at its center, so the disc must be inflated
 *  by roughly a tree's radius to keep foliage from overhanging the pad edge. */
const FOOTPRINT_TREE_MARGIN = 2.5;
/** The lane ribbon's half-width (world meters) — matches village-geometry's `halfW`. The lane
 *  exclusion discs sample the centerline at this + margin so no tree lands on the rammed earth. */
const LANE_HALF_WIDTH = 1.4;

export function registerVillageSkills(
  registry: SkillRegistry,
  layers: Map<string, EditableTerrain>,
  assets: AssetRegistry,
  /** Shared settlement-footprint registry (keyed by terrain id). village.build REPLACES this
   *  terrain's entry each build with the freshly-computed building/courtyard/lane keep-out discs,
   *  which vegetation.scatter auto-includes as exclusions. Replace (not append) keeps it replay-safe:
   *  a re-run recomputes byte-identical discs from the same config. */
  footprints: Map<string, ScatterExclusion[]> = new Map(),
  /** Shared VEGETATION-CLEAR registry (keyed by terrain id). After village.build computes + registers
   *  this terrain's footprints, it invokes every registered vegetation clear closure so any forest /
   *  grass grown on the NATURAL terrain BEFORE this build is re-mounted with the settlement footprints
   *  carved out — expressing the canonical causal order (nature first, civilization clears) in the
   *  scene even though vegetation ran earlier in the command list. Empty when no veg preceded (the
   *  legacy veg-after-village order, where the exclusion is already applied at veg mount time). */
  vegetationClears: Map<string, Array<() => void | Promise<void>>> = new Map(),
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
      // Observed relief.
      let lo = Infinity, hi = -Infinity;
      for (let i = 0; i < heights.length; i++) { const v = heights[i]; if (v < lo) lo = v; if (v > hi) hi = v; }
      // Sea level: when this layer was GENERATED with a real waterline (terrain.create's
      // `generate` stores elevationColors.seaLevel), use it so NO building settles at/below the
      // lake — surveySites rejects any site with h <= seaLevel + 1.5, keeping the whole
      // settlement on dry land above the world.addWater surface. A plain editable slab (no
      // generated water) keeps the legacy "just below the lowest point" so its entire surface
      // stays buildable.
      const seaLevel = layer.elevationColors?.seaLevel ?? (oy + lo - 2);
      const sampler = {
        heightAt, slopeAt,
        halfSize: sizeX / 2,
        seaLevel,
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

      // -- Run the SHARED, pure layout (over the ORIGINAL terrain — sites are chosen on the real
      //    eroded ground, keeping the flatness/contour preference).
      const { placements } = planVillage(sampler, input.direction, input.steering, radii) as {
        placements: Array<{ role: string; style: string; index: number; x: number; z: number; yaw: number }>;
      };

      // -- v2 TERRACING: LEVEL each footprint into a flat platform cut into the hillside BEFORE
      //    placing, so buildings sit FLUSH (no uphill burial / downhill float) and the settlement
      //    reads as genuinely terraced. Targets are the ORIGINAL center heights (captured before any
      //    leveling, so the order of cuts can't perturb them). Each cut is a recorded terrain.deform
      //    (flatten): a wider SMOOTH flatten grades the terrace shoulder into the slope, then an inner
      //    CONSTANT-falloff disc stamps a dead-flat platform over the footprint (+ a small apron).
      //    heightAt reads the layer's live heights (same array terrain.deform mutates), so subsequent
      //    placement + ground pads see the leveled terraces. Deterministic + replay-safe (nested under
      //    village.build via ctx.chainId; logs ops, never heights).
      const levelTargets = placements.map((p) => heightAt(p.x, p.z));
      // Cap the FOCAL terrace height comfortably below the terrain's snow line: the focal seats on the
      // very highest ground, so leveling a terrace there would otherwise fill flanks up to the snowy
      // summit. Cutting it to ≈0.82 of the relief keeps the citadel + its terrace below the snow band
      // (terrain.create caps snow at ~0.95), so the peak keeps its cap while the settlement stays green.
      const snowSafeFocalTop = sampler.seaLevel + 2 + Math.max(1, hi - lo) * 0.82;
      for (let k = 0; k < placements.length; k++) {
        const p = placements[k];
        const r = radii[p.index];
        const isFocal = k === 0;
        // Dead-flat platform: for the focal it spans the whole plaza (≈ its earth apron, below) so the
        // apron + cobbled courtyard sit on level ground with no terrain poking through; cottages get a
        // tight platform just past their footprint. A wider SMOOTH flatten grades the shoulder out.
        const flatR = isFocal ? r + 9 : r * 1.25 + 1.5;
        const shoulderR = isFocal ? r + 15 : r * 2.0 + 2.0;
        // flatten TARGET (relative to origin.y); the focal is capped below the snow line.
        const targetH = isFocal ? Math.min(levelTargets[k], snowSafeFocalTop) : levelTargets[k];
        const target = targetH - oy;
        for (const [radius, falloff] of [[shoulderR, "smooth"], [flatR, "constant"]] as const) {
          const res = await registry.invoke("terrain.deform", {
            entity: id, center: [p.x, p.z], radius, delta: target, mode: "flatten", falloff,
          }, {
            agentId: ctx.agentId, sessionId: ctx.sessionId, permissions: new Set<string>(PLACE_PERMS),
            tick: ctx.tick, world: ctx.world, chainId: ctx.chainId,
          });
          if (!res.success) throw new Error(`village.build: terrain.deform (level) failed: ${JSON.stringify(res.error)}`);
        }
      }

      // -- Place each building via asset.place (grounded to the LEVELED platform height). The nested
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

      // -- v2 GROUND: the winding lane + a trodden pad under every building (+ the focal earth
      //    apron with a cobbled courtyard on top) — the SAME shared geometry the preview authors,
      //    seated on THIS terrain's heightfield. A PURE function of (heights, placements, radii),
      //    so replay re-runs village.build and recomputes them byte-identically — we spawn the
      //    meshes + record their existence as entities, but log NO vertices.
      const placed = placements.map((p) => ({ x: p.x, z: p.z, r: radii[p.index] }));
      const groundGeoms: Array<{ buf: { positions: ArrayLike<number>; uvs: ArrayLike<number>; indices: number[] }; kind: "earth" | "cobble" }> = [];
      const laneBuf = buildLaneGeometry(heightAt, placed) as { positions: ArrayLike<number>; uvs: ArrayLike<number>; indices: number[] } | null;
      if (laneBuf !== null) groundGeoms.push({ buf: laneBuf, kind: "earth" });
      for (let k = 0; k < placements.length; k++) {
        const p = placements[k];
        const r = radii[p.index];
        if (k === 0) {
          // focal: broad earth apron draping the WHOLE terrace (flat plaza + graded shoulder, ≈ shoulderR)
          // so the raised terrace-fill never shows as bare snow/rock; a cobbled courtyard on the flat plaza.
          groundGeoms.push({ buf: buildGroundPadGeometry(heightAt, p.x, p.z, r + 16, 0.2), kind: "earth" });
          groundGeoms.push({ buf: buildGroundPadGeometry(heightAt, p.x, p.z, r + 4, 0.32), kind: "cobble" });
        } else {
          groundGeoms.push({ buf: buildGroundPadGeometry(heightAt, p.x, p.z, r * 1.15 + 1, 0.14), kind: "earth" });
        }
      }
      const scene = ctx.world.scene as { add?: (m: unknown) => void } | undefined;
      const canRender = scene !== undefined && typeof scene.add === "function";
      // The SHARED procedural earth/cobble materials (canvas2d textures) — only minted in a render
      // context; headless authoring records the ground entities without meshes. Seeded from the
      // recorded request so the ground look is deterministic (render-only; not part of the log).
      const groundSeed = (input.seed ?? (hashStr(JSON.stringify({ d: input.direction, s: input.steering })) as number)) >>> 0;
      const mats = canRender ? makeMaterials(THREE, input.direction, mulberry32(groundSeed || 1)) : null;
      for (const spec of groundGeoms) {
        let mesh: MeshLike | undefined;
        if (canRender && mats !== null) {
          const m = meshFromBuffers(spec.buf, spec.kind === "cobble" ? mats.cobble : mats.earth);
          scene!.add!(m);
          mesh = m as unknown as MeshLike;
        }
        const geid = spawnRenderable(ctx.world.ecs, inertTransform(), 0, 0, 0);
        if (geid >= MAX_ENTITIES) { despawnRenderable(ctx.world.ecs, geid); throw new Error("village.build: entity capacity exceeded (MAX_ENTITIES) placing ground geometry"); }
        const groundEntity = ctx.world.entities.create({ eid: geid, mesh: mesh as never, origin: { tool: "village.build", input: { ground: true } } });
        entities.push(groundEntity);
      }

      // -- FOOTPRINT REGISTRY: publish this settlement's keep-out discs (building pads + focal
      //    courtyard/apron + lane samples) so a later vegetation.scatter on THIS terrain auto-clears
      //    the built ground with no manual data-flow. A PURE function of (placements, radii, heights) —
      //    recomputed byte-identically on replay — and REPLACED (not appended) so a re-run of
      //    village.build can't grow duplicates. The discs mirror the ground geometry authored above:
      //    each building's earth pad (focal: the earth apron r+16 covering the cobbled courtyard),
      //    inflated by a canopy margin, plus lane discs sampling the SAME centerline the ribbon uses.
      const exclusions: ScatterExclusion[] = [];
      for (let k = 0; k < placements.length; k++) {
        const p = placements[k];
        const r = radii[p.index];
        // Match the pad radii in the ground-geometry block: focal earth apron r+16 (spans the
        // cobbled courtyard + graded terrace), cottages the trodden pad r*1.15+1.
        const padR = k === 0 ? r + 16 : r * 1.15 + 1;
        exclusions.push({ x: p.x, z: p.z, r: padR + FOOTPRINT_TREE_MARGIN });
      }
      const laneCl = laneCenterline(heightAt, placed);
      if (laneCl !== null) {
        // Sub-sample the centerline by arc length so consecutive discs overlap (spacing < 2·radius),
        // giving a continuous tree-free corridor without thousands of tiny discs.
        const laneR = LANE_HALF_WIDTH + FOOTPRINT_TREE_MARGIN;
        const spacing = laneR; // < 2·laneR → overlapping cover along the lane
        let acc = spacing; // emit the first sample
        let prev: { x: number; z: number } | null = null;
        for (const s of laneCl.samples) {
          if (prev !== null) acc += Math.hypot(s.x - prev.x, s.z - prev.z);
          if (acc >= spacing) { exclusions.push({ x: s.x, z: s.z, r: laneR }); acc = 0; }
          prev = s;
        }
      }
      footprints.set(id, exclusions);

      // -- SUBTRACTIVE CLEAR: now that this terrain's footprints are registered, re-mount any
      //    vegetation that was grown on the NATURAL terrain BEFORE this build so it is re-computed
      //    with the settlement footprints carved out — the forest/grass under each building pad, the
      //    focal courtyard, and the lane corridor are dropped from their instanced meshes. Pure +
      //    replay-safe: the closures recompute deterministic placements against the deterministic
      //    footprints. No-op when vegetation ran AFTER this build (its mount already saw the discs).
      const clears = vegetationClears.get(id);
      if (clears !== undefined) { for (const clear of clears) await clear(); }

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
