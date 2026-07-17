/** Deterministic WebGPU/TSL volumetric hearth fire.
 *
 * The bounded box-raymarch technique is adapted from THREE.Fire by typeWolffo
 * (MIT; see js/THIRD_PARTY_NOTICES.md). Limina deliberately does not import the
 * package at runtime: its stock TSL path uses Math.random(), Three's renderer
 * clock, disabled depth testing, and bare `three` module identities. This port
 * keeps the useful technique while preserving Limina's tick, seed, occlusion,
 * bundle, and lifecycle authorities.
 */

import * as THREE from "../../build/three.bundle.mjs";

// TSL is dynamically exposed by Limina's pinned Three r184 bundle.
// deno-lint-ignore no-explicit-any
const T = (THREE as any).TSL;

type V3 = readonly [number, number, number];

export interface BuildingFireVolumeContract {
  readonly id: string;
  readonly socketId: string;
  readonly geometry: "volumetric-raymarch-box";
  readonly materialRole: "flame-volume";
  readonly centerOffsetM: V3;
  readonly halfExtentsM: V3;
  readonly iterations: number;
  readonly noiseOctaves: number;
  readonly noiseScale: readonly [number, number, number, number];
  readonly magnitude: number;
  readonly lacunarity: number;
  readonly gain: number;
  readonly densityTextureResolution: readonly [number, number];
  readonly densityProfile: "analytic-radial-height/v1";
  readonly timeAuthority: "explicit-runtime-tick-uniform";
  readonly seedAuthority: "simulation-seed";
  readonly depthTest: true;
  readonly depthWrite: false;
}

export interface BuildingFireVolume {
  readonly mesh: THREE.Mesh;
  readonly geometry: THREE.BoxGeometry;
  readonly material: THREE.MeshBasicNodeMaterial;
  readonly densityTexture: THREE.DataTexture;
  readonly triangles: 12;
  readonly fragmentWorkPerCoveredPixel: number;
  readonly disposed: boolean;
  update(timeSeconds: number, envelope: number): void;
  dispose(): void;
}

interface CreateBuildingFireVolumeInput {
  readonly contract: BuildingFireVolumeContract;
  readonly socketPosition: V3;
  readonly simulationSeed: number;
}

function finite(value: unknown, minimum: number, maximum: number, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum) {
    throw new RangeError(`${label} must be finite in [${minimum}, ${maximum}]`);
  }
  return value;
}

function integer(value: unknown, minimum: number, maximum: number, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new RangeError(`${label} must be an integer in [${minimum}, ${maximum}]`);
  }
  return value as number;
}

function smoothstep(edge0: number, edge1: number, value: number): number {
  const t = Math.max(0, Math.min(1, (value - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

/** Analytic substitute for THREE.Fire's caller-owned grayscale mask.
 * X encodes normalized radius and Y encodes height. The upstream reference is
 * a hollow teardrop/ring, not a filled radial blob: preserving that hollow shell
 * is what creates transparent separation and a colored flame edge after marching.
 */
export function createBuildingFireDensityTexture(width = 128, height = 192): THREE.DataTexture {
  integer(width, 32, 512, "fire density texture width");
  integer(height, 32, 512, "fire density texture height");
  const pixels = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    const v = (y + .5) / height;
    const centerRadius = .055 + .82 * Math.pow(1 - v, .62)
      + .026 * Math.sin(v * 24.7) + .014 * Math.sin(v * 47.3 + 1.2);
    const thickness = .055 + .09 * Math.pow(1 - v, .7);
    for (let x = 0; x < width; x++) {
      const radius = (x + .5) / width;
      const distance = Math.abs(radius - centerRadius);
      const shell = 1 - smoothstep(thickness * .24, thickness, distance);
      const softInterior = .12 * (1 - smoothstep(centerRadius * .25, centerRadius * .92, radius));
      const verticalFade = smoothstep(0, .045, v) * (1 - smoothstep(.91, 1, v));
      const density = Math.max(0, Math.min(1, Math.max(shell, softInterior) * verticalFade));
      const value = Math.round(density * 255), offset = (y * width + x) * 4;
      pixels[offset] = value; pixels[offset + 1] = value; pixels[offset + 2] = value; pixels[offset + 3] = value;
    }
  }
  const texture = new THREE.DataTexture(pixels, width, height, THREE.RGBAFormat, THREE.UnsignedByteType);
  texture.name = "limina:deterministic-fire-density-analytic-radial-height-v1";
  texture.magFilter = THREE.LinearFilter; texture.minFilter = THREE.LinearFilter;
  texture.wrapS = THREE.ClampToEdgeWrapping; texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.colorSpace = THREE.NoColorSpace; texture.generateMipmaps = false; texture.needsUpdate = true;
  texture.userData.liminaDensityProfile = "analytic-radial-height/v1";
  texture.userData.liminaDeterministic = true;
  return texture;
}

export function createBuildingFireVolume(input: CreateBuildingFireVolumeInput): BuildingFireVolume {
  const contract = input.contract;
  if (contract.geometry !== "volumetric-raymarch-box" || contract.materialRole !== "flame-volume") {
    throw new Error("building fire volume requires the volumetric flame contract");
  }
  if (contract.timeAuthority !== "explicit-runtime-tick-uniform" || contract.seedAuthority !== "simulation-seed") {
    throw new Error("building fire volume requires explicit tick and simulation seed authority");
  }
  if (contract.depthTest !== true || contract.depthWrite !== false) throw new Error("building fire volume must be depth-tested without depth writes");
  const iterations = integer(contract.iterations, 8, 32, "fire volume iterations");
  const octaves = integer(contract.noiseOctaves, 1, 5, "fire volume noiseOctaves");
  const half = contract.halfExtentsM.map((value, axis) => finite(value, .03, .8, `fire volume halfExtentsM[${axis}]`)) as unknown as V3;
  const offset = contract.centerOffsetM.map((value, axis) => finite(value, -.8, .8, `fire volume centerOffsetM[${axis}]`)) as unknown as V3;
  const resolution = contract.densityTextureResolution;
  if (contract.densityProfile !== "analytic-radial-height/v1") throw new Error("building fire volume density profile is unsupported");
  const densityTexture = createBuildingFireDensityTexture(resolution[0], resolution[1]);
  const geometry = new THREE.BoxGeometry(half[0] * 2, half[1] * 2, half[2] * 2, 1, 1, 1);
  geometry.name = "limina:building-fire-volumetric-box";

  const authorityTime = T.uniform(0), authorityEnvelope = T.uniform(0);
  const inverseModel = T.uniform(new THREE.Matrix4()), worldScale = T.uniform(new THREE.Vector3(half[0] * 2, half[1] * 2, half[2] * 2));
  const seed01 = (integer(input.simulationSeed, 0, 0xffffffff, "fire simulation seed") >>> 0) / 0x1_0000_0000;
  const seed = T.uniform(seed01 * 19.19), noiseScale = T.uniform(new THREE.Vector4(...contract.noiseScale));
  const magnitude = T.uniform(finite(contract.magnitude, .5, 3, "fire volume magnitude"));
  const lacunarity = T.uniform(finite(contract.lacunarity, 1, 4, "fire volume lacunarity"));
  const gain = T.uniform(finite(contract.gain, .1, 1, "fire volume gain"));

  // deno-lint-ignore no-explicit-any
  const turbulence = T.Fn(([point]: [any]) => {
    const sum = T.float(0).toVar("liminaFireTurbulence"), frequency = T.float(1).toVar("liminaFireFrequency");
    const amplitude = T.float(1).toVar("liminaFireAmplitude"), position = T.vec3(point).toVar("liminaFireNoisePosition");
    T.Loop(octaves, () => { sum.addAssign(T.abs(T.mx_noise_float(position.mul(frequency))).mul(amplitude)); frequency.mulAssign(lacunarity); amplitude.mulAssign(gain); });
    return sum;
  });
  // deno-lint-ignore no-explicit-any
  const localize = T.Fn(([position]: [any]) => inverseModel.mul(T.vec4(position, 1)).xyz);
  // deno-lint-ignore no-explicit-any
  const sampleDensity = T.Fn(([point]: [any]) => {
    const radius = T.sqrt(T.dot(point.xz, point.xz)), st = T.vec2(radius, point.y).toVar("liminaFireDensityUv");
    const animated = T.vec3(point).toVar("liminaFireAnimatedPoint");
    animated.y.subAssign(seed.add(authorityTime).mul(noiseScale.w));
    animated.assign(animated.mul(noiseScale.xyz));
    st.y.addAssign(T.sqrt(T.max(st.y, 0)).mul(magnitude).mul(turbulence(animated)));
    const outside = st.x.lessThanEqual(0).or(st.x.greaterThanEqual(1)).or(st.y.lessThanEqual(0)).or(st.y.greaterThanEqual(1));
    return T.select(outside, T.float(0), T.texture(densityTexture, st).x);
  });
  const fragmentNode = T.Fn(() => {
    const rayPosition = T.vec3(T.positionWorld).toVar("liminaFireRayPosition");
    const rayDirection = T.normalize(rayPosition.sub(T.cameraPosition)).toVar("liminaFireRayDirection");
    const rayLength = T.float(.0288).mul(T.length(worldScale));
    const accumulated = T.float(0).toVar("liminaFireAccumulatedDensity");
    T.Loop(iterations, () => {
      rayPosition.addAssign(rayDirection.mul(rayLength));
      const local = localize(rayPosition).toVar("liminaFireLocalPosition");
      local.y.addAssign(.5); local.x.mulAssign(2); local.z.mulAssign(2);
      const density = sampleDensity(local).mul(authorityEnvelope).mul(.065);
      accumulated.addAssign(T.oneMinus(T.min(accumulated, 1)).mul(density));
    });
    const density = T.clamp(accumulated, 0, 1), hot = T.smoothstep(.18, .55, density);
    const outer = T.vec3(.42, .002, 0), middle = T.vec3(1, .12, .003), core = T.vec3(1.45, .72, .06);
    const color = T.mix(T.mix(outer, middle, T.smoothstep(.07, .38, density)), core, hot);
    const alpha = T.smoothstep(.035, .56, density).mul(.86);
    return T.vec4(color.mul(authorityEnvelope), alpha.mul(authorityEnvelope));
  })();

  // THREE.Fire's ray direction runs from the camera-facing proxy surface into the box.
  // FrontSide is therefore part of the sampling contract: BackSide starts at the far face
  // and marches out of the volume, which visibly collapses the effect into a tinted plane.
  const material = new THREE.MeshBasicNodeMaterial({ transparent: true, depthTest: true, depthWrite: false,
    side: THREE.FrontSide, blending: THREE.NormalBlending });
  material.fragmentNode = fragmentNode; material.toneMapped = true;
  material.userData.liminaFireMaterial = "three-fire-derived-volumetric/v1";
  material.userData.liminaAuthoritativeTimeOnly = true;
  material.userData.liminaDepthOcclusion = "depth-test-on-depth-write-off";
  material.userData.liminaRayEntrySurface = "camera-facing-front-face";
  Object.defineProperty(material.userData, "liminaOwnedDensityTexture", { value: densityTexture, enumerable: false });
  const mesh = new THREE.Mesh(geometry, material); mesh.name = `limina:${contract.id}`;
  mesh.position.set(input.socketPosition[0] + offset[0], input.socketPosition[1] + offset[1], input.socketPosition[2] + offset[2]);
  mesh.frustumCulled = false; mesh.castShadow = false; mesh.receiveShadow = false; mesh.renderOrder = 20;
  mesh.userData.liminaSemanticId = contract.id; mesh.userData.liminaVolumetricRaymarch = true;
  mesh.userData.liminaAuthoritativeTimeSeconds = 0; mesh.userData.liminaAuthoritativeEnvelope = 0;
  mesh.updateMatrixWorld(true); inverseModel.value.copy(mesh.matrixWorld).invert();

  let disposed = false;
  return {
    mesh, geometry, material, densityTexture, triangles: 12,
    fragmentWorkPerCoveredPixel: iterations * octaves,
    get disposed() { return disposed; },
    update(timeSeconds, envelope) {
      if (disposed) throw new Error("disposed building fire volume cannot update");
      authorityTime.value = finite(timeSeconds, 0, Number.MAX_SAFE_INTEGER, "fire volume authority time");
      authorityEnvelope.value = finite(envelope, 0, 1, "fire volume authority envelope");
      mesh.userData.liminaAuthoritativeTimeSeconds = timeSeconds; mesh.userData.liminaAuthoritativeEnvelope = envelope;
      mesh.updateMatrixWorld(true); inverseModel.value.copy(mesh.matrixWorld).invert();
    },
    dispose() {
      if (disposed) return; disposed = true; geometry.dispose(); material.dispose(); densityTexture.dispose();
    },
  };
}
