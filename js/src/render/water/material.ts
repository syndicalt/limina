import * as THREE from "../../../build/three.bundle.mjs";

// deno-lint-ignore no-explicit-any
const T = (THREE as any).TSL;

// BrowserRenderHost and terrain disposal both recognize this shared explicit-ownership key.
export const WATER_OWNED_TEXTURES_KEY = "liminaOwnedTextures";

export interface WaterDepthTextureBinding {
  texture: THREE.Texture;
  bounds: Readonly<{ minX: number; minZ: number; maxX: number; maxZ: number }>;
  /** RG textures use G as the semantic-body ownership mask. */
  coverageChannel?: boolean;
  /** Ocean bakes cover finite terrain; outside that rectangle is deep open water. */
  outsideAsDeep?: boolean;
}

export interface WaterMaterialOptions {
  color: number;
  kind: "ocean" | "basin" | "river";
  depth?: WaterDepthTextureBinding;
  peek?: boolean;
  waveCount?: number;
  /** Ocean PlaneGeometry is local XY; authored basin/river geometry is local XZ. */
  orientation?: "xy" | "xz";
}

export function trackWaterMaterialTexture(material: THREE.Material, texture: THREE.Texture): void {
  const userData = material.userData as Record<string, unknown>;
  const current = userData[WATER_OWNED_TEXTURES_KEY];
  const textures = Array.isArray(current) ? current as THREE.Texture[] : [];
  if (!textures.includes(texture)) textures.push(texture);
  userData[WATER_OWNED_TEXTURES_KEY] = textures;
}

/** Shared TSL/PBR water graph. It compiles through both WebGPU and forceWebGL backends. */
export function createWaterMaterial(options: WaterMaterialOptions): THREE.MeshStandardNodeMaterial {
  const waveCount = Math.max(0, Math.min(4, Math.floor(options.waveCount ?? 4)));
  const orientation = options.orientation ?? "xz";
  const material = new THREE.MeshStandardNodeMaterial({
    color: options.color,
    roughness: options.kind === "river" ? 0.14 : 0.1,
    metalness: 0,
    transparent: true,
    opacity: options.kind === "river" ? 0.84 : 0.85,
    depthWrite: false,
    side: options.kind === "river" ? THREE.DoubleSide : THREE.FrontSide,
  });
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
  // deno-lint-ignore no-explicit-any
  let height: any = T.float(0), slopeX: any = T.float(0), slopeZ: any = T.float(0);
  for (let index = 0; index < waveCount; index++) {
    const wave = waves[index];
    const phase = localX.mul(wave.dx * wave.frequency)
      .add(localZ.mul(wave.dz * wave.frequency))
      .add(T.time.mul(wave.speed));
    height = height.add(phase.sin().mul(wave.amplitude));
    const derivative = phase.cos().mul(wave.amplitude * wave.frequency);
    slopeX = slopeX.add(derivative.mul(wave.dx));
    slopeZ = slopeZ.add(derivative.mul(wave.dz));
  }
  const normalStrength = options.peek === true ? 0 : options.kind === "river" ? 0.2 : 0.34;
  const localNormal = orientation === "xy"
    ? T.vec3(slopeX.mul(-normalStrength), slopeZ.mul(-normalStrength), 1).normalize()
    : T.vec3(slopeX.mul(-normalStrength), 1, slopeZ.mul(-normalStrength)).normalize();
  material.normalNode = T.transformNormalToView(localNormal);
  if (orientation === "xy" && waveCount > 0 && options.kind === "ocean") {
    material.positionNode = T.positionLocal.add(T.vec3(0, 0, height.mul(0.06)));
  }
  const height01 = T.clamp(height.mul(0.18).add(0.5), 0, 1);
  material.roughnessNode = options.peek === true
    ? T.float(0.9)
    : T.float(options.kind === "river" ? 0.09 : 0.05).add(height01.mul(options.kind === "river" ? 0.09 : 0.07));

  if (options.depth !== undefined) {
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
    material.colorNode = T.mix(shallow, deep, T.clamp(colourDeep.add(fresnel.mul(0.25)), 0, 1));
    const opacity = T.float(0.22).add(T.smoothstep(0, 0.55, depth01).mul(0.75));
    material.opacityNode = opacity.mul(ownership);
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
    return material;
  } catch (error) {
    material.dispose();
    throw error;
  }
}
