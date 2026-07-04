// terrain.create / terrain.deform — an EDITABLE heightfield terrain layer as first-class,
// recorded, replayable world state. Distinct from world.generateRegion (generate-only tile
// streaming): this is a ground grid the agent (or the editor's sculpt brush) OWNS and reshapes.
//
// DATA MODEL (the record/replay spine): the durable log records the OPS — terrain.create's
// params + each terrain.deform brush stamp — NOT the height bytes. Replay re-invokes the same
// skills in the same order and reconstructs identical heights (the deform math is pure +
// deterministic). Heights are meters relative to origin.y (scaleY === 1), so a deform delta is
// a real-world height change and the render mesh matches 1:1 (terrain/mesh.ts: y = origin.y +
// heights[i]*scaleY).

import { z } from "../../build/zod.bundle.mjs";
import { MAX_ENTITIES, despawnRenderable, spawnRenderable } from "../ecs/world.ts";
import type { Transformable } from "../ecs/world.ts";
import type { TerrainTile } from "../terrain/types.ts";
import { applyElevationColors, buildTerrainMesh, type ElevationColorRamp, terrainTileBufferGeometry } from "../terrain/render.ts";
import { generateHeightfield } from "../world/pipeline/terrain-heightfield.mjs";
import type { SkillDefinition, SkillRegistry } from "./registry.ts";

/** An inert transform for the terrain entity's ECS slot (the mesh is world-fixed at its origin). */
const inertTransform = (): Transformable => ({ position: { set() {} }, quaternion: { set() {} }, scale: { set() {} } });

/** The live editable layer: its mutable tile + rendered mesh (mesh is undefined in a headless
 *  context whose scene is a stub — the tile state is still maintained + records/replays). */
export interface EditableTerrain { tile: TerrainTile; mesh: MeshLike | undefined; eid: number; elevationColors?: ElevationColorRamp; }
interface MeshLike { geometry: { dispose?: () => void }; }

const Vec3 = z.tuple([z.number(), z.number(), z.number()]);

const createInput = z.object({
  /** Square terrain extent in world meters. */
  size: z.number().positive().max(8192).default(256),
  /** Grid vertices per edge (resolution). Higher = finer sculpting, more geometry. */
  resolution: z.number().int().min(2).max(1025).default(129),
  /** World-space center of the layer [x, y, z]. */
  origin: Vec3.default([0, 0, 0]),
  /** Starting height (meters, relative to origin.y) for every cell — a flat slab by default. */
  baseHeight: z.number().default(0),
  /** Ground color for the render mesh. */
  color: z.number().int().min(0).max(0xffffff).default(0x4a6b3a),
  /**
   * OPTIONAL procedural eroded terrain. When present, the layer starts NOT as a flat slab but
   * as a real eroded heightfield (fBm → hydraulic + thermal erosion → drainage channels) filled
   * by the PURE, deterministic generator (world/pipeline/terrain-heightfield.mjs), and the render
   * mesh gets sand/grass/rock/snow elevation colors. Only these PARAMS are recorded — replay
   * regenerates byte-identical heights (never the height array). Absent → the flat slab default
   * (backward compatible; existing flat terrain.create ops replay unchanged).
   */
  generate: z.object({
    seed: z.number().int().default(1337),
    /** Peak relief in meters (0..amplitude above origin.y). */
    amplitude: z.number().positive().default(14),
    /** Fraction of the map below the derived sea level (drives the sand/grass line). */
    seaCoverage: z.number().min(0).max(1).optional(),
    /** Base fBm frequency (smaller = broader landforms). */
    noiseScale: z.number().positive().optional(),
    octaves: z.number().int().min(1).max(12).optional(),
    lacunarity: z.number().positive().optional(),
    gain: z.number().positive().optional(),
    /** Domain-warp strength (meanders the ridgelines). */
    warp: z.number().min(0).optional(),
    /** Erosion recipe overrides (rain droplets / thermal passes / talus angle). */
    erosion: z.object({
      rain: z.number().min(0).optional(),
      thermal: z.number().int().min(0).optional(),
      talus: z.number().min(0).optional(),
    }).optional(),
  }).optional(),
});

const DEFORM_MODES = ["raise", "lower", "smooth", "flatten", "noise"] as const;
const FALLOFFS = ["smooth", "linear", "constant"] as const;
const deformInput = z.object({
  /** Which terrain layer to reshape. Defaults to the most recently created one. */
  entity: z.string().optional(),
  /** Brush center in WORLD space [x, z]. */
  center: z.tuple([z.number(), z.number()]),
  /** Brush radius in world meters. */
  radius: z.number().positive(),
  /** raise/lower/noise: amount in meters. flatten: TARGET height. */
  delta: z.number().default(1),
  mode: z.enum(DEFORM_MODES).default("raise"),
  /** Brush weight profile from center (1) to edge (0). */
  falloff: z.enum(FALLOFFS).default("smooth"),
});

function falloffWeight(kind: (typeof FALLOFFS)[number], t: number): number {
  // t is 1 at the brush center, 0 at the rim.
  if (kind === "constant") return 1;
  if (kind === "linear") return t;
  return t * t * (3 - 2 * t); // smoothstep
}

/** Deterministic value noise from integer grid coords — no Math.random/transcendentals, so
 *  a noise deform replays byte-identically across runs and platforms. */
function hashNoise(col: number, row: number): number {
  let h = (Math.imul(col, 374761393) + Math.imul(row, 668265263)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177) | 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** Apply one deterministic brush stamp to a tile's heights, in place. */
function applyBrush(tile: TerrainTile, input: z.infer<typeof deformInput>): void {
  const { nrows, ncols, origin, scale, heights } = tile;
  const x0 = origin[0] - scale[0] / 2;
  const z0 = origin[2] - scale[2] / 2;
  const dxStep = scale[0] / (ncols - 1);
  const dzStep = scale[2] / (nrows - 1);
  const [cx, cz] = input.center;
  const r = input.radius;
  const r2 = r * r;
  // "smooth" reads the pre-stamp field so the blur is order-independent within the stamp.
  const src = input.mode === "smooth" ? Float32Array.from(heights) : heights;

  for (let row = 0; row < nrows; row++) {
    const wz = z0 + row * dzStep;
    for (let col = 0; col < ncols; col++) {
      const wx = x0 + col * dxStep;
      const dx = wx - cx, dz = wz - cz;
      const d2 = dx * dx + dz * dz;
      if (d2 > r2) continue;
      const t = 1 - Math.sqrt(d2) / r;
      const f = falloffWeight(input.falloff, t);
      const i = row * ncols + col;
      switch (input.mode) {
        case "raise": heights[i] += input.delta * f; break;
        case "lower": heights[i] -= input.delta * f; break;
        case "flatten": heights[i] += (input.delta - heights[i]) * f; break;
        case "noise": heights[i] += (hashNoise(col, row) * 2 - 1) * input.delta * f; break;
        case "smooth": {
          let sum = 0, cnt = 0;
          for (let rr = -1; rr <= 1; rr++) {
            const nr = row + rr; if (nr < 0 || nr >= nrows) continue;
            for (let cc = -1; cc <= 1; cc++) {
              const nc = col + cc; if (nc < 0 || nc >= ncols) continue;
              sum += src[nr * ncols + nc]; cnt++;
            }
          }
          heights[i] += (sum / cnt - heights[i]) * f;
          break;
        }
      }
    }
  }
}

/** Register terrain.create + terrain.deform. `layers` is the per-registry live state (each
 *  context — headless authoritative, browser render — keeps its own; both reconstruct identically
 *  from the recorded ops). */
export function registerTerrainEditSkills(
  registry: SkillRegistry,
  layers: Map<string, EditableTerrain> = new Map(),
): { layers: Map<string, EditableTerrain> } {
  const create: SkillDefinition<z.infer<typeof createInput>, { entity: string }> = {
    name: "terrain.create",
    version: "1.0.0",
    description: "Create an editable heightfield terrain layer — a flat, deformable/paintable ground grid — as a world entity. Reshape it with terrain.deform. Records its params so it replays; heights are meters relative to origin.y.",
    category: "terrain",
    permissions: ["scene.write"],
    input: createInput,
    output: z.object({ entity: z.string() }),
    handler: (input, ctx) => {
      const n = input.resolution;
      // Heights: a flat slab by default, OR a PURE eroded heightfield when `generate` is set.
      // The generator produces an (n)×(n) grid over `size` meters (gridN = n-1 vertices/edge)
      // deterministically from the recorded params, so replay reconstructs identical heights.
      let heights: Float32Array;
      let elevationColors: { seaLevel: number; amplitude: number } | undefined;
      if (input.generate !== undefined) {
        const g = input.generate;
        const gh = generateHeightfield({
          seed: g.seed,
          amplitude: g.amplitude,
          sizeM: input.size,
          gridN: n - 1,
          ...(g.seaCoverage !== undefined ? { seaCoverage: g.seaCoverage } : {}),
          ...(g.noiseScale !== undefined ? { noiseScale: g.noiseScale } : {}),
          ...(g.octaves !== undefined ? { octaves: g.octaves } : {}),
          ...(g.lacunarity !== undefined ? { lacunarity: g.lacunarity } : {}),
          ...(g.gain !== undefined ? { gain: g.gain } : {}),
          ...(g.warp !== undefined ? { warp: g.warp } : {}),
          ...(g.erosion !== undefined ? { erosion: g.erosion } : {}),
        }) as { heights: Float32Array; cfg: { seaLevelM: number; amplitude: number } };
        heights = gh.heights;
        // snowFrac 1.0: snow only where terrain rises to the summit of the sea-relative relief.
        // applyElevationColors now measures the snow line off the tile's ACTUAL relief (sea→peak).
        // village.build seats the focal on the HIGHEST ground and grades a flat terrace + smooth
        // shoulder across the top of that relief, so the settlement IS the local summit — a snow line
        // below 1.0 painted the graded shoulder as a harsh white ring. Keying it to the summit leaves
        // the inhabited knoll reading grass/rock/dirt; a bare generated peak (no settlement leveling it)
        // still whitens at its very top. This is the harsh-white-scree fix for authored village terrain.
        elevationColors = { seaLevel: input.origin[1] + gh.cfg.seaLevelM, amplitude: gh.cfg.amplitude, snowFrac: 1.0 };
      } else {
        heights = new Float32Array(n * n);
        if (input.baseHeight !== 0) heights.fill(input.baseHeight);
      }
      const tile: TerrainTile = { nrows: n, ncols: n, origin: [input.origin[0], input.origin[1], input.origin[2]], scale: [input.size, 1, input.size], heights };

      let mesh: MeshLike | undefined;
      const scene = ctx.world.scene as { add?: (m: unknown) => void } | undefined;
      if (scene !== undefined && typeof scene.add === "function") {
        const built = buildTerrainMesh(tile, elevationColors !== undefined ? { color: input.color, elevationColors } : { color: input.color });
        scene.add(built);
        mesh = built as unknown as MeshLike;
      }

      const eid = spawnRenderable(ctx.world.ecs, inertTransform(), input.origin[0], input.origin[1], input.origin[2]);
      if (eid >= MAX_ENTITIES) {
        despawnRenderable(ctx.world.ecs, eid);
        throw new Error("terrain.create: entity capacity exceeded (MAX_ENTITIES)");
      }
      const origin = { tool: "terrain.create", input: { ...input } };
      const entity = ctx.world.entities.create({ eid, mesh: mesh as never, origin });
      // Stash the elevation ramp so terrain.deform can re-color the rebuilt geometry (a deform
      // that levels a terrace would otherwise drop the vertex colors → a white patch).
      layers.set(entity, { tile, mesh, eid, ...(elevationColors !== undefined ? { elevationColors } : {}) });
      ctx.emit("terrain.created", { entity, size: input.size, resolution: n });
      return { entity };
    },
  };

  const deform: SkillDefinition<z.infer<typeof deformInput>, { ok: boolean }> = {
    name: "terrain.deform",
    version: "1.0.0",
    description: "Reshape an editable terrain layer with a brush stamp (raise/lower/smooth/flatten/noise) in a world-space radius. Deterministic + recorded, so hand-sculpted terrain replays and is editable.",
    category: "terrain",
    permissions: ["scene.write"],
    input: deformInput,
    output: z.object({ ok: z.boolean() }),
    handler: (input, ctx) => {
      let id = input.entity;
      if (id === undefined) {
        let last: string | undefined;
        for (const k of layers.keys()) last = k; // most-recently created
        id = last;
      }
      const layer = id !== undefined ? layers.get(id) : undefined;
      if (layer === undefined) return { ok: false };

      applyBrush(layer.tile, input);

      // Rebuild the render geometry from the mutated heights (browser render context only).
      if (layer.mesh !== undefined) {
        const next = terrainTileBufferGeometry(layer.tile);
        // Re-apply elevation vertex colors so a leveled terrace keeps its sand/grass/rock/snow
        // shading instead of reverting to the material's flat base color.
        if (layer.elevationColors !== undefined) applyElevationColors(next, layer.tile, layer.elevationColors);
        const old = layer.mesh.geometry;
        (layer.mesh as unknown as { geometry: unknown }).geometry = next;
        old.dispose?.();
      }
      ctx.emit("terrain.deformed", { entity: id, mode: input.mode });
      return { ok: true };
    },
  };

  registry.register(create as unknown as Parameters<SkillRegistry["register"]>[0]);
  registry.register(deform as unknown as Parameters<SkillRegistry["register"]>[0]);
  return { layers };
}
