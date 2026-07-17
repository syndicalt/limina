import * as THREE from "../../build/three.bundle.mjs";
import { SURFACE_COMPOSITE_TILE_SCHEMA } from "../world/surface-composite-tile.mjs";

// deno-lint-ignore no-explicit-any
const T = (THREE as any).TSL;

export interface BiomeSurfaceMaterialMount {
  readonly material: THREE.MeshStandardNodeMaterial;
  readonly textures: readonly [THREE.DataTexture, THREE.DataTexture, THREE.DataTexture];
  dispose(): void;
}

function texture(data: Uint8Array, size: number, srgb: boolean, name: string): THREE.DataTexture {
  const result = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.UnsignedByteType);
  result.name = name;
  result.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  result.wrapS = THREE.ClampToEdgeWrapping; result.wrapT = THREE.ClampToEdgeWrapping;
  result.minFilter = THREE.LinearMipmapLinearFilter; result.magFilter = THREE.LinearFilter;
  result.generateMipmaps = true; result.needsUpdate = true;
  return result;
}

/** Build the one-graph/one-draw runtime projection of a verified CPU-composited terrain tile. */
export function buildBiomeSurfaceMaterial(artifact: any, options: { localBounds?: readonly [number, number, number, number]; normalStrength?: number } = {}): BiomeSurfaceMaterialMount {
  if (artifact?.schema !== SURFACE_COMPOSITE_TILE_SCHEMA || artifact?.diagnostics?.runtimeTextureSamples !== 3) {
    throw new TypeError("biome surface material requires a three-map surface-composite tile");
  }
  const total = artifact.resolution?.total;
  if (!Number.isSafeInteger(total) || total < 2) throw new RangeError("biome surface composite texture size is invalid");
  const expected = total * total * 4;
  for (const key of ["albedo", "normal", "orm"]) if (!(artifact.maps?.[key]?.data instanceof Uint8Array) || artifact.maps[key].data.length !== expected) {
    throw new TypeError(`biome surface composite ${key} is not exact RGBA8`);
  }
  if (artifact.maps.orm.channels !== "ao-roughness-metalness-grass-density") {
    throw new TypeError("biome surface composite ORM does not declare authenticated grass density");
  }
  const bounds = options.localBounds ?? [-artifact.placement.sizeM / 2, -artifact.placement.sizeM / 2, artifact.placement.sizeM / 2, artifact.placement.sizeM / 2];
  if (!Array.isArray(bounds) || bounds.length !== 4 || !bounds.every(Number.isFinite) || !(bounds[2] > bounds[0]) || !(bounds[3] > bounds[1])) {
    throw new RangeError("biome surface localBounds must be finite [minX,minZ,maxX,maxZ]");
  }
  const normalStrength = options.normalStrength ?? 1;
  if (!Number.isFinite(normalStrength) || normalStrength < 0 || normalStrength > 4) throw new RangeError("biome surface normalStrength must be in [0,4]");
  const albedo = texture(artifact.maps.albedo.data, total, true, "limina:biome-surface-albedo");
  const normal = texture(artifact.maps.normal.data, total, false, "limina:biome-surface-normal");
  const orm = texture(artifact.maps.orm.data, total, false, "limina:biome-surface-orm");
  const material = new THREE.MeshStandardNodeMaterial({ color: 0xffffff, roughness: 1, metalness: 1 });
  const u = T.positionLocal.x.sub(bounds[0]).div(bounds[2] - bounds[0]);
  const v = T.positionLocal.z.sub(bounds[1]).div(bounds[3] - bounds[1]);
  const interior = artifact.resolution.interior, gutter = artifact.resolution.gutter;
  const uv = T.vec2(T.float(gutter).add(T.clamp(u, 0, 1).mul(interior - 1)).add(0.5).div(total),
    T.float(gutter).add(T.clamp(v, 0, 1).mul(interior - 1)).add(0.5).div(total));
  const albedoSample = T.texture(albedo, uv), normalSample = T.texture(normal, uv), ormSample = T.texture(orm, uv);
  const shorelineWet = T.clamp(albedoSample.a, 0, 1);
  const wetColor = T.mix(albedoSample.rgb, albedoSample.rgb.mul(T.vec3(0.42, 0.5, 0.52)), shorelineWet.mul(0.78));
  // Policy v7 already bakes occupancy-matched authenticated turf into all three PBR maps. Keeping
  // that detail intact lets explicit blades fade onto real grass instead of a smooth green proxy.
  material.colorNode = wetColor;
  material.normalNode = T.normalMap(normalSample.rgb, T.vec2(normalStrength));
  material.aoNode = T.clamp(ormSample.r, 0, 1);
  const wetRoughness = T.mix(T.clamp(ormSample.g, 0, 1), T.float(0.3), shorelineWet.mul(0.72));
  material.roughnessNode = wetRoughness;
  material.metalnessNode = T.clamp(ormSample.b, 0, 1);
  (material.userData as Record<string, unknown>).liminaBiomeSurface = Object.freeze({
    schema: SURFACE_COMPOSITE_TILE_SCHEMA, textureSamples: 3, oneGraph: true, featureLocalUv: true,
    source: artifact.source, coord: artifact.coord, shorelineMaskChannel: "albedo.a",
    grassDensityChannel: "orm.a", grassSurfacePresentation: "cpu-composited-density-turf/v1",
  });
  let disposed = false;
  return Object.freeze({ material, textures: Object.freeze([albedo, normal, orm]) as readonly [THREE.DataTexture, THREE.DataTexture, THREE.DataTexture],
    dispose(): void {
      if (disposed) return; disposed = true;
      const errors: unknown[] = [];
      for (const owned of [material, albedo, normal, orm]) try { owned.dispose(); } catch (error) { errors.push(error); }
      if (errors.length > 0) throw new AggregateError(errors, `biome surface material disposal failed in ${errors.length} operation(s)`);
    } });
}
