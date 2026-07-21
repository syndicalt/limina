import {
  canonicalizeNativeSurfacePixels,
  nativeSurfaceReadbackLayout,
  readNativeSurfaceRgba,
  withPresentedNativeSurfaceFrame,
} from "../src/render/native-surface-readback.ts";

function assert(value: boolean, message: string): asserts value {
  if (!value) throw new Error(`p_native_surface_readback FAIL: ${message}`);
}

const layout = nativeSurfaceReadbackLayout(3, 2);
assert(layout.bytesPerRow === 256 && layout.byteLength === 512, "layout did not enforce WebGPU row alignment");

const padded = new Uint8Array(layout.byteLength).fill(0xee);
padded.set([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], 0);
padded.set([13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24], layout.bytesPerRow);
const rgba = canonicalizeNativeSurfacePixels(padded, 3, 2, layout.bytesPerRow, "bgra8unorm-srgb");
assert([...rgba].join(",") === [
  3, 2, 1, 4, 7, 6, 5, 8, 11, 10, 9, 12,
  15, 14, 13, 16, 19, 18, 17, 20, 23, 22, 21, 24,
].join(","), "BGRA conversion or row-padding removal drifted");

for (const invalid of [
  () => nativeSurfaceReadbackLayout(0, 1),
  () => canonicalizeNativeSurfacePixels(padded, 3, 2, 12, "rgba8unorm"),
  () => canonicalizeNativeSurfacePixels(padded, 3, 2, 256, "rgba16float"),
]) {
  let rejected = false;
  try { invalid(); } catch { rejected = true; }
  assert(rejected, "invalid native readback contract was accepted");
}

Object.assign(globalThis, {
  GPUBufferUsage: Object.freeze({ COPY_DST: 8, MAP_READ: 1 }),
  GPUMapMode: Object.freeze({ READ: 1 }),
});
let copied = false, submitted = false, unmapped = false, destroyed = false;
const result = await readNativeSurfaceRgba({
  expectedWidth: 3,
  expectedHeight: 2,
  context: { getCurrentTexture: () => ({ width: 3, height: 2, format: "rgba8unorm" }) },
  device: {
    createBuffer: ({ size }) => {
      assert(size === layout.byteLength, "readback buffer allocation drifted");
      return {
        mapAsync: async () => undefined,
        getMappedRange: () => padded.buffer,
        unmap: () => { unmapped = true; },
        destroy: () => { destroyed = true; },
      };
    },
    createCommandEncoder: () => ({
      copyTextureToBuffer: (_source, destination, size) => {
        copied = destination.bytesPerRow === 256 && size.width === 3 && size.height === 2;
      },
      finish: () => "command",
    }),
    queue: { submit: (commands) => { submitted = commands[0] === "command"; } },
  },
});
assert(copied && submitted && unmapped && destroyed, "readback lifecycle did not copy, submit, unmap, and destroy");
assert(result.format === "rgba8unorm" && result.rgba[0] === 1 && result.rgba[2] === 3,
  "live readback did not preserve canonical RGBA order");
let minimumRejected = false;
try {
  await readNativeSurfaceRgba({
    minimumWidth: 4,
    minimumHeight: 2,
    context: { getCurrentTexture: () => ({ width: 3, height: 2, format: "rgba8unorm" }) },
    device: {
      createBuffer: () => { throw new Error("minimum validation allocated a GPU buffer"); },
      createCommandEncoder: () => { throw new Error("minimum validation created an encoder"); },
      queue: { submit: () => undefined },
    },
  });
} catch (error) {
  minimumRejected = error instanceof Error && /below required/.test(error.message);
}
assert(minimumRejected, "below-floor native surface dimensions were accepted");

let presents = 0;
const frameValue = await withPresentedNativeSurfaceFrame(() => { presents++; }, async () => "frame");
assert(frameValue === "frame" && presents === 1, "successful native surface frame was not presented exactly once");
let primaryPreserved = false;
try {
  await withPresentedNativeSurfaceFrame(() => { presents++; }, () => { throw new Error("render failed"); });
} catch (error) {
  primaryPreserved = error instanceof Error && error.message === "render failed";
}
assert(primaryPreserved && presents === 2, "failed native surface frame did not present and preserve its primary error");
let aggregatePreserved = false;
try {
  await withPresentedNativeSurfaceFrame(
    () => { throw new Error("present failed"); },
    () => { throw new Error("render failed"); },
  );
} catch (error) {
  aggregatePreserved = error instanceof AggregateError && error.errors.length === 2
    && /render failed/.test(error.message) && /present failed/.test(error.message);
}
assert(aggregatePreserved, "dual render/present failure did not retain both errors and summaries");

console.log("p_native_surface_readback OK: dimensions, row padding, channel normalization, balanced present, copy submission, and cleanup are proven");
