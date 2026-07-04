// vegetation.grass — carpet an EDITABLE terrain layer in climate-aware instanced ground grass.
//
// Placement reuses the deterministic, slope/elevation-gated scatterAssets over the layer's
// heightfield (see grass-plan.ts) — the SAME machinery the tree scatter uses, including the
// footprint-exclusion seam, so grass stops at the settlement edge (no blades on building pads,
// the focal courtyard, or the lane). Blades are ONE InstancedMesh of a small tapered-strip
// geometry with a WebGPU-native TSL node material (MeshStandardNodeMaterial + positionNode wind
// + climate colour) — it renders under the engine's THREE.WebGPURenderer, unlike a classic GLSL
// ShaderMaterial. Modelled on water.ts (the engine's canonical TSL vertex-displacement material)
// and props-render.ts (the InstancedMesh builder).
//
// Deterministic + recorded: the world log carries the grass config (seed/climate/density/…) +
// the terrain it grows on, NEVER the per-blade transforms — replay recomputes identical blades
// over the same recorded terrain + village footprints. The wind animation lives ENTIRELY in the
// render graph (a per-frame `time` uniform), so it never touches the sim/log/replay.

import * as THREE from "../../build/three.bundle.mjs";
import { z } from "../../build/zod.bundle.mjs";
import { MAX_ENTITIES, despawnRenderable, spawnRenderable } from "../ecs/world.ts";
import type { Transformable } from "../ecs/world.ts";
import type { AssetInstance, ScatterExclusion } from "../terrain/asset-scatter.ts";
import { tagEntity } from "./ecs.ts";
import type { SkillDefinition, SkillRegistry } from "./registry.ts";
import type { EditableTerrain } from "./terrain-edit.ts";
import { GRASS_CLIMATES, type GrassClimate, type GrassPlan, planGrassBlades } from "./grass-plan.ts";

// TSL node-graph helpers under the three/webgpu bundle's `TSL` namespace (same access idiom as
// water.ts / terrain/render.ts). Typed loosely — the fluent node API is dynamic and validated by
// the live WebGPU shader compile.
// deno-lint-ignore no-explicit-any
const T = (THREE as any).TSL;

const inertTransform = (): Transformable => ({ position: { set() {} }, quaternion: { set() {} }, scale: { set() {} } });

const Y_AXIS = new THREE.Vector3(0, 1, 0);

/** Options for building the grass render mesh (the visual/geometry knobs, separate from placement). */
export interface GrassMeshOptions {
  climate: GrassClimate;
  /** Base blade height (world units) before per-blade scale jitter. */
  bladeHeight: number;
  /** Base blade width (world units) at the ground; tapers to a point at the tip. */
  bladeWidth: number;
  /** Vertical geometry segments per blade (more = smoother bend). */
  segments: number;
  /** Peak horizontal sway (world units) at the blade tip. */
  windStrength: number;
  /** Sway speed multiplier on the render `time` node. */
  windSpeed: number;
}

/** A vertical blade in local space: base centred at (0,0,0), tip at (0,height,0), tapering from
 *  `width` at the base to a point. Normals point UP so blades shade like the sky-lit ground (a
 *  soft carpet), not as dark verticals. Fixed geometry — per-blade variety comes from the instance
 *  matrix (yaw/scale) + the shader's per-instance hash, so this is deterministic. */
export function buildGrassBladeGeometry(height: number, width: number, segments: number): THREE.BufferGeometry {
  const segs = Math.max(1, Math.round(segments));
  const positions: number[] = [];
  const normals: number[] = [];
  const indices: number[] = [];
  for (let i = 0; i <= segs; i++) {
    const t = i / segs;
    const y = t * height;
    const halfW = (width * 0.5) * (1 - t); // taper to a point at the tip
    positions.push(-halfW, y, 0, halfW, y, 0);
    normals.push(0, 1, 0, 0, 1, 0);
  }
  for (let i = 0; i < segs; i++) {
    const a = i * 2, b = i * 2 + 1, c = i * 2 + 2, d = i * 2 + 3;
    indices.push(a, c, b, b, c, d);
  }
  const geom = new THREE.BufferGeometry();
  geom.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geom.setAttribute("normal", new THREE.Float32BufferAttribute(normals, 3));
  geom.setIndex(indices);
  geom.computeBoundingBox();
  geom.computeBoundingSphere();
  return geom;
}

/** The WebGPU-native (TSL node) grass material: a climate base→tip colour gradient up the blade
 *  with a per-blade brightness jitter, plus a gentle two-octave wind sway that bends the tip most
 *  (amplitude ∝ heightFraction²). Per-blade phase/jitter come from `hash(instanceIndex)` so no
 *  extra attribute buffers are needed and the look is deterministic per instance. Animation is
 *  driven by the render `time` node only — render-graph, never sim state. */
export function buildGrassMaterial(opts: GrassMeshOptions): THREE.MeshStandardNodeMaterial {
  const pal = GRASS_CLIMATES[opts.climate];
  const baseC = new THREE.Color(pal.base); // ColorManagement → linear components
  const tipC = new THREE.Color(pal.tip);
  const material = new THREE.MeshStandardNodeMaterial({ roughness: 0.92, metalness: 0.0, side: THREE.DoubleSide });

  // Height fraction up the blade (0 = base, 1 = tip).
  const hf = T.clamp(T.positionLocal.y.div(opts.bladeHeight), 0, 1);

  // Per-blade deterministic randoms from the instance index.
  const idxF = T.float(T.instanceIndex);
  const rndPhase = T.hash(idxF);
  const rndTint = T.hash(idxF.add(1013.0));
  const phase = rndPhase.mul(Math.PI * 2);

  // Two-octave sway; amplitude ramps with height² so the base stays planted and the tip bends.
  const w1 = T.time.mul(opts.windSpeed).add(phase).sin();
  const w2 = T.time.mul(opts.windSpeed * 0.47).add(phase.mul(1.7)).sin().mul(0.5);
  const sway = w1.add(w2);
  const bend = hf.mul(hf).mul(opts.windStrength).mul(sway);
  // Bend in the blade's LOCAL frame → the instance yaw rotates it, so blades sway in varied
  // directions (a coherent world wind field is the fidelity upgrade — see the report).
  material.positionNode = T.positionLocal.add(T.vec3(bend, 0, bend.mul(0.3)));

  // Colour: base→tip gradient + a small per-blade brightness jitter so the carpet isn't flat.
  const jitter = rndTint.sub(0.5).mul(0.14);
  let col = T.mix(T.vec3(baseC.r, baseC.g, baseC.b), T.vec3(tipC.r, tipC.g, tipC.b), hf);
  col = col.add(jitter);
  if (pal.snowMix > 0) {
    const snow = T.smoothstep(0.4, 1.0, hf).mul(pal.snowMix);
    col = T.mix(col, T.vec3(0.9, 0.92, 0.95), snow);
  }
  material.colorNode = col;
  return material;
}

/** Build ONE InstancedMesh carpeting the terrain from `placements` (from planGrassBlades). Each
 *  blade's matrix is translate (x,y,z on the ground) · yaw about +Y · uniform scale. Returns null
 *  for an empty carpet. `frustumCulled = false` because the instanced bounds span the whole tile. */
export function buildGrassInstancedMesh(placements: AssetInstance[], opts: GrassMeshOptions): THREE.InstancedMesh | null {
  if (placements.length === 0) return null;
  const geom = buildGrassBladeGeometry(opts.bladeHeight, opts.bladeWidth, opts.segments);
  const material = buildGrassMaterial(opts);
  const mesh = new THREE.InstancedMesh(geom, material, placements.length);
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const pos = new THREE.Vector3();
  const scl = new THREE.Vector3();
  for (let i = 0; i < placements.length; i++) {
    const p = placements[i];
    pos.set(p.x, p.y, p.z);
    q.setFromAxisAngle(Y_AXIS, p.yaw);
    scl.set(p.scale, p.scale, p.scale);
    m.compose(pos, q, scl);
    mesh.setMatrixAt(i, m);
  }
  mesh.instanceMatrix.needsUpdate = true;
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  mesh.frustumCulled = false;
  mesh.name = "limina:grass";
  return mesh;
}

/** Dispose a grass InstancedMesh's GPU resources after removal from the scene. */
export function disposeGrassMesh(mesh: unknown): void {
  const m = mesh as { geometry?: { dispose?: () => void }; material?: { dispose?: () => void }; dispose?: () => void };
  m.geometry?.dispose?.();
  m.material?.dispose?.();
  m.dispose?.();
}

/** Sea level + snow line (world Y) for a terrain layer. Prefer the layer's stashed elevation ramp
 *  (terrain.create sets it for generated layers); otherwise derive from the tile's height range so
 *  a flat/imported layer still gets sane grass bounds. */
function grassElevationBounds(layer: EditableTerrain): { seaLevel: number; snowLine: number } {
  const oy = layer.tile.origin[1];
  const ramp = layer.elevationColors;
  if (ramp !== undefined) {
    const snowFrac = ramp.snowFrac ?? 0.95;
    return { seaLevel: ramp.seaLevel, snowLine: oy + ramp.amplitude * snowFrac };
  }
  const h = layer.tile.heights;
  const sy = layer.tile.scale[1];
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < h.length; i++) { const v = h[i]; if (v < lo) lo = v; if (v > hi) hi = v; }
  if (!isFinite(lo)) { lo = 0; hi = 1; }
  const seaLevel = oy + lo * sy;
  const amp = Math.max(1, (hi - lo) * sy);
  return { seaLevel, snowLine: seaLevel + amp * 0.95 };
}

type SceneLike = { add?: (o: unknown) => void; remove?: (o: unknown) => void };

const grassInput = z.object({
  /** Terrain layer to carpet. Defaults to the most recently created one. */
  terrain: z.string().optional(),
  /** Climate profile — drives blade colour + default density (green summer / gold autumn /
   *  sparse-dry / snow-dusted winter). */
  climate: z.enum(["summer", "autumn", "dry", "winter"]).default("summer"),
  /** Candidate samples per grid axis (density² candidates). Grass wants a high value to carpet. */
  density: z.number().int().min(1).max(512).default(220),
  /** Scatter salt — same seed reproduces the same carpet. */
  seed: z.number().int().default(1337),
  /** Fraction of passing candidates placed. Defaults to the climate's coverage. */
  coverage: z.number().min(0).max(1).optional(),
  /** Clumping strength [0,1] — >0 gathers grass into denser tufts. */
  cluster: z.number().min(0).max(1).default(0.3),
  /** Max local slope (rise/run) — steeper faces stay bare. */
  slopeMax: z.number().min(0).default(0.6),
  /** World-Y floor. Defaults to the layer's sea level (grass grows above water). */
  elevationMin: z.number().optional(),
  /** World-Y ceiling. Defaults to the layer's snow line (grass thins below it). */
  elevationMax: z.number().optional(),
  /** Per-blade uniform scale range (height + width jitter). */
  sizeRange: z.tuple([z.number().positive(), z.number().positive()]).default([0.7, 1.3]),
  /** Base blade height (world units) before scale jitter. */
  bladeHeight: z.number().positive().default(0.5),
  /** Base blade width (world units) at the ground. */
  bladeWidth: z.number().positive().default(0.09),
  /** Peak tip sway (world units). */
  windStrength: z.number().min(0).default(0.12),
  /** Sway speed. */
  windSpeed: z.number().min(0).default(1.2),
  /** Extra keep-out discs — UNIONED with the settlement footprints for this terrain, so grass
   *  avoids the village with no manual wiring (identical seam to vegetation.scatter). */
  exclusions: z.array(z.object({ x: z.number(), z: z.number(), r: z.number().nonnegative() })).optional(),
  /** Extra tags for the grass entity (always tagged "grass" + "vegetation"). */
  tags: z.array(z.string()).optional(),
});

/** Register vegetation.grass. Shares the terrain-layer map + the settlement-footprint registry
 *  with vegetation.scatter / village.build, so a build-then-carpet flow clears the buildings,
 *  courtyard, and lane automatically. */
export function registerGrassSkill(
  registry: SkillRegistry,
  layers: Map<string, EditableTerrain>,
  footprints: Map<string, ScatterExclusion[]> = new Map(),
  mounted: Map<string, () => void> = new Map(),
  /** Shared VEGETATION-CLEAR registry (keyed by terrain id) — see registerVegetationSkills. This
   *  grass registers a re-mount closure so a carpet grown BEFORE village.build is subtractively
   *  cleared on the settlement footprints once village.build registers them. */
  vegetationClears: Map<string, Array<() => void | Promise<void>>> = new Map(),
): void {
  const grass: SkillDefinition<z.infer<typeof grassInput>, { entity: string; blades: number; exclusions: number }> = {
    name: "vegetation.grass",
    version: "1.0.0",
    description: "Carpet an editable terrain layer in climate-aware instanced ground grass, gated by slope + elevation (above water / below the snow line) and the SAME settlement footprints trees honor (so grass stops at the building pads / courtyard / lane). One InstancedMesh of tapered blades with a WebGPU-native TSL material (climate colour + gentle wind). Deterministic + recorded: the log carries the config, never the per-blade transforms. Returns the grass entity + blade count.",
    category: "terrain",
    permissions: ["scene.write"],
    input: grassInput,
    output: z.object({ entity: z.string(), blades: z.number().int(), exclusions: z.number().int() }),
    handler: (input, ctx) => {
      // Resolve the terrain layer (default: most recently created).
      let terrainId = input.terrain;
      if (terrainId === undefined) { let last: string | undefined; for (const k of layers.keys()) last = k; terrainId = last; }
      const layer = terrainId !== undefined ? layers.get(terrainId) : undefined;
      if (layer === undefined) throw new Error("vegetation.grass: no terrain layer — create one with terrain.create first");

      const pal = GRASS_CLIMATES[input.climate];
      const bounds = grassElevationBounds(layer);
      const elevationMin = input.elevationMin ?? bounds.seaLevel;
      const elevationMax = input.elevationMax ?? bounds.snowLine;
      const coverage = input.coverage ?? pal.coverage;

      // Placements are a PURE function of the terrain + the terrain's CURRENT footprints (unioned
      // with any explicit exclusions) — the SAME seam trees use. Computing them fresh on each
      // (re)mount carpets the whole buildable ground when no village exists yet AND re-carpets with
      // the buildings/courtyard/lane carved out once village.build has registered its footprints
      // (the causal "grass grows first, then civilization clears it" order). Replay-safe: footprints
      // + the grass plan are pure over the recorded ops.
      const computePlacements = (): AssetInstance[] => {
        const registered = footprints.get(terrainId!) ?? [];
        const allExclusions: ScatterExclusion[] = [...registered, ...(input.exclusions ?? [])];
        const plan: GrassPlan = {
          seed: input.seed,
          density: input.density,
          coverage,
          cluster: input.cluster,
          slopeMax: input.slopeMax,
          sizeRange: input.sizeRange,
          elevationMin,
          elevationMax,
          exclusions: allExclusions,
        };
        return planGrassBlades(layer.tile, plan);
      };

      const scene = ctx.world.scene as SceneLike | undefined;
      const canRender = ctx.world.mode !== "headless" && scene !== undefined && typeof scene.add === "function";
      let mesh: unknown = null;
      let placements: AssetInstance[] = computePlacements();

      const disposeMesh = (): void => {
        if (mesh !== null) { if (typeof scene?.remove === "function") scene.remove(mesh); disposeGrassMesh(mesh); mesh = null; }
      };

      // (Re)build the single carpet InstancedMesh from freshly-computed placements. Drops the prior
      // mesh first — after village.build registers footprints, the recompute yields the carpet MINUS
      // the blades on the settlement (a strict subset) and the old full carpet is disposed.
      const remount = (): void => {
        placements = computePlacements();
        if (!canRender) return;
        disposeMesh();
        try {
          const built = buildGrassInstancedMesh(placements, {
            climate: input.climate,
            bladeHeight: input.bladeHeight,
            bladeWidth: input.bladeWidth,
            segments: 4,
            windStrength: input.windStrength,
            windSpeed: input.windSpeed,
          });
          if (built !== null) { scene!.add(built); mesh = built; }
        } catch (err) {
          ctx.emit("vegetation.grass_mount_failed", { message: err instanceof Error ? err.message : String(err) });
        }
      };

      remount();

      // A grass handle entity (world-integrated + removable), anchored at the terrain origin.
      const [ox, oy, oz] = layer.tile.origin;
      const eid = spawnRenderable(ctx.world.ecs, inertTransform(), ox, oy, oz);
      if (eid >= MAX_ENTITIES) { despawnRenderable(ctx.world.ecs, eid); throw new Error("vegetation.grass: entity capacity exceeded"); }
      const origin = { tool: "vegetation.grass", input: { ...input } };
      const entity = ctx.world.entities.create({ eid, origin });
      tagEntity(ctx as never, entity, ["grass", "vegetation", ...(input.tags ?? [])]);
      mounted.set(entity, disposeMesh);
      // Register the subtractive-clear closure: village.build calls it after registering footprints,
      // so a carpet grown before the village is re-grown with the settlement footprints carved out.
      const clears = vegetationClears.get(terrainId) ?? [];
      clears.push(() => { remount(); });
      vegetationClears.set(terrainId, clears);

      ctx.emit("vegetation.grass_scattered", { entity, terrain: terrainId, blades: placements.length, mounted: mesh !== null ? placements.length : 0, climate: input.climate });
      return { entity, blades: placements.length, exclusions: (footprints.get(terrainId) ?? []).length + (input.exclusions?.length ?? 0) };
    },
  };

  registry.register(grass as unknown as Parameters<SkillRegistry["register"]>[0]);
}
