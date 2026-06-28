// Phase 11 ACCEPTANCE SCENE — "a cottage on a beach" assembled from INTENT-LEVEL
// foundation skills with ZERO hand-authored geometry.
//
// THE GATE this proves: a beach world is built by SEQUENCING the shipped skill seam
//   world.generateRegion  → a procedural beach region (real heightfield surface)
//   world.addWater         → a sea-level water surface where the sand goes under
//   asset.place(COTTAGE)   → the cottage, placed BY ID on the dry sand
//   asset.scatter(PALM,    → palms + driftwood scattered BY ID across the region,
//                 DRIFTWOOD)  elevation-gated so they sit on the DRY sand only
// — and NOTHING is a hand-built mesh or a `scene.createEntity` primitive. Every prop
// is a content-addressed ASSET resolved by id (cottage/palm/driftwood), so the whole
// look is "place curated assets by id", which is exactly what the curated CC0 beach
// pack swaps into later (see the ASSET-ID constants below — change ONLY those).
//
// The build is a pure sequence of recorded skill REQUESTS, so it is deterministic
// (same inputs → same world) and replayable from an export package (the tiles + asset
// bytes ride the package; the log carries only the requests). Verified headlessly by
// js/test/p11_cottage_scene.ts. Run live for UAT via js/src/demos/cottage_beach_window.ts.

import { MATERIALS } from "../materials/palette.ts";
import { resolveProfile } from "../skills/permissions.ts";
import { TILE_SIZE } from "../terrain/procedural.ts";
import { terrainTypeHints } from "../terrain/terrain-types.ts";
import { resolveBeachConfig } from "../terrain/biome-content.ts";
import type { AssetInstance, ScatterConfig } from "../terrain/asset-scatter.ts";
import type { TerrainSource } from "../terrain/types.ts";
import type { SkillRegistry, WorldContext } from "../skills/registry.ts";
import type { MCPResponse } from "../mcp/protocol.ts";

// ───────────────────────── ASSET IDS — THE SWAP POINT ─────────────────────────
// Place-by-id is the whole architecture: the scene never knows what a "cottage" or a
// "palm" mesh looks like — it asks the content-addressed registry for an asset BY ID.
//
// These point at a curated CC0 beach pack dropped into assets/. To re-skin the look,
// swap ONLY these three constants; the builder, the test, and the export package all
// flow from them unchanged. Do NOT hand-author cottage/palm geometry here — that is
// the exact anti-pattern Phase 11 replaces (procedural region + curated assets, never
// bespoke meshes in the scene).
// Curated CC0 (public-domain, attribution-free) low-poly beach pack from Poly Pizza
// (poly.pizza — Kenney's CC0 model host). Each is plain glTF 2.0 (no Draco/meshopt/
// KTX2), verified to load through parseGltfScene. Source + license per asset:
//   cottage.glb — "Hut" by Quaternius, CC0 — https://poly.pizza/m/wxi3kAu5ey
//                 (model unit extent ≈ 1.46 × 0.77 × 1.18 m, base at Y≈0)
//   palm.glb    — "Palm Tree" by Quaternius, CC0 — https://poly.pizza/m/A6cKJYFsIb
//                 (model unit extent ≈ 2.86 × 2.69 × 2.75 m, base at Y≈0)
//   rock.glb    — "Rock" by Quaternius, CC0 — https://poly.pizza/m/RtLRqYjfMs
//                 (model unit extent ≈ 0.62 × 0.57 × 0.70 m, base at Y≈0)
export const COTTAGE_ASSET = "cottage.glb"; //   a curated cottage/beach-hut GLB (CC0)
export const PALM_ASSET = "palm.glb"; //         a curated palm-tree GLB (CC0)
export const DRIFTWOOD_ASSET = "rock.glb"; //    a curated rock/driftwood GLB (CC0)

// ───────────────────────── SCENE PARAMETERS (deterministic) ─────────────────────────
/** Deterministic world seed for the beach (seed 11's procedural surface dips below
 *  and rises above the waterline, so the region reads as a real beach). */
export const BEACH_SEED = 11;
/** Default beach region: a 2×2 tile rectangle (4 heightfield tiles). Small enough
 *  for a compact export, large enough to scatter a believable shoreline. */
export const BEACH_BOUNDS = { minTx: 0, minTz: 0, maxTx: 1, maxTz: 1 } as const;
/** Where the sea sits between the region's lowest and highest surface point. 0.4 →
 *  the low ~40% of the height range floods, leaving dry sand above it. */
const SEA_FRACTION = 0.4;

/**
 * The OPT-IN terrain-shaping hints that turn the procedural surface from a flat tan
 * dome into a genuine sand island: a domain-WARPED base (organic, meandering shoreline),
 * RIDGED dune detail blended on the crest, and a radial island FALLOFF centred on the
 * region so the land rises from the sea floor, crests into dunes, and slopes back down
 * into the water (a real beach). Derived from the region bounds so the island is always
 * centred and scaled to the generated rectangle. Passed to BOTH world.generateRegion
 * (the tiles/colliders) and source.sampleHeight (the survey that picks the sea level +
 * cottage spot), so the survey matches the shaped tiles. Pure numbers → recorded
 * verbatim in the world log, reproduced bit-for-bit on replay.
 *
 * Tuning knobs (all world meters / [0,1]):
 *   warp        domain-warp amplitude — higher = more sinuous coastline/dunes
 *   warpFreq    warp field frequency — smaller = broader meanders
 *   ridge       [0,1] dune-ridge blend — higher = sharper, more defined dune lines
 *   islandRadius / islandFalloff   the flat-top radius and the beach-slope width
 */
export function beachShapeHints(b: BeachBounds): Record<string, number> {
  // The beach is now ONE entry in the terrain-type catalog (terrain-types.ts) — the single
  // source of truth for every type. This thin wrapper preserves the old call site + name;
  // the "beach" preset reproduces the original shape (warp 22 / ridge 0.45 / island core
  // 0.62 / slope 0.70) bit-for-bit, so the surface, sea level, and scatter are unchanged.
  return terrainTypeHints("beach", b);
}

/**
 * The deterministic palm/driftwood scatter recipe for the beach, as a pure function of
 * the surveyed `seaLevel` (the only runtime input — everything else is fixed). Shared by
 * the builder AND the acceptance test so the falsifiable waterline check runs the EXACT
 * same config. Reads naturally: CLUSTERED into a few groves (not a uniform lattice) with
 * extra driftwood variety and a natural size spread. The cluster mask is purely spatial,
 * so the per-candidate RNG order is unchanged → the elevation gate stays falsifiable
 * (a lower elevationMin yields a strict superset).
 */
export function beachScatterConfig(seaLevel: number): ScatterConfig {
  // The beach is now ONE entry in the BIOME-CONTENT catalog (biome-content.ts) — the
  // single source of truth for every type's scatter content. This thin wrapper preserves
  // the old call site + name; the beach layer reproduces the original recipe bit-for-bit
  // (palms weight 3 + driftwood weight 2, clustered groves on the DRY sand above seaLevel),
  // so the cottage scene's placements are byte-identical.
  return resolveBeachConfig(seaLevel);
}
/** Cottage scale: the Hut model is ≈1.46 × 1.18 m at unit scale, so ×5 gives a ≈7.3 ×
 *  5.9 m footprint and ≈3.8 m ridge — a sensible beach hut sitting ON the sand (the
 *  model's base is at Y≈0, so placing it at the surface height seats it, not buries it). */
const COTTAGE_SCALE: [number, number, number] = [5, 5, 5];

export interface BeachBounds { minTx: number; minTz: number; maxTx: number; maxTz: number }

export interface BuildCottageBeachDeps {
  /** The registry holding the core skills (the only surface the build mutates through). */
  registry: SkillRegistry;
  /** The world the skills write into (scene + ecs + entities + ops). */
  world: WorldContext;
  /** The SAME deterministic terrain source the core skills are bound to
   *  (coreSkills.terrain.source) — read (never mutated) to pick the sea level + the
   *  cottage's dry-sand spot. Passing the bound source guarantees the sampled surface
   *  matches the generated region. */
  source: TerrainSource;
  /** Invoke identity (defaults to a builder.readWrite base). */
  base?: { agentId: string; sessionId: string; permissions?: ReadonlySet<string>; tick?: number };
  /** Override the beach region bounds (default BEACH_BOUNDS). */
  bounds?: BeachBounds;
}

export interface BuildCottageBeachResult {
  regionId: string;
  /** Surface-Y extent sampled across the region. */
  surface: { minY: number; maxY: number };
  /** Sea level passed to world.addWater. */
  seaLevel: number;
  cottage: { entity: string; assetId: string; hash: string; position: [number, number, number] };
  scatter: { instances: number; placements: AssetInstance[]; assetHashes: Record<string, string> };
}

function ok(res: MCPResponse | undefined, what: string): Record<string, unknown> {
  if (res === undefined || !res.success) {
    throw new Error(`buildCottageBeach: ${what} failed: ${JSON.stringify(res?.error)}`);
  }
  return res.result as Record<string, unknown>;
}

/** Sample the procedural surface across the region (deterministic, fixed order) to
 *  find its Y extent and a dry-sand spot for the cottage near the waterline. Pure
 *  READ of the bound source — records no commands, mutates nothing. */
function surveyBeach(source: TerrainSource, seed: number, b: BeachBounds, hints: Record<string, number>): {
  minY: number; maxY: number; samples: { x: number; z: number; y: number }[];
} {
  const STEP = TILE_SIZE / 8; // 8 samples per tile edge
  const x0 = b.minTx * TILE_SIZE, x1 = (b.maxTx + 1) * TILE_SIZE;
  const z0 = b.minTz * TILE_SIZE, z1 = (b.maxTz + 1) * TILE_SIZE;
  const samples: { x: number; z: number; y: number }[] = [];
  let minY = Infinity, maxY = -Infinity;
  for (let z = z0; z <= z1 + 1e-6; z += STEP) {
    for (let x = x0; x <= x1 + 1e-6; x += STEP) {
      // Sample the SHAPED surface (same hints the region is generated with) so the
      // sea level + cottage spot match the rich tiles, not the flat base field.
      const y = source.sampleHeight(seed, x, z, 0, hints);
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      samples.push({ x, z, y });
    }
  }
  return { minY, maxY, samples };
}

/**
 * Build the cottage-on-a-beach world by sequencing ONLY the Phase 11 foundation
 * skills (no primitive geometry, no hand-built meshes). Callable headless (a stub
 * world) and from a host/demo (a live engine world). Returns the region handle, the
 * sea level, the placed cottage (asset id + content hash), and the scattered
 * palm/driftwood instances.
 */
export async function buildCottageBeach(deps: BuildCottageBeachDeps): Promise<BuildCottageBeachResult> {
  const { registry, world, source } = deps;
  const bounds = deps.bounds ?? BEACH_BOUNDS;
  const base = {
    agentId: deps.base?.agentId ?? "agt_beach_builder",
    sessionId: deps.base?.sessionId ?? "ses_cottage_beach",
    permissions: deps.base?.permissions ?? resolveProfile("builder.readWrite"),
    tick: deps.base?.tick ?? 0,
    world,
  };

  // 1. THE GROUND — generate the procedural beach region (real heightfield surface),
  //    OPTING IN to the rich island/dune/beach shaping via hints (the default-off knobs
  //    that keep every other terrain test byte-identical — see procedural.ts / beachShapeHints).
  // Seed the ground by terrain TYPE — the agent-native way: "beach" resolves (server-side,
  // deterministically) to the same shaping+climate hints below. The survey/scatter reuse
  // the resolved hints so every read matches the generated tiles bit-for-bit.
  const hints = beachShapeHints(bounds);

  // Survey the SHAPED surface FIRST (deterministic read, SAME hints) → sea level + cottage spot,
  // BEFORE generating, so the AUTO-SURFACE builds the visible sand mesh with the right sea level.
  const { minY, maxY, samples } = surveyBeach(source, BEACH_SEED, bounds, hints);
  const seaLevel = minY + SEA_FRACTION * (maxY - minY);

  // 1b. THE GROUND + SURFACE — generate the procedural beach region (real heightfield colliders)
  //    AND, in the SAME skill call, the VISIBLE sand surface with the tropical wet/foam SHORELINE
  //    band right where the sand crosses the sea level (the AUTO-SURFACE; render-only, keyed to
  //    seaLevel). Each tile mesh coincides with the collider, so the cottage/props sit on what
  //    you see. Seeded by TYPE "beach" — the agent-native way; ZERO hand-authored geometry.
  const gen = ok(await registry.invoke("world.generateRegion", {
    seed: BEACH_SEED, bounds, lod: 0, type: "beach",
    surface: { mode: "shoreline", color: MATERIALS.sand.color, roughness: MATERIALS.sand.roughness, seaLevel },
  }, base), "world.generateRegion");
  const regionId = gen.regionId as string;

  // 2. THE SEA — a render-only water surface at sea level; the low sand floods. The
  //    surface plane is centred at the origin, so the default (large) size is used so
  //    it fully covers the positive-coordinate region and reads as open water. The
  //    `region` descriptor (seed + type + bounds — pure, log-safe) turns on TRUE
  //    water-column-depth shading: the water samples the SAME terrain field the region
  //    was generated with, so the colour/opacity grade by actual depth and the shoreline
  //    band tracks the real coastline (no camera-distance surf ring). Render-only.
  ok(await registry.invoke("world.addWater", {
    level: seaLevel,
    color: MATERIALS.water.color,
    region: { seed: BEACH_SEED, type: "beach", bounds },
  }, base), "world.addWater");

  // 3. THE COTTAGE — placed BY ID on dry sand just above the waterline. Pick the
  //    interior sample (above the sea) whose height is nearest a low shoreline target,
  //    so the cottage sits on the beach rather than the back-dune peak.
  const targetBeachY = seaLevel + Math.max(0.5, 0.2 * (maxY - seaLevel));
  let spot = { x: (samples[0]?.x ?? 0), z: (samples[0]?.z ?? 0), y: maxY };
  let bestErr = Infinity;
  const innerX0 = bounds.minTx * TILE_SIZE + TILE_SIZE * 0.25, innerX1 = (bounds.maxTx + 1) * TILE_SIZE - TILE_SIZE * 0.25;
  const innerZ0 = bounds.minTz * TILE_SIZE + TILE_SIZE * 0.25, innerZ1 = (bounds.maxTz + 1) * TILE_SIZE - TILE_SIZE * 0.25;
  for (const s of samples) {
    if (s.y <= seaLevel) continue; // dry sand only
    if (s.x < innerX0 || s.x > innerX1 || s.z < innerZ0 || s.z > innerZ1) continue; // keep it inside the region
    const err = Math.abs(s.y - targetBeachY);
    if (err < bestErr) { bestErr = err; spot = s; }
  }
  const cottagePos: [number, number, number] = [spot.x, spot.y, spot.z];
  const placed = ok(await registry.invoke("asset.place", { assetId: COTTAGE_ASSET, position: cottagePos, scale: COTTAGE_SCALE }, base), "asset.place");

  // 4. THE PROPS — scatter palms + driftwood BY ID across the region, elevation-gated
  //    to the DRY sand (elevationMin = seaLevel) so nothing floats in the water, and
  //    CLUMPED into groves (see beachScatterConfig) so it reads as a natural shoreline.
  const scatterConfig = beachScatterConfig(seaLevel);
  const scattered = ok(await registry.invoke("asset.scatter", { regionId, config: scatterConfig }, base), "asset.scatter");

  return {
    regionId,
    surface: { minY, maxY },
    seaLevel,
    cottage: {
      entity: placed.entity as string,
      assetId: COTTAGE_ASSET,
      hash: placed.hash as string,
      position: cottagePos,
    },
    scatter: {
      instances: scattered.instances as number,
      placements: scattered.placements as AssetInstance[],
      assetHashes: scattered.assetHashes as Record<string, string>,
    },
  };
}
