// S3 — headless deno_webgpu inside the limina embedder.
//
// Renders a triangle to an OFFSCREEN texture (no window/surface), copies it to a
// buffer, reads it back, and asserts the center pixel is the triangle's color.
// Proves navigator.gpu works in our custom host before windowing (S4) is added.

const adapter = await navigator.gpu.requestAdapter();
if (!adapter) throw new Error("S3 FAIL: no WebGPU adapter");
const device = await adapter.requestDevice();

const SIZE = 256;
const FORMAT = "rgba8unorm";

const texture = device.createTexture({
  size: { width: SIZE, height: SIZE },
  format: FORMAT,
  usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
});

const shader = device.createShaderModule({
  code: `
@vertex
fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4<f32> {
  var p = array<vec2<f32>, 3>(
    vec2<f32>(0.0, 0.5), vec2<f32>(-0.5, -0.5), vec2<f32>(0.5, -0.5)
  );
  return vec4<f32>(p[i], 0.0, 1.0);
}
@fragment
fn fs() -> @location(0) vec4<f32> { return vec4<f32>(1.0, 0.6, 0.1, 1.0); }
`,
});

const pipeline = device.createRenderPipeline({
  layout: "auto",
  vertex: { module: shader, entryPoint: "vs" },
  fragment: { module: shader, entryPoint: "fs", targets: [{ format: FORMAT }] },
  primitive: { topology: "triangle-list" },
});

const bytesPerRow = SIZE * 4; // 1024 — already a multiple of 256
const readBuffer = device.createBuffer({
  size: bytesPerRow * SIZE,
  usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
});

const encoder = device.createCommandEncoder();
const pass = encoder.beginRenderPass({
  colorAttachments: [{
    view: texture.createView(),
    clearValue: { r: 0.07, g: 0.08, b: 0.12, a: 1 },
    loadOp: "clear",
    storeOp: "store",
  }],
});
pass.setPipeline(pipeline);
pass.draw(3);
pass.end();
encoder.copyTextureToBuffer(
  { texture },
  { buffer: readBuffer, bytesPerRow },
  { width: SIZE, height: SIZE },
);
device.queue.submit([encoder.finish()]);

await readBuffer.mapAsync(GPUMapMode.READ);
const pixels = new Uint8Array(readBuffer.getMappedRange());

const cx = SIZE >> 1;
const cy = SIZE >> 1;
const idx = (cy * SIZE + cx) * 4;
const r = pixels[idx];
const g = pixels[idx + 1];
const b = pixels[idx + 2];
const a = pixels[idx + 3];
console.log(`S3 center pixel rgba = ${r}, ${g}, ${b}, ${a}`);

// Triangle color (1.0, 0.6, 0.1) -> ~ (255, 153, 26).
const ok = r > 200 && g > 120 && g < 190 && b < 80 && a === 255;
readBuffer.unmap();
if (!ok) throw new Error("S3 FAIL: center pixel is not the triangle color");
console.log("S3 OK: offscreen triangle rendered in the embedder and read back");
