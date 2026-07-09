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
import { briefToRecipe } from "./building-recipe.ts";
import { archetypeBrief, type BuildingBrief } from "../game/building-brief.ts";
// Grass builders — reused DIRECTLY (not via a nested skill invoke) so village.build can lay a tended
// LAWN on each yard with no registry coupling; render-guarded like the ground pads (headless = no-op).
import { planGrassBlades, GRASS_CLIMATES } from "./grass-plan.ts";
import { buildGrassInstancedMesh, buildGrassGroundTint } from "./grass.ts";
// Lawn decoration: scatter wildflower/tuft GLBs confined to the lawn (the inclusion primitive), instanced
// exactly like asset.scatter. Render-guarded + graceful (missing curated GLBs are skipped).
import { scatterAssets, type ScatterConfig, type AssetInstance } from "../terrain/asset-scatter.ts";
import { buildAssetInstancedMeshes } from "../terrain/asset-scatter-render.ts";
import { parseGltfScene } from "./three.ts";
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

/** Default KIT house size [width, depth, height] (meters) when a kit building omits `sizeM`. */
const DEFAULT_KIT_SIZE: readonly [number, number, number] = [7, 6, 3.4];

/** A building spec: what to place, how the agent describes it (role/style for the layout's
 *  focal-role + facing bookkeeping), and how many. A building is either GLB-backed (`assetId`)
 *  or KIT-backed (`kit: true`, optional `sizeM`) — the latter raises a procedural half-timber
 *  building through architecture.building at the planned transform instead of placing a GLB. */
const buildingSpec = z.object({
  role: z.string(),
  style: z.string(),
  /** The curated GLB to place. Required UNLESS `kit` is set (then a kit building is raised). */
  assetId: z.string().optional(),
  count: z.number().int().min(1).default(1),
  /** Raise a KIT half-timber building here (via architecture.building) instead of a GLB. */
  kit: z.boolean().optional(),
  /** Kit building size [width, depth, height] in meters (default DEFAULT_KIT_SIZE). Only read for kit. */
  sizeM: z.tuple([z.number().positive(), z.number().positive(), z.number().positive()]).optional(),
  /** Raise a per-TYPE building from a shipped archetype BRIEF (game/building-brief.ts) via
   *  building.assemble — e.g. "buildings.medieval.dwelling.cottage" or ".religious.monastery". The
   *  brief carries the construction, roof, ornament + footprint, so a cottage and a monastery diverge
   *  by their brief. Supersedes `sizeM` (footprint comes from the brief). */
  archetype: z.string().optional(),
}).refine(
  (b) => b.archetype !== undefined || b.kit === true || (typeof b.assetId === "string" && b.assetId.length > 0),
  { message: "village building spec requires `assetId`, `kit: true`, or `archetype`" },
);

// SITING — how buildings meet the ground, a SPEC-DRIVEN choice (not a hardcoded look). The GDD/planning
// session sets this per settlement; the DEFAULTS are the natural look (clear trees, sit on flattened
// grass, no manicured yard, a dirt path). A grand focal (keep/manor with a formal forecourt) OPTS IN to
// a courtyard/plaza — a curated base is never imposed by default.
const SitingSchema = z.object({
  /** How much ground to flatten under each building. minimal = a tight pad + gentle grade (natural);
   *  graded = a wider shoulder; plaza = a broad level forecourt (grand focal). */
  terrace: z.enum(["minimal", "graded", "plaza"]).default("minimal"),
  /** The ground a building sits on. DEFAULT "lawn" = a tended patch of dense short turf (+ ground tint)
   *  confined to the yard, so settled ground reads as a kept lawn, not wild scrub or a bare scar. "none"
   *  leaves the natural terrain; "earth" = a bare trodden forecourt; "cobble-courtyard" = paved forecourt. */
  yard: z.enum(["lawn", "none", "earth", "cobble-courtyard"]).default("lawn"),
  /** GLBs a "lawn" yard sprinkles as vegetation (wildflowers/tufts), by id + weight. PROJECT content —
   *  the engine bakes in NO ids; empty by default (a bare turf lawn). A caller/project supplies ids; a
   *  missing asset is skipped at build (never fatal). Pre-warmed by the live runtime from this list. */
  lawnVegetation: z.array(z.object({ id: z.string(), weight: z.number().positive().default(1) })).default([]),
  /** The path between buildings. dirt = a trodden earth lane; gravel = a crushed-stone path;
   *  cobble = paved setts; none = no lane. */
  lane: z.enum(["dirt", "gravel", "cobble", "none"]).default("dirt"),
  /** The settlement CLEARING — how far the surrounding wild growth (a forest scattered BEFORE
   *  this build) is pushed back from the hamlet as a whole. "none" (default) clears only each
   *  building's own footprint, so a forest grows right between the buildings. "commons" registers
   *  ONE keep-out disc covering all placements + a margin, so the settlement sits in an open
   *  clearing ringed by the forest (the canonical hamlet-in-a-clearing read). The grass carpet
   *  still fills the commons — it is cleared of TREES, not of ground cover. */
  clearing: z.enum(["none", "commons"]).default("none"),
  /** Extra world-XZ margin (m) the "commons" clearing adds beyond the outermost building, i.e.
   *  how deep the open ring between the hamlet edge and the treeline is. Ignored for "none". */
  clearingMargin: z.number().min(0).max(60).default(10),
}).prefault({});

// AUTHORED PLACEMENT ANCHORS — WorldMap-derived pins (js/src/world/worldmap.ts Anchor: {id, kind,
// position, count?, name?, source}) reduced to what village.build needs to bind one to a buildingSpec:
// THE RULE (locked): an anchor pins WHERE a building goes; the layout solver (planVillage) still
// decides HOW (facing, terrace order, cluster spread). Matching is by `assetId` (exact) else `role`
// (first UNCLAIMED buildingSpec occurrence, in steering.buildings order) — see the binding loop below.
// `count > 1` clusters that many instances of the matched spec tightly around the SAME anchor.
const AnchorSchema = z.object({
  id: z.string(),
  position: z.tuple([z.number(), z.number()]),
  role: z.string().optional(),
  assetId: z.string().optional(),
  count: z.number().int().positive().optional(),
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
    /** How buildings meet the ground (terrace/yard/lane). Defaults = the natural look. */
    siting: SitingSchema,
    /** Authored placement anchors (from a compiled WorldMap) pinning specific buildings to specific
     *  world positions. Optional — an unanchored steering behaves exactly as before (pure map-wide
     *  solver). See AnchorSchema above for the matching + cluster semantics. */
    anchors: z.array(AnchorSchema).optional(),
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
    /** The authored anchor id this placement was pinned to (absent when unanchored). */
    anchorId: z.string().optional(),
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
      const siting = input.steering.siting; // terrace/yard/lane treatment — spec-driven, defaults natural.

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
      //    expands), resolving each instance's footprint radius. GLB instances pin their content
      //    hash + take their footprint from the baked card; KIT instances derive their footprint
      //    from `sizeM` (half the XZ diagonal — the SAME semantics as footprintRadius) and carry
      //    the size to raise an architecture.building at placement time. Both flow through the
      //    SAME radii array planVillage consumes, so kit + GLB buildings terrace + lay out together.
      const radii: number[] = [];
      /** instance index -> what to raise there: a GLB placement, a plain kit building of size [w,d,h],
       *  or a per-TYPE archetype BRIEF raised through building.assemble. */
      type InstPlan =
        | { kind: "glb"; assetId: string }
        | { kind: "kit"; sizeM: [number, number, number] }
        | { kind: "brief"; brief: BuildingBrief };
      const instOf: InstPlan[] = [];
      const assetHashes: Record<string, string> = {};
      const radiusCache = new Map<string, number>();
      // Per-spec instance-index RANGE (start + count) in the SAME spec-by-spec, count-times order as
      // `radii`/`instOf` — recorded regardless of branch so anchor↔spec binding below (which only
      // needs counts, not asset/kit/archetype identity) can resolve which flat instance index(es) an
      // anchor claims.
      const specRanges: Array<{ start: number; count: number }> = [];
      for (const spec of input.steering.buildings) {
        const count = Math.max(1, spec.count ?? 1);
        specRanges.push({ start: radii.length, count });
        if (spec.archetype !== undefined) {
          const brief = archetypeBrief(spec.archetype);
          if (brief === undefined) throw new Error(`village.build: unknown archetype '${spec.archetype}' — not in the shipped building-brief library`);
          // Footprint = half the XZ diagonal of the brief's own footprint (same semantics as GLB/kit).
          const recipe0 = briefToRecipe(brief);
          const r = 0.5 * Math.hypot(recipe0.width, recipe0.depth);
          for (let i = 0; i < count; i++) { radii.push(r); instOf.push({ kind: "brief", brief }); }
          continue;
        }
        if (spec.kit === true) {
          const sizeM: [number, number, number] = spec.sizeM ?? [...DEFAULT_KIT_SIZE] as [number, number, number];
          // Footprint radius = half the horizontal (XZ) diagonal of width×depth — the SAME semantics
          // footprintRadius() uses for a GLB's boundsM, so kit + GLB radii are directly comparable.
          const r = 0.5 * Math.hypot(sizeM[0], sizeM[1]);
          for (let i = 0; i < count; i++) { radii.push(r); instOf.push({ kind: "kit", sizeM }); }
          continue;
        }
        const assetId = spec.assetId as string; // guaranteed by the schema refine (assetId required unless kit)
        const resolved = assets.resolve(assetId);
        // Content-hash pin: WARN (never THROW) on a mismatch. The committed hash may have been produced
        // by a DIFFERENT host than the one now replaying (e.g. authored on the Rust host, replayed in the
        // browser JS host) — op_sha256 is not guaranteed byte-identical across hosts, so a cross-host
        // mismatch is expected and must NOT quarantine the whole settlement (that dropped EVERY building
        // on browser replay while the procedural forest survived — the "no structures, trees fine" bug).
        // The `assetId` already pins authored identity; the hash is a secondary integrity signal. A
        // genuinely swapped asset surfaces as a visible mismatch warning without nuking the build.
        const committed = input.assetHashes?.[assetId];
        if (committed !== undefined && committed !== resolved.hash) {
          ctx.emit("village.asset_hash_mismatch", { assetId, committed, resolved: resolved.hash });
        }
        assetHashes[assetId] = resolved.hash;
        let r = radiusCache.get(assetId);
        if (r === undefined) { r = footprintRadius(assets, assetId); radiusCache.set(assetId, r); }
        for (let i = 0; i < count; i++) { radii.push(r); instOf.push({ kind: "glb", assetId }); }
      }

      // -- ANCHORS: bind each authored placement anchor to the buildingSpec instance slot(s) it pins —
      //    by `assetId` (exact) else `role` (first UNCLAIMED occurrence, in steering.buildings order),
      //    so two anchors referencing the same role/spec consume disjoint occurrence ranges. This is
      //    the ONLY place assetId/role identity is resolved — planVillage stays agnostic and only ever
      //    sees flat instance indices, keeping "matching" (here) cleanly separate from "siting" (there).
      type AnchorBinding = { id: string; position: [number, number]; instanceIndices: number[] };
      const anchorBindings: AnchorBinding[] = [];
      const anchorsIn = input.steering.anchors ?? [];
      if (anchorsIn.length > 0) {
        const claimed = new Array(specRanges.length).fill(0) as number[];
        for (const anchor of anchorsIn) {
          let listIndex = -1;
          if (anchor.assetId !== undefined) {
            listIndex = input.steering.buildings.findIndex((b) => b.assetId === anchor.assetId);
          }
          if (listIndex === -1 && anchor.role !== undefined) {
            listIndex = input.steering.buildings.findIndex(
              (b, i) => b.role === anchor.role && claimed[i] < specRanges[i].count,
            );
          }
          if (listIndex === -1) {
            throw new Error(
              `village.build: anchor '${anchor.id}' at [${anchor.position[0]}, ${anchor.position[1]}] matches ` +
              `no buildingSpec (assetId='${anchor.assetId ?? ""}', role='${anchor.role ?? ""}')`,
            );
          }
          const range = specRanges[listIndex];
          const want = Math.max(1, Math.min(anchor.count ?? 1, range.count - claimed[listIndex]));
          const instanceIndices: number[] = [];
          for (let i = 0; i < want; i++) { instanceIndices.push(range.start + claimed[listIndex]); claimed[listIndex]++; }
          anchorBindings.push({ id: anchor.id, position: anchor.position, instanceIndices });
        }
      }

      // -- Run the SHARED, pure layout (over the ORIGINAL terrain — sites are chosen on the real
      //    eroded ground, keeping the flatness/contour preference). Anchored instances (if any) are
      //    sited FIRST, at/near their authored positions; the map-wide solver then seats everything
      //    else around them (planVillage throws, naming the anchor, if one has no buildable site).
      const { placements } = planVillage(
        sampler, input.direction, input.steering, radii,
        anchorBindings.length > 0 ? anchorBindings : undefined,
      ) as {
        placements: Array<{ role: string; style: string; index: number; x: number; z: number; yaw: number; anchorId?: string }>;
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
        // Terrace footprint from the siting spec. DEFAULT "minimal": a tight flat pad just past the
        // footprint + a gentle graded shoulder — the building sits on flattened GRASS, no big graded
        // crater. "plaza" (opt-in, focal only) cuts the broad level forecourt a courtyard needs.
        // "minimal" (default): deform barely past the footprint so the grassless deformed cells are hidden
        // UNDER the building; grass stays right up to the walls. "graded"/"plaza" widen it deliberately.
        const plaza = siting.terrace === "plaza" && isFocal;
        const flatR = plaza ? r + 9 : siting.terrace === "graded" ? r * 1.25 + 1.5 : r * 0.95;
        const shoulderR = plaza ? r + 15 : siting.terrace === "graded" ? r * 2.0 + 2.0 : r * 1.15;
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

      // -- Place each building at its planned transform, grounded to the LEVELED platform height. A
      //    GLB building goes through asset.place (unchanged); a KIT building raises a procedural
      //    half-timber structure through architecture.building (its floor sits at position.y, so the
      //    same terraced height grounds it). Both nested invokes are folded into this command
      //    (ctx.chainId), run under village.build's OWN least-privilege scope, and are reproduced on
      //    replay by re-running the plan. The kit seed is a PURE function of the village seed + the
      //    instance index (no clock/RNG), so the kit parts are byte-identical on replay.
      const villageSeed = (input.seed ?? (hashStr(JSON.stringify({ d: input.direction, s: input.steering })) as number)) >>> 0;
      const nestedCtx = () => ({
        agentId: ctx.agentId, sessionId: ctx.sessionId, permissions: new Set<string>(PLACE_PERMS),
        tick: ctx.tick, world: ctx.world, chainId: ctx.chainId,
      });
      const entities: string[] = [];
      const outPlacements: Array<{ assetId: string; role: string; style: string; x: number; y: number; z: number; yaw: number; anchorId?: string }> = [];
      for (const p of placements) {
        const inst = instOf[p.index];
        const y = heightAt(p.x, p.z);
        // Deterministic per-instance seed (village seed mixed with the instance index) — no RNG/clock.
        const kitSeed = (villageSeed + Math.imul(p.index + 1, 0x9e3779b1)) >>> 0;
        const anchorId = p.anchorId; // present only when this placement was pinned to an authored anchor
        if (inst.kind === "brief") {
          // Per-TYPE building raised from its archetype brief through building.assemble (which carries the
          // craft fields: construction, base course, roof cover). The brief's own footprint + rotation are
          // baked into the recipe; the floor sits at position.y so the terraced height grounds it.
          const recipe = briefToRecipe(inst.brief, { rotation: p.yaw });
          const res = await registry.invoke("building.assemble", {
            position: [p.x, y, p.z], seed: kitSeed, ...recipe,
          }, nestedCtx());
          if (!res.success) throw new Error(`village.build: building.assemble failed for archetype '${inst.brief.id}': ${JSON.stringify(res.error)}`);
          entities.push((res.result as { root: string }).root);
          outPlacements.push({ assetId: `archetype:${inst.brief.id}`, role: p.role, style: p.style, x: p.x, y, z: p.z, yaw: p.yaw, anchorId });
        } else if (inst.kind === "kit") {
          const [w, d, h] = inst.sizeM;
          const res = await registry.invoke("architecture.building", {
            position: [p.x, y, p.z],
            rotation: p.yaw, // yaw about +Y (radians) — the SAME facing the GLB path passes as rotation[1]
            width: w, depth: d, height: h,
            seed: kitSeed,
          }, nestedCtx());
          if (!res.success) throw new Error(`village.build: architecture.building failed for kit '${p.role}': ${JSON.stringify(res.error)}`);
          entities.push((res.result as { root: string }).root);
          outPlacements.push({ assetId: "kit", role: p.role, style: p.style, x: p.x, y, z: p.z, yaw: p.yaw, anchorId });
        } else {
          const assetId = inst.assetId;
          const res = await registry.invoke("asset.place", {
            assetId,
            position: [p.x, y, p.z],
            rotation: [0, p.yaw, 0],
            ground: true,
            hash: assetHashes[assetId],
          }, nestedCtx());
          if (!res.success) throw new Error(`village.build: asset.place failed for '${assetId}': ${JSON.stringify(res.error)}`);
          entities.push((res.result as { entity: string }).entity);
          outPlacements.push({ assetId, role: p.role, style: p.style, x: p.x, y, z: p.z, yaw: p.yaw, anchorId });
        }
      }

      // -- v2 GROUND: the winding lane + a trodden pad under every building (+ the focal earth
      //    apron with a cobbled courtyard on top) — the SAME shared geometry the preview authors,
      //    seated on THIS terrain's heightfield. A PURE function of (heights, placements, radii),
      //    so replay re-runs village.build and recomputes them byte-identically — we spawn the
      //    meshes + record their existence as entities, but log NO vertices.
      const placed = placements.map((p) => ({ x: p.x, z: p.z, r: radii[p.index] }));
      const groundGeoms: Array<{ buf: { positions: ArrayLike<number>; uvs: ArrayLike<number>; indices: number[] }; kind: "earth" | "gravel" | "cobble" }> = [];
      // The path between buildings, per the siting spec. DEFAULT "dirt" = a trodden earth lane (cobble
      // reads too formal for a rustic settlement); "gravel" = a crushed-stone path; "cobble" paves it; "none" omits it.
      const laneBuf = siting.lane === "none" ? null : (buildLaneGeometry(heightAt, placed) as { positions: ArrayLike<number>; uvs: ArrayLike<number>; indices: number[] } | null);
      if (laneBuf !== null) groundGeoms.push({ buf: laneBuf, kind: siting.lane === "cobble" ? "cobble" : siting.lane === "gravel" ? "gravel" : "earth" });
      // YARD is OPT-IN (default "none"): buildings sit on the flattened GRASS — no earth apron, no cobbled
      // courtyard, no curated base (a baked/manicured yard reads as out of place against the natural
      // ground). Only when the spec asks does the FOCAL get a forecourt: an earth apron, optionally paved.
      if ((siting.yard === "earth" || siting.yard === "cobble-courtyard") && placements.length > 0) {
        const p = placements[0];
        const r = radii[p.index];
        groundGeoms.push({ buf: buildGroundPadGeometry(heightAt, p.x, p.z, r + 16, 0.2), kind: "earth" });
        if (siting.yard === "cobble-courtyard") groundGeoms.push({ buf: buildGroundPadGeometry(heightAt, p.x, p.z, r + 4, 0.32), kind: "cobble" });
      }
      const scene = ctx.world.scene as { add?: (m: unknown) => void } | undefined;
      const canRender = scene !== undefined && typeof scene.add === "function";
      // The SHARED procedural earth/cobble materials (canvas2d textures) — only minted in a render
      // context; headless authoring records the ground entities without meshes. Seeded from the
      // recorded request so the ground look is deterministic (render-only; not part of the log).
      const groundSeed = (input.seed ?? (hashStr(JSON.stringify({ d: input.direction, s: input.steering })) as number)) >>> 0;
      // The procedural earth/cobble textures need a canvas backend (OffscreenCanvas or a DOM document).
      // A headless authoring context has neither, so it records the ground entities WITHOUT meshes
      // (render-only; not part of the log) — matching the documented headless discipline. The building
      // KIT parts do NOT depend on a canvas, so kit buildings still assemble headlessly.
      const hasCanvas = typeof OffscreenCanvas !== "undefined" || typeof document !== "undefined";
      const mats = (canRender && hasCanvas) ? makeMaterials(THREE, input.direction, mulberry32(groundSeed || 1)) : null;
      for (const spec of groundGeoms) {
        let mesh: MeshLike | undefined;
        if (canRender && mats !== null) {
          const m = meshFromBuffers(spec.buf, spec.kind === "cobble" ? mats.cobble : spec.kind === "gravel" ? mats.gravel : mats.earth);
          scene!.add!(m);
          mesh = m as unknown as MeshLike;
        }
        const geid = spawnRenderable(ctx.world.ecs, inertTransform(), 0, 0, 0);
        if (geid >= MAX_ENTITIES) { despawnRenderable(ctx.world.ecs, geid); throw new Error("village.build: entity capacity exceeded (MAX_ENTITIES) placing ground geometry"); }
        const groundEntity = ctx.world.entities.create({ eid: geid, mesh: mesh as never, origin: { tool: "village.build", input: { ground: true } } });
        entities.push(groundEntity);
      }

      // -- LAWN (siting.yard === "lawn", the DEFAULT): the tended ground each building sits on. A ring of
      //    dense SHORT turf confined to the yard via the INCLUSION primitive (r..r+4), with the building's
      //    own footprint excluded so no blade grows through the walls, plus a matching ground tint so the
      //    settled earth reads as kept lawn — never a bare grey scar or wild scrub. A high slopeMax means
      //    the lawn covers even a graded knoll (the focal), where the wild carpet thins out. Render-only
      //    (like the ground pads above): deterministic from the footprints, recomputed on replay, logs no
      //    vertices; headless authoring/tests have no scene, so it is skipped.
      if (siting.yard === "lawn" && canRender) { // canRender (scene.add), NOT mode — runLive re-authors village.build with mode "headless" but a real scene (same as the ground pads above).
        // The yard blankets the whole settled area (terrace + graded shoulder), so it covers the bare
        // knoll the wild carpet leaves grey. Excludes only the building's own footprint (no blades in the
        // walls). slopeMax is effectively off so even a steep graded knoll gets turf.
        const lawnIncl = placements.map((p) => ({ x: p.x, z: p.z, r: radii[p.index] + 12 }));
        const lawnExcl = placements.map((p) => ({ x: p.x, z: p.z, r: radii[p.index] * 0.6 }));
        const elevMin = sampler.seaLevel - 5, elevMax = oy + hi + 12;
        const lawnPlacements = planGrassBlades(tile, {
          seed: (villageSeed ^ 0x1a2b3c4d) >>> 0,
          density: 300, coverage: 0.97, cluster: 0.12, slopeMax: 4.0,
          sizeRange: [0.7, 1.1], elevationMin: elevMin, elevationMax: elevMax,
          exclusions: lawnExcl, inclusions: lawnIncl,
        });
        const lawnMeshes: unknown[] = [];
        const lawnMesh = buildGrassInstancedMesh(lawnPlacements, {
          climate: "summer", bladeHeight: 0.22, bladeWidth: 0.05, segments: 3, curvature: 0.05,
          windStrength: 0.03, windSpeed: 1.0, windGust: 0.04, windGustFreq: 0.18,
          sssStrength: 0.5, aoStrength: 0.5, maxBlades: 90000,
        });
        if (lawnMesh !== null) lawnMeshes.push(lawnMesh);
        const lawnTint = buildGrassGroundTint(tile, {
          baseColor: GRASS_CLIMATES.summer.base, elevationMin: elevMin, elevationMax: elevMax,
          slopeMax: 4.0, exclusions: lawnExcl, inclusions: lawnIncl, opacity: 1.0,
        });
        if (lawnTint !== null) lawnMeshes.push(lawnTint);
        for (const lm of lawnMeshes) {
          scene!.add!(lm);
          const leid = spawnRenderable(ctx.world.ecs, inertTransform(), 0, 0, 0);
          if (leid >= MAX_ENTITIES) { despawnRenderable(ctx.world.ecs, leid); throw new Error("village.build: entity capacity exceeded (lawn)"); }
          entities.push(ctx.world.entities.create({ eid: leid, mesh: lm as never, origin: { tool: "village.build", input: { lawn: true } } }));
        }

        // LAWN DECORATION — the "vegetation features" of a tended yard: a light scatter of wildflowers +
        // grass tufts CONFINED to the lawn discs (inclusion), the building footprint excluded, low density
        // so it reads as sprinkled flowers, not a meadow. Instanced exactly like asset.scatter. GRACEFUL:
        // a curated GLB that doesn't resolve (bare checkout) is skipped, so this never fails a build.
        const decoAssets: { id: string; weight: number }[] = [];
        for (const a of siting.lawnVegetation) {
          try { assets.resolve(a.id); decoAssets.push({ id: a.id, weight: a.weight }); } catch { /* asset absent — skip */ }
        }
        if (decoAssets.length > 0) {
          const decoConfig: ScatterConfig = {
            seed: (villageSeed ^ 0x0051ed12) >>> 0,
            assets: decoAssets,
            density: 40, coverage: 0.4, cluster: 0.35, slopeMax: 2.0,
            sizeRange: [0.6, 1.2], elevationMin: elevMin, elevationMax: elevMax,
            exclusions: lawnExcl, inclusions: lawnIncl,
          };
          const byId = new Map<string, AssetInstance[]>();
          for (const inst of scatterAssets(tile, decoConfig.seed, decoConfig)) {
            let l = byId.get(inst.assetId); if (l === undefined) { l = []; byId.set(inst.assetId, l); } l.push(inst);
          }
          for (const [id, list] of byId) {
            try {
              const root = await parseGltfScene(id, assets.resolve(id).bytes);
              // Normalize each decoration GLB to a sane lawn-plant height — curated library assets have
              // wildly inconsistent authored scales (some are hundreds of metres, some empty); degenerate
              // ones are skipped inside the builder. Keeps set-dressing from swamping the settlement.
              for (const dm of buildAssetInstancedMeshes(root, list, { normalizeHeight: 0.5 })) {
                scene!.add!(dm);
                const deid = spawnRenderable(ctx.world.ecs, inertTransform(), 0, 0, 0);
                if (deid >= MAX_ENTITIES) { despawnRenderable(ctx.world.ecs, deid); break; }
                entities.push(ctx.world.entities.create({ eid: deid, mesh: dm as never, origin: { tool: "village.build", input: { lawnDeco: true } } }));
              }
            } catch { /* a decoration asset failed to parse (stub/absent GLB) — skip, never fatal */ }
          }
        }
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
        // Natural default: clear only the building's OWN footprint — grass grows right up to the walls,
        // and a tree just can't stand ON the building (it can stand beside it, like a house in a wood).
        // NO canopy blast radius. Only an OPTED-IN focal forecourt widens the clear to its apron.
        // Tree-clear radius by yard style. "lawn": a modest clearing (r+4) that the lawn then fills.
        // "earth"/"cobble-courtyard": clear the whole forecourt apron. "none": tight (grass to walls).
        const clearR = siting.yard === "lawn" ? r + 4
          : (k === 0 && (siting.yard === "earth" || siting.yard === "cobble-courtyard")) ? r + 16 + FOOTPRINT_TREE_MARGIN
            : r;
        exclusions.push({ x: p.x, z: p.z, r: clearR });
      }
      // SETTLEMENT COMMONS (siting.clearing === "commons"): push the surrounding forest back from the
      // hamlet as a whole. One keep-out disc centered on the placements' centroid, sized to enclose the
      // farthest building (center + its footprint) plus the clearing margin — so the settlement sits in an
      // open ring of cleared ground, the treeline beyond it. A PURE function of the placements + radii,
      // recomputed byte-identically on replay. The grass lawn/carpet still fills it (this clears TREES).
      if (siting.clearing === "commons" && placements.length > 0) {
        let cx = 0, cz = 0;
        for (const p of placements) { cx += p.x; cz += p.z; }
        cx /= placements.length; cz /= placements.length;
        // Median distance to a building (not the MAX) so one deliberately-outlying building — a watchtower
        // pushed to the frontier edge, an outlying cottage — doesn't balloon the clearing to swallow the
        // whole map. The commons covers the hamlet CORE; outliers keep only their own footprint clearing
        // and sit at the treeline. Capped absolutely so a sparse spread can't over-clear either.
        const dists = placements.map((p, k) => Math.hypot(p.x - cx, p.z - cz) + radii[p.index]).sort((a, b) => a - b);
        const core = dists[Math.floor(dists.length / 2)]; // median reach
        const r = Math.min(core + siting.clearingMargin, 30);
        exclusions.push({ x: cx, z: cz, r });
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
