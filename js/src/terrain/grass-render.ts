// grass-render.ts — chunked instanced RENDERING of the paint-driven grass field.
//
// Consumes the pure placements from render/grass-source.ts (blade density ∝ the tile's painted
// grass weight) and mounts them as per-chunk THREE.InstancedMesh blades:
//   • geometry + TSL node material come from the PROVEN vegetation.grass core (skills/grass.ts:
//     buildGrassBladeGeometry / buildGrassMaterial — bezier blades, three-layer coherent wind in
//     positionNode, SSS backlight; WebGPURenderer(forceWebGL)-safe, no raw GLSL), extended with
//     the opt-in camera-distance fade for the streamed path;
//   • one InstancedMesh PER CHUNK cell (default 24 m) with a REAL bounding sphere
//     (computeBoundingSphere over the instance matrices + a sway/tip pad) and frustumCulled
//     left true — the Phase-3.4 scatter-culling discipline (p_scatter_culling), NOT the old
//     single-carpet frustumCulled=false;
//   • ZERO entity slots: meshes are scene-direct render state (like streamed terrain tiles) —
//     MAX_ENTITIES is untouched, nothing is recorded.
//
// Two consumers:
//   • the EDITABLE layer (terrain.create / terrain.paint / terrain.deform): TileGrass mounts at
//     create when the tile carries paint, and the live brush refreshes ONLY the chunks under its
//     stroke (grassChunkCoordsInCircle) — cheap enough to run per recorded stamp;
//   • STREAMED map tiles (browser-entry's ClientTerrainStream): StreamedGrassManager grows
//     grass on resident tiles within a small radius of the camera (budgeted ≤1 tile-build per
//     frame, hysteresis +1 — the stream-client mount pattern) and disposes it with the tile.

import * as THREE from "../../build/three.bundle.mjs";
import { buildGrassBladeGeometry, buildGrassMaterial, type GrassMeshOptions } from "../skills/grass.ts";
import {
  grassChunkCoordsForTile,
  grassChunkCoordsInCircle,
  grassChunkKey,
  grassChunkPlacements,
  type GrassPlacement,
  type GrassSourceOptions,
} from "../render/grass-source.ts";
import type { TerrainTile } from "./types.ts";

const Y_AXIS = new THREE.Vector3(0, 1, 0);

/** Visual knobs for the paint-driven grass (placement knobs live in GrassSourceOptions).
 *  Defaults mirror the vegetation.grass short-turf look. */
export interface GrassStyle {
  climate?: GrassMeshOptions["climate"];
  bladeHeight?: number;
  bladeWidth?: number;
  segments?: number;
  curvature?: number;
  windStrength?: number;
  windSpeed?: number;
  windGust?: number;
  windGustFreq?: number;
  sssStrength?: number;
  aoStrength?: number;
  /** Camera-distance blade fade (streamed LOD) — see GrassMeshOptions.fade. */
  fade?: { start: number; end: number };
}

function meshOptions(style: GrassStyle): GrassMeshOptions {
  return {
    climate: style.climate ?? "summer",
    bladeHeight: style.bladeHeight ?? 0.32,
    bladeWidth: style.bladeWidth ?? 0.03,
    segments: style.segments ?? 3,
    curvature: style.curvature ?? 0.12,
    windStrength: style.windStrength ?? 0.045,
    windSpeed: style.windSpeed ?? 1.1,
    windGust: style.windGust ?? 0.06,
    windGustFreq: style.windGustFreq ?? 0.18,
    sssStrength: style.sssStrength ?? 0.5,
    aoStrength: style.aoStrength ?? 0.45,
    maxBlades: Number.MAX_SAFE_INTEGER, // per-chunk caps live in GrassSourceOptions
    ...(style.fade !== undefined ? { fade: style.fade } : {}),
  };
}

/** Minimal scene surface (matches THREE.Scene and the headless gate stubs). */
export interface SceneAddRemove {
  add(child: unknown): void;
  remove(child: unknown): void;
}

/** Build ONE chunk's InstancedMesh from placements. The blade geometry is CLONED per chunk so
 *  each chunk carries its own `aWind` instanced attribute (the world-coherent wind field needs
 *  per-blade world roots; instanced attributes live on the geometry, which therefore can't be
 *  shared). The MATERIAL is shared across every chunk of a mount (one shader). */
function buildChunkMesh(
  blade: THREE.BufferGeometry,
  material: THREE.MeshStandardNodeMaterial,
  placements: GrassPlacement[],
  opts: GrassMeshOptions,
): THREE.InstancedMesh {
  const n = placements.length;
  const geom = blade.clone();
  const wind = new Float32Array(n * 4);
  const mesh = new THREE.InstancedMesh(geom, material, n);
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const pos = new THREE.Vector3();
  const scl = new THREE.Vector3();
  for (let i = 0; i < n; i++) {
    const p = placements[i];
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
  mesh.name = "limina:grass-chunk";
  // REAL bounding sphere (p_scatter_culling discipline): union of the instance-transformed
  // geometry sphere, PADDED for what the shader adds beyond the static geometry — per-blade
  // height/lean jitter (≤ ~1.3×) and the wind sway at the tip — so a gust never pokes out of
  // a culled chunk. frustumCulled stays THREE's default true: a chunk behind the camera is
  // skipped whole.
  mesh.computeBoundingSphere();
  const bs = mesh.boundingSphere as { radius: number } | null;
  if (bs !== null) bs.radius += opts.bladeHeight * 0.6 + opts.windStrength + opts.windGust + 0.15;
  return mesh;
}

/** Live grass over ONE tile (the editable layer / one streamed tile). Chunks mount into the
 *  scene immediately; refresh* recomputes placements from the tile's CURRENT paint/heights
 *  (pure), so a brush stroke or a settlement-footprint change re-renders only what moved. */
/** Blade geometry + TSL material shared across many TileGrass mounts (the streamed manager
 *  builds ONE shader for its whole window instead of one per tile). Owner disposes it. */
export interface SharedGrassResources {
  blade: THREE.BufferGeometry;
  material: THREE.MeshStandardNodeMaterial;
  opts: GrassMeshOptions;
}

/** A 3-blade TUFT: three copies of the single bezier blade fanned about +Y with a tiny radial
 *  offset, merged into ONE geometry. Triples the apparent turf coverage per INSTANCE (the perf
 *  unit) — the classic grass-card trick, but with real blade geometry so the TSL wind/colour
 *  graph (which works in blade-local space, per instance) still applies; the three copies share
 *  one per-instance variation draw, which reads as a natural clump. */
function buildGrassTuftGeometry(opts: GrassMeshOptions): THREE.BufferGeometry {
  const blade = buildGrassBladeGeometry(opts.bladeHeight, opts.bladeWidth, opts.segments, opts.curvature);
  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  const src = {
    pos: blade.getAttribute("position") as THREE.BufferAttribute,
    nrm: blade.getAttribute("normal") as THREE.BufferAttribute,
    uv: blade.getAttribute("uv") as THREE.BufferAttribute,
    idx: blade.getIndex() as THREE.BufferAttribute,
  };
  const COPIES = 3;
  const Y_SCALE = [1.0, 0.8, 0.62]; // staggered blade heights — a clump, not a symmetric pod
  for (let cIdx = 0; cIdx < COPIES; cIdx++) {
    const ang = (cIdx / COPIES) * Math.PI * 2 + cIdx * 0.7; // uneven fan
    const ca = Math.cos(ang), sa = Math.sin(ang);
    const ox = ca * 0.05, oz = sa * 0.05; // radial splay so the roots spread, not z-fight
    const ys = Y_SCALE[cIdx];
    const base = positions.length / 3;
    for (let i = 0; i < src.pos.count; i++) {
      const x = src.pos.getX(i), y = src.pos.getY(i), z = src.pos.getZ(i);
      positions.push(ca * x - sa * z + ox, y * ys, sa * x + ca * z + oz);
      normals.push(src.nrm.getX(i), src.nrm.getY(i), src.nrm.getZ(i));
      uvs.push(src.uv.getX(i), src.uv.getY(i));
    }
    for (let i = 0; i < src.idx.count; i++) indices.push(base + src.idx.getX(i));
  }
  blade.dispose();
  const geom = new THREE.BufferGeometry();
  geom.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geom.setAttribute("normal", new THREE.Float32BufferAttribute(normals, 3));
  geom.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  geom.setIndex(indices);
  geom.computeBoundingBox();
  geom.computeBoundingSphere();
  return geom;
}

export function createSharedGrassResources(style: GrassStyle = {}): SharedGrassResources {
  const opts = meshOptions(style);
  return {
    blade: buildGrassTuftGeometry(opts),
    material: buildGrassMaterial(opts),
    opts,
  };
}

export function disposeSharedGrassResources(shared: SharedGrassResources): void {
  shared.blade.dispose();
  shared.material.dispose();
}

export class TileGrass {
  private readonly chunks = new Map<string, THREE.InstancedMesh>();
  private readonly blade: THREE.BufferGeometry;
  private readonly material: THREE.MeshStandardNodeMaterial;
  private readonly opts: GrassMeshOptions;
  private readonly ownsResources: boolean;
  private disposed = false;

  constructor(
    private readonly scene: SceneAddRemove,
    private readonly tile: TerrainTile,
    /** Placement options PROVIDER — read fresh on every (re)compute so live exclusion state
     *  (the settlement-footprint registry) is honoured without a wiring dance. */
    private readonly source: () => GrassSourceOptions,
    style: GrassStyle = {},
    shared?: SharedGrassResources,
  ) {
    if (shared !== undefined) {
      this.opts = shared.opts;
      this.blade = shared.blade;
      this.material = shared.material;
      this.ownsResources = false;
    } else {
      this.opts = meshOptions(style);
      this.blade = buildGrassTuftGeometry(this.opts);
      this.material = buildGrassMaterial(this.opts);
      this.ownsResources = true;
    }
    this.refreshAll();
  }

  bladeCount(): number {
    let n = 0;
    for (const c of this.chunks.values()) n += c.count;
    return n;
  }

  chunkCount(): number {
    return this.chunks.size;
  }

  /** The mounted chunk meshes (gates/introspection). */
  chunkMeshes(): THREE.InstancedMesh[] {
    return [...this.chunks.values()];
  }

  private setChunk(key: string, placements: GrassPlacement[]): void {
    const prev = this.chunks.get(key);
    if (prev !== undefined) {
      this.scene.remove(prev);
      prev.geometry.dispose();
      (prev as unknown as { dispose?: () => void }).dispose?.();
      this.chunks.delete(key);
    }
    if (placements.length === 0) return;
    const mesh = buildChunkMesh(this.blade, this.material, placements, this.opts);
    this.chunks.set(key, mesh);
    this.scene.add(mesh);
  }

  /** Recompute + swap the chunks intersecting a world-XZ disc — the live brush path
   *  (terrain.paint / terrain.deform refresh only what the stamp touched). */
  refreshCircle(x: number, z: number, r: number): void {
    if (this.disposed) return;
    const opts = this.source();
    for (const { cx, cz } of grassChunkCoordsInCircle(this.tile, x, z, r, opts.chunkSize)) {
      this.setChunk(grassChunkKey(cx, cz), grassChunkPlacements(this.tile, cx, cz, opts));
    }
  }

  /** Recompute + swap EVERY chunk (mount time; the vegetation-clear closure after
   *  village.build registers its footprints). */
  refreshAll(): void {
    if (this.disposed) return;
    const opts = this.source();
    const live = new Set<string>();
    if (this.tile.paintMat !== undefined && this.tile.paintW !== undefined) {
      for (const { cx, cz } of grassChunkCoordsForTile(this.tile, opts.chunkSize)) {
        const key = grassChunkKey(cx, cz);
        this.setChunk(key, grassChunkPlacements(this.tile, cx, cz, opts));
        if (this.chunks.has(key)) live.add(key);
      }
    }
    for (const key of [...this.chunks.keys()]) {
      if (!live.has(key)) this.setChunk(key, []);
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const mesh of this.chunks.values()) {
      this.scene.remove(mesh);
      mesh.geometry.dispose();
      (mesh as unknown as { dispose?: () => void }).dispose?.();
    }
    this.chunks.clear();
    if (this.ownsResources) {
      this.blade.dispose();
      this.material.dispose();
    }
  }
}

export interface StreamedGrassOptions {
  /** Streamed tile edge (metres) — TILE_SIZE. */
  tileSize: number;
  /** Grass GROW radius in tiles (Chebyshev around the camera tile). Blades mount only this
   *  close; the painted vertex tint carries the grass colour beyond. Default 2 (≈ 96–120 m,
   *  matching the default fade). */
  radius?: number;
  /** Tile-grass builds per update() (the per-frame budget — same idea as the ≤2 tile mounts
   *  of ClientTerrainStream; a grass build is heavier than a tile mesh, so default 1). */
  budget?: number;
  /** Placement options for a tile (seed/waterline/spacing). Chunked per tile regardless. */
  source: (tile: TerrainTile) => GrassSourceOptions;
  /** Visual style. Default adds the 60→110 m camera fade (the streamed LOD). */
  style?: GrassStyle;
}

/** Camera-following grass over the CLIENT-streamed tile window. Pure view state (like
 *  ClientTerrainStream itself): tiles are REGISTERED as they mount and FORGOTTEN as they
 *  unmount; each update() grows grass on registered tiles within `radius` of the camera
 *  tile (nearest-first, ≤ budget builds) and drops grass past `radius + 1` (hysteresis).
 *  Deterministic placements per (tile, seed) — mount ORDER never changes the blades. */
export class StreamedGrassManager {
  private readonly tiles = new Map<string, { coord: { tx: number; tz: number }; tile: TerrainTile }>();
  private readonly grass = new Map<string, TileGrass>();
  /** Density ring each grown tile was built at: 0 = FINE (Chebyshev ≤ 1 — the turf underfoot),
   *  1 = COARSE (further out — 2× spacing = ¼ density; those blades live mostly inside the fade
   *  band anyway). A tile whose ring changes as the camera crosses a tile border is REBUILT under
   *  the same per-update budget, so density follows the camera without an unbounded burst. */
  private readonly ring = new Map<string, 0 | 1>();
  private readonly radius: number;
  private readonly budget: number;
  private readonly style: GrassStyle;
  private readonly source: (tile: TerrainTile) => GrassSourceOptions;
  private readonly tileSize: number;
  /** ONE blade geometry + node material shared by every tile-grass (one shader for the whole
   *  window); built lazily on the first grow so a grassless world never compiles it. */
  private shared: SharedGrassResources | undefined;
  private cleared = false;

  constructor(private readonly scene: SceneAddRemove, opts: StreamedGrassOptions) {
    this.tileSize = opts.tileSize;
    this.radius = Math.max(1, Math.floor(opts.radius ?? 2));
    this.budget = Math.max(1, Math.floor(opts.budget ?? 1));
    this.source = opts.source;
    this.style = opts.style ?? { fade: { start: 50, end: 95 } };
  }

  /** Register a resident streamed tile (call from the stream mount callback). */
  noteTile(key: string, coord: { tx: number; tz: number }, tile: TerrainTile): void {
    if (this.cleared) return;
    this.tiles.set(key, { coord, tile });
  }

  /** Forget a tile (stream unmount callback) — its grass unmounts immediately. */
  dropTile(key: string): void {
    this.tiles.delete(key);
    this.ring.delete(key);
    const g = this.grass.get(key);
    if (g !== undefined) {
      g.dispose();
      this.grass.delete(key);
    }
  }

  grassKeys(): Set<string> {
    return new Set(this.grass.keys());
  }

  bladeCount(): number {
    let n = 0;
    for (const g of this.grass.values()) n += g.bladeCount();
    return n;
  }

  /** Advance to the camera's world position: drop grass beyond radius+1, grow ≤ budget
   *  tile-grasses within radius, nearest tile first (stream-client's deterministic order). */
  update(anchorX: number, anchorZ: number): { grown: number; dropped: number; active: number } {
    if (this.cleared) return { grown: 0, dropped: 0, active: this.grass.size };
    const ax = Math.floor(anchorX / this.tileSize);
    const az = Math.floor(anchorZ / this.tileSize);
    const dist = (c: { tx: number; tz: number }): number => Math.max(Math.abs(c.tx - ax), Math.abs(c.tz - az));
    let dropped = 0;
    for (const [key, g] of [...this.grass]) {
      const t = this.tiles.get(key);
      if (t === undefined || dist(t.coord) > this.radius + 1) {
        g.dispose();
        this.grass.delete(key);
        this.ring.delete(key);
        dropped++;
      }
    }
    // Candidates: registered tiles within radius that lack grass OR whose density ring changed —
    // nearest first, (tz, tx) ascending as the deterministic tie-break (the stream-client order).
    const ringFor = (d: number): 0 | 1 => (d <= 1 ? 0 : 1);
    let grown = 0;
    while (grown < this.budget) {
      let bestKey: string | undefined;
      let bestCoord: { tx: number; tz: number } | undefined;
      let bestDist = Infinity;
      for (const [key, t] of this.tiles) {
        const d = dist(t.coord);
        if (d > this.radius) continue;
        if (this.grass.has(key) && this.ring.get(key) === ringFor(d)) continue;
        if (
          d < bestDist ||
          (d === bestDist && bestCoord !== undefined && (t.coord.tz < bestCoord.tz || (t.coord.tz === bestCoord.tz && t.coord.tx < bestCoord.tx)))
        ) {
          bestDist = d;
          bestKey = key;
          bestCoord = t.coord;
        }
      }
      if (bestKey === undefined) break;
      const entry = this.tiles.get(bestKey)!;
      const level = ringFor(dist(entry.coord));
      this.grass.get(bestKey)?.dispose();
      if (this.shared === undefined) this.shared = createSharedGrassResources(this.style);
      // COARSE ring: 2× spacing (¼ density) — those tiles sit mostly inside the camera fade band.
      const src = (): GrassSourceOptions => {
        const base = this.source(entry.tile);
        return level === 1 ? { ...base, spacing: (base.spacing ?? 0.45) * 2 } : base;
      };
      // A grassless tile keeps its (empty, near-free) handle so it isn't re-scanned every
      // frame; it drops with the tile like any other.
      this.grass.set(bestKey, new TileGrass(this.scene, entry.tile, src, this.style, this.shared));
      this.ring.set(bestKey, level);
      grown++;
    }
    return { grown, dropped, active: this.grass.size };
  }

  /** Terminal teardown (viewport stop). */
  clear(): void {
    if (this.cleared) return;
    this.cleared = true;
    for (const g of this.grass.values()) g.dispose();
    this.grass.clear();
    this.ring.clear();
    this.tiles.clear();
    if (this.shared !== undefined) {
      disposeSharedGrassResources(this.shared);
      this.shared = undefined;
    }
  }
}
