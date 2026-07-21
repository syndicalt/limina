import * as THREE from "../../build/three.bundle.mjs";
import { GRASS_FIELD_MAX_RESIDENT_SLOTS, grassFieldCandidate, type GrassFieldPlan } from "./grass-field-plan.ts";

// deno-lint-ignore no-explicit-any
const T = (THREE as any).TSL;

interface ComputeRenderer {
  backend?: { isWebGPUBackend?: boolean; isWebGLBackend?: boolean };
  hasInitialized?: () => boolean;
  computeAsync(node: unknown): Promise<void>;
}

export interface GrassFieldComputeResource {
  readonly slots: number;
  readonly kernel: unknown;
  readonly rootsYaw: unknown;
  readonly scales: unknown;
  /** Vertex-stage attributes backed by the same GPU-written storage buffers. */
  readonly rootYawAttribute: unknown;
  readonly scaleAttribute: unknown;
  readonly densityTexture: THREE.DataTexture;
  readonly heightTexture: THREE.DataTexture;
  /** Dispatch exactly once per caller-selected rebuild; never reads results back to the CPU. */
  dispatch(): Promise<void>;
  dispose(): void;
}

export interface GrassFieldComputeInput {
  renderer: ComputeRenderer;
  plan: GrassFieldPlan;
  /** Candidate-order terrain height, one finite float per fixed slot. */
  heights: Float32Array;
  /** Base size range encoded by the compute transform stream. */
  sizeRange?: readonly [number, number];
  /** CPU-authored feature origin subtracted before storage publication. */
  featureOrigin?: readonly [number, number, number];
  /** Test seam; production always uses the pinned Three TSL namespace. */
  // deno-lint-ignore no-explicit-any
  nodeApi?: any;
}

export interface GrassFieldComputeBatchPage {
  readonly plan: GrassFieldPlan;
  readonly heights: Float32Array;
}

export interface GrassFieldComputeBatchInput {
  readonly renderer: ComputeRenderer;
  readonly pages: readonly GrassFieldComputeBatchPage[];
  readonly sizeRange?: readonly [number, number];
  /** One terrain-tile origin shared by every page in the batch. */
  readonly featureOrigin: readonly [number, number, number];
  // deno-lint-ignore no-explicit-any
  readonly nodeApi?: any;
}

export interface GrassFieldComputeBatchResource {
  readonly slots: number;
  readonly pages: number;
  readonly kernels: readonly unknown[];
  readonly rootYawAttribute: unknown;
  readonly scaleAttribute: unknown;
  dispatch(): Promise<void>;
  dispose(): void;
}

export function isNativeGrassFieldComputeRenderer(renderer: ComputeRenderer): boolean {
  return renderer.hasInitialized?.() === true
    && renderer.backend?.isWebGPUBackend === true
    && renderer.backend?.isWebGLBackend !== true;
}

/** CPU oracle for the precision-preserving storage coordinate contract. */
export function grassFieldFeatureLocalCandidate(
  plan: GrassFieldPlan,
  slot: number,
  featureOrigin: readonly [number, number, number],
): Readonly<{ x: number; z: number }> {
  const candidate = grassFieldCandidate(plan, slot);
  return Object.freeze({ x: candidate.x - featureOrigin[0], z: candidate.z - featureOrigin[2] });
}

/**
 * Construct the native-WebGPU fixed-slot compute resources. Downstream rendering must use an
 * InstancedMesh whose ordinary instance matrices are identity: root/yaw and scale come from the
 * returned storage-backed attributes. A rejected slot has scale exactly zero; no matrix is ever
 * zeroed, keeping Three's instance-normal transform finite.
 */
export function buildGrassFieldCompute(input: GrassFieldComputeInput): GrassFieldComputeResource {
  // Load-bearing: fail before creating textures, storage nodes, or a compute node. navigator.gpu
  // is not sufficient because WebGPURenderer(forceWebGL) can coexist with it.
  if (!isNativeGrassFieldComputeRenderer(input.renderer)) throw new Error("grass field compute requires an initialized native WebGPU backend");
  const N = input.nodeApi ?? T;
  const { plan } = input;
  if (Object.getPrototypeOf(input.heights) !== Float32Array.prototype || input.heights.length !== plan.slots) {
    throw new RangeError(`grass field heights must be a Float32Array of length ${plan.slots}`);
  }
  for (let i = 0; i < input.heights.length; i++) if (!Number.isFinite(input.heights[i])) throw new RangeError("grass field height must be finite");
  const [sizeLo, sizeHi] = input.sizeRange ?? [0.7, 1.3];
  if (!Number.isFinite(sizeLo) || !Number.isFinite(sizeHi) || sizeLo < 0 || sizeHi < sizeLo) throw new RangeError("grass field sizeRange is invalid");
  const [originX, originY, originZ] = input.featureOrigin ?? [0, 0, 0];
  if (![originX, originY, originZ].every(Number.isFinite)) throw new RangeError("grass field featureOrigin must be finite");
  // Form local coordinates from small integer grid deltas + a CPU-computed phase. Never construct
  // gx*spacing at million-scale in f32 and subtract afterward; that destroys sub-metre jitter.
  const originGridX = Math.floor(originX / plan.spacing);
  const originGridZ = Math.floor(originZ / plan.spacing);
  const originPhaseX = originGridX * plan.spacing - originX;
  const originPhaseZ = originGridZ * plan.spacing - originZ;
  const localBounds = {
    minX: plan.bounds.minX - originX, maxX: plan.bounds.maxX - originX,
    minZ: plan.bounds.minZ - originZ, maxZ: plan.bounds.maxZ - originZ,
  };

  // Canonical CPU identity remains Uint16. r184 WebGPU rejects RedInteger+UnsignedShort, so the
  // upload adapter expands to R32Uint without mutating the plan's bytes.
  const densityUpload = Uint32Array.from(plan.density);
  const densityTexture = new THREE.DataTexture(densityUpload, plan.slots, 1, THREE.RedIntegerFormat, THREE.UnsignedIntType);
  densityTexture.minFilter = THREE.NearestFilter; densityTexture.magFilter = THREE.NearestFilter;
  densityTexture.generateMipmaps = false; densityTexture.needsUpdate = true;
  const localHeights = new Float32Array(plan.slots);
  for (let index = 0; index < plan.slots; index++) localHeights[index] = input.heights[index] - originY;
  const heightTexture = new THREE.DataTexture(localHeights, plan.slots, 1, THREE.RedFormat, THREE.FloatType);
  heightTexture.minFilter = THREE.NearestFilter; heightTexture.magFilter = THREE.NearestFilter;
  heightTexture.generateMipmaps = false; heightTexture.needsUpdate = true;

  const rootsYaw = N.instancedArray(plan.slots, "vec4").setName("liminaGrassRootYaw");
  const scales = N.instancedArray(plan.slots, "float").setName("liminaGrassScale");
  const rootYawAttribute = rootsYaw.toAttribute();
  const scaleAttribute = scales.toAttribute();

  const pcg = (value: unknown) => {
    // deno-lint-ignore no-explicit-any
    const v = value as any;
    const state = v.toUint().mul(747796405).add(2891336453);
    const word = state.shiftRight(state.shiftRight(28).add(4)).bitXor(state).mul(277803737);
    return word.shiftRight(22).bitXor(word);
  };
  const random = (gx: unknown, gz: unknown, stream: number) => {
    // deno-lint-ignore no-explicit-any
    const x = gx as any, z = gz as any;
    let mixed = N.uint(plan.seed);
    mixed = mixed.bitXor(x.toUint().mul(N.uint(0x9e3779b1)));
    mixed = mixed.bitXor(z.toUint().mul(N.uint(0x85ebca77)));
    mixed = mixed.bitXor(N.uint(stream).mul(N.uint(0xc2b2ae3d)));
    return pcg(mixed);
  };

  const kernel = N.Fn(() => {
    const index = N.instanceIndex;
    const gx = N.int(index.mod(N.uint(plan.columns))).add(plan.minGridX);
    const gz = N.int(index.div(N.uint(plan.columns))).add(plan.minGridZ);
    const texel = N.ivec2(N.int(index), 0);
    const density = N.textureLoad(densityTexture, texel).r.toUint();
    const draw = random(gx, gz, 0).bitAnd(N.uint(0xffff));
    const accepted = density.equal(N.uint(0xffff)).or(draw.lessThan(density));
    const jitter = random(gx, gz, 1);
    const style = random(gx, gz, 2);
    const jx = jitter.bitAnd(N.uint(0xffff)).toFloat().div(65536).sub(0.5).mul(plan.spacing);
    const jz = jitter.shiftRight(N.uint(16)).toFloat().div(65536).sub(0.5).mul(plan.spacing);
    const x = gx.sub(originGridX).toFloat().add(0.5).mul(plan.spacing).add(originPhaseX).add(jx);
    const z = gz.sub(originGridZ).toFloat().add(0.5).mul(plan.spacing).add(originPhaseZ).add(jz);
    const inside = x.greaterThanEqual(localBounds.minX).and(x.lessThan(localBounds.maxX))
      .and(z.greaterThanEqual(localBounds.minZ)).and(z.lessThan(localBounds.maxZ));
    const y = N.textureLoad(heightTexture, texel).r;
    const yaw = style.bitAnd(N.uint(0xffff)).toFloat().mul(Math.PI * 2 / 65536);
    const authoredScale = N.float(sizeLo).add(style.shiftRight(N.uint(16)).toFloat().div(65536).mul(sizeHi - sizeLo));
    rootsYaw.element(index).assign(N.vec4(x, y, z, yaw));
    scales.element(index).assign(N.select(accepted.and(inside), authoredScale, N.float(0)));
  })().compute(plan.slots, [64]);

  let disposed = false;
  return Object.freeze({
    slots: plan.slots, kernel, rootsYaw, scales, rootYawAttribute, scaleAttribute,
    densityTexture, heightTexture,
    dispatch: () => disposed
      ? Promise.reject(new Error("grass field compute resource is disposed"))
      : input.renderer.computeAsync(kernel),
    dispose: () => {
      if (disposed) return;
      disposed = true;
      (kernel as { dispose?: () => void }).dispose?.();
      densityTexture.dispose();
      heightTexture.dispose();
      // BufferAttribute.dispose is the public WebGPURenderer release signal. Geometry disposal
      // removes render-object bindings later; it does not itself dispatch attribute disposal.
      (rootsYaw.value as { dispose?: () => void }).dispose?.();
      (scales.value as { dispose?: () => void }).dispose?.();
    },
  });
}

/**
 * Native streamed variant: canonical pages remain the CPU planning/ownership unit, while one
 * concatenated upload and one kernel write a terrain tile's shared storage. This keeps both
 * compute and render pipeline counts at one per resident terrain tile.
 */
export function buildGrassFieldComputeBatch(input: GrassFieldComputeBatchInput): GrassFieldComputeBatchResource {
  if (!isNativeGrassFieldComputeRenderer(input.renderer)) throw new Error("grass field compute batch requires an initialized native WebGPU backend");
  if (input.pages.length < 1) throw new RangeError("grass field compute batch requires at least one page");
  const N = input.nodeApi ?? T;
  const [sizeLo, sizeHi] = input.sizeRange ?? [0.7, 1.3];
  if (!Number.isFinite(sizeLo) || !Number.isFinite(sizeHi) || sizeLo < 0 || sizeHi < sizeLo) throw new RangeError("grass field batch sizeRange is invalid");
  const [originX, originY, originZ] = input.featureOrigin;
  if (![originX, originY, originZ].every(Number.isFinite)) throw new RangeError("grass field batch featureOrigin must be finite");
  const spacing = input.pages[0].plan.spacing, seed = input.pages[0].plan.seed;
  let slots = 0;
  for (const page of input.pages) {
    if (page.plan.spacing !== spacing || page.plan.seed !== seed) throw new RangeError("grass field batch pages must share spacing and seed");
    if (Object.getPrototypeOf(page.heights) !== Float32Array.prototype || page.heights.length !== page.plan.slots) {
      throw new RangeError(`grass field batch heights must be a Float32Array of length ${page.plan.slots}`);
    }
    for (const height of page.heights) if (!Number.isFinite(height)) throw new RangeError("grass field batch height must be finite");
    slots += page.plan.slots;
  }
  if (!Number.isSafeInteger(slots) || slots < 1 || slots > GRASS_FIELD_MAX_RESIDENT_SLOTS) {
    throw new RangeError(`grass field batch slots must be in [1, ${GRASS_FIELD_MAX_RESIDENT_SLOTS}]`);
  }
  const uploadWidth = Math.min(4096, slots), uploadHeight = Math.ceil(slots / uploadWidth);
  const coordinates = new Int32Array(uploadWidth * uploadHeight * 4);
  const density = new Uint32Array(uploadWidth * uploadHeight);
  const heights = new Float32Array(uploadWidth * uploadHeight);
  let cursor = 0;
  for (const page of input.pages) for (let slot = 0; slot < page.plan.slots; slot++, cursor++) {
    coordinates[cursor * 4] = page.plan.gridCoordinates[slot * 2];
    coordinates[cursor * 4 + 1] = page.plan.gridCoordinates[slot * 2 + 1];
    density[cursor] = grassFieldCandidate(page.plan, slot).inside ? page.plan.density[slot] : 0;
    heights[cursor] = page.heights[slot] - originY;
  }
  const coordinateTexture = new THREE.DataTexture(coordinates, uploadWidth, uploadHeight, THREE.RGBAIntegerFormat, THREE.IntType);
  const densityTexture = new THREE.DataTexture(density, uploadWidth, uploadHeight, THREE.RedIntegerFormat, THREE.UnsignedIntType);
  const heightTexture = new THREE.DataTexture(heights, uploadWidth, uploadHeight, THREE.RedFormat, THREE.FloatType);
  for (const texture of [coordinateTexture, densityTexture, heightTexture]) {
    texture.minFilter = THREE.NearestFilter; texture.magFilter = THREE.NearestFilter; texture.generateMipmaps = false; texture.needsUpdate = true;
  }
  const rootsYaw = N.instancedArray(slots, "vec4").setName("liminaGrassBatchRootYaw");
  const scales = N.instancedArray(slots, "float").setName("liminaGrassBatchScale");
  const rootYawAttribute = rootsYaw.toAttribute(), scaleAttribute = scales.toAttribute();
  const originGridX = Math.floor(originX / spacing), originGridZ = Math.floor(originZ / spacing);
  const originPhaseX = originGridX * spacing - originX, originPhaseZ = originGridZ * spacing - originZ;
  const pcg = (value: unknown) => {
    // deno-lint-ignore no-explicit-any
    const v = value as any;
    const state = v.toUint().mul(747796405).add(2891336453);
    const word = state.shiftRight(state.shiftRight(28).add(4)).bitXor(state).mul(277803737);
    return word.shiftRight(22).bitXor(word);
  };
  const random = (gx: unknown, gz: unknown, stream: number) => {
    // deno-lint-ignore no-explicit-any
    const x = gx as any, z = gz as any;
    let mixed = N.uint(seed);
    mixed = mixed.bitXor(x.toUint().mul(N.uint(0x9e3779b1)));
    mixed = mixed.bitXor(z.toUint().mul(N.uint(0x85ebca77)));
    mixed = mixed.bitXor(N.uint(stream).mul(N.uint(0xc2b2ae3d)));
    return pcg(mixed);
  };
  let kernel: unknown;
  try {
    kernel = N.Fn(() => {
      const index = N.instanceIndex;
      const texel = N.ivec2(N.int(index.mod(N.uint(uploadWidth))), N.int(index.div(N.uint(uploadWidth))));
      const coordinate = N.textureLoad(coordinateTexture, texel);
      const gx = coordinate.x.toInt(), gz = coordinate.y.toInt();
      const authoredDensity = N.textureLoad(densityTexture, texel).r.toUint();
      const draw = random(gx, gz, 0).bitAnd(N.uint(0xffff));
      const accepted = authoredDensity.equal(N.uint(0xffff)).or(draw.lessThan(authoredDensity));
      const jitter = random(gx, gz, 1), style = random(gx, gz, 2);
      const jx = jitter.bitAnd(N.uint(0xffff)).toFloat().div(65536).sub(0.5).mul(spacing);
      const jz = jitter.shiftRight(N.uint(16)).toFloat().div(65536).sub(0.5).mul(spacing);
      const x = gx.sub(originGridX).toFloat().add(0.5).mul(spacing).add(originPhaseX).add(jx);
      const z = gz.sub(originGridZ).toFloat().add(0.5).mul(spacing).add(originPhaseZ).add(jz);
      const y = N.textureLoad(heightTexture, texel).r;
      const yaw = style.bitAnd(N.uint(0xffff)).toFloat().mul(Math.PI * 2 / 65536);
      const authoredScale = N.float(sizeLo).add(style.shiftRight(N.uint(16)).toFloat().div(65536).mul(sizeHi - sizeLo));
      rootsYaw.element(index).assign(N.vec4(x, y, z, yaw));
      scales.element(index).assign(N.select(accepted, authoredScale, N.float(0)));
    })().compute(slots, [64]);
  } catch (error) {
    coordinateTexture.dispose(); densityTexture.dispose(); heightTexture.dispose();
    (rootsYaw.value as { dispose?: () => void }).dispose?.(); (scales.value as { dispose?: () => void }).dispose?.();
    throw error;
  }
  let disposed = false;
  return Object.freeze({
    slots, pages: input.pages.length, kernels: Object.freeze([kernel]), rootYawAttribute, scaleAttribute,
    dispatch: () => disposed ? Promise.reject(new Error("grass field compute batch is disposed")) : input.renderer.computeAsync(kernel),
    dispose: () => {
      if (disposed) return; disposed = true;
      (kernel as { dispose?: () => void }).dispose?.();
      coordinateTexture.dispose(); densityTexture.dispose(); heightTexture.dispose();
      (rootsYaw.value as { dispose?: () => void }).dispose?.(); (scales.value as { dispose?: () => void }).dispose?.();
    },
  });
}
