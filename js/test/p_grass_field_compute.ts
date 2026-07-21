import * as THREE from "../build/three.bundle.mjs";
import { buildGrassFieldPlan } from "../src/render/grass-field-plan.ts";
import { buildGrassFieldCompute, buildGrassFieldComputeBatch, grassFieldFeatureLocalCandidate } from "../src/render/grass-field-compute.ts";

function assert(value: boolean, message: string): asserts value { if (!value) throw new Error(`p_grass_field_compute FAIL: ${message}`); }

const plan = buildGrassFieldPlan({
  bounds: { minX: -4, minZ: -4, maxX: 4, maxZ: 4 }, spacing: 1, seed: -17,
  density: new Uint16Array(64).map((_v, i) => i % 3 === 0 ? 0 : 0xffff),
});
const canonicalBytes = new Uint8Array(plan.density.buffer.slice(0));
let dispatches = 0;
const renderer = {
  backend: { isWebGPUBackend: true, isWebGLBackend: false }, hasInitialized: () => true,
  async computeAsync(node: unknown) { assert(node === resource.kernel, "dispatch used a different kernel"); dispatches++; },
};
const resource = buildGrassFieldCompute({ renderer, plan, heights: new Float32Array(plan.slots).fill(3.5) });
// deno-lint-ignore no-explicit-any
const kernel = resource.kernel as any;
assert(kernel.isComputeNode === true && kernel.count === plan.slots, "kernel count is not the fixed slot count");
assert(JSON.stringify(kernel.workgroupSize) === JSON.stringify([64, 1, 1]), "kernel workgroup is not compile-time [64,1,1]");
// deno-lint-ignore no-explicit-any
const roots = resource.rootsYaw as any, scales = resource.scales as any;
assert(roots.value?.isStorageInstancedBufferAttribute === true && roots.value.itemSize === 4 && roots.value.count === plan.slots,
  "root/yaw storage attribute shape is wrong");
assert(scales.value?.isStorageInstancedBufferAttribute === true && scales.value.itemSize === 1 && scales.value.count === plan.slots,
  "scale storage attribute shape is wrong");
// deno-lint-ignore no-explicit-any
assert((resource.rootYawAttribute as any).constructor?.name === "BufferAttributeNode" &&
  (resource.rootYawAttribute as any).attribute === roots.value &&
  (resource.scaleAttribute as any).constructor?.name === "BufferAttributeNode" &&
  (resource.scaleAttribute as any).attribute === scales.value,
  "storage outputs are not exposed through toAttribute for zero-readback rendering");
assert(resource.densityTexture.format === THREE.RedIntegerFormat && resource.densityTexture.type === THREE.UnsignedIntType &&
  resource.densityTexture.image.data instanceof Uint32Array, "Uint16 density was not adapted to R32Uint");
assert(resource.heightTexture.format === THREE.RedFormat && resource.heightTexture.type === THREE.FloatType &&
  resource.heightTexture.image.data instanceof Float32Array, "height input is not a Float32 texture");
assert(plan.density instanceof Uint16Array && JSON.stringify([...new Uint8Array(plan.density.buffer)]) === JSON.stringify([...canonicalBytes]),
  "compute upload mutated canonical Uint16 density bytes");
const fnSource = String(kernel.computeNode?.shaderNode?.jsFunc ?? kernel.computeNode?.getChildren?.().next?.().value?.shaderNode?.jsFunc ?? "");
assert(fnSource.includes("N.select") && fnSource.includes("N.float(0)"), "rejected-slot scale=0 is absent from compute source");

const distantPlan = buildGrassFieldPlan({
  bounds: { minX: 1_000_008.25, minZ: -2_000_015.75, maxX: 1_000_016.25, maxZ: -2_000_007.75 },
  spacing: 0.75, seed: 91,
});
const distantOrigin = [1_000_008.25, 100_000.5, -2_000_015.75] as const;
const distant = grassFieldFeatureLocalCandidate(distantPlan, 0, distantOrigin);
assert(Math.abs(distant.x) < 1 && Math.abs(distant.z) < 1,
  `feature-local oracle retained million-scale roots: ${JSON.stringify(distant)}`);
const distantResource = buildGrassFieldCompute({
  renderer, plan: distantPlan, heights: new Float32Array(distantPlan.slots).fill(100_003.75), featureOrigin: distantOrigin,
});
assert((distantResource.heightTexture.image.data as Float32Array)[0] === 3.25,
  "height upload subtracted the feature origin after f32 conversion and lost precision");
const distantKernel = distantResource.kernel as any;
const distantSource = String(distantKernel.computeNode?.shaderNode?.jsFunc ?? distantKernel.computeNode?.getChildren?.().next?.().value?.shaderNode?.jsFunc ?? "");
assert(distantSource.includes("gx.sub(originGridX)") && !distantSource.includes("x.sub(originX)"),
  "compute graph constructs global f32 roots before feature-origin subtraction");
distantResource.dispose();

await resource.dispatch();
assert(dispatches === 1, "dispatch did not call computeAsync exactly once");
let kernelDisposals = 0, densityDisposals = 0, heightDisposals = 0;
let rootDisposals = 0, scaleDisposals = 0;
kernel.addEventListener("dispose", () => kernelDisposals++);
resource.densityTexture.addEventListener("dispose", () => densityDisposals++);
resource.heightTexture.addEventListener("dispose", () => heightDisposals++);
(roots.value as THREE.BufferAttribute).addEventListener("dispose", () => rootDisposals++);
(scales.value as THREE.BufferAttribute).addEventListener("dispose", () => scaleDisposals++);
resource.dispose(); resource.dispose();
assert(kernelDisposals === 1 && densityDisposals === 1 && heightDisposals === 1 && rootDisposals === 1 && scaleDisposals === 1,
  "aggregate cleanup is not idempotent/exactly-once");

let nodeTouches = 0, webglDispatches = 0;
const forbiddenNodes = new Proxy({}, { get() { nodeTouches++; throw new Error("node API touched"); } });
let rejected = false;
try {
  buildGrassFieldCompute({
    renderer: {
      backend: { isWebGPUBackend: false, isWebGLBackend: true }, hasInitialized: () => true,
      async computeAsync() { webglDispatches++; },
    },
    plan, heights: new Float32Array(plan.slots), nodeApi: forbiddenNodes,
  });
} catch (error) { rejected = /native WebGPU/.test(String(error)); }
assert(rejected && nodeTouches === 0 && webglDispatches === 0,
  "forceWebGL did not fail before node construction/dispatch");

const batchPlanA = buildGrassFieldPlan({ bounds: { minX: 0, minZ: 0, maxX: 8, maxZ: 8 }, spacing: 1, seed: 5 });
const batchPlanB = buildGrassFieldPlan({ bounds: { minX: 8, minZ: 0, maxX: 16, maxZ: 8 }, spacing: 1, seed: 5 });
let batchDispatches = 0;
let batchResource: ReturnType<typeof buildGrassFieldComputeBatch>;
const batchRenderer = { backend: { isWebGPUBackend: true, isWebGLBackend: false }, hasInitialized: () => true,
  async computeAsync(node: unknown) { assert(batchResource.kernels.includes(node), "batch dispatched an unknown kernel"); batchDispatches++; } };
batchResource = buildGrassFieldComputeBatch({ renderer: batchRenderer, featureOrigin: [8, 0, 4], pages: [
  { plan: batchPlanA, heights: new Float32Array(batchPlanA.slots).fill(0.5) },
  { plan: batchPlanB, heights: new Float32Array(batchPlanB.slots).fill(0.75) },
] });
// deno-lint-ignore no-explicit-any
const batchRoots = (batchResource.rootYawAttribute as any).attribute as THREE.BufferAttribute;
// deno-lint-ignore no-explicit-any
const batchScales = (batchResource.scaleAttribute as any).attribute as THREE.BufferAttribute;
assert(batchResource.pages === 2 && batchResource.slots === batchPlanA.slots + batchPlanB.slots
  && batchRoots.count === batchResource.slots && batchScales.count === batchResource.slots,
"batch compute did not expose one shared storage pair covering both canonical pages");
await batchResource.dispatch();
assert(batchDispatches === 1 && batchResource.kernels.length === 1, "batch compute did not concatenate canonical pages into one tile kernel/dispatch");
let batchKernelDisposals = 0, batchRootDisposals = 0, batchScaleDisposals = 0;
for (const node of batchResource.kernels) (node as THREE.EventDispatcher).addEventListener("dispose", () => batchKernelDisposals++);
batchRoots.addEventListener("dispose", () => batchRootDisposals++); batchScales.addEventListener("dispose", () => batchScaleDisposals++);
batchResource.dispose(); batchResource.dispose();
assert(batchKernelDisposals === 1 && batchRootDisposals === 1 && batchScaleDisposals === 1,
  "batched tile kernel/shared storage did not dispose exactly once");

console.log("p_grass_field_compute OK: native backend gate, fixed and batched compute shapes, shared storage-to-attribute outputs, u16-preserving uploads, no-readback dispatch, zero-scale rejection, and exact cleanup are proven");
