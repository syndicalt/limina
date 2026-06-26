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
import { StreamFollower, tileKey, type StreamFollowOptions, type TileCoord, type TileKey } from "./stream.ts";

export interface TerrainMeshOptions {
  /** Base albedo (hex). Default a muted terrain green/brown. */
  color?: number;
  roughness?: number;
  metalness?: number;
  /** Draw both faces (debug / steep overhangs). Default false — winding faces +y. */
  doubleSide?: boolean;
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
  const material = new THREE.MeshStandardNodeMaterial({
    color: opts.color ?? 0x4a6b3a,
    roughness: opts.roughness ?? 0.95,
    metalness: opts.metalness ?? 0.0,
  });
  if (opts.doubleSide === true) material.side = THREE.DoubleSide;
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

  constructor(private readonly scene: SceneAddRemove, opts: TerrainStreamRendererOptions) {
    this.follower = new StreamFollower(opts);
    this.getTile = opts.getTile;
    this.meshOpts = opts.mesh ?? {};
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
    }
    for (const t of diff.load) {
      const k = tileKey(t.tx, t.tz);
      if (this.meshes.has(k)) continue;
      const mesh = buildTerrainMesh(this.getTile(t), this.meshOpts);
      this.meshes.set(k, mesh);
      this.scene.add(mesh);
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
  }
}
