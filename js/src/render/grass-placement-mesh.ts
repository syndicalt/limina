import * as THREE from "../../build/three.bundle.mjs";
import type { AssetInstance, ScatterExclusion } from "../terrain/asset-scatter.ts";
import type { TerrainTile } from "../terrain/types.ts";
import type { GrassFieldQualityTier } from "./grass-field-config.ts";
import type { GrassFieldLod, GrassFieldVisualPackage } from "./grass-field-package.ts";

// deno-lint-ignore no-explicit-any
const T = (THREE as any).TSL;
const Y_AXIS = new THREE.Vector3(0, 1, 0);

export interface GrassVisualMountSelection {
  readonly visualPackage: GrassFieldVisualPackage;
  readonly quality: GrassFieldQualityTier;
  readonly lod: GrassFieldLod;
  readonly variant?: string;
}

export interface GrassPlacementMeshOptions {
  /** Hard cap on actual modeled blades after applying the package's blades-per-instance ratio. */
  readonly maxBlades: number;
  /** Feature-local origin used to preserve transform precision in large worlds. */
  readonly featureOrigin?: readonly [number, number, number];
}

/** Build one package-selected instanced mesh from engine-owned, deterministic placements. */
export function buildGrassInstancedMesh(
  placements: AssetInstance[],
  opts: GrassPlacementMeshOptions,
  selection: GrassVisualMountSelection,
): THREE.InstancedMesh | null {
  if (placements.length === 0) return null;
  const profile = selection.visualPackage.profile(selection.quality);
  const bladesPerInstance = profile.bladesPerInstance[selection.lod];
  const bladeBudget = Math.min(Math.max(1, Math.floor(opts.maxBlades)), profile.maxResidentBlades);
  const cap = Math.max(1, Math.floor(bladeBudget / bladesPerInstance));
  let kept: AssetInstance[] = placements;
  if (placements.length > cap) {
    const cx = opts.featureOrigin?.[0] ?? placements.reduce((sum, placement) => sum + placement.x, 0) / placements.length;
    const cz = opts.featureOrigin?.[2] ?? placements.reduce((sum, placement) => sum + placement.z, 0) / placements.length;
    // Bound contiguous covered area. Uniform hash-thinning preserves extent by destroying local
    // density, which is exactly how the rejected wispy lawn returned under a blade budget.
    kept = [...placements].sort((left, right) => {
      const ld = (left.x - cx) ** 2 + (left.z - cz) ** 2;
      const rd = (right.x - cx) ** 2 + (right.z - cz) ** 2;
      return ld - rd || left.z - right.z || left.x - right.x;
    }).slice(0, cap);
  }

  const context = {
    quality: selection.quality,
    lod: selection.lod,
    maxBlades: bladeBudget,
    ...(opts.featureOrigin === undefined ? {} : { featureOrigin: opts.featureOrigin }),
    ...(selection.variant === undefined ? {} : { variant: selection.variant }),
  } as const;
  const geometry = selection.visualPackage.createGeometry(context);
  const material = selection.visualPackage.createMaterial(context);
  const mesh = new THREE.InstancedMesh(geometry, material, kept.length);
  const wind = new Float32Array(kept.length * 4);
  const matrix = new THREE.Matrix4();
  const rotation = new THREE.Quaternion();
  const position = new THREE.Vector3();
  const scale = new THREE.Vector3();
  const originX = opts.featureOrigin?.[0] ?? 0;
  const originY = opts.featureOrigin?.[1] ?? 0;
  const originZ = opts.featureOrigin?.[2] ?? 0;
  for (let index = 0; index < kept.length; index++) {
    const placement = kept[index];
    position.set(placement.x - originX, placement.y - originY, placement.z - originZ);
    rotation.setFromAxisAngle(Y_AXIS, placement.yaw);
    scale.setScalar(placement.scale);
    matrix.compose(position, rotation, scale);
    mesh.setMatrixAt(index, matrix);
    wind[index * 4] = placement.x - originX;
    wind[index * 4 + 1] = placement.z - originZ;
    wind[index * 4 + 2] = 0;
    wind[index * 4 + 3] = placement.yaw;
  }
  geometry.setAttribute("aWind", new THREE.InstancedBufferAttribute(wind, 4));
  mesh.instanceMatrix.needsUpdate = true;
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  mesh.frustumCulled = false;
  mesh.name = "limina:grass";
  mesh.position.set(originX, originY, originZ);
  return mesh;
}

export interface GrassGroundTintOptions {
  baseColor: number;
  elevationMin: number;
  elevationMax: number;
  slopeMax: number;
  exclusions: ScatterExclusion[];
  /** Inclusion discs confine the tint to authored yards when present. */
  inclusions?: ScatterExclusion[];
  opacity: number;
}

/** Build a terrain-conforming tint mask beneath a package-owned grass presentation. */
export function buildGrassGroundTint(tile: TerrainTile, opts: GrassGroundTintOptions): THREE.Mesh | null {
  const { nrows, ncols, heights } = tile;
  const [ox, oy, oz] = tile.origin;
  const [sx, sy, sz] = tile.scale;
  const base = new THREE.Color(opts.baseColor);
  const runX = ((sx / Math.max(1, ncols - 1)) * 2) || 1;
  const runZ = ((sz / Math.max(1, nrows - 1)) * 2) || 1;
  const height = (row: number, column: number): number => heights[row * ncols + column];
  const positions = new Float32Array(nrows * ncols * 3);
  const tint = new Float32Array(nrows * ncols * 4);
  let anyMask = false;

  for (let row = 0; row < nrows; row++) for (let column = 0; column < ncols; column++) {
    const vertex = row * ncols + column;
    const x = ox - sx / 2 + (column / Math.max(1, ncols - 1)) * sx;
    const z = oz - sz / 2 + (row / Math.max(1, nrows - 1)) * sz;
    const y = oy + height(row, column) * sy;
    positions[vertex * 3] = x;
    positions[vertex * 3 + 1] = y + 0.03;
    positions[vertex * 3 + 2] = z;
    const dc = (height(row, Math.min(ncols - 1, column + 1)) - height(row, Math.max(0, column - 1))) * sy;
    const dr = (height(Math.min(nrows - 1, row + 1), column) - height(Math.max(0, row - 1), column)) * sy;
    const slope = Math.hypot(dc / runX, dr / runZ);
    let masked = y >= opts.elevationMin && y <= opts.elevationMax && slope <= opts.slopeMax;
    if (masked) for (const exclusion of opts.exclusions) {
      const dx = x - exclusion.x, dz = z - exclusion.z;
      if (dx * dx + dz * dz <= exclusion.r * exclusion.r) { masked = false; break; }
    }
    if (masked && opts.inclusions !== undefined && opts.inclusions.length > 0) {
      masked = opts.inclusions.some((inclusion) => {
        const dx = x - inclusion.x, dz = z - inclusion.z;
        return dx * dx + dz * dz <= inclusion.r * inclusion.r;
      });
    }
    let hash = (Math.imul(column + 1, 374761393) ^ Math.imul(row + 1, 668265263)) >>> 0;
    hash = Math.imul(hash ^ (hash >>> 13), 1274126177) >>> 0;
    const jitter = 0.9 + (hash / 4294967296) * 0.2;
    tint[vertex * 4] = base.r * jitter;
    tint[vertex * 4 + 1] = base.g * jitter;
    tint[vertex * 4 + 2] = base.b * jitter;
    tint[vertex * 4 + 3] = masked ? opts.opacity : 0;
    anyMask ||= masked;
  }
  if (!anyMask) return null;

  const indices: number[] = [];
  for (let row = 0; row < nrows - 1; row++) for (let column = 0; column < ncols - 1; column++) {
    const a = row * ncols + column, b = a + 1, c = (row + 1) * ncols + column, d = c + 1;
    indices.push(a, c, b, b, c, d);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute("aTint", new THREE.Float32BufferAttribute(tint, 4));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  const material = new THREE.MeshStandardNodeMaterial({ roughness: 0.95, metalness: 0, transparent: true, side: THREE.DoubleSide });
  const tintNode = T.attribute("aTint", "vec4");
  material.colorNode = T.vec3(tintNode.x, tintNode.y, tintNode.z);
  material.opacityNode = tintNode.w;
  material.depthWrite = false;
  const mesh = new THREE.Mesh(geometry, material);
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  mesh.renderOrder = -1;
  mesh.name = "limina:grass-tint";
  return mesh;
}
