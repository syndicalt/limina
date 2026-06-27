// Phase 9 / workstream D — THREE BufferGeometry + Mesh for a terrain tile.
//
// The browser/UAT side of the mesh: wraps the PURE `terrainTileGeometry` (mesh.ts)
// in a real THREE BufferGeometry so a generated tile becomes a visible mesh in the
// render path (browser-entry). This module imports THREE and is NOT headless — the
// geometry MATH is proven in js/test/p9_terrain_mesh.ts; the in-tab WebGPU render of
// the result is UAT.

import * as THREE from "../../build/three.bundle.mjs";
import type { TerrainTile } from "./types.ts";
import { terrainTileGeometry } from "./mesh.ts";
import { scatterProps } from "./scatter.ts";
import { buildTilePropMeshes, disposePropMesh } from "./props-render.ts";
import { StreamFollower, tileKey, type StreamFollowOptions, type TileCoord, type TileKey } from "./stream.ts";

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
  // Opt-in tropical shoreline (wet band + animated foam line). No-op when absent.
  if (opts.shoreline !== undefined) applyShoreline(material, baseColor, baseRough, opts.shoreline);
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
