import * as THREE from "../../../build/three.bundle.mjs";
import type { GrassFieldQualityTier } from "../../render/grass-field-config.ts";
import {
  GRASS_FIELD_VISUAL_PACKAGE_SCHEMA,
  type GrassFieldVisualBuildContext,
  type GrassFieldVisualPackage,
  type GrassFieldVisualProfile,
} from "../../render/grass-field-package.ts";

// deno-lint-ignore no-explicit-any
const T = (THREE as any).TSL;

interface ReedLod {
  readonly bladeHeight: number;
  readonly bladeWidth: number;
  readonly segments: number;
  readonly curvature: number;
  readonly windStrength: number;
  readonly windSpeed: number;
  readonly windGust: number;
  readonly windGustFreq: number;
  readonly fade: Readonly<{ start: number; end: number }>;
}

const renderProfiles: Readonly<Record<GrassFieldQualityTier, Readonly<{
  maxResidentBlades: number; bladesPerInstance: readonly [number, number]; radius: number; fineRadius: number;
  spacingMultipliers: readonly [number, number]; lod: readonly [Readonly<ReedLod>, Readonly<ReedLod>];
}>>> = Object.freeze({
  performance: Object.freeze({ maxResidentBlades: 35_000, bladesPerInstance: [5, 3] as const, radius: 2, fineRadius: 0,
    spacingMultipliers: [1, 3.5] as const, lod: [
      { climate: "summer", bladeHeight: 1.25, bladeWidth: 0.055, segments: 3, curvature: 0.16,
        windStrength: 0.08, windSpeed: 0.7, windGust: 0.12, windGustFreq: 0.1, fade: { start: 52, end: 96 } },
      { climate: "summer", bladeHeight: 1.0, bladeWidth: 0.06, segments: 2, curvature: 0.1,
        windStrength: 0.05, windSpeed: 0.65, windGust: 0.08, windGustFreq: 0.09, fade: { start: 78, end: 132 } },
    ] as const }),
  balanced: Object.freeze({ maxResidentBlades: 70_000, bladesPerInstance: [7, 4] as const, radius: 2, fineRadius: 1,
    spacingMultipliers: [1, 3] as const, lod: [
      { climate: "summer", bladeHeight: 1.45, bladeWidth: 0.06, segments: 4, curvature: 0.18,
        windStrength: 0.09, windSpeed: 0.72, windGust: 0.14, windGustFreq: 0.1, fade: { start: 68, end: 124 } },
      { climate: "summer", bladeHeight: 1.08, bladeWidth: 0.065, segments: 2, curvature: 0.11,
        windStrength: 0.055, windSpeed: 0.65, windGust: 0.085, windGustFreq: 0.09, fade: { start: 102, end: 168 } },
    ] as const }),
  cinematic: Object.freeze({ maxResidentBlades: 110_000, bladesPerInstance: [9, 5] as const, radius: 3, fineRadius: 1,
    spacingMultipliers: [1, 2.7] as const, lod: [
      { climate: "summer", bladeHeight: 1.6, bladeWidth: 0.065, segments: 5, curvature: 0.2,
        windStrength: 0.1, windSpeed: 0.74, windGust: 0.15, windGustFreq: 0.1, fade: { start: 84, end: 148 } },
      { climate: "summer", bladeHeight: 1.15, bladeWidth: 0.07, segments: 3, curvature: 0.12,
        windStrength: 0.06, windSpeed: 0.66, windGust: 0.09, windGustFreq: 0.09, fade: { start: 126, end: 198 } },
    ] as const }),
});

const profiles: Readonly<Record<GrassFieldQualityTier, GrassFieldVisualProfile>> = Object.freeze(
  Object.fromEntries((Object.keys(renderProfiles) as GrassFieldQualityTier[]).map((quality) => {
    const source = renderProfiles[quality];
    return [quality, Object.freeze({
      maxResidentBlades: source.maxResidentBlades,
      bladesPerInstance: source.bladesPerInstance,
      bladesPerSquareMeter: Object.freeze([4, 1]) as readonly [number, number],
      radius: source.radius,
      fineRadius: source.fineRadius,
      spacingMultipliers: source.spacingMultipliers,
      lod: Object.freeze(source.lod.map((entry) => Object.freeze({
        maxHeight: entry.bladeHeight,
        maxHorizontalDisplacement: entry.curvature + entry.windStrength + entry.windGust,
        footprintRadius: entry.bladeHeight * 0.28,
        ...(entry.fade === undefined ? {} : { fade: entry.fade }),
      })) as unknown as GrassFieldVisualProfile["lod"]),
    })];
  })) as Record<GrassFieldQualityTier, GrassFieldVisualProfile>,
);

function geometry(context: GrassFieldVisualBuildContext): THREE.BufferGeometry {
  const resolved = renderProfiles[context.quality].lod[context.lod];
  const count = profiles[context.quality].bladesPerInstance[context.lod];
  const segments = Math.max(2, resolved.segments);
  const positions: number[] = [], uvs: number[] = [], indices: number[] = [];
  for (let blade = 0; blade < count; blade++) {
    const ring = blade === 0 ? 0 : 0.08 + 0.055 * Math.ceil(blade / 3);
    const angle = blade * 2.399963229728653;
    const bx = Math.cos(angle) * ring, bz = Math.sin(angle) * ring;
    const rightX = Math.cos(angle + Math.PI / 2), rightZ = Math.sin(angle + Math.PI / 2);
    const forwardX = Math.cos(angle), forwardZ = Math.sin(angle);
    const height = resolved.bladeHeight * (0.78 + ((blade * 29 + 7) % 31) / 100);
    const width = resolved.bladeWidth * (0.82 + ((blade * 17 + 3) % 27) / 100);
    const start = positions.length / 3;
    for (let section = 0; section < segments; section++) {
      const t = section / segments;
      const half = width * 0.5 * Math.pow(1 - t, 0.55);
      const lean = resolved.curvature * t * t;
      const crown = width * 0.16 * (1 - t);
      const cx = bx + forwardX * lean, cz = bz + forwardZ * lean, y = height * t;
      positions.push(cx - rightX * half, y, cz - rightZ * half,
        cx + forwardX * crown, y, cz + forwardZ * crown,
        cx + rightX * half, y, cz + rightZ * half);
      uvs.push(0, t, 0.5, t, 1, t);
    }
    const tip = positions.length / 3;
    positions.push(bx + forwardX * resolved.curvature, height, bz + forwardZ * resolved.curvature);
    uvs.push(0.5, 1);
    for (let section = 0; section < segments - 1; section++) {
      const a = start + section * 3, d = a + 3;
      indices.push(a, d, a + 1, a + 1, d, d + 1, a + 1, d + 1, a + 2, a + 2, d + 1, d + 2);
    }
    const last = start + (segments - 1) * 3;
    indices.push(last, tip, last + 1, last + 1, tip, last + 2);
  }
  const result = new THREE.BufferGeometry();
  result.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  result.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  result.setIndex(indices); result.computeVertexNormals(); result.computeBoundingBox(); result.computeBoundingSphere();
  result.userData.liminaRiparianReedBlades = count;
  return result;
}

/** Riparian-specific material: broad wetland clusters, slow coordinated wind, dark planted roots,
 * and warm transmitted tips. This belongs to the content package, not to an engine grass style. */
function material(context: GrassFieldVisualBuildContext): THREE.MeshStandardNodeMaterial {
  const lod = renderProfiles[context.quality].lod[context.lod];
  const result = new THREE.MeshStandardNodeMaterial({ roughness: 0.88, metalness: 0, side: THREE.DoubleSide });
  const local = T.positionLocal;
  const height = T.clamp(local.y.div(lod.bladeHeight), 0, 1);
  const bendWeight = height.pow(2.35);
  const field = context.fieldAttributes;
  const rootYaw = field?.rootYaw ?? T.attribute("aWind", "vec4");
  const rootX = rootYaw.x;
  const rootY = field === undefined ? T.float(0) : rootYaw.y;
  const rootZ = field === undefined ? rootYaw.y : rootYaw.z;
  const yaw = rootYaw.w;
  const instance = T.float(T.instanceIndex);
  const phase = T.hash(instance.add(19)).mul(6.2832);
  const worldX = rootX.add(T.modelPosition.x);
  const worldZ = rootZ.add(T.modelPosition.z);
  const time = T.time.mul(lod.windSpeed);
  const coherent = worldX.mul(0.075).add(worldZ.mul(0.115)).add(time).sin().mul(lod.windStrength);
  const gustEnvelope = worldX.mul(0.027).sub(worldZ.mul(0.041)).sub(time.mul(0.31)).sin().mul(0.5).add(0.5);
  const gust = worldX.mul(lod.windGustFreq).add(worldZ.mul(lod.windGustFreq * 0.6))
    .add(time.mul(1.8)).sin().mul(lod.windGust).mul(gustEnvelope);
  const flutter = time.mul(2.3).add(phase).sin().mul(lod.windStrength * 0.18);
  let sway = coherent.add(gust).add(flutter).mul(bendWeight);
  const dx = rootX.sub(T.cameraPosition.x.sub(T.modelPosition.x));
  const dz = rootZ.sub(T.cameraPosition.z.sub(T.modelPosition.z));
  const fade = T.oneMinus(T.smoothstep(lod.fade.start, lod.fade.end, T.sqrt(dx.mul(dx).add(dz.mul(dz)))));
  sway = sway.mul(fade);
  const cy = yaw.cos(), sy = yaw.sin();
  const windX = sway.mul(0.62), windZ = sway.mul(0.78);
  const localWindX = cy.mul(windX).sub(sy.mul(windZ));
  const localWindZ = sy.mul(windX).add(cy.mul(windZ));
  const px = local.x.add(localWindX), py = local.y.mul(fade), pz = local.z.add(localWindZ);
  if (field === undefined) result.positionNode = T.vec3(px, py, pz);
  else {
    // deno-lint-ignore no-explicit-any
    const scale = field.scale as any;
    const lx = px.mul(scale), ly = py.mul(scale), lz = pz.mul(scale);
    result.positionNode = T.vec3(rootX.add(cy.mul(lx).add(sy.mul(lz))), rootY.add(ly), rootZ.add(cy.mul(lz).sub(sy.mul(lx))));
  }
  const base = new THREE.Color(0x294322), tip = new THREE.Color(0x8ca654);
  const variation = T.hash(instance.add(61)).sub(0.5).mul(0.12);
  let color = T.mix(T.vec3(base.r, base.g, base.b), T.vec3(tip.r, tip.g, tip.b), height).add(variation);
  color = color.mul(T.mix(T.float(0.38), T.float(1), T.smoothstep(0, 0.28, height)));
  result.colorNode = T.max(color, 0);
  const view = T.cameraPosition.sub(T.positionWorld).normalize();
  const backlight = T.max(view.negate().dot(T.vec3(0.42, 0.76, 0.5)), 0).pow(3.2);
  result.emissiveNode = color.mul(T.vec3(0.2, 0.34, 0.1)).mul(backlight).mul(height).mul(0.64);
  result.userData.liminaGrassMaterial = "riparian-reed/v1";
  return result;
}

export const RIPARIAN_REED_GRASS_PACKAGE: GrassFieldVisualPackage = Object.freeze({
  schema: GRASS_FIELD_VISUAL_PACKAGE_SCHEMA,
  id: "limina.grass.riparian-reed",
  version: "1.0.1",
  variants: Object.freeze(["summer"]),
  profile: (quality: GrassFieldQualityTier) => profiles[quality],
  createGeometry: geometry,
  createMaterial: material,
});
