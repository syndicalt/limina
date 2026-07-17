import * as THREE from "../../build/three.bundle.mjs";
// TSL's fluent node API is exported dynamically under the WebGPU bundle namespace.
// deno-lint-ignore no-explicit-any
const T = (THREE as any).TSL;

export interface TreeFoliageMaterialOptions {
  readonly alphaCutoff?: number;
  readonly sssStrength?: number;
  readonly sunDirection?: Readonly<{ x: number; y: number; z: number }>;
  readonly sunColor?: THREE.ColorRepresentation;
}

type StandardLike = THREE.MeshStandardMaterial & Partial<THREE.MeshStandardNodeMaterial>;

function finiteRange(value: number, min: number, max: number, label: string): number {
  if (!Number.isFinite(value) || value < min || value > max) throw new RangeError(`${label} must be finite in [${min}, ${max}]`);
  return value;
}

function configureTextureColorSpaces(source: StandardLike): void {
  if (source.map !== null) source.map.colorSpace = THREE.SRGBColorSpace;
  if (source.emissiveMap !== null) source.emissiveMap.colorSpace = THREE.SRGBColorSpace;
  for (const texture of [source.alphaMap, source.aoMap, source.bumpMap, source.displacementMap, source.metalnessMap, source.normalMap, source.roughnessMap]) {
    if (texture !== null) texture.colorSpace = THREE.NoColorSpace;
  }
}

/** Convert a glTF foliage material into one shared pure-TSL graph while retaining every host-owned
 * PBR texture. Alpha cutout avoids transparent sorting; warm emissive backscatter follows the
 * already-proven grass model and compiles through both WebGPU and forceWebGL. */
export function buildTreeFoliageMaterial(source: StandardLike, options: TreeFoliageMaterialOptions = {}): THREE.MeshStandardNodeMaterial {
  if (source === null || source.isMeshStandardMaterial !== true) throw new TypeError("tree foliage source must be MeshStandardMaterial-compatible");
  const alphaCutoff = finiteRange(options.alphaCutoff ?? Math.max(source.alphaTest || 0, 0.45), 0.01, 0.99, "tree foliage alphaCutoff");
  const sssStrength = finiteRange(options.sssStrength ?? 0.24, 0, 2, "tree foliage sssStrength");
  const sun = new THREE.Vector3(options.sunDirection?.x ?? 0.42, options.sunDirection?.y ?? 0.78, options.sunDirection?.z ?? 0.46);
  if (sun.lengthSq() === 0 || !Number.isFinite(sun.lengthSq())) throw new RangeError("tree foliage sunDirection must be finite and non-zero");
  sun.normalize();
  const sunColor = new THREE.Color(options.sunColor ?? 0xffd8a0);
  configureTextureColorSpaces(source);
  const material = new THREE.MeshStandardNodeMaterial({
    color: source.color.clone(), roughness: source.roughness, metalness: source.metalness,
    map: source.map, lightMap: source.lightMap, lightMapIntensity: source.lightMapIntensity,
    aoMap: source.aoMap, aoMapIntensity: source.aoMapIntensity,
    emissive: source.emissive.clone(), emissiveIntensity: source.emissiveIntensity, emissiveMap: source.emissiveMap,
    bumpMap: source.bumpMap, bumpScale: source.bumpScale, normalMap: source.normalMap,
    normalMapType: source.normalMapType, normalScale: source.normalScale.clone(),
    displacementMap: source.displacementMap, displacementScale: source.displacementScale, displacementBias: source.displacementBias,
    roughnessMap: source.roughnessMap, metalnessMap: source.metalnessMap, alphaMap: source.alphaMap,
    envMap: source.envMap, envMapIntensity: source.envMapIntensity,
    alphaTest: alphaCutoff, side: THREE.DoubleSide, transparent: false, opacity: source.opacity,
    depthTest: source.depthTest, depthWrite: true, colorWrite: source.colorWrite,
    polygonOffset: source.polygonOffset, polygonOffsetFactor: source.polygonOffsetFactor, polygonOffsetUnits: source.polygonOffsetUnits,
    fog: source.fog, flatShading: source.flatShading, vertexColors: source.vertexColors,
  });
  material.name = `${source.name || "foliage"}:limina-backlit`;
  const sourceNodes = source as unknown as {
    colorNode?: unknown; normalNode?: unknown; roughnessNode?: unknown; metalnessNode?: unknown;
    aoNode?: unknown; emissiveNode?: unknown; opacityNode?: unknown;
  };
  if (sourceNodes.colorNode) material.colorNode = sourceNodes.colorNode as never;
  if (sourceNodes.normalNode) material.normalNode = sourceNodes.normalNode as never;
  if (sourceNodes.roughnessNode) material.roughnessNode = sourceNodes.roughnessNode as never;
  if (sourceNodes.metalnessNode) material.metalnessNode = sourceNodes.metalnessNode as never;
  if (sourceNodes.aoNode) material.aoNode = sourceNodes.aoNode as never;
  if (sourceNodes.opacityNode) material.opacityNode = sourceNodes.opacityNode as never;
  const baseColor = sourceNodes.colorNode ? sourceNodes.colorNode as never : T.materialColor.rgb;
  const existingEmissive = sourceNodes.emissiveNode ? sourceNodes.emissiveNode as never : T.materialEmissive;
  const view = T.cameraPosition.sub(T.positionWorld).normalize();
  const sunNode = T.uniform(sun);
  const sunColorNode = T.uniform(sunColor);
  const strengthNode = T.uniform(sssStrength);
  const throughView = T.max(view.negate().dot(sunNode), 0).pow(3);
  const leafBack = T.max(T.normalWorld.dot(sunNode).negate(), 0).mul(0.65).add(0.35);
  material.emissiveNode = T.vec3(existingEmissive).add(T.vec3(baseColor).mul(sunColorNode).mul(throughView).mul(leafBack).mul(strengthNode));
  const userData = { ...source.userData } as Record<string, unknown>;
  delete userData.liminaLifetime;
  material.userData = { ...userData, liminaTreeFoliage: Object.freeze({ graph: "pure-tsl-backscatter/1", alphaCutoff,
    sssStrength, sunDirection: Object.freeze(sun.toArray()), sunColor: sunColor.getHex() }) };
  return material;
}
