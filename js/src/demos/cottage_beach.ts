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
import type { AssetInstance, ScatterConfig } from "../terrain/asset-scatter.ts";
import type { TerrainSource } from "../terrain/types.ts";
import type { SkillRegistry, WorldContext } from "../skills/registry.ts";
import type { MCPResponse } from "../mcp/protocol.ts";

// ───────────────────────── ASSET IDS — THE SWAP POINT ─────────────────────────
// Place-by-id is the whole architecture: the scene never knows what a "cottage" or a
// "palm" mesh looks like — it asks the content-addressed registry for an asset BY ID.
//
// For now these point at the two BUNDLED test GLTFs (assets/triangle.glb,
// assets/textured-triangle.gltf) as FUNCTIONAL STAND-INS — enough to prove the
// place-by-id + scatter-by-id pipeline end to end. To ship the real look, drop a
// curated CC0 beach pack into assets/ and change ONLY these three constants; the
// builder, the test, and the export package all flow from them unchanged. Do NOT
// hand-author cottage/palm geometry here — that is the exact anti-pattern Phase 11
// replaces (procedural region + curated assets, never bespoke meshes in the scene).
export const COTTAGE_ASSET = "textured-triangle.gltf"; // → swap: a curated cottage GLTF
export const PALM_ASSET = "triangle.glb"; //               → swap: a curated palm GLTF
export const DRIFTWOOD_ASSET = "textured-triangle.gltf"; // → swap: a curated driftwood GLTF

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
/** Cottage stand-in scale (the unit test asset reads as a small structure on the sand). */
const COTTAGE_SCALE: [number, number, number] = [4, 4, 4];

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
function surveyBeach(source: TerrainSource, seed: number, b: BeachBounds): {
  minY: number; maxY: number; samples: { x: number; z: number; y: number }[];
} {
  const STEP = TILE_SIZE / 8; // 8 samples per tile edge
  const x0 = b.minTx * TILE_SIZE, x1 = (b.maxTx + 1) * TILE_SIZE;
  const z0 = b.minTz * TILE_SIZE, z1 = (b.maxTz + 1) * TILE_SIZE;
  const samples: { x: number; z: number; y: number }[] = [];
  let minY = Infinity, maxY = -Infinity;
  for (let z = z0; z <= z1 + 1e-6; z += STEP) {
    for (let x = x0; x <= x1 + 1e-6; x += STEP) {
      const y = source.sampleHeight(seed, x, z, 0);
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

  // 1. THE GROUND — generate the procedural beach region (real heightfield surface).
  const gen = ok(await registry.invoke("world.generateRegion", { seed: BEACH_SEED, bounds, lod: 0 }, base), "world.generateRegion");
  const regionId = gen.regionId as string;

  // Survey the generated surface (deterministic read) → sea level + cottage spot.
  const { minY, maxY, samples } = surveyBeach(source, BEACH_SEED, bounds);
  const seaLevel = minY + SEA_FRACTION * (maxY - minY);

  // 2. THE SEA — a render-only water surface at sea level; the low sand floods. The
  //    surface plane is centred at the origin, so the default (large) size is used so
  //    it fully covers the positive-coordinate region and reads as open water.
  ok(await registry.invoke("world.addWater", { level: seaLevel, color: MATERIALS.water.color }, base), "world.addWater");

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
  //    to the DRY sand (elevationMin = seaLevel) so nothing floats in the water.
  const scatterConfig: ScatterConfig = {
    seed: 21,
    density: 12,
    assets: [{ id: PALM_ASSET, weight: 2 }, { id: DRIFTWOOD_ASSET, weight: 1 }],
    elevationMin: seaLevel, // dry sand only — props never sit below the waterline
    slopeMax: 0.6, //          keep them off steep back-dune faces
    sizeRange: [0.8, 1.8],
  };
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
