// Phase 9 / workstream D — THREE BufferGeometry + Mesh for a terrain tile.
//
// The browser/UAT side of the mesh: wraps the PURE `terrainTileGeometry` (mesh.ts)
// in a real THREE BufferGeometry so a generated tile becomes a visible mesh in the
// render path (browser-entry). This module imports THREE and is NOT headless — the
// geometry MATH is proven in js/test/p9_terrain_mesh.ts; the in-tab WebGPU render of
// the result is UAT.

import * as THREE from "../../build/three.bundle.mjs";
import { CLIMATE_BIOME, CLIMATE_PRECIP_MM, CLIMATE_TEMP_C, type TerrainTile } from "./types.ts";
import { terrainTileGeometry } from "./mesh.ts";
import { scatterProps } from "./scatter.ts";
import { buildTilePropMeshes, disposePropMesh } from "./props-render.ts";
import { StreamFollower, tileKey, type StreamFollowOptions, type TileCoord, type TileKey } from "./stream.ts";
import { applyPbrMaterial, type TerrainPbrOptions } from "./material-pbr.ts";
export type { TerrainPbrOptions } from "./material-pbr.ts";

export interface TerrainMeshOptions {
  /** Base albedo (hex). Default a muted terrain green/brown. */
  color?: number;
  roughness?: number;
  metalness?: number;
  /** Draw both faces (debug / steep overhangs). Default false — winding faces +y. */
  doubleSide?: boolean;
  /**
   * OPT-IN tropical shoreline shading (render-only). When set, the sand surface is
   * shaded by its world-Y relative to `seaLevel`: a darker, glossier WET band around
   * the waterline and a bright animated FOAM line right at it — the literal "where
   * water meets sand" wet edge. It is GROUND-TRUTH (the sand mesh knows its own
   * height), deterministic, and needs no scene-depth buffer; the foam lap is driven by
   * the TSL `time` node (render graph only — never the sim/log). Omit for the plain
   * matte sand every other world gets (no behaviour change when absent).
   */
  shoreline?: {
    /** Sea-level world Y the wet/foam bands are centred on. */
    seaLevel: number;
    /** Foam line colour (hex, near-white). Default 0xf2f6f4. */
    foamColor?: number;
    /** Wet-sand tint the dry albedo darkens toward (hex). Default a damp brown. */
    wetColor?: number;
    /** Half-height (world units) of the wet band above/below the waterline. Default 0.9. */
    wetBand?: number;
    /** Half-height (world units) of the bright foam line. Default 0.22. */
    foamBand?: number;
  };
  /**
   * OPT-IN elevation + biome colour ramp (render-only). When set, the surface is shaded
   * per-fragment by its world-Y elevation banded by the tile's CLIMATE — a believable
   * landscape (sandy coast just above the sea → green forest where it's wet / dry grass
   * where it isn't → grey rock on the high+steep flanks → white snow on the high+cold
   * crests → a dark silt tint below the waterline), blended smoothly (no hard stripes).
   * The tile's per-cell climate (temp/precip/biome) is baked into a small DataTexture and
   * sampled by world XZ (the same technique water.ts bakes its depth field with), so the
   * biome — and therefore the colour family — varies SPATIALLY across the tile. Replaces
   * the flat `color`; supersedes `shoreline` when both are set. Omit for the plain matte
   * material every other world gets (no behaviour change when absent).
   */
  palette?: TerrainPaletteOptions;
  /**
   * OPT-IN procedural PBR surface (render-only). When set, the surface is shaded by the SAME
   * elevation+biome bands as `palette`, but each band is a real MATERIAL LAYER — procedural
   * albedo + a real detail NORMAL + honest roughness, projected TRIPLANARLY (no UV stretch on
   * slopes). The detail normals break up the flat "clay" shading so rock reads craggy, grass
   * grained, snow soft, sand rippled — "Grounded Stylized Realism". Supersedes `palette`/
   * `shoreline`. Built from a SHARED baked tileable noise texture (deterministic, render-only).
   * Omit for the plain matte material every other world gets (no behaviour change when absent).
   */
  pbr?: TerrainPbrOptions;
  /**
   * OPT-IN render-only vertical exaggeration of the rendered mesh (the geometry only —
   * the collider/source heights are untouched). Scales each vertex's world-Y about
   * `pivot` by `factor` and recomputes normals, so a gentle DEM reads with more relief.
   * `factor: 1` is identity (geometry byte-identical to the default). NOTE: props/water
   * placed at TRUE heights assume `factor: 1`; only exaggerate for a bare-DEM look.
   */
  exaggerateY?: { factor: number; pivot: number };
}

/**
 * The elevation + biome colour-ramp recipe (opt-in via `TerrainMeshOptions.palette`).
 * Only `seaLevel` is required; the rest default to Earth-like values. The bands are keyed
 * to world-Y relative to `seaLevel`/`maxY` and to the tile's baked climate, so "high",
 * "cold", and "wet" all resolve against the real generated surface + climate.
 */
export interface TerrainPaletteOptions {
  /** Sea-level world Y. Coast sits just above it; everything below reads as wet silt. */
  seaLevel: number;
  /** Region relief used to normalise the high/low elevation bands. Default: the tile's
   *  own world-Y bounding box. Pass the surveyed REGION relief so the snow/rock line is
   *  consistent across tiles of a large region. */
  minY?: number;
  maxY?: number;
  /** Decode window for the baked climate temperature channel (°C). Default [-30, 40]. */
  tempRange?: [number, number];
  /** Decode ceiling for the baked precipitation channel (mm/yr). Default 3000. */
  precipMax?: number;
  /** Precip (mm/yr) below which lowland reads as dry grass / above which as wet forest.
   *  Default [300, 1400]. */
  precipBand?: [number, number];
  /** Fraction of (maxY − seaLevel) over which the sandy coast fades up into lowland.
   *  Default 0.06. */
  coastFrac?: number;
  /** Per-band albedo overrides (sRGB hex). */
  colors?: Partial<{ subSea: number; sand: number; dryGrass: number; forest: number; rock: number; snow: number }>;
}

// TSL handle for the opt-in shoreline graph (loosely typed: the fluent node API is
// dynamic; the graph is validated by the live WebGPU shader compile / in-tab UAT).
// deno-lint-ignore no-explicit-any
const T = (THREE as any).TSL;

/** Build the opt-in shoreline `colorNode`/`roughnessNode` for the sand material: a wet
 *  band + an animated foam line keyed to world-Y vs sea level. Render-only, time-driven
 *  in the render graph (never the sim/log). */
function applyShoreline(
  material: THREE.MeshStandardNodeMaterial,
  dryColor: number,
  baseRough: number,
  shore: NonNullable<TerrainMeshOptions["shoreline"]>,
): void {
  const dry = new THREE.Color(dryColor); // linear components
  const wet = new THREE.Color(shore.wetColor ?? 0x6f5b44);
  const foam = new THREE.Color(shore.foamColor ?? 0xf2f6f4);
  const wetBand = shore.wetBand ?? 0.9;
  const foamBand = shore.foamBand ?? 0.22;

  // Signed height above the waterline (negative = submerged), plus a small time-driven
  // lap so the foam edge breathes in/out like a wash. `ad` = distance from waterline.
  const lap = T.positionWorld.x.mul(0.6).add(T.positionWorld.z.mul(0.55)).add(T.time.mul(1.1)).sin().mul(0.13);
  const ad = T.positionWorld.y.sub(shore.seaLevel).add(lap).abs();

  // Wet band: 1 at the waterline → 0 a `wetBand` away. Foam: a tighter bright band.
  const wetMask = T.oneMinus(T.smoothstep(0, wetBand, ad));
  const foamMask = T.oneMinus(T.smoothstep(0, foamBand, ad));

  const dryV = T.vec3(dry.r, dry.g, dry.b);
  const wetV = T.vec3(wet.r, wet.g, wet.b);
  const foamV = T.vec3(foam.r, foam.g, foam.b);

  let col = T.mix(dryV, wetV, wetMask.mul(0.85));
  col = T.mix(col, foamV, foamMask);
  material.colorNode = col;
  // Wet sand is glossier (lower roughness) → catches a sky sheen; foam/dry stay matte.
  material.roughnessNode = T.float(baseRough).sub(wetMask.mul(Math.max(0, baseRough - 0.45)));
}

/** Default per-band albedo (sRGB hex) for the elevation+biome ramp. Exported so the opt-in
 *  PBR material reuses the SAME band albedos as the flat ramp (consistent colour families). */
export const RAMP_DEFAULT_COLORS = {
  subSea: 0x4a4636,   // damp silt/sand under the waterline
  sand: 0xc2a878,     // warm coastal sand just above the sea
  dryGrass: 0xa7a256, // dry grass / savanna where precip is low
  forest: 0x3f6b34,   // green lowland / forest where precip is high
  rock: 0x756657,     // bare grey-brown rock on the mountainside / high+steep flanks
  snow: 0xf2f4f7,     // snow on the high+cold crests
} as const;

/** A baked per-tile climate field: an RGBA DataTexture (R=temp01, G=precip01, B=biome01)
 *  + the world-XZ rectangle it covers, so the ramp shader can read a fragment's climate
 *  at its world (x,z). Mirrors water.ts's depth bake (DataTexture sampled by world XZ).
 *  Exported so the opt-in PBR material (material-pbr.ts) reuses the SAME climate read as
 *  the flat ramp — the two shaders band identically, only the surface detail differs. */
export interface BakedClimate {
  texture: THREE.DataTexture;
  bounds: { minX: number; minZ: number; maxX: number; maxZ: number };
}

/** Bake the tile's own per-cell climate grid into an RGBA texture (linear-filtered, so the
 *  bands vary smoothly between cells). Self-contained: reads the tile's `climate` channels
 *  in the canonical CLIMATE_* layout (falls back to a neutral temperate field if absent). */
export function bakeTileClimate(tile: TerrainTile, tempRange: [number, number], precipMax: number): BakedClimate {
  const { ncols, nrows } = tile;
  const ch = tile.climateChannels ?? 0;
  const climate = tile.climate;
  const [tMin, tMax] = tempRange;
  const tSpan = Math.max(1e-6, tMax - tMin);
  const data = new Uint8Array(ncols * nrows * 4);
  for (let r = 0; r < nrows; r++) {
    for (let c = 0; c < ncols; c++) {
      const idx = r * ncols + c;
      let tempC = 14, precipMm = 900, biome = 4; // neutral temperate fallback
      if (climate !== undefined && ch > 0) {
        const b = idx * ch;
        tempC = climate[b + CLIMATE_TEMP_C];
        precipMm = climate[b + CLIMATE_PRECIP_MM];
        biome = climate[b + CLIMATE_BIOME];
      }
      const o = idx * 4;
      data[o] = Math.round(Math.min(1, Math.max(0, (tempC - tMin) / tSpan)) * 255);
      data[o + 1] = Math.round(Math.min(1, Math.max(0, precipMm / precipMax)) * 255);
      data[o + 2] = Math.round(Math.min(1, Math.max(0, biome / 6)) * 255);
      data[o + 3] = 255;
    }
  }
  const texture = new THREE.DataTexture(data, ncols, nrows, THREE.RGBAFormat, THREE.UnsignedByteType);
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.needsUpdate = true;
  // Climate cell (r,c) → tile-local UV (rows→z, cols→x), the geometry's world mapping.
  const [ox, oy, oz] = tile.origin;
  const [sx, , sz] = tile.scale;
  void oy;
  const minX = ox - sx / 2, minZ = oz - sz / 2;
  return { texture, bounds: { minX, minZ, maxX: minX + sx, maxZ: minZ + sz } };
}

/** Build the opt-in elevation+biome ramp `colorNode`/`roughnessNode` for a tile's material.
 *  ELEVATION is the PRIMARY driver — a stark green-base → rock-mountainside → snow-PEAK
 *  gradient over the normalised relief above the waterline (plus a sandy coast and sub-sea
 *  silt) — with the baked climate only MODULATING it: precip splits the green band into dry
 *  grass vs forest, a cold climate lowers the snow line a touch (but never moves snow off the
 *  high band), and steep slopes expose cliff rock. Render-only, no time node (static surface);
 *  reflections still come from `scene.environment`. */
function applyBiomeRamp(material: THREE.MeshStandardNodeMaterial, tile: TerrainTile, baseRough: number, pal: TerrainPaletteOptions): void {
  const tempRange = pal.tempRange ?? [-30, 40];
  const precipMax = pal.precipMax ?? 3000;
  const [precipDry, precipWet] = pal.precipBand ?? [300, 1400];
  const [tMin, tMax] = tempRange;
  const tSpan = tMax - tMin;

  const cols = { ...RAMP_DEFAULT_COLORS, ...(pal.colors ?? {}) };
  const C = (hex: number) => { const c = new THREE.Color(hex); return T.vec3(c.r, c.g, c.b); };
  const subSeaV = C(cols.subSea), sandV = C(cols.sand), dryV = C(cols.dryGrass);
  const forestV = C(cols.forest), rockV = C(cols.rock), snowV = C(cols.snow);

  const sea = pal.seaLevel;
  // Default relief = the tile's own world-Y bounds (from its raw heights × scaleY).
  let minY = pal.minY, maxY = pal.maxY;
  if (minY === undefined || maxY === undefined) {
    const oy = tile.origin[1], sy = tile.scale[1];
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < tile.heights.length; i++) { const h = tile.heights[i]; if (h < lo) lo = h; if (h > hi) hi = h; }
    minY = pal.minY ?? (oy + lo * sy);
    maxY = pal.maxY ?? (oy + hi * sy);
  }
  const aboveSpan = Math.max(1e-3, maxY - sea);
  const coastBand = Math.max(1e-3, aboveSpan * (pal.coastFrac ?? 0.06));
  const subBand = Math.max(0.5, (sea - minY) * 0.6);

  // Climate sampled at the fragment's world (x,z) (mirrors water.ts's world-XZ read).
  const baked = bakeTileClimate(tile, tempRange, precipMax);
  const { minX, minZ, maxX, maxZ } = baked.bounds;
  const u = T.positionWorld.x.sub(minX).div(maxX - minX);
  const v = T.positionWorld.z.sub(minZ).div(maxZ - minZ);
  const clim = T.texture(baked.texture, T.vec2(u, v));
  const tempC = clim.r.mul(tSpan).add(tMin); // °C
  const precip = clim.g.mul(precipMax);      // mm/yr

  const y = T.positionWorld.y;
  // ELEVATION is the PRIMARY band driver: normalised relief above the waterline, 0 at the
  // shore → 1 at the highest point. Climate only MODULATES (below) — it never overrides it.
  const r = T.clamp(y.sub(sea).div(aboveSpan), 0, 1);
  const steep = T.clamp(T.oneMinus(T.normalWorld.y), 0, 1); // 0 flat → 1 vertical

  // CLIMATE MODULATION (secondary): precip splits the green band into dry grass ↔ forest;
  // a COLD climate lowers the snow line a touch (≤ 0.06 of the relief) but cannot move snow
  // off the high band — so a uniformly cold world still reads green-base / rock / snow-peak.
  const wet = T.smoothstep(precipDry, precipWet, precip);
  const cold = T.oneMinus(T.smoothstep(-5.0, 6.0, tempC)); // 1 cold → 0 warm
  const rEff = T.clamp(r.add(cold.mul(0.06)), 0, 1);       // cold-shifted effective elevation

  // THREE STARK ELEVATION ZONES (smoothstep transitions read as distinct bands):
  //   low  r≲0.35    → GREEN  (grass→forest by precip)
  //   mid  r≈0.35..0.85 → ROCK   (grey-brown mountainside — the big middle band)
  //   high r≳0.85    → SNOW   (white) — the PEAK only
  const green = T.mix(dryV, forestV, wet);
  let col = green;
  const rockMask = T.smoothstep(0.32, 0.46, rEff);  // entering the mountainside
  col = T.mix(col, rockV, rockMask);
  const snowMask = T.smoothstep(0.84, 0.95, rEff);  // peak snow only (high elevation-gated)
  col = T.mix(col, snowV, snowMask);

  // Steep CLIFFS expose rock even down in the green band (subtle; never over the snow cap).
  const cliff = T.smoothstep(0.55, 0.82, steep).mul(T.oneMinus(snowMask)).mul(0.7);
  col = T.mix(col, rockV, cliff);

  // Sandy coast in the thin band just above the waterline.
  const coastMask = T.oneMinus(T.smoothstep(0.0, coastBand, y.sub(sea)));
  col = T.mix(col, sandV, coastMask);

  // Dark silt below the waterline (seen through the water surface).
  const subMask = T.smoothstep(0.0, subBand, T.float(sea).sub(y));
  col = T.mix(col, subSeaV, subMask);

  material.colorNode = col;

  // Roughness: snow a touch glossier (catches a sky sheen), submerged silt glossier (wet).
  let rough = T.mix(T.float(baseRough), T.float(0.6), snowMask);
  rough = T.mix(rough, T.float(0.5), subMask);
  material.roughnessNode = T.clamp(rough, 0, 1);
}

/** Build a THREE BufferGeometry sitting on the tile's world surface. */
export function terrainTileBufferGeometry(tile: TerrainTile): THREE.BufferGeometry {
  const { positions, indices, normals } = terrainTileGeometry(tile);
  const geom = new THREE.BufferGeometry();
  geom.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geom.setAttribute("normal", new THREE.BufferAttribute(normals, 3));
  geom.setIndex(new THREE.BufferAttribute(indices, 1));
  geom.computeBoundingSphere();
  geom.computeBoundingBox();
  return geom;
}

/**
 * Build a ready-to-add terrain Mesh for a tile. The mesh's vertices coincide with
 * the native heightfield collider surface, so the rendered ground and the collider
 * agree (drop-test parity). Returns the THREE.Mesh; the caller adds it to the scene
 * and disposes geometry/material when the tile is streamed out.
 */
export function buildTerrainMesh(tile: TerrainTile, opts: TerrainMeshOptions = {}): THREE.Mesh {
  const geom = terrainTileBufferGeometry(tile);
  const baseColor = opts.color ?? 0x4a6b3a;
  const baseRough = opts.roughness ?? 0.95;
  const material = new THREE.MeshStandardNodeMaterial({
    color: baseColor,
    roughness: baseRough,
    metalness: opts.metalness ?? 0.0,
  });
  if (opts.doubleSide === true) material.side = THREE.DoubleSide;
  // Opt-in procedural PBR (supersedes the flat ramp/shoreline) else opt-in elevation+biome
  // ramp (supersedes shoreline) else opt-in tropical shoreline. ALL are no-ops when absent →
  // the material is byte-identical to the flat-colour default (no regression to default path).
  if (opts.pbr !== undefined) applyPbrMaterial(material, tile, baseRough, opts.pbr);
  else if (opts.palette !== undefined) applyBiomeRamp(material, tile, baseRough, opts.palette);
  else if (opts.shoreline !== undefined) applyShoreline(material, baseColor, baseRough, opts.shoreline);
  // Opt-in render-only vertical exaggeration (geometry only; identity when factor === 1).
  if (opts.exaggerateY !== undefined && opts.exaggerateY.factor !== 1) {
    const { factor, pivot } = opts.exaggerateY;
    const posAttr = geom.getAttribute("position") as THREE.BufferAttribute;
    for (let i = 0; i < posAttr.count; i++) posAttr.setY(i, pivot + (posAttr.getY(i) - pivot) * factor);
    posAttr.needsUpdate = true;
    geom.computeVertexNormals();
    geom.computeBoundingSphere();
    geom.computeBoundingBox();
  }
  const mesh = new THREE.Mesh(geom, material);
  mesh.castShadow = false;
  mesh.receiveShadow = true;
  return mesh;
}

/** Dispose a terrain mesh's GPU resources after it's removed from the scene. */
export function disposeTerrainMesh(mesh: THREE.Mesh): void {
  mesh.geometry?.dispose?.();
  const mat = mesh.material as { dispose?: () => void } | undefined;
  mat?.dispose?.();
}

/** Minimal scene surface this renderer needs (matches THREE.Scene / Object3DLike). */
interface SceneAddRemove {
  add(child: unknown): void;
  remove(child: unknown): void;
}

export interface TerrainStreamRendererOptions extends StreamFollowOptions {
  /** Resolve the tile for a coord (cache / snapshot / fake generator). */
  getTile(coord: TileCoord): TerrainTile;
  /** Mesh appearance. */
  mesh?: TerrainMeshOptions;
  /** Seed for the deterministic prop scatter (Phase 9.1). Required when `props` is on. */
  seed?: number;
  /** Scatter + mount trees/rocks/grass on each tile (recomputed from the tile, render-only). Default off. */
  props?: boolean;
}

/**
 * Drives the visible terrain meshes off a `StreamFollower`: as the anchor moves, the
 * follower's load/unload diff adds/removes (and disposes) tile meshes on the scene.
 * The render side of `world.streamFollow` — the set math is StreamFollower (pure,
 * headless-proven); this just turns its diff into scene mutations. In-tab render = UAT.
 */
export class TerrainStreamRenderer {
  private readonly follower: StreamFollower;
  private readonly getTile: (coord: TileCoord) => TerrainTile;
  private readonly meshOpts: TerrainMeshOptions;
  private readonly meshes = new Map<TileKey, THREE.Mesh>();
  private readonly propsEnabled: boolean;
  private readonly seed: number;
  // Per-tile prop InstancedMeshes (one per present kind), mounted/disposed with the tile.
  private readonly propMeshes = new Map<TileKey, THREE.InstancedMesh[]>();

  constructor(private readonly scene: SceneAddRemove, opts: TerrainStreamRendererOptions) {
    this.follower = new StreamFollower(opts);
    this.getTile = opts.getTile;
    this.meshOpts = opts.mesh ?? {};
    this.propsEnabled = opts.props === true;
    this.seed = opts.seed ?? 0;
  }

  /** Tiles currently mounted in the scene. */
  mountedKeys(): Set<TileKey> {
    return new Set(this.meshes.keys());
  }

  /** Advance the anchor to a world position; mounts/unmounts terrain meshes to match. */
  update(anchorX: number, anchorZ: number): { loaded: number; unloaded: number } {
    const diff = this.follower.update(anchorX, anchorZ);
    for (const t of diff.unload) {
      const k = tileKey(t.tx, t.tz);
      const mesh = this.meshes.get(k);
      if (mesh !== undefined) {
        this.scene.remove(mesh);
        disposeTerrainMesh(mesh);
        this.meshes.delete(k);
      }
      const props = this.propMeshes.get(k);
      if (props !== undefined) {
        for (const pm of props) { this.scene.remove(pm); disposePropMesh(pm); }
        this.propMeshes.delete(k);
      }
    }
    for (const t of diff.load) {
      const k = tileKey(t.tx, t.tz);
      if (this.meshes.has(k)) continue;
      const tile = this.getTile(t);
      const mesh = buildTerrainMesh(tile, this.meshOpts);
      this.meshes.set(k, mesh);
      this.scene.add(mesh);
      // Props are recomputed from the tile (render-only) and mounted alongside the mesh.
      if (this.propsEnabled) {
        const propMeshes = buildTilePropMeshes(scatterProps(tile, this.seed));
        if (propMeshes.length > 0) {
          this.propMeshes.set(k, propMeshes);
          for (const pm of propMeshes) this.scene.add(pm);
        }
      }
    }
    return { loaded: diff.load.length, unloaded: diff.unload.length };
  }

  /** Remove + dispose every mounted tile (teardown). */
  clear(): void {
    for (const mesh of this.meshes.values()) {
      this.scene.remove(mesh);
      disposeTerrainMesh(mesh);
    }
    this.meshes.clear();
    for (const props of this.propMeshes.values()) {
      for (const pm of props) { this.scene.remove(pm); disposePropMesh(pm); }
    }
    this.propMeshes.clear();
  }
}
