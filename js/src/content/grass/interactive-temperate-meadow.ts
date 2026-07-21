import * as THREE from "../../../build/three.bundle.mjs";
import type { GrassFieldQualityTier } from "../../render/grass-field-config.ts";
import {
  CONTINUOUS_GRASS_FAR_SURFACE_FADE_M,
  GRASS_FIELD_VISUAL_PACKAGE_SCHEMA,
  type GrassFieldVisualBuildContext,
  type GrassFieldVisualPackage,
  type GrassFieldVisualProfile,
} from "../../render/grass-field-package.ts";

// deno-lint-ignore no-explicit-any
const T = (THREE as any).TSL;
const MID_CLUSTER_BLADES_PER_INSTANCE = 16;
const MID_CLUSTER_GEOMETRY = Object.freeze({
  schema: "limina.grass-mid-physical-cluster/v1",
  blades: MID_CLUSTER_BLADES_PER_INSTANCE,
  longitudinalSegments: 1,
  trianglesPerBlade: 2,
  variationDomain: "world-root-xz",
  variantFamilies: 64,
  rootRadiusM: 0.55,
  bladeYawJitterRad: 0.24,
  bladeOffsetRadiusM: 0.08,
  bladeWidthScale: Object.freeze([0.88, 1.12] as const),
  bladeHeightScale: Object.freeze([0.9, 1.1] as const),
  bladeLeanMaxM: 0.08,
  foldedLightingSurface: true,
});

interface MeadowLod {
  readonly bladesPerSquareMeter: number;
  readonly bladesPerInstance: number;
  readonly height: number;
  readonly width: number;
  readonly spread: number;
  readonly segments: number;
  readonly bend: number;
  readonly wind: number;
  readonly gust: number;
  readonly fade: Readonly<{ start: number; end: number }>;
}
interface MeadowTier {
  readonly maxResidentBlades: number;
  readonly radius: number;
  readonly fineRadius: number;
  readonly spacingMultipliers: readonly [number, number];
  readonly lod: readonly [MeadowLod, MeadowLod];
}

/** Clean-room implementation of the public principles documented at
 * https://penev.tech/labs/grass. No deployed source was copied. The package groups a bounded
 * number of independently modeled folded blades into deterministic distant clusters; Limina retains
 * terrain grounding, paging, culling, biome masks, and actual-blade residency budgets. */
const tiers: Readonly<Record<GrassFieldQualityTier, MeadowTier>> = Object.freeze({
  performance: Object.freeze({ maxResidentBlades: 60_000, radius: 2, fineRadius: 0,
    spacingMultipliers: [1, Math.sqrt(8 * 90 / 5.5)] as const, lod: [
      Object.freeze({ bladesPerSquareMeter: 90, bladesPerInstance: 1, height: 0.3, width: 0.032,
        spread: 0, segments: 3, bend: 0.04,
        wind: 0.022, gust: 0.026, fade: Object.freeze({ start: 12, end: 16 }) }),
      Object.freeze({ bladesPerSquareMeter: 5.5, bladesPerInstance: 8, height: 0.23, width: 0.028,
        spread: 0.7, segments: 3, bend: 0.022,
        wind: 0.014, gust: 0.016, fade: Object.freeze({ start: 30, end: 56 }) }),
    ] as const }),
  balanced: Object.freeze({ maxResidentBlades: 120_000, radius: 2, fineRadius: 0,
    spacingMultipliers: [1, Math.sqrt(10 * 150 / 12)] as const, lod: [
      Object.freeze({ bladesPerSquareMeter: 150, bladesPerInstance: 1, height: 0.32, width: 0.034,
        spread: 0, segments: 4, bend: 0.047,
        wind: 0.026, gust: 0.032, fade: Object.freeze({ start: 8, end: 16 }) }),
      Object.freeze({ bladesPerSquareMeter: 12, bladesPerInstance: 10, height: 0.24, width: 0.029,
        spread: 0.85, segments: 3, bend: 0.025,
        wind: 0.016, gust: 0.019, fade: Object.freeze({ start: 34, end: 66 }) }),
    ] as const }),
  cinematic: Object.freeze({ maxResidentBlades: 525_000, radius: 2, fineRadius: 2,
    spacingMultipliers: [1, Math.sqrt(16 * 260 / 72)] as const, lod: [
      Object.freeze({ bladesPerSquareMeter: 260, bladesPerInstance: 1, height: 0.34, width: 0.035,
        spread: 0, segments: 5, bend: 0.052,
        wind: 0.03, gust: 0.038, fade: Object.freeze({ start: 8, end: 16 }) }),
      Object.freeze({ bladesPerSquareMeter: 72, bladesPerInstance: 16, height: 0.27, width: 0.021,
        spread: 1.15, segments: 3, bend: 0.026,
        wind: 0.017, gust: 0.021, fade: Object.freeze({ start: 8, end: 20 }) }),
    ] as const }),
});

const profiles: Readonly<Record<GrassFieldQualityTier, GrassFieldVisualProfile>> = Object.freeze(
  Object.fromEntries((Object.keys(tiers) as GrassFieldQualityTier[]).map((quality) => {
    const tier = tiers[quality];
    // Keep the physical-to-surface retirement inside the existing 32 m residency envelope, but
    // give cinematic grass enough screen distance to dissolve instead of exposing an eight-metre
    // density step. The far surface proxy is already substantially established at 18 m and fully
    // established by 20 m, so this changes only the handoff profile, not residency or geometry.
    const midRange = quality === "cinematic" ? [8, 16, 18, 32]
      : quality === "balanced" ? [8, 16, 24, 32] : [12, 16, 24, 32];
    const midDensity = quality === "cinematic" ? 72 : quality === "balanced" ? 46 : 28;
    // Mean projected areas are mechanically measured by p_grass_silhouette_contract. These
    // initial values are pinned to the authored folded geometry and must move with that gate.
    const midProjectedArea = quality === "cinematic" ? 0.06465
      : quality === "balanced" ? 0.05912 : 0.05219;
    const midTargetCoverage = midDensity * midProjectedArea / MID_CLUSTER_BLADES_PER_INSTANCE;
    const midRadius = 2;
    return [quality, Object.freeze({
      maxResidentBlades: tier.maxResidentBlades,
      bladesPerInstance: Object.freeze([tier.lod[0].bladesPerInstance, tier.lod[1].bladesPerInstance]) as readonly [number, number],
      bladesPerSquareMeter: Object.freeze([tier.lod[0].bladesPerSquareMeter, tier.lod[1].bladesPerSquareMeter]) as readonly [number, number],
      radius: tier.radius,
      fineRadius: tier.fineRadius,
      spacingMultipliers: tier.spacingMultipliers,
      lod: Object.freeze(tier.lod.map((lod) => Object.freeze({
        maxHeight: lod.height * 1.22,
        maxHorizontalDisplacement: lod.bend * 2.05 + lod.wind + lod.gust * 1.55,
        footprintRadius: lod.spread + lod.width * 0.5,
        fade: lod.fade,
      })) as unknown as GrassFieldVisualProfile["lod"]),
      additionalContinuousBands: Object.freeze([Object.freeze({
        id: "mid-cluster",
        cellSizeDivisor: 3,
        radius: midRadius,
        lod: 1 as const,
        bladesPerInstance: MID_CLUSTER_BLADES_PER_INSTANCE,
        bladesPerSquareMeter: midDensity,
        maxResidentBlades: quality === "cinematic" ? 540_000 : quality === "balanced" ? 360_000 : 220_000,
        fadeIn: Object.freeze({ start: midRange[0]!, end: midRange[1]! }),
        fadeOut: Object.freeze({ start: midRange[2]!, end: midRange[3]! }),
        projectedAreaPerInstanceM2: midProjectedArea,
        targetProjectedCoverage: midTargetCoverage,
        placement: Object.freeze({
          strategy: "world-matern-blue-noise/v1" as const,
          oversample: 2,
          // Empirically retains about half of the infinite candidate field. Two-times candidate
          // density therefore preserves the authored root density without submitting the much
          // larger three-times fixed-slot field to native WebGPU.
          minimumDistanceMultiplier: 0.84,
        }),
        visualBounds: Object.freeze({
          // The shader widens, offsets, leans, and height-varies these cards beyond base LOD1.
          maxHeight: 0.52,
          maxHorizontalDisplacement: 0.104,
          footprintRadius: 0.82,
        }),
        complementsLod: 0 as const,
      })]),
      farSurfaceProxy: Object.freeze({ fadeIn: CONTINUOUS_GRASS_FAR_SURFACE_FADE_M, coverageEnd: 10_000 }),
    })];
  })) as Record<GrassFieldQualityTier, GrassFieldVisualProfile>,
);

function midClusterGeometry(context: GrassFieldVisualBuildContext, lod: MeadowLod): THREE.BufferGeometry {
  const positions: number[] = [], normals: number[] = [], uvs: number[] = [], variation: number[] = [], indices: number[] = [];
  const near = tiers[context.quality].lod[0], blades = MID_CLUSTER_BLADES_PER_INSTANCE;
  for (let blade = 0; blade < blades; blade++) {
    const angle = blade * 2.399963229728653 + ((blade * 37 + 11) % 17) * 0.021;
    const radial = blade === 0 ? 0 : MID_CLUSTER_GEOMETRY.rootRadiusM
      * Math.sqrt(0.08 + 0.92 * (((blade * 23 + 5) % 29) / 28));
    const rootX = Math.cos(angle) * radial, rootZ = Math.sin(angle) * radial;
    const rightX = Math.cos(angle + Math.PI / 2), rightZ = Math.sin(angle + Math.PI / 2);
    const forwardX = Math.cos(angle), forwardZ = Math.sin(angle);
    const height = near.height * (0.78 + ((blade * 29 + 7) % 31) / 90);
    const width = near.width * (0.74 + ((blade * 17 + 3) % 23) / 42);
    const lean = near.bend * (0.72 + ((blade * 13 + 9) % 19) / 28);
    const tint = ((blade * 19 + 7) % 37) / 36, start = positions.length / 3;
    const half = width * 0.5, crownHalf = width * (0.065 + ((blade * 11 + 5) % 7) / 200);
    const twist = width * (0.02 + ((blade * 7 + 3) % 11) / 500);
    // One connected, subtly twisted tapered ribbon. The narrow crown prevents the pointed
    // triangular-spike silhouette while the non-planar top edge retains physical lighting at the
    // two-triangle cost required by native fixed-slot submission.
    positions.push(
      rootX - rightX * half, 0, rootZ - rightZ * half,
      rootX + rightX * half, 0, rootZ + rightZ * half,
      rootX + forwardX * (lean + twist) - rightX * crownHalf, height,
      rootZ + forwardZ * (lean + twist) - rightZ * crownHalf,
      rootX + forwardX * (lean - twist) + rightX * crownHalf, height * 0.985,
      rootZ + forwardZ * (lean - twist) + rightZ * crownHalf,
    );
    uvs.push(0, 0, 1, 0, 0, 1, 1, 1);
    variation.push(tint, tint, tint, tint);
    for (const side of [-1, 1, -1, 1]) {
      const nx = forwardX + rightX * side * 0.22, ny = 0.04;
      const nz = forwardZ + rightZ * side * 0.22, length = Math.hypot(nx, ny, nz);
      normals.push(nx / length, ny / length, nz / length);
    }
    indices.push(start, start + 2, start + 1, start + 1, start + 2, start + 3);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute("normal", new THREE.Float32BufferAttribute(normals, 3));
  geometry.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setAttribute("meadowVariation", new THREE.Float32BufferAttribute(variation, 1));
  geometry.setIndex(indices); geometry.computeBoundingBox(); geometry.computeBoundingSphere();
  geometry.userData.liminaTemperateMeadowBlades = MID_CLUSTER_BLADES_PER_INSTANCE;
  geometry.userData.liminaGroundCoverStrategy = "world-varied-folded-physical-cluster/v2";
  geometry.userData.liminaMidClusterGeometry = MID_CLUSTER_GEOMETRY;
  return geometry;
}

function bladeGeometry(context: GrassFieldVisualBuildContext): THREE.BufferGeometry {
  const lod = tiers[context.quality].lod[context.lod];
  if (context.presentationBand === "mid-cluster") return midClusterGeometry(context, lod);
  const positions: number[] = [], uvs: number[] = [], variation: number[] = [], indices: number[] = [];
  // LOD0 is one independently instanced folded blade: the 200k cinematic budget is an honest blade
  // budget, not a repeated near-camera tuft count. LOD1 deliberately groups individually modeled
  // blades across a broad footprint so the complete residency window remains covered at distance.
  for (let blade = 0; blade < lod.bladesPerInstance; blade++) {
    const angle = blade * 2.399963229728653 + ((blade * 37 + 11) % 17) * 0.021;
    const radialLayer = blade === 0 ? 0 : 0.48 + 0.52 * (((blade * 23 + 5) % 29) / 28);
    const ring = lod.spread * radialLayer;
    const rootX = Math.cos(angle) * ring, rootZ = Math.sin(angle) * ring;
    const rightX = Math.cos(angle + Math.PI / 2), rightZ = Math.sin(angle + Math.PI / 2);
    const forwardX = Math.cos(angle), forwardZ = Math.sin(angle);
    const heightScale = 0.7 + ((blade * 29 + 7) % 31) / 100;
    const widthScale = 0.88 + ((blade * 17 + 3) % 23) / 100;
    const height = lod.height * heightScale, width = lod.width * widthScale;
    const lean = lod.bend * (0.72 + ((blade * 13 + 9) % 19) / 34);
    const tint = ((blade * 19 + 7) % 37) / 36;
    const start = positions.length / 3;
    for (let section = 0; section < lod.segments; section++) {
      const t = section / lod.segments;
      // Real blades retain most of their width through the lower body and taper near the tip.
      // Root-to-tip taper produced the rejected field of solid triangular spikes.
      const taper = t <= 0.52 ? 1 : Math.pow(Math.max(0, (1 - t) / 0.48), 0.72);
      const half = width * 0.5 * taper;
      const forward = lean * t * t;
      const fold = width * 0.24 * (1 - t);
      const cx = rootX + forwardX * forward, cz = rootZ + forwardZ * forward, y = height * t;
      positions.push(cx - rightX * half, y, cz - rightZ * half,
        cx + forwardX * fold, y, cz + forwardZ * fold,
        cx + rightX * half, y, cz + rightZ * half);
      uvs.push(0, t, 0.5, t, 1, t);
      variation.push(tint, tint, tint);
    }
    const tip = positions.length / 3;
    positions.push(rootX + forwardX * lean, height, rootZ + forwardZ * lean);
    uvs.push(0.5, 1); variation.push(tint);
    for (let section = 0; section < lod.segments - 1; section++) {
      const a = start + section * 3, d = a + 3;
      indices.push(a, d, a + 1, a + 1, d, d + 1, a + 1, d + 1, a + 2, a + 2, d + 1, d + 2);
    }
    const last = start + (lod.segments - 1) * 3;
    indices.push(last, tip, last + 1, last + 1, tip, last + 2);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setAttribute("meadowVariation", new THREE.Float32BufferAttribute(variation, 1));
  geometry.setIndex(indices); geometry.computeVertexNormals(); geometry.computeBoundingBox(); geometry.computeBoundingSphere();
  geometry.userData.liminaTemperateMeadowBlades = lod.bladesPerInstance;
  geometry.userData.liminaGroundCoverStrategy = context.lod === 0
    ? "individually-instanced-curved-blade/v3" : "bounded-distant-meadow-cluster/v3";
  return geometry;
}

function bladeMaterial(context: GrassFieldVisualBuildContext): THREE.MeshStandardNodeMaterial {
  const lod = tiers[context.quality].lod[context.lod];
  const midCluster = context.presentationBand === "mid-cluster";
  const variant = context.variant === "autumn" || context.variant === "dry" || context.variant === "winter"
    ? context.variant : "summer";
  const palette = variant === "winter" ? [0x4d6346, 0xa7b18a] : variant === "autumn" ? [0x66703a, 0xb9a75c]
    : variant === "dry" ? [0x716d32, 0xc0ae67] : [0x3f7336, 0x9bb957];
  const base = new THREE.Color(palette[0]), tip = new THREE.Color(palette[1]);
  const material = new THREE.MeshStandardNodeMaterial({ roughness: 0.78, metalness: 0, side: THREE.DoubleSide });
  const materialHeight = midCluster ? tiers[context.quality].lod[0].height : lod.height;
  const pl = T.positionLocal, hf = T.clamp(pl.y.div(materialHeight), 0, 1), weight = hf.pow(2.8);
  const field = context.fieldAttributes;
  const rootYaw = field?.rootYaw ?? T.attribute("aWind", "vec4");
  const rootX = rootYaw.x, rootY = field === undefined ? T.float(0) : rootYaw.y;
  const rootZ = field === undefined ? rootYaw.y : rootYaw.z, yaw = rootYaw.w;
  const bladeVariation = T.attribute("meadowVariation", "float").sub(0.5);
  const patchWorldX = rootX.add(T.modelPosition.x), patchWorldZ = rootZ.add(T.modelPosition.z);
  // Instance indices restart for every streamed cell/tile. Seed every visual decision from the
  // world root instead, so adjacent residency draws cannot stamp the same sequence repeatedly.
  const rootSeedInput = patchWorldX.mul(0.754877666).add(patchWorldZ.mul(0.569840296)).add(yaw.mul(0.159154943));
  const rootSeed = T.hash(rootSeedInput);
  const cardIdentity = bladeVariation.add(0.5);
  const seed = T.hash(rootSeed.mul(97.13).add(cardIdentity.mul(7919)).add(17));
  const seedB = T.hash(rootSeed.mul(193.7).add(cardIdentity.mul(3571)).add(31));
  const seedC = T.hash(rootSeed.mul(389.3).add(cardIdentity.mul(1597)).add(47));
  const instanceHeightScale = T.hash(rootSeed.mul(53.9).add(31)).mul(0.5).add(0.72);
  const staticBend = T.hash(rootSeed.mul(79.7).add(47)).sub(0.5).mul(lod.bend * 1.6);
  const waveA = patchWorldX.mul(0.16).add(patchWorldZ.mul(0.09)).add(T.time.mul(0.82)).add(seed.mul(6.2832)).sin();
  const waveB = patchWorldX.mul(-0.07).add(patchWorldZ.mul(0.19)).add(T.time.mul(1.47)).add(seed.mul(13.71)).sin();
  const envelope = patchWorldX.mul(0.049).add(patchWorldZ.mul(0.031)).sub(T.time.mul(0.23)).sin().mul(0.5).add(0.5);
  let sway = waveA.mul(lod.wind).add(waveB.mul(lod.gust * 0.55)).add(waveA.mul(lod.gust).mul(envelope))
    .add(staticBend).mul(weight);
  const dx = rootX.sub(T.cameraPosition.x.sub(T.modelPosition.x));
  const dz = rootZ.sub(T.cameraPosition.z.sub(T.modelPosition.z));
  const distance = T.sqrt(dx.mul(dx).add(dz.mul(dz)));
  const midProfile = profiles[context.quality].additionalContinuousBands?.[0];
  const fade = midCluster
    ? T.smoothstep(midProfile!.fadeIn.start, midProfile!.fadeIn.end, distance)
      .mul(T.oneMinus(T.smoothstep(midProfile!.fadeOut.start, midProfile!.fadeOut.end, distance)))
    : T.oneMinus(T.smoothstep(lod.fade.start, lod.fade.end, distance));
  sway = sway.mul(fade);
  const cy = yaw.cos(), sy = yaw.sin();
  const windX = sway.mul(0.848), windZ = sway.mul(0.53);
  const localWindX = cy.mul(windX).sub(sy.mul(windZ)), localWindZ = sy.mul(windX).add(cy.mul(windZ));
  let authoredX = pl.x, authoredY = pl.y, authoredZ = pl.z;
  if (midCluster) {
    const geometryProfile = MID_CLUSTER_GEOMETRY;
    const angle = seed.sub(0.5).mul(geometryProfile.bladeYawJitterRad * 2);
    const ca = angle.cos(), sa = angle.sin();
    const widthScale = T.mix(T.float(geometryProfile.bladeWidthScale[0]),
      T.float(geometryProfile.bladeWidthScale[1]), seedB);
    const heightScale = T.mix(T.float(geometryProfile.bladeHeightScale[0]),
      T.float(geometryProfile.bladeHeightScale[1]), seedC);
    const rotatedX = ca.mul(pl.x).add(sa.mul(pl.z)).mul(widthScale);
    const rotatedZ = ca.mul(pl.z).sub(sa.mul(pl.x)).mul(widthScale);
    const offsetAngle = seedB.mul(Math.PI * 2), offsetRadius = seedC.mul(geometryProfile.bladeOffsetRadiusM);
    const leanAngle = seed.add(seedC).fract().mul(Math.PI * 2);
    const lean = seedB.sub(0.5).mul(geometryProfile.bladeLeanMaxM * 2).mul(hf.pow(2));
    authoredX = rotatedX.add(offsetAngle.cos().mul(offsetRadius)).add(leanAngle.cos().mul(lean));
    authoredZ = rotatedZ.add(offsetAngle.sin().mul(offsetRadius)).add(leanAngle.sin().mul(lean));
    authoredY = pl.y.mul(heightScale);
  }
  const px = authoredX.add(localWindX), py = authoredY.mul(instanceHeightScale), pz = authoredZ.add(localWindZ);
  if (field === undefined) material.positionNode = T.vec3(px, py, pz);
  else {
    const scale = field.scale as any;
    const lx = px.mul(scale), ly = py.mul(scale), lz = pz.mul(scale);
    material.positionNode = T.vec3(rootX.add(cy.mul(lx).add(sy.mul(lz))), rootY.add(ly), rootZ.add(cy.mul(lz).sub(sy.mul(lx))));
  }
  let color = T.mix(T.vec3(base.r, base.g, base.b), T.vec3(tip.r, tip.g, tip.b), hf);
  color = T.mix(color, T.vec3(0.54, 0.46, 0.22), T.smoothstep(0.72, 0.98, seed).mul(T.smoothstep(0.45, 1, hf)).mul(0.42));
  color = color.mul(T.mix(T.float(0.62), T.float(1), T.smoothstep(0, 0.32, hf)))
    .add(seed.sub(0.5).mul(0.045)).add(bladeVariation.mul(T.vec3(0.025, 0.06, 0.014)));
  material.colorNode = T.max(color, 0);
  // Alpha hash is the stable screen-door crossfade used by modern foliage renderers: it keeps
  // depth ordering and shadows deterministic without transparent-blend sorting artifacts. Every
  // geometry band uses the same mechanism, so residency retirement never exposes a solid edge.
  material.opacityNode = fade;
  material.alphaHash = true;
  const view = T.cameraPosition.sub(T.positionWorld).normalize();
  const back = T.max(view.negate().dot(T.vec3(0.42, 0.76, 0.5)), 0).pow(3.5);
  material.emissiveNode = color.mul(T.vec3(0.055, 0.085, 0.028))
    .add(color.mul(T.vec3(0.18, 0.32, 0.09)).mul(back).mul(hf).mul(0.62));
  material.userData.liminaGrassMaterial = "interactive-temperate-meadow/v5";
  if (midCluster) material.userData.liminaMidClusterGeometry = MID_CLUSTER_GEOMETRY;
  return material;
}

export const INTERACTIVE_TEMPERATE_MEADOW_PACKAGE: GrassFieldVisualPackage = Object.freeze({
  schema: GRASS_FIELD_VISUAL_PACKAGE_SCHEMA,
  id: "limina.grass.interactive-temperate-meadow",
  version: "4.0.1",
  variants: Object.freeze(["summer", "autumn", "dry", "winter"]),
  profile: (quality: GrassFieldQualityTier) => profiles[quality],
  createGeometry: bladeGeometry,
  createMaterial: bladeMaterial,
});
