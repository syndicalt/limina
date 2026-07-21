import * as THREE from "../../build/three.bundle.mjs";
import type { SelectedTreeInstance } from "./tree-population-plan.ts";

// TSL is a dynamic fluent graph API under the WebGPU bundle.
// deno-lint-ignore no-explicit-any
const T = (THREE as any).TSL;

export const TREE_IMPOSTOR_CENTER_SCALE_ATTRIBUTE = "liminaTreeCenterScale";
export const TREE_IMPOSTOR_YAW_ATTRIBUTE = "liminaTreeYaw";

export interface TreeImpostorMaterialOptions {
  readonly albedo: THREE.Texture;
  readonly normalDepth: THREE.Texture;
  readonly grid: number;
  readonly cellSize: number;
  readonly alphaCutoff: number;
  readonly parallaxStrength?: number;
  readonly roughness?: number;
}

export interface TreeImpostorGeometry extends THREE.BufferGeometry {
  getAttribute(name: typeof TREE_IMPOSTOR_CENTER_SCALE_ATTRIBUTE): THREE.InstancedBufferAttribute;
  getAttribute(name: typeof TREE_IMPOSTOR_YAW_ATTRIBUTE): THREE.InstancedBufferAttribute;
}

export function encodeTreeImpostorDirection(direction: Readonly<{ x: number; y: number; z: number }>): Readonly<{ u: number; v: number }> {
  const values = [direction.x, direction.y, direction.z];
  if (values.some((value) => !Number.isFinite(value))) throw new RangeError("tree impostor direction must be finite");
  const length = Math.abs(direction.x) + Math.max(direction.y, 0) + Math.abs(direction.z);
  if (length === 0) throw new RangeError("tree impostor direction must be non-zero");
  const x = direction.x / length, z = direction.z / length;
  return Object.freeze({ u: Math.max(0, Math.min(1, (x + z + 1) * 0.5)), v: Math.max(0, Math.min(1, (x - z + 1) * 0.5)) });
}

export function planTreeImpostorFrames(direction: Readonly<{ x: number; y: number; z: number }>, grid: number): readonly Readonly<{ column: number; row: number; weight: number }>[] {
  if (!Number.isSafeInteger(grid) || grid < 2 || grid > 16) throw new RangeError("tree impostor frame grid must be an integer in [2, 16]");
  const uv = encodeTreeImpostorDirection(direction), px = uv.u * grid - 0.5, py = uv.v * grid - 0.5;
  const x0 = Math.floor(px), y0 = Math.floor(py), fx = px - x0, fy = py - y0;
  const clamp = (value: number) => Math.max(0, Math.min(grid - 1, value));
  return Object.freeze([
    Object.freeze({ column: clamp(x0), row: clamp(y0), weight: (1 - fx) * (1 - fy) }),
    Object.freeze({ column: clamp(x0 + 1), row: clamp(y0), weight: fx * (1 - fy) }),
    Object.freeze({ column: clamp(x0), row: clamp(y0 + 1), weight: (1 - fx) * fy }),
    Object.freeze({ column: clamp(x0 + 1), row: clamp(y0 + 1), weight: fx * fy }),
  ]);
}

function finiteRange(value: number, min: number, max: number, label: string): number {
  if (!Number.isFinite(value) || value < min || value > max) throw new RangeError(`${label} must be finite in [${min}, ${max}]`);
  return value;
}

export function buildTreeImpostorGeometry(source: THREE.BufferGeometry, capacity: number): TreeImpostorGeometry {
  if (!Number.isSafeInteger(capacity) || capacity <= 0) throw new RangeError("tree impostor capacity must be a positive safe integer");
  if (source.getAttribute("position") === undefined || source.getAttribute("uv") === undefined) throw new RangeError("tree impostor source geometry requires position and uv attributes");
  const geometry = source.clone() as TreeImpostorGeometry;
  geometry.setAttribute(TREE_IMPOSTOR_CENTER_SCALE_ATTRIBUTE,
    new THREE.InstancedBufferAttribute(new Float32Array(capacity * 4), 4).setUsage(THREE.DynamicDrawUsage));
  geometry.setAttribute(TREE_IMPOSTOR_YAW_ATTRIBUTE,
    new THREE.InstancedBufferAttribute(new Float32Array(capacity), 1).setUsage(THREE.DynamicDrawUsage));
  return geometry;
}

export function writeTreeImpostorInstance(
  geometry: TreeImpostorGeometry,
  index: number,
  tree: SelectedTreeInstance,
  anchorX: number,
  anchorZ: number,
): void {
  const centerScale = geometry.getAttribute(TREE_IMPOSTOR_CENTER_SCALE_ATTRIBUTE), yaw = geometry.getAttribute(TREE_IMPOSTOR_YAW_ATTRIBUTE);
  if (!Number.isSafeInteger(index) || index < 0 || index >= centerScale.count || index >= yaw.count) throw new RangeError("tree impostor instance index is out of range");
  centerScale.setXYZW(index, tree.x - anchorX, tree.y, tree.z - anchorZ, tree.scale);
  yaw.setX(index, tree.yaw);
}

export function markTreeImpostorAttributesUpdated(geometry: TreeImpostorGeometry): void {
  geometry.getAttribute(TREE_IMPOSTOR_CENTER_SCALE_ATTRIBUTE).needsUpdate = true;
  geometry.getAttribute(TREE_IMPOSTOR_YAW_ATTRIBUTE).needsUpdate = true;
}

/** Pure-TSL lit impostor: cylindrical billboard, bijective hemi-octa selection, four-frame
 * premultiplied blend, per-frame normal reconstruction, and bounded depth parallax. */
export function buildTreeImpostorMaterial(options: TreeImpostorMaterialOptions): THREE.MeshStandardNodeMaterial {
  if (!(options.albedo instanceof THREE.Texture) || !(options.normalDepth instanceof THREE.Texture)) throw new TypeError("tree impostor requires albedo and normal-depth textures");
  if (!Number.isSafeInteger(options.grid) || options.grid < 2 || options.grid > 16) throw new RangeError("tree impostor grid must be an integer in [2, 16]");
  if (!Number.isSafeInteger(options.cellSize) || options.cellSize < 32 || options.cellSize > 512) throw new RangeError("tree impostor cellSize must be an integer in [32, 512]");
  const alphaCutoff = finiteRange(options.alphaCutoff, 0.01, 0.99, "tree impostor alphaCutoff");
  const parallaxStrength = finiteRange(options.parallaxStrength ?? 0.035, 0, 0.15, "tree impostor parallaxStrength");
  const roughness = finiteRange(options.roughness ?? 0.82, 0, 1, "tree impostor roughness");
  options.albedo.colorSpace = THREE.SRGBColorSpace;
  options.normalDepth.colorSpace = THREE.NoColorSpace;
  options.albedo.wrapS = options.albedo.wrapT = options.normalDepth.wrapS = options.normalDepth.wrapT = THREE.ClampToEdgeWrapping;
  // Per-cell atlases have no dilation gutters yet; disabling mips prevents cross-cell bleed.
  for (const texture of [options.albedo, options.normalDepth]) {
    texture.generateMipmaps = false; texture.minFilter = THREE.LinearFilter; texture.magFilter = THREE.LinearFilter;
  }

  const material = new THREE.MeshStandardNodeMaterial({ roughness, metalness: 0, alphaTest: alphaCutoff,
    side: THREE.DoubleSide, transparent: false, depthWrite: true });
  material.name = "limina-tree-impostor-tsl";
  const centerScale = T.attribute(TREE_IMPOSTOR_CENTER_SCALE_ATTRIBUTE, "vec4");
  const yaw = T.attribute(TREE_IMPOSTOR_YAW_ATTRIBUTE, "float");
  const center = centerScale.xyz;
  const cameraObject = T.modelWorldMatrixInverse.mul(T.vec4(T.cameraPosition, 1)).xyz;
  const toCamera = cameraObject.sub(center);
  const horizontal = T.vec3(toCamera.x, 0, toCamera.z);
  const horizontalLength = horizontal.length();
  const ordinaryForward = horizontal.div(T.max(horizontalLength, 1e-6));
  const cameraRightObject = T.modelWorldMatrixInverse.mul(T.vec4(T.cameraWorldMatrix[0].xyz, 0)).xyz.normalize();
  const fallbackForward = T.vec3(cameraRightObject.z.negate(), 0, cameraRightObject.x).normalize();
  const forward = horizontalLength.greaterThan(1e-5).select(ordinaryForward, fallbackForward);
  const right = T.vec3(forward.z, 0, forward.x.negate());
  const raw = T.positionGeometry;
  material.positionNode = center.add(right.mul(raw.x.mul(centerScale.w))).add(T.vec3(0, raw.y.mul(centerScale.w), 0)).add(forward.mul(raw.z.mul(centerScale.w)));

  // Actual view in tree-local yaw space, then the exact inverse of the v2 rotated-diamond decode.
  const viewObject = toCamera.normalize();
  const cy = yaw.cos(), sy = yaw.sin();
  const viewLocal = T.vec3(cy.mul(viewObject.x).sub(sy.mul(viewObject.z)), T.max(viewObject.y, 0),
    sy.mul(viewObject.x).add(cy.mul(viewObject.z))).normalize();
  const l1 = viewLocal.x.abs().add(viewLocal.y).add(viewLocal.z.abs()).max(1e-6);
  const a = viewLocal.x.div(l1), b = viewLocal.z.div(l1);
  const directionUv = T.vec2(a.add(b).add(1).mul(0.5), a.sub(b).add(1).mul(0.5)).clamp(0, 1);
  const grid = T.float(options.grid), cellSize = T.float(options.cellSize), atlasSize = T.float(options.grid * options.cellSize);
  const frame = directionUv.mul(grid).sub(0.5);
  const base = frame.floor(), blend = frame.fract();
  const x0 = base.x.clamp(0, options.grid - 1), y0 = base.y.clamp(0, options.grid - 1);
  const x1 = base.x.add(1).clamp(0, options.grid - 1), y1 = base.y.add(1).clamp(0, options.grid - 1);
  const weights = [blend.x.oneMinus().mul(blend.y.oneMinus()), blend.x.mul(blend.y.oneMinus()),
    blend.x.oneMinus().mul(blend.y), blend.x.mul(blend.y)];
  const cells = [[x0, y0], [x1, y0], [x0, y1], [x1, y1]] as const;
  const localUv = T.uv();

  const decodeDirection = (cellX: any, cellY: any) => {
    const qx = cellX.add(0.5).div(grid).mul(2).sub(1), qy = cellY.add(0.5).div(grid).mul(2).sub(1);
    const dx = qx.add(qy).mul(0.5), dz = qx.sub(qy).mul(0.5);
    const dy = T.max(T.float(1).sub(dx.abs()).sub(dz.abs()), 0);
    return T.vec3(dx, dy, dz).normalize();
  };
  const basis = (direction: any) => {
    const cross = T.vec3(0, 1, 0).cross(direction), length = cross.length();
    const frameRight = length.greaterThan(1e-5).select(cross.div(T.max(length, 1e-6)), T.vec3(1, 0, 0));
    return { right: frameRight, up: direction.cross(frameRight).normalize() };
  };
  const atlasUv = (cellX: any, cellY: any, offset: any) => {
    const inset = T.float(0.5), usable = cellSize.sub(1);
    const sample = localUv.add(offset).clamp(inset.div(cellSize), T.float(1).sub(inset.div(cellSize)));
    const pixelX = cellX.mul(cellSize).add(inset).add(sample.x.mul(usable));
    // Sharp packs row zero at the PNG top; GLTF textures use unflipped image data.
    const pixelY = cellY.mul(cellSize).add(inset).add(sample.y.oneMinus().mul(usable));
    return T.vec2(pixelX.div(atlasSize), T.float(1).sub(pixelY.div(atlasSize)));
  };
  const samples = cells.map(([cellX, cellY]) => {
    const direction = decodeDirection(cellX, cellY), frameBasis = basis(direction);
    const delta = viewLocal.sub(direction);
    const preliminaryUv = atlasUv(cellX, cellY, T.vec2(0));
    const preliminaryDepth = T.texture(options.normalDepth, preliminaryUv).b.sub(0.5);
    const offset = T.vec2(delta.dot(frameBasis.right), delta.dot(frameBasis.up)).mul(preliminaryDepth).mul(parallaxStrength);
    const uv = atlasUv(cellX, cellY, offset);
    const albedo = T.texture(options.albedo, uv), normalDepth = T.texture(options.normalDepth, uv);
    const normalXy = normalDepth.rg.mul(2).sub(1);
    const normalZ = T.max(T.float(1).sub(normalXy.dot(normalXy)), 0).sqrt();
    const normalTree = frameBasis.right.mul(normalXy.x).add(frameBasis.up.mul(normalXy.y)).add(direction.mul(normalZ)).normalize();
    // Rotate baked tree-local normal by authored instance yaw into batch-root object space.
    const normalObject = T.vec3(cy.mul(normalTree.x).add(sy.mul(normalTree.z)), normalTree.y,
      sy.negate().mul(normalTree.x).add(cy.mul(normalTree.z))).normalize();
    return { albedo, normal: normalObject };
  });
  let alpha = T.float(0), premultiplied = T.vec3(0), normal = T.vec3(0);
  for (let index = 0; index < 4; index++) {
    const weightedAlpha = samples[index]!.albedo.a.mul(weights[index]!);
    alpha = alpha.add(weightedAlpha);
    premultiplied = premultiplied.add(samples[index]!.albedo.rgb.mul(weightedAlpha));
    normal = normal.add(samples[index]!.normal.mul(weightedAlpha));
  }
  material.colorNode = premultiplied.div(T.max(alpha, 1e-5));
  material.opacityNode = alpha;
  material.normalNode = T.transformNormalToView(normal.normalize());
  material.userData.liminaTreeImpostor = Object.freeze({ schema: "limina.tree-impostor-runtime/1", pureTsl: true,
    projection: "upper-hemi-octa-rotated-diamond", blend: "four-frame-premultiplied", normal: "per-frame-decode-rotate-normalize",
    depthParallax: parallaxStrength, mipPolicy: "disabled-until-cell-gutters" });
  return material;
}
