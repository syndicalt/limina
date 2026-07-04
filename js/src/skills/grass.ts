// vegetation.grass — carpet an EDITABLE terrain layer in climate-aware instanced ground grass.
//
// Placement reuses the deterministic, slope/elevation-gated scatterAssets over the layer's
// heightfield (see grass-plan.ts) — the SAME machinery the tree scatter uses, including the
// footprint-exclusion seam, so grass stops at the settlement edge (no blades on building pads,
// the focal courtyard, or the lane). Blades are ONE InstancedMesh of a curved, tapered blade
// with a WebGPU-native TSL node material (MeshStandardNodeMaterial + positionNode wind + climate
// colour + subsurface glow) — it renders under the engine's THREE.WebGPURenderer, unlike a classic
// GLSL ShaderMaterial. Modelled on water.ts (the engine's canonical TSL vertex-displacement
// material) and props-render.ts (the InstancedMesh builder).
//
// The blade geometry, three-layer wind, subsurface-scattering approximation and blade-type presets
// are adapted from the MIT-licensed `procedural-grass` skill (Three.js WebGPU/TSL grass system —
// bezier-curved tapered blades, layered wind, SSS). Ported to the engine's MeshStandardNodeMaterial
// + deterministic scatter placement + terrain grounding + settlement exclusion seam.
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
import type { TerrainTile } from "../terrain/types.ts";
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

/** The engine's key sun, surface→light direction (render-baseline DEFAULT: light sits at (5,9,6)
 *  aimed at the origin). Normalised here so the SSS backlight term matches how the scene is lit —
 *  grass glows when the camera looks toward the sun through the blades. */
const SUN_DIR = new THREE.Vector3(5, 9, 6).normalize();
const SUN_COLOR = new THREE.Color(0xfff4e6); // render-baseline sun colour (linear components)
/** Golden dry-blade tip colour — a fraction of blades (the "driest") fade toward this at the tip
 *  so the sward carries the natural yellow-green ↔ deep-green ↔ dry variation of a real lawn. */
const DRY_TIP = new THREE.Color(0xc7b26a);
/** A single coherent world wind direction (unit XZ) — gust fronts roll across the field along it. */
const WIND_DIR = ((): [number, number] => { const x = 0.85, z = 0.53; const l = Math.hypot(x, z); return [x / l, z / l]; })();

/** Options for building the grass render mesh (the visual/geometry knobs, separate from placement). */
export interface GrassMeshOptions {
  climate: GrassClimate;
  /** Base blade height (world units) before per-blade scale jitter. */
  bladeHeight: number;
  /** Base blade width (world units) at the ground; tapers to a point at the tip. */
  bladeWidth: number;
  /** Vertical geometry segments per blade (more = smoother bezier bend). */
  segments: number;
  /** Lateral bow of the blade tip (world units) — the quadratic-bezier control offset. */
  curvature: number;
  /** Peak horizontal sway (world units) at the blade tip (wind base amplitude). */
  windStrength: number;
  /** Sway speed multiplier on the render `time` node. */
  windSpeed: number;
  /** Gust-front amplitude (world units) — the medium-frequency wave rolling across the field. */
  windGust: number;
  /** Gust-front spatial frequency (rad/world-unit along the wind direction). */
  windGustFreq: number;
  /** Subsurface-scattering (backlit translucency) strength [0..~1]. */
  sssStrength: number;
  /** Root ambient-occlusion darkening [0..1] — grounds the blade base into the turf. */
  aoStrength: number;
  /** Hard cap on rendered blade instances (bounded draw cost) — placements above it are decimated
   *  by a deterministic uniform stride. */
  maxBlades: number;
}

/** A curved, tapered grass blade in local space (adapted from the MIT procedural-grass skill's
 *  `createBladeGeometry`). The blade follows a QUADRATIC BEZIER — p0=(0,0), control≈(curvature,½h),
 *  p2=(0,h) — so it bows and tapers from `width` at the base to a point at the tip, with `segments`
 *  cross-sections plus one tip vertex. Normals point UP so the blades shade like the sky-lit ground
 *  (a soft, grounded carpet) rather than dark verticals; the engine's MeshStandardNodeMaterial then
 *  lights them from the sun/hemisphere with the SSS backlight added on top. Fixed geometry —
 *  per-blade variety comes from the instance matrix (yaw/scale) + the baked wind attribute, so this
 *  is deterministic. */
export function buildGrassBladeGeometry(height: number, width: number, segments: number, curvature: number): THREE.BufferGeometry {
  const segs = Math.max(1, Math.min(8, Math.round(segments)));
  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  for (let i = 0; i <= segs; i++) {
    const t = i / segs;
    // Quadratic bezier lateral bow: x = 2(1-t)t·curvature (0 at base + tip, max at mid), y = t·h.
    const x = 2 * (1 - t) * t * curvature;
    const y = t * height;
    const halfW = (width * 0.5) * (1 - t * 0.8); // taper toward the tip (matches the skill)
    positions.push(x - halfW, y, 0, x + halfW, y, 0);
    normals.push(0, 1, 0, 0, 1, 0);
    uvs.push(0, t, 1, t);
  }
  // Tip vertex at the bezier endpoint (x=0, y=height) — closes the blade to a point.
  const tip = (segs + 1) * 2;
  positions.push(0, height, 0);
  normals.push(0, 1, 0);
  uvs.push(0.5, 1);
  for (let i = 0; i < segs; i++) {
    const a = i * 2, b = i * 2 + 1, c = i * 2 + 2, d = i * 2 + 3;
    indices.push(a, c, b, b, c, d);
  }
  // Cap the last cross-section to the tip.
  indices.push(segs * 2, tip, segs * 2 + 1);
  const geom = new THREE.BufferGeometry();
  geom.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geom.setAttribute("normal", new THREE.Float32BufferAttribute(normals, 3));
  geom.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  geom.setIndex(indices);
  geom.computeBoundingBox();
  geom.computeBoundingSphere();
  return geom;
}

/** The WebGPU-native (TSL node) grass material, adapted from the MIT procedural-grass skill's
 *  TSL/WebGPU path onto the engine's MeshStandardNodeMaterial:
 *   - COLOUR: a climate base→tip gradient up the blade, a small per-blade brightness jitter, and a
 *     root ambient-occlusion darkening so the base reads planted (grounded turf, not floating).
 *   - THREE-LAYER WIND in the position node: (1) a low-frequency GLOBAL sway along a single world
 *     wind direction, (2) medium-frequency GUST FRONTS whose phase rolls across the field by world
 *     position (with a soft envelope so gusts come in patches), (3) per-blade high-frequency
 *     TURBULENCE. Amplitude ramps with heightFraction² so the base stays planted and the tip bends
 *     most. The displacement is computed in the WORLD wind direction and counter-rotated by the
 *     blade's baked yaw into local space, so after the instance yaw it lands as a COHERENT world
 *     wind field (all blades lean the same way in a gust), not per-blade-random.
 *   - SSS: a subsurface-scattering approximation added as emissive — when the camera looks toward
 *     the sun THROUGH a blade, the tip glows with a warm, grass-tinted translucency.
 *  Per-blade phase/tint/yaw come from a baked `aWind` instanced attribute (worldX, worldZ, tint,
 *  yaw) so the wind field is world-coherent. All animation is driven by the render `time` node only
 *  — render-graph, never sim state, so replay/determinism are untouched. */
export function buildGrassMaterial(opts: GrassMeshOptions): THREE.MeshStandardNodeMaterial {
  const pal = GRASS_CLIMATES[opts.climate];
  const baseC = new THREE.Color(pal.base); // ColorManagement → linear components
  const tipC = new THREE.Color(pal.tip);
  const baseV = T.vec3(baseC.r, baseC.g, baseC.b);
  const tipV = T.vec3(tipC.r, tipC.g, tipC.b);
  const dryV = T.vec3(DRY_TIP.r, DRY_TIP.g, DRY_TIP.b);
  const material = new THREE.MeshStandardNodeMaterial({ roughness: 0.9, metalness: 0.0, side: THREE.DoubleSide });

  // Height fraction up the blade (0 = base, 1 = tip) FROM THE GEOMETRY y (pre per-blade height
  // scaling), so it stays in [0,1] and the base is always planted at the ground. h2 = base-planted
  // bend weight; bezierW = the quadratic-bezier bow weight (0 at base+tip, peak mid-blade).
  const pl = T.positionLocal;
  const hf = T.clamp(pl.y.div(opts.bladeHeight), 0, 1);
  const h2 = hf.mul(hf);
  const bezierW = hf.mul(T.oneMinus(hf)).mul(4.0);

  // Baked per-blade data needed for a COHERENT world wind field: (worldX, worldZ, unused, yaw).
  const aw = T.attribute("aWind", "vec4");
  const wx = aw.x, wz = aw.y, yaw = aw.w;

  // ── PER-BLADE VARIATION (deterministic, from hash(instanceIndex) — no Math.random) ──────────────
  // Each blade draws its own width, height, extra bezier curvature, static lean direction, wind
  // phase, brightness, hue and dryness, so the field reads as many distinct blades, not one stamp.
  const idxF = T.float(T.instanceIndex);
  const rW = T.hash(idxF.add(2.0));
  const rH = T.hash(idxF.add(11.0));
  const rC = T.hash(idxF.add(23.0));
  const rL = T.hash(idxF.add(37.0));
  const rP = T.hash(idxF.add(53.0));
  const rS = T.hash(idxF.add(67.0));
  const rHue = T.hash(idxF.add(83.0));
  const rDry = T.hash(idxF.add(97.0));

  const widthMul = rW.mul(0.6).add(0.6);                  // 0.60 .. 1.20 × base width (fine blades)
  const heightMul = rH.mul(0.6).add(0.7);                 // 0.70 .. 1.30 × base height
  const curveExtra = rC.sub(0.28).mul(opts.curvature * 2.4); // signed extra bow (some near-straight)
  const leanAmt = rL.sub(0.5).mul(opts.bladeHeight * 0.55);   // signed static tip lean (varied dir via yaw)
  const phase = rP.mul(6.2832);

  // Shaped blade in LOCAL space: width scales x about the centre; extra bezier bow peaks mid-blade;
  // a static lean grows toward the tip (h2). Height scales y (base stays at y=0 → still grounded).
  let px = pl.x.mul(widthMul);
  px = px.add(bezierW.mul(curveExtra));
  px = px.add(h2.mul(leanAmt));
  const py = pl.y.mul(heightMul);

  // ── THREE-LAYER WIND (render-graph only, driven by the `time` node) ─────────────────────────────
  const along = wx.mul(WIND_DIR[0]).add(wz.mul(WIND_DIR[1]));
  const t = T.time.mul(opts.windSpeed);
  // Layer 1 — global sway (low freq) with a per-blade phase so blades don't move in lock-step.
  const global = along.mul(0.25).add(t.mul(1.2)).add(phase).sin().mul(opts.windStrength);
  // Layer 2 — gust fronts (medium freq rolling wave) with a soft moving envelope (patchy gusts).
  const gustEnv = T.smoothstep(
    0.15, 0.85,
    along.mul(0.06).add(t.mul(0.3)).sin().mul(0.25).add(wz.mul(0.07).sub(t.mul(0.22)).sin().mul(0.25)).add(0.5),
  );
  const gust = along.mul(opts.windGustFreq).add(t.mul(2.5)).sin().mul(opts.windGust).mul(gustEnv);
  // Layer 3 — per-blade turbulence (high freq flutter, off the per-blade phase).
  const turb = t.mul(3.0).add(phase.mul(1.9)).sin().mul(opts.windStrength * 0.35);

  const swayAmt = global.add(gust).add(turb).mul(h2);
  // Counter-rotate the WORLD wind offset by the blade's yaw into local space so that AFTER the
  // instance yaw it points along the SAME world direction for every blade (coherent field).
  const cy = yaw.cos(), sy = yaw.sin();
  const wWX = swayAmt.mul(WIND_DIR[0]), wWZ = swayAmt.mul(WIND_DIR[1]);
  const windLX = cy.mul(wWX).sub(sy.mul(wWZ));
  const windLZ = sy.mul(wWX).add(cy.mul(wWZ));

  material.positionNode = T.vec3(px.add(windLX), py, pl.z.add(windLZ));

  // ── COLOUR: base→tip gradient + per-blade hue/shade jitter + dry golden tips on some blades ──────
  const shade = rS.sub(0.5).mul(0.18);                    // ±0.09 brightness
  const hueShift = rHue.sub(0.5);                         // warm (yellow-green) ↔ cool (deep green)
  let col = T.mix(baseV, tipV, hf);
  col = col.add(T.vec3(hueShift.mul(0.07), hueShift.mul(0.02), hueShift.mul(-0.04)));
  // Dry golden tips on only the driest ~30% of blades, near the tip — a minority accent, not a wash.
  const dryPick = T.smoothstep(0.62, 1.0, rDry);
  const dryAmt = T.smoothstep(0.5, 1.0, hf).mul(dryPick).mul(0.5);
  col = T.mix(col, dryV, dryAmt);
  col = col.add(shade);
  // Root ambient occlusion: darken the base, full brightness by ~1/3 up the blade — grounds the turf.
  const ao = T.mix(T.float(1.0 - opts.aoStrength), T.float(1.0), T.smoothstep(0.0, 0.35, hf));
  col = col.mul(ao);
  if (pal.snowMix > 0) {
    const snow = T.smoothstep(0.4, 1.0, hf).mul(pal.snowMix);
    col = T.mix(col, T.vec3(0.9, 0.92, 0.95), snow);
  }
  col = T.max(col, 0.0);
  material.colorNode = col;

  // ── SUBSURFACE SCATTERING (backlit translucency) as emissive: strongest when the view opposes
  // the sun (camera looking toward the sun through the blade), scaled up the blade so the tips glow.
  const V = T.cameraPosition.sub(T.positionWorld).normalize();
  const back = T.max(V.negate().dot(T.vec3(SUN_DIR.x, SUN_DIR.y, SUN_DIR.z)), 0.0);
  const sss = back.pow(3.0).mul(opts.sssStrength).mul(hf);
  material.emissiveNode = col.mul(T.vec3(SUN_COLOR.r, SUN_COLOR.g, SUN_COLOR.b)).mul(sss);

  return material;
}

/** Build ONE InstancedMesh carpeting the terrain from `placements` (from planGrassBlades). Each
 *  blade's matrix is translate (x,y,z on the ground) · yaw about +Y · uniform scale; a parallel
 *  `aWind` instanced attribute bakes (worldX, worldZ, 0, yaw) so the TSL material can drive a
 *  world-coherent wind field (the rest of the per-blade variation is hashed off the instance index).
 *  `opts.maxBlades` caps the instance count for BOUNDED render cost — placements above the cap are
 *  dropped by a deterministic uniform stride so the carpet thins evenly rather than clipping a
 *  corner. Returns null for an empty carpet. `frustumCulled = false` because the instanced bounds
 *  span the whole tile and wind pushes blades past them. */
export function buildGrassInstancedMesh(placements: AssetInstance[], opts: GrassMeshOptions): THREE.InstancedMesh | null {
  if (placements.length === 0) return null;
  // Deterministic decimation to the blade budget for bounded draw cost. Thinning must be SPATIALLY
  // UNIFORM: an `i % stride` filter over the row-major placement list thins in spatial STRIPES
  // (banding), so instead we keep a blade when a hash of its WORLD position falls under the keep
  // fraction — a spatially-uncorrelated, replay-stable thinning that leaves an even carpet.
  const cap = Math.max(1, Math.floor(opts.maxBlades));
  let kept: AssetInstance[] = placements;
  if (placements.length > cap) {
    const keepFrac = cap / placements.length;
    const thr = keepFrac * 4294967296;
    kept = placements.filter((p) => {
      const ix = Math.round(p.x * 137.0) | 0, iz = Math.round(p.z * 149.0) | 0;
      let h = (Math.imul(ix, 374761393) ^ Math.imul(iz, 668265263)) >>> 0;
      h = Math.imul(h ^ (h >>> 13), 1274126177) >>> 0;
      return (h >>> 0) < thr;
    });
  }

  const geom = buildGrassBladeGeometry(opts.bladeHeight, opts.bladeWidth, opts.segments, opts.curvature);
  const material = buildGrassMaterial(opts);
  const n = kept.length;
  const mesh = new THREE.InstancedMesh(geom, material, n);
  const wind = new Float32Array(n * 4);
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const pos = new THREE.Vector3();
  const scl = new THREE.Vector3();
  for (let i = 0; i < n; i++) {
    const p = kept[i];
    pos.set(p.x, p.y, p.z);
    q.setFromAxisAngle(Y_AXIS, p.yaw);
    scl.set(p.scale, p.scale, p.scale);
    m.compose(pos, q, scl);
    mesh.setMatrixAt(i, m);
    wind[i * 4] = p.x;
    wind[i * 4 + 1] = p.z;
    wind[i * 4 + 2] = 0;
    wind[i * 4 + 3] = p.yaw;
  }
  geom.setAttribute("aWind", new THREE.InstancedBufferAttribute(wind, 4));
  mesh.instanceMatrix.needsUpdate = true;
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  mesh.frustumCulled = false;
  mesh.name = "limina:grass";
  return mesh;
}

/** Parameters for the ground-tint overlay — the same elevation/slope gate + settlement-footprint
 *  exclusions the blades honour, so the tint covers EXACTLY the buildable-ground-minus-settlement
 *  area the grass grows on. */
export interface GrassGroundTintOptions {
  baseColor: number;
  elevationMin: number;
  elevationMax: number;
  slopeMax: number;
  exclusions: ScatterExclusion[];
  /** Peak opacity of the tint where the mask is fully inside the grass footprint. */
  opacity: number;
}

/** Build a thin GROUND-TINT overlay that hugs the terrain surface and paints it toward the grass
 *  BASE colour ONLY inside the grass footprint (elevation band ∩ slope gate ∩ outside every
 *  settlement footprint disc) — so the gaps between blades read as grass-shadowed turf that matches
 *  the blade bases, while sand, rock, the earthen plaza, the cobbled courtyard and snow (all OUTSIDE
 *  that mask) are left untouched. A grid conforming to the tile heightfield carries a per-vertex
 *  RGBA tint (green + a small deterministic brightness jitter; alpha = the mask), read explicitly by
 *  a TSL node material so the overlay fades to fully transparent at the footprint edge. Lifted a few
 *  cm to avoid z-fighting; the blades sitting on it hide the lift. Deterministic + THREE-only render
 *  state (never sim/log). Returns null when the mask is empty (no grass area). */
export function buildGrassGroundTint(tile: TerrainTile, opts: GrassGroundTintOptions): THREE.Mesh | null {
  const { nrows, ncols, heights } = tile;
  const [ox, oy, oz] = tile.origin;
  const [sx, sy, sz] = tile.scale;
  const base = new THREE.Color(opts.baseColor); // → linear components
  const exN = opts.exclusions.length;
  const runX = ((sx / Math.max(1, ncols - 1)) * 2) || 1;
  const runZ = ((sz / Math.max(1, nrows - 1)) * 2) || 1;
  const h = (r: number, c: number): number => heights[r * ncols + c];

  const positions = new Float32Array(nrows * ncols * 3);
  const tintAttr = new Float32Array(nrows * ncols * 4); // rgb + alpha (mask)
  let anyMask = false;
  for (let r = 0; r < nrows; r++) {
    for (let c = 0; c < ncols; c++) {
      const vi = r * ncols + c;
      const x = ox - sx / 2 + (c / Math.max(1, ncols - 1)) * sx;
      const z = oz - sz / 2 + (r / Math.max(1, nrows - 1)) * sz;
      const y = oy + h(r, c) * sy;
      positions[vi * 3] = x;
      positions[vi * 3 + 1] = y + 0.03; // small lift to defeat z-fighting with the terrain mesh
      positions[vi * 3 + 2] = z;
      // Local slope (rise/run) — same discrete form scatterAssets gates blade placement with.
      const dC = (h(r, Math.min(ncols - 1, c + 1)) - h(r, Math.max(0, c - 1))) * sy;
      const dR = (h(Math.min(nrows - 1, r + 1), c) - h(Math.max(0, r - 1), c)) * sy;
      const slope = Math.sqrt((dC / runX) * (dC / runX) + (dR / runZ) * (dR / runZ));
      let masked = y >= opts.elevationMin && y <= opts.elevationMax && slope <= opts.slopeMax;
      if (masked && exN > 0) {
        for (let e = 0; e < exN; e++) {
          const ex = opts.exclusions[e], dx = x - ex.x, dz = z - ex.z;
          if (dx * dx + dz * dz <= ex.r * ex.r) { masked = false; break; }
        }
      }
      // Deterministic per-vertex brightness jitter (no Math.random) so the turf isn't dead flat.
      let hsh = (Math.imul(c + 1, 374761393) ^ Math.imul(r + 1, 668265263)) >>> 0;
      hsh = Math.imul(hsh ^ (hsh >>> 13), 1274126177) >>> 0;
      const j = 0.9 + (hsh / 4294967296) * 0.2; // 0.9 .. 1.1
      tintAttr[vi * 4] = base.r * j;
      tintAttr[vi * 4 + 1] = base.g * j;
      tintAttr[vi * 4 + 2] = base.b * j;
      tintAttr[vi * 4 + 3] = masked ? opts.opacity : 0;
      if (masked) anyMask = true;
    }
  }
  if (!anyMask) return null;

  const indices: number[] = [];
  for (let r = 0; r < nrows - 1; r++) {
    for (let c = 0; c < ncols - 1; c++) {
      const a = r * ncols + c, b = r * ncols + c + 1, cc = (r + 1) * ncols + c, d = (r + 1) * ncols + c + 1;
      indices.push(a, cc, b, b, cc, d);
    }
  }
  const geom = new THREE.BufferGeometry();
  geom.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geom.setAttribute("aTint", new THREE.Float32BufferAttribute(tintAttr, 4));
  geom.setIndex(indices);
  geom.computeVertexNormals();
  geom.computeBoundingBox();
  geom.computeBoundingSphere();

  const material = new THREE.MeshStandardNodeMaterial({ roughness: 0.95, metalness: 0.0, transparent: true, side: THREE.DoubleSide });
  const at = T.attribute("aTint", "vec4");
  material.colorNode = T.vec3(at.x, at.y, at.z);
  material.opacityNode = at.w;
  material.depthWrite = false; // a translucent tint film — don't occlude the blades' own depth
  const mesh = new THREE.Mesh(geom, material);
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  mesh.renderOrder = -1; // draw under the blades
  mesh.name = "limina:grass-tint";
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
  /** Candidate samples per grid axis (density² candidates). Grass wants a high value to carpet a
   *  dense lawn. Cap raised 512 → 1024 (≤1M candidates) to allow a genuinely lush turf; the ~167K
   *  blades at density 512 already read as a dense lawn and stay in the single-draw-call budget. */
  density: z.number().int().min(1).max(1024).default(360),
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
  /** Base blade height (world units) before scale jitter — SHORT dense turf by default, not tall
   *  meadow. */
  bladeHeight: z.number().positive().default(0.3),
  /** Base blade width (world units) at the ground; tapers to a point at the tip. */
  bladeWidth: z.number().positive().default(0.045),
  /** Vertical bezier segments per blade (3 = lawn LOD, 5 = hero). */
  segments: z.number().int().min(1).max(8).default(3),
  /** Lateral bow of the blade (world units) — the quadratic-bezier control offset. Small for turf. */
  curvature: z.number().min(0).default(0.06),
  /** Peak tip sway (world units) — base wind amplitude. Small for short grass. */
  windStrength: z.number().min(0).default(0.045),
  /** Sway speed. */
  windSpeed: z.number().min(0).default(1.1),
  /** Gust-front amplitude (world units) — medium-frequency wave rolling across the field. */
  windGust: z.number().min(0).default(0.06),
  /** Gust-front spatial frequency (rad/world-unit along the wind direction). */
  windGustFreq: z.number().min(0).default(0.18),
  /** Subsurface-scattering (backlit translucency) strength. */
  sssStrength: z.number().min(0).default(0.5),
  /** Root ambient-occlusion darkening [0..1] — grounds the blade base into the turf. */
  aoStrength: z.number().min(0).max(1).default(0.45),
  /** Opacity [0..1] of the GROUND-TINT overlay that paints the terrain toward the grass base green
   *  under the blades (over the same footprint) so gaps read as turf. 0 disables it. */
  groundTint: z.number().min(0).max(1).default(0.85),
  /** Hard cap on RENDERED blade instances for bounded draw cost — placements above it are decimated
   *  by a deterministic uniform stride (the log still records the full density; only the render
   *  thins). Keeps a huge density request in one bounded single-draw-call carpet. */
  maxBlades: z.number().int().min(1000).default(320000),
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
    description: "Carpet an editable terrain layer in climate-aware instanced ground grass, gated by slope + elevation (above water / below the snow line) and the SAME settlement footprints trees honor (so grass stops at the building pads / courtyard / lane). One InstancedMesh of curved, tapered bezier blades with a WebGPU-native TSL material (climate colour, three-layer coherent wind, subsurface-scattering backlight). Deterministic + recorded: the log carries the config, never the per-blade transforms. Returns the grass entity + blade count.",
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
      let tintMesh: unknown = null;
      let placements: AssetInstance[] = computePlacements();

      const disposeMesh = (): void => {
        if (mesh !== null) { if (typeof scene?.remove === "function") scene.remove(mesh); disposeGrassMesh(mesh); mesh = null; }
        if (tintMesh !== null) { if (typeof scene?.remove === "function") scene.remove(tintMesh); disposeGrassMesh(tintMesh); tintMesh = null; }
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
            segments: input.segments,
            curvature: input.curvature,
            windStrength: input.windStrength,
            windSpeed: input.windSpeed,
            windGust: input.windGust,
            windGustFreq: input.windGustFreq,
            sssStrength: input.sssStrength,
            aoStrength: input.aoStrength,
            maxBlades: input.maxBlades,
          });
          if (built !== null) { scene!.add(built); mesh = built; }
          // GROUND TINT: paint the terrain toward the grass base green over EXACTLY the same
          // footprint (elevation band ∩ slope ∩ outside settlement discs) so the gaps between blades
          // read as turf, not bare ground — sand/rock/plaza/cobble/snow (outside the mask) untouched.
          const registered = footprints.get(terrainId!) ?? [];
          const allExclusions: ScatterExclusion[] = [...registered, ...(input.exclusions ?? [])];
          const tint = buildGrassGroundTint(layer.tile, {
            baseColor: pal.base,
            elevationMin,
            elevationMax,
            slopeMax: input.slopeMax,
            exclusions: allExclusions,
            opacity: input.groundTint,
          });
          if (tint !== null) { scene!.add(tint); tintMesh = tint; }
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
