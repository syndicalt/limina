import * as THREE from "../../../build/three.bundle.mjs";
import type { WaterSceneOptics } from "../quality.ts";

// deno-lint-ignore no-explicit-any
const T = (THREE as any).TSL;

// BrowserRenderHost and terrain disposal both recognize this shared explicit-ownership key.
export const WATER_OWNED_TEXTURES_KEY = "liminaOwnedTextures";
export const WATER_OWNED_NODES_KEY = "liminaOwnedNodes";
export const WATER_AUXILIARY_TARGETS_KEY = "liminaWaterAuxiliaryTargets";

export interface WaterDepthTextureBinding {
  texture: THREE.Texture;
  bounds: Readonly<{ minX: number; minZ: number; maxX: number; maxZ: number }>;
  /** RG textures use G as the semantic-body ownership mask. */
  coverageChannel?: boolean;
  /** Ocean bakes cover finite terrain; outside that rectangle is deep open water. */
  outsideAsDeep?: boolean;
  /** The bake's normalisation divisor in metres (R=1 ⇒ this depth). Beer–Lambert absorption
   * needs real water-column metres, not the normalised sample. */
  maxDepthM?: number;
}

export interface WaterMaterialOptions {
  color: number;
  kind: "ocean" | "basin" | "river";
  depth?: WaterDepthTextureBinding;
  peek?: boolean;
  waveCount?: number;
  /** Ocean PlaneGeometry is local XY; authored basin/river geometry is local XZ. */
  orientation?: "xy" | "xz";
  /** Real viewport optics. Refraction samples the opaque scene colour with depth-safe UVs;
   * reflection adds an owned planar reflector for standing water. */
  sceneOptics?: WaterSceneOptics;
  reflectionScale?: number;
}

export type WaterfallMaterialKind = "curtain" | "foam" | "mist";

export function trackWaterMaterialTexture(material: THREE.Material, texture: THREE.Texture): void {
  const userData = material.userData as Record<string, unknown>;
  const current = userData[WATER_OWNED_TEXTURES_KEY];
  const textures = Array.isArray(current) ? current as THREE.Texture[] : [];
  if (!textures.includes(texture)) textures.push(texture);
  userData[WATER_OWNED_TEXTURES_KEY] = textures;
}

export function attachWaterMaterialAuxiliaries(mesh: THREE.Mesh): void {
  const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
  for (const material of materials) {
    const targets = (material.userData as Record<string, unknown>)[WATER_AUXILIARY_TARGETS_KEY];
    if (!Array.isArray(targets)) continue;
    for (const target of targets) if (target instanceof THREE.Object3D && target.parent !== mesh) mesh.add(target);
  }
}

/** Shared TSL/PBR water graph. It compiles through both WebGPU and forceWebGL backends. */
export function createWaterMaterial(options: WaterMaterialOptions): THREE.MeshStandardNodeMaterial {
  const waveCount = Math.max(0, Math.min(4, Math.floor(options.waveCount ?? 4)));
  const orientation = options.orientation ?? "xz";
  const material = new THREE.MeshStandardNodeMaterial({
    color: options.color,
    roughness: options.kind === "river" ? 0.22 : 0.1,
    metalness: 0,
    transparent: true,
    opacity: options.kind === "river" ? 0.68 : 0.85,
    depthWrite: false,
    side: options.kind === "river" ? THREE.DoubleSide : THREE.FrontSide,
  });
  // River colour should be dominated by the scene environment at grazing angles. This remains
  // curved-water-safe IBL/specular reflection; it does not pretend a sloped reach is one plane.
  material.envMapIntensity = options.kind === "river" ? 1.65 : 1;
  try {
  const base = new THREE.Color(options.color);
  const deep = T.vec3(base.r, base.g, base.b);
  const shallow = T.vec3(
    Math.min(1, base.r * 1.7 + 0.05),
    Math.min(1, base.g * 1.45 + 0.2),
    Math.min(1, base.b * 1.15 + 0.1),
  );
  const facing = T.clamp(T.cameraPosition.sub(T.positionWorld).normalize().y, 0, 1);
  const fresnel = T.oneMinus(facing).pow(4);
  const waves = [
    { dx: 0.80, dz: 0.60, frequency: 0.30, speed: 0.90, amplitude: 1.00 },
    { dx: -0.60, dz: 0.80, frequency: 0.42, speed: 1.10, amplitude: 0.80 },
    { dx: 0.50, dz: -0.85, frequency: 0.55, speed: 0.70, amplitude: 0.60 },
    { dx: -0.90, dz: -0.40, frequency: 0.68, speed: 1.30, amplitude: 0.45 },
  ];
  const localX = T.positionLocal.x;
  const localZ = orientation === "xy" ? T.positionLocal.y : T.positionLocal.z;
  const riverArc = options.kind === "river" ? T.attribute("waterArcDistance", "float") : T.float(0);
  const riverDirection = options.kind === "river" ? T.attribute("waterFlowDirection", "vec2") : T.vec2(0, 0);
  const riverCross = options.kind === "river" ? T.attribute("waterCrossDistance", "float") : T.float(0);
  const riverCrossRatio = options.kind === "river" ? T.attribute("waterCrossRatio", "float") : T.float(0);
  // deno-lint-ignore no-explicit-any
  let height: any = T.float(0), slopeX: any = T.float(0), slopeZ: any = T.float(0);
  // River-only, aperiodic flow signals reused by the normal, shore foam, and shallow caustics.
  // Keeping those cues on the same advected field prevents independent sine bands from stacking
  // into the conspicuous cross-channel ribs that the old analytic fan produced.
  // deno-lint-ignore no-explicit-any
  let riverMacroNoise: any = T.float(0), riverDetailNoise: any = T.float(0);
  if (options.kind === "river") {
    // Arc/cross are continuous flow-space metres. Two advected, domain-warped Perlin fields give
    // the river multi-scale boil and streak detail without a finite set of coherent carrier waves.
    // Central differences recover a stable normal gradient in metres; those derivatives are then
    // rotated into world XZ by the verified downstream direction attribute.
    const octaveCount = Math.min(2, waveCount);
    const metreStep = 0.12;
    const advectedArc = riverArc.sub(T.time.mul(0.72));
    const macroCoord = T.vec2(advectedArc.mul(0.12), riverCross.mul(0.19));
    const warpA = T.mx_noise_float(macroCoord.add(T.vec2(4.17, -2.31)));
    const warpB = T.mx_noise_float(macroCoord.mul(0.73).add(T.vec2(-7.4, 5.6)));
    const detailCoord = T.vec2(
      advectedArc.mul(0.46).add(warpA.mul(0.62)),
      riverCross.mul(0.58).add(warpB.mul(0.48)),
    );
    riverMacroNoise = T.mx_noise_float(macroCoord);
    riverDetailNoise = T.mx_noise_float(detailCoord);
    height = octaveCount > 0 ? riverMacroNoise.mul(0.58) : T.float(0);
    if (octaveCount > 1) height = height.add(riverDetailNoise.mul(0.24));
    const sampleHeight = (arcOffsetM: number, crossOffsetM: number) => {
      const shiftedMacro = T.vec2(
        advectedArc.add(arcOffsetM).mul(0.12),
        riverCross.add(crossOffsetM).mul(0.19),
      );
      const shiftedWarpA = T.mx_noise_float(shiftedMacro.add(T.vec2(4.17, -2.31)));
      const shiftedWarpB = T.mx_noise_float(shiftedMacro.mul(0.73).add(T.vec2(-7.4, 5.6)));
      const shiftedDetail = T.vec2(
        advectedArc.add(arcOffsetM).mul(0.46).add(shiftedWarpA.mul(0.62)),
        riverCross.add(crossOffsetM).mul(0.58).add(shiftedWarpB.mul(0.48)),
      );
      const macro = T.mx_noise_float(shiftedMacro).mul(0.58);
      return octaveCount > 1 ? macro.add(T.mx_noise_float(shiftedDetail).mul(0.24)) : macro;
    };
    const alongSlope = sampleHeight(metreStep, 0).sub(sampleHeight(-metreStep, 0)).div(2 * metreStep);
    const crossSlope = sampleHeight(0, metreStep).sub(sampleHeight(0, -metreStep)).div(2 * metreStep);
    slopeX = alongSlope.mul(riverDirection.x).sub(crossSlope.mul(riverDirection.y));
    slopeZ = alongSlope.mul(riverDirection.y).add(crossSlope.mul(riverDirection.x));
    if (octaveCount > 0) {
      material.userData.liminaWaterFlowAlignedNormals = true;
      material.userData.liminaWaterNormalOctaves = octaveCount;
    }
  } else {
    for (let index = 0; index < waveCount; index++) {
      const wave = waves[index];
      const phase = localX.mul(wave.dx * wave.frequency).add(localZ.mul(wave.dz * wave.frequency)).add(T.time.mul(wave.speed));
      height = height.add(phase.sin().mul(wave.amplitude));
      const derivative = phase.cos().mul(wave.amplitude);
      slopeX = slopeX.add(derivative.mul(wave.dx * wave.frequency));
      slopeZ = slopeZ.add(derivative.mul(wave.dz * wave.frequency));
    }
  }
  const normalStrength = options.peek === true ? 0 : options.kind === "river" ? 0.14 : 0.34;
  // Rivers PERTURB the interpolated geometry normal instead of replacing it: the ribbon's
  // continuous per-point normals carry the downstream bed tilt, and discarding them would light
  // a steep reach as a flat sheet.
  const localNormal = orientation === "xy"
    ? T.vec3(slopeX.mul(-normalStrength), slopeZ.mul(-normalStrength), 1).normalize()
    : options.kind === "river"
      ? T.normalLocal.add(T.vec3(slopeX.mul(-normalStrength), 0, slopeZ.mul(-normalStrength))).normalize()
      : T.vec3(slopeX.mul(-normalStrength), 1, slopeZ.mul(-normalStrength)).normalize();
  material.normalNode = T.transformNormalToView(localNormal);
  if (orientation === "xy" && waveCount > 0 && options.kind === "ocean") {
    material.positionNode = T.positionLocal.add(T.vec3(0, 0, height.mul(0.06)));
  }
  const height01 = T.clamp(height.mul(0.18).add(0.5), 0, 1);
  // At grazing angles a river hands over to its environment reflection (fresnel → near-mirror),
  // which is what sells the sky/bank mirror of a real channel; overhead it stays satin.
  material.roughnessNode = options.peek === true
    ? T.float(0.9)
    : options.kind === "river"
      ? T.mix(T.float(0.19), T.float(0.07), fresnel).add(height01.mul(0.05))
      : T.float(0.05).add(height01.mul(0.07));

  // deno-lint-ignore no-explicit-any
  let riverTransmittance: any, riverClarity: any, riverWetBand: any;
  // Exact variable-width ribbon coverage, feathered only across the final few percent of the
  // physical bank. This removes the hard polygon cut while keeping gameplay/grass exclusion tied
  // to the unfeathered semantic topology.
  const riverEdgeCoverage = options.kind === "river"
    ? T.oneMinus(T.smoothstep(0.72, 1, T.abs(riverCrossRatio))) : T.float(1);
  if (options.kind === "river" && options.depth !== undefined) {
    const { minX, minZ, maxX, maxZ } = options.depth.bounds;
    const u = T.positionWorld.x.sub(minX).div(Math.max(maxX - minX, Number.EPSILON));
    const v = T.positionWorld.z.sub(minZ).div(Math.max(maxZ - minZ, Number.EPSILON));
    const sampled = T.texture(options.depth.texture, T.vec2(u, v));
    const depth01 = sampled.r;
    const ownership = options.depth.coverageChannel === true ? sampled.g : T.float(1);
    // Beer–Lambert per-channel absorption over the real view path through the verified water
    // column (red extinguishes first). This is what separates a water VOLUME from a tinted
    // sheet: the bed fades out with depth and the body colour takes over by in-scatter.
    const maxDepthM = options.depth.maxDepthM ?? 3.5;
    const pathM = T.min(depth01.mul(maxDepthM).div(T.max(facing, 0.12)), 24);
    riverTransmittance = T.exp(pathM.mul(T.vec3(-0.34, -0.13, -0.085)));
    riverClarity = T.clamp(T.dot(riverTransmittance, T.vec3(0.25, 0.4, 0.35)), 0, 1);
    // Contact bands: a darkened wet margin exactly at depth→0 (the bank read), and an
    // advected interference foam band just inside it. Both live inside the existing footprint
    // and coverage mask, so water exclusion and channel identity are untouched.
    const bankProximity = T.smoothstep(0.86, 0.995, T.abs(riverCrossRatio));
    riverWetBand = T.max(T.oneMinus(T.smoothstep(0.0, 0.05, depth01)), bankProximity.mul(0.62)).mul(ownership);
    const depthShoreBand = T.oneMinus(T.smoothstep(0.02, 0.2, depth01));
    const shoreBand = T.max(depthShoreBand, bankProximity).mul(ownership);
    const foamNoise = riverMacroNoise.mul(0.32).add(riverDetailNoise.mul(0.68)).mul(0.5).add(0.5);
    const foam = shoreBand.mul(T.smoothstep(0.6, 0.88, foamNoise.add(height01.mul(0.08))))
      .mul(T.sqrt(riverEdgeCoverage));
    const caustic = T.oneMinus(T.smoothstep(0.08, 0.48, depth01))
      .mul(riverDetailNoise.mul(0.5).add(0.5))
      .mul(ownership);
    let waterColor = T.mix(shallow, deep, T.clamp(T.oneMinus(riverClarity).add(fresnel.mul(0.2)), 0, 1));
    waterColor = waterColor.add(T.vec3(0.08, 0.16, 0.12).mul(caustic));
    // Low-amplitude advected luminance is the visible flow cue away from foam and shallow
    // caustics. It follows the same aperiodic detail field as the normals, so motion remains
    // coherent without reintroducing cross-channel carrier bands.
    const flowLuminance = riverDetailNoise.mul(0.5).add(0.5);
    waterColor = waterColor.mul(T.mix(T.float(0.93), T.float(1.07), flowLuminance));
    waterColor = T.mix(waterColor, waterColor.mul(0.4), riverWetBand.mul(0.85));
    material.colorNode = T.mix(waterColor, T.vec3(0.72, 0.82, 0.78), foam.mul(0.48));
    const opacity = T.float(0.18).add(T.oneMinus(riverClarity).mul(0.52));
    material.opacityNode = T.max(opacity, foam.mul(0.72)).mul(ownership).mul(riverEdgeCoverage);
    material.roughnessNode = T.max(material.roughnessNode, foam.mul(0.58));
    material.userData.liminaWaterShoreFoam = true;
    material.userData.liminaWaterCaustics = true;
    material.userData.liminaWaterVolumetricAbsorption = true;
    material.userData.liminaWaterWetShoreMargin = true;
    material.userData.liminaWaterDownstreamFlow = true;
    material.userData.liminaWaterTwoDimensionalFlow = true;
    trackWaterMaterialTexture(material, options.depth.texture);
  } else if (options.depth !== undefined) {
    const { minX, minZ, maxX, maxZ } = options.depth.bounds;
    const u = T.positionWorld.x.sub(minX).div(Math.max(maxX - minX, Number.EPSILON));
    const v = T.positionWorld.z.sub(minZ).div(Math.max(maxZ - minZ, Number.EPSILON));
    const sampled = T.texture(options.depth.texture, T.vec2(u, v));
    const outsideU = T.max(u.mul(-1), u.sub(1));
    const outsideV = T.max(v.mul(-1), v.sub(1));
    const outside = T.clamp(T.max(outsideU, outsideV).mul(40), 0, 1);
    const depth01 = options.depth.outsideAsDeep === true ? T.mix(sampled.r, T.float(1), outside) : sampled.r;
    const ownership = options.depth.coverageChannel === true ? sampled.g : T.float(1);
    const colourDeep = T.smoothstep(0.05, 0.42, depth01);
    let waterColor = T.mix(shallow, deep, T.clamp(colourDeep.add(fresnel.mul(0.25)), 0, 1));
    const shoreBand = T.oneMinus(T.smoothstep(0.025, 0.16, depth01)).mul(ownership);
    const ripple = T.positionWorld.x.mul(0.73).add(T.positionWorld.z.mul(0.57)).sub(T.time.mul(0.8)).sin().mul(0.5).add(0.5);
    const foam = shoreBand.mul(T.smoothstep(0.2, 0.78, ripple));
    // Cheap shallow caustic modulation follows the same verified depth field. This is deliberately
    // a surface cue; scene-depth refraction remains a separate renderer-buffer slice.
    const caustic = T.oneMinus(T.smoothstep(0.08, 0.48, depth01))
      .mul(T.positionWorld.x.mul(1.8).add(T.positionWorld.z.mul(-1.35)).add(T.time.mul(0.7)).sin().mul(0.5).add(0.5))
      .mul(ownership);
    waterColor = waterColor.add(T.vec3(0.08, 0.16, 0.12).mul(caustic));
    material.colorNode = T.mix(waterColor, T.vec3(0.82, 0.94, 0.9), foam.mul(0.72));
    const opacity = T.float(0.22).add(T.smoothstep(0, 0.55, depth01).mul(0.75));
    material.opacityNode = T.max(opacity, foam.mul(0.92)).mul(ownership);
    material.roughnessNode = T.max(material.roughnessNode, foam.mul(0.72));
    material.userData.liminaWaterShoreFoam = true;
    material.userData.liminaWaterCaustics = true;
    trackWaterMaterialTexture(material, options.depth.texture);
  } else if (options.kind === "river") {
    const arc = T.attribute("waterArcDistance", "float");
    const flow = arc.mul(0.18).sub(T.time.mul(1.6)).sin().mul(0.5).add(0.5);
    material.colorNode = T.mix(deep, shallow, T.float(0.16).add(flow.mul(0.12)));
    material.opacityNode = T.float(0.78).add(flow.mul(0.12));
  } else {
    const distance = T.positionView.z.mul(-1);
    const deepness = T.clamp(T.smoothstep(6, 55, distance).mul(0.85).add(fresnel.mul(0.5)), 0, 1);
    material.colorNode = T.mix(shallow, deep, deepness);
    material.opacityNode = T.float(0.55).add(deepness.mul(0.43));
  }
  const optics = options.sceneOptics ?? "none";
  if (optics !== "none" && options.peek !== true) {
    const distortion = T.vec2(slopeX, slopeZ).mul(options.kind === "river" ? 0.013 : 0.009);
    // viewportSafeUV performs a real viewport-depth comparison and rejects distorted samples that
    // belong in front of the water surface. viewportSharedTexture snapshots opaque scene colour,
    // avoiding read/write feedback while the transparent water pass is drawn.
    const refractedUv = T.viewportSafeUV(T.screenUV.add(distortion));
    const refracted = T.viewportSharedTexture(refractedUv);
    let backdrop = refracted.rgb;
    if (options.kind === "river" && riverTransmittance !== undefined) {
      // The refracted bed is attenuated by the SAME Beer–Lambert transmittance that grades the
      // body colour, then in-scatter fills what absorption removed; the wet margin darkens the
      // last visible strip of bank through the near-transparent edge water.
      backdrop = backdrop.mul(riverTransmittance).add(deep.mul(T.oneMinus(riverClarity)).mul(0.85));
      backdrop = backdrop.mul(T.mix(T.float(1), T.float(0.45), riverWetBand));
    }
    if (optics === "refraction-reflection" && options.kind !== "river") {
      const reflection = T.reflector({
        resolutionScale: Math.max(0.125, Math.min(1, options.reflectionScale ?? 0.35)),
        bounces: false,
      });
      reflection.uvNode = reflection.uvNode.add(distortion);
      backdrop = T.mix(backdrop, reflection.rgb, fresnel.mul(0.82));
      material.userData[WATER_OWNED_NODES_KEY] = [reflection];
      material.userData[WATER_AUXILIARY_TARGETS_KEY] = [reflection.target];
      material.userData.liminaWaterPlanarReflection = true;
    }
    material.backdropNode = backdrop;
    material.backdropAlphaNode = (options.kind === "river" && riverClarity !== undefined
      ? T.mix(T.float(0.08), T.float(0.85), riverClarity).mul(T.oneMinus(fresnel.mul(0.55)))
      : T.float(options.kind === "river" ? 0.24 : 0.58).mul(T.oneMinus(fresnel.mul(0.45))))
      .mul(riverEdgeCoverage);
    material.userData.liminaWaterSceneDepthRefraction = true;
  }
    return material;
  } catch (error) {
    material.dispose();
    throw error;
  }
}

/** Dedicated vertical-water and spray materials. They intentionally do not reuse the horizontal
 * surface normal graph: a waterfall sheet must retain its geometry-derived vertical normal. */
export function createWaterfallMaterial(kind: WaterfallMaterialKind): THREE.Material {
  if (kind === "mist") {
    const material = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, side: THREE.DoubleSide });
    const radial = T.oneMinus(T.clamp(T.positionLocal.y.add(0.5), 0, 1));
    const drift = T.positionLocal.x.mul(2.1).add(T.time.mul(0.55)).sin().mul(0.5).add(0.5);
    material.colorNode = T.mix(T.vec3(0.56, 0.72, 0.76), T.vec3(0.94, 0.98, 1), drift);
    material.opacityNode = radial.mul(0.24).add(drift.mul(0.08));
    material.userData.liminaWaterfallMaterial = "mist/v1";
    return material;
  }
  const material = new THREE.MeshStandardNodeMaterial({
    roughness: kind === "foam" ? 0.78 : 0.24,
    metalness: 0,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  const arc = T.attribute("waterArcDistance", "float");
  const streak = arc.mul(kind === "foam" ? 2.4 : 1.15).sub(T.time.mul(kind === "foam" ? 3.6 : 2.2))
    .sin().mul(0.5).add(0.5);
  if (kind === "foam") {
    material.colorNode = T.mix(T.vec3(0.55, 0.78, 0.82), T.vec3(0.94, 0.99, 1), streak);
    material.opacityNode = T.float(0.58).add(streak.mul(0.34));
    material.userData.liminaWaterfallMaterial = "foam/v1";
  } else {
    const vertical = T.clamp(arc.mul(0.18), 0, 1);
    material.colorNode = T.mix(T.vec3(0.08, 0.34, 0.43), T.vec3(0.62, 0.86, 0.9), streak.mul(0.48).add(vertical.mul(0.2)));
    material.opacityNode = T.float(0.62).add(streak.mul(0.22));
    material.userData.liminaWaterfallMaterial = "curtain/v1";
  }
  return material;
}
